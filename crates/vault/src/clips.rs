//! Captured inspiration lives beside writing, not inside the writing tree.
//! Updates reread the file and patch only the requested fields, so enrichment
//! never saves an old copy of the writer's own text.

use crate::clip_frontmatter::{Frontmatter, Value};
use crate::{Result, capture_title, relative, slugify, write_atomic, write_bytes_new_atomic};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use url::Url;

pub const INSPIRATION: &str = "inspiration";
pub const MAX_CLIP_IMAGE_BYTES: usize = 15 * 1024 * 1024;
const MAX_SOURCE_CHARS: usize = 20_000;
const SOURCE_MARKER: &str = "<!-- kintsugi:source -->";
const IMAGE_FORMATS: &[(&str, &str)] = &[
    ("image/jpeg", "jpg"),
    ("image/jpg", "jpg"),
    ("image/png", "png"),
    ("image/gif", "gif"),
    ("image/webp", "webp"),
    ("image/heic", "heic"),
    ("image/heif", "heif"),
    ("image/avif", "avif"),
];

// Capture names are selected together; unrelated clips can still be edited
// independently. Weak entries keep the per-path lock table bounded.
static CREATES: Mutex<()> = Mutex::new(());
type ClipLocks = HashMap<PathBuf, Weak<Mutex<()>>>;
static LOCKS: OnceLock<Mutex<ClipLocks>> = OnceLock::new();

fn clip_lock(root: &Path, path: &str) -> Result<Arc<Mutex<()>>> {
    clip_path(root, path)?;
    // Case aliases refer to one file on the default macOS filesystem. Using
    // one lock for them is also safe on case-sensitive filesystems.
    let key = root
        .canonicalize()
        .map_err(|_| "could not open clip vault")?
        .join(path.to_lowercase());
    let mut locks = LOCKS
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|_| "clip storage unavailable")?;
    if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
        return Ok(lock);
    }
    locks.retain(|_, lock| lock.strong_count() > 0);
    let lock = Arc::new(Mutex::new(()));
    locks.insert(key, Arc::downgrade(&lock));
    Ok(lock)
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ClipKind {
    Link,
    Post,
    Video,
    Image,
    Quote,
    Note,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ClipVia {
    Mac,
    Phone,
    Share,
}

/// The path is the stable identity, even after the title changes. Optional
/// frontmatter is serialized as null; tags always serialize as an array.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClipSummary {
    pub path: String,
    pub kind: ClipKind,
    pub title: Option<String>,
    pub url: Option<String>,
    pub site: Option<String>,
    pub author: Option<String>,
    pub image: Option<String>,
    pub captured: String,
    pub via: Option<ClipVia>,
    pub tags: Vec<String>,
    pub summary: Option<String>,
    pub enriched: Option<String>,
    pub enrich_error: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    #[serde(flatten)]
    pub summary: ClipSummary,
    /// Everything before the source boundary, without frontmatter.
    pub text: String,
    pub has_source: bool,
    /// Enrichment can reuse source text; the phone doesn't need the large body.
    #[serde(skip_serializing)]
    pub source: Option<String>,
}

/// Raw captures are saved before any network or AI work. The phone decodes
/// base64 at its HTTP boundary; desktop callers pass the image bytes directly.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipCapture {
    pub url: Option<String>,
    pub text: Option<String>,
    pub note: Option<String>,
    pub title: Option<String>,
    pub image: Option<Vec<u8>>,
    pub image_type: Option<String>,
    pub captured_at: String,
    pub via: ClipVia,
}

/// An absent field is untouched; an empty optional scalar removes it. `note`
/// replaces the own-text section, while `source` changes only extracted text.
/// Callers should send patches, never a previously read whole clip.
#[derive(Default, Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipUpdate {
    pub kind: Option<ClipKind>,
    pub title: Option<String>,
    pub url: Option<String>,
    pub site: Option<String>,
    pub author: Option<String>,
    pub image: Option<String>,
    pub tags: Option<Vec<String>>,
    pub summary: Option<String>,
    pub enriched: Option<String>,
    pub enrich_error: Option<String>,
    pub note: Option<String>,
    pub source: Option<String>,
}

