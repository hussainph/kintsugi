//! Reddit: one post with its comment tree, from the public `.json` view of
//! the post. Subreddits can't be followed (Reddit's RSS and public API are
//! closing), so there is no poll.
//!
//! - Accepts post and comment permalinks on reddit.com (www, old, new, np,
//!   m), `redd.it/<id>` short links, and app share links (`/r/<sub>/s/<code>`),
//!   which are resolved by reading their redirect, never by following it.
//! - Requests carry a descriptive user agent, are spaced at least six
//!   seconds apart (Reddit allows about ten a minute without OAuth), and stop
//!   while Reddit reports a rate limit.
//! - When the JSON is refused (Reddit blocks some networks outright) and a
//!   fallback adapter is configured, the post's old.reddit.com page goes
//!   through it instead: on the Mac that is the web adapter with its hidden
//!   webview. The result is still labelled a Reddit item.
//!
//! No Reddit account, password or cookie is ever used.

use crate::api::{ApiClient, ApiLimits};
use crate::{
    Adapter, BoxFuture, CaptureOptions, Error, Item, Media, MediaData, MediaKind, Result, SourceType, Target, markdown,
    media::image_mime, text,
};
use reqwest::Url;
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::time::Instant;

const USER_AGENT: &str = "macos:dev.phalasiya.kintsugi:v0.1 (personal reading app)";
/// Comments rendered at most, and how deep.
const MAX_COMMENTS: usize = 300;
const MAX_DEPTH: usize = 8;
/// Stop building once the body is this long; it's cut to the body cap anyway.
const BUILD_CHARS: usize = crate::FULL_CHARS + 4_000;

pub struct RedditAdapter {
    client: ApiClient,
    base: Url,
    fallback: Option<Arc<dyn Adapter>>,
}

impl RedditAdapter {
    pub fn new() -> Result<Self> {
        let limits =
            ApiLimits { json_bytes: 4 * 1024 * 1024, min_interval: Duration::from_secs(6), ..ApiLimits::default() };
        Self::with_endpoint(Url::parse("https://www.reddit.com/").unwrap(), limits)
    }

    /// `base` replaces `https://www.reddit.com/` (tests use a loopback server).
    pub fn with_endpoint(base: Url, limits: ApiLimits) -> Result<Self> {
        Ok(Self { client: ApiClient::new(USER_AGENT, limits)?, base, fallback: None })
    }

    /// Captures the post's old.reddit.com page with `fallback` when the JSON
    /// can't be had (but never while Reddit is rate limiting).
    pub fn with_fallback(mut self, fallback: Arc<dyn Adapter>) -> Self {
        self.fallback = Some(fallback);
        self
    }

    pub async fn fetch(&self, url: &Url, options: CaptureOptions) -> Result<Item> {
        let link = parse(url).ok_or(Error::Unsupported)?;
        let deadline = Instant::now() + self.client.limits.deadline;
        let read = async {
            let post = match link {
                Link::Post(post) => post,
                Link::Share(path) => self.resolve_share(&path).await?,
            };
            match self.read_json(&post).await {
                Ok(item) => Ok(item),
                Err(Error::RateLimited) => Err(Error::RateLimited),
                Err(error) => self.read_fallback(&post, options).await.ok_or(error),
            }
        };
        let mut item = tokio::time::timeout_at(deadline, read).await.map_err(|_| Error::TimedOut)??;
        if options.want_media && item.primary_image().is_none() {
            self.download_primary(&mut item, deadline).await;
        }
        Ok(item)
    }

    /// Share links answer with a redirect to the real permalink.
    async fn resolve_share(&self, path: &str) -> Result<PostRef> {
        let share = self.base.join(path.trim_start_matches('/')).map_err(|_| Error::InvalidUrl)?;
        let location = self.client.location(share).await?.ok_or(Error::Unavailable)?;
        match parse(&location) {
            Some(Link::Post(post)) => Ok(post),
            _ => Err(Error::Unavailable),
        }
    }

    async fn read_json(&self, post: &PostRef) -> Result<Item> {
        let mut url = self.base.join(&format!("comments/{}.json", post.id)).map_err(|_| Error::InvalidUrl)?;
        url.query_pairs_mut()
            .append_pair("raw_json", "1")
            .append_pair("limit", &MAX_COMMENTS.to_string())
            .append_pair("depth", &MAX_DEPTH.to_string());
        let body = self.client.get(url).await?;
        let listing: Value = serde_json::from_slice(&body.bytes).map_err(|_| Error::Unavailable)?;
        item_from_listing(&listing, &post.id).ok_or(Error::Unavailable)
    }

