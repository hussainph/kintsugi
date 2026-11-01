//! Hacker News: one story with its whole comment tree, from the Algolia HN
//! items API (`hn.algolia.com/api/v1/items/<id>`), which answers with the
//! story and every comment nested under its parent in one request.
//!
//! HN's own pages are tables with spacer images, so a readable-article
//! extractor loses who wrote each comment and what it answers. Here every
//! comment keeps its author, its date and a permalink, and replies nest as
//! block quotes, so a passage quoted from the thread can say who said it.
//!
//! - Accepts `news.ycombinator.com/item?id=<n>`. A comment's link captures its
//!   whole story, noting the comment in `extras.comment`.
//! - Comment HTML is a small subset (`<p>`, `<i>`, `<a>`, `<pre><code>`); it is
//!   converted here, and every text run is escaped so a comment can't open a
//!   heading, quote, list or raw HTML its author never wrote. HN's own
//!   `>` quoting stays literal text.
//!
//! No HN account or cookie is ever used.

use crate::api::{ApiClient, ApiLimits};
use crate::{Adapter, BoxFuture, CaptureOptions, Error, Item, Result, SourceType, Target, markdown, text};
use reqwest::Url;
use serde_json::Value;
use std::collections::BTreeMap;
use std::time::Duration;
use tokio::time::Instant;

const USER_AGENT: &str = "macos:dev.phalasiya.kintsugi:v0.1 (personal reading app)";
/// Comments rendered at most.
const MAX_COMMENTS: usize = 3_000;
/// Replies nest as block quotes up to this depth; deeper replies stay at it
/// (each still names its author), so a long argument doesn't scroll off the
/// right edge.
const MAX_QUOTE_DEPTH: usize = 8;
/// Stop building once the body is this long; it's cut to the cap anyway.
const BUILD_CHARS: usize = crate::FULL_CHARS + 8_000;

pub struct HackerNewsAdapter {
    client: ApiClient,
    base: Url,
}

impl HackerNewsAdapter {
    pub fn new() -> Result<Self> {
        let limits = ApiLimits {
            json_bytes: 16 * 1024 * 1024,
            min_interval: Duration::from_millis(500),
            request_timeout: Duration::from_secs(30),
            ..ApiLimits::default()
        };
        Self::with_endpoint(Url::parse("https://hn.algolia.com/api/v1/").unwrap(), limits)
    }

    /// `base` replaces `https://hn.algolia.com/api/v1/` (tests use a loopback
    /// server).
    pub fn with_endpoint(base: Url, limits: ApiLimits) -> Result<Self> {
        Ok(Self { client: ApiClient::new(USER_AGENT, limits)?, base })
    }

    pub async fn fetch(&self, url: &Url) -> Result<Item> {
        let id = item_id(url).ok_or(Error::Unsupported)?;
        let deadline = Instant::now() + self.client.limits.deadline;
        let read = async {
            let first = self.item(id).await?;
            match first.get("type").and_then(Value::as_str) {
                Some("comment") => {
                    let story = first.get("story_id").and_then(Value::as_u64).ok_or(Error::Unavailable)?;
                    let story = self.item(story).await?;
                    item_from_story(&story, Some(id)).ok_or(Error::Unavailable)
                }
                _ => item_from_story(&first, None).ok_or(Error::Unavailable),
            }
        };
        tokio::time::timeout_at(deadline, read).await.map_err(|_| Error::TimedOut)?
    }

    async fn item(&self, id: u64) -> Result<Value> {
        let url = self.base.join(&format!("items/{id}")).map_err(|_| Error::InvalidUrl)?;
        let body = self.client.get(url).await?;
        serde_json::from_slice(&body.bytes).map_err(|_| Error::Unavailable)
    }
}

impl Adapter for HackerNewsAdapter {
    fn source(&self) -> SourceType {
        SourceType::Hn
    }

    fn matches(&self, target: &Target) -> bool {
        matches!(target, Target::Url(url) if item_id(url).is_some())
    }

    fn capture<'a>(&'a self, target: &'a Target, _: CaptureOptions) -> BoxFuture<'a, Result<Item>> {
        Box::pin(async move {
            match target {
                Target::Url(url) => self.fetch(url).await,
                Target::File(_) => Err(Error::Unsupported),
            }
        })
    }
}

/// The item id in `https://news.ycombinator.com/item?id=<n>`.
pub fn item_id(url: &Url) -> Option<u64> {
    if !matches!(url.scheme(), "http" | "https") || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    if !url.host_str()?.eq_ignore_ascii_case("news.ycombinator.com") || url.path() != "/item" {
        return None;
    }
    let (_, id) = url.query_pairs().find(|(k, _)| k == "id")?;
    (id.len() <= 12 && id.bytes().all(|b| b.is_ascii_digit())).then(|| id.parse().ok()).flatten().filter(|n| *n > 0)
}

/// A comment's (or story's) page on HN.
pub fn permalink(id: u64) -> String {
    format!("https://news.ycombinator.com/item?id={id}")
}

// --- Items ---------------------------------------------------------------------

