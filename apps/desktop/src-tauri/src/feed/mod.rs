//! The Feed (docs/vision.md › Feed): sources Hussain follows, polled into one
//! SQLite file in the app's data directory (never the vault), read newest
//! first. Saving an item is the only way from the Feed into Inspiration, and
//! goes through the same clip capture path as every other capture.
//!
//! Fetching belongs to the ingest engine (`kintsugi-ingest`, docs/ingest.md):
//! its feed adapter polls feeds, its X adapter X accounts, its web adapter
//! watches pages without a feed (and fetches an item's full article when the
//! feed only carries an excerpt), and its author adapter followed authors. This module decides what to
//! poll when, and keeps the store.

pub(crate) mod catalogue;
mod neighbours;
mod opml;
pub(crate) mod picked;
mod presets;
mod store;
mod stories;

pub use picked::kin_hook;
#[cfg(feature = "headless")]
pub(crate) use stories::STORY_SUMMARIZER;
pub(crate) use stories::wake as wake_summaries;

use crate::AppHandle;
use kintsugi_ingest::{
    self as ingest, CaptureOptions, Engine, Subscription, Target,
    authors::AuthorAdapter,
    catalogue::Catalogue,
    feed::{FeedAdapter, Podcast},
    web::WebAdapter,
    x::XAdapter,
};
use kintsugi_vault as vault;
use presets::{Subscribe, Youtube};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use store::{Coverage, Due, Entry, Event, Item, NewItem, Page, Source, SourceKind, Store, Story};
use tauri::{Emitter, Manager};
use tokio::sync::Notify;

type Result<T> = std::result::Result<T, String>;

const DB_FILE: &str = "feed.sqlite";
const CHANGED: &str = "feed:changed";
const TICK: Duration = Duration::from_secs(60);
const CONCURRENT_POLLS: usize = 4;
/// How often a healthy source is polled.
const INTERVAL: i64 = 30 * 60;
/// A watched page: often enough to notice an edit the same day, rarely
/// enough to stay a polite visitor.
const PAGE_INTERVAL: i64 = 6 * 60 * 60;
/// Authors publish a book or two a year; weekly is plenty.
const AUTHOR_INTERVAL: i64 = 7 * 24 * 60 * 60;
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
    /// Archive scans never delay a normal refresh or a subscription.
    cataloguing: tokio::sync::Mutex<()>,
    /// Reconsider outgoing links only when actions or readable text change.
    neighbours_dirty: AtomicBool,
    /// Picked for you's ranker (KI-32), derived from the event log.
    ranking: picked::Ranking,
    /// One clustering pass at a time (KI-94).
    clustering: Mutex<()>,
    /// Kin's story summaries, in the background (KI-94).
    summaries: stories::Summaries,
}

/// The engine (feed, X and author adapters for polling, the web adapter for
/// watched pages and full text) plus a handle on the feed adapter for its
/// discovery extras.
struct Ingest {
    engine: Engine,
    feeds: Arc<FeedAdapter>,
    /// Keep per-origin pacing across scans and explicit retries.
    catalogue: Catalogue,
}

impl Ingest {
    fn new(app: &AppHandle) -> Result<Self> {
        let feeds = Arc::new(FeedAdapter::new().map_err(|e| e.to_string())?);
        let web = WebAdapter::new().map_err(|e| e.to_string())?;
        // The same hidden-webview JavaScript fallback clip enrichment uses.
        #[cfg(not(feature = "headless"))]
        let web = web.with_renderer(Arc::new(crate::enrich::render::WebviewRenderer::new(
            app.clone(),
        )));
        #[cfg(feature = "headless")]
        let _ = app;
        let x = XAdapter::new().map_err(|e| e.to_string())?;
        let books = author_adapter().map_err(|e| e.to_string())?;
        Ok(Self {
            engine: Engine::new()
                .with(x)
                .with(feeds.clone())
                .with(books)
                .with(web),
            feeds,
            catalogue: Catalogue::new().map_err(|e| e.to_string())?,
        })
    }
}

