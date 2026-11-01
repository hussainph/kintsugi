//! Timed transcripts: parsing caption formats into [`Segment`]s and turning
//! them into an item's Markdown body, where every paragraph starts with a
//! timestamp that links to that moment, so a quote can deep-link to it.
//!
//! Formats: WebVTT (including YouTube's rolling auto-captions), SubRip, the
//! Podcasting 2.0 JSON transcript, and untimed HTML or plain text.

use crate::markdown;
use serde::{Deserialize, Serialize};

/// Transcript bodies may be longer than an article's: an hour of speech is
/// about 55,000 characters with timestamps.
pub const TRANSCRIPT_CHARS: usize = 250_000;

/// One timed piece of speech. Times are seconds from the start.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Segment {
    pub start: f64,
    pub end: f64,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaker: Option<String>,
}

/// A titled section (YouTube chapters, podcast chapters).
#[derive(Debug, Clone, PartialEq)]
pub struct Chapter {
    pub start: f64,
    pub title: String,
}

/// What a transcript file turned into.
#[derive(Debug, Clone, PartialEq)]
pub enum Parsed {
    Timed(Vec<Segment>),
    /// HTML or plain text without times: already Markdown.
    Untimed(String),
}

/// Parses a transcript by MIME type, sniffing when the type is unhelpful.
pub fn parse(text: &str, mime: &str) -> Option<Parsed> {
    let mime = mime.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    let trimmed = text.trim_start_matches('\u{feff}').trim_start();
    let timed = match mime.as_str() {
        "application/json" | "application/x-podcast-transcript+json" => parse_json(trimmed),
        "text/vtt" | "text/srt" | "application/srt" | "application/x-subrip" => parse_cues(trimmed),
        "text/html" | "application/xhtml+xml" => return untimed_html(trimmed),
        "text/plain" => return untimed_text(trimmed),
        _ if trimmed.starts_with('{') => parse_json(trimmed),
        _ if trimmed.starts_with("WEBVTT") || trimmed.contains("-->") => parse_cues(trimmed),
        _ if trimmed.starts_with('<') => return untimed_html(trimmed),
        _ => return untimed_text(trimmed),
    };
    (!timed.is_empty()).then_some(Parsed::Timed(timed))
}

/// WebVTT and SubRip cues. YouTube's auto-captions repeat each line in the
/// next cue (a rolling two-line window); a line already shown by the
/// previous cue extends its segment instead of repeating.
pub fn parse_cues(text: &str) -> Vec<Segment> {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut segments: Vec<Segment> = Vec::new();
    let mut previous: Vec<String> = Vec::new();
    for block in text.split("\n\n") {
        let mut lines = block.lines().skip_while(|l| !l.contains("-->"));
        let Some(timing) = lines.next() else { continue };
        let Some((start, end)) = cue_times(timing) else { continue };
        let mut current = Vec::new();
        for raw in lines {
            let (speaker, line) = clean_cue_line(raw);
            if line.is_empty() {
                continue;
            }
            if previous.contains(&line) {
                if let Some(seg) = segments.iter_mut().rev().take(4).find(|s| s.text == line) {
                    seg.end = seg.end.max(end);
                }
            } else if let Some(last) = segments.last_mut().filter(|s| s.text == line && start - s.end < 0.5) {
                last.end = last.end.max(end);
            } else {
                segments.push(Segment { start, end, text: line.clone(), speaker });
            }
            current.push(line);
        }
        previous = current;
    }
    segments
}

fn cue_times(line: &str) -> Option<(f64, f64)> {
    let (a, b) = line.split_once("-->")?;
    let start = clock(a.split_whitespace().next()?)?;
    let end = clock(b.split_whitespace().next()?)?;
    Some((start, end.max(start)))
}

