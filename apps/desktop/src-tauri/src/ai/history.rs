//! Kin's one conversation: a single append-only log in app data, never in
//! the vault.
//!
//! The owner never tags or files anything. Each entry's **topic** is inferred
//! from what was on screen and what was said; a "thread" ("the conversation
//! about draft X") is just the entries that share a topic, with its own
//! running summary so it can be resumed when he comes back to X.
//!
//! Nothing here deletes or rewrites history: entries are only appended, and
//! summaries are kept beside the log (`threads.json`), never instead of it.
//!
//! Files, in `<config>/kin/conversation/`:
//! - `log.jsonl`: one [`Entry`] per line. A torn last line is skipped.
//! - `threads.json`: summaries and the answered watermark ([`Meta`]).

use super::prompt::Chip;
use chrono::{DateTime, FixedOffset, Local};
use kintsugi_vault::write_atomic;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::path::PathBuf;

type Result<T> = std::result::Result<T, String>;

/// The topic of a turn with nothing on screen and nothing named.
pub const GENERAL: &str = "";
/// A message with nothing on screen continues the previous topic this long.
const CONTINUE_MINUTES: i64 = 30;
/// Exchanges sent to the model as messages; older ones are in the recap.
pub const HISTORY_PAIRS: usize = 6;
const SNIPPET_CHARS: usize = 220;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    /// Hussain.
    Owner,
    Kin,
    /// A helper agent reporting back, quietly.
    Helper,
}

impl Role {
    fn name(self) -> &'static str {
        match self {
            Role::Owner => "Hussain",
            Role::Kin => "Kin",
            Role::Helper => "Helper",
        }
    }
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// One line of the log.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// Position in the log, from 1. Never reused.
    pub seq: u64,
    /// RFC 3339.
    pub at: String,
    pub role: Role,
    pub text: String,
    /// What was on screen (owner messages).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub chips: Vec<Chip>,
    /// The inferred thread key; [`GENERAL`] when there's no subject.
    #[serde(default)]
    pub topic: String,
    /// Kin's reply: the owner messages it answers (a burst is one turn).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub answers: Vec<u64>,
    /// Kin's reply was cut short by the owner typing.
    #[serde(default, skip_serializing_if = "is_false")]
    pub interrupted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// A helper's report: its job id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usd: Option<f64>,
}

/// What a new entry says; the log assigns `seq` and `at`.
#[derive(Debug, Clone, Default)]
pub struct Draft {
    pub text: String,
    pub chips: Vec<Chip>,
    pub topic: String,
    pub answers: Vec<u64>,
    pub interrupted: bool,
    pub error: Option<String>,
    pub job: Option<String>,
    pub usd: Option<f64>,
}

/// A topic, as inferred for one message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Topic {
    pub key: String,
    /// `"doc"`, `"clip"`, `"feed"` or `"general"`.
    pub kind: String,
    pub label: String,
}

impl Topic {
    pub fn general() -> Self {
        Topic { key: GENERAL.into(), kind: "general".into(), label: "Anything".into() }
    }
}

/// A view of the log: the entries about one topic, with a running summary.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub key: String,
    pub kind: String,
    pub label: String,
    /// What has been said so far, written by Kin while the owner was idle.
    #[serde(default)]
    pub summary: String,
    /// The summary covers entries up to this `seq`.
    #[serde(default)]
    pub summarized_through: u64,
    /// Rebuilt from the log on open.
    #[serde(default)]
    pub entries: usize,
    #[serde(default)]
    pub last_seq: u64,
    #[serde(default)]
    pub last_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    /// Owner messages up to here have had their turn.
    #[serde(default)]
    pub answered_through: u64,
    #[serde(default)]
    pub threads: BTreeMap<String, Thread>,
}

/// A history search result.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub seq: u64,
    pub at: String,
    pub role: Role,
    pub topic: String,
    pub snippet: String,
}

