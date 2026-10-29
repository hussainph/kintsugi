//! Bounded, best-effort page extraction. A login wall is still useful metadata;
//! a failed thumbnail must not prevent a shared passage from being enriched.

use futures_util::StreamExt;
use reqwest::{Client, Url};
use scraper::{ElementRef, Html, Selector};
use serde::Deserialize;
use std::time::Duration;

pub const SOURCE_CHARS: usize = 20_000;
const HTML_BYTES: usize = 2 * 1024 * 1024;
const OEMBED_BYTES: usize = 256 * 1024;
const IMAGE_BYTES: usize = 8 * 1024 * 1024;
const USER_AGENT: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15 Kintsugi/0.1";
type Result<T> = std::result::Result<T, String>;

#[derive(Debug, Default, Clone)]
pub struct Page {
    pub title: Option<String>,
    pub site: Option<String>,
    pub author: Option<String>,
    pub description: Option<String>,
    pub source_text: String,
    pub image: Option<Image>,
}

#[derive(Debug, Clone)]
pub struct Image {
    pub bytes: Vec<u8>,
    pub mime: String,
}

#[derive(Debug, Default)]
struct Parsed {
    page: Page,
    image_url: Option<Url>,
}

/// Reused across clips, with the same policy applied to every redirect.
pub struct Fetcher(Client);

impl Fetcher {
    pub fn new() -> Result<Self> {
        Client::builder()
            .user_agent(USER_AGENT)
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= 5 || !allowed_url(attempt.url()) {
                    attempt.error("unsupported redirect")
                } else {
                    attempt.follow()
                }
            }))
            .build()
            .map(Self)
            .map_err(|_| "could not start page fetcher".into())
    }

    /// Image downloads are skipped when the capture already has its own image.
    pub async fn fetch(&self, url: &str, want_image: bool) -> Result<Page> {
        let url = web_url(url)?;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(45);
        let parsed = tokio::time::timeout_at(deadline, self.fetch_page(url, want_image))
            .await
            .map_err(|_| "page fetch timed out".to_string())??;
        Ok(self.with_image(parsed, want_image, deadline).await)
    }

    async fn fetch_page(&self, url: Url, want_image: bool) -> Result<Parsed> {
        let html = self.download(url.clone(), HTML_BYTES, Some(IMAGE_BYTES)).await;
        let mut parsed = match &html {
            Ok(body) if is_html(body) => parse_html(&String::from_utf8_lossy(&body.bytes), &body.url),
            _ => Parsed::default(),
        };
        let mut useful = html.as_ref().is_ok_and(is_html);
        // Short links may only reveal their platform after the HTML redirect.
        let endpoint = oembed_url(&url).or_else(|| html.as_ref().ok().and_then(|body| oembed_url(&body.url)));
        if let Some(endpoint) = endpoint {
            if let Ok(body) = self.get(endpoint, OEMBED_BYTES).await {
                if let Ok(embed) = serde_json::from_slice::<OEmbed>(&body.bytes) {
                    useful = true;
                    merge_embed(&mut parsed, embed, &url);
                }
            }
        }
        // A directly shared image URL need not pretend to be an HTML page.
        if let Ok(body) = &html {
            if let Some(mime) = image_mime(&body.bytes) {
                useful = true;
                if want_image {
                    parsed.page.image = Some(Image {
                        bytes: body.bytes.clone(),
                        mime: mime.into(),
                    });
                }
            }
        }
        if !useful {
            return Err("could not fetch source page".into());
        }
        Ok(parsed)
    }

    async fn with_image(&self, mut parsed: Parsed, want_image: bool, deadline: tokio::time::Instant) -> Page {
        if want_image && parsed.page.image.is_none() {
            if let Some(url) = parsed.image_url {
                // A slow thumbnail can exhaust the fetch budget, but never
                // discards page metadata or readable text already collected.
                if let Ok(Ok(body)) = tokio::time::timeout_at(deadline, self.get(url, IMAGE_BYTES)).await {
                    if let Some(mime) = image_mime(&body.bytes) {
                        parsed.page.image = Some(Image {
                            bytes: body.bytes,
                            mime: mime.into(),
                        });
                    }
                }
            }
        }
        parsed.page
    }

    async fn get(&self, url: Url, limit: usize) -> Result<Body> {
        self.download(url, limit, None).await
    }

    async fn download(&self, url: Url, limit: usize, image_limit: Option<usize>) -> Result<Body> {
        if !allowed_url(&url) {
            return Err("source must use http or https without credentials".into());
        }
        let response = self.0.get(url).send().await.map_err(|_| "source request failed")?;
        if !response.status().is_success() {
            return Err("source returned an unsuccessful status".into());
        }
        let url = response.url().clone();
        let mime = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        let limit = if mime.starts_with("image/") {
            image_limit.unwrap_or(limit)
        } else {
            limit
        };
        if response.content_length().is_some_and(|n| n > limit as u64) {
            return Err("source exceeds download limit".into());
        }
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| "source download failed")?;
            if chunk.len() > limit.saturating_sub(bytes.len()) {
                return Err("source exceeds download limit".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(Body { bytes, mime, url })
    }
}

