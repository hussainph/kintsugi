//! The Feed's one SQLite file in app data (never the vault): sources, items
//! and an append-only event log of every impression and action, so ranking
//! (KI-32) can learn online and be evaluated offline from the same history.

use kintsugi_ingest::SourceInfo;
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Serialize;
use serde_json::Value;
use std::path::Path;

type Result<T> = std::result::Result<T, String>;

/// Ignored items (no like, note, save or Not interested) drop out after this.
pub const EXPIRE_AFTER: i64 = 30 * 24 * 60 * 60;
/// Non-article sources keep a few older entries on their first fetch.
/// Article sources instead admit older work through the catalogue quota.
const FIRST_FETCH_KEEP: usize = 3;
/// One poll never floods the feed with a podcast's whole back catalogue.
pub const MAX_ENTRIES_PER_POLL: usize = 100;

const SCHEMA: &str = "
CREATE TABLE sources (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  title TEXT,
  site_url TEXT,
  image TEXT,
  muted INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER NOT NULL,
  removed_at INTEGER,
  last_fetch_at INTEGER,
  last_success_at INTEGER,
  last_status INTEGER,
  last_error TEXT,
  failures INTEGER NOT NULL DEFAULT 0,
  next_fetch_at INTEGER NOT NULL DEFAULT 0,
  -- The ingest adapter's opaque poll cursor (ETag / Last-Modified, the newest
  -- X status, a watched page's hash and lines, an author's seen titles).
  cursor TEXT
);
-- No cascade: unsubscribing keeps the items he acted on (ranking signals).
CREATE TABLE items (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  guid TEXT NOT NULL,
  url TEXT,
  title TEXT,
  author TEXT,
  summary TEXT,
  content TEXT,
  -- When full text was fetched through the ingest engine's web adapter.
  full_text_at INTEGER,
  image TEXT,
  media TEXT NOT NULL DEFAULT 'article',
  published_at INTEGER,
  fetched_at INTEGER NOT NULL,
  sort_at INTEGER NOT NULL,
  liked_at INTEGER,
  note TEXT,
  note_at INTEGER,
  save_id TEXT,
  saved_path TEXT,
  dismissed_at INTEGER,
  expired_at INTEGER,
  UNIQUE (source_id, guid)
);
CREATE INDEX items_newest ON items (sort_at DESC, id DESC);
-- Append-only: every impression (with its position) and every action.
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  item_id INTEGER,
  source_id INTEGER,
  surface TEXT,
  position INTEGER,
  data TEXT
);
CREATE INDEX events_item ON events (item_id);
CREATE TRIGGER events_no_update BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'the feed event log is append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events
  BEGIN SELECT RAISE(ABORT, 'the feed event log is append-only'); END;
";

/// Version 3 (KI-94, after KI-95's catalogue at 2): stories, items about the same thing from different
/// sources. Clustering keeps its decisions here so a story keeps its id
/// (and its summary) while sources join it.
const STORIES: &str = "
CREATE TABLE stories (
  id INTEGER PRIMARY KEY,
  -- Kin's title and summary (JSON: paragraphs of sentences with the item
  -- ids each one cites), once written.
  title TEXT,
  summary TEXT,
  -- pending, ready, failed, capped (the month's AI limit) or unavailable
  -- (no AI provider).
  summary_state TEXT NOT NULL DEFAULT 'pending',
  -- How many items it had when last summarised, and how many times it was.
  summary_items INTEGER NOT NULL DEFAULT 0,
  summary_attempts INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- An item is in at most one story.
ALTER TABLE items ADD COLUMN story_id INTEGER REFERENCES stories(id);
-- When clustering last placed the item (NULL: not yet).
ALTER TABLE items ADD COLUMN clustered_at INTEGER;
CREATE INDEX items_story ON items (story_id);
";
const VERSION: i64 = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceKind {
    Feed,
    Hn,
    Youtube,
    Podcast,
    /// An X account, polled through the ingest engine's X adapter.
    X,
    /// A page without a feed, watched for changes by the web adapter.
    Page,
    /// An author, polled for new books by the author adapter.
    Author,
}

impl SourceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Feed => "feed",
            Self::Hn => "hn",
            Self::Youtube => "youtube",
            Self::Podcast => "podcast",
            Self::X => "x",
            Self::Page => "page",
            Self::Author => "author",
        }
    }
    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "feed" => Self::Feed,
            "hn" => Self::Hn,
            "youtube" => Self::Youtube,
            "podcast" => Self::Podcast,
            "x" => Self::X,
            "page" => Self::Page,
            "author" => Self::Author,
            _ => return None,
        })
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: i64,
    pub url: String,
    pub kind: SourceKind,
    pub title: Option<String>,
    pub site_url: Option<String>,
    pub image: Option<String>,
    pub muted: bool,
    pub added_at: i64,
    pub last_fetch_at: Option<i64>,
    pub last_success_at: Option<i64>,
    pub last_status: Option<i64>,
    pub last_error: Option<String>,
    pub failures: i64,
    pub next_fetch_at: i64,
    /// Items from this source currently in the feed.
    pub items: i64,
    pub catalogue_enabled: bool,
    pub catalogue_state: String,
    pub catalogue_count: i64,
    pub catalogue_error: Option<String>,
}

