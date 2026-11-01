//! The Feed's one SQLite file in app data (never the vault): sources, items
//! and an append-only event log of every impression and action, so ranking
//! (KI-32) can learn online and be evaluated offline from the same history.

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Serialize;
use serde_json::Value;
use kintsugi_ingest::SourceInfo;
use std::path::Path;

type Result<T> = std::result::Result<T, String>;

/// Ignored items (no like, note, save or Not interested) drop out after this.
pub const EXPIRE_AFTER: i64 = 30 * 24 * 60 * 60;
/// On a source's first fetch, this many entries show even if they are old,
/// so subscribing to a quiet blog shows something.
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
  -- The ingest feed adapter's opaque poll cursor (ETag / Last-Modified).
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceKind {
    Feed,
    Hn,
    Youtube,
    Podcast,
    /// An X account, polled through the ingest engine's X adapter.
    X,
}

impl SourceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Feed => "feed",
            Self::Hn => "hn",
            Self::Youtube => "youtube",
            Self::Podcast => "podcast",
            Self::X => "x",
        }
    }
    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "feed" => Self::Feed,
            "hn" => Self::Hn,
            "youtube" => Self::Youtube,
            "podcast" => Self::Podcast,
            "x" => Self::X,
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
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub items: Vec<Item>,
    pub total: i64,
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

const SOURCE_COLUMNS: &str = "s.id, s.url, s.kind, s.title, s.site_url, s.image, s.muted, s.added_at,
  s.last_fetch_at, s.last_success_at, s.last_status, s.last_error, s.failures, s.next_fetch_at,
  (SELECT COUNT(*) FROM items i WHERE i.source_id = s.id AND i.dismissed_at IS NULL AND i.expired_at IS NULL)";

const ITEM_COLUMNS: &str = "i.id, i.source_id, s.title, s.kind, i.url, i.title, i.author, i.summary,
  i.image, i.media, i.published_at, i.fetched_at, i.sort_at, i.liked_at IS NOT NULL, i.note,
  i.saved_path, i.dismissed_at IS NOT NULL, i.content IS NOT NULL AND i.content <> ''";

/// In the feed: a live, unmuted source; not dismissed, not expired.
const VISIBLE: &str = "s.removed_at IS NULL AND s.muted = 0 AND i.dismissed_at IS NULL AND i.expired_at IS NULL";

fn kind(row: &Row, index: usize) -> rusqlite::Result<SourceKind> {
    let text: String = row.get(index)?;
    SourceKind::parse(&text).ok_or_else(|| rusqlite::Error::InvalidColumnType(index, "kind".into(), rusqlite::types::Type::Text))
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
    })
}

