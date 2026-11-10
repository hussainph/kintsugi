//! Turning the vault's old single log and its comment threads into threads,
//! once (KI-104).
//!
//! Before KI-104 a vault kept one append-only log, `.kintsugi/kin/log.jsonl`
//! (topics inferred per message, summaries in `threads.json`), and paragraph
//! comment threads in `.kintsugi/comments/<doc>.json`, whose messages were
//! rows in that log. Now every conversation is its own thread.
//!
//! **How the log is split.** A message whose topic came from what was on
//! screen (its first chip names the topic) is reliable: every such message
//! about one subject becomes one thread about it, named as the old thread
//! was. A comment thread's messages become a thread anchored to its
//! paragraph, with its status and origin. A helper's report becomes a
//! thread of its own; "Kin, review this draft" and Kin's note on it a review
//! thread about the document. Kin's replies follow the messages they
//! answer. Anything else (no subject, or a topic only guessed from the words
//! or the last 30 minutes) becomes an "Earlier conversation" thread, one per
//! day. Every message keeps its time and its place in the old log (`was`).
//!
//! **Crash safety**, the same bar as KI-59's move ([`super::global`]):
//! nothing old is touched until the new threads have been written and read
//! back, and every step can be cut short and picked up again:
//!
//! 1. **Write.** Each thread's file is written whole and atomically (a temp
//!    file, fsync, rename). Thread ids are derived from the old log, so a
//!    second run writes the same files; one already there is checked, not
//!    rewritten.
//! 2. **Index.** The new threads are added to `threads/index.json`
//!    (atomically), with the old log's fingerprint.
//! 3. **Verify.** Every file and the index are read back: each old message
//!    must be in exactly one thread, unchanged, and each comment thread
//!    must keep its anchor and status.
//! 4. **Keep the old files.** Only then are `log.jsonl`, `threads.json` and
//!    `.kintsugi/comments/` moved (renamed, never deleted) into
//!    `.kintsugi/kin/archive/`, where they stay as a backup.

use super::{Anchor, Entry, Index, Meta, Quote, Role, Status, ToolUse, title_from, valid_id};
use crate::ai::prompt::Chip;
use crate::ai::web::WebCall;
use kintsugi_vault::write_atomic;
use serde::Deserialize;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

type Result<T> = std::result::Result<T, String>;

/// The vault's comment threads before KI-104, relative to the vault.
pub const COMMENTS: &str = ".kintsugi/comments";
/// Where the old files are kept, inside `.kintsugi/kin`.
pub const ARCHIVE: &str = "archive";
pub const EARLIER: &str = "Earlier conversation";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Migrated {
    /// There was nothing old to move.
    Nothing,
    /// The old log and comments are threads now.
    Moved { threads: usize, entries: usize },
}

/// One line of the old log (`history::Entry` before KI-104).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OldEntry {
    seq: u64,
    at: String,
    role: Role,
    #[serde(default)]
    text: String,
    #[serde(default)]
    chips: Vec<Chip>,
    #[serde(default)]
    topic: String,
    #[serde(default)]
    answers: Vec<u64>,
    #[serde(default)]
    interrupted: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    job: Option<String>,
    #[serde(default)]
    usd: Option<f64>,
    #[serde(default)]
    comment: Option<String>,
    #[serde(default)]
    review: bool,
    #[serde(default)]
    web: Vec<WebCall>,
    #[serde(default)]
    tools: Vec<ToolUse>,
    #[serde(default)]
    ms: Option<u64>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    cap_reached: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct OldMeta {
    #[serde(default)]
    threads: BTreeMap<String, OldTopic>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct OldTopic {
    #[serde(default)]
    kind: String,
    #[serde(default)]
    label: String,
}

/// One document's comment threads (`comments::File` before KI-104).
#[derive(Debug, Clone, Deserialize)]
struct OldComments {
    #[serde(default)]
    path: String,
    #[serde(default)]
    threads: Vec<OldComment>,
}

#[derive(Debug, Clone, Deserialize)]
struct OldComment {
    id: String,
    anchor: Quote,
    #[serde(default)]
    status: Status,
    #[serde(default)]
    origin: String,
    #[serde(default)]
    created: String,
    #[serde(default)]
    resolved: Option<String>,
    #[serde(default)]
    orphaned: bool,
}

/// What a message of the old log belongs to.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum Key {
    Topic(String),
    Comment(String),
    Job(String),
    Review(String, String),
    Day(String),
}

