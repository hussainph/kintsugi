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

/// The engine clips are enriched with: web pages, with the hidden-webview
/// JavaScript fallback on the Mac. Headless runs have no webview, so they
/// use static extraction only.
fn ingest_engine(app: &crate::AppHandle) -> kintsugi_ingest::Result<kintsugi_ingest::Engine> {
    let web = kintsugi_ingest::web::WebAdapter::new()?;
    #[cfg(not(feature = "headless"))]
    let web = web.with_renderer(std::sync::Arc::new(render::WebviewRenderer::new(app.clone())));
    #[cfg(feature = "headless")]
    let _ = app;
    Ok(kintsugi_ingest::Engine::new().with(web))
}
