//! YouTube videos: transcripts from the video's own subtitles, fetched by
//! yt-dlp (`--skip-download --write-subs --write-auto-subs`), an optional
//! tool downloaded on first need (see [`crate::tools`]).
//!
//! YouTube changes often, so yt-dlp is kept fresh: the tools manager checks
//! for a new release at most daily, and a failed run checks again (at most
//! hourly) and retries once with the new release. When Deno is installed it
//! is passed to yt-dlp, which needs a JavaScript runtime for YouTube's
//! player challenges.
//!
//! The item's body is the transcript as timestamped Markdown paragraphs,
//! each linking to `watch?v=<id>&t=<seconds>s`, with chapters as headings.
//! Manual subtitles beat automatic captions; the video's own language beats
//! English, and English beats translations.
//!
//! Without yt-dlp (no consent yet), the adapter hands the URL to a fallback
//! adapter (the web adapter's oEmbed metadata) when one is configured, and
//! otherwise fails with [`Error::ToolNeeded`].

use crate::fetch::Fetcher;
use crate::tools::{ToolError, Tools, catalog};
use crate::transcript::{self, Chapter};
use crate::{
    Adapter, BoxFuture, CaptureOptions, Error, Item, Media, MediaData, MediaKind, Result, SourceType, Target, markdown,
    media::image_mime,
};
use reqwest::Url;
use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

/// Caption languages asked of yt-dlp (regular expressions): English and
/// every original (untranslated) auto-caption track. `en.*` would also
/// fetch machine translations into English (`en-de`), and all languages
/// about a hundred. Manual subtitles in other languages are fetched from
/// the info JSON if needed.
pub const DEFAULT_LANGUAGES: &str = "en,en-[A-Z]{2},.*-orig";

pub struct YouTubeAdapter {
    tools: Arc<Tools>,
    fallback: Option<Arc<dyn Adapter>>,
    languages: String,
    timeout: Duration,
    fetcher: Fetcher,
}

impl YouTubeAdapter {
    pub fn new(tools: Arc<Tools>) -> Result<Self> {
        Ok(Self {
            tools,
            fallback: None,
            languages: DEFAULT_LANGUAGES.into(),
            timeout: Duration::from_secs(180),
            fetcher: Fetcher::new()?,
        })
    }

    /// Captures metadata some other way while yt-dlp is not installed.
    pub fn with_fallback(mut self, adapter: Arc<dyn Adapter>) -> Self {
        self.fallback = Some(adapter);
        self
    }

