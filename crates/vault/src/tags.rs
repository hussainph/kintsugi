//! Tags in a document's frontmatter, read the same way everywhere: the
//! sidebar tree, the phone, search and enrichment's vocabulary. Clips and
//! writing share the convention (see `docs/inspiration.md`): `tags: [a, b]`,
//! an Obsidian block list (`tags:` then `  - a` lines), or a lone scalar.
//! Reading only. Writers (the desktop editor, the phone) set the field
//! through `@kintsugi/core/frontmatter`, which mirrors this file.

/// A document's tags, normalized ([`normal_tag`]) and without duplicates, in
/// the order written. Only the first top-level `tags` key is read and the
/// body is never scanned, so `tags:` written as prose can't leak in. YAML we
/// don't interpret (nested maps, anchors, block scalars) yields nothing
/// rather than an invented tag.
pub fn doc_tags(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for tag in raw_tags(text.trim_start_matches('\u{feff}')).iter().filter_map(|t| normal_tag(t)) {
        if !out.contains(&tag) {
            out.push(tag);
        }
    }
    out
}

/// `#Craft` and `  craft ` are the same tag: whitespace collapsed, `#` gone,
/// lowercase, capped so one malformed line can't dominate a tag list.
pub fn normal_tag(tag: &str) -> Option<String> {
    let words = tag
        .split_whitespace()
        .filter(|w| !w.chars().any(char::is_control));
    let tag: String = words.collect::<Vec<_>>().join(" ").chars().take(64).collect();
    let tag = tag.trim_start_matches('#').trim().to_lowercase();
    (!tag.is_empty()).then_some(tag)
}

fn raw_tags(text: &str) -> Vec<String> {
    let mut lines = text.split_inclusive('\n');
    let Some(open) = lines.next() else {
        return Vec::new();
    };
    if open.trim_end_matches(['\r', '\n']) != "---" {
        return Vec::new();
    }
    let mut tags = Vec::new();
    let mut found = false;
    let mut block = false;
    for line in lines {
        let bare = line.trim_end_matches(['\r', '\n']);
        if bare.trim_end() == "---" {
            break;
        }
        if bare.trim().is_empty() || bare.trim_start().starts_with('#') {
            continue;
        }
        // Obsidian indents block items; YAML also allows `- a` flush left.
        if bare.starts_with(char::is_whitespace) || (block && bare.starts_with("- ")) {
            if block {
                if let Some(item) = bare.trim().strip_prefix("- ").and_then(scalar) {
                    tags.push(item);
                }
            }
            continue;
        }
        block = false;
        let Some((key, value)) = bare.split_once(':') else {
            continue;
        };
        if found || key.trim() != "tags" {
            continue;
        }
        found = true;
        let value = value.trim();
        if value.is_empty() {
            block = true;
        } else if value.starts_with('[') {
            tags.extend(list(value).unwrap_or_default());
        } else if !value.starts_with('#') {
            if let Some(tag) = scalar(value) {
                tags.push(tag);
            }
        }
    }
    tags
}

/// A quoted or plain scalar without its trailing comment. `None` for YAML we
/// don't interpret, so it can never invent a tag.
fn scalar(value: &str) -> Option<String> {
    let value = value.trim();
    if let Some(q) = value.chars().next().filter(|c| *c == '"' || *c == '\'') {
        let end = quoted_end(value, q)?;
        let tail = value[end..].trim();
        if !tail.is_empty() && !tail.starts_with('#') {
            return None;
        }
        return if q == '"' {
            serde_json::from_str(&value[..end]).ok()
        } else {
            Some(value[1..end - 1].replace("''", "'"))
        };
    }
    if value.starts_with(['|', '>', '{', '[', '&', '*', '!', '%', '@', '`']) {
        return None;
    }
    let plain = value.split_once(" #").map_or(value, |(v, _)| v).trim();
    (!plain.is_empty()).then(|| plain.into())
}

fn quoted_end(value: &str, quote: char) -> Option<usize> {
    let mut chars = value.char_indices().skip(1).peekable();
    while let Some((index, c)) = chars.next() {
        if quote == '"' && c == '\\' {
            chars.next();
        } else if c == quote {
            if quote == '\'' && chars.peek().is_some_and(|(_, c)| *c == '\'') {
                chars.next();
            } else {
                return Some(index + 1);
            }
        }
    }
    None
}

fn list(value: &str) -> Option<Vec<String>> {
    let mut rest = value.strip_prefix('[')?.trim_start();
    let mut items = Vec::new();
    loop {
        if let Some(tail) = rest.strip_prefix(']') {
            let tail = tail.trim();
            return (tail.is_empty() || tail.starts_with('#')).then_some(items);
        }
        let end = match rest.chars().next()? {
            q @ ('"' | '\'') => quoted_end(rest, q)?,
            _ => rest.find([',', ']'])?,
        };
        if end == 0 {
            return None;
        }
        items.push(scalar(&rest[..end])?);
        rest = rest[end..].trim_start();
        if let Some(tail) = rest.strip_prefix(',') {
            rest = tail.trim_start();
        } else if !rest.starts_with(']') {
            return None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tags(text: &str) -> Vec<String> {
        doc_tags(text)
    }

    #[test]
    fn inline_lists_with_quotes_comments_and_hashes() {
        let text = "---\ntitle: \"tags: [fake]\"\ntags: [Writing, '#craft', \"two  words\", 'reader''s life', writing] # mine\n---\n\ntags: [body]\n";
        assert_eq!(tags(text), ["writing", "craft", "two words", "reader's life"]);
    }

    #[test]
    fn obsidian_block_lists_indented_or_flush() {
        assert_eq!(tags("---\ntags:\n  - Essay\n  - \"a, b\"\ntitle: x\n---\n"), ["essay", "a, b"]);
        assert_eq!(tags("---\r\ntags:\r\n- one\r\n- two\r\nstatus: draft\r\n---\r\n"), ["one", "two"]);
        // A nested map under tags isn't a tag.
        assert_eq!(tags("---\ntags:\n  - a\n  k: v\n---\n"), ["a"]);
    }

    #[test]
    fn a_lone_scalar_is_one_tag() {
        assert_eq!(tags("---\ntags: solo\n---\n"), ["solo"]);
        assert!(tags("---\ntags: # nothing\n---\n").is_empty());
    }

    #[test]
    fn nothing_is_invented() {
        assert!(tags("tags: [body]\n").is_empty());
        assert!(tags("---\ntags: [unclosed\n---\n").is_empty());
        assert!(tags("---\nc:\n  tags: [nested]\n---\n").is_empty());
        assert!(tags("---\ntags: []\n---\n").is_empty());
        // Only the first key counts.
        assert_eq!(tags("---\ntags: [a]\ntags: [b]\n---\n"), ["a"]);
    }

    #[test]
    fn ideas_metadata_beside_tags_is_left_alone() {
        let text = "---\ntitle: \"What repair costs\"\nideas:\n  - id: idea-1\n    clips:\n      - \"[[x]]\"\ntags: [repair]\nstatus: draft\n---\n\nBody";
        assert_eq!(tags(text), ["repair"]);
    }
}
