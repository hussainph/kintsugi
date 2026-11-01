//! The Feed (docs/vision.md › Feed): sources Hussain follows, polled into one
//! SQLite file in the app's data directory (never the vault), read newest
//! first. Saving an item is the only way from the Feed into Inspiration, and
//! goes through the same clip capture path as every other capture.
//!
//! Fetching belongs to the ingest engine (`kintsugi-ingest`, docs/ingest.md):
//! its feed adapter polls sources, and its web adapter fetches an item's full
//! article when the feed only carries an excerpt. This module decides what to
//! poll when, and keeps the store.

mod opml;
mod presets;
mod store;

use crate::AppHandle;
use kintsugi_ingest::{self as ingest, CaptureOptions, Engine, Subscription, Target, feed::{FeedAdapter, Podcast}, web::WebAdapter, x::XAdapter};
use kintsugi_vault as vault;
use presets::{Subscribe, Youtube};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use store::{Due, Event, Item, NewItem, Page, Source, SourceKind, Store};
use tauri::{Emitter, Manager};
use tokio::sync::Notify;

type Result<T> = std::result::Result<T, String>;

const DB_FILE: &str = "feed.sqlite";
const CHANGED: &str = "feed:changed";
const TICK: Duration = Duration::from_secs(60);
const CONCURRENT_POLLS: usize = 4;
/// How often a healthy source is polled.
const INTERVAL: i64 = 30 * 60;
const FIRST_RETRY: i64 = 5 * 60;
/// A feed text shorter than this is an excerpt: reading or saving the item
/// fetches the full article through the ingest engine.
const EXCERPT_CHARS: usize = 600;

#[derive(Default)]
pub struct Feed {
    store: OnceLock<Mutex<Store>>,
    ingest: OnceLock<Ingest>,
    wake: Notify,
    /// One poll pass at a time, so a manual refresh and the timer don't
    /// fetch the same source twice.
    polling: tokio::sync::Mutex<()>,
}

/// The engine (feed and X adapters for polling, web adapter for full text) plus a
/// handle on the feed adapter for its discovery extras.
struct Ingest {
    engine: Engine,
    feeds: Arc<FeedAdapter>,
}

impl Ingest {
    fn new(app: &AppHandle) -> Result<Self> {
        let feeds = Arc::new(FeedAdapter::new().map_err(|e| e.to_string())?);
        let web = WebAdapter::new().map_err(|e| e.to_string())?;
        // The same hidden-webview JavaScript fallback clip enrichment uses.
        #[cfg(not(feature = "headless"))]
        let web = web.with_renderer(Arc::new(crate::enrich::render::WebviewRenderer::new(app.clone())));
        #[cfg(feature = "headless")]
        let _ = app;
        let x = XAdapter::new().map_err(|e| e.to_string())?;
        Ok(Self { engine: Engine::new().with(x).with(feeds.clone()).with(web), feeds })
    }
}

/// App data, not the vault. Headless and scratch runs use their own folder.
fn db_path(app: &AppHandle) -> Result<PathBuf> {
    #[cfg(feature = "headless")]
    {
        let _ = app;
        Ok(crate::headless::config_directory()?.join(DB_FILE))
    }
    #[cfg(not(feature = "headless"))]
    {
        #[cfg(debug_assertions)]
        if let Some(dir) = std::env::var_os("KINTSUGI_CONFIG_DIR").filter(|p| !p.is_empty()) {
            return Ok(PathBuf::from(dir).join(DB_FILE));
        }
        if crate::config::isolated_dev() {
            // A scratch vault run never touches the real app's feed.
            return Ok(std::env::temp_dir().join("kintsugi-isolated-dev").join(DB_FILE));
        }
        Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join(DB_FILE))
    }
}

impl Feed {
    fn store(&self, app: &AppHandle) -> Result<&Mutex<Store>> {
        if let Some(store) = self.store.get() {
            return Ok(store);
        }
        let opened = Store::open(&db_path(app)?)?;
        let _ = self.store.set(Mutex::new(opened));
        Ok(self.store.get().expect("feed store was just set"))
    }

    fn ingest(&self, app: &AppHandle) -> Result<&Ingest> {
        if let Some(ingest) = self.ingest.get() {
            return Ok(ingest);
        }
        let _ = self.ingest.set(Ingest::new(app)?);
        Ok(self.ingest.get().expect("feed ingest engine was just set"))
    }
}

