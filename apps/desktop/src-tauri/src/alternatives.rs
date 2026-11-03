//! Alternatives (KI-86): other versions of a word, selection, sentence or
//! paragraph, swapped in place in the editor.
//!
//! The document only ever holds the version that's showing. The rest is
//! here, one JSON file per document, beside it and never in it:
//! `.kintsugi/alternatives/<document path>.json`. Each set has an anchor
//! (a text quote of the showing version with a little context, the same
//! shape as comment threads' and re-resolved by the editor the same way,
//! `packages/editor/src/spans.ts`), its versions, and who wrote each one
//! (`owner` or `kin`; KI-87 adds Kin's). The editor owns the list while the
//! document is open and saves it whole.

use crate::ai::comments::Anchor;
use crate::vault::Vault;
use kintsugi_vault::write_atomic;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::State;

type Result<T> = std::result::Result<T, String>;

pub const DIR: &str = ".kintsugi/alternatives";
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_SETS: usize = 1_000;
const MAX_ENTRIES: usize = 50;
const MAX_TEXT_CHARS: usize = 8_000;
const MAX_CONTEXT_CHARS: usize = 64;
const MAX_ID_CHARS: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Level {
    Word,
    Phrase,
    Sentence,
    Paragraph,
}

/// Who wrote a version: him, or Kin (KI-87).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Author {
    Owner,
    Kin,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub text: String,
    pub by: Author,
    #[serde(default)]
    pub created: String,
}

/// A span and its versions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Set {
    pub id: String,
    pub level: Level,
    pub anchor: Anchor,
    /// The showing version's id.
    pub current: String,
    pub entries: Vec<Entry>,
    #[serde(default)]
    pub created: String,
    /// Its text couldn't be found in the document any more.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub orphaned: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct File {
    pub version: u32,
    /// The document these sets are on, relative to the vault.
    pub path: String,
    pub sets: Vec<Set>,
}

fn chars(text: &str, n: usize) -> String {
    text.chars().take(n).collect()
}

fn last_chars(text: &str, n: usize) -> String {
    let count = text.chars().count();
    text.chars().skip(count.saturating_sub(n)).collect()
}

/// What the webview sends, made safe to keep: bounded sizes, unique ids, at
/// least two versions, and the showing one among them.
fn clean(sets: Vec<Set>) -> Vec<Set> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for mut set in sets {
        set.id = chars(set.id.trim(), MAX_ID_CHARS);
        if set.id.is_empty() || !seen.insert(set.id.clone()) {
            continue;
        }
        let mut ids = HashSet::new();
        set.entries
            .retain(|e| !e.text.trim().is_empty() && !e.id.is_empty() && ids.insert(e.id.clone()));
        set.entries.truncate(MAX_ENTRIES);
        for entry in &mut set.entries {
            entry.id = chars(&entry.id, MAX_ID_CHARS);
            entry.text = chars(&entry.text, MAX_TEXT_CHARS);
        }
        if set.entries.len() < 2 {
            continue;
        }
        if !set.entries.iter().any(|e| e.id == set.current) {
            set.current = set.entries[0].id.clone();
        }
        set.anchor.exact = chars(&set.anchor.exact, MAX_TEXT_CHARS);
        set.anchor.prefix = last_chars(&set.anchor.prefix, MAX_CONTEXT_CHARS);
        set.anchor.suffix = chars(&set.anchor.suffix, MAX_CONTEXT_CHARS);
        out.push(set);
        if out.len() >= MAX_SETS {
            break;
        }
    }
    out
}

pub fn file_path(root: &Path, doc: &str) -> Result<PathBuf> {
    crate::sidecar::file_path(root, DIR, doc)
}

