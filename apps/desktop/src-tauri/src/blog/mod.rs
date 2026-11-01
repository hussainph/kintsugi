//! Publishing to the blog (hussain.ph) and importing its posts as a read-only
//! mirror in the vault. Kintsugi writes into the repository's working tree
//! and stops there: no git, no push. See docs/publishing.md.

pub mod repo;

use crate::AppHandle;
use crate::vault::Vault;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

type Result<T> = std::result::Result<T, String>;

pub const DEFAULT_SITE: &str = "https://hussain.ph";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// The blog repository's root.
    pub path: Option<PathBuf>,
    /// Add a sources appendix from referenced clips by default.
    #[serde(default)]
    pub appendix: bool,
    #[serde(default = "default_site")]
    pub site: String,
}

fn default_site() -> String {
    DEFAULT_SITE.into()
}

impl Default for Settings {
    fn default() -> Self {
        Settings { path: None, appendix: false, site: default_site() }
    }
}

/// Settings once loaded (or, without a place to keep them, only in memory).
#[derive(Default)]
pub struct Blog {
    settings: Mutex<Option<Settings>>,
    ledger: Mutex<()>,
}

/// `<config>/<name>`. An isolated dev run without a scratch config keeps
/// everything in memory, so it never touches the real app's settings.
pub(crate) fn config_file(app: &AppHandle, name: &str) -> Option<PathBuf> {
    #[cfg(not(feature = "headless"))]
    if crate::config::isolated_dev() && std::env::var_os("KINTSUGI_CONFIG_DIR").is_none_or(|p| p.is_empty()) {
        return None;
    }
    crate::config::directory(app).ok().map(|d| d.join(name))
}

fn settings(app: &AppHandle) -> Settings {
    let blog = app.state::<Blog>();
    let mut cached = blog.settings.lock().unwrap();
    cached
        .get_or_insert_with(|| {
            config_file(app, "blog.json")
                .and_then(|p| fs::read_to_string(p).ok())
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default()
        })
        .clone()
}

/// The appendix default as KI-9 stored it; Settings → Export owns it now.
pub(crate) fn appendix_default(app: &AppHandle) -> bool {
    settings(app).appendix
}

fn save(app: &AppHandle, next: Settings) -> Result<()> {
    if let Some(path) = config_file(app, "blog.json") {
        fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
        kintsugi_vault::write_atomic(&path, &serde_json::to_string_pretty(&next).map_err(|e| e.to_string())?)?;
    }
    *app.state::<Blog>().settings.lock().unwrap() = Some(next);
    Ok(())
}

/// The configured repository, checked again on every use (it may have moved).
/// Headless runs only ever accept a scratch copy under a `.headless/` folder.
fn checked(path: &Path) -> Result<PathBuf> {
    #[cfg(feature = "headless")]
    crate::headless::scratch_blog(path)?;
    repo::checked_repo(path)
}

fn configured(app: &AppHandle) -> Result<(PathBuf, Settings)> {
    let settings = settings(app);
    let path = settings.path.clone().ok_or("Choose the blog's folder in Settings first.")?;
    Ok((checked(&path)?, settings))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    path: Option<String>,
    appendix: bool,
    site: String,
    /// The vault folder posts are mirrored into.
    folder: String,
    posts: Option<usize>,
    error: Option<String>,
}

fn status(app: &AppHandle) -> Status {
    let settings = settings(app);
    let (posts, error) = match settings.path.as_deref().map(checked) {
        None => (None, None),
        Some(Err(e)) => (None, Some(e)),
        Some(Ok(path)) => match repo::posts(&path, &settings.site) {
            Ok(posts) => (Some(posts.len()), None),
            Err(e) => (None, Some(e)),
        },
    };
    Status {
        path: settings.path.map(|p| p.to_string_lossy().into_owned()),
        appendix: settings.appendix,
        folder: repo::host(&settings.site),
        site: settings.site,
        posts,
        error,
    }
}

#[tauri::command]
pub fn blog_status(app: AppHandle) -> Status {
    status(&app)
}

/// Sets the repository (an empty path forgets it) and/or the appendix default.
#[tauri::command]
pub fn blog_configure(app: AppHandle, path: Option<String>, appendix: Option<bool>) -> Result<Status> {
    let mut next = settings(&app);
    if let Some(path) = path {
        next.path = if path.trim().is_empty() { None } else { Some(checked(Path::new(path.trim()))?) };
    }
    if let Some(appendix) = appendix {
        next.appendix = appendix;
    }
    save(&app, next)?;
    Ok(status(&app))
}

#[derive(Serialize, Clone)]
struct TreeChanged<'a> {
    path: &'a str,
    text: Option<String>,
}

/// The tree and references refresh; no open document's text changed.
fn changed(app: &AppHandle, folder: &str) {
    crate::vault::references_changed(app);
    let _ = app.emit("vault:changed", TreeChanged { path: folder, text: None });
}