fn with<T>(app: &AppHandle, f: impl FnOnce(&Store) -> Result<T>) -> Result<T> {
    let feed = app.state::<Feed>();
    let store = feed.store(app)?.lock().map_err(|_| "the feed database is unavailable".to_string())?;
    f(&store)
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn changed(app: &AppHandle) {
    crate::search::feed_changed(app);
    let _ = app.emit(CHANGED, ());
}

fn source_text(content: Option<String>) -> Option<String> {
    content.filter(|c| !c.trim().is_empty())
}

/// The item's full article through the ingest engine's web adapter, when the
/// feed only carried an excerpt. Tried once per item; the longer text wins.
async fn full_text(app: &AppHandle, item: &Item) -> Result<()> {
    let feed = app.state::<Feed>();
    let (content, tried) = with(app, |s| Ok((s.content(item.id)?, s.full_text_tried(item.id)?)))?;
    let short = content.as_deref().is_none_or(|c| c.chars().count() < EXCERPT_CHARS);
    let Some(url) = item.url.as_deref().filter(|_| short && !tried && item.media == "article") else {
        return Ok(());
    };
    let Ok(target) = Target::url(url) else { return Ok(()) };
    let fetched = feed.ingest(app)?.engine.capture(&target, CaptureOptions::default()).await.ok();
    let longer = fetched
        .map(|page| page.body)
        .filter(|body| body.chars().count() > content.as_deref().map_or(0, |c| c.chars().count()));
    with(app, |s| s.set_full_text(item.id, longer.as_deref(), now()))?;
    crate::search::feed_changed(app);
    Ok(())
}

/// The search index's id for a feed item. Not a vault path.
pub(crate) fn search_id(id: i64) -> String {
    format!("feed:{id}")
}

/// What the search index's `feed` scope should change, given what it holds
/// (ids to stamps): items new or changed since, as documents, and ids no
/// longer in the feed (expired, dismissed, muted or unfollowed).
pub(crate) fn search_changes(
    app: &AppHandle,
    indexed: &std::collections::HashMap<String, String>,
) -> Result<(Vec<kintsugi_search::Doc>, Vec<String>)> {
    with(app, |s| {
        let live = s.search_stamps()?;
        let ids: std::collections::HashSet<String> = live.iter().map(|(id, _)| search_id(*id)).collect();
        let gone = indexed.keys().filter(|id| !ids.contains(*id)).cloned().collect();
        let mut docs = Vec::new();
        for (id, stamp) in live {
            let key = search_id(id);
            if indexed.get(&key) == Some(&stamp) {
                continue;
            }
            let Some([title, source, author, summary, content]) = s.search_text(id)? else { continue };
            let body = [summary, content].into_iter().flatten().filter(|t| !t.trim().is_empty()).collect::<Vec<_>>().join("\n\n");
            docs.push(kintsugi_search::Doc {
                id: key,
                kind: Some(kintsugi_search::Kind::Feed),
                title,
                source: source.or(author),
                tags: vec![],
                body,
                stamp,
            });
        }
        Ok((docs, gone))
    })
}

// ── Polling ────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Polled {
    pub source_id: i64,
    pub added: usize,
    pub error: Option<String>,
}

/// Seconds until the next try after `failures` consecutive failures. YouTube's
/// channel feeds fail transiently (a non-200 means "retry", not "gone"), so
/// they never back off further than an hour; nor do X accounts, whose
/// FxTwitter page holds only the latest ~20 posts.
fn retry_after(kind: SourceKind, failures: i64) -> i64 {
    let cap = if matches!(kind, SourceKind::Youtube | SourceKind::X) { 60 * 60 } else { 24 * 60 * 60 };
    (FIRST_RETRY << (failures.clamp(1, 16) - 1)).min(cap)
}

/// What the source health line says about a failure.
fn describe(kind: SourceKind, error: ingest::Error) -> String {
    match (kind, error) {
        (SourceKind::Youtube, ingest::Error::Status(status)) => format!("YouTube answered {status}; it does that sometimes, so Kintsugi keeps trying"),
        (_, ingest::Error::Status(404)) => "not found (HTTP 404)".into(),
        (_, ingest::Error::Status(410)) => "the site says this feed is gone (HTTP 410)".into(),
        (_, ingest::Error::Status(status)) => format!("HTTP {status}"),
        (SourceKind::X, ingest::Error::Unavailable) => "FxTwitter didn't answer; the account may be private or gone".into(),
        (_, ingest::Error::Unavailable) => "couldn't reach it".into(),
        (_, ingest::Error::TimedOut) => "timed out".into(),
        (_, ingest::Error::TooLarge) => "too large to be a feed".into(),
        (_, ingest::Error::NotAFeed) => "not a feed".into(),
        (_, ingest::Error::RateLimited) => "rate limited; Kintsugi will try again later".into(),
        (_, error) => error.to_string(),
    }
}

