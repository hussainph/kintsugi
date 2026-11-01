//! The web page adapter: any credential-free HTTP(S) URL.
//!
//! 1. Download the page (bounded, every redirect re-checked).
//! 2. Read OpenGraph / Twitter card / `<title>` metadata and extract the
//!    readable article as Markdown with `dom_smoothie`, a Readability port.
//! 3. For platforms with oEmbed (YouTube, X, Bluesky, TikTok, Vimeo), merge the
//!    embed: a login-walled post's embed carries its actual text.
//! 4. When the static page has too little readable text (a JavaScript app, a
//!    bot wall), and a [`Renderer`] is configured, render it in a hidden local
//!    webview and run Defuddle there. See [`render`].
//! 5. Download the primary image when asked.
//!
//! Every step shares one overall deadline; a slow image or render never
//! discards what was already collected.

mod extract;
mod oembed;
pub mod render;

use crate::{
    Adapter, BoxFuture, CaptureOptions, Error, Item, Media, MediaData, MediaKind, Result, SourceType, Target, markdown,
    media::image_mime,
};
use futures_util::StreamExt;
use reqwest::{Client, Url};
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::time::Instant;

pub use render::{Rendered, Renderer};

const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15 Kintsugi/0.1";

/// Size caps and timeouts. The defaults are the clip contract in
/// `docs/inspiration.md`.
#[derive(Debug, Clone)]
pub struct Limits {
    pub html_bytes: usize,
    pub oembed_bytes: usize,
    pub image_bytes: usize,
    pub connect_timeout: Duration,
    pub request_timeout: Duration,
    /// Covers the whole capture: page, embed, render and image.
    pub deadline: Duration,
    /// The most a hidden-webview render may take, within the deadline.
    pub render_timeout: Duration,
    /// A static body shorter than this (in characters) counts as "nothing
    /// readable" and tries the renderer.
    pub min_readable_chars: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            html_bytes: 2 * 1024 * 1024,
            oembed_bytes: 256 * 1024,
            image_bytes: 8 * 1024 * 1024,
            connect_timeout: Duration::from_secs(5),
            request_timeout: Duration::from_secs(15),
            deadline: Duration::from_secs(45),
            render_timeout: Duration::from_secs(20),
            min_readable_chars: 200,
        }
    }
}

/// Reused across captures, with the same URL policy applied to every redirect.
pub struct WebAdapter {
    client: Client,
    limits: Limits,
    renderer: Option<Arc<dyn Renderer>>,
}

impl WebAdapter {
    pub fn new() -> Result<Self> {
        Self::with_limits(Limits::default())
    }

