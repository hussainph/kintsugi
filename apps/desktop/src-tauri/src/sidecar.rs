//! Files Kintsugi keeps beside a document, never in it. JSON sidecars
//! hold comments and alternatives; Markdown holds the shared stash.
//! Renaming or moving a document (or its folder) takes its sidecars along.

use kintsugi_vault::write_atomic;
use std::fs;
use std::path::{Component, Path, PathBuf};

type Result<T> = std::result::Result<T, String>;

fn relative(path: &str, hidden: bool) -> bool {
    !path.is_empty()
        && Path::new(path).components().all(|c| {
            matches!(c, Component::Normal(n) if hidden || !n.to_string_lossy().starts_with('.'))
        })
}

/// The document a file is for: a Markdown file inside the vault, in no
/// hidden folder.
pub fn document(doc: &str) -> Result<&str> {
    let doc = doc.trim();
    if !relative(doc, false) || !(doc.ends_with(".md") || doc.ends_with(".mdx")) {
        return Err(format!("not a document: {doc}"));
    }
    Ok(doc)
}

/// Resolve a relative path without following links, including a dangling
/// link or one in a parent folder. Missing components are fine for writes.
fn checked(root: &Path, rel: &str) -> Result<PathBuf> {
    if !relative(rel, true) {
        return Err("not a relative sidecar path".into());
    }
    let mut at = root.to_path_buf();
    for part in Path::new(rel).components() {
        at.push(part);
        match fs::symlink_metadata(&at) {
            Ok(m) if m.file_type().is_symlink() => {
                return Err(format!("{rel}: links are not followed"));
            }
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.to_string()),
            _ => {}
        }
    }
    Ok(at)
}

/// The source document, with the same no-links check as its sidecar.
pub fn document_path(root: &Path, doc: &str) -> Result<PathBuf> {
    checked(root, document(doc)?)
}

/// `<dir>/<doc>.json`, refusing links on the way.
pub fn file_path(root: &Path, dir: &str, doc: &str) -> Result<PathBuf> {
    file_path_with_extension(root, dir, doc, "json")
}

/// The shared path checks, also used by Markdown stash files.
pub fn file_path_with_extension(root: &Path, dir: &str, doc: &str, ext: &str) -> Result<PathBuf> {
    let doc = document(doc)?;
    if !matches!(ext, "json" | "md") {
        return Err("not a sidecar extension".into());
    }
    checked(root, &format!("{dir}/{doc}.{ext}"))
}

/// A renamed or moved document (or folder) takes its JSON sidecar along.
pub fn renamed(root: &Path, dir: &str, from: &str, to: &str) -> Result<()> {
    renamed_with_extension(root, dir, from, to, "json")
}

/// Moves a sidecar without overwriting an existing destination. JSON has
/// its document path updated; Markdown has no embedded path to rewrite.
pub fn renamed_with_extension(
    root: &Path,
    dir: &str,
    from: &str,
    to: &str,
    ext: &str,
) -> Result<()> {
    let (from, to) = (
        from.trim().trim_end_matches('/'),
        to.trim().trim_end_matches('/'),
    );
    if !relative(from, false) || !relative(to, false) {
        return Ok(());
    }
    let old_folder = checked(root, &format!("{dir}/{from}"))?;
    let new_folder = checked(root, &format!("{dir}/{to}"))?;
    if old_folder.is_dir() {
        if new_folder.exists() {
            return Ok(());
        }
        fs::create_dir_all(new_folder.parent().ok_or("not a folder")?)
            .map_err(|e| e.to_string())?;
        return fs::rename(old_folder, new_folder).map_err(|e| e.to_string());
    }
    if document(from).is_err() || document(to).is_err() {
        return Ok(());
    }
    let old = file_path_with_extension(root, dir, from, ext)?;
    let new = file_path_with_extension(root, dir, to, ext)?;
    if !old.is_file() || new.exists() {
        return Ok(());
    }
    fs::create_dir_all(new.parent().ok_or("not a file path")?).map_err(|e| e.to_string())?;
    if ext == "md" {
        return fs::rename(old, new).map_err(|e| e.to_string());
    }
    let text = fs::read_to_string(&old).map_err(|e| e.to_string())?;
    let mut value: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("{dir}/{from}.json: {e}"))?;
    if let Some(object) = value.as_object_mut() {
        object.insert("path".into(), to.into());
    }
    let json = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    write_atomic(&new, &(json + "\n"))?;
    fs::remove_file(old).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_uses_the_shared_document_checks() {
        let dir = tempfile::tempdir().unwrap();
        assert!(
            file_path_with_extension(dir.path(), ".kintsugi/stash", "a.mdx", "md")
                .unwrap()
                .ends_with("a.mdx.md")
        );
        for doc in ["../x.md", "/x.md", ".private/x.md", "x.txt", ""] {
            assert!(file_path_with_extension(dir.path(), ".kintsugi/stash", doc, "md").is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn renames_refuse_links_in_every_parent() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join(".kintsugi/stash")).unwrap();
        fs::create_dir_all(outside.path().join("old")).unwrap();
        fs::write(outside.path().join("old/a.md.md"), "unchanged").unwrap();
        std::os::unix::fs::symlink(outside.path(), root.join(".kintsugi/stash/link")).unwrap();
        assert!(renamed_with_extension(root, ".kintsugi/stash", "link/old", "new", "md").is_err());
        assert_eq!(
            fs::read_to_string(outside.path().join("old/a.md.md")).unwrap(),
            "unchanged"
        );
        std::os::unix::fs::symlink(outside.path(), root.join("docs")).unwrap();
        assert!(document_path(root, "docs/a.md").is_err());
    }
}
