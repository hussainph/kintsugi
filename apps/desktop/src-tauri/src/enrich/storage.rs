//! Clips on disk, in the format `docs/inspiration.md` specifies. Behind
//! `Store` so the worker can switch to KI-1's clip API once it lands.
//!
//! Write-back always starts from the newest file, never from the snapshot the
//! worker enriched: the writer's own text (everything before the exact
//! `## Source` line) is copied byte for byte, frontmatter lines enrichment
//! doesn't own are kept verbatim, and title, tags and kind edited since the
//! snapshot win. Errors are generic on purpose: they may end up in the clip's
//! `enrich_error`, so they never carry paths or file contents.

use super::{
    fetch::{Image, SOURCE_CHARS},
    think::KINDS,
};
use kintsugi_vault::{self as vault, Write};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write as _};
use std::path::{Path, PathBuf};

type Result<T> = std::result::Result<T, String>;

pub const DIR: &str = "inspiration";
const MEDIA: &str = "media";
const SOURCE: &str = "## Source";
const MAX_TEXT: u64 = 4 * 1024 * 1024;
const MAX_IMAGE: usize = 15 * 1024 * 1024;
const MAX_DEPTH: usize = 32;
/// Version-checked writes retried when the file changes underneath us.
const ATTEMPTS: usize = 3;

const NOT_A_CLIP: &str = "not an inspiration clip";
const READ: &str = "could not read the clip";
const FRONTMATTER: &str = "the clip's frontmatter could not be read";
const SAVE: &str = "could not save the clip";
const BUSY: &str = "the clip kept changing while it was enriched";
const VAULT: &str = "could not read the vault";

/// A clip as it was when enrichment picked it up.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Clip {
    /// Vault-relative, e.g. `inspiration/why-we-sleep.md`.
    pub path: String,
    pub title: Option<String>,
    pub url: Option<String>,
    pub site: Option<String>,
    pub author: Option<String>,
    pub image: Option<String>,
    pub kind: String,
    pub tags: Vec<String>,
    /// Everything before `## Source`, trimmed. Read-only: never written back.
    pub own_text: String,
    pub source_text: String,
}

/// What enrichment found. Metadata and the image only fill gaps.
#[derive(Debug, Clone, Default)]
pub struct Update {
    pub title: Option<String>,
    pub summary: String,
    pub tags: Vec<String>,
    pub kind: String,
    pub site: Option<String>,
    pub author: Option<String>,
    /// Replaces the `## Source` section only when supplied.
    pub source_text: Option<String>,
    pub image: Option<Image>,
}

pub trait Store {
    /// Clips with neither `enriched` nor `enrich_error`, newest capture first.
    fn pending(&self, root: &Path) -> Result<Vec<Clip>>;
    /// Tags in use across every writing document and clip, most used first.
    fn tags(&self, root: &Path) -> Result<Vec<String>>;
    fn apply(&self, root: &Path, clip: &Clip, update: &Update) -> Result<()>;
    /// Gives up on a clip for good, keeping all of its text.
    fn fail(&self, root: &Path, clip: &Clip, message: &str) -> Result<()>;
}

/// Plain clip files in `<vault>/inspiration`.
pub struct Files;

impl Store for Files {
    fn pending(&self, root: &Path) -> Result<Vec<Clip>> {
        let dir = root.join(DIR);
        if !is_real_dir(&dir) {
            return Ok(Vec::new());
        }
        let mut clips = Vec::new();
        for entry in fs::read_dir(&dir).map_err(|_| VAULT)?.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || !name.ends_with(".md") || !entry.file_type().is_ok_and(|t| t.is_file()) {
                continue;
            }
            let Ok(text) = read_text(&entry.path()) else {
                continue;
            };
            // A file we can't parse is a file we can't safely rewrite.
            let Some(doc) = Doc::parse(&text) else {
                continue;
            };
            if doc.scalar("enriched").is_some() || doc.scalar("enrich_error").is_some() {
                continue;
            }
            clips.push((doc.scalar("captured").unwrap_or_default(), clip_of(format!("{DIR}/{name}"), &doc)));
        }
        clips.sort_by(|(a, x), (b, y)| b.cmp(a).then_with(|| x.path.cmp(&y.path)));
        Ok(clips.into_iter().map(|(_, clip)| clip).collect())
    }

    fn tags(&self, root: &Path) -> Result<Vec<String>> {
        let mut counts = HashMap::new();
        fs::read_dir(root).map_err(|_| VAULT)?;
        collect_tags(root, root, 0, &mut counts);
        let mut tags: Vec<(String, usize)> = counts.into_iter().collect();
        tags.sort_by(|(a, x), (b, y)| y.cmp(x).then_with(|| a.cmp(b)));
        Ok(tags.into_iter().map(|(tag, _)| tag).collect())
    }

    fn apply(&self, root: &Path, clip: &Clip, update: &Update) -> Result<()> {
        let file = clip_file(root, &clip.path)?;
        let mut media = None;
        let result = write_back(root, &file, clip, update, &mut media);
        // An image the clip didn't end up referencing must not linger.
        if let Some((path, _)) = &media {
            if !matches!(result, Ok(true)) {
                let _ = fs::remove_file(path);
            }
        }
        result.map(|_| ())
    }

    fn fail(&self, root: &Path, clip: &Clip, message: &str) -> Result<()> {
        let file = clip_file(root, &clip.path)?;
        let message = Some(one_line(message, 200))
            .filter(|m| !m.is_empty())
            .unwrap_or_else(|| "could not enrich clip".into());
        for _ in 0..ATTEMPTS {
            let current = read_text(&file)?;
            let mut doc = Doc::parse(&current).ok_or(FRONTMATTER)?;
            if doc.scalar("enriched").is_some() {
                return Ok(());
            }
            doc.set("enrich_error", Value::Scalar(message.clone()));
            if save(root, &clip.path, &doc.render(doc.body), &current)? {
                return Ok(());
            }
        }
        Err(BUSY.into())
    }
}

