use super::*;
use crate::test_http::{Server, run};
use crate::test_server::{route, serve};
use std::sync::{Arc, Mutex as StdMutex};

const HISTORY: &[u8] = include_bytes!("../../fixtures/catalogue/history.atom");
const PG: &[u8] = include_bytes!("../../fixtures/catalogue/pg-articles.html");
const LONG_FEED: &[u8] = include_bytes!("../../fixtures/catalogue/cohen-longform-feed.xml");
const LONG_MAP: &[u8] = include_bytes!("../../fixtures/catalogue/cohen-longform-sitemap.xml");
const BLOG_FEED: &[u8] = include_bytes!("../../fixtures/catalogue/cohen-blog-feed.xml");
const BLOG_MAP: &[u8] = include_bytes!("../../fixtures/catalogue/cohen-blog-posts.xml");
const BLOG_INDEX: &[u8] = include_bytes!("../../fixtures/catalogue/cohen-blog-index.xml");

fn limits() -> Limits {
    Limits {
        min_interval: Duration::ZERO,
        deadline: Duration::from_secs(5),
        ..Limits::default()
    }
}
fn catalogue() -> Catalogue {
    Catalogue::with_limits(limits()).unwrap()
}
fn url(s: &str) -> Url {
    Url::parse(s).unwrap()
}
fn html(path: &'static str, body: &str) -> (&'static str, u16, &'static str, Vec<u8>) {
    (path, 200, "text/html", body.as_bytes().to_vec())
}
fn xml(path: &'static str, body: &[u8]) -> (&'static str, u16, &'static str, Vec<u8>) {
    (path, 200, "application/xml", body.to_vec())
}
fn map(body: &str) -> String {
    format!("<urlset xmlns='http://www.sitemaps.org/schemas/sitemap/0.9'>{body}</urlset>")
}
fn atom(body: &str) -> String {
    format!(
        "<feed xmlns='http://www.w3.org/2005/Atom'><id>urn:test</id><title>Writing</title><updated>2024-01-01T00:00:00Z</updated>{body}</feed>"
    )
}

#[test]
fn feed_history_deduplicates_cycles_and_never_fetches_articles_or_media() {
    let server = Server::start(vec![xml("/feed", HISTORY), xml("/history.atom", HISTORY)]);
    let updates = Arc::new(StdMutex::new(vec![]));
    let log = updates.clone();
    let catalogue = catalogue().with_progress(move |p| log.lock().unwrap().push(p.entries_found));
    let report = run(catalogue.discover(&url(&server.url("/feed")), None)).unwrap();
    assert_eq!(report.entries.len(), 1);
    assert_eq!(report.entries[0].title, "Older & wiser");
    assert_eq!(report.entries[0].url, server.url("/older"));
    assert_eq!(
        report.entries[0].published_at.as_deref(),
        Some("2010-06-01T12:30:00+00:00")
    );
    assert_eq!(server.hits("/history.atom"), 1);
    assert_eq!(server.hits("/older"), 0);
    assert_eq!(server.hits("/never-image"), 0);
    assert_eq!(server.hits("/robots.txt"), 1);
    assert!(!updates.lock().unwrap().is_empty());
}

#[test]
fn rss_atom_archive_links_work_and_updated_is_not_publication() {
    let feed = br#"<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>Writing</title><atom:link rel="prev-archive" href="/old.atom"/></channel></rss>"#;
    let old = atom(
        "<entry><id>urn:undated</id><title>Undated</title><link href='/undated'/><updated>2010-01-01T00:00:00Z</updated></entry>",
    );
    let server = Server::start(vec![xml("/feed", feed), xml("/old.atom", old.as_bytes())]);
    let report = run(catalogue().discover(&url(&server.url("/feed")), None)).unwrap();
    assert_eq!(report.entries.len(), 1);
    assert!(report.entries[0].published_at.is_none());
    assert_eq!(server.hits("/undated"), 0);
}

