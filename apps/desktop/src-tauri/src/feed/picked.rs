//! Picked for you (KI-32): the Feed's ranked section, its "Why this?"
//! corrections, what a like changed, and Kin's ranking tools. The ranking
//! itself is `kintsugi-rank` (docs/ranking.md); this module feeds it.
//!
//! - The ranker is derived from the Feed's event log and kept in memory. It
//!   consumes new events online on every request; an undo (unlike, undo Not
//!   interested, a cleared note) or a correction replays the log instead, so
//!   undoing is exact.
//! - Vectors come from the search index (model2vec, the mean of an item's
//!   chunks) once the model is loaded, else from hashed text. A change of
//!   space rebuilds the ranker.
//! - Kin's picks (`shortlist`, `similar_to`) are logged as `kin_pick` events
//!   with surface `kin`, which the ranker never learns from.
//! - No LLM calls anywhere here.

use super::{Event as LogEvent, Item, now_ms, with};
use crate::AppHandle;
use kintsugi_rank::{self as rank, Clip, Pick, PickOptions, Ranker, World, text};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;
use tauri::Manager;

type Result<T> = std::result::Result<T, String>;

/// Picked for you shows this many; one of them explores.
const PICKED: usize = 8;
const SHORTLIST_DEFAULT: usize = 20;
const SHORTLIST_MAX: usize = 50;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Space {
    Hashed,
    Model,
}

#[derive(Default)]
pub struct Ranking(Mutex<Option<State>>);

struct State {
    ranker: Ranker,
    space: Space,
    clips: u64,
    /// What Picked for you showed last, for "what a like changed".
    shown: Vec<i64>,
}

/// Clips are read from the vault only when `inspiration/` changes.
#[derive(Default)]
struct ClipCache {
    stamp: Option<(std::path::PathBuf, SystemTime, usize)>,
    clips: Vec<kintsugi_vault::ClipSummary>,
}

static CLIPS: Mutex<ClipCache> = Mutex::new(ClipCache { stamp: None, clips: Vec::new() });

fn clip_summaries(root: &Path) -> Vec<kintsugi_vault::ClipSummary> {
    let dir = root.join(kintsugi_vault::INSPIRATION);
    let stamp = std::fs::metadata(&dir)
        .and_then(|m| m.modified())
        .ok()
        .map(|modified| (root.to_path_buf(), modified, std::fs::read_dir(&dir).map_or(0, |d| d.count())));
    let mut cache = CLIPS.lock().unwrap_or_else(|e| e.into_inner());
    if stamp.is_none() || cache.stamp != stamp {
        cache.clips = kintsugi_vault::clip_list(root).unwrap_or_default();
        cache.stamp = stamp;
    }
    cache.clips.clone()
}

/// "2026-10-29T14:05" → seconds, read as UTC (precision doesn't matter here).
fn captured_at(text: &str) -> i64 {
    let digits: Vec<u32> = text.split(|c: char| !c.is_ascii_digit()).filter(|s| !s.is_empty()).filter_map(|s| s.parse().ok()).collect();
    let [year, month, day, rest @ ..] = digits.as_slice() else { return 0 };
    chrono::NaiveDate::from_ymd_opt(*year as i32, *month, *day)
        .and_then(|d| d.and_hms_opt(rest.first().copied().unwrap_or(0).min(23), rest.get(1).copied().unwrap_or(0).min(59), 0))
        .map_or(0, |t| t.and_utc().timestamp())
}

fn normalized(mut vector: Vec<f32>) -> Vec<f32> {
    rank::vector::normalize(&mut vector);
    vector
}

