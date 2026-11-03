//! Catalogue-only age-neutral scoring. The real world (and stored item dates)
//! stays untouched for learning, presentation and the append-only event log.

use kintsugi_rank::{Ranker, World};
use std::collections::HashMap;
use std::hash::{Hash, Hasher};

/// Pending metadata is deliberately absent from search. Keep its local
/// embeddings across requests rather than repeatedly embedding an archive.
#[derive(Default)]
pub struct MetadataVectors {
    rows: HashMap<i64, (u64, u64, Vec<f32>)>,
}

impl MetadataVectors {
    pub fn vector(
        &mut self,
        id: i64,
        title: &str,
        body: &str,
        space: u64,
        embed: impl FnOnce() -> Vec<f32>,
    ) -> Vec<f32> {
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        (title, body).hash(&mut hash);
        let stamp = hash.finish();
        if let Some((previous, previous_space, vector)) = self.rows.get(&id)
            && *previous == stamp
            && *previous_space == space
        {
            return vector.clone();
        }
        let vector = embed();
        self.rows.insert(id, (stamp, space, vector.clone()));
        vector
    }
}

pub fn age_neutral_world(world: &World, catalogue: &[i64], now_ms: i64) -> World {
    let mut scoring = world.clone();
    for id in catalogue {
        if let Some(item) = scoring.items.get_mut(id) {
            item.published = now_ms / 1000;
        }
    }
    scoring
}

/// Neighbours need a close positive anchor in either vector space. The same
/// conservative threshold applies to hashed and model embeddings; links alone
/// are provenance, not sufficient evidence of taste.
pub fn neighbour_matches(ranker: &Ranker, scoring: &World, id: i64, now_ms: i64) -> bool {
    ranker
        .explain(scoring, id, now_ms)
        .is_some_and(|explanation| {
            explanation
                .features
                .iter()
                .any(|f| f.name == "nearest" && f.value >= 0.55)
        })
}

/// Limit the entire accumulated release pool, not just today's admissions.
/// Selection is independent of the requested pick count and uses no random
/// exploration to decide which two older pieces may compete with fresh work.
pub fn mixed_candidates(
    ranker: &Ranker,
    scoring: &World,
    fresh: &[i64],
    released: &[i64],
    now_ms: i64,
) -> Vec<i64> {
    let released: Vec<i64> = released
        .iter()
        .copied()
        .filter(|id| !ranker.touched(*id))
        .collect();
    let mut candidates = fresh.to_vec();
    candidates.extend(
        ranker
            .scores(scoring, &released, now_ms)
            .into_iter()
            .take(2)
            .map(|(id, _)| id),
    );
    candidates
}

#[cfg(test)]
mod tests {
    use super::*;
    use kintsugi_rank::{Event, Item, Media, PickOptions, Source};

    const NOW: i64 = 1_800_000_000_000;

    fn world() -> World {
        let mut world = World::default();
        world.sources.insert(
            1,
            Source {
                id: 1,
                title: "Essays".into(),
                added: NOW / 1000,
            },
        );
        for (id, published, vector) in [
            (1, NOW / 1000 - 86_400, vec![1.0, 0.0]),
            (2, NOW / 1000 - 10 * 365 * 86_400, vec![1.0, 0.0]),
            (3, NOW / 1000, vec![0.0, 1.0]),
            (4, NOW / 1000 - 365 * 86_400, vec![0.0, 1.0]),
            (5, NOW / 1000 - 2 * 365 * 86_400, vec![0.0, 1.0]),
        ] {
            world.items.insert(
                id,
                Item {
                    id,
                    source: 1,
                    title: format!("Essay {id}"),
                    author: None,
                    url: None,
                    topics: vec![],
                    media: Media::Article,
                    published,
                    length: 4000,
                    vector,
                    story: None,
                },
            );
        }
        world
    }

    #[test]
    fn older_taste_match_beats_fresh_irrelevant_without_changing_dates() {
        let world = world();
        let events = [Event {
            id: 1,
            at: NOW - 3_600_000,
            kind: "like".into(),
            item: Some(1),
            ..Default::default()
        }];
        let ranker = Ranker::build(&world, &events, NOW);
        // With the ordinary age penalty a decade-old match loses cold-start recency.
        assert_eq!(ranker.scores(&world, &[2, 3], NOW)[0].0, 3);
        let scoring = age_neutral_world(&world, &[2], NOW);
        assert_eq!(ranker.scores(&scoring, &[2, 3], NOW)[0].0, 2);
        let picks = ranker.pick(
            &scoring,
            &[2, 3],
            NOW,
            PickOptions {
                n: 1,
                explore: false,
                seed: 0,
            },
        );
        assert_eq!(picks[0].id, 2);
        assert_eq!(world.items[&2].published, NOW / 1000 - 10 * 365 * 86_400);
    }

    #[test]
    fn pending_metadata_embedding_is_cached_by_text_and_space() {
        let mut cache = MetadataVectors::default();
        let calls = std::cell::Cell::new(0);
        let embed = || {
            calls.set(calls.get() + 1);
            vec![1.0, 0.0]
        };
        cache.vector(1, "Title", "", 0, embed);
        cache.vector(1, "Title", "", 0, embed);
        assert_eq!(calls.get(), 1);
        cache.vector(1, "Title", "New summary", 0, embed);
        assert_eq!(calls.get(), 2);
        cache.vector(1, "Title", "New summary", 1, embed);
        assert_eq!(calls.get(), 3);
        cache.vector(1, "New title", "New summary", 1, embed);
        assert_eq!(calls.get(), 4);
    }

    #[test]
    fn neighbour_gate_requires_close_positive_taste() {
        let world = world();
        let cold = Ranker::build(&world, &[], NOW);
        assert!(!neighbour_matches(&cold, &world, 2, NOW));
        let events = [Event {
            id: 1,
            at: NOW - 3_600_000,
            kind: "like".into(),
            item: Some(1),
            ..Default::default()
        }];
        let ranker = Ranker::build(&world, &events, NOW);
        assert!(neighbour_matches(&ranker, &world, 2, NOW));
        assert!(!neighbour_matches(&ranker, &world, 3, NOW));
    }

    #[test]
    fn accumulated_releases_have_two_candidates_regardless_of_batch_size() {
        let world = world();
        let ranker = Ranker::build(&world, &[], NOW);
        let scoring = age_neutral_world(&world, &[2, 4, 5], NOW);
        let candidates = mixed_candidates(&ranker, &scoring, &[3], &[2, 4, 5], NOW);
        assert_eq!(candidates.len(), 3);
        for n in [1, 8, 20] {
            let picks = ranker.pick(
                &scoring,
                &candidates,
                NOW,
                PickOptions {
                    n,
                    explore: true,
                    seed: 0,
                },
            );
            assert!(picks.iter().filter(|p| [2, 4, 5].contains(&p.id)).count() <= 2);
        }
    }
}