/// A thread to write.
#[derive(Debug, Clone)]
struct Planned {
    meta: Meta,
    entries: Vec<Entry>,
    /// The old topic it was, for its model pick.
    topic: Option<String>,
}

/// FNV-1a: a fingerprint of the old log that's the same on every run.
fn fingerprint(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}")
}

fn day(at: &str) -> String {
    at.chars().take(10).collect()
}

/// The topic a message's own screen gave it, if that's how it got one.
fn reliable(entry: &OldEntry) -> bool {
    !entry.topic.is_empty()
        && entry
            .chips
            .iter()
            .find(|c| !c.path.trim().is_empty())
            .is_some_and(|c| c.path.trim() == entry.topic)
}

fn stem(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    let name = name
        .strip_suffix(".mdx")
        .or_else(|| name.strip_suffix(".md"))
        .unwrap_or(name);
    name.replace(['-', '_'], " ")
}

fn topic_anchor(key: &str, topic: Option<&OldTopic>) -> Option<Anchor> {
    let kind = match topic.map(|t| t.kind.as_str()) {
        Some("clip") => "clip",
        Some("feed") => "feed",
        Some("idea") => "idea",
        _ if key.ends_with(".md") || key.ends_with(".mdx") => "doc",
        Some("doc") => "doc",
        _ => return None,
    };
    Anchor {
        kind: kind.into(),
        path: key.into(),
        label: topic
            .map(|t| t.label.clone())
            .filter(|l| !l.trim().is_empty()),
        quote: None,
        orphaned: false,
    }
    .checked()
    .ok()
}