struct Body {
    bytes: Vec<u8>,
    mime: String,
    url: Url,
}

fn allowed_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https") && url.host_str().is_some() && url.username().is_empty() && url.password().is_none()
}

fn web_url(raw: &str) -> Result<Url> {
    Url::parse(raw)
        .ok()
        .filter(allowed_url)
        .ok_or_else(|| "source must use http or https without credentials".into())
}

fn is_html(body: &Body) -> bool {
    body.mime.starts_with("text/html")
        || body.mime.starts_with("application/xhtml+xml")
        || (body.mime.is_empty()
            && std::str::from_utf8(&body.bytes).is_ok()
            && !body.bytes.contains(&0)
            && image_mime(&body.bytes).is_none())
}

fn selector(s: &str) -> Selector {
    Selector::parse(s).expect("static HTML selector")
}

fn clean(s: &str, limit: usize) -> Option<String> {
    let text: String = s.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(limit).collect();
    (!text.is_empty()).then_some(text)
}

fn parse_html(html: &str, url: &Url) -> Parsed {
    let doc = Html::parse_document(html);
    let meta = |keys: &[&str]| -> Option<String> {
        for key in keys {
            for element in doc.select(&selector("meta")) {
                let name = element.value().attr("property").or_else(|| element.value().attr("name"));
                if name.is_some_and(|name| name.eq_ignore_ascii_case(key)) {
                    if let Some(value) = element.value().attr("content").and_then(|s| clean(s, 2000)) {
                        return Some(value);
                    }
                }
            }
        }
        None
    };
    let title = meta(&["og:title", "twitter:title"]).or_else(|| {
        doc.select(&selector("title"))
            .next()
            .and_then(|el| clean(&el.text().collect::<String>(), 500))
    });
    let image_url = meta(&["og:image:secure_url", "og:image", "twitter:image", "twitter:image:src"])
        .and_then(|s| url.join(&s).ok())
        .filter(allowed_url);
    let page = Page {
        title,
        site: meta(&["og:site_name", "application-name"]),
        author: meta(&["author", "article:author", "twitter:creator"]),
        description: meta(&["og:description", "twitter:description", "description"]),
        source_text: readable(&doc),
        image: None,
    };
    Parsed { page, image_url }
}

fn readable(doc: &Html) -> String {
    // Prefer the largest explicit article/main, rather than including menus and
    // related-story cards. Fall back to the body for small, unstructured pages.
    let roots: Vec<_> = doc.select(&selector("article, main, [role=main]")).collect();
    let roots = if roots.is_empty() {
        doc.select(&selector("body")).collect()
    } else {
        roots
    };
    roots
        .into_iter()
        .map(|root| {
            let mut text = String::new();
            let mut remaining = SOURCE_CHARS;
            append_text(root, &mut text, &mut remaining, 0);
            text.trim().to_string()
        })
        .max_by_key(|s| s.chars().count())
        .unwrap_or_default()
}

