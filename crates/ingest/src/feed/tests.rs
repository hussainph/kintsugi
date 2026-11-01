use super::*;
use crate::Engine;
use std::io::{Read, Write};
use std::net::TcpListener;

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!("{}/fixtures/feed/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

fn run<T>(f: impl std::future::Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(f)
}

#[test]
fn rss_blog() {
    let (info, items) = parse(&fixture("blog.rss.xml"), "https://quiet.example/feed.xml").unwrap();
    assert_eq!(info.title.as_deref(), Some("The Quiet Blog"));
    assert_eq!(info.url.as_deref(), Some("https://quiet.example/"));
    assert_eq!(items.len(), 3);
    let first = &items[0];
    assert_eq!(first.source, SourceType::Rss);
    assert_eq!(first.id, "rss:https://quiet.example/posts/tools");
    assert_eq!(first.title.as_deref(), Some("Tools that shape thinking"));
    assert_eq!(first.url.as_deref(), Some("https://quiet.example/posts/tools"));
    assert_eq!(first.author.as_deref(), Some("Ada Writer"));
    assert_eq!(first.site.as_deref(), Some("The Quiet Blog"));
    assert_eq!(first.extras["media"], "article");
    assert!(first.body.contains("Every tool is an argument."), "{}", first.body);
    assert!(first.body.contains("*slowness*"), "Markdown keeps emphasis: {}", first.body);
    assert!(!first.body.contains("alert"), "scripts are dropped: {}", first.body);
    assert_eq!(first.description.as_deref(), Some("Every tool is an argument about what matters."));
    assert_eq!(first.media[0].url.as_deref(), Some("https://quiet.example/tools.jpg"));
    assert_eq!(first.published.as_deref(), Some("2026-10-30T09:00:00Z"));
    assert_eq!(items[1].description.as_deref(), Some("Repair as a design material."));
}

#[test]
fn atom_youtube_channel() {
    let (info, items) = parse(&fixture("youtube.atom.xml"), "https://www.youtube.com/feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv").unwrap();
    assert_eq!(info.title.as_deref(), Some("Slow Craft"));
    assert_eq!(items[0].extras["media"], "video");
    assert_eq!(items[0].url.as_deref(), Some("https://www.youtube.com/watch?v=abc123def45"));
    assert_eq!(items[0].media[0].url.as_deref(), Some("https://i.ytimg.com/vi/abc123def45/hqdefault.jpg"));
    assert!(items[0].description.as_deref().unwrap().contains("joinery"));
}

#[test]
fn podcast_enclosures_are_audio_and_json_feeds_parse() {
    let (_, items) = parse(&fixture("podcast.rss.xml"), "https://pod.example/feed").unwrap();
    assert_eq!(items[0].extras["media"], "audio");
    let (info, items) = parse(&fixture("notes.feed.json"), "https://notes.example/feed.json").unwrap();
    assert_eq!(info.title.as_deref(), Some("Field Notes"));
    assert_eq!(items[0].body, "Attention is a garden.\n\nTend it.");
    assert_eq!(parse(b"<html><body>hi</body></html>", "https://example.com/"), Err(Error::NotAFeed));
}

#[test]
fn feed_links_and_youtube_channels() {
    let html = String::from_utf8(fixture("blog.html")).unwrap();
    let base = Url::parse("https://quiet.example/posts/").unwrap();
    assert_eq!(feed_links(&html, &base), [Url::parse("https://quiet.example/feed.xml").unwrap()]);
    let channel = String::from_utf8(fixture("youtube-channel.html")).unwrap();
    assert_eq!(channel_id(&channel).as_deref(), Some("UCabcdefghijklmnopqrstuv"));
    assert_eq!(channel_id(r#"<script>{"externalId":"UCzyxwvutsrqponmlkjihgfe"}</script>"#).as_deref(), Some("UCzyxwvutsrqponmlkjihgfe"));
    assert_eq!(channel_id("<html></html>"), None);
}

#[test]
fn podcast_search_results() {
    let found = podcasts(&fixture("itunes-search.json")).unwrap();
    assert_eq!(found.len(), 1, "shows without a feed are skipped");
    assert_eq!(found[0].title, "Repair Hour");
    assert_eq!(found[0].feed_url, "https://pod.example/feed");
}

/// Answers every request: the feed (with an ETag, honouring If-None-Match),
/// a page that links to it, or a 503.
fn serve() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let feed = fixture("blog.rss.xml");
    let page = fixture("blog.html");
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut request = [0; 4096];
            let n = stream.read(&mut request).unwrap_or(0);
            let request = String::from_utf8_lossy(&request[..n]).to_ascii_lowercase();
            let (head, body): (&str, &[u8]) = if request.starts_with("get /feed.xml ") {
                if request.contains("if-none-match: \"v1\"") {
                    ("HTTP/1.1 304 Not Modified\r\n", b"")
                } else {
                    ("HTTP/1.1 200 OK\r\nContent-Type: application/rss+xml\r\nETag: \"v1\"\r\n", &feed)
                }
            } else if request.starts_with("get /blog ") {
                ("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n", &page)
            } else {
                ("HTTP/1.1 503 Service Unavailable\r\n", b"down")
            };
            let _ = write!(stream, "{head}Content-Length: {}\r\nConnection: close\r\n\r\n", body.len());
            let _ = stream.write_all(body);
        }
    });
    base
}

#[test]
fn polls_conditionally_through_the_engine() {
    let base = serve();
    let engine = Engine::new().with(FeedAdapter::new().unwrap()).with(crate::web::WebAdapter::new().unwrap());
    let mut subscription = Subscription { url: format!("{base}/feed.xml"), cursor: None };
    let first = run(engine.poll(SourceType::Rss, &subscription)).unwrap();
    assert_eq!(first.items.len(), 3);
    assert_eq!(first.source.unwrap().title.as_deref(), Some("The Quiet Blog"));
    assert_eq!(first.cursor.as_deref(), Some(r#"{"etag":"\"v1\""}"#));
    subscription.cursor = first.cursor.clone();
    let second = run(engine.poll(SourceType::Rss, &subscription)).unwrap();
    assert!(second.items.is_empty());
    assert_eq!(second.cursor, first.cursor);
    assert!(second.source.is_none());
    let broken = Subscription { url: format!("{base}/broken"), cursor: None };
    assert_eq!(run(engine.poll(SourceType::Rss, &broken)), Err(Error::Status(503)));
    // Feeds are followed, not captured: a URL still goes to the web adapter.
    assert_eq!(engine.adapter_for(&Target::url(&format!("{base}/feed.xml")).unwrap()).unwrap().source(), SourceType::Web);
}

#[test]
fn discovers_the_feed_behind_a_page() {
    let base = serve();
    let adapter = FeedAdapter::new().unwrap();
    let feed = Url::parse(&format!("{base}/feed.xml")).unwrap();
    assert_eq!(run(adapter.discover(&feed)).unwrap(), feed);
    // blog.html links to /feed.xml on its own host.
    assert_eq!(run(adapter.discover(&Url::parse(&format!("{base}/blog")).unwrap())).unwrap(), feed);
    assert_eq!(run(adapter.discover(&Url::parse(&format!("{base}/broken")).unwrap())), Err(Error::Status(503)));
}
