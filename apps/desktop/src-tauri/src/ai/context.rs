//! Bounded, provider-neutral thread replay and the current document view.
//! Kept separate from messages' display metadata so new message parts can
//! extend the transcript without changing the thread's UI trace.

use super::prompt::Chip;
use super::tools::{Tools, document_key};
use super::web::guard::Guard;
use super::wire::Item;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};
use std::hash::{DefaultHasher, Hash, Hasher};

#[cfg(test)]
mod tests;

pub const HISTORY_BYTES: usize = 128 * 1024;
pub const TOOL_TURNS: usize = 4;
const SMALL_DOCUMENT_BYTES: usize = 16 * 1024;
const CONTEXT_BYTES: usize = 64 * 1024;

/// One complete exchange. Reasoning is intentionally not persisted across
/// turns/providers. Tool calls and results are retained together or dropped
/// together, never leaving an orphan tool result on any wire.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Replay {
    #[serde(default)]
    pub items: Vec<Item>,
    /// Owner-authored text only, kept separate from injected file context.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub heard: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub reads: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provenance: Option<Guard>,
    /// Freeze the cached prefix across app restarts too. New threads load
    /// fresh memory; later turns of this thread reuse this snapshot.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory: Option<super::prompt::Memory>,
}

impl Replay {
    pub fn bytes(&self) -> usize {
        serde_json::to_vec(&self.items).map_or(usize::MAX, |s| s.len())
    }

    /// Don't persist an oversized tool loop. Keep the owner's contextual
    /// question and final answer; never silently clip a result or paragraph.
    pub fn bound(&mut self) {
        if self.bytes() > HISTORY_BYTES {
            let first = self
                .items
                .iter()
                .find(|i| matches!(i, Item::User(_)))
                .cloned();
            let last = self.items.iter().rev().find_map(|i| match i {
                Item::Assistant { text, calls } if calls.is_empty() => Some(Item::Assistant {
                    text: text.clone(),
                    calls: vec![],
                }),
                _ => None,
            });
            self.items = first.into_iter().chain(last).collect();
            // No retained tool content supports these read stamps anymore.
            self.reads.clear();
            if self.bytes() > HISTORY_BYTES {
                self.items.clear();
            }
        }
    }
}

fn escaped_json(value: &serde_json::Value) -> String {
    value
        .to_string()
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
}

pub fn revision(text: &str) -> String {
    let mut hash = DefaultHasher::new();
    text.hash(&mut hash);
    format!("{:016x}", hash.finish())
}

/// Validate each exchange's own read stamps, not just the latest stamp for
/// a path. A newer partial read must not make an older full body current.
/// Keep the old stamps for changed notices, and preserve thread metadata.
pub fn fresh(tools: &Tools, previous: &[Replay]) -> Vec<Replay> {
    let mut revisions = BTreeMap::new();
    previous
        .iter()
        .map(|earlier| {
            let mut replay = earlier.clone();
            for (path, stamp) in &replay.reads {
                let current = revisions
                    .entry(document_key(path))
                    .or_insert_with(|| tools.document(path).ok().map(|text| revision(&text)));
                if current.as_ref() != Some(stamp) {
                    invalidate(&mut replay.items, path);
                }
            }
            replay
        })
        .collect()
}

const OUTDATED: &str = "This text changed or is unavailable. Read the document again.";

/// A retry notice with a safely escaped path, never a partial source body.
pub fn outdated(path: &str) -> String {
    format!(
        "<data tool=\"read\">\n{}\n</data>",
        escaped_json(&json!({"path": path, "state": "outdated", "notice": OUTDATED}))
    )
}

