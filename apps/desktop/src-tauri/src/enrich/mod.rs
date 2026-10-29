//! Enrichment adds source material and organization, never the writer's words.

pub mod fetch;
mod storage;
pub mod think;
mod worker;

pub use worker::{Worker, start, wake};