#[test]
fn pg_table_index_is_metadata_only_with_relative_links() {
    let parsed = parse::document(
        PG,
        &url("https://paulgraham.com/articles.html"),
        Kind::Index,
    )
    .unwrap();
    assert_eq!(parsed.entries.len(), 3);
    assert_eq!(
        parsed.entries[0].url,
        "https://paulgraham.com/greatwork.html"
    );
    assert_eq!(parsed.entries[0].title, "How to Do Great Work");
    let server = Server::start(vec![xml("/articles.html", PG)]);
    let report = run(catalogue().discover(
        &url(&server.url("/missing-feed")),
        Some(&url(&server.url("/articles.html"))),
    ))
    .unwrap();
    assert_eq!(report.entries.len(), 3);
    assert_eq!(server.hits("/greatwork.html"), 0);
    assert_eq!(server.hits("/articles.html"), 1);
}

#[test]
fn recorded_pg_mirror_keeps_titles_and_never_fetches_articles_images_or_scripts() {
    let recorded = include_bytes!("../../fixtures/catalogue/pg-recorded.html");
    let parsed = parse::document(
        recorded,
        &url("https://paulgraham.com/articles.html"),
        Kind::Index,
    )
    .unwrap();
    assert_eq!(parsed.entries.len(), 4);
    assert_eq!(parsed.entries[0].title, "Beyond Smart");
    assert_eq!(parsed.entries[2].title, "How to Work Hard");
    assert_eq!(parsed.entries[2].url, "https://paulgraham.com/hwh.html");
    assert!(parsed.entries.iter().all(|e| e.published_at.is_none()));
    let server = Server::start(vec![xml("/articles.html", recorded)]);
    let report = run(catalogue().discover(&url(&server.url("/articles.html")), None)).unwrap();
    assert_eq!(report.entries.len(), 4);
    for path in ["/smart.html", "/hwh.html", "/cgi-bin/refsd"] {
        assert_eq!(server.hits(path), 0);
    }
}

#[test]
fn recorded_cohen_feeds_and_sitemaps_parse_without_article_fetches() {
    for (base, feed, sitemap) in [
        ("https://longform.asmartbear.com/", LONG_FEED, LONG_MAP),
        ("https://blog.asmartbear.com/", BLOG_FEED, BLOG_MAP),
    ] {
        let feed = parse::document(feed, &url(base), Kind::Feed).unwrap();
        assert!(feed.entries.len() >= 2);
        assert!(feed.entries.iter().all(|e| e.published_at.is_some()));
        let sitemap = parse::document(sitemap, &url(base), Kind::Sitemap).unwrap();
        assert!(sitemap.entries.len() >= 4);
        assert!(sitemap.entries.iter().all(|e| e.published_at.is_none()));
    }
    let parsed = parse::document(
        BLOG_INDEX,
        &url("https://blog.asmartbear.com/sitemap.xml"),
        Kind::Sitemap,
    )
    .unwrap();
    assert_eq!(parsed.links.len(), 1);
    assert_eq!(
        parsed.links[0].0.as_str(),
        "https://blog.asmartbear.com/post.xml"
    );
    for (feed, sitemap) in [(LONG_FEED, LONG_MAP), (BLOG_FEED, BLOG_MAP)] {
        let rewrite = |bytes: &[u8]| {
            String::from_utf8_lossy(bytes)
                .replace("https://longform.asmartbear.com", "{base}")
                .replace("https://blog.asmartbear.com", "{base}")
        };
        let server = Server::start(vec![
            xml("/feed", rewrite(feed).as_bytes()),
            xml("/sitemap.xml", rewrite(sitemap).as_bytes()),
        ]);
        let report = run(catalogue().discover(&url(&server.url("/feed")), None)).unwrap();
        assert!(report.entries.len() >= 5);
        assert_eq!(server.hits("/whos-lying/"), 0);
        assert_eq!(server.hits("/delegation/"), 0);
    }
}

