//! Stories (KI-94): items about the same thing from different sources.
//! Clustering (`kintsugi_rank::stories`) decides; this keeps its decisions,
//! folds stories into the Newest list, and holds Kin's summaries.
//!
//! A cluster is shown as a story only while its visible items span two or
//! more sources. Otherwise its items read as plain items.

use super::{ITEM_COLUMNS, Item, Result, Store, VISIBLE, err, item_row};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// A story is summarised at most this many times (once, then again as
/// sources join).
pub const MAX_SUMMARIES: i64 = 3;
/// What the summariser reads of each article.
const EXCERPT_CHARS: usize = 1_200;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SummaryState {
    /// Not written yet, or due again because a source joined.
    Pending,
    Ready,
    /// The model answered with nothing usable; the lead article stands in.
    Failed,
    /// This month's AI limit is reached; it waits.
    Capped,
    /// No AI provider is set up.
    Unavailable,
}

impl SummaryState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Ready => "ready",
            Self::Failed => "failed",
            Self::Capped => "capped",
            Self::Unavailable => "unavailable",
        }
    }
    fn parse(text: &str) -> Self {
        match text {
            "ready" => Self::Ready,
            "failed" => Self::Failed,
            "capped" => Self::Capped,
            "unavailable" => Self::Unavailable,
            _ => Self::Pending,
        }
    }
}

/// One sentence of a summary and the items it came from.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Sentence {
    pub text: String,
    pub cites: Vec<i64>,
}

/// Kin's summary of a story: paragraphs of cited sentences.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Summary {
    pub paragraphs: Vec<Vec<Sentence>>,
}

/// A source in a story, with how many of its items are in it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorySource {
    pub id: i64,
    pub title: Option<String>,
    pub kind: super::SourceKind,
    pub site: Option<String>,
    pub items: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Story {
    pub id: i64,
    /// Kin's title once summarised, else the lead article's.
    pub title: String,
    /// Only when ready.
    pub summary: Option<Summary>,
    pub summary_state: SummaryState,
    /// The article it falls back to: the first to cover it.
    pub lead: Item,
    /// The lead's picture, else the first item's that has one.
    pub image: Option<String>,
    /// Its items in the Feed: the lead first, then newest first.
    pub items: Vec<Item>,
    /// Most items first.
    pub sources: Vec<StorySource>,
    /// Its newest item's.
    pub sort_at: i64,
    pub updated_at: i64,
}

/// One entry of the Newest list.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Entry {
    Item { item: Item },
    Story { story: Story },
}

/// What the summariser needs: the story's items as numbered articles.
#[derive(Clone, Debug, PartialEq)]
pub struct SummaryJob {
    pub id: i64,
    /// (item id, title, source, the start of its text)
    pub articles: Vec<(i64, String, String, String)>,
    /// Kin's summary so far, kept if a later one fails.
    pub has_summary: bool,
}

/// What came of summarising.
pub enum Outcome {
    Ready {
        title: Option<String>,
        summary: Summary,
        model: String,
        cost: f64,
    },
    Failed {
        model: Option<String>,
        cost: f64,
    },
    Capped,
    Unavailable,
}

impl Store {
    /// Keeps clustering's decisions: `joins` are (item, story) pairs, with
    /// negative story keys for new stories; every item in `placed` is marked
    /// as clustered, joined or not. Returns the joins with real story ids.
    pub fn assign_stories(
        &self,
        placed: &[i64],
        joins: &[(i64, i64)],
        now: i64,
    ) -> Result<Vec<(i64, i64)>> {
        let tx = self.db.unchecked_transaction().map_err(err)?;
        let mut keys: HashMap<i64, i64> = HashMap::new();
        let mut changed = Vec::new();
        let mut resolved = Vec::new();
        for &(item, key) in joins {
            let story = match keys.get(&key) {
                Some(&id) => id,
                None if key < 0 => {
                    tx.execute(
                        "INSERT INTO stories (created_at, updated_at) VALUES (?1, ?1)",
                        [now],
                    )
                    .map_err(err)?;
                    let id = tx.last_insert_rowid();
                    keys.insert(key, id);
                    id
                }
                None => key,
            };
            tx.execute(
                "UPDATE items SET story_id = ?2 WHERE id = ?1",
                params![item, story],
            )
            .map_err(err)?;
            resolved.push((item, story));
            if !changed.contains(&story) {
                changed.push(story);
            }
        }
        for story in &changed {
            tx.execute(
                "UPDATE stories SET updated_at = ?2 WHERE id = ?1",
                params![story, now],
            )
            .map_err(err)?;
        }
        for item in placed {
            tx.execute(
                "UPDATE items SET clustered_at = ?2 WHERE id = ?1",
                params![item, now],
            )
            .map_err(err)?;
        }
        tx.commit().map_err(err)?;
        Ok(resolved)
    }

