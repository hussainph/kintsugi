//! Podcast episodes: a transcript as the item's body.
//!
//! Episodes arrive from the Feed (which owns podcast subscriptions) as an
//! [`Episode`], parsed from the show's RSS with [`episodes`], or found by
//! feed URL and GUID with [`PodcastAdapter::capture_from_feed`]. A pasted
//! link to an audio file (`.mp3`, `.m4a`…) is an episode too.
//!
//! 1. **Publisher transcript** first: the Podcasting 2.0 `<podcast:transcript>`
//!    tag (the namespace Podcast Index maintains). JSON, WebVTT and SubRip are
//!    timed; HTML and plain text are kept as they are.
//! 2. Otherwise **on-device transcription** of the enclosure with the
//!    configured [`Transcriber`] (Apple SpeechAnalyzer on the Mac).
//! 3. Otherwise the show notes, marked `transcript: unavailable`.
//!
//! Timestamps link to the audio with a media fragment (`<audio>#t=754`), so a
//! quote can jump to its moment.

use crate::fetch::Fetcher;
use crate::transcribe::Transcriber;
use crate::transcript::{self, Parsed};
use crate::web::{allowed_url, canonical_url};
use crate::{
    Adapter, BoxFuture, CaptureOptions, Error, Item, Media, MediaData, MediaKind, Result, SourceType, Target, markdown,
    media::image_mime,
};
use reqwest::Url;
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

/// A link to a transcript, as `<podcast:transcript>` declares it.
#[derive(Debug, Clone, PartialEq)]
pub struct TranscriptLink {
    pub url: Url,
    pub mime: String,
    pub language: Option<String>,
    /// `captions` marks a file meant as closed captions.
    pub rel: Option<String>,
}

/// One episode, as the Feed knows it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Episode {
    /// The feed it came from; with `guid`, the item's stable id.
    pub feed_url: Option<String>,
    pub guid: Option<String>,
    pub title: Option<String>,
    /// The show's name.
    pub show: Option<String>,
    pub author: Option<String>,
    /// The episode's web page.
    pub link: Option<Url>,
    pub audio_url: Option<Url>,
    pub published: Option<String>,
    /// Show notes, as HTML or text.
    pub notes: Option<String>,
    pub image: Option<Url>,
    /// Seconds.
    pub duration: Option<u64>,
    pub language: Option<String>,
    pub transcripts: Vec<TranscriptLink>,
}

/// Limits for what an episode capture may download.
#[derive(Debug, Clone)]
pub struct Limits {
    pub feed_bytes: u64,
    pub transcript_bytes: u64,
    pub audio_bytes: u64,
    pub image_bytes: u64,
    /// Covers the feed, transcript and image fetches.
    pub fetch_timeout: Duration,
    /// Covers downloading the audio.
    pub audio_timeout: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            feed_bytes: 16 * 1024 * 1024,
            transcript_bytes: 8 * 1024 * 1024,
            audio_bytes: 1024 * 1024 * 1024,
            image_bytes: 8 * 1024 * 1024,
            fetch_timeout: Duration::from_secs(45),
            audio_timeout: Duration::from_secs(30 * 60),
        }
    }
}

pub struct PodcastAdapter {
    fetcher: Fetcher,
    transcriber: Option<Arc<dyn Transcriber>>,
    limits: Limits,
}

impl PodcastAdapter {
    pub fn new() -> Result<Self> {
        Ok(Self { fetcher: Fetcher::new()?, transcriber: None, limits: Limits::default() })
    }

    /// Enables on-device transcription for episodes without a publisher
    /// transcript.
    pub fn with_transcriber(mut self, transcriber: Arc<dyn Transcriber>) -> Self {
        self.transcriber = Some(transcriber);
        self
    }

    pub fn with_limits(mut self, limits: Limits) -> Self {
        self.limits = limits;
        self
    }

