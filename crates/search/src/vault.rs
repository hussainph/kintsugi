//! Keeping a vault's writing, notes and clips in the index.
//!
//! A sync compares cheap file metadata with what's indexed and reads only
//! what changed, so it can run before every search. The walk follows the
//! same rules as Kin's tools: no hidden entries, no symlinks, text files only.

use crate::index::{Doc, Index, Kind};
use kintsugi_vault::{self as vault, INBOX, INSPIRATION};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

type Result<T> = std::result::Result<T, String>;

const TEXT_EXTENSIONS: [&str; 3] = ["md", "mdx", "txt"];
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_FILES: usize = 20_000;
const MAX_DEPTH: usize = 16;
/// Documents written per transaction during a sync.
const BATCH: usize = 64;

/// What a sync changed.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Synced {
    pub indexed: usize,
    pub removed: usize,
}

/// Brings the scope up to date with the vault at `root` (canonical).
pub fn sync(index: &mut Index, scope: &str, root: &Path) -> Result<Synced> {
    let files = walk(root);
    let stored = index.stamps(scope)?;
    let present: HashSet<&str> = files.iter().map(|(rel, _, _)| rel.as_str()).collect();
    let removed: Vec<String> = stored.keys().filter(|id| !present.contains(id.as_str())).cloned().collect();
    index.remove(scope, &removed)?;
    let mut report = Synced { indexed: 0, removed: removed.len() };
    let mut batch = Vec::new();
    let mut unreadable = Vec::new();
    for (rel, path, stamp) in files {
        if stored.get(&rel) == Some(&stamp) {
            continue;
        }
        match load(root, &rel, &path, stamp) {
            Some(doc) => batch.push(doc),
            None => unreadable.push(rel),
        }
        if batch.len() == BATCH {
            report.indexed += batch.len();
            index.upsert(scope, &std::mem::take(&mut batch))?;
        }
    }
    report.indexed += batch.len();
    index.upsert(scope, &batch)?;
    // A file that can't be read (yet) isn't left with stale content.
    index.remove(scope, &unreadable)?;
    Ok(report)
}

/// The kind of a vault path.
pub fn kind(rel: &str) -> Kind {
    let first = rel.split('/').next().unwrap_or_default();
    if first.eq_ignore_ascii_case(INSPIRATION) {
        Kind::Clip
    } else if first.eq_ignore_ascii_case(INBOX) {
        Kind::Note
    } else {
        Kind::Writing
    }
}

fn load(root: &Path, rel: &str, path: &Path, stamp: String) -> Option<Doc> {
    let kind = kind(rel);
    // A clip file that doesn't parse (hand-made, half-written) is still text.
    if kind == Kind::Clip
        && is_clip_path(rel)
        && let Ok(clip) = vault::clip_read(root, rel)
    {
        let summary = clip.summary;
        // The whole source (a long transcript's sidecar), not just the excerpt.
        let source = vault::clip_full_source(root, rel).ok().flatten().or(clip.source).unwrap_or_default();
        let body = [summary.summary.as_deref().unwrap_or_default(), clip.text.trim(), source.as_str()]
            .iter()
            .filter(|s| !s.trim().is_empty())
            .copied()
            .collect::<Vec<_>>()
            .join("\n\n");
        let source = summary.site.clone().or_else(|| summary.url.as_deref().and_then(host)).or(summary.author.clone());
        return Some(Doc {
            id: rel.into(),
            kind: Some(Kind::Clip),
            title: summary.title,
            source,
            tags: summary.tags,
            body,
            stamp,
        });
    }
    let text = fs::read_to_string(path).ok()?;
    let (title, _) = vault::front_matter(&text);
    let body = strip_front_matter(&text);
    let title = title.or_else(|| heading(body));
    Some(Doc { id: rel.into(), kind: Some(kind), title, source: None, tags: front_matter_tags(&text), body: body.into(), stamp })
}

/// Clips are the Markdown files directly in `inspiration/`.
fn is_clip_path(rel: &str) -> bool {
    rel.split('/').count() == 2 && rel.ends_with(".md")
}

fn host(url: &str) -> Option<String> {
    let rest = url.split_once("://")?.1;
    let host = rest.split(['/', '?', '#']).next()?;
    Some(host.trim_start_matches("www.").to_string()).filter(|h| !h.is_empty())
}

fn heading(body: &str) -> Option<String> {
    body.lines().find_map(|l| l.strip_prefix("# ")).map(|h| h.trim().to_string()).filter(|h| !h.is_empty())
}

fn strip_front_matter(text: &str) -> &str {
    let Some(rest) = text.strip_prefix("---\n").or_else(|| text.strip_prefix("---\r\n")) else { return text };
    let mut at = 0;
    for line in rest.split_inclusive('\n') {
        at += line.len();
        if line.trim_end() == "---" {
            return &rest[at..];
        }
    }
    text
}

/// `tags: [a, b]`, a block list or a lone scalar, read as the tree reads them.
fn front_matter_tags(text: &str) -> Vec<String> {
    vault::doc_tags(text)
}

/// Text files under the root, with a stamp that changes when a file does.
fn walk(root: &Path) -> Vec<(String, PathBuf, String)> {
    let mut out = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else { continue };
            if entry.file_name().to_string_lossy().starts_with('.') || kind.is_symlink() {
                continue;
            }
            let path = entry.path();
            // Clip sidecars (`inspiration/sources/`) are indexed with their clip.
            if kind.is_dir() && vault::relative(root, &path).eq_ignore_ascii_case(&format!("{INSPIRATION}/sources")) {
                continue;
            }
            if kind.is_dir() && depth < MAX_DEPTH {
                stack.push((path, depth + 1));
            } else if kind.is_file() && is_text(&path) && out.len() < MAX_FILES {
                let Ok(meta) = entry.metadata() else { continue };
                if meta.len() > MAX_FILE_BYTES {
                    continue;
                }
                out.push((vault::relative(root, &path), path, stamp(&meta)));
            }
        }
    }
    out.sort();
    out
}

fn is_text(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| TEXT_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

/// Modification time, size and (on Unix) inode and change time, so atomic
/// replacements and same-size edits are noticed.
fn stamp(meta: &fs::Metadata) -> String {
    let modified = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos());
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        format!("{modified}:{}:{}:{}.{}", meta.len(), meta.ino(), meta.ctime(), meta.ctime_nsec())
    }
    #[cfg(not(unix))]
    format!("{modified}:{}", meta.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn front_matter_is_read_for_titles_and_tags() {
        let text = "---\ntitle: On Kilns\ntags: [Craft, \"fire\"]\n---\n\n# Ignored\n\nBody.";
        assert_eq!(strip_front_matter(text), "\n# Ignored\n\nBody.");
        assert_eq!(front_matter_tags(text), ["craft", "fire"]);
        assert_eq!(front_matter_tags("---\ntags:\n  - a\n  - b\ntitle: x\n---\n"), ["a", "b"]);
        assert_eq!(heading("intro\n# Title here\n"), Some("Title here".into()));
        assert_eq!(host("https://www.newyorker.com/a?b"), Some("newyorker.com".into()));
        assert_eq!(kind("Inbox/x.md"), Kind::Note);
    }
}
