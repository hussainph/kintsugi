//! The vault's tag vocabulary, read-only. Writes belong to the vault's clip
//! API; nothing here parses a document in order to save it back.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

const INSPIRATION: &str = "inspiration";
const MEDIA: &str = "media";
const MAX_TEXT: u64 = 4 * 1024 * 1024;
const MAX_DEPTH: usize = 32;
const VAULT: &str = "could not read the vault";

/// Tags in use across every writing document and clip, most used first, then
/// alphabetical. A tag counts once per document; it is lowercase and has no
/// leading `#`, so `#Craft` and `craft` are one vocabulary entry.
pub fn vocabulary(root: &Path) -> std::result::Result<Vec<String>, String> {
    // A vault that can't be listed at all is an error; unreadable files inside
    // it are not. The vocabulary is a hint, never a contract.
    fs::read_dir(root).map_err(|_| VAULT)?;
    let mut counts = HashMap::new();
    walk(root, 0, &root.join(INSPIRATION).join(MEDIA), &mut counts);
    let mut tags: Vec<(String, usize)> = counts.into_iter().collect();
    tags.sort_by(|(a, x), (b, y)| y.cmp(x).then_with(|| a.cmp(b)));
    Ok(tags.into_iter().map(|(tag, _)| tag).collect())
}

/// Every `.md` / `.mdx` under `dir`, skipping hidden entries, symlinks, clip
/// media, oversized files and folders nested past [`MAX_DEPTH`].
fn walk(dir: &Path, depth: usize, media: &Path, counts: &mut HashMap<String, usize>) {
    if depth > MAX_DEPTH {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if name.starts_with('.') || kind.is_symlink() {
            continue;
        }
        let path = entry.path();
        if kind.is_dir() {
            if path != media {
                walk(&path, depth + 1, media, counts);
            }
        } else if kind.is_file() && (name.ends_with(".md") || name.ends_with(".mdx")) {
            if let Some(text) = read_text(&path) {
                let mut seen = Vec::new();
                for tag in tags(&text).iter().filter_map(|t| normal_tag(t)) {
                    if !seen.contains(&tag) {
                        *counts.entry(tag.clone()).or_insert(0) += 1;
                        seen.push(tag);
                    }
                }
            }
        }
    }
}

fn read_text(path: &Path) -> Option<String> {
    let meta = fs::symlink_metadata(path).ok()?;
    let file = meta.file_type().is_file() && meta.len() <= MAX_TEXT;
    file.then(|| fs::read_to_string(path).ok()).flatten()
}

/// `#Craft` and `  craft ` are the same tag: whitespace collapsed, `#` gone,
/// lowercase, capped so one malformed line can't dominate the vocabulary.
fn normal_tag(tag: &str) -> Option<String> {
    let words = tag
        .split_whitespace()
        .filter(|w| !w.chars().any(char::is_control));
    let tag: String = words
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(64)
        .collect();
    let tag = tag.trim_start_matches('#').trim().to_lowercase();
    (!tag.is_empty()).then_some(tag)
}

/// The `tags` field of flat frontmatter: an inline list, a block list, or a
/// lone scalar. Only the first `tags` key is read, and the body is never
/// scanned, so a `tags:` line written as prose can't leak into the vocabulary.
fn tags(text: &str) -> Vec<String> {
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
        if bare == "---" {
            break;
        }
        if bare.trim().is_empty() || bare.trim_start().starts_with('#') {
            continue;
        }
        if bare.starts_with(char::is_whitespace) {
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
    use kintsugi_vault::{self as vault, ClipCapture, ClipUpdate, ClipVia};
    use std::fs;

    fn write(root: &Path, rel: &str, text: &str) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn words(tags: &str) -> Vec<String> {
        tags.split('|').map(str::to_string).collect()
    }

    #[test]
    fn inline_block_and_quoted_tags_are_normalized_and_counted_once() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        const CRAFT: &str = "---\ntitle: \"tags: [fake]\"\ntags: [Writing, '#craft', \"two words\", 'reader''s life']\n---\n\ntags: [body]\n";
        const IDEA: &str = "---\ntags:\n  - Writing\n  - '#writing'\n  - ideas\n  k: v\n---\n";
        write(root, "essays/craft.mdx", CRAFT);
        write(root, "notes/idea.md", IDEA);
        write(root, "single.md", "---\ntags: solo\n---\n");
        write(root, "nested.md", "---\nc:\n  tags: [nested]\n---\n");
        write(root, "commented.md", "---\ntags: # nothing\n---\n");
        write(root, "body-only.md", "tags: [body]\n");
        write(root, "broken.md", "---\ntags: [unclosed\n---\n");
        let tags = vocabulary(root).unwrap();
        assert_eq!(
            tags,
            words("writing|craft|ideas|reader's life|solo|two words")
        );
    }

    #[test]
    fn skips_hidden_symlinks_media_oversized_and_too_deep_documents() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(root, "notes/kept.md", "---\ntags: [kept]\n---\n");
        write(root, "inspiration/clip.md", "---\ntags: [clip]\n---\n");
        write(root, "inspiration/media/m.md", "---\ntags: [media]\n---\n");
        write(root, ".obsidian/x.md", "---\ntags: [hidden]\n---\n");
        write(root, "notes/.draft.md", "---\ntags: [hidden]\n---\n");
        write(root, "notes/readme.txt", "---\ntags: [text]\n---\n");
        write(
            root,
            "huge.md",
            &format!("---\ntags: [huge]\n---\n{}", "x".repeat(MAX_TEXT as usize)),
        );
        let deep = vec!["d"; MAX_DEPTH + 2].join("/");
        write(root, &format!("{deep}/deep.md"), "---\ntags: [deep]\n---\n");
        #[cfg(unix)]
        {
            let outside = tempfile::tempdir().unwrap();
            write(outside.path(), "out.md", "---\ntags: [outside]\n---\n");
            std::os::unix::fs::symlink(outside.path(), root.join("linked")).unwrap();
            std::os::unix::fs::symlink(root.join("notes/kept.md"), root.join("notes/linked.md"))
                .unwrap();
        }
        assert_eq!(vocabulary(root).unwrap(), ["clip", "kept"]);
    }

    #[test]
    fn a_clip_captured_through_the_vault_joins_the_vocabulary() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(root, "notes/kept.md", "---\ntags: [writing]\n---\n");
        let path = vault::clip_create(
            root,
            &ClipCapture {
                url: None,
                text: Some("A passage worth keeping.".into()),
                note: None,
                title: Some("Why we sleep".into()),
                image: None,
                image_type: None,
                file: None,
                captured_at: "2026-10-29T14:05".into(),
                via: ClipVia::Mac,
            },
        )
        .unwrap();
        let text = fs::read_to_string(root.join(&path)).unwrap();
        assert!(text.contains("<!-- kintsugi:source -->"), "{text}");
        let patch = ClipUpdate {
            tags: Some(vec!["Writing".into(), "Sleep".into(), "#attention".into()]),
            ..ClipUpdate::default()
        };
        vault::clip_update(root, &path, &patch).unwrap();
        assert_eq!(vocabulary(root).unwrap(), words("writing|attention|sleep"));
        assert_eq!(vocabulary(&root.join("missing")).unwrap_err(), VAULT);
    }
}