    /// Fetches the show's feed and captures the episode with this GUID (or,
    /// without one, the newest episode).
    pub async fn capture_from_feed(&self, feed_url: &Url, guid: Option<&str>, options: CaptureOptions) -> Result<Item> {
        let feed = tokio::time::timeout(self.limits.fetch_timeout, self.fetcher.bytes(feed_url, self.limits.feed_bytes))
            .await
            .map_err(|_| Error::TimedOut)??;
        let mut list = episodes(&String::from_utf8_lossy(&feed.bytes), feed_url);
        let index = match guid {
            Some(guid) => list.iter().position(|e| e.guid.as_deref() == Some(guid)).ok_or(Error::Unavailable)?,
            None if !list.is_empty() => 0,
            None => return Err(Error::Unavailable),
        };
        self.capture_episode(&list.swap_remove(index), options).await
    }

    /// Captures one episode: publisher transcript, then on-device
    /// transcription, then show notes.
    pub async fn capture_episode(&self, episode: &Episode, options: CaptureOptions) -> Result<Item> {
        let mut extras = BTreeMap::new();
        extras.insert("extractor".to_string(), Value::from("podcast"));
        // Downloads go through the enclosure as published; everything written
        // into the item (its URL, timestamp links) skips the tracking
        // redirects in front of the audio file.
        let enclosure = episode.audio_url.as_ref().filter(|u| allowed_url(u));
        let untracked = enclosure.map(untrack);
        let audio = untracked.as_ref();
        let link = |t: u64| audio.map(|a| format!("{}#t={t}", without_fragment(a)));

        let mut body = None;
        if let Some((found, mime)) = self.publisher_transcript(episode).await {
            extras.insert("transcript".into(), Value::from("publisher"));
            extras.insert("transcriptType".into(), Value::from(mime));
            body = Some(match found {
                Parsed::Timed(segments) => {
                    let (md, cut) = transcript::to_markdown(&segments, &[], &link);
                    if cut {
                        extras.insert("truncated".into(), Value::from(true));
                    }
                    md
                }
                Parsed::Untimed(md) => md,
            });
        }
        let mut reason = "no-transcript";
        if body.is_none()
            && let (Some(transcriber), Some(enclosure)) = (&self.transcriber, enclosure)
        {
            match self.transcribe(transcriber.as_ref(), enclosure, episode.language.as_deref()).await {
                Ok(segments) if !segments.is_empty() => {
                    let (md, cut) = transcript::to_markdown(&segments, &[], &link);
                    extras.insert("transcript".into(), Value::from("on-device"));
                    extras.insert("transcriber".into(), Value::from(transcriber.name()));
                    if cut {
                        extras.insert("truncated".into(), Value::from(true));
                    }
                    body = Some(md);
                }
                Ok(_) => reason = "no-speech",
                Err(Error::ToolNeeded) => reason = "model-not-installed",
                Err(Error::Unsupported) => reason = "transcription-unsupported",
                Err(_) => reason = "transcription-failed",
            }
        } else if body.is_none() && audio.is_some() {
            reason = "no-transcriber";
        }
        let body = match body {
            Some(body) => body,
            None => {
                extras.insert("transcript".into(), Value::from("unavailable"));
                extras.insert("transcriptReason".into(), Value::from(reason));
                episode.notes.as_deref().map(notes_markdown).unwrap_or_default()
            }
        };
        if let Some(duration) = episode.duration {
            extras.insert("duration".into(), Value::from(duration));
        }
        if let Some(audio) = audio {
            extras.insert("audioUrl".into(), Value::from(audio.as_str()));
        }
        if let Some(lang) = episode.language.as_deref().and_then(|l| markdown::field(l, 40)) {
            extras.insert("lang".into(), Value::from(lang));
        }

        let mut media = Vec::new();
        if let Some(image) = episode.image.as_ref().filter(|u| allowed_url(u)) {
            let mut data = None;
            if options.want_media
                && let Ok(Ok(fetched)) =
                    tokio::time::timeout(Duration::from_secs(15), self.fetcher.bytes(image, self.limits.image_bytes)).await
                && let Some(mime) = image_mime(&fetched.bytes)
            {
                data = Some(MediaData { bytes: fetched.bytes, mime: mime.into() });
            }
            media.push(Media { kind: MediaKind::Image, url: Some(image.to_string()), data });
        }

        let page = episode.link.as_ref().filter(|u| allowed_url(u)).map(canonical_url);
        let key = match (&episode.feed_url, &episode.guid) {
            (Some(feed), Some(guid)) => format!("{feed}#{guid}"),
            _ => page.as_ref().or(audio).map(|u| u.to_string()).ok_or(Error::Unavailable)?,
        };
        Ok(Item {
            source: SourceType::Podcast,
            id: format!("podcast:{key}"),
            url: page.map(String::from).or_else(|| audio.map(|a| a.to_string())),
            title: episode.title.as_deref().and_then(|t| markdown::field(t, 500)),
            author: episode.author.as_deref().and_then(|a| markdown::field(a, 200)),
            site: episode.show.as_deref().and_then(|s| markdown::field(s, 200)),
            description: episode.notes.as_deref().map(notes_text).and_then(|t| markdown::field(&t, 2000)),
            published: episode.published.as_deref().and_then(|p| markdown::field(p, 64)),
            captured: crate::now(),
            media,
            body,
            extras,
        })
    }