/// Generic document commands must not rename or overwrite the clip namespace.
/// Clips keep their own mutation lock and stable names.
pub fn is_inspiration_path(path: &str) -> bool {
    match Path::new(path)
        .components()
        .find(|c| !matches!(c, Component::CurDir))
    {
        Some(Component::Normal(name)) => name.to_string_lossy().eq_ignore_ascii_case(INSPIRATION),
        _ => false,
    }
}

/// Only direct `inspiration/*.md` paths are clips. Check every existing
/// component for symlinks so neither media nor a linked directory escapes.
pub fn clip_path(root: &Path, path: &str) -> Result<PathBuf> {
    let parts = Path::new(path).components().collect::<Vec<_>>();
    if parts.len() != 2
        || parts[0] != Component::Normal(INSPIRATION.as_ref())
        || !matches!(parts[1], Component::Normal(_))
        || !path.ends_with(".md")
        || Path::new(path)
            .file_name()
            .is_none_or(|name| path != format!("{INSPIRATION}/{}", name.to_string_lossy()))
        || Path::new(path)
            .file_stem()
            .is_none_or(|s| s.to_string_lossy().starts_with('.'))
    {
        return Err("not a clip path".into());
    }
    contained(root, Path::new(path))
}

fn contained(root: &Path, path: &Path) -> Result<PathBuf> {
    let mut target = root.to_path_buf();
    for part in path.components() {
        let Component::Normal(part) = part else {
            return Err("path escapes the vault".into());
        };
        target.push(part);
        match fs::symlink_metadata(&target) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err("clip paths cannot contain symlinks".into());
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("could not inspect clip path".into()),
        }
    }
    Ok(target)
}

fn nonempty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|s| !s.is_empty())
}

fn source_url(value: &str) -> Result<Url> {
    let url = Url::parse(value).map_err(|_| "invalid clip URL")?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("clip URLs must use http or https".into());
    }
    Ok(url)
}

fn host_is(host: &str, domain: &str) -> bool {
    host == domain
        || host
            .strip_suffix(domain)
            .is_some_and(|prefix| prefix.ends_with('.'))
}

/// Host guesses are deliberately conservative; enrichment can correct them.
pub fn clip_guess_kind(url: Option<&str>, text: Option<&str>, has_image: bool) -> ClipKind {
    let url = nonempty(url);
    let host = url
        .and_then(|s| source_url(s).ok())
        .and_then(|u| u.host_str().map(str::to_owned));
    if let Some(host) = host {
        if [
            "x.com",
            "twitter.com",
            "instagram.com",
            "threads.net",
            "threads.com",
            "bsky.app",
            "bsky.social",
            "tiktok.com",
            "mastodon.social",
        ]
        .iter()
        .any(|domain| host_is(&host, domain))
        {
            return ClipKind::Post;
        }
        if [
            "youtube.com",
            "youtu.be",
            "vimeo.com",
            "dailymotion.com",
            "twitch.tv",
        ]
        .iter()
        .any(|domain| host_is(&host, domain))
        {
            return ClipKind::Video;
        }
    }
    if url.is_none() && has_image {
        ClipKind::Image
    } else if url.is_some() && nonempty(text).is_some() {
        ClipKind::Quote
    } else if url.is_none() {
        ClipKind::Note
    } else {
        ClipKind::Link
    }
}

