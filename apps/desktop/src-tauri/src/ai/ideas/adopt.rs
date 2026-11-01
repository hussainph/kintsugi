//! What Adopt writes: the idea lives in the draft's frontmatter, never in
//! its body. `ideas:` is a list, so a draft can carry more than one, and
//! each clip is a `[[wikilink]]`, so the clip shows the draft under Used in.

use super::store::Idea;

type Result<T> = std::result::Result<T, String>;

fn q(text: &str) -> String {
    // A JSON string is a valid double-quoted YAML scalar.
    serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into())
}

/// The vault path without its extension, as a wikilink writes it.
fn stem(path: &str) -> &str {
    path.strip_suffix(".mdx").or_else(|| path.strip_suffix(".md")).unwrap_or(path)
}

/// Clips beside a draft: one per vault source, never the draft itself.
pub fn clips(idea: &Idea, draft: Option<&str>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for quote in &idea.content.quotes {
        if quote.source.starts_with("feed:") || draft.is_some_and(|d| stem(d) == stem(&quote.source)) {
            continue;
        }
        let link = stem(&quote.source).to_string();
        if !out.contains(&link) {
            out.push(link);
        }
    }
    out
}

/// One entry of the `ideas:` list, indented under it.
pub fn entry(idea: &Idea, offered: &str, draft: Option<&str>) -> String {
    let mut out = format!(
        "  - id: {}\n    from: kin\n    offered: {offered}\n    title: {}\n    hunch: {}\n",
        idea.id,
        q(&idea.content.title),
        q(&idea.content.hunch)
    );
    let clips = clips(idea, draft);
    if clips.is_empty() {
        out.push_str("    clips: []\n");
    } else {
        out.push_str("    clips:\n");
        for clip in clips {
            out.push_str(&format!("      - {}\n", q(&format!("[[{clip}]]"))));
        }
    }
    out
}

/// A new draft: a working title, an empty body, the idea in frontmatter.
pub fn new_draft(title: &str, idea: &Idea, offered: &str, path: &str) -> String {
    format!("---\ntitle: {}\nstatus: draft\nideas:\n{}---\n\n", q(title), entry(idea, offered, Some(path)))
}

/// Adds the idea to a draft already started. Its body, other fields and
/// earlier ideas stay exactly as they were. Adding the same idea twice
/// changes nothing.
pub fn attach(text: &str, idea: &Idea, offered: &str, path: &str) -> Result<String> {
    let entry = entry(idea, offered, Some(path));
    let bom = if text.starts_with('\u{feff}') { "\u{feff}" } else { "" };
    let text = &text[bom.len()..];
    let mut lines: Vec<&str> = text.split_inclusive('\n').collect();
    let opens = lines.first().is_some_and(|l| l.trim_end() == "---");
    let close = opens.then(|| lines.iter().skip(1).position(|l| l.trim_end() == "---").map(|i| i + 1)).flatten();
    let Some(close) = close else {
        // No frontmatter (or an unfinished one): start a block above the body.
        if opens {
            return Err("This draft's frontmatter isn't closed; fix it before adding an idea.".into());
        }
        return Ok(format!("{bom}---\nideas:\n{entry}---\n\n{text}"));
    };
    let block = &lines[1..close];
    if block.iter().any(|l| l.trim() == format!("- id: {}", idea.id)) {
        return Ok(format!("{bom}{text}"));
    }
    match block.iter().position(|l| l.split(':').next().map(str::trim_end) == Some("ideas") && !l.starts_with(char::is_whitespace)) {
        Some(i) => {
            let at = i + 1;
            let value = lines[at].split_once(':').map(|(_, v)| v.trim()).unwrap_or_default();
            if !value.is_empty() && value != "[]" {
                return Err("This draft's ideas field isn't a list Kintsugi can add to.".into());
            }
            let replaced = "ideas:\n";
            lines[at] = replaced;
            // The list ends at the next line that isn't indented.
            let end = (at + 1..close).find(|&j| !lines[j].starts_with(char::is_whitespace) && !lines[j].trim().is_empty()).unwrap_or(close);
            let mut out: String = lines[..end].concat();
            if end > 0 && !lines[end - 1].ends_with('\n') {
                out.push('\n');
            }
            out.push_str(&entry);
            out.push_str(&lines[end..].concat());
            Ok(format!("{bom}{out}"))
        }
        None => {
            let mut out: String = lines[..close].concat();
            if !lines[close - 1].ends_with('\n') {
                out.push('\n');
            }
            out.push_str("ideas:\n");
            out.push_str(&entry);
            out.push_str(&lines[close..].concat());
            Ok(format!("{bom}{out}"))
        }
    }
}