/// What a poll needs to make a conditional request.
#[derive(Clone, Debug)]
pub struct Due {
    pub id: i64,
    pub url: String,
    pub kind: SourceKind,
    pub cursor: Option<String>,
    pub failures: i64,
    pub first: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct NewItem {
    pub guid: String,
    pub url: Option<String>,
    pub title: Option<String>,
    pub author: Option<String>,
    pub summary: Option<String>,
    pub content: Option<String>,
    pub image: Option<String>,
    pub media: &'static str,
    pub published_at: Option<i64>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: i64,
    pub source_id: i64,
    pub source_title: Option<String>,
    pub source_kind: SourceKind,
    pub url: Option<String>,
    pub title: Option<String>,
    pub author: Option<String>,
    pub summary: Option<String>,
    pub image: Option<String>,
    pub media: String,
    pub published_at: Option<i64>,
    pub fetched_at: i64,
    pub sort_at: i64,
    pub liked: bool,
    pub note: Option<String>,
    pub saved_path: Option<String>,
    pub dismissed: bool,
    pub has_content: bool,
    pub back_catalogue: bool,
    pub suggestion: Option<Suggestion>,
    /// The source's site (or feed) URL, for its icon.
    pub source_site: Option<String>,
    /// A Hacker News item's discussion page; its `url` is the page it links to.
    pub discussion: Option<String>,
    /// The cluster it is in (`kintsugi_rank::stories`). Shown as a story
    /// only when the cluster spans two sources, so the webview reads stories
    /// from `feed_entries` and `feed_story`, never from this.
    #[serde(skip)]
    pub story_id: Option<i64>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub reason: String,
    pub source_url: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub items: Vec<Item>,
    pub total: i64,
}

/// A Feed item Hussain acted on, for Ideas (KI-39).
#[derive(Clone, Debug, PartialEq)]
pub struct Acted {
    /// The search index's id, `feed:<id>`.
    pub id: String,
    pub title: String,
    pub source: String,
    pub liked: bool,
    pub saved: bool,
    pub note: Option<String>,
}

/// One row of the event log. `at` is milliseconds since the epoch.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub at: i64,
    pub kind: String,
    pub item_id: Option<i64>,
    pub source_id: Option<i64>,
    pub surface: Option<String>,
    pub position: Option<i64>,
    pub data: Option<Value>,
}

pub struct Store {
    db: Connection,
}

mod catalogue;
pub(super) mod mixing;
/// What ranking (KI-32, `feed::picked`) reads: every item and source, and
/// the event log from a cursor.
mod ranking;
/// Stories (KI-94): clustering's decisions, the Newest list with stories
/// folded in, and Kin's summaries.
mod stories;
pub use stories::{Entry, Outcome, Sentence, Story, Summary, SummaryJob, SummaryState};

const SOURCE_COLUMNS: &str = "s.id, s.url, s.kind, s.title, s.site_url, s.image, s.muted, s.added_at,
  s.last_fetch_at, s.last_success_at, s.last_status, s.last_error, s.failures, s.next_fetch_at,
  (SELECT COUNT(*) FROM items i WHERE i.source_id = s.id AND i.dismissed_at IS NULL AND i.expired_at IS NULL
     AND (i.back_catalogue = 0 OR (s.catalogue_enabled = 1 AND i.catalogue_released_at IS NOT NULL))),
  s.catalogue_enabled, s.catalogue_state,
  (SELECT COUNT(*) FROM items i WHERE i.source_id = s.id AND i.back_catalogue = 1), s.catalogue_error";

const ITEM_COLUMNS: &str =
    "i.id, i.source_id, s.title, s.kind, i.url, i.title, i.author, i.summary,
  i.image, i.media, i.published_at, i.fetched_at, i.sort_at, i.liked_at IS NOT NULL, i.note,
  i.saved_path, i.dismissed_at IS NOT NULL, i.content IS NOT NULL AND i.content <> '', i.back_catalogue,
  CASE WHEN s.suggested = 1 THEN i.suggestion_reason END,
  CASE WHEN s.suggested = 1 THEN s.url END,
  COALESCE(s.site_url, s.url),
  CASE WHEN s.kind = 'hn' AND i.guid LIKE 'rss:https://news.ycombinator.com/item?id=%' THEN substr(i.guid, 5) END,
  i.story_id";

/// In the feed: a live, unmuted source; not dismissed, not expired.
const VISIBLE: &str =
    "s.removed_at IS NULL AND s.muted = 0 AND i.dismissed_at IS NULL AND i.expired_at IS NULL
     AND ((i.back_catalogue = 0 AND s.suggested = 0)
       OR (i.back_catalogue = 1 AND s.catalogue_enabled = 1 AND i.catalogue_released_at IS NOT NULL))";

fn kind(row: &Row, index: usize) -> rusqlite::Result<SourceKind> {
    let text: String = row.get(index)?;
    SourceKind::parse(&text).ok_or_else(|| {
        rusqlite::Error::InvalidColumnType(index, "kind".into(), rusqlite::types::Type::Text)
    })
}

fn source_row(row: &Row) -> rusqlite::Result<Source> {
    Ok(Source {
        id: row.get(0)?,
        url: row.get(1)?,
        kind: kind(row, 2)?,
        title: row.get(3)?,
        site_url: row.get(4)?,
        image: row.get(5)?,
        muted: row.get(6)?,
        added_at: row.get(7)?,
        last_fetch_at: row.get(8)?,
        last_success_at: row.get(9)?,
        last_status: row.get(10)?,
        last_error: row.get(11)?,
        failures: row.get(12)?,
        next_fetch_at: row.get(13)?,
        items: row.get(14)?,
        catalogue_enabled: row.get(15)?,
        catalogue_state: row.get(16)?,
        catalogue_count: row.get(17)?,
        catalogue_error: row.get(18)?,
    })
}