/// `hh:mm:ss.mmm`, `mm:ss.mmm` or SubRip's `hh:mm:ss,mmm`.
fn clock(s: &str) -> Option<f64> {
    let s = s.replace(',', ".");
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() < 2 || parts.len() > 3 {
        return None;
    }
    let mut total = 0.0;
    for (i, part) in parts.iter().enumerate() {
        let value: f64 = part.parse().ok()?;
        if !value.is_finite() || value < 0.0 || (i + 1 < parts.len() && part.contains('.')) {
            return None;
        }
        total = total * 60.0 + value;
    }
    Some(total)
}

/// Drops cue markup (`<c>`, inline `<00:00:01.000>` times, styling),
/// keeps a `<v Speaker>` voice as the speaker, decodes entities.
fn clean_cue_line(line: &str) -> (Option<String>, String) {
    let mut speaker = None;
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(open) = rest.find('<') {
        out.push_str(&rest[..open]);
        let Some(close) = rest[open..].find('>') else {
            rest = "";
            break;
        };
        let tag = &rest[open + 1..open + close];
        if let Some(name) = tag.strip_prefix("v ").or_else(|| tag.strip_prefix("v.").and_then(|t| t.split_once(' ').map(|x| x.1)))
        {
            speaker = markdown::field(name, 80);
        }
        rest = &rest[open + close + 1..];
    }
    out.push_str(rest);
    (speaker, decode_entities(&out).split_whitespace().collect::<Vec<_>>().join(" "))
}

fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    s.replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&lrm;", "")
        .replace("&rlm;", "")
        .replace("&amp;", "&")
}