/// `Ok(true)` when the saved clip references the image saved into `media`.
fn write_back(root: &Path, file: &Path, before: &Clip, update: &Update, media: &mut Option<(PathBuf, String)>) -> Result<bool> {
    let enriched = local_stamp();
    for _ in 0..ATTEMPTS {
        let current = read_text(file)?;
        let mut doc = Doc::parse(&current).ok_or(FRONTMATTER)?;
        if doc.scalar("enriched").is_some() {
            return Ok(false);
        }
        let now = clip_of(before.path.clone(), &doc);
        let wants_image = before.image.is_none() && now.image.is_none();
        if wants_image && media.is_none() {
            *media = update.image.as_ref().and_then(|image| save_image(root, file, image));
        }
        let image = media.as_ref().filter(|_| wants_image).map(|(_, rel)| rel.clone());
        let text = merge(&mut doc, before, &now, update, image.as_deref(), &enriched);
        if save(root, &before.path, &text, &current)? {
            return Ok(image.is_some());
        }
    }
    Err(BUSY.into())
}

/// `false` when the file changed since `read`; nothing was written then.
/// `kintsugi_vault::write` checks the version and renames atomically, but the
/// check and the rename aren't one step: a save landing in between is lost.
fn save(root: &Path, rel: &str, text: &str, read: &str) -> Result<bool> {
    match vault::write(root, rel, text, Some(&vault::version(read))) {
        Ok(Write::Saved { .. }) => Ok(true),
        Ok(Write::Conflict { .. }) => Ok(false),
        Err(_) => Err(SAVE.into()),
    }
}

fn merge(doc: &mut Doc, before: &Clip, now: &Clip, update: &Update, image: Option<&str>, enriched: &str) -> String {
    let body = doc.body;
    // Fill a gap only if it was a gap in the snapshot too: a field the writer
    // cleared since is an edit, not an invitation.
    let mut fill = |key: &str, was: &Option<String>, is: &Option<String>, value: Option<&str>, limit: usize| {
        let value = value.map(|v| one_line(v, limit)).filter(|v| !v.is_empty());
        if let (None, None, Some(value)) = (was, is, value) {
            doc.set(key, Value::Scalar(value));
        }
    };
    fill("title", &before.title, &now.title, update.title.as_deref(), 200);
    fill("site", &before.site, &now.site, update.site.as_deref(), 120);
    fill("author", &before.author, &now.author, update.author.as_deref(), 120);
    fill("image", &before.image, &now.image, image, 200);

    let kind = update.kind.trim().to_lowercase();
    if now.kind == before.kind && kind != now.kind && KINDS.contains(&kind.as_str()) {
        doc.set("kind", Value::Scalar(kind));
    }
    if now.tags == before.tags {
        let mut tags = now.tags.clone();
        for tag in update.tags.iter().filter_map(|t| normal_tag(t)) {
            if !tags.iter().any(|t| normal_tag(t).as_deref() == Some(tag.as_str())) {
                tags.push(tag);
            }
        }
        if tags != now.tags {
            doc.set("tags", Value::List(tags));
        }
    }
    let summary = one_line(&update.summary, 600);
    if !summary.is_empty() {
        doc.set("summary", Value::Scalar(summary));
    }
    doc.remove("enrich_error");
    doc.set("enriched", Value::Scalar(enriched.into()));

    match update.source_text.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(source) => doc.render(&with_source(body, source, doc.newline)),
        None => doc.render(body),
    }
}

