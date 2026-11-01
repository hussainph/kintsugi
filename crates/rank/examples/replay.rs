//! The offline evaluation as a script.
//!
//!   cargo run -p kintsugi-rank --example replay              synthetic reader
//!   cargo run -p kintsugi-rank --example replay -- --db PATH a Feed database
//!
//! `--db` opens the file read-only (use a copy). It replays that log with
//! hashed text vectors (the search index's model vectors live elsewhere) and
//! no Inspiration clips, so it is a lower bound on what the app does.

use kintsugi_rank::{DAY_MS, Event, Item, Media, Source, World, replay, synthetic, text};

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    let k = args.iter().position(|a| a == "--k").and_then(|i| args.get(i + 1)?.parse().ok()).unwrap_or(5);
    let (world, events) = match args.iter().position(|a| a == "--db").and_then(|i| args.get(i + 1)) {
        Some(path) => load(path)?,
        None => {
            let start = 1_700_000_000_000 / DAY_MS * DAY_MS;
            let fixture = synthetic::fixture(42, 30, start);
            (fixture.world, fixture.events)
        }
    };
    print!("{}", replay::replay(&world, &events, k).table());
    Ok(())
}

fn load(path: &str) -> Result<(World, Vec<Event>), String> {
    use rusqlite::{Connection, OpenFlags};
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| e.to_string())?;
    let err = |e: rusqlite::Error| e.to_string();
    let mut world = World::default();
    let mut statement = db.prepare("SELECT id, COALESCE(title, url), added_at FROM sources").map_err(err)?;
    for row in statement.query_map([], |r| Ok(Source { id: r.get(0)?, title: r.get(1)?, added: r.get(2)? })).map_err(err)? {
        let source = row.map_err(err)?;
        world.sources.insert(source.id, source);
    }
    let mut statement = db
        .prepare("SELECT id, source_id, author, COALESCE(title, ''), url, COALESCE(summary, ''), length(COALESCE(content, '')), media, sort_at FROM items")
        .map_err(err)?;
    let rows = statement
        .query_map([], |r| {
            let (title, summary): (String, String) = (r.get(3)?, r.get(5)?);
            let media: String = r.get(7)?;
            Ok(Item {
                id: r.get(0)?,
                source: r.get(1)?,
                author: r.get(2)?,
                url: r.get(4)?,
                topics: text::topics(&title, &summary, &[]),
                vector: text::hashed(&title, &summary),
                title,
                media: Media::parse(&media),
                published: r.get(8)?,
                length: r.get::<_, i64>(6)? as usize,
            })
        })
        .map_err(err)?;
    for row in rows {
        let item = row.map_err(err)?;
        world.items.insert(item.id, item);
    }
    let mut statement = db.prepare("SELECT id, at, kind, item_id, source_id, surface, data FROM events ORDER BY id").map_err(err)?;
    let events = statement
        .query_map([], |r| {
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
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    Ok((world, events))
}