fn item_row(row: &Row) -> rusqlite::Result<Item> {
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
        db.busy_timeout(std::time::Duration::from_secs(5)).map_err(err)?;
        db.pragma_update(None, "journal_mode", "WAL").map_err(err)?;
        db.pragma_update(None, "foreign_keys", true).map_err(err)?;
        let version: i64 = db.pragma_query_value(None, "user_version", |r| r.get(0)).map_err(err)?;
        if version == 0 {
            db.execute_batch(&format!("BEGIN; {SCHEMA} PRAGMA user_version = 1; COMMIT;")).map_err(err)?;
        } else if version > 1 {
            return Err("the feed database was written by a newer Kintsugi".into());
        }
        Ok(Self { db })
    }

    // ── Sources ────────────────────────────────────────────────────────────

    /// Subscribing to a URL already followed (or unsubscribed earlier)
    /// revives that source rather than duplicating it.
    pub fn add_source(&self, url: &str, kind: SourceKind, title: Option<&str>, now: i64) -> Result<(Source, bool)> {
        let existing: Option<(i64, Option<i64>)> = self
            .db
            .query_row("SELECT id, removed_at FROM sources WHERE url = ?1", [url], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()
            .map_err(err)?;
        let (id, added) = match existing {
            Some((id, removed)) => {
                self.db
                    .execute(
                        "UPDATE sources SET removed_at = NULL, muted = 0, next_fetch_at = 0,
                           title = COALESCE(title, ?2) WHERE id = ?1",
                        params![id, title],
                    )
                    .map_err(err)?;
                (id, removed.is_some())
            }
            None => {
                self.db
                    .execute(
                        "INSERT INTO sources (url, kind, title, added_at) VALUES (?1, ?2, ?3, ?4)",
                        params![url, kind.as_str(), title, now],
                    )
                    .map_err(err)?;
                (self.db.last_insert_rowid(), true)
            }
        };
        Ok((self.source(id)?, added))
    }

    pub fn source(&self, id: i64) -> Result<Source> {
        self.db
            .query_row(&format!("SELECT {SOURCE_COLUMNS} FROM sources s WHERE s.id = ?1 AND s.removed_at IS NULL"), [id], source_row)
            .optional()
            .map_err(err)?
            .ok_or_else(|| "no such source".into())
    }

    /// Alphabetical by title, falling back to the URL.
    pub fn sources(&self) -> Result<Vec<Source>> {
        let mut statement = self
            .db
            .prepare(&format!(
                "SELECT {SOURCE_COLUMNS} FROM sources s WHERE s.removed_at IS NULL
                 ORDER BY lower(COALESCE(s.title, s.url)), s.id"
            ))
            .map_err(err)?;
        statement.query_map([], source_row).map_err(err)?.collect::<rusqlite::Result<_>>().map_err(err)
    }

    pub fn remove_source(&self, id: i64, now: i64) -> Result<()> {
        let changed = self
            .db
            .execute("UPDATE sources SET removed_at = ?2 WHERE id = ?1 AND removed_at IS NULL", params![id, now])
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
                 WHERE removed_at IS NULL AND muted = 0 AND (?2 OR next_fetch_at <= ?1) ORDER BY next_fetch_at, id",
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
        self.due(0, true)?.into_iter().find(|d| d.id == id).ok_or_else(|| "no such source, or it is muted".into())
    }

    /// The metadata a fetch learned; existing titles the writer has are kept
    /// only when the feed offers none.
    pub fn record_success(&self, id: i64, now: i64, cursor: Option<&str>, meta: Option<&SourceInfo>, next: i64) -> Result<()> {
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
    pub fn record_failure(&self, id: i64, now: i64, status: Option<u16>, error: &str, next: i64) -> Result<()> {
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
    pub fn insert_items(&self, source: i64, entries: &[NewItem], now: i64, first: bool) -> Result<usize> {
        let tx = self.db.unchecked_transaction().map_err(err)?;
        let mut added = 0;
        let mut order: Vec<&NewItem> = entries.iter().take(MAX_ENTRIES_PER_POLL).collect();
        // Newest by date first; undated entries keep the feed's own order.
        order.sort_by_key(|e| std::cmp::Reverse(e.published_at.map(|p| p.min(now)).unwrap_or(now)));
        // Insert oldest first so ties on sort_at break by id, newest on top.
        for (rank, entry) in order.iter().enumerate().rev() {
            let known: bool = tx
                .query_row("SELECT 1 FROM items WHERE source_id = ?1 AND guid = ?2", params![source, entry.guid], |_| Ok(true))
                .optional()
                .map_err(err)?
                .unwrap_or(false);
            if known {
                tx.execute(
                    "UPDATE items SET url = ?3, title = ?4, author = ?5, summary = ?6,
                       content = CASE WHEN full_text_at IS NULL THEN ?7 ELSE content END, image = ?8, media = ?9
                     WHERE source_id = ?1 AND guid = ?2 AND expired_at IS NULL",
                    params![source, entry.guid, entry.url, entry.title, entry.author, entry.summary, entry.content, entry.image, entry.media],
                )
                .map_err(err)?;
                continue;
            }
            // A feed's future-dated entry still sorts as "now".
            let published = entry.published_at.map(|p| p.min(now));
            let sort_at = published.unwrap_or(now);
            // Old back-catalogue entries are recorded (so they never come back)
            // but start out expired, except a few on the first fetch.
            let stale = now - sort_at > EXPIRE_AFTER && !(first && rank < FIRST_FETCH_KEEP);
            tx.execute(
                "INSERT INTO items (source_id, guid, url, title, author, summary, content, image, media,
                   published_at, fetched_at, sort_at, expired_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, CASE WHEN ?13 IS NULL THEN ?7 END, ?8, ?9, ?10, ?11, ?12, ?13)",
                params![
                    source, entry.guid, entry.url, entry.title, entry.author, entry.summary, entry.content,
                    entry.image, entry.media, published, now, sort_at, stale.then_some(now)
                ],
            )
            .map_err(err)?;
            if !stale {
                added += 1;
            }
        }
        tx.commit().map_err(err)?;
        Ok(added)
    }

    /// Newest first: live, unmuted sources; no dismissed or expired items.
    pub fn items(&self, offset: i64, limit: i64, source: Option<i64>) -> Result<Page> {
        let filter = format!("{VISIBLE} AND (?1 IS NULL OR i.source_id = ?1)");
        let total = self
            .db
            .query_row(&format!("SELECT COUNT(*) FROM items i JOIN sources s ON s.id = i.source_id WHERE {filter}"), [source], |r| r.get(0))
            .map_err(err)?;
        let mut statement = self
            .db
            .prepare(&format!(
                "SELECT {ITEM_COLUMNS} FROM items i JOIN sources s ON s.id = i.source_id WHERE {filter}
                 ORDER BY i.sort_at DESC, i.id DESC LIMIT ?2 OFFSET ?3"
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
        let rows = statement.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map_err(err)?;
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
        self.db.query_row("SELECT content FROM items WHERE id = ?1", [id], |r| r.get(0)).map_err(err)
    }

    pub fn set_liked(&self, id: i64, liked: bool, now: i64) -> Result<Item> {
        self.update(id, "liked_at = CASE WHEN ?2 THEN COALESCE(liked_at, ?3) END", params![id, liked, now])
    }

    pub fn set_dismissed(&self, id: i64, dismissed: bool, now: i64) -> Result<Item> {
        self.update(id, "dismissed_at = CASE WHEN ?2 THEN COALESCE(dismissed_at, ?3) END", params![id, dismissed, now])
    }

    /// An empty note clears it.
    pub fn set_note(&self, id: i64, note: &str, now: i64) -> Result<Item> {
        let note = Some(note.trim()).filter(|n| !n.is_empty());
        self.update(id, "note = ?2, note_at = CASE WHEN ?2 IS NULL THEN NULL ELSE ?3 END", params![id, note, now])
    }

    /// Full text from the ingest engine replaces the feed's excerpt.
    pub fn set_full_text(&self, id: i64, text: Option<&str>, now: i64) -> Result<()> {
        self.db
            .execute("UPDATE items SET content = COALESCE(?2, content), full_text_at = ?3 WHERE id = ?1", params![id, text, now])
            .map_err(err)?;
        Ok(())
    }

    pub fn full_text_tried(&self, id: i64) -> Result<bool> {
        self.db.query_row("SELECT full_text_at IS NOT NULL FROM items WHERE id = ?1", [id], |r| r.get(0)).map_err(err)
    }

    pub fn set_saved(&self, id: i64, path: &str) -> Result<Item> {
        self.update(id, "saved_path = ?2", params![id, path])
    }

    /// The clip capture idempotency key: made once, reused for every retry.
    pub fn save_id(&self, id: i64) -> Result<String> {
        let existing: Option<String> = self
            .db
            .query_row("SELECT save_id FROM items WHERE id = ?1", [id], |r| r.get(0))
            .optional()
            .map_err(err)?
            .ok_or("no such feed item")?;
        if let Some(existing) = existing {
            return Ok(existing);
        }
        let fresh = uuid::Uuid::new_v4().to_string();
        self.db.execute("UPDATE items SET save_id = ?2 WHERE id = ?1", params![id, fresh]).map_err(err)?;
        Ok(fresh)
    }

    fn update(&self, id: i64, set: &str, args: impl rusqlite::Params) -> Result<Item> {
        let changed = self.db.execute(&format!("UPDATE items SET {set} WHERE id = ?1"), args).map_err(err)?;
        if changed == 0 {
            return Err("no such feed item".into());
        }
        self.item(id)
    }

    /// Ignored items drop out after 30 days. Anything he acted on stays (it's
    /// a ranking signal); a dismissed item keeps its row but not its text.
    pub fn expire(&self, now: i64) -> Result<usize> {
        let cutoff = now - EXPIRE_AFTER;
        let expired = self
            .db
            .execute(
                "UPDATE items SET expired_at = ?1, content = NULL
                 WHERE expired_at IS NULL AND fetched_at < ?2 AND liked_at IS NULL AND note IS NULL
                   AND saved_path IS NULL AND dismissed_at IS NULL",
                params![now, cutoff],
            )
            .map_err(err)?;
        self.db
            .execute("UPDATE items SET content = NULL WHERE dismissed_at IS NOT NULL AND dismissed_at < ?1 AND content IS NOT NULL", [cutoff])
            .map_err(err)?;
        Ok(expired)
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
        let (source, _) = store.add_source("https://example.com/feed", SourceKind::Feed, Some("Example"), NOW).unwrap();
        store.insert_items(source.id, &[entry("a", Some(1)), entry("b", Some(1))], NOW, true).unwrap();
        let before = store.search_stamps().unwrap();
        assert_eq!(before.len(), 2);
        let a = before.iter().map(|i| i.0).find(|id| store.item(*id).unwrap().title.as_deref() == Some("a")).unwrap();
        let [title, from, _, _, content] = store.search_text(a).unwrap().unwrap();
        assert_eq!((title.as_deref(), from.as_deref()), (Some("a"), Some("Example")));
        assert_eq!(content.as_deref(), Some("Body of a"));
        store.set_full_text(a, Some("A much longer body of a"), NOW + 1).unwrap();
        let after = store.search_stamps().unwrap();
        assert_ne!(after.iter().find(|i| i.0 == a), before.iter().find(|i| i.0 == a));
        store.set_dismissed(a, true, NOW).unwrap();
        assert_eq!(store.search_stamps().unwrap().len(), 1);
        store.set_muted(source.id, true).unwrap();
        assert!(store.search_stamps().unwrap().is_empty());
    }

    #[test]
    fn newest_first_and_known_entries_are_not_duplicated() {
        let store = Store::memory();
        let (source, added) = store.add_source("https://example.com/feed", SourceKind::Feed, Some("Example"), NOW).unwrap();
        assert!(added);
        let entries = [entry("b", Some(2)), entry("a", Some(1)), entry("c", Some(3))];
        assert_eq!(store.insert_items(source.id, &entries, NOW, true).unwrap(), 3);
        assert_eq!(store.insert_items(source.id, &entries, NOW + 60, false).unwrap(), 0);
        let page = store.items(0, 10, None).unwrap();
        assert_eq!(page.total, 3);
        let titles: Vec<_> = page.items.iter().map(|i| i.title.clone().unwrap()).collect();
        assert_eq!(titles, ["a", "b", "c"]);
        assert_eq!(page.items[0].source_title.as_deref(), Some("Example"));
        assert!(page.items[0].has_content);
    }

    #[test]
    fn undated_entries_keep_feed_order() {
        let store = Store::memory();
        let (source, _) = store.add_source("https://example.com/feed", SourceKind::Feed, None, NOW).unwrap();
        store.insert_items(source.id, &[entry("first", None), entry("second", None)], NOW, true).unwrap();
        let titles: Vec<_> = store.items(0, 10, None).unwrap().items.into_iter().map(|i| i.title.unwrap()).collect();
        assert_eq!(titles, ["first", "second"]);
    }

    #[test]
    fn back_catalogue_starts_expired_except_a_few_on_first_fetch() {
        let store = Store::memory();
        let (source, _) = store.add_source("https://example.com/podcast", SourceKind::Podcast, None, NOW).unwrap();
        let old: Vec<_> = (0..6).map(|n| entry(&format!("old{n}"), Some(100 + n))).collect();
        assert_eq!(store.insert_items(source.id, &old, NOW, true).unwrap(), 3);
        assert_eq!(store.items(0, 10, None).unwrap().total, 3);
        // Later polls never bring the rest back, and new old entries start expired.
        assert_eq!(store.insert_items(source.id, &[entry("older", Some(200))], NOW, false).unwrap(), 0);
        assert_eq!(store.items(0, 10, None).unwrap().total, 3);
    }

    #[test]
    fn ignored_items_expire_after_thirty_days_but_acted_ones_stay() {
        let store = Store::memory();
        let (source, _) = store.add_source("https://example.com/feed", SourceKind::Feed, None, NOW).unwrap();
        let entries: Vec<_> = ["ignored", "liked", "noted", "dismissed"].iter().map(|g| entry(g, Some(0))).collect();
        store.insert_items(source.id, &entries, NOW, true).unwrap();
        let id = |title: &str| store.raw().query_row("SELECT id FROM items WHERE guid = ?1", [title], |r| r.get::<_, i64>(0)).unwrap();
        store.set_liked(id("liked"), true, NOW).unwrap();
        store.set_note(id("noted"), "Worth a post", NOW).unwrap();
        store.set_dismissed(id("dismissed"), true, NOW).unwrap();
        assert_eq!(store.expire(NOW + 29 * DAY).unwrap(), 0);
        assert_eq!(store.expire(NOW + 31 * DAY).unwrap(), 1);
        let left: Vec<_> = store.items(0, 10, None).unwrap().items.into_iter().map(|i| i.title.unwrap()).collect();
        assert_eq!(left.len(), 2);
        assert!(left.contains(&"liked".to_string()) && left.contains(&"noted".to_string()));
        // The expired item's text is gone, and a later poll doesn't revive it.
        assert_eq!(store.content(id("ignored")).unwrap(), None);
        assert_eq!(store.content(id("dismissed")).unwrap(), None);
        store.insert_items(source.id, &[entry("ignored", Some(0))], NOW + 32 * DAY, false).unwrap();
        assert_eq!(store.items(0, 10, None).unwrap().total, 2);
    }

    #[test]
    fn muted_and_removed_sources_leave_the_feed() {
        let store = Store::memory();
        let (source, _) = store.add_source("https://example.com/feed", SourceKind::Feed, None, NOW).unwrap();
        store.insert_items(source.id, &[entry("a", Some(0))], NOW, true).unwrap();
        assert!(store.set_muted(source.id, true).unwrap().muted);
        assert_eq!(store.items(0, 10, None).unwrap().total, 0);
        assert!(store.due(NOW, true).unwrap().is_empty(), "muted sources aren't polled");
        store.set_muted(source.id, false).unwrap();
        assert_eq!(store.items(0, 10, None).unwrap().total, 1);
        store.remove_source(source.id, NOW).unwrap();
        assert!(store.sources().unwrap().is_empty());
        assert_eq!(store.items(0, 10, None).unwrap().total, 0);
        // Subscribing again revives it with its history.
        let (again, added) = store.add_source("https://example.com/feed", SourceKind::Feed, None, NOW).unwrap();
        assert_eq!(again.id, source.id);
        assert!(added);
        assert_eq!(store.items(0, 10, None).unwrap().total, 1);
    }

    #[test]
    fn health_records_backoff_and_conditional_headers() {
        let store = Store::memory();
        let (source, _) = store.add_source("https://example.com/feed", SourceKind::Feed, None, NOW).unwrap();
        assert!(store.due(NOW, false).unwrap()[0].first);
        store.record_failure(source.id, NOW, Some(503), "HTTP 503", NOW + 300).unwrap();
        let failed = store.source(source.id).unwrap();
        assert_eq!((failed.failures, failed.last_error.as_deref(), failed.last_status), (1, Some("HTTP 503"), Some(503)));
        assert!(store.due(NOW + 10, false).unwrap().is_empty());
        let meta = SourceInfo { title: Some("Example blog".into()), ..Default::default() };
        store.record_success(source.id, NOW + 400, Some(r#"{"etag":"\"v1\""}"#), Some(&meta), NOW + 2200).unwrap();
        let healthy = store.source(source.id).unwrap();
        assert_eq!((healthy.failures, healthy.last_error, healthy.last_status, healthy.title.as_deref()), (0, None, None, Some("Example blog")));
        let due = store.due(NOW + 2200, false).unwrap();
        assert_eq!(due[0].cursor.as_deref(), Some(r#"{"etag":"\"v1\""}"#));
        assert!(!due[0].first);
    }

    #[test]
    fn the_event_log_is_append_only() {
        let store = Store::memory();
        store
            .log(&Event { at: 1, kind: "impression".into(), item_id: Some(7), surface: Some("newest".into()), position: Some(0), ..Default::default() })
            .unwrap();
        assert!(store.raw().execute("UPDATE events SET kind = 'like'", []).is_err());
        assert!(store.raw().execute("DELETE FROM events", []).is_err());
        assert_eq!(store.events().unwrap()[0].position, Some(0));
    }

    #[test]
    fn full_text_is_fetched_once_and_survives_later_polls() {
        let store = Store::memory();
        let (source, _) = store.add_source("https://example.com/feed", SourceKind::Feed, None, NOW).unwrap();
        store.insert_items(source.id, &[entry("a", Some(0))], NOW, true).unwrap();
        let id = store.items(0, 1, None).unwrap().items[0].id;
        assert!(!store.full_text_tried(id).unwrap());
        store.set_full_text(id, Some("The whole article."), NOW).unwrap();
        assert!(store.full_text_tried(id).unwrap());
        store.insert_items(source.id, &[entry("a", Some(0))], NOW + 60, false).unwrap();
        assert_eq!(store.content(id).unwrap().as_deref(), Some("The whole article."));
        // A failed fetch keeps the feed's text but isn't retried.
        store.insert_items(source.id, &[entry("b", Some(0))], NOW, false).unwrap();
        let other = store.items(0, 2, None).unwrap().items.into_iter().find(|i| i.id != id).unwrap().id;
        store.set_full_text(other, None, NOW).unwrap();
        assert_eq!(store.content(other).unwrap().as_deref(), Some("Body of b"));
        assert!(store.full_text_tried(other).unwrap());
    }

    #[test]
    fn save_ids_are_stable() {
        let store = Store::memory();
        let (source, _) = store.add_source("https://example.com/feed", SourceKind::Feed, None, NOW).unwrap();
        store.insert_items(source.id, &[entry("a", Some(0))], NOW, true).unwrap();
        let id = store.items(0, 1, None).unwrap().items[0].id;
        let first = store.save_id(id).unwrap();
        assert_eq!(first.len(), 36);
        assert_eq!(store.save_id(id).unwrap(), first);
    }
}