fn stamp(value: &str) -> Result<()> {
    let b = value.as_bytes();
    if b.len() != 16
        || b[4] != b'-'
        || b[7] != b'-'
        || b[10] != b'T'
        || b[13] != b':'
        || b.iter()
            .enumerate()
            .any(|(i, c)| ![4, 7, 10, 13].contains(&i) && !c.is_ascii_digit())
    {
        return Err("capturedAt must be local time as YYYY-MM-DDTHH:MM".into());
    }
    let n = |start, end| value[start..end].parse::<u32>().unwrap_or(0);
    let (year, month, day) = (n(0, 4), n(5, 7), n(8, 10));
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        _ => 0,
    };
    if year == 0 || day == 0 || day > days || n(11, 13) > 23 || n(14, 16) > 59 {
        return Err("invalid clip capture time".into());
    }
    Ok(())
}

fn enum_value<T: Serialize>(value: T) -> Value {
    Value::Scalar(
        serde_json::to_value(value)
            .expect("an enum is serializable")
            .as_str()
            .unwrap()
            .into(),
    )
}

fn enum_field<T: serde::de::DeserializeOwned>(
    fm: &Frontmatter<'_>,
    field: &str,
) -> Result<Option<T>> {
    fm.scalar(field)
        .map(|s| {
            serde_json::from_value(serde_json::Value::String(s))
                .map_err(|_| "invalid clip field".into())
        })
        .transpose()
}

fn tags(tags: Vec<String>) -> Vec<String> {
    let mut result = Vec::new();
    for tag in tags {
        let tag = tag.trim().to_lowercase();
        if !tag.is_empty() && !result.contains(&tag) {
            result.push(tag);
        }
    }
    result
}

fn summary(fm: &Frontmatter<'_>, path: &str) -> Result<ClipSummary> {
    let captured = fm
        .scalar("captured")
        .ok_or("clip is missing captured time")?;
    stamp(&captured)?;
    let image = fm.scalar("image");
    if let Some(image) = &image {
        media_relative(path, image)?;
    }
    Ok(ClipSummary {
        path: path.into(),
        kind: enum_field(fm, "kind")?.ok_or("clip is missing kind")?,
        title: fm.scalar("title"),
        url: fm.scalar("url"),
        site: fm.scalar("site"),
        author: fm.scalar("author"),
        image,
        captured,
        via: enum_field(fm, "via")?,
        tags: tags(fm.list("tags")),
        summary: fm.scalar("summary"),
        enriched: fm.scalar("enriched"),
        enrich_error: fm.scalar("enrich_error"),
    })
}

/// An explicit boundary keeps arbitrary captured Markdown safe, even a note
/// with a Source heading or unfinished fence. Heading-only files remain valid.
fn sections(body: &str) -> (&str, Option<&str>) {
    let mut offset = 0;
    let mut saw_marker = false;
    for line in body.split_inclusive('\n') {
        if line.trim_end_matches(['\r', '\n']) == SOURCE_MARKER {
            saw_marker = true;
            let rest = body[offset + line.len()..].trim_start_matches(['\r', '\n']);
            if rest.is_empty() {
                return (&body[..offset], None);
            }
            let (heading, source) = rest.split_once('\n').unwrap_or((rest, ""));
            if heading.trim_end() == "## Source" {
                return (&body[..offset], Some(source));
            }
            // An external editor appended writing below an empty boundary.
            // Keep it as own text, rather than silently discarding that tail.
        }
        offset += line.len();
    }
    if saw_marker {
        return (body, None);
    }
    let mut offset = 0;
    let mut fence: Option<(char, usize)> = None;
    for line in body.split_inclusive('\n') {
        let plain = line.trim_end_matches(['\r', '\n']);
        let trimmed = plain.trim_start_matches(' ');
        if plain.len() - trimmed.len() <= 3 {
            let c = trimmed.chars().next().unwrap_or_default();
            if c == '`' || c == '~' {
                let length = trimmed.chars().take_while(|x| *x == c).count();
                if length >= 3 {
                    match fence {
                        None => fence = Some((c, length)),
                        Some((mark, size))
                            if mark == c
                                && length >= size
                                && trimmed[length..].trim().is_empty() =>
                        {
                            fence = None
                        }
                        _ => {}
                    }
                }
            }
        }
        if fence.is_none() && plain.trim_end() == "## Source" {
            return (&body[..offset], Some(&body[offset + line.len()..]));
        }
        offset += line.len();
    }
    (body, None)
}

