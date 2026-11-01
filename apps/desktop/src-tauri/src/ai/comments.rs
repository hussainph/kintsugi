//! Kin's comment threads on paragraphs (KI-38): where they're kept.
//!
//! A thread is a mini chat anchored to one paragraph of a document. Its
//! messages are entries in Kin's one conversation log (`history`, with
//! `comment` set to the thread's id and the document as the topic); this
//! file keeps what the log doesn't: where the thread sits and whether it's
//! resolved.
//!
//! One JSON file per document, outside the document and never in the MDX:
//! `.kintsugi/comments/<document path>.json` in the vault. The anchor is a
//! text quote with a little context on each side ([`Anchor`]), re-resolved
//! against the document when it's opened and kept up to date by the editor
//! while it's being edited (`packages/editor/src/anchors.ts`). A thread whose
//! paragraph is gone is marked `orphaned` and kept, never dropped.

use kintsugi_vault::write_atomic;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};

type Result<T> = std::result::Result<T, String>;

pub const DIR: &str = ".kintsugi/comments";
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_QUOTE_CHARS: usize = 4_000;
const MAX_CONTEXT_CHARS: usize = 64;
pub const MAX_THREADS: usize = 500;

/// Where a thread sits: the paragraph's text when last seen, a little of
/// what came before and after it, and its first line (a tie-breaker).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Anchor {
    pub exact: String,
    #[serde(default)]
    pub prefix: String,
    #[serde(default)]
    pub suffix: String,
    #[serde(default)]
    pub line: u32,
}

impl Anchor {
    /// Caps what the webview sends, so a file can't grow without bound.
    fn clamp(mut self) -> Self {
        self.exact = self.exact.chars().take(MAX_QUOTE_CHARS).collect();
        let n = self.prefix.chars().count();
        self.prefix = self.prefix.chars().skip(n.saturating_sub(MAX_CONTEXT_CHARS)).collect();
        self.suffix = self.suffix.chars().take(MAX_CONTEXT_CHARS).collect();
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Open,
    Resolved,
}

/// One thread. Its messages are in the conversation log.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub id: String,
    pub anchor: Anchor,
    pub status: Status,
    /// How it started: `"mention"` (`@Kin`), `"discuss"` (⌘K) or `"review"`.
    pub origin: String,
    /// RFC 3339.
    pub created: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved: Option<String>,
    /// Its paragraph couldn't be found in the document any more.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub orphaned: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct File {
    pub version: u32,
    /// The document these threads are on, relative to the vault.
    pub path: String,
    pub threads: Vec<Thread>,
}

/// An anchor the editor re-resolved after edits.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Moved {
    pub id: String,
    pub anchor: Anchor,
    #[serde(default)]
    pub orphaned: bool,
}

/// The document a thread file is for: a Markdown file inside the vault, in
/// no hidden folder.
fn document(doc: &str) -> Result<&str> {
    let doc = doc.trim();
    let parts: Vec<_> = Path::new(doc).components().collect();
    let plain = !parts.is_empty()
        && parts.iter().all(|c| matches!(c, Component::Normal(name) if !name.to_string_lossy().starts_with('.')));
    if !plain || !(doc.ends_with(".md") || doc.ends_with(".mdx")) {
        return Err(format!("not a document: {doc}"));
    }
    Ok(doc)
}

/// `.kintsugi/comments/<doc>.json`, refusing links on the way.
pub fn file_path(root: &Path, doc: &str) -> Result<PathBuf> {
    let doc = document(doc)?;
    let mut at = root.to_path_buf();
    let file = format!("{doc}.json");
    for part in DIR.split('/').chain(file.split('/')) {
        at.push(part);
        if fs::symlink_metadata(&at).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(format!("{DIR}/{file}: links are not followed"));
        }
    }
    Ok(at)
}

/// A document's threads; none if it has no file yet. A file that can't be
/// read is an error rather than an empty list, so nothing overwrites it.
pub fn load(root: &Path, doc: &str) -> Result<File> {
    let path = file_path(root, doc)?;
    let empty = File { version: 1, path: doc.trim().into(), threads: vec![] };
    match fs::metadata(&path) {
        Err(_) => Ok(empty),
        Ok(meta) if !meta.is_file() || meta.len() > MAX_FILE_BYTES => Err(format!("{DIR}/{doc}.json isn't a comments file")),
        Ok(_) => {
            let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
            let mut file: File = serde_json::from_str(&text).map_err(|e| format!("{DIR}/{doc}.json: {e}"))?;
            file.path = doc.trim().into();
            Ok(file)
        }
    }
}