    /// Visible items clustering hasn't placed yet.
    pub fn unclustered(&self) -> Result<i64> {
        self.db
            .query_row(
                &format!("SELECT COUNT(*) FROM items i JOIN sources s ON s.id = i.source_id WHERE {VISIBLE} AND i.clustered_at IS NULL"),
                [],
                |r| r.get(0),
            )
            .map_err(err)
    }

    /// Visible items, newest first: (id, story, source).
    fn visible_order(&self) -> Result<Vec<(i64, Option<i64>, i64)>> {
        let mut statement = self
            .db
            .prepare_cached(&format!(
                // As `items` places them (KI-95): released older writing by
                // when it was released, at most two of it.
                "SELECT i.id, i.story_id, i.source_id FROM items i JOIN sources s ON s.id = i.source_id
                 WHERE {VISIBLE} AND (i.back_catalogue = 0 OR i.id IN (
                   SELECT i.id FROM items i JOIN sources s ON s.id = i.source_id
                   WHERE {VISIBLE} AND i.back_catalogue = 1
                   ORDER BY i.catalogue_released_at DESC, i.id DESC LIMIT 2))
                 ORDER BY CASE WHEN i.back_catalogue = 1 THEN i.catalogue_released_at ELSE i.sort_at END DESC,
                   i.id DESC"
            ))
            .map_err(err)?;
        let rows = statement
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(err)?;
        rows.collect::<rusqlite::Result<_>>().map_err(err)
    }

    /// The Newest list with each story folded into one entry, at its newest
    /// item. Returns the page and how many entries there are.
    pub fn entries(&self, offset: usize, limit: usize) -> Result<(Vec<Entry>, usize)> {
        let order = self.visible_order()?;
        let stories = kintsugi_rank::stories::multi_source(order.iter().copied());
        let mut seen = std::collections::HashSet::new();
        let keys: Vec<(bool, i64)> = order
            .into_iter()
            .filter_map(
                |(id, story, _)| match story.filter(|s| stories.contains_key(s)) {
                    Some(story) => seen.insert(story).then_some((true, story)),
                    None => Some((false, id)),
                },
            )
            .collect();
        let total = keys.len();
        let mut page = Vec::new();
        for (is_story, id) in keys.into_iter().skip(offset).take(limit) {
            page.push(if is_story {
                Entry::Story {
                    story: self.story(id)?,
                }
            } else {
                Entry::Item {
                    item: self.item(id)?,
                }
            });
        }
        Ok((page, total))
    }

    /// The story an item stands for, if its cluster is one now.
    pub fn story_of(&self, item: &Item) -> Result<Option<Story>> {
        match item.story_id {
            Some(id) => Ok(self.story(id).ok()),
            None => Ok(None),
        }
    }