fn s<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key)?.as_str().map(str::trim).filter(|s| !s.is_empty())
}

fn item_from_story(story: &Value, comment: Option<u64>) -> Option<Item> {
    let id = story.get("id")?.as_u64()?;
    if !matches!(s(story, "type"), Some("story" | "job" | "poll")) {
        return None;
    }
    let op = s(story, "author");
    let mut body = String::new();
    let link = s(story, "url").and_then(safe_url);
    if let Some(link) = &link {
        let host = Url::parse(link).ok().and_then(|u| u.host_str().map(|h| h.trim_start_matches("www.").to_string()));
        push_block(&mut body, &format!("[{}](<{link}>)", text::label(host.as_deref().unwrap_or(link), 200)));
    }
    if let Some(html) = s(story, "text") {
        push_block(&mut body, &html_markdown(html));
    }
    let mut rendered = Rendered { op, ..Rendered::default() };
    if let Some(children) = story.get("children").and_then(Value::as_array) {
        render(children, 0, &mut rendered);
    }
    if !rendered.out.is_empty() {
        push_block(&mut body, "## Comments");
        push_block(&mut body, &rendered.out);
    }
    let mut extras = BTreeMap::new();
    extras.insert("extractor".to_string(), Value::from("hn-algolia"));
    if let Some(points) = story.get("points").and_then(Value::as_i64) {
        extras.insert("points".to_string(), Value::from(points));
    }
    extras.insert("includedComments".to_string(), Value::from(rendered.count));
    if let Some(link) = &link {
        extras.insert("link".to_string(), Value::from(link.as_str()));
    }
    if let Some(comment) = comment {
        extras.insert("comment".to_string(), Value::from(comment));
    }
    if rendered.out.len() >= BUILD_CHARS || rendered.count >= MAX_COMMENTS {
        extras.insert("truncated".to_string(), Value::from(true));
    }
    Some(Item {
        source: SourceType::Hn,
        id: format!("hn:{id}"),
        url: Some(permalink(id)),
        title: s(story, "title").and_then(|t| markdown::field(t, 500)),
        author: op.and_then(|a| markdown::field(a, 100)),
        site: Some("Hacker News".into()),
        description: None,
        published: story
            .get("created_at_i")
            .and_then(Value::as_i64)
            .and_then(crate::x::rfc3339)
            .or_else(|| s(story, "created_at").and_then(|c| markdown::field(c, 64))),
        captured: crate::now(),
        media: Vec::new(),
        body: markdown::body(&body, crate::FULL_CHARS),
        extras,
    })
}

fn push_block(body: &mut String, block: &str) {
    if !body.is_empty() {
        body.push_str("\n\n");
    }
    body.push_str(block);
}

fn safe_url(raw: &str) -> Option<String> {
    let url = crate::web::web_url(raw.trim()).ok()?;
    Some(url.as_str().replace('<', "%3C").replace('>', "%3E").replace(' ', "%20"))
}

#[derive(Default)]
struct Rendered<'a> {
    out: String,
    count: usize,
    op: Option<&'a str>,
}

/// Comments in the API's order, each headed `**author** · date · [link](…)`
/// (plus `OP` for the story's author), replies as nested block quotes.
/// Deleted comments with no replies are skipped.
fn render(children: &[Value], depth: usize, rendered: &mut Rendered) {
    let level = depth.min(MAX_QUOTE_DEPTH);
    let marks = vec![">"; level].join(" ");
    let prefix = |line: &str| match (level, line.is_empty()) {
        (0, _) => line.to_string(),
        (_, true) => marks.clone(),
        (_, false) => format!("{marks} {line}"),
    };
    for child in children {
        if rendered.count >= MAX_COMMENTS || rendered.out.len() >= BUILD_CHARS {
            return;
        }
        if s(child, "type") != Some("comment") {
            continue;
        }
        let replies = child.get("children").and_then(Value::as_array).filter(|r| !r.is_empty());
        let author = s(child, "author");
        let html = s(child, "text");
        if (author.is_none() || html.is_none()) && replies.is_none() {
            continue;
        }
        let mut head = match author {
            Some(author) => format!("**{}**", escape(&text::label(author, 40))),
            None => "**[deleted]**".to_string(),
        };
        if let Some(date) = s(child, "created_at").filter(|d| d.len() >= 10 && d.is_char_boundary(10)) {
            head.push_str(&format!(" · {}", &date[..10]));
        }
        if author.is_some() && author == rendered.op {
            head.push_str(" · OP");
        }
        if let Some(id) = child.get("id").and_then(Value::as_u64) {
            head.push_str(&format!(" · [link](<{}>)", permalink(id)));
        }
        let text = match (author, html) {
            (Some(_), Some(html)) => html_markdown(html),
            _ => "_[deleted]_".to_string(),
        };
        rendered.count += 1;
        if !rendered.out.is_empty() {
            rendered.out.push_str("\n\n");
        }
        let block = format!("{head}\n\n{text}");
        rendered.out.push_str(&block.lines().map(prefix).collect::<Vec<_>>().join("\n"));
        if let Some(replies) = replies {
            render(replies, depth + 1, rendered);
        }
    }
}

