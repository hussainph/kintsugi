use super::{Entry, Kind, Parsed};
use crate::{
    Url,
    web::{allowed_url, canonical_url},
};
use chrono::{DateTime, NaiveDate};
use dom_query::Document;

pub(super) fn document(bytes: &[u8], base: &Url, kind: Kind) -> Option<Parsed> {
    let text = String::from_utf8_lossy(bytes);
    if let Ok(xml) = roxmltree::Document::parse(&text) {
        let root = xml.root_element();
        match root.tag_name().name() {
            "sitemapindex" => {
                let links = root
                    .children()
                    .filter(|n| {
                        n.has_tag_name((root.tag_name().namespace().unwrap_or(""), "sitemap"))
                            || n.tag_name().name() == "sitemap"
                    })
                    .filter_map(|n| child(n, "loc"))
                    .filter_map(|s| resolve(base, s))
                    .filter(|u| useful_sitemap(u))
                    .map(|u| (u, Kind::Sitemap))
                    .collect();
                return Some(Parsed {
                    entries: vec![],
                    links,
                });
            }
            "urlset" => {
                let entries = root
                    .children()
                    .filter(|n| n.is_element() && n.tag_name().name() == "url")
                    .filter_map(|n| child(n, "loc"))
                    .filter_map(|s| resolve(base, s))
                    .filter(article_url)
                    .map(|url| Entry {
                        title: url_title(&url),
                        url: url.to_string(),
                        published_at: None,
                    })
                    .collect();
                return Some(Parsed {
                    entries,
                    links: vec![],
                });
            }
            _ => {}
        }
    }
    if let Ok(feed) = feed_rs::parser::Builder::new()
        .base_uri(Some(base.as_str()))
        .build()
        .parse(bytes)
    {
        let entries = feed
            .entries
            .into_iter()
            .filter_map(|entry| {
                let url = entry
                    .links
                    .iter()
                    .find(|l| {
                        l.rel.as_deref().is_none_or(|r| r == "alternate")
                            && l.media_type.as_deref().is_none_or(|t| t.contains("html"))
                    })
                    .and_then(|l| resolve(base, &l.href))?;
                let title = entry
                    .title
                    .map(|t| plain(&t.content))
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| url_title(&url));
                Some(Entry {
                    url: url.to_string(),
                    title,
                    published_at: entry.published.map(|d| d.to_rfc3339()),
                })
            })
            .collect();
        let links = feed
            .links
            .iter()
            .filter_map(|l| match l.rel.as_deref() {
                Some("next" | "prev-archive" | "last") => {
                    resolve(base, &l.href).map(|u| (u, Kind::Feed))
                }
                // A homepage must still pass the caller's host scope.
                None | Some("alternate") => resolve(base, &l.href).map(|u| (u, Kind::Index)),
                _ => None,
            })
            .collect();
        return Some(Parsed { entries, links });
    }
    // A broken sitemap isn't an HTML index full of arbitrary XML text.
    if matches!(kind, Kind::Sitemap) || !text.contains('<') {
        return None;
    }
    Some(html(&text, base))
}

fn child<'a>(node: roxmltree::Node<'a, '_>, name: &str) -> Option<&'a str> {
    node.children()
        .find(|n| n.is_element() && n.tag_name().name() == name)
        .and_then(|n| n.text())
        .map(str::trim)
}

fn resolve(base: &Url, href: &str) -> Option<Url> {
    base.join(href.trim())
        .ok()
        .filter(allowed_url)
        .map(|u| canonical_url(&u))
}

