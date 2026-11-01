//! Grounding: what a helper reports is checked before anything reaches
//! Hussain. The helper replies with JSON; every quote must appear, verbatim,
//! in the source it names, or the whole idea is dropped. Ideas carry facts,
//! a guess and evidence, never draft prose, so over-long or essay-shaped
//! fields drop the idea too.

use super::super::jobs::Trace;
use super::store::{Content, Footprint, Quote, Reason, Step};
use serde::Deserialize;
use serde_json::Value;

/// Ideas in one daily batch, at most.
pub const MAX_BATCH: usize = 5;
pub const MIN_QUOTES: usize = 2;
pub const MAX_QUOTES: usize = 4;
const MAX_TITLE: usize = 120;
const MAX_DRAFT_TITLE: usize = 80;
const MAX_SNIPPET: usize = 140;
const MAX_FACT: usize = 300;
const MAX_FACTS: usize = 5;
const MAX_HUNCH: usize = 600;
const MIN_QUOTE: usize = 8;
const MAX_QUOTE: usize = 400;
const MAX_STEPS: usize = 8;
const MAX_STEP: usize = 200;
const MAX_REASONS: usize = 4;

/// One idea as the helper wrote it. Lenient: anything missing is empty and
/// the checks decide.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Candidate {
    pub kind: String,
    pub title: String,
    pub draft_title: String,
    pub snippet: String,
    pub observed: Vec<String>,
    pub hunch: String,
    pub quotes: Vec<RawQuote>,
    pub steps: Vec<RawStep>,
    pub reasons: Vec<RawReason>,
    pub about: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct RawQuote {
    pub source: String,
    pub text: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct RawStep {
    pub did: String,
    pub found: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RawReason {
    pub text: String,
    pub profile_line: Option<String>,
}

/// A document a quote can come from.
#[derive(Debug, Clone, PartialEq)]
pub struct SourceDoc {
    /// The canonical id: a vault path with its extension, or `feed:<id>`.
    pub id: String,
    pub title: String,
    /// "Your writing", "Your note", a clip's site, "Feed · <source>".
    pub origin: String,
    pub own: bool,
    /// A wikilink target (vault path without extension), or a URL.
    pub link: Option<String>,
    pub text: String,
}

/// Where quotes are looked up: the vault, and the Feed.
pub trait Sources {
    fn get(&self, source: &str) -> Option<SourceDoc>;
}

/// Pulls the ideas out of a helper's report: a JSON array, `{ "ideas": [...] }`
/// or one idea object, bare, fenced or between `<ideas>` tags.
pub fn parse(report: &str) -> Result<Vec<Candidate>, String> {
    let body = between(report, "<ideas>", "</ideas>")
        .or_else(|| between(report, "```json", "```"))
        .or_else(|| between(report, "```", "```"))
        .unwrap_or(report)
        .trim();
    let value = serde_json::from_str::<Value>(body).ok().or_else(|| {
        // Prose around the JSON: take the outermost array or object.
        let start = body.find(['[', '{'])?;
        let close = if body[start..].starts_with('[') { ']' } else { '}' };
        let end = body.rfind(close)?;
        serde_json::from_str(&body[start..=end]).ok()
    });
    let Some(value) = value else { return Err("The helper's report wasn't the JSON it was asked for.".into()) };
    let list = match value {
        Value::Array(items) => items,
        Value::Object(mut map) => match map.remove("ideas") {
            Some(Value::Array(items)) => items,
            Some(other) => vec![other],
            None => vec![Value::Object(map)],
        },
        _ => return Err("The helper's report held no ideas.".into()),
    };
    Ok(list.into_iter().filter_map(|v| serde_json::from_value(v).ok()).collect())
}

fn between<'a>(text: &'a str, open: &str, close: &str) -> Option<&'a str> {
    let start = text.find(open)? + open.len();
    let end = text[start..].find(close)? + start;
    Some(&text[start..end])
}

