//! The feed adapter: RSS 0.x/1.0/2.0, Atom and JSON Feed (via feed-rs, MIT).
//! One adapter covers blogs, YouTube channels, podcasts and Hacker News
//! (hnrss.org): anything with a feed.
//!
//! Feeds are followed, not captured: [`FeedAdapter::matches`] is always false,
//! so a single URL still goes to the web adapter. [`Adapter::poll`] makes a
//! conditional request (the cursor holds the `ETag` and `Last-Modified`) and
//! returns the feed's current entries, newest first; consumers deduplicate on
//! [`Item::id`]. A 304 returns no items and the same cursor.
//!
//! Also here, because they read the same documents: finding the feed a page
//! advertises (including a YouTube channel page's), and podcast search.

mod discover;

use crate::{Adapter, BoxFuture, CaptureOptions, Error, Item, Media, MediaKind, Polled, Result, SourceInfo, SourceType, Subscription, Target, markdown, web::allowed_url};
use dom_query::Document;
use feed_rs::model::{Entry, Feed};
use futures_util::StreamExt;
use reqwest::header::{ACCEPT, ETAG, IF_MODIFIED_SINCE, IF_NONE_MATCH, LAST_MODIFIED};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::time::Duration;

pub use discover::{Podcast, channel_id, feed_links, podcasts};

const USER_AGENT: &str = concat!("Kintsugi/", env!("CARGO_PKG_VERSION"), " (feed reader; +https://github.com/hussainph/kintsugi)");
const MAX_BYTES: usize = 8 * 1024 * 1024;
/// The entry summary, as plain text.
pub const DESCRIPTION_CHARS: usize = 600;
const ITUNES_SEARCH: &str = "https://itunes.apple.com/search";

/// What the poll cursor remembers: the validators for a conditional request.
#[derive(Debug, Default, Serialize, Deserialize, PartialEq)]
struct Cursor {
    #[serde(skip_serializing_if = "Option::is_none")]
    etag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    modified: Option<String>,
}

pub struct FeedAdapter {
    client: Client,
}

struct Body {
    bytes: Vec<u8>,
    url: Url,
    etag: Option<String>,
    modified: Option<String>,
}

