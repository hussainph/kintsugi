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
                // Normalized and counted once per document.
                for tag in kintsugi_vault::doc_tags(&text) {
                    *counts.entry(tag).or_insert(0) += 1;
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