// --- Comment HTML --------------------------------------------------------------

/// HN's comment HTML (`<p>`, `<i>`, `<a href>`, `<pre><code>`, entities) as
/// Markdown. Text is escaped inline, so nothing its author typed becomes
/// structure; links keep their target, code blocks stay verbatim.
pub(crate) fn html_markdown(html: &str) -> String {
    let mut blocks: Vec<String> = Vec::new();
    let mut paragraph = String::new();
    let mut code: Option<String> = None;
    let mut link: Option<(String, String)> = None;
    let flush = |paragraph: &mut String, blocks: &mut Vec<String>| {
        let text = paragraph.split_whitespace().collect::<Vec<_>>().join(" ");
        if !text.is_empty() {
            blocks.push(guard_block_start(&text));
        }
        paragraph.clear();
    };
    let mut rest = html;
    while !rest.is_empty() {
        let (chunk, tag) = match rest.find('<') {
            Some(0) => {
                let end = rest.find('>').map_or(rest.len(), |i| i + 1);
                let tag = &rest[..end];
                rest = &rest[end..];
                ("", Some(tag))
            }
            Some(i) => {
                let chunk = &rest[..i];
                rest = &rest[i..];
                (chunk, None)
            }
            None => {
                let chunk = rest;
                rest = "";
                (chunk, None)
            }
        };
        if !chunk.is_empty() {
            let decoded = entities(chunk);
            if let Some(code) = &mut code {
                code.push_str(&decoded);
            } else if let Some((label, _)) = &mut link {
                label.push_str(&decoded);
            } else {
                paragraph.push_str(&escape(&decoded));
            }
        }
        let Some(tag) = tag else { continue };
        let inner = tag.trim_start_matches('<').trim_end_matches('>').trim();
        let closing = inner.starts_with('/');
        let name: String = inner
            .trim_start_matches('/')
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric())
            .collect::<String>()
            .to_ascii_lowercase();
        match (name.as_str(), closing) {
            ("p", false) | ("br", _) if code.is_none() => flush(&mut paragraph, &mut blocks),
            ("pre", false) => {
                flush(&mut paragraph, &mut blocks);
                code = Some(String::new());
            }
            ("pre", true) => {
                if let Some(code) = code.take() {
                    let code = code.trim_matches('\n');
                    let longest = code.split(|c| c != '`').map(str::len).max().unwrap_or(0);
                    let fence = "`".repeat(longest.max(2) + 1);
                    blocks.push(format!("{fence}\n{code}\n{fence}"));
                }
            }
            ("i", _) | ("em", _) if code.is_none() && link.is_none() => paragraph.push('*'),
            ("a", false) if code.is_none() => {
                let href = attribute(inner, "href").map(|h| entities(&h)).and_then(|h| safe_url(&h));
                link = Some((String::new(), href.unwrap_or_default()));
            }
            ("a", true) => {
                if let Some((label, href)) = link.take() {
                    let label = escape(&text::label(&label, 300));
                    if href.is_empty() {
                        paragraph.push_str(&label);
                    } else {
                        paragraph.push_str(&format!("[{}](<{href}>)", if label.is_empty() { &href } else { &label }));
                    }
                }
            }
            _ => {}
        }
    }
    if let Some((label, _)) = link.take() {
        paragraph.push_str(&escape(&label));
    }
    if let Some(code) = code.take() {
        paragraph.push_str(&escape(&code));
    }
    flush(&mut paragraph, &mut blocks);
    blocks.join("\n\n")
}

fn attribute(tag: &str, name: &str) -> Option<String> {
    let at = tag.find(&format!("{name}=\""))? + name.len() + 2;
    let end = tag[at..].find('"')? + at;
    Some(tag[at..end].to_string())
}

/// Escapes inline Markdown and raw HTML in a text run.
fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 8);
    for c in text.chars() {
        if matches!(c, '\\' | '*' | '_' | '`' | '[' | ']' | '<' | '>' | '|') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// A paragraph can't begin a heading, list or other block it never meant.
fn guard_block_start(paragraph: &str) -> String {
    let first = paragraph.chars().next();
    let digits = paragraph.chars().take_while(char::is_ascii_digit).count();
    let ordered = digits > 0 && digits <= 9 && matches!(paragraph[digits..].chars().next(), Some('.' | ')'));
    if matches!(first, Some('#' | '-' | '+' | '=' | '~')) || ordered {
        format!("\\{paragraph}")
    } else {
        paragraph.to_string()
    }
}

fn entities(text: &str) -> String {
    if !text.contains('&') {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let Some(end) = rest[..rest.len().min(12)].find(';') else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let name = &rest[1..end];
        let decoded = match name {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            _ => name
                .strip_prefix("#x")
                .or_else(|| name.strip_prefix("#X"))
                .and_then(|hex| u32::from_str_radix(hex, 16).ok())
                .or_else(|| name.strip_prefix('#').and_then(|dec| dec.parse().ok()))
                .and_then(char::from_u32),
        };
        match decoded {
            Some(c) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests;
