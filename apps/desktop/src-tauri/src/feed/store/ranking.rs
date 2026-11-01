//! The ranking's reads (KI-32): everything it learns from, nothing it writes
//! but corrections and Kin's picks, which go through the event log.

use super::{Result, Store, err};
use kintsugi_rank::Event;

/// One item as ranking sees it, including items no longer visible (a
/// dismissed or liked item is still a training example).
#[derive(Clone, Debug)]
pub struct RankRow {
    pub id: i64,
    pub source_id: i64,
    pub author: Option<String>,
    pub title: String,
    pub url: Option<String>,
    pub summary: String,
    /// The start of its text, for the hashed fallback embedding.
    pub text: String,
    pub length: usize,
    pub media: String,
    pub sort_at: i64,
    /// In the feed now: a pick candidate.
    pub visible: bool,
    pub saved_path: Option<String>,
}

impl Store {
    pub fn rank_rows(&self) -> Result<Vec<RankRow>> {
        let mut statement = self
            .db
            .prepare(&format!(
                "SELECT i.id, i.source_id, i.author, COALESCE(i.title, ''), i.url, COALESCE(i.summary, ''),
                   substr(COALESCE(i.content, ''), 1, 4000), length(COALESCE(i.content, '')), i.media, i.sort_at,
                   {visible}, i.saved_path
                 FROM items i JOIN sources s ON s.id = i.source_id ORDER BY i.id",
                visible = super::VISIBLE
            ))
            .map_err(err)?;
        let rows = statement
            .query_map([], |r| {
                Ok(RankRow {
                    id: r.get(0)?,
                    source_id: r.get(1)?,
                    author: r.get(2)?,
                    title: r.get(3)?,
                    url: r.get(4)?,
                    summary: r.get(5)?,
                    text: r.get(6)?,
                    length: r.get::<_, i64>(7)?.max(0) as usize,
                    media: r.get(8)?,
                    sort_at: r.get(9)?,
                    visible: r.get(10)?,
                    saved_path: r.get(11)?,
                })
            })
            .map_err(err)?;
        rows.collect::<rusqlite::Result<_>>().map_err(err)
    }

    /// Every source ever followed: id, title (or URL), when it was added.
    pub fn rank_sources(&self) -> Result<Vec<(i64, String, i64)>> {
        let mut statement = self.db.prepare("SELECT id, COALESCE(title, url), added_at FROM sources ORDER BY id").map_err(err)?;
        let rows = statement.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).map_err(err)?;
        rows.collect::<rusqlite::Result<_>>().map_err(err)
    }

    /// The event log after `cursor` (an event id), oldest first.
    pub fn events_after(&self, cursor: i64) -> Result<Vec<Event>> {
        let mut statement = self
            .db
            .prepare_cached("SELECT id, at, kind, item_id, source_id, surface, data FROM events WHERE id > ?1 ORDER BY id")
            .map_err(err)?;
        let rows = statement
            .query_map([cursor], |r| {
                let data: Option<String> = r.get(6)?;
                Ok(Event {
                    id: r.get(0)?,
                    at: r.get(1)?,
                    kind: r.get(2)?,
                    item: r.get(3)?,
                    source: r.get(4)?,
                    surface: r.get(5)?,
                    data: data.and_then(|d| serde_json::from_str(&d).ok()),
                })
            })
            .map_err(err)?;
        rows.collect::<rusqlite::Result<_>>().map_err(err)
    }
}

#[cfg(test)]
mod tests {
    use super::super::{Event as LogEvent, NewItem, SourceKind, Store};
    use kintsugi_rank::{PickOptions, Ranker, Source, World, text};

    const NOW: i64 = 1_800_000_000;

    /// A seeded event log through the real store, into the ranker: a saved
    /// pottery post pulls the other pottery post above fresher football.
    #[test]
    fn a_seeded_log_ranks_through_the_store() {
        let store = Store::memory();
        let (pots, _) = store.add_source("https://pots.example/feed", SourceKind::Feed, Some("Pots"), NOW).unwrap();
        let (ball, _) = store.add_source("https://ball.example/feed", SourceKind::Feed, Some("Ball"), NOW).unwrap();
        let entry = |guid: &str, title: &str, hours: i64| NewItem {
            guid: guid.into(),
            title: Some(title.into()),
            content: Some(format!("{title}. More about {title}.")),
            media: "article",
            published_at: Some(NOW - hours * 3600),
            ..Default::default()
        };
        store.insert_items(pots.id, &[entry("a", "Kiln glaze firing", 30), entry("b", "Porcelain glaze in the kiln", 20)], NOW, true).unwrap();
        store.insert_items(ball.id, &[entry("c", "Striker transfer derby", 1)], NOW, true).unwrap();
        let rows = store.rank_rows().unwrap();
        let id = |guid: &str| rows.iter().find(|r| r.title.starts_with(match guid { "a" => "Kiln", "b" => "Porcelain", _ => "Striker" })).unwrap().id;
        let log = |kind: &str, item: i64, data: Option<serde_json::Value>| {
            store.log(&LogEvent { at: NOW * 1000 - 3_600_000, kind: kind.into(), item_id: Some(item), data, ..Default::default() }).unwrap()
        };
        log("save", id("a"), None);
        log("kin_pick", id("c"), None);
        assert_eq!(store.events_after(1).unwrap().len(), 1);
        let events = store.events_after(0).unwrap();
        assert_eq!((events[0].kind.as_str(), events[0].item), ("save", Some(id("a"))));

        let mut world = World::default();
        for (sid, title, added) in store.rank_sources().unwrap() {
            world.sources.insert(sid, Source { id: sid, title, added });
        }
        for row in &rows {
            assert!(row.visible && row.length > 0);
            world.items.insert(row.id, kintsugi_rank::Item {
                id: row.id,
                source: row.source_id,
                author: None,
                title: row.title.clone(),
                url: None,
                topics: text::topics(&row.title, &row.text, &[]),
                media: kintsugi_rank::Media::parse(&row.media),
                published: row.sort_at,
                length: row.length,
                vector: text::hashed(&row.title, &row.text),
            });
        }
        let ranker = Ranker::build(&world, &events, NOW * 1000);
        let picks = ranker.pick(&world, &rows.iter().map(|r| r.id).collect::<Vec<_>>(), NOW * 1000, PickOptions { n: 2, explore: false, seed: 0 });
        assert_eq!(picks.iter().map(|p| p.id).collect::<Vec<_>>(), [id("b"), id("c")]);
        assert!(picks[0].reasons.iter().any(|r| r.key == format!("anchor:item:{}", id("a"))), "{:?}", picks[0].reasons);
    }
}
