//! Saved pages and a loopback server only; nothing here touches the internet.

use super::*;
use crate::Adapter;
use crate::test_server::{Route, run, serve};

const V1: &str = include_str!("../../../fixtures/watch/now-v1.html");
const NOISE: &str = include_str!("../../../fixtures/watch/now-v1-noise.html");
const V2: &str = include_str!("../../../fixtures/watch/now-v2.html");

fn url(s: &str) -> Url {
    web_url(s).unwrap()
}

fn html(target: &str, body: &str, etag: Option<&str>) -> Route {
    let mut head = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n".to_string();
    if let Some(etag) = etag {
        head.push_str(&format!("ETag: {etag}\r\n"));
    }
    Route { target: target.into(), head, body: body.as_bytes().to_vec() }
}

fn status(target: &str, code: u16, reason: &str) -> Route {
    Route { target: target.into(), head: format!("HTTP/1.1 {code} {reason}\r\n"), body: Vec::new() }
}

#[test]
fn a_snapshot_is_the_readable_region_without_chrome() {
    let page = snapshot(V1, &url("https://ada.example/now"));
    assert_eq!(page.title.as_deref(), Some("What I'm doing now"));
    assert_eq!(page.image.as_deref(), Some("https://ada.example/images/desk.jpg"));
    assert_eq!(
        page.lines,
        [
            "What I'm doing now",
            "Updated November 3, 2026 at 9:14 am · 3 hours ago",
            "Reading",
            "Piranesi by Susanna Clarke",
            "The Dispossessed, for the second time",
            "Writing",
            "An essay on slow software. 2,301 views · 14 comments",
            "Building a quiet notes app in Rust.",
        ]
    );
}

#[test]
fn dates_counters_and_link_targets_are_noise() {
    let base = url("https://ada.example/now");
    let (v1, noise, v2) = (snapshot(V1, &base), snapshot(NOISE, &base), snapshot(V2, &base));
    assert_eq!(fingerprint(&v1.lines), fingerprint(&noise.lines), "{:#?}\n{:#?}", v1.lines, noise.lines);
    assert_ne!(fingerprint(&v1.lines), fingerprint(&v2.lines));
    for (a, b) in [
        ("Posted 2026-11-03T09:14:07Z", "Posted 2027-01-01 10:00"),
        ("Last updated 11/03/2026 at 2:05 PM", "Last updated 3.12.27 at 14:05"),
        ("Monday, 3rd of November 2026", "Friday, 5 December 2027"),
        ("Edited 5 minutes ago", "Edited an hour ago"),
        ("Edited 3h ago", "Edited yesterday"),
        ("1,204 views · 3 likes", "1.2k views · 12 likes"),
        ("Stars: 812", "Stars: 1,020"),
        ("© 2026 Someone", "Copyright 2024–2027 Someone"),
        ("Updated November 3, 2026 at 9:14 am · 3 hours ago", "Updated December 1, 2026 · yesterday"),
    ] {
        assert_eq!(normalize(a), normalize(b), "{a} vs {b}");
    }
    // Real content still counts, even when it holds numbers.
    assert_ne!(normalize("Version 2.3 is out"), normalize("Version 2.4 is out"));
    assert_ne!(normalize("Price: $40"), normalize("Price: $45"));
    assert_ne!(normalize("Reading Piranesi"), normalize("Reading Middlemarch"));
}

#[test]
fn the_diff_shows_what_was_added_and_removed() {
    let base = url("https://ada.example/now");
    let change = diff(&snapshot(V1, &base).lines, &snapshot(V2, &base).lines);
    assert_eq!(change.added, ["The Left Hand of Darkness", "Learning to bind books by hand."]);
    assert_eq!(change.removed, ["The Dispossessed, for the second time"]);
    assert_eq!(summary(&change), "2 lines added and 1 removed");
    assert_eq!(
        describe(&change),
        "**Added**\n\n- The Left Hand of Darkness\n- Learning to bind books by hand.\n\n**Removed**\n\n- The Dispossessed, for the second time"
    );
    // Long pages fall back to an order-blind comparison.
    let many: Vec<String> = (0..10).map(|i| format!("line {i}")).collect();
    let (keep_a, keep_b) = multiset(&many, &[many[3].clone(), "new".into(), many[3].clone()]);
    assert_eq!(keep_a.iter().filter(|k| **k).count(), 1);
    assert_eq!(keep_b, [true, false, false]);
}