fn append_text(element: ElementRef<'_>, out: &mut String, remaining: &mut usize, depth: usize) {
    // Arbitrarily nested untrusted HTML must not overflow the worker's stack.
    if depth > 128 || *remaining == 0 {
        return;
    }
    let name = element.value().name();
    if matches!(
        name,
        "script" | "style" | "noscript" | "nav" | "header" | "footer" | "aside" | "form" | "svg" | "template"
    ) || element.value().attr("hidden").is_some()
        || element.value().attr("aria-hidden") == Some("true")
    {
        return;
    }
    let block = matches!(
        name,
        "p" | "div" | "section" | "article" | "main" | "li" | "blockquote" | "h1" | "h2" | "h3" | "h4" | "br" | "pre"
    );
    if block {
        append_bounded(out, "\n", remaining);
    }
    for child in element.children() {
        if *remaining == 0 {
            break;
        }
        if let Some(text) = child.value().as_text() {
            // Keep a boundary between inline nodes while collapsing page layout whitespace.
            let words = text.split_whitespace().collect::<Vec<_>>().join(" ");
            if !words.is_empty() {
                if !out.is_empty() && !out.ends_with([' ', '\n']) {
                    append_bounded(out, " ", remaining);
                }
                append_bounded(out, &words, remaining);
            }
        } else if let Some(element) = ElementRef::wrap(child) {
            append_text(element, out, remaining, depth + 1);
        }
    }
    if block && !out.ends_with('\n') {
        append_bounded(out, "\n", remaining);
    }
}

fn append_bounded(out: &mut String, text: &str, remaining: &mut usize) {
    for ch in text.chars().take(*remaining) {
        out.push(ch);
        *remaining -= 1;
    }
}

#[derive(Deserialize)]
struct OEmbed {
    title: Option<String>,
    author_name: Option<String>,
    provider_name: Option<String>,
    thumbnail_url: Option<String>,
    html: Option<String>,
}

fn merge_embed(parsed: &mut Parsed, embed: OEmbed, url: &Url) {
    parsed.page.title = parsed.page.title.take().or_else(|| embed.title.and_then(|s| clean(&s, 500)));
    parsed.page.author = parsed.page.author.take().or_else(|| embed.author_name.and_then(|s| clean(&s, 500)));
    parsed.page.site = parsed.page.site.take().or_else(|| embed.provider_name.and_then(|s| clean(&s, 500)));
    parsed.image_url = parsed
        .image_url
        .take()
        .or_else(|| embed.thumbnail_url.and_then(|s| url.join(&s).ok()).filter(allowed_url));
    if let Some(html) = embed.html {
        let text = readable(&Html::parse_document(&html));
        // A social page often renders only a login prompt. Its oEmbed contains
        // the actual post; video iframe embeds contain no text, so keep HTML.
        if !text.is_empty() {
            parsed.page.source_text = text;
        }
    }
}

fn oembed_url(url: &Url) -> Option<Url> {
    let host = url.host_str()?.trim_start_matches("www.");
    let endpoint = match host {
        "youtube.com" | "m.youtube.com" | "youtu.be" => "https://www.youtube.com/oembed",
        "x.com" | "mobile.x.com" | "twitter.com" | "mobile.twitter.com" => "https://publish.twitter.com/oembed",
        "bsky.app" => "https://embed.bsky.app/oembed",
        "tiktok.com" | "vm.tiktok.com" | "vt.tiktok.com" | "m.tiktok.com" => "https://www.tiktok.com/oembed",
        "vimeo.com" | "player.vimeo.com" => "https://vimeo.com/api/oembed.json",
        _ => return None,
    };
    let mut endpoint = Url::parse(endpoint).ok()?;
    endpoint
        .query_pairs_mut()
        .append_pair("url", url.as_str())
        .append_pair("format", "json")
        .append_pair("omit_script", "true");
    Some(endpoint)
}