impl FeedAdapter {
    pub fn new() -> Result<Self> {
        let client = Client::builder()
            .user_agent(USER_AGENT)
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(25))
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= 5 || !allowed_url(attempt.url()) {
                    attempt.error("unsupported redirect")
                } else {
                    attempt.follow()
                }
            }))
            .build()
            .map_err(|_| Error::Setup)?;
        Ok(Self { client })
    }

    /// `Ok(None)` is 304 Not Modified.
    async fn get(&self, url: &Url, cursor: &Cursor) -> Result<Option<Body>> {
        if !allowed_url(url) {
            return Err(Error::InvalidUrl);
        }
        let mut request = self.client.get(url.clone()).header(
            ACCEPT,
            "application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.8, */*;q=0.5",
        );
        if let Some(etag) = &cursor.etag {
            request = request.header(IF_NONE_MATCH, etag);
        }
        if let Some(modified) = &cursor.modified {
            request = request.header(IF_MODIFIED_SINCE, modified);
        }
        let response = request.send().await.map_err(|e| if e.is_timeout() { Error::TimedOut } else { Error::Unavailable })?;
        let status = response.status();
        if status.as_u16() == 304 {
            return Ok(None);
        }
        if !status.is_success() {
            return Err(Error::Status(status.as_u16()));
        }
        if response.content_length().is_some_and(|n| n > MAX_BYTES as u64) {
            return Err(Error::TooLarge);
        }
        let header = |name| response.headers().get(name).and_then(|v: &reqwest::header::HeaderValue| v.to_str().ok()).map(str::to_string);
        let (etag, modified, final_url) = (header(ETAG), header(LAST_MODIFIED), response.url().clone());
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| Error::Unavailable)?;
            if chunk.len() > MAX_BYTES.saturating_sub(bytes.len()) {
                return Err(Error::TooLarge);
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(Some(Body { bytes, url: final_url, etag, modified }))
    }

    /// The feed behind a URL: the URL itself if it is a feed, else the first
    /// working feed the page advertises (`<link rel="alternate">`), or a
    /// YouTube channel page's uploads feed.
    pub async fn discover(&self, url: &Url) -> Result<Url> {
        let body = self.get(url, &Cursor::default()).await?.ok_or(Error::Unavailable)?;
        if parse(&body.bytes, body.url.as_str()).is_ok() {
            return Ok(url.clone());
        }
        let html = String::from_utf8_lossy(&body.bytes);
        let mut candidates = feed_links(&html, &body.url);
        if let Some(id) = channel_id(&html) {
            candidates.push(Url::parse(&format!("https://www.youtube.com/feeds/videos.xml?channel_id={id}")).map_err(|_| Error::Unavailable)?);
        }
        for candidate in candidates {
            if let Ok(Some(found)) = self.get(&candidate, &Cursor::default()).await
                && parse(&found.bytes, found.url.as_str()).is_ok()
            {
                return Ok(candidate);
            }
        }
        Err(Error::NotAFeed)
    }

    /// A YouTube channel page's channel ID (for `@handle` and `/c/` URLs).
    pub async fn youtube_channel(&self, page: &Url) -> Result<String> {
        let body = self.get(page, &Cursor::default()).await?.ok_or(Error::Unavailable)?;
        channel_id(&String::from_utf8_lossy(&body.bytes)).ok_or(Error::Unavailable)
    }

    /// Podcasts with a public feed, from iTunes Search.
    pub async fn search_podcasts(&self, term: &str) -> Result<Vec<Podcast>> {
        let mut url = Url::parse(ITUNES_SEARCH).map_err(|_| Error::Setup)?;
        url.query_pairs_mut()
            .append_pair("media", "podcast")
            .append_pair("entity", "podcast")
            .append_pair("limit", "12")
            .append_pair("term", term.trim());
        let body = self.get(&url, &Cursor::default()).await?.ok_or(Error::Unavailable)?;
        podcasts(&body.bytes)
    }
}

impl Adapter for FeedAdapter {
    fn source(&self) -> SourceType {
        SourceType::Rss
    }

    /// Feeds are followed, never captured as one item.
    fn matches(&self, _: &Target) -> bool {
        false
    }

    fn capture<'a>(&'a self, _: &'a Target, _: CaptureOptions) -> BoxFuture<'a, Result<Item>> {
        Box::pin(async { Err(Error::Unsupported) })
    }

    fn poll<'a>(&'a self, subscription: &'a Subscription) -> BoxFuture<'a, Result<Polled>> {
        Box::pin(async move {
            let url = crate::web::web_url(&subscription.url)?;
            let cursor: Cursor = subscription.cursor.as_deref().and_then(|c| serde_json::from_str(c).ok()).unwrap_or_default();
            let Some(body) = self.get(&url, &cursor).await? else {
                return Ok(Polled { items: Vec::new(), cursor: subscription.cursor.clone(), source: None });
            };
            let (source, items) = parse(&body.bytes, body.url.as_str())?;
            let next = Cursor { etag: body.etag, modified: body.modified };
            let cursor = (next != Cursor::default()).then(|| serde_json::to_string(&next).unwrap_or_default());
            Ok(Polled { items, cursor, source: Some(source) })
        })
    }
}

/// Parses a feed document into items, newest first as the feed lists them.
pub fn parse(bytes: &[u8], url: &str) -> Result<(SourceInfo, Vec<Item>)> {
    let feed = feed_rs::parser::Builder::new().base_uri(Some(url)).build().parse(bytes).map_err(|_| Error::NotAFeed)?;
    let info = SourceInfo {
        title: feed.title.as_ref().and_then(|t| plain(&t.content, 300)),
        url: feed
            .links
            .iter()
            .find(|l| l.rel.as_deref().is_none_or(|r| r == "alternate"))
            .map(|l| l.href.clone())
            .filter(|h| web(h)),
        image: feed.logo.as_ref().or(feed.icon.as_ref()).map(|i| i.uri.clone()).filter(|u| web(u)),
    };
    let captured = crate::now();
    let items = feed.entries.iter().map(|e| item(e, &feed, &info, &captured)).collect();
    Ok((info, items))
}