/// The body with its `## Source` section replaced (or added), own text untouched.
fn with_source(body: &str, source: &str, nl: &str) -> String {
    let (own, existing) = split_source(body);
    let mut out = own.to_string();
    if existing.is_none() && !own.trim().is_empty() {
        if !out.ends_with('\n') {
            out.push_str(nl);
        }
        if !out.ends_with(&format!("{nl}{nl}")) {
            out.push_str(nl);
        }
    }
    let source: String = source.chars().take(SOURCE_CHARS).collect();
    out.push_str(&format!("{SOURCE}{nl}{nl}{}{nl}", source.trim_end()));
    out
}

/// (own text, text after the `## Source` line). The heading must be a line of
/// its own, exactly; the first one wins.
fn split_source(body: &str) -> (&str, Option<&str>) {
    let mut offset = 0;
    let mut fence: Option<(char, usize)> = None;
    for line in body.split_inclusive('\n') {
        let bare = line.trim_end_matches(['\r', '\n']);
        let trimmed = bare.trim_start_matches(' ');
        if bare.len() - trimmed.len() <= 3 {
            if let Some(mark @ ('`' | '~')) = trimmed.chars().next() {
                let count = trimmed.chars().take_while(|c| *c == mark).count();
                match fence {
                    Some((open, width)) if mark == open && count >= width && trimmed[count..].trim().is_empty() => fence = None,
                    None if count >= 3 => fence = Some((mark, count)),
                    _ => {}
                }
            }
        }
        // A heading inside the writer's fenced example is not a section.
        if fence.is_none() && bare == SOURCE {
            return (&body[..offset], Some(&body[offset + line.len()..]));
        }
        offset += line.len();
    }
    (body, None)
}

fn clip_of(path: String, doc: &Doc) -> Clip {
    let (own, source) = split_source(doc.body);
    let url = doc.scalar("url");
    Clip {
        path,
        title: doc.scalar("title"),
        site: doc.scalar("site"),
        author: doc.scalar("author"),
        image: doc.scalar("image"),
        kind: doc
            .scalar("kind")
            .unwrap_or_else(|| if url.is_some() { "link" } else { "note" }.into()),
        tags: doc.list("tags"),
        own_text: own.trim().into(),
        source_text: source.unwrap_or_default().trim().into(),
        url,
    }
}

/// Only `inspiration/<name>.md`, a regular file in a real (non-symlinked) folder.
fn clip_file(root: &Path, rel: &str) -> Result<PathBuf> {
    let name = rel
        .strip_prefix("inspiration/")
        .filter(|n| n.len() > 3 && n.ends_with(".md") && !n.starts_with('.') && !n.contains(['/', '\\']))
        .ok_or(NOT_A_CLIP)?;
    let dir = root.join(DIR);
    let file = dir.join(name);
    match fs::symlink_metadata(&file) {
        Ok(meta) if meta.file_type().is_file() && is_real_dir(&dir) => Ok(file),
        _ => Err(READ.into()),
    }
}

fn is_real_dir(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_dir())
}

fn read_text(path: &Path) -> Result<String> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_file() && meta.len() <= MAX_TEXT => fs::read_to_string(path).map_err(|_| READ.into()),
        _ => Err(READ.into()),
    }
}

/// Every `.md` / `.mdx` under `dir`, skipping hidden entries, symlinks and
/// clip media. Unreadable files are skipped: tags are a hint, not a contract.
fn collect_tags(root: &Path, dir: &Path, depth: usize, counts: &mut HashMap<String, usize>) {
    if depth > MAX_DEPTH {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if name.starts_with('.') || kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            if path != root.join(DIR).join(MEDIA) {
                collect_tags(root, &path, depth + 1, counts);
            }
        } else if kind.is_file() && (name.ends_with(".md") || name.ends_with(".mdx")) {
            let Ok(text) = read_text(&path) else { continue };
            let Some(doc) = Doc::parse(&text) else {
                continue;
            };
            let mut seen = Vec::new();
            for tag in doc.list("tags").iter().filter_map(|t| normal_tag(t)) {
                if !seen.contains(&tag) {
                    *counts.entry(tag.clone()).or_insert(0) += 1;
                    seen.push(tag);
                }
            }
        }
    }
}

fn normal_tag(tag: &str) -> Option<String> {
    let tag = one_line(tag.trim().trim_start_matches('#'), 64).to_lowercase();
    (!tag.is_empty()).then_some(tag)
}