/// Every comment file under `.kintsugi/comments/`, by document.
fn read_comments(root: &Path) -> Result<Vec<OldComments>> {
    let dir = root.join(COMMENTS);
    if fs::symlink_metadata(&dir).is_ok_and(|m| m.file_type().is_symlink()) {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    let mut stack = vec![dir];
    while let Some(at) = stack.pop() {
        let entries = match fs::read_dir(&at) {
            Ok(entries) => entries,
            Err(e) if e.kind() == ErrorKind::NotFound => continue,
            Err(e) => return Err(format!("could not read the comment threads: {e}")),
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                stack.push(entry.path());
            } else if kind.is_file() && entry.file_name().to_string_lossy().ends_with(".json") {
                let text = fs::read_to_string(entry.path())
                    .map_err(|e| format!("could not read the comment threads: {e}"))?;
                // A damaged file stops the move: nothing is archived unread.
                let file: OldComments = serde_json::from_str(&text).map_err(|e| {
                    format!(
                        "could not read the comment threads in {}: {e}",
                        entry.path().display()
                    )
                })?;
                out.push(file);
            }
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// Splits the old log and comment threads into threads. Pure: the same
/// input always gives the same threads and ids.
fn plan(
    log: &[OldEntry],
    topics: &BTreeMap<String, OldTopic>,
    comments: &[OldComments],
    fp: &str,
) -> Vec<Planned> {
    let short = &fp[..fp.len().min(8)];
    let mut comment_of: HashMap<String, (&str, &OldComment)> = HashMap::new();
    for file in comments {
        for thread in &file.threads {
            comment_of.insert(thread.id.clone(), (file.path.as_str(), thread));
        }
    }
    let reliable_topics: HashSet<&str> = log
        .iter()
        .filter(|e| e.role == Role::Owner && e.comment.is_none() && !e.review && reliable(e))
        .map(|e| e.topic.as_str())
        .collect();

    let mut order: Vec<Key> = Vec::new();
    let mut members: HashMap<Key, Vec<&OldEntry>> = HashMap::new();
    let mut key_of: HashMap<u64, Key> = HashMap::new();
    for entry in log {
        let fallback = || {
            if reliable_topics.contains(entry.topic.as_str()) && !entry.topic.is_empty() {
                Key::Topic(entry.topic.clone())
            } else {
                Key::Day(day(&entry.at))
            }
        };
        let key = if let Some(id) = &entry.comment {
            Key::Comment(id.clone())
        } else if entry.review {
            Key::Review(entry.topic.clone(), day(&entry.at))
        } else {
            match entry.role {
                Role::Helper => Key::Job(
                    entry
                        .job
                        .clone()
                        .unwrap_or_else(|| format!("seq{}", entry.seq)),
                ),
                Role::Kin => entry
                    .answers
                    .iter()
                    .find_map(|s| key_of.get(s).cloned())
                    .unwrap_or_else(fallback),
                Role::Owner if reliable(entry) => Key::Topic(entry.topic.clone()),
                Role::Owner => Key::Day(day(&entry.at)),
            }
        };
        key_of.insert(entry.seq, key.clone());
        if !members.contains_key(&key) {
            order.push(key.clone());
        }
        members.entry(key).or_default().push(entry);
    }
    // Comment threads nobody wrote in (or whose messages were moved before).
    for file in comments {
        for thread in &file.threads {
            let key = Key::Comment(thread.id.clone());
            if let std::collections::hash_map::Entry::Vacant(slot) = members.entry(key.clone()) {
                slot.insert(vec![]);
                order.push(key);
            }
        }
    }

    let mut planned = Vec::new();
    for (n, key) in order.iter().enumerate() {
        let old = &members[key];
        let id = match key {
            Key::Comment(id) if valid_id(id) => id.clone(),
            _ => format!("m{short}-{:03}", n + 1),
        };
        let mut seqs: HashMap<u64, u64> = HashMap::new();
        let entries: Vec<Entry> = old
            .iter()
            .enumerate()
            .map(|(i, e)| {
                let seq = i as u64 + 1;
                seqs.insert(e.seq, seq);
                Entry {
                    seq,
                    thread: id.clone(),
                    at: e.at.clone(),
                    role: e.role,
                    text: e.text.clone(),
                    chips: e.chips.clone(),
                    answers: e
                        .answers
                        .iter()
                        .filter_map(|s| seqs.get(s).copied())
                        .collect(),
                    interrupted: e.interrupted,
                    error: e.error.clone(),
                    job: e.job.clone(),
                    usd: e.usd,
                    // A review's note on a paragraph answers the request,
                    // which is in the review's own thread now.
                    review: e.review
                        || (e.comment.is_some()
                            && e.role == Role::Kin
                            && e.answers.iter().any(|s| !seqs.contains_key(s))),
                    web: e.web.clone(),
                    tools: e.tools.clone(),
                    ms: e.ms,
                    model: e.model.clone(),
                    cap_reached: e.cap_reached,
                    was: Some(e.seq),
                    replay: None,
                }
            })
            .collect();
        let first_said = old.iter().find(|e| e.role == Role::Owner && !e.review);
        let first = old.first();
        let created = first.map(|e| e.at.clone()).unwrap_or_default();
        let (title, anchor, origin, status, resolved, created) = match key {
            Key::Topic(topic) => {
                let known = topics.get(topic);
                let label = known
                    .map(|t| t.label.trim().to_string())
                    .filter(|l| !l.is_empty())
                    .unwrap_or_else(|| stem(topic));
                (
                    label,
                    topic_anchor(topic, known),
                    "chat",
                    Status::Open,
                    None,
                    created,
                )
            }
            Key::Day(_) => (
                EARLIER.to_string(),
                None,
                "earlier",
                Status::Open,
                None,
                created,
            ),
            Key::Job(_) => (
                first
                    .map(|e| title_from(&e.text))
                    .unwrap_or_else(|| "Helper report".into()),
                None,
                "helper",
                Status::Open,
                None,
                created,
            ),
            Key::Review(topic, _) => (
                "Review".to_string(),
                topic_anchor(topic, topics.get(topic)),
                "review",
                Status::Open,
                None,
                created,
            ),
            Key::Comment(cid) => {
                let stored = comment_of.get(cid);
                let anchor = match stored {
                    Some((doc, c)) => Anchor {
                        kind: "paragraph".into(),
                        path: (*doc).into(),
                        label: None,
                        quote: Some(c.anchor.clone()),
                        orphaned: c.orphaned,
                    }
                    .checked()
                    .ok(),
                    None => first.and_then(|e| topic_anchor(&e.topic, topics.get(&e.topic))),
                };
                let title = first_said
                    .or(first)
                    .map(|e| title_from(&e.text))
                    .or_else(|| stored.map(|(_, c)| title_from(&c.anchor.exact)))
                    .unwrap_or_default();
                let origin = stored
                    .map(|(_, c)| c.origin.as_str())
                    .filter(|o| !o.is_empty())
                    .unwrap_or("mention");
                (
                    title,
                    anchor,
                    origin,
                    stored.map_or(Status::Open, |(_, c)| c.status),
                    stored.and_then(|(_, c)| c.resolved.clone()),
                    stored
                        .map(|(_, c)| c.created.clone())
                        .filter(|c| !c.is_empty())
                        .unwrap_or(created),
                )
            }
        };
        let updated = entries
            .last()
            .map_or_else(|| created.clone(), |e| e.at.clone());
        planned.push(Planned {
            meta: Meta {
                id,
                title: if title.is_empty() {
                    EARLIER.into()
                } else {
                    title
                },
                titled: false,
                anchor,
                status,
                origin: origin.into(),
                created,
                updated,
                resolved,
                entries: entries.len(),
                preview: entries.last().map(super::preview).unwrap_or_default(),
            },
            entries,
            topic: match key {
                Key::Topic(topic) => Some(topic.clone()),
                _ => None,
            },
        });
    }
    planned
}

fn read_index(dir: &Path) -> Result<Index> {
    match fs::read_to_string(dir.join(super::INDEX)) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| {
            format!("could not move Kin's conversation: the thread index is damaged ({e})")
        }),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(Index::default()),
        Err(e) => Err(format!(
            "could not move Kin's conversation (read the index): {e}"
        )),
    }
}

fn same(a: &Entry, b: &Entry) -> bool {
    a.was == b.was && a.role == b.role && a.text == b.text && a.at == b.at && a.error == b.error
}

/// Moves `<kin>/log.jsonl` and `<vault>/.kintsugi/comments/` into threads
/// under `<kin>/threads/`. Safe to call on every open: it does nothing once
/// the old files are archived.
pub fn migrate(kin: &Path, vault: &Path) -> Result<Migrated> {
    migrate_until(kin, vault, usize::MAX)
}

/// [`migrate`], stopping after `steps` steps: what a crash at that point
/// leaves on disk (tests).
pub(crate) fn migrate_until(kin: &Path, vault: &Path, steps: usize) -> Result<Migrated> {
    let fail =
        |what: &str, e: std::io::Error| format!("could not move Kin's conversation ({what}): {e}");
    let mut step = 0;
    let mut stop = || {
        step += 1;
        step > steps
    };
    let log_path = kin.join("log.jsonl");
    let bytes = match fs::read(&log_path) {
        Ok(bytes) => Some(bytes),
        Err(e) if e.kind() == ErrorKind::NotFound => None,
        Err(e) => return Err(fail("read the log", e)),
    };
    let comments = read_comments(vault)?;
    let comments_dir = vault.join(COMMENTS);
    let has_comments = fs::symlink_metadata(&comments_dir).is_ok_and(|m| m.is_dir());
    if bytes.is_none() && !has_comments {
        return Ok(Migrated::Nothing);
    }
    let bytes = bytes.unwrap_or_default();
    let fp = fingerprint(&bytes);
    let log: Vec<OldEntry> = String::from_utf8_lossy(&bytes)
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    let topics = fs::read_to_string(kin.join("threads.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<OldMeta>(&t).ok())
        .unwrap_or_default()
        .threads;
    let planned = plan(&log, &topics, &comments, &fp);
    let dir = kin.join(super::FOLDER);
    if fs::symlink_metadata(&dir).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("could not move Kin's conversation: links are not followed".into());
    }
    fs::create_dir_all(&dir).map_err(|e| fail("create the threads folder", e))?;

    // 1. Write each thread whole, unless an earlier run already did.
    for thread in planned.iter().filter(|t| !t.entries.is_empty()) {
        let path = dir.join(format!("{}.jsonl", thread.meta.id));
        let there = super::read_entries(&path, &thread.meta.id);
        if !there.is_empty() {
            let prefix = there.len() >= thread.entries.len()
                && thread.entries.iter().zip(&there).all(|(a, b)| same(a, b));
            if !prefix {
                return Err(format!(
                    "could not move Kin's conversation: {} is in the way",
                    path.display()
                ));
            }
            continue;
        }
        let mut text = String::new();
        for entry in &thread.entries {
            text.push_str(&serde_json::to_string(entry).map_err(|e| e.to_string())?);
            text.push('\n');
        }
        write_atomic(&path, &text)?;
        if stop() {
            return Err(format!("stopped after writing {}", thread.meta.id));
        }
    }

    // 2. Add them to the index; threads it knows already stay as they are.
    let mut index = read_index(&dir)?;
    let known: HashSet<String> = index.threads.iter().map(|m| m.id.clone()).collect();
    let mut added = false;
    for thread in &planned {
        if !known.contains(&thread.meta.id) {
            index.threads.push(thread.meta.clone());
            added = true;
        }
    }
    if !bytes.is_empty() && !index.migrated.contains(&fp) {
        index.migrated.push(fp.clone());
        added = true;
    }
    if added {
        index.version = 1;
        let json = serde_json::to_string_pretty(&index).map_err(|e| e.to_string())?;
        write_atomic(&dir.join(super::INDEX), &(json + "\n"))?;
    }
    if stop() {
        return Err("stopped after the index".into());
    }

    // 3. Read it all back.
    let index = read_index(&dir)?;
    let metas: HashMap<&str, &Meta> = index.threads.iter().map(|m| (m.id.as_str(), m)).collect();
    let mut seen: HashMap<u64, usize> = HashMap::new();
    for thread in &planned {
        let meta = metas.get(thread.meta.id.as_str()).ok_or_else(|| {
            format!(
                "could not move Kin's conversation: {} isn't in the index",
                thread.meta.id
            )
        })?;
        let paragraph = |a: Option<&Anchor>| a.is_some_and(|a| a.kind == "paragraph");
        if paragraph(thread.meta.anchor.as_ref()) && !paragraph(meta.anchor.as_ref()) {
            return Err(format!(
                "could not move Kin's conversation: {} lost its paragraph",
                thread.meta.id
            ));
        }
        let there = super::read_entries(
            &dir.join(format!("{}.jsonl", thread.meta.id)),
            &thread.meta.id,
        );
        if there.len() < thread.entries.len()
            || !thread.entries.iter().zip(&there).all(|(a, b)| same(a, b))
        {
            return Err(format!(
                "could not move Kin's conversation: {} doesn't match",
                thread.meta.id
            ));
        }
        for entry in &thread.entries {
            *seen.entry(entry.was.unwrap_or_default()).or_default() += 1;
        }
    }
    for entry in &log {
        if seen.get(&entry.seq) != Some(&1) {
            return Err(format!(
                "could not move Kin's conversation: message #{} wasn't moved exactly once",
                entry.seq
            ));
        }
    }
    if stop() {
        return Err("stopped before keeping the old files".into());
    }

    // Model picks follow their conversation (best effort).
    let picks = crate::ai::picks::all(kin);
    for thread in &planned {
        if let Some(pick) = thread.topic.as_ref().and_then(|t| picks.get(t))
            && crate::ai::picks::get(kin, &thread.meta.id).is_none()
        {
            let _ = crate::ai::picks::put(kin, &thread.meta.id, pick.clone());
        }
    }

    // 4. Keep the old files, out of the way.
    let archive = kin.join(ARCHIVE);
    fs::create_dir_all(&archive).map_err(|e| fail("create the archive", e))?;
    let free = |name: &str| -> PathBuf {
        let mut at = archive.join(name);
        let mut n = 2;
        while at.exists() {
            at = archive.join(format!("{name}-{n}"));
            n += 1;
        }
        at
    };
    if log_path.exists() {
        fs::rename(&log_path, free(&format!("log-{}.jsonl", &fp[..8])))
            .map_err(|e| fail("keep the old log", e))?;
    }
    if stop() {
        return Err("stopped after keeping the log".into());
    }
    let summaries = kin.join("threads.json");
    if summaries.exists() {
        fs::rename(&summaries, free(&format!("threads-{}.json", &fp[..8])))
            .map_err(|e| fail("keep the old summaries", e))?;
    }
    if has_comments {
        fs::rename(&comments_dir, free("comments"))
            .map_err(|e| fail("keep the old comments", e))?;
    }
    Ok(Migrated::Moved {
        threads: planned.len(),
        entries: log.len(),
    })
}

#[cfg(test)]
mod tests;
