//! Small, bounded clean-ups applied to every Markdown body and metadata field.

/// Collapses whitespace and bounds a metadata field. Empty becomes `None`.
pub fn field(s: &str, limit: usize) -> Option<String> {
    let text: String = s.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(limit).collect();
    (!text.is_empty()).then_some(text)
}

/// Normalizes extracted Markdown: no inline `data:` payloads (they bloat the
/// source and are never useful text), no runs of blank lines, no trailing
/// spaces, and at most `limit` characters, cut at a paragraph or line break
/// near the end when there is one.
pub fn body(md: &str, limit: usize) -> String {
    let mut out = String::with_capacity(md.len().min(limit * 4));
    let mut blank = 0;
    for line in md.lines() {
        let line = strip_data_images(line.trim_end());
        if line.trim().is_empty() {
            blank += 1;
            continue;
        }
        if !out.is_empty() {
            out.push_str(if blank > 0 { "\n\n" } else { "\n" });
        }
        blank = 0;
        out.push_str(&line);
    }
    bound(&out, limit)
}

fn bound(text: &str, limit: usize) -> String {
    let Some((cut, _)) = text.char_indices().nth(limit) else {
        return text.to_string();
    };
    let head = &text[..cut];
    // Prefer a clean break in the last tenth rather than a half sentence.
    let floor = head.char_indices().nth(limit - limit / 10).map_or(0, |(i, _)| i);
    let end =
        head.rfind("\n\n").filter(|&i| i >= floor).or_else(|| head.rfind('\n').filter(|&i| i >= floor)).unwrap_or(cut);
    head[..end].trim_end().to_string()
}

fn strip_data_images(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(start) = rest.find("](data:") {
        let Some(open) = rest[..start].rfind("![") else {
            out.push_str(&rest[..start + 2]);
            rest = &rest[start + 2..];
            continue;
        };
        out.push_str(&rest[..open]);
        rest = rest[start..].find(')').map_or("", |end| &rest[start + end + 1..]);
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bodies_are_tidied_and_bounded_on_unicode_boundaries() {
        assert_eq!(body("# Title  \n\n\n\nText\nmore\n\n", 100), "# Title\n\nText\nmore");
        let long = "界".repeat(30_000);
        let cut = body(&long, 20_000);
        assert_eq!(cut.chars().count(), 20_000);
        let paragraphs = format!("{}\n\n{}", "a".repeat(19_000), "b".repeat(5_000));
        assert_eq!(body(&paragraphs, 20_000), "a".repeat(19_000));
    }

    #[test]
    fn inline_data_images_are_dropped() {
        assert_eq!(
            body("See ![chart](data:image/png;base64,AAAA) and ![x](https://e.org/x.png)", 100),
            "See  and ![x](https://e.org/x.png)"
        );
        assert_eq!(body("[link](data:text/html,hi)", 100), "[link](data:text/html,hi)");
    }

    #[test]
    fn fields_collapse_whitespace() {
        assert_eq!(field("  A \n title ", 100).as_deref(), Some("A title"));
        assert_eq!(field(" \n ", 100), None);
        assert_eq!(field("abcdef", 3).as_deref(), Some("abc"));
    }
}
