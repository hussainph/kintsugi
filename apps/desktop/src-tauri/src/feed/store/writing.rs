//! News or writing (KI-105). The classifier (`kintsugi_rank::writing`)
//! reads each source and item locally; this keeps what it decided, the
//! per-source switch ("Group with other coverage"), takes writing out of
//! any story it was grouped into, and links writing to news about the same
//! thing (`coverage`).

use super::{GROUPABLE, Result, Source, SourceKind, Store, VISIBLE, err};
use kintsugi_rank::writing::{self, Signals, SourceItem};
use rusqlite::params;
use serde::Serialize;

/// How many of a source's newest items say what kind of source it is.
const RECENT: usize = 40;
/// Excerpts stop here.
const EXCERPT_CHARS: usize = 600;
/// A paragraph shorter than this (a byline, a caption) isn't the opening.
const OPENING_CHARS: usize = 80;

/// News about the same thing as a piece of writing: a link in its reader.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Coverage {
    pub id: i64,
    pub title: String,
    pub source: String,
    /// The story it's in, when that's shown as a story.
    pub story: Option<i64>,
}

/// Whether a source groups: his switch, else Hacker News and news sites.
fn groups(kind: SourceKind, grouping: Option<bool>, personal: Option<bool>) -> bool {
    grouping.unwrap_or(match kind {
        SourceKind::Hn => true,
        SourceKind::Feed => personal == Some(false),
        _ => false,
    })
}

/// The author's own opening: the first paragraph of prose in the item's
/// Markdown (not a heading, picture, quote, list, table or code), as plain
/// text, cut at a word near [`EXCERPT_CHARS`].
pub fn excerpt(markdown: &str) -> Option<String> {
    let mut first: Option<String> = None;
    for block in markdown.split("\n\n") {
        let block = block.trim();
        let skip = block.is_empty()
            || block.starts_with(['#', '>', '|', '<'])
            || block.starts_with("```")
            || block.starts_with("- ")
            || block.starts_with("* ")
            || block.starts_with("![")
            || block.starts_with("[![")
            || numbered(block)
            // hnrss's own lines.
            || ["Article URL:", "Comments URL:", "Points:", "\\# Comments:"].iter().any(|p| block.starts_with(p));
        if skip {
            continue;
        }
        let text = super::super::stories::plain(block)
            .replace("**", "")
            .replace("__", "")
            .replace('`', "");
        let text = text.trim_matches(|c: char| c == '*' || c == '_' || c.is_whitespace());
        if text.is_empty() {
            continue;
        }
        if text.chars().count() >= OPENING_CHARS {
            return Some(cut(text));
        }
        first.get_or_insert_with(|| cut(text));
    }
    first
}

/// A link's host, without `www.`.
fn host(url: &str) -> Option<String> {
    let rest = url.split_once("://")?.1;
    let host = rest
        .split(['/', '?', '#'])
        .next()?
        .trim_start_matches("www.");
    (!host.is_empty()).then(|| host.to_lowercase())
}