/// Text as a quote is compared: typographic quotes, dashes and spaces
/// unified; Markdown emphasis, link brackets and blockquote markers dropped.
pub fn normalize(text: &str) -> String {
    let mut lines = String::with_capacity(text.len());
    for line in text.lines() {
        let line = line.trim_start();
        let line = line.trim_start_matches('>').trim_start();
        lines.push_str(line);
        lines.push(' ');
    }
    let mut out = String::with_capacity(lines.len());
    let mut space = true;
    for c in lines.chars() {
        let c = match c {
            '\u{2018}' | '\u{2019}' | '\u{02bc}' | '`' => '\'',
            '\u{201c}' | '\u{201d}' => '"',
            '\u{2013}' | '\u{2014}' | '\u{2212}' => '-',
            '\u{00a0}' | '\t' => ' ',
            '*' | '_' | '[' | ']' => continue,
            c => c,
        };
        if c.is_whitespace() {
            if !space {
                out.push(' ');
            }
            space = true;
        } else {
            out.push(c);
            space = false;
        }
    }
    out.trim().to_string()
}

/// True if `quote` appears verbatim in `source` (after [`normalize`]). An
/// ellipsis inside the quote marks an omission: each part must appear, in
/// order.
pub fn quoted_in(source: &str, quote: &str) -> bool {
    let source = normalize(source);
    let quote = normalize(&quote.replace('\u{2026}', "...")).trim_matches('"').trim().to_string();
    let parts: Vec<&str> = quote.split("...").map(|p| p.trim()).filter(|p| !p.is_empty()).collect();
    if parts.is_empty() || parts.iter().map(|p| p.chars().count()).sum::<usize>() < MIN_QUOTE {
        return false;
    }
    let mut from = 0;
    for part in parts {
        match source[from..].find(part) {
            Some(at) => from += at + part.len(),
            None => return false,
        }
    }
    true
}

/// The result of checking a helper's ideas.
#[derive(Debug, Default)]
pub struct Checked {
    pub accepted: Vec<Content>,
    /// Ideas that didn't pass, with why: (title, reason).
    pub dropped: Vec<(String, String)>,
}

