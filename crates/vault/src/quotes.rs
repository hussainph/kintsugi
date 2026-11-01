//! Who said a quoted passage, and where it is.
//!
//! A clip's source keeps the structure a quote needs (see `docs/ingest.md`):
//! comment headings with their author and permalink (Hacker News, Reddit),
//! timestamp links and speakers (YouTube, podcasts), page markers (PDFs).
//! [`quote_attribution`] finds a passage in that source and reads the
//! nearest anchor before it, so a reply is never read as the poster's
//! words and every quote can link back to its place. Articles without
//! anchors get a text fragment (`#:~:text=`), which browsers scroll to.

use serde::Serialize;
use url::Url;

/// Where a passage came from. Every field is optional: a passage that is
/// not found in the source gets nothing but (for articles) a text fragment.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteAttribution {
    /// The speaker: a comment's author, a transcript's speaker.
    pub by: Option<String>,
    /// A deep link: a comment permalink, a timestamp, `#page=N`, a text
    /// fragment. HTTP(S), or relative to the clip file for a saved PDF.
    pub link: Option<String>,
    /// How to show the link: `14:48`, `p. 12`, or none.
    pub label: Option<String>,
}

/// What a clip offers to anchor a passage in.
#[derive(Clone, Copy, Debug, Default)]
pub struct QuoteSource<'a> {
    /// The full extracted source (the sidecar when there is one).
    pub text: &'a str,
    /// The clip's URL.
    pub url: Option<&'a str>,
    /// A saved file, relative to the clip (`files/x.pdf`): page links use it
    /// when there is no web URL.
    pub file: Option<&'a str>,
    /// Whether the URL is a page a text fragment can scroll (an article,
    /// not a video or a post in a script-built app).
    pub fragments: bool,
}

/// Finds `passage` in the source and attributes it. Searching uses the
/// passage's first 120 characters, ignoring case, spacing, Markdown
/// escapes and emphasis, so a passage that runs past one paragraph still
/// matches.
pub fn quote_attribution(source: QuoteSource<'_>, passage: &str) -> QuoteAttribution {
    let passage = unquote(passage);
    let needle: String = normalize(&passage).chars().take(120).collect();
    let found = if needle.chars().count() >= 8 { locate(source.text, &needle) } else { None };
    let mut out = QuoteAttribution::default();
    let anchored = has_anchors(source.text);
    match found {
        Some(Anchor::Comment { by, link }) => {
            out.by = Some(by);
            out.link = link;
        }
        Some(Anchor::Time { label, link, by }) => {
            out.by = by;
            out.link = Some(link);
            out.label = Some(label);
        }
        Some(Anchor::Page(page)) => {
            let base = source.url.and_then(web).map(|mut u| {
                u.set_fragment(None);
                u.to_string()
            });
            if let Some(base) = base.or_else(|| source.file.map(str::to_string)) {
                out.link = Some(format!("{base}#page={page}"));
                out.label = Some(format!("p. {page}"));
            }
        }
        Some(Anchor::None) if !anchored => out.link = fragment(source, &passage),
        None if source.text.trim().is_empty() => out.link = fragment(source, &passage),
        _ => {}
    }
    out
}

/// The passage of a clip's own text: its leading block quote, if it has one.
pub fn leading_passage(own_text: &str) -> Option<String> {
    let lines: Vec<&str> = own_text
        .trim_start_matches(['\r', '\n'])
        .lines()
        .take_while(|l| l.trim_start().starts_with('>'))
        .collect();
    let passage = unquote(&lines.join("\n"));
    (!passage.trim().is_empty()).then(|| passage.trim().to_string())
}

#[derive(Debug, PartialEq)]
enum Anchor {
    Comment { by: String, link: Option<String> },
    Time { label: String, link: String, by: Option<String> },
    Page(usize),
    None,
}

