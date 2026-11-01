//! Export destinations (PDF, LinkedIn text, HTML) beside publishing to the
//! blog. The frontend reads a document once into a piece and renders it for
//! a destination (`packages/core/src/export.ts`); this side keeps the
//! settings, finds and reads the piece's images in the vault, typesets PDFs
//! and writes files where the save panel chose. No network, no social APIs.
//! See docs/export.md.

pub mod pdf;

use crate::AppHandle;
use crate::blog::repo::{self, ImageRef};
use crate::vault::Vault;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Manager, State};

type Result<T> = std::result::Result<T, String>;

/// The destinations the app knows, in menu order. Ids are open-ended so a
/// destination added later (Kin's, through MCP) needs no settings change.
pub const KNOWN: [&str; 4] = ["blog", "pdf", "linkedin", "html"];
/// Largest image embedded in an export.
const MAX_IMAGE: u64 = 25 * 1024 * 1024;
/// Pages the dialog previews.
const PREVIEW_PAGES: usize = 6;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Stored {
    /// Destinations shown in the Export menu; absent means all of them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    destinations: Option<Vec<String>>,
    /// Sources appendix by default; absent means the blog's older setting.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    appendix: Option<bool>,
    #[serde(default)]
    statement: bool,
    /// The writer's wording; absent means the app's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    statement_text: Option<String>,
}

#[derive(Default)]
pub struct Export {
    settings: Mutex<Option<Stored>>,
    /// One change at a time: each reads, changes and writes the whole file.
    changing: Mutex<()>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    destinations: Vec<String>,
    appendix: bool,
    statement: bool,
    /// Null until the writer words it himself.
    statement_text: Option<String>,
}

fn stored(app: &AppHandle) -> Stored {
    let export = app.state::<Export>();
    let mut cached = export.settings.lock().unwrap();
    cached
        .get_or_insert_with(|| {
            crate::blog::config_file(app, "export.json")
                .and_then(|p| fs::read_to_string(p).ok())
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default()
        })
        .clone()
}

fn resolve(stored: &Stored, blog_appendix: bool) -> Settings {
    Settings {
        destinations: stored.destinations.clone().unwrap_or_else(|| KNOWN.iter().map(|s| s.to_string()).collect()),
        appendix: stored.appendix.unwrap_or(blog_appendix),
        statement: stored.statement,
        statement_text: stored.statement_text.clone(),
    }
}

fn settings(app: &AppHandle) -> Settings {
    resolve(&stored(app), crate::blog::appendix_default(app))
}

#[tauri::command]
pub fn export_settings(app: AppHandle) -> Settings {
    settings(&app)
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    destinations: Option<Vec<String>>,
    appendix: Option<bool>,
    statement: Option<bool>,
    /// An empty string goes back to the default wording.
    statement_text: Option<String>,
}

fn apply(mut next: Stored, change: Change) -> Result<Stored> {
    if let Some(list) = change.destinations {
        let mut clean: Vec<String> = Vec::new();
        for id in list {
            let ok = !id.is_empty() && id.len() <= 40 && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
            if !ok {
                return Err(format!("not a destination: {id}"));
            }
            if !clean.contains(&id) {
                clean.push(id);
            }
        }
        next.destinations = Some(clean);
    }
    if let Some(on) = change.appendix {
        next.appendix = Some(on);
    }
    if let Some(on) = change.statement {
        next.statement = on;
    }
    if let Some(text) = change.statement_text {
        let text = text.trim();
        if text.chars().count() > 600 {
            return Err("Keep the statement under 600 characters.".into());
        }
        next.statement_text = (!text.is_empty()).then(|| text.to_string());
    }
    Ok(next)
}

#[tauri::command]
pub fn export_configure(app: AppHandle, change: Change) -> Result<Settings> {
    let export = app.state::<Export>();
    let _one = export.changing.lock().unwrap();
    let next = apply(stored(&app), change)?;
    if let Some(path) = crate::blog::config_file(&app, "export.json") {
        fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
        kintsugi_vault::write_atomic(&path, &serde_json::to_string_pretty(&next).map_err(|e| e.to_string())?)?;
    }
    *app.state::<Export>().settings.lock().unwrap() = Some(next);
    Ok(settings(&app))
}

/// Which vault file each of a piece's images is (as Publish resolves them).
#[tauri::command]
pub fn export_images(vault: State<Vault>, images: Vec<ImageRef>) -> Result<BTreeMap<String, Option<String>>> {
    Ok(repo::resolve_images(&vault.root()?, &images))
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    name: String,
    /// Vault-relative.
    from: String,
}

fn mime(path: &str) -> Option<&'static str> {
    let ext = Path::new(path).extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        _ => return None,
    })
}

fn read_asset(root: &Path, asset: &Asset) -> Result<Vec<u8>> {
    mime(&asset.from).ok_or_else(|| format!("not an image: {}", asset.from))?;
    let path = kintsugi_vault::resolve(root, &asset.from)?;
    let meta = fs::metadata(&path).map_err(|e| format!("{}: {e}", asset.from))?;
    if !meta.is_file() {
        return Err(format!("not a file: {}", asset.from));
    }
    if meta.len() > MAX_IMAGE {
        return Err(format!("{} is too large to embed", asset.from));
    }
    fs::read(&path).map_err(|e| format!("{}: {e}", asset.from))
}

