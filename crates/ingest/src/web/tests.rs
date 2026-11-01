//! Saved-page fixtures and a loopback server only; nothing here touches the
//! internet (the live check is `#[ignore]`d).

use super::*;
use crate::Engine;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::Mutex;

fn url(s: &str) -> Url {
    web_url(s).unwrap()
}

fn run<T>(f: impl std::future::Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(f)
}

#[test]
fn open_graph_wins_and_readable_markdown_omits_page_chrome() {
    let page = extract::page(include_str!("../../fixtures/article.html"), &url("https://example.org/stories/sleep"));
    assert_eq!(page.title.as_deref(), Some("Sleep & attention"));
    assert_eq!(page.author.as_deref(), Some("Jane Doe"));
    assert_eq!(page.site.as_deref(), Some("The Journal"));
    assert_eq!(page.description.as_deref(), Some("Why rest matters."));
    assert_eq!(page.image_url.unwrap().as_str(), "https://example.org/images/sleep.jpg");
    assert!(page.body.contains("A quiet *mind* needs rest."), "{}", page.body);
    assert!(page.body.contains("A second paragraph & a little perspective."));
    for unwanted in ["Menu", "Related", "TRACKING", "Secret", "Subscribe"] {
        assert!(!page.body.contains(unwanted), "{unwanted} in {}", page.body);
    }
}

#[test]
fn a_real_article_becomes_structured_markdown_without_the_site_around_it() {
    let page = extract::page(
        include_str!("../../fixtures/blog.html"),
        &url("https://notes.example.org/2026/slow-software?utm_source=rss"),
    );
    assert_eq!(page.extractor, "readability");
    assert_eq!(page.title.as_deref(), Some("On slow software"));
    assert_eq!(page.site.as_deref(), Some("Field Notes"));
    assert_eq!(page.author.as_deref(), Some("Ada Byron"));
    assert_eq!(page.published.as_deref(), Some("2026-09-14T08:30:00Z"));
    assert_eq!(page.lang.as_deref(), Some("en"));
    assert_eq!(page.canonical.unwrap().as_str(), "https://notes.example.org/2026/slow-software");
    let body = &page.body;
    assert!(body.contains("## What waiting looks like"), "{body}");
    assert!(body.contains("[link one idea to another](https://notes.example.org/2026/plain-files)"), "{body}");
    assert!(body.contains("- It never interrupts a sentence."), "{body}");
    assert!(body.contains("> The best tool for thinking"), "{body}");
    assert!(body.contains("const pause = () => think();"), "{body}");
    for unwanted in ["Popular posts", "Archive", "crypto newsletter", "All rights reserved", "analytics"] {
        assert!(!body.contains(unwanted), "{unwanted} in {body}");
    }
}

#[test]
fn twitter_metadata_and_the_title_tag_are_fallbacks() {
    let base = url("https://example.org/");
    let page = extract::page(include_str!("../../fixtures/twitter.html"), &base);
    assert_eq!(page.title.as_deref(), Some("A small thought"));
    assert_eq!(page.author.as_deref(), Some("@writer"));
    assert_eq!(page.image_url.unwrap().as_str(), "https://example.org/card.png");
    assert!(page.body.contains("A small thought worth keeping."), "{}", page.body);
    assert_eq!(extract::page("<title>Just &amp; a title</title>", &base).title.as_deref(), Some("Just & a title"));
}

#[test]
fn a_declared_canonical_on_another_host_is_ignored() {
    let html = r#"<link rel="canonical" href="https://victim.example/story"><p>Hi</p>"#;
    assert!(extract::page(html, &url("https://attacker.example/a")).canonical.is_none());
    let html = r#"<meta property="og:url" content="/story"><p>Hi</p>"#;
    assert_eq!(extract::page(html, &url("https://e.org/a#x")).canonical.unwrap().as_str(), "https://e.org/story");
}

#[test]
fn canonical_ids_drop_fragments_and_tracking_parameters() {
    assert_eq!(canonical_url(&url("https://e.org/a?utm_source=x&id=2&fbclid=1#top")).as_str(), "https://e.org/a?id=2");
    assert_eq!(canonical_url(&url("https://e.org/a?utm_medium=x")).as_str(), "https://e.org/a");
}

#[test]
fn bodies_are_bounded_on_unicode_boundaries() {
    let html = format!("<article><p>{}</p></article>", "界".repeat(30_000));
    let page = extract::page(&html, &url("https://example.org/"));
    let n = page.body.chars().count();
    assert!(n <= crate::BODY_CHARS && n > 19_900, "{n}");
}

