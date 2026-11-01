//! The ranker: taste vectors, Beta-smoothed affinities and an online
//! logistic regression, all derived from the Feed's event log, plus
//! exploration, diversity and explanations at pick time.
//!
//! Everything here is a pure function of the world (items, sources, clips)
//! and the event log, so the app can rebuild it at any time, an undo can be
//! exact (the undone pair is dropped and the log replayed), and the offline
//! evaluation replays the same code day by day.

use crate::model::Ftrl;
use crate::rng::Rng;
use crate::vector::{Centroid, cosine};
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

pub const HOUR_MS: i64 = 3_600_000;
pub const DAY_MS: i64 = 24 * HOUR_MS;

/// An impression with no action this long after becomes a weak negative.
pub const IGNORED_AFTER_MS: i64 = 24 * HOUR_MS;
/// One ignored impression in this many trains the model (downsampling).
const IGNORED_SAMPLE: u64 = 2;
/// A source this new (or this rarely shown) gets an exploration boost.
const NEW_SOURCE_MS: i64 = 14 * DAY_MS;
const NEW_SOURCE_IMPRESSIONS: u32 = 8;
/// Beta prior for affinities: a quarter of things shown are wanted.
const PRIOR_A: f64 = 1.0;
const PRIOR_B: f64 = 3.0;
const PRIOR_MEAN: f64 = PRIOR_A / (PRIOR_A + PRIOR_B);
/// Examples it takes for the learned model to fully replace the cold start.
const WARM_EXAMPLES: f64 = 30.0;
/// MMR trade-off between relevance and novelty.
const MMR_LAMBDA: f64 = 0.7;
/// Each earlier pick by the same author (or source) shrinks relevance.
const AUTHOR_DECAY: f64 = 0.7;
const SOURCE_DECAY: f64 = 0.85;
/// Closer than this to an earlier pick is the same thing again.
const NEAR_DUPLICATE: f32 = 0.92;
/// A nearest anchor this close is worth naming in "Why this?".
const NAMEABLE_SIMILARITY: f32 = 0.25;
/// At most this many anchors are compared (most recent first).
const MAX_ANCHORS: usize = 400;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Media {
    Article,
    Video,
    Audio,
}

impl Media {
    pub fn parse(text: &str) -> Self {
        match text {
            "video" => Media::Video,
            "audio" => Media::Audio,
            _ => Media::Article,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Item {
    pub id: i64,
    pub source: i64,
    pub author: Option<String>,
    pub title: String,
    pub url: Option<String>,
    pub topics: Vec<String>,
    pub media: Media,
    /// Seconds since the epoch.
    pub published: i64,
    /// Characters of text.
    pub length: usize,
    /// Normalized, or empty when unknown.
    pub vector: Vec<f32>,
}

#[derive(Clone, Debug)]
pub struct Source {
    pub id: i64,
    pub title: String,
    /// Seconds since the epoch.
    pub added: i64,
}

/// An Inspiration clip: what he kept before the Feed existed, and the cold start.
#[derive(Clone, Debug)]
pub struct Clip {
    /// Its vault path.
    pub key: String,
    pub title: String,
    /// Seconds since the epoch.
    pub captured: i64,
    pub vector: Vec<f32>,
    pub site: Option<String>,
    pub author: Option<String>,
    pub topics: Vec<String>,
    /// The feed item it was saved from; its save event already counts.
    pub item: Option<i64>,
}

#[derive(Clone, Debug, Default)]
pub struct World {
    pub items: HashMap<i64, Item>,
    pub sources: HashMap<i64, Source>,
    pub clips: Vec<Clip>,
}

/// One row of the Feed's event log. `at` is milliseconds.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Event {
    pub id: i64,
    pub at: i64,
    pub kind: String,
    pub item: Option<i64>,
    pub source: Option<i64>,
    pub surface: Option<String>,
    pub data: Option<Value>,
}

/// Kin's own exposures. They are logged, and never train the ranker.
pub const KIN_SURFACE: &str = "kin";

/// What an event says about an item, strongest first.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Signal {
    Save,
    Note,
    Like,
    Discuss,
    Open,
    NotInterested,
    Ignored,
}

impl Signal {
    fn from_kind(kind: &str) -> Option<Self> {
        Some(match kind {
            "save" => Signal::Save,
            "note" => Signal::Note,
            "like" => Signal::Like,
            "discuss" => Signal::Discuss,
            "open" | "open_original" => Signal::Open,
            "not_interested" => Signal::NotInterested,
            _ => return None,
        })
    }

    /// X-style weights: save > note > like > open; Not interested strongly negative.
    pub fn weight(self) -> f64 {
        match self {
            Signal::Save => 4.0,
            Signal::Note => 3.0,
            Signal::Like => 2.0,
            Signal::Discuss => 1.5,
            Signal::Open => 1.0,
            Signal::NotInterested => 6.0,
            Signal::Ignored => 0.3,
        }
    }

