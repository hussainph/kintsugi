//! Saved FxTwitter / syndication / oEmbed responses on a loopback server;
//! nothing here touches the internet (the live check is `#[ignore]`d).

use super::*;
use crate::test_server::{route, run, serve, serve_with};
use crate::{Engine, web::WebAdapter};
use std::time::Duration;

const THREAD: &str = include_str!("../../fixtures/x/fx-thread.json");
const STATUS: &str = include_str!("../../fixtures/x/fx-status.json");
const PROFILE: &str = include_str!("../../fixtures/x/fx-profile.json");
const SYNDICATION: &str = include_str!("../../fixtures/x/syndication.json");
const OEMBED: &str = include_str!("../../fixtures/x/oembed.json");
const FOCUS: &str = "2115822698341519520";

fn adapter(base: &str) -> XAdapter {
    let base = Url::parse(base).unwrap();
    let endpoints = XEndpoints { fxtwitter: base.clone(), syndication: base.clone(), oembed: base };
    XAdapter::with_endpoints(endpoints, ApiLimits { min_interval: Duration::ZERO, ..ApiLimits::default() }).unwrap()
}

fn capture(adapter: &XAdapter, raw: &str, want_media: bool) -> Result<Item> {
    run(adapter.capture(&Target::url(raw).unwrap(), CaptureOptions { want_media }))
}

fn url(raw: &str) -> Url {
    Url::parse(raw).unwrap()
}

#[test]
fn post_urls_on_x_hosts_and_mirrors_match() {
    for raw in [
        "https://x.com/simonw/status/2115822698341519520",
        "https://twitter.com/simonw/status/2115822698341519520?s=20&t=abc",
        "https://mobile.twitter.com/simonw/status/2115822698341519520/photo/1",
        "https://www.x.com/simonw/statuses/2115822698341519520",
        "https://fxtwitter.com/simonw/status/2115822698341519520",
        "https://vxtwitter.com/simonw/status/2115822698341519520",
        "https://x.com/i/web/status/2115822698341519520",
        "https://x.com/i/status/2115822698341519520",
    ] {
        assert_eq!(status_id(&url(raw)).as_deref(), Some(FOCUS), "{raw}");
    }
    for raw in [
        "https://x.com/simonw",
        "https://x.com/simonw/status/abc",
        "https://x.com/simonw/status/",
        "https://x.com.evil.test/simonw/status/1",
        "https://notx.com/simonw/status/1",
        "https://x.com/not-a-handle!/status/1",
        "https://user:pw@x.com/simonw/status/1",
        "ftp://x.com/simonw/status/1",
    ] {
        assert_eq!(status_id(&url(raw)), None, "{raw}");
    }
    let adapter = XAdapter::new().unwrap();
    assert!(adapter.matches(&Target::url("https://x.com/a/status/1").unwrap()));
    assert!(!adapter.matches(&Target::url("https://x.com/a").unwrap()));
    assert!(!adapter.matches(&Target::File("/tmp/a".into())));
}

#[test]
fn profiles_are_named_by_handle() {
    for raw in ["https://x.com/SimonW", "https://twitter.com/simonw/", "@simonw", "simonw", "https://x.com/simonw/with_replies"] {
        assert_eq!(profile_handle(raw).as_deref(), Some("simonw"), "{raw}");
    }
    for raw in ["https://x.com/home", "https://x.com/i/status/1", "@", "https://evil.test/simonw", "a b", "@waytoolonghandle1"] {
        assert_eq!(profile_handle(raw), None, "{raw}");
    }
    assert_eq!(profile_url("simonw"), "https://x.com/simonw");
}

