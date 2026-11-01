//! PDFs: a local file (a drop on the Mac, a share from the phone) or a link
//! to one (`….pdf`, arXiv's `/pdf/` pages).
//!
//! - **Out of the box**, Apple's PDFKit reads the text, metadata and outline
//!   and renders page one as the clip's image, through the small Swift
//!   helper `kintsugi-pdf` (`crates/ingest/swift/pdf.swift`) run as a child
//!   process, so a hostile file can only crash or stall the helper, which is
//!   killed at the time limit. [`layout`] turns its lines into Markdown.
//! - **Optionally**, Docling ([`crate::tools::catalog::DOCLING`]) converts
//!   the body with layout analysis (columns, tables, formulas) once the
//!   person has agreed to download it. PDFKit still supplies metadata and
//!   the thumbnail, and its text is the fallback when Docling fails.
//!
//! See `docs/ingest.md` › "PDFs" for why PDFKit rather than pdfium.

pub mod layout;

use crate::fetch::Fetcher;
use crate::tools::{ToolError, Tools, catalog};
use crate::{
    Adapter, BoxFuture, FULL_CHARS, CaptureOptions, Error, Item, Media, MediaData, MediaKind, Result, SourceType,
    Target, markdown, media,
};
pub use layout::PdfText;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncReadExt;

/// Linked PDFs larger than this aren't downloaded (the clip file cap).
pub const MAX_PDF_BYTES: u64 = 50 * 1024 * 1024;
/// The helper stops reading pages after this much text; the body is capped
/// at [`FULL_CHARS`] anyway, and headings need some look-ahead.
const HELPER_CHARS: usize = 400_000;

/// Reads a PDF's text, metadata and (optionally) a page-one thumbnail.
pub trait PdfReader: Send + Sync {
    fn read<'a>(&'a self, pdf: &'a Path, thumbnail: Option<&'a Path>) -> BoxFuture<'a, Result<PdfText>>;
}

/// Apple PDFKit through the `kintsugi-pdf` helper.
pub struct PdfKitReader {
    program: PathBuf,
    timeout: Duration,
}

impl PdfKitReader {
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self { program: program.into(), timeout: Duration::from_secs(60) }
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    async fn run(&self, pdf: &Path, thumbnail: Option<&Path>) -> Result<PdfText> {
        let mut command = tokio::process::Command::new(&self.program);
        command.arg(pdf).arg("--max-chars").arg(HELPER_CHARS.to_string());
        if let Some(thumbnail) = thumbnail {
            command.arg("--thumbnail").arg(thumbnail);
        }
        let out = run_helper(command, self.timeout, 64 * 1024 * 1024).await?;
        serde_json::from_slice(&out).map_err(|_| Error::Unavailable)
    }
}

impl PdfReader for PdfKitReader {
    fn read<'a>(&'a self, pdf: &'a Path, thumbnail: Option<&'a Path>) -> BoxFuture<'a, Result<PdfText>> {
        Box::pin(self.run(pdf, thumbnail))
    }
}

/// Runs a helper with no stdin, discarded stderr (it can carry document
/// text) and a time limit; returns at most `limit` bytes of stdout. Exit 3
/// is "unsupported here".
pub(crate) async fn run_helper(mut command: tokio::process::Command, timeout: Duration, limit: u64) -> Result<Vec<u8>> {
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    let mut child = command.spawn().map_err(|_| Error::Unavailable)?;
    let mut stdout = child.stdout.take().ok_or(Error::Unavailable)?;
    let work = async {
        let mut out = Vec::new();
        (&mut stdout).take(limit).read_to_end(&mut out).await.map_err(|_| Error::Unavailable)?;
        let status = child.wait().await.map_err(|_| Error::Unavailable)?;
        Ok::<_, Error>((status, out))
    };
    let (status, out) = tokio::time::timeout(timeout, work).await.map_err(|_| Error::TimedOut)??;
    match status.code() {
        Some(0) => Ok(out),
        Some(3) => Err(Error::Unsupported),
        _ => Err(Error::Unavailable),
    }
}

/// A high-quality converter: the whole document as Markdown.
pub trait PdfConverter: Send + Sync {
    /// Recorded in `extras.extractor`.
    fn name(&self) -> &'static str;
    /// [`Error::ToolNeeded`] when the person hasn't agreed to install it.
    fn convert<'a>(&'a self, pdf: &'a Path) -> BoxFuture<'a, Result<String>>;
}

/// Docling from the optional-tools manager. Conversions run offline: the
/// models were fetched at install and Hugging Face is told not to look.
pub struct Docling {
    tools: Arc<Tools>,
    timeout: Duration,
}

