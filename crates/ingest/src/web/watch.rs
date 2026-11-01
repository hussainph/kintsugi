//! "Follow this page": change detection for pages without a feed, as the
//! web adapter's [`Adapter::poll`](crate::Adapter::poll).
//!
//! Each poll makes a conditional request (`If-None-Match` /
//! `If-Modified-Since` from the cursor); a 304 is "unchanged" without any
//! work. Otherwise the page's readable region (the largest
//! `article`/`main`/`[role=main]`, or the body, without page chrome) becomes
//! lines of text. Each line is normalized into a comparison key that ignores
//! what changes on every visit without the page really changing: dates,
//! times, "5 minutes ago", view/like/comment counters, copyright years and
//! link targets. The keys are hashed; when the hash differs from the
//! cursor's, one item describes the change with a line diff (no AI).
//!
//! The first poll records a baseline and returns no items. The cursor is JSON
//! holding the validators, the hash and the page's lines (bounded), so the
//! next change can be diffed against them.
//!
//! Polling is static only: the hidden-webview renderer is for one-off
//! captures, not for a page checked every few hours.

use super::{Limits, WebAdapter, allowed_url, canonical_url, web_url};
use crate::{Error, Item, Media, MediaKind, Polled, Result, SourceInfo, SourceType, Subscription, markdown, text};
use dom_query::Document;
use futures_util::StreamExt;
use regex::Regex;
use reqwest::Url;
use reqwest::header::{ACCEPT, CONTENT_TYPE, ETAG, IF_MODIFIED_SINCE, IF_NONE_MATCH, LAST_MODIFIED};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::LazyLock;

/// Never worth watching: page chrome and anything not shown as text.
const CHROME: &[&str] = &[
    "script", "style", "noscript", "nav", "header", "footer", "aside", "form", "svg", "template", "iframe", "button",
    "head", "meta", "link", "select", "dialog",
];
/// The cursor keeps at most this many lines of the last version.
const MAX_LINES: usize = 1_500;
/// A line longer than this is cut (the cursor stays small).
const LINE_CHARS: usize = 600;
/// Lines shown per side of a change in the item body.
const SHOWN: usize = 12;
/// Above this many line pairs, the diff compares sets instead of sequences.
const LCS_CELLS: usize = 2_000_000;

/// What the watch remembers between polls.
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
struct Cursor {
    #[serde(skip_serializing_if = "Option::is_none")]
    etag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    modified: Option<String>,
    /// FNV-1a of the normalized lines, as hex.
    hash: String,
    /// The last version's readable lines, as shown (not normalized).
    lines: Vec<String>,
}

/// The page as one snapshot: its title and readable lines.
#[derive(Debug, Default, PartialEq)]
pub struct Snapshot {
    pub title: Option<String>,
    pub site: Option<String>,
    pub image: Option<String>,
    pub lines: Vec<String>,
}

/// What changed between two snapshots, as display lines.
#[derive(Debug, Default, PartialEq)]
pub struct Change {
    pub added: Vec<String>,
    pub removed: Vec<String>,
}

pub(super) async fn poll(adapter: &WebAdapter, subscription: &Subscription) -> Result<Polled> {
    let url = web_url(&subscription.url)?;
    let previous: Option<Cursor> = subscription.cursor.as_deref().and_then(|c| serde_json::from_str(c).ok());
    let deadline = tokio::time::Instant::now() + adapter.limits.deadline;
    let fetched = tokio::time::timeout_at(deadline, fetch(adapter, &url, previous.as_ref()))
        .await
        .map_err(|_| Error::TimedOut)??;
    let Some(page) = fetched else {
        return Ok(Polled { items: Vec::new(), cursor: subscription.cursor.clone(), source: None });
    };
    let snapshot = if page.html {
        snapshot(&String::from_utf8_lossy(&page.bytes), &page.url)
    } else {
        Snapshot { lines: lines(&String::from_utf8_lossy(&page.bytes)), ..Snapshot::default() }
    };
    if snapshot.lines.is_empty() && snapshot.title.is_none() {
        return Err(Error::Unavailable);
    }
    let hash = fingerprint(&snapshot.lines);
    let canonical = canonical_url(&url);
    let source = SourceInfo {
        title: snapshot.title.clone().or_else(|| canonical.host_str().map(str::to_string)),
        url: Some(canonical.to_string()),
        image: snapshot.image.clone(),
    };
    let mut items = Vec::new();
    if let Some(previous) = previous.as_ref().filter(|p| p.hash != hash) {
        let change = diff(&previous.lines, &snapshot.lines);
        // Equal keys hash equally, so a new hash always has a line to show;
        // the check only guards against a cursor written by another version.
        if !change.added.is_empty() || !change.removed.is_empty() {
            items.push(item(&canonical, &snapshot, &change, &previous.hash, &hash));
        }
    }
    let next = Cursor { etag: page.etag, modified: page.modified, hash, lines: snapshot.lines };
    Ok(Polled { items, cursor: serde_json::to_string(&next).ok(), source: Some(source) })
}