/// Remove source bodies without removing their calls/results or the owner's
/// question. Also used before a new read changes a path's stamp mid-turn.
pub fn invalidate(items: &mut [Item], path: &str) {
    let stub = outdated(path);
    let mut reads = BTreeSet::new();
    for item in items {
        match item {
            Item::Assistant { calls, .. } => {
                // IDs can repeat across historical exchanges. Only match
                // results to the current batch, never to another file's call.
                reads = calls
                    .iter()
                    .filter(|call| {
                        call.name == "read"
                            && call.arguments["path"]
                                .as_str()
                                .is_some_and(|read| document_key(read) == document_key(path))
                    })
                    .map(|call| call.id.clone())
                    .collect();
            }
            Item::Results(results) => {
                for result in results {
                    if reads.contains(&result.call_id) {
                        result.content = stub.clone();
                    }
                }
            }
            Item::User(message) => invalidate_context(message, path),
            Item::Reasoning(_) => {}
        }
    }
}

fn invalidate_context(message: &mut String, path: &str) {
    let Some((before, tail)) = message.rsplit_once("<data tool=\"context\">\n") else {
        return;
    };
    let Some((data, after)) = tail.split_once("\n</data>") else {
        return;
    };
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(data) else {
        return;
    };
    let Some(documents) = value
        .get_mut("documents")
        .and_then(serde_json::Value::as_array_mut)
    else {
        return;
    };
    let mut changed = false;
    for document in documents {
        if document["path"]
            .as_str()
            .is_some_and(|read| document_key(read) == document_key(path))
            && let Some(document) = document.as_object_mut()
        {
            document.remove("text");
            document.remove("paragraphs");
            document.insert("state".into(), json!("outdated"));
            document.insert("notice".into(), json!(OUTDATED));
            changed = true;
        }
    }
    if changed {
        *message = format!(
            "{before}<data tool=\"context\">\n{}\n</data>{after}",
            escaped_json(&value)
        );
    }
}

/// Resolve only exact saved quotes here. The editor owns fuzzy re-anchoring;
/// when it hasn't done that yet, a stale notice is safer than a wrong passage.
fn resolve_anchor(text: &str, anchor: &super::threads::Anchor) -> Option<[u32; 2]> {
    if anchor.orphaned {
        return None;
    }
    let quote = anchor.quote.as_ref()?;
    if quote.exact.is_empty() {
        return None;
    }
    text.match_indices(&quote.exact)
        .map(|(at, _)| {
            let from = text[..at].bytes().filter(|b| *b == b'\n').count() as u32 + 1;
            let end = at + quote.exact.trim_end_matches('\n').len();
            let to = text[..end].bytes().filter(|b| *b == b'\n').count() as u32 + 1;
            let context_misses = u8::from(!text[..at].ends_with(&quote.prefix))
                + u8::from(!text[at + quote.exact.len()..].starts_with(&quote.suffix));
            (
                (context_misses, from.abs_diff(quote.line.max(1))),
                [from, to],
            )
        })
        .min_by_key(|(score, _)| *score)
        .map(|(_, range)| range)
}