fn new_item(item: ingest::Item) -> NewItem {
    let media = match item.extras.get("media").and_then(|m| m.as_str()) {
        Some("video") => "video",
        Some("audio") => "audio",
        _ => "article",
    };
    NewItem {
        guid: item.id,
        url: item.url,
        title: item.title,
        author: item.author,
        summary: item.description,
        content: Some(item.body).filter(|b| !b.trim().is_empty()),
        image: item.media.into_iter().find_map(|m| m.url),
        media,
        published_at: item.published.and_then(|p| chrono::DateTime::parse_from_rfc3339(&p).ok()).map(|d| d.timestamp()),
    }
}

/// Poll one source through the engine, record its health, store new entries.
async fn poll(store: &Mutex<Store>, engine: &Engine, due: &Due) -> Polled {
    let subscription = Subscription { url: due.url.clone(), cursor: due.cursor.clone() };
    let source = if due.kind == SourceKind::X { ingest::SourceType::X } else { ingest::SourceType::Rss };
    let outcome = engine.poll(source, &subscription).await;
    let result: Result<usize> = (|| {
        let store = store.lock().map_err(|_| "the feed database is unavailable".to_string())?;
        let now = now();
        match outcome {
            Ok(polled) => {
                let entries: Vec<NewItem> = polled.items.into_iter().map(new_item).collect();
                let added = store.insert_items(due.id, &entries, now, due.first)?;
                store.record_success(due.id, now, polled.cursor.as_deref(), polled.source.as_ref(), now + INTERVAL)?;
                Ok(added)
            }
            Err(error) => {
                let message = describe(due.kind, error);
                let status = match error {
                    ingest::Error::Status(status) => Some(status),
                    _ => None,
                };
                store.record_failure(due.id, now, status, &message, now + retry_after(due.kind, due.failures + 1))?;
                Err(message)
            }
        }
    })();
    match result {
        Ok(added) => Polled { source_id: due.id, added, error: None },
        Err(error) => Polled { source_id: due.id, added: 0, error: Some(error) },
    }
}

/// Polls every due source (or all of them), then expires ignored items.
async fn poll_due(app: &AppHandle, all: bool, only: Option<i64>) -> Result<Vec<Polled>> {
    use futures_util::StreamExt;
    let feed = app.state::<Feed>();
    let _pass = feed.polling.lock().await;
    let store = feed.store(app)?;
    let due = {
        let store = store.lock().map_err(|_| "the feed database is unavailable".to_string())?;
        match only {
            Some(id) => vec![store.due_one(id)?],
            None => store.due(now(), all)?,
        }
    };
    let engine = &feed.ingest(app)?.engine;
    let polled: Vec<Polled> = futures_util::stream::iter(due)
        .map(|d| async move { poll(store, engine, &d).await })
        .buffer_unordered(CONCURRENT_POLLS)
        .collect()
        .await;
    let expired = store.lock().map_err(|_| "the feed database is unavailable".to_string())?.expire(now())?;
    if !polled.is_empty() || expired > 0 {
        changed(app);
    }
    Ok(polled)
}

/// One background task polls due sources every minute, or when woken by a
/// subscribe, import or unmute.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let _ = poll_due(&app, false, None).await;
            let feed = app.state::<Feed>();
            let _ = tokio::time::timeout(TICK, feed.wake.notified()).await;
        }
    });
}

fn wake(app: &AppHandle) {
    app.state::<Feed>().wake.notify_one();
}

// ── Commands: sources ──────────────────────────────────────────────────────