/// One line of plain text: no control characters, whitespace collapsed.
fn one_line(text: &str, limit: usize) -> String {
    let text = text.split(|c: char| c.is_whitespace() || c.is_control()).filter(|w| !w.is_empty());
    text.collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(limit)
        .collect::<String>()
        .trim_end()
        .into()
}

/// Raster images only, by their bytes, never overwriting a capture's image.
/// Best effort: a clip without its hero image is still worth enriching.
fn save_image(root: &Path, file: &Path, image: &Image) -> Option<(PathBuf, String)> {
    let bytes = &image.bytes;
    let mime = super::fetch::image_mime(bytes)?;
    if image.mime != mime {
        return None;
    }
    let ext = match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => return None,
    };
    if bytes.len() > MAX_IMAGE {
        return None;
    }
    let dir = root.join(DIR).join(MEDIA);
    if !is_real_dir(&dir) {
        fs::create_dir(&dir).ok()?;
    }
    let stem = file.file_stem()?.to_str()?;
    for n in 1..100 {
        let name = if n == 1 {
            format!("{stem}.{ext}")
        } else {
            format!("{stem}-{n}.{ext}")
        };
        let path = dir.join(&name);
        // `create_new` refuses existing files and symlinks alike.
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut out) => {
                if out.write_all(bytes).and_then(|_| out.sync_all()).is_err() {
                    let _ = fs::remove_file(&path);
                    return None;
                }
                return Some((path, format!("{MEDIA}/{name}")));
            }
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            Err(_) => return None,
        }
    }
    None
}

/// Local time as `YYYY-MM-DDTHH:MM`, like `captured`.
fn local_stamp() -> String {
    chrono::Local::now().format("%Y-%m-%dT%H:%M").to_string()
}

#[cfg(test)]
fn is_stamp(s: &str) -> bool {
    s.len() == 16
        && s.bytes().enumerate().all(|(i, b)| match i {
            4 | 7 => b == b'-',
            10 => b == b'T',
            13 => b == b':',
            _ => b.is_ascii_digit(),
        })
}

/// Flat frontmatter: scalars and inline or block lists. Anything else (nested
/// maps, block scalars, YAML we don't speak) is kept as raw lines and never
/// interpreted, so rewriting a clip can't lose or reinterpret it.
#[derive(Clone, Debug, PartialEq)]
enum Value {
    Scalar(String),
    List(Vec<String>),
    Other,
}

struct Field {
    /// `None` for blank and comment lines.
    key: Option<String>,
    /// The original lines, emitted verbatim unless the field was changed.
    raw: String,
    value: Value,
    changed: bool,
}

struct Doc<'a> {
    open: &'a str,
    fields: Vec<Field>,
    close: &'a str,
    body: &'a str,
    newline: &'static str,
}

impl<'a> Doc<'a> {
    fn parse(text: &'a str) -> Option<Self> {
        let mut lines = text.split_inclusive('\n');
        let open = lines.next()?;
        if open.trim_end_matches(['\r', '\n']) != "---" {
            return None;
        }
        let newline = if open.ends_with("\r\n") { "\r\n" } else { "\n" };
        let mut offset = open.len();
        let mut fields: Vec<Field> = Vec::new();
        for line in lines {
            let start = offset;
            offset += line.len();
            let bare = line.trim_end_matches(['\r', '\n']);
            if bare == "---" {
                let (close, body) = (&text[start..offset], &text[offset..]);
                return Some(Self {
                    open,
                    fields,
                    close,
                    body,
                    newline,
                });
            }
            if bare.trim().is_empty() || bare.starts_with('#') {
                fields.push(Field {
                    key: None,
                    raw: line.into(),
                    value: Value::Other,
                    changed: false,
                });
            } else if bare.starts_with(char::is_whitespace) {
                let field = fields.last_mut()?;
                let item = bare.trim().strip_prefix("- ").and_then(scalar);
                match (&mut field.value, item) {
                    (Value::List(items), Some(item)) if field.key.is_some() => items.push(item),
                    (value, _) if field.key.is_some() => *value = Value::Other,
                    _ => {}
                }
                field.raw.push_str(line);
            } else {
                let (key, value) = bare.split_once(':')?;
                let key = key.trim();
                if key.is_empty()
                    || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
                    || fields.iter().any(|f| f.key.as_deref() == Some(key))
                {
                    return None;
                }
                let value = value.trim();
                let value = if value.is_empty() {
                    Some(Value::List(Vec::new()))
                } else if value.starts_with('[') {
                    list(value).map(Value::List)
                } else {
                    scalar(value).map(Value::Scalar)
                };
                let value = value.unwrap_or(Value::Other);
                fields.push(Field {
                    key: Some(key.into()),
                    raw: line.into(),
                    value,
                    changed: false,
                });
            }
        }
        None
    }

