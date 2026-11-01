//! Saved Algolia responses on a loopback server; nothing here touches the
//! internet (the live check is `#[ignore]`d).

use super::*;
use crate::test_server::{route, run, serve};

const STORY: &str = include_str!("../../fixtures/hn/story.json");
const COMMENT: &str = include_str!("../../fixtures/hn/comment.json");

fn adapter(base: &str) -> HackerNewsAdapter {
    HackerNewsAdapter::with_endpoint(
        Url::parse(base).unwrap(),
        ApiLimits { min_interval: Duration::ZERO, ..ApiLimits::default() },
    )
    .unwrap()
}

fn capture(adapter: &HackerNewsAdapter, raw: &str) -> Result<Item> {
    run(adapter.capture(&Target::url(raw).unwrap(), CaptureOptions::default()))
}

#[test]
fn item_links_match_and_others_do_not() {
    let id = |raw: &str| item_id(&Url::parse(raw).unwrap());
    assert_eq!(id("https://news.ycombinator.com/item?id=19804478"), Some(19804478));
    assert_eq!(id("http://NEWS.ycombinator.com/item?id=1&p=2"), Some(1));
    for raw in [
        "https://news.ycombinator.com/",
        "https://news.ycombinator.com/item",
        "https://news.ycombinator.com/item?id=abc",
        "https://news.ycombinator.com/item?id=0",
        "https://news.ycombinator.com/user?id=pg",
        "https://news.ycombinator.com.evil.test/item?id=1",
        "https://u:p@news.ycombinator.com/item?id=1",
    ] {
        assert_eq!(id(raw), None, "{raw}");
    }
    let adapter = HackerNewsAdapter::new().unwrap();
    assert!(adapter.matches(&Target::url("https://news.ycombinator.com/item?id=19804478").unwrap()));
    assert!(!adapter.matches(&Target::url("https://news.ycombinator.com/news").unwrap()));
}

#[test]
fn a_story_keeps_every_comment_author_nesting_and_permalink() {
    let server = serve(vec![route("/items/19804478", 200, STORY)]);
    let item = capture(&adapter(&server.base), "https://news.ycombinator.com/item?id=19804478").unwrap();
    server.finish();
    assert_eq!(item.source, SourceType::Hn);
    assert_eq!(item.id, "hn:19804478");
    assert_eq!(item.url.as_deref(), Some("https://news.ycombinator.com/item?id=19804478"));
    assert_eq!(item.title.as_deref(), Some("Local-first software: You own your data, in spite of the cloud"));
    assert_eq!(item.author.as_deref(), Some("pvh"));
    assert_eq!(item.site.as_deref(), Some("Hacker News"));
    assert_eq!(item.published.as_deref(), Some("2019-05-01T14:01:12Z"));
    assert_eq!(item.extras["extractor"], "hn-algolia");
    assert_eq!(item.extras["points"], 1103);
    assert_eq!(item.extras["includedComments"], 5);
    assert_eq!(item.extras["link"], "https://www.inkandswitch.com/local-first.html");

    let body = &item.body;
    assert!(body.starts_with("[inkandswitch.com](<https://www.inkandswitch.com/local-first.html>)\n\n## Comments\n\n"), "{body}");
    // A top-level comment: author, date, permalink; HN's `>` quoting stays text.
    assert!(
        body.contains(
            "**josephg** · 2019-05-01 · [link](<https://news.ycombinator.com/item?id=19805001>)\n\n\
             I've spent years on CRDTs. The hard part isn't the algorithm, it's the *product*.\n\n\
             \\> real-time collaboration is table stakes\n\n\
             Agreed. See [https://github.com/josephg/diamond-types](<https://github.com/josephg/diamond-types>)"
        ),
        "{body}"
    );
    assert!(body.contains("```\n  let doc = Doc::new();\n  doc.insert(0, \"hi\");\n```"), "{body}");
    // The reply is nested one level, marked OP, and can't open a heading or raw HTML.
    assert!(
        body.contains(
            "> **pvh** · 2019-05-01 · OP · [link](<https://news.ycombinator.com/item?id=19805123>)\n>\n\
             > \\# not a heading. Thanks, Joseph! \\<script\\>alert(1)\\</script\\>"
        ),
        "{body}"
    );
    assert!(body.contains("> > **josephg** · 2019-05-01 · [link](<https://news.ycombinator.com/item?id=19805200>)\n> >\n> > \\1. Happy to help."), "{body}");
    // A deleted comment with no replies is skipped; one with replies keeps them.
    assert!(!body.contains("19805300"), "{body}");
    assert!(body.contains("**[deleted]** · 2019-05-01 · [link](<https://news.ycombinator.com/item?id=19805400>)\n\n_[deleted]_"), "{body}");
    assert!(body.contains("> **skeptic**"), "{body}");
    assert!(body.contains("Sync is never \\[free\\](javascript:alert(1))."), "{body}");
}

#[test]
fn a_comment_link_captures_its_whole_story() {
    let server = serve(vec![route("/items/19805123", 200, COMMENT), route("/items/19804478", 200, STORY)]);
    let item = capture(&adapter(&server.base), "https://news.ycombinator.com/item?id=19805123").unwrap();
    server.finish();
    assert_eq!(item.id, "hn:19804478");
    assert_eq!(item.url.as_deref(), Some("https://news.ycombinator.com/item?id=19804478"));
    assert_eq!(item.extras["comment"], 19805123);
}

#[test]
fn ask_hn_text_and_failures() {
    let ask = r#"{"id": 7, "type": "story", "author": "a", "title": "Ask HN: Why?", "text": "Why <i>now</i>?<p>Second.", "children": []}"#;
    let server = serve(vec![route("/items/7", 200, ask), route("/items/8", 404, "{}"), route("/items/9", 200, "not json")]);
    let adapter = adapter(&server.base);
    let item = capture(&adapter, "https://news.ycombinator.com/item?id=7").unwrap();
    assert_eq!(item.body, "Why *now*?\n\nSecond.");
    assert_eq!(item.extras["includedComments"], 0);
    assert_eq!(capture(&adapter, "https://news.ycombinator.com/item?id=8"), Err(Error::Unavailable));
    assert_eq!(capture(&adapter, "https://news.ycombinator.com/item?id=9"), Err(Error::Unavailable));
    server.finish();
}

#[test]
fn comment_html_is_converted_and_escaped() {
    assert_eq!(html_markdown("a &amp; b &lt;c&gt; &#x2F; &#39;"), "a & b \\<c\\> / '");
    assert_eq!(html_markdown("- dash<p>+ plus<p>*star*"), "\\- dash\n\n\\+ plus\n\n\\*star\\*");
    assert_eq!(html_markdown("<a href=\"ftp://x\">x</a>"), "x");
    assert_eq!(html_markdown("<pre><code>a ``` b</code></pre>"), "````\na ``` b\n````");
    assert_eq!(html_markdown("unclosed <a href=\"https://e.org\">link"), "unclosed link");
}

#[test]
#[ignore = "touches the network: cargo test -p kintsugi-ingest -- --ignored live_hn_thread"]
fn live_hn_thread() {
    let adapter = HackerNewsAdapter::new().unwrap();
    let item = capture(&adapter, "https://news.ycombinator.com/item?id=19804478").unwrap();
    assert_eq!(item.id, "hn:19804478");
    assert!(item.body.contains("## Comments"));
    assert!(item.body.contains(" · [link](<https://news.ycombinator.com/item?id="));
    eprintln!("{} chars, {} comments", item.body.chars().count(), item.extras["includedComments"]);
}
