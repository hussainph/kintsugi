# Ranking

The contract for Feed ranking as built (KI-32): **Picked for you**, its
"Why this?", what a like changed, and Kin's ranking tools. Direction lives in
[vision.md](vision.md) › "Ranking without burning tokens". If you change the
code this describes, change this document in the same commit.

**No LLM calls.** Everything here is local arithmetic over the Feed's event
log, its items and the Inspiration clips.

Code: `crates/rank` (`kintsugi-rank`, no Tauri and no SQLite) holds the
ranker; `apps/desktop/src-tauri/src/feed/picked.rs` feeds it and holds the
commands and Kin's tools; `feed/store/ranking.rs` holds the store's reads;
the webview's side is `apps/desktop/src/feed/Picked.tsx` and `ranking.ts`.

## What it learns from

The ranker is a pure function of three things, rebuilt from scratch when
needed and updated online otherwise:

- **Items and sources** from `feed.sqlite` (every item, including dismissed
  and expired ones, since they are training examples). Candidates for a pick
  are the visible items.
- **Inspiration clips** (`clip_list`): the cold start. A clip saved from a
  feed item is skipped (its `save` event already counts).
- **The event log** (see [feed.md](feed.md)), oldest first.

### Labels

| Event | Label | Weight |
| --- | --- | --- |
| `save` | wanted | 4 |
| `note` | wanted | 3 |
| `like` | wanted | 2 |
| `discuss` | wanted | 1.5 |
| `open`, `open_original` | wanted | 1 |
| `not_interested` | not wanted | 6 |
| an `impression` with no action 24 h later | not wanted (ignored) | 0.3, one in two trains the model |

Each signal counts once per item. **Undo is exact:** `unlike` removes its
`like`, `undo_not_interested` its `not_interested`, `note_cleared` every
`note` before it, and `undo_correction` its `correction`; the pair is dropped
and the log replayed (`kintsugi_rank::effective`). Events with surface `kin`
and `kin_pick` events are Kin's own exposures and are never learned from.

### Vectors

Once the search index's model is loaded ([search.md](search.md)), an item's
vector is the normalized mean of its indexed chunks (`Index::doc_vectors`);
items or clips not in the index are embedded with the same model from their
title and summary. Before that (headless runs, tests, first launch), vectors
are a **hashed bag of words** (`text::hashed`: 256 signed feature-hashing
dimensions over stemmed content words, title counted double). A change of
space rebuilds the ranker. Topics are cheap keywords: a clip's tags, else the
most telling words of a title (`text::topics`, at most three).

## The model

- **Taste vectors.** Exponentially decayed weighted centroids of what he
  wanted: a long one (90-day half-life) and a short one (7 days). Clips seed
  both at weight 3 from their capture time. A centroid of Not interested
  (90 days) pulls away.
- **Nearest kept thing.** Max cosine to his anchors: clips plus items he
  saved, noted or liked (the newest 400), so separate interests don't blur
  into one average.
- **Affinities.** Beta(1, 3)-smoothed rates per source, author and topic:
  a save adds 1 kept, a like 0.5, an open 0.25; Not interested adds 1.5
  passed, an ignored impression 0.5. Clips add one kept to their topics, and
  to a source or author whose name matches their `site` / `author`.
- **Logistic regression** (FTRL-Proximal, α 0.5, β 1, L1 0.01, L2 0.5)
  over `bias, taste_long, taste_short, nearest, unwanted, source, author,
  topic, age (log hours), length (log chars), video, audio,
  nearest×freshness, source×taste`. It learns a residual on hand-set prior
  weights and trains on each label with the features as they were just
  before that action.
- **Cold start.** `cold = 0.45·recency (e^-h/72) + 0.2·source prior +
  0.35·max(nearest, taste_long)`. The score is
  `(1 − s)·cold + s·learned`, where `s = min(1, labelled actions / 30)`.

## Picking

`Ranker::pick` for Picked for you (8 items):

1. Candidates are visible items he hasn't acted on or ignored.
2. **MMR** (λ 0.7) over min-max-normalized relevance, with relevance
   multiplied by 0.7 per earlier pick by the same author and 0.85 per earlier
   pick from the same source.
