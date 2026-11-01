//! X (Twitter): single posts and whole threads, and following accounts.
//!
//! Capture tries, in order, until one answers:
//!
//! 1. the [`XApi`] backend's thread (FxTwitter's `/2/thread/{id}`, then its
//!    `/2/status/{id}`), which carries text, media, quoted posts, link cards
//!    and the author's own continuation of the thread;
//! 2. X's public syndication endpoint (the post, its parent and its quote);
//! 3. X's oEmbed endpoint (the post's text only).
//!
//! Each item says which one answered (`extras.extractor`) and whether the
//! thread is known to be whole (`extras.complete`). Following an account
//! polls the backend's timeline. The backend is a trait so that a
//! user-supplied X API key could replace FxTwitter without touching the
//! normalization, fallbacks or cursors here.
//!
//! No X account, password or cookie is ever used.

mod fxtwitter;
mod oembed;
mod syndication;

use crate::api::{ApiClient, ApiLimits};
use crate::{
    Adapter, BoxFuture, CaptureOptions, Error, Item, Media, MediaData, MediaKind, Polled, Result, SourceType,
    Subscription, Target, markdown, media::image_mime, text,
};
use reqwest::Url;
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Arc;
use tokio::time::Instant;

pub use fxtwitter::FxTwitter;
pub(crate) use fxtwitter::rfc3339;

const USER_AGENT: &str = "Kintsugi/0.1 (personal reading app; +https://github.com/hussainph/kintsugi)";