struct Page {
    bytes: Vec<u8>,
    url: Url,
    html: bool,
    etag: Option<String>,
    modified: Option<String>,
}

/// `Ok(None)` is 304 Not Modified.
async fn fetch(adapter: &WebAdapter, url: &Url, cursor: Option<&Cursor>) -> Result<Option<Page>> {
    if !allowed_url(url) {
        return Err(Error::InvalidUrl);
    }
    let Limits { html_bytes, .. } = adapter.limits;
    let mut request = adapter.client.get(url.clone()).header(ACCEPT, "text/html, application/xhtml+xml, text/plain;q=0.9, */*;q=0.5");
    if let Some(cursor) = cursor {
        if let Some(etag) = &cursor.etag {
            request = request.header(IF_NONE_MATCH, etag);
        }
        if let Some(modified) = &cursor.modified {
            request = request.header(IF_MODIFIED_SINCE, modified);
        }
    }
    let response = request.send().await.map_err(|e| if e.is_timeout() { Error::TimedOut } else { Error::Unavailable })?;
    let status = response.status();
    if status.as_u16() == 304 && cursor.is_some() {
        return Ok(None);
    }
    if !status.is_success() {
        return Err(Error::Status(status.as_u16()));
    }
    let header = |name| response.headers().get(name).and_then(|v: &reqwest::header::HeaderValue| v.to_str().ok()).map(str::to_string);
    let mime = header(CONTENT_TYPE).unwrap_or_default().to_ascii_lowercase();
    let html = mime.is_empty() || mime.starts_with("text/html") || mime.starts_with("application/xhtml+xml");
    if !html && !mime.starts_with("text/") {
        // An image or a PDF has no lines to compare.
        return Err(Error::Unsupported);
    }
    if response.content_length().is_some_and(|n| n > html_bytes as u64) {
        return Err(Error::TooLarge);
    }
    let (etag, modified, final_url) = (header(ETAG), header(LAST_MODIFIED), response.url().clone());
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| Error::Unavailable)?;
        if chunk.len() > html_bytes.saturating_sub(bytes.len()) {
            return Err(Error::TooLarge);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(Some(Page { bytes, url: final_url, html, etag, modified }))
}

