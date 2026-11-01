//! Kintsugi's ingestion engine. One pipeline serves the Feed and Inspiration:
//! source adapters turn a URL or a file into one normalized [`Item`], whose
//! body is clean Markdown with metadata and media beside it.
//!
//! - An [`Adapter`] says which targets it handles, captures one item, and
//!   (when its source can be followed) polls a [`Subscription`] for new ones.
//! - The [`Engine`] holds adapters in priority order and routes a target to
//!   the first that matches. Specific adapters (X, YouTube, PDFs…) go before
//!   the generic [`web::WebAdapter`], which accepts any web page.
//!
//! Everything an adapter fetches is untrusted data. Items carry it as text,
//! never as instructions, and errors are fixed strings that never echo it.
//! The AI is not an extractor here: it only cleans up and summarizes items
//! downstream.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fmt;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;

pub mod api;
pub mod authors;
pub mod feed;
mod markdown;
pub mod media;
pub mod reddit;
#[cfg(test)]
mod test_server;
mod text;
pub mod web;
pub mod x;
mod fetch;
pub mod podcast;
pub mod pdf;
pub mod epub;
pub mod books;
#[cfg(test)]
mod test_http;
pub mod tools;
pub mod transcribe;
pub mod transcript;
pub mod youtube;

pub use reqwest::Url;

/// Markdown bodies are capped at this many characters (the clip source cap).
pub const BODY_CHARS: usize = 20_000;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
pub type Result<T> = std::result::Result<T, Error>;

/// Which adapter produced an item. New adapters add a variant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceType {
    /// Any web page: an article, a blog post, a social post's public page.
    Web,
    /// An entry in a followed RSS, Atom or JSON Feed.
    Rss,
    /// An X (Twitter) post or thread, or a followed account's posts.
    X,
    /// A Reddit post with its comments.
    Reddit,
    /// A YouTube video, with its captions as a timestamped transcript.
    Youtube,
    /// A podcast episode, with a publisher or on-device transcript.
    Podcast,
    /// A PDF, from a local file or a link.
    Pdf,
    /// An EPUB e-book, from a local file or a link.
    Epub,
    /// A book's catalog record from Open Library (no text of the book).
    Book,
    /// A new book from a followed author (Google Books or Open Library).
    Author,
}

impl SourceType {
    pub fn as_str(self) -> &'static str {
        match self {
            SourceType::Web => "web",
            SourceType::Rss => "rss",
            SourceType::X => "x",
            SourceType::Reddit => "reddit",
            SourceType::Youtube => "youtube",
            SourceType::Podcast => "podcast",
            SourceType::Pdf => "pdf",
            SourceType::Epub => "epub",
            SourceType::Book => "book",
            SourceType::Author => "author",
        }
    }
}