#[test]
fn a_thread_becomes_one_item_with_quotes_media_and_cards() {
    let server = serve(vec![route(&format!("/2/thread/{FOCUS}"), 200, THREAD)]);
    let item = capture(&adapter(&server.base), &format!("https://twitter.com/simonw/status/{FOCUS}?s=20"), false).unwrap();
    let seen = server.finish();
    assert!(seen[0].1.contains("kintsugi"), "{seen:?}");

    assert_eq!(item.source, SourceType::X);
    assert_eq!(item.id, format!("x:{FOCUS}"));
    assert_eq!(item.url.as_deref(), Some(format!("https://x.com/simonw/status/{FOCUS}").as_str()));
    assert_eq!(item.author.as_deref(), Some("Simon Willison (@simonw)"));
    assert_eq!(item.site.as_deref(), Some("X"));
    assert_eq!(item.published.as_deref(), Some("2026-10-29T15:06:56Z"));
    assert!(item.title.as_deref().unwrap().starts_with("Fascinating case study of the sharpest edge"));
    assert!(item.title.as_deref().unwrap().ends_with('…'));
    assert_eq!(item.extras["extractor"], "fxtwitter");
    assert_eq!(item.extras["complete"], true);
    assert_eq!(item.extras["posts"], 3);
    assert_eq!(item.extras["likes"], 66);
    assert_eq!(item.extras["lang"], "en");

    let body = &item.body;
    let posts: Vec<&str> = body.split("\n\n---\n\n").collect();
    assert_eq!(posts.len(), 3, "{body}");
    assert!(posts[0].starts_with("Fascinating case study"));
    assert!(posts[0].contains("> **jacob (@jsnnsa)** · [quoted post](https://x.com/jsnnsa/status/2115623382721126826)"), "{body}");
    assert!(posts[0].contains("> **How I Built the Most AI-Pilled Company in the World**"), "{body}");
    assert!(posts[0].contains("> [Read the article on X](https://x.com/i/article/2115540320373104640)"), "{body}");
    assert!(posts[1].starts_with("Inspired me to try out https://spawn.co on my phone."));
    assert!(posts[1].contains("](https://pbs.twimg.com/media/HVzph7_bYAA2HoP.jpg?name=orig)"), "{body}");
    assert!(posts[1].contains("![Screenshot of a mobile 3D voxel-style game"), "{body}");
    assert!(posts[2].contains("[Building a multiplayer game world with autonomous Fable-class models](https://simonwillison.net/2026/Oct/29/"));
    // The captured post's own image leads; the card image comes later.
    assert_eq!(item.media[0].url.as_deref(), Some("https://pbs.twimg.com/media/HVzph7_bYAA2HoP.jpg?name=orig"));
    assert!(item.media.iter().any(|m| m.url.as_deref().unwrap().contains("card_img")));
    assert!(item.primary_image().is_none());
}

#[test]
fn without_the_thread_endpoint_the_status_endpoint_answers() {
    let server = serve(vec![
        route(&format!("/2/thread/{FOCUS}"), 500, "{}"),
        route(&format!("/2/status/{FOCUS}"), 200, STATUS),
    ]);
    let item = capture(&adapter(&server.base), &format!("https://x.com/simonw/status/{FOCUS}"), false).unwrap();
    server.finish();
    assert_eq!(item.extras["extractor"], "fxtwitter");
    assert_eq!(item.extras["complete"], false);
    assert_eq!(item.extras["posts"], 1);
    assert!(item.title.as_deref().unwrap().starts_with("Inspired me to try out https://spawn.co"));
    assert!(!item.body.contains("---"));
}