/// Reads own and source text separately, so callers never need to split raw
/// Markdown themselves or accidentally feed extracted text back into a note.
pub fn clip_read(root: &Path, path: &str) -> Result<Clip> {
    let text = fs::read_to_string(clip_path(root, path)?).map_err(|_| "could not read clip")?;
    let fm = Frontmatter::parse(&text)?;
    let (own, source) = sections(fm.body);
    let source = source.map(|s| s.trim_matches(['\r', '\n']).to_string());
    Ok(Clip {
        summary: summary(&fm, path)?,
        text: own.trim_matches(['\r', '\n']).into(),
        has_source: source.as_ref().is_some_and(|s| !s.trim().is_empty()),
        source,
    })
}

/// Newest first, with stable path ordering for equal capture times. A malformed
/// file edited outside Kintsugi must not hide the rest of the library.
pub fn clip_list(root: &Path) -> Result<Vec<ClipSummary>> {
    let dir = contained(root, Path::new(INSPIRATION))?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut clips = Vec::new();
    for entry in fs::read_dir(dir).map_err(|_| "could not list clips")? {
        let entry = entry.map_err(|_| "could not list clips")?;
        if !entry
            .file_type()
            .map_err(|_| "could not inspect clip")?
            .is_file()
        {
            continue;
        }
        if let Ok(clip) = clip_read(root, &relative(root, &entry.path())) {
            clips.push(clip.summary);
        }
    }
    clips.sort_by(|a, b| {
        b.captured
            .cmp(&a.captured)
            .then_with(|| a.path.cmp(&b.path))
    });
    Ok(clips)
}

/// Work that has neither finished nor exhausted its retries. Errors remain
/// visible in the library, but don't restart on every launch.
pub fn clips_needing_enrichment(root: &Path) -> Result<Vec<ClipSummary>> {
    Ok(clip_list(root)?
        .into_iter()
        .filter(|c| c.enriched.is_none() && c.enrich_error.is_none())
        .collect())
}

fn image_extension(bytes: &[u8], mime: &str) -> Result<&'static str> {
    if bytes.is_empty() || bytes.len() > MAX_CLIP_IMAGE_BYTES {
        return Err("clip images must be between 1 byte and 15 MiB".into());
    }
    // An allowlist avoids executable/vector files and never uses the supplied
    // MIME string as a path extension. Enrichment uses this same boundary.
    let mime = mime.trim().to_ascii_lowercase();
    IMAGE_FORMATS
        .iter()
        .find(|(kind, _)| *kind == mime)
        .map(|(_, ext)| *ext)
        .ok_or_else(|| "unsupported clip image type".into())
}

fn media_relative(path: &str, image: &str) -> Result<PathBuf> {
    let stem = Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or("not a clip path")?;
    let image_path = Path::new(image);
    let ext = image_path
        .extension()
        .and_then(|s| s.to_str())
        .ok_or("invalid clip media path")?;
    if !IMAGE_FORMATS.iter().any(|(_, allowed)| *allowed == ext)
        || image != format!("media/{stem}.{ext}")
    {
        return Err("invalid clip media path".into());
    }
    Ok(Path::new(INSPIRATION).join(image_path))
}

/// Resolves a clip's primary image for display or trashing, with the same
/// containment checks as writes. `image` is relative to the clip file.
pub fn clip_media_path(root: &Path, path: &str, image: &str) -> Result<PathBuf> {
    clip_path(root, path)?;
    contained(root, &media_relative(path, image)?)
}