#[test]
fn sitemap_indexes_filter_taxonomies_assets_and_cross_host_links() {
    let index = br#"<s:sitemapindex xmlns:s='http://www.sitemaps.org/schemas/sitemap/0.9'>
    <s:sitemap><s:loc>{base}/post.xml</s:loc></s:sitemap>
    <s:sitemap><s:loc>{base}/taxonomy_category.xml</s:loc></s:sitemap>
    <s:sitemap><s:loc>{base}/page.xml</s:loc></s:sitemap>
    <s:sitemap><s:loc>https://elsewhere.invalid/sitemap.xml</s:loc></s:sitemap>
    <s:sitemap><s:loc>{base}/sitemap.xml</s:loc></s:sitemap></s:sitemapindex>"#;
    let posts = map(
        "<url><loc>{base}/old-post/</loc><lastmod>2026-10-01</lastmod><image xmlns='urn:images'><loc>{base}/nested.jpg</loc></image></url><url><loc>{base}/tag/startup/</loc></url><url><loc>{base}/image.png</loc></url><url><loc>{base}/about</loc></url><url><loc>{base}/2024/02/</loc></url><url><loc>https://elsewhere.invalid/alien</loc></url>",
    );
    let server = Server::start(vec![
        xml("/sitemap.xml", index),
        xml("/post.xml", posts.as_bytes()),
    ]);
    let report = run(catalogue().discover(&url(&server.url("/feed")), None)).unwrap();
    assert_eq!(report.entries.len(), 1);
    assert_eq!(report.entries[0].title, "old post");
    assert!(report.entries[0].published_at.is_none());
    assert_eq!(server.hits("/taxonomy_category.xml"), 0);
    assert_eq!(server.hits("/page.xml"), 0);
    assert_eq!(server.hits("/old-post/"), 0);
    assert_eq!(server.hits("/sitemap.xml"), 1);
}

#[test]
fn robots_groups_specificity_allow_ties_patterns_and_percent_encoding() {
    let policy = Robots::parse(
        "User-agent: *\nDisallow: /\n\nUser-agent: Kintsugi\nDisallow: /private\nAllow: /private/open\nDisallow: /*.json$\nDisallow: /x%2fy\nDisallow: /café\nAllow: /tie\nDisallow: /tie\nCrawl-delay: 0.05\nSitemap: /map.xml\n\nUser-agent: Otherbot\nDisallow: /\n",
        &url("https://example.org/"),
    );
    for (path, allowed) in [
        ("/public", true),
        ("/private", false),
        ("/private/open", true),
        ("/a.json", false),
        ("/a.json?x=1", true),
        ("/x%2Fy", false),
        ("/café", false),
        ("/tie", true),
    ] {
        assert_eq!(
            policy.allows(&url(&format!("https://example.org{path}"))),
            allowed,
            "{path}"
        );
    }
    assert_eq!(policy.delay, Duration::from_millis(50));
    assert_eq!(policy.sitemaps, vec![url("https://example.org/map.xml")]);
}

#[test]
fn robots_disallow_stops_feed_archive_and_redirect_destination() {
    let server = serve(vec![
        route(
            "/robots.txt",
            200,
            "User-agent: *\nDisallow: /feed\nDisallow: /blocked\n",
        ),
        route("/", 301, "").header("Location: /blocked"),
    ]);
    let c = Catalogue::with_limits(Limits {
        max_pages: 2,
        ..limits()
    })
    .unwrap();
    let report = run(c.discover(&url(&format!("{}feed", server.base)), None)).unwrap();
    assert!(report.entries.is_empty());
    assert!(report.issues.iter().any(|i| i.error.contains("403")));
    let seen = server.finish();
    assert_eq!(seen.len(), 2);
    assert!(seen.iter().all(|(_, agent)| agent.contains("kintsugi/")));
}

#[test]
fn unavailable_robots_fails_closed_while_missing_robots_allows() {
    for status in [401, 403, 429, 503] {
        let server = Server::start(vec![
            ("/robots.txt", status, "text/plain", vec![]),
            xml("/feed", HISTORY),
        ]);
        let report = run(catalogue().discover(&url(&server.url("/feed")), None)).unwrap();
        assert_eq!(server.hits("/feed"), 0);
        assert!(report.entries.is_empty());
        assert!(!report.issues.is_empty());
    }
}