impl Docling {
    pub fn new(tools: Arc<Tools>) -> Self {
        Self { tools, timeout: Duration::from_secs(10 * 60) }
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    async fn run(&self, pdf: &Path) -> Result<String> {
        self.run_with(&catalog::DOCLING, pdf).await
    }

    pub(crate) async fn run_with(&self, spec: &crate::tools::ToolSpec, pdf: &Path) -> Result<String> {
        let program = self.tools.ensure(spec).await.map_err(|e| match e {
            ToolError::NeedsConsent => Error::ToolNeeded,
            ToolError::UnsupportedPlatform => Error::Unsupported,
            _ => Error::Unavailable,
        })?;
        // `<version>/bin/docling` → `<version>/models`.
        let version_dir = program.parent().and_then(Path::parent).ok_or(Error::Unavailable)?;
        let work = tempfile::tempdir().map_err(|_| Error::Setup)?;
        let input = work.path().join("document.pdf");
        tokio::fs::copy(pdf, &input).await.map_err(|_| Error::Setup)?;
        let output = work.path().join("out");
        let mut command = tokio::process::Command::new(&program);
        command
            .arg(&input)
            .args(["--to", "md", "--image-export-mode", "placeholder", "--ocr-engine", "ocrmac"])
            .arg("--artifacts-path")
            .arg(version_dir.join("models"))
            .arg("--output")
            .arg(&output)
            .env("HF_HUB_OFFLINE", "1")
            .env("HF_HOME", version_dir.join("hf"))
            .current_dir(work.path());
        run_helper(command, self.timeout, 1024).await?;
        let file = tokio::fs::File::open(output.join("document.md")).await.map_err(|_| Error::Unavailable)?;
        let mut bytes = Vec::new();
        file.take(8 * 1024 * 1024).read_to_end(&mut bytes).await.map_err(|_| Error::Unavailable)?;
        let text = String::from_utf8_lossy(&bytes);
        Ok(text.lines().filter(|l| l.trim() != "<!-- image -->").collect::<Vec<_>>().join("\n"))
    }
}

impl PdfConverter for Docling {
    fn name(&self) -> &'static str {
        "docling"
    }

    fn convert<'a>(&'a self, pdf: &'a Path) -> BoxFuture<'a, Result<String>> {
        Box::pin(self.run(pdf))
    }
}

/// Captures PDFs. Without a reader (no helper in this build) only the
/// converter can read them; with neither, PDFs are unsupported.
pub struct PdfAdapter {
    reader: Option<Arc<dyn PdfReader>>,
    converter: Option<Arc<dyn PdfConverter>>,
    fetcher: Fetcher,
}

impl PdfAdapter {
    pub fn new(reader: Option<Arc<dyn PdfReader>>) -> Result<Self> {
        Ok(Self { reader, converter: None, fetcher: Fetcher::new()? })
    }

    pub fn with_converter(mut self, converter: Arc<dyn PdfConverter>) -> Self {
        self.converter = Some(converter);
        self
    }

    /// Reads one PDF already on disk. `url` is where it came from, if anywhere.
    pub async fn capture_file(&self, pdf: &Path, url: Option<&reqwest::Url>, options: CaptureOptions) -> Result<Item> {
        let head = read_head(pdf).await?;
        if !is_pdf(&head) {
            return Err(Error::Unsupported);
        }
        let work = tempfile::tempdir().map_err(|_| Error::Setup)?;
        let thumbnail = options.want_media.then(|| work.path().join("page-1.png"));
        let read = match &self.reader {
            Some(reader) => Some(reader.read(pdf, thumbnail.as_deref()).await),
            None => None,
        };
        let converted = match &self.converter {
            Some(converter) => Some((converter.name(), converter.convert(pdf).await)),
            None => None,
        };
        let text = match read {
            Some(Ok(text)) => Some(text),
            // Docling may still read what PDFKit could not.
            Some(Err(error)) if !matches!(converted, Some((_, Ok(_)))) => return Err(error),
            _ => None,
        };
        let Some(text) = text.or_else(|| converted.as_ref().filter(|(_, r)| r.is_ok()).map(|_| PdfText::default())) else {
            return Err(Error::Unsupported);
        };

        let mut extras: BTreeMap<String, Value> = BTreeMap::new();
        let mut body = markdown::body(&layout::markdown(&text), FULL_CHARS);
        let mut extractor = "pdfkit";
        match converted {
            Some((name, Ok(md))) if !md.trim().is_empty() => {
                body = markdown::body(&md, FULL_CHARS);
                extractor = name;
            }
            Some((name, Err(Error::ToolNeeded))) => {
                extras.insert("converter".into(), json!(name));
                extras.insert("converterReason".into(), json!("tool-not-installed"));
            }
            Some((name, _)) => {
                extras.insert("converter".into(), json!(name));
                extras.insert("converterReason".into(), json!("failed"));
            }
            None => {}
        }
        extras.insert("extractor".into(), json!(extractor));
        if text.page_count > 0 {
            extras.insert("pages".into(), json!(text.page_count));
        }
        if !text.keywords.is_empty() {
            extras.insert("keywords".into(), json!(text.keywords));
        }
        if text.locked {
            extras.insert("locked".into(), json!(true));
        }
        if body.is_empty() {
            extras.insert("textReason".into(), json!(if text.locked { "locked" } else { "no-text" }));
        }

        let mut media = Vec::new();
        if let Some(path) = &thumbnail
            && let Ok(bytes) = tokio::fs::read(path).await
            && let Some(mime) = media::image_mime(&bytes)
        {
            media.push(Media { kind: MediaKind::Image, url: None, data: Some(MediaData { bytes, mime: mime.into() }) });
        }
        let canonical = url.map(crate::web::canonical_url);
        let id = match &canonical {
            Some(url) => format!("pdf:{url}"),
            None => format!("pdf:sha256:{}", file_sha256(pdf).await?),
        };
        Ok(Item {
            source: SourceType::Pdf,
            id,
            url: canonical.map(|u| u.to_string()),
            title: title(&text, &body),
            author: text.author.as_deref().and_then(|a| markdown::field(a, 300)),
            site: None,
            description: text.subject.as_deref().and_then(|s| markdown::field(s, 600)),
            published: text.created.clone(),
            captured: crate::now(),
            media,
            body,
            extras,
        })
    }

