//! The desktop's view of the vault: which folder is open, and the commands
//! the webview calls. The vault itself lives in `kintsugi_vault`.

use crate::config;
use kintsugi_vault::{self as vault, Entry};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

const WELCOME: &str = "---
title: Welcome to Kintsugi
status: draft
---

# Welcome to Kintsugi

This is your vault: a plain folder of Markdown and MDX files. Kintsugi never hides your writing in a database, so you can open these files in anything.

Every document carries a `status` in its frontmatter, `draft` or `complete`. Press ⌘⇧D to flip it.

- ⌘N: new document
- ⌘P: jump to a document
- ⌘\\: hide the sidebar
- ⌘⇧O: open a different vault
";

#[derive(Default)]
pub struct Vault(Mutex<Option<PathBuf>>);

type Result<T> = std::result::Result<T, String>;

impl Vault {
    pub fn root(&self) -> Result<PathBuf> {
        self.0.lock().unwrap().clone().ok_or_else(|| "no vault open".into())
    }
}

/// The open vault, opening the last one used or creating `~/Documents/Kintsugi`.
/// The phone can ask before the window has, so this works from either.
pub fn current(app: &AppHandle) -> Result<PathBuf> {
    let vault = app.state::<Vault>();
    if let Ok(root) = vault.root() {
        return Ok(root);
    }
    let path = match config::load(app).vault.filter(|p| p.is_dir()) {
        Some(path) => path,
        None => {
            let path = app.path().document_dir().map_err(|e| e.to_string())?.join("Kintsugi");
            if !path.exists() {
                fs::create_dir_all(&path).map_err(|e| e.to_string())?;
                vault::write_atomic(&path.join("welcome.mdx"), WELCOME)?;
            }
            path
        }
    };
    open(app, &path)?;
    Ok(path)
}

fn open(app: &AppHandle, path: &std::path::Path) -> Result<()> {
    if !path.is_dir() {
        return Err(format!("not a folder: {}", path.display()));
    }
    config::update(app, |c| c.vault = Some(path.to_path_buf()))?;
    *app.state::<Vault>().0.lock().unwrap() = Some(path.to_path_buf());
    Ok(())
}

#[tauri::command]
pub fn vault_current(app: AppHandle) -> Result<String> {
    Ok(current(&app)?.to_string_lossy().into())
}

#[tauri::command]
pub fn vault_open(app: AppHandle, path: String) -> Result<String> {
    open(&app, std::path::Path::new(&path))?;
    Ok(path)
}

#[tauri::command]
pub fn vault_tree(vault: State<Vault>) -> Result<Vec<Entry>> {
    vault::tree(&vault.root()?)
}

#[tauri::command]
pub fn doc_read(vault: State<Vault>, path: String) -> Result<String> {
    Ok(vault::read(&vault.root()?, &path)?.text)
}

/// The desktop editor holds the document, so its saves don't check versions.
#[tauri::command]
pub fn doc_write(vault: State<Vault>, path: String, contents: String) -> Result<()> {
    writing_path(&path)?;
    vault::write(&vault.root()?, &path, &contents, None).map(drop)
}

/// Creates a draft in `dir` named after `title`; returns its path.
#[tauri::command]
pub fn doc_create(vault: State<Vault>, dir: String, title: String) -> Result<String> {
    writing_path(&dir)?;
    vault::create_doc(&vault.root()?, &dir, &title)
}

#[tauri::command]
pub fn folder_create(vault: State<Vault>, dir: String, name: String) -> Result<String> {
    writing_path(&dir)?;
    writing_path(&std::path::Path::new(&dir).join(vault::slugify(&name)).to_string_lossy())?;
    vault::create_folder(&vault.root()?, &dir, &name)
}

/// Renames in place (same folder); returns the new path.
#[tauri::command]
pub fn entry_rename(vault: State<Vault>, path: String, name: String) -> Result<String> {
    writing_path(&path)?;
    writing_path(&std::path::Path::new(&path).with_file_name(&name).to_string_lossy())?;
    vault::rename(&vault.root()?, &path, &name)
}

/// Moves to the macOS Trash rather than deleting, so it can be undone in Finder.
#[tauri::command]
pub fn entry_trash(vault: State<Vault>, path: String) -> Result<()> {
    writing_path(&path)?;
    if path.is_empty() {
        return Err("refusing to trash the vault itself".into());
    }
    let target = vault::resolve(&vault.root()?, &path)?;
    trash::delete(target).map_err(|e| e.to_string())
}

fn writing_path(path: &str) -> Result<()> {
    if vault::is_inspiration_path(path) {
        return Err("use clip commands for inspiration".into());
    }
    Ok(())
}

#[derive(Clone, serde::Serialize)]
struct ClipChanged<'a> {
    path: &'a str,
}

/// The library and enrichment listen to one event for Mac and phone captures.
/// Only paths cross this boundary, never the image bytes or source text.
pub fn clips_changed(app: &AppHandle, path: &str) {
    let _ = app.emit("clips:changed", ClipChanged { path });
}

#[tauri::command]
pub fn clip_list(vault: State<Vault>) -> Result<Vec<vault::ClipSummary>> {
    vault::clip_list(&vault.root()?)
}

#[tauri::command]
pub fn clip_read(vault: State<Vault>, path: String) -> Result<vault::Clip> {
    vault::clip_read(&vault.root()?, &path)
}

#[tauri::command]
pub fn clip_create(app: AppHandle, vault: State<Vault>, capture: vault::ClipCapture) -> Result<String> {
    let path = vault::clip_create(&vault.root()?, &capture)?;
    clips_changed(&app, &path);
    Ok(path)
}

/// Editing a clip never renames its stable file or replaces extracted source.
#[tauri::command]
pub fn clip_update(
    app: AppHandle,
    vault: State<Vault>,
    path: String,
    title: Option<String>,
    tags: Option<Vec<String>>,
    note: Option<String>,
) -> Result<vault::Clip> {
    let clip = vault::clip_update(&vault.root()?, &path, &vault::ClipUpdate {
        title, tags, note, ..Default::default()
    })?;
    clips_changed(&app, &path);
    Ok(clip)
}

/// The Markdown and its primary image go to the macOS Trash, not an unlink.
#[tauri::command]
pub fn clip_trash(app: AppHandle, vault: State<Vault>, path: String) -> Result<()> {
    vault::clip_trash(&vault.root()?, &path, |targets| {
        trash::delete_all(targets).map_err(|_| "could not move clip to Trash".into())
    })?;
    clips_changed(&app, &path);
    Ok(())
}