#[test]
fn robots_sitemap_and_html_archive_advertisements_are_followed() {
    let sitemap = map("<url><loc>{base}/old-one</loc></url>");
    let server = Server::start(vec![
        (
            "/robots.txt",
            200,
            "text/plain",
            b"User-agent: *\nSitemap: /custom-map.xml\n".to_vec(),
        ),
        xml("/custom-map.xml", sitemap.as_bytes()),
        html("/", "<a href='/writing-index'>All posts</a>"),
        html(
            "/writing-index",
            "<ul><li><a href='/old-two'>Older essay</a><time datetime='2005-02-03'>Feb 3, 2005</time></li></ul>",
        ),
    ]);
    let report = run(catalogue().discover(&url(&server.url("/feed")), None)).unwrap();
    assert_eq!(report.entries.len(), 2);
    assert!(
        report
            .entries
            .iter()
            .any(|e| e.published_at.as_deref() == Some("2005-02-03T00:00:00Z"))
    );
    assert_eq!(server.hits("/old-two"), 0);
}

#[test]
fn html_drops_chrome_lazy_content_credentials_and_cross_host_links() {
    let server = Server::start(vec![html(
        "/",
        r#"
    <nav><a href='/navigation'>Navigation</a></nav>
    <header><a href='/header'>Header</a></header>
    <main><article><header><h2><a href='/real'>Real title</a></h2></header><time datetime='2012-01-01'/></article>
    <li><a href='https://elsewhere.invalid/archive/'>Alien</a></li>
    <li><a href='http://user:secret@127.0.0.1/private'>Secret</a></li>
    <a data-href='/lazy'>Lazy data link</a><img loading='lazy' src='/image'>
    <script>fetch('/injected')</script><noscript><a href='/no'>Fallback</a></noscript>
    <a href='javascript:alert(1)'>Click</a><a href='/asset.pdf'>PDF</a><a href='/about'>About</a>
    <div hidden><a href='/hidden'>Hidden</a></div><p><a href='/citation'>Citation</a></p></main>"#,
    )]);
    let report = run(catalogue().discover(&url(&server.url("/feed")), None)).unwrap();
    assert_eq!(report.entries.len(), 1, "{:#?}", report.entries);
    assert_eq!(report.entries[0].title, "Real title");
    for path in [
        "/real",
        "/lazy",
        "/image",
        "/injected",
        "/no",
        "/hidden",
        "/navigation",
    ] {
        assert_eq!(server.hits(path), 0);
    }
}

#[test]
fn redirects_cannot_escape_hosts_or_gain_credentials_and_are_bounded() {
    for location in [
        "https://elsewhere.invalid/feed",
        "http://u:p@127.0.0.1/private",
        "file:///etc/passwd",
    ] {
        let server = serve(vec![
            route("/robots.txt", 404, ""),
            route("/feed", 301, "").header(&format!("Location: {location}")),
        ]);
        let c = Catalogue::with_limits(Limits {
            max_pages: 1,
            ..limits()
        })
        .unwrap();
        let report = run(c.discover(&url(&format!("{}feed", server.base)), None)).unwrap();
        assert!(report.entries.is_empty());
        assert!(!report.issues.is_empty());
        assert_eq!(server.finish().len(), 2);
    }
    let server = serve(vec![
        route("/robots.txt", 404, ""),
        route("/feed", 301, "").header("Location: /loop"),
        route("/loop", 301, "").header("Location: /feed"),
    ]);
    let c = Catalogue::with_limits(Limits {
        max_pages: 1,
        max_redirects: 1,
        ..limits()
    })
    .unwrap();
    let report = run(c.discover(&url(&format!("{}feed", server.base)), None)).unwrap();
    assert!(!report.issues.is_empty());
    assert_eq!(server.finish().len(), 3);
}