pub struct Log {
    /// `None`: an isolated run that keeps everything in memory.
    dir: Option<PathBuf>,
    entries: Vec<Entry>,
    meta: Meta,
}

fn parse_time(at: &str) -> Option<DateTime<FixedOffset>> {
    DateTime::parse_from_rfc3339(at).ok()
}

/// The subject a chip points at: a paragraph belongs to its document.
fn chip_topic(chip: &Chip) -> Topic {
    let kind = match chip.kind.as_str() {
        "paragraph" | "selection" | "doc" => "doc",
        "clip" => "clip",
        "feed" => "feed",
        other => other,
    };
    let label = match (chip.kind.as_str(), chip.label.as_deref()) {
        // A paragraph's label is its text, not the document's name.
        ("paragraph" | "selection", _) | (_, None) => stem(&chip.path),
        (_, Some(label)) if label.trim().is_empty() => stem(&chip.path),
        (_, Some(label)) => label.trim().chars().take(80).collect(),
    };
    Topic { key: chip.path.trim().to_string(), kind: kind.into(), label }
}

fn stem(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    let name = name.strip_suffix(".mdx").or_else(|| name.strip_suffix(".md")).unwrap_or(name);
    name.replace(['-', '_'], " ")
}

impl Log {
    pub fn open(dir: Option<PathBuf>) -> Self {
        let entries: Vec<Entry> = dir
            .as_ref()
            .and_then(|d| fs::read_to_string(d.join("log.jsonl")).ok())
            .map(|text| text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect())
            .unwrap_or_default();
        let meta: Meta = dir
            .as_ref()
            .and_then(|d| fs::read_to_string(d.join("threads.json")).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let mut log = Log { dir, entries, meta };
        log.rebuild();
        log
    }

    /// Thread counts come from the log itself, so a crash between writing
    /// the log and `threads.json` loses nothing.
    fn rebuild(&mut self) {
        for thread in self.meta.threads.values_mut() {
            thread.entries = 0;
        }
        for i in 0..self.entries.len() {
            let entry = self.entries[i].clone();
            self.touch(&entry, None);
        }
    }

    fn touch(&mut self, entry: &Entry, topic: Option<&Topic>) {
        if entry.topic == GENERAL && topic.is_none() && !self.meta.threads.contains_key(GENERAL) {
            let general = Topic::general();
            return self.touch(entry, Some(&general));
        }
        let thread = self.meta.threads.entry(entry.topic.clone()).or_insert_with(|| {
            let t = topic.cloned().unwrap_or_else(|| Topic { key: entry.topic.clone(), kind: "doc".into(), label: stem(&entry.topic) });
            Thread {
                key: t.key,
                kind: t.kind,
                label: t.label,
                summary: String::new(),
                summarized_through: 0,
                entries: 0,
                last_seq: 0,
                last_at: String::new(),
            }
        });
        thread.entries += 1;
        thread.last_seq = thread.last_seq.max(entry.seq);
        thread.last_at = entry.at.clone();
    }

    fn save_meta(&self) -> Result<()> {
        let Some(dir) = &self.dir else { return Ok(()) };
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let json = serde_json::to_string_pretty(&self.meta).map_err(|e| e.to_string())?;
        write_atomic(&dir.join("threads.json"), &json)
    }

    /// Appends an entry. The log line is written before anything else.
    pub fn append_at(&mut self, role: Role, draft: Draft, topic: Option<&Topic>, now: DateTime<FixedOffset>) -> Result<Entry> {
        let entry = Entry {
            seq: self.entries.last().map_or(1, |e| e.seq + 1),
            at: now.to_rfc3339(),
            role,
            text: draft.text,
            chips: draft.chips,
            topic: draft.topic,
            answers: draft.answers,
            interrupted: draft.interrupted,
            error: draft.error,
            job: draft.job,
            usd: draft.usd,
        };
        self.push(entry, topic)
    }

    fn push(&mut self, entry: Entry, topic: Option<&Topic>) -> Result<Entry> {
        if let Some(dir) = &self.dir {
            let line = serde_json::to_string(&entry).map_err(|e| e.to_string())?;
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            let mut file = OpenOptions::new().create(true).append(true).open(dir.join("log.jsonl")).map_err(|e| e.to_string())?;
            writeln!(file, "{line}").map_err(|e| e.to_string())?;
        }
        self.entries.push(entry.clone());
        self.touch(&entry, topic);
        // Labels follow what's on screen now (a renamed draft, a new title).
        if let Some(topic) = topic
            && let Some(thread) = self.meta.threads.get_mut(&topic.key)
            && !topic.label.is_empty()
        {
            thread.label = topic.label.clone();
        }
        let _ = self.save_meta();
        Ok(entry)
    }

    /// Appends an owner message, its topic inferred.
    pub fn say(&mut self, text: &str, chips: Vec<Chip>) -> Result<Entry> {
        self.say_at(text, chips, Local::now().fixed_offset())
    }

    pub fn say_at(&mut self, text: &str, chips: Vec<Chip>, now: DateTime<FixedOffset>) -> Result<Entry> {
        let topic = self.infer(text, &chips, now);
        let draft = Draft { text: text.trim().into(), chips, topic: topic.key.clone(), ..Draft::default() };
        self.append_at(Role::Owner, draft, Some(&topic), now)
    }

    /// Appends Kin's or a helper's entry, now.
    pub fn reply(&mut self, role: Role, draft: Draft) -> Result<Entry> {
        self.append_at(role, draft, None, Local::now().fixed_offset())
    }

    /// What a message is about: the first thing on screen; else a known
    /// thread it names; else the previous topic if he's still mid-thought;
    /// else nothing in particular.
    pub fn infer(&self, text: &str, chips: &[Chip], now: DateTime<FixedOffset>) -> Topic {
        if let Some(chip) = chips.iter().find(|c| !c.path.trim().is_empty()) {
            let mut topic = chip_topic(chip);
            if matches!(chip.kind.as_str(), "paragraph" | "selection") {
                // Name it after its document: the doc chip beside it, or the thread.
                let named = chips.iter().find(|c| c.kind == "doc" && c.path.trim() == topic.key).map(chip_topic);
                if let Some(label) = named.map(|t| t.label).or_else(|| self.meta.threads.get(&topic.key).map(|t| t.label.clone())) {
                    topic.label = label;
                }
            }
            return topic;
        }
        let said = text.to_lowercase();
        let mut named: Vec<&Thread> = self
            .meta
            .threads
            .values()
            .filter(|t| t.key != GENERAL)
            .filter(|t| {
                let stem = stem(&t.key).to_lowercase();
                let label = t.label.to_lowercase();
                said.contains(&t.key.to_lowercase())
                    || (stem.chars().count() >= 4 && said.contains(&stem))
                    || (label.chars().count() >= 4 && said.contains(&label))
            })
            .collect();
        named.sort_by(|a, b| b.last_seq.cmp(&a.last_seq));
        if let Some(thread) = named.first() {
            return Topic { key: thread.key.clone(), kind: thread.kind.clone(), label: thread.label.clone() };
        }
        let recent = self.entries.iter().rev().find(|e| e.role == Role::Owner).filter(|e| {
            parse_time(&e.at).is_some_and(|at| (now - at).num_minutes() < CONTINUE_MINUTES)
        });
        if let Some(previous) = recent
            && let Some(thread) = self.meta.threads.get(&previous.topic)
        {
            return Topic { key: thread.key.clone(), kind: thread.kind.clone(), label: thread.label.clone() };
        }
        Topic::general()
    }

    /// Owner messages still waiting for Kin, oldest first.
    pub fn pending(&self) -> Vec<Entry> {
        let through = self.meta.answered_through;
        self.entries.iter().filter(|e| e.role == Role::Owner && e.seq > through).cloned().collect()
    }

    pub fn mark_answered(&mut self, through: u64) {
        if through > self.meta.answered_through {
            self.meta.answered_through = through;
            let _ = self.save_meta();
        }
    }

    pub fn get(&self, seq: u64) -> Option<&Entry> {
        self.entries.binary_search_by_key(&seq, |e| e.seq).ok().map(|i| &self.entries[i])
    }

    /// A page of the log, oldest first: entries before `before` (or the
    /// newest), optionally only one thread's.
    pub fn page(&self, topic: Option<&str>, before: Option<u64>, limit: usize) -> Vec<Entry> {
        let mut page: Vec<Entry> = self
            .entries
            .iter()
            .rev()
            .filter(|e| before.is_none_or(|b| e.seq < b))
            .filter(|e| topic.is_none_or(|t| e.topic == t))
            .take(limit)
            .cloned()
            .collect();
        page.reverse();
        page
    }

    /// Threads, most recently active first.
    pub fn threads(&self) -> Vec<Thread> {
        let mut threads: Vec<Thread> = self.meta.threads.values().filter(|t| t.entries > 0).cloned().collect();
        threads.sort_by(|a, b| b.last_seq.cmp(&a.last_seq));
        threads
    }

    pub fn thread(&self, key: &str) -> Option<&Thread> {
        self.meta.threads.get(key)
    }

    /// What the model sees of a thread: its summary, then the latest
    /// answered exchanges the summary doesn't cover (interrupted and failed
    /// replies are in the log, not in the model's context).
    pub fn context(&self, key: &str, max_pairs: usize) -> (Option<String>, Vec<(String, String)>) {
        let (summary, through) = self
            .meta
            .threads
            .get(key)
            .map_or((String::new(), 0), |t| (t.summary.clone(), t.summarized_through));
        let mut pairs: Vec<(String, String)> = self
            .entries
            .iter()
            .filter(|e| e.role == Role::Kin && e.topic == key && e.seq > through)
            .filter(|e| !e.interrupted && e.error.is_none() && !e.answers.is_empty() && !e.text.trim().is_empty())
            .map(|reply| {
                let said: Vec<&str> = reply.answers.iter().filter_map(|s| self.get(*s)).map(|e| e.text.as_str()).collect();
                (said.join("\n\n"), reply.text.clone())
            })
            .filter(|(said, _)| !said.trim().is_empty())
            .collect();
        if pairs.len() > max_pairs {
            pairs.drain(..pairs.len() - max_pairs);
        }
        (Some(summary).filter(|s| !s.trim().is_empty()), pairs)
    }

    /// Threads with at least `min_new` entries newer than their summary.
    pub fn stale(&self, min_new: usize) -> Vec<String> {
        self.meta
            .threads
            .values()
            .filter(|t| self.entries.iter().filter(|e| e.topic == t.key && e.seq > t.summarized_through).count() >= min_new)
            .map(|t| t.key.clone())
            .collect()
    }

    /// The previous summary and the entries since, for the summarizer.
    pub fn unsummarized(&self, key: &str) -> (String, Vec<Entry>) {
        let thread = self.meta.threads.get(key);
        let through = thread.map_or(0, |t| t.summarized_through);
        let entries = self.entries.iter().filter(|e| e.topic == key && e.seq > through).cloned().collect();
        (thread.map(|t| t.summary.clone()).unwrap_or_default(), entries)
    }

    pub fn set_summary(&mut self, key: &str, summary: &str, through: u64) -> Option<Thread> {
        let thread = self.meta.threads.get_mut(key)?;
        if through <= thread.summarized_through {
            return None;
        }
        thread.summary = summary.trim().to_string();
        thread.summarized_through = through;
        let thread = thread.clone();
        let _ = self.save_meta();
        Some(thread)
    }

    /// Finds words in the whole log (any order, case-insensitive), best
    /// matches first, newest first among equals.
    pub fn search(&self, query: &str, topic: Option<&str>, limit: usize) -> Vec<Hit> {
        let query = query.trim().to_lowercase();
        let mut terms: Vec<&str> = query.split_whitespace().collect();
        terms.dedup();
        terms.truncate(8);
        if terms.is_empty() {
            return vec![];
        }
        let mut hits: Vec<(usize, &Entry)> = self
            .entries
            .iter()
            .filter(|e| topic.is_none_or(|t| e.topic == t))
            .filter_map(|e| {
                let text = e.text.to_lowercase();
                let found = terms.iter().filter(|t| text.contains(*t) || e.topic.to_lowercase().contains(*t)).count();
                (found > 0).then_some((found * 10 + usize::from(terms.len() > 1 && text.contains(&query)) * 5, e))
            })
            .collect();
        hits.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.seq.cmp(&a.1.seq)));
        hits.into_iter()
            .take(limit)
            .map(|(_, e)| {
                let lower = e.text.to_lowercase();
                let at = terms.iter().filter_map(|t| lower.find(t)).min().unwrap_or(0);
                Hit { seq: e.seq, at: e.at.clone(), role: e.role, topic: e.topic.clone(), snippet: snippet(&e.text, lower[..at].chars().count()) }
            })
            .collect()
    }

    /// The `history` tool: search, or read around one entry.
    pub fn tool(&self, query: Option<&str>, around: Option<u64>, topic: Option<&str>, limit: usize) -> String {
        if let Some(seq) = around {
            let Some(i) = self.entries.iter().position(|e| e.seq == seq) else {
                return format!("No entry #{seq}.");
            };
            let from = i.saturating_sub(3);
            let to = (i + 4).min(self.entries.len());
            return self.entries[from..to]
                .iter()
                .map(|e| format!("#{} {} {}{}:\n{}\n", e.seq, &e.at[..e.at.len().min(16)], e.role.name(), about(&e.topic), e.text.trim()))
                .collect::<Vec<_>>()
                .join("\n");
        }
        let query = query.unwrap_or_default();
        let hits = self.search(query, topic, limit);
        if hits.is_empty() {
            return format!("Nothing in the conversation history matches {query:?}.");
        }
        let mut out = format!("{} match(es), best first. Read around one with {{\"around\": seq}}.\n", hits.len());
        for hit in hits {
            let entry = self.get(hit.seq).map_or(Role::Owner, |e| e.role);
            out.push_str(&format!("\n#{} {} {}{}: {}\n", hit.seq, &hit.at[..hit.at.len().min(10)], entry.name(), about(&hit.topic), hit.snippet));
        }
        out
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.entries.len()
    }
}

