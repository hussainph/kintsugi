//! Files Kintsugi keeps beside a document, never in it: one JSON file per
//! document at `<dir>/<document path>.json` in the vault, such as comment
//! threads (`.kintsugi/comments/`, KI-38) and alternatives
//! (`.kintsugi/alternatives/`, KI-86). Each file has a `path` field naming
//! its document; renaming or moving the document (or its folder) moves it.

use kintsugi_vault::write_atomic;
use std::fs;
use std::path::{Component, Path, PathBuf};

type Result<T> = std::result::Result<T, String>;

/// The document a file is for: a Markdown file inside the vault, in no
/// hidden folder.
pub fn document(doc: &str) -> Result<&str> {
    let doc = doc.trim();
    let parts: Vec<_> = Path::new(doc).components().collect();
    let plain = !parts.is_empty()
        && parts.iter().all(
            |c| matches!(c, Component::Normal(name) if !name.to_string_lossy().starts_with('.')),
        );
    if !plain || !(doc.ends_with(".md") || doc.ends_with(".mdx")) {
        return Err(format!("not a document: {doc}"));
    }
    Ok(doc)
}

/// `<dir>/<doc>.json`, refusing links on the way.
pub fn file_path(root: &Path, dir: &str, doc: &str) -> Result<PathBuf> {
    let doc = document(doc)?;
    let mut at = root.to_path_buf();
    let file = format!("{doc}.json");
    for part in dir.split('/').chain(file.split('/')) {
        at.push(part);
        if fs::symlink_metadata(&at).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(format!("{dir}/{file}: links are not followed"));
        }
    }
    Ok(at)
}

/// A renamed or moved document (or folder) takes its file (or folder of
/// files) along. Nothing happens if there's none, or one is already there.
pub fn renamed(root: &Path, dir: &str, from: &str, to: &str) -> Result<()> {
    let folder = |rel: &str| -> Option<PathBuf> {
        let rel = rel.trim().trim_end_matches('/');
        let plain = !rel.is_empty()
            && Path::new(rel).components().all(
                |c| matches!(c, Component::Normal(n) if !n.to_string_lossy().starts_with('.')),
            );
        let at = root.join(dir).join(rel);
        (plain && !fs::symlink_metadata(root.join(dir)).is_ok_and(|m| m.file_type().is_symlink()))
            .then_some(at)
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
    let (Ok(old), Ok(new)) = (file_path(root, dir, from), file_path(root, dir, to)) else {
        return Ok(());
    };
    if !old.is_file() || new.exists() {
        return Ok(());
    }
    let text = fs::read_to_string(&old).map_err(|e| e.to_string())?;
    let mut value: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("{dir}/{from}.json: {e}"))?;
    if let Some(object) = value.as_object_mut() {
        object.insert("path".into(), to.trim().into());
    }
    fs::create_dir_all(new.parent().ok_or("not a file path")?).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    write_atomic(&new, &(json + "\n"))?;
    fs::remove_file(old).map_err(|e| e.to_string())
}
