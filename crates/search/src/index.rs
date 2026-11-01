//! The index: one SQLite file with an FTS5 table for words and a vector per
//! chunk, searched together and merged with reciprocal rank fusion.

use crate::embed::Embedder;
use crate::text;
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;

type Result<T> = std::result::Result<T, String>;

/// Bumped when chunking or the schema changes; a mismatch rebuilds the index.
const SCHEMA: i64 = 1;
/// Reciprocal rank fusion's constant (Cormack et al.): `1 / (K + rank)`.
const RRF_K: f32 = 60.0;
/// BM25 weights for the title, tags and body columns.
const BM25: &str = "bm25(fts, 4.0, 2.0, 1.0)";
/// Chunk rows read from FTS before collapsing to documents.
const LEXICAL_ROWS: usize = 2_000;
/// Below this cosine, a vector match is noise rather than meaning.
/// Calibrated on potion-base-8M: related short texts score 0.3–0.8,
/// unrelated ones mostly under 0.2 (see the `live_potion_base_8m` test).
pub const MIN_SIMILARITY: f32 = 0.3;
const EMBED_BATCH: usize = 256;

/// What a searchable thing is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// A document in the vault: a post, draft or note outside `inbox/`.
    Writing,
    /// A quick note in `inbox/`.
    Note,
    /// An Inspiration clip.
    Clip,
    /// A Feed item.
    Feed,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Writing => "writing",
            Kind::Note => "note",
            Kind::Clip => "clip",
            Kind::Feed => "feed",
        }
    }

    pub fn parse(value: &str) -> Option<Kind> {
        [Kind::Writing, Kind::Note, Kind::Clip, Kind::Feed].into_iter().find(|k| k.as_str() == value)
    }
}

/// One thing to index. `id` is unique within a scope: a vault-relative path
/// for documents and clips, the Feed's own id for feed items.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Doc {
    pub id: String,
    pub kind: Option<Kind>,
    pub title: Option<String>,
    /// Where it's from: a clip's site, a feed item's source.
    pub source: Option<String>,
    pub tags: Vec<String>,
    pub body: String,
    /// Changes when the content does (file metadata, a feed item's version).
    pub stamp: String,
}

/// A search. Empty `kinds` means every kind; `within` limits ids to a folder.
#[derive(Clone, Debug)]
pub struct Query {
    pub text: String,
    pub limit: usize,
    pub scopes: Vec<String>,
    pub kinds: Vec<Kind>,
    pub within: Option<String>,
    /// Lexical matches must contain every word (the library's filter);
    /// otherwise documents with some of the words rank below those with all.
    pub all_terms: bool,
    pub min_similarity: f32,
}

impl Query {
    pub fn new(text: &str, scopes: &[&str]) -> Self {
        Query {
            text: text.into(),
            limit: 10,
            scopes: scopes.iter().map(|s| s.to_string()).collect(),
            kinds: vec![],
            within: None,
            all_terms: false,
            min_similarity: MIN_SIMILARITY,
        }
    }
}

/// One result: compact, never the full text.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Hit {
    pub id: String,
    pub kind: Kind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub snippet: String,
    /// 1.0 is first in every ranking; relative, not a probability.
    pub score: f32,
    /// Which rankings found it.
    #[serde(skip)]
    pub matched: Matched,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Matched {
    pub words: bool,
    pub meaning: bool,
}

struct Cached {
    doc: i64,
    chunk: i64,
    vector: Vec<f32>,
}

struct DocMeta {
    scope: String,
    id: String,
    kind: Kind,
}

/// The search index. Not `Sync`; callers share it behind a mutex.
pub struct Index {
    conn: Connection,
    embedder: Option<Arc<dyn Embedder>>,
    /// Every stored vector, loaded on first vector search after a write.
    vectors: Option<(Vec<Cached>, HashMap<i64, DocMeta>)>,
}

