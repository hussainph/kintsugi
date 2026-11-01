//! Kintsugi's Feed ranking (see `docs/ranking.md` and "Ranking without
//! burning tokens" in `docs/vision.md`). Local machine learning only: no LLM
//! calls anywhere in this crate.
//!
//! - Taste vectors from what he liked, noted and saved (long and short
//!   half-lives), plus the nearest kept thing (clips and items), so separate
//!   interests don't blur together; a centroid of Not interested pulls away.
//! - Online logistic regression (FTRL-Proximal) over a handful of features,
//!   learning from X-style weighted labels in the Feed's event log.
//! - Thompson-sampled exploration slots, MMR diversity, author decay and
//!   near-duplicate removal at pick time; reasons for every pick.
//! - A day-by-day offline replay against newest first.
//!
//! No Tauri and no SQLite here: the app turns its Feed store, search index
//! and clips into a [`World`] and an event list.

pub mod model;
pub mod ranker;
pub mod replay;
pub mod rng;
pub mod synthetic;
pub mod text;
pub mod vector;

pub use ranker::{
    Change, Clip, DAY_MS, Effect, Event, Explained, HOUR_MS, Item, KIN_SURFACE, Media, Pick, PickOptions, Profile, Ranker, Reason,
    Source, TopicWeight, World, effective, needs_rebuild,
};

#[cfg(test)]
mod tests;
