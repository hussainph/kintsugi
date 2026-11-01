//! The ingest engine's JavaScript fallback on the Mac: a hidden, throwaway
//! webview per page, running the bundled Defuddle (see
//! `kintsugi_ingest::web::render` for the contract this implements).
//!
//! The webview is invisible, unfocused and incognito. Its label is outside
//! every capability and its origin is remote, so it has no IPC access. Only
//! credential-free HTTP(S) navigation outside `localhost` is allowed; new
//! windows and downloads are denied. One render runs at a time, and the
//! webview is destroyed when it finishes, fails or times out.

use crate::AppHandle;
use kintsugi_ingest::{
    BoxFuture, Error, Result, Url,
    web::render::{QUIET_SCRIPT, Rendered, Renderer, SETTLE_SCRIPT, allowed_navigation, defuddle_script},
};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewWindowBuilder};
use tauri::{WebviewUrl, WebviewWindow};
use tokio::sync::{Mutex, mpsc};
use tokio::time::Instant;

/// Labels of hidden ingest webviews start with this; the app's navigation
/// plugin applies [`allowed_navigation`] to them instead of the app-origin rule.
pub const LABEL_PREFIX: &str = "ingest-render-";
/// Longest wait for the page's text to stop changing after load.
const SETTLE: Duration = Duration::from_secs(6);
const SETTLE_POLL: Duration = Duration::from_millis(500);

pub struct WebviewRenderer {
    app: AppHandle,
    next: AtomicU64,
    one_at_a_time: Mutex<()>,
}

impl WebviewRenderer {
    pub fn new(app: AppHandle) -> Self {
        Self { app, next: AtomicU64::new(0), one_at_a_time: Mutex::new(()) }
    }

    async fn run(&self, url: &Url, timeout: Duration) -> Result<Rendered> {
        if !allowed_navigation(url) {
            return Err(Error::InvalidUrl);
        }
        let deadline = Instant::now() + timeout;
        let _turn = tokio::time::timeout_at(deadline, self.one_at_a_time.lock()).await.map_err(|_| Error::TimedOut)?;
        let label = format!("{LABEL_PREFIX}{}", self.next.fetch_add(1, Ordering::Relaxed));
        let (loaded_tx, mut loaded) = mpsc::unbounded_channel();
        let window = WebviewWindowBuilder::new(&self.app, &label, WebviewUrl::External(url.clone()))
            .title("Kintsugi page reader")
            .visible(false)
            .focused(false)
            .skip_taskbar(true)
            .incognito(true)
            .devtools(false)
            .initialization_script(QUIET_SCRIPT)
            .on_navigation(allowed_navigation)
            .on_new_window(|_, _| NewWindowResponse::Deny)
            .on_download(|_, _| false)
            .on_page_load(move |_, payload| {
                if payload.event() == PageLoadEvent::Finished {
                    let _ = loaded_tx.send(());
                }
            })
            .build()
            .map_err(|_| Error::Setup)?;
        let window = Destroy(window);
        let result = tokio::time::timeout_at(deadline, async {
            loaded.recv().await.ok_or(Error::Unavailable)?;
            settle(&window.0, deadline.min(Instant::now() + SETTLE)).await;
            let raw = eval(&window.0, defuddle_script()).await?;
            Rendered::parse(&raw).ok_or(Error::Unavailable)
        })
        .await
        .map_err(|_| Error::TimedOut)?;
        drop(window);
        result
    }
}

impl Renderer for WebviewRenderer {
    fn render<'a>(&'a self, url: &'a Url, timeout: Duration) -> BoxFuture<'a, Result<Rendered>> {
        Box::pin(self.run(url, timeout))
    }
}

/// Waits until the visible text length is nonzero and unchanged between two
/// polls, or until `until`.
async fn settle(window: &WebviewWindow<crate::Runtime>, until: Instant) {
    let mut last = None;
    while Instant::now() < until {
        tokio::time::sleep(SETTLE_POLL).await;
        let length = eval(window, SETTLE_SCRIPT.to_string()).await.ok().and_then(|raw| raw.trim().parse::<u64>().ok());
        if length.is_some_and(|n| n > 0) && length == last {
            return;
        }
        last = length;
    }
}

async fn eval(window: &WebviewWindow<crate::Runtime>, script: String) -> Result<String> {
    let (tx, mut rx) = mpsc::unbounded_channel();
    window
        .eval_with_callback(script, move |result| {
            let _ = tx.send(result);
        })
        .map_err(|_| Error::Unavailable)?;
    rx.recv().await.ok_or(Error::Unavailable)
}

/// Closes the hidden webview however the render ends.
struct Destroy(WebviewWindow<crate::Runtime>);

impl Drop for Destroy {
    fn drop(&mut self) {
        let _ = self.0.destroy();
    }
}