/// Everything the ranker reads, with pick candidates (visible items).
fn world(app: &AppHandle) -> Result<(World, Vec<i64>, Space, u64)> {
    let (rows, sources) = with(app, |s| Ok((s.rank_rows()?, s.rank_sources()?)))?;
    let root = crate::vault::current(app).ok();
    let vectors = app.state::<crate::search::Search>().vectors(app, root.as_deref());
    let space = if vectors.is_some() { Space::Model } else { Space::Hashed };
    let embed = |key: Option<&Vec<f32>>, title: &str, body: &str| -> Vec<f32> {
        match (&vectors, key) {
            (Some(_), Some(found)) => found.clone(),
            (Some(v), None) => normalized(v.embedder.embed(&[format!("{title}\n{body}")]).pop().unwrap_or_default()),
            (None, _) => text::hashed(title, body),
        }
    };
    let mut world = World::default();
    for (id, title, added) in sources {
        world.sources.insert(id, rank::Source { id, title, added });
    }
    let mut candidates = Vec::new();
    let mut saved: HashMap<String, i64> = HashMap::new();
    for row in rows {
        let body = if row.text.is_empty() { row.summary.clone() } else { format!("{}\n\n{}", row.summary, row.text) };
        let key = vectors.as_ref().and_then(|v| v.feed.get(&super::search_id(row.id)));
        let vector = embed(key, &row.title, &body);
        if row.visible {
            candidates.push(row.id);
        }
        if let Some(path) = &row.saved_path {
            saved.insert(path.clone(), row.id);
        }
        world.items.insert(
            row.id,
            rank::Item {
                id: row.id,
                source: row.source_id,
                author: row.author.filter(|a| !a.trim().is_empty()),
                topics: text::topics(&row.title, &body, &[]),
                title: row.title,
                url: row.url,
                media: rank::Media::parse(&row.media),
                published: row.sort_at,
                length: row.length.max(row.summary.chars().count()),
                vector,
            },
        );
    }
    // Which clips (and their tags) the ranker was built from; a change rebuilds it.
    let mut clip_stamp = std::collections::hash_map::DefaultHasher::new();
    if let Some(root) = &root {
        for clip in clip_summaries(root) {
            let title = clip.title.clone().or_else(|| clip.url.clone()).unwrap_or_else(|| clip.path.clone());
            let body = [clip.summary.clone().unwrap_or_default(), clip.tags.join(" ")].join("\n");
            let key = vectors.as_ref().and_then(|v| v.vault.get(&clip.path));
            std::hash::Hash::hash(&(&clip.path, &clip.captured, &clip.tags, &clip.site, &clip.summary), &mut clip_stamp);
            world.clips.push(Clip {
                vector: embed(key, &title, &body),
                topics: text::topics(&title, &body, &clip.tags),
                item: saved.get(&clip.path).copied(),
                captured: captured_at(&clip.captured),
                site: clip.site.clone(),
                author: clip.author.clone(),
                key: clip.path,
                title,
            });
        }
    }
    Ok((world, candidates, space, std::hash::Hasher::finish(&clip_stamp)))
}

/// Brings the ranker up to date with the log, then runs `f` on it.
fn ranked<T>(app: &AppHandle, f: impl FnOnce(&mut State, &World, &[i64], i64) -> Result<T>) -> Result<T> {
    let (world, candidates, space, clips) = world(app)?;
    let ranking = &app.state::<super::Feed>().ranking;
    let mut slot = ranking.0.lock().map_err(|_| "ranking is unavailable".to_string())?;
    let now = now_ms();
    let fresh = match slot.as_mut() {
        Some(state) if state.space == space && state.clips == clips => {
            let events = with(app, |s| s.events_after(state.ranker.cursor))?;
            if rank::needs_rebuild(&events) {
                true
            } else {
                state.ranker.observe(&world, &events);
                state.ranker.advance(&world, now);
                false
            }
        }
        _ => true,
    };
    if fresh {
        let events = with(app, |s| s.events_after(0))?;
        let shown = slot.take().map(|s| s.shown).unwrap_or_default();
        *slot = Some(State { ranker: Ranker::build(&world, &events, now), space, clips, shown });
    }
    f(slot.as_mut().expect("ranker was just built"), &world, &candidates, now)
}

