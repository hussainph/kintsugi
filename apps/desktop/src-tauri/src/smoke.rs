//! CI's packaged-app smoke test (`scripts/smoke-app.mjs`). The frontend calls
//! `app_ready` once the vault has loaded and rendered in the real webview.
//! With `KINTSUGI_SMOKE=1` the native app first asks for one reload, so the
//! app's own origin has to pass the navigation guard (a guard that blocked
//! `tauri://localhost` once left packaged debug builds blank). After the
//! reloaded page renders, it prints a marker and exits 0. That proves the
//! bundle's frontend loaded, ran and reached the backend. Without the variable
//! it does nothing.
use crate::AppHandle;
use std::io::Write;

pub const MARKER: &str = "KINTSUGI_SMOKE_READY";

fn enabled() -> bool {
    std::env::var_os("KINTSUGI_SMOKE").is_some_and(|v| v == "1")
}

/// `rendered`: how many characters of text the page showed. Returns true
/// when the page should reload and report again.
#[tauri::command]
pub fn app_ready(app: AppHandle, rendered: usize) -> bool {
    if !enabled() {
        return false;
    }
    let mut out = std::io::stdout();
    #[cfg(not(feature = "headless"))]
    {
        use std::sync::atomic::{AtomicBool, Ordering};
        static RELOADED: AtomicBool = AtomicBool::new(false);
        if !RELOADED.swap(true, Ordering::SeqCst) {
            let _ = writeln!(out, "smoke: first render (rendered={rendered}); reloading");
            let _ = out.flush();
            return true;
        }
    }
    let _ = writeln!(out, "{MARKER} rendered={rendered}");
    let _ = out.flush();
    // The headless backend serves many tabs and keeps running.
    #[cfg(not(feature = "headless"))]
    app.exit(0);
    #[cfg(feature = "headless")]
    let _ = app;
    false
}

/// Logs the navigation guard's decisions during a smoke run.
#[cfg(not(feature = "headless"))]
pub fn navigation(url: &tauri::Url, allowed: bool) {
    if enabled() {
        eprintln!(
            "smoke: navigation to {url} {}",
            if allowed { "allowed" } else { "blocked" }
        );
    }
}