/// One post, as every backend and fallback normalizes it. Text is plain
/// (links expanded, media links removed) and untrusted.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Post {
    /// The numeric status id.
    pub id: String,
    pub author: Author,
    pub text: String,
    /// RFC 3339, UTC.
    pub created: Option<String>,
    pub lang: Option<String>,
    pub media: Vec<PostMedia>,
    pub quote: Option<Box<Post>>,
    pub card: Option<Card>,
    pub article: Option<Article>,
    pub replying_to: Option<ReplyTo>,
    /// Set when this appears in a timeline as someone's repost.
    pub reposted_by: Option<String>,
    pub stats: Stats,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Author {
    pub name: Option<String>,
    /// The screen name, without `@`.
    pub handle: String,
    /// The profile picture.
    pub avatar: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ReplyTo {
    pub id: String,
    pub handle: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PostMediaKind {
    Photo,
    Video,
    Gif,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PostMedia {
    pub kind: PostMediaKind,
    /// The photo, or the video file.
    pub url: Option<String>,
    /// A still for videos and GIFs.
    pub preview: Option<String>,
    pub alt: Option<String>,
}

/// A link preview attached to a post.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Card {
    pub url: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub image: Option<String>,
}

/// An X Article (long-form post): its title and opening only.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Article {
    pub id: Option<String>,
    pub title: Option<String>,
    pub preview: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Stats {
    pub likes: Option<u64>,
    pub reposts: Option<u64>,
    pub replies: Option<u64>,
    pub quotes: Option<u64>,
    pub views: Option<u64>,
}

/// A conversation around one post, oldest first.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Thread {
    pub posts: Vec<Post>,
    /// Whether this is known to be the whole thread, not just the post (and
    /// perhaps its parent).
    pub complete: bool,
}

impl Post {
    pub fn url(&self) -> String {
        format!("https://x.com/{}/status/{}", self.author.handle, self.id)
    }

    fn author_label(&self) -> String {
        match &self.author.name {
            Some(name) if !name.is_empty() => format!("{name} (@{})", self.author.handle),
            _ => format!("@{}", self.author.handle),
        }
    }

    fn number(&self) -> u64 {
        self.id.parse().unwrap_or(0)
    }
}

/// Where posts come from. FxTwitter today; an official-API client holding a
/// user-supplied key could implement this later. Implementations must not
/// require the owner's X password or session.
pub trait XApi: Send + Sync {
    /// Names the source in `extras.extractor`, e.g. `fxtwitter`.
    fn name(&self) -> &'static str;
    /// The conversation containing post `id`, oldest first: at least the post
    /// itself, ideally its ancestors and the author's continuation.
    fn thread<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Thread>>;
    /// The account's latest posts, newest first, reposts marked.
    fn timeline<'a>(&'a self, handle: &'a str) -> BoxFuture<'a, Result<Vec<Post>>>;
}

/// Where the fallbacks live; tests point them at a loopback server.
#[derive(Debug, Clone)]
pub struct XEndpoints {
    pub fxtwitter: Url,
    pub syndication: Url,
    pub oembed: Url,
}

impl Default for XEndpoints {
    fn default() -> Self {
        Self {
            fxtwitter: Url::parse("https://api.fxtwitter.com/").unwrap(),
            syndication: Url::parse("https://cdn.syndication.twimg.com/").unwrap(),
            oembed: Url::parse("https://publish.twitter.com/").unwrap(),
        }
    }
}

pub struct XAdapter {
    client: Arc<ApiClient>,
    api: Arc<dyn XApi>,
    endpoints: XEndpoints,
}

impl XAdapter {
    pub fn new() -> Result<Self> {
        Self::with_endpoints(XEndpoints::default(), ApiLimits::default())
    }

    pub fn with_endpoints(endpoints: XEndpoints, limits: ApiLimits) -> Result<Self> {
        let client = Arc::new(ApiClient::new(USER_AGENT, limits)?);
        let api = Arc::new(FxTwitter::new(client.clone(), endpoints.fxtwitter.clone()));
        Ok(Self { client, api, endpoints })
    }

    /// Replaces the FxTwitter backend (for example with an official API
    /// client). The syndication and oEmbed fallbacks stay.
    pub fn with_api(mut self, api: Arc<dyn XApi>) -> Self {
        self.api = api;
        self
    }

    pub async fn fetch(&self, url: &Url, options: CaptureOptions) -> Result<Item> {
        let id = status_id(url).ok_or(Error::Unsupported)?;
        let deadline = Instant::now() + self.client.limits.deadline;
        let mut item =
            tokio::time::timeout_at(deadline, self.read(&id, url)).await.map_err(|_| Error::TimedOut)??;
        if options.want_media {
            self.download_primary(&mut item, deadline).await;
        }
        Ok(item)
    }

    async fn read(&self, id: &str, url: &Url) -> Result<Item> {
        let mut failures = Vec::new();
        match self.api.thread(id).await {
            Ok(thread) => match build(&thread, id, self.api.name()) {
                Some(item) => return Ok(item),
                None => failures.push(Error::Unavailable),
            },
            Err(error) => failures.push(error),
        }
        match syndication::thread(&self.client, &self.endpoints.syndication, id).await {
            Ok(thread) => match build(&thread, id, "syndication") {
                Some(item) => return Ok(item),
                None => failures.push(Error::Unavailable),
            },
            Err(error) => failures.push(error),
        }
        match oembed::post(&self.client, &self.endpoints.oembed, url, id).await {
            Ok(post) => {
                let thread = Thread { posts: vec![post], complete: false };
                if let Some(item) = build(&thread, id, "oembed") {
                    return Ok(item);
                }
                failures.push(Error::Unavailable);
            }
            Err(error) => failures.push(error),
        }
        Err(honest(&failures))
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

    pub async fn poll_profile(&self, subscription: &Subscription) -> Result<Polled> {
        let handle = profile_handle(&subscription.url).ok_or(Error::InvalidUrl)?;
        let deadline = Instant::now() + self.client.limits.deadline;
        let posts = tokio::time::timeout_at(deadline, self.api.timeline(&handle)).await.map_err(|_| Error::TimedOut)??;
        let since = subscription.cursor.as_deref().and_then(|c| c.parse::<u64>().ok()).unwrap_or(0);
        let (items, newest) = timeline_items(&posts, &handle, since, self.api.name());
        let cursor = match newest.max(since) {
            0 => subscription.cursor.clone(),
            n => Some(n.to_string()),
        };
        // The account describes itself through its own posts.
        let source = posts.iter().find(|p| p.reposted_by.is_none() && p.author.handle.eq_ignore_ascii_case(&handle)).map(|p| {
            crate::SourceInfo {
                title: markdown::field(&p.author_label(), 200),
                url: Some(profile_url(&p.author.handle)),
                image: p.author.avatar.as_deref().and_then(safe_url),
            }
        });
        Ok(Polled { items, cursor, source })
    }
}

impl Adapter for XAdapter {
    fn source(&self) -> SourceType {
        SourceType::X
    }

    fn matches(&self, target: &Target) -> bool {
        matches!(target, Target::Url(url) if status_id(url).is_some())
    }

    fn capture<'a>(&'a self, target: &'a Target, options: CaptureOptions) -> BoxFuture<'a, Result<Item>> {
        Box::pin(async move {
            match target {
                Target::Url(url) => self.fetch(url, options).await,
                Target::File(_) => Err(Error::Unsupported),
            }
        })
    }

    /// `subscription.url` is a profile (`https://x.com/<handle>` or
    /// `@handle`); the cursor is the newest status id delivered.
    fn poll<'a>(&'a self, subscription: &'a Subscription) -> BoxFuture<'a, Result<Polled>> {
        Box::pin(self.poll_profile(subscription))
    }
}

/// A rate limit or timeout explains a failure better than "unavailable".
fn honest(failures: &[Error]) -> Error {
    for preferred in [Error::RateLimited, Error::TimedOut, Error::TooLarge] {
        if failures.contains(&preferred) {
            return preferred;
        }
    }
    Error::Unavailable
}

// --- URLs ----------------------------------------------------------------------

/// X's own hosts and the embed-fixing mirrors people share.
fn x_host(url: &Url) -> bool {
    let Some(host) = url.host_str() else { return false };
    let host = host.to_ascii_lowercase();
    let host = host.strip_prefix("www.").or_else(|| host.strip_prefix("mobile.")).unwrap_or(&host);
    matches!(host, "x.com" | "twitter.com" | "fxtwitter.com" | "fixupx.com" | "vxtwitter.com" | "fixvx.com")
        && matches!(url.scheme(), "http" | "https")
        && url.username().is_empty()
        && url.password().is_none()
}

/// The status id in a post URL: `/<handle>/status/<id>`, `/i/status/<id>`,
/// `/i/web/status/<id>`, with or without a trailing `/photo/1` and the like.
pub fn status_id(url: &Url) -> Option<String> {
    if !x_host(url) {
        return None;
    }
    let segments: Vec<&str> = url.path_segments()?.filter(|s| !s.is_empty()).collect();
    let id = match segments.as_slice() {
        ["i", "web", "status", id, ..] | ["i", "status", id, ..] => id,
        [handle, "status" | "statuses", id, ..] if valid_handle(handle) => id,
        _ => return None,
    };
    (id.len() <= 20 && !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit())).then(|| id.to_string())
}

fn valid_handle(handle: &str) -> bool {
    (1..=15).contains(&handle.len()) && handle.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// Paths under x.com that are not accounts.
const RESERVED: &[&str] = &[
    "i", "home", "explore", "search", "settings", "intent", "share", "hashtag", "messages", "notifications",
    "compose", "login", "logout", "signup", "tos", "privacy", "jobs",
];

/// The account a Feed source follows, from `https://x.com/<handle>` (any X
/// host), `@handle` or a bare handle. Lowercased, without `@`.
pub fn profile_handle(input: &str) -> Option<String> {
    let input = input.trim();
    let handle = if let Some(bare) = input.strip_prefix('@') {
        bare.to_ascii_lowercase()
    } else if let Ok(url) = Url::parse(input) {
        if !x_host(&url) {
            return None;
        }
        let mut segments = url.path_segments()?.filter(|s| !s.is_empty());
        segments.next()?.to_ascii_lowercase()
    } else {
        input.to_ascii_lowercase()
    };
    (valid_handle(&handle) && !RESERVED.contains(&handle.as_str())).then_some(handle)
}

/// The canonical profile URL stored as a subscription.
pub fn profile_url(handle: &str) -> String {
    format!("https://x.com/{handle}")
}

// --- Items ---------------------------------------------------------------------

/// Builds the item for post `focus` from its conversation. `None` if the
/// conversation doesn't contain it or says nothing at all.
fn build(thread: &Thread, focus: &str, extractor: &str) -> Option<Item> {
    let at = thread.posts.iter().position(|p| p.id == focus)?;
    let post = &thread.posts[at];
    if post.author.handle.is_empty() {
        return None;
    }
    let body = render(&thread.posts, &post.author.handle);
    if body.is_empty() && post.media.is_empty() {
        return None;
    }
    let mut item = item_for(&thread.posts, at, body, extractor);
    item.extras.insert("complete".into(), Value::from(thread.complete));
    Some(item)
}

fn item_for(posts: &[Post], focus: usize, body: String, extractor: &str) -> Item {
    let post = &posts[focus];
    let handle = &post.author.handle;
    // A self-thread is titled by its opening post.
    let opening = posts.iter().find(|p| p.author.handle.eq_ignore_ascii_case(handle)).unwrap_or(post);
    let title = text::title(&opening.text, 120)
        .or_else(|| opening.article.as_ref().and_then(|a| a.title.as_deref()).and_then(|t| text::title(t, 120)))
        .unwrap_or_else(|| format!("Post by @{handle}"));
    let mut extras = BTreeMap::new();
    extras.insert("extractor".to_string(), Value::from(extractor));
    extras.insert("handle".to_string(), Value::from(handle.as_str()));
    extras.insert("posts".to_string(), Value::from(posts.len()));
    if let Some(lang) = post.lang.as_deref().and_then(|l| markdown::field(l, 40)) {
        extras.insert("lang".to_string(), Value::from(lang));
    }
    for (key, value) in [
        ("likes", post.stats.likes),
        ("reposts", post.stats.reposts),
        ("replies", post.stats.replies),
        ("quotes", post.stats.quotes),
        ("views", post.stats.views),
    ] {
        if let Some(n) = value {
            extras.insert(key.to_string(), Value::from(n));
        }
    }
    let url = post.url();
    Item {
        source: SourceType::X,
        id: format!("x:{}", post.id),
        url: Some(url),
        title: markdown::field(&title, 500),
        author: markdown::field(&post.author_label(), 500),
        site: Some("X".into()),
        description: None,
        published: post.created.clone(),
        captured: crate::now(),
        media: media_of(posts, focus),
        body: markdown::body(&body, crate::BODY_CHARS),
        extras,
    }
}

/// Images in reading order, the focused post's first; videos by their still.
fn media_of(posts: &[Post], focus: usize) -> Vec<Media> {
    let mut urls: Vec<String> = Vec::new();
    let mut add = |post: &Post| {
        let mut found: Vec<Option<&String>> =
            post.media.iter().map(|m| if m.kind == PostMediaKind::Photo { m.url.as_ref() } else { m.preview.as_ref() }).collect();
        if let Some(quote) = &post.quote {
            found.extend(quote.media.iter().map(|m| if m.kind == PostMediaKind::Photo { m.url.as_ref() } else { m.preview.as_ref() }));
        }
        found.push(post.card.as_ref().and_then(|c| c.image.as_ref()));
        for url in found.into_iter().flatten() {
            if let Some(url) = safe_url(url)
                && !urls.contains(&url)
            {
                urls.push(url);
            }
        }
    };
    add(&posts[focus]);
    posts.iter().for_each(&mut add);
    urls.into_iter().take(20).map(|url| Media { kind: MediaKind::Image, url: Some(url), data: None }).collect()
}

/// The conversation as Markdown: posts separated by rules, other people's
/// posts introduced by name, quoted posts as block quotes.
fn render(posts: &[Post], focus_handle: &str) -> String {
    posts
        .iter()
        .map(|post| render_post(post, !post.author.handle.eq_ignore_ascii_case(focus_handle), true))
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n---\n\n")
}

fn render_post(post: &Post, introduce: bool, with_quote: bool) -> String {
    let mut blocks = Vec::new();
    if introduce {
        blocks.push(format!("**{}**", text::label(&post.author_label(), 200)));
    }
    if !post.text.trim().is_empty() {
        blocks.push(text::plain(post.text.trim()));
    }
    if let Some(article) = &post.article {
        if let Some(title) = article.title.as_deref().map(|t| text::label(t, 300)).filter(|t| !t.is_empty()) {
            blocks.push(format!("**{title}**"));
        }
        if let Some(preview) = article.preview.as_deref().filter(|p| !p.trim().is_empty()) {
            blocks.push(text::plain(preview.trim()));
        }
        if let Some(id) = article.id.as_deref().filter(|id| id.bytes().all(|b| b.is_ascii_digit())) {
            blocks.push(format!("[Read the article on X](https://x.com/i/article/{id})"));
        }
    }
    for media in &post.media {
        let alt = media.alt.as_deref().map(|a| text::label(a, 300)).unwrap_or_default();
        match media.kind {
            PostMediaKind::Photo => {
                if let Some(url) = media.url.as_deref().and_then(safe_url) {
                    blocks.push(format!("![{alt}]({url})"));
                }
            }
            PostMediaKind::Video | PostMediaKind::Gif => {
                let what = if media.kind == PostMediaKind::Gif { "GIF" } else { "Video" };
                if let Some(preview) = media.preview.as_deref().and_then(safe_url) {
                    let alt = if alt.is_empty() { what.to_string() } else { format!("{what}: {alt}") };
                    blocks.push(format!("![{alt}]({preview})"));
                }
                if let Some(url) = media.url.as_deref().and_then(safe_url) {
                    blocks.push(format!("[Watch the {}]({url})", what.to_lowercase()));
                }
            }
        }
    }
    if let Some(card) = &post.card
        && let Some(url) = safe_url(&card.url)
    {
        let title = card.title.as_deref().map(|t| text::label(t, 300)).filter(|t| !t.is_empty());
        blocks.push(format!("[{}]({url})", title.unwrap_or_else(|| text::label(&url, 300))));
        if let Some(description) = card.description.as_deref().filter(|d| !d.trim().is_empty()) {
            blocks.push(text::plain(&text::label(description, 500)));
        }
    }
    if with_quote && let Some(quote) = &post.quote {
        let inner = render_post(quote, false, false);
        let head = format!("**{}** · [quoted post]({})", text::label(&quote.author_label(), 200), quote.url());
        let quoted = std::iter::once(head.as_str())
            .chain(std::iter::once(""))
            .chain(inner.lines())
            .map(|line| if line.is_empty() { ">".to_string() } else { format!("> {line}") })
            .collect::<Vec<_>>()
            .join("\n");
        blocks.push(quoted);
    }
    blocks.join("\n\n")
}

/// HTTP(S) only, with parentheses and spaces encoded so the URL can't end a
/// Markdown link early.
fn safe_url(raw: &str) -> Option<String> {
    let url = crate::web::web_url(raw.trim()).ok()?;
    Some(url.as_str().replace('(', "%28").replace(')', "%29").replace(' ', "%20"))
}

/// Timeline posts become items: the account's own posts (no reposts, no
/// replies to others), its self-replies folded into the post they continue
/// when both are in the page. Returns items newest first and the newest
/// own status id seen.
fn timeline_items(posts: &[Post], handle: &str, since: u64, extractor: &str) -> (Vec<Item>, u64) {
    let mut own: Vec<&Post> = posts
        .iter()
        .filter(|p| p.reposted_by.is_none() && p.author.handle.eq_ignore_ascii_case(handle) && p.number() > 0)
        .collect();
    own.sort_by_key(|p| p.number());
    own.dedup_by_key(|p| p.number());
    let newest = own.last().map_or(0, |p| p.number());
    // Chains of the account's posts, each started by a post that isn't a
    // reply to another one in this page.
    let mut chains: Vec<Vec<&Post>> = Vec::new();
    for post in own {
        match &post.replying_to {
            None => chains.push(vec![post]),
            Some(reply) => {
                let to_self = reply.handle.as_deref().is_some_and(|h| h.eq_ignore_ascii_case(handle));
                if !to_self {
                    continue;
                }
                match chains.iter_mut().find(|chain| chain.iter().any(|p| p.id == reply.id)) {
                    Some(chain) => chain.push(post),
                    None => chains.push(vec![post]),
                }
            }
        }
    }
    let mut items: Vec<(u64, Item)> = chains
        .into_iter()
        .filter_map(|chain| {
            let fresh: Vec<Post> = chain.into_iter().filter(|p| p.number() > since).cloned().collect();
            let first = fresh.first()?.number();
            let body = render(&fresh, &fresh[0].author.handle);
            let mut item = item_for(&fresh, 0, body, extractor);
            item.extras.insert("complete".into(), Value::from(false));
            Some((first, item))
        })
        .collect();
    items.sort_by(|a, b| b.0.cmp(&a.0));
    (items.into_iter().map(|(_, item)| item).collect(), newest)
}

#[cfg(test)]
mod tests;
