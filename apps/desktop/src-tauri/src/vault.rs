//! The desktop's view of the vault: which folder is open, and the commands
//! the webview calls. The vault itself lives in `kintsugi_vault`.

use crate::config;
use kintsugi_vault::{self as vault, Entry};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

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
    crate::enrich::wake(app);
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
    vault::write(&vault.root()?, &path, &contents, None).map(drop)
}

/// Creates a draft in `dir` named after `title`; returns its path.
#[tauri::command]
pub fn doc_create(vault: State<Vault>, dir: String, title: String) -> Result<String> {
    vault::create_doc(&vault.root()?, &dir, &title)
}

#[tauri::command]
pub fn folder_create(vault: State<Vault>, dir: String, name: String) -> Result<String> {
    vault::create_folder(&vault.root()?, &dir, &name)
}

/// Renames in place (same folder); returns the new path.
#[tauri::command]
pub fn entry_rename(vault: State<Vault>, path: String, name: String) -> Result<String> {
    vault::rename(&vault.root()?, &path, &name)
}

/// Moves to the macOS Trash rather than deleting, so it can be undone in Finder.
#[tauri::command]
pub fn entry_trash(vault: State<Vault>, path: String) -> Result<()> {
    if path.is_empty() {
        return Err("refusing to trash the vault itself".into());
    }
    let target = vault::resolve(&vault.root()?, &path)?;
    trash::delete(target).map_err(|e| e.to_string())
}