fn web(url: &str) -> bool {
    url.starts_with("https://") || url.starts_with("http://")
}

fn item(entry: &Entry, feed: &Feed, info: &SourceInfo, captured: &str) -> Item {
    let url = entry
        .links
        .iter()
        .find(|l| l.rel.as_deref().is_none_or(|r| r == "alternate"))
        .or(entry.links.first())
        .map(|l| l.href.clone())
        .filter(|h| web(h));
    let content = entry.content.as_ref().and_then(|c| c.body.as_deref());
    let summary = entry.summary.as_ref().map(|s| s.content.as_str());
    let media_description = entry.media.iter().find_map(|m| m.description.as_ref()).map(|d| d.content.as_str());
    let body = content.or(summary).or(media_description).map(to_markdown).unwrap_or_default();
    let author = entry.authors.first().or(feed.authors.first()).and_then(|p| p.name.as_deref()).and_then(|n| markdown::field(n, 200));
    let mime = |ty: &str| entry.media.iter().flat_map(|m| &m.content).any(|c| c.content_type.as_ref().is_some_and(|t| t.ty() == ty));
    let audio = mime("audio")
        || entry.links.iter().any(|l| l.rel.as_deref() == Some("enclosure") && l.media_type.as_deref().is_some_and(|t| t.starts_with("audio/")));
    let video = url.as_deref().is_some_and(|u| u.contains("youtube.com/watch") || u.contains("youtu.be/")) || mime("video");
    let mut extras = BTreeMap::new();
    extras.insert("media".into(), Value::from(if video { "video" } else if audio { "audio" } else { "article" }));
    Item {
        source: SourceType::Rss,
        id: format!("rss:{}", entry.id),
        url,
        title: entry.title.as_ref().and_then(|t| plain(&t.content, 500)),
        author,
        site: info.title.clone(),
        description: summary.or(media_description).or(content).and_then(|s| plain(s, DESCRIPTION_CHARS)),
        published: entry.published.or(entry.updated).map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
        captured: captured.into(),
        media: image(entry, content.or(summary)).map(|url| Media { kind: MediaKind::Image, url: Some(url), data: None }).into_iter().collect(),
        body,
        extras,
    }
}

fn image(entry: &Entry, html: Option<&str>) -> Option<String> {
    let thumbnail = entry.media.iter().flat_map(|m| &m.thumbnails).map(|t| t.image.uri.clone()).next();
    let picture = entry
        .media
        .iter()
        .flat_map(|m| &m.content)
        .find_map(|c| c.content_type.as_ref().filter(|t| t.ty() == "image").and(c.url.as_ref()).map(|u| u.to_string()));
    let inline = html.filter(|h| h.contains("<img")).and_then(|h| Document::from(h).select("img[src]").attr("src").map(|s| s.to_string()));
    thumbnail.or(picture).or(inline).filter(|u| web(u))
}

const SKIP: &[&str] = &["script", "style", "noscript", "iframe", "svg", "form"];

/// Feed HTML (or plain text) as bounded Markdown.
fn to_markdown(html: &str) -> String {
    if !html.contains('<') {
        return markdown::body(html, crate::BODY_CHARS);
    }
    let doc = Document::from(html);
    let body = doc.select("body");
    body.nodes().first().map_or_else(String::new, |root| markdown::body(&root.md(Some(SKIP)), crate::BODY_CHARS))
}

/// Plain text: tags dropped, entities decoded, whitespace collapsed.
fn plain(html: &str, limit: usize) -> Option<String> {
    if !html.contains('<') && !html.contains('&') {
        return markdown::field(html, limit);
    }
    let doc = Document::from(html);
    doc.select(&SKIP.join(", ")).remove();
    let text = doc.select("body").text();
    let bounded = markdown::field(&text, limit + 1)?;
    Some(if bounded.chars().count() > limit { format!("{}…", bounded.chars().take(limit).collect::<String>().trim_end()) } else { bounded })
}

#[cfg(test)]
mod tests;