    async fn read_fallback(&self, post: &PostRef, options: CaptureOptions) -> Option<Item> {
        let fallback = self.fallback.as_ref()?;
        let page = format!("https://old.reddit.com{}", post.path());
        let mut item = fallback.capture(&Target::url(&page).ok()?, options).await.ok()?;
        let extractor = item.extras.remove("extractor").unwrap_or(Value::from("none"));
        item.extras.insert("extractor".into(), extractor);
        item.extras.insert("fallback".into(), Value::from("web"));
        item.source = SourceType::Reddit;
        item.id = format!("reddit:{}", post.id);
        item.url = Some(format!("https://www.reddit.com{}", post.path()));
        item.site = item.site.or_else(|| post.subreddit.as_ref().map(|s| format!("r/{s}")));
        Some(item)
    }

    async fn download_primary(&self, item: &mut Item, deadline: Instant) {
        let Some(first) = item.media.first_mut() else { return };
        let Some(url) = first.url.as_deref().and_then(|u| crate::web::web_url(u).ok()) else { return };
        if let Ok(Ok(bytes)) = tokio::time::timeout_at(deadline, self.client.media(url)).await
            && let Some(mime) = image_mime(&bytes)
        {
            first.data = Some(MediaData { bytes, mime: mime.into() });
        }
    }
}

impl Adapter for RedditAdapter {
    fn source(&self) -> SourceType {
        SourceType::Reddit
    }

    fn matches(&self, target: &Target) -> bool {
        matches!(target, Target::Url(url) if parse(url).is_some())
    }

    fn capture<'a>(&'a self, target: &'a Target, options: CaptureOptions) -> BoxFuture<'a, Result<Item>> {
        Box::pin(async move {
            match target {
                Target::Url(url) => self.fetch(url, options).await,
                Target::File(_) => Err(Error::Unsupported),
            }
        })
    }
}

// --- URLs ----------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
enum Link {
    Post(PostRef),
    /// A `/r/<sub>/s/<code>` share link's path.
    Share(String),
}

#[derive(Debug, Clone, PartialEq)]
struct PostRef {
    id: String,
    subreddit: Option<String>,
    slug: Option<String>,
}

impl PostRef {
    fn path(&self) -> String {
        match (&self.subreddit, &self.slug) {
            (Some(sub), Some(slug)) => format!("/r/{sub}/comments/{}/{slug}/", self.id),
            (Some(sub), None) => format!("/r/{sub}/comments/{}/", self.id),
            _ => format!("/comments/{}/", self.id),
        }
    }
}

fn parse(url: &Url) -> Option<Link> {
    if !matches!(url.scheme(), "http" | "https") || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let host = url.host_str()?.to_ascii_lowercase();
    let segments: Vec<&str> = url.path_segments()?.filter(|s| !s.is_empty()).collect();
    if host == "redd.it" {
        return match segments.as_slice() {
            [id] if valid_id(id) => Some(Link::Post(PostRef { id: id.to_ascii_lowercase(), subreddit: None, slug: None })),
            _ => None,
        };
    }
    let bare = host.strip_suffix("reddit.com")?;
    if !matches!(bare, "" | "www." | "old." | "new." | "np." | "m." | "sh.") {
        return None;
    }
    let token = |s: &str| !s.is_empty() && s.len() <= 100 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    match segments.as_slice() {
        ["r", sub, "comments", id, rest @ ..] if token(sub) && valid_id(id) => Some(Link::Post(PostRef {
            id: id.to_ascii_lowercase(),
            subreddit: Some(sub.to_string()),
            slug: rest.first().filter(|s| token(s)).map(|s| s.to_string()),
        })),
        ["comments", id, ..] | ["user" | "u", _, "comments", id, ..] if valid_id(id) => {
            Some(Link::Post(PostRef { id: id.to_ascii_lowercase(), subreddit: None, slug: None }))
        }
        ["r", sub, "s", code] if token(sub) && token(code) => Some(Link::Share(format!("/r/{sub}/s/{code}"))),
        _ => None,
    }
}

fn valid_id(id: &str) -> bool {
    (1..=12).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric())
}

// --- Items ---------------------------------------------------------------------

fn s<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key)?.as_str().map(str::trim).filter(|s| !s.is_empty())
}

