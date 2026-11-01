//! EPUB e-books: a local file (dropped on the Mac, shared from the phone)
//! or a link to one. An EPUB is a zip of XHTML chapters with an OPF package
//! document listing its metadata, files and reading order (the spine).
//!
//! Capture unzips it in memory with strict caps, reads the package's
//! Dublin Core metadata and cover, and runs the chapters, in spine order,
//! through the same HTML-to-Markdown conversion as web pages. Front matter
//! (the cover page, the table of contents, the copyright page) and
//! non-linear items are skipped, so the body starts with the book itself.
//! Bodies are capped at [`FULL_CHARS`] like other long-form items, so a
//! long book keeps its opening chapters (`extras.truncated`).
//!
//! An EPUB is untrusted: no DTDs, no paths outside the archive, every entry
//! size-checked before and while it inflates, internal links and images
//! dropped (they point inside the zip), and no scripts or styles.

use crate::fetch::Fetcher;
use crate::pdf::{file_sha256, has_extension};
use crate::{
    Adapter, BODY_CHARS, BoxFuture, FULL_CHARS, CaptureOptions, Error, Item, Media, MediaData, MediaKind, Result, SourceType,
    Target, markdown, media,
};
use dom_query::Document;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::io::Read;
use std::path::Path;
use std::time::Duration;

/// Larger EPUBs aren't read or downloaded (the clip file cap).
pub const MAX_EPUB_BYTES: u64 = 50 * 1024 * 1024;
const MAX_ENTRIES: usize = 10_000;
const MAX_XML_BYTES: u64 = 2 * 1024 * 1024;
const MAX_CHAPTER_BYTES: u64 = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES: u64 = 8 * 1024 * 1024;
/// Enough chapters are read to fill the body, with some to spare.
const READ_CHARS: usize = FULL_CHARS + BODY_CHARS;

/// Never worth reading in a chapter (images point inside the archive).
const SKIP: &[&str] = &[
    "script", "style", "head", "img", "image", "svg", "video", "audio", "iframe", "object", "embed", "form", "nav",
    "template", "math",
];
/// Spine items that are front matter, by id or file name.
const FRONT_MATTER: &[&str] = &["cover", "titlepage", "title-page", "toc", "contents", "copyright", "nav"];

pub struct EpubAdapter {
    fetcher: Fetcher,
}

impl EpubAdapter {
    pub fn new() -> Result<Self> {
        Ok(Self { fetcher: Fetcher::new()? })
    }

    /// Reads one EPUB already on disk. `url` is where it came from, if anywhere.
    pub async fn capture_file(&self, path: &Path, url: Option<&reqwest::Url>, options: CaptureOptions) -> Result<Item> {
        let owned = path.to_path_buf();
        let want_media = options.want_media;
        let book = tokio::task::spawn_blocking(move || read(&owned, want_media)).await.map_err(|_| Error::Unavailable)??;
        let canonical = url.map(crate::web::canonical_url);
        let id = match (&book.isbn, &canonical) {
            (Some(isbn), _) => format!("epub:isbn:{isbn}"),
            (None, Some(url)) => format!("epub:{url}"),
            (None, None) => format!("epub:sha256:{}", file_sha256(path).await?),
        };
        let mut extras: BTreeMap<String, Value> = BTreeMap::new();
        extras.insert("extractor".into(), json!("epub"));
        extras.insert("chapters".into(), json!(book.chapters));
        if let Some(lang) = &book.lang {
            extras.insert("lang".into(), json!(lang));
        }
        if let Some(isbn) = &book.isbn {
            extras.insert("isbn".into(), json!(isbn));
        }
        let body = markdown::body(&book.body, FULL_CHARS);
        if book.body.chars().count() > body.chars().count() {
            extras.insert("truncated".into(), json!(true));
        }
        Ok(Item {
            source: SourceType::Epub,
            id,
            url: canonical.map(|u| u.to_string()),
            title: book.title,
            author: (!book.authors.is_empty()).then(|| book.authors.join(", ")),
            site: book.publisher,
            description: book.description,
            published: book.date,
            captured: crate::now(),
            media: book.cover.into_iter().collect(),
            body,
            extras,
        })
    }

    async fn capture_url(&self, url: &reqwest::Url, options: CaptureOptions) -> Result<Item> {
        let work = tempfile::tempdir().map_err(|_| Error::Setup)?;
        let path = work.path().join("download.epub");
        tokio::time::timeout(Duration::from_secs(120), self.fetcher.to_file(url, MAX_EPUB_BYTES, &path))
            .await
            .map_err(|_| Error::TimedOut)??;
        self.capture_file(&path, Some(url), options).await.map_err(|e| match e {
            Error::Unsupported => Error::Unavailable,
            other => other,
        })
    }
}