/// Refreshes the vault's mirror of the blog's posts.
#[tauri::command]
pub fn blog_import(app: AppHandle, vault: State<Vault>) -> Result<repo::ImportReport> {
    let (path, settings) = configured(&app)?;
    let report = repo::import(&vault.root()?, &path, &settings.site, None)?;
    if !report.written.is_empty() || !report.removed.is_empty() {
        changed(&app, &report.folder);
    }
    Ok(report)
}

/// Vault documents on the blog (mirrors and published documents), for links.
#[tauri::command]
pub fn blog_links(vault: State<Vault>) -> Result<Vec<repo::Linked>> {
    repo::linked(&vault.root()?)
}

/// What Kintsugi last wrote to each post file, to notice edits made in the
/// repository since. Kept beside the settings; lost harmlessly in memory runs.
fn ledger(app: &AppHandle) -> HashMap<String, String> {
    config_file(app, "blog-published.json")
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn ledger_key(repo: &Path, file: &str) -> String {
    format!("{}::{file}", repo.display())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckRequest {
    /// The vault document being published.
    source: String,
    file: String,
    replaces: Option<String>,
    #[serde(default)]
    imports: Vec<String>,
    #[serde(default)]
    images: Vec<repo::ImageRef>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    exists: bool,
    owned: bool,
    changed: bool,
    imports: BTreeMap<String, bool>,
    images: BTreeMap<String, Option<String>>,
    repo: String,
    site: String,
    appendix: bool,
}

/// Does the document own this post? Its `post:` on disk names the file (or
/// the one being replaced). Saves are flushed before publishing.
fn owns(root: &Path, source: &str, file: &str, replaces: Option<&str>) -> Result<bool> {
    let text = fs::read_to_string(kintsugi_vault::resolve(root, source)?).map_err(|e| e.to_string())?;
    let post = repo::field(&text, "post");
    Ok(post.as_deref() == Some(file) || (post.is_some() && post.as_deref() == replaces))
}

#[tauri::command]
pub fn blog_check(app: AppHandle, vault: State<Vault>, request: CheckRequest) -> Result<Check> {
    let (path, settings) = configured(&app)?;
    let root = vault.root()?;
    repo::post_file(&request.file).ok_or_else(|| format!("not a blog post file: {}", request.file))?;
    let target = path.join(&request.file);
    let exists = target.exists();
    let owned = owns(&root, &request.source, &request.file, request.replaces.as_deref())?;
    let current = fs::read_to_string(&target).ok().or_else(|| {
        request.replaces.as_deref().and_then(|old| fs::read_to_string(path.join(old)).ok())
    });
    let written = request.replaces.iter().chain([&request.file]).find_map(|f| ledger(&app).remove(&ledger_key(&path, f)));
    let changed = owned && matches!((&current, &written), (Some(now), Some(then)) if &kintsugi_vault::version(now) != then);
    Ok(Check {
        exists,
        owned,
        changed,
        imports: repo::resolve_imports(&path, &request.imports),
        images: repo::resolve_images(&root, &request.images),
        repo: path.to_string_lossy().into_owned(),
        site: settings.site,
        appendix: settings.appendix,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishRequest {
    source: String,
    file: String,
    replaces: Option<String>,
    content: String,
    #[serde(default)]
    images: Vec<repo::CopyImage>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Published {
    repo: String,
    written: Vec<String>,
    removed: Vec<String>,
    import: Option<repo::ImportReport>,
}

/// Writes the post and its images into the repository's working tree. The
/// writer commits and pushes; Kintsugi never runs git.
#[tauri::command]
pub fn blog_publish(app: AppHandle, vault: State<Vault>, request: PublishRequest) -> Result<Published> {
    let (path, settings) = configured(&app)?;
    let root = vault.root()?;
    repo::refuse_mirror(&root, &request.source)?;
    let owned = owns(&root, &request.source, &request.file, request.replaces.as_deref())?;
    let written = repo::write_post(
        &root,
        &path,
        &request.file,
        request.replaces.as_deref(),
        &request.content,
        &request.images,
        owned,
    )?;
    {
        let blog = app.state::<Blog>();
        let _guard = blog.ledger.lock().unwrap();
        if let Some(file) = config_file(&app, "blog-published.json") {
            let mut entries = ledger(&app);
            if let Some(old) = &request.replaces {
                entries.remove(&ledger_key(&path, old));
            }
            entries.insert(ledger_key(&path, &request.file), kintsugi_vault::version(&request.content));
            if let Some(parent) = file.parent() {
                let _ = fs::create_dir_all(parent);
            }
            let _ = kintsugi_vault::write_atomic(&file, &serde_json::to_string_pretty(&entries).unwrap_or_default());
        }
    }
    // The mirror catches up (its post may now be sourced by this document).
    let import = repo::import(&root, &path, &settings.site, Some(&request.file)).ok();
    if let Some(report) = &import {
        changed(&app, &report.folder);
    }
    Ok(Published { repo: path.to_string_lossy().into_owned(), written: written.written, removed: written.removed, import })
}
