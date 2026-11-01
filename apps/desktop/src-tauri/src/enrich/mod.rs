//! Enrichment adds source material and organization, never the writer's words.
//! Fetching and extraction belong to the ingest engine (`kintsugi-ingest`);
//! this module decides what a clip needs and writes it back.

#[cfg(not(feature = "headless"))]
pub mod render;
mod storage;
mod tags;
pub mod think;
mod worker;

pub use worker::{Worker, start, wake};

/// The engine clips are enriched with: X posts and threads, Reddit posts with
/// their comments, then any web page, with the hidden-webview JavaScript
/// fallback on the Mac. Reddit falls back to the web adapter when its JSON is
/// refused. Headless runs have no webview, so they use static extraction only.
fn ingest_engine(app: &crate::AppHandle) -> kintsugi_ingest::Result<kintsugi_ingest::Engine> {
    use std::sync::Arc;
    let web = kintsugi_ingest::web::WebAdapter::new()?;
    #[cfg(not(feature = "headless"))]
    let web = web.with_renderer(Arc::new(render::WebviewRenderer::new(app.clone())));
    #[cfg(feature = "headless")]
    let _ = app;
    let web = Arc::new(web);
    let reddit = kintsugi_ingest::reddit::RedditAdapter::new()?.with_fallback(web.clone());
    Ok(kintsugi_ingest::Engine::new().with(kintsugi_ingest::x::XAdapter::new()?).with(reddit).with(web))
}