fn item_from_listing(listing: &Value, id: &str) -> Option<Item> {
    let post = listing.get(0)?.pointer("/data/children/0")?;
    if post.get("kind")?.as_str()? != "t3" {
        return None;
    }
    let data = post.get("data")?;
    let post_id = s(data, "id")?;
    if !post_id.eq_ignore_ascii_case(id) {
        return None;
    }
    // A crosspost's content lives in its parent.
    let content = data
        .pointer("/crosspost_parent_list/0")
        .filter(|_| s(data, "selftext").is_none() && data.get("is_self").and_then(Value::as_bool) != Some(true))
        .unwrap_or(data);
    let permalink = s(data, "permalink")
        .filter(|p| p.starts_with("/r/") || p.starts_with("/user/"))
        .map(str::to_string)
        .unwrap_or_else(|| format!("/comments/{post_id}/"));
    let url = crate::web::web_url(&format!("https://www.reddit.com{permalink}")).ok()?;

    let images = images(content);
    let mut body = String::new();
    if let Some(selftext) = s(content, "selftext").filter(|t| !matches!(*t, "[deleted]" | "[removed]")) {
        body.push_str(selftext);
    }
    let is_self = content.get("is_self").and_then(Value::as_bool).unwrap_or(false);
    let link = s(content, "url_overridden_by_dest").or_else(|| s(content, "url")).filter(|_| !is_self);
    let gallery = content.get("is_gallery").and_then(Value::as_bool) == Some(true);
    let link = link.filter(|_| !gallery).and_then(safe_url);
    if let Some(link) = &link
        && !images.iter().any(|i| i == link)
    {
        push_block(&mut body, &format!("[{}]({link})", text::label(link, 300)));
    }
    for image in &images {
        push_block(&mut body, &format!("![]({image})"));
    }
    if let Some(video) = content.pointer("/media/reddit_video/fallback_url").and_then(Value::as_str).and_then(safe_url) {
        push_block(&mut body, &format!("[Watch the video]({video})"));
    }
    let comments = listing.get(1).and_then(|l| l.pointer("/data/children")).and_then(Value::as_array);
    let mut rendered = Rendered::default();
    if let Some(children) = comments {
        render_comments(children, 0, &mut rendered);
    }
    if !rendered.out.is_empty() {
        push_block(&mut body, "## Comments");
        push_block(&mut body, &rendered.out);
    }

    let subreddit = s(data, "subreddit");
    let mut extras = BTreeMap::new();
    extras.insert("extractor".to_string(), Value::from("reddit-json"));
    if let Some(sub) = subreddit {
        extras.insert("subreddit".to_string(), Value::from(sub));
    }
    for key in ["score", "num_comments"] {
        if let Some(n) = data.get(key).and_then(Value::as_i64) {
            extras.insert(if key == "score" { "score" } else { "comments" }.to_string(), Value::from(n));
        }
    }
    extras.insert("includedComments".to_string(), Value::from(rendered.count));
    if data.get("over_18").and_then(Value::as_bool) == Some(true) {
        extras.insert("nsfw".to_string(), Value::from(true));
    }
    if let Some(link) = &link {
        extras.insert("link".to_string(), Value::from(link.as_str()));
    }
    let author = s(data, "author").filter(|a| !matches!(*a, "[deleted]" | "[removed]")).map(|a| format!("u/{a}"));
    Some(Item {
        source: SourceType::Reddit,
        id: format!("reddit:{}", post_id.to_ascii_lowercase()),
        url: Some(url.to_string()),
        title: s(data, "title").and_then(|t| markdown::field(t, 500)),
        author: author.and_then(|a| markdown::field(&a, 500)),
        site: s(data, "subreddit_name_prefixed")
            .and_then(|p| markdown::field(p, 200))
            .or_else(|| subreddit.map(|s| format!("r/{s}"))),
        description: None,
        published: data
            .get("created_utc")
            .and_then(Value::as_f64)
            .and_then(|t| crate::x::rfc3339(t as i64)),
        captured: crate::now(),
        media: images.into_iter().map(|url| Media { kind: MediaKind::Image, url: Some(url), data: None }).collect(),
        body: markdown::body(&body, crate::FULL_CHARS),
        extras,
    })
}

fn push_block(body: &mut String, block: &str) {
    if !body.is_empty() {
        body.push_str("\n\n");
    }
    body.push_str(block);
}

