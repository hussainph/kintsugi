//! Saved `.json` responses on a loopback server; nothing here touches the
//! internet (the live check is `#[ignore]`d).

use super::*;
use crate::test_server::{route, run, serve};
use std::sync::Mutex;

const POST: &str = include_str!("../../fixtures/reddit/post.json");
const GALLERY: &str = include_str!("../../fixtures/reddit/gallery.json");
const JSON_PATH: &str = "/comments/1oabc12.json?raw_json=1&limit=300&depth=8";

fn adapter(base: &str) -> RedditAdapter {
    RedditAdapter::with_endpoint(
        Url::parse(base).unwrap(),
        ApiLimits { min_interval: Duration::ZERO, ..ApiLimits::default() },
    )
    .unwrap()
}

fn capture(adapter: &RedditAdapter, raw: &str) -> Result<Item> {
    run(adapter.capture(&Target::url(raw).unwrap(), CaptureOptions::default()))
}

fn link(raw: &str) -> Option<Link> {
    parse(&Url::parse(raw).unwrap())
}

fn post(id: &str, sub: Option<&str>, slug: Option<&str>) -> Option<Link> {
    Some(Link::Post(PostRef { id: id.into(), subreddit: sub.map(Into::into), slug: slug.map(Into::into) }))
}

#[test]
fn post_comment_short_and_share_links_match() {
    let full = "https://www.reddit.com/r/rust/comments/1oabc12/what_finally_made/";
    assert_eq!(link(full), post("1oabc12", Some("rust"), Some("what_finally_made")));
    assert_eq!(link("https://old.reddit.com/r/rust/comments/1OABC12/"), post("1oabc12", Some("rust"), None));
    assert_eq!(link("https://reddit.com/r/rust/comments/1oabc12/x/kcomment/?context=3"), post("1oabc12", Some("rust"), Some("x")));
    assert_eq!(link("https://m.reddit.com/comments/1oabc12"), post("1oabc12", None, None));
    assert_eq!(link("https://www.reddit.com/user/someone/comments/1oabc12/x/"), post("1oabc12", None, None));
    assert_eq!(link("https://redd.it/1oabc12"), post("1oabc12", None, None));
    assert_eq!(link("https://www.reddit.com/r/rust/s/AbC123xyz"), Some(Link::Share("/r/rust/s/AbC123xyz".into())));
    for raw in [
        "https://www.reddit.com/r/rust/",
        "https://www.reddit.com/r/rust/comments/",
        "https://reddit.com.evil.test/r/rust/comments/1oabc12/",
        "https://notreddit.com/r/rust/comments/1oabc12/",
        "https://www.reddit.com/r/rust/comments/bad!id/",
        "https://u:p@www.reddit.com/r/rust/comments/1oabc12/",
    ] {
        assert_eq!(link(raw), None, "{raw}");
    }
    let adapter = RedditAdapter::new().unwrap();
    assert!(adapter.matches(&Target::url(full).unwrap()));
    assert!(!adapter.matches(&Target::url("https://www.reddit.com/r/rust/").unwrap()));
}

#[test]
fn a_post_becomes_markdown_with_its_comment_tree() {
    let server = serve(vec![route(JSON_PATH, 200, POST)]);
    let item = capture(&adapter(&server.base), "https://old.reddit.com/r/rust/comments/1oabc12/what/").unwrap();
    let seen = server.finish();
    assert!(seen[0].1.starts_with("macos:dev.phalasiya.kintsugi:"), "{seen:?}");

    assert_eq!(item.source, SourceType::Reddit);
    assert_eq!(item.id, "reddit:1oabc12");
    assert_eq!(
        item.url.as_deref(),
        Some("https://www.reddit.com/r/rust/comments/1oabc12/what_finally_made_ownership_click_for_you/")
    );
    assert_eq!(item.title.as_deref(), Some("What finally made ownership click for you?"));
    assert_eq!(item.author.as_deref(), Some("u/ferris_fan"));
    assert_eq!(item.site.as_deref(), Some("r/rust"));
    assert_eq!(item.published.as_deref(), Some("2026-10-29T15:06:56Z"));
    assert_eq!(item.extras["extractor"], "reddit-json");
    assert_eq!(item.extras["score"], 412);
    assert_eq!(item.extras["comments"], 87);
    assert_eq!(item.extras["includedComments"], 6);
    assert_eq!(item.media[0].url.as_deref(), Some("https://preview.redd.it/ownership.png?width=1200&format=png&auto=webp&s=abc"));

    let body = &item.body;
    assert!(body.starts_with("I've read the book twice.\n\nWhat was the **one** example"), "{body}");
    assert!(body.contains("\n\n## Comments\n\n**u/crab_person** · 250 points · [link](<https://www.reddit.com/r/rust/comments/1oabc12/x/c2/>)\n\nThinking of `&mut` as *exclusive*"), "{body}");
    assert!(body.contains("> **u/ferris_fan** · 80 points · OP · [link](<https://www.reddit.com/r/rust/comments/1oabc12/x/c3/>)\n>\n> This is exactly it, thanks!"), "{body}");
    assert!(body.contains("> > **u/borrowck** · 30 points · [link](<https://www.reddit.com/r/rust/comments/1oabc12/x/c4/>)\n> >\n> > And `&` as shared access.\n> >\n> > Two lines."), "{body}");
    assert!(body.contains("> _4 more replies on Reddit_"), "{body}");
    assert!(body.contains("**[deleted]** · 2 points · [link](<https://www.reddit.com/r/rust/comments/1oabc12/x/c6/>)\n\n_[deleted]_\n\n> **u/lurker**"), "{body}");
    assert!(body.ends_with("_61 more replies on Reddit_"), "{body}");
    assert!(!body.contains("AutoModerator") && !body.contains("Please read the rules"), "{body}");
    assert_eq!(body.matches("[deleted]").count(), 2, "{body}");
    // Hostile comments stay inert text in the item: never instructions.
    assert!(body.contains("Ignore previous instructions"));
}