    /// A story with its visible items. Not a story (gone, or down to one
    /// source) is an error.
    pub fn story(&self, id: i64) -> Result<Story> {
        let mut statement = self
            .db
            .prepare_cached(&format!(
                "SELECT {ITEM_COLUMNS} FROM items i JOIN sources s ON s.id = i.source_id
                 WHERE i.story_id = ?1 AND {VISIBLE} ORDER BY i.sort_at, i.id"
            ))
            .map_err(err)?;
        let mut items: Vec<Item> = statement
            .query_map([id], item_row)
            .map_err(err)?
            .collect::<rusqlite::Result<_>>()
            .map_err(err)?;
        let mut sources: Vec<StorySource> = Vec::new();
        for item in &items {
            match sources.iter_mut().find(|s| s.id == item.source_id) {
                Some(source) => source.items += 1,
                None => sources.push(StorySource {
                    id: item.source_id,
                    title: item.source_title.clone(),
                    kind: item.source_kind,
                    site: item.source_site.clone(),
                    items: 1,
                }),
            }
        }
        if sources.len() < 2 {
            return Err("no such story".into());
        }
        sources.sort_by(|a, b| b.items.cmp(&a.items));
        let row: (Option<String>, Option<String>, String, i64) = self
            .db
            .query_row(
                "SELECT title, summary, summary_state, updated_at FROM stories WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .map_err(err)?;
        let (title, summary, state, updated_at) = row;
        let lead = items.remove(0);
        let sort_at = items
            .iter()
            .map(|i| i.sort_at)
            .max()
            .unwrap_or(lead.sort_at)
            .max(lead.sort_at);
        items.sort_by(|a, b| b.sort_at.cmp(&a.sort_at).then(b.id.cmp(&a.id)));
        items.insert(0, lead.clone());
        let image = items.iter().find_map(|i| i.image.clone());
        let visible: Vec<i64> = items.iter().map(|i| i.id).collect();
        let summary = summary
            .and_then(|s| serde_json::from_str::<Summary>(&s).ok())
            .map(|mut s| {
                // A cited item he has since dismissed is no longer linked.
                for sentence in s.paragraphs.iter_mut().flatten() {
                    sentence.cites.retain(|c| visible.contains(c));
                }
                s
            });
        let state = SummaryState::parse(&state);
        // A summary written before a source joined still reads; the new one
        // follows.
        let summary = summary.filter(|s| !s.paragraphs.is_empty());
        let title = summary
            .as_ref()
            .and(title)
            .unwrap_or_else(|| lead.title.clone().unwrap_or_default());
        Ok(Story {
            id,
            title,
            summary_state: if summary.is_some() {
                SummaryState::Ready
            } else {
                state
            },
            summary,
            image,
            lead,
            items,
            sources,
            sort_at,
            updated_at,
        })
    }

    /// Stories due a summary: shown as stories (two sources or more), not
    /// summarised since their last item joined, and summarised fewer than
    /// [`MAX_SUMMARIES`] times. Those that waited on the cap or a provider
    /// are due again.
    pub fn summaries_due(&self) -> Result<Vec<SummaryJob>> {
        let order = self.visible_order()?;
        let shown = kintsugi_rank::stories::multi_source(order.iter().copied());
        let mut counts: HashMap<i64, i64> = HashMap::new();
        for (_, story, _) in &order {
            if let Some(story) = story.filter(|s| shown.contains_key(s)) {
                *counts.entry(story).or_default() += 1;
            }
        }
        let mut due = Vec::new();
        let mut ids: Vec<i64> = shown.keys().copied().collect();
        ids.sort();
        for id in ids {
            let (items, attempts, has_summary): (i64, i64, bool) = self
                .db
                .query_row(
                    "SELECT summary_items, summary_attempts, summary IS NOT NULL FROM stories WHERE id = ?1",
                    [id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()
                .map_err(err)?
                .unwrap_or((0, MAX_SUMMARIES, false));
            if attempts >= MAX_SUMMARIES || counts[&id] <= items {
                continue;
            }
            let mut statement = self
                .db
                .prepare_cached(&format!(
                    "SELECT i.id, COALESCE(i.title, ''), COALESCE(s.title, s.url),
                       substr(COALESCE(NULLIF(i.content, ''), i.summary, ''), 1, {EXCERPT_CHARS})
                     FROM items i JOIN sources s ON s.id = i.source_id
                     WHERE i.story_id = ?1 AND {VISIBLE} ORDER BY i.sort_at, i.id"
                ))
                .map_err(err)?;
            let articles = statement
                .query_map([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
                .map_err(err)?
                .collect::<rusqlite::Result<_>>()
                .map_err(err)?;
            due.push(SummaryJob {
                id,
                articles,
                has_summary,
            });
        }
        Ok(due)
    }

    /// Records a summary (or why there isn't one) for the items it read.
    /// Returns whether what the story shows changed: waiting on the cap (or
    /// a provider) again changes nothing.
    pub fn set_summary(&self, id: i64, items: usize, outcome: &Outcome, now: i64) -> Result<bool> {
        let changed = match outcome {
            Outcome::Ready {
                title,
                summary,
                model,
                cost,
            } => self.db.execute(
                "UPDATE stories SET title = ?2, summary = ?3, summary_state = 'ready', summary_items = ?4,
                   summary_attempts = summary_attempts + 1, model = ?5, cost_usd = cost_usd + ?6, updated_at = ?7
                 WHERE id = ?1",
                params![
                    id,
                    title,
                    serde_json::to_string(summary).map_err(|e| e.to_string())?,
                    items as i64,
                    model,
                    cost,
                    now
                ],
            ),
            // An earlier summary stays; it was right for the items it read.
            Outcome::Failed { model, cost } => self.db.execute(
                "UPDATE stories SET summary_state = CASE WHEN summary IS NULL THEN 'failed' ELSE 'ready' END,
                   summary_items = ?2, summary_attempts = summary_attempts + 1,
                   model = COALESCE(?3, model), cost_usd = cost_usd + ?4, updated_at = ?5
                 WHERE id = ?1",
                params![id, items as i64, model, cost, now],
            ),
            Outcome::Capped | Outcome::Unavailable => {
                let state = if matches!(outcome, Outcome::Capped) {
                    SummaryState::Capped
                } else {
                    SummaryState::Unavailable
                };
                self.db.execute(
                    "UPDATE stories SET summary_state = CASE WHEN summary IS NULL THEN ?2 ELSE 'ready' END
                     WHERE id = ?1 AND summary_state <> CASE WHEN summary IS NULL THEN ?2 ELSE 'ready' END",
                    params![id, state.as_str()],
                )
            }
        }
        .map_err(err)?;
        Ok(changed > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::super::{NewItem, SourceKind, Store};
    use super::*;

    const NOW: i64 = 1_800_000_000;

    fn source(store: &Store, name: &str) -> i64 {
        store
            .add_source(
                &format!("https://{name}.example/feed"),
                SourceKind::Feed,
                Some(name),
                NOW,
            )
            .unwrap()
            .0
            .id
    }

    fn add(store: &Store, source: i64, guid: &str, hours_ago: i64) -> i64 {
        store
            .insert_items(
                source,
                &[NewItem {
                    guid: guid.into(),
                    url: Some(format!("https://example.com/{guid}")),
                    title: Some(format!("Title {guid}")),
                    summary: Some(format!("Summary of {guid}")),
                    content: Some(format!("The text of {guid}.")),
                    image: (guid == "b").then(|| "https://example.com/b.png".into()),
                    media: "article",
                    published_at: Some(NOW - hours_ago * 3_600),
                    ..Default::default()
                }],
                NOW,
                false,
            )
            .unwrap();
        store
            .raw()
            .query_row("SELECT id FROM items WHERE guid = ?1", [guid], |r| r.get(0))
            .unwrap()
    }

    fn user_version(store: &Store) -> i64 {
        store
            .raw()
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn version_one_databases_gain_the_catalogue_then_stories() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("feed.sqlite");
        {
            let db = rusqlite::Connection::open(&path).unwrap();
            db.execute_batch(&format!(
                "BEGIN; {} PRAGMA user_version = 1; COMMIT;",
                super::super::SCHEMA
            ))
            .unwrap();
            db.execute(
                "INSERT INTO sources (url, kind, added_at) VALUES ('https://a.example', 'feed', 1)",
                [],
            )
            .unwrap();
            db.execute(
                "INSERT INTO items (source_id, guid, title, fetched_at, sort_at) VALUES (1, 'x', 'Old', 1, ?1)",
                [NOW],
            )
            .unwrap();
        }
        let store = Store::open(&path).unwrap();
        assert_eq!(user_version(&store), 3);
        assert_eq!(store.unclustered().unwrap(), 1);
        assert_eq!(store.items(0, 10, None).unwrap().items[0].story_id, None);
    }

    /// A KI-95 database (version 2) with older writing in it: released,
    /// pending and suggested rows survive version 3, released older writing
    /// shows in Newest, and nothing is in a story yet.
    #[test]
    fn version_two_databases_with_older_writing_gain_stories() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("feed.sqlite");
        let years_ago = NOW - 4 * 365 * 24 * 3_600;
        {
            let db = rusqlite::Connection::open(&path).unwrap();
            db.execute_batch(&format!(
                "BEGIN; {} PRAGMA user_version = 1; COMMIT;",
                super::super::SCHEMA
            ))
            .unwrap();
            super::super::catalogue::migrate(&db).unwrap();
            let version: i64 = db
                .pragma_query_value(None, "user_version", |r| r.get(0))
                .unwrap();
            assert_eq!(version, 2);
            db.execute_batch(&format!(
                "INSERT INTO sources (url, kind, title, added_at, catalogue_enabled, catalogue_state)
                   VALUES ('https://essays.example/feed', 'feed', 'Essays', 1, 1, 'done');
                 INSERT INTO sources (url, kind, title, added_at, suggested, catalogue_enabled, catalogue_state)
                   VALUES ('https://friend.example/feed', 'feed', 'Friend', 1, 1, 1, 'done');
                 INSERT INTO items (source_id, guid, url, url_key, title, fetched_at, sort_at)
                   VALUES (1, 'new', 'https://essays.example/new', 'essays.example/new', 'A new essay', {NOW}, {NOW});
                 INSERT INTO items (source_id, guid, url, url_key, title, published_at, fetched_at, sort_at,
                     back_catalogue, catalogue_released_at)
                   VALUES (1, 'old', 'https://essays.example/old', 'essays.example/old', 'An old essay',
                     {years_ago}, {NOW}, {years_ago}, 1, {NOW});
                 INSERT INTO items (source_id, guid, url, title, published_at, fetched_at, sort_at, back_catalogue)
                   VALUES (1, 'waiting', 'https://essays.example/waiting', 'Not released yet',
                     {years_ago}, {NOW}, {years_ago}, 1);
                 INSERT INTO items (source_id, guid, url, title, published_at, fetched_at, sort_at,
                     back_catalogue, catalogue_released_at, suggestion_reason)
                   VALUES (2, 'theirs', 'https://friend.example/a', 'A friend of an essay',
                     {years_ago}, {NOW}, {years_ago}, 1, {NOW}, 'Linked from An old essay');
                 INSERT INTO catalogue_releases (item_id, day, released_at, suggested)
                   VALUES (2, {day}, {NOW}, 0), (4, {day}, {NOW}, 1);",
                day = NOW / 86_400
            ))
            .unwrap();
        }
        let store = Store::open(&path).unwrap();
        assert_eq!(user_version(&store), 3);
        let old = store.item(2).unwrap();
        assert!(old.back_catalogue);
        assert_eq!(old.published_at, Some(years_ago), "the original date stays");
        assert_eq!(
            store.item(4).unwrap().suggestion.map(|s| s.reason),
            Some("Linked from An old essay".into())
        );
        let released: i64 = store
            .raw()
            .query_row("SELECT COUNT(*) FROM catalogue_releases", [], |r| r.get(0))
            .unwrap();
        assert_eq!(released, 2);
        // Released older writing (and the suggestion) is in Newest as items;
        // the pending one isn't; every visible item waits for clustering.
        let (entries, total) = store.entries(0, 10).unwrap();
        let ids: Vec<i64> = entries
            .iter()
            .map(|e| match e {
                Entry::Item { item } => item.id,
                Entry::Story { story } => story.id,
            })
            .collect();
        assert_eq!(total, 3, "{ids:?}");
        assert!(ids.contains(&1) && ids.contains(&2) && ids.contains(&4));
        assert!(!ids.contains(&3));
        assert_eq!(store.unclustered().unwrap(), 3);
        // Version 3's columns work on the old rows.
        let joined = store
            .assign_stories(&[1, 2], &[(1, -1), (2, -1)], NOW)
            .unwrap();
        assert_eq!(store.item(2).unwrap().story_id, Some(joined[0].1));
    }

    #[test]
    fn stories_fold_into_the_newest_list_and_need_two_sources() {
        let store = Store::memory();
        let (one, two) = (source(&store, "one"), source(&store, "two"));
        let a = add(&store, one, "a", 5);
        let b = add(&store, two, "b", 3);
        let c = add(&store, one, "c", 1);
        let lone = add(&store, two, "lone", 2);
        let same = add(&store, two, "same", 4);
        let joined = store
            .assign_stories(
                &[a, b, c, lone, same],
                &[(a, -1), (b, -1), (c, -1), (lone, -2), (same, -2)],
                NOW,
            )
            .unwrap();
        assert_eq!(joined.len(), 5);
        assert_ne!(joined[0].1, joined[3].1);
        assert_eq!(store.unclustered().unwrap(), 0);
        let (entries, total) = store.entries(0, 10).unwrap();
        // The story sits at its newest item (c); the one-source cluster's
        // items stay plain.
        assert_eq!(total, 3);
        let Entry::Story { story } = &entries[0] else {
            panic!("{entries:?}")
        };
        assert_eq!(story.lead.id, a, "the first to cover it leads");
        assert_eq!(
            story.items.iter().map(|i| i.id).collect::<Vec<_>>(),
            [a, c, b]
        );
        assert_eq!(story.image.as_deref(), Some("https://example.com/b.png"));
        assert_eq!(story.sources.len(), 2);
        assert_eq!(story.sources[0].items, 2);
        assert_eq!(story.title, "Title a");
        assert_eq!(story.summary_state, SummaryState::Pending);
        assert!(matches!(&entries[1], Entry::Item { item } if item.id == lone));
        assert!(matches!(&entries[2], Entry::Item { item } if item.id == same));
        // Dismissing one source's items leaves one source: no longer a story.
        store.set_dismissed(b, true, NOW).unwrap();
        let (entries, total) = store.entries(0, 10).unwrap();
        assert_eq!(total, 4);
        assert!(entries.iter().all(|e| matches!(e, Entry::Item { .. })));
        assert!(store.story(joined[0].1).is_err());
    }

    #[test]
    fn summaries_are_due_once_and_again_when_a_source_joins() {
        let store = Store::memory();
        let (one, two, three) = (
            source(&store, "one"),
            source(&store, "two"),
            source(&store, "three"),
        );
        let a = add(&store, one, "a", 5);
        let b = add(&store, two, "b", 3);
        let story = store
            .assign_stories(&[a, b], &[(a, -1), (b, -1)], NOW)
            .unwrap()[0]
            .1;
        let due = store.summaries_due().unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].articles.len(), 2);
        assert_eq!(due[0].articles[0].3, "The text of a.");
        // Waiting on the cap doesn't count as a try, and waiting again changes nothing.
        assert!(store.set_summary(story, 2, &Outcome::Capped, NOW).unwrap());
        assert!(!store.set_summary(story, 2, &Outcome::Capped, NOW).unwrap());
        assert_eq!(
            store.story(story).unwrap().summary_state,
            SummaryState::Capped
        );
        assert_eq!(store.summaries_due().unwrap().len(), 1);
        let summary = Summary {
            paragraphs: vec![vec![Sentence {
                text: "Both said so.".into(),
                cites: vec![a, b],
            }]],
        };
        store
            .set_summary(
                story,
                2,
                &Outcome::Ready {
                    title: Some("A new title".into()),
                    summary: summary.clone(),
                    model: "mock".into(),
                    cost: 0.001,
                },
                NOW,
            )
            .unwrap();
        let ready = store.story(story).unwrap();
        assert_eq!(
            (ready.title.as_str(), ready.summary_state),
            ("A new title", SummaryState::Ready)
        );
        assert!(store.summaries_due().unwrap().is_empty());
        // A third source joins: due again; a failed rewrite keeps the old one.
        let c = add(&store, three, "c", 1);
        store.assign_stories(&[c], &[(c, story)], NOW).unwrap();
        assert_eq!(store.summaries_due().unwrap()[0].articles.len(), 3);
        store
            .set_summary(
                story,
                3,
                &Outcome::Failed {
                    model: None,
                    cost: 0.0,
                },
                NOW,
            )
            .unwrap();
        let kept = store.story(story).unwrap();
        assert_eq!(kept.summary, Some(summary));
        assert!(store.summaries_due().unwrap().is_empty());
        // Citations to a dismissed item drop out.
        store.set_dismissed(b, true, NOW).unwrap();
        let cited = store.story(story).unwrap().summary.unwrap();
        assert_eq!(cited.paragraphs[0][0].cites, [a]);
    }

    #[test]
    fn a_failed_first_summary_falls_back_to_the_lead() {
        let store = Store::memory();
        let (one, two) = (source(&store, "one"), source(&store, "two"));
        let a = add(&store, one, "a", 5);
        let b = add(&store, two, "b", 3);
        let story = store
            .assign_stories(&[a, b], &[(a, -1), (b, -1)], NOW)
            .unwrap()[0]
            .1;
        store
            .set_summary(
                story,
                2,
                &Outcome::Failed {
                    model: Some("m".into()),
                    cost: 0.0,
                },
                NOW,
            )
            .unwrap();
        let failed = store.story(story).unwrap();
        assert_eq!(
            (failed.title.as_str(), failed.summary_state),
            ("Title a", SummaryState::Failed)
        );
        assert!(failed.summary.is_none());
    }
}
