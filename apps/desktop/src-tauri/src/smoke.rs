//! CI's packaged-app smoke test (`scripts/smoke-app.mjs`). The frontend calls
//! `app_ready` once the vault has loaded and rendered in the real webview.
//! With `KINTSUGI_SMOKE=1` the app prints a marker and exits 0, which proves
//! the bundle's frontend loaded, ran and reached the backend. Without the
//! variable it does nothing.
use crate::AppHandle;
use std::io::Write;

pub const MARKER: &str = "KINTSUGI_SMOKE_READY";

fn enabled() -> bool {
    std::env::var_os("KINTSUGI_SMOKE").is_some_and(|v| v == "1")
}

/// `rendered`: how many characters of text the page showed.
#[tauri::command]
pub fn app_ready(app: AppHandle, rendered: usize) {
    if !enabled() {
        return;
    }
    let mut out = std::io::stdout();
    let _ = writeln!(out, "{MARKER} rendered={rendered}");
    let _ = out.flush();
    // The headless backend serves many tabs and keeps running.
    #[cfg(not(feature = "headless"))]
    app.exit(0);
    #[cfg(feature = "headless")]
    let _ = app;
}