    fn get(&self, key: &str) -> Option<&Value> {
        self.fields.iter().find(|f| f.key.as_deref() == Some(key)).map(|f| &f.value)
    }

    fn scalar(&self, key: &str) -> Option<String> {
        match self.get(key) {
            Some(Value::Scalar(value)) if !value.trim().is_empty() => Some(value.trim().into()),
            _ => None,
        }
    }

    /// A list, or a lone scalar as a list of one (Obsidian accepts `tags: x`).
    fn list(&self, key: &str) -> Vec<String> {
        match self.get(key) {
            Some(Value::List(items)) => items.clone(),
            Some(Value::Scalar(value)) if !value.trim().is_empty() => vec![value.trim().into()],
            _ => Vec::new(),
        }
    }

    fn set(&mut self, key: &str, value: Value) {
        match self.fields.iter_mut().find(|f| f.key.as_deref() == Some(key)) {
            Some(field) => {
                field.value = value;
                field.changed = true;
            }
            None => self.fields.push(Field {
                key: Some(key.into()),
                raw: String::new(),
                value,
                changed: true,
            }),
        }
    }

    fn remove(&mut self, key: &str) {
        self.fields.retain(|f| f.key.as_deref() != Some(key));
    }

    fn render(&self, body: &str) -> String {
        let nl = self.newline;
        let mut text = self.open.to_string();
        for field in &self.fields {
            match (&field.key, field.changed) {
                (Some(key), true) => {
                    let value = match &field.value {
                        Value::Scalar(value) => quote(value),
                        Value::List(items) => format!("[{}]", items.iter().map(|t| list_item(t)).collect::<Vec<_>>().join(", ")),
                        Value::Other => continue,
                    };
                    text.push_str(&format!("{key}: {value}{nl}"));
                }
                _ => text.push_str(&field.raw),
            }
        }
        text.push_str(self.close);
        if !self.close.ends_with('\n') && !body.is_empty() {
            text.push_str(nl);
        }
        text.push_str(body);
        text
    }
}

/// JSON strings are YAML double-quoted strings, escapes and all, so no value
/// can break out of its line or inject a field.
fn quote(value: &str) -> String {
    serde_json::to_string(value).expect("a string serializes")
}

/// Plain when unambiguous (`[sleep, science]`, as the spec shows), else quoted.
fn list_item(item: &str) -> String {
    let plain = item.starts_with(|c: char| c.is_alphabetic())
        && item.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_')
        && !["true", "false", "null", "yes", "no", "on", "off"].contains(&item);
    if plain { item.into() } else { quote(item) }
}

fn scalar(value: &str) -> Option<String> {
    let value = value.trim();
    if let Some(q) = value.chars().next().filter(|c| *c == '"' || *c == '\'') {
        let end = quoted_end(value, q)?;
        let tail = value[end..].trim();
        if !tail.is_empty() && !tail.starts_with('#') {
            return None;
        }
        return if q == '"' {
            serde_json::from_str(&value[..end]).ok()
        } else {
            Some(value[1..end - 1].replace("''", "'"))
        };
    }
    if value.starts_with(['|', '>', '{', '[', '&', '*', '!', '%', '@', '`']) {
        return None;
    }
    Some(value.split_once(" #").map_or(value, |(v, _)| v).trim().into())
}

fn quoted_end(value: &str, quote: char) -> Option<usize> {
    let mut chars = value.char_indices().skip(1).peekable();
    while let Some((index, c)) = chars.next() {
        if quote == '"' && c == '\\' {
            chars.next();
        } else if c == quote {
            if quote == '\'' && chars.peek().is_some_and(|(_, c)| *c == '\'') {
                chars.next();
            } else {
                return Some(index + 1);
            }
        }
    }
    None
}