#[test]
fn deeply_nested_markup_does_not_exhaust_the_stack() {
    let html = format!("<article><p>Readable.</p>{}Deep{}</article>", "<div>".repeat(2000), "</div>".repeat(2000));
    let page = extract::page(&html, &url("https://example.org/"));
    assert!(page.body.contains("Readable."), "{}", page.body);
}

#[test]
fn embed_metadata_fills_gaps_without_overwriting_page_metadata() {
    let target = url("https://x.com/writer/status/1");
    let mut draft = Draft::new(target.clone());
    draft.apply(extract::page("<meta property='og:title' content='Original'><body>Log in to continue</body>", &target));
    let embed = serde_json::from_str(include_str!("../../fixtures/oembed.json")).unwrap();
    oembed::merge(&mut draft, embed);
    assert_eq!(draft.title.as_deref(), Some("Original"));
    assert_eq!(draft.author.as_deref(), Some("Writer"));
    assert_eq!(draft.extractor, "oembed");
    assert!(draft.body.contains("A thought worth keeping."));
    assert!(!draft.body.contains("evil"));
    assert!(!draft.body.contains("Log in"));
}

#[test]
fn only_exact_platform_hosts_get_embed_requests() {
    for host in ["youtube.com", "youtu.be", "x.com", "bsky.app", "tiktok.com", "vimeo.com"] {
        let endpoint = oembed::endpoint(&url(&format!("https://{host}/watch?v=1&list=2"))).unwrap();
        assert_eq!(
            endpoint.query_pairs().find(|(k, _)| k == "url").unwrap().1,
            format!("https://{host}/watch?v=1&list=2")
        );
    }
    assert!(oembed::endpoint(&url("https://youtube.com.evil.test/")).is_none());
    for raw in ["file:///etc/passwd", "data:text/html,hi", "ftp://example.org", "https://secret@example.org"] {
        assert_eq!(web_url(raw), Err(Error::InvalidUrl));
        assert!(Target::url(raw).is_err());
    }
}

#[test]
fn the_web_adapter_matches_only_web_urls() {
    let adapter = WebAdapter::new().unwrap();
    assert!(adapter.matches(&Target::url("https://example.org/").unwrap()));
    assert!(!adapter.matches(&Target::File("/tmp/a.html".into())));
    assert!(!adapter.matches(&Target::Url(Url::parse("file:///tmp/a.html").unwrap())));
}

// --- Loopback server ---------------------------------------------------------

type Route = (&'static str, &'static str, Vec<u8>);

/// Serves one response per route, in order, asserting each request path.
fn serve(routes: Vec<Route>) -> (String, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let thread = std::thread::spawn(move || {
        for (target, head, body) in routes {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 4096];
            let n = stream.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..n]);
            assert!(request.starts_with(&format!("GET {target} ")), "{request}");
            assert!(request.to_ascii_lowercase().contains("user-agent: mozilla/5.0"));
            let _ = write!(stream, "{head}Content-Length: {}\r\nConnection: close\r\n\r\n", body.len());
            let _ = stream.write_all(&body);
        }
    });
    (base, thread)
}

fn ok(mime: &str) -> &'static str {
    match mime {
        "html" => "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n",
        "png" => "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\n",
        _ => unreachable!(),
    }
}

fn capture(adapter: &WebAdapter, raw: &str, want_media: bool) -> Result<Item> {
    run(adapter.capture(&Target::url(raw).unwrap(), CaptureOptions { want_media }))
}

#[test]
fn a_capture_normalizes_the_page_and_downloads_its_hero_image() {
    let (base, thread) = serve(vec![
        ("/story?utm_source=feed", ok("html"), include_bytes!("../../fixtures/article.html").to_vec()),
        ("/images/sleep.jpg", ok("png"), b"\x89PNG\r\n\x1a\nimage".to_vec()),
    ]);
    let engine = Engine::new().with(WebAdapter::new().unwrap());
    let target = Target::url(&format!("{base}/story?utm_source=feed")).unwrap();
    let item = run(engine.capture(&target, CaptureOptions { want_media: true })).unwrap();
    thread.join().unwrap();
    assert_eq!(item.source, SourceType::Web);
    assert_eq!(item.url.as_deref(), Some(format!("{base}/story").as_str()));
    assert_eq!(item.id, format!("web:{base}/story"));
    assert_eq!(item.title.as_deref(), Some("Sleep & attention"));
    assert!(item.body.contains("A quiet *mind* needs rest."));
    // A page this short reads best from its explicit <article>.
    assert_eq!(item.extras["extractor"], "html");
    let image = item.primary_image().unwrap();
    assert_eq!(image.mime, "image/png");
    assert_eq!(image.bytes, b"\x89PNG\r\n\x1a\nimage");
    assert_eq!(item.media[0].url.as_deref(), Some(format!("{base}/images/sleep.jpg").as_str()));
}