/// The readable region of a page as lines, plus its declared title. The
/// whole region (not Readability's pick) is watched, so a change anywhere
/// in it counts, and the choice of region can't flip between versions.
pub fn snapshot(html: &str, url: &Url) -> Snapshot {
    let doc = Document::from(html);
    let meta = |key: &str| {
        doc.select(&format!("meta[property='{key}'], meta[name='{key}']")).attr("content").and_then(|s| markdown::field(&s, 300))
    };
    let title = meta("og:title").or_else(|| doc.select("title").iter().next().and_then(|t| markdown::field(&t.text(), 300)));
    let site = meta("og:site_name");
    let image = meta("og:image").and_then(|s| url.join(&s).ok()).filter(allowed_url).map(String::from);
    doc.select(r#"[hidden], [aria-hidden="true"], [style*="display:none"], [style*="display: none"]"#).remove();
    let regions = doc.select("article, main, [role=main]");
    let roots = if regions.is_empty() { doc.select("body") } else { regions };
    let text = roots
        .nodes()
        .iter()
        .map(|root| root.md(Some(CHROME)).to_string())
        .max_by_key(|s| s.chars().count())
        .unwrap_or_default();
    Snapshot { title, site, image, lines: lines(&text) }
}

static IMAGE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"!\[[^\]]*\]\([^)]*\)").unwrap());
static LINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[([^\]]*)\]\([^)]*\)").unwrap());
static MARKER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d{1,9}[.)]\s+|\|)+").unwrap());
static EMPHASIS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\*\*|__|`|\\").unwrap());
static RULE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[-*_=|:\s]+$").unwrap());

/// Markdown (or plain text) as display lines: images dropped, links reduced
/// to their text, block markers and emphasis removed, whitespace collapsed,
/// rules and blank lines skipped.
pub fn lines(md: &str) -> Vec<String> {
    let mut out = Vec::new();
    for raw in md.lines() {
        let line = IMAGE.replace_all(raw, "");
        let line = LINK.replace_all(&line, "$1");
        let line = MARKER.replace(line.trim(), "");
        let line = EMPHASIS.replace_all(&line, "");
        let line = line.trim_end_matches('|');
        let Some(line) = markdown::field(&line.replace('|', " · "), LINE_CHARS) else { continue };
        if RULE.is_match(&line) || line == "·" {
            continue;
        }
        out.push(line);
        if out.len() >= MAX_LINES {
            break;
        }
    }
    out
}

const MONTH: &str = r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?";
const UNIT: &str = r"(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|wks?|months?|years?|yrs?|[smhdwy]|mo)";
const COUNTED: &str = r"(?:views?|likes?|comments?|repl(?:y|ies)|shares?|reposts?|retweets?|followers?|following|subscribers?|stars?|forks?|reads?|visits?|visitors?|downloads?|installs?|points?|votes?|reactions?|clicks?|plays?|listens?|watching|online|people|members?|responses?|claps?)";

/// What changes on every visit without the page changing, in order. Each
/// becomes `#` in a line's comparison key.
static NOISE: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        // ISO dates and datetimes.
        r"\b\d{4}-\d{2}-\d{2}(?:[t ]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})?)?\b".to_string(),
        // 11/03/2026, 3.11.26
        r"\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b".to_string(),
        // Nov 3, 2026 · November 3rd · 3 Nov 2026 · Nov 2026
        format!(r"\b{MONTH}\s+\d{{1,2}}(?:st|nd|rd|th)?(?:,?\s+\d{{4}})?\b"),
        format!(r"\b\d{{1,2}}(?:st|nd|rd|th)?\s+(?:of\s+)?{MONTH}(?:,?\s+\d{{4}})?\b"),
        format!(r"\b{MONTH}\s+\d{{4}}\b"),
        r"\b(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|nesday|sday|urday)?\b".to_string(),
        // 14:05, 2:05:09 pm
        r"\b\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]\.?m\.?)?\b".to_string(),
        // 5 minutes ago, an hour ago, 3h ago, just now, yesterday
        format!(r"\b(?:\d+|an?|one|a few)\s*{UNIT}\s+ago\b"),
        r"\b(?:just now|yesterday|today|tonight|tomorrow)\b".to_string(),
        // 1,204 views · 3.2k likes · 12 comments
        format!(r"\b\d[\d,.\u{{a0}} ]*[kmb]?\+?\s*{COUNTED}\b"),
        format!(r"\b{COUNTED}\s*[:·]?\s*\d[\d,.]*[kmb]?\b"),
        // © 2024–2026, Copyright 2026
        r"(?:©|\(c\)|copyright)\s*(?:\d{4}\s*(?:[-–—]\s*\d{4})?)?".to_string(),
    ]
    .iter()
    .map(|p| Regex::new(&format!("(?i){p}")).unwrap())
    .collect()
});

/// Masked noise next to masked noise ("# at # · #") is one stretch of noise,
/// so "Updated Nov 3 at 9:14 · 3 hours ago" and "Updated Dec 1 · yesterday"
/// compare equal.
static RUN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"#(?:[\s,·•|/()\-–—]*(?:at|on|by|and)?[\s,·•|/()\-–—]*#)+").unwrap());

/// A line's comparison key: lowercased, noise masked, whitespace collapsed.
pub fn normalize(line: &str) -> String {
    let mut key = line.to_lowercase();
    for noise in NOISE.iter() {
        key = noise.replace_all(&key, " # ").into_owned();
    }
    let key = RUN.replace_all(&key, "#");
    key.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A stable hash of the page's normalized lines (FNV-1a, 64 bits).
pub fn fingerprint(lines: &[String]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for line in lines {
        for byte in normalize(line).bytes().chain(std::iter::once(b'\n')) {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x0100_0000_01b3);
        }
    }
    format!("{hash:016x}")
}

/// Lines added and removed, compared by normalized key. A line whose only
/// difference is noise counts as unchanged.
pub fn diff(old: &[String], new: &[String]) -> Change {
    let a: Vec<String> = old.iter().map(|l| normalize(l)).collect();
    let b: Vec<String> = new.iter().map(|l| normalize(l)).collect();
    let (keep_a, keep_b) = if a.len().saturating_mul(b.len()) <= LCS_CELLS { lcs(&a, &b) } else { multiset(&a, &b) };
    Change {
        added: new.iter().zip(&keep_b).filter(|(_, kept)| !**kept).map(|(l, _)| l.clone()).collect(),
        removed: old.iter().zip(&keep_a).filter(|(_, kept)| !**kept).map(|(l, _)| l.clone()).collect(),
    }
}