#[tauri::command]
pub fn feed_sources(app: AppHandle) -> Result<Vec<Source>> {
    with(&app, |s| s.sources())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Subscribed {
    pub source: Source,
    pub added: usize,
    pub error: Option<String>,
}

/// A page that isn't a feed is searched for the feed it advertises. A URL
/// that doesn't answer right now is still followed: its health shows why,
/// and polling keeps retrying (a failure is "retry", not "gone").
async fn find_feed(feeds: &FeedAdapter, input: &str) -> Result<String> {
    let url = presets::checked_url(input)?;
    match feeds.discover(&url).await {
        Ok(found) => Ok(found.to_string()),
        Err(ingest::Error::NotAFeed) => Err("No feed there. Try the site's RSS or Atom link.".into()),
        Err(_) => Ok(url.to_string()),
    }
}

async fn resolve(feeds: &FeedAdapter, input: Subscribe) -> Result<(String, SourceKind, Option<String>)> {
    Ok(match input {
        Subscribe::Url { url } if presets::x_link(&url).is_some() => (presets::x_link(&url).unwrap_or_default(), SourceKind::X, None),
        Subscribe::Url { url } => {
            let url = find_feed(feeds, &url).await?;
            let kind = presets::kind_for_url(&url);
            (url, kind, None)
        }
        Subscribe::Hn { list, points } => {
            let title = match list.as_str() {
                "best" => "Hacker News: Best",
                "newest" => "Hacker News: Newest",
                "show" => "Show HN",
                "ask" => "Ask HN",
                _ => "Hacker News",
            };
            let title = match points.filter(|p| *p > 0) {
                Some(p) => format!("{title} ({p}+ points)"),
                None => title.to_string(),
            };
            (presets::hn_url(&list, points)?, SourceKind::Hn, Some(title))
        }
        Subscribe::Youtube { channel } => match presets::youtube(&channel)? {
            Youtube::Feed(url) => (url, SourceKind::Youtube, None),
            Youtube::Page(page) => {
                let page = presets::checked_url(&page)?;
                let id = feeds
                    .youtube_channel(&page)
                    .await
                    .map_err(|_| "Couldn't read that channel's ID from YouTube; try its /channel/UC… URL".to_string())?;
                (presets::youtube_feed(&id), SourceKind::Youtube, None)
            }
        },
        Subscribe::Podcast { feed_url, title } => (presets::checked_url(&feed_url)?.to_string(), SourceKind::Podcast, title),
        Subscribe::X { account } => (presets::x_account(&account)?, SourceKind::X, None),
    })
}

/// Subscribes and fetches right away, so the feed shows something (or the
/// source shows why not) before this returns.
#[tauri::command]
pub async fn feed_subscribe(app: AppHandle, input: Subscribe) -> Result<Subscribed> {
    let feeds = app.state::<Feed>().ingest(&app)?.feeds.clone();
    let (url, kind, title) = resolve(&feeds, input).await?;
    let source = with(&app, |s| {
        let (source, _) = s.add_source(&url, kind, title.as_deref(), now())?;
        s.log(&Event { at: now_ms(), kind: "subscribe".into(), source_id: Some(source.id), data: Some(json!({ "kind": kind })), ..Default::default() })?;
        Ok(source)
    })?;
    let polled = poll_due(&app, true, Some(source.id)).await?;
    let first = polled.into_iter().next();
    Ok(Subscribed {
        source: with(&app, |s| s.source(source.id))?,
        added: first.as_ref().map_or(0, |p| p.added),
        error: first.and_then(|p| p.error),
    })
}

#[tauri::command]
pub fn feed_unsubscribe(app: AppHandle, id: i64) -> Result<()> {
    with(&app, |s| {
        s.remove_source(id, now())?;
        s.log(&Event { at: now_ms(), kind: "unsubscribe".into(), source_id: Some(id), ..Default::default() })
    })?;
    changed(&app);
    Ok(())
}

#[tauri::command]
pub fn feed_mute(app: AppHandle, id: i64, muted: bool) -> Result<Source> {
    let source = with(&app, |s| {
        let source = s.set_muted(id, muted)?;
        s.log(&Event { at: now_ms(), kind: if muted { "mute" } else { "unmute" }.into(), source_id: Some(id), ..Default::default() })?;
        Ok(source)
    })?;
    if !muted {
        wake(&app);
    }
    changed(&app);
    Ok(source)
}

/// Fetch now: one source, or every unmuted one.
#[tauri::command]
pub async fn feed_refresh(app: AppHandle, id: Option<i64>) -> Result<Vec<Polled>> {
    poll_due(&app, true, id).await
}

#[tauri::command]
pub async fn feed_podcast_search(app: AppHandle, term: String) -> Result<Vec<Podcast>> {
    if term.trim().is_empty() {
        return Ok(Vec::new());
    }
    let feeds = app.state::<Feed>().ingest(&app)?.feeds.clone();
    feeds.search_podcasts(&term).await.map_err(|e| format!("Podcast search didn't answer ({e})"))
}

// ── Commands: OPML ─────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Imported {
    pub added: usize,
    pub existing: usize,
    pub invalid: usize,
}

