//! PDFKit gives text line by line with font sizes and positions. This turns
//! it into readable Markdown: headings from larger type, paragraphs rebuilt
//! from wrapped lines (and words hyphenated across them), running headers,
//! footers and page numbers dropped, two-column pages read column by
//! column, and every page's start marked with `<!-- page N -->` so a quote
//! can link to `#page=N`. Pure, so it is tested without PDFKit.

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
    /// The page's width in points (helpers before KI-46 didn't say).
    pub width: Option<f64>,
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
    /// Left edge and width, in points, when the helper reports them.
    pub x: Option<f64>,
    pub width: Option<f64>,
    /// The bounds' height: more than one line's when PDFKit joined several.
    pub height: Option<f64>,
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

/// The invisible marker before the first block that starts on page `n`.
/// Text from the PDF can't forge it: `<` in extracted text is escaped.
pub fn page_marker(n: usize) -> String {
    format!("<!-- page {n} -->")
}

/// The page a marker line names.
pub fn marker_page(line: &str) -> Option<usize> {
    line.trim().strip_prefix("<!-- page ")?.strip_suffix(" -->")?.parse().ok()
}

/// Blocks with a page marker whenever the page a block starts on changes.
struct Blocks {
    blocks: Vec<String>,
    marked: Option<usize>,
    mark: bool,
}

impl Blocks {
    fn push(&mut self, page: usize, block: String) {
        if self.mark && self.marked != Some(page) {
            self.blocks.push(page_marker(page));
            self.marked = Some(page);
        }
        self.blocks.push(block);
    }
}

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

    let mut out = Blocks { blocks: Vec::new(), marked: None, mark: doc.pages.len() > 1 };
    // Each pending block remembers the page it started on.
    let mut paragraph = String::new();
    let mut paragraph_page = 0;
    let mut heading: Option<(f64, String, usize)> = None;
    let flush = |paragraph: &mut String, page: usize, out: &mut Blocks| {
        if !paragraph.trim().is_empty() {
            out.push(page, plain(paragraph.trim()));
        }
        paragraph.clear();
    };
    let flush_heading = |heading: &mut Option<(f64, String, usize)>, out: &mut Blocks| {
        if let Some((size, text, page)) = heading.take() {
            let rank = heading_sizes.iter().position(|s| (s - size).abs() < 0.5).unwrap_or(0);
            let marks = "#".repeat((rank + 2).min(4));
            out.push(page, format!("{marks} {}", plain(text.trim()).trim_start_matches('\\')));
        }
    };
    for page in &doc.pages {
        let mut previous_y: Option<f64> = None;
        let mut previous_x: Option<f64> = None;
        // A jump this far sideways is a move to the other column.
        let order = reading_order(page);
        let column_jump = match (page.width, two_columns(page)) {
            (Some(width), true) => width / 4.0,
            _ => f64::INFINITY,
        };
        for (position, &index) in order.iter().enumerate() {
            let line = &page.lines[index];
            let text = line.text.trim();
            if text.is_empty() || is_furniture(&furniture, order.len(), position, text) {
                continue;
            }
            if let Some(marks) = numbered_heading(line, body_size) {
                flush(&mut paragraph, paragraph_page, &mut out);
                flush_heading(&mut heading, &mut out);
                out.push(page.page, format!("{marks} {}", plain(text).trim_start_matches('\\')));
                previous_y = Some(line.y);
                continue;
            }
            let outline_heading = use_outline && outline.contains(&normalize(text));
            if (is_heading(line, body_size) || outline_heading) && text.chars().count() <= HEADING_CHARS {
                flush(&mut paragraph, paragraph_page, &mut out);
                let size = if outline_heading { heading_sizes.first().copied().unwrap_or(line.size) } else { line.size };
                match &mut heading {
                    // A title wrapped over two lines in the same type.
                    Some((current, words, _)) if (*current - size).abs() < 0.5 && previous_y.is_some() => {
                        words.push(' ');
                        words.push_str(text);
                    }
                    _ => {
                        flush_heading(&mut heading, &mut out);
                        heading = Some((size, text.to_string(), page.page));
                    }
                }
                previous_y = Some(line.y);
                continue;
            }
            flush_heading(&mut heading, &mut out);
            let bullet = bullet(text);
            let jumped = previous_x.zip(line.x).is_some_and(|(a, b)| (a - b).abs() > column_jump);
            let spaced = previous_y.is_some_and(|y| y - line.y > gap * 1.5 || line.y > y) || jumped;
            if bullet.is_some() || spaced || (previous_y.is_none() && ends_sentence(&paragraph)) {
                flush(&mut paragraph, paragraph_page, &mut out);
            }
            if let Some(rest) = bullet {
                out.push(page.page, format!("- {}", plain(rest)));
            } else {
                if paragraph.is_empty() {
                    paragraph_page = page.page;
                }
                join(&mut paragraph, text);
            }
            previous_y = Some(line.y);
            previous_x = line.x;
        }
        flush_heading(&mut heading, &mut out);
    }
    flush(&mut paragraph, paragraph_page, &mut out);
    out.blocks.join("\n\n")
}