impl Adapter for EpubAdapter {
    fn source(&self) -> SourceType {
        SourceType::Epub
    }

    fn matches(&self, target: &Target) -> bool {
        match target {
            Target::File(path) => has_extension(path, "epub"),
            Target::Url(url) => crate::web::allowed_url(url) && url.path().to_ascii_lowercase().ends_with(".epub"),
        }
    }

    fn capture<'a>(&'a self, target: &'a Target, options: CaptureOptions) -> BoxFuture<'a, Result<Item>> {
        Box::pin(async move {
            match target {
                Target::File(path) => self.capture_file(path, None, options).await,
                Target::Url(url) => self.capture_url(url, options).await,
            }
        })
    }
}

#[derive(Debug, Default)]
struct Book {
    title: Option<String>,
    authors: Vec<String>,
    publisher: Option<String>,
    date: Option<String>,
    description: Option<String>,
    lang: Option<String>,
    isbn: Option<String>,
    cover: Option<Media>,
    chapters: usize,
    body: String,
}

struct ManifestItem {
    href: String,
    media_type: String,
    properties: String,
}

fn read(path: &Path, want_media: bool) -> Result<Book> {
    let meta = std::fs::metadata(path).map_err(|_| Error::Unavailable)?;
    if meta.len() > MAX_EPUB_BYTES {
        return Err(Error::TooLarge);
    }
    let file = std::fs::File::open(path).map_err(|_| Error::Unavailable)?;
    let mut zip = zip::ZipArchive::new(file).map_err(|_| Error::Unsupported)?;
    if zip.len() > MAX_ENTRIES {
        return Err(Error::TooLarge);
    }
    let container = entry_text(&mut zip, "META-INF/container.xml", MAX_XML_BYTES)?;
    let container = xml(&container)?;
    let opf_path = container
        .descendants()
        .find(|n| n.tag_name().name() == "rootfile")
        .and_then(|n| n.attribute("full-path"))
        .map(str::to_string)
        .ok_or(Error::Unavailable)?;
    let opf_text = entry_text(&mut zip, &opf_path, MAX_XML_BYTES)?;
    let opf = xml(&opf_text)?;
    let base = opf_path.rsplit_once('/').map_or("", |(dir, _)| dir).to_string();

    let mut book = Book::default();
    let mut cover_id = None;
    if let Some(metadata) = opf.descendants().find(|n| n.tag_name().name() == "metadata") {
        for node in metadata.children().filter(|n| n.is_element()) {
            let text = node.text().unwrap_or("").trim();
            match node.tag_name().name() {
                "title" if book.title.is_none() => book.title = markdown::field(text, 300),
                "creator" if book.authors.len() < 5 => book.authors.extend(markdown::field(text, 200)),
                "publisher" if book.publisher.is_none() => book.publisher = markdown::field(text, 200),
                "date" if book.date.is_none() => book.date = markdown::field(text, 40),
                "language" if book.lang.is_none() => book.lang = markdown::field(text, 20),
                "description" if book.description.is_none() => book.description = html_text(text, 600),
                "identifier" if book.isbn.is_none() => book.isbn = isbn(text),
                "meta" if node.attribute("name") == Some("cover") => cover_id = node.attribute("content").map(str::to_string),
                _ => {}
            }
        }
    }
    let mut manifest: HashMap<String, ManifestItem> = HashMap::new();
    if let Some(list) = opf.descendants().find(|n| n.tag_name().name() == "manifest") {
        for item in list.children().filter(|n| n.tag_name().name() == "item") {
            if let (Some(id), Some(href)) = (item.attribute("id"), item.attribute("href")) {
                manifest.insert(
                    id.to_string(),
                    ManifestItem {
                        href: resolve(&base, href),
                        media_type: item.attribute("media-type").unwrap_or("").to_ascii_lowercase(),
                        properties: item.attribute("properties").unwrap_or("").to_string(),
                    },
                );
            }
        }
    }

    if want_media {
        let cover = manifest
            .values()
            .find(|i| i.properties.split_whitespace().any(|p| p == "cover-image"))
            .or_else(|| cover_id.as_ref().and_then(|id| manifest.get(id)));
        if let Some(cover) = cover
            && let Ok(bytes) = entry_bytes(&mut zip, &cover.href, MAX_IMAGE_BYTES)
            && let Some(mime) = media::image_mime(&bytes)
        {
            book.cover =
                Some(Media { kind: MediaKind::Image, url: None, data: Some(MediaData { bytes, mime: mime.into() }) });
        }
    }

    let spine: Vec<(String, bool)> = opf
        .descendants()
        .find(|n| n.tag_name().name() == "spine")
        .map(|spine| {
            spine
                .children()
                .filter(|n| n.tag_name().name() == "itemref")
                .filter_map(|n| Some((n.attribute("idref")?.to_string(), n.attribute("linear") != Some("no"))))
                .collect()
        })
        .unwrap_or_default();
    let mut parts: Vec<String> = Vec::new();
    let mut chars = 0;
    for (id, linear) in &spine {
        let Some(item) = manifest.get(id) else { continue };
        if !matches!(item.media_type.as_str(), "application/xhtml+xml" | "text/html") {
            continue;
        }
        book.chapters += 1;
        if !linear || front_matter(id, item) || chars >= READ_CHARS {
            continue;
        }
        let Ok(html) = entry_text(&mut zip, &item.href, MAX_CHAPTER_BYTES) else { continue };
        let md = chapter(&html);
        if !md.trim().is_empty() {
            chars += md.chars().count();
            parts.push(md);
        }
    }
    if parts.is_empty() && book.title.is_none() {
        return Err(Error::Unavailable);
    }
    book.body = parts.join("\n\n");
    Ok(book)
}