#[test]
fn page_text_cannot_write_markdown_or_html() {
    let change = Change { added: vec!["# <script>alert(1)</script> [x](javascript:1)".into(), "1. not a list".into()], removed: vec![] };
    let body = describe(&change);
    assert!(!body.contains('<') && !body.contains("](javascript"), "{body}");
    assert!(body.contains("- \\# script"), "{body}");
    assert!(body.contains("- \\1. not a list"), "{body}");
    let more = Change { added: (0..20).map(|i| format!("entry {i}")).collect(), removed: vec![] };
    assert!(describe(&more).ends_with("- …and 8 more"));
    assert_eq!(summary(&Change { added: vec![], removed: vec!["x".into()] }), "1 line removed");
}

#[test]
fn polling_baselines_skips_noise_and_reports_a_change() {
    let server = serve(vec![
        html("/now", V1, Some("\"a\"")),
        html("/now", NOISE, Some("\"b\"")),
        status("/now", 304, "Not Modified"),
        html("/now", V2, None),
        status("/now", 503, "Service Unavailable"),
    ]);
    let adapter = WebAdapter::new().unwrap();
    let page = format!("{}now", server.base);
    run(async {
        let first = adapter.poll(&Subscription { url: page.clone(), cursor: None }).await.unwrap();
        assert!(first.items.is_empty(), "the first poll is a baseline");
        assert_eq!(first.source.as_ref().and_then(|s| s.title.as_deref()), Some("What I'm doing now"));
        let cursor = first.cursor.clone().unwrap();
        assert!(cursor.contains("\"etag\":\"\\\"a\\\"\""), "{cursor}");

        let noise = adapter.poll(&Subscription { url: page.clone(), cursor: Some(cursor) }).await.unwrap();
        assert!(noise.items.is_empty(), "dates and counters moved, nothing else");

        let unchanged = adapter.poll(&Subscription { url: page.clone(), cursor: noise.cursor.clone() }).await.unwrap();
        assert!(unchanged.items.is_empty());
        assert_eq!(unchanged.cursor, noise.cursor, "a 304 keeps the cursor");
        assert_eq!(unchanged.source, None);

        let changed = adapter.poll(&Subscription { url: page.clone(), cursor: unchanged.cursor.clone() }).await.unwrap();
        assert_eq!(changed.items.len(), 1);
        let item = &changed.items[0];
        assert_eq!(item.source, SourceType::Web);
        assert_eq!(item.url.as_deref(), Some(page.as_str()));
        assert!(item.id.starts_with(&format!("web:{page}#")), "{}", item.id);
        assert_eq!(item.title.as_deref(), Some("The Left Hand of Darkness"));
        assert_eq!(item.description.as_deref(), Some("2 lines added and 1 removed on What I'm doing now"));
        assert!(item.body.contains("- Learning to bind books by hand."));
        assert_eq!(item.extras["extractor"], "watch");
        assert!(item.published.is_some());

        let failed = adapter.poll(&Subscription { url: page.clone(), cursor: changed.cursor.clone() }).await;
        assert_eq!(failed, Err(Error::Status(503)));
    });
    let seen = server.finish();
    assert_eq!(seen.len(), 5);
}

#[test]
fn non_text_pages_cannot_be_watched() {
    let server = serve(vec![Route {
        target: "/photo".into(),
        head: "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\n".into(),
        body: vec![0x89, b'P', b'N', b'G'],
    }]);
    let adapter = WebAdapter::new().unwrap();
    let polled = run(adapter.poll(&Subscription { url: format!("{}photo", server.base), cursor: None }));
    assert_eq!(polled, Err(Error::Unsupported));
    server.finish();
    let invalid = run(adapter.poll(&Subscription { url: "file:///etc/passwd".into(), cursor: None }));
    assert_eq!(invalid, Err(Error::InvalidUrl));
}
