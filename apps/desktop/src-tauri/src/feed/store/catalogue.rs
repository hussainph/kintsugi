//! Metadata-only older work, discovery state and a durable UTC-day release ledger.
//! Discovery supplies metadata; only local taste ranking chooses admissions.

use super::{NewItem, Result, Source, SourceKind, Store, err, params};
use kintsugi_ingest::{Url, web};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior};

const DAY: i64 = 86_400;

/// Only these adapters describe article archives. Other source kinds retain
/// their ordinary poll/expiry behaviour and are never discovered automatically.
pub(super) fn supported(kind: SourceKind) -> bool {
    matches!(kind, SourceKind::Feed | SourceKind::Page)
}

pub(super) fn url_key(raw: &str) -> Option<String> {
    let url = Url::parse(raw).ok()?;
    web::allowed_url(&url).then(|| web::canonical_url(&url).to_string())
}

pub(super) fn migrate(db: &Connection) -> Result<()> {
    let tx = db.unchecked_transaction().map_err(err)?;
    tx.execute_batch("
        ALTER TABLE sources ADD COLUMN catalogue_enabled INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE sources ADD COLUMN catalogue_state TEXT NOT NULL DEFAULT 'disabled';
        ALTER TABLE sources ADD COLUMN catalogue_error TEXT;
        ALTER TABLE sources ADD COLUMN suggested INTEGER NOT NULL DEFAULT 0;
        UPDATE sources SET catalogue_enabled = 1, catalogue_state = 'queued' WHERE kind IN ('feed', 'page');
        ALTER TABLE items ADD COLUMN back_catalogue INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE items ADD COLUMN catalogue_released_at INTEGER;
        ALTER TABLE items ADD COLUMN url_key TEXT;
        ALTER TABLE items ADD COLUMN suggestion_reason TEXT;
        ALTER TABLE items ADD COLUMN suggestion_anchor INTEGER REFERENCES items(id);
        CREATE INDEX items_url_key ON items(url_key);
        CREATE INDEX items_catalogue ON items(back_catalogue, catalogue_released_at);
        CREATE TABLE catalogue_releases (
          item_id INTEGER PRIMARY KEY REFERENCES items(id),
          day INTEGER NOT NULL,
          released_at INTEGER NOT NULL,
          suggested INTEGER NOT NULL
        );
        CREATE INDEX catalogue_releases_day ON catalogue_releases(day);
        CREATE TABLE catalogue_neighbours (
          url TEXT PRIMARY KEY,
          checked_at INTEGER NOT NULL
        );
        -- v1 marked stale-on-arrival entries expired at their fetch timestamp.
        -- They were never offered. Recover only that unobserved article history;
        -- actual expiry, dismissal and any human exposure remain decisions.
        UPDATE items SET back_catalogue = 1, expired_at = NULL,
          content = CASE WHEN full_text_at IS NULL THEN NULL ELSE content END
        WHERE expired_at = fetched_at AND sort_at < fetched_at - 2592000
          AND liked_at IS NULL AND note IS NULL AND saved_path IS NULL AND dismissed_at IS NULL
          AND source_id IN (SELECT id FROM sources WHERE kind IN ('feed', 'page'))
          AND NOT EXISTS (SELECT 1 FROM events e WHERE e.item_id = items.id AND e.kind <> 'kin_pick');
    ").map_err(err)?;
    // Do not merge or revive legacy rows: their full text and decisions belong
    // to their original identities, even if v1 had already duplicated a URL.
    let rows: Vec<(i64, String)> = {
        let mut statement = tx
            .prepare("SELECT id, url FROM items WHERE url IS NOT NULL")
            .map_err(err)?;
        statement
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(err)?
            .collect::<rusqlite::Result<_>>()
            .map_err(err)?
    };
    for (id, url) in rows {
        tx.execute(
            "UPDATE items SET url_key = ?2 WHERE id = ?1",
            params![id, url_key(&url)],
        )
        .map_err(err)?;
    }
    tx.pragma_update(None, "user_version", 2).map_err(err)?;
    tx.commit().map_err(err)
}

pub(super) fn known_item(
    db: &Connection,
    source: i64,
    guid: &str,
    url: Option<&str>,
) -> Result<Option<(i64, i64)>> {
    db.query_row(
        "SELECT id, source_id FROM items WHERE (source_id = ?1 AND guid = ?2) OR (?3 IS NOT NULL AND url_key = ?3)
         ORDER BY CASE WHEN source_id = ?1 AND guid = ?2 THEN 0 ELSE 1 END, id LIMIT 1",
        params![source, guid, url], |r| Ok((r.get(0)?, r.get(1)?)),
    ).optional().map_err(err)
}

/// A suggested candidate must still have a positive, linked anchor. Undoing
/// that action before release cannot introduce a recommendation on its behalf.
pub(super) const PENDING: &str = "i.back_catalogue = 1 AND i.catalogue_released_at IS NULL
    AND i.expired_at IS NULL AND i.dismissed_at IS NULL AND i.liked_at IS NULL AND i.note IS NULL AND i.saved_path IS NULL
    AND s.removed_at IS NULL AND s.muted = 0 AND s.catalogue_enabled = 1
    AND (s.suggested = 0 OR EXISTS (SELECT 1 FROM items a WHERE a.id = i.suggestion_anchor
      AND (a.liked_at IS NOT NULL OR a.note IS NOT NULL OR a.saved_path IS NOT NULL)))";

/// A positive item whose outgoing links can seed conservative neighbours.
#[derive(Clone, Debug)]
pub struct FavouriteLink {
    pub id: i64,
    pub title: String,
    pub url: String,
    pub content: String,
}

impl Store {
    /// Queued article sources. A claim is separate so discovery can run outside
    /// the normal polling lock. Interrupted claims are recovered on open.
    pub fn catalogue_pending_sources(&self) -> Result<Vec<Source>> {
        let mut statement = self.db.prepare(&format!(
            "SELECT {} FROM sources s WHERE s.removed_at IS NULL AND s.muted = 0 AND s.suggested = 0
             AND s.catalogue_enabled = 1 AND s.catalogue_state = 'queued' ORDER BY s.id", super::SOURCE_COLUMNS,
        )).map_err(err)?;
        statement
            .query_map([], super::source_row)
            .map_err(err)?
            .collect::<rusqlite::Result<_>>()
            .map_err(err)
    }

    pub fn due_catalogues(&self) -> Result<Vec<Source>> {
        self.catalogue_pending_sources()
    }

    pub fn queue_catalogue(&self, id: i64) -> Result<Source> {
        self.db
            .execute(
                "UPDATE sources SET catalogue_state = 'queued', catalogue_error = NULL
             WHERE id = ?1 AND removed_at IS NULL AND suggested = 0 AND catalogue_enabled = 1
               AND catalogue_state <> 'discovering'",
                [id],
            )
            .map_err(err)?;
        self.source(id)
    }

    pub fn retry_catalogue(&self, id: i64) -> Result<Source> {
        self.queue_catalogue(id)
    }

    pub fn start_catalogue(&self, id: i64) -> Result<bool> {
        self.db.execute(
            "UPDATE sources SET catalogue_state = 'discovering', catalogue_error = NULL
             WHERE id = ?1 AND removed_at IS NULL AND muted = 0 AND suggested = 0 AND catalogue_enabled = 1
               AND catalogue_state = 'queued'", [id],
        ).map(|n| n == 1).map_err(err)
    }

    pub fn finish_catalogue(&self, id: i64, error: Option<&str>) -> Result<Source> {
        self.db.execute(
            "UPDATE sources SET catalogue_state = CASE WHEN catalogue_enabled = 0 THEN 'disabled'
               WHEN ?2 IS NULL THEN 'ready' ELSE 'error' END, catalogue_error = ?2 WHERE id = ?1",
            params![id, error.map(|e| e.chars().take(600).collect::<String>())],
        ).map_err(err)?;
        self.source(id)
    }

    pub fn set_catalogue_enabled(&self, id: i64, enabled: bool) -> Result<Source> {
        let source = self.source(id)?;
        if enabled && !supported(source.kind) {
            return Err("This source has no back catalogue.".into());
        }
        self.db
            .execute(
                "UPDATE sources SET catalogue_enabled = ?2,
               catalogue_state = CASE WHEN NOT ?2 THEN 'disabled'
                 WHEN catalogue_state = 'disabled' THEN 'queued' ELSE catalogue_state END
             WHERE id = ?1 AND removed_at IS NULL AND suggested = 0",
                params![id, enabled],
            )
            .map_err(err)?;
        self.source(id)
    }

    /// Idempotent metadata insertion, even if an archive uses a different guid
    /// or another source already supplied the URL. Never overwrite user state,
    /// fetched text, original dates, or an earlier expired/dismissed decision.
    pub fn insert_catalogue_items(
        &self,
        source: i64,
        entries: &[NewItem],
        now: i64,
    ) -> Result<usize> {
        let source_kind = self
            .db
            .query_row("SELECT kind FROM sources WHERE id = ?1", [source], |r| {
                super::kind(r, 0)
            })
            .map_err(err)?;
        if !supported(source_kind) {
            return Ok(0);
        }
        let tx = self.db.unchecked_transaction().map_err(err)?;
        let added = insert_metadata(&tx, source, entries, now, None)?;
        tx.commit().map_err(err)?;
        Ok(added)
    }

    /// A cheap gate for newest-first reads: no ranking or embeddings when the
    /// day's quota is full, or only neighbours remain after their one slot.
    pub fn catalogue_release_due(&self, now: i64) -> Result<bool> {
        let (used, neighbours): (i64, i64) = self.db.query_row(
            "SELECT COUNT(*), COALESCE(SUM(suggested), 0) FROM catalogue_releases WHERE day = ?1",
            [now.div_euclid(DAY)], |r| Ok((r.get(0)?, r.get(1)?)),
        ).map_err(err)?;
        if used >= 2 {
            return Ok(false);
        }
        self.db
            .query_row(
                &format!(
                    "SELECT EXISTS (SELECT 1 FROM items i JOIN sources s ON s.id = i.source_id
                WHERE {PENDING} AND (?1 OR s.suggested = 0))"
                ),
                [neighbours < 1],
                |r| r.get(0),
            )
            .map_err(err)
    }

    /// IDs in taste order, independent of the requested batch size. Ledger
    /// slots are never refunded by hide/dismiss/unfollow, nor by a restart.
    pub fn release_catalogue(&self, ranked: &[i64], now: i64) -> Result<Vec<i64>> {
        let tx =
            Transaction::new_unchecked(&self.db, TransactionBehavior::Immediate).map_err(err)?;
        let day = now.div_euclid(DAY);
        let (used, mut neighbours): (i64, i64) = tx.query_row(
            "SELECT COUNT(*), COALESCE(SUM(suggested), 0) FROM catalogue_releases WHERE day = ?1",
            [day], |r| Ok((r.get(0)?, r.get(1)?)),
        ).map_err(err)?;
        let mut released = Vec::new();
        for id in ranked {
            if used + released.len() as i64 >= 2 {
                break;
            }
            let suggested: Option<bool> = tx.query_row(
                &format!("SELECT s.suggested FROM items i JOIN sources s ON s.id = i.source_id WHERE i.id = ?1 AND {PENDING}"),
                [id], |r| r.get(0),
            ).optional().map_err(err)?;
            let Some(suggested) = suggested else { continue };
            if suggested && neighbours >= 1 {
                continue;
            }
            tx.execute("INSERT INTO catalogue_releases (item_id, day, released_at, suggested) VALUES (?1, ?2, ?3, ?4)",
                params![id, day, now, suggested]).map_err(err)?;
            tx.execute(
                "UPDATE items SET catalogue_released_at = ?2 WHERE id = ?1",
                params![id, now],
            )
            .map_err(err)?;
            neighbours += i64::from(suggested);
            released.push(*id);
        }
        tx.commit().map_err(err)?;
        Ok(released)
    }

    pub fn catalogue_visible_ids(&self) -> Result<Vec<i64>> {
        let mut statement = self.db.prepare(&format!(
            "SELECT i.id FROM items i JOIN sources s ON s.id = i.source_id WHERE {} AND i.back_catalogue = 1 ORDER BY i.id",
            super::VISIBLE,
        )).map_err(err)?;
        statement
            .query_map([], |r| r.get(0))
            .map_err(err)?
            .collect::<rusqlite::Result<_>>()
            .map_err(err)
    }

    /// An undated archive entry can learn its real date on lazy full-text
    /// capture. Rediscovery never changes a date already supplied by metadata.
    pub fn set_original_date(&self, id: i64, published: Option<i64>) -> Result<()> {
        self.set_catalogue_metadata(id, None, None, published)
    }

    /// Lazy capture replaces slug-derived titles, fills a missing author and
    /// learns an unknown publication date. Dates already known remain exact.
    pub fn set_catalogue_metadata(
        &self,
        id: i64,
        title: Option<&str>,
        author: Option<&str>,
        published: Option<i64>,
    ) -> Result<()> {
        let title = title.map(str::trim).filter(|s| !s.is_empty());
        let author = author.map(str::trim).filter(|s| !s.is_empty());
        let url: Option<String> = self
            .db
            .query_row(
                "SELECT url FROM items WHERE id = ?1 AND back_catalogue = 1",
                [id],
                |r| r.get(0),
            )
            .optional()
            .map_err(err)?
            .flatten();
        let fallback = url.as_deref().and_then(url_title);
        self.db
            .execute(
                "UPDATE items SET title = CASE WHEN title IS NULL OR trim(title) = '' OR title = ?5
                   THEN COALESCE(?2, title) ELSE title END, author = COALESCE(author, ?3),
               sort_at = CASE WHEN published_at IS NULL AND ?4 IS NOT NULL THEN ?4 ELSE sort_at END,
               published_at = COALESCE(published_at, ?4)
             WHERE id = ?1 AND back_catalogue = 1",
                params![id, title, author, published, fallback],
            )
            .map_err(err)?;
        Ok(())
    }

    /// Offline fallback: hidden neighbours are Page sources, never a Feed
    /// pointing at a homepage. Retried Follow returns the already-followed row.
    pub fn follow_suggestion(&self, item: i64, now: i64) -> Result<Source> {
        let (url, kind): (String, SourceKind) = self
            .db
            .query_row(
                "SELECT s.url, s.kind FROM items i JOIN sources s ON s.id = i.source_id
             WHERE i.id = ?1 AND i.suggestion_reason IS NOT NULL AND s.removed_at IS NULL",
                [item],
                |r| Ok((r.get(0)?, super::kind(r, 1)?)),
            )
            .optional()
            .map_err(err)?
            .ok_or("No suggested source.")?;
        self.follow_suggestion_target(item, now, &url, kind)
    }

    /// Promote to a discovered feed, or retain the Page fallback. If that URL
    /// is followed already, merge ownership without losing item IDs, actions,
    /// full text or the immutable release/event history.
    pub fn follow_suggestion_target(
        &self,
        item: i64,
        now: i64,
        url: &str,
        kind: SourceKind,
    ) -> Result<Source> {
        if !supported(kind) {
            return Err("Invalid suggested source.".into());
        }
        let url = url_key(url).ok_or("Invalid suggested source.")?;
        let tx =
            Transaction::new_unchecked(&self.db, TransactionBehavior::Immediate).map_err(err)?;
        let (origin, suggested): (i64, bool) = tx
            .query_row(
                "SELECT s.id, s.suggested FROM items i JOIN sources s ON s.id = i.source_id
             WHERE i.id = ?1 AND i.suggestion_reason IS NOT NULL AND s.removed_at IS NULL",
                [item],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(err)?
            .ok_or("No suggested source.")?;
        if !suggested {
            tx.commit().map_err(err)?;
            return self.source(origin);
        }
        let target: Option<(i64, Option<i64>, bool)> = tx
            .query_row(
                "SELECT id, removed_at, suggested FROM sources WHERE url = ?1",
                [&url],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(err)?;
        if target
            .as_ref()
            .is_some_and(|(_, removed, _)| removed.is_some())
        {
            return Err("This source was unfollowed.".into());
        }
        let target_id = target.as_ref().map_or(origin, |t| t.0);
        if target_id != origin {
            // GUIDs are source-scoped. Different URLs can share an opaque
            // GUID; rename only that internal key when source ownership merges.
            let conflicts: Vec<i64> = {
                let mut statement = tx
                    .prepare(
                        "SELECT i.id FROM items i WHERE i.source_id = ?1
                    AND EXISTS (SELECT 1 FROM items t WHERE t.source_id = ?2 AND t.guid = i.guid)",
                    )
                    .map_err(err)?;
                statement
                    .query_map(params![origin, target_id], |r| r.get(0))
                    .map_err(err)?
                    .collect::<rusqlite::Result<_>>()
                    .map_err(err)?
            };
            for id in conflicts {
                tx.execute(
                    "UPDATE items SET guid = ?2 WHERE id = ?1",
                    params![
                        id,
                        format!("catalogue-follow:{}:{id}", uuid::Uuid::new_v4())
                    ],
                )
                .map_err(err)?;
            }
            tx.execute(
                "UPDATE items SET source_id = ?2 WHERE source_id = ?1",
                params![origin, target_id],
            )
            .map_err(err)?;
            tx.execute(
                "UPDATE sources SET removed_at = ?2 WHERE id = ?1",
                params![origin, now],
            )
            .map_err(err)?;
        }
        if target.as_ref().is_none_or(|t| t.2) {
            tx.execute(
                "UPDATE sources SET url = ?2, kind = ?3, suggested = 0, added_at = ?4, next_fetch_at = 0,
                   catalogue_state = CASE WHEN catalogue_enabled = 1 THEN 'queued' ELSE 'disabled' END WHERE id = ?1",
                params![target_id, url, kind.as_str(), now],
            ).map_err(err)?;
        } else {
            tx.execute(
                "UPDATE sources SET next_fetch_at = 0 WHERE id = ?1",
                [target_id],
            )
            .map_err(err)?;
        }
        tx.commit().map_err(err)?;
        self.source(target_id)
    }

    pub fn favourite_links(&self) -> Result<Vec<FavouriteLink>> {
        let mut statement = self.db.prepare(
            "SELECT id, COALESCE(title, url), url, content FROM items
             WHERE (liked_at IS NOT NULL OR note IS NOT NULL OR saved_path IS NOT NULL)
               AND dismissed_at IS NULL AND url IS NOT NULL AND content IS NOT NULL AND content <> ''
             ORDER BY MAX(COALESCE(liked_at, 0), COALESCE(note_at, 0), fetched_at) DESC, id DESC LIMIT 100",
        ).map_err(err)?;
        statement
            .query_map([], |r| {
                Ok(FavouriteLink {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    url: r.get(2)?,
                    content: r.get(3)?,
                })
            })
            .map_err(err)?
            .collect::<rusqlite::Result<_>>()
            .map_err(err)
    }

    pub fn neighbour_checked(&self, url: &str) -> Result<bool> {
        let key = url_key(url).ok_or("Invalid neighbour URL.")?;
        self.db
            .query_row(
                "SELECT 1 FROM catalogue_neighbours WHERE url = ?1",
                [key],
                |_| Ok(true),
            )
            .optional()
            .map(|r| r.unwrap_or(false))
            .map_err(err)
    }

    pub fn mark_neighbour_checked(&self, url: &str, now: i64) -> Result<()> {
        let key = url_key(url).ok_or("Invalid neighbour URL.")?;
        self.db
            .execute(
                "INSERT OR IGNORE INTO catalogue_neighbours (url, checked_at) VALUES (?1, ?2)",
                params![key, now],
            )
            .map_err(err)?;
        Ok(())
    }

    /// One explicit link from a kept item, not a graph crawl. Hidden sources
    /// are excluded from subscriptions and normal polling until Follow.
    pub fn insert_suggested_catalogue(
        &self,
        source_url: &str,
        title: Option<&str>,
        positive_item: i64,
        entries: &[NewItem],
        now: i64,
    ) -> Result<usize> {
        let source_url = url_key(source_url).ok_or("Invalid neighbour URL.")?;
        let anchor = self
            .favourite_links()?
            .into_iter()
            .find(|a| a.id == positive_item)
            .ok_or("No positive linked item.")?;
        if !links_to(&anchor.content, &source_url) {
            return Err("No link to this source.".into());
        }
        let tx = self.db.unchecked_transaction().map_err(err)?;
        let existing: Option<(i64, bool, Option<i64>)> = tx
            .query_row(
                "SELECT id, suggested, removed_at FROM sources WHERE url = ?1",
                [&source_url],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(err)?;
        let source = match existing {
            Some((id, true, None)) => id,
            // Do not bypass an explicit unfollow, nor suggest a followed source.
            Some(_) => return Ok(0),
            None => {
                tx.execute("INSERT INTO sources (url, kind, title, added_at, suggested, catalogue_enabled, catalogue_state)
                    VALUES (?1, 'page', ?2, ?3, 1, 1, 'ready')", params![source_url, title, now]).map_err(err)?;
                tx.last_insert_rowid()
            }
        };
        let reason = format!(
            "Linked from {}",
            anchor.title.chars().take(160).collect::<String>()
        );
        // A neighbour is a small sample, never its entire archive.
        let entries = &entries[..entries.len().min(3)];
        let added = insert_metadata(&tx, source, entries, now, Some((&reason, positive_item)))?;
        tx.commit().map_err(err)?;
        Ok(added)
    }
}

fn insert_metadata(
    tx: &Transaction<'_>,
    source: i64,
    entries: &[NewItem],
    now: i64,
    suggestion: Option<(&str, i64)>,
) -> Result<usize> {
    let mut added = 0;
    for entry in entries {
        let Some(key) = entry.url.as_deref().and_then(url_key) else {
            continue;
        };
        if entry.title.as_deref().is_none_or(|t| t.trim().is_empty())
            || entry.published_at.is_some_and(|date| date > now)
        {
            continue;
        }
        if known_item(tx, source, &entry.guid, Some(&key))?.is_some() {
            continue;
        }
        added += tx.execute(
            "INSERT INTO items (source_id, guid, url, url_key, title, author, summary, image, media,
               published_at, fetched_at, sort_at, back_catalogue, suggestion_reason, suggestion_anchor)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 1, ?13, ?14)",
            params![source, entry.guid, entry.url, key, entry.title, entry.author, entry.summary, entry.image,
                if entry.media.is_empty() { "article" } else { entry.media }, entry.published_at, now,
                entry.published_at.unwrap_or(now), suggestion.map(|s| s.0), suggestion.map(|s| s.1)],
        ).map_err(err)?;
    }
    Ok(added)
}

/// Match ingest's sitemap URL-title fallback, not a publisher's real title.
/// Keep this local so lazy capture cannot replace authoritative titles with SEO.
fn url_title(raw: &str) -> Option<String> {
    let url = Url::parse(raw).ok()?;
    let slug = url
        .path()
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("");
    let slug = slug
        .strip_suffix(".html")
        .or_else(|| slug.strip_suffix(".htm"))
        .unwrap_or(slug);
    let flat = slug
        .replace(['-', '_'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    Some(
        flat.chars()
            .filter(|c| !matches!(c, '[' | ']' | '<' | '>'))
            .take(300)
            .collect(),
    )
}

fn links_to(content: &str, target: &str) -> bool {
    let Ok(target) = Url::parse(target) else {
        return false;
    };
    content
        .split(|c: char| c.is_whitespace() || "()<>[]\"'".contains(c))
        .any(|word| {
            Url::parse(word.trim_end_matches([',', ';', '.']))
                .is_ok_and(|url| web::allowed_url(&url) && url.origin() == target.origin())
        })
}

#[cfg(test)]
#[path = "catalogue_tests.rs"]
mod tests;