/// Stable within a day, so the section doesn't reshuffle on every visit.
fn seed(now: i64) -> u64 {
    (now / rank::DAY_MS) as u64
}

// ── Commands ──────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Picked {
    pub picks: Vec<PickedItem>,
    /// Labelled actions so far, and how much the learned model counts.
    pub examples: usize,
    pub learned_share: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedItem {
    pub item: Item,
    #[serde(flatten)]
    pub pick: Pick,
}

fn picked_items(app: &AppHandle, picks: Vec<Pick>) -> Result<Vec<PickedItem>> {
    with(app, |s| Ok(picks.into_iter().filter_map(|pick| Some(PickedItem { item: s.item(pick.id).ok()?, pick })).collect()))
}

/// Picked for you: a few items ranked for him, one of them exploring, each
/// with the reasons behind it.
#[tauri::command]
pub fn feed_picked(app: AppHandle, n: Option<usize>) -> Result<Picked> {
    let n = n.unwrap_or(PICKED).clamp(1, 20);
    let (picks, examples, learned_share) = ranked(&app, |state, world, candidates, now| {
        let picks = state.ranker.pick(world, candidates, now, PickOptions { n, explore: true, seed: seed(now) });
        state.shown = picks.iter().map(|p| p.id).collect();
        let profile = state.ranker.profile(world, now);
        Ok((picks, profile.examples, profile.learned_share))
    })?;
    Ok(Picked { picks: picked_items(&app, picks)?, examples, learned_share })
}

