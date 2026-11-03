//! A folder's colour and icon (KI-75), kept beside the writing in
//! `.kintsugi/folders.json` so every device that opens the vault sees the
//! same ones. Keys are vault-relative folder paths; values name a colour and
//! an icon from small fixed sets, by stable key, so each app maps them to
//! its own palette and icon pack.
//!
//! ```json
//! { "version": 1, "folders": { "drafts": { "color": "amber", "icon": "pen" } } }
//! ```
//!
//! Unknown keys from a newer app are kept on read and left alone on write.

use crate::{Result, moved_path, resolve, write_atomic};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};

pub const FOLDERS_FILE: &str = ".kintsugi/folders.json";

/// The colours a folder can take. Mirrors `packages/core/src/folders.ts`.
pub const FOLDER_COLORS: [&str; 6] = ["red", "amber", "green", "sage", "sand", "lavender"];

/// The icons a folder can take. Mirrors `packages/core/src/folders.ts`.
pub const FOLDER_ICONS: [&str; 16] = [
    "folder",
    "inbox",
    "pen",
    "note",
    "book",
    "bulb",
    "star",
    "heart",
    "quote",
    "image",
    "code",
    "globe",
    "music",
    "camera",
    "briefcase",
    "archive",
];

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct FolderStyle {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// Fields a newer app wrote; kept as they are.
    #[serde(flatten)]
    pub other: BTreeMap<String, serde_json::Value>,
}

impl FolderStyle {
    fn is_empty(&self) -> bool {
        self.color.is_none() && self.icon.is_none() && self.other.is_empty()
    }
}

#[derive(Serialize, Deserialize)]
struct File {
    #[serde(default = "one")]
    version: u32,
    #[serde(default)]
    folders: BTreeMap<String, FolderStyle>,
    #[serde(flatten)]
    other: BTreeMap<String, serde_json::Value>,
}

fn one() -> u32 {
    1
}

impl Default for File {
    fn default() -> Self {
        File {
            version: one(),
            folders: BTreeMap::new(),
            other: BTreeMap::new(),
        }
    }
}

/// The file, unless `.kintsugi` is a symlink that could lead out of the vault.
fn file_path(root: &Path) -> Result<PathBuf> {
    if fs::symlink_metadata(root.join(".kintsugi")).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(".kintsugi is a symlink".into());
    }
    Ok(root.join(FOLDERS_FILE))
}

fn load(root: &Path) -> Result<File> {
    match fs::read_to_string(file_path(root)?) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("{FOLDERS_FILE}: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(File::default()),
        Err(e) => Err(e.to_string()),
    }
}

fn save(root: &Path, file: &File) -> Result<()> {
    let path = file_path(root)?;
    fs::create_dir_all(path.parent().ok_or("no parent")?).map_err(|e| e.to_string())?;
    let mut text = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    text.push('\n');
    write_atomic(&path, &text)
}

/// Every folder's style, by path. A file that doesn't parse reads as none,
/// so a hand edit gone wrong never hides the tree.
pub fn folder_styles(root: &Path) -> BTreeMap<String, FolderStyle> {
    load(root).map(|f| f.folders).unwrap_or_default()
}

/// Sets (or, with neither, clears) one folder's colour and icon. Other
/// fields on it are kept. A file that doesn't parse is left alone.
pub fn set_folder_style(root: &Path, path: &str, mut style: FolderStyle) -> Result<()> {
    let plain = !path.is_empty()
        && Path::new(path)
            .components()
            .all(|c| matches!(c, Component::Normal(n) if !n.to_string_lossy().starts_with('.')));
    if !plain || !resolve(root, path)?.is_dir() {
        return Err(format!("not a folder: {path}"));
    }
    if let Some(color) = &style.color
        && !FOLDER_COLORS.contains(&color.as_str())
    {
        return Err(format!("not a folder colour: {color}"));
    }
    if let Some(icon) = &style.icon
        && !FOLDER_ICONS.contains(&icon.as_str())
    {
        return Err(format!("not a folder icon: {icon}"));
    }
    let mut file = load(root)?;
    style.other = file
        .folders
        .get(path)
        .map(|s| s.other.clone())
        .unwrap_or_default();
    if style.is_empty() {
        file.folders.remove(path);
    } else {
        file.folders.insert(path.to_string(), style);
    }
    save(root, &file)
}