/// Google Books and Open Library, or in a headless run, a loopback stand-in
/// for both (`KINTSUGI_HEADLESS_BOOKS=http://127.0.0.1:<port>/`), so tests
/// never reach the live APIs.
fn author_adapter() -> ingest::Result<AuthorAdapter> {
    #[cfg(feature = "headless")]
    if let Some(base) = std::env::var("KINTSUGI_HEADLESS_BOOKS")
        .ok()
        .and_then(|b| ingest::Url::parse(&b).ok())
        .filter(|u| u.scheme() == "http" && u.host_str() == Some("127.0.0.1"))
    {
        return AuthorAdapter::with_endpoints(
            ingest::authors::AuthorEndpoints::at(base),
            ingest::api::ApiLimits::default(),
        );
    }
    AuthorAdapter::new()
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
            return Ok(std::env::temp_dir()
                .join("kintsugi-isolated-dev")
                .join(DB_FILE));
        }
        Ok(app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join(DB_FILE))
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
    let store = feed
        .store(app)?
        .lock()
        .map_err(|_| "the feed database is unavailable".to_string())?;
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
    let (content, tried) = with(app, |s| {
        Ok((s.content(item.id)?, s.full_text_tried(item.id)?))
    })?;
    let short = content
        .as_deref()
        .is_none_or(|c| c.chars().count() < EXCERPT_CHARS);
    // A page change's text is the change, and a book's is its listing: the
    // page behind either link isn't "the rest of the article".
    let article = item.media == "article"
        && (item.back_catalogue
            || !matches!(item.source_kind, SourceKind::Page | SourceKind::Author));
    let Some(url) = item.url.as_deref().filter(|_| short && !tried && article) else {
        return Ok(());
    };
    let Ok(target) = Target::url(url) else {
        return Ok(());
    };
    let fetched = feed
        .ingest(app)?
        .engine
        .capture(&target, CaptureOptions::default())
        .await
        .ok();
    if item.back_catalogue
        && let Some(page) = fetched.as_ref()
    {
        let published = page
            .published
            .as_ref()
            .and_then(|date| chrono::DateTime::parse_from_rfc3339(date).ok())
            .map(|date| date.timestamp());
        with(app, |s| {
            s.set_catalogue_metadata(
                item.id,
                page.title.as_deref(),
                page.author.as_deref(),
                published,
            )
        })?;
    }
    let longer = fetched
        .map(|page| page.body)
        .filter(|body| body.chars().count() > content.as_deref().map_or(0, |c| c.chars().count()));
    with(app, |s| {
        s.set_full_text(item.id, longer.as_deref(), now())?;
        // The whole article may read differently from its excerpt.
        if longer.is_some() {
            s.classify_source(item.source_id, now())?;
        }
        Ok(())
    })?;
    if longer.is_some() {
        catalogue::mark_neighbours(app);
    }
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
        let ids: std::collections::HashSet<String> =
            live.iter().map(|(id, _)| search_id(*id)).collect();
        let gone = indexed
            .keys()
            .filter(|id| !ids.contains(*id))
            .cloned()
            .collect();
        let mut docs = Vec::new();
        for (id, stamp) in live {
            let key = search_id(id);
            if indexed.get(&key) == Some(&stamp) {
                continue;
            }
            let Some([title, source, author, summary, content]) = s.search_text(id)? else {
                continue;
            };
            let body = [summary, content]
                .into_iter()
                .flatten()
                .filter(|t| !t.trim().is_empty())
                .collect::<Vec<_>>()
                .join("\n\n");
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

/// For Ideas (KI-39): Feed items Hussain liked, noted or saved, newest
/// action first.
pub(crate) fn acted_on(app: &AppHandle, limit: usize) -> Result<Vec<store::Acted>> {
    with(app, |s| s.acted_on(limit))
}

/// A Feed item as a quote's source: title, source, link and searchable text.
pub(crate) struct Quotable {
    pub title: String,
    pub source: String,
    pub url: Option<String>,
    pub text: String,
}

/// For Ideas (KI-39): a Feed item's text, so a quote from it can be checked.
pub(crate) fn quotable(app: &AppHandle, id: i64) -> Result<Option<Quotable>> {
    with(app, |s| {
        let Some([title, source, author, summary, content]) = s.search_text(id)? else {
            return Ok(None);
        };
        let url = s.item(id).ok().and_then(|i| i.url);
        let text = [title.clone(), summary, content]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join("\n\n");
        Ok(Some(Quotable {
            title: title.unwrap_or_default(),
            source: source.or(author).unwrap_or_default(),
            url,
            text,
        }))
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
fn interval(kind: SourceKind) -> i64 {
    match kind {
        SourceKind::Page => PAGE_INTERVAL,
        SourceKind::Author => AUTHOR_INTERVAL,
        _ => INTERVAL,
    }
}

fn retry_after(kind: SourceKind, failures: i64) -> i64 {
    let cap = if matches!(kind, SourceKind::Youtube | SourceKind::X) {
        60 * 60
    } else {
        24 * 60 * 60
    };
    (FIRST_RETRY << (failures.clamp(1, 16) - 1)).min(cap)
}

/// What the source health line says about a failure.
fn describe(kind: SourceKind, error: ingest::Error) -> String {
    match (kind, error) {
        (SourceKind::Youtube, ingest::Error::Status(status)) => {
            format!("YouTube answered {status}; it does that sometimes, so Kintsugi keeps trying")
        }
        (_, ingest::Error::Status(404)) => "not found (HTTP 404)".into(),
        (_, ingest::Error::Status(410)) => "the site says this feed is gone (HTTP 410)".into(),
        (_, ingest::Error::Status(status)) => format!("HTTP {status}"),
        (SourceKind::X, ingest::Error::Unavailable) => {
            "FxTwitter didn't answer; the account may be private or gone".into()
        }
        (SourceKind::Author, ingest::Error::Unavailable) => {
            "Google Books and Open Library didn't answer".into()
        }
        (SourceKind::Page, ingest::Error::Unsupported) => {
            "not a web page Kintsugi can watch (an image or a file?)".into()
        }
        (SourceKind::Page, ingest::Error::Unavailable) => {
            "couldn't read any text on that page".into()
        }
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
        Some("book") => "book",
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
        published_at: item
            .published
            .and_then(|p| chrono::DateTime::parse_from_rfc3339(&p).ok())
            .map(|d| d.timestamp()),
    }
}

/// Poll one source through the engine, record its health, store new entries.
async fn poll(store: &Mutex<Store>, engine: &Engine, due: &Due) -> Polled {
    let subscription = Subscription {
        url: due.url.clone(),
        cursor: due.cursor.clone(),
    };
    let source = match due.kind {
        SourceKind::X => ingest::SourceType::X,
        SourceKind::Page => ingest::SourceType::Web,
        SourceKind::Author => ingest::SourceType::Author,
        _ => ingest::SourceType::Rss,
    };
    let outcome = engine.poll(source, &subscription).await;
    let result: Result<usize> = (|| {
        let store = store
            .lock()
            .map_err(|_| "the feed database is unavailable".to_string())?;
        let now = now();
        match outcome {
            Ok(polled) => {
                let mut entries: Vec<NewItem> = polled.items.into_iter().map(new_item).collect();
                if due.kind == SourceKind::Author && !due.first {
                    // A title the author's catalogue only now lists is news
                    // even if its date is older than the feed's 30 days (the
                    // author adapter never returns one twice).
                    for entry in &mut entries {
                        entry.published_at =
                            entry.published_at.filter(|p| now - p < store::EXPIRE_AFTER);
                    }
                }
                let added = store.insert_items(due.id, &entries, now, due.first)?;
                store.record_success(
                    due.id,
                    now,
                    polled.cursor.as_deref(),
                    polled.source.as_ref(),
                    now + interval(due.kind),
                )?;
                // News or writing (KI-105), with its title and new items.
                if added > 0 || due.first {
                    store.classify_source(due.id, now)?;
                }
                Ok(added)
            }
            Err(error) => {
                let message = describe(due.kind, error);
                let status = match error {
                    ingest::Error::Status(status) => Some(status),
                    _ => None,
                };
                store.record_failure(
                    due.id,
                    now,
                    status,
                    &message,
                    now + retry_after(due.kind, due.failures + 1),
                )?;
                Err(message)
            }
        }
    })();
    match result {
        Ok(added) => Polled {
            source_id: due.id,
            added,
            error: None,
        },
        Err(error) => Polled {
            source_id: due.id,
            added: 0,
            error: Some(error),
        },
    }
}

/// Polls every due source (or all of them), then expires ignored items.
async fn poll_due(app: &AppHandle, all: bool, only: Option<i64>) -> Result<Vec<Polled>> {
    use futures_util::StreamExt;
    let feed = app.state::<Feed>();
    let _pass = feed.polling.lock().await;
    let store = feed.store(app)?;
    let due = {
        let store = store
            .lock()
            .map_err(|_| "the feed database is unavailable".to_string())?;
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
    let expired = store
        .lock()
        .map_err(|_| "the feed database is unavailable".to_string())?
        .expire(now())?;
    if !polled.is_empty() || expired > 0 {
        changed(app);
    }
    if polled.iter().any(|p| p.added > 0) {
        // New items join stories (and stories get summaries) off this path.
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            if picked::refresh(&app).is_ok() {
                changed(&app);
            }
        });
    }
    Ok(polled)
}

/// One background task polls due sources every minute, or when woken by a
/// subscribe, import or unmute.
pub fn start(app: &AppHandle) {
    app.state::<Feed>()
        .neighbours_dirty
        .store(true, Ordering::Relaxed);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let _ = poll_due(&app, false, None).await;
            catalogue::start(&app);
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
        Err(ingest::Error::NotAFeed) => Err("No feed there. Try the site's RSS or Atom link, or follow it as a Page to hear when it changes.".into()),
        Err(_) => Ok(url.to_string()),
    }
}

async fn resolve(
    feeds: &FeedAdapter,
    input: Subscribe,
) -> Result<(String, SourceKind, Option<String>)> {
    Ok(match input {
        Subscribe::Url { url } if presets::x_link(&url).is_some() => (
            presets::x_link(&url).unwrap_or_default(),
            SourceKind::X,
            None,
        ),
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
                let id = feeds.youtube_channel(&page).await.map_err(|_| {
                    "Couldn't read that channel's ID from YouTube; try its /channel/UC… URL"
                        .to_string()
                })?;
                (presets::youtube_feed(&id), SourceKind::Youtube, None)
            }
        },
        Subscribe::Podcast { feed_url, title } => (
            presets::checked_url(&feed_url)?.to_string(),
            SourceKind::Podcast,
            title,
        ),
        Subscribe::X { account } => (presets::x_account(&account)?, SourceKind::X, None),
        Subscribe::Page { url } => (
            presets::checked_url(&url)?.to_string(),
            SourceKind::Page,
            None,
        ),
        Subscribe::Author { name } => {
            let url = presets::author(&name)?;
            let name = ingest::authors::author_name(&url);
            (url, SourceKind::Author, name)
        }
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
        s.log(&Event {
            at: now_ms(),
            kind: "subscribe".into(),
            source_id: Some(source.id),
            data: Some(json!({ "kind": kind })),
            ..Default::default()
        })?;
        Ok(source)
    })?;
    let polled = poll_due(&app, true, Some(source.id)).await?;
    let first = polled.into_iter().next();
    catalogue::start(&app);
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
        s.log(&Event {
            at: now_ms(),
            kind: "unsubscribe".into(),
            source_id: Some(id),
            ..Default::default()
        })
    })?;
    changed(&app);
    Ok(())
}