/// Which column a line sits in on a page of `width` points.
#[derive(Clone, Copy, PartialEq)]
enum Column {
    Left,
    Right,
    Full,
}

/// The order to read a page's lines in. PDFKit gives a two-column page in
/// its content-stream order, which can interleave the columns (an author
/// block beside an abstract). When at least three lines sit wholly in each
/// half of the page and column lines outnumber full-width ones, lines are
/// read top to bottom in bands split by full-width lines: within a band,
/// the left column, then the right. Otherwise (or without positions) the
/// helper's order stands.
fn reading_order(page: &PageText) -> Vec<usize> {
    let natural: Vec<usize> = (0..page.lines.len()).collect();
    let Some(columns) = columns(page) else { return natural };
    let mut by_height = natural;
    by_height.sort_by(|&a, &b| {
        let (a, b) = (&page.lines[a], &page.lines[b]);
        let top = |l: &Line| l.y + l.height.unwrap_or(l.size);
        top(b).total_cmp(&top(a)).then(a.x.unwrap_or(0.0).total_cmp(&b.x.unwrap_or(0.0)))
    });
    let mut order = Vec::with_capacity(by_height.len());
    let (mut lefts, mut rights) = (Vec::new(), Vec::new());
    for index in by_height {
        match columns[index] {
            Column::Left => lefts.push(index),
            Column::Right => rights.push(index),
            Column::Full => {
                order.append(&mut lefts);
                order.append(&mut rights);
                order.push(index);
            }
        }
    }
    order.append(&mut lefts);
    order.append(&mut rights);
    order
}

fn two_columns(page: &PageText) -> bool {
    columns(page).is_some()
}

/// Each line's column, when the page is set in two.
fn columns(page: &PageText) -> Option<Vec<Column>> {
    let width = page.width.filter(|w| *w > 0.0)?;
    let (mid, tolerance) = (width / 2.0, width * 0.02);
    let columns: Option<Vec<Column>> = page
        .lines
        .iter()
        .map(|l| match (l.x, l.width) {
            (Some(x), Some(w)) if w >= 0.0 => Some(if x + w <= mid + tolerance {
                Column::Left
            } else if x >= mid - tolerance {
                Column::Right
            } else {
                Column::Full
            }),
            _ => None,
        })
        .collect();
    let columns = columns?;
    let count = |c: Column| columns.iter().filter(|x| **x == c).count();
    let (left, right, full) = (count(Column::Left), count(Column::Right), count(Column::Full));
    (left >= 3 && right >= 3 && left + right > full).then_some(columns)
}

/// A line in body-size type that is only a section number (`2`, `2.1`,
/// `3.4.1.`) and a title, bold or in title case, is a section heading:
/// `###` for a top-level number, `####` below it. Papers often set these in
/// the body size, where the size rule can't see them.
fn numbered_heading(line: &Line, body_size: f64) -> Option<&'static str> {
    let text = line.text.trim();
    if text.chars().count() > 100 || (body_size > 0.0 && line.size >= body_size * HEADING_RATIO) {
        return None;
    }
    let number: String = text.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
    let rest = text[number.len()..].strip_prefix(' ')?.trim_start();
    let parts: Vec<&str> = number.trim_end_matches('.').split('.').collect();
    let valid = !number.is_empty()
        && !number.starts_with('.')
        && parts.len() <= 4
        && parts.iter().all(|p| (1..=2).contains(&p.len()))
        && rest.chars().next().is_some_and(char::is_uppercase)
        && !rest.ends_with(['.', ',', ';', '-'])
        && (line.bold || title_case(rest));
    valid.then_some(if parts.len() == 1 { "###" } else { "####" })
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
        .flat_map(|p| reading_order(p).windows(2).map(|w| (&p.lines[w[0]], &p.lines[w[1]])).collect::<Vec<_>>())
        .filter(|(a, b)| (a.size - body_size).abs() < 0.5 && (b.size - body_size).abs() < 0.5)
        .map(|(a, b)| a.y - b.y)
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

/// The first and last two lines of a page, in reading order.
fn edges(page: &PageText) -> impl Iterator<Item = &Line> {
    let order = reading_order(page);
    let n = order.len();
    order.into_iter().enumerate().filter(move |(i, _)| *i < 2 || *i + 2 >= n).map(|(_, l)| &page.lines[l])
}

fn is_furniture(furniture: &[String], lines: usize, position: usize, text: &str) -> bool {
    let at_edge = position < 2 || position + 2 >= lines;
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

/// Most words of four letters or more start with a capital.
fn title_case(text: &str) -> bool {
    let long: Vec<&str> = text.split_whitespace().filter(|w| w.chars().filter(|c| c.is_alphabetic()).count() >= 4).collect();
    let capital = long.iter().filter(|w| w.chars().find(|c| c.is_alphabetic()).is_some_and(char::is_uppercase)).count();
    !long.is_empty() && capital * 3 >= long.len() * 2
}

fn normalize(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}