    pub fn with_limits(limits: Limits) -> Result<Self> {
        let client = Client::builder()
            .user_agent(USER_AGENT)
            .connect_timeout(limits.connect_timeout)
            .timeout(limits.request_timeout)
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= 5 || !allowed_url(attempt.url()) {
                    attempt.error("unsupported redirect")
                } else {
                    attempt.follow()
                }
            }))
            .build()
            .map_err(|_| Error::Setup)?;
        Ok(Self { client, limits, renderer: None })
    }

    /// Enables the JavaScript fallback. Without one (headless runs, tests),
    /// static extraction is all there is.
    pub fn with_renderer(mut self, renderer: Arc<dyn Renderer>) -> Self {
        self.renderer = Some(renderer);
        self
    }

    pub async fn fetch(&self, url: &Url, options: CaptureOptions) -> Result<Item> {
        if !allowed_url(url) {
            return Err(Error::InvalidUrl);
        }
        let deadline = Instant::now() + self.limits.deadline;
        let mut draft = tokio::time::timeout_at(deadline, self.read_static(url, options.want_media))
            .await
            .map_err(|_| Error::TimedOut)??;
        if self.should_render(&draft) {
            self.render_into(&mut draft, deadline).await;
        }
        if !draft.useful {
            return Err(Error::Unavailable);
        }
        if options.want_media
            && draft.image.is_none()
            && let Some(image_url) = draft.image_url.clone()
        {
            // Best effort: a slow thumbnail can exhaust the budget, but
            // never discards the page already collected.
            if let Ok(Ok(body)) = tokio::time::timeout_at(deadline, self.get(image_url, self.limits.image_bytes)).await
                && let Some(mime) = image_mime(&body.bytes)
            {
                draft.image = Some(MediaData { bytes: body.bytes, mime: mime.into() });
            }
        }
        Ok(draft.into_item())
    }

    async fn read_static(&self, url: &Url, want_media: bool) -> Result<Draft> {
        let page = self.download(url.clone(), self.limits.html_bytes, Some(self.limits.image_bytes)).await;
        let mut draft = Draft::new(url.clone());
        match &page {
            Ok(body) if is_html(body) => {
                draft.final_url = body.url.clone();
                draft.html = true;
                draft.useful = true;
                draft.apply(extract::page(&String::from_utf8_lossy(&body.bytes), &body.url));
            }
            // A directly shared image URL need not pretend to be an HTML page.
            Ok(body) => {
                if let Some(mime) = image_mime(&body.bytes) {
                    draft.final_url = body.url.clone();
                    draft.useful = true;
                    draft.direct_image = true;
                    draft.extractor = "image";
                    draft.image_url = Some(body.url.clone());
                    if want_media {
                        draft.image = Some(MediaData { bytes: body.bytes.clone(), mime: mime.into() });
                    }
                }
            }
            Err(Fail::Status) => draft.refused = true,
            Err(Fail::Other(_)) => {}
        }
        // Short links may only reveal their platform after the redirect.
        let endpoint =
            oembed::endpoint(url).or_else(|| page.as_ref().ok().and_then(|body| oembed::endpoint(&body.url)));
        if let Some(endpoint) = endpoint {
            draft.oembed_host = true;
            if let Ok(body) = self.get(endpoint, self.limits.oembed_bytes).await
                && let Ok(embed) = serde_json::from_slice::<oembed::OEmbed>(&body.bytes)
            {
                draft.useful = true;
                oembed::merge(&mut draft, embed);
            }
        }
        match page {
            Err(Fail::Other(Error::TooLarge)) if !draft.useful => Err(Error::TooLarge),
            _ => Ok(draft),
        }
    }

    /// Video and social platforms are served by their embeds (rendering a
    /// player helps nobody); images have nothing to render.
    fn should_render(&self, draft: &Draft) -> bool {
        self.renderer.is_some()
            && !draft.oembed_host
            && !draft.direct_image
            && (draft.html || draft.refused)
            && draft.body.trim().chars().count() < self.limits.min_readable_chars
    }

    async fn render_into(&self, draft: &mut Draft, deadline: Instant) {
        let Some(renderer) = &self.renderer else { return };
        let budget = deadline.saturating_duration_since(Instant::now()).min(self.limits.render_timeout);
        let render_deadline = Instant::now() + budget;
        let target = draft.final_url.clone();
        if let Ok(Ok(rendered)) = tokio::time::timeout_at(render_deadline, renderer.render(&target, budget)).await {
            draft.merge_rendered(rendered, &target);
        }
    }

    async fn get(&self, url: Url, limit: usize) -> Result<Body> {
        self.download(url, limit, None).await.map_err(|fail| match fail {
            Fail::Status => Error::Unavailable,
            Fail::Other(error) => error,
        })
    }

    async fn download(&self, url: Url, limit: usize, image_limit: Option<usize>) -> std::result::Result<Body, Fail> {
        if !allowed_url(&url) {
            return Err(Fail::Other(Error::InvalidUrl));
        }
        let response = self.client.get(url).send().await.map_err(|_| Fail::Other(Error::Unavailable))?;
        if !response.status().is_success() {
            return Err(Fail::Status);
        }
        let url = response.url().clone();
        let mime = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        let limit = if mime.starts_with("image/") { image_limit.unwrap_or(limit) } else { limit };
        if response.content_length().is_some_and(|n| n > limit as u64) {
            return Err(Fail::Other(Error::TooLarge));
        }
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| Fail::Other(Error::Unavailable))?;
            if chunk.len() > limit.saturating_sub(bytes.len()) {
                return Err(Fail::Other(Error::TooLarge));
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(Body { bytes, mime, url })
    }
}

impl Adapter for WebAdapter {
    fn source(&self) -> SourceType {
        SourceType::Web
    }