    /// yt-dlp's `--sub-langs` value.
    pub fn with_languages(mut self, languages: impl Into<String>) -> Self {
        self.languages = languages.into();
        self
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub async fn fetch(&self, id: &str, options: CaptureOptions) -> Result<Item> {
        let program = match self.tools.ensure(&catalog::YT_DLP).await {
            Ok(path) => path,
            Err(error) => return self.without_tool(id, options, error).await,
        };
        let work = tempfile::Builder::new().prefix("kintsugi-yt-").tempdir().map_err(|_| Error::Setup)?;
        let video = match self.run(&program, id, work.path()).await {
            Ok(video) => video,
            Err(error) => {
                // YouTube may have changed under this release: check for a
                // newer one (at most hourly) and try once more with it.
                match self.tools.update_if_stale(&catalog::YT_DLP, Duration::from_secs(3600)).await {
                    Ok(fresh) if fresh != program => {
                        let _ = std::fs::remove_dir_all(work.path()).and_then(|_| std::fs::create_dir_all(work.path()));
                        self.run(&fresh, id, work.path()).await?
                    }
                    _ => return Err(error),
                }
            }
        };
        let mut video = video;
        if video.captions.is_none() {
            // yt-dlp found the tracks but could not download them (its
            // impersonating HTTP client can fail where a plain request
            // works): fetch the chosen track's WebVTT from the info JSON.
            video.captions = self.fetch_captions(&video.info).await;
        }
        let mut item = video.into_item(id);
        if options.want_media
            && let Some(url) = item.media.first().and_then(|m| m.url.as_deref()).and_then(|u| Url::parse(u).ok())
            && let Ok(Ok(image)) = tokio::time::timeout(Duration::from_secs(15), self.fetcher.bytes(&url, 8 * 1024 * 1024)).await
            && let Some(mime) = image_mime(&image.bytes)
        {
            item.media[0].data = Some(MediaData { bytes: image.bytes, mime: mime.into() });
        }
        Ok(item)
    }

    async fn fetch_captions(&self, info: &Info) -> Option<Captions> {
        for (lang, url) in remote_tracks(info).into_iter().take(2) {
            let fetched = tokio::time::timeout(Duration::from_secs(20), self.fetcher.bytes(&url, 8 * 1024 * 1024)).await;
            let Ok(Ok(fetched)) = fetched else { continue };
            let segments = transcript::parse_cues(&String::from_utf8_lossy(&fetched.bytes));
            if !segments.is_empty() {
                let manual = is_manual(info, &lang);
                return Some(Captions { lang, manual, segments });
            }
        }
        None
    }

    async fn without_tool(&self, id: &str, options: CaptureOptions, error: ToolError) -> Result<Item> {
        let Some(fallback) = &self.fallback else {
            return Err(if error == ToolError::NeedsConsent { Error::ToolNeeded } else { Error::Unavailable });
        };
        let target = Target::Url(Url::parse(&watch_url(id)).map_err(|_| Error::InvalidUrl)?);
        let mut item = fallback.capture(&target, options).await?;
        item.extras.insert("transcript".into(), Value::from("unavailable"));
        item.extras.insert(
            "transcriptReason".into(),
            Value::from(if error == ToolError::NeedsConsent { "tool-not-installed" } else { "tool-unavailable" }),
        );
        Ok(item)
    }

    async fn run(&self, program: &Path, id: &str, dir: &Path) -> Result<Video> {
        let mut command = tokio::process::Command::new(program);
        command
            .args(["--ignore-config", "--no-playlist", "--skip-download", "--write-info-json"])
            .args(["--no-write-playlist-metafiles", "--write-subs", "--write-auto-subs"])
            .args(["--sub-format", "vtt/best", "--sub-langs", &self.languages])
            .args(["--no-progress", "--no-color", "--socket-timeout", "10", "--retries", "1"])
            .arg("--cache-dir")
            .arg(self.tools.root().join("yt-dlp-cache"))
            .arg("--paths")
            .arg(dir)
            .args(["--output", "%(id)s.%(ext)s"]);
        if let Some(deno) = self.tools.path(&catalog::DENO) {
            command.arg("--js-runtimes").arg(format!("deno:{}", deno.display()));
        }
        command
            .arg("--")
            .arg(watch_url(id))
            .current_dir(dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = command.spawn().map_err(|_| Error::Unavailable)?;
        let status = tokio::time::timeout(self.timeout, child.wait()).await.map_err(|_| Error::TimedOut)?;
        let info = std::fs::read(dir.join(format!("{id}.info.json"))).map_err(|_| Error::Unavailable)?;
        if info.len() > 32 * 1024 * 1024 {
            return Err(Error::TooLarge);
        }
        let info: Info = serde_json::from_slice(&info).map_err(|_| Error::Unavailable)?;
        // A video without captions still succeeds; a failed run without
        // metadata does not.
        if !status.map_err(|_| Error::Unavailable)?.success() && info.title.is_none() {
            return Err(Error::Unavailable);
        }
        let captions = pick_captions(&info, id, dir);
        Ok(Video { info, captions })
    }
}

impl Adapter for YouTubeAdapter {
    fn source(&self) -> SourceType {
        SourceType::Youtube
    }

    fn matches(&self, target: &Target) -> bool {
        matches!(target, Target::Url(url) if video_id(url).is_some())
    }

    fn capture<'a>(&'a self, target: &'a Target, options: CaptureOptions) -> BoxFuture<'a, Result<Item>> {
        Box::pin(async move {
            match target {
                Target::Url(url) => self.fetch(&video_id(url).ok_or(Error::Unsupported)?, options).await,
                Target::File(_) => Err(Error::Unsupported),
            }
        })
    }
}

/// The 11-character video id of a YouTube watch, short, shorts, live or
/// embed URL. Channels, playlists and searches are not videos.
pub fn video_id(url: &Url) -> Option<String> {
    if !crate::web::allowed_url(url) {
        return None;
    }
    let host = url.host_str()?.to_ascii_lowercase();
    let host = host.strip_prefix("www.").or_else(|| host.strip_prefix("m.")).unwrap_or(&host);
    let mut path = url.path_segments()?.filter(|s| !s.is_empty());
    let id = match host {
        "youtu.be" => path.next()?.to_string(),
        "youtube.com" | "music.youtube.com" | "youtube-nocookie.com" => match path.next()? {
            "watch" => url.query_pairs().find(|(k, _)| k == "v")?.1.into_owned(),
            "shorts" | "live" | "embed" | "v" => path.next()?.to_string(),
            _ => return None,
        },
        _ => return None,
    };
    (id.len() == 11 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')).then_some(id)
}

pub fn watch_url(id: &str) -> String {
    format!("https://www.youtube.com/watch?v={id}")
}

/// The fields of yt-dlp's `.info.json` that the item uses.
#[derive(Debug, Default, Deserialize)]
struct Info {
    title: Option<String>,
    uploader: Option<String>,
    channel: Option<String>,
    channel_url: Option<String>,
    upload_date: Option<String>,
    description: Option<String>,
    duration: Option<f64>,
    thumbnail: Option<String>,
    language: Option<String>,
    #[serde(default)]
    chapters: Option<Vec<RawChapter>>,
    #[serde(default)]
    subtitles: HashMap<String, Value>,
    #[serde(default)]
    automatic_captions: HashMap<String, Value>,
    #[serde(default)]
    was_live: Option<bool>,
    #[serde(rename = "_version", default)]
    version: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct RawChapter {
    start_time: Option<f64>,
    title: Option<String>,
}

struct Captions {
    lang: String,
    manual: bool,
    segments: Vec<transcript::Segment>,
}

struct Video {
    info: Info,
    captions: Option<Captions>,
}

/// Chooses among the caption files yt-dlp wrote: manual over automatic,
/// the video's language over English over anything else, untranslated
/// (`-orig`) over translated.
fn pick_captions(info: &Info, id: &str, dir: &Path) -> Option<Captions> {
    let prefix = format!("{id}.");
    let mut files: Vec<(String, PathBuf)> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let lang = name.strip_prefix(&prefix)?.strip_suffix(".vtt")?.to_string();
            (lang != "live_chat").then(|| (lang, entry.path()))
        })
        .collect();
    files.sort_by(|a, b| score(info, &b.0).cmp(&score(info, &a.0)).then_with(|| a.0.cmp(&b.0)));
    files.into_iter().find_map(|(lang, path)| {
        let text = std::fs::read_to_string(&path).ok()?;
        let segments = transcript::parse_cues(&text);
        let manual = is_manual(info, &lang);
        (!segments.is_empty()).then_some(Captions { lang, manual, segments })
    })
}

/// yt-dlp writes a language's manual subtitles when it has both.
fn is_manual(info: &Info, lang: &str) -> bool {
    info.subtitles.contains_key(lang)
}

fn base_lang(lang: &str) -> String {
    lang.trim_end_matches("-orig").split(['-', '_']).next().unwrap_or("").to_ascii_lowercase()
}

/// Manual over automatic, the video's language over English over the
/// rest, untranslated over translated.
fn score(info: &Info, lang: &str) -> u8 {
    let manual = is_manual(info, lang);
    let own = info.language.as_deref().is_some_and(|v| base_lang(v) == base_lang(lang));
    let original = lang.ends_with("-orig") || manual;
    (manual as u8) * 8 + (own as u8) * 4 + ((base_lang(lang) == "en") as u8) * 2 + original as u8
}

/// WebVTT tracks listed in the info JSON, best first: manual subtitles, and
/// automatic captions that are untranslated or in English. Only YouTube's
/// own HTTPS caption endpoint is fetched.
fn remote_tracks(info: &Info) -> Vec<(String, Url)> {
    let vtt = |formats: &Value| {
        formats.as_array()?.iter().find(|f| f.get("ext").and_then(Value::as_str) == Some("vtt"))?.get("url")?.as_str().map(String::from)
    };
    let mut tracks: Vec<(String, Url)> = info
        .subtitles
        .iter()
        .filter(|(lang, _)| lang.as_str() != "live_chat")
        .chain(info.automatic_captions.iter().filter(|(lang, _)| {
            lang.ends_with("-orig") || base_lang(lang) == "en" || info.language.as_deref().is_some_and(|v| v == lang.as_str())
        }))
        .filter_map(|(lang, formats)| {
            let url = Url::parse(&vtt(formats)?).ok()?;
            let host = url.host_str()?.to_ascii_lowercase();
            let youtube = url.scheme() == "https" && (host == "youtube.com" || host.ends_with(".youtube.com"));
            (youtube || (cfg!(test) && host == "127.0.0.1"))
                .then(|| (lang.clone(), url))
        })
        .collect();
    tracks.sort_by(|a, b| score(info, &b.0).cmp(&score(info, &a.0)).then_with(|| a.0.cmp(&b.0)));
    tracks.dedup_by(|a, b| a.0 == b.0);
    tracks
}

impl Video {
    fn into_item(self, id: &str) -> Item {
        let info = self.info;
        let url = watch_url(id);
        let mut extras = BTreeMap::new();
        extras.insert("extractor".into(), Value::from("yt-dlp"));
        if let Some(version) = info.version.as_ref().and_then(|v| v.get("version")).and_then(Value::as_str) {
            extras.insert("toolVersion".into(), Value::from(version));
        }
        if let Some(duration) = info.duration.filter(|d| d.is_finite() && *d >= 0.0) {
            extras.insert("duration".into(), Value::from(duration.round() as u64));
        }
        if let Some(channel) = info.channel_url.as_deref().and_then(|u| Url::parse(u).ok()).filter(crate::web::allowed_url) {
            extras.insert("channelUrl".into(), Value::from(channel.as_str()));
        }
        if info.was_live == Some(true) {
            extras.insert("wasLive".into(), Value::from(true));
        }
        let description = info.description.as_deref().unwrap_or("");
        let body = match &self.captions {
            Some(captions) => {
                let chapters: Vec<Chapter> = info
                    .chapters
                    .iter()
                    .flatten()
                    .filter_map(|c| {
                        Some(Chapter { start: c.start_time.filter(|t| t.is_finite())?, title: markdown::field(c.title.as_deref()?, 200)? })
                    })
                    .collect();
                let (body, cut) =
                    transcript::to_markdown(&captions.segments, &chapters, &|t| Some(format!("{url}&t={t}s")));
                extras.insert("transcript".into(), Value::from(if captions.manual { "subtitles" } else { "auto-captions" }));
                extras.insert("lang".into(), Value::from(captions.lang.trim_end_matches("-orig")));
                if cut {
                    extras.insert("truncated".into(), Value::from(true));
                }
                body
            }
            None => {
                extras.insert("transcript".into(), Value::from("unavailable"));
                extras.insert("transcriptReason".into(), Value::from("no-captions"));
                // The description is the only readable text there is.
                let escaped: String = description
                    .lines()
                    .map(|l| l.replace('<', "\\<").replace('>', "\\>"))
                    .collect::<Vec<_>>()
                    .join("\n");
                markdown::body(&escaped, crate::BODY_CHARS)
            }
        };
        let published = info.upload_date.as_deref().filter(|d| d.len() == 8 && d.bytes().all(|b| b.is_ascii_digit()));
        let thumbnail = info.thumbnail.as_deref().and_then(|u| Url::parse(u).ok()).filter(crate::web::allowed_url);
        Item {
            source: SourceType::Youtube,
            id: format!("youtube:{id}"),
            url: Some(url),
            title: info.title.as_deref().and_then(|t| markdown::field(t, 500)),
            author: info.channel.as_deref().or(info.uploader.as_deref()).and_then(|a| markdown::field(a, 200)),
            site: Some("YouTube".into()),
            description: markdown::field(description, 2000),
            published: published.map(|d| format!("{}-{}-{}", &d[..4], &d[4..6], &d[6..])),
            captured: crate::now(),
            media: thumbnail
                .map(|u| vec![Media { kind: MediaKind::Image, url: Some(u.to_string()), data: None }])
                .unwrap_or_default(),
            body,
            extras,
        }
    }
}

#[cfg(test)]
mod tests;