/// The Podcasting 2.0 JSON transcript: `{ version, segments: [{ speaker?,
/// startTime, endTime, body }] }`. Segments are often single words.
pub fn parse_json(text: &str) -> Vec<Segment> {
    #[derive(Deserialize)]
    struct File {
        segments: Vec<serde_json::Value>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Raw {
        speaker: Option<String>,
        start_time: Option<f64>,
        end_time: Option<f64>,
        body: Option<String>,
    }
    let Ok(file) = serde_json::from_str::<File>(text) else { return vec![] };
    file.segments
        .into_iter()
        .filter_map(|value| serde_json::from_value::<Raw>(value).ok())
        .filter_map(|raw| {
            let start = raw.start_time.filter(|t| t.is_finite() && *t >= 0.0)?;
            let text = raw.body.as_deref().map(|b| b.split_whitespace().collect::<Vec<_>>().join(" "))?;
            (!text.is_empty()).then(|| Segment {
                start,
                end: raw.end_time.filter(|t| t.is_finite()).unwrap_or(start).max(start),
                text,
                speaker: raw.speaker.as_deref().and_then(|s| markdown::field(s, 80)),
            })
        })
        .collect()
}

fn untimed_html(html: &str) -> Option<Parsed> {
    let doc = dom_query::Document::from(html);
    let body = doc.select("body");
    let md = body.nodes().first().map(|root| root.md(Some(&["script", "style", "nav", "header", "footer"])))?;
    let md = markdown::body(&md, TRANSCRIPT_CHARS);
    (!md.trim().is_empty()).then_some(Parsed::Untimed(md))
}

fn untimed_text(text: &str) -> Option<Parsed> {
    let escaped: String = text.lines().map(escape).collect::<Vec<_>>().join("\n");
    let md = markdown::body(&escaped, TRANSCRIPT_CHARS);
    (!md.trim().is_empty()).then_some(Parsed::Untimed(md))
}

/// `1:02:03`, or `2:03` under an hour.
pub fn timestamp(seconds: f64) -> String {
    let total = seconds.max(0.0) as u64;
    let (h, m, s) = (total / 3600, total / 60 % 60, total % 60);
    if h > 0 { format!("{h}:{m:02}:{s:02}") } else { format!("{m}:{s:02}") }
}

/// Transcript text is untrusted: keep it from forming links, HTML or
/// emphasis when it becomes Markdown.
fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if matches!(c, '\\' | '[' | ']' | '<' | '>' | '*' | '`' | '|') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Renders segments as Markdown paragraphs, each led by a timestamp link
/// (`link(seconds)` returns the URL for that moment, or `None` for plain
/// text). A paragraph breaks at a new speaker or chapter, after a pause
/// once it is half a minute long, or at a minute regardless. Chapters
/// become `##` headings. Returns the body and whether it was cut.
pub fn to_markdown(segments: &[Segment], chapters: &[Chapter], link: &dyn Fn(u64) -> Option<String>) -> (String, bool) {
    let mut out = String::new();
    let mut chapters = chapters.iter().peekable();
    let mut i = 0;
    while i < segments.len() {
        while let Some(chapter) = chapters.next_if(|c| c.start <= segments[i].start + 0.5) {
            out.push_str(&format!("## {}\n\n", escape(&chapter.title)));
        }
        let first = &segments[i];
        let mut words = vec![first.text.as_str()];
        let mut j = i + 1;
        while j < segments.len() {
            let (prev, next) = (&segments[j - 1], &segments[j]);
            let span = next.start - first.start;
            let pause = next.start - prev.end;
            let sentence_end = prev.text.ends_with(['.', '?', '!', '"', '”']);
            let chapter_starts = chapters.peek().is_some_and(|c| c.start <= next.start + 0.5);
            if next.speaker != first.speaker
                || chapter_starts
                || span >= 60.0
                || (span >= 30.0 && (pause >= 1.5 || sentence_end))
            {
                break;
            }
            words.push(next.text.as_str());
            j += 1;
        }
        let seconds = first.start.max(0.0) as u64;
        let stamp = timestamp(first.start);
        match link(seconds) {
            Some(url) => out.push_str(&format!("[{stamp}](<{url}>)")),
            None => out.push_str(&format!("**{stamp}**")),
        }
        if let Some(speaker) = &first.speaker {
            out.push_str(&format!(" **{}:**", escape(speaker)));
        }
        out.push(' ');
        out.push_str(&escape(&words.join(" ")));
        out.push_str("\n\n");
        i = j;
        if out.len() > TRANSCRIPT_CHARS * 4 {
            break;
        }
    }
    let full = out.trim_end().to_string();
    let body = markdown::body(&full, TRANSCRIPT_CHARS);
    let cut = body.len() < full.len();
    (body, cut)
}

#[cfg(test)]
mod tests {
    use super::*;

    const YOUTUBE_AUTO: &str = "WEBVTT\nKind: captions\nLanguage: en\n\n\
00:00:00.000 --> 00:00:02.390 align:start position:0%\n \nhello<00:00:00.480><c> and</c><00:00:00.640><c> welcome</c>\n\n\
00:00:02.390 --> 00:00:02.400 align:start position:0%\nhello and welcome\n \n\n\
00:00:02.400 --> 00:00:05.000 align:start position:0%\nhello and welcome\nto<00:00:02.800><c> the</c><c> show</c>\n\n\
00:00:05.000 --> 00:00:05.010 align:start position:0%\nto the show\n \n\n\
00:00:05.010 --> 00:00:07.000 align:start position:0%\nto the show\nwe&#39;re &amp; <00:00:05.500><c>back</c>\n";

    #[test]
    fn youtube_rolling_auto_captions_are_deduplicated() {
        let segments = parse_cues(YOUTUBE_AUTO);
        let text: Vec<_> = segments.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(text, ["hello and welcome", "to the show", "we're & back"]);
        assert_eq!(segments[0].start, 0.0);
        assert_eq!(segments[1].start, 2.4);
        assert_eq!(segments[1].end, 7.0, "the repeat extends it");
    }

    #[test]
    fn subrip_and_vtt_voices() {
        let srt = "1\r\n00:00:01,500 --> 00:00:03,000\r\nFirst line\r\nsecond half\r\n\r\n2\r\n01:02:03,000 --> 01:02:04,000\r\nLater\r\n";
        let segments = parse_cues(srt);
        assert_eq!(segments.len(), 3);
        assert_eq!(segments[0].start, 1.5);
        assert_eq!(segments[2].start, 3723.0);
        let vtt = "WEBVTT\n\nNOTE skip me --> not a cue? no\n\n00:01.000 --> 00:02.000\n<v Ana Lopez>Hi there</v>\n";
        let segments = parse_cues(vtt);
        assert_eq!(segments.last().unwrap().speaker.as_deref(), Some("Ana Lopez"));
        assert_eq!(segments.last().unwrap().text, "Hi there");
    }

    #[test]
    fn podcasting_json_transcripts() {
        let json = r#"{"version":"1.0.0","segments":[
            {"speaker":"Host","startTime":0.5,"endTime":1.0,"body":"Welcome"},
            {"speaker":"Host","startTime":1.0,"endTime":1.4,"body":"back."},
            {"startTime":"bad","body":"skipped"},
            {"speaker":"Guest","startTime":2.0,"endTime":3.0,"body":"Thanks"}]}"#;
        let Some(Parsed::Timed(segments)) = parse(json, "application/json") else { panic!() };
        assert_eq!(segments.len(), 3);
        let (md, cut) = to_markdown(&segments, &[], &|t| Some(format!("https://e.org/a.mp3#t={t}")));
        assert!(!cut);
        assert_eq!(
            md,
            "[0:00](<https://e.org/a.mp3#t=0>) **Host:** Welcome back.\n\n[0:02](<https://e.org/a.mp3#t=2>) **Guest:** Thanks"
        );
    }

    #[test]
    fn paragraphs_break_at_pauses_minutes_and_chapters() {
        let seg = |start: f64, text: &str| Segment { start, end: start + 2.0, text: text.into(), speaker: None };
        let segments: Vec<_> = (0..40).map(|i| seg(i as f64 * 2.0, if i % 10 == 9 { "end." } else { "word" })).collect();
        let chapters = [Chapter { start: 0.0, title: "Intro".into() }, Chapter { start: 70.0, title: "Part [2]".into() }];
        let (md, _) = to_markdown(&segments, &chapters, &|t| Some(format!("https://youtu.be/x?t={t}")));
        let paragraphs: Vec<_> = md.split("\n\n").collect();
        assert_eq!(paragraphs[0], "## Intro");
        assert!(paragraphs[1].starts_with("[0:00](<https://youtu.be/x?t=0>) word word"));
        assert!(paragraphs[2].starts_with("[0:40]"), "{md}");
        assert_eq!(paragraphs[3], "## Part \\[2\\]");
        assert!(paragraphs[4].starts_with("[1:10]"), "{md}");
    }

    #[test]
    fn untrusted_text_cannot_form_links_and_untimed_formats_pass_through() {
        let segments = [Segment { start: 3725.0, end: 3726.0, text: "[click](javascript:x) <b>".into(), speaker: None }];
        let (md, _) = to_markdown(&segments, &[], &|_| None);
        assert_eq!(md, r"**1:02:05** \[click\](javascript:x) \<b\>");
        let Some(Parsed::Untimed(html)) = parse("<html><body><p>Hello <b>there</b></p><script>x</script></body></html>", "text/html")
        else {
            panic!()
        };
        assert_eq!(html, "Hello **there**");
        assert_eq!(parse("Just words", "text/plain"), Some(Parsed::Untimed("Just words".into())));
        assert_eq!(parse("", "text/vtt"), None);
    }

    #[test]
    fn long_transcripts_are_cut_at_a_paragraph() {
        let segments: Vec<_> = (0..20_000)
            .map(|i| Segment { start: i as f64 * 10.0, end: i as f64 * 10.0 + 9.0, text: "a".repeat(30) + ".", speaker: None })
            .collect();
        let (md, cut) = to_markdown(&segments, &[], &|_| None);
        assert!(cut);
        assert!(md.chars().count() <= TRANSCRIPT_CHARS);
        assert!(md.ends_with('.'));
    }
}