/// The one normalized shape every adapter produces.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub source: SourceType,
    /// Stable across captures of the same thing: `<source>:<canonical key>`,
    /// e.g. `web:https://example.org/story`. Feeds deduplicate on it.
    pub id: String,
    /// The canonical URL, when the item has one.
    pub url: Option<String>,
    pub title: Option<String>,
    pub author: Option<String>,
    /// Publisher or platform name.
    pub site: Option<String>,
    /// The source's own short description (OpenGraph, an excerpt).
    pub description: Option<String>,
    /// When the source says it was published, as the source wrote it
    /// (usually ISO 8601).
    pub published: Option<String>,
    /// When the engine captured it: RFC 3339, UTC.
    pub captured: String,
    /// The primary image first.
    pub media: Vec<Media>,
    /// Readable content as Markdown, at most [`BODY_CHARS`] characters. Empty
    /// when the source had no readable text (a video, a bare image).
    pub body: String,
    /// Adapter-specific facts: `extractor` (which method produced the body),
    /// `lang`, `modified`, and later things like durations or reply counts.
    pub extras: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    Image,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Media {
    pub kind: MediaKind,
    /// Where it lives at the source, if it was found by URL.
    pub url: Option<String>,
    /// Downloaded bytes, only when the capture asked for media. Always a
    /// raster format checked by [`media::image_mime`], never SVG or HTML.
    #[serde(skip)]
    pub data: Option<MediaData>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MediaData {
    pub bytes: Vec<u8>,
    pub mime: String,
}

impl Item {
    /// The primary image's downloaded bytes, if any.
    pub fn primary_image(&self) -> Option<&MediaData> {
        self.media.first().and_then(|m| m.data.as_ref())
    }
}

/// Fixed, content-free reasons. Clip enrichment stores these as
/// `enrich_error`, so they must never include fetched text or URLs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    /// No adapter handles this target, or this adapter cannot poll.
    Unsupported,
    /// Only HTTP(S) URLs without embedded credentials are fetched.
    InvalidUrl,
    /// The source could not be reached or returned nothing usable.
    Unavailable,
    /// The source is larger than the download cap.
    TooLarge,
    /// The overall deadline passed.
    TimedOut,
    /// The client could not be started.
    Setup,
    /// The source answered with this HTTP error status (a number, never content).
    Status(u16),
    /// The document is not an RSS, Atom or JSON feed, and links to none.
    NotAFeed,
    /// The source asked us to slow down; nothing is sent until it allows.
    RateLimited,
    /// The source needs an optional tool the person has not agreed to
    /// download yet (see [`tools`]).
    ToolNeeded,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Error::Unsupported => "no source adapter handles this",
            Error::InvalidUrl => "source must use http or https without credentials",
            Error::Unavailable => "could not fetch source page",
            Error::TooLarge => "source exceeds download limit",
            Error::TimedOut => "page fetch timed out",
            Error::Setup => "could not start page fetcher",
            Error::Status(code) => return write!(f, "source answered HTTP {code}"),
            Error::NotAFeed => "source is not a feed",
            Error::RateLimited => "source is rate limiting requests",
            Error::ToolNeeded => "this source needs an optional tool that is not installed",
        })
    }
}

impl std::error::Error for Error {}

/// What to ingest.
#[derive(Debug, Clone, PartialEq)]
pub enum Target {
    Url(Url),
    /// A local file: a PDF or an EPUB.
    File(PathBuf),
}

impl Target {
    /// A web target, refusing anything but credential-free HTTP(S).
    pub fn url(raw: &str) -> Result<Self> {
        web::web_url(raw).map(Target::Url)
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct CaptureOptions {
    /// Download the primary image's bytes (skipped when a clip already has
    /// its own image, such as a shared screenshot).
    pub want_media: bool,
}

/// A followed source. The cursor is adapter-owned and opaque: an ETag, the
/// newest item id seen, a change-detection hash.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Subscription {
    pub url: String,
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Polled {
    /// Items newer than the subscription's cursor, newest first.
    pub items: Vec<Item>,
    /// Store this for the next poll.
    pub cursor: Option<String>,
    /// What the source said about itself, when it sent a fresh document.
    pub source: Option<SourceInfo>,
}

/// A followed source's own title, home page and image.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub title: Option<String>,
    pub url: Option<String>,
    pub image: Option<String>,
}

/// One kind of source. Object-safe so the engine can hold a list of them.
pub trait Adapter: Send + Sync {
    fn source(&self) -> SourceType;
    /// Whether this adapter can capture the target. Cheap; no I/O.
    fn matches(&self, target: &Target) -> bool;
    /// Fetch and normalize one item.
    fn capture<'a>(&'a self, target: &'a Target, options: CaptureOptions) -> BoxFuture<'a, Result<Item>>;
    /// New items from a followed source since its cursor. Adapters whose
    /// source cannot be followed keep this default.
    fn poll<'a>(&'a self, subscription: &'a Subscription) -> BoxFuture<'a, Result<Polled>> {
        let _ = subscription;
        Box::pin(async { Err(Error::Unsupported) })
    }
}

/// A shared adapter is still an adapter, so one instance can sit in an
/// engine and be called directly for its own extras (feed discovery).
impl<A: Adapter + ?Sized> Adapter for std::sync::Arc<A> {
    fn source(&self) -> SourceType {
        (**self).source()
    }
    fn matches(&self, target: &Target) -> bool {
        (**self).matches(target)
    }
    fn capture<'a>(&'a self, target: &'a Target, options: CaptureOptions) -> BoxFuture<'a, Result<Item>> {
        (**self).capture(target, options)
    }
    fn poll<'a>(&'a self, subscription: &'a Subscription) -> BoxFuture<'a, Result<Polled>> {
        (**self).poll(subscription)
    }
}

/// Routes targets to adapters, first match wins.
#[derive(Default)]
pub struct Engine {
    adapters: Vec<Box<dyn Adapter>>,
}

impl Engine {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds an adapter after the ones already registered.
    pub fn with(mut self, adapter: impl Adapter + 'static) -> Self {
        self.adapters.push(Box::new(adapter));
        self
    }

