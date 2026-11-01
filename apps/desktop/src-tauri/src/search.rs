//! The app's one search index (`kintsugi-search`, see `docs/search.md`),
//! shared by the library, Kin's `search` tool and the Feed.
//!
//! - The index is `<config>/search/index.sqlite`, never in the vault. An
//!   isolated dev run without a scratch config dir keeps it in memory.
//! - The embedding model is fetched once into `<config>/search/models/` and
//!   verified; until it's there, search is words only. Headless runs skip it
//!   unless `KINTSUGI_HEADLESS_EMBEDDINGS=1`.
//! - Every search first syncs the open vault from cheap file metadata, and
//!   document saves and `clips:changed` refresh it in the background, so
//!   results never wait on more than what just changed.
//! - The Feed's visible items are pulled into the `feed` scope whenever the
//!   Feed changes (polls, expiry, Not interested, mute, full text).

use crate::AppHandle;
use kintsugi_search::{self as search, FEED_SCOPE, Hit, Index, Kind, Query};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Manager, State};

type Result<T> = std::result::Result<T, String>;

/// Library results that match by meaning alone must be this close.
const LIBRARY_SIMILARITY: f32 = 0.35;
const LIBRARY_RANKED: usize = 500;
/// Saves arrive in bursts (autosave, enrichment); refresh once they settle.
const REFRESH_DELAY: Duration = Duration::from_millis(400);

#[derive(Clone, Default)]
pub struct Search(Arc<Shared>);

#[derive(Default)]
struct Shared {
    /// Opened on first use, once the app's data folder is known.
    index: Mutex<Option<Index>>,
    vault_dirty: AtomicBool,
    feed_dirty: AtomicBool,
    refreshing: AtomicBool,
}

/// `<config>/search`, or `None` for an isolated dev run without one.
fn data_dir(app: &AppHandle) -> Option<PathBuf> {
    crate::ai::kin::data_dir(app).and_then(|kin| kin.parent().map(|p| p.join("search")))
}

/// Each vault has its own scope in the one index, keyed by its canonical path.
fn scope(root: &Path) -> Result<(PathBuf, String)> {
    let root = root.canonicalize().map_err(|_| "could not open the vault for search")?;
    let key = root.to_string_lossy().into_owned();
    Ok((root, key))
}

impl Search {
    fn with<T>(&self, app: &AppHandle, f: impl FnOnce(&mut Index) -> Result<T>) -> Result<T> {
        let mut slot = self.0.index.lock().map_err(|_| "search unavailable")?;
        if slot.is_none() {
            *slot = Some(match data_dir(app) {
                Some(dir) => Index::open(&dir.join("index.sqlite"))?,
                None => Index::open_in_memory()?,
            });
        }
        f(slot.as_mut().unwrap())
    }

    /// Syncs the vault at `root`, then searches it (and the Feed). The query's
    /// scopes are set here.
    pub fn query(&self, app: &AppHandle, root: &Path, mut query: Query) -> Result<Vec<Hit>> {
        let (root, key) = scope(root)?;
        query.scopes = vec![key.clone(), FEED_SCOPE.into()];
        self.with(app, |index| {
            search::vault::sync(index, &key, &root)?;
            index.search(&query)
        })
    }

    /// Clip paths for a library query, best first: every word (or its stem
    /// or prefix) in the clip, or close in meaning. `None` if search failed.
    pub fn rank_clips(&self, app: &AppHandle, root: &Path, text: &str) -> Option<Vec<String>> {
        let mut query = Query::new(text, &[]);
        query.kinds = vec![Kind::Clip];
        query.limit = LIBRARY_RANKED;
        query.all_terms = true;
        query.min_similarity = LIBRARY_SIMILARITY;
        let hits = self.query(app, root, query).ok()?;
        Some(hits.into_iter().map(|h| h.id).collect())
    }
}

/// What Feed ranking (KI-32) reads from the index: one vector per feed item
/// and per vault document, and the model to embed anything else with.
/// `None` until the model is loaded: ranking then uses hashed text vectors.
pub struct Vectors {
    pub feed: std::collections::HashMap<String, Vec<f32>>,
    pub vault: std::collections::HashMap<String, Vec<f32>>,
    pub embedder: Arc<dyn search::Embedder>,
}

impl Search {
    pub fn vectors(&self, app: &AppHandle, root: Option<&Path>) -> Option<Vectors> {
        self.with(app, |index| {
            let Some(embedder) = index.embedder() else { return Ok(None) };
            let mut vault = Default::default();
            if let Some((root, key)) = root.and_then(|r| scope(r).ok()) {
                search::vault::sync(index, &key, &root)?;
                vault = index.doc_vectors(&key)?;
            }
            Ok(Some(Vectors { feed: index.doc_vectors(FEED_SCOPE)?, vault, embedder }))
        })
        .ok()
        .flatten()
    }
}

