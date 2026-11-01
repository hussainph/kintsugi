//! Pictures: a shared photo or screenshot, read on this Mac.
//!
//! An image clip has nothing for search or Kin to read: no title, no text.
//! [`VisionReader`] runs the small Swift helper `kintsugi-vision`
//! (`crates/ingest/swift/vision.swift`), which uses Apple's Vision framework
//! on-device, as a child process: text recognition (OCR) and image
//! classification labels. Nothing leaves the Mac and no AI call is made.
//!
//! The body says plainly that it is machine-made: it is what a model read
//! or guessed from the picture, not words anyone wrote. Recognised text is
//! made Markdown-safe like post text.

use crate::pdf::{file_sha256, run_helper};
use crate::{Adapter, BoxFuture, CaptureOptions, Error, Item, Result, SourceType, Target, text};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

/// Images the reader accepts, by extension (the clip's media formats).
pub const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "avif"];
/// Labels below this confidence are left out.
const MIN_LABEL_CONFIDENCE: f64 = 0.2;
const MAX_LABELS: usize = 8;
/// Recognised text is capped like a short body.
const MAX_TEXT_CHARS: usize = crate::BODY_CHARS;

/// What the `kintsugi-vision` helper reports about one picture.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct ImageText {
    pub width: u32,
    pub height: u32,
    /// Recognised lines, top to bottom.
    pub lines: Vec<String>,
    /// Classification labels, most confident first.
    pub labels: Vec<Label>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct Label {
    pub label: String,
    pub confidence: f64,
}

/// Reads text and labels from an image file.
pub trait ImageReader: Send + Sync {
    fn read<'a>(&'a self, image: &'a Path) -> BoxFuture<'a, Result<ImageText>>;
}

/// Apple Vision through the `kintsugi-vision` helper.
pub struct VisionReader {
    program: PathBuf,
    timeout: Duration,
}

impl VisionReader {
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self { program: program.into(), timeout: Duration::from_secs(60) }
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }
}

impl ImageReader for VisionReader {
    fn read<'a>(&'a self, image: &'a Path) -> BoxFuture<'a, Result<ImageText>> {
        Box::pin(async move {
            let mut command = tokio::process::Command::new(&self.program);
            command.arg(image);
            let out = run_helper(command, self.timeout, 4 * 1024 * 1024).await?;
            serde_json::from_slice(&out).map_err(|_| Error::Unavailable)
        })
    }
}

/// Captures local image files (`Target::File`) with an [`ImageReader`].
pub struct ImageAdapter {
    reader: Arc<dyn ImageReader>,
}

impl ImageAdapter {
    pub fn new(reader: Arc<dyn ImageReader>) -> Self {
        Self { reader }
    }

    pub async fn capture_file(&self, path: &Path) -> Result<Item> {
        let read = self.reader.read(path).await?;
        let mut extras: BTreeMap<String, Value> = BTreeMap::new();
        extras.insert("extractor".into(), json!("vision"));
        extras.insert("machine".into(), json!(true));
        if read.width > 0 && read.height > 0 {
            extras.insert("width".into(), json!(read.width));
            extras.insert("height".into(), json!(read.height));
        }
        let labels = labels(&read);
        if !labels.is_empty() {
            extras.insert("labels".into(), json!(labels));
        }
        let lines: Vec<String> =
            read.lines.iter().map(|l| l.split_whitespace().collect::<Vec<_>>().join(" ")).filter(|l| !l.is_empty()).collect();
        if !lines.is_empty() {
            extras.insert("ocrLines".into(), json!(lines.len()));
        }
        Ok(Item {
            source: SourceType::Image,
            id: format!("image:sha256:{}", file_sha256(path).await?),
            url: None,
            title: None,
            author: None,
            site: None,
            description: None,
            published: None,
            captured: crate::now(),
            media: Vec::new(),
            body: body(&lines, &labels),
            extras,
        })
    }
}

impl Adapter for ImageAdapter {
    fn source(&self) -> SourceType {
        SourceType::Image
    }

    fn matches(&self, target: &Target) -> bool {
        matches!(target, Target::File(path) if is_image_path(path))
    }

    fn capture<'a>(&'a self, target: &'a Target, _: CaptureOptions) -> BoxFuture<'a, Result<Item>> {
        Box::pin(async move {
            match target {
                Target::File(path) => self.capture_file(path).await,
                Target::Url(_) => Err(Error::Unsupported),
            }
        })
    }
}

pub fn is_image_path(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| IMAGE_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

fn labels(read: &ImageText) -> Vec<String> {
    let mut labels: Vec<&Label> =
        read.labels.iter().filter(|l| l.confidence >= MIN_LABEL_CONFIDENCE && l.confidence.is_finite()).collect();
    labels.sort_by(|a, b| b.confidence.total_cmp(&a.confidence));
    let mut out: Vec<String> = Vec::new();
    for label in labels {
        let name = text::label(&label.label.replace('_', " "), 60).to_lowercase();
        if !name.is_empty() && !out.contains(&name) {
            out.push(name);
        }
        if out.len() == MAX_LABELS {
            break;
        }
    }
    out
}

/// The machine-made description, labelled as such.
fn body(lines: &[String], labels: &[String]) -> String {
    let mut blocks = Vec::new();
    if !lines.is_empty() {
        blocks.push("_Text recognised in the image on this Mac (machine-made, may contain errors):_".to_string());
        let mut text = String::new();
        for line in lines {
            if text.chars().count() + line.chars().count() > MAX_TEXT_CHARS {
                break;
            }
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(line);
        }
        // One recognised line per Markdown line, kept apart with hard breaks.
        blocks.push(text::plain(&text).replace('\n', "  \n"));
    }
    if !labels.is_empty() {
        blocks.push(format!("_What the image shows, as guessed on this Mac (machine-made):_ {}", labels.join(", ")));
    }
    blocks.join("\n\n")
}

#[cfg(test)]
mod tests;