fn item_row(row: &Row) -> rusqlite::Result<Item> {
    let suggestion = match row.get::<_, Option<String>>(19)? {
        Some(reason) => Some(Suggestion {
            reason,
            source_url: row.get(20)?,
        }),
        None => None,
    };
    Ok(Item {
        id: row.get(0)?,
        source_id: row.get(1)?,
        source_title: row.get(2)?,
        source_kind: kind(row, 3)?,
        url: row.get(4)?,
        title: row.get(5)?,
        author: row.get(6)?,
        summary: row.get(7)?,
        image: row.get(8)?,
        media: row.get(9)?,
        published_at: row.get(10)?,
        fetched_at: row.get(11)?,
        sort_at: row.get(12)?,
        liked: row.get(13)?,
        note: row.get(14)?,
        saved_path: row.get(15)?,
        dismissed: row.get(16)?,
        has_content: row.get(17)?,
        back_catalogue: row.get(18)?,
        suggestion,
        source_site: row.get(21)?,
        discussion: row.get(22)?,
        story_id: row.get(23)?,
    })
}

fn err(e: rusqlite::Error) -> String {
    format!("feed database: {e}")
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        Self::init(Connection::open(path).map_err(err)?)
    }

    #[cfg(test)]
    pub fn memory() -> Self {
        Self::init(Connection::open_in_memory().unwrap()).unwrap()
    }

    fn init(db: Connection) -> Result<Self> {
        db.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(err)?;
        db.pragma_update(None, "journal_mode", "WAL").map_err(err)?;
        db.pragma_update(None, "foreign_keys", true).map_err(err)?;
        let version: i64 = db
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .map_err(err)?;
        if version > VERSION {
            return Err("the feed database was written by a newer Kintsugi".into());
        }
        if version == 0 {
            db.execute_batch(&format!("BEGIN; {SCHEMA} PRAGMA user_version = 1; COMMIT;"))
                .map_err(err)?;
        }
        // Version 2 is KI-95's catalogue; version 3, stories, builds on it.
        if version < 2 {
            catalogue::migrate(&db)?;
        }
        if version < 3 {
            db.execute_batch(&format!(
                "BEGIN; {STORIES} PRAGMA user_version = 3; COMMIT;"
            ))
            .map_err(err)?;
        }
        // A process stopped mid-discovery must be able to claim the source again.
        db.execute(
            "UPDATE sources SET catalogue_state = 'queued' WHERE catalogue_state = 'discovering'",
            [],
        )
        .map_err(err)?;
        Ok(Self { db })
    }

    // ── Sources ────────────────────────────────────────────────────────────

    /// Subscribing to a URL already followed (or unsubscribed earlier)
    /// revives that source rather than duplicating it.
    pub fn add_source(
        &self,
        url: &str,
        kind: SourceKind,
        title: Option<&str>,
        now: i64,
    ) -> Result<(Source, bool)> {
        let existing: Option<(i64, Option<i64>, bool)> = self
            .db
            .query_row(
                "SELECT id, removed_at, suggested FROM sources WHERE url = ?1",
                [url],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(err)?;
        let (id, added) = match existing {
            Some((id, removed, suggested)) => {
                self.db
                    .execute(
                        "UPDATE sources SET removed_at = NULL, muted = 0, next_fetch_at = 0,
                           catalogue_state = CASE WHEN suggested = 1 AND catalogue_enabled = 1 THEN 'queued' ELSE catalogue_state END,
                           suggested = 0, title = COALESCE(title, ?2) WHERE id = ?1",
                        params![id, title],
                    )
                    .map_err(err)?;
                (id, removed.is_some() || suggested)
            }
            None => {
                self.db
                    .execute(
                        "INSERT INTO sources (url, kind, title, added_at, catalogue_enabled, catalogue_state)
                         VALUES (?1, ?2, ?3, ?4, ?5, CASE WHEN ?5 THEN 'queued' ELSE 'disabled' END)",
                        params![url, kind.as_str(), title, now, catalogue::supported(kind)],
                    )
                    .map_err(err)?;
                (self.db.last_insert_rowid(), true)
            }
        };
        Ok((self.source(id)?, added))
    }

    pub fn source(&self, id: i64) -> Result<Source> {
        self.db
            .query_row(&format!("SELECT {SOURCE_COLUMNS} FROM sources s WHERE s.id = ?1 AND s.removed_at IS NULL AND s.suggested = 0"), [id], source_row)
            .optional()
            .map_err(err)?
            .ok_or_else(|| "no such source".into())
    }

    /// Alphabetical by title, falling back to the URL.
    pub fn sources(&self) -> Result<Vec<Source>> {
        let mut statement = self
            .db
            .prepare(&format!(
                "SELECT {SOURCE_COLUMNS} FROM sources s WHERE s.removed_at IS NULL AND s.suggested = 0
                 ORDER BY lower(COALESCE(s.title, s.url)), s.id"
            ))
            .map_err(err)?;
        statement
            .query_map([], source_row)
            .map_err(err)?
            .collect::<rusqlite::Result<_>>()
            .map_err(err)
    }

    pub fn remove_source(&self, id: i64, now: i64) -> Result<()> {
        let changed = self
            .db
            .execute(
                "UPDATE sources SET removed_at = ?2 WHERE id = ?1 AND removed_at IS NULL",
                params![id, now],
            )
            .map_err(err)?;
        if changed == 0 {
            return Err("no such source".into());
        }
        Ok(())
    }

    pub fn set_muted(&self, id: i64, muted: bool) -> Result<Source> {
        self.db
            .execute(
                // Unmuting fetches right away; muted sources aren't polled.
                "UPDATE sources SET muted = ?2, next_fetch_at = CASE WHEN ?2 THEN next_fetch_at ELSE 0 END
                 WHERE id = ?1 AND removed_at IS NULL",
                params![id, muted],
            )
            .map_err(err)?;
        self.source(id)
    }

    /// Live, unmuted sources whose next fetch has come (or all of them).
    pub fn due(&self, now: i64, all: bool) -> Result<Vec<Due>> {
        let mut statement = self
            .db
            .prepare(
                "SELECT id, url, kind, cursor, failures, last_success_at IS NULL FROM sources
                 WHERE removed_at IS NULL AND muted = 0 AND suggested = 0 AND (?2 OR next_fetch_at <= ?1) ORDER BY next_fetch_at, id",
            )
            .map_err(err)?;
        statement
            .query_map(params![now, all], |r| {
                Ok(Due {
                    id: r.get(0)?,
                    url: r.get(1)?,
                    kind: kind(r, 2)?,
                    cursor: r.get(3)?,
                    failures: r.get(4)?,
                    first: r.get(5)?,
                })
            })
            .map_err(err)?
            .collect::<rusqlite::Result<_>>()
            .map_err(err)
    }

    pub fn due_one(&self, id: i64) -> Result<Due> {
        self.due(0, true)?
            .into_iter()
            .find(|d| d.id == id)
            .ok_or_else(|| "no such source, or it is muted".into())
    }

    /// The metadata a fetch learned; existing titles the writer has are kept
    /// only when the feed offers none.
    pub fn record_success(
        &self,
        id: i64,
        now: i64,
        cursor: Option<&str>,
        meta: Option<&SourceInfo>,
        next: i64,
    ) -> Result<()> {
        let meta = meta.cloned().unwrap_or_default();
        self.db
            .execute(
                "UPDATE sources SET last_fetch_at = ?2, last_success_at = ?2, last_status = NULL, last_error = NULL,
                   failures = 0, next_fetch_at = ?3, cursor = ?4,
                   title = COALESCE(?5, title), site_url = COALESCE(?6, site_url), image = COALESCE(?7, image)
                 WHERE id = ?1",
                params![id, now, next, cursor, meta.title, meta.url, meta.image],
            )
            .map_err(err)?;
        Ok(())
    }

    /// A failure never removes a source: it backs off and tries again.
    pub fn record_failure(
        &self,
        id: i64,
        now: i64,
        status: Option<u16>,
        error: &str,
        next: i64,
    ) -> Result<()> {
        self.db
            .execute(
                "UPDATE sources SET last_fetch_at = ?2, last_status = ?3, last_error = ?4,
                   failures = failures + 1, next_fetch_at = ?5 WHERE id = ?1",
                params![id, now, status, error, next],
            )
            .map_err(err)?;
        Ok(())
    }

    // ── Items ──────────────────────────────────────────────────────────────

    /// Entries arrive newest first, as feeds list them. Returns how many are
    /// new to the feed. Known entries are refreshed unless they have expired.
    pub fn insert_items(
        &self,
        source: i64,
        entries: &[NewItem],
        now: i64,
        first: bool,
    ) -> Result<usize> {
        let tx = self.db.unchecked_transaction().map_err(err)?;
        let source_kind = tx
            .query_row("SELECT kind FROM sources WHERE id = ?1", [source], |r| {
                kind(r, 0)
            })
            .map_err(err)?;
        let pool_old = catalogue::supported(source_kind);
        let mut added = 0;
        let mut order: Vec<&NewItem> = entries.iter().take(MAX_ENTRIES_PER_POLL).collect();
        // Newest by date first; undated entries keep the feed's own order.
        order.sort_by_key(|e| std::cmp::Reverse(e.published_at.map(|p| p.min(now)).unwrap_or(now)));
        // Insert oldest first so ties on sort_at break by id, newest on top.
        for (rank, entry) in order.iter().enumerate().rev() {
            let url_key = entry.url.as_deref().and_then(catalogue::url_key);
            let known = catalogue::known_item(&tx, source, &entry.guid, url_key.as_deref())?;
            if let Some((id, owner)) = known {
                // A URL discovered under another source keeps its identity and actions.
                if owner == source {
                    tx.execute(
                        "UPDATE items SET url = COALESCE(?2, url), url_key = COALESCE(?3, url_key),
                           title = COALESCE(?4, title), author = COALESCE(?5, author), summary = COALESCE(?6, summary),
                           content = CASE WHEN full_text_at IS NULL AND back_catalogue = 0 THEN COALESCE(?7, content) ELSE content END,
                           image = COALESCE(?8, image), media = ?9
                         WHERE id = ?1 AND expired_at IS NULL AND dismissed_at IS NULL",
                        params![id, entry.url, url_key, entry.title, entry.author, entry.summary, entry.content, entry.image, entry.media],
                    ).map_err(err)?;
                }
                continue;
            }
            // Preserve the original publication date; only the sort key clamps future dates.
            let published = entry.published_at;
            let sort_at = published.map(|p| p.min(now)).unwrap_or(now);
            let old = now - sort_at > EXPIRE_AFTER;
            let pooled = old && pool_old;
            let stale = old && !pooled && !(first && rank < FIRST_FETCH_KEEP);
            tx.execute(
                "INSERT INTO items (source_id, guid, url, url_key, title, author, summary, content, image, media,
                   published_at, fetched_at, sort_at, expired_at, back_catalogue)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, CASE WHEN ?14 IS NULL AND NOT ?15 THEN ?8 END, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
                params![source, entry.guid, entry.url, url_key, entry.title, entry.author, entry.summary, entry.content,
                    entry.image, entry.media, published, now, sort_at, stale.then_some(now), pooled],
            ).map_err(err)?;
            if !stale && !pooled {
                added += 1;
            }
        }
        tx.commit().map_err(err)?;
        Ok(added)
    }

    /// Newest first: live, unmuted sources; no dismissed or expired items.
    pub fn items(&self, offset: i64, limit: i64, source: Option<i64>) -> Result<Page> {
        // Keep the original dates on returned items. Placement uses release time,
        // with at most two catalogue pieces even when many days have accumulated.
        let filter = format!(
            "{VISIBLE} AND (?1 IS NULL OR i.source_id = ?1)
            AND (i.back_catalogue = 0 OR i.id IN (
              SELECT i.id FROM items i JOIN sources s ON s.id = i.source_id
              WHERE {VISIBLE} AND i.back_catalogue = 1 AND (?1 IS NULL OR i.source_id = ?1)
              ORDER BY i.catalogue_released_at DESC, i.id DESC LIMIT 2))"
        );
        let total = self
            .db
            .query_row(&format!("SELECT COUNT(*) FROM items i JOIN sources s ON s.id = i.source_id WHERE {filter}"), [source], |r| r.get(0))
            .map_err(err)?;
        let mut statement = self
            .db
            .prepare(&format!(
                "SELECT {ITEM_COLUMNS} FROM items i JOIN sources s ON s.id = i.source_id WHERE {filter}
                 ORDER BY CASE WHEN i.back_catalogue = 1 THEN i.catalogue_released_at ELSE i.sort_at END DESC,
                   i.id DESC LIMIT ?2 OFFSET ?3"
            ))
            .map_err(err)?;
        let items = statement
            .query_map(params![source, limit, offset], item_row)
            .map_err(err)?
            .collect::<rusqlite::Result<_>>()
            .map_err(err)?;
        Ok(Page { items, total })
    }

    pub fn item(&self, id: i64) -> Result<Item> {
        self.db
            .query_row(&format!("SELECT {ITEM_COLUMNS} FROM items i JOIN sources s ON s.id = i.source_id WHERE i.id = ?1"), [id], item_row)
            .optional()
            .map_err(err)?
            .ok_or_else(|| "no such feed item".into())
    }

    /// Every item in the feed, with a stamp that changes with its text, for
    /// the search index (`crate::search`).
    pub fn search_stamps(&self) -> Result<Vec<(i64, String)>> {
        let mut statement = self
            .db
            .prepare(&format!(
                "SELECT i.id, i.fetched_at || ':' || COALESCE(i.full_text_at, 0) || ':' || COALESCE(s.title, '') || ':'
                   || length(COALESCE(i.title, '') || COALESCE(i.author, '') || COALESCE(i.summary, '') || COALESCE(i.content, ''))
                 FROM items i JOIN sources s ON s.id = i.source_id WHERE {VISIBLE} ORDER BY i.id"
            ))
            .map_err(err)?;
        let rows = statement
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(err)?;
        rows.collect::<rusqlite::Result<_>>().map_err(err)
    }

    /// An item's searchable text: title, source title, author, summary, content.
    pub fn search_text(&self, id: i64) -> Result<Option<[Option<String>; 5]>> {
        self.db
            .query_row(
                "SELECT i.title, s.title, i.author, i.summary, i.content FROM items i JOIN sources s ON s.id = i.source_id WHERE i.id = ?1",
                [id],
                |r| Ok([r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?]),
            )
            .optional()
            .map_err(err)
    }

    /// Readable text from the feed itself, for reading in the app and for a
    /// saved clip's source section.
    pub fn content(&self, id: i64) -> Result<Option<String>> {
        self.db
            .query_row("SELECT content FROM items WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .map_err(err)
    }

    pub fn set_liked(&self, id: i64, liked: bool, now: i64) -> Result<Item> {
        self.update(
            id,
            "liked_at = CASE WHEN ?2 THEN COALESCE(liked_at, ?3) END",
            params![id, liked, now],
        )
    }

    pub fn set_dismissed(&self, id: i64, dismissed: bool, now: i64) -> Result<Item> {
        self.update(
            id,
            "dismissed_at = CASE WHEN ?2 THEN COALESCE(dismissed_at, ?3) END",
            params![id, dismissed, now],
        )
    }

    /// An empty note clears it.
    pub fn set_note(&self, id: i64, note: &str, now: i64) -> Result<Item> {
        let note = Some(note.trim()).filter(|n| !n.is_empty());
        self.update(
            id,
            "note = ?2, note_at = CASE WHEN ?2 IS NULL THEN NULL ELSE ?3 END",
            params![id, note, now],
        )
    }

    /// Full text from the ingest engine replaces the feed's excerpt.
    pub fn set_full_text(&self, id: i64, text: Option<&str>, now: i64) -> Result<()> {
        self.db
            .execute(
                "UPDATE items SET content = COALESCE(?2, content), full_text_at = ?3 WHERE id = ?1",
                params![id, text, now],
            )
            .map_err(err)?;
        Ok(())
    }

    pub fn full_text_tried(&self, id: i64) -> Result<bool> {
        self.db
            .query_row(
                "SELECT full_text_at IS NOT NULL FROM items WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .map_err(err)
    }

    pub fn set_saved(&self, id: i64, path: &str) -> Result<Item> {
        self.update(id, "saved_path = ?2", params![id, path])
    }

    /// The clip capture idempotency key: made once, reused for every retry.
    pub fn save_id(&self, id: i64) -> Result<String> {
        let existing: Option<String> = self
            .db
            .query_row("SELECT save_id FROM items WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .optional()
            .map_err(err)?
            .ok_or("no such feed item")?;
        if let Some(existing) = existing {
            return Ok(existing);
        }
        let fresh = uuid::Uuid::new_v4().to_string();
        self.db
            .execute(
                "UPDATE items SET save_id = ?2 WHERE id = ?1",
                params![id, fresh],
            )
            .map_err(err)?;
        Ok(fresh)
    }

    fn update(&self, id: i64, set: &str, args: impl rusqlite::Params) -> Result<Item> {
        let changed = self
            .db
            .execute(&format!("UPDATE items SET {set} WHERE id = ?1"), args)
            .map_err(err)?;
        if changed == 0 {
            return Err("no such feed item".into());
        }
        self.item(id)
    }

    /// Unseen articles age into the catalogue. Pending and unseen releases
    /// never expire; ignored releases expire 30 days after their first human
    /// exposure. Reacted items stay, while dismissed items eventually lose text.
    pub fn expire(&self, now: i64) -> Result<usize> {
        let cutoff = now - EXPIRE_AFTER;
        let tx = self.db.unchecked_transaction().map_err(err)?;
        // Unseen feed entries age into the pool. Human exposure still expires
        // normally, rather than recommending something he already ignored.
        let pooled = tx.execute(
            "UPDATE items SET back_catalogue = 1, content = CASE WHEN full_text_at IS NULL THEN NULL ELSE content END
             WHERE back_catalogue = 0 AND expired_at IS NULL AND fetched_at < ?1
               AND liked_at IS NULL AND note IS NULL AND saved_path IS NULL AND dismissed_at IS NULL
               AND source_id IN (SELECT id FROM sources WHERE kind IN ('feed', 'page'))
               AND NOT EXISTS (SELECT 1 FROM events e WHERE e.item_id = items.id AND e.kind <> 'kin_pick')",
            [cutoff],
        ).map_err(err)?;
        let expired = tx.execute(
            "UPDATE items SET expired_at = ?1, content = NULL
             WHERE expired_at IS NULL AND liked_at IS NULL AND note IS NULL AND saved_path IS NULL AND dismissed_at IS NULL
               AND ((back_catalogue = 0 AND fetched_at < ?2)
                 OR (back_catalogue = 1 AND catalogue_released_at IS NOT NULL
                   AND (SELECT MIN(e.at) FROM events e WHERE e.item_id = items.id
                     AND e.kind <> 'kin_pick' AND COALESCE(e.surface, '') <> 'kin'
                     AND e.at >= items.catalogue_released_at * 1000) < ?2 * 1000))",
            params![now, cutoff],
        ).map_err(err)?;
        tx.commit().map_err(err)?;
        self.db
            .execute("UPDATE items SET content = NULL WHERE dismissed_at IS NOT NULL AND dismissed_at < ?1 AND content IS NOT NULL", [cutoff])
            .map_err(err)?;
        Ok(expired + pooled)
    }

    // ── Event log ──────────────────────────────────────────────────────────

    pub fn log(&self, event: &Event) -> Result<()> {
        self.db
            .execute(
                "INSERT INTO events (at, kind, item_id, source_id, surface, position, data) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    event.at,
                    event.kind,
                    event.item_id,
                    event.source_id,
                    event.surface,
                    event.position,
                    event.data.as_ref().map(Value::to_string)
                ],
            )
            .map_err(err)?;
        Ok(())
    }

    pub fn log_all(&self, events: &[Event]) -> Result<()> {
        let tx = self.db.unchecked_transaction().map_err(err)?;
        for event in events {
            self.log(event)?;
        }
        tx.commit().map_err(err)
    }

    /// Oldest first.
    #[cfg(test)]
    pub fn events(&self) -> Result<Vec<Event>> {
        let mut statement = self
            .db
            .prepare("SELECT at, kind, item_id, source_id, surface, position, data FROM events ORDER BY id")
            .map_err(err)?;
        statement
            .query_map([], |r| {
                let data: Option<String> = r.get(6)?;
                Ok(Event {
                    at: r.get(0)?,
                    kind: r.get(1)?,
                    item_id: r.get(2)?,
                    source_id: r.get(3)?,
                    surface: r.get(4)?,
                    position: r.get(5)?,
                    data: data.and_then(|d| serde_json::from_str(&d).ok()),
                })
            })
            .map_err(err)?
            .collect::<rusqlite::Result<_>>()
            .map_err(err)
    }

    /// Items liked, noted or saved, newest action first (Ideas, KI-39).
    pub fn acted_on(&self, limit: usize) -> Result<Vec<Acted>> {
        let mut statement = self
            .db
            .prepare(
                "SELECT i.id, COALESCE(i.title, ''), COALESCE(s.title, ''), i.liked_at IS NOT NULL, i.saved_path IS NOT NULL, i.note
                 FROM items i JOIN sources s ON s.id = i.source_id
                 WHERE i.liked_at IS NOT NULL OR i.note IS NOT NULL OR i.saved_path IS NOT NULL
                 ORDER BY MAX(COALESCE(i.liked_at, 0), COALESCE(i.note_at, 0), i.fetched_at) DESC LIMIT ?1",
            )
            .map_err(err)?;
        let rows = statement
            .query_map([limit as i64], |r| {
                Ok(Acted {
                    id: format!("feed:{}", r.get::<_, i64>(0)?),
                    title: r.get(1)?,
                    source: r.get(2)?,
                    liked: r.get(3)?,
                    saved: r.get(4)?,
                    note: r.get(5)?,
                })
            })
            .map_err(err)?;
        rows.collect::<rusqlite::Result<_>>().map_err(err)
    }

    #[cfg(test)]
    pub fn raw(&self) -> &Connection {
        &self.db
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: i64 = 24 * 60 * 60;
    const NOW: i64 = 1_800_000_000;

    fn entry(guid: &str, days_ago: Option<i64>) -> NewItem {
        NewItem {
            guid: guid.into(),
            url: Some(format!("https://example.com/{guid}")),
            title: Some(guid.into()),
            content: Some(format!("Body of {guid}")),
            media: "article",
            published_at: days_ago.map(|d| NOW - d * DAY),
            ..Default::default()
        }
    }

    /// The search index's view: visible items, stamps that move with text.
    #[test]
    fn search_stamps_follow_text_and_visibility() {
        let store = Store::memory();
        let (source, _) = store
            .add_source(
                "https://example.com/feed",
                SourceKind::Feed,
                Some("Example"),
                NOW,
            )
            .unwrap();
        store
            .insert_items(
                source.id,
                &[entry("a", Some(1)), entry("b", Some(1))],
                NOW,
                true,
            )
            .unwrap();
        let before = store.search_stamps().unwrap();
        assert_eq!(before.len(), 2);
        let a = before
            .iter()
            .map(|i| i.0)
            .find(|id| store.item(*id).unwrap().title.as_deref() == Some("a"))
            .unwrap();
        let [title, from, _, _, content] = store.search_text(a).unwrap().unwrap();
        assert_eq!(
            (title.as_deref(), from.as_deref()),
            (Some("a"), Some("Example"))
        );
        assert_eq!(content.as_deref(), Some("Body of a"));
        store
            .set_full_text(a, Some("A much longer body of a"), NOW + 1)
            .unwrap();
        let after = store.search_stamps().unwrap();
        assert_ne!(
            after.iter().find(|i| i.0 == a),
            before.iter().find(|i| i.0 == a)
        );
        store.set_dismissed(a, true, NOW).unwrap();
        assert_eq!(store.search_stamps().unwrap().len(), 1);
        store.set_muted(source.id, true).unwrap();
        assert!(store.search_stamps().unwrap().is_empty());
    }

    #[test]
    fn newest_first_and_known_entries_are_not_duplicated() {
        let store = Store::memory();
        let (source, added) = store
            .add_source(
                "https://example.com/feed",
                SourceKind::Feed,
                Some("Example"),
                NOW,
            )
            .unwrap();
        assert!(added);
        let entries = [
            entry("b", Some(2)),
            entry("a", Some(1)),
            entry("c", Some(3)),
        ];
        assert_eq!(
            store.insert_items(source.id, &entries, NOW, true).unwrap(),
            3
        );
        assert_eq!(
            store
                .insert_items(source.id, &entries, NOW + 60, false)
                .unwrap(),
            0
        );
        let page = store.items(0, 10, None).unwrap();
        assert_eq!(page.total, 3);
        let titles: Vec<_> = page
            .items
            .iter()
            .map(|i| i.title.clone().unwrap())
            .collect();
        assert_eq!(titles, ["a", "b", "c"]);
        assert_eq!(page.items[0].source_title.as_deref(), Some("Example"));
        assert!(page.items[0].has_content);
    }

    #[test]
    fn undated_entries_keep_feed_order() {
        let store = Store::memory();
        let (source, _) = store
            .add_source("https://example.com/feed", SourceKind::Feed, None, NOW)
            .unwrap();
        store
            .insert_items(
                source.id,
                &[entry("first", None), entry("second", None)],
                NOW,
                true,
            )
            .unwrap();
        let titles: Vec<_> = store
            .items(0, 10, None)
            .unwrap()
            .items
            .into_iter()
            .map(|i| i.title.unwrap())
            .collect();
        assert_eq!(titles, ["first", "second"]);
    }

    #[test]
    fn non_article_back_catalogue_keeps_legacy_first_fetch_limit() {
        let store = Store::memory();
        let (source, _) = store
            .add_source(
                "https://example.com/podcast",
                SourceKind::Podcast,
                None,
                NOW,
            )
            .unwrap();
        let old: Vec<_> = (0..6)
            .map(|n| entry(&format!("old{n}"), Some(100 + n)))
            .collect();
        assert_eq!(store.insert_items(source.id, &old, NOW, true).unwrap(), 3);
        assert_eq!(store.items(0, 10, None).unwrap().total, 3);
        // Later polls never bring the rest back, and new old entries start expired.
        assert_eq!(
            store
                .insert_items(source.id, &[entry("older", Some(200))], NOW, false)
                .unwrap(),
            0
        );
        assert_eq!(store.items(0, 10, None).unwrap().total, 3);
    }

    #[test]
    fn ignored_feed_items_join_catalogue_after_thirty_days_but_acted_ones_stay() {
        let store = Store::memory();
        let (source, _) = store
            .add_source("https://example.com/feed", SourceKind::Feed, None, NOW)
            .unwrap();
        let entries: Vec<_> = ["ignored", "liked", "noted", "dismissed"]
            .iter()
            .map(|g| entry(g, Some(0)))
            .collect();
        store.insert_items(source.id, &entries, NOW, true).unwrap();
        let id = |title: &str| {
            store
                .raw()
                .query_row("SELECT id FROM items WHERE guid = ?1", [title], |r| {
                    r.get::<_, i64>(0)
                })
                .unwrap()
        };
        store.set_liked(id("liked"), true, NOW).unwrap();
        store.set_note(id("noted"), "Worth a post", NOW).unwrap();
        store.set_dismissed(id("dismissed"), true, NOW).unwrap();
        assert_eq!(store.expire(NOW + 29 * DAY).unwrap(), 0);
        assert_eq!(store.expire(NOW + 31 * DAY).unwrap(), 1);
        let left: Vec<_> = store
            .items(0, 10, None)
            .unwrap()
            .items
            .into_iter()
            .map(|i| i.title.unwrap())
            .collect();
        assert_eq!(left.len(), 2);
        assert!(left.contains(&"liked".to_string()) && left.contains(&"noted".to_string()));
        // The pooled item stays metadata-only and a later poll cannot release it.
        assert!(store.item(id("ignored")).unwrap().back_catalogue);
        assert_eq!(store.content(id("ignored")).unwrap(), None);
        assert_eq!(store.content(id("dismissed")).unwrap(), None);
        store
            .insert_items(
                source.id,
                &[entry("ignored", Some(0))],
                NOW + 32 * DAY,
                false,
            )
            .unwrap();
        assert_eq!(store.items(0, 10, None).unwrap().total, 2);
    }

    #[test]
    fn muted_and_removed_sources_leave_the_feed() {
        let store = Store::memory();
        let (source, _) = store
            .add_source("https://example.com/feed", SourceKind::Feed, None, NOW)
            .unwrap();
        store
            .insert_items(source.id, &[entry("a", Some(0))], NOW, true)
            .unwrap();
        assert!(store.set_muted(source.id, true).unwrap().muted);
        assert_eq!(store.items(0, 10, None).unwrap().total, 0);
        assert!(
            store.due(NOW, true).unwrap().is_empty(),
            "muted sources aren't polled"
        );
        store.set_muted(source.id, false).unwrap();
        assert_eq!(store.items(0, 10, None).unwrap().total, 1);
        store.remove_source(source.id, NOW).unwrap();
        assert!(store.sources().unwrap().is_empty());
        assert_eq!(store.items(0, 10, None).unwrap().total, 0);
        // Subscribing again revives it with its history.
        let (again, added) = store
            .add_source("https://example.com/feed", SourceKind::Feed, None, NOW)
            .unwrap();
        assert_eq!(again.id, source.id);
        assert!(added);
        assert_eq!(store.items(0, 10, None).unwrap().total, 1);
    }

    #[test]
    fn health_records_backoff_and_conditional_headers() {
        let store = Store::memory();
        let (source, _) = store
            .add_source("https://example.com/feed", SourceKind::Feed, None, NOW)
            .unwrap();
        assert!(store.due(NOW, false).unwrap()[0].first);
        store
            .record_failure(source.id, NOW, Some(503), "HTTP 503", NOW + 300)
            .unwrap();
        let failed = store.source(source.id).unwrap();
        assert_eq!(
            (
                failed.failures,
                failed.last_error.as_deref(),
                failed.last_status
            ),
            (1, Some("HTTP 503"), Some(503))
        );
        assert!(store.due(NOW + 10, false).unwrap().is_empty());
        let meta = SourceInfo {
            title: Some("Example blog".into()),
            ..Default::default()
        };
        store
            .record_success(
                source.id,
                NOW + 400,
                Some(r#"{"etag":"\"v1\""}"#),
                Some(&meta),
                NOW + 2200,
            )
            .unwrap();
        let healthy = store.source(source.id).unwrap();
        assert_eq!(
            (
                healthy.failures,
                healthy.last_error,
                healthy.last_status,
                healthy.title.as_deref()
            ),
            (0, None, None, Some("Example blog"))
        );
        let due = store.due(NOW + 2200, false).unwrap();
        assert_eq!(due[0].cursor.as_deref(), Some(r#"{"etag":"\"v1\""}"#));
        assert!(!due[0].first);
    }

    #[test]
    fn the_event_log_is_append_only() {
        let store = Store::memory();
        store
            .log(&Event {
                at: 1,
                kind: "impression".into(),
                item_id: Some(7),
                surface: Some("newest".into()),
                position: Some(0),
                ..Default::default()
            })
            .unwrap();
        assert!(
            store
                .raw()
                .execute("UPDATE events SET kind = 'like'", [])
                .is_err()
        );
        assert!(store.raw().execute("DELETE FROM events", []).is_err());
        assert_eq!(store.events().unwrap()[0].position, Some(0));
    }

    #[test]
    fn full_text_is_fetched_once_and_survives_later_polls() {
        let store = Store::memory();
        let (source, _) = store
            .add_source("https://example.com/feed", SourceKind::Feed, None, NOW)
            .unwrap();
        store
            .insert_items(source.id, &[entry("a", Some(0))], NOW, true)
            .unwrap();
        let id = store.items(0, 1, None).unwrap().items[0].id;
        assert!(!store.full_text_tried(id).unwrap());
        store
            .set_full_text(id, Some("The whole article."), NOW)
            .unwrap();
        assert!(store.full_text_tried(id).unwrap());
        store
            .insert_items(source.id, &[entry("a", Some(0))], NOW + 60, false)
            .unwrap();
        assert_eq!(
            store.content(id).unwrap().as_deref(),
            Some("The whole article.")
        );
        // A failed fetch keeps the feed's text but isn't retried.
        store
            .insert_items(source.id, &[entry("b", Some(0))], NOW, false)
            .unwrap();
        let other = store
            .items(0, 2, None)
            .unwrap()
            .items
            .into_iter()
            .find(|i| i.id != id)
            .unwrap()
            .id;
        store.set_full_text(other, None, NOW).unwrap();
        assert_eq!(store.content(other).unwrap().as_deref(), Some("Body of b"));
        assert!(store.full_text_tried(other).unwrap());
    }

    #[test]
    fn save_ids_are_stable() {
        let store = Store::memory();
        let (source, _) = store
            .add_source("https://example.com/feed", SourceKind::Feed, None, NOW)
            .unwrap();
        store
            .insert_items(source.id, &[entry("a", Some(0))], NOW, true)
            .unwrap();
        let id = store.items(0, 1, None).unwrap().items[0].id;
        let first = store.save_id(id).unwrap();
        assert_eq!(first.len(), 36);
        assert_eq!(store.save_id(id).unwrap(), first);
    }
}