pub fn save(root: &Path, file: &File) -> Result<()> {
    let path = file_path(root, &file.path)?;
    fs::create_dir_all(path.parent().ok_or("not a file path")?).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    write_atomic(&path, &(json + "\n"))
}

pub fn new_id() -> String {
    use std::sync::atomic::{AtomicU32, Ordering};
    static N: AtomicU32 = AtomicU32::new(0);
    let n = N.fetch_add(1, Ordering::Relaxed);
    format!("c-{}-{:x}{:04x}", chrono::Local::now().format("%Y%m%d-%H%M%S"), std::process::id() & 0xfff, n & 0xffff)
}

impl File {
    pub fn add(&mut self, anchor: Anchor, origin: &str) -> Result<Thread> {
        if self.threads.len() >= MAX_THREADS {
            return Err("This document has too many comment threads. Resolve or clear some first.".into());
        }
        if anchor.exact.trim().is_empty() {
            return Err("Comment on a paragraph with some text in it.".into());
        }
        let origin = match origin {
            "mention" | "discuss" | "review" => origin,
            _ => "mention",
        };
        let thread = Thread {
            id: new_id(),
            anchor: anchor.clamp(),
            status: Status::Open,
            origin: origin.into(),
            created: chrono::Local::now().to_rfc3339(),
            resolved: None,
            orphaned: false,
        };
        self.threads.push(thread.clone());
        Ok(thread)
    }

    pub fn get(&self, id: &str) -> Option<&Thread> {
        self.threads.iter().find(|t| t.id == id)
    }

    pub fn set_status(&mut self, id: &str, status: Status) -> Result<Thread> {
        let thread = self.threads.iter_mut().find(|t| t.id == id).ok_or("That comment thread is gone.")?;
        thread.status = status;
        thread.resolved = (status == Status::Resolved).then(|| chrono::Local::now().to_rfc3339());
        Ok(thread.clone())
    }

    /// Applies re-resolved anchors; true if anything changed. Unknown ids
    /// are ignored (a thread created elsewhere meanwhile is untouched).
    pub fn moved(&mut self, moves: Vec<Moved>) -> bool {
        let mut changed = false;
        for m in moves {
            let Some(thread) = self.threads.iter_mut().find(|t| t.id == m.id) else { continue };
            let anchor = m.anchor.clamp();
            // An orphan keeps the last text it was on, so it can be shown and found again.
            let anchor = if m.orphaned || anchor.exact.trim().is_empty() { Anchor { line: anchor.line, ..thread.anchor.clone() } } else { anchor };
            if thread.anchor != anchor || thread.orphaned != m.orphaned {
                thread.anchor = anchor;
                thread.orphaned = m.orphaned;
                changed = true;
            }
        }
        changed
    }
}

