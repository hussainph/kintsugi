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
/// their comments, YouTube videos (transcripts through yt-dlp once the person
/// installed it, oEmbed metadata until then), links to podcast audio
/// (transcribed on this Mac), PDFs (PDFKit, or Docling once installed) and
/// EPUBs, saved or linked, Open Library books, then any web page, with the hidden-webview
/// JavaScript fallback on the Mac. Reddit falls back to the web adapter when
/// its JSON is refused. Headless runs have no webview, so they use static
/// extraction only.
fn ingest_engine(app: &crate::AppHandle) -> kintsugi_ingest::Result<kintsugi_ingest::Engine> {
    use kintsugi_ingest::{podcast::PodcastAdapter, transcribe::SpeechAnalyzerTranscriber, web::WebAdapter, youtube::YouTubeAdapter};
    use std::sync::Arc;
    let web = WebAdapter::new()?;
    #[cfg(not(feature = "headless"))]
    let web = web.with_renderer(Arc::new(render::WebviewRenderer::new(app.clone())));
    let web = Arc::new(web);
    let reddit = kintsugi_ingest::reddit::RedditAdapter::new()?.with_fallback(web.clone());
    let tools = crate::tools::manager(app).map_err(|_| kintsugi_ingest::Error::Setup)?;
    let youtube = YouTubeAdapter::new(tools.clone())?.with_fallback(Arc::new(WebAdapter::new()?));
    let mut podcast = PodcastAdapter::new()?;
    if let Some(helper) = crate::tools::transcriber_helper() {
        podcast = podcast.with_transcriber(Arc::new(SpeechAnalyzerTranscriber::new(helper).with_consent(tools.clone())));
    }
    let reader = crate::tools::pdf_helper()
        .map(|helper| Arc::new(kintsugi_ingest::pdf::PdfKitReader::new(helper)) as Arc<dyn kintsugi_ingest::pdf::PdfReader>);
    let pdf = kintsugi_ingest::pdf::PdfAdapter::new(reader)?
        .with_converter(Arc::new(kintsugi_ingest::pdf::Docling::new(tools.clone())));
    Ok(kintsugi_ingest::Engine::new()
        .with(kintsugi_ingest::x::XAdapter::new()?)
        .with(reddit)
        .with(youtube)
        .with(podcast)
        .with(pdf)
        .with(kintsugi_ingest::epub::EpubAdapter::new()?)
        .with(kintsugi_ingest::books::BookAdapter::new()?)
        .with(web))
}