/// The piece's images as data URLs, for destinations that carry them inside
/// the file (HTML) and for previews.
#[tauri::command]
pub fn export_assets(vault: State<Vault>, assets: Vec<Asset>) -> Result<BTreeMap<String, String>> {
    let root = vault.root()?;
    assets
        .iter()
        .map(|asset| {
            let bytes = read_asset(&root, asset)?;
            let data = base64::engine::general_purpose::STANDARD.encode(bytes);
            Ok((asset.name.clone(), format!("data:{};base64,{data}", mime(&asset.from).unwrap())))
        })
        .collect()
}

/// Where the save panel chose to write: an absolute path with the expected
/// extension. Headless runs only write inside their scratch vault or config.
fn target(path: &str, extensions: &[&str]) -> Result<PathBuf> {
    let path = PathBuf::from(path);
    let ext = path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase());
    if !path.is_absolute() || !ext.is_some_and(|e| extensions.contains(&e.as_str())) {
        return Err(format!("choose a .{} file to export to", extensions[0]));
    }
    #[cfg(feature = "headless")]
    let path = crate::headless::scratch_file(&path)?;
    if path.is_dir() {
        return Err("that's a folder".into());
    }
    Ok(path)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfRequest {
    /// Typst source, as `export-typst.ts` renders a piece.
    source: String,
    #[serde(default)]
    assets: Vec<Asset>,
    /// Where to write it; without one, only the preview is made.
    path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfReply {
    pages: usize,
    /// The first pages as SVG (previews only).
    preview: Vec<String>,
    written: Option<String>,
}

/// Typesets a piece; previews it, or writes the PDF.
#[tauri::command]
pub async fn export_pdf(vault: State<'_, Vault>, request: PdfRequest) -> Result<PdfReply> {
    let root = vault.root()?;
    let path = request.path.as_deref().map(|p| target(p, &["pdf"])).transpose()?;
    tauri::async_runtime::spawn_blocking(move || {
        let assets = request.assets.iter().map(|a| Ok((a.name.clone(), read_asset(&root, a)?))).collect::<Result<Vec<_>>>()?;
        let document = pdf::typeset(&request.source, assets)?;
        let pages = document.pages().len();
        match path {
            Some(path) => {
                kintsugi_vault::write_bytes_atomic(&path, &pdf::pdf(&document)?)?;
                Ok(PdfReply { pages, preview: vec![], written: Some(path.to_string_lossy().into_owned()) })
            }
            None => Ok(PdfReply { pages, preview: pdf::svg_pages(&document, PREVIEW_PAGES), written: None }),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Writes a text destination (HTML) where the save panel chose.
#[tauri::command]
pub fn export_write(path: String, content: String) -> Result<String> {
    let path = target(&path, &["html", "htm", "txt"])?;
    kintsugi_vault::write_atomic(&path, &content)?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_default_to_every_destination_and_the_blogs_appendix() {
        let s = resolve(&Stored::default(), true);
        assert_eq!(s.destinations, KNOWN);
        assert!(s.appendix);
        assert!(!s.statement, "the statement is off until he turns it on");
        assert_eq!(s.statement_text, None);
    }

    #[test]
    fn changes_validate_ids_and_trim_the_statement() {
        let next = apply(Stored::default(), Change {
            destinations: Some(vec!["pdf".into(), "html".into(), "pdf".into(), "mcp-notion".into()]),
            appendix: Some(false),
            statement: Some(true),
            statement_text: Some("  Mine, all of it.  ".into()),
        })
        .unwrap();
        let s = resolve(&next, true);
        assert_eq!(s.destinations, ["pdf", "html", "mcp-notion"]);
        assert!(!s.appendix && s.statement);
        assert_eq!(s.statement_text.as_deref(), Some("Mine, all of it."));
        let back = apply(next, Change { statement_text: Some("  ".into()), ..Default::default() }).unwrap();
        assert_eq!(back.statement_text, None, "empty goes back to the default wording");
        assert!(apply(Stored::default(), Change { destinations: Some(vec!["../x".into()]), ..Default::default() }).is_err());
        assert!(apply(Stored::default(), Change { statement_text: Some("x".repeat(601)), ..Default::default() }).is_err());
    }

    #[test]
    fn writes_only_the_expected_kind_of_file() {
        assert!(target("relative.pdf", &["pdf"]).is_err());
        assert!(target("/tmp/x.exe", &["pdf"]).is_err());
        #[cfg(not(feature = "headless"))]
        assert!(target("/tmp/x.PDF", &["pdf"]).is_ok());
    }

    #[test]
    fn assets_are_vault_images_only() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.png"), b"png").unwrap();
        fs::write(dir.path().join("notes.md"), b"text").unwrap();
        let asset = |from: &str| Asset { name: "image-1.png".into(), from: from.into() };
        assert_eq!(read_asset(dir.path(), &asset("a.png")).unwrap(), b"png");
        assert!(read_asset(dir.path(), &asset("notes.md")).is_err());
        assert!(read_asset(dir.path(), &asset("../a.png")).is_err());
    }
}
