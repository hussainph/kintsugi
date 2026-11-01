# Search

One local index finds things by words and by meaning. The Inspiration
library, Kin's `search` tool and (once it lands) the Feed all use it. See
"Ranking without burning tokens" and "How it thinks" in
[vision.md](vision.md). The engine is `crates/search` (`kintsugi-search`) and
doesn't depend on Tauri. The app's side is `apps/desktop/src-tauri/src/search.rs`.

This document is the contract. If you change the code that it describes,
change this document in the same commit.

## How a search runs

1. **Words.** SQLite FTS5 with BM25. The tokenizer is
   `porter unicode61 remove_diacritics 2`. Columns are title, tags and body,
   weighted 4, 2 and 1. A query is split into letter-and-digit words (at
   most 12), and FTS syntax is never interpreted. Each word matches by stem
   (`distractions` finds `distraction`). Words longer than one letter also
   match as prefixes (`kil` finds `kiln`), so search works as you type.
   Documents that contain every word rank first. Documents that contain only
   some of the words come after them, unless the query asks for every word.
2. **Meaning.** The query is embedded and compared with every chunk's vector
   by brute-force cosine. At this scale (thousands of documents, 256
   dimensions) that takes a few milliseconds. A document scores as its
   nearest chunk. Matches below `MIN_SIMILARITY` (0.3) are dropped as noise.
   The threshold was calibrated on potion-base-8M: related short texts score
   0.3–0.8 and unrelated ones mostly score under 0.2.
3. **Fusion.** Reciprocal rank fusion, `Σ 1 / (60 + rank)` over both
   rankings. `score` is normalized so that 1.0 means first in every
   ranking. It's relative, not a probability. Before the model is
   available, only the words ranking runs, and the top word match scores 1.0.

Each result is compact and never contains the full text:
`{ id, kind, title?, source?, snippet, score }`.

- `id` is a vault-relative path for documents and clips. For feed items,
  it's the Feed's own id.
- `kind` is one of `writing`, `note` (`inbox/`), `clip` (`inspiration/`) or
  `feed`.
- `source` is a clip's site, its URL's host or its author, or a feed
  item's source.
- `snippet` is at most 220 characters, with whitespace collapsed. A word
  match uses FTS5's `snippet()` around the match. A meaning-only match uses
  the start of its nearest chunk.

Filters: `kinds`, and `within` (a folder: ids under `folder/`).

## What's indexed

- **Writing and notes**: every `.md`/`.mdx`/`.txt` file in the vault, up
  to 2 MB, 20,000 files and 16 levels deep. Hidden entries and symlinks are
  skipped, the same rules Kin's tools follow, so `.kintsugi/` (Kin's memory)
  is never indexed. The title comes from frontmatter `title`, else from the
  first `# heading`. Tags come from frontmatter `tags`. The body is the text
  without frontmatter.
- **Clips**: `inspiration/*.md` through `clip_read`. That's the title, tags,
  summary, own text and extracted source. A clip file that doesn't parse is
  still indexed as plain text.
- **Chunks**: a body is split into chunks of about 900 characters made of
  whole paragraphs, up to 128 per document. Each chunk is embedded with its
  title and tags in front of it.

## Storage and refresh

- The index is `<app config>/search/index.sqlite` (WAL), never in the
  vault. It only holds copies, so deleting it just means a rebuild.
  Headless runs keep it in `$KINTSUGI_CONFIG_DIR/search/`. An isolated dev
  run (`KINTSUGI_VAULT`) without a config dir keeps it in memory.
  `PRAGMA user_version` is the schema version, and a mismatch rebuilds the
  index.
- **Scopes.** Each vault has its own scope (its canonical path), and feed
  items use the `feed` scope. The app searches the open vault and the
  Feed together, and Kin's `kind` filter can narrow that down.
- **Sync.** Before every search, the open vault is compared with the index
  using file metadata (mtime, size, inode, ctime). Only changed files are
  read again, and deleted files are dropped. Document saves, create, rename
  and trash, phone writes, `clips:changed` (captures, edits, enrichment) and
  opening a vault also start the same sync in the background, 400 ms after
  the last change.
- **The Feed.** Whenever the Feed changes (a poll, expiry, Not interested,
  mute or unfollow, a fetched full text), and once at start, its visible
  items are pulled into the `feed` scope. The Feed store
  (`Store::search_stamps`) gives each visible item a stamp that changes
  with its text. `feed::search_changes` compares those stamps with the
  index's own, returns changed items as documents (title, source title or
  author, summary and content) and lists items that are no longer visible
  (expired, dismissed, muted, unfollowed) so they can be removed. The two
  SQLite files stay separate. Feed ids are `feed:<item id>`. A vault sync
  never touches the `feed` scope.

## The embedding model

[model2vec](https://github.com/MinishLab/model2vec-rs) static embeddings,
using `minishlab/potion-base-8M` (MIT, 256 dimensions, about 30 MB). A text
is embedded by looking up and averaging token vectors, which takes
microseconds on the CPU and makes no network call.

- The model is downloaded once, at app start, into
  `<app config>/search/models/potion-base-8M-<rev>/`. It's pinned to Hub
  revision `bf8b0566…`. Each file is checked against its size and pinned
  hash (Git blob id for the small files, sha256 for the weights), and a
  mismatch is refused. The download is the only network call search makes.
  Until it finishes (or if it fails, for example when offline), search runs
  on words only, and the app tries again at the next start.
- Once the model loads, chunks without vectors are embedded in batches of
  512, so searches can run between batches. The stored model id
  (`potion-base-8M@<rev>`) is kept in the index. A different model clears
  the old vectors and embeds everything again.
- `KINTSUGI_EMBEDDINGS=off` turns the model off. Headless runs skip it
  unless `KINTSUGI_HEADLESS_EMBEDDINGS=1`.
- If a stronger model is needed later, fastembed-rs can implement the same
  `Embedder` trait.

## Who uses it

- **Library**: with a query, `clip_search` asks the index for clips
  (`kinds: [clip]`, every word required, meaning-only matches above 0.35)
  and lists them in that order. After them come any other clips the
  library's own substring filter matches (URLs, mid-word fragments), newest
  first. Tags still filter, and pagination is unchanged. Without a query,
  results stay newest first. If the index fails, the library falls back to
  lexical search. See [inspiration.md](inspiration.md).
- **Kin**: the `search` tool (see [kin.md](kin.md)).
- **Feed ranking** ([ranking.md](ranking.md)): `Index::doc_vectors(scope)`
  gives one vector per document (the normalized mean of its chunks' vectors)
  for feed items and clips, and `Index::embedder()` embeds anything not
  indexed. Without a model, ranking uses its own hashed text vectors.
- **Webview**: `search({ query, k?, kinds?, within? })` returns `SearchHit[]`
  (`src/lib/search.ts`). `k` defaults to 20, with a maximum of 100.

## Testing

`cargo test -p kintsugi-search` runs offline. `embed::fixture` builds a
tiny real model2vec model (a word-level tokenizer and a one-hot table in
which synonyms share a dimension), so the actual model2vec code path runs
with no download. The relevance check
(`hybrid_search_finds_by_meaning_and_keeps_exact_matches_first`) measures
recall on synonym queries. The words-only ranking must miss them, hybrid
must find all of them, and exact matches must stay first.
`live_potion_base_8m` is `#[ignore]`d and is the only test that downloads
anything. It fetches the real model into a temporary folder and checks the
hashes and the similarity threshold.