#[tauri::command]
pub fn feed_mute(app: AppHandle, id: i64, muted: bool) -> Result<Source> {
    let source = with(&app, |s| {
        let source = s.set_muted(id, muted)?;
        s.log(&Event {
            at: now_ms(),
            kind: if muted { "mute" } else { "unmute" }.into(),
            source_id: Some(id),
            ..Default::default()
        })?;
        Ok(source)
    })?;
    if !muted {
        wake(&app);
    }
    changed(&app);
    Ok(source)
}

/// "Group with other coverage" (KI-105): off takes the source's items out
/// of their stories at once; on lets clustering place them again.
#[tauri::command]
pub fn feed_grouping(app: AppHandle, id: i64, enabled: bool) -> Result<Source> {
    let source = with(&app, |s| s.set_grouping(id, enabled, now()))?;
    changed(&app);
    if enabled {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            if picked::refresh(&app).is_ok() {
                changed(&app);
            }
        });
    }
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
    feeds
        .search_podcasts(&term)
        .await
        .map_err(|e| format!("Podcast search didn't answer ({e})"))
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
            let (source, _) =
                s.add_source(&outline.url, outline.kind, outline.title.as_deref(), now())?;
            if outline.muted {
                s.set_muted(source.id, true)?;
            }
            s.log(&Event {
                at: now_ms(),
                kind: "subscribe".into(),
                source_id: Some(source.id),
                data: Some(json!({ "kind": outline.kind, "via": "opml" })),
                ..Default::default()
            })?;
            added += 1;
        }
        Ok(Imported {
            added,
            existing,
            invalid,
        })
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
pub fn feed_items(
    app: AppHandle,
    offset: Option<i64>,
    limit: Option<i64>,
    source: Option<i64>,
) -> Result<Page> {
    // A ranking failure must never prevent reading items already here.
    let _ = picked::prepare_catalogue(&app);
    with(&app, |s| {
        s.items(
            offset.unwrap_or(0).max(0),
            limit.unwrap_or(40).clamp(1, 100),
            source,
        )
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entries {
    pub entries: Vec<Entry>,
    pub total: usize,
}

/// The Newest list with each story (items about the same thing from two or
/// more sources) folded into one entry at its newest item. New items are
/// placed into stories first.
#[tauri::command]
pub fn feed_entries(
    app: AppHandle,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<Entries> {
    // The same daily release of older writing as `feed_items` (KI-95).
    let _ = picked::prepare_catalogue(&app);
    stories::cluster_waiting(&app)?;
    let (entries, total) = with(&app, |s| {
        s.entries(offset.unwrap_or(0), limit.unwrap_or(40).clamp(1, 100))
    })?;
    stories::summarize_if_due(
        &app,
        entries.iter().filter_map(|e| match e {
            Entry::Story { story } => Some(&story.summary_state),
            Entry::Item { .. } => None,
        }),
    );
    Ok(Entries { entries, total })
}

/// One story with its items and Kin's summary (or why there isn't one).
#[tauri::command]
pub fn feed_story(app: AppHandle, id: i64) -> Result<Story> {
    let story = with(&app, |s| s.story(id))?;
    stories::summarize_if_due(&app, [&story.summary_state]);
    Ok(story)
}

/// Not interested (or its undo) for several items at once: a whole story.
#[tauri::command]
pub fn feed_dismiss_many(
    app: AppHandle,
    ids: Vec<i64>,
    undo: Option<bool>,
    place: Option<Place>,
) -> Result<Vec<Item>> {
    if ids.len() > 200 {
        return Err("too many items at once".into());
    }
    let undo = undo.unwrap_or(false);
    let place = place.unwrap_or_default();
    let items = with(&app, |s| {
        let mut out = Vec::new();
        for id in ids {
            let before = s.item(id)?;
            if before.dismissed != undo {
                continue;
            }
            out.push(s.set_dismissed(id, !undo, now())?);
            let kind = if undo {
                "undo_not_interested"
            } else {
                "not_interested"
            };
            s.log(&event(kind, &before, &place))?;
        }
        Ok(out)
    })?;
    changed(&app);
    Ok(items)
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
    place
        .surface
        .clone()
        .filter(|s| matches!(s.as_str(), "newest" | "picked" | "source"))
}

/// An event on an item. One in a story carries `data.story`, so ranking
/// can learn per story (KI-94).
fn event(kind: &str, item: &Item, place: &Place) -> Event {
    Event {
        at: now_ms(),
        kind: kind.into(),
        item_id: Some(item.id),
        source_id: Some(item.source_id),
        surface: surface(place),
        position: place.position.filter(|p| *p >= 0),
        data: item.story_id.map(|story| json!({ "story": story })),
    }
}

/// `data` for an event, keeping its `story`.
fn with_data(mut event: Event, data: serde_json::Value) -> Event {
    let mut merged = event.data.take().unwrap_or_else(|| json!({}));
    if let (Some(into), Some(from)) = (merged.as_object_mut(), data.as_object()) {
        into.extend(from.clone());
    }
    event.data = Some(merged);
    event
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reading {
    pub item: Item,
    pub text: Option<String>,
    /// For writing (KI-105): news about the same thing, as links.
    pub coverage: Vec<Coverage>,
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
    with(&app, |s| {
        let item = s.item(id)?;
        Ok(Reading {
            text: source_text(s.content(id)?),
            coverage: if item.story_id.is_none() {
                s.coverage(id)?
            } else {
                Vec::new()
            },
            item,
        })
    })
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
            Action::UndoNotInterested => {
                ("undo_not_interested", s.set_dismissed(id, false, now())?)
            }
            Action::OpenOriginal => ("open_original", before.clone()),
            Action::Discuss => ("discuss", before.clone()),
        };
        s.log(&event(kind, &before, &place))?;
        Ok(item)
    })?;
    if matches!(
        action,
        Action::Like | Action::Unlike | Action::NotInterested | Action::UndoNotInterested
    ) {
        catalogue::mark_neighbours(&app);
    }
    if matches!(action, Action::NotInterested | Action::UndoNotInterested) {
        changed(&app);
    }
    Ok(item)
}

/// A note stays on the item, and travels with it into Inspiration if saved.
/// The log records that a note was written, not its words.
#[tauri::command]
pub fn feed_note(app: AppHandle, id: i64, note: String, place: Option<Place>) -> Result<Item> {
    match note_checked(&app, id, &note, None, place.unwrap_or_default())? {
        NoteWrite::Saved(item) | NoteWrite::Conflict(item) => Ok(item),
    }
}

/// A note written somewhere else first (the phone, offline), checked
/// against the note it started from.
pub enum NoteWrite {
    Saved(Item),
    /// The note changed since `base`; nothing was written.
    Conflict(Item),
}

/// The version of an item's note, as `kintsugi_vault::version` (no note is "").
pub fn note_version(item: &Item) -> String {
    vault::version(item.note.as_deref().unwrap_or(""))
}

/// Writes the note if it is still at `base` (`None`: overwrite on purpose),
/// under the store's lock. Since phone API 6.
pub fn note_checked(
    app: &AppHandle,
    id: i64,
    note: &str,
    base: Option<&str>,
    place: Place,
) -> Result<NoteWrite> {
    if note.len() > 20_000 {
        return Err("that note is too long for a feed item".into());
    }
    let result = with(app, |s| {
        let before = s.item(id)?;
        if base.is_some_and(|b| b != note_version(&before)) {
            // Already what the phone wanted: no conflict to show.
            if before.note.as_deref().unwrap_or("").trim() == note.trim() {
                return Ok(NoteWrite::Saved(before));
            }
            return Ok(NoteWrite::Conflict(before));
        }
        if before.saved_path.is_some() {
            return Err("this item is saved; edit its note in Inspiration".into());
        }
        let item = s.set_note(id, note, now())?;
        if item.note != before.note {
            let logged = event(
                if item.note.is_some() {
                    "note"
                } else {
                    "note_cleared"
                },
                &before,
                &place,
            );
            let chars = item.note.as_deref().map_or(0, |n| n.chars().count());
            s.log(&with_data(logged, json!({ "chars": chars })))?;
        }
        Ok(NoteWrite::Saved(item))
    })?;
    catalogue::mark_neighbours(app);
    Ok(result)
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
                let mut logged = event(
                    "impression",
                    &item,
                    &Place {
                        surface: Some(i.surface.clone()),
                        position: Some(i.position),
                    },
                );
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
    let (item, save_id, content) =
        with(&app, |s| Ok((s.item(id)?, s.save_id(id)?, s.content(id)?)))?;
    if item.saved_path.is_some() {
        return Ok(item);
    }
    let root = crate::vault::current(&app)?;
    let capture = crate::clip_capture::Capture {
        id: Some(save_id),
        clip: vault::ClipCapture {
            url: item.url.clone(),
            // Without a link, the item's own words are what's worth keeping.
            text: if item.url.is_none() {
                item.summary.clone().or_else(|| item.title.clone())
            } else {
                None
            },
            note: item.note.clone(),
            title: item.title.clone(),
            image: None,
            image_type: None,
            file: None,
            captured_at: chrono::Local::now().format("%Y-%m-%dT%H:%M").to_string(),
            via: vault::ClipVia::Feed,
        },
    };
    let created =
        crate::clip_capture::create(&root, &crate::clip_capture::index_path(&app)?, &capture)
            .map_err(|e| e.to_string())?;
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
    let saved = with(&app, |s| {
        let saved = s.set_saved(id, &created.path)?;
        let logged = event("save", &item, &place);
        s.log(&with_data(logged, json!({ "path": created.path })))?;
        Ok(saved)
    })?;
    catalogue::mark_neighbours(&app);
    Ok(saved)
}

/// A small sample Feed for driving the phone in the Simulator against a
/// scratch vault (`phone_dev_server`): two news sites and a personal blog, seven items with
/// their whole text, so reading never fetches anything. Links point at
/// `base` (the dev server itself), never the web. Headless builds only.
#[cfg(all(test, feature = "headless"))]
pub(crate) fn seed_sample(app: &AppHandle, base: &str) -> Result<usize> {
    const REPAIR: &str = "Mending Workshop's 2026 study follows 240 repaired bowls across three workshops, comparing the visible repair methods used, the cost of labour and materials, how often a repair failed over the following year and whether owners kept using the bowls after the first repair; the kintsugi study also separates material costs from workshop time, so the repair prices can be compared without treating a photograph as evidence that the method worked.";
    const RSS: &str = "RSS Reader 2 adds an offline reading queue and full-text search for personal websites. The new RSS Reader stores articles on the device, keeps reading position between sessions and lets readers export their subscriptions. The release keeps the existing feed format and has no recommendation algorithm.";
    const ESSAY: &str = "I spent a year keeping a ledger of every bowl I mended, and the numbers changed how I price my own work.\n\n## What I counted\n\nThe study counted 240 bowls. I counted 31, and mine are messier:\n\n- the hours each repair took\n- the lacquer, by the gram\n- the second coat nobody sees\n\n> A repair you can't see is a repair nobody pays for.\n\n![A cracked bowl on the workbench](https://picsum.photos/id/1080/800/500 \"The bowl that started the ledger.\")\n\nThe formula I use now is one line:\n\n```\n=SUM(materials) + hours * rate\n```\n\nRead [the workshop's own report](https://example.com/report) for their numbers.";
    // Two news sites (several reporters each) that cover the same two
    // stories, and a personal blog whose essay shares a name with one of
    // them but always stands alone (KI-105).
    let sources: [(&str, &[&str], &[(&str, &str)]); 3] = [
        (
            "Workshop Wire",
            &["Ana Ruiz", "Tom Okafor", "Lena Fischer"],
            &[
                (
                    "Mending Workshop 2026 measures the cost of visible repair",
                    REPAIR,
                ),
                (
                    "RSS Reader 2 brings offline reading to personal websites",
                    RSS,
                ),
                (
                    "Attention is the scarce material",
                    "Publishers say readers spend less time per article than a year ago.",
                ),
            ][..],
        ),
        (
            "Night Shift",
            &["Dr. Lee", "Sam Ode", "Priya Raman"],
            &[
                (
                    "Mending Workshop 2026 reports a year of repair results",
                    REPAIR,
                ),
                (
                    "RSS Reader 2 adds full-text search and an offline queue",
                    RSS,
                ),
            ][..],
        ),
        (
            "Mara Ito",
            &["Mara Ito"],
            &[
                (
                    "What Mending Workshop 2026 taught me about my own prices",
                    ESSAY,
                ),
                (
                    "The workbench diary",
                    "I keep notes from a year of fixing things instead of replacing them. My rule: if I fix it twice, I write it down.",
                ),
            ][..],
        ),
    ];
    let now = now();
    let mut added = 0;
    with(app, |s| {
        for (n, (title, authors, items)) in sources.iter().enumerate() {
            let (source, _) = s.add_source(
                &format!("{base}/sample/feed-{n}.xml"),
                SourceKind::Feed,
                Some(title),
                now,
            )?;
            let entries: Vec<NewItem> = items
                .iter()
                .enumerate()
                .map(|(i, (title, text))| NewItem {
                    guid: format!("sample-{n}-{i}"),
                    url: Some(format!("{base}/sample/{n}/{i}")),
                    title: Some((*title).into()),
                    author: Some(authors[i % authors.len()].into()),
                    summary: text.split("\n\n").next().map(Into::into),
                    content: Some(if text.contains('\n') {
                        (*text).to_string()
                    } else {
                        format!("{text}\n\n{}", format!("{text} ").repeat(5))
                    }),
                    image: None,
                    media: "article",
                    published_at: Some(now - (n as i64 * 3 + i as i64) * 3_600),
                })
                .collect();
            added += s.insert_items(source.id, &entries, now, true)?;
            s.classify_source(source.id, now)?;
        }
        Ok(())
    })?;
    changed(app);
    Ok(added)
}

#[cfg(test)]
mod tests;