impl Index {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("search index: {e}"))?;
        }
        let conn = Connection::open(path).map_err(sql)?;
        conn.pragma_update(None, "journal_mode", "WAL").map_err(sql)?;
        Self::setup(conn)
    }

    pub fn open_in_memory() -> Result<Self> {
        Self::setup(Connection::open_in_memory().map_err(sql)?)
    }

    fn setup(conn: Connection) -> Result<Self> {
        conn.pragma_update(None, "foreign_keys", true).map_err(sql)?;
        let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0)).map_err(sql)?;
        if version != SCHEMA {
            conn.execute_batch("DROP TABLE IF EXISTS fts; DROP TABLE IF EXISTS chunks; DROP TABLE IF EXISTS docs; DROP TABLE IF EXISTS meta;")
                .map_err(sql)?;
        }
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS docs (
               rowid INTEGER PRIMARY KEY, scope TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL,
               title TEXT, source TEXT, stamp TEXT NOT NULL, UNIQUE (scope, id));
             CREATE TABLE IF NOT EXISTS chunks (
               rowid INTEGER PRIMARY KEY, doc INTEGER NOT NULL REFERENCES docs(rowid) ON DELETE CASCADE,
               ord INTEGER NOT NULL, embed TEXT NOT NULL, vector BLOB);
             CREATE INDEX IF NOT EXISTS chunks_doc ON chunks(doc);
             CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
               title, tags, body, tokenize = 'porter unicode61 remove_diacritics 2', prefix = '2 3');",
        )
        .map_err(sql)?;
        conn.pragma_update(None, "user_version", SCHEMA).map_err(sql)?;
        Ok(Index { conn, embedder: None, vectors: None })
    }

    /// Adds vectors to the index. A model other than the one that made the
    /// stored vectors clears them; [`Index::embed_missing`] fills them in.
    pub fn set_embedder(&mut self, embedder: Arc<dyn Embedder>) -> Result<()> {
        let stored: Option<String> =
            self.conn.query_row("SELECT value FROM meta WHERE key = 'model'", [], |r| r.get(0)).optional().map_err(sql)?;
        if stored.as_deref() != Some(embedder.id()) {
            self.conn.execute("UPDATE chunks SET vector = NULL", []).map_err(sql)?;
            self.conn
                .execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('model', ?1)", [embedder.id()])
                .map_err(sql)?;
        }
        self.embedder = Some(embedder);
        self.vectors = None;
        Ok(())
    }

    pub fn has_embedder(&self) -> bool {
        self.embedder.is_some()
    }

    /// The model, for callers that embed text of their own (Feed ranking).
    pub fn embedder(&self) -> Option<Arc<dyn Embedder>> {
        self.embedder.clone()
    }

    /// Each document's stamp in a scope, by id.
    pub fn stamps(&self, scope: &str) -> Result<HashMap<String, String>> {
        let mut statement = self.conn.prepare_cached("SELECT id, stamp FROM docs WHERE scope = ?1").map_err(sql)?;
        let rows = statement.query_map([scope], |r| Ok((r.get(0)?, r.get(1)?))).map_err(sql)?;
        rows.collect::<std::result::Result<_, _>>().map_err(sql)
    }

    /// Adds or replaces documents, then embeds their chunks if a model is set.
    pub fn upsert(&mut self, scope: &str, docs: &[Doc]) -> Result<()> {
        if docs.is_empty() {
            return Ok(());
        }
        let tx = self.conn.transaction().map_err(sql)?;
        for doc in docs {
            delete(&tx, scope, &doc.id)?;
            let kind = doc.kind.unwrap_or(Kind::Writing);
            tx.execute(
                "INSERT INTO docs (scope, id, kind, title, source, stamp) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![scope, doc.id, kind.as_str(), doc.title, doc.source, doc.stamp],
            )
            .map_err(sql)?;
            let rowid = tx.last_insert_rowid();
            let title = doc.title.clone().unwrap_or_default();
            let tags = doc.tags.join(" ");
            for (ord, chunk) in text::chunks(&doc.body).into_iter().enumerate() {
                // What gets embedded: the chunk in the context of its title and tags.
                let embed = [title.as_str(), tags.as_str(), chunk.as_str()]
                    .iter()
                    .filter(|s| !s.is_empty())
                    .copied()
                    .collect::<Vec<_>>()
                    .join("\n");
                tx.execute("INSERT INTO chunks (doc, ord, embed) VALUES (?1, ?2, ?3)", params![rowid, ord as i64, embed])
                    .map_err(sql)?;
                let chunk_id = tx.last_insert_rowid();
                tx.execute(
                    "INSERT INTO fts (rowid, title, tags, body) VALUES (?1, ?2, ?3, ?4)",
                    params![chunk_id, title, tags, chunk],
                )
                .map_err(sql)?;
            }
        }
        tx.commit().map_err(sql)?;
        self.vectors = None;
        self.embed_missing(usize::MAX)?;
        Ok(())
    }

    pub fn remove(&mut self, scope: &str, ids: &[String]) -> Result<()> {
        let tx = self.conn.transaction().map_err(sql)?;
        for id in ids {
            delete(&tx, scope, id)?;
        }
        tx.commit().map_err(sql)?;
        self.vectors = None;
        Ok(())
    }

    /// Embeds up to `limit` chunks that have no vector yet. Returns how many.
    pub fn embed_missing(&mut self, limit: usize) -> Result<usize> {
        let Some(embedder) = self.embedder.clone() else { return Ok(0) };
        let mut done = 0;
        while done < limit {
            let batch: Vec<(i64, String)> = {
                let mut statement =
                    self.conn.prepare_cached("SELECT rowid, embed FROM chunks WHERE vector IS NULL LIMIT ?1").map_err(sql)?;
                let rows = statement
                    .query_map([EMBED_BATCH.min(limit - done) as i64], |r| Ok((r.get(0)?, r.get(1)?)))
                    .map_err(sql)?;
                rows.collect::<std::result::Result<_, _>>().map_err(sql)?
            };
            if batch.is_empty() {
                break;
            }
            let texts: Vec<String> = batch.iter().map(|(_, t)| t.clone()).collect();
            let vectors = embedder.embed(&texts);
            let tx = self.conn.transaction().map_err(sql)?;
            for ((rowid, _), vector) in batch.iter().zip(vectors) {
                tx.execute("UPDATE chunks SET vector = ?1 WHERE rowid = ?2", params![to_blob(&normalized(vector)), rowid])
                    .map_err(sql)?;
            }
            tx.commit().map_err(sql)?;
            done += batch.len();
            self.vectors = None;
        }
        Ok(done)
    }

    /// Words (BM25) and meaning (cosine), fused by reciprocal rank.
    pub fn search(&mut self, query: &Query) -> Result<Vec<Hit>> {
        let terms = text::terms(&query.text);
        if terms.is_empty() || query.limit == 0 || query.scopes.is_empty() {
            return Ok(vec![]);
        }
        let candidates = (query.limit * 5).clamp(50, 1_000);
        let lexical = self.lexical(query, &terms, candidates)?;
        let semantic = self.semantic(query, candidates)?;
        let lists = 1 + usize::from(semantic.is_some());
        let mut fused: HashMap<i64, (f32, Option<i64>, Option<i64>)> = HashMap::new();
        for (rank, (doc, chunk)) in lexical.iter().enumerate() {
            let entry = fused.entry(*doc).or_default();
            entry.0 += 1.0 / (RRF_K + rank as f32 + 1.0);
            entry.1 = Some(*chunk);
        }
        for (rank, (doc, chunk)) in semantic.iter().flatten().enumerate() {
            let entry = fused.entry(*doc).or_default();
            entry.0 += 1.0 / (RRF_K + rank as f32 + 1.0);
            entry.2 = Some(*chunk);
        }
        let mut ranked: Vec<(i64, f32, Option<i64>, Option<i64>)> =
            fused.into_iter().map(|(doc, (score, words, meaning))| (doc, score, words, meaning)).collect();
        ranked.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
        ranked.truncate(query.limit);
        let best = lists as f32 / (RRF_K + 1.0);
        let fts = text::fts_query(&terms, false);
        let mut hits = Vec::with_capacity(ranked.len());
        for (doc, score, words, meaning) in ranked {
            let (id, kind, title, source): (String, String, Option<String>, Option<String>) = self
                .conn
                .query_row("SELECT id, kind, title, source FROM docs WHERE rowid = ?1", [doc], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
                })
                .map_err(sql)?;
            let snippet = match (words, meaning) {
                (Some(chunk), _) => self.lexical_snippet(&fts, chunk)?,
                (None, Some(chunk)) => self.chunk_snippet(chunk)?,
                (None, None) => String::new(),
            };
            hits.push(Hit {
                id,
                kind: Kind::parse(&kind).unwrap_or(Kind::Writing),
                title,
                source,
                snippet,
                score: (score / best * 1000.0).round() / 1000.0,
                matched: Matched { words: words.is_some(), meaning: meaning.is_some() },
            });
        }
        Ok(hits)
    }

    /// Documents ranked by their best-matching chunk, with that chunk.
    fn lexical(&self, query: &Query, terms: &[String], candidates: usize) -> Result<Vec<(i64, i64)>> {
        let mut ranked: Vec<(i64, i64)> = Vec::new();
        let mut seen = HashSet::new();
        let passes: &[bool] = if query.all_terms || terms.len() == 1 { &[true] } else { &[true, false] };
        for &all in passes {
            let mut values = vec![text::fts_query(terms, all)];
            let filter = filters(query, &mut values);
            let sql_text = format!(
                "SELECT chunks.doc, fts.rowid FROM fts JOIN chunks ON chunks.rowid = fts.rowid JOIN docs ON docs.rowid = chunks.doc
                 WHERE fts MATCH ?1 {filter} ORDER BY {BM25} LIMIT {LEXICAL_ROWS}"
            );
            let mut statement = self.conn.prepare(&sql_text).map_err(sql)?;
            let rows = statement.query_map(params_from_iter(values.iter()), |r| Ok((r.get(0)?, r.get(1)?))).map_err(sql)?;
            for row in rows {
                let (doc, chunk): (i64, i64) = row.map_err(sql)?;
                if seen.insert(doc) {
                    ranked.push((doc, chunk));
                }
            }
            if ranked.len() >= candidates {
                break;
            }
        }
        ranked.truncate(candidates);
        Ok(ranked)
    }

    /// Documents ranked by their nearest chunk, or `None` without a model.
    fn semantic(&mut self, query: &Query, candidates: usize) -> Result<Option<Vec<(i64, i64)>>> {
        let Some(embedder) = self.embedder.clone() else { return Ok(None) };
        let probe = normalized(embedder.embed(std::slice::from_ref(&query.text)).pop().unwrap_or_default());
        if probe.iter().all(|x| *x == 0.0) {
            return Ok(Some(vec![]));
        }
        if self.vectors.is_none() {
            self.vectors = Some(self.load_vectors()?);
        }
        let (vectors, docs) = self.vectors.as_ref().unwrap();
        let within = query.within.as_ref().map(|w| format!("{}/", w.trim_end_matches('/')));
        let mut best: HashMap<i64, (f32, i64)> = HashMap::new();
        for cached in vectors {
            let Some(meta) = docs.get(&cached.doc) else { continue };
            if !query.scopes.contains(&meta.scope)
                || (!query.kinds.is_empty() && !query.kinds.contains(&meta.kind))
                || within.as_ref().is_some_and(|w| !meta.id.starts_with(w.as_str()))
            {
                continue;
            }
            let similarity: f32 = probe.iter().zip(&cached.vector).map(|(a, b)| a * b).sum();
            if similarity < query.min_similarity {
                continue;
            }
            let entry = best.entry(cached.doc).or_insert((f32::MIN, cached.chunk));
            if similarity > entry.0 {
                *entry = (similarity, cached.chunk);
            }
        }
        let mut ranked: Vec<(i64, f32, i64)> = best.into_iter().map(|(doc, (s, chunk))| (doc, s, chunk)).collect();
        ranked.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
        Ok(Some(ranked.into_iter().take(candidates).map(|(doc, _, chunk)| (doc, chunk)).collect()))
    }

    /// One vector per document in `scope`: the normalized mean of its chunks'
    /// vectors. Feed ranking (`kintsugi-rank`) reads these as item and clip
    /// embeddings. Empty without a model or before anything is embedded.
    pub fn doc_vectors(&mut self, scope: &str) -> Result<HashMap<String, Vec<f32>>> {
        if self.embedder.is_none() {
            return Ok(HashMap::new());
        }
        if self.vectors.is_none() {
            self.vectors = Some(self.load_vectors()?);
        }
        let (vectors, docs) = self.vectors.as_ref().unwrap();
        let mut sums: HashMap<i64, Vec<f32>> = HashMap::new();
        for cached in vectors {
            if docs.get(&cached.doc).is_none_or(|d| d.scope != scope) {
                continue;
            }
            let sum = sums.entry(cached.doc).or_insert_with(|| vec![0.0; cached.vector.len()]);
            if sum.len() == cached.vector.len() {
                sum.iter_mut().zip(&cached.vector).for_each(|(s, x)| *s += x);
            }
        }
        Ok(sums.into_iter().map(|(doc, sum)| (docs[&doc].id.clone(), normalized(sum))).collect())
    }

    fn load_vectors(&self) -> Result<(Vec<Cached>, HashMap<i64, DocMeta>)> {
        let mut statement = self.conn.prepare("SELECT rowid, scope, id, kind FROM docs").map_err(sql)?;
        let docs = statement
            .query_map([], |r| {
                let kind: String = r.get(3)?;
                Ok((r.get(0)?, DocMeta { scope: r.get(1)?, id: r.get(2)?, kind: Kind::parse(&kind).unwrap_or(Kind::Writing) }))
            })
            .map_err(sql)?
            .collect::<std::result::Result<HashMap<_, _>, _>>()
            .map_err(sql)?;
        let mut statement = self.conn.prepare("SELECT doc, rowid, vector FROM chunks WHERE vector IS NOT NULL").map_err(sql)?;
        let vectors = statement
            .query_map([], |r| {
                let blob: Vec<u8> = r.get(2)?;
                Ok(Cached { doc: r.get(0)?, chunk: r.get(1)?, vector: from_blob(&blob) })
            })
            .map_err(sql)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(sql)?;
        Ok((vectors, docs))
    }

    fn lexical_snippet(&self, fts: &str, chunk: i64) -> Result<String> {
        let found: Option<String> = self
            .conn
            .query_row("SELECT snippet(fts, 2, '', '', '…', 32) FROM fts WHERE fts MATCH ?1 AND rowid = ?2", params![fts, chunk], |r| {
                r.get(0)
            })
            .optional()
            .map_err(sql)?;
        match found.filter(|s| !s.trim().is_empty()) {
            Some(found) => Ok(text::snippet(&found)),
            None => self.chunk_snippet(chunk),
        }
    }

    fn chunk_snippet(&self, chunk: i64) -> Result<String> {
        let body: Option<String> =
            self.conn.query_row("SELECT body FROM fts WHERE rowid = ?1", [chunk], |r| r.get(0)).optional().map_err(sql)?;
        Ok(text::snippet(&body.unwrap_or_default()))
    }
}