fn save_media(root: &Path, path: &str, bytes: &[u8], mime: &str) -> Result<String> {
    let ext = image_extension(bytes, mime)?;
    let stem = Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or("not a clip path")?;
    let image = format!("media/{stem}.{ext}");
    let target = contained(root, &media_relative(path, &image)?)?;
    fs::create_dir_all(target.parent().ok_or("not a media path")?)
        .map_err(|_| "could not create clip media folder")?;
    write_bytes_new_atomic(&target, bytes)
        .map_err(|_| "could not save clip image without replacing an existing file")?;
    Ok(image)
}

fn unique_clip(dir: &Path, stem: &str, reserved: &[String]) -> Result<PathBuf> {
    for n in 1.. {
        let name = if n == 1 {
            stem.into()
        } else {
            format!("{stem}-{n}")
        };
        let path = dir.join(format!("{name}.md"));
        if reserved.iter().any(|p| p == &format!("{INSPIRATION}/{name}.md")) {
            continue;
        }
        let media_taken = IMAGE_FORMATS
            .iter()
            .any(|(_, ext)| fs::symlink_metadata(dir.join(format!("media/{name}.{ext}"))).is_ok());
        match fs::symlink_metadata(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && !media_taken => return Ok(path),
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                return Err("could not select clip name".into());
            }
            _ => {}
        }
    }
    unreachable!("an unused name")
}

fn protect_boundary(text: &str) -> String {
    // Only the exact reserved comment is escaped; ordinary Markdown, including
    // Source headings and incomplete code examples, is stored unchanged.
    text.replace(SOURCE_MARKER, "&lt;!-- kintsugi:source --&gt;")
}

/// Checks a capture without writing, so API boundaries can distinguish a
/// permanent rejection from a storage failure.
pub fn clip_validate_capture(capture: &ClipCapture) -> Result<()> {
    stamp(&capture.captured_at)?;
    let url = nonempty(capture.url.as_deref());
    url.map(source_url).transpose()?;
    let text = nonempty(capture.text.as_deref());
    let note = nonempty(capture.note.as_deref());
    if url.is_none() && text.is_none() && note.is_none() && capture.image.is_none() {
        return Err("nothing to capture".into());
    }
    match (&capture.image, &capture.image_type) {
        (Some(bytes), Some(mime)) => {
            image_extension(bytes, mime)?;
        }
        (Some(_), None) => return Err("clip image needs a MIME type".into()),
        (None, Some(_)) => return Err("clip image type needs an image".into()),
        _ => {}
    }
    Ok(())
}

/// Saves what arrived immediately; naming and media writes do no network work.
pub fn clip_create(root: &Path, capture: &ClipCapture) -> Result<String> {
    clip_create_with_receipt(root, capture, &[], |_| Ok(()))
}