#[test]
fn page_entry_and_byte_bounds_are_reported() {
    let server = Server::start(vec![xml("/feed", HISTORY)]);
    let c = Catalogue::with_limits(Limits {
        max_pages: 1,
        ..limits()
    })
    .unwrap();
    let report = run(c.discover(&url(&server.url("/feed")), None)).unwrap();
    assert!(report.truncated);
    assert_eq!(report.pages_fetched, 1);
    assert_eq!(server.hits("/"), 0);
    let posts = map("<url><loc>{base}/one</loc></url><url><loc>{base}/two</loc></url>");
    let server = Server::start(vec![xml("/sitemap.xml", posts.as_bytes())]);
    let c = Catalogue::with_limits(Limits {
        max_entries: 1,
        ..limits()
    })
    .unwrap();
    let report = run(c.discover(&url(&server.url("/sitemap.xml")), None)).unwrap();
    assert!(report.truncated);
    assert_eq!(report.entries.len(), 1);
    for (page_bytes, total_bytes) in [(8, 4096), (4096, 8)] {
        let c = Catalogue::with_limits(Limits {
            page_bytes,
            total_bytes,
            max_pages: 1,
            ..limits()
        })
        .unwrap();
        let report = run(c.discover(&url(&server.url("/sitemap.xml")), None)).unwrap();
        assert!(report.truncated);
        assert!(report.entries.is_empty());
    }
}

#[test]
fn oversized_stream_and_gzip_expansion_are_bounded() {
    use std::io::Write;
    let mut gzip = flate2::write::GzEncoder::new(vec![], flate2::Compression::default());
    gzip.write_all(&vec![b'x'; 10_000]).unwrap();
    let compressed = gzip.finish().unwrap();
    let server = Server::start(vec![xml("/map.xml.gz", &compressed)]);
    let c = Catalogue::with_limits(Limits {
        page_bytes: 128,
        max_pages: 1,
        ..limits()
    })
    .unwrap();
    let report = run(c.discover(&url(&server.url("/map.xml.gz")), None)).unwrap();
    assert!(report.truncated);
    assert!(report.entries.is_empty());
    let server = serve(vec![
        route("/robots.txt", 404, ""),
        route(
            "/feed",
            200,
            format!("64\r\n{}\r\n0\r\n\r\n", "x".repeat(100)),
        )
        .header("Transfer-Encoding: chunked"),
    ]);
    let c = Catalogue::with_limits(Limits {
        page_bytes: 32,
        max_pages: 1,
        ..limits()
    })
    .unwrap();
    let report = run(c.discover(&url(&format!("{}feed", server.base)), None)).unwrap();
    assert!(report.entries.is_empty());
    assert!(report.truncated);
    assert!(
        report
            .issues
            .iter()
            .any(|i| i.error == Error::TooLarge.to_string())
    );
    server.finish();
}

#[test]
fn polite_interval_and_crawl_delay_apply_to_every_origin_request() {
    let server = Server::start(vec![
        (
            "/robots.txt",
            200,
            "text/plain",
            b"User-agent: *\nCrawl-delay: 0.04\n".to_vec(),
        ),
        xml("/feed", HISTORY),
    ]);
    let c = Catalogue::with_limits(Limits {
        max_pages: 2,
        min_interval: Duration::from_millis(25),
        ..limits()
    })
    .unwrap();
    let started = std::time::Instant::now();
    run(c.discover(&url(&server.url("/feed")), None)).unwrap();
    assert!(started.elapsed() >= Duration::from_millis(75));
    assert_eq!(server.hits("/robots.txt"), 1);
}

#[test]
fn reused_catalogue_shares_rate_limits_between_discoveries() {
    let server = Server::start(vec![xml("/feed", HISTORY)]);
    let c = Catalogue::with_limits(Limits {
        max_pages: 1,
        min_interval: Duration::from_millis(25),
        ..limits()
    })
    .unwrap();
    let started = std::time::Instant::now();
    run(async {
        let a = url(&server.url("/feed"));
        let (a, b) = tokio::join!(c.discover(&a, None), c.discover(&a, None));
        assert_eq!(a.unwrap().entries.len(), 1);
        assert_eq!(b.unwrap().entries.len(), 1);
    });
    assert!(started.elapsed() >= Duration::from_millis(70));
}

