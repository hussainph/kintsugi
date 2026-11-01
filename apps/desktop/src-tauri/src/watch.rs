//! Notices edits made to the vault by other apps (Obsidian, git, iCloud,
//! another editor) so the open document is never saved over them.
//!
//! The watcher reports documents whose text on disk is not what Kintsugi last
//! saved there. Its own atomic-save temp files (`.kintsugi-*`), every hidden
//! file or folder (`.kintsugi/`, `.git/`, `.obsidian/`) and the inspiration
//! library (clips have their own events) are ignored. The editor decides what
//! to do with a change: reload, merge or ask (see `App.tsx`).

use crate::AppHandle;
use kintsugi_vault::{self as vault, INSPIRATION};
use notify::{RecursiveMode, Watcher as _};
use serde::Serialize;
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

/// How long the vault must be quiet before a batch is reported: one save from
/// another app is several file events (temp file, rename, metadata).
const QUIET: Duration = Duration::from_millis(150);
/// A steady stream of events (a `git checkout`) still reports this often.
const MOST: Duration = Duration::from_secs(1);

/// What Kintsugi itself last saved to each document, by version.
type Written = Arc<Mutex<HashMap<String, String>>>;

#[derive(Default)]
pub struct Watch {
    active: Mutex<Option<notify::RecommendedWatcher>>,
    written: Written,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Doc {
    pub path: String,
    pub text: String,
}

/// One batch of outside changes. The tree is worth reloading even when both
/// lists are empty (a folder appeared, say).
#[derive(Serialize, Debug, PartialEq, Default)]
pub struct Outside {
    /// Documents whose text on disk changed, with that text.
    pub docs: Vec<Doc>,
    /// Paths that no longer exist: documents, or folders that held them.
    pub gone: Vec<String>,
}

/// Starts watching `root`, replacing the watcher of any earlier vault.
/// Best effort: without a watcher, saves still refuse a stale write.
pub fn start(app: &AppHandle, root: &Path) {
    let state = app.state::<Watch>();
    state.written.lock().unwrap().clear();
    let app = app.clone();
    let watcher = watch(root, state.written.clone(), move |outside| {
        let _ = app.emit("vault:outside", &outside);
        crate::vault::references_changed(&app);
    });
    match watcher {
        Ok(w) => *state.active.lock().unwrap() = Some(w),
        Err(e) => {
            *state.active.lock().unwrap() = None;
            eprintln!("kintsugi: not watching the vault for outside edits: {e}");
        }
    }
}

/// Kintsugi saved `text` to `path`: the watcher's echo of it is not news.
pub fn wrote(app: &AppHandle, path: &str, text: &str) {
    app.state::<Watch>().written.lock().unwrap().insert(path.to_string(), vault::version(text));
}

/// Watches `root` recursively and calls `report` with each batch of outside
/// changes, on a thread of its own. Dropping the watcher ends the thread.
pub(crate) fn watch(
    root: &Path,
    written: Written,
    report: impl Fn(Outside) + Send + 'static,
) -> Result<notify::RecommendedWatcher, String> {
    // FSEvents reports resolved paths (/private/var for /var, say).
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let (tx, rx) = mpsc::channel::<PathBuf>();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if let Ok(event) = event {
            if event.kind.is_access() {
                return;
            }
            for path in event.paths {
                let _ = tx.send(path);
            }
        }
    })
    .map_err(|e| e.to_string())?;
    watcher.watch(&root, RecursiveMode::Recursive).map_err(|e| e.to_string())?;

    std::thread::Builder::new()
        .name("vault-watch".into())
        .spawn(move || {
            // Ends when the watcher (and so the sender) is dropped.
            while let Ok(first) = rx.recv() {
                let mut paths = vec![first];
                let started = Instant::now();
                while started.elapsed() < MOST {
                    match rx.recv_timeout(QUIET) {
                        Ok(path) => paths.push(path),
                        Err(mpsc::RecvTimeoutError::Timeout) => break,
                        Err(mpsc::RecvTimeoutError::Disconnected) => return,
                    }
                }
                let written = written.lock().unwrap().clone();
                if let Some(outside) = outside(&root, paths, &written) {
                    report(outside);
                }
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(watcher)
}

/// Which of these changed paths are news from outside Kintsugi, or `None` if
/// none are. Reads each document as it is on disk now.
pub(crate) fn outside(root: &Path, paths: Vec<PathBuf>, written: &HashMap<String, String>) -> Option<Outside> {
    let mut seen = BTreeSet::new();
    let mut out = Outside::default();
    let mut relevant = false;
    for path in paths {
        let Ok(rel) = path.strip_prefix(root) else { continue };
        let parts: Vec<_> = rel.components().collect();
        if parts.is_empty() || !parts.iter().all(|c| matches!(c, Component::Normal(_))) {
            continue;
        }
        let rel = vault::relative(root, &path);
        if !seen.insert(rel.clone()) {
            continue;
        }
        // Temp files, Kin's memory, .git, .obsidian, .DS_Store.
        if rel.split('/').any(|part| part.starts_with('.')) {
            continue;
        }
        if rel.split('/').next().is_some_and(|top| top.eq_ignore_ascii_case(INSPIRATION)) {
            continue;
        }
        let doc = path.extension().and_then(|e| e.to_str()).is_some_and(|e| e == "md" || e == "mdx");
        match fs::metadata(&path) {
            Ok(meta) if meta.is_dir() => relevant = true,
            Ok(_) if doc => match fs::read_to_string(&path) {
                Ok(text) => {
                    if written.get(&rel) != Some(&vault::version(&text)) {
                        relevant = true;
                        out.docs.push(Doc { path: rel, text });
                    }
                }
                Err(e) if e.kind() == ErrorKind::NotFound => {
                    relevant = true;
                    out.gone.push(rel);
                }
                Err(_) => {}
            },
            Ok(_) => {}
            Err(e) if e.kind() == ErrorKind::NotFound => {
                relevant = true;
                out.gone.push(rel);
            }
            Err(_) => {}
        }
    }
    relevant.then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn written(entries: &[(&str, &str)]) -> HashMap<String, String> {
        entries.iter().map(|(p, t)| (p.to_string(), vault::version(t))).collect()
    }

    #[test]
    fn ignores_temp_files_hidden_folders_inspiration_and_kintsugis_own_saves() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("posts")).unwrap();
        fs::create_dir_all(root.join(".kintsugi/comments")).unwrap();
        fs::create_dir_all(root.join("inspiration")).unwrap();
        fs::write(root.join("posts/mine.mdx"), "saved by kintsugi").unwrap();
        fs::write(root.join("posts/.kintsugi-a1b2c3"), "half a save").unwrap();
        fs::write(root.join(".kintsugi/comments/x.json"), "{}").unwrap();
        fs::write(root.join("inspiration/clip.md"), "a clip").unwrap();
        fs::write(root.join("posts/image.png"), "png").unwrap();
        let paths = ["posts/mine.mdx", "posts/.kintsugi-a1b2c3", ".kintsugi/comments/x.json", "inspiration/clip.md", "posts/image.png", ".DS_Store"]
            .map(|p| root.join(p))
            .to_vec();
        assert_eq!(outside(root, paths, &written(&[("posts/mine.mdx", "saved by kintsugi")])), None);
        // Something outside the vault is not this vault's news either.
        assert_eq!(outside(root, vec![PathBuf::from("/elsewhere/a.md")], &HashMap::new()), None);
    }

    #[test]
    fn reports_outside_edits_new_documents_deletes_and_folders() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("notes/new-folder")).unwrap();
        fs::write(root.join("notes/a.md"), "edited in obsidian").unwrap();
        let paths = ["notes/a.md", "notes/a.md", "notes/gone.md", "old-folder", "notes/new-folder"]
            .map(|p| root.join(p))
            .to_vec();
        // Kintsugi saved an older text; the disk has moved on.
        assert_eq!(
            outside(root, paths, &written(&[("notes/a.md", "saved by kintsugi")])),
            Some(Outside {
                docs: vec![Doc { path: "notes/a.md".into(), text: "edited in obsidian".into() }],
                gone: vec!["notes/gone.md".into(), "old-folder".into()],
            })
        );
        // A new folder alone still reloads the tree.
        assert_eq!(outside(root, vec![root.join("notes/new-folder")], &HashMap::new()), Some(Outside::default()));
    }

    #[test]
    fn the_watcher_reports_another_apps_save_but_not_kintsugis() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        fs::write(root.join("note.md"), "first").unwrap();
        let written: Written = Arc::default();
        let (tx, rx) = mpsc::channel();
        let _watcher = watch(&root, written.clone(), move |o| {
            let _ = tx.send(o);
        })
        .unwrap();
        // FSEvents can replay events from just before the stream started.
        std::thread::sleep(Duration::from_millis(300));
        while rx.try_recv().is_ok() {}

        written.lock().unwrap().insert("note.md".into(), vault::version("from kintsugi"));
        vault::write_atomic(&root.join("note.md"), "from kintsugi").unwrap();
        assert!(rx.recv_timeout(Duration::from_secs(2)).is_err(), "Kintsugi's own save is not reported");

        fs::write(root.join("note.md"), "from another app").unwrap();
        let got = rx.recv_timeout(Duration::from_secs(5)).expect("an outside edit is reported");
        assert_eq!(got.docs, vec![Doc { path: "note.md".into(), text: "from another app".into() }]);

        fs::remove_file(root.join("note.md")).unwrap();
        let got = rx.recv_timeout(Duration::from_secs(5)).expect("a delete is reported");
        assert_eq!(got.gone, vec!["note.md".to_string()]);
    }
}