    async fn capture_url(&self, url: &reqwest::Url, options: CaptureOptions) -> Result<Item> {
        let work = tempfile::tempdir().map_err(|_| Error::Setup)?;
        let path = work.path().join("download.pdf");
        tokio::time::timeout(Duration::from_secs(120), self.fetcher.to_file(url, MAX_PDF_BYTES, &path))
            .await
            .map_err(|_| Error::TimedOut)??;
        if !is_pdf(&read_head(&path).await?) {
            return Err(Error::Unavailable);
        }
        self.capture_file(&path, Some(url), options).await
    }
}

impl Adapter for PdfAdapter {
    fn source(&self) -> SourceType {
        SourceType::Pdf
    }

    fn matches(&self, target: &Target) -> bool {
        match target {
            Target::File(path) => has_extension(path, "pdf"),
            Target::Url(url) => pdf_url(url),
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

/// A link that names a PDF: a `.pdf` path, or an arXiv PDF page.
pub fn pdf_url(url: &reqwest::Url) -> bool {
    if !crate::web::allowed_url(url) {
        return false;
    }
    let path = url.path().to_ascii_lowercase();
    path.ends_with(".pdf")
        || (matches!(url.host_str(), Some("arxiv.org" | "www.arxiv.org" | "export.arxiv.org")) && path.starts_with("/pdf/"))
}

pub(crate) fn has_extension(path: &Path, extension: &str) -> bool {
    path.extension().is_some_and(|e| e.eq_ignore_ascii_case(extension))
}

/// PDF readers accept the header anywhere in the first kilobyte.
fn is_pdf(head: &[u8]) -> bool {
    head.windows(5).any(|w| w == b"%PDF-")
}

async fn read_head(path: &Path) -> Result<Vec<u8>> {
    let file = tokio::fs::File::open(path).await.map_err(|_| Error::Unavailable)?;
    let mut head = Vec::new();
    file.take(1024).read_to_end(&mut head).await.map_err(|_| Error::Unavailable)?;
    Ok(head)
}

pub(crate) async fn file_sha256(path: &Path) -> Result<String> {
    let mut file = tokio::fs::File::open(path).await.map_err(|_| Error::Unavailable)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0; 64 * 1024];
    loop {
        let n = file.read(&mut buffer).await.map_err(|_| Error::Unavailable)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// The declared title, unless it is a word processor's leftover ("Microsoft
/// Word - draft.docx", "untitled"); else the first heading of the body.
fn title(text: &PdfText, body: &str) -> Option<String> {
    let declared = text.title.as_deref().and_then(|t| markdown::field(t, 300)).filter(|t| {
        let lower = t.to_lowercase();
        !(lower.starts_with("microsoft word")
            || lower.starts_with("untitled")
            || lower.ends_with(".doc")
            || lower.ends_with(".docx")
            || lower.ends_with(".pdf")
            || lower.ends_with(".indd")
            || lower.ends_with(".tex")
            || lower.chars().filter(|c| c.is_alphabetic()).count() < 2)
    });
    declared.or_else(|| {
        body.lines()
            .find_map(|l| l.strip_prefix("## ").or_else(|| l.strip_prefix("# ")))
            .and_then(|h| markdown::field(&h.replace('\\', ""), 300))
    })
}

#[cfg(test)]
mod tests;