    pub fn positive(self) -> bool {
        !matches!(self, Signal::NotInterested | Signal::Ignored)
    }

    /// What one signal adds to a Beta affinity: a save counts as one kept
    /// thing, an ignored impression as half a pass.
    fn evidence(self) -> f64 {
        match self {
            Signal::NotInterested => 1.5,
            Signal::Ignored => 0.5,
            positive => positive.weight() / 4.0,
        }
    }

    /// Strong enough to be a nearest-neighbour anchor.
    fn anchors(self) -> bool {
        matches!(self, Signal::Save | Signal::Note | Signal::Like)
    }
}

/// The features, in order. Names are stable: `explain` and `taste_profile` show them.
pub const FEATURES: [&str; 14] = [
    "bias",
    "taste_long",
    "taste_short",
    "nearest",
    "unwanted",
    "source",
    "author",
    "topic",
    "age",
    "length",
    "video",
    "audio",
    "nearest_x_fresh",
    "source_x_taste",
];
const N: usize = FEATURES.len();
/// Hand-set priors: the model learns a residual on top of these.
const PRIOR: [f64; N] = [-1.0, 1.0, 0.8, 2.0, -1.5, 3.0, 2.0, 2.0, -1.5, 0.2, 0.0, 0.0, 0.0, 0.0];

#[derive(Clone, Debug, Default, Serialize)]
pub struct Affinity {
    pub pos: f64,
    pub neg: f64,
}

impl Affinity {
    /// Beta-smoothed: how likely a thing with this key is wanted.
    pub fn mean(&self) -> f64 {
        (PRIOR_A + self.pos) / (PRIOR_A + PRIOR_B + self.pos + self.neg)
    }
    fn lift(&self) -> f64 {
        self.mean() - PRIOR_MEAN
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
pub enum AnchorKey {
    Item(i64),
    Clip(String),
}

impl AnchorKey {
    pub fn reason_key(&self) -> String {
        match self {
            AnchorKey::Item(id) => format!("anchor:item:{id}"),
            AnchorKey::Clip(path) => format!("anchor:clip:{path}"),
        }
    }
}

#[derive(Clone, Debug)]
struct Anchor {
    key: AnchorKey,
    title: String,
    vector: Vec<f32>,
    at: i64,
    clip: bool,
}

/// A label the ranker learned from, kept for topics and profiles.
#[derive(Clone, Debug)]
struct Label {
    at: i64,
    item: i64,
    signal: Signal,
}

/// What one action changed, for the like toast ("what it changed").
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Effect {
    pub item: i64,
    pub changes: Vec<Change>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub key: String,
    pub label: String,
    pub before: f64,
    pub after: f64,
}

/// One reason behind a pick. Removable reasons are corrections: removing one
/// logs a `correction` event and the ranker stops using that signal.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Reason {
    pub key: String,
    pub label: String,
    pub removable: bool,
    #[serde(skip)]
    pub weight: f64,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Pick {
    pub id: i64,
    pub score: f64,
    pub explore: bool,
    pub reasons: Vec<Reason>,
}

#[derive(Clone, Copy, Debug)]
pub struct PickOptions {
    pub n: usize,
    /// Reserve 10–15% of slots for Thompson-sampled exploration.
    pub explore: bool,
    pub seed: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureValue {
    pub name: &'static str,
    pub value: f64,
    pub weight: f64,
    pub contribution: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Explained {
    pub id: i64,
    pub score: f64,
    pub cold: f64,
    pub learned: f64,
    /// How much of the score is the learned model (the rest is the cold start).
    pub learned_share: f64,
    pub nearest: Option<String>,
    pub features: Vec<FeatureValue>,
    pub reasons: Vec<Reason>,
}

struct Scored {
    x: [f64; N],
    cold: f64,
    learned: f64,
    score: f64,
    nearest: Option<(usize, f32)>,
    topic: Option<(String, f64)>,
    fresh_hours: f64,
}

#[derive(Clone, Debug)]
pub struct Ranker {
    long: Centroid,
    short: Centroid,
    unwanted: Centroid,
    anchors: Vec<Anchor>,
    affinity: HashMap<String, Affinity>,
    /// Thompson arms: unweighted successes and failures per source and topic.
    arms: HashMap<String, (f64, f64)>,
    model: Ftrl,
    examples: f64,
    /// Impressions waiting to become ignored: by (time, item), and by item.
    pending: BTreeSet<(i64, i64)>,
    pending_at: HashMap<i64, i64>,
    acted: HashSet<(i64, Signal)>,
    touched: HashSet<i64>,
    shown: HashMap<i64, u32>,
    corrections: BTreeSet<String>,
    labels: Vec<Label>,
    effects: HashMap<i64, Effect>,
    /// Latest event time seen (ms).
    clock: i64,
    /// Highest event id consumed.
    pub cursor: i64,
}

/// Drops undone pairs (like/unlike, Not interested/undo, notes cleared,
/// corrections undone) and Kin's own exposures, keeping time order.
pub fn effective(events: &[Event]) -> Vec<Event> {
    let mut dropped = vec![false; events.len()];
    let mut open: HashMap<(String, String), Vec<usize>> = HashMap::new();
    for (i, event) in events.iter().enumerate() {
        if event.surface.as_deref() == Some(KIN_SURFACE) || event.kind == "kin_pick" {
            dropped[i] = true;
            continue;
        }
        let item = event.item.map(|i| i.to_string()).unwrap_or_default();
        let reason = || event.data.as_ref().and_then(|d| d["reason"].as_str()).unwrap_or_default().to_string();
        let (opens, key) = match event.kind.as_str() {
            "like" => (true, ("like".to_string(), item)),
            "unlike" => (false, ("like".to_string(), item)),
            "not_interested" => (true, ("ni".to_string(), item)),
            "undo_not_interested" => (false, ("ni".to_string(), item)),
            "note" => (true, ("note".to_string(), item)),
            "note_cleared" => (false, ("note".to_string(), item)),
            "correction" => (true, ("correction".to_string(), reason())),
            "undo_correction" => (false, ("correction".to_string(), reason())),
            _ => continue,
        };
        if opens {
            open.entry(key).or_default().push(i);
        } else {
            dropped[i] = true;
            // A cleared note undoes every edit before it; the others undo one.
            let stack = open.entry(key.clone()).or_default();
            if key.0 == "note" {
                stack.drain(..).for_each(|j| dropped[j] = true);
            } else if let Some(j) = stack.pop() {
                dropped[j] = true;
            }
        }
    }
    events.iter().zip(dropped).filter(|(_, d)| !d).map(|(e, _)| e.clone()).collect()
}

/// Whether consuming these events online would differ from a replay: undo
/// events and corrections need the whole log replayed.
pub fn needs_rebuild(events: &[Event]) -> bool {
    events.iter().any(|e| matches!(e.kind.as_str(), "unlike" | "undo_not_interested" | "note_cleared" | "correction" | "undo_correction"))
}

fn hash(value: i64) -> u64 {
    let mut z = (value as u64).wrapping_add(0x9e37_79b9_7f4a_7c15);
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z ^ (z >> 27)
}

fn norm_name(name: &str) -> String {
    name.trim().to_lowercase()
}

impl Ranker {
    /// Replays the whole log over the world. Undone pairs are dropped first,
    /// so an undo is exact.
    pub fn build(world: &World, events: &[Event], now_ms: i64) -> Self {
        let events = effective(events);
        let corrections: BTreeSet<String> = events
            .iter()
            .filter(|e| e.kind == "correction")
            .filter_map(|e| e.data.as_ref()?.get("reason")?.as_str().map(str::to_string))
            .collect();
        let mut ranker = Ranker {
            long: Centroid::new(90.0),
            short: Centroid::new(7.0),
            unwanted: Centroid::new(90.0),
            anchors: Vec::new(),
            affinity: HashMap::new(),
            arms: HashMap::new(),
            model: Ftrl::new(N),
            examples: 0.0,
            pending: BTreeSet::new(),
            pending_at: HashMap::new(),
            acted: HashSet::new(),
            touched: HashSet::new(),
            shown: HashMap::new(),
            corrections,
            labels: Vec::new(),
            effects: HashMap::new(),
            clock: 0,
            cursor: 0,
        };
        ranker.seed_clips(world);
        ranker.observe(world, &events);
        ranker.advance(world, now_ms);
        ranker.cursor = events.iter().map(|e| e.id).max().unwrap_or(0).max(ranker.cursor);
        ranker
    }

    /// Cold start: what he already kept in Inspiration is taste, anchors and
    /// pseudo-counts for the sources, authors and topics it came from.
    fn seed_clips(&mut self, world: &World) {
        let sources: Vec<(String, i64)> = world.sources.values().map(|s| (norm_name(&s.title), s.id)).collect();
        for clip in &world.clips {
            if clip.item.is_some() {
                continue;
            }
            let key = AnchorKey::Clip(clip.key.clone());
            if self.corrections.contains(&key.reason_key()) {
                continue;
            }
            let at = clip.captured * 1000;
            self.long.add(&clip.vector, 3.0, at);
            self.short.add(&clip.vector, 3.0, at);
            if !clip.vector.is_empty() {
                self.anchors.push(Anchor { key, title: clip.title.clone(), vector: clip.vector.clone(), at, clip: true });
            }
            for topic in &clip.topics {
                self.affinity.entry(format!("topic:{topic}")).or_default().pos += 1.0;
            }
            if let Some(site) = clip.site.as_deref().map(norm_name)
                && let Some((_, id)) = sources.iter().find(|(title, _)| *title == site)
            {
                self.affinity.entry(format!("source:{id}")).or_default().pos += 1.0;
            }
            if let Some(author) = clip.author.as_deref().map(norm_name).filter(|a| !a.is_empty()) {
                self.affinity.entry(format!("author:{author}")).or_default().pos += 1.0;
            }
        }
    }

    /// Consumes new events online. Callers rebuild instead when
    /// [`needs_rebuild`] says so.
    pub fn observe(&mut self, world: &World, events: &[Event]) {
        for event in events {
            self.cursor = self.cursor.max(event.id);
            if event.surface.as_deref() == Some(KIN_SURFACE) || event.kind == "kin_pick" {
                continue;
            }
            self.mature(world, event.at);
            self.clock = self.clock.max(event.at);
            let Some(id) = event.item else { continue };
            if !world.items.contains_key(&id) {
                continue;
            }
            if event.kind == "impression" {
                *self.shown.entry(world.items[&id].source).or_default() += 1;
                if !self.touched.contains(&id) && !self.pending_at.contains_key(&id) {
                    self.pending.insert((event.at, id));
                    self.pending_at.insert(id, event.at);
                }
                continue;
            }
            let Some(signal) = Signal::from_kind(&event.kind) else { continue };
            self.touched.insert(id);
            if let Some(at) = self.pending_at.remove(&id) {
                self.pending.remove(&(at, id));
            }
            if self.acted.insert((id, signal)) {
                self.learn(world, id, signal, event.at);
            }
        }
    }

    /// Impressions old enough without an action become ignored.
    pub fn advance(&mut self, world: &World, now_ms: i64) {
        self.mature(world, now_ms);
        self.clock = self.clock.max(now_ms);
    }

    fn mature(&mut self, world: &World, now_ms: i64) {
        while let Some(&(at, id)) = self.pending.iter().next() {
            if at + IGNORED_AFTER_MS > now_ms {
                break;
            }
            self.pending.remove(&(at, id));
            self.pending_at.remove(&id);
            self.touched.insert(id);
            self.learn(world, id, Signal::Ignored, at + IGNORED_AFTER_MS);
        }
    }

    fn keys(&self, item: &Item) -> Vec<String> {
        let mut keys = vec![format!("source:{}", item.source)];
        if let Some(author) = item.author.as_deref().map(norm_name).filter(|a| !a.is_empty()) {
            keys.push(format!("author:{author}"));
        }
        keys.extend(item.topics.iter().map(|t| format!("topic:{t}")));
        keys
    }

    fn learn(&mut self, world: &World, id: i64, signal: Signal, at: i64) {
        let item = &world.items[&id];
        let weight = signal.weight();
        let scored = self.score_item(item, at);
        // Train on what the ranker knew before this action.
        if signal != Signal::Ignored || hash(id).is_multiple_of(IGNORED_SAMPLE) {
            let y = if signal.positive() { 1.0 } else { 0.0 };
            self.model.update(&PRIOR, &scored.x, y, weight);
        }
        if signal != Signal::Ignored {
            self.examples += 1.0;
        }
        let keys = self.keys(item);
        let before: Vec<f64> = keys.iter().map(|k| self.affinity.get(k).map_or(PRIOR_MEAN, Affinity::mean)).collect();
        for key in &keys {
            let affinity = self.affinity.entry(key.clone()).or_default();
            let arm = self.arms.entry(key.clone()).or_default();
            if signal.positive() {
                affinity.pos += signal.evidence();
                arm.0 += 1.0;
            } else {
                affinity.neg += signal.evidence();
                arm.1 += 1.0;
            }
        }
        let anchor = AnchorKey::Item(id);
        let excluded = self.corrections.contains(&anchor.reason_key());
        if signal.positive() && !excluded {
            self.long.add(&item.vector, weight, at);
            self.short.add(&item.vector, weight, at);
            if signal.anchors() && !item.vector.is_empty() && !self.anchors.iter().any(|a| a.key == anchor) {
                self.anchors.push(Anchor { key: anchor, title: item.title.clone(), vector: item.vector.clone(), at, clip: false });
            }
        } else if signal == Signal::NotInterested && !excluded {
            self.unwanted.add(&item.vector, 1.0, at);
        }
        if signal != Signal::Ignored {
            self.labels.push(Label { at, item: id, signal });
        }
        if signal.positive() && signal != Signal::Open {
            let changes = keys
                .iter()
                .zip(before)
                .filter(|(key, _)| !self.corrections.contains(*key))
                .map(|(key, before)| Change {
                    key: key.clone(),
                    label: self.key_label(world, key),
                    before: round(before),
                    after: round(self.affinity[key].mean()),
                })
                .collect();
            self.effects.insert(id, Effect { item: id, changes });
        }
    }

    /// A readable name for an affinity or anchor key.
    pub fn key_label(&self, world: &World, key: &str) -> String {
        if let Some(id) = key.strip_prefix("source:").and_then(|s| s.parse::<i64>().ok()) {
            return world.sources.get(&id).map_or_else(|| format!("source {id}"), |s| s.title.clone());
        }
        if let Some(author) = key.strip_prefix("author:") {
            return world
                .items
                .values()
                .find_map(|i| i.author.as_ref().filter(|a| norm_name(a) == author).cloned())
                .unwrap_or_else(|| author.to_string());
        }
        if let Some(topic) = key.strip_prefix("topic:") {
            return topic.to_string();
        }
        if let Some(anchor) = self.anchors.iter().find(|a| a.key.reason_key() == key) {
            return anchor.title.clone();
        }
        key.to_string()
    }

    /// What the last strong action on `item` changed.
    pub fn effect(&self, item: i64) -> Option<&Effect> {
        self.effects.get(&item)
    }

    pub fn corrections(&self) -> impl Iterator<Item = &String> {
        self.corrections.iter()
    }

    /// Items he already acted on (or ignored); picks skip them.
    pub fn touched(&self, item: i64) -> bool {
        self.touched.contains(&item) || self.pending_at.get(&item).is_some_and(|at| *at + IGNORED_AFTER_MS <= self.clock)
    }

    /// How much of the score the learned model carries.
    pub fn learned_share(&self) -> f64 {
        (self.examples / WARM_EXAMPLES).min(1.0)
    }

    fn lift(&self, key: &str) -> f64 {
        if self.corrections.contains(key) {
            return 0.0;
        }
        self.affinity.get(key).map_or(0.0, Affinity::lift)
    }

    fn score_item(&self, item: &Item, now_ms: i64) -> Scored {
        let long = self.long.direction();
        let short = self.short.direction();
        let unwanted = self.unwanted.direction();
        let v = &item.vector;
        let mut nearest: Option<(usize, f32)> = None;
        let start = self.anchors.len().saturating_sub(MAX_ANCHORS);
        for (i, anchor) in self.anchors.iter().enumerate().skip(start) {
            if anchor.key == AnchorKey::Item(item.id) {
                continue;
            }
            let similarity = cosine(&anchor.vector, v);
            if nearest.is_none_or(|(_, best)| similarity > best) {
                nearest = Some((i, similarity));
            }
        }
        let near = nearest.map_or(0.0, |(_, s)| f64::from(s.max(0.0)));
        let source = self.lift(&format!("source:{}", item.source));
        let author = item.author.as_deref().map(norm_name).filter(|a| !a.is_empty()).map_or(0.0, |a| self.lift(&format!("author:{a}")));
        let topic = item
            .topics
            .iter()
            .map(|t| (t.clone(), self.lift(&format!("topic:{t}"))))
            .max_by(|a, b| a.1.total_cmp(&b.1));
        let topic_lift = topic.as_ref().map_or(0.0, |t| t.1);
        let hours = ((now_ms - item.published * 1000) as f64 / HOUR_MS as f64).max(0.0);
        let age = (hours.ln_1p() / 720f64.ln_1p()).min(1.2);
        let taste_long = f64::from(cosine(&long, v));
        let x = [
            1.0,
            taste_long,
            f64::from(cosine(&short, v)),
            near,
            f64::from(cosine(&unwanted, v)).max(0.0),
            source,
            author,
            topic_lift,
            age,
            (item.length as f64).ln_1p() / 20_001f64.ln(),
            f64::from(u8::from(item.media == Media::Video)),
            f64::from(u8::from(item.media == Media::Audio)),
            near * (1.0 - age).max(0.0),
            source * taste_long,
        ];
        let learned = self.model.predict(&PRIOR, &x);
        // Until there's history: recency, per-source priors, Inspiration taste.
        let recency = (-hours / 72.0).exp();
        let source_prior = if self.corrections.contains(&format!("source:{}", item.source)) {
            PRIOR_MEAN
        } else {
            self.affinity.get(&format!("source:{}", item.source)).map_or(PRIOR_MEAN, Affinity::mean)
        };
        let cold = 0.45 * recency + 0.2 * source_prior + 0.35 * near.max(taste_long).clamp(0.0, 1.0);
        let share = self.learned_share();
        Scored { x, cold, learned, score: (1.0 - share) * cold + share * learned, nearest, topic, fresh_hours: hours }
    }

    fn reasons(&self, world: &World, item: &Item, scored: &Scored) -> Vec<Reason> {
        let mut reasons = Vec::new();
        let weights: Vec<f64> = (0..N).map(|i| PRIOR[i] + self.model.weight(i)).collect();
        let contribution = |i: usize| weights[i] * scored.x[i];
        if let Some((index, similarity)) = scored.nearest.filter(|(_, s)| *s >= NAMEABLE_SIMILARITY) {
            let anchor = &self.anchors[index];
            let how = if anchor.clip { "in Inspiration" } else { "which you kept" };
            reasons.push(Reason {
                key: anchor.key.reason_key(),
                label: format!("Close to “{}”, {how}", anchor.title),
                removable: true,
                weight: contribution(3) + f64::from(similarity),
            });
        }
        let source_key = format!("source:{}", item.source);
        if self.lift(&source_key) > 0.05 {
            let name = self.key_label(world, &source_key);
            reasons.push(Reason { key: source_key, label: format!("You often keep things from {name}"), removable: true, weight: contribution(5) });
        }
        if let Some(author) = item.author.as_deref().filter(|a| !a.trim().is_empty()) {
            let key = format!("author:{}", norm_name(author));
            if self.lift(&key) > 0.05 && world.sources.get(&item.source).is_none_or(|s| norm_name(&s.title) != norm_name(author)) {
                reasons.push(Reason { key, label: format!("You’ve liked {author} before"), removable: true, weight: contribution(6) });
            }
        }
        if let Some((topic, lift)) = scored.topic.as_ref().filter(|t| t.1 > 0.05) {
            reasons.push(Reason {
                key: format!("topic:{topic}"),
                label: format!("About {topic}, a topic you keep"),
                removable: true,
                weight: weights[7] * lift,
            });
        }
        if scored.x[2] > 0.3 && reasons.is_empty() {
            reasons.push(Reason { key: "taste".into(), label: "Like what you’ve been keeping this week".into(), removable: false, weight: contribution(2) });
        }
        if scored.fresh_hours < 6.0 {
            let label = if scored.fresh_hours < 1.0 { "New in the last hour".to_string() } else { format!("New: {:.0} hours ago", scored.fresh_hours.floor().max(1.0)) };
            reasons.push(Reason { key: "fresh".into(), label, removable: false, weight: 0.1 });
        }
        if self.learned_share() < 0.5 {
            reasons.push(Reason {
                key: "cold".into(),
                label: "Still learning: mostly what’s recent and what’s in Inspiration".into(),
                removable: false,
                weight: -1.0,
            });
        }
        reasons.sort_by(|a, b| b.weight.total_cmp(&a.weight));
        reasons.truncate(4);
        reasons
    }

    /// The relevance of every candidate, best first. No exploration or diversity.
    pub fn scores(&self, world: &World, candidates: &[i64], now_ms: i64) -> Vec<(i64, f64)> {
        let mut out: Vec<(i64, f64)> = candidates
            .iter()
            .filter_map(|id| world.items.get(id))
            .map(|item| (item.id, self.score_item(item, now_ms).score))
            .collect();
        out.sort_by(|a, b| b.1.total_cmp(&a.1).then(b.0.cmp(&a.0)));
        out
    }

    /// Why an item scores what it does.
    pub fn explain(&self, world: &World, id: i64, now_ms: i64) -> Option<Explained> {
        let item = world.items.get(&id)?;
        let scored = self.score_item(item, now_ms);
        let features = FEATURES
            .iter()
            .enumerate()
            .map(|(i, name)| {
                let weight = PRIOR[i] + self.model.weight(i);
                FeatureValue { name, value: round(scored.x[i]), weight: round(weight), contribution: round(weight * scored.x[i]) }
            })
            .collect();
        Some(Explained {
            id,
            score: round(scored.score),
            cold: round(scored.cold),
            learned: round(scored.learned),
            learned_share: round(self.learned_share()),
            nearest: scored.nearest.filter(|(_, s)| *s >= NAMEABLE_SIMILARITY).map(|(i, _)| self.anchors[i].title.clone()),
            features,
            reasons: self.reasons(world, item, &scored),
        })
    }

    /// Thompson sample for an arm, with optimism for new sources.
    fn sample(&self, rng: &mut Rng, key: &str, new: bool) -> f64 {
        let (wins, losses) = self.arms.get(key).copied().unwrap_or_default();
        let theta = rng.beta(1.0 + wins, 1.0 + losses);
        if new { theta.max(rng.beta(1.0 + wins, 1.0 + losses)) + 0.05 } else { theta }
    }

    fn is_new_source(&self, world: &World, source: i64, now_ms: i64) -> bool {
        let recent = world.sources.get(&source).is_some_and(|s| now_ms - s.added * 1000 < NEW_SOURCE_MS);
        recent || self.shown.get(&source).copied().unwrap_or(0) < NEW_SOURCE_IMPRESSIONS
    }

    /// Picked for you: relevance, then MMR diversity with author and source
    /// decay and near-duplicate removal, with exploration slots filled by
    /// Thompson sampling over sources and topics.
    pub fn pick(&self, world: &World, candidates: &[i64], now_ms: i64, options: PickOptions) -> Vec<Pick> {
        let mut pool: Vec<(&Item, Scored)> = candidates
            .iter()
            .filter_map(|id| world.items.get(id))
            .filter(|item| !self.touched(item.id))
            .map(|item| (item, self.score_item(item, now_ms)))
            .collect();
        pool.sort_by(|a, b| b.1.score.total_cmp(&a.1.score).then(b.0.id.cmp(&a.0.id)));
        pool.truncate(300);
        if pool.is_empty() || options.n == 0 {
            return Vec::new();
        }
        let duplicate = |chosen: &[usize], candidate: usize| {
            let item = pool[candidate].0;
            chosen.iter().any(|&c| {
                let other = pool[c].0;
                cosine(&other.vector, &item.vector) >= NEAR_DUPLICATE
                    || (!item.title.is_empty() && norm_name(&other.title) == norm_name(&item.title))
                    || (item.url.is_some() && other.url == item.url)
            })
        };
        let mut explore_slots = if options.explore && options.n >= 4 { ((options.n as f64 * 0.125).round() as usize).max(1) } else { 0 };
        // A small pool still keeps room for exploring.
        let mut unique: Vec<usize> = Vec::new();
        for i in 0..pool.len() {
            if !duplicate(&unique, i) {
                unique.push(i);
            }
        }
        explore_slots = explore_slots.min(unique.len().saturating_sub(1));
        let exploit = (options.n - explore_slots).min(unique.len() - explore_slots);
        let (low, high) = pool.iter().fold((f64::MAX, f64::MIN), |(lo, hi), (_, s)| (lo.min(s.score), hi.max(s.score)));
        let span = (high - low).max(1e-9);

        let mut chosen: Vec<usize> = Vec::new();
        while chosen.len() < exploit {
            let mut best: Option<(usize, f64)> = None;
            for (i, (item, scored)) in pool.iter().enumerate() {
                if chosen.contains(&i) || duplicate(&chosen, i) {
                    continue;
                }
                let relevance = (scored.score - low) / span;
                let authors = chosen.iter().filter(|&&c| item.author.is_some() && pool[c].0.author == item.author).count();
                let sources = chosen.iter().filter(|&&c| pool[c].0.source == item.source).count();
                let decayed = relevance * AUTHOR_DECAY.powi(authors as i32) * SOURCE_DECAY.powi(sources as i32);
                let redundancy = chosen.iter().map(|&c| f64::from(cosine(&pool[c].0.vector, &item.vector))).fold(0.0, f64::max);
                let value = MMR_LAMBDA * decayed - (1.0 - MMR_LAMBDA) * redundancy;
                if best.is_none_or(|(_, b)| value > b) {
                    best = Some((i, value));
                }
            }
            let Some((i, _)) = best else { break };
            chosen.push(i);
        }

        let mut rng = Rng::new(options.seed);
        let mut explored: Vec<usize> = Vec::new();
        for _ in 0..explore_slots {
            let mut best: Option<(usize, f64)> = None;
            for (i, (item, scored)) in pool.iter().enumerate() {
                let taken = [chosen.as_slice(), explored.as_slice()].concat();
                if taken.contains(&i) || duplicate(&taken, i) {
                    continue;
                }
                let new = self.is_new_source(world, item.source, now_ms);
                let source = self.sample(&mut rng, &format!("source:{}", item.source), new);
                let topic = item.topics.iter().map(|t| self.sample(&mut rng, &format!("topic:{t}"), false)).fold(0.0, f64::max);
                let fresh = (-scored.fresh_hours / 72.0).exp();
                let theta = (0.5 * source + 0.5 * topic) * (0.6 + 0.4 * fresh);
                if best.is_none_or(|(_, b)| theta > b) {
                    best = Some((i, theta));
                }
            }
            let Some((i, _)) = best else { break };
            explored.push(i);
        }

        let mut picks: Vec<Pick> = chosen
            .iter()
            .map(|&i| Pick { id: pool[i].0.id, score: round(pool[i].1.score), explore: false, reasons: self.reasons(world, pool[i].0, &pool[i].1) })
            .collect();
        for (k, &i) in explored.iter().enumerate() {
            let (item, scored) = &pool[i];
            let new = self.is_new_source(world, item.source, now_ms);
            let name = world.sources.get(&item.source).map_or("this source".to_string(), |s| s.title.clone());
            let label = if new { format!("Exploring: {name} is new to you") } else { format!("Exploring: a change from your usual, from {name}") };
            let mut reasons = vec![Reason { key: "explore".into(), label, removable: false, weight: 1.0 }];
            reasons.extend(self.reasons(world, item, scored).into_iter().filter(|r| r.key != "cold").take(2));
            let at = ((k + 1) * options.n / (explore_slots + 1)).saturating_sub(1).min(picks.len());
            picks.insert(at, Pick { id: item.id, score: round(scored.score), explore: true, reasons });
        }
        picks
    }

    /// Feed items nearest to a vector, excluding `except`.
    pub fn similar(&self, world: &World, vector: &[f32], except: Option<i64>, n: usize) -> Vec<(i64, f64)> {
        let mut out: Vec<(i64, f64)> = world
            .items
            .values()
            .filter(|i| Some(i.id) != except)
            .map(|i| (i.id, f64::from(cosine(vector, &i.vector))))
            .filter(|(_, s)| *s > 0.05)
            .collect();
        out.sort_by(|a, b| b.1.total_cmp(&a.1).then(b.0.cmp(&a.0)));
        out.truncate(n);
        out.into_iter().map(|(id, s)| (id, round(s))).collect()
    }

    /// Topics of what he kept (and clipped) in the last `days`, by weight.
    pub fn top_topics(&self, world: &World, days: i64, now_ms: i64, n: usize) -> Vec<TopicWeight> {
        let since = now_ms - days * DAY_MS;
        let mut topics: BTreeMap<String, (f64, usize)> = BTreeMap::new();
        for label in self.labels.iter().filter(|l| l.at >= since && l.signal.positive()) {
            if let Some(item) = world.items.get(&label.item) {
                for topic in &item.topics {
                    let entry = topics.entry(topic.clone()).or_default();
                    entry.0 += label.signal.weight();
                    entry.1 += 1;
                }
            }
        }
        for clip in world.clips.iter().filter(|c| c.item.is_none() && c.captured * 1000 >= since) {
            for topic in &clip.topics {
                let entry = topics.entry(topic.clone()).or_default();
                entry.0 += Signal::Save.weight();
                entry.1 += 1;
            }
        }
        let mut out: Vec<TopicWeight> = topics
            .into_iter()
            .filter(|(topic, _)| !self.corrections.contains(&format!("topic:{topic}")))
            .map(|(topic, (weight, items))| TopicWeight { topic, weight: round(weight), items })
            .collect();
        out.sort_by(|a, b| b.weight.total_cmp(&a.weight).then(a.topic.cmp(&b.topic)));
        out.truncate(n);
        out
    }

    /// What the ranker believes about him, compactly.
    pub fn profile(&self, world: &World, now_ms: i64) -> Profile {
        let top = |prefix: &str| {
            let mut out: Vec<KeyAffinity> = self
                .affinity
                .iter()
                .filter(|(k, _)| k.starts_with(prefix) && !self.corrections.contains(*k))
                .map(|(k, a)| KeyAffinity { key: k.clone(), name: self.key_label(world, k), affinity: round(a.mean()), kept: round(a.pos), passed: round(a.neg) })
                .collect();
            out.sort_by(|a, b| b.affinity.total_cmp(&a.affinity).then(a.key.cmp(&b.key)));
            out.truncate(5);
            out
        };
        let mut recent: Vec<&Anchor> = self.anchors.iter().collect();
        recent.sort_by_key(|a| std::cmp::Reverse(a.at));
        Profile {
            examples: self.examples as usize,
            learned_share: round(self.learned_share()),
            anchors: self.anchors.len(),
            recent_anchors: recent.iter().take(5).map(|a| a.title.clone()).collect(),
            long_mass: round(self.long.mass_at(now_ms)),
            short_mass: round(self.short.mass_at(now_ms)),
            sources: top("source:"),
            authors: top("author:"),
            topics: self.top_topics(world, 90, now_ms, 8),
            weights: FEATURES.iter().enumerate().map(|(i, name)| (name.to_string(), round(PRIOR[i] + self.model.weight(i)))).collect(),
            corrections: self.corrections.iter().cloned().collect(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicWeight {
    pub topic: String,
    pub weight: f64,
    pub items: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyAffinity {
    pub key: String,
    pub name: String,
    pub affinity: f64,
    pub kept: f64,
    pub passed: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub examples: usize,
    pub learned_share: f64,
    pub anchors: usize,
    pub recent_anchors: Vec<String>,
    pub long_mass: f64,
    pub short_mass: f64,
    pub sources: Vec<KeyAffinity>,
    pub authors: Vec<KeyAffinity>,
    pub topics: Vec<TopicWeight>,
    pub weights: BTreeMap<String, f64>,
    pub corrections: Vec<String>,
}

fn round(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}