#[test]
fn media_is_not_downloaded_unless_asked() {
    let (base, thread) = serve(vec![("/", ok("html"), include_bytes!("../../fixtures/article.html").to_vec())]);
    let item = capture(&WebAdapter::new().unwrap(), &format!("{base}/"), false).unwrap();
    thread.join().unwrap();
    assert!(item.primary_image().is_none());
    assert!(item.media[0].url.is_some());
}

#[test]
fn downloads_enforce_declared_and_streamed_size_limits() {
    let adapter = WebAdapter::new().unwrap();
    for headers in ["Content-Length: 1000\r\n", ""] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let target = url(&format!("http://{}/", listener.local_addr().unwrap()));
        let response = format!("HTTP/1.1 200 OK\r\n{headers}Connection: close\r\n\r\n{}", "x".repeat(100));
        let thread = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = stream.read(&mut [0; 2048]);
            let _ = stream.write_all(response.as_bytes());
        });
        assert_eq!(run(adapter.get(target, 50)).err(), Some(Error::TooLarge));
        thread.join().unwrap();
    }
}

#[test]
fn redirects_cannot_escape_http_and_errors_do_not_echo_urls() {
    let (base, thread) = serve(vec![("/", "HTTP/1.1 302 Found\r\nLocation: file:///etc/passwd\r\n", vec![])]);
    let error = capture(&WebAdapter::new().unwrap(), &format!("{base}/"), false).unwrap_err();
    thread.join().unwrap();
    // Reqwest may return the refused 302 rather than an error; either way
    // the file is never read and the stored error is a fixed string.
    assert_eq!(error, Error::Unavailable);
    assert!(!error.to_string().contains("passwd"));
}

#[test]
fn directly_shared_images_use_the_image_cap_not_the_html_cap() {
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
    bytes.resize(Limits::default().html_bytes + 100, 0);
    let (base, thread) = serve(vec![("/", ok("png"), bytes.clone())]);
    let item = capture(&WebAdapter::new().unwrap(), &format!("{base}/"), true).unwrap();
    thread.join().unwrap();
    assert_eq!(item.primary_image().unwrap().bytes, bytes);
    assert!(item.body.is_empty());
    assert_eq!(item.extras["extractor"], "image");
}

#[test]
fn an_exhausted_deadline_keeps_the_collected_page() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let thread = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let _ = stream.read(&mut [0; 4096]);
        let body = include_bytes!("../../fixtures/article.html");
        let _ = write!(stream, "{}Content-Length: {}\r\nConnection: close\r\n\r\n", ok("html"), body.len());
        let _ = stream.write_all(body);
        // The image request is accepted and never answered.
        let (stalled, _) = listener.accept().unwrap();
        std::thread::sleep(Duration::from_millis(1500));
        drop(stalled);
    });
    let adapter =
        WebAdapter::with_limits(Limits { deadline: Duration::from_millis(700), ..Limits::default() }).unwrap();
    let item = capture(&adapter, &format!("{base}/"), true).unwrap();
    thread.join().unwrap();
    assert_eq!(item.title.as_deref(), Some("Sleep & attention"));
    assert!(item.primary_image().is_none());
}

// --- JavaScript fallback -----------------------------------------------------

#[derive(Default)]
struct FakeRenderer {
    calls: Mutex<Vec<String>>,
}

impl Renderer for FakeRenderer {
    fn render<'a>(&'a self, url: &'a Url, timeout: Duration) -> BoxFuture<'a, Result<Rendered>> {
        Box::pin(async move {
            assert!(timeout <= Limits::default().render_timeout);
            self.calls.lock().unwrap().push(url.path().to_string());
            Rendered::parse(include_str!("../../fixtures/spa.rendered.json")).ok_or(Error::Unavailable)
        })
    }
}