fn locate(text: &str, needle: &str) -> Option<Anchor> {
    let mut page = None;
    // A comment heading per quote depth: (author, permalink).
    let mut comments: Vec<Option<(String, Option<String>)>> = Vec::new();
    let text = text.replace("\r\n", "\n");
    for (depth, body) in blocks(&text) {
        let body = body.trim();
        if let Some(n) = page_marker(body) {
            page = Some(n);
            continue;
        }
        if let Some((by, link)) = comment_heading(body) {
            comments.truncate(depth);
            comments.resize(depth + 1, None);
            comments[depth] = Some((by, link));
            continue;
        }
        let time = timestamp(body);
        let content = time.as_ref().map_or(body, |t| t.rest);
        if !normalize(content).contains(needle) {
            continue;
        }
        if let Some(t) = time {
            return Some(Anchor::Time { label: t.label, link: t.link, by: t.speaker });
        }
        // A comment's text shares its heading's quote depth.
        if let Some(Some((by, link))) = comments.get(depth) {
            return Some(Anchor::Comment { by: by.clone(), link: link.clone() });
        }
        return Some(page.map_or(Anchor::None, Anchor::Page));
    }
    None
}

/// Paragraphs with their quote depth. A quoted comment keeps its heading
/// and text in one Markdown block (`>` on the blank line between them), so
/// each block is split again once its marks are gone.
fn blocks(text: &str) -> Vec<(usize, String)> {
    let mut out = Vec::new();
    for block in text.split("\n\n") {
        let (depth, body) = strip_quotes(block);
        for part in body.split("\n\n") {
            if !part.trim().is_empty() {
                out.push((depth, part.to_string()));
            }
        }
    }
    out
}

fn has_anchors(text: &str) -> bool {
    blocks(&text.replace("\r\n", "\n")).iter().any(|(_, body)| {
        let body = body.trim();
        page_marker(body).is_some() || comment_heading(body).is_some() || timestamp(body).is_some()
    })
}

fn page_marker(line: &str) -> Option<usize> {
    line.strip_prefix("<!-- page ")?.strip_suffix(" -->")?.parse().ok()
}

/// `**name** · … · [link](<url>)`, as the HN and Reddit adapters write.
fn comment_heading(block: &str) -> Option<(String, Option<String>)> {
    if block.contains('\n') {
        return None;
    }
    let rest = block.strip_prefix("**")?;
    let end = rest.find("**")?;
    let name = unescape(&rest[..end]);
    let tail = &rest[end + 2..];
    if !tail.starts_with(" · ") || name.trim().is_empty() || name == "[deleted]" {
        return None;
    }
    let link = tail
        .find("[link](<")
        .map(|at| &tail[at + 8..])
        .and_then(|l| l.find(">)").map(|end| l[..end].to_string()))
        .filter(|l| web(l).is_some());
    Some((name.trim().to_string(), link))
}

struct Timestamp<'a> {
    label: String,
    link: String,
    speaker: Option<String>,
    rest: &'a str,
}

/// `[1:05](<url#t=65>) **Ken:** text`, as transcripts are written.
fn timestamp(block: &str) -> Option<Timestamp<'_>> {
    let rest = block.strip_prefix('[')?;
    let close = rest.find("](<")?;
    let label = &rest[..close];
    if label.is_empty() || !label.chars().all(|c| c.is_ascii_digit() || c == ':') {
        return None;
    }
    let after = &rest[close + 3..];
    let end = after.find(">)")?;
    let link = after[..end].to_string();
    web(&link)?;
    let mut text = after[end + 2..].trim_start();
    let mut speaker = None;
    if let Some(bold) = text.strip_prefix("**")
        && let Some(end) = bold.find(":**")
    {
        speaker = Some(unescape(&bold[..end]).trim().to_string()).filter(|s| !s.is_empty());
        text = bold[end + 3..].trim_start();
    }
    Some(Timestamp { label: label.to_string(), link, speaker, rest: text })
}

