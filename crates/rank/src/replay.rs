//! Offline evaluation: replay the event log day by day. Each day, the ranker
//! is rebuilt from everything before that day (no peeking), ranks the items
//! he was shown that day, and is scored by NDCG@k against what he actually
//! did with them; a newest-first ordering of the same items is the baseline.

use crate::ranker::{DAY_MS, Event, KIN_SURFACE, Ranker, Signal, World, effective};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashMap};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Day {
    /// Days since the epoch (UTC).
    pub day: i64,
    pub shown: usize,
    pub relevant: usize,
    pub ranker: f64,
    pub recency: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub k: usize,
    pub days: Vec<Day>,
    /// Mean NDCG@k over days with at least one relevant item.
    pub ranker: f64,
    pub recency: f64,
}

/// How much an action says he wanted the item.
fn gain(signal: Signal) -> f64 {
    match signal {
        Signal::Save => 4.0,
        Signal::Note => 3.0,
        Signal::Like => 2.0,
        Signal::Discuss => 1.5,
        Signal::Open => 1.0,
        Signal::NotInterested | Signal::Ignored => 0.0,
    }
}

fn signal(kind: &str) -> Option<Signal> {
    Some(match kind {
        "save" => Signal::Save,
        "note" => Signal::Note,
        "like" => Signal::Like,
        "discuss" => Signal::Discuss,
        "open" | "open_original" => Signal::Open,
        _ => return None,
    })
}

fn ndcg(order: &[i64], gains: &HashMap<i64, f64>, k: usize) -> f64 {
    let dcg = |gs: &mut dyn Iterator<Item = f64>| gs.take(k).enumerate().map(|(i, g)| (2f64.powf(g) - 1.0) / (i as f64 + 2.0).log2()).sum::<f64>();
    let actual = dcg(&mut order.iter().map(|id| gains.get(id).copied().unwrap_or(0.0)));
    let mut ideal: Vec<f64> = gains.values().copied().collect();
    ideal.sort_by(|a, b| b.total_cmp(a));
    let best = dcg(&mut ideal.into_iter());
    if best == 0.0 { 0.0 } else { actual / best }
}

pub fn replay(world: &World, events: &[Event], k: usize) -> Report {
    let events = effective(events);
    let mut by_day: BTreeMap<i64, (BTreeSet<i64>, HashMap<i64, f64>)> = BTreeMap::new();
    for event in &events {
        let Some(item) = event.item else { continue };
        if event.surface.as_deref() == Some(KIN_SURFACE) {
            continue;
        }
        let day = event.at.div_euclid(DAY_MS);
        let entry = by_day.entry(day).or_default();
        if event.kind == "impression" {
            entry.0.insert(item);
        } else if let Some(signal) = signal(&event.kind) {
            let best = entry.1.entry(item).or_insert(0.0);
            *best = best.max(gain(signal));
        }
    }
    let mut days = Vec::new();
    for (day, (shown, acted)) in by_day {
        let gains: HashMap<i64, f64> = acted.into_iter().filter(|(id, g)| shown.contains(id) && *g > 0.0).collect();
        if gains.is_empty() {
            continue;
        }
        let start = day * DAY_MS;
        let before: Vec<Event> = events.iter().filter(|e| e.at < start).cloned().collect();
        let ranker = Ranker::build(world, &before, start);
        let candidates: Vec<i64> = shown.iter().copied().filter(|id| world.items.contains_key(id)).collect();
        let ranked: Vec<i64> = ranker.scores(world, &candidates, start).into_iter().map(|(id, _)| id).collect();
        let mut newest = candidates.clone();
        newest.sort_by_key(|id| std::cmp::Reverse((world.items[id].published, *id)));
        days.push(Day {
            day,
            shown: candidates.len(),
            relevant: gains.len(),
            ranker: ndcg(&ranked, &gains, k),
            recency: ndcg(&newest, &gains, k),
        });
    }
    let mean = |f: fn(&Day) -> f64| if days.is_empty() { 0.0 } else { days.iter().map(f).sum::<f64>() / days.len() as f64 };
    Report { k, ranker: mean(|d| d.ranker), recency: mean(|d| d.recency), days }
}

impl Report {
    /// A plain table for the example and test output.
    pub fn table(&self) -> String {
        let mut out = format!("day      shown  relevant  ranker@{k}  newest@{k}\n", k = self.k);
        for day in &self.days {
            out.push_str(&format!("{:<8} {:>5}  {:>8}  {:>8.3}  {:>8.3}\n", day.day, day.shown, day.relevant, day.ranker, day.recency));
        }
        out.push_str(&format!("mean NDCG@{}: ranker {:.3}, newest first {:.3} ({} days)\n", self.k, self.ranker, self.recency, self.days.len()));
        out
    }
}