fn about(topic: &str) -> String {
    if topic.is_empty() { String::new() } else { format!(" (about {topic})") }
}

fn snippet(text: &str, center: usize) -> String {
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let count = flat.chars().count();
    if count <= SNIPPET_CHARS {
        return flat;
    }
    let start = center.saturating_sub(SNIPPET_CHARS / 3).min(count - SNIPPET_CHARS);
    let body: String = flat.chars().skip(start).take(SNIPPET_CHARS).collect();
    format!("{}{body}{}", if start > 0 { "…" } else { "" }, if start + SNIPPET_CHARS < count { "…" } else { "" })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(minute: i64) -> DateTime<FixedOffset> {
        DateTime::parse_from_rfc3339("2026-11-02T10:00:00+00:00").unwrap() + chrono::Duration::minutes(minute)
    }

    fn chip(kind: &str, path: &str, label: Option<&str>) -> Chip {
        Chip { kind: kind.into(), path: path.into(), label: label.map(String::from), lines: None }
    }

    fn kin(log: &mut Log, text: &str, answers: Vec<u64>) -> Entry {
        let topic = log.get(*answers.last().unwrap()).unwrap().topic.clone();
        log.reply(Role::Kin, Draft { text: text.into(), topic, answers, ..Draft::default() }).unwrap()
    }

    #[test]
    fn topics_come_from_the_screen_then_from_what_is_said_then_from_the_moment() {
        let mut log = Log::open(None);
        // A paragraph chip belongs to its draft.
        let a = log
            .say_at("Is this paragraph too long?", vec![chip("paragraph", "drafts/tools.mdx", Some("A pencil is…")), chip("doc", "drafts/tools.mdx", Some("Tools that shape thinking"))], at(0))
            .unwrap();
        assert_eq!(a.topic, "drafts/tools.mdx");
        assert_eq!(log.thread("drafts/tools.mdx").unwrap().label, "Tools that shape thinking", "named after the document");
        // A paragraph alone takes the thread's name, or the file's.
        let alone = log.infer("", &[chip("paragraph", "drafts/tools.mdx", Some("A pencil is…"))], at(1));
        assert_eq!(alone.label, "Tools that shape thinking");
        assert_eq!(log.infer("", &[chip("paragraph", "drafts/new-one.md", Some("x"))], at(1)).label, "new one");

        // Nothing on screen, a moment later: still the same thread.
        let b = log.say_at("What about the ending?", vec![], at(5)).unwrap();
        assert_eq!(b.topic, "drafts/tools.mdx");
        // A clip on screen starts its own thread.
        let c = log.say_at("Why did I keep this?", vec![chip("clip", "inspiration/kiln.md", Some("Anagama kilns"))], at(6)).unwrap();
        assert_eq!(c.topic, "inspiration/kiln.md");
        // Naming a thread brings it back, with nothing on screen.
        let d = log.say_at("Back to tools that shape thinking: is it done?", vec![], at(90)).unwrap();
        assert_eq!(d.topic, "drafts/tools.mdx");
        // Hours later, with nothing on screen and nothing named: general.
        let e = log.say_at("What should I read tonight?", vec![], at(400)).unwrap();
        assert_eq!(e.topic, GENERAL);
        let keys: Vec<String> = log.threads().into_iter().map(|t| t.key).collect();
        assert_eq!(keys, ["", "drafts/tools.mdx", "inspiration/kiln.md"]);
    }

    #[test]
    fn the_log_is_append_only_and_survives_reopening() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = Log::open(Some(dir.path().into()));
        let q = log.say_at("Kilns?", vec![chip("clip", "inspiration/kiln.md", None)], at(0)).unwrap();
        assert_eq!(log.pending().len(), 1);
        let r = kin(&mut log, "Anagama kilns fire for days.", vec![q.seq]);
        assert_eq!((r.role, r.seq, r.topic.as_str()), (Role::Kin, 2, "inspiration/kiln.md"));
        log.mark_answered(q.seq);
        assert!(log.pending().is_empty());
        log.set_summary("inspiration/kiln.md", "Talked about kilns.", 2).unwrap();
        // A torn last line (a crash mid-write) is skipped.
        let mut file = OpenOptions::new().append(true).open(dir.path().join("log.jsonl")).unwrap();
        write!(file, "{{\"seq\":3,\"at\":").unwrap();

        let reopened = Log::open(Some(dir.path().into()));
        assert_eq!(reopened.len(), 2);
        assert_eq!(reopened.get(2).unwrap().role, Role::Kin);
        assert!(reopened.pending().is_empty());
        let thread = reopened.thread("inspiration/kiln.md").unwrap();
        assert_eq!((thread.entries, thread.summary.as_str(), thread.summarized_through), (2, "Talked about kilns.", 2));
    }

    #[test]
    fn a_thread_resumes_with_its_summary_and_recent_exchanges() {
        let mut log = Log::open(None);
        let draft = || vec![chip("doc", "drafts/x.md", Some("Draft X"))];
        let q1 = log.say_at("First question", draft(), at(0)).unwrap();
        kin(&mut log, "First answer", vec![q1.seq]);
        // A burst answered as one turn.
        let q2 = log.say_at("Second", draft(), at(1)).unwrap();
        let q3 = log.say_at("and third", draft(), at(1)).unwrap();
        kin(&mut log, "Both answered", vec![q2.seq, q3.seq]);
        // An interrupted reply stays in the log but not in the model's context.
        let q4 = log.say_at("Fourth", draft(), at(2)).unwrap();
        log.reply(Role::Kin, Draft { text: "Half an ans".into(), topic: "drafts/x.md".into(), answers: vec![q4.seq], interrupted: true, ..Draft::default() }).unwrap();
        // Another thread in between doesn't leak in.
        let other = log.say_at("Elsewhere", vec![chip("clip", "inspiration/y.md", None)], at(3)).unwrap();
        kin(&mut log, "Other answer", vec![other.seq]);

        let (recap, pairs) = log.context("drafts/x.md", HISTORY_PAIRS);
        assert_eq!(recap, None);
        assert_eq!(pairs, [("First question".into(), "First answer".into()), ("Second\n\nand third".into(), "Both answered".into())]);

        // After an idle summary, only newer exchanges are sent as messages.
        log.set_summary("drafts/x.md", "Asked two things.", 5).unwrap();
        assert!(log.set_summary("drafts/x.md", "older", 3).is_none(), "summaries only move forward");
        let (recap, pairs) = log.context("drafts/x.md", HISTORY_PAIRS);
        assert_eq!(recap.as_deref(), Some("Asked two things."));
        assert!(pairs.is_empty());
        // The scrollable history is all still there.
        assert_eq!(log.page(Some("drafts/x.md"), None, 100).len(), 7);
        assert_eq!(log.page(None, None, 100).len(), 9);
        assert_eq!(log.page(None, Some(3), 100).iter().map(|e| e.seq).collect::<Vec<_>>(), [1, 2]);
    }

    #[test]
    fn stale_threads_are_the_ones_to_summarize() {
        let mut log = Log::open(None);
        for i in 0..4 {
            log.say_at(&format!("q{i}"), vec![chip("doc", "a.md", None)], at(i)).unwrap();
        }
        log.say_at("one", vec![chip("doc", "b.md", None)], at(5)).unwrap();
        assert_eq!(log.stale(4), ["a.md"]);
        let (previous, entries) = log.unsummarized("a.md");
        assert_eq!((previous.as_str(), entries.len()), ("", 4));
        log.set_summary("a.md", "four questions", entries.last().unwrap().seq).unwrap();
        assert!(log.stale(4).is_empty());
    }

    #[test]
    fn history_is_searchable_by_kin() {
        let mut log = Log::open(None);
        let q = log.say_at("What did the anagama clip say about patience?", vec![chip("clip", "inspiration/kiln.md", None)], at(0)).unwrap();
        kin(&mut log, "It says firing takes days, which is about patience.", vec![q.seq]);
        log.say_at("Unrelated: groceries", vec![], at(500)).unwrap();

        let hits = log.search("patience", None, 10);
        assert_eq!(hits.iter().map(|h| h.seq).collect::<Vec<_>>(), [2, 1], "newest first among equals");
        assert_eq!(log.search("anagama patience", None, 10)[0].seq, 1, "more terms rank higher");
        assert!(log.search("patience", Some(GENERAL), 10).is_empty());
        let out = log.tool(Some("patience"), None, None, 5);
        assert!(out.contains("#1 2026-11-02 Hussain (about inspiration/kiln.md): What did the anagama"), "{out}");
        let around = log.tool(None, Some(2), None, 5);
        assert!(around.contains("#2") && around.contains("Kin (about inspiration/kiln.md):\nIt says firing"), "{around}");
        assert!(log.tool(Some("zebra"), None, None, 5).starts_with("Nothing"));
    }
}