/// "1. First": an ordered list.
fn numbered(block: &str) -> bool {
    block
        .split_once(". ")
        .is_some_and(|(n, _)| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
}

fn cut(text: &str) -> String {
    if text.chars().count() <= EXCERPT_CHARS {
        return text.to_string();
    }
    let head: String = text.chars().take(EXCERPT_CHARS).collect();
    let end = head.rfind(' ').unwrap_or(head.len());
    format!("{}…", head[..end].trim_end_matches([',', ';', ':', ' ']))
}

impl Store {
    /// Reads one source and its items again: which items are writing, and
    /// whether the source is personal. Returns whether anything changed.
    fn classify(&self, id: i64) -> Result<bool> {
        let (kind, title, site, grouping, personal): (
            String,
            Option<String>,
            String,
            Option<bool>,
            Option<bool>,
        ) = self
            .db
            .query_row(
                "SELECT kind, title, COALESCE(site_url, url), grouping, personal FROM sources WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .map_err(err)?;
        let kind = SourceKind::parse(&kind).unwrap_or(SourceKind::Feed);
        let before = groups(kind, grouping, personal);
        // An HN link to a site he follows that doesn't group (a personal
        // blog) is that author's writing.
        let personal_hosts: Vec<String> = if kind == SourceKind::Hn {
            let mut statement = self
                .db
                .prepare_cached(&format!(
                    "SELECT COALESCE(s.site_url, s.url) FROM sources s
                     WHERE s.removed_at IS NULL AND s.kind <> 'hn' AND {} = 0",
                    groups!()
                ))
                .map_err(err)?;
            statement
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(err)?
                .filter_map(|u| u.ok().as_deref().and_then(host))
                .collect()
        } else {
            Vec::new()
        };
        let mut statement = self
            .db
            .prepare_cached(
                "SELECT id, author, COALESCE(NULLIF(content, ''), summary, ''), sort_at, writing, url FROM items
                 WHERE source_id = ?1 AND expired_at IS NULL ORDER BY sort_at DESC, id DESC",
            )
            .map_err(err)?;
        let rows: Vec<(i64, Option<String>, String, i64, bool, Option<String>)> = statement
            .query_map([id], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            })
            .map_err(err)?
            .collect::<rusqlite::Result<_>>()
            .map_err(err)?;
        let mut changed = false;
        let mut recent = Vec::new();
        for (item, author, text, published, was, url) in rows {
            let signals = Signals::read(author.as_deref(), &text, title.as_deref(), &site);
            let linked = url
                .as_deref()
                .and_then(host)
                .is_some_and(|h| personal_hosts.contains(&h));
            let now = signals.writing() || linked;
            if now != was {
                changed = true;
                // News again: clustering looks at it afresh.
                self.db
                    .execute(
                        "UPDATE items SET writing = ?2, clustered_at = CASE WHEN ?2 THEN clustered_at END WHERE id = ?1",
                        params![item, now],
                    )
                    .map_err(err)?;
            }
            if recent.len() < RECENT {
                recent.push(SourceItem {
                    author,
                    signals,
                    published,
                });
            }
        }
        let personal_now = match kind {
            SourceKind::Feed if !recent.is_empty() => Some(writing::personal(&recent)),
            _ => personal,
        };
        if personal_now != personal {
            changed = true;
            self.db
                .execute(
                    "UPDATE sources SET personal = ?2 WHERE id = ?1",
                    params![id, personal_now],
                )
                .map_err(err)?;
        }
        if groups(kind, grouping, personal_now) && !before {
            self.cluster_again(id)?;
        }
        Ok(changed)
    }

    /// Reads a source again after a poll or a full article, and takes any
    /// writing out of stories. Hacker News is read again too: its links to
    /// a personal blog are that blog's writing. Returns whether anything
    /// changed.
    pub fn classify_source(&self, id: i64, now: i64) -> Result<bool> {
        let tx = self.db.unchecked_transaction().map_err(err)?;
        let mut changed = self.classify(id)?;
        for hn in self.hn_sources(id)? {
            changed |= self.classify(hn)?;
        }
        let ungrouped = self.ungroup(now)?;
        tx.commit().map_err(err)?;
        Ok(changed || ungrouped > 0)
    }

    fn hn_sources(&self, except: i64) -> Result<Vec<i64>> {
        let mut statement = self
            .db
            .prepare_cached(
                "SELECT id FROM sources WHERE kind = 'hn' AND removed_at IS NULL AND id <> ?1",
            )
            .map_err(err)?;
        statement
            .query_map([except], |r| r.get(0))
            .map_err(err)?
            .collect::<rusqlite::Result<_>>()
            .map_err(err)
    }

    /// Every source (the version 4 migration).
    pub(super) fn classify_all(&self, now: i64) -> Result<()> {
        let ids: Vec<i64> = {
            let mut statement = self.db.prepare("SELECT id FROM sources").map_err(err)?;
            statement
                .query_map([], |r| r.get(0))
                .map_err(err)?
                .collect::<rusqlite::Result<_>>()
                .map_err(err)?
        };
        let tx = self.db.unchecked_transaction().map_err(err)?;
        // Hacker News last: it reads the others' kinds.
        let hn = self.hn_sources(0)?;
        for id in ids.iter().filter(|id| !hn.contains(id)).chain(&hn) {
            self.classify(*id)?;
        }
        self.ungroup(now)?;
        tx.commit().map_err(err)
    }

    /// A source's ungrouped news is placed by clustering again.
    fn cluster_again(&self, source: i64) -> Result<()> {
        self.db
            .execute(
                "UPDATE items SET clustered_at = NULL WHERE source_id = ?1 AND story_id IS NULL AND writing = 0",
                [source],
            )
            .map_err(err)?;
        Ok(())
    }

    /// Takes every item that may not group (writing, or from a source that
    /// doesn't) out of its story. The stories it left lose Kin's summary,
    /// which read it, and are summarised again from the news that stays.
    /// The items are placed again, to find the news they're related to.
    /// Returns how many stories changed.
    pub fn ungroup(&self, now: i64) -> Result<usize> {
        let stray = format!(
            "SELECT i.id FROM items i JOIN sources s ON s.id = i.source_id
             WHERE i.story_id IS NOT NULL AND NOT {GROUPABLE}"
        );
        let affected: Vec<i64> = {
            let mut statement = self
                .db
                .prepare(&format!(
                    "SELECT DISTINCT story_id FROM items WHERE id IN ({stray})"
                ))
                .map_err(err)?;
            statement
                .query_map([], |r| r.get(0))
                .map_err(err)?
                .collect::<rusqlite::Result<_>>()
                .map_err(err)?
        };
        if affected.is_empty() {
            return Ok(0);
        }
        self.db
            .execute(
                &format!(
                    "UPDATE items SET story_id = NULL, clustered_at = NULL WHERE id IN ({stray})"
                ),
                [],
            )
            .map_err(err)?;
        for story in &affected {
            self.db
                .execute(
                    "UPDATE stories SET title = NULL, summary = NULL, summary_state = 'pending',
                       summary_items = 0, summary_attempts = 0, updated_at = ?2 WHERE id = ?1",
                    params![story, now],
                )
                .map_err(err)?;
        }
        Ok(affected.len())
    }

    /// "Group with other coverage" for one source. Matching the
    /// classifier's choice forgets his, so the source follows it again.
    pub fn set_grouping(&self, id: i64, enabled: bool, now: i64) -> Result<Source> {
        let source = self.source(id)?;
        let tx = self.db.unchecked_transaction().map_err(err)?;
        self.db
            .execute(
                "UPDATE sources SET grouping = ?2 WHERE id = ?1",
                params![id, (enabled != source.grouping_default).then_some(enabled)],
            )
            .map_err(err)?;
        if enabled {
            self.cluster_again(id)?;
        } else {
            self.ungroup(now)?;
        }
        tx.commit().map_err(err)?;
        self.source(id)
    }

    /// Keeps (writing, news) pairs about the same thing.
    pub fn add_coverage(&self, pairs: &[(i64, i64)]) -> Result<()> {
        for (writing, news) in pairs {
            self.db
                .execute(
                    "INSERT OR IGNORE INTO coverage (writing_id, news_id) VALUES (?1, ?2)",
                    params![writing, news],
                )
                .map_err(err)?;
        }
        Ok(())
    }

    /// News in the Feed about the same thing as a piece of writing, newest
    /// first, one per source.
    pub fn coverage(&self, id: i64) -> Result<Vec<Coverage>> {
        let mut statement = self
            .db
            .prepare_cached(&format!(
                "SELECT i.id, COALESCE(i.title, ''), COALESCE(s.title, s.url), i.story_id, s.id
                 FROM coverage c JOIN items i ON i.id = c.news_id JOIN sources s ON s.id = i.source_id
                 WHERE c.writing_id = ?1 AND {VISIBLE} AND {GROUPABLE}
                 ORDER BY i.sort_at DESC, i.id DESC"
            ))
            .map_err(err)?;
        let rows: Vec<(i64, String, String, Option<i64>, i64)> = statement
            .query_map([id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .map_err(err)?
            .collect::<rusqlite::Result<_>>()
            .map_err(err)?;
        let mut seen = Vec::new();
        let mut out = Vec::new();
        for (news, title, source, story, source_id) in rows {
            if seen.contains(&source_id) {
                continue;
            }
            seen.push(source_id);
            out.push(Coverage {
                id: news,
                title,
                source,
                story: story.filter(|s| self.story(*s).is_ok()),
            });
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000;

    /// A KI-94 database (version 3) where an essay from a personal blog was
    /// grouped (and summarised) with two news reports: opening it takes the
    /// essay out, and Kin's summary, which read it, goes too.
    #[test]
    fn version_three_stories_lose_the_writing_grouped_into_them() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("feed.sqlite");
        {
            let db = rusqlite::Connection::open(&path).unwrap();
            db.execute_batch(&format!(
                "BEGIN; {} PRAGMA user_version = 1; COMMIT;",
                super::super::SCHEMA
            ))
            .unwrap();
            super::super::catalogue::migrate(&db).unwrap();
            db.execute_batch(&format!(
                "BEGIN; {} PRAGMA user_version = 3; COMMIT;",
                super::super::STORIES
            ))
            .unwrap();
            let essay = "I read the quarter the way I read my own books. My studio is tiny, and I learned more from it than from my own spreadsheets. I keep thinking about my prices.";
            db.execute_batch(&format!(
                "INSERT INTO sources (url, kind, title, added_at) VALUES
                   ('https://maraito.example/feed.atom', 'feed', 'Mara Ito', 1),
                   ('https://ledger.example/feed/', 'feed', 'The Ledger', 1),
                   ('https://orchard.example/feed/', 'feed', 'Orchard Daily', 1);
                 INSERT INTO stories (id, title, summary, summary_state, summary_items, summary_attempts, created_at, updated_at)
                   VALUES (7, 'Apple''s quarter', '{{\"paragraphs\":[[{{\"text\":\"Mara learned a lot.\",\"cites\":[1]}}]]}}', 'ready', 5, 1, 1, 1);
                 INSERT INTO items (source_id, guid, title, author, content, fetched_at, sort_at, story_id, clustered_at) VALUES
                   (1, 'e', 'What Apple taught me', 'Mara Ito', '{essay}', {NOW}, {NOW}, 7, {NOW}),
                   (2, 'a', 'Apple reports Q4', 'Priya Raman', 'CUPERTINO, Calif. — Apple reported revenue.', {NOW}, {NOW}, 7, {NOW}),
                   (2, 'b', 'Meta ends Quest 2 updates', 'Tom Okafor', 'MENLO PARK — Meta said.', {NOW}, {NOW}, NULL, {NOW}),
                   (2, 'c', 'Oil slips', 'Lena Fischer', 'LONDON (Reuters) - Oil fell.', {NOW}, {NOW}, NULL, {NOW}),
                   (3, 'd', 'Apple sets an iPhone record', 'Chance Miller', 'Revenue was $114.5 billion.', {NOW}, {NOW}, 7, {NOW}),
                   (3, 'f', 'iOS 27.2 beta', 'Zac Hall', 'A third beta.', {NOW}, {NOW}, NULL, {NOW}),
                   (3, 'g', 'MagSafe stands', 'Ryan Christoffel', 'Stands.', {NOW}, {NOW}, NULL, {NOW});"
            ))
            .unwrap();
        }
        let store = Store::open(&path).unwrap();
        let version: i64 = store
            .raw()
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, 4);
        let essay = store.item(1).unwrap();
        assert!(essay.writing);
        assert_eq!(essay.story_id, None, "the essay leaves its story");
        assert_eq!(store.item(2).unwrap().story_id, Some(7));
        assert_eq!(store.item(5).unwrap().story_id, Some(7));
        let story = store.story(7).unwrap();
        assert!(
            story.summary.is_none(),
            "the summary that read the essay is gone"
        );
        assert_eq!(story.summary_state, super::super::SummaryState::Pending);
        assert_eq!(story.items.len(), 2);
        // Due again, from the news alone, and the essay waits to find its coverage.
        let due = store.summaries_due().unwrap();
        assert!(
            due.iter()
                .any(|j| j.id == 7 && j.articles.iter().all(|a| a.0 != 1))
        );
        assert!(store.unclustered().unwrap() >= 1);
        let sources = store.sources().unwrap();
        let mara = sources
            .iter()
            .find(|s| s.title.as_deref() == Some("Mara Ito"))
            .unwrap();
        assert!(!mara.grouping && !mara.grouping_default);
        let ledger = sources
            .iter()
            .find(|s| s.title.as_deref() == Some("The Ledger"))
            .unwrap();
        assert!(ledger.grouping);
    }

    #[test]
    fn the_excerpt_is_the_first_paragraph_of_prose() {
        let md = "# A heading\n\n![A bowl](https://x.example/b.png)\n\nBy Mara\n\nI spent the weekend mending a **cracked** bowl, and [the lacquer](https://x.example/l) took three days to cure between coats.\n\nSecond paragraph.";
        assert_eq!(
            excerpt(md).as_deref(),
            Some(
                "I spent the weekend mending a cracked bowl, and the lacquer took three days to cure between coats."
            )
        );
        assert_eq!(
            excerpt("Short one.\n\n- a list").as_deref(),
            Some("Short one.")
        );
        assert_eq!(excerpt("## Only a heading"), None);
        let long = format!("{} end", "word ".repeat(200));
        let cut = excerpt(&long).unwrap();
        assert!(cut.ends_with('…') && cut.chars().count() <= EXCERPT_CHARS + 1);
    }
}