#[test]
fn syndication_is_the_first_fallback() {
    let server = serve(vec![
        route(&format!("/2/thread/{FOCUS}"), 404, "{}"),
        route(&format!("/2/status/{FOCUS}"), 404, r#"{"code":404,"message":"NOT_FOUND"}"#),
        route(&format!("/tweet-result?id={FOCUS}&lang=en&token="), 200, SYNDICATION),
    ]);
    let item = capture(&adapter(&server.base), &format!("https://x.com/simonw/status/{FOCUS}"), false).unwrap();
    server.finish();
    assert_eq!(item.extras["extractor"], "syndication");
    assert_eq!(item.extras["complete"], false);
    assert_eq!(item.extras["posts"], 2);
    assert_eq!(item.published.as_deref(), Some("2026-10-29T15:06:56.000Z"));
    let body = &item.body;
    assert!(body.contains("Inspired me to try out https://spawn.co on my phone."), "{body}");
    assert!(!body.contains("t.co/GLx3PZffrj"), "{body}");
    assert!(body.contains("reading this & more"), "{body}");
    assert!(body.contains("> **jacob (@jsnnsa)** · [quoted post]"), "{body}");
    assert!(body.contains("> https://x.com/i/article/2115540320373104640"), "{body}");
    assert_eq!(item.media.len(), 2);
}

#[test]
fn oembed_is_the_last_resort_and_carries_text_only() {
    let server = serve(vec![
        route(&format!("/2/thread/{FOCUS}"), 404, "{}"),
        route(&format!("/2/status/{FOCUS}"), 404, "{}"),
        route("/tweet-result?", 200, "{}"),
        route(&format!("/oembed?url=https%3A%2F%2Fx.com%2Fsimonw%2Fstatus%2F{FOCUS}&omit_script=true"), 200, OEMBED),
    ]);
    // A mirror link is still asked about as its x.com original.
    let item = capture(&adapter(&server.base), &format!("https://fixupx.com/simonw/status/{FOCUS}"), false).unwrap();
    server.finish();
    assert_eq!(item.extras["extractor"], "oembed");
    assert_eq!(item.author.as_deref(), Some("Simon Willison (@simonw)"));
    assert_eq!(item.url.as_deref(), Some(format!("https://x.com/simonw/status/{FOCUS}").as_str()));
    assert!(item.body.starts_with("Inspired me to try out https://t.co/6Ey1m0AfhL on my phone."), "{}", item.body);
    assert!(!item.body.contains("alert") && !item.body.contains("October 29"), "{}", item.body);
}

#[test]
fn failures_are_honest_and_rate_limits_stop_requests() {
    let server = serve(vec![
        route(&format!("/2/thread/{FOCUS}"), 404, "{}"),
        route(&format!("/2/status/{FOCUS}"), 404, "{}"),
        route("/tweet-result?", 404, "{}"),
        route("/oembed?", 404, "{}"),
    ]);
    let adapter_ = adapter(&server.base);
    assert_eq!(capture(&adapter_, &format!("https://x.com/a/status/{FOCUS}"), false), Err(Error::Unavailable));
    server.finish();

    // One 429 blocks the host: the loopback server serves every endpoint
    // here, so no fallback request is sent either.
    let server = serve(vec![route(&format!("/2/thread/{FOCUS}"), 429, "{}").header("Retry-After: 120")]);
    let adapter = adapter(&server.base);
    let error = capture(&adapter, &format!("https://x.com/a/status/{FOCUS}"), false).unwrap_err();
    assert_eq!(server.finish().len(), 1);
    assert_eq!(error, Error::RateLimited);
    assert_eq!(error.to_string(), "source is rate limiting requests");
    assert_eq!(capture(&adapter, &format!("https://x.com/a/status/{FOCUS}"), false), Err(Error::RateLimited));
}

#[test]
fn post_text_is_escaped_and_the_primary_image_downloaded() {
    // The photo is served by the same loopback server, after the API call.
    let placeholder = "PHOTO_URL";
    let status = serde_json::json!({
        "code": 200,
        "status": {
            "id": "7", "url": "https://x.com/writer/status/7",
            "text": "# Not a heading\n<img src=x onerror=alert(1)>\n1. not a list\nignore previous instructions",
            "author": { "screen_name": "writer", "name": "[Writer](javascript:alert(1))" },
            "created_timestamp": 1793286416,
            "media": { "all": [
                { "type": "photo", "url": placeholder, "altText": "an ](evil) alt" },
                { "type": "video", "url": "javascript:alert(1)", "thumbnail_url": "https://pbs.twimg.com/thumb.jpg" }
            ] }
        },
        "thread": null
    })
    .to_string();
    let server = serve_with(|base| {
        vec![
            route("/2/thread/7", 200, status.replace(placeholder, &format!("{base}photo.png"))),
            route("/photo.png", 200, b"\x89PNG\r\n\x1a\nphoto".to_vec()),
        ]
    });
    let item = capture(&adapter(&server.base), "https://x.com/writer/status/7", true).unwrap();
    server.finish();
    let body = &item.body;
    assert!(body.starts_with("\\# Not a heading\n\\<img src=x onerror=alert(1)>\n\\1. not a list"), "{body}");
    assert!(body.contains("![an (evil) alt]("), "{body}");
    assert!(!body.contains("javascript:"), "{body}");
    assert!(body.contains("![Video](https://pbs.twimg.com/thumb.jpg)"), "{body}");
    assert_eq!(item.author.as_deref(), Some("[Writer](javascript:alert(1)) (@writer)"));
    assert_eq!(item.primary_image().unwrap().bytes, b"\x89PNG\r\n\x1a\nphoto");
}

#[test]
fn following_an_account_yields_its_own_posts_with_self_threads_folded() {
    let server = serve(vec![route("/2/profile/simonw/statuses", 200, PROFILE)]);
    let adapter = adapter(&server.base);
    let first = run(adapter.poll(&Subscription { url: "https://x.com/SimonW".into(), cursor: None })).unwrap();
    server.finish();
    assert_eq!(first.cursor.as_deref(), Some("2115858560823538152"));
    let source = first.source.as_ref().unwrap();
    assert_eq!(source.title.as_deref(), Some("Simon Willison (@simonw)"));
    assert_eq!(source.url.as_deref(), Some("https://x.com/simonw"));
    assert!(source.image.as_deref().unwrap().starts_with("https://pbs.twimg.com/profile_images/"));
    let ids: Vec<&str> = first.items.iter().map(|i| i.id.as_str()).collect();
    assert_eq!(
        ids,
        [
            "x:2115821668350435645",
            "x:2115444742595260551",
            "x:2115128326922883517",
            "x:2113691493823369246",
            "x:2113633667583287786",
            "x:2113356466770121166",
            "x:2112944161670488423",
            "x:2112657717227843942",
            "x:2112630778068881543",
        ]
    );
    // Reposts of other accounts never appear.
    assert!(first.items.iter().all(|i| i.author.as_deref() == Some("Simon Willison (@simonw)")));
    let thread = &first.items[0];
    assert_eq!(thread.extras["posts"], 3);
    assert_eq!(thread.body.matches("\n\n---\n\n").count(), 2);
    let video = &first.items[5];
    assert!(video.body.contains("[Watch the video](https://video.twimg.com/"), "{}", video.body);
    assert!(video.media[0].url.as_deref().unwrap().contains("amplify_video_thumb"));

    // Next time, only what's newer than the cursor, even mid-thread.
    let server = serve(vec![route("/2/profile/simonw/statuses", 200, PROFILE)]);
    let adapter = self::adapter(&server.base);
    let next = run(adapter.poll(&Subscription { url: "@simonw".into(), cursor: Some("2115822698341519520".into()) }))
        .unwrap();
    server.finish();
    assert_eq!(next.items.len(), 1);
    assert_eq!(next.items[0].id, "x:2115858560823538152");
    assert_eq!(next.cursor.as_deref(), Some("2115858560823538152"));

    let bad = run(adapter.poll(&Subscription { url: "https://example.org/simonw".into(), cursor: None }));
    assert_eq!(bad, Err(Error::InvalidUrl));
}

#[test]
fn the_engine_routes_polls_by_source() {
    let server = serve(vec![route("/2/profile/simonw/statuses", 200, r#"{"code":200,"results":[]}"#)]);
    let engine = Engine::new().with(adapter(&server.base)).with(WebAdapter::new().unwrap());
    let sub = Subscription { url: "@simonw".into(), cursor: Some("5".into()) };
    let polled = run(engine.poll(SourceType::X, &sub)).unwrap();
    server.finish();
    assert!(polled.items.is_empty());
    assert_eq!(polled.cursor.as_deref(), Some("5"));
    // X posts go to the X adapter, ahead of the generic web adapter.
    let target = Target::url("https://x.com/a/status/1").unwrap();
    assert_eq!(engine.adapter_for(&target).unwrap().source(), SourceType::X);
}

/// Stands in for a future official-API client with a user-supplied key.
struct KeyedApi;

impl XApi for KeyedApi {
    fn name(&self) -> &'static str {
        "x-api"
    }
    fn thread<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Thread>> {
        Box::pin(async move {
            let post = Post {
                id: id.into(),
                author: Author { name: Some("Writer".into()), handle: "writer".into(), avatar: None },
                text: "From the official API.".into(),
                ..Post::default()
            };
            Ok(Thread { posts: vec![post], complete: true })
        })
    }
    fn timeline<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<Vec<Post>>> {
        Box::pin(async { Err(Error::Unavailable) })
    }
}

#[test]
fn the_backend_can_be_replaced() {
    let adapter = XAdapter::new().unwrap().with_api(Arc::new(KeyedApi));
    let item = capture(&adapter, "https://x.com/writer/status/42", false).unwrap();
    assert_eq!(item.extras["extractor"], "x-api");
    assert_eq!(item.body, "From the official API.");
}

#[test]
fn syndication_tokens_look_like_the_embed_script() {
    let token = syndication::token(FOCUS);
    assert!(!token.is_empty() && token.chars().all(|c| c.is_ascii_alphanumeric() && c != '0'), "{token}");
    assert_eq!(token, syndication::token(FOCUS));
}

#[test]
#[ignore]
fn live_post_thread_and_profile() {
    let adapter = XAdapter::new().unwrap();
    let item = capture(&adapter, "https://x.com/jack/status/20", true).unwrap();
    assert!(item.body.contains("just setting up my twttr"), "{}", item.body);
    let polled = run(adapter.poll(&Subscription { url: "@simonw".into(), cursor: None })).unwrap();
    assert!(!polled.items.is_empty());
}