fn front_matter(id: &str, item: &ManifestItem) -> bool {
    let name = item.href.rsplit('/').next().unwrap_or("").to_ascii_lowercase();
    let stem = name.split('.').next().unwrap_or("");
    let id = id.to_ascii_lowercase();
    item.properties.split_whitespace().any(|p| p == "nav") || FRONT_MATTER.iter().any(|f| id == *f || stem == *f)
}

/// One chapter's XHTML as Markdown: links into the book become plain text,
/// and images, scripts, styles and navigation are left out.
fn chapter(html: &str) -> String {
    let doc = Document::from(html);
    for link in doc.select("a").iter() {
        let external = link.attr("href").is_some_and(|h| {
            let h = h.trim().to_ascii_lowercase();
            h.starts_with("https://") || h.starts_with("http://")
        });
        if !external {
            link.remove_attr("href");
        }
    }
    let body = doc.select("body");
    body.nodes().first().map_or_else(String::new, |root| markdown::body(&root.md(Some(SKIP)), READ_CHARS))
}

/// Text of a description that may hold HTML (it usually does, escaped).
fn html_text(text: &str, limit: usize) -> Option<String> {
    let doc = Document::from(text);
    markdown::field(&doc.select("body").text(), limit)
}

/// The ISBN in an identifier such as `urn:isbn:978-…` or `ISBN 0-…`.
fn isbn(identifier: &str) -> Option<String> {
    let lower = identifier.trim().to_ascii_lowercase();
    let rest = lower.strip_prefix("urn:isbn:").or_else(|| lower.strip_prefix("isbn:")).or_else(|| lower.strip_prefix("isbn"))?;
    crate::books::normalize_isbn(rest)
}

fn xml(text: &str) -> Result<roxmltree::Document<'_>> {
    // DTDs are refused (no entity expansion from untrusted files).
    roxmltree::Document::parse_with_options(text, roxmltree::ParsingOptions { allow_dtd: false, ..Default::default() })
        .map_err(|_| Error::Unavailable)
}

/// A path inside the archive: `href` (percent-encoded, maybe with a
/// fragment) relative to the package's folder, with `..` resolved and never
/// above the root.
fn resolve(base: &str, href: &str) -> String {
    let href = href.split('#').next().unwrap_or("");
    let mut parts: Vec<String> = base.split('/').filter(|p| !p.is_empty()).map(str::to_string).collect();
    for part in href.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            part => parts.push(percent_decode(part)),
        }
    }
    parts.join("/")
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Ok(byte) = u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("zz"), 16)
        {
            out.push(byte);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn entry_bytes(zip: &mut zip::ZipArchive<std::fs::File>, name: &str, limit: u64) -> Result<Vec<u8>> {
    let entry = zip.by_name(name).map_err(|_| Error::Unavailable)?;
    if entry.size() > limit {
        return Err(Error::TooLarge);
    }
    let mut bytes = Vec::new();
    // The declared size can lie; the read is capped too.
    entry.take(limit + 1).read_to_end(&mut bytes).map_err(|_| Error::Unavailable)?;
    if bytes.len() as u64 > limit {
        return Err(Error::TooLarge);
    }
    Ok(bytes)
}

fn entry_text(zip: &mut zip::ZipArchive<std::fs::File>, name: &str, limit: u64) -> Result<String> {
    let bytes = entry_bytes(zip, name, limit)?;
    let text = String::from_utf8_lossy(&bytes);
    Ok(text.strip_prefix('\u{feff}').unwrap_or(&text).to_string())
}

#[cfg(test)]
mod tests;
