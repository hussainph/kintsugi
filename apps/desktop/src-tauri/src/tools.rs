//! Optional tools (see `kintsugi_ingest::tools`): what Settings lists, and
//! the person's consent to download each one. Tools live in `tools/` in the
//! app's config folder (the scratch config folder in headless runs), never
//! in the vault.

use kintsugi_ingest::tools::{ToolSpec, ToolStatus, Tools, catalog};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use crate::AppHandle;

type Result<T> = std::result::Result<T, String>;

static TOOLS: OnceLock<Arc<Tools>> = OnceLock::new();

/// The shared manager. Its folder is fixed for the life of the process.
pub fn manager(app: &AppHandle) -> Result<Arc<Tools>> {
    if let Some(tools) = TOOLS.get() {
        return Ok(tools.clone());
    }
    let root = crate::config::directory(app)?.join("tools");
    let tools = Arc::new(Tools::new(root).map_err(|e| e.to_string())?);
    Ok(TOOLS.get_or_init(|| tools).clone())
}

/// The on-device transcription helper, built from
/// `crates/ingest/swift/transcribe.swift` and shipped beside the app binary
/// (a Tauri sidecar), if it is there.
pub fn transcriber_helper() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let path = exe.parent()?.join("kintsugi-transcribe");
    path.is_file().then_some(path)
}

/// The PDF reader (Apple PDFKit), built from `crates/ingest/swift/pdf.swift`
/// and shipped beside the app binary like the transcriber.
pub fn pdf_helper() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let path = exe.parent()?.join("kintsugi-pdf");
    path.is_file().then_some(path)
}

/// The image reader (Apple Vision: text recognition and labels), built from
/// `crates/ingest/swift/vision.swift` and shipped beside the app binary like
/// the transcriber.
pub fn vision_helper() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let path = exe.parent()?.join("kintsugi-vision");
    path.is_file().then_some(path)
}

/// Tools that come along with another: yt-dlp needs Deno for YouTube, and
/// Docling is installed by uv (first, so it is there to install Docling).
fn with_companions(spec: &'static ToolSpec) -> Vec<&'static ToolSpec> {
    if spec.id == catalog::YT_DLP.id {
        vec![spec, &catalog::DENO]
    } else if spec.id == catalog::DOCLING.id {
        vec![&catalog::UV, spec]
    } else {
        vec![spec]
    }
}

fn spec(id: &str) -> Result<&'static ToolSpec> {
    catalog::by_id(id).ok_or_else(|| "unknown optional tool".to_string())
}

fn list(tools: &Tools) -> Vec<ToolStatus> {
    catalog::ALL
        .iter()
        .map(|spec| {
            let mut status = tools.status(spec);
            if spec.id == catalog::APPLE_SPEECH.id && transcriber_helper().is_none() {
                status.supported = false;
            }
            status
        })
        .collect()
}

#[tauri::command]
pub fn tools_list(app: AppHandle) -> Result<Vec<ToolStatus>> {
    let tools = manager(&app)?;
    Ok(list(&tools))
}

/// The person agreed: record consent and download now (system tools are
/// fetched by macOS on first use instead).
#[tauri::command]
pub async fn tools_install(app: AppHandle, id: String) -> Result<Vec<ToolStatus>> {
    let tools = manager(&app)?;
    for spec in with_companions(spec(&id)?) {
        tools.grant(spec).map_err(|e| e.to_string())?;
        if tools.status(spec).kind == "download" {
            tools.install(spec).await.map_err(|e| e.to_string())?;
        }
    }
    Ok(list(&tools))
}

/// Checks for and installs a newer release now.
#[tauri::command]
pub async fn tools_update(app: AppHandle, id: String) -> Result<Vec<ToolStatus>> {
    let tools = manager(&app)?;
    for spec in with_companions(spec(&id)?) {
        if tools.status(spec).kind == "download" && tools.consented(spec) {
            tools.update_if_stale(spec, Duration::ZERO).await.map_err(|e| e.to_string())?;
        }
    }
    Ok(list(&tools))
}

/// Withdraws consent and deletes the files.
#[tauri::command]
pub fn tools_remove(app: AppHandle, id: String) -> Result<Vec<ToolStatus>> {
    let tools = manager(&app)?;
    for spec in with_companions(spec(&id)?) {
        tools.remove(spec).map_err(|e| e.to_string())?;
    }
    Ok(list(&tools))
}