fn delete(tx: &rusqlite::Transaction, scope: &str, id: &str) -> Result<()> {
    tx.execute(
        "DELETE FROM fts WHERE rowid IN (SELECT chunks.rowid FROM chunks JOIN docs ON docs.rowid = chunks.doc WHERE docs.scope = ?1 AND docs.id = ?2)",
        params![scope, id],
    )
    .map_err(sql)?;
    tx.execute("DELETE FROM docs WHERE scope = ?1 AND id = ?2", params![scope, id]).map_err(sql)?;
    Ok(())
}

/// SQL conditions for the query's scopes, kinds and folder; values appended.
fn filters(query: &Query, values: &mut Vec<String>) -> String {
    let mut out = String::new();
    let mut list = |column: &str, items: Vec<String>, values: &mut Vec<String>| {
        let start = values.len() + 1;
        let marks: Vec<String> = (start..start + items.len()).map(|i| format!("?{i}")).collect();
        values.extend(items);
        out.push_str(&format!(" AND {column} IN ({})", marks.join(", ")));
    };
    list("docs.scope", query.scopes.clone(), values);
    if !query.kinds.is_empty() {
        list("docs.kind", query.kinds.iter().map(|k| k.as_str().to_string()).collect(), values);
    }
    if let Some(within) = &query.within {
        values.push(format!("{}/", within.trim_end_matches('/')));
        let n = values.len();
        out.push_str(&format!(" AND substr(docs.id, 1, length(?{n})) = ?{n}"));
    }
    out
}

fn normalized(mut vector: Vec<f32>) -> Vec<f32> {
    let norm = vector.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        vector.iter_mut().for_each(|x| *x /= norm);
    }
    vector
}

fn to_blob(vector: &[f32]) -> Vec<u8> {
    vector.iter().flat_map(|x| x.to_le_bytes()).collect()
}

fn from_blob(blob: &[u8]) -> Vec<f32> {
    blob.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect()
}

fn sql(error: rusqlite::Error) -> String {
    format!("search index: {error}")
}