    /// The best transcript the publisher declared that downloads and parses:
    /// timed formats first (JSON, then WebVTT, then SubRip), the episode's
    /// language first.
    async fn publisher_transcript(&self, episode: &Episode) -> Option<(Parsed, String)> {
        let rank = |t: &TranscriptLink| {
            let format = match t.mime.as_str() {
                "application/json" => 0,
                "text/vtt" => 1,
                "application/x-subrip" | "application/srt" | "text/srt" => 2,
                "text/html" => 3,
                _ => 4,
            };
            let lang = |l: &Option<String>| l.as_deref().map(|l| l.split(['-', '_']).next().unwrap_or("").to_ascii_lowercase());
            let other_language = lang(&t.language).is_some() && lang(&t.language) != lang(&episode.language);
            (other_language, format)
        };
        let mut links: Vec<&TranscriptLink> = episode.transcripts.iter().filter(|t| allowed_url(&t.url)).collect();
        links.sort_by_key(|t| rank(t));
        for link in links.into_iter().take(3) {
            let fetched =
                tokio::time::timeout(self.limits.fetch_timeout, self.fetcher.bytes(&link.url, self.limits.transcript_bytes)).await;
            let Ok(Ok(fetched)) = fetched else { continue };
            let mime = if link.mime.is_empty() { fetched.mime.clone() } else { link.mime.clone() };
            if let Some(parsed) = transcript::parse(&String::from_utf8_lossy(&fetched.bytes), &mime) {
                return Some((parsed, mime));
            }
        }
        None
    }

    async fn transcribe(
        &self,
        transcriber: &dyn Transcriber,
        audio: &Url,
        language: Option<&str>,
    ) -> Result<Vec<transcript::Segment>> {
        let work = tempfile::Builder::new().prefix("kintsugi-podcast-").tempdir().map_err(|_| Error::Setup)?;
        // Keep the extension: AVAudioFile and other decoders sniff by it.
        let ext = audio
            .path_segments()
            .and_then(|mut s| s.next_back())
            .and_then(|name| name.rsplit_once('.'))
            .map(|(_, ext)| ext.to_ascii_lowercase())
            .filter(|ext| AUDIO_EXTENSIONS.contains(&ext.as_str()))
            .unwrap_or_else(|| "mp3".into());
        let path = work.path().join(format!("episode.{ext}"));
        tokio::time::timeout(self.limits.audio_timeout, self.fetcher.to_file(audio, self.limits.audio_bytes, &path))
            .await
            .map_err(|_| Error::TimedOut)??;
        transcriber.transcribe(&path, language).await
    }
}

impl Adapter for PodcastAdapter {
    fn source(&self) -> SourceType {
        SourceType::Podcast
    }

    /// Direct links to audio files. Episode pages are web pages; episodes
    /// from feeds come through [`PodcastAdapter::capture_episode`].
    fn matches(&self, target: &Target) -> bool {
        matches!(target, Target::Url(url) if allowed_url(url) && is_audio_url(url))
    }

    fn capture<'a>(&'a self, target: &'a Target, options: CaptureOptions) -> BoxFuture<'a, Result<Item>> {
        Box::pin(async move {
            let Target::Url(url) = target else { return Err(Error::Unsupported) };
            let title = url
                .path_segments()
                .and_then(|mut s| s.next_back())
                .map(|name| name.rsplit_once('.').map_or(name, |(stem, _)| stem).replace(['-', '_'], " "));
            let episode = Episode { audio_url: Some(url.clone()), title, ..Episode::default() };
            self.capture_episode(&episode, options).await
        })
    }
}

