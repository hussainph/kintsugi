//! Static extraction: declared metadata plus the readable article as
//! Markdown. Pure, so it is tested on saved pages without any network.

use super::allowed_url;
use crate::{BODY_CHARS, markdown};
use dom_query::Document;
use dom_smoothie::{Config, Readability, TextMode};
use reqwest::Url;

/// Elements never worth reading when Readability gives up.
const CHROME: &[&str] = &[
    "script", "style", "noscript", "nav", "header", "footer", "aside", "form", "svg", "template", "iframe", "button",
    "head", "meta", "link", "select", "dialog",
];

/// Real pages nest a few dozen levels; far beyond that is not an article.
const MAX_READABILITY_DEPTH: usize = 256;
/// Readability's default character threshold.
const SHORT_ARTICLE_CHARS: usize = 500;

#[derive(Debug, Default)]
pub(crate) struct Extracted {
    pub canonical: Option<Url>,
    pub title: Option<String>,
    pub author: Option<String>,
    pub site: Option<String>,
    pub description: Option<String>,
    pub published: Option<String>,
    pub modified: Option<String>,
    pub lang: Option<String>,
    pub image_url: Option<Url>,
    pub body: String,
    pub extractor: &'static str,
}

pub(crate) fn page(html: &str, url: &Url) -> Extracted {
    let doc = Document::from(html);
    let meta = |keys: &[&str]| -> Option<String> {
        for key in keys {
            for element in doc.select("meta").iter() {
                let name = element.attr("property").or_else(|| element.attr("name"));
                if name.is_some_and(|name| name.eq_ignore_ascii_case(key))
                    && let Some(value) = element.attr("content").and_then(|s| markdown::field(&s, 2000))
                {
                    return Some(value);
                }
            }
        }
        None
    };
    let mut page = Extracted {
        title: meta(&["og:title", "twitter:title"])
            .or_else(|| doc.select("title").iter().next().and_then(|el| markdown::field(&el.text(), 500))),
        site: meta(&["og:site_name", "application-name"]),
        author: meta(&["author", "article:author", "twitter:creator"]),
        description: meta(&["og:description", "twitter:description", "description"]),
        published: meta(&["article:published_time", "datePublished", "date"]),
        modified: meta(&["article:modified_time", "dateModified"]),
        image_url: meta(&["og:image:secure_url", "og:image", "twitter:image", "twitter:image:src"])
            .and_then(|s| url.join(&s).ok())
            .filter(allowed_url),
        canonical: canonical(&doc, url),
        ..Extracted::default()
    };
    // Hidden text is not what the reader saw.
    doc.select(r#"[hidden], [aria-hidden="true"], [style*="display:none"], [style*="display: none"]"#).remove();
    let fallback = || {
        // Small or unstructured pages: the largest explicit main region, else
        // the body, without page chrome.
        let regions = doc.select("article, main, [role=main]");
        let roots = if regions.is_empty() { doc.select("body") } else { regions };
        roots
            .nodes()
            .iter()
            .map(|root| {
                let text = root.md(Some(CHROME));
                markdown::body(&text, BODY_CHARS)
            })
            .max_by_key(|s| s.chars().count())
            .unwrap_or_default()
    };
    let fallback_body = fallback();
    let config = Config {
        text_mode: TextMode::Markdown,
        // Untrusted pages can be huge; Readability refuses beyond this rather
        // than spending seconds scoring them, and the fallback still reads them.
        max_elements_to_parse: 60_000,
        ..Config::default()
    };
    // Readability's cleanup is quadratic in nesting depth; adversarial or
    // broken markup gets the linear fallback instead of minutes of CPU.
    let article = (max_depth(&doc) <= MAX_READABILITY_DEPTH)
        .then(|| Readability::with_document(doc.clone(), Some(url.as_str()), Some(config)).ok())
        .flatten()
        .and_then(|mut r| r.parse().ok());
    match article {
        Some(article) => {
            let body = markdown::body(&article.text_content, BODY_CHARS);
            // Below its own length threshold, Readability settles for the
            // whole page; an explicit article/main region is the better read.
            if body.chars().count() >= SHORT_ARTICLE_CHARS || fallback_body.is_empty() {
                page.body = body;
                page.extractor = "readability";
            } else {
                page.body = fallback_body;
                page.extractor = "html";
            }
            fill(&mut page.title, Some(article.title.to_string()), 500);
            fill(&mut page.author, article.byline, 500);
            fill(&mut page.site, article.site_name, 500);
            fill(&mut page.description, article.excerpt, 2000);
            fill(&mut page.published, article.published_time, 100);
            fill(&mut page.modified, article.modified_time, 100);
            fill(&mut page.lang, article.lang, 40);
            if page.image_url.is_none() {
                page.image_url = article.image.and_then(|s| url.join(&s).ok()).filter(allowed_url);
            }
        }
        None => {
            page.body = fallback_body;
            page.extractor = "html";
        }
    }
    if page.lang.is_none() {
        page.lang = doc.select("html").attr("lang").and_then(|s| markdown::field(&s, 40));
    }
    if page.body.is_empty() {
        page.extractor = "none";
    }
    page
}

/// The deepest element nesting, measured without recursion.
fn max_depth(doc: &Document) -> usize {
    let mut deepest = 0;
    let mut stack = vec![(doc.root(), 0usize)];
    while let Some((node, depth)) = stack.pop() {
        deepest = deepest.max(depth);
        if deepest > MAX_READABILITY_DEPTH {
            break;
        }
        let mut child = node.first_child();
        while let Some(c) = child {
            if c.is_element() {
                stack.push((c, depth + 1));
            }
            child = c.next_sibling();
        }
    }
    deepest
}

fn fill(slot: &mut Option<String>, value: Option<String>, limit: usize) {
    if slot.is_none() {
        *slot = value.and_then(|v| markdown::field(&v, limit));
    }
}

/// A declared canonical URL, trusted only on the page's own host: a page
/// cannot claim to be someone else's article.
fn canonical(doc: &Document, url: &Url) -> Option<Url> {
    let declared = doc
        .select("link[rel=canonical]")
        .attr("href")
        .map(|s| s.to_string())
        .or_else(|| doc.select("meta[property='og:url']").attr("content").map(|s| s.to_string()))?;
    url.join(declared.trim()).ok().filter(allowed_url).filter(|c| c.host_str() == url.host_str())
}

/// Markdown for a small trusted-shape fragment such as an oEmbed's HTML.
pub(crate) fn fragment(html: &str) -> String {
    let doc = Document::from(html);
    let body = doc.select("body");
    body.nodes().first().map_or_else(String::new, |root| markdown::body(&root.md(Some(CHROME)), BODY_CHARS))
}