/// The post's images: a gallery in order, else the preview image or a
/// directly linked image.
fn images(data: &Value) -> Vec<String> {
    let mut urls = Vec::new();
    if let Some(items) = data.pointer("/gallery_data/items").and_then(Value::as_array) {
        for item in items {
            let Some(media_id) = s(item, "media_id") else { continue };
            let meta = data.get("media_metadata").and_then(|m| m.get(media_id));
            if let Some(url) = meta.and_then(|m| m.pointer("/s/u")).and_then(Value::as_str).and_then(safe_url) {
                urls.push(url);
            }
        }
    }
    if urls.is_empty() {
        let direct = s(data, "url_overridden_by_dest")
            .or_else(|| s(data, "url"))
            .filter(|u| {
                let path = u.split(['?', '#']).next().unwrap_or("").to_ascii_lowercase();
                [".jpg", ".jpeg", ".png", ".gif", ".webp"].iter().any(|ext| path.ends_with(ext))
            })
            .and_then(safe_url);
        let preview = data.pointer("/preview/images/0/source/url").and_then(Value::as_str).and_then(safe_url);
        urls.extend(direct.or(preview));
    }
    urls.truncate(20);
    urls
}

fn safe_url(raw: &str) -> Option<String> {
    let url = crate::web::web_url(raw.trim()).ok()?;
    Some(url.as_str().replace('(', "%28").replace(')', "%29").replace(' ', "%20"))
}

#[derive(Default)]
struct Rendered {
    out: String,
    count: usize,
}

/// Comments as nested block quotes, in Reddit's order, each headed
/// `**u/name** · N points · OP · [link](<permalink>)`. AutoModerator's
/// pinned notices and childless deleted comments are skipped; "more"
/// placeholders become a note of how many replies weren't loaded.
fn render_comments(children: &[Value], depth: usize, rendered: &mut Rendered) {
    let marks = vec![">"; depth].join(" ");
    let prefix = |line: &str| match (depth, line.is_empty()) {
        (0, _) => line.to_string(),
        (_, true) => marks.clone(),
        (_, false) => format!("{marks} {line}"),
    };
    for child in children {
        if rendered.count >= MAX_COMMENTS || rendered.out.len() >= BUILD_CHARS || depth >= MAX_DEPTH {
            return;
        }
        let Some(data) = child.get("data") else { continue };
        let block = match child.get("kind").and_then(Value::as_str) {
            Some("t1") => {
                let author = s(data, "author").unwrap_or("[deleted]");
                let body = s(data, "body").unwrap_or("");
                let removed = matches!(body, "[deleted]" | "[removed]" | "");
                let replies = data.pointer("/replies/data/children").and_then(Value::as_array);
                let pinned_bot = author == "AutoModerator" && data.get("stickied").and_then(Value::as_bool) == Some(true);
                if pinned_bot || (removed && replies.is_none_or(|r| r.is_empty())) {
                    continue;
                }
                let mut head = match author {
                    "[deleted]" | "[removed]" => "**[deleted]**".to_string(),
                    _ => format!("**u/{}**", text::label(author, 40)),
                };
                if let Some(score) = data.get("score").and_then(Value::as_i64) {
                    head.push_str(&format!(" · {score} points"));
                }
                if data.get("is_submitter").and_then(Value::as_bool) == Some(true) {
                    head.push_str(" · OP");
                }
                // The comment's own page, so a quote from it can link there.
                if let Some(link) = s(data, "permalink")
                    .filter(|p| p.starts_with("/r/") || p.starts_with("/user/"))
                    .and_then(|p| safe_url(&format!("https://www.reddit.com{p}")))
                {
                    head.push_str(&format!(" · [link](<{link}>)"));
                }
                let body = if removed { "_[deleted]_".to_string() } else { body.to_string() };
                rendered.count += 1;
                let text = format!("{head}\n\n{body}");
                if !rendered.out.is_empty() {
                    rendered.out.push_str("\n\n");
                }
                rendered.out.push_str(&text.lines().map(prefix).collect::<Vec<_>>().join("\n"));
                if let Some(replies) = replies {
                    render_comments(replies, depth + 1, rendered);
                }
                continue;
            }
            Some("more") => match data.get("count").and_then(Value::as_u64) {
                Some(n) if n > 0 => format!("_{n} more {} on Reddit_", if n == 1 { "reply" } else { "replies" }),
                _ => continue,
            },
            _ => continue,
        };
        if !rendered.out.is_empty() {
            rendered.out.push_str("\n\n");
        }
        rendered.out.push_str(&prefix(&block));
    }
}

#[cfg(test)]
mod tests;