/// Measurement redirects podcast hosts put in front of the audio file, by
/// host, and the path segments before the real URL. `*` is any segment,
/// and a trailing `*` matches a segment's start (`e,pg=…`, `redirect.mp3`).
const TRACKERS: &[(&str, &[&str])] = &[
    ("op3.dev", &["e*"]),
    ("dts.podtrac.com", &["redirect.*"]),
    ("podtrac.com", &["pts", "redirect.*"]),
    ("www.podtrac.com", &["pts", "redirect.*"]),
    ("chtbl.com", &["track", "*"]),
    ("chrt.fm", &["track", "*"]),
    ("pdst.fm", &["e"]),
    ("pdcn.co", &["e"]),
    ("pfx.vpixl.com", &["*"]),
    ("mgln.ai", &["e", "*"]),
    ("arttrk.com", &["p", "*"]),
    ("verifi.podscribe.com", &["rss", "p"]),
    ("pscrb.fm", &["rss", "p"]),
    ("prfx.byspotify.com", &["e"]),
    ("claritaspod.com", &["measure"]),
    ("tracking.swap.fm", &["track", "*"]),
];

/// The URL behind any chain of known podcast tracking redirects (OP3,
/// Podtrac, Chartable, Podsights, Spotify's prefix…), or the URL itself.
/// The result must still be an allowed web URL.
pub fn untrack(url: &Url) -> Url {
    let mut current = url.clone();
    for _ in 0..8 {
        match strip_tracker(&current) {
            Some(next) => current = next,
            None => break,
        }
    }
    current
}

/// Whether a URL starts with a known tracking redirect.
pub fn is_tracked(url: &Url) -> bool {
    strip_tracker(url).is_some()
}

fn strip_tracker(url: &Url) -> Option<Url> {
    let host = url.host_str()?.to_ascii_lowercase();
    let (_, pattern) = TRACKERS.iter().find(|(h, _)| *h == host)?;
    // The wrapped URL is the rest of the path, with its own `//` and query.
    let full = match url.query() {
        Some(query) => format!("{}?{query}", url.path()),
        None => url.path().to_string(),
    };
    let mut rest = full.strip_prefix('/')?;
    for want in pattern.iter() {
        let (segment, tail) = rest.split_once('/')?;
        let ok = match want.strip_suffix('*') {
            Some("") => !segment.is_empty(),
            Some(prefix) => segment.starts_with(prefix),
            None => segment == *want,
        };
        if !ok {
            return None;
        }
        rest = tail;
    }
    let rest = rest.trim_start_matches('/');
    let target = if rest.starts_with("http://") || rest.starts_with("https://") {
        rest.to_string()
    } else if let Some(stripped) = rest.strip_prefix("https:/").or_else(|| rest.strip_prefix("http:/")) {
        // A proxy that collapsed the scheme's `//`.
        format!("https://{stripped}")
    } else {
        format!("https://{rest}")
    };
    Url::parse(&target).ok().filter(allowed_url).filter(|u| u.host_str().is_some_and(|h| h.contains('.')))
}

const AUDIO_EXTENSIONS: &[&str] = &["mp3", "m4a", "aac", "wav", "aiff", "aif", "flac", "ogg", "opus", "caf"];