3. **Near-duplicates** are dropped: cosine ≥ 0.92 to an earlier pick, the
   same title, or the same URL.
4. **Exploration:** 12.5% of slots (1 in 8; 10–15% for larger lists),
   filled by Thompson sampling: a Beta(1 + wins, 1 + losses) draw per
   source and per topic (unweighted counts), averaged, times a freshness
   factor. New sources (followed in the last 14 days or shown fewer than 8
   times) get the better of two draws plus 0.05. Explore picks are spread
   through the list (position 4 of 8).
5. The seed is the UTC day, so the section is stable within a day.

## Why this?

Each pick carries up to four reasons, strongest first. Removable ones are
**corrections**: "Close to “X”, in Inspiration / which you kept"
(`anchor:clip:<path>` / `anchor:item:<id>`), "You often keep things from S"
(`source:<id>`), "You’ve liked A before" (`author:<name>`), "About T, a
topic you keep" (`topic:<t>`). Fixed ones explain: "Exploring: S is new to
you", "New: 3 hours ago", "Still learning…".

Removing one calls `feed_correct({ reason, id })`, which logs a `correction`
event (`data: { reason }`, surface `picked`); the ranker then treats that
source, author or topic as neutral and drops that anchor from taste
entirely. Undo logs `undo_correction`. Both replay like every other event.

## What a like changed

After a like, the webview asks `feed_effect({ id })`: the affinities that
action moved (before → after, as the Beta mean) and the picks that came in
or went out of Picked for you since it was last shown. The toast says so,
with Undo (an `unlike`, so the ranker returns exactly to before).

## Kin's tools

Through `tool` (see [kin.md](kin.md)), answered by `feed::picked::kin_tool`,
compact JSON:

| Tool | Returns |
| --- | --- |
| `shortlist {n?}` | the ranked list without exploration (default 20, max 50): `id` (`feed:<id>`), `title`, `source`, `age`, `score`, `why` |
| `similar_to {item, n?}` | Feed items nearest a `feed:<id>` or a clip path: `id`, `title`, `source`, `age`, `similarity` |
| `top_topics {window?}` | topics of what he kept (and clipped) in the last `window` days (default 30): `topic`, `weight`, `items` |
| `taste_profile {}` | examples, learned share, anchors, top sources/authors/topics with affinity, model weights, corrections |
| `explain {item}` | score, cold and learned parts, every feature's value, weight and contribution, and the reasons |

`read feed:<id>` reads an item: title, source, author, URL, date, his
actions and note, then its text. Discuss's `feed` chip reaches Kin as
`feed:<id>`, so Kin reads the item, not just its title. `shortlist` and
`similar_to` results are logged as `kin_pick` events (surface `kin`,
`data.tool`), which the ranker never learns from.

## Offline evaluation

`kintsugi_rank::replay` replays the log day by day: for each UTC day with at
least one wanted item, the ranker is built from everything before that day,
ranks the items he was shown that day, and is scored by NDCG@5 with gains
save 4, note 3, like 2, discuss 1.5, open 1. Newest first is the baseline.

- `cargo test -p kintsugi-rank` runs it on a synthetic reader
  (`synthetic.rs`: six topics, mixed sources, a known taste, 30 days) and
  requires the ranker to beat newest first by 0.15 NDCG@5 (seed 42: about
  0.55 against 0.34) and by 0.1 on five other seeds.
- `cargo run -p kintsugi-rank --example replay` prints the day-by-day
  table; `-- --db <copy of feed.sqlite>` replays a real log read-only, with
  hashed vectors and no clips.

## Testing

- `cargo test -p kintsugi-rank`: the ranker (cold start, exact undo, Kin's
  picks never train, online equals replay, ignored items, diversity and
  exploration, corrections, the tools' answers) and the replay.
- `cargo test -p kintsugi --no-default-features --features headless`: a
  seeded log through the real store into the ranker, and Kin's feed hook.
- `apps/desktop/test/runtime-feed.test.ts` drives the headless runtime:
  Picked for you from the seeded clips, Why this? with a correction and its
  undo, a like's effect toast and undo, picked impressions, and Kin (the
  headless mock model) reading a feed item and calling `shortlist`.
  Screenshots go to `.headless/feed-shots/09-…` to `14-…`.