/// Removing a reason from "Why this?" (or undoing that). Logged in the event
/// log, so it is replayed like everything else.
#[tauri::command]
pub fn feed_correct(app: AppHandle, reason: String, id: Option<i64>, undo: Option<bool>) -> Result<()> {
    let valid = ["source:", "author:", "topic:", "anchor:item:", "anchor:clip:"].iter().any(|p| reason.starts_with(p));
    if !valid || reason.len() > 600 {
        return Err("that reason can't be removed".into());
    }
    with(&app, |s| {
        let source = id.and_then(|id| s.item(id).ok()).map(|i| i.source_id);
        s.log(&LogEvent {
            at: now_ms(),
            kind: if undo.unwrap_or(false) { "undo_correction" } else { "correction" }.into(),
            item_id: id,
            source_id: source,
            surface: Some("picked".into()),
            data: Some(json!({ "reason": reason })),
            ..Default::default()
        })
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Titled {
    pub id: i64,
    pub title: String,
}

/// What a like (or save, or note) changed: the affinities it moved, and
/// which picks came in or went out of Picked for you.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LikeEffect {
    pub changes: Vec<rank::Change>,
    pub added: Vec<Titled>,
    pub removed: Vec<Titled>,
}

#[tauri::command]
pub fn feed_effect(app: AppHandle, id: i64) -> Result<LikeEffect> {
    let (changes, added, removed) = ranked(&app, |state, world, candidates, now| {
        let mut changes = state.ranker.effect(id).map(|e| e.changes.clone()).unwrap_or_default();
        changes.retain(|c| (c.after - c.before).abs() >= 0.005);
        changes.sort_by(|a, b| (b.after - b.before).abs().total_cmp(&(a.after - a.before).abs()));
        changes.truncate(3);
        let picks: Vec<i64> = state.ranker.pick(world, candidates, now, PickOptions { n: PICKED, explore: true, seed: seed(now) }).iter().map(|p| p.id).collect();
        let title = |id: &i64| Titled { id: *id, title: world.items.get(id).map_or_else(String::new, |i| i.title.clone()) };
        let added: Vec<Titled> = picks.iter().filter(|p| !state.shown.contains(p)).map(title).collect();
        let removed: Vec<Titled> = state.shown.iter().filter(|p| !picks.contains(p) && **p != id).map(title).collect();
        state.shown = picks;
        Ok((changes, added, removed))
    })?;
    Ok(LikeEffect { changes, added, removed })
}

// ── Kin's tools ───────────────────────────────────────────────────────────

/// The `feed:<id>` (or bare id) of a feed item.
fn feed_id(value: &Value) -> Option<i64> {
    match value {
        Value::Number(n) => n.as_i64(),
        Value::String(s) => s.trim().trim_start_matches("feed:").parse().ok(),
        _ => None,
    }
}

fn age(published: i64, now: i64) -> String {
    let hours = ((now / 1000 - published) / 3600).max(0);
    if hours < 48 { format!("{hours}h") } else { format!("{}d", hours / 24) }
}

fn lines(values: Vec<Value>) -> String {
    if values.is_empty() {
        return "[]".into();
    }
    format!("[\n{}\n]", values.iter().map(Value::to_string).collect::<Vec<_>>().join(",\n"))
}

fn source_name(world: &World, item: &rank::Item) -> String {
    world.sources.get(&item.source).map_or_else(String::new, |s| s.title.clone())
}

/// Logs what Kin was shown as its own picks, never as his impressions.
fn log_kin_picks(app: &AppHandle, tool: &str, ids: &[i64]) {
    let at = now_ms();
    let _ = with(app, |s| {
        let events: Vec<LogEvent> = ids
            .iter()
            .enumerate()
            .map(|(position, id)| LogEvent {
                at,
                kind: "kin_pick".into(),
                item_id: Some(*id),
                source_id: s.item(*id).ok().map(|i| i.source_id),
                surface: Some(rank::KIN_SURFACE.into()),
                position: Some(position as i64),
                data: Some(json!({ "tool": tool })),
            })
            .collect();
        s.log_all(&events)
    });
}

/// Reads one feed item for Kin: what it is, then its text.
fn read_item(app: &AppHandle, id: i64) -> Result<String> {
    let (item, content) = with(app, |s| Ok((s.item(id)?, s.content(id)?)))?;
    let mut out = format!("feed:{id}\ntitle: {}\n", item.title.as_deref().unwrap_or("(untitled)"));
    for (label, value) in [("source", item.source_title.clone()), ("author", item.author.clone()), ("url", item.url.clone())] {
        if let Some(value) = value.filter(|v| !v.is_empty()) {
            out.push_str(&format!("{label}: {value}\n"));
        }
    }
    let published = item.published_at.unwrap_or(item.fetched_at);
    out.push_str(&format!("published: {}\nmedia: {}\n", chrono::DateTime::from_timestamp(published, 0).map_or_else(String::new, |d| d.to_rfc3339()), item.media));
    let mut state = Vec::new();
    if item.liked {
        state.push("liked");
    }
    if item.saved_path.is_some() {
        state.push("saved");
    }
    if item.dismissed {
        state.push("not interested");
    }
    if !state.is_empty() {
        out.push_str(&format!("his actions: {}\n", state.join(", ")));
    }
    if let Some(path) = &item.saved_path {
        out.push_str(&format!("clip: {path}\n"));
    }
    if let Some(note) = item.note.as_deref().filter(|n| !n.is_empty()) {
        out.push_str(&format!("his note: {note}\n"));
    }
    out.push('\n');
    match content.filter(|c| !c.trim().is_empty()).or(item.summary.clone()) {
        Some(text) => out.push_str(&text),
        None => out.push_str("(The feed sent only a headline.)"),
    }
    Ok(out)
}

/// Kin's Feed and ranking tools (`tool` extras, and `read feed:<id>`).
/// Compact JSON, never full text except `read`.
pub fn kin_tool(app: &AppHandle, name: &str, args: &Value) -> Result<String> {
    match name {
        "read" => read_item(app, feed_id(&args["item"]).ok_or("read a feed item as feed:<id>")?),
        "shortlist" => {
            let n = args["n"].as_u64().map_or(SHORTLIST_DEFAULT, |n| (n as usize).clamp(1, SHORTLIST_MAX));
            let (out, ids) = ranked(app, |state, world, candidates, now| {
                let picks = state.ranker.pick(world, candidates, now, PickOptions { n, explore: false, seed: 0 });
                let out: Vec<Value> = picks
                    .iter()
                    .filter_map(|p| {
                        let item = world.items.get(&p.id)?;
                        Some(json!({
                            "id": format!("feed:{}", p.id),
                            "title": item.title,
                            "source": source_name(world, item),
                            "age": age(item.published, now),
                            "score": p.score,
                            "why": p.reasons.iter().filter(|r| r.key != "cold").map(|r| r.label.clone()).collect::<Vec<_>>(),
                        }))
                    })
                    .collect();
                Ok((out, picks.iter().map(|p| p.id).collect::<Vec<_>>()))
            })?;
            log_kin_picks(app, "shortlist", &ids);
            Ok(lines(out))
        }
        "similar_to" => {
            let n = args["n"].as_u64().map_or(10, |n| (n as usize).clamp(1, 30));
            let target = args["item"].as_str().unwrap_or_default().trim().to_string();
            if target.is_empty() {
                return Err("similar_to needs an item: feed:<id> or a clip path".into());
            }
            let (out, ids) = ranked(app, |state, world, _, now| {
                let (vector, except) = match feed_id(&args["item"]).filter(|_| target.starts_with("feed:") || target.parse::<i64>().is_ok()) {
                    Some(id) => (world.items.get(&id).ok_or("no such feed item")?.vector.clone(), Some(id)),
                    None => (world.clips.iter().find(|c| c.key == target).ok_or("no such clip; give feed:<id> or an inspiration/ path")?.vector.clone(), None),
                };
                let found = state.ranker.similar(world, &vector, except, n);
                let out: Vec<Value> = found
                    .iter()
                    .filter_map(|(id, similarity)| {
                        let item = world.items.get(id)?;
                        Some(json!({ "id": format!("feed:{id}"), "title": item.title, "source": source_name(world, item), "age": age(item.published, now), "similarity": similarity }))
                    })
                    .collect();
                Ok((out, found.iter().map(|f| f.0).collect::<Vec<_>>()))
            })?;
            log_kin_picks(app, "similar_to", &ids);
            Ok(lines(out))
        }
        "top_topics" => {
            let days = args["window"].as_i64().or_else(|| args["days"].as_i64()).unwrap_or(30).clamp(1, 365);
            ranked(app, |state, world, _, now| Ok(lines(state.ranker.top_topics(world, days, now, 12).iter().map(|t| json!(t)).collect())))
        }
        "taste_profile" => ranked(app, |state, world, _, now| Ok(serde_json::to_string(&state.ranker.profile(world, now)).unwrap_or_default())),
        "explain" => {
            let id = feed_id(&args["item"]).ok_or("explain needs an item: feed:<id>")?;
            ranked(app, |state, world, _, now| {
                let explained = state.ranker.explain(world, id, now).ok_or("no such feed item")?;
                Ok(serde_json::to_string(&explained).unwrap_or_default())
            })
        }
        other => Err(format!("no feed tool named {other}")),
    }
}

/// Kin's hook into the Feed, for `ai::tools::Tools::with_feed`.
pub fn kin_hook(app: &AppHandle) -> crate::ai::tools::FeedTool {
    let app = app.clone();
    Arc::new(move |name: &str, args: &Value| kin_tool(&app, name, args))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clip_capture_times_parse() {
        assert_eq!(captured_at("2026-10-29T14:05"), 1_793_282_700);
        assert_eq!(captured_at("garbage"), 0);
        assert_eq!(feed_id(&json!("feed:12")), Some(12));
        assert_eq!(feed_id(&json!(7)), Some(7));
        assert_eq!(age(0, 3 * 86_400_000), "3d");
    }
}