/// A document's sets; none if it has no file yet. A file that can't be read
/// is an error rather than an empty list, so nothing overwrites it.
pub fn load(root: &Path, doc: &str) -> Result<File> {
    let path = file_path(root, doc)?;
    let empty = File {
        version: 1,
        path: doc.trim().into(),
        sets: vec![],
    };
    match fs::metadata(&path) {
        Err(_) => Ok(empty),
        Ok(meta) if !meta.is_file() || meta.len() > MAX_FILE_BYTES => {
            Err(format!("{DIR}/{doc}.json isn't an alternatives file"))
        }
        Ok(_) => {
            let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
            let mut file: File =
                serde_json::from_str(&text).map_err(|e| format!("{DIR}/{doc}.json: {e}"))?;
            file.path = doc.trim().into();
            Ok(file)
        }
    }
}

/// Replaces a document's sets. The document must exist, so a late save for
/// a document that was just renamed doesn't leave a stray file behind. No
/// sets left removes the file.
pub fn save(root: &Path, doc: &str, sets: Vec<Set>) -> Result<()> {
    let path = file_path(root, doc)?;
    let doc = doc.trim();
    if !root.join(doc).is_file() {
        return Err(format!("{doc} isn't in the vault"));
    }
    let sets = clean(sets);
    if sets.is_empty() {
        return match fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        };
    }
    let file = File {
        version: 1,
        path: doc.into(),
        sets,
    };
    fs::create_dir_all(path.parent().ok_or("not a file path")?).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    write_atomic(&path, &(json + "\n"))
}

/// A renamed or moved document (or folder) takes its alternatives along.
pub fn renamed(root: &Path, from: &str, to: &str) -> Result<()> {
    crate::sidecar::renamed(root, DIR, from, to)
}

// --- Tauri ----------------------------------------------------------------

#[tauri::command]
pub fn alternatives_load(vault: State<Vault>, path: String) -> Result<File> {
    load(&vault.root()?, &path)
}