#[test]
fn overall_deadline_keeps_partial_results() {
    let server = Server::start(vec![xml("/feed", HISTORY)]);
    let c = Catalogue::with_limits(Limits {
        min_interval: Duration::from_millis(140),
        deadline: Duration::from_millis(250),
        ..limits()
    })
    .unwrap();
    let report = run(c.discover(&url(&server.url("/feed")), None)).unwrap();
    assert!(report.truncated);
    assert_eq!(report.entries.len(), 1);
    assert_eq!(server.hits("/"), 0);
    assert!(
        report
            .issues
            .iter()
            .any(|i| i.error == Error::TimedOut.to_string())
    );
}

#[test]
fn invalid_input_is_rejected_without_requests() {
    for bad in [
        "https://user:password@example.org/feed",
        "file:///tmp/feed",
        "ftp://example.org/",
    ] {
        assert!(matches!(
            run(catalogue().discover(&url(bad), None)),
            Err(Error::InvalidUrl)
        ));
        assert!(matches!(
            run(catalogue().discover(&url("https://example.org/feed"), Some(&url(bad)))),
            Err(Error::InvalidUrl)
        ));
    }
}

#[test]
fn full_feed_history_is_not_limited_to_the_pollers_hundred_items() {
    let entries: String = (0..150).map(|n| format!("<entry><id>urn:{n}</id><title>Essay {n}</title><link href='/essay-{n}'/><updated>2001-01-01T00:00:00Z</updated></entry>")).collect();
    let server = Server::start(vec![xml("/feed", atom(&entries).as_bytes())]);
    let report = run(catalogue().discover(&url(&server.url("/feed")), None)).unwrap();
    assert_eq!(report.entries.len(), 150);
    assert_eq!(server.hits("/essay-149"), 0);
}

#[test]
fn explicitly_supplied_other_origin_checks_its_own_robots_after_redirect() {
    let destination = Server::start(vec![(
        "/robots.txt",
        200,
        "text/plain",
        b"User-agent: *\nDisallow: /blocked\n".to_vec(),
    )]);
    let source = serve(vec![
        route("/robots.txt", 404, ""),
        route("/feed", 301, "").header(&format!("Location: {}", destination.url("/blocked"))),
    ]);
    let c = Catalogue::with_limits(Limits {
        max_pages: 1,
        ..limits()
    })
    .unwrap();
    let report = run(c.discover(
        &url(&format!("{}feed", source.base)),
        Some(&url(&destination.url("/"))),
    ))
    .unwrap();
    assert!(report.entries.is_empty());
    assert_eq!(destination.hits("/robots.txt"), 1);
    assert_eq!(destination.hits("/blocked"), 0);
    assert_eq!(source.finish().len(), 2);
}

#[test]
fn rate_limit_stops_further_probes_on_that_origin() {
    let server = Server::start(vec![("/feed", 429, "text/plain", vec![])]);
    let report = run(catalogue().discover(&url(&server.url("/feed")), None)).unwrap();
    assert!(report.entries.is_empty());
    assert_eq!(server.hits("/feed"), 1);
    assert_eq!(server.hits("/"), 0);
    assert_eq!(server.hits("/sitemap.xml"), 0);
}

#[test]
fn gzipped_sitemap_and_xml_entities_are_read_without_fetching_entries() {
    use std::io::Write;
    // The fixture server substitutes UTF-8 bodies, not gzip. Use a relative
    // location so the compressed fixture still resolves onto loopback.
    let mut gzip = flate2::write::GzEncoder::new(vec![], flate2::Compression::default());
    gzip.write_all(map("<url><loc>/essay?a=1&amp;b=2</loc></url>").as_bytes())
        .unwrap();
    let compressed_server = Server::start(vec![xml("/map.xml.gz", &gzip.finish().unwrap())]);
    let report =
        run(catalogue().discover(&url(&compressed_server.url("/map.xml.gz")), None)).unwrap();
    assert_eq!(report.entries.len(), 1);
    assert_eq!(
        report.entries[0].url,
        compressed_server.url("/essay?a=1&b=2")
    );
    assert_eq!(compressed_server.hits("/essay?a=1&b=2"), 0);
}
