//! Plain text from platform APIs (posts, captions, alt text) made safe to
//! place in a Markdown body: it reads the same, but can't open a heading,
//! list, quote, code block or raw HTML that the author never wrote.

/// Escapes block-level Markdown at line starts and every `<` (raw HTML).
/// Inline emphasis and URLs are left alone so the text stays readable and
/// links stay clickable.
pub(crate) fn plain(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 16);
    for (i, line) in text.split('\n').enumerate() {
        if i > 0 {
            out.push('\n');
        }
        let line = line.trim_end_matches('\r');
        let body = line.trim_start();
        out.push_str(&line[..line.len() - body.len()].replace('\t', "    ").chars().take(3).collect::<String>());
        if starts_block(body) {
            out.push('\\');
        }
        out.push_str(&body.replace('<', "\\<"));
    }
    out
}

fn starts_block(line: &str) -> bool {
    let first = line.chars().next();
    if matches!(first, Some('#' | '>' | '-' | '+' | '*' | '=' | '|' | '`' | '~')) {
        return true;
    }
    // "1. " or "1) " would start an ordered list.
    let digits = line.chars().take_while(char::is_ascii_digit).count();
    digits > 0 && digits <= 9 && matches!(line[digits..].chars().next(), Some('.' | ')'))
}

/// Short text for an image's alt or a link label: one line, no brackets.
pub(crate) fn label(text: &str, limit: usize) -> String {
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    flat.chars().filter(|c| !matches!(c, '[' | ']' | '<' | '>')).take(limit).collect()
}

/// A title from a post: its first non-empty line, bounded with an ellipsis.
pub(crate) fn title(text: &str, limit: usize) -> Option<String> {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty())?;
    let line: String = line.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= limit {
        return Some(line);
    }
    let cut: String = line.chars().take(limit).collect();
    let cut = cut.rfind(' ').filter(|&i| i > limit / 2).map_or(cut.as_str(), |i| &cut[..i]);
    Some(format!("{}…", cut.trim_end()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn block_markdown_and_html_are_escaped() {
        assert_eq!(plain("# not a heading\n> nor a quote\n- nor a list"), "\\# not a heading\n\\> nor a quote\n\\- nor a list");
        assert_eq!(plain("1. first\n2) second\n2026 was good"), "\\1. first\n\\2) second\n2026 was good");
        assert_eq!(plain("a <script>x</script> b"), "a \\<script>x\\</script> b");
        assert_eq!(plain("        indented code"), "   indented code");
        assert_eq!(plain("*bold* and https://e.org/a_b_c"), "\\*bold* and https://e.org/a_b_c");
        assert_eq!(plain("mid *emphasis* stays"), "mid *emphasis* stays");
    }

    #[test]
    fn labels_and_titles_are_one_bounded_line() {
        assert_eq!(label(" a [b]\n c ", 100), "a b c");
        assert_eq!(title("\n\nFirst line here\nsecond", 100).as_deref(), Some("First line here"));
        assert_eq!(title("one two three four five", 12).as_deref(), Some("one two…"));
        assert_eq!(title("  \n ", 10), None);
    }
}
