//! Chunking, query terms and snippets.

/// Target chunk size. A chunk is what gets embedded and what a snippet comes
/// from: a few paragraphs, well under model2vec's 512-token window.
const CHUNK_CHARS: usize = 900;
/// A document is indexed up to this many chunks (about 115,000 characters).
pub const MAX_CHUNKS: usize = 128;
pub const SNIPPET_CHARS: usize = 220;
const MAX_TERMS: usize = 12;

/// Splits text into chunks of whole paragraphs, splitting long paragraphs at
/// whitespace. Always returns at least one (possibly empty) chunk.
pub fn chunks(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut current = String::new();
    for paragraph in text.split("\n\n").map(str::trim).filter(|p| !p.is_empty()) {
        for piece in split_long(paragraph) {
            if !current.is_empty() && current.chars().count() + piece.chars().count() > CHUNK_CHARS {
                out.push(std::mem::take(&mut current));
                if out.len() == MAX_CHUNKS {
                    return out;
                }
            }
            if !current.is_empty() {
                current.push_str("\n\n");
            }
            current.push_str(piece);
        }
    }
    if !current.is_empty() || out.is_empty() {
        out.push(current);
    }
    out.truncate(MAX_CHUNKS);
    out
}

fn split_long(paragraph: &str) -> Vec<&str> {
    let mut pieces = Vec::new();
    let mut rest = paragraph;
    while rest.chars().count() > CHUNK_CHARS {
        let limit = rest.char_indices().nth(CHUNK_CHARS).map_or(rest.len(), |(i, _)| i);
        let cut = rest[..limit].rfind(char::is_whitespace).filter(|&i| i > limit / 2).unwrap_or(limit);
        pieces.push(rest[..cut].trim());
        rest = rest[cut..].trim_start();
    }
    if !rest.is_empty() {
        pieces.push(rest);
    }
    pieces
}

/// Lowercased words of a query: runs of letters and digits, deduplicated.
pub fn terms(query: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for word in query.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()) {
        let word = word.to_lowercase();
        if !out.contains(&word) {
            out.push(word);
        }
        if out.len() == MAX_TERMS {
            break;
        }
    }
    out
}

/// An FTS5 query over `terms`. Words are alphanumeric, so quoting is safe.
/// Each matches by stem (`distractions` finds `distraction`) and, past one letter, as a
/// prefix too (`kil` finds `kiln`), for search as you type.
pub fn fts_query(terms: &[String], all: bool) -> String {
    let parts: Vec<String> = terms
        .iter()
        .map(|t| if t.chars().count() > 1 { format!("(\"{t}\" OR \"{t}\"*)") } else { format!("\"{t}\"") })
        .collect();
    parts.join(if all { " AND " } else { " OR " })
}

/// Whitespace collapsed, at most `SNIPPET_CHARS`, cut at a word.
pub fn snippet(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= SNIPPET_CHARS {
        return flat;
    }
    let limit = flat.char_indices().nth(SNIPPET_CHARS).map_or(flat.len(), |(i, _)| i);
    let cut = flat[..limit].rfind(' ').filter(|&i| i > limit / 2).unwrap_or(limit);
    format!("{}…", flat[..cut].trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_keep_paragraphs_together_and_split_long_ones() {
        assert_eq!(chunks(""), vec![String::new()]);
        assert_eq!(chunks("One.\n\nTwo."), vec!["One.\n\nTwo.".to_string()]);
        let long = "word ".repeat(500);
        let parts = chunks(&format!("Intro.\n\n{long}"));
        assert!(parts.len() >= 3, "{}", parts.len());
        assert!(parts.iter().all(|p| p.chars().count() <= CHUNK_CHARS + 10));
        assert!(parts[0].starts_with("Intro."));
        let many = "para\n\n".repeat(10_000).replace("para", &"x".repeat(800));
        assert_eq!(chunks(&many).len(), MAX_CHUNKS);
    }

    #[test]
    fn queries_are_words_quoted_as_prefixes() {
        let t = terms("Kiln's \"glaze\" OR a NEAR(x) kiln");
        assert_eq!(t, ["kiln", "s", "glaze", "or", "a", "near", "x"]);
        assert_eq!(fts_query(&t[..3], true), "(\"kiln\" OR \"kiln\"*) AND \"s\" AND (\"glaze\" OR \"glaze\"*)");
        assert_eq!(fts_query(&t[..2], false), "(\"kiln\" OR \"kiln\"*) OR \"s\"");
    }

    #[test]
    fn snippets_are_short_and_flat() {
        assert_eq!(snippet("a\n\n  b"), "a b");
        let s = snippet(&"lorem ipsum ".repeat(100));
        assert!(s.ends_with('…') && s.chars().count() <= SNIPPET_CHARS + 1, "{s}");
    }
}