/// Append current text *inside* the dynamic tail, never the cached prefix.
/// All file text is JSON escaped and wrapped as data. The small-document
/// snapshot is a convenience; larger documents still use the paged reader.
pub fn current(
    tools: &Tools,
    chips: &[Chip],
    previous: &[Replay],
    anchor: Option<&super::threads::Anchor>,
) -> (String, BTreeMap<String, String>) {
    let mut known = BTreeMap::new();
    for turn in previous {
        known.extend(
            turn.reads
                .iter()
                .map(|(path, stamp)| (document_key(path), stamp.clone())),
        );
    }
    let mut paths: Vec<String> = chips.iter().map(|c| document_key(&c.path)).collect();
    paths.extend(anchor.map(|a| document_key(&a.path)));
    paths.extend(known.keys().cloned());
    paths.sort();
    paths.dedup();
    let mut views = Vec::new();
    let mut reads = BTreeMap::new();
    let mut remaining = CONTEXT_BYTES;
    for path in paths {
        if path.starts_with("feed:") || path.starts_with("@out/") {
            continue;
        }
        let text = match tools.document(&path) {
            Ok(text) => text,
            Err(error) => {
                // A deleted/moved/unreadable previously read file isn't current.
                if known.contains_key(&path) {
                    views.push(json!({"path": path, "state": "unavailable", "notice": error}));
                }
                continue;
            }
        };
        let stamp = revision(&text);
        let state = match known.get(&path) {
            Some(before) if *before == stamp => "unchanged",
            Some(_) => "changed",
            None => "not previously read",
        };
        let mut view = json!({"path": path, "revision": stamp, "state": state});
        let mut paragraphs = Vec::new();
        let anchored = anchor.filter(|a| a.kind == "paragraph" && document_key(&a.path) == path);
        let resolved = anchored.and_then(|a| resolve_anchor(&text, a));
        let saved_lines = anchored.and_then(|a| a.chip().lines);
        let mut ranges: Vec<[u32; 2]> = chips
            .iter()
            .filter(|c| document_key(&c.path) == path)
            .filter_map(|c| c.lines)
            .filter(|range| anchored.is_none() || Some(*range) != saved_lines)
            .collect();
        if let Some(range) = resolved {
            ranges.push(range);
        } else if anchored.is_some() {
            paragraphs.push(json!({"state": "stale anchor", "notice": "The saved paragraph cannot be located exactly in the current document. Do not use its old line range; read the document to locate it."}));
        }
        ranges.sort();
        ranges.dedup();
        for [from, to] in ranges {
            let lines: Vec<&str> = text.split_inclusive('\n').collect();
            let start = from.max(1) as usize - 1;
            let end = (to.max(from) as usize).min(lines.len());
            if start < end {
                let passage = lines[start..end].concat();
                let candidate = json!({"lines": [from.max(1), to.max(from)], "text": passage});
                let size = escaped_json(&candidate).len();
                if size <= remaining {
                    remaining -= size;
                    tools.note_context(&passage);
                    paragraphs.push(candidate);
                } else {
                    paragraphs.push(json!({"lines": [from, to], "notice": "Passage exceeds context budget. Use read with these lines; no text was clipped."}));
                }
            } else {
                paragraphs.push(json!({"lines": [from, to], "notice": "These lines no longer exist. Read the document to locate the passage."}));
            }
        }
        if !paragraphs.is_empty() {
            if paragraphs.iter().any(|p| p.get("text").is_some()) {
                reads.insert(path.clone(), stamp.clone());
            }
            view["paragraphs"] = json!(paragraphs);
        }
        if chips.iter().any(|c| document_key(&c.path) == path) && text.len() <= SMALL_DOCUMENT_BYTES
        {
            let size = escaped_json(&json!(text)).len();
            if size <= remaining {
                remaining -= size;
                tools.note_context(&text);
                view["text"] = json!(text);
                reads.insert(path.clone(), stamp.clone());
            }
        }
        views.push(view);
    }
    if views.is_empty() {
        return (String::new(), reads);
    }
    let data = escaped_json(&json!({"documents": views}));
    (
        format!(
            "\nCurrent documents (reuse unchanged reads; re-read changed text when needed):\n<data tool=\"context\">\n{data}\n</data>"
        ),
        reads,
    )
}

/// Register historical dynamic file text if web tools were off when it was
/// first shown. It is never an owner-message exception to query protection.
pub fn protect(tools: &Tools, message: &str) {
    let Some((_, tail)) = message.rsplit_once("<data tool=\"context\">\n") else {
        return;
    };
    let Some((data, _)) = tail.split_once("\n</data>") else {
        return;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(data) else {
        return;
    };
    if let Some(documents) = value["documents"].as_array() {
        for document in documents {
            if let Some(text) = document["text"].as_str() {
                tools.note_context(text);
            }
            if let Some(paragraphs) = document["paragraphs"].as_array() {
                for paragraph in paragraphs {
                    if let Some(text) = paragraph["text"].as_str() {
                        tools.note_context(text);
                    }
                }
            }
        }
    }
}

/// A historical question retains its chips even on old logs without replay.
/// These are references, not assertions that an old paragraph is still current.
pub fn question(text: &str, chips: &[Chip]) -> String {
    if chips.is_empty() {
        text.to_string()
    } else {
        format!(
            "{text}\n\n<data tool=\"message-chips\">\n{}\n</data>",
            serde_json::to_string(chips)
                .unwrap_or_default()
                .replace('<', "\\u003c")
                .replace('>', "\\u003e")
        )
    }
}