/// Loads the embedding model in the background (downloading it once), then
/// embeds whatever the index holds without vectors.
pub fn init(app: &AppHandle) {
    feed_changed(app);
    if !embeddings_enabled() {
        return;
    }
    let Some(dir) = data_dir(app) else { return };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let client = match reqwest::Client::builder().connect_timeout(Duration::from_secs(10)).build() {
            Ok(client) => client,
            Err(_) => return,
        };
        let model = match search::POTION_BASE_8M.ensure(&dir.join("models"), &client).await {
            Ok(model) => Arc::new(model),
            Err(error) => {
                eprintln!("search: words only ({error})");
                return;
            }
        };
        let _ = tauri::async_runtime::spawn_blocking(move || {
            let state = app.state::<Search>();
            if state.with(&app, |index| index.set_embedder(model)).is_err() {
                return;
            }
            // In batches, so searches can run between them.
            while state.with(&app, |index| index.embed_missing(512)).is_ok_and(|n| n > 0) {}
        })
        .await;
    });
}

fn embeddings_enabled() -> bool {
    if std::env::var_os("KINTSUGI_EMBEDDINGS").is_some_and(|v| v == "off") {
        return false;
    }
    if cfg!(feature = "headless") {
        return std::env::var_os("KINTSUGI_HEADLESS_EMBEDDINGS").is_some_and(|v| v == "1");
    }
    true
}

/// A document or clip changed: refresh the open vault's scope soon, off the
/// calling thread.
pub fn changed(app: &AppHandle) {
    let state = app.state::<Search>().inner().clone();
    state.0.vault_dirty.store(true, Ordering::SeqCst);
    state.refresh(app);
}

/// The Feed changed: bring the `feed` scope up to date soon.
pub fn feed_changed(app: &AppHandle) {
    let state = app.state::<Search>().inner().clone();
    state.0.feed_dirty.store(true, Ordering::SeqCst);
    state.refresh(app);
}

impl Search {
    /// One background refresher at a time; changes during a round start another.
    fn refresh(self, app: &AppHandle) {
        if self.0.refreshing.swap(true, Ordering::SeqCst) {
            return;
        }
        let app = app.clone();
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(REFRESH_DELAY);
                let vault = self.0.vault_dirty.swap(false, Ordering::SeqCst);
                let feed = self.0.feed_dirty.swap(false, Ordering::SeqCst);
                if !vault && !feed {
                    break;
                }
                if vault
                    && let Ok(root) = app.state::<crate::vault::Vault>().root()
                    && let Ok((root, key)) = scope(&root)
                {
                    let _ = self.with(&app, |index| search::vault::sync(index, &key, &root));
                }
                if feed && let Err(error) = self.sync_feed(&app) {
                    eprintln!("search: feed not indexed ({error})");
                }
            }
            self.0.refreshing.store(false, Ordering::SeqCst);
            if self.0.vault_dirty.load(Ordering::SeqCst) || self.0.feed_dirty.load(Ordering::SeqCst) {
                self.clone().refresh(&app);
            }
        });
    }

    /// The Feed's store and this index are separate files; the Feed says what
    /// changed against our stamps, and the index applies it.
    fn sync_feed(&self, app: &AppHandle) -> Result<()> {
        let indexed = self.with(app, |index| index.stamps(FEED_SCOPE))?;
        let (docs, gone) = crate::feed::search_changes(app, &indexed)?;
        self.with(app, |index| {
            index.remove(FEED_SCOPE, &gone)?;
            index.upsert(FEED_SCOPE, &docs)
        })
    }
}

/// Kin's `search` tool, bound to the open vault.
pub fn searcher(app: &AppHandle) -> crate::ai::tools::Searcher {
    let app = app.clone();
    Arc::new(move |query: &Query| {
        let root = crate::vault::current(&app)?;
        app.state::<Search>().query(&app, &root, query.clone())
    })
}

/// Hybrid search for the webview: `{ query, k?, kinds?, within? }` →
/// `{ id, kind, title?, source?, snippet, score }[]`, best first.
#[tauri::command]
pub async fn search(
    app: AppHandle,
    search: State<'_, Search>,
    query: String,
    k: Option<usize>,
    kinds: Option<Vec<Kind>>,
    within: Option<String>,
) -> Result<Vec<Hit>> {
    let root = crate::vault::current(&app)?;
    let state = search.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut q = Query::new(&query, &[]);
        q.limit = k.unwrap_or(20).clamp(1, 100);
        q.kinds = kinds.unwrap_or_default();
        q.within = within.filter(|w| !w.trim().is_empty());
        state.query(&app, &root, q)
    })
    .await
    .map_err(|_| "search task failed")?
}
