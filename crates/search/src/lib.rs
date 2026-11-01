//! Kintsugi's local hybrid search (see `docs/search.md`).
//!
//! One index serves the Inspiration library, Kin's `search` tool and the
//! Feed: SQLite FTS5 (BM25) for words, on-device model2vec embeddings for
//! meaning, merged with reciprocal rank fusion. The index lives in app data,
//! never in the vault; it holds copies that can always be rebuilt.
//!
//! No Tauri here: the desktop app owns where the file lives, when it
//! refreshes, and how the model is fetched.

pub mod embed;
mod index;
mod text;
pub mod vault;

pub use embed::{Embedder, Model2Vec, ModelSpec, POTION_BASE_8M};
pub use index::{Doc, Hit, Index, Kind, MIN_SIMILARITY, Matched, Query};
pub use text::SNIPPET_CHARS;

/// The scope feed items are indexed under, beside each vault's own scope.
pub const FEED_SCOPE: &str = "feed";

#[cfg(test)]
mod tests;
