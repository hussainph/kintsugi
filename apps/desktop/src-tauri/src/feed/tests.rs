//! Polling through the ingest engine against a local fixture server: never
//! the live network.

use super::*;
use axum::{Router, http::{HeaderMap, StatusCode, header}, response::IntoResponse, routing::get};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

fn engine() -> Engine {
    Engine::new().with(FeedAdapter::new().unwrap()).with(WebAdapter::new().unwrap())
}

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../crates/ingest/fixtures/feed");

fn fixture(name: &str) -> String {
    std::fs::read_to_string(format!("{FIXTURES}/{name}")).unwrap()
}

async fn serve(hits: Arc<AtomicUsize>) -> String {
    let feed = move |headers: HeaderMap| {
        let hits = hits.clone();
        async move {
            hits.fetch_add(1, Ordering::SeqCst);
            if headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()) == Some("\"v1\"") {
                return StatusCode::NOT_MODIFIED.into_response();
            }
            ([(header::ETAG, "\"v1\""), (header::CONTENT_TYPE, "application/rss+xml")], fixture("blog.rss.xml")).into_response()
        }
    };
    let app = Router::new()
        .route("/feed.xml", get(feed))
        .route("/blog", get(|| async { ([(header::CONTENT_TYPE, "text/html")], fixture("blog.html")) }))
        .route("/broken", get(|| async { StatusCode::SERVICE_UNAVAILABLE }))
        .route("/html", get(|| async { "<html><body>No feeds here</body></html>" }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    base
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
}

#[test]
fn polls_with_conditional_requests_and_records_health() {
    runtime().block_on(async {
        let hits = Arc::new(AtomicUsize::new(0));
        let base = serve(hits.clone()).await;
        let store = Mutex::new(Store::memory());
        let engine = engine();
        let url = format!("{base}/feed.xml");
        let (source, _) = store.lock().unwrap().add_source(&url, SourceKind::Feed, None, now()).unwrap();

        let due = store.lock().unwrap().due_one(source.id).unwrap();
        let first = poll(&store, &engine, &due).await;
        assert_eq!((first.added, first.error), (3, None));
        let healthy = store.lock().unwrap().source(source.id).unwrap();
        assert_eq!(healthy.title.as_deref(), Some("The Quiet Blog"));
        assert_eq!((healthy.last_status, healthy.last_error), (None, None));
        assert!(healthy.next_fetch_at > now());

        // The ETag comes back as If-None-Match; a 304 adds nothing and is healthy.
        let due = store.lock().unwrap().due_one(source.id).unwrap();
        let second = poll(&store, &engine, &due).await;
        assert_eq!((second.added, second.error), (0, None));
        assert_eq!(store.lock().unwrap().source(source.id).unwrap().failures, 0);
        assert_eq!(hits.load(Ordering::SeqCst), 2);
        assert_eq!(store.lock().unwrap().items(0, 10, None).unwrap().total, 3);
    });
}

#[test]
fn failures_back_off_and_keep_the_source() {
    runtime().block_on(async {
        let base = serve(Arc::default()).await;
        let store = Mutex::new(Store::memory());
        let engine = engine();
        for (path, kind, status) in [("/broken", SourceKind::Youtube, Some(503)), ("/html", SourceKind::Feed, None)] {
            let (source, _) = store.lock().unwrap().add_source(&format!("{base}{path}"), kind, None, now()).unwrap();
            let due = store.lock().unwrap().due_one(source.id).unwrap();
            let polled = poll(&store, &engine, &due).await;
            assert!(polled.error.is_some());
            let failed = store.lock().unwrap().source(source.id).unwrap();
            assert_eq!(failed.failures, 1);
            assert_eq!(failed.last_status, status);
            assert!(failed.next_fetch_at >= now() + 299);
            if kind == SourceKind::Youtube {
                assert!(failed.last_error.unwrap().contains("keeps trying"));
            }
        }
        assert_eq!(store.lock().unwrap().sources().unwrap().len(), 2);
    });
}

#[test]
fn a_page_url_finds_its_feed() {
    runtime().block_on(async {
        let base = serve(Arc::default()).await;
        let feeds = FeedAdapter::new().unwrap();
        assert_eq!(find_feed(&feeds, &format!("{base}/blog")).await.unwrap(), format!("{base}/feed.xml"));
        assert_eq!(find_feed(&feeds, &format!("{base}/feed.xml")).await.unwrap(), format!("{base}/feed.xml"));
        assert!(find_feed(&feeds, &format!("{base}/html")).await.is_err());
        // Down right now is followed anyway; polling retries it.
        assert_eq!(find_feed(&feeds, &format!("{base}/broken")).await.unwrap(), format!("{base}/broken"));
    });
}

#[test]
fn backoff_grows_and_youtube_stays_close() {
    assert_eq!(retry_after(SourceKind::Feed, 1), 300);
    assert_eq!(retry_after(SourceKind::Feed, 2), 600);
    assert_eq!(retry_after(SourceKind::Feed, 30), 24 * 60 * 60);
    assert_eq!(retry_after(SourceKind::Youtube, 30), 60 * 60);
    assert!(describe(SourceKind::Youtube, ingest::Error::Status(404)).contains("keeps trying"));
    assert_eq!(describe(SourceKind::Feed, ingest::Error::Status(503)), "HTTP 503");
}