#[tauri::command]
pub fn alternatives_save(vault: State<Vault>, path: String, sets: Vec<Set>) -> Result<()> {
    save(&vault.root()?, &path, sets)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, text: &str, by: Author) -> Entry {
        Entry {
            id: id.into(),
            text: text.into(),
            by,
            created: "2026-11-02T10:00:00Z".into(),
        }
    }

    fn set(id: &str, texts: &[&str]) -> Set {
        Set {
            id: id.into(),
            level: Level::Word,
            anchor: Anchor {
                exact: texts[0].into(),
                prefix: "an ".into(),
                suffix: " line".into(),
                line: 5,
            },
            current: "e0".into(),
            entries: texts
                .iter()
                .enumerate()
                .map(|(i, t)| {
                    entry(
                        &format!("e{i}"),
                        t,
                        if i == 2 { Author::Kin } else { Author::Owner },
                    )
                })
                .collect(),
            created: "2026-11-02T10:00:00Z".into(),
            orphaned: false,
        }
    }

    const DOC: &str = "The bowl broke along an old line.\n";

    #[test]
    fn alternatives_live_beside_the_document_never_in_it() {
        let vault = tempfile::tempdir().unwrap();
        let root = vault.path();
        fs::create_dir_all(root.join("drafts")).unwrap();
        fs::write(root.join("drafts/bowl.md"), DOC).unwrap();
        assert!(load(root, "drafts/bowl.md").unwrap().sets.is_empty());

        save(
            root,
            "drafts/bowl.md",
            vec![set("a1", &["old", "ancient", "faint"])],
        )
        .unwrap();
        let stored = root.join(".kintsugi/alternatives/drafts/bowl.md.json");
        assert!(stored.is_file());
        assert_eq!(
            fs::read_to_string(root.join("drafts/bowl.md")).unwrap(),
            DOC
        );
        let json = fs::read_to_string(&stored).unwrap();
        assert!(
            json.contains("\"by\": \"kin\""),
            "who wrote each version is kept: {json}"
        );

        let file = load(root, "drafts/bowl.md").unwrap();
        assert_eq!(file.path, "drafts/bowl.md");
        assert_eq!(file.sets, [set("a1", &["old", "ancient", "faint"])]);

        // No sets left: no file.
        save(root, "drafts/bowl.md", vec![]).unwrap();
        assert!(!stored.exists());
        save(root, "drafts/bowl.md", vec![]).unwrap();
    }

    #[test]
    fn what_the_webview_sends_is_cleaned() {
        let mut bad_current = set("a2", &["x", "y"]);
        bad_current.current = "nope".into();
        let mut huge = set("a3", &["x", "y"]);
        huge.entries[1].text = "z".repeat(MAX_TEXT_CHARS + 10);
        huge.anchor.prefix = "p".repeat(200);
        let cleaned = clean(vec![
            set("a1", &["only one"]),
            set("a1b", &["x", "  "]),
            bad_current,
            set("a2", &["duplicate", "id"]),
            huge,
            set("", &["no", "id"]),
        ]);
        assert_eq!(
            cleaned.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            ["a2", "a3"]
        );
        assert_eq!(
            cleaned[0].current, "e0",
            "the showing one is one of the versions"
        );
        assert_eq!(cleaned[1].entries[1].text.chars().count(), MAX_TEXT_CHARS);
        assert_eq!(cleaned[1].anchor.prefix.chars().count(), MAX_CONTEXT_CHARS);
    }

    #[test]
    fn a_broken_file_is_an_error_and_is_not_overwritten_on_load() {
        let vault = tempfile::tempdir().unwrap();
        let root = vault.path();
        fs::write(root.join("a.md"), DOC).unwrap();
        fs::create_dir_all(root.join(DIR)).unwrap();
        fs::write(root.join(DIR).join("a.md.json"), "{ not json").unwrap();
        assert!(load(root, "a.md").is_err());
        assert_eq!(
            fs::read_to_string(root.join(DIR).join("a.md.json")).unwrap(),
            "{ not json"
        );
    }

    #[test]
    fn only_documents_in_the_vault_get_a_file() {
        let vault = tempfile::tempdir().unwrap();
        for bad in [
            "../x.md",
            "/etc/passwd.md",
            ".kintsugi/agent/USER.md",
            "drafts/x.txt",
            "",
        ] {
            assert!(file_path(vault.path(), bad).is_err(), "{bad}");
        }
        // A late save for a document that's gone (renamed meanwhile) writes nothing.
        assert!(save(vault.path(), "gone.md", vec![set("a1", &["x", "y"])]).is_err());
        assert!(!vault.path().join(DIR).exists());
        #[cfg(unix)]
        {
            let outside = tempfile::tempdir().unwrap();
            fs::write(vault.path().join("a.md"), DOC).unwrap();
            fs::create_dir_all(vault.path().join(".kintsugi")).unwrap();
            std::os::unix::fs::symlink(outside.path(), vault.path().join(DIR)).unwrap();
            assert!(
                save(vault.path(), "a.md", vec![set("a1", &["x", "y"])])
                    .unwrap_err()
                    .contains("links are not followed")
            );
            assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
        }
    }

    #[test]
    fn a_renamed_or_moved_document_takes_its_alternatives() {
        let vault = tempfile::tempdir().unwrap();
        let root = vault.path();
        fs::create_dir_all(root.join("drafts")).unwrap();
        fs::write(root.join("drafts/a.md"), DOC).unwrap();
        save(root, "drafts/a.md", vec![set("a1", &["old", "ancient"])]).unwrap();
        renamed(root, "drafts/a.md", "posts/b.md").unwrap();
        assert!(!root.join(DIR).join("drafts/a.md.json").exists());
        let moved = load(root, "posts/b.md").unwrap();
        assert_eq!((moved.path.as_str(), moved.sets.len()), ("posts/b.md", 1));
        let raw = fs::read_to_string(root.join(DIR).join("posts/b.md.json")).unwrap();
        assert!(raw.contains("\"path\": \"posts/b.md\""), "{raw}");
        renamed(root, "posts", "essays").unwrap();
        assert_eq!(
            load(root, "essays/b.md").unwrap().sets.len(),
            1,
            "a folder's alternatives move with it"
        );
        // Nothing to move is fine.
        renamed(root, "none.md", "other.md").unwrap();
    }
}