/// Which lines of each side are in a longest common subsequence.
fn lcs(a: &[String], b: &[String]) -> (Vec<bool>, Vec<bool>) {
    let (n, m) = (a.len(), b.len());
    let mut table = vec![0u32; (n + 1) * (m + 1)];
    let at = |i: usize, j: usize| i * (m + 1) + j;
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            table[at(i, j)] = if a[i] == b[j] { table[at(i + 1, j + 1)] + 1 } else { table[at(i + 1, j)].max(table[at(i, j + 1)]) };
        }
    }
    let (mut keep_a, mut keep_b) = (vec![false; n], vec![false; m]);
    let (mut i, mut j) = (0, 0);
    while i < n && j < m {
        if a[i] == b[j] {
            keep_a[i] = true;
            keep_b[j] = true;
            i += 1;
            j += 1;
        } else if table[at(i + 1, j)] >= table[at(i, j + 1)] {
            i += 1;
        } else {
            j += 1;
        }
    }
    (keep_a, keep_b)
}

/// For very long pages: lines kept if the other side has them too, ignoring order.
fn multiset(a: &[String], b: &[String]) -> (Vec<bool>, Vec<bool>) {
    let mut count: BTreeMap<&str, (usize, usize)> = BTreeMap::new();
    for line in a {
        count.entry(line).or_default().0 += 1;
    }
    for line in b {
        count.entry(line).or_default().1 += 1;
    }
    let mark = |side: &[String], pick: fn(&(usize, usize)) -> usize| {
        let mut left: BTreeMap<&str, usize> = count.iter().map(|(k, v)| (*k, pick(v))).collect();
        side.iter()
            .map(|line| {
                let slot = left.get_mut(line.as_str()).expect("every line was counted");
                let kept = *slot > 0;
                *slot = slot.saturating_sub(1);
                kept
            })
            .collect::<Vec<bool>>()
    };
    // A line is kept up to the number of times both sides have it.
    (mark(a, |(x, y)| (*x).min(*y)), mark(b, |(x, y)| (*x).min(*y)))
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// The change as one sentence: "3 lines added and 1 removed".
pub fn summary(change: &Change) -> String {
    match (change.added.len(), change.removed.len()) {
        (0, r) => format!("{} removed", plural(r, "line", "lines")),
        (a, 0) => format!("{} added", plural(a, "line", "lines")),
        (a, r) => format!("{} added and {r} removed", plural(a, "line", "lines")),
    }
}

/// Markdown describing the change: what was added, then what was removed,
/// each line as plain text (never Markdown or HTML the page wrote).
pub fn describe(change: &Change) -> String {
    let mut out = String::new();
    for (heading, lines) in [("Added", &change.added), ("Removed", &change.removed)] {
        if lines.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str(&format!("**{heading}**\n\n"));
        for line in lines.iter().take(SHOWN) {
            out.push_str("- ");
            out.push_str(&text::plain(&text::label(line, LINE_CHARS)));
            out.push('\n');
        }
        if lines.len() > SHOWN {
            out.push_str(&format!("- …and {} more\n", lines.len() - SHOWN));
        }
    }
    markdown::body(&out, crate::BODY_CHARS)
}

fn item(url: &Url, snapshot: &Snapshot, change: &Change, before: &str, after: &str) -> Item {
    let page = snapshot.title.clone().or_else(|| url.host_str().map(str::to_string)).unwrap_or_default();
    let headline = change
        .added
        .first()
        .and_then(|l| text::title(l, 120))
        .or_else(|| change.removed.first().and_then(|l| text::title(l, 110)).map(|l| format!("Removed: {l}")));
    let mut extras = BTreeMap::new();
    extras.insert("extractor".into(), Value::from("watch"));
    extras.insert("media".into(), Value::from("article"));
    extras.insert("added".into(), Value::from(change.added.len()));
    extras.insert("removed".into(), Value::from(change.removed.len()));
    extras.insert("hash".into(), Value::from(after));
    let captured = crate::now();
    Item {
        source: SourceType::Web,
        // One item per transition, so a page that changes back still counts.
        id: format!("web:{url}#{before}-{after}"),
        url: Some(url.to_string()),
        title: headline.or_else(|| Some(format!("{page} changed"))),
        author: None,
        site: Some(page.clone()).filter(|p| !p.is_empty()).or_else(|| snapshot.site.clone()),
        description: Some(format!("{} on {page}", summary(change))),
        published: Some(captured.clone()),
        captured,
        media: snapshot.image.clone().map(|u| Media { kind: MediaKind::Image, url: Some(u), data: None }).into_iter().collect(),
        body: describe(change),
        extras,
    }
}

#[cfg(test)]
mod tests;