/// Reserves the selected path in an application-owned receipt journal before
/// writing media or Markdown. The callback runs under the naming/path locks;
/// an error aborts the capture. `reserved` paths are skipped during naming,
/// so another capture cannot take a pending receipt's path after a crash.
/// No delivery metadata is added to the vault's plain files.
pub fn clip_create_with_receipt(
    root: &Path,
    capture: &ClipCapture,
    reserved: &[String],
    receipt: impl FnOnce(&str) -> Result<()>,
) -> Result<String> {
    let _create_guard = CREATES.lock().map_err(|_| "clip storage unavailable")?;
    clip_validate_capture(capture)?;
    let url = nonempty(capture.url.as_deref());
    let parsed_url = url.map(source_url).transpose()?;
    let text = nonempty(capture.text.as_deref());
    let note = nonempty(capture.note.as_deref());
    let title = nonempty(capture.title.as_deref());
    let fallback = parsed_url
        .as_ref()
        .map(|u| format!("{}{}", u.host_str().unwrap_or_default(), u.path()));
    let name = title
        .or(fallback.as_deref())
        .map(str::to_string)
        .unwrap_or_else(|| {
            text.or(note)
                .map(capture_title)
                .unwrap_or_else(|| "image".into())
        });
    let dir = contained(root, Path::new(INSPIRATION))?;
    fs::create_dir_all(&dir).map_err(|_| "could not create inspiration folder")?;
    let path = relative(root, &unique_clip(&dir, &slugify(&name), reserved)?);
    let lock = clip_lock(root, &path)?;
    let _guard = lock.lock().map_err(|_| "clip storage unavailable")?;
    let target = clip_path(root, &path)?;
    let mut fm = Frontmatter::empty();
    fm.set(
        "kind",
        Some(enum_value(clip_guess_kind(
            url,
            text,
            capture.image.is_some(),
        ))),
    );
    for (key, value) in [("title", title), ("url", url)] {
        if let Some(value) = value {
            fm.set(key, Some(Value::Scalar(value.into())));
        }
    }
    fm.set("captured", Some(Value::Scalar(capture.captured_at.clone())));
    fm.set("via", Some(enum_value(capture.via)));
    let mut body = String::from("\n");
    if let Some(text) = text {
        if url.is_some() {
            body.push_str(
                &text
                    .lines()
                    .map(|line| format!("> {line}"))
                    .collect::<Vec<_>>()
                    .join("\n"),
            );
        } else {
            body.push_str(text);
        }
    }
    if let Some(note) = note {
        if text.is_some() {
            body.push_str("\n\n");
        }
        body.push_str(note);
    }
    body = protect_boundary(&body);
    body.push_str(&format!("\n\n{SOURCE_MARKER}\n"));
    receipt(&path)?;
    let image = if let (Some(bytes), Some(mime)) = (&capture.image, &capture.image_type) {
        let image = save_media(root, &path, bytes, mime)?;
        fm.set("image", Some(Value::Scalar(image.clone())));
        Some(image)
    } else {
        None
    };
    if write_atomic(&target, &fm.render(&body)).is_err() {
        if let Some(image) = image {
            if let Ok(image) = clip_media_path(root, &path, &image) {
                let _ = fs::remove_file(image);
            }
        }
        return Err("could not save clip".into());
    }
    Ok(path)
}

/// Merges only the requested fields into the current clip under its path lock.
/// Never save a raw snapshot here: the writer may have edited during a fetch.
pub fn clip_update(root: &Path, path: &str, patch: &ClipUpdate) -> Result<Clip> {
    let lock = clip_lock(root, path)?;
    let _guard = lock.lock().map_err(|_| "clip storage unavailable")?;
    update(root, path, patch)
}

/// Applies a worker's result without replacing a title that is already known
/// or tags the writer changed while the worker was fetching. Own text cannot
/// be patched through this entry point. The comparison and write share a lock.
pub fn clip_enrich(
    root: &Path,
    path: &str,
    baseline: &ClipSummary,
    patch: &ClipUpdate,
) -> Result<Clip> {
    let lock = clip_lock(root, path)?;
    let _guard = lock.lock().map_err(|_| "clip storage unavailable")?;
    if baseline.path != path || patch.note.is_some() {
        return Err("invalid clip enrichment patch".into());
    }
    let current = clip_read(root, path)?.summary;
    let mut patch = patch.clone();
    if current.title.is_some() || current.title != baseline.title {
        patch.title = None;
    }
    if current.tags != baseline.tags {
        patch.tags = None;
    }
    if current.image.is_some() || current.image != baseline.image {
        patch.image = None;
    }
    update(root, path, &patch)
}