/// The webview reads the chosen file; no arbitrary file reads cross IPC.
#[tauri::command]
pub fn feed_opml_import(app: AppHandle, opml: String) -> Result<Imported> {
    if opml.len() > 4 * 1024 * 1024 {
        return Err("that OPML file is too large".into());
    }
    let (outlines, invalid) = opml::import(&opml)?;
    let imported = with(&app, |s| {
        let known: Vec<String> = s.sources()?.into_iter().map(|s| s.url).collect();
        let (mut added, mut existing) = (0, 0);
        for outline in &outlines {
            if known.contains(&outline.url) {
                existing += 1;
                continue;
            }
            let (source, _) = s.add_source(&outline.url, outline.kind, outline.title.as_deref(), now())?;
            if outline.muted {
                s.set_muted(source.id, true)?;
            }
            s.log(&Event { at: now_ms(), kind: "subscribe".into(), source_id: Some(source.id), data: Some(json!({ "kind": outline.kind, "via": "opml" })), ..Default::default() })?;
            added += 1;
        }
        Ok(Imported { added, existing, invalid })
    })?;
    wake(&app);
    changed(&app);
    Ok(imported)
}

/// Writes to the path the save dialog chose. Returns how many were written.
#[tauri::command]
pub fn feed_opml_export(app: AppHandle, path: String) -> Result<usize> {
    let path = PathBuf::from(path);
    if !path.is_absolute() || !path.extension().is_some_and(|e| e == "opml" || e == "xml") {
        return Err("choose a .opml file to export to".into());
    }
    #[cfg(feature = "headless")]
    crate::headless::scratch_file(&path)?;
    let sources = with(&app, |s| s.sources())?;
    let created = chrono::Utc::now().to_rfc2822();
    vault::write_atomic(&path, &opml::export(&sources, &created))?;
    Ok(sources.len())
}

// ── Commands: items and actions ────────────────────────────────────────────

#[tauri::command]
pub fn feed_items(app: AppHandle, offset: Option<i64>, limit: Option<i64>, source: Option<i64>) -> Result<Page> {
    with(&app, |s| s.items(offset.unwrap_or(0).max(0), limit.unwrap_or(40).clamp(1, 100), source))
}

/// Where an action or impression happened: the list ("newest", or KI-32's
/// "picked") and the item's position in it.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub surface: Option<String>,
    pub position: Option<i64>,
}

fn surface(place: &Place) -> Option<String> {
    place.surface.clone().filter(|s| matches!(s.as_str(), "newest" | "picked" | "source"))
}

