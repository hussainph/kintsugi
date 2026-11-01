//! PDFKit gives text line by line with font sizes and positions. This turns
//! it into readable Markdown: headings from larger type, paragraphs rebuilt
//! from wrapped lines (and words hyphenated across them), running headers,
//! footers and page numbers dropped. Pure, so it is tested without PDFKit.

use crate::text::plain;
use serde::Deserialize;
use std::collections::HashMap;

/// What the `kintsugi-pdf` helper reports about one document.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PdfText {
    pub page_count: usize,
    /// Still locked after trying the empty password: no text was read.
    pub locked: bool,
    pub title: Option<String>,
    pub author: Option<String>,
    pub subject: Option<String>,
    pub keywords: Vec<String>,
    /// ISO 8601.
    pub created: Option<String>,
    pub outline: Vec<OutlineEntry>,
    pub pages: Vec<PageText>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct OutlineEntry {
    pub title: String,
    pub page: Option<usize>,
    pub level: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct PageText {
    pub page: usize,
    pub lines: Vec<Line>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct Line {
    pub text: String,
    /// The dominant font size, in points.
    pub size: f64,
    pub bold: bool,
    /// Bottom edge from the page's bottom, in points.
    pub y: f64,
}

impl PdfText {
    /// Characters of text found, ignoring whitespace.
    pub fn chars(&self) -> usize {
        self.pages.iter().flat_map(|p| &p.lines).map(|l| l.text.chars().filter(|c| !c.is_whitespace()).count()).sum()
    }
}

/// Headings are at least this much larger than body text.
const HEADING_RATIO: f64 = 1.2;
/// A heading longer than this is a large-print paragraph, not a heading.
const HEADING_CHARS: usize = 150;

/// The document as Markdown (unbounded; the caller caps it).
pub fn markdown(doc: &PdfText) -> String {
    let body_size = body_size(doc);
    let furniture = furniture(doc);
    let gap = line_gap(doc, body_size);
    // Larger heading sizes rank higher: the largest becomes `##` (the clip
    // title is the document's own `#`).
    let mut heading_sizes: Vec<f64> = doc
        .pages
        .iter()
        .flat_map(|p| &p.lines)
        .filter(|l| is_heading(l, body_size))
        .map(|l| l.size)
        .collect();
    heading_sizes.sort_by(|a, b| b.total_cmp(a));
    heading_sizes.dedup_by(|a, b| (*a - *b).abs() < 0.5);
    let outline: Vec<String> = doc.outline.iter().map(|o| normalize(&o.title)).collect();
    let use_outline = heading_sizes.is_empty() && !outline.is_empty();

    let mut blocks: Vec<String> = Vec::new();
    let mut paragraph = String::new();
    let mut heading: Option<(f64, String)> = None;
    let flush = |paragraph: &mut String, blocks: &mut Vec<String>| {
        if !paragraph.trim().is_empty() {
            blocks.push(plain(paragraph.trim()));
        }
        paragraph.clear();
    };
    let flush_heading = |heading: &mut Option<(f64, String)>, blocks: &mut Vec<String>| {
        if let Some((size, text)) = heading.take() {
            let rank = heading_sizes.iter().position(|s| (s - size).abs() < 0.5).unwrap_or(0);
            let marks = "#".repeat((rank + 2).min(4));
            blocks.push(format!("{marks} {}", plain(text.trim()).trim_start_matches('\\')));
        }
    };
    for page in &doc.pages {
        let mut previous_y: Option<f64> = None;
        for (index, line) in page.lines.iter().enumerate() {
            let text = line.text.trim();
            if text.is_empty() || is_furniture(&furniture, page, index, text) {
                continue;
            }
            let outline_heading = use_outline && outline.contains(&normalize(text));
            if (is_heading(line, body_size) || outline_heading) && text.chars().count() <= HEADING_CHARS {
                flush(&mut paragraph, &mut blocks);
                let size = if outline_heading { heading_sizes.first().copied().unwrap_or(line.size) } else { line.size };
                match &mut heading {
                    // A title wrapped over two lines in the same type.
                    Some((current, words)) if (*current - size).abs() < 0.5 && previous_y.is_some() => {
                        words.push(' ');
                        words.push_str(text);
                    }
                    _ => {
                        flush_heading(&mut heading, &mut blocks);
                        heading = Some((size, text.to_string()));
                    }
                }
                previous_y = Some(line.y);
                continue;
            }
            flush_heading(&mut heading, &mut blocks);
            let bullet = bullet(text);
            let spaced = previous_y.is_some_and(|y| y - line.y > gap * 1.5 || line.y > y);
            if bullet.is_some() || spaced || (previous_y.is_none() && ends_sentence(&paragraph)) {
                flush(&mut paragraph, &mut blocks);
            }
            if let Some(rest) = bullet {
                blocks.push(format!("- {}", plain(rest)));
            } else {
                join(&mut paragraph, text);
            }
            previous_y = Some(line.y);
        }
        flush_heading(&mut heading, &mut blocks);
    }
    flush(&mut paragraph, &mut blocks);
    blocks.join("\n\n")
}

/// The size most body characters are set in.
fn body_size(doc: &PdfText) -> f64 {
    let mut chars: HashMap<i64, usize> = HashMap::new();
    for line in doc.pages.iter().flat_map(|p| &p.lines) {
        *chars.entry((line.size * 2.0).round() as i64).or_default() += line.text.chars().count();
    }
    chars.into_iter().max_by_key(|(size, n)| (*n, -*size)).map_or(0.0, |(size, _)| size as f64 / 2.0)
}

fn is_heading(line: &Line, body_size: f64) -> bool {
    body_size > 0.0
        && line.size >= body_size * HEADING_RATIO
        && line.text.chars().any(char::is_alphabetic)
        && line.text.trim().chars().count() <= HEADING_CHARS
}

/// The usual distance between consecutive body lines.
fn line_gap(doc: &PdfText, body_size: f64) -> f64 {
    let mut gaps: Vec<f64> = doc
        .pages
        .iter()
        .flat_map(|p| p.lines.windows(2))
        .filter(|w| (w[0].size - body_size).abs() < 0.5 && (w[1].size - body_size).abs() < 0.5)
        .map(|w| w[0].y - w[1].y)
        .filter(|g| *g > 0.0)
        .collect();
    gaps.sort_by(f64::total_cmp);
    gaps.get(gaps.len() / 2).copied().unwrap_or(body_size * 1.3).max(1.0)
}

/// Running headers and footers: text at the top or bottom of a page that
/// recurs (digits ignored) on at least half the pages.
fn furniture(doc: &PdfText) -> Vec<String> {
    if doc.pages.len() < 2 {
        return Vec::new();
    }
    let mut seen: HashMap<String, usize> = HashMap::new();
    for page in &doc.pages {
        let mut keys: Vec<String> = edges(page).map(|l| shape(&l.text)).collect();
        keys.sort();
        keys.dedup();
        for key in keys {
            *seen.entry(key).or_default() += 1;
        }
    }
    let needed = doc.pages.len().div_ceil(2).max(2);
    seen.into_iter().filter(|(_, n)| *n >= needed).map(|(key, _)| key).collect()
}

fn edges(page: &PageText) -> impl Iterator<Item = &Line> {
    let n = page.lines.len();
    page.lines.iter().enumerate().filter(move |(i, _)| *i < 2 || *i + 2 >= n).map(|(_, l)| l)
}

fn is_furniture(furniture: &[String], page: &PageText, index: usize, text: &str) -> bool {
    let at_edge = index < 2 || index + 2 >= page.lines.len();
    at_edge && (page_number(text) || furniture.contains(&shape(text)))
}

/// Digits and whitespace don't distinguish a running header.
fn shape(text: &str) -> String {
    text.chars().filter(|c| !c.is_whitespace()).map(|c| if c.is_ascii_digit() { '#' } else { c.to_ascii_lowercase() }).collect()
}

fn page_number(text: &str) -> bool {
    let t = text.trim().to_ascii_lowercase();
    let t = t.strip_prefix("page ").unwrap_or(&t);
    let core = t.split(" of ").next().unwrap_or(t).trim_matches(|c: char| c == '-' || c == '–' || c.is_whitespace());
    !core.is_empty()
        && core.len() <= 8
        && (core.chars().all(|c| c.is_ascii_digit()) || core.chars().all(|c| matches!(c, 'i' | 'v' | 'x' | 'l' | 'c')))
}

fn bullet(text: &str) -> Option<&str> {
    ["• ", "◦ ", "▪ ", "– ", "- ", "· "].iter().find_map(|b| text.strip_prefix(b)).map(str::trim).filter(|r| !r.is_empty())
}

fn ends_sentence(paragraph: &str) -> bool {
    paragraph.trim_end().ends_with(['.', '!', '?', ':', '"', '”', '’', ')'])
}

/// Appends a wrapped line, rejoining a word hyphenated across the break.
fn join(paragraph: &mut String, line: &str) {
    if paragraph.is_empty() {
        paragraph.push_str(line);
        return;
    }
    let hyphenated = paragraph.ends_with('-')
        && paragraph[..paragraph.len() - 1].chars().last().is_some_and(char::is_alphabetic)
        && line.chars().next().is_some_and(char::is_lowercase);
    if hyphenated {
        paragraph.pop();
    } else {
        paragraph.push(' ');
    }
    paragraph.push_str(line);
}

fn normalize(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}