fn is_audio_url(url: &Url) -> bool {
    url.path_segments()
        .and_then(|mut s| s.next_back())
        .and_then(|name| name.rsplit_once('.'))
        .is_some_and(|(_, ext)| AUDIO_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
}

fn without_fragment(url: &Url) -> Url {
    let mut url = url.clone();
    url.set_fragment(None);
    url
}

/// Show notes as Markdown (they are usually HTML).
fn notes_markdown(notes: &str) -> String {
    if notes.contains('<') {
        let doc = dom_query::Document::from(notes);
        let body = doc.select("body");
        let md = body.nodes().first().map(|root| root.md(Some(&["script", "style"]))).unwrap_or_default();
        markdown::body(&md, crate::BODY_CHARS)
    } else {
        markdown::body(notes, crate::BODY_CHARS)
    }
}

fn notes_text(notes: &str) -> String {
    if !notes.contains('<') {
        return notes.to_string();
    }
    let doc = dom_query::Document::from(notes);
    doc.select("script, style").remove();
    doc.select("body").text().to_string()
}

/// Every episode in a podcast RSS feed, in feed order (usually newest
/// first), with its enclosure and `<podcast:transcript>` links resolved
/// against the feed URL.
pub fn episodes(xml: &str, feed_url: &Url) -> Vec<Episode> {
    const ITUNES: &str = "http://www.itunes.com/dtds/podcast-1.0.dtd";
    const PODCAST: &str = "https://podcastindex.org/namespace/1.0";
    const CONTENT: &str = "http://purl.org/rss/1.0/modules/content/";
    let options = roxmltree::ParsingOptions { allow_dtd: false, ..Default::default() };
    let Ok(doc) = roxmltree::Document::parse_with_options(xml, options) else { return vec![] };
    let Some(channel) = doc.descendants().find(|n| n.has_tag_name("channel")) else { return vec![] };
    fn child<'a, 'i>(node: roxmltree::Node<'a, 'i>, ns: Option<&str>, name: &str) -> Option<roxmltree::Node<'a, 'i>> {
        node.children().find(|c| c.tag_name().name() == name && c.tag_name().namespace() == ns)
    }
    fn text(node: roxmltree::Node, ns: Option<&str>, name: &str) -> Option<String> {
        child(node, ns, name).and_then(|c| c.text()).map(str::trim).filter(|t| !t.is_empty()).map(String::from)
    }
    let resolve = |raw: &str| feed_url.join(raw.trim()).ok().filter(allowed_url);
    let image = |node: roxmltree::Node| {
        child(node, Some(ITUNES), "image")
            .and_then(|i| i.attribute("href"))
            .or_else(|| child(node, None, "image").and_then(|i| child(i, None, "url")).and_then(|u| u.text()))
            .and_then(resolve)
    };
    let show = text(channel, None, "title");
    let show_author = text(channel, Some(ITUNES), "author");
    let show_language = text(channel, None, "language");
    let show_image = image(channel);
    channel
        .children()
        .filter(|n| n.has_tag_name("item"))
        .map(|item| {
            let enclosure = child(item, None, "enclosure");
            let transcripts = item
                .children()
                .filter(|c| c.tag_name().name() == "transcript" && c.tag_name().namespace() == Some(PODCAST))
                .filter_map(|t| {
                    Some(TranscriptLink {
                        url: resolve(t.attribute("url")?)?,
                        mime: t.attribute("type").unwrap_or("").trim().to_ascii_lowercase(),
                        language: t.attribute("language").map(String::from),
                        rel: t.attribute("rel").map(String::from),
                    })
                })
                .collect();
            Episode {
                feed_url: Some(feed_url.to_string()),
                guid: text(item, None, "guid"),
                title: text(item, None, "title"),
                show: show.clone(),
                author: text(item, Some(ITUNES), "author").or_else(|| show_author.clone()),
                link: text(item, None, "link").and_then(|l| resolve(&l)),
                audio_url: enclosure.and_then(|e| e.attribute("url")).and_then(resolve),
                published: text(item, None, "pubDate"),
                notes: text(item, Some(CONTENT), "encoded")
                    .or_else(|| text(item, None, "description"))
                    .or_else(|| text(item, Some(ITUNES), "summary")),
                image: image(item).or_else(|| show_image.clone()),
                duration: text(item, Some(ITUNES), "duration").and_then(|d| duration(&d)),
                language: show_language.clone(),
                transcripts,
            }
        })
        .collect()
}

/// `itunes:duration`: seconds, `mm:ss` or `hh:mm:ss`.
fn duration(raw: &str) -> Option<u64> {
    raw.split(':').try_fold(0u64, |total, part| {
        let value: f64 = part.trim().parse().ok()?;
        (value.is_finite() && value >= 0.0).then(|| total * 60 + value as u64)
    })
}

#[cfg(test)]
mod tests;