fn html(text: &str, base: &Url) -> Parsed {
    let doc = Document::from(text);
    // Never follow lazy content, images, scripts, or JS-provided links.
    doc.select("nav, footer, aside, script, style, noscript, template, svg, form, [hidden], [aria-hidden=true]").remove();
    let mut parsed = Parsed {
        entries: vec![],
        links: vec![],
    };
    let archive_page = is_index(base) || base.path() == "/" || base.path().ends_with("index.html");
    for a in doc.select("a[href], link[href]").iter() {
        let Some(href) = a.attr("href") else { continue };
        if href.starts_with('#') {
            continue;
        }
        let Some(url) = resolve(base, &href) else {
            continue;
        };
        if url == *base {
            continue;
        }
        let rel = a.attr("rel").unwrap_or_default();
        let text = a.text();
        let label = plain(&text);
        if rel.split_whitespace().any(|r| r == "next" || r == "prev")
            || is_index(&url)
            || matches!(
                label.to_ascii_lowercase().as_str(),
                "archive" | "archives" | "all posts" | "all articles" | "essays" | "older posts"
            )
        {
            parsed.links.push((url, Kind::Index));
            continue;
        }
        if a.is("link") || !article_url(&url) {
            continue;
        }
        let ancestors = a.ancestors(Some(64));
        // Exclude header chrome, but keep article headers and their titles.
        if ancestors.is("header") && !ancestors.is("article") {
            continue;
        }
        let heading = a.select("h1, h2, h3, h4").text();
        let title = if !heading.trim().is_empty() {
            plain(&heading)
        } else {
            label
        };
        if title.is_empty() || title.chars().count() < 3 {
            continue;
        }
        let structured = ancestors.is("h1, h2, h3, h4, li, td, .post-title, .entry-title")
            || !heading.is_empty();
        if !structured && !archive_page {
            continue;
        }
        // On a homepage an ordinary paragraph link is often a citation.
        if ancestors.is("p") && !structured {
            continue;
        }
        let row = ancestors
            .iter()
            .find(|s| s.is("li, tr, article, .post, .entry, .post-card"));
        let published_at = row.and_then(|row| {
            let time =
                row.select("time, .published, .post-date, .entry-date, [itemprop=datePublished]");
            time.attr("datetime")
                .or_else(|| time.attr("content"))
                .and_then(|s| date(&s))
                .or_else(|| date(&time.text()))
        });
        parsed.entries.push(Entry {
            url: url.to_string(),
            title,
            published_at,
        });
    }
    for url in crate::feed::feed_links(text, base) {
        parsed.links.push((url, Kind::Feed));
    }
    parsed
}

fn plain(text: &str) -> String {
    let doc = Document::from(text);
    doc.select("script, style, svg").remove();
    crate::text::label(&doc.text(), 300)
}

fn date(text: &str) -> Option<String> {
    let text = text.trim();
    if let Ok(d) = DateTime::parse_from_rfc3339(text) {
        return Some(d.to_rfc3339());
    }
    for format in ["%Y-%m-%d", "%B %e, %Y", "%b %e, %Y", "%e %B %Y", "%Y/%m/%d"] {
        if let Ok(d) = NaiveDate::parse_from_str(text, format) {
            return Some(format!("{}T00:00:00Z", d.format("%Y-%m-%d")));
        }
    }
    None
}

fn is_index(url: &Url) -> bool {
    let path = url.path().trim_matches('/').to_ascii_lowercase();
    matches!(
        path.as_str(),
        "archive"
            | "archives"
            | "articles"
            | "essays"
            | "posts"
            | "blog"
            | "articles.html"
            | "archive.html"
            | "archives.html"
    ) || path.starts_with("page/")
        || url
            .query_pairs()
            .any(|(k, _)| matches!(k.as_ref(), "page" | "paged"))
}

fn useful_sitemap(url: &Url) -> bool {
    let file = url
        .path()
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    !(matches!(file.as_str(), "site.xml" | "page.xml")
        || file.starts_with("taxonomy_")
        || ["category", "tag", "author", "image", "video", "attachment"]
            .iter()
            .any(|s| file.starts_with(&format!("{s}-"))))
}

fn article_url(url: &Url) -> bool {
    let path = url.path().trim_matches('/').to_ascii_lowercase();
    if path.is_empty() || is_index(url) {
        return false;
    }
    if path.split('/').any(|s| {
        matches!(
            s,
            "about"
                | "about.html"
                | "contact"
                | "contact.html"
                | "privacy"
                | "privacy-policy"
                | "terms"
                | "subscribe"
                | "search"
                | "feed"
                | "rss"
                | "tag"
                | "tags"
                | "category"
                | "categories"
                | "author"
                | "authors"
                | "wp-content"
                | "wp-admin"
                | "ref"
        )
    }) {
        return false;
    }
    if path.split('/').all(|s| s.parse::<u32>().is_ok()) {
        return false;
    }
    let last = path.rsplit('/').next().unwrap_or("");
    last.rsplit_once('.')
        .is_none_or(|(_, ext)| matches!(ext, "html" | "htm" | "xhtml"))
}

pub(super) fn url_title(url: &Url) -> String {
    let slug = url
        .path()
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("");
    let slug = slug
        .strip_suffix(".html")
        .or_else(|| slug.strip_suffix(".htm"))
        .unwrap_or(slug);
    crate::text::label(&slug.replace(['-', '_'], " "), 300)
}