/// Only raster formats supported by capture storage; never save active SVG/HTML.
pub(super) fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn open_graph_wins_and_readable_text_omits_page_chrome() {
        let parsed = parse_html(
            include_str!("fixtures/article.html"),
            &web_url("https://example.org/stories/sleep").unwrap(),
        );
        assert_eq!(parsed.page.title.as_deref(), Some("Sleep & attention"));
        assert_eq!(parsed.page.author.as_deref(), Some("Jane Doe"));
        assert_eq!(parsed.page.site.as_deref(), Some("The Journal"));
        assert_eq!(parsed.page.description.as_deref(), Some("Why rest matters."));
        assert_eq!(parsed.image_url.unwrap().as_str(), "https://example.org/images/sleep.jpg");
        assert!(parsed.page.source_text.contains("A quiet mind needs rest."));
        for unwanted in ["Menu", "Related", "TRACKING", "Secret", "Subscribe"] {
            assert!(!parsed.page.source_text.contains(unwanted), "{unwanted}");
        }
    }

    #[test]
    fn twitter_metadata_and_the_title_tag_are_fallbacks() {
        let url = web_url("https://example.org/").unwrap();
        let parsed = parse_html(include_str!("fixtures/twitter.html"), &url);
        assert_eq!(parsed.page.title.as_deref(), Some("A small thought"));
        assert_eq!(parsed.page.author.as_deref(), Some("@writer"));
        assert_eq!(parsed.image_url.unwrap().as_str(), "https://example.org/card.png");
        assert_eq!(
            parse_html("<title>Just &amp; a title</title>", &url).page.title.as_deref(),
            Some("Just & a title")
        );
    }

    #[test]
    fn source_text_is_bounded_on_unicode_boundaries() {
        let html = format!("<article><p>{}</p></article>", "界".repeat(30_000));
        let parsed = parse_html(&html, &web_url("https://example.org/").unwrap());
        assert!(parsed.page.source_text.chars().count() <= SOURCE_CHARS);
        assert!(parsed.page.source_text.chars().count() > 19_900);
    }

    #[test]
    fn deeply_nested_markup_does_not_exhaust_the_stack() {
        let html = format!(
            "<article><p>Readable.</p>{}Deep{}</article>",
            "<div>".repeat(2000),
            "</div>".repeat(2000)
        );
        let parsed = parse_html(&html, &web_url("https://example.org/").unwrap());
        assert!(parsed.page.source_text.contains("Readable."));
        assert!(!parsed.page.source_text.contains("Deep"));
    }

    #[test]
    fn embed_metadata_fills_gaps_without_overwriting_page_metadata() {
        let url = web_url("https://x.com/writer/status/1").unwrap();
        let mut parsed = parse_html("<meta property='og:title' content='Original'><body>Log in to continue</body>", &url);
        let embed = serde_json::from_str(include_str!("fixtures/oembed.json")).unwrap();
        merge_embed(&mut parsed, embed, &url);
        assert_eq!(parsed.page.title.as_deref(), Some("Original"));
        assert_eq!(parsed.page.author.as_deref(), Some("Writer"));
        assert!(parsed.page.source_text.contains("A thought worth keeping."));
        assert!(!parsed.page.source_text.contains("evil"));
        assert!(!parsed.page.source_text.contains("Log in"));
    }

    #[test]
    fn only_exact_platform_hosts_get_embed_requests() {
        for host in ["youtube.com", "youtu.be", "x.com", "bsky.app", "tiktok.com", "vimeo.com"] {
            let endpoint = oembed_url(&web_url(&format!("https://{host}/watch?v=1&list=2")).unwrap()).unwrap();
            assert_eq!(
                endpoint.query_pairs().find(|(k, _)| k == "url").unwrap().1,
                format!("https://{host}/watch?v=1&list=2")
            );
        }
        assert!(oembed_url(&web_url("https://youtube.com.evil.test/").unwrap()).is_none());
        for url in [
            "file:///etc/passwd",
            "data:text/html,hi",
            "ftp://example.org",
            "https://secret@example.org",
        ] {
            assert!(web_url(url).is_err());
        }
    }

    fn serve(response: String) -> (Url, std::thread::JoinHandle<()>) {
        serve_bytes(response.into_bytes())
    }

    fn serve_bytes(response: Vec<u8>) -> (Url, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = web_url(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let thread = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 2048];
            let _ = stream.read(&mut request);
            let _ = stream.write_all(&response);
        });
        (url, thread)
    }

    fn run<T>(f: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(f)
    }

    #[test]
    fn downloads_enforce_declared_and_streamed_size_limits() {
        for headers in ["Content-Length: 1000\r\n", ""] {
            let (url, thread) = serve(format!("HTTP/1.1 200 OK\r\n{headers}Connection: close\r\n\r\n{}", "x".repeat(100)));
            let result = run(Fetcher::new().unwrap().get(url, 50));
            assert_eq!(result.err().as_deref(), Some("source exceeds download limit"));
            thread.join().unwrap();
        }
    }

    #[test]
    fn redirects_cannot_escape_http_and_errors_do_not_echo_urls() {
        let (url, thread) = serve("HTTP/1.1 302 Found\r\nLocation: file:///etc/passwd\r\nContent-Length: 0\r\n\r\n".into());
        let error = run(Fetcher::new().unwrap().get(url, 100)).err().unwrap();
        // Reqwest may return the refused 302 instead of an error, but must
        // never fetch the file or include its location in our stored error.
        assert!(["source request failed", "source returned an unsuccessful status"].contains(&error.as_str()));
        assert!(!error.contains("passwd") && !error.contains("file:"));
        thread.join().unwrap();
    }

    #[test]
    fn a_page_fetch_resolves_and_downloads_its_hero_image() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/story", listener.local_addr().unwrap());
        let thread = std::thread::spawn(move || {
            for (body, mime, target) in [
                (include_str!("fixtures/article.html").as_bytes(), "text/html", "/story"),
                (b"\x89PNG\r\n\x1a\nimage".as_slice(), "image/png", "/images/sleep.jpg"),
            ] {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0; 4096];
                let n = stream.read(&mut request).unwrap();
                let request = String::from_utf8_lossy(&request[..n]);
                assert!(request.starts_with(&format!("GET {target} ")));
                assert!(request.to_ascii_lowercase().contains("user-agent: mozilla/5.0"));
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .unwrap();
                stream.write_all(body).unwrap();
            }
        });
        let page = run(Fetcher::new().unwrap().fetch(&url, true)).unwrap();
        thread.join().unwrap();
        assert_eq!(page.title.as_deref(), Some("Sleep & attention"));
        assert_eq!(page.image.as_ref().unwrap().mime, "image/png");
        assert_eq!(page.image.unwrap().bytes, b"\x89PNG\r\n\x1a\nimage");
    }

    #[test]
    fn directly_shared_images_use_the_image_cap_not_the_html_cap() {
        let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
        bytes.resize(HTML_BYTES + 100, 0);
        let mut response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            bytes.len()
        )
        .into_bytes();
        response.extend_from_slice(&bytes);
        let (url, thread) = serve_bytes(response);
        let page = run(Fetcher::new().unwrap().fetch(url.as_str(), true)).unwrap();
        thread.join().unwrap();
        assert_eq!(page.image.unwrap().bytes, bytes);
        assert!(page.source_text.is_empty());
    }

    #[test]
    fn an_exhausted_image_budget_keeps_the_collected_page() {
        run(async {
            let parsed = Parsed {
                page: Page {
                    title: Some("Already fetched".into()),
                    source_text: "Useful text.".into(),
                    ..Page::default()
                },
                image_url: Some(web_url("http://127.0.0.1:9/hero.png").unwrap()),
            };
            let page = Fetcher::new().unwrap().with_image(parsed, true, tokio::time::Instant::now()).await;
            assert_eq!(page.title.as_deref(), Some("Already fetched"));
            assert_eq!(page.source_text, "Useful text.");
            assert!(page.image.is_none());
        });
    }

    #[test]
    fn hero_images_must_be_raster_bytes_not_html_or_svg() {
        assert_eq!(image_mime(b"\x89PNG\r\n\x1a\n..."), Some("image/png"));
        assert_eq!(image_mime(b"<svg></svg>"), None);
        assert_eq!(image_mime(b"<html>login</html>"), None);
    }

    #[test]
    #[ignore]
    fn live_article_and_video_metadata() {
        run(async {
            let fetcher = Fetcher::new().unwrap();
            let page = fetcher.fetch("https://example.com", false).await.unwrap();
            assert!(page.title.is_some());
            let page = fetcher.fetch("https://www.youtube.com/watch?v=jNQXAC9IVRw", true).await.unwrap();
            assert!(page.title.is_some());
        });
    }
}
