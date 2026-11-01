use crate::ranker::*;
use crate::{replay, synthetic, text};
use serde_json::json;

const NOW: i64 = 1_800_000_000_000;

fn item(id: i64, source: i64, title: &str, body: &str, hours_ago: i64) -> Item {
    Item {
        id,
        source,
        author: Some(format!("author {source}")),
        title: title.into(),
        url: Some(format!("https://example.com/{id}")),
        topics: text::topics(title, body, &[]),
        media: Media::Article,
        published: (NOW - hours_ago * HOUR_MS) / 1000,
        length: body.len(),
        vector: text::hashed(title, body),
    }
}

fn world() -> World {
    let mut world = World::default();
    for (id, title) in [(1, "Studio Notes"), (2, "Matchday"), (3, "Brand New")] {
        world.sources.insert(id, Source { id, title: title.into(), added: (NOW - 60 * DAY_MS) / 1000 });
    }
    world.sources.get_mut(&3).unwrap().added = (NOW - DAY_MS) / 1000;
    let items = [
        item(1, 1, "Kiln firing and glaze", "Glaze chemistry in a wood kiln; stoneware and porcelain firing.", 10),
        item(2, 2, "Striker transfer rumours", "The league leaders want a striker before the derby.", 2),
        item(3, 1, "Porcelain glaze notes", "Clay bodies, porcelain and glaze for the kiln.", 30),
        item(4, 2, "Goalkeeper derby report", "The goalkeeper saved the derby at the stadium.", 5),
        item(5, 3, "Unrelated ledger thoughts", "Bookkeeping ledgers and accounting.", 3),
        item(6, 1, "Kiln firing and glaze", "Glaze chemistry in a wood kiln; stoneware and porcelain firing.", 9),
    ];
    for item in items {
        world.items.insert(item.id, item);
    }
    world.clips.push(Clip {
        key: "inspiration/kiln.md".into(),
        title: "Anagama kilns".into(),
        captured: (NOW - 40 * DAY_MS) / 1000,
        vector: text::hashed("Anagama kilns", "Wood-fired kiln, glaze and ash on stoneware."),
        site: Some("Studio Notes".into()),
        author: None,
        topics: vec!["kiln".into()],
        item: None,
    });
    world
}

fn event(id: i64, kind: &str, item: i64, hours_ago: i64) -> Event {
    Event { id, at: NOW - hours_ago * HOUR_MS, kind: kind.into(), item: Some(item), source: None, surface: Some("newest".into()), data: None }
}

fn ids(scores: &[(i64, f64)]) -> Vec<i64> {
    scores.iter().map(|s| s.0).collect()
}

#[test]
fn cold_start_uses_inspiration_and_recency() {
    let world = world();
    let ranker = Ranker::build(&world, &[], NOW);
    let order = ids(&ranker.scores(&world, &[1, 2], NOW));
    // The older kiln piece beats the fresher football one: it's close to a clip.
    assert_eq!(order, [1, 2]);
    let explained = ranker.explain(&world, 1, NOW).unwrap();
    assert!(explained.reasons.iter().any(|r| r.key == "anchor:clip:inspiration/kiln.md"), "{:?}", explained.reasons);
    assert!(explained.reasons.iter().any(|r| r.key == "cold"));
    assert_eq!(explained.learned_share, 0.0);
}

#[test]
fn undo_is_exact_and_kin_picks_never_train() {
    let world = world();
    let base = vec![event(1, "impression", 1, 40), event(2, "like", 3, 39)];
    let mut undone = base.clone();
    undone.push(event(3, "like", 2, 38));
    undone.push(event(4, "unlike", 2, 38));
    undone.push(Event { data: Some(json!({ "reason": "source:1" })), ..event(5, "correction", 3, 37) });
    undone.push(Event { data: Some(json!({ "reason": "source:1" })), ..event(6, "undo_correction", 3, 37) });
    // Kin's shortlist exposures are logged but never learned from.
    undone.push(Event { surface: Some(KIN_SURFACE.into()), ..event(7, "kin_pick", 4, 36) });
    undone.push(Event { surface: Some(KIN_SURFACE.into()), ..event(8, "impression", 4, 36) });
    let a = Ranker::build(&world, &base, NOW);
    let b = Ranker::build(&world, &undone, NOW);
    for id in 1..=6 {
        assert_eq!(a.explain(&world, id, NOW).unwrap().score, b.explain(&world, id, NOW).unwrap().score, "item {id}");
    }
    assert!(!b.touched(4), "a Kin pick isn't an impression he ignored");
    assert!(needs_rebuild(&undone[2..4]));
    assert!(!needs_rebuild(&base));
    assert_eq!(effective(&undone).len(), base.len());
}

#[test]
fn online_updates_match_a_replay() {
    let world = world();
    let events = vec![event(1, "impression", 2, 50), event(2, "save", 1, 30), event(3, "not_interested", 4, 20)];
    let replayed = Ranker::build(&world, &events, NOW);
    let mut online = Ranker::build(&world, &events[..1], NOW - 31 * HOUR_MS);
    online.observe(&world, &events[1..]);
    online.advance(&world, NOW);
    for id in [3, 5, 6] {
        assert_eq!(online.explain(&world, id, NOW).unwrap().score, replayed.explain(&world, id, NOW).unwrap().score);
    }
    assert_eq!(online.cursor, 3);
}