/// After `from` was renamed or moved to `to`: its style, and its subfolders',
/// follow it. Best effort; nothing to do when no style mentions it.
pub fn folder_styles_moved(root: &Path, from: &str, to: &str) -> Result<()> {
    let mut file = load(root)?;
    let moved: Vec<String> = file
        .folders
        .keys()
        .filter(|k| moved_path(k, from, to).is_some())
        .cloned()
        .collect();
    if moved.is_empty() {
        return Ok(());
    }
    for key in moved {
        if let (Some(style), Some(next)) = (file.folders.remove(&key), moved_path(&key, from, to)) {
            file.folders.insert(next, style);
        }
    }
    save(root, &file)
}

/// After `path` went to the Trash: drop its style and its subfolders'.
pub fn folder_styles_removed(root: &Path, path: &str) -> Result<()> {
    let mut file = load(root)?;
    let before = file.folders.len();
    file.folders
        .retain(|k, _| moved_path(k, path, "").is_none());
    if file.folders.len() == before {
        return Ok(());
    }
    save(root, &file)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn style(color: &str, icon: &str) -> FolderStyle {
        FolderStyle {
            color: Some(color.into()),
            icon: Some(icon.into()),
            ..Default::default()
        }
    }

    #[test]
    fn styles_persist_follow_moves_and_drop_with_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("notes/deep")).unwrap();
        fs::create_dir_all(root.join("posts")).unwrap();
        assert!(folder_styles(root).is_empty());

        set_folder_style(root, "notes", style("amber", "pen")).unwrap();
        set_folder_style(
            root,
            "notes/deep",
            FolderStyle {
                color: Some("sage".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let text = fs::read_to_string(root.join(FOLDERS_FILE)).unwrap();
        assert!(text.contains("\"version\": 1"), "{text}");
        assert_eq!(folder_styles(root)["notes"], style("amber", "pen"));

        folder_styles_moved(root, "notes", "posts/notes").unwrap();
        let styles = folder_styles(root);
        assert_eq!(
            styles.keys().collect::<Vec<_>>(),
            ["posts/notes", "posts/notes/deep"]
        );

        folder_styles_removed(root, "posts/notes/deep").unwrap();
        assert_eq!(folder_styles(root).len(), 1);

        // An empty style clears the entry.
        fs::create_dir_all(root.join("posts/notes")).unwrap();
        set_folder_style(root, "posts/notes", FolderStyle::default()).unwrap();
        assert!(folder_styles(root).is_empty());
    }

    #[test]
    fn refuses_unknown_values_hidden_paths_and_missing_folders() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("notes")).unwrap();
        fs::create_dir_all(root.join(".kintsugi/kin")).unwrap();
        assert!(set_folder_style(root, "notes", style("magenta", "pen")).is_err());
        assert!(set_folder_style(root, "notes", style("red", "skull")).is_err());
        assert!(set_folder_style(root, "missing", style("red", "pen")).is_err());
        assert!(set_folder_style(root, ".kintsugi", style("red", "pen")).is_err());
        assert!(set_folder_style(root, "", style("red", "pen")).is_err());
        assert!(set_folder_style(root, "../x", style("red", "pen")).is_err());
    }

    #[test]
    fn a_broken_file_reads_as_no_styles_and_newer_fields_survive() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join(".kintsugi")).unwrap();
        fs::create_dir_all(root.join("notes")).unwrap();
        fs::write(root.join(FOLDERS_FILE), "{ nope").unwrap();
        assert!(folder_styles(root).is_empty());
        assert!(set_folder_style(root, "notes", style("red", "pen")).is_err());
        assert_eq!(
            fs::read_to_string(root.join(FOLDERS_FILE)).unwrap(),
            "{ nope"
        );

        fs::write(
            root.join(FOLDERS_FILE),
            r#"{"version":1,"pinned":["notes"],"folders":{"notes":{"color":"red","emoji":"x"}}}"#,
        )
        .unwrap();
        set_folder_style(root, "notes", style("sand", "book")).unwrap();
        let text = fs::read_to_string(root.join(FOLDERS_FILE)).unwrap();
        assert!(
            text.contains("pinned") && text.contains("emoji") && text.contains("sand"),
            "{text}"
        );
    }
}
