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

#[test]
fn x_accounts_poll_through_the_x_adapter() {
    runtime().block_on(async {
        let profile = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../crates/ingest/fixtures/x/fx-profile.json")).unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let counted = hits.clone();
        let app = Router::new().route(
            "/2/profile/simonw/statuses",
            get(move || {
                counted.fetch_add(1, Ordering::SeqCst);
                let profile = profile.clone();
                async move { ([(header::CONTENT_TYPE, "application/json")], profile) }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = kintsugi_ingest::Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let endpoints = kintsugi_ingest::x::XEndpoints { fxtwitter: base.clone(), syndication: base.clone(), oembed: base };
        let x = XAdapter::with_endpoints(endpoints, kintsugi_ingest::api::ApiLimits::default()).unwrap();
        let engine = Engine::new().with(x).with(FeedAdapter::new().unwrap());

        let store = Mutex::new(Store::memory());
        let (url, kind, _) = resolve(&FeedAdapter::new().unwrap(), Subscribe::Url { url: "x.com/SimonW".into() }).await.unwrap();
        assert_eq!((url.as_str(), kind), ("https://x.com/simonw", SourceKind::X));
        let (source, _) = store.lock().unwrap().add_source(&url, kind, None, now()).unwrap();
        let due = store.lock().unwrap().due_one(source.id).unwrap();
        let first = poll(&store, &engine, &due).await;
        assert_eq!(first.error, None);
        assert!(first.added > 0);
        let followed = store.lock().unwrap().source(source.id).unwrap();
        assert_eq!(followed.title.as_deref(), Some("Simon Willison (@simonw)"));
        assert!(followed.next_fetch_at - now() <= 60 * 60);

        // The cursor is the newest post: polling again adds nothing.
        let due = store.lock().unwrap().due_one(source.id).unwrap();
        assert_eq!(due.cursor.as_deref(), Some("2115858560823538152"));
        let again = poll(&store, &engine, &due).await;
        assert_eq!((again.added, again.error), (0, None));
        assert_eq!(hits.load(Ordering::SeqCst), 2);
        let page = store.lock().unwrap().items(0, 40, None).unwrap();
        assert_eq!(page.total as usize, first.added);
    });
}

#[test]
fn x_failures_retry_within_the_hour() {
    assert_eq!(retry_after(SourceKind::X, 30), 60 * 60);
    assert!(describe(SourceKind::X, ingest::Error::RateLimited).contains("try again"));
}

const WATCH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../crates/ingest/fixtures/watch");

#[test]
fn watched_pages_post_their_changes() {
    runtime().block_on(async {
        // Version 1, then the same page with new dates and counters, then a 304
        // for the ETag it sent, then a real edit.
        let version = Arc::new(AtomicUsize::new(0));
        let conditional = Arc::new(AtomicUsize::new(0));
        let (v, c) = (version.clone(), conditional.clone());
        let app = Router::new().route(
            "/now",
            get(move |headers: HeaderMap| {
                let (v, c) = (v.clone(), c.clone());
                async move {
                    let n = v.load(Ordering::SeqCst);
                    let tag = format!("\"v{n}\"");
                    if headers.get(header::IF_NONE_MATCH).and_then(|h| h.to_str().ok()) == Some(tag.as_str()) {
                        c.fetch_add(1, Ordering::SeqCst);
                        return StatusCode::NOT_MODIFIED.into_response();
                    }
                    let file = ["now-v1.html", "now-v1-noise.html", "now-v2.html"][n.min(2)];
                    let html = std::fs::read_to_string(format!("{WATCH}/{file}")).unwrap();
                    ([(header::ETAG, tag), (header::CONTENT_TYPE, "text/html".into())], html).into_response()
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let store = Mutex::new(Store::memory());
        let engine = engine();
        let (url, kind, _) = resolve(&FeedAdapter::new().unwrap(), Subscribe::Page { url: format!("{base}/now") }).await.unwrap();
        assert_eq!(kind, SourceKind::Page);
        let (source, _) = store.lock().unwrap().add_source(&url, kind, None, now()).unwrap();
        let poll_once = || async {
            let due = store.lock().unwrap().due_one(source.id).unwrap();
            poll(&store, &engine, &due).await
        };

        let baseline = poll_once().await;
        assert_eq!((baseline.added, baseline.error.as_deref()), (0, None), "following records a baseline");
        let followed = store.lock().unwrap().source(source.id).unwrap();
        assert_eq!(followed.title.as_deref(), Some("What I'm doing now"));
        assert!(followed.next_fetch_at - now() > 5 * 60 * 60, "pages poll every few hours");

        version.store(1, Ordering::SeqCst);
        assert_eq!(poll_once().await.added, 0, "new dates and counters aren't a change");
        assert_eq!(poll_once().await.added, 0);
        assert_eq!(conditional.load(Ordering::SeqCst), 1, "the ETag came back as If-None-Match");

        version.store(2, Ordering::SeqCst);
        let changed = poll_once().await;
        assert_eq!((changed.added, changed.error), (1, None));
        let page = store.lock().unwrap().items(0, 10, None).unwrap();
        let item = &page.items[0];
        assert_eq!(item.title.as_deref(), Some("The Left Hand of Darkness"));
        assert_eq!(item.summary.as_deref(), Some("2 lines added and 1 removed on What I'm doing now"));
        assert_eq!(item.url.as_deref(), Some(url.as_str()));
        assert_eq!(item.source_kind, SourceKind::Page);
        let content = store.lock().unwrap().content(item.id).unwrap().unwrap();
        assert!(content.contains("**Removed**\n\n- The Dispossessed"), "{content}");
    });
}

#[test]
fn authors_bring_their_new_books() {
    runtime().block_on(async {
        let google = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../crates/ingest/fixtures/authors/google-clarke.json")).unwrap();
        let app = Router::new().route("/books/v1/volumes", get(move || {
            let google = google.clone();
            async move { ([(header::CONTENT_TYPE, "application/json")], google) }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = kintsugi_ingest::Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let books = AuthorAdapter::with_endpoints(kintsugi_ingest::authors::AuthorEndpoints::at(base), kintsugi_ingest::api::ApiLimits::default()).unwrap();
        let engine = Engine::new().with(FeedAdapter::new().unwrap()).with(books);

        let store = Mutex::new(Store::memory());
        let (url, kind, title) = resolve(&FeedAdapter::new().unwrap(), Subscribe::Author { name: " Susanna Clarke ".into() }).await.unwrap();
        assert_eq!((kind, title.as_deref()), (SourceKind::Author, Some("Susanna Clarke")));
        let (source, _) = store.lock().unwrap().add_source(&url, kind, title.as_deref(), now()).unwrap();
        let due = store.lock().unwrap().due_one(source.id).unwrap();
        let first = poll(&store, &engine, &due).await;
        assert_eq!(first.error, None);
        let page = store.lock().unwrap().items(0, 10, None).unwrap();
        let titles: Vec<_> = page.items.iter().map(|i| i.title.clone().unwrap()).collect();
        // The latest three show on following, even though they're old.
        assert_eq!(titles, ["The Lost Garden: A Novel", "The Wood at Midwinter", "Piranesi"]);
        assert!(page.items.iter().all(|i| i.media == "book" && i.source_kind == SourceKind::Author));
        let followed = store.lock().unwrap().source(source.id).unwrap();
        assert!(followed.next_fetch_at - now() > 6 * 24 * 60 * 60, "authors poll weekly");

        let due = store.lock().unwrap().due_one(source.id).unwrap();
        assert_eq!(poll(&store, &engine, &due).await.added, 0);
    });
    assert!(describe(SourceKind::Author, ingest::Error::Unavailable).contains("Open Library"));
}