#[test]
fn signals_move_affinity_and_ignored_items_are_weak_negatives() {
    let world = world();
    let liked = Ranker::build(&world, &[event(1, "like", 3, 20)], NOW);
    let effect = liked.effect(3).unwrap();
    let source = effect.changes.iter().find(|c| c.key == "source:1").unwrap();
    assert!(source.after > source.before, "{effect:?}");
    assert_eq!(source.label, "Studio Notes");
    let ignored = Ranker::build(&world, &[event(1, "impression", 2, 30)], NOW);
    assert!(ignored.touched(2));
    let fresh = Ranker::build(&world, &[event(1, "impression", 2, 2)], NOW);
    assert!(!fresh.touched(2), "not ignored until a day has passed");
    let profile = ignored.profile(&world, NOW);
    let matchday = profile.sources.iter().find(|s| s.key == "source:2").unwrap();
    assert!(matchday.passed > 0.0 && matchday.affinity < 0.25);
}

#[test]
fn picks_diversify_explore_and_drop_near_duplicates() {
    let world = world();
    let ranker = Ranker::build(&world, &[event(1, "save", 3, 20)], NOW);
    let all: Vec<i64> = world.items.keys().copied().collect();
    let picks = ranker.pick(&world, &all, NOW, PickOptions { n: 8, explore: true, seed: 1 });
    let picked: Vec<i64> = picks.iter().map(|p| p.id).collect();
    // Items 1 and 6 are the same post twice; only one survives. Item 3 was acted on.
    assert!(!(picked.contains(&1) && picked.contains(&6)), "{picked:?}");
    assert!(!picked.contains(&3));
    assert_eq!(picks.iter().filter(|p| p.explore).count(), 1);
    let explored = picks.iter().find(|p| p.explore).unwrap();
    assert_eq!(explored.reasons[0].key, "explore");
    assert!(!explored.reasons[0].removable);
    // Same seed, same picks.
    assert_eq!(ranker.pick(&world, &all, NOW, PickOptions { n: 8, explore: true, seed: 1 }), picks);
    // Without exploration (Kin's shortlist), no explore slot.
    assert!(ranker.pick(&world, &all, NOW, PickOptions { n: 8, explore: false, seed: 1 }).iter().all(|p| !p.explore));
}

#[test]
fn corrections_remove_a_reason() {
    let world = world();
    let save = event(1, "save", 3, 20);
    let ranker = Ranker::build(&world, std::slice::from_ref(&save), NOW);
    let reasons = ranker.explain(&world, 1, NOW).unwrap().reasons;
    assert!(reasons.iter().any(|r| r.key == "source:1"), "{reasons:?}");
    let corrected = Ranker::build(
        &world,
        &[save.clone(), Event { data: Some(json!({ "reason": "source:1" })), ..event(2, "correction", 1, 1) }],
        NOW,
    );
    let after = corrected.explain(&world, 1, NOW).unwrap();
    assert!(!after.reasons.iter().any(|r| r.key == "source:1"), "{:?}", after.reasons);
    assert_eq!(after.features.iter().find(|f| f.name == "source").unwrap().value, 0.0);
    // Removing a clip as an anchor takes it out of taste too.
    let unanchored = Ranker::build(
        &world,
        &[Event { data: Some(json!({ "reason": "anchor:clip:inspiration/kiln.md" })), ..event(1, "correction", 1, 1) }],
        NOW,
    );
    assert!(unanchored.explain(&world, 1, NOW).unwrap().nearest.is_none());
    assert_eq!(unanchored.profile(&world, NOW).corrections, ["anchor:clip:inspiration/kiln.md"]);
}

#[test]
fn tools_answer_similar_topics_and_profile() {
    let world = world();
    let ranker = Ranker::build(&world, &[event(1, "save", 3, 20), event(2, "like", 1, 10)], NOW);
    let similar = ranker.similar(&world, &world.items[&3].vector, Some(3), 3);
    assert!([1, 6].contains(&similar[0].0), "{similar:?}");
    assert!(!similar.iter().any(|(id, _)| *id == 3));
    let topics = ranker.top_topics(&world, 30, NOW, 5);
    assert!(topics.iter().any(|t| t.topic == "glaze"), "{topics:?}");
    let profile = ranker.profile(&world, NOW);
    assert_eq!(profile.examples, 2);
    assert_eq!(profile.sources[0].name, "Studio Notes");
}

/// The offline evaluation: a reader with known taste, thirty days, replayed
/// day by day. The ranker has to beat newest first clearly.
#[test]
fn replay_beats_newest_first_on_a_synthetic_reader() {
    let start = 1_700_000_000_000 / DAY_MS * DAY_MS;
    let fixture = synthetic::fixture(42, 30, start);
    let report = replay::replay(&fixture.world, &fixture.events, 5);
    println!("{}", report.table());
    assert!(report.days.len() >= 25);
    assert!(report.ranker > report.recency + 0.15, "{}", report.table());
    // Even the first day beats it, from Inspiration alone.
    let first = &report.days[0];
    assert!(first.ranker >= first.recency, "{}", report.table());
    // And the second half is better than the first: it learns.
    let half = report.days.len() / 2;
    let mean = |days: &[replay::Day]| days.iter().map(|d| d.ranker).sum::<f64>() / days.len() as f64;
    assert!(mean(&report.days[half..]) >= mean(&report.days[..half]) - 0.02, "{}", report.table());
}

/// Not one lucky seed: other readers drawn from the same taste.
#[test]
fn replay_wins_across_seeds() {
    let start = 1_700_000_000_000 / DAY_MS * DAY_MS;
    for seed in 1..=5 {
        let fixture = synthetic::fixture(seed, 30, start);
        let report = replay::replay(&fixture.world, &fixture.events, 5);
        assert!(report.ranker > report.recency + 0.1, "seed {seed}: {}", report.table());
    }
}