    fn matches(&self, target: &Target) -> bool {
        matches!(target, Target::Url(url) if allowed_url(url))
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

enum Fail {
    /// The server answered, but not with success: a bot wall may still
    /// render in a real browser.
    Status,
    Other(Error),
}

struct Body {
    bytes: Vec<u8>,
    mime: String,
    url: Url,
}

/// Everything known about a page while it is being captured.
#[derive(Debug, Clone)]
struct Draft {
    final_url: Url,
    canonical: Option<Url>,
    title: Option<String>,
    author: Option<String>,
    site: Option<String>,
    description: Option<String>,
    published: Option<String>,
    modified: Option<String>,
    lang: Option<String>,
    body: String,
    extractor: &'static str,
    image_url: Option<Url>,
    image: Option<MediaData>,
    useful: bool,
    html: bool,
    refused: bool,
    direct_image: bool,
    oembed_host: bool,
}

impl Draft {
    fn new(url: Url) -> Self {
        Self {
            final_url: url,
            canonical: None,
            title: None,
            author: None,
            site: None,
            description: None,
            published: None,
            modified: None,
            lang: None,
            body: String::new(),
            extractor: "none",
            image_url: None,
            image: None,
            useful: false,
            html: false,
            refused: false,
            direct_image: false,
            oembed_host: false,
        }
    }

    fn apply(&mut self, page: extract::Extracted) {
        self.canonical = page.canonical;
        self.title = page.title;
        self.author = page.author;
        self.site = page.site;
        self.description = page.description;
        self.published = page.published;
        self.modified = page.modified;
        self.lang = page.lang;
        self.image_url = page.image_url;
        self.extractor = page.extractor;
        self.body = page.body;
    }

    /// Fills gaps from the rendered page and takes its body when it found
    /// more to read. Static metadata wins: it is what the publisher declared.
    fn merge_rendered(&mut self, rendered: Rendered, base: &Url) {
        let rendered = rendered.bounded();
        fill(&mut self.title, rendered.title);
        fill(&mut self.author, rendered.author);
        fill(&mut self.site, rendered.site);
        fill(&mut self.description, rendered.description);
        fill(&mut self.published, rendered.published);
        fill(&mut self.lang, rendered.language);
        if self.image_url.is_none() {
            self.image_url = rendered.image.and_then(|s| base.join(&s).ok()).filter(allowed_url);
        }
        let body = rendered.content.map(|md| markdown::body(&md, crate::BODY_CHARS)).unwrap_or_default();
        if body.chars().count() > self.body.chars().count() {
            self.body = body;
            self.extractor = "defuddle";
            self.useful = true;
        } else if self.title.is_some() {
            self.useful = true;
        }
    }

    fn into_item(self) -> Item {
        let canonical = canonical_url(self.canonical.as_ref().unwrap_or(&self.final_url));
        let mut extras = BTreeMap::new();
        extras.insert("extractor".to_string(), Value::from(self.extractor));
        if let Some(lang) = self.lang {
            extras.insert("lang".to_string(), Value::from(lang));
        }
        if let Some(modified) = self.modified {
            extras.insert("modified".to_string(), Value::from(modified));
        }
        let media = if self.image_url.is_some() || self.image.is_some() {
            vec![Media { kind: MediaKind::Image, url: self.image_url.map(String::from), data: self.image }]
        } else {
            vec![]
        };
        Item {
            source: SourceType::Web,
            id: format!("web:{canonical}"),
            url: Some(canonical.to_string()),
            title: self.title,
            author: self.author,
            site: self.site,
            description: self.description,
            published: self.published,
            captured: crate::now(),
            media,
            body: self.body,
            extras,
        }
    }
}

fn fill(slot: &mut Option<String>, value: Option<String>) {
    if slot.is_none() {
        *slot = value;
    }
}

/// HTTP(S) with a host and no embedded credentials.
pub fn allowed_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
}

pub(crate) fn web_url(raw: &str) -> Result<Url> {
    Url::parse(raw).ok().filter(allowed_url).ok_or(Error::InvalidUrl)
}

/// The canonical form used for item ids: no fragment, no tracking parameters.
pub fn canonical_url(url: &Url) -> Url {
    let mut url = url.clone();
    url.set_fragment(None);
    let kept: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(key, _)| {
            let key = key.to_ascii_lowercase();
            !(key.starts_with("utm_")
                || matches!(key.as_str(), "fbclid" | "gclid" | "mc_cid" | "mc_eid" | "igshid" | "ref_src"))
        })
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    if kept.is_empty() {
        url.set_query(None);
    } else {
        url.query_pairs_mut().clear().extend_pairs(kept);
    }
    url
}

fn is_html(body: &Body) -> bool {
    body.mime.starts_with("text/html")
        || body.mime.starts_with("application/xhtml+xml")
        || (body.mime.is_empty()
            && std::str::from_utf8(&body.bytes).is_ok()
            && !body.bytes.contains(&0)
            && image_mime(&body.bytes).is_none())
}

#[cfg(test)]
mod tests;