/// The quote depth of a block (`> > text` is 2) and its text without the marks.
fn strip_quotes(block: &str) -> (usize, String) {
    let first = block.trim_start_matches('\n').lines().next().unwrap_or("");
    let mut depth = 0;
    let mut rest = first.trim_start();
    while let Some(next) = rest.strip_prefix('>') {
        depth += 1;
        rest = next.trim_start_matches(' ');
    }
    let body = block
        .trim_start_matches('\n')
        .lines()
        .map(|line| {
            let mut line = line.trim_start();
            for _ in 0..depth {
                line = line.strip_prefix('>').map_or(line, |l| l.strip_prefix(' ').unwrap_or(l));
            }
            line
        })
        .collect::<Vec<_>>()
        .join("\n");
    (depth, body)
}

/// A block quote's lines without their `>` marks.
fn unquote(text: &str) -> String {
    text.lines()
        .map(|line| {
            let mut line = line.trim_start();
            while let Some(rest) = line.strip_prefix('>') {
                line = rest.trim_start();
            }
            line
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn unescape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' && chars.peek().is_some_and(|n| n.is_ascii_punctuation()) {
            continue;
        }
        out.push(c);
    }
    out
}

/// Lowercased words with Markdown escapes, emphasis and link targets gone.
fn normalize(text: &str) -> String {
    let mut plain = String::with_capacity(text.len());
    let mut rest = text;
    // `[label](<url>)` and `[label](url)` read as their label.
    while let Some(open) = rest.find('[') {
        plain.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        match after.find("](").map(|close| (close, &after[close + 2..])) {
            Some((close, target)) if !after[..close].contains('[') => {
                let end = if target.starts_with('<') { target.find(">)").map(|e| e + 2) } else { target.find(')').map(|e| e + 1) };
                match end {
                    Some(end) => {
                        plain.push_str(&after[..close]);
                        rest = &target[end..];
                    }
                    None => {
                        plain.push('[');
                        rest = after;
                    }
                }
            }
            _ => {
                plain.push('[');
                rest = after;
            }
        }
    }
    plain.push_str(rest);
    unescape(&plain)
        .replace(['*', '_'], "")
        .replace(['’', '‘'], "'")
        .replace(['“', '”'], "\"")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn web(raw: &str) -> Option<Url> {
    Url::parse(raw).ok().filter(|u| matches!(u.scheme(), "http" | "https") && u.host_str().is_some())
}

/// `url#:~:text=start,end` for the passage: the whole passage when it is
/// short, else its first and last five words.
fn fragment(source: QuoteSource<'_>, passage: &str) -> Option<String> {
    if !source.fragments {
        return None;
    }
    let mut url = web(source.url?)?;
    url.set_fragment(None);
    let words: Vec<String> = unescape(passage).split_whitespace().map(str::to_string).collect();
    if words.is_empty() {
        return None;
    }
    let text = if words.len() <= 10 {
        encode(&words.join(" "))
    } else {
        format!("{},{}", encode(&words[..5].join(" ")), encode(&words[words.len() - 5..].join(" ")))
    };
    Some(format!("{url}#:~:text={text}"))
}

/// Percent-encodes all but unreserved characters (text fragments reserve
/// `-`, `,` and `&` too).
fn encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 2);
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const THREAD: &str = "[inkandswitch.com](<https://www.inkandswitch.com/local-first.html>)\n\n## Comments\n\n\
**josephg** · 2019-05-01 · [link](<https://news.ycombinator.com/item?id=1>)\n\n\
I've spent years on CRDTs. The hard part isn't the algorithm, it's the *product*.\n\n\
> **pvh** · 2019-05-01 · OP · [link](<https://news.ycombinator.com/item?id=2>)\n>\n\
> Thanks, Joseph! The \\# product is the hard part.\n\n\
**u/theLightSlide** · 12 points · [link](<https://www.reddit.com/r/PKMS/comments/x/y/c3/>)\n\n\
Writing is where the system meets reality.";

    fn source(text: &str) -> QuoteSource<'_> {
        QuoteSource { text, url: Some("https://news.ycombinator.com/item?id=9"), file: None, fragments: false }
    }

    #[test]
    fn a_comment_passage_names_its_author_not_the_poster() {
        let reply = quote_attribution(source(THREAD), "> Thanks, Joseph! The # product\n> is the hard part.");
        assert_eq!(reply.by.as_deref(), Some("pvh"));
        assert_eq!(reply.link.as_deref(), Some("https://news.ycombinator.com/item?id=2"));
        let top = quote_attribution(source(THREAD), "the hard part isn’t the algorithm, it’s the product");
        assert_eq!(top.by.as_deref(), Some("josephg"));
        assert_eq!(top.link.as_deref(), Some("https://news.ycombinator.com/item?id=1"));
        let reddit = quote_attribution(source(THREAD), "Writing is where the system meets reality.");
        assert_eq!(reddit.by.as_deref(), Some("u/theLightSlide"));
        assert_eq!(quote_attribution(source(THREAD), "Words nobody wrote here at all."), QuoteAttribution::default());
    }

    #[test]
    fn a_transcript_passage_links_to_its_moment_and_speaker() {
        let text = "## The lacquer\n\n[0:41](<https://www.youtube.com/watch?v=abc&t=41s>) urushi lacquer takes weeks\n\n\
[14:48](<https://www.youtube.com/watch?v=abc&t=888s>) If it's clear and useless, it's useless.\n\n\
[1:05:00](<https://pod.example/12.mp3#t=3900>) **Ken:** Gold makes the crack visible.";
        let talk = quote_attribution(source(text), "If it's clear and useless, it's useless.");
        assert_eq!(talk.link.as_deref(), Some("https://www.youtube.com/watch?v=abc&t=888s"));
        assert_eq!(talk.label.as_deref(), Some("14:48"));
        assert_eq!(talk.by, None);
        let pod = quote_attribution(source(text), "Gold makes the crack visible");
        assert_eq!(pod.by.as_deref(), Some("Ken"));
        assert_eq!(pod.label.as_deref(), Some("1:05:00"));
    }

    #[test]
    fn a_pdf_passage_links_to_its_page() {
        let text = "<!-- page 1 -->\n\n## Local-first\n\nIntro text.\n\n<!-- page 3 -->\n\nWe call this type of software local-first software.";
        let linked = QuoteSource { text, url: Some("https://e.org/paper.pdf#x"), file: Some("files/paper.pdf"), fragments: true };
        let found = quote_attribution(linked, "We call this type of software local-first software.");
        assert_eq!(found.link.as_deref(), Some("https://e.org/paper.pdf#page=3"));
        assert_eq!(found.label.as_deref(), Some("p. 3"));
        let saved = QuoteSource { url: None, ..linked };
        assert_eq!(quote_attribution(saved, "intro text").link.as_deref(), Some("files/paper.pdf#page=1"));
    }

    #[test]
    fn an_article_passage_gets_a_text_fragment() {
        let text = "Paul Graham writes.\n\nWriting about something, even something you know well, usually shows you that you didn't know it as well as you thought.";
        let article = QuoteSource { text, url: Some("https://paulgraham.com/words.html"), file: None, fragments: true };
        let long = quote_attribution(article, "Writing about something, even something you know well, usually shows you that you didn't know it as well as you thought.");
        assert_eq!(
            long.link.as_deref(),
            Some("https://paulgraham.com/words.html#:~:text=Writing%20about%20something%2C%20even%20something,as%20well%20as%20you%20thought.")
        );
        let short = quote_attribution(article, "Paul Graham writes.");
        assert_eq!(short.link.as_deref(), Some("https://paulgraham.com/words.html#:~:text=Paul%20Graham%20writes."));
        assert_eq!(short.by, None);
        // A post in a script-built app: no fragment.
        assert_eq!(quote_attribution(QuoteSource { fragments: false, ..article }, "Paul Graham writes.").link, None);
        // Nothing fetched yet: the fragment still finds the passage on the page.
        let bare = QuoteSource { text: "", ..article };
        assert!(quote_attribution(bare, "Paul Graham writes.").link.is_some());
    }

    #[test]
    fn the_leading_block_quote_is_the_passage() {
        assert_eq!(leading_passage("\n> One\n> two\n\nMy note").as_deref(), Some("One\ntwo"));
        assert_eq!(leading_passage("My note\n\n> later quote"), None);
        assert_eq!(leading_passage("> \n>\n"), None);
    }
}