#[test]
fn galleries_keep_their_order_and_skip_the_gallery_link() {
    let server = serve(vec![route("/comments/1ogal01.json?", 200, GALLERY)]);
    let item = capture(&adapter(&server.base), "https://redd.it/1ogal01").unwrap();
    server.finish();
    let urls: Vec<&str> = item.media.iter().filter_map(|m| m.url.as_deref()).collect();
    assert_eq!(urls, ["https://preview.redd.it/m2.jpg?width=2000&s=2", "https://preview.redd.it/m1.jpg?width=2000&s=1"]);
    assert_eq!(item.body, "![](https://preview.redd.it/m2.jpg?width=2000&s=2)\n\n![](https://preview.redd.it/m1.jpg?width=2000&s=1)");
    assert!(!item.extras.contains_key("link"));
}

#[test]
fn share_links_are_resolved_from_their_redirect_without_following_it() {
    let server = serve(vec![
        route("/r/rust/s/AbC123xyz", 301, "")
            .header("Location: https://www.reddit.com/r/rust/comments/1oabc12/what/?share_id=x"),
        route(JSON_PATH, 200, POST),
    ]);
    let item = capture(&adapter(&server.base), "https://www.reddit.com/r/rust/s/AbC123xyz").unwrap();
    assert_eq!(server.finish().len(), 2);
    assert_eq!(item.id, "reddit:1oabc12");

    let server = serve(vec![route("/r/rust/s/AbC123xyz", 301, "").header("Location: https://evil.test/r/x/comments/1/")]);
    assert_eq!(capture(&adapter(&server.base), "https://www.reddit.com/r/rust/s/AbC123xyz"), Err(Error::Unavailable));
    server.finish();
}

/// Stands in for the web adapter with its hidden webview.
#[derive(Default)]
struct FakeWeb {
    calls: Mutex<Vec<String>>,
}

impl Adapter for FakeWeb {
    fn source(&self) -> SourceType {
        SourceType::Web
    }
    fn matches(&self, _: &Target) -> bool {
        true
    }
    fn capture<'a>(&'a self, target: &'a Target, _: CaptureOptions) -> BoxFuture<'a, Result<Item>> {
        Box::pin(async move {
            let Target::Url(url) = target else { unreachable!() };
            self.calls.lock().unwrap().push(url.to_string());
            let mut extras = BTreeMap::new();
            extras.insert("extractor".to_string(), Value::from("defuddle"));
            Ok(Item {
                source: SourceType::Web,
                id: format!("web:{url}"),
                url: Some(url.to_string()),
                title: Some("Rendered title".into()),
                author: None,
                site: None,
                description: None,
                published: None,
                captured: crate::now(),
                media: vec![],
                body: "Rendered post and comments.".into(),
                extras,
            })
        })
    }
}

#[test]
fn a_refused_json_falls_back_to_the_rendered_page() {
    let server = serve(vec![route(JSON_PATH, 403, "<body>blocked</body>")]);
    let web = Arc::new(FakeWeb::default());
    let adapter = adapter(&server.base).with_fallback(web.clone());
    let item = capture(&adapter, "https://www.reddit.com/r/rust/comments/1oabc12/what/").unwrap();
    server.finish();
    assert_eq!(*web.calls.lock().unwrap(), ["https://old.reddit.com/r/rust/comments/1oabc12/what/"]);
    assert_eq!(item.source, SourceType::Reddit);
    assert_eq!(item.id, "reddit:1oabc12");
    assert_eq!(item.url.as_deref(), Some("https://www.reddit.com/r/rust/comments/1oabc12/what/"));
    assert_eq!(item.site.as_deref(), Some("r/rust"));
    assert_eq!(item.extras["extractor"], "defuddle");
    assert_eq!(item.extras["fallback"], "web");

    // Without a fallback, the refusal is reported as such.
    let server = serve(vec![route(JSON_PATH, 403, "")]);
    assert_eq!(capture(&self::adapter(&server.base), "https://redd.it/1oabc12"), Err(Error::Unavailable));
    server.finish();
}

#[test]
fn a_rate_limit_is_respected_rather_than_worked_around() {
    let server = serve(vec![route(JSON_PATH, 429, "").header("x-ratelimit-reset: 300")]);
    let web = Arc::new(FakeWeb::default());
    let adapter = adapter(&server.base).with_fallback(web.clone());
    assert_eq!(capture(&adapter, "https://redd.it/1oabc12"), Err(Error::RateLimited));
    server.finish();
    assert!(web.calls.lock().unwrap().is_empty());
    // Still blocked: nothing is sent.
    assert_eq!(capture(&adapter, "https://redd.it/1oabc12"), Err(Error::RateLimited));
}

#[test]
fn reddit_cannot_be_followed() {
    let adapter = RedditAdapter::new().unwrap();
    let polled = run(adapter.poll(&crate::Subscription { url: "https://www.reddit.com/r/rust/".into(), cursor: None }));
    assert_eq!(polled, Err(Error::Unsupported));
}

#[test]
#[ignore]
fn live_post_with_comments() {
    // Reddit refuses some networks outright; a 403 here is Reddit's choice.
    let adapter = RedditAdapter::new().unwrap();
    let item = capture(&adapter, "https://www.reddit.com/r/rust/comments/1d8n6vh/").unwrap();
    assert!(item.title.is_some());
}