fn event(kind: &str, item: &Item, place: &Place) -> Event {
    Event {
        at: now_ms(),
        kind: kind.into(),
        item_id: Some(item.id),
        source_id: Some(item.source_id),
        surface: surface(place),
        position: place.position.filter(|p| *p >= 0),
        data: None,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reading {
    pub item: Item,
    pub text: Option<String>,
}

/// Opening an item in the app to read it, logged as an `open`. An excerpt
/// is replaced by the full article, fetched once through the ingest engine;
/// if that fails, the feed's own text is what there is.
#[tauri::command]
pub async fn feed_read(app: AppHandle, id: i64, place: Option<Place>) -> Result<Reading> {
    let place = place.unwrap_or_default();
    let item = with(&app, |s| {
        let item = s.item(id)?;
        s.log(&event("open", &item, &place))?;
        Ok(item)
    })?;
    let _ = full_text(&app, &item).await;
    with(&app, |s| Ok(Reading { text: source_text(s.content(id)?), item: s.item(id)? }))
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    Like,
    Unlike,
    NotInterested,
    UndoNotInterested,
    /// Opening the original page outside the app.
    OpenOriginal,
    /// Opening Kin's chat with the item attached (the webview does that).
    Discuss,
}

#[tauri::command]
pub fn feed_act(app: AppHandle, id: i64, action: Action, place: Option<Place>) -> Result<Item> {
    let place = place.unwrap_or_default();
    let item = with(&app, |s| {
        let before = s.item(id)?;
        let (kind, item) = match action {
            Action::Like => ("like", s.set_liked(id, true, now())?),
            Action::Unlike => ("unlike", s.set_liked(id, false, now())?),
            Action::NotInterested => ("not_interested", s.set_dismissed(id, true, now())?),
            Action::UndoNotInterested => ("undo_not_interested", s.set_dismissed(id, false, now())?),
            Action::OpenOriginal => ("open_original", before.clone()),
            Action::Discuss => ("discuss", before.clone()),
        };
        s.log(&event(kind, &before, &place))?;
        Ok(item)
    })?;
    if matches!(action, Action::NotInterested | Action::UndoNotInterested) {
        changed(&app);
    }
    Ok(item)
}

/// A note stays on the item, and travels with it into Inspiration if saved.
/// The log records that a note was written, not its words.
#[tauri::command]
pub fn feed_note(app: AppHandle, id: i64, note: String, place: Option<Place>) -> Result<Item> {
    if note.len() > 20_000 {
        return Err("that note is too long for a feed item".into());
    }
    let place = place.unwrap_or_default();
    with(&app, |s| {
        let before = s.item(id)?;
        if before.saved_path.is_some() {
            return Err("this item is saved; edit its note in Inspiration".into());
        }
        let item = s.set_note(id, &note, now())?;
        if item.note != before.note {
            let mut logged = event(if item.note.is_some() { "note" } else { "note_cleared" }, &before, &place);
            logged.data = Some(json!({ "chars": item.note.as_deref().map_or(0, |n| n.chars().count()) }));
            s.log(&logged)?;
        }
        Ok(item)
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Impression {
    pub id: i64,
    pub position: i64,
    pub surface: String,
}

/// Every impression, with its position, for ranking to learn from.
#[tauri::command]
pub fn feed_impressions(app: AppHandle, impressions: Vec<Impression>) -> Result<()> {
    if impressions.len() > 500 {
        return Err("too many impressions at once".into());
    }
    let at = now_ms();
    with(&app, |s| {
        let events: Vec<Event> = impressions
            .iter()
            .filter_map(|i| {
                let item = s.item(i.id).ok()?;
                let mut logged = event("impression", &item, &Place { surface: Some(i.surface.clone()), position: Some(i.position) });
                logged.at = at;
                Some(logged)
            })
            .collect();
        s.log_all(&events)
    })
}

/// Saves an item into Inspiration through the shared clip capture path
/// (`via: feed`). Retrying reuses one capture ID, so a save is never doubled.
/// It never waits on the network: the clip gets the best text already here
/// (the full article if it was read), and enrichment fetches the rest.
#[tauri::command]
pub fn feed_save(app: AppHandle, id: i64, place: Option<Place>) -> Result<Item> {
    let place = place.unwrap_or_default();
    let (item, save_id, content) = with(&app, |s| Ok((s.item(id)?, s.save_id(id)?, s.content(id)?)))?;
    if item.saved_path.is_some() {
        return Ok(item);
    }
    let root = crate::vault::current(&app)?;
    let capture = crate::clip_capture::Capture {
        id: Some(save_id),
        clip: vault::ClipCapture {
            url: item.url.clone(),
            // Without a link, the item's own words are what's worth keeping.
            text: if item.url.is_none() { item.summary.clone().or_else(|| item.title.clone()) } else { None },
            note: item.note.clone(),
            title: item.title.clone(),
            image: None,
            image_type: None,
            captured_at: chrono::Local::now().format("%Y-%m-%dT%H:%M").to_string(),
            via: vault::ClipVia::Feed,
        },
    };
    let created = crate::clip_capture::create(&root, &crate::clip_capture::index_path(&app)?, &capture).map_err(|e| e.to_string())?;
    if created.created {
        // What the feed already knows; enrichment fills in the rest.
        let update = vault::ClipUpdate {
            site: item.source_title.clone().filter(|s| !s.is_empty()),
            author: item.author.clone().filter(|a| !a.is_empty()),
            source: source_text(content),
            ..Default::default()
        };
        if update.site.is_some() || update.author.is_some() || update.source.is_some() {
            // Best effort: the clip is already safely captured.
            let _ = vault::clip_update(&root, &created.path, &update);
        }
        crate::vault::clips_changed(&app, &created.path);
    }
    with(&app, |s| {
        let saved = s.set_saved(id, &created.path)?;
        let mut logged = event("save", &item, &place);
        logged.data = Some(json!({ "path": created.path }));
        s.log(&logged)?;
        Ok(saved)
    })
}

#[cfg(test)]
mod tests;