    pub fn adapter_for(&self, target: &Target) -> Option<&dyn Adapter> {
        self.adapters.iter().find(|a| a.matches(target)).map(|a| a.as_ref())
    }

    pub async fn capture(&self, target: &Target, options: CaptureOptions) -> Result<Item> {
        self.adapter_for(target).ok_or(Error::Unsupported)?.capture(target, options).await
    }

    /// Polls with the adapter for `source`.
    pub async fn poll(&self, source: SourceType, subscription: &Subscription) -> Result<Polled> {
        let adapter = self.adapters.iter().find(|a| a.source() == source).ok_or(Error::Unsupported)?;
        adapter.poll(subscription).await
    }
}

pub(crate) fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixed(&'static str);

    impl Adapter for Fixed {
        fn source(&self) -> SourceType {
            SourceType::Web
        }
        fn matches(&self, target: &Target) -> bool {
            matches!(target, Target::Url(url) if url.host_str() == Some(self.0))
        }
        fn capture<'a>(&'a self, _: &'a Target, _: CaptureOptions) -> BoxFuture<'a, Result<Item>> {
            Box::pin(async move {
                Ok(Item {
                    source: SourceType::Web,
                    id: format!("web:{}", self.0),
                    url: None,
                    title: Some(self.0.into()),
                    author: None,
                    site: None,
                    description: None,
                    published: None,
                    captured: now(),
                    media: vec![],
                    body: String::new(),
                    extras: BTreeMap::new(),
                })
            })
        }
    }

    fn run<T>(f: impl Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(f)
    }

    #[test]
    fn the_first_matching_adapter_captures() {
        let engine = Engine::new().with(Fixed("a.test")).with(Fixed("b.test"));
        let item = run(engine.capture(&Target::url("https://b.test/x").unwrap(), CaptureOptions::default())).unwrap();
        assert_eq!(item.title.as_deref(), Some("b.test"));
        assert!(item.captured.ends_with('Z'));
        let none = run(engine.capture(&Target::url("https://c.test/").unwrap(), CaptureOptions::default()));
        assert_eq!(none, Err(Error::Unsupported));
        assert!(engine.adapter_for(&Target::File("/tmp/x.pdf".into())).is_none());
    }

    #[test]
    fn adapters_without_subscriptions_refuse_to_poll() {
        let engine = Engine::new().with(Fixed("a.test"));
        let polled = run(engine.poll(SourceType::Web, &Subscription::default()));
        assert_eq!(polled, Err(Error::Unsupported));
    }

    #[test]
    fn items_serialize_with_camel_case_and_without_media_bytes() {
        let item = Item {
            source: SourceType::Web,
            id: "web:https://example.org/".into(),
            url: Some("https://example.org/".into()),
            title: None,
            author: None,
            site: None,
            description: None,
            published: None,
            captured: "2026-11-01T00:00:00Z".into(),
            media: vec![Media {
                kind: MediaKind::Image,
                url: Some("https://example.org/a.png".into()),
                data: Some(MediaData { bytes: vec![1, 2], mime: "image/png".into() }),
            }],
            body: "# Hi".into(),
            extras: BTreeMap::new(),
        };
        let json = serde_json::to_value(&item).unwrap();
        assert_eq!(json["source"], "web");
        assert_eq!(json["media"][0], serde_json::json!({ "kind": "image", "url": "https://example.org/a.png" }));
        assert!(json.get("extras").is_some());
    }

    #[test]
    fn errors_are_fixed_strings() {
        for (error, text) in [
            (Error::TimedOut, "page fetch timed out"),
            (Error::Unavailable, "could not fetch source page"),
            (Error::InvalidUrl, "source must use http or https without credentials"),
        ] {
            assert_eq!(error.to_string(), text);
        }
    }
}