#[test]
fn a_javascript_shell_falls_back_to_the_rendered_page() {
    let (base, thread) = serve(vec![
        ("/app", ok("html"), include_bytes!("../../fixtures/spa.html").to_vec()),
        ("/hero.png", ok("png"), b"\x89PNG\r\n\x1a\nhero".to_vec()),
    ]);
    let renderer = Arc::new(FakeRenderer::default());
    let adapter = WebAdapter::new().unwrap().with_renderer(renderer.clone());
    let item = capture(&adapter, &format!("{base}/app"), true).unwrap();
    thread.join().unwrap();
    assert_eq!(*renderer.calls.lock().unwrap(), ["/app"]);
    assert_eq!(item.extras["extractor"], "defuddle");
    // The page's own <title> is still the declared one; gaps come from the render.
    assert_eq!(item.title.as_deref(), Some("Loading…"));
    assert_eq!(item.author.as_deref(), Some("Grace Hopper"));
    assert_eq!(item.published.as_deref(), Some("2026-10-01"));
    assert!(item.body.starts_with("## A page built in the browser"));
    assert!(item.body.contains("- Rendered locally"));
    assert_eq!(item.primary_image().unwrap().bytes, b"\x89PNG\r\n\x1a\nhero");
}

#[test]
fn a_bot_wall_status_also_tries_the_renderer() {
    let (base, thread) =
        serve(vec![("/", "HTTP/1.1 403 Forbidden\r\nContent-Type: text/html\r\n", b"no bots".to_vec())]);
    let renderer = Arc::new(FakeRenderer::default());
    let adapter = WebAdapter::new().unwrap().with_renderer(renderer.clone());
    let item = capture(&adapter, &format!("{base}/"), false).unwrap();
    thread.join().unwrap();
    assert_eq!(renderer.calls.lock().unwrap().len(), 1);
    assert_eq!(item.title.as_deref(), Some("A page built in the browser"));
    // Without a renderer the same page is simply unavailable.
    let (base, thread) =
        serve(vec![("/", "HTTP/1.1 403 Forbidden\r\nContent-Type: text/html\r\n", b"no bots".to_vec())]);
    assert_eq!(capture(&WebAdapter::new().unwrap(), &format!("{base}/"), false), Err(Error::Unavailable));
    thread.join().unwrap();
}

#[test]
fn readable_pages_embeds_and_images_never_render() {
    let (base, thread) = serve(vec![("/", ok("html"), include_bytes!("../../fixtures/blog.html").to_vec())]);
    let renderer = Arc::new(FakeRenderer::default());
    let adapter = WebAdapter::new().unwrap().with_renderer(renderer.clone());
    let item = capture(&adapter, &format!("{base}/"), false).unwrap();
    thread.join().unwrap();
    assert!(renderer.calls.lock().unwrap().is_empty());
    assert_eq!(item.extras["extractor"], "readability");
    // Its canonical names another host, so the fetched URL names the item.
    assert_eq!(item.id, format!("web:{base}/"));

    let mut video = Draft::new(url("https://www.youtube.com/watch?v=1"));
    video.html = true;
    video.oembed_host = true;
    assert!(!adapter.should_render(&video));
    let mut image = Draft::new(url("https://e.org/a.png"));
    image.direct_image = true;
    assert!(!adapter.should_render(&image));
    let mut thin = Draft::new(url("https://e.org/"));
    thin.html = true;
    assert!(adapter.should_render(&thin));
    assert!(!WebAdapter::new().unwrap().should_render(&thin));
}

#[test]
fn a_failed_render_keeps_the_static_page() {
    struct Broken;
    impl Renderer for Broken {
        fn render<'a>(&'a self, _: &'a Url, _: Duration) -> BoxFuture<'a, Result<Rendered>> {
            Box::pin(async { Err(Error::TimedOut) })
        }
    }
    let (base, thread) = serve(vec![("/", ok("html"), include_bytes!("../../fixtures/spa.html").to_vec())]);
    let adapter = WebAdapter::new().unwrap().with_renderer(Arc::new(Broken));
    let item = capture(&adapter, &format!("{base}/"), false).unwrap();
    thread.join().unwrap();
    assert_eq!(item.title.as_deref(), Some("Loading…"));
    assert_ne!(item.extras["extractor"], "defuddle");
}

#[test]
#[ignore]
fn live_article_and_video_metadata() {
    let adapter = WebAdapter::new().unwrap();
    let page = capture(&adapter, "https://example.com", false).unwrap();
    assert!(page.title.is_some());
    let video = capture(&adapter, "https://www.youtube.com/watch?v=jNQXAC9IVRw", true).unwrap();
    assert!(video.title.is_some());
}