fn clean(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn shorten(text: &str, max: usize) -> String {
    let text = clean(text);
    if text.chars().count() <= max {
        return text;
    }
    let cut: String = text.chars().take(max - 1).collect();
    let cut = cut.rsplit_once(' ').map_or(cut.as_str(), |(head, _)| head).trim_end_matches([',', ';', ':', '.']);
    format!("{cut}…")
}

/// Draft prose has paragraphs, headings and lists; an idea's hunch is a
/// sentence or two.
fn reads_like_prose(text: &str) -> bool {
    text.contains("\n\n") || text.lines().any(|l| l.trim_start().starts_with('#') || l.trim_start().starts_with("- "))
}

fn kind(kind: &str) -> String {
    let k = kind.trim().to_lowercase();
    match k.as_str() {
        "gap" | "tension" | "connection" | "stalled" => k,
        "stalled draft" | "stalled-draft" => "stalled".into(),
        _ => "other".into(),
    }
}

/// Checks one candidate. `about_you` is USER.md: a reason's profile line is
/// kept only if it really is one of its lines.
pub fn check_one(c: Candidate, sources: &dyn Sources, about_you: &[String], footprint: &Footprint) -> Result<Content, String> {
    let title = clean(&c.title);
    if title.is_empty() {
        return Err("it had no title".into());
    }
    if title.chars().count() > MAX_TITLE {
        return Err("its title ran long, like prose".into());
    }
    let hunch = c.hunch.trim().to_string();
    if hunch.is_empty() {
        return Err("it had no hunch".into());
    }
    if hunch.chars().count() > MAX_HUNCH || reads_like_prose(&hunch) {
        return Err("its hunch read like draft prose".into());
    }
    let observed: Vec<String> = c.observed.iter().map(|f| clean(f)).filter(|f| !f.is_empty()).collect();
    if observed.is_empty() {
        return Err("it observed nothing checkable".into());
    }
    if observed.iter().any(|f| f.chars().count() > MAX_FACT) {
        return Err("an observation read like prose".into());
    }
    if c.quotes.len() < MIN_QUOTES {
        return Err(format!("it quoted {} source(s); ideas need {MIN_QUOTES} to {MAX_QUOTES}", c.quotes.len()));
    }
    let mut quotes = Vec::new();
    for raw in c.quotes.iter().take(MAX_QUOTES) {
        let text = raw.text.trim().trim_matches(['"', '\u{201c}', '\u{201d}']).trim().to_string();
        let len = text.chars().count();
        if !(MIN_QUOTE..=MAX_QUOTE).contains(&len) {
            return Err(format!("a quote from {} was too short or too long", raw.source.trim()));
        }
        let Some(doc) = sources.get(&raw.source) else {
            return Err(format!("it quoted {}, which isn't in the vault or the Feed", raw.source.trim()));
        };
        if !quoted_in(&doc.text, &text) {
            return Err(format!("a quote isn't in {}", doc.id));
        }
        quotes.push(Quote { source: doc.id, text, title: doc.title, origin: doc.origin, own: doc.own, link: doc.link });
    }
    let profile: Vec<String> = about_you.iter().map(|l| normalize(l).to_lowercase()).collect();
    let reasons = c
        .reasons
        .iter()
        .map(|r| (clean(&r.text), r.profile_line.as_deref().map(str::trim).unwrap_or_default().to_string()))
        .filter(|(text, _)| !text.is_empty())
        .take(MAX_REASONS)
        .enumerate()
        .map(|(i, (text, line))| {
            let line = normalize(&line).to_lowercase();
            let found = (!line.is_empty()).then(|| about_you.iter().zip(&profile).find(|(_, p)| **p == line || p.contains(&line)).map(|(l, _)| l.clone())).flatten();
            Reason { id: format!("r{}", i + 1), text: shorten(&text, MAX_FACT), profile_line: found, removed: false }
        })
        .collect();
    let steps = c
        .steps
        .iter()
        .filter(|s| !s.did.trim().is_empty())
        .take(MAX_STEPS)
        .map(|s| Step { did: shorten(&s.did, MAX_STEP), found: s.found.as_deref().map(|f| shorten(f, MAX_STEP)).filter(|f| !f.is_empty()) })
        .collect();
    let about = c.about.iter().filter_map(|p| sources.get(p)).filter(|d| !d.id.starts_with("feed:")).map(|d| d.id).collect();
    let draft_title = Some(clean(&c.draft_title)).filter(|t| !t.is_empty() && t.chars().count() <= MAX_DRAFT_TITLE).unwrap_or_else(|| shorten(&title, 60));
    Ok(Content {
        kind: kind(&c.kind),
        snippet: shorten(if c.snippet.trim().is_empty() { &observed[0] } else { &c.snippet }, MAX_SNIPPET),
        title,
        draft_title,
        observed: observed.into_iter().take(MAX_FACTS).collect(),
        hunch: clean(&hunch),
        quotes,
        steps,
        reasons,
        about,
        footprint: footprint.clone(),
    })
}

/// Checks a batch, keeping at most `max` ideas.
pub fn check(candidates: Vec<Candidate>, sources: &dyn Sources, about_you: &[String], footprint: &Footprint, max: usize) -> Checked {
    let mut out = Checked::default();
    for c in candidates {
        let title = clean(&c.title);
        match check_one(c, sources, about_you, footprint) {
            Ok(_) if out.accepted.len() >= max => out.dropped.push((title, format!("the batch already had {max}"))),
            Ok(content) if out.accepted.iter().any(|a| a.title.eq_ignore_ascii_case(&content.title)) => {
                out.dropped.push((title, "it repeated another idea".into()))
            }
            Ok(content) => out.accepted.push(content),
            Err(why) => out.dropped.push((title, why)),
        }
    }
    out
}

/// The footprint of a helper run, shared by every idea it produced.
pub fn footprint(trace: &Trace, ideas: usize) -> Footprint {
    let mut files = trace.files.clone();
    files.sort();
    files.dedup();
    Footprint {
        searches: trace.searches.len() as u32,
        files: files.len() as u32,
        seconds: (trace.millis as f64 / 1000.0).round() as u32,
        usd: trace.usd,
        model: trace.model.clone(),
        batch: ideas as u32,
    }
}