fn list(value: &str) -> Option<Vec<String>> {
    let mut rest = value.strip_prefix('[')?.trim_start();
    let mut items = Vec::new();
    loop {
        if let Some(tail) = rest.strip_prefix(']') {
            let tail = tail.trim();
            return (tail.is_empty() || tail.starts_with('#')).then_some(items);
        }
        let end = match rest.chars().next()? {
            q @ ('"' | '\'') => quoted_end(rest, q)?,
            _ => rest.find([',', ']'])?,
        };
        if end == 0 {
            return None;
        }
        items.push(scalar(&rest[..end])?);
        rest = rest[end..].trim_start();
        if let Some(tail) = rest.strip_prefix(',') {
            rest = tail.trim_start();
        } else if !rest.starts_with(']') {
            return None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLIP: &str = "---\nkind: link\ntitle: \"Why we sleep\"\nurl: \"https://example.org/sleep\"\n# a comment the writer left\ncaptured: \"2026-10-29T14:05\"\nvia: share\ncustom:\n  nested: kept\naliases:\n  - Sleep\ntags:\n  - Sleep\n  - \"a, b\"\n---\n\n> A passage.\n\nMy note,  with  odd   spacing\t\n\n## Source\n\nOld source.\n";

    fn vault() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("inspiration/media")).unwrap();
        dir
    }

    fn write(root: &Path, rel: &str, text: &str) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn read(root: &Path, rel: &str) -> String {
        fs::read_to_string(root.join(rel)).unwrap()
    }

    fn jpeg() -> Image {
        Image {
            bytes: b"\xff\xd8\xff\xe0fake jpeg".to_vec(),
            mime: "image/jpeg".into(),
        }
    }

    fn update() -> Update {
        Update {
            title: Some("Fetched title".into()),
            summary: "Rest, \nexplained.".into(),
            tags: vec!["Science".into(), "sleep".into(), "#attention".into()],
            kind: "video".into(),
            site: Some("The Journal".into()),
            author: Some("Jane Doe".into()),
            source_text: Some("New source.".into()),
            image: Some(jpeg()),
        }
    }

    fn own(text: &str) -> &str {
        let body = text.splitn(3, "---\n").nth(2).unwrap();
        split_source(body).0
    }

    #[test]
    fn pending_reads_flat_frontmatter_and_skips_finished_hidden_and_linked_files() {
        let dir = vault();
        let root = dir.path();
        write(root, "inspiration/why-we-sleep.md", CLIP);
        write(
            root,
            "inspiration/older.md",
            "---\nkind: note\ncaptured: '2026-01-01T09:00'\ntags: [a, 'reader''s life']\n---\nJust a thought.\n",
        );
        write(
            root,
            "inspiration/done.md",
            "---\nkind: note\nenriched: \"2026-10-29T14:06\"\n---\n",
        );
        write(
            root,
            "inspiration/gave-up.md",
            "---\nkind: note\nenrich_error: \"timed out\"\n---\n",
        );
        write(root, "inspiration/.hidden.md", "---\nkind: note\n---\n");
        write(root, "inspiration/media/inside.md", "---\nkind: note\n---\n");
        write(root, "inspiration/no-frontmatter.md", "just text");
        write(root, "inspiration/notes.txt", "---\nkind: note\n---\n");
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("inspiration/older.md"), root.join("inspiration/linked.md")).unwrap();

        let clips = Files.pending(root).unwrap();
        assert_eq!(
            clips.iter().map(|c| c.path.as_str()).collect::<Vec<_>>(),
            ["inspiration/why-we-sleep.md", "inspiration/older.md"]
        );
        let clip = &clips[0];
        assert_eq!(clip.title.as_deref(), Some("Why we sleep"));
        assert_eq!(clip.url.as_deref(), Some("https://example.org/sleep"));
        assert_eq!(clip.kind, "link");
        assert_eq!(clip.tags, ["Sleep", "a, b"]);
        assert_eq!(clip.own_text, "> A passage.\n\nMy note,  with  odd   spacing");
        assert_eq!(clip.source_text, "Old source.");
        assert_eq!(clips[1].tags, ["a", "reader's life"]);
        assert_eq!(clips[1].source_text, "");
    }

    #[test]
    fn apply_keeps_own_text_bytes_and_unknown_fields_and_fills_only_gaps() {
        let dir = vault();
        let root = dir.path();
        write(root, "inspiration/why-we-sleep.md", CLIP);
        let clip = Files.pending(root).unwrap().remove(0);
        Files.apply(root, &clip, &update()).unwrap();

        let text = read(root, "inspiration/why-we-sleep.md");
        assert_eq!(own(&text), own(CLIP));
        for kept in [
            "# a comment the writer left\n",
            "custom:\n  nested: kept\n",
            "aliases:\n  - Sleep\n",
            "via: share\n",
            "title: \"Why we sleep\"\n",
        ] {
            assert!(text.contains(kept), "{kept}\n{text}");
        }
        assert!(text.contains("kind: \"video\"\n"));
        assert!(text.contains("site: \"The Journal\"\n"));
        assert!(text.contains("tags: [Sleep, \"a, b\", science, attention]\n"), "{text}");
        assert!(text.contains("summary: \"Rest, explained.\"\n"));
        assert!(text.contains("image: \"media/why-we-sleep.jpg\"\n"));
        assert!(text.ends_with("## Source\n\nNew source.\n"));
        assert!(!text.contains("Old source."));
        assert_eq!(fs::read(root.join("inspiration/media/why-we-sleep.jpg")).unwrap(), jpeg().bytes);
        let stamp = Doc::parse(&text).unwrap().scalar("enriched").unwrap();
        assert!(is_stamp(&stamp), "{stamp}");

        // Done: not pending, and a second apply changes nothing.
        assert!(Files.pending(root).unwrap().is_empty());
        Files.apply(root, &clip, &update()).unwrap();
        assert_eq!(read(root, "inspiration/why-we-sleep.md"), text);
    }

    #[test]
    fn apply_rereads_and_keeps_concurrent_own_text_title_and_tag_edits() {
        let dir = vault();
        let root = dir.path();
        write(
            root,
            "inspiration/note.md",
            "---\nkind: note\ncaptured: \"2026-10-29T14:05\"\ntags: [draft]\n---\n\nFirst thought.",
        );
        let clip = Files.pending(root).unwrap().remove(0);

        // The writer edits on the Mac while the AI is thinking.
        let edited = "---\nkind: note\ncaptured: \"2026-10-29T14:05\"\ntitle: Mine\ntags: [mine]\n---\n\nFirst thought, reworded  \r\nwith a second line, no trailing newline";
        write(root, "inspiration/note.md", edited);
        Files
            .apply(
                root,
                &clip,
                &Update {
                    source_text: None,
                    image: None,
                    ..update()
                },
            )
            .unwrap();

        let text = read(root, "inspiration/note.md");
        let doc = Doc::parse(&text).unwrap();
        assert_eq!(
            doc.body,
            Doc::parse(edited).unwrap().body,
            "own text byte-for-byte, no source added"
        );
        assert_eq!(doc.scalar("title").as_deref(), Some("Mine"));
        assert_eq!(doc.list("tags"), ["mine"]);
        assert_eq!(doc.scalar("kind").as_deref(), Some("video"));
        assert!(!root.join("inspiration/media/note.jpg").exists());
    }

    #[test]
    fn source_is_appended_after_own_text_and_capture_images_are_never_overwritten() {
        let dir = vault();
        let root = dir.path();
        let original = "---\nkind: link\nurl: \"https://example.org\"\n---\n\nMy note";
        write(root, "inspiration/page.md", original);
        write(root, "inspiration/media/page.jpg", "the capture's screenshot");
        let clip = Files.pending(root).unwrap().remove(0);
        Files.apply(root, &clip, &update()).unwrap();

        let text = read(root, "inspiration/page.md");
        assert!(text.ends_with("\n\nMy note\n\n## Source\n\nNew source.\n"), "{text}");
        assert_eq!(read(root, "inspiration/media/page.jpg"), "the capture's screenshot");
        assert!(text.contains("image: \"media/page-2.jpg\"\n"));
        assert!(root.join("inspiration/media/page-2.jpg").exists());
    }

    #[test]
    fn existing_or_unsafe_images_are_not_saved() {
        let dir = vault();
        let root = dir.path();
        write(root, "inspiration/shot.md", "---\nkind: image\nimage: \"media/shot.png\"\n---\n");
        write(root, "inspiration/svg.md", "---\nkind: link\n---\n");
        let clips = Files.pending(root).unwrap();
        for clip in &clips {
            let svg = Image {
                bytes: b"<svg onload=alert(1)>".to_vec(),
                mime: "image/jpeg".into(),
            };
            let image = if clip.path.ends_with("svg.md") { svg } else { jpeg() };
            Files
                .apply(
                    root,
                    clip,
                    &Update {
                        image: Some(image),
                        ..update()
                    },
                )
                .unwrap();
        }
        assert_eq!(fs::read_dir(root.join("inspiration/media")).unwrap().count(), 0);
        assert!(read(root, "inspiration/shot.md").contains("image: \"media/shot.png\"\n"));
        assert!(!read(root, "inspiration/svg.md").contains("image:"));
    }

    #[test]
    fn fail_records_one_safe_line_and_keeps_the_text() {
        let dir = vault();
        let root = dir.path();
        write(root, "inspiration/why-we-sleep.md", CLIP);
        let clip = Files.pending(root).unwrap().remove(0);
        Files.fail(root, &clip, "page fetch timed out\nkind: video\n---").unwrap();

        let text = read(root, "inspiration/why-we-sleep.md");
        // Only one line added; every other byte, frontmatter included, is kept.
        let expected = CLIP.replacen(
            "---\n\n> A passage",
            "enrich_error: \"page fetch timed out kind: video ---\"\n---\n\n> A passage",
            1,
        );
        assert_eq!(text, expected);
        let doc = Doc::parse(&text).unwrap();
        assert_eq!(doc.scalar("enrich_error").as_deref(), Some("page fetch timed out kind: video ---"));
        assert_eq!(doc.scalar("kind").as_deref(), Some("link"));
        assert_eq!(doc.body, Doc::parse(CLIP).unwrap().body);
        assert!(Files.pending(root).unwrap().is_empty());
    }

    #[test]
    fn errors_name_no_paths() {
        let dir = vault();
        let root = dir.path();
        for path in [
            "../secret.md",
            "inspiration/../x.md",
            "inspiration/.hidden.md",
            "notes/x.md",
            "inspiration/missing.md",
        ] {
            let clip = Clip {
                path: path.into(),
                ..Clip::default()
            };
            let error = Files.apply(root, &clip, &update()).unwrap_err();
            assert!(
                !error.contains('/') && !error.contains("secret") && !error.contains("missing"),
                "{error}"
            );
            assert!(Files.fail(root, &clip, "x").is_err());
        }
        #[cfg(unix)]
        {
            let outside = tempfile::tempdir().unwrap();
            write(outside.path(), "x.md", "---\nkind: note\n---\n");
            std::os::unix::fs::symlink(outside.path().join("x.md"), root.join("inspiration/x.md")).unwrap();
            let clip = Clip {
                path: "inspiration/x.md".into(),
                ..Clip::default()
            };
            assert!(Files.apply(root, &clip, &update()).is_err());
            assert_eq!(read(outside.path(), "x.md"), "---\nkind: note\n---\n");
        }
    }

    #[test]
    fn tags_come_from_every_writing_document_most_used_first() {
        let dir = vault();
        let root = dir.path();
        write(
            root,
            "essays/craft.mdx",
            "---\ntitle: On craft\ntags: [Writing, '#craft']\nstatus: draft\n---\n",
        );
        write(root, "notes/deep/idea.md", "---\ntags:\n  - writing\n  - ideas\n---\n");
        write(root, "single.md", "---\ntags: solo\n---\n");
        write(root, "inspiration/clip.md", "---\nkind: note\ntags: [writing, sleep]\n---\n");
        write(root, "inspiration/media/fake.md", "---\ntags: [media]\n---\n");
        write(root, ".obsidian/x.md", "---\ntags: [hidden]\n---\n");
        write(root, "notes/.draft.md", "---\ntags: [hidden]\n---\n");
        write(root, "notes/readme.txt", "---\ntags: [text]\n---\n");
        #[cfg(unix)]
        {
            let outside = tempfile::tempdir().unwrap();
            write(outside.path(), "out.md", "---\ntags: [outside]\n---\n");
            std::os::unix::fs::symlink(outside.path(), root.join("linked")).unwrap();
        }
        assert_eq!(Files.tags(root).unwrap(), ["writing", "craft", "ideas", "sleep", "solo"]);
    }

    #[test]
    fn frontmatter_round_trips_without_injection_and_keeps_crlf() {
        let text = "---\r\nkind: note\r\nnote: >\r\n  folded\r\n---\r\n\r\nBody\r\n";
        let mut doc = Doc::parse(text).unwrap();
        assert_eq!(doc.render(doc.body), text);
        assert_eq!(doc.get("note"), Some(&Value::Other));
        let evil = "a \"quote\"\nkind: video\n---\nbody";
        doc.set("title", Value::Scalar(evil.into()));
        doc.set("tags", Value::List(vec!["ok".into(), "two words".into(), "true".into()]));
        let rendered = doc.render(doc.body);
        assert!(rendered.contains("tags: [ok, \"two words\", \"true\"]\r\n"));
        let parsed = Doc::parse(&rendered).unwrap();
        assert_eq!(parsed.scalar("title").as_deref(), Some(evil));
        assert_eq!(parsed.scalar("kind").as_deref(), Some("note"));
        assert_eq!(parsed.body, "\r\nBody\r\n");
        for bad in ["Body", "---\nkind: note", "---\na: x\na: y\n---", "---\n  - x\n---"] {
            assert!(Doc::parse(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn source_headings_inside_the_writers_code_are_never_replaced() {
        let own = "\nMy example:\n```markdown\n## Source\nKeep this example.\n```\n\n~~~\n## Source\nKeep this too.\n~~~\n\n";
        let body = format!("{own}## Source\n\nOld page text.\n");
        let updated = with_source(&body, "New page text.", "\n");
        assert_eq!(split_source(&updated).0, own);
        assert!(updated.ends_with("## Source\n\nNew page text.\n"));
    }

    #[test]
    fn enriched_uses_the_capture_stamp_format() {
        assert!(is_stamp(&local_stamp()));
        assert!(!is_stamp("2026-10-29 14:05"));
    }
}