/// A renamed or moved document (or folder) takes its threads along.
pub fn renamed(root: &Path, from: &str, to: &str) -> Result<()> {
    let folder = |rel: &str| -> Option<PathBuf> {
        let rel = rel.trim().trim_end_matches('/');
        let plain = !rel.is_empty() && Path::new(rel).components().all(|c| matches!(c, Component::Normal(n) if !n.to_string_lossy().starts_with('.')));
        let at = root.join(DIR).join(rel);
        (plain && !fs::symlink_metadata(root.join(DIR)).is_ok_and(|m| m.file_type().is_symlink())).then_some(at)
    };
    if let (Some(old), Some(new)) = (folder(from), folder(to))
        && fs::symlink_metadata(&old).is_ok_and(|m| m.is_dir())
    {
        if new.exists() {
            return Ok(());
        }
        fs::create_dir_all(new.parent().ok_or("not a folder")?).map_err(|e| e.to_string())?;
        return fs::rename(old, new).map_err(|e| e.to_string());
    }
    let (Ok(old), Ok(new)) = (file_path(root, from), file_path(root, to)) else { return Ok(()) };
    if !old.is_file() || new.exists() {
        return Ok(());
    }
    let mut file = load(root, from)?;
    file.path = to.trim().into();
    save(root, &file)?;
    fs::remove_file(old).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn anchor(text: &str) -> Anchor {
        Anchor { exact: text.into(), prefix: "before ".into(), suffix: " after".into(), line: 5 }
    }

    #[test]
    fn threads_live_beside_the_document_never_in_it() {
        let vault = tempfile::tempdir().unwrap();
        let root = vault.path();
        fs::create_dir_all(root.join("drafts")).unwrap();
        fs::write(root.join("drafts/tools.mdx"), "A pencil is a tool for thinking.\n").unwrap();
        let mut file = load(root, "drafts/tools.mdx").unwrap();
        assert!(file.threads.is_empty());
        let thread = file.add(anchor("A pencil is a tool for thinking."), "mention").unwrap();
        save(root, &file).unwrap();
        assert!(root.join(".kintsugi/comments/drafts/tools.mdx.json").is_file());
        assert_eq!(fs::read_to_string(root.join("drafts/tools.mdx")).unwrap(), "A pencil is a tool for thinking.\n");

        let mut again = load(root, "drafts/tools.mdx").unwrap();
        assert_eq!(again.threads, [thread.clone()]);
        let resolved = again.set_status(&thread.id, Status::Resolved).unwrap();
        assert!(resolved.resolved.is_some());
        assert!(again.set_status(&thread.id, Status::Open).unwrap().resolved.is_none());
        assert!(again.set_status("nope", Status::Open).is_err());
        assert!(again.add(anchor("  "), "mention").is_err(), "a blank paragraph can't be commented on");
    }

    #[test]
    fn an_orphan_keeps_the_text_it_was_on() {
        let mut file = File::default();
        let t = file.add(anchor("The gold seam is the repair."), "review").unwrap();
        assert!(!file.moved(vec![Moved { id: t.id.clone(), anchor: anchor("The gold seam is the repair."), orphaned: false }]));
        assert!(file.moved(vec![Moved { id: t.id.clone(), anchor: Anchor { exact: "The gold seam is the mend.".into(), line: 7, ..anchor("") }, orphaned: false }]));
        assert_eq!(file.get(&t.id).unwrap().anchor.exact, "The gold seam is the mend.");
        assert!(file.moved(vec![Moved { id: t.id.clone(), anchor: Anchor::default(), orphaned: true }]));
        let orphan = file.get(&t.id).unwrap();
        assert!(orphan.orphaned);
        assert_eq!(orphan.anchor.exact, "The gold seam is the mend.", "kept, not lost");
        assert!(!file.moved(vec![Moved { id: "unknown".into(), anchor: Anchor::default(), orphaned: true }]));
    }

    #[test]
    fn only_documents_inside_the_vault_get_a_file() {
        let vault = tempfile::tempdir().unwrap();
        for bad in ["../x.md", "/etc/passwd.md", ".kintsugi/agent/USER.md", "drafts/x.txt", "", "drafts/../../x.md"] {
            assert!(file_path(vault.path(), bad).is_err(), "{bad}");
        }
        #[cfg(unix)]
        {
            let outside = tempfile::tempdir().unwrap();
            fs::create_dir_all(vault.path().join(".kintsugi")).unwrap();
            std::os::unix::fs::symlink(outside.path(), vault.path().join(DIR)).unwrap();
            let mut file = File { version: 1, path: "a.md".into(), threads: vec![] };
            file.add(anchor("x"), "mention").unwrap();
            assert!(save(vault.path(), &file).unwrap_err().contains("links are not followed"));
            assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
        }
    }

    #[test]
    fn a_renamed_document_takes_its_threads() {
        let vault = tempfile::tempdir().unwrap();
        let mut file = File { version: 1, path: "drafts/a.md".into(), threads: vec![] };
        file.add(anchor("x"), "mention").unwrap();
        save(vault.path(), &file).unwrap();
        renamed(vault.path(), "drafts/a.md", "posts/b.md").unwrap();
        assert!(!vault.path().join(".kintsugi/comments/drafts/a.md.json").exists());
        let moved = load(vault.path(), "posts/b.md").unwrap();
        assert_eq!((moved.path.as_str(), moved.threads.len()), ("posts/b.md", 1));
        renamed(vault.path(), "posts", "essays").unwrap();
        assert_eq!(load(vault.path(), "essays/b.md").unwrap().threads.len(), 1, "a folder's threads move with it");
    }
}