fn update(root: &Path, path: &str, patch: &ClipUpdate) -> Result<Clip> {
    let target = clip_path(root, path)?;
    let raw = fs::read_to_string(&target).map_err(|_| "could not read clip")?;
    let mut fm = Frontmatter::parse(&raw)?;
    summary(&fm, path)?;
    if let Some(kind) = patch.kind {
        fm.set("kind", Some(enum_value(kind)));
    }
    for (key, value) in [
        ("title", &patch.title),
        ("url", &patch.url),
        ("site", &patch.site),
        ("author", &patch.author),
        ("image", &patch.image),
        ("summary", &patch.summary),
        ("enriched", &patch.enriched),
        ("enrich_error", &patch.enrich_error),
    ] {
        if let Some(value) = value {
            let value = nonempty(Some(value));
            if key == "url" {
                if let Some(value) = value {
                    source_url(value)?;
                }
            }
            if key == "image" {
                if let Some(value) = value {
                    contained(root, &media_relative(path, value)?)?;
                }
            }
            fm.set(key, value.map(|s| Value::Scalar(s.into())));
        }
    }
    if let Some(value) = &patch.tags {
        fm.set("tags", Some(Value::List(tags(value.clone()))));
    }
    let mut body = fm.body.to_string();
    if patch.note.is_some() || patch.source.is_some() {
        let (own, source) = sections(fm.body);
        body = match &patch.note {
            Some(note) => format!(
                "\n{}\n\n",
                protect_boundary(note.trim_matches(['\r', '\n']))
            ),
            None => own.to_string(),
        };
        if !body.ends_with('\n') {
            body.push('\n');
        }
        if !body.ends_with("\n\n") && !body.ends_with("\r\n\r\n") {
            body.push('\n');
        }
        body.push_str(SOURCE_MARKER);
        body.push('\n');
        let next_source = patch.source.as_deref().or(source);
        if let Some(next_source) = next_source.filter(|s| !s.trim().is_empty()) {
            body.push_str("## Source\n\n");
            body.extend(
                next_source
                    .trim_matches(['\r', '\n'])
                    .chars()
                    .take(MAX_SOURCE_CHARS),
            );
            body.push('\n');
        }
    }
    write_atomic(&target, &fm.render(&body)).map_err(|_| "could not save clip")?;
    clip_read(root, path)
}

/// Fills a missing primary image and patches the latest clip under its lock.
/// Returns the existing image unchanged if one arrived while fetching. Never
/// replaces a screenshot or a preexisting media file, even an orphan.
pub fn clip_save_media(root: &Path, path: &str, bytes: &[u8], mime: &str) -> Result<String> {
    let lock = clip_lock(root, path)?;
    let _guard = lock.lock().map_err(|_| "clip storage unavailable")?;
    let target = clip_path(root, path)?;
    let raw = fs::read_to_string(&target).map_err(|_| "could not read clip")?;
    let mut fm = Frontmatter::parse(&raw)?;
    summary(&fm, path)?;
    image_extension(bytes, mime)?;
    if let Some(image) = fm.scalar("image") {
        clip_media_path(root, path, &image)?;
        return Ok(image);
    }
    let image = save_media(root, path, bytes, mime)?;
    fm.set("image", Some(Value::Scalar(image.clone())));
    if write_atomic(&target, &fm.render(fm.body)).is_err() {
        if let Ok(target) = clip_media_path(root, path, &image) {
            let _ = fs::remove_file(target);
        }
        return Err("could not save clip".into());
    }
    Ok(image)
}

/// Keeps trashing in the same mutation sequence as enrichment, so an in-flight
/// update cannot recreate a trashed clip. The desktop supplies the OS Trash
/// operation; this crate only selects and validates the files it owns.
pub fn clip_trash(
    root: &Path,
    path: &str,
    trash: impl FnOnce(&[PathBuf]) -> Result<()>,
) -> Result<()> {
    let lock = clip_lock(root, path)?;
    let _guard = lock.lock().map_err(|_| "clip storage unavailable")?;
    let clip = clip_read(root, path)?;
    let mut targets = vec![clip_path(root, path)?];
    if let Some(image) = clip.summary.image {
        let image = clip_media_path(root, path, &image)?;
        if image.exists() {
            targets.push(image);
        }
    }
    trash(&targets)
}

#[cfg(test)]
mod tests;
