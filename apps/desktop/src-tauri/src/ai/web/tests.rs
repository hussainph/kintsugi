//! Mocked HTTP only: each provider's request and response mapping against a
//! local server, the fetch guard, and the settings store. No live calls.

use super::search::{self, Searcher};
use super::*;
use serde_json::json;
use std::sync::Mutex as StdMutex;

type Seen = Arc<StdMutex<Vec<(String, String, Value)>>>;

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

/// A provider stand-in: records each request's method, auth headers and
/// query or body, and answers `status` with `answer`.
async fn provider(status: u16, answer: Value) -> (String, Seen) {
    let seen: Seen = Arc::default();
    let log = seen.clone();
    let app = axum::Router::new().fallback(
        move |method: axum::http::Method,
              uri: axum::http::Uri,
              headers: axum::http::HeaderMap,
              body: axum::body::Bytes| {
            let (log, answer) = (log.clone(), answer.clone());
            async move {
                let auth = [
                    "x-api-key",
                    "x-subscription-token",
                    "authorization",
                    "accept",
                ]
                .iter()
                .filter_map(|h| Some(format!("{h}={}", headers.get(*h)?.to_str().ok()?)))
                .collect::<Vec<_>>()
                .join(" ");
                let body = if body.is_empty() {
                    json!(uri.query().unwrap_or_default())
                } else {
                    serde_json::from_slice(&body).unwrap()
                };
                log.lock()
                    .unwrap()
                    .push((format!("{method} {}", uri.path()), auth, body));
                (
                    axum::http::StatusCode::from_u16(status).unwrap(),
                    axum::Json(answer),
                )
            }
        },
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (base, seen)
}

#[test]
fn exa_maps_its_request_and_results() {
    let rt = runtime();
    rt.block_on(async {
        let (base, seen) = provider(
            200,
            json!({ "results": [
                { "title": "Kintsugi - Wikipedia", "url": "https://en.wikipedia.org/wiki/Kintsugi",
                  "publishedDate": "2024-05-01T00:00:00.000Z", "favicon": "https://en.wikipedia.org/favicon.ico",
                  "highlights": ["Kintsugi is the Japanese art", "of repairing broken pottery."] },
                { "title": "No link", "url": "javascript:alert(1)" },
                { "title": "Summary only", "url": "https://example.com/a", "summary": "A  short\nsummary." }
            ]}),
        )
        .await;
        let searcher = Searcher::at(Provider::Exa, "exa-key", format!("{base}/search"));
        let results = searcher.search("kintsugi pottery", 5).await.unwrap();
        let seen = seen.lock().unwrap();
        assert_eq!(seen[0].0, "POST /search");
        assert_eq!(seen[0].1, "x-api-key=exa-key accept=*/*");
        assert_eq!(
            seen[0].2,
            json!({ "query": "kintsugi pottery", "numResults": 5, "type": "auto",
                    "contents": { "highlights": { "maxCharacters": 600 } } })
        );
        assert_eq!(results.len(), 2, "the javascript: link is dropped");
        assert_eq!(
            results[0],
            Source {
                url: "https://en.wikipedia.org/wiki/Kintsugi".into(),
                title: "Kintsugi - Wikipedia".into(),
                snippet: Some("Kintsugi is the Japanese art … of repairing broken pottery.".into()),
                date: Some("2024-05-01".into()),
                favicon: Some("https://en.wikipedia.org/favicon.ico".into()),
            }
        );
        assert_eq!(results[1].snippet.as_deref(), Some("A short summary."));
        assert_eq!(results[1].date, None);
    });
}

#[test]
fn brave_maps_its_request_and_results() {
    let rt = runtime();
    rt.block_on(async {
        let (base, seen) = provider(
            200,
            json!({ "type": "search", "web": { "results": [
                { "title": "The art of <strong>kintsugi</strong>", "url": "https://www.example.com/kintsugi",
                  "description": "Golden <strong>repair</strong> &amp; the &quot;wabi-sabi&quot; idea",
                  "page_age": "2023-02-10T08:00:00", "age": "February 10, 2023",
                  "meta_url": { "hostname": "www.example.com", "favicon": "https://imgs.search.brave.com/fav.png" } },
                { "title": "Undated", "url": "https://example.org/b", "description": "x", "age": "2 days ago" }
            ]}}),
        )
        .await;
        let searcher = Searcher::at(Provider::Brave, "brave-key", format!("{base}/res/v1/web/search"));
        let results = searcher.search("kintsugi & gold", 3).await.unwrap();
        let seen = seen.lock().unwrap();
        assert_eq!(seen[0].0, "GET /res/v1/web/search");
        assert_eq!(seen[0].1, "x-subscription-token=brave-key accept=application/json");
        assert_eq!(seen[0].2, json!("q=kintsugi+%26+gold&count=3"));
        assert_eq!(
            results[0],
            Source {
                url: "https://www.example.com/kintsugi".into(),
                title: "The art of kintsugi".into(),
                snippet: Some("Golden repair & the \"wabi-sabi\" idea".into()),
                date: Some("2023-02-10".into()),
                favicon: Some("https://imgs.search.brave.com/fav.png".into()),
            }
        );
        assert_eq!(results[1].date.as_deref(), Some("2 days ago"));
    });
}

#[test]
fn tavily_maps_its_request_and_results() {
    let rt = runtime();
    rt.block_on(async {
        let (base, seen) = provider(
            200,
            json!({ "query": "q", "answer": null, "images": [], "response_time": 1.2, "results": [
                { "title": "Repair as philosophy", "url": "https://example.net/repair",
                  "content": "Kintsugi treats breakage as part of an object's history.", "score": 0.9,
                  "published_date": "Tue, 11 Mar 2025 17:00:00 GMT", "favicon": "https://example.net/favicon.png" },
                { "title": "Plain", "url": "http://example.net/plain", "content": "", "favicon": "http://insecure/fav.ico" }
            ]}),
        )
        .await;
        let searcher = Searcher::at(Provider::Tavily, "tvly-key", format!("{base}/search"));
        let results = searcher.search("repair", 30).await.unwrap();
        let seen = seen.lock().unwrap();
        assert_eq!(seen[0].0, "POST /search");
        assert_eq!(seen[0].1, "authorization=Bearer tvly-key accept=*/*");
        assert_eq!(
            seen[0].2,
            json!({ "query": "repair", "max_results": 30, "search_depth": "basic",
                    "include_favicon": true, "include_published_date": true })
        );
        assert_eq!(results[0].date.as_deref(), Some("2025-03-11"));
        assert_eq!(
            results[0].snippet.as_deref(),
            Some("Kintsugi treats breakage as part of an object's history.")
        );
        assert_eq!(results[1].snippet, None);
        assert_eq!(results[1].favicon, None, "only https favicons are shown");
    });
}

#[test]
fn provider_errors_are_plain_and_never_echo_the_key() {
    let rt = runtime();
    rt.block_on(async {
        for (status, says) in [
            (401, "refused the API key"),
            (402, "out of credits"),
            (432, "out of credits"),
            (429, "rate limiting"),
            (500, "HTTP 500"),
        ] {
            let (base, _) = provider(status, json!({ "error": "secret-key-123 is bad" })).await;
            let searcher =
                Searcher::at(Provider::Tavily, "secret-key-123", format!("{base}/search"));
            let error = searcher.search("q", 3).await.unwrap_err();
            assert!(error.contains(says), "{status}: {error}");
            assert!(error.starts_with("Tavily"), "{error}");
            assert!(
                !error.contains("secret-key-123") && !error.contains("127.0.0.1"),
                "{error}"
            );
        }
        let (base, _) = provider(200, json!("not results")).await;
        let none = Searcher::at(Provider::Exa, "k", format!("{base}/search"))
            .search("q", 3)
            .await
            .unwrap();
        assert!(none.is_empty());
    });
}

#[test]
fn snippets_and_dates_are_cleaned() {
    assert_eq!(
        search::clean("a <b>bold</b>\n\n  move &lt;3", 100),
        "a bold move <3"
    );
    assert_eq!(search::clean(&"word ".repeat(100), 12), "word word wo…");
    assert_eq!(search::day("2024-01-02T03:04:05Z"), "2024-01-02");
    assert_eq!(search::day("Tue, 11 Mar 2025 17:00:00 GMT"), "2025-03-11");
    assert_eq!(search::day("3 hours ago"), "3 hours ago");
}

// --- web_search and web_fetch -------------------------------------------------

#[test]
fn without_a_key_web_search_says_how_to_set_one_up() {
    let rt = runtime();
    let web = Web::for_tests(None, vec![]);
    let error = rt
        .block_on(web.search(&json!({ "query": "kintsugi" })))
        .err()
        .unwrap();
    assert!(
        error.contains("Settings › Web") && error.contains("web_fetch still works"),
        "{error}"
    );
}

#[test]
fn web_search_returns_compact_json_and_the_chat_call() {
    let rt = runtime();
    let web = Web::scripted();
    let answer = rt
        .block_on(web.search(&json!({ "query": "golden joinery", "count": 2 })))
        .unwrap();
    let hits: Vec<Value> = serde_json::from_str(&answer.text).unwrap();
    assert_eq!(hits.len(), 2);
    assert_eq!(
        hits[0].as_object().unwrap().keys().collect::<Vec<_>>(),
        ["date", "snippet", "title", "url"]
    );
    assert_eq!(answer.call.tool, "search");
    assert_eq!(answer.call.query.as_deref(), Some("golden joinery"));
    assert_eq!(answer.call.provider.as_deref(), Some("mock"));
    assert_eq!(
        answer.call.results[0].url,
        "https://en.wikipedia.org/wiki/golden-joinery"
    );
    assert!(rt.block_on(web.search(&json!({ "query": " " }))).is_err());
}

#[test]
fn web_fetch_refuses_private_addresses_and_other_schemes() {
    let rt = runtime();
    let web = Web::for_tests(None, vec![]);
    for url in [
        "http://127.0.0.1:1423/",
        "http://localhost:1422/#token=x",
        "http://169.254.169.254/latest/meta-data/",
        "http://192.168.1.1/",
        "http://[::1]/",
        "http://nas/",
        "file:///etc/passwd",
        "ftp://example.com/x",
        "not a url",
    ] {
        let error = rt
            .block_on(web.fetch(&json!({ "url": url })))
            .err()
            .unwrap();
        assert!(
            error.contains("public http(s) pages only"),
            "{url}: {error}"
        );
    }
}

/// A page server for fetch tests, reached as `public.test` (pinned to it).
async fn pages(body: String) -> (std::net::SocketAddr, Arc<StdMutex<usize>>) {
    let hits = Arc::new(StdMutex::new(0));
    let count = hits.clone();
    let app = axum::Router::new()
        .route(
            "/essay",
            axum::routing::get(move || {
                let (count, body) = (count.clone(), body.clone());
                async move {
                    *count.lock().unwrap() += 1;
                    (
                        [(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")],
                        body,
                    )
                }
            }),
        )
        .route(
            "/leak",
            axum::routing::get(|| async {
                (
                    axum::http::StatusCode::FOUND,
                    [(axum::http::header::LOCATION, "http://127.0.0.1:9/secret")],
                )
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (addr, hits)
}

#[test]
fn web_fetch_reads_a_page_as_markdown_and_pages_through_it() {
    let rt = runtime();
    rt.block_on(async {
        let paragraph = "Kintsugi repairs broken pottery with lacquer and gold. ".repeat(40);
        let body = format!(
            "<html><head><title>On repair</title><meta property=\"og:site_name\" content=\"Public Test\"></head>\
             <body><article><h1>On repair</h1>{}</article></body></html>",
            (0..12).map(|_| format!("<p>{paragraph}</p>")).collect::<String>()
        );
        let (addr, hits) = pages(body).await;
        let web = Web::for_tests(None, vec![("public.test".into(), addr)]);
        let url = format!("http://public.test:{}/essay", addr.port());
        let first = web.fetch(&json!({ "url": url })).await.unwrap();
        assert!(first.text.starts_with("# On repair\nURL: "), "{}", &first.text[..200]);
        assert!(first.text.contains("Public Test"));
        assert!(first.text.contains("Kintsugi repairs broken pottery"));
        let more = first.text.rsplit("call web_fetch with start ").next().unwrap();
        let start: usize = more.trim_end_matches(')').parse().unwrap();
        assert_eq!(start, PAGE_CHARS);
        assert_eq!(first.call.tool, "fetch");
        assert_eq!(first.call.results[0].title, "On repair");
        let second = web.fetch(&json!({ "url": url, "start": start })).await.unwrap();
        assert!(second.text.contains(&format!("(characters {start}-")), "{}", &second.text[..300]);
        assert_eq!(*hits.lock().unwrap(), 1, "the second page came from the turn's cache");

        let leak = format!("http://public.test:{}/leak", addr.port());
        assert!(web.fetch(&json!({ "url": leak })).await.is_err(), "redirects are re-checked");
    });
}

// --- Settings -----------------------------------------------------------------

#[test]
fn keys_are_saved_owner_only_and_never_shown() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(Some(dir.path().into())).with_env(|_| None);
    assert_eq!(store.view().active, None);
    assert!(
        store.tools().unwrap().search.is_none(),
        "no key: no search, fetch still on"
    );

    let view = store
        .set_key(Provider::Brave, Some("  brave-secret  ".into()))
        .unwrap();
    assert_eq!(
        view.provider,
        Some(Provider::Brave),
        "the first key picks the provider"
    );
    assert_eq!(view.active, Some(Provider::Brave));
    let shown = serde_json::to_string(&view).unwrap();
    assert!(!shown.contains("brave-secret"), "{shown}");
    assert_eq!(view.providers[1].key, Some(KeySource::Settings));

    let path = dir.path().join(FILE);
    let mode = fs::metadata(&path).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o600);
    assert!(
        fs::read_to_string(&path)
            .unwrap()
            .contains("\"brave\": \"brave-secret\"")
    );

    // A pick without a key falls back to one that has a key.
    let view = store.set_provider(Some(Provider::Exa)).unwrap();
    assert_eq!(
        (view.provider, view.active),
        (Some(Provider::Exa), Some(Provider::Brave))
    );
    assert_eq!(
        store.tools().unwrap().search.as_ref().unwrap().id(),
        "brave"
    );

    // Reopened from disk, the same.
    let again = Store::open(Some(dir.path().into())).with_env(|_| None);
    assert_eq!(again.view(), store.view());

    assert!(
        store
            .set_key(Provider::Exa, Some("two words".into()))
            .is_err()
    );
    let view = store.set_key(Provider::Brave, None).unwrap();
    assert_eq!(view.active, None);
    assert!(!fs::read_to_string(&path).unwrap().contains("brave-secret"));

    let view = store.set_enabled(false).unwrap();
    assert!(!view.enabled);
    assert!(store.tools().is_none(), "off: no web tools at all");
}

#[test]
fn environment_keys_are_used_when_none_is_saved() {
    let store =
        Store::open(None).with_env(|name| (name == "TAVILY_API_KEY").then(|| "tvly-env".into()));
    let view = store.view();
    assert_eq!(view.active, Some(Provider::Tavily));
    assert_eq!(view.providers[2].key, Some(KeySource::Environment));
    assert_eq!(view.providers[0].key, None);
    let view = store
        .set_key(Provider::Tavily, Some("tvly-saved".into()))
        .unwrap();
    assert_eq!(view.providers[2].key, Some(KeySource::Settings));
}
