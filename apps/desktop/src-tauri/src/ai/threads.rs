//! Kin's threads (KI-104): many small conversations instead of one long one.
//!
//! A thread is the one primitive behind the chat, paragraph comments,
//! Discuss on a Feed story, a clip or an idea, and quick asks. Each has an
//! id, a title (from its first message, editable), an optional anchor (what
//! it's about), its messages and a status (open or resolved). Nothing is
//! inferred: a new ask starts a new thread unless he replies inside one.
//!
//! Files, in `<vault>/.kintsugi/kin/threads/` ([`FOLDER`]):
//! - `<id>.jsonl`: the thread's messages, one [`Entry`] per line, only ever
//!   appended to. A torn last line (a crash mid-write) is skipped.
//! - `index.json`: each thread's [`Meta`] (title, anchor, status, when it
//!   last changed), for listing and search. Rewritten atomically. If it's
//!   lost or damaged, threads are found again from their files.
//!
//! The vault's old single log and `.kintsugi/comments/` are turned into
//! threads once, by [`migrate`].

use super::prompt::Chip;
use chrono::{DateTime, FixedOffset, Local};
use kintsugi_vault::write_atomic;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};

pub mod global;
pub mod migrate;

type Result<T> = std::result::Result<T, String>;

/// Kin's folder in a vault, relative to the vault.
pub const DIR: &str = ".kintsugi/kin";
/// The threads, inside [`DIR`].
pub const FOLDER: &str = "threads";
const INDEX: &str = "index.json";
/// Exchanges of a thread sent to the model as messages. Threads are small;
/// older exchanges are still in the thread and the `threads` tool.
pub const HISTORY_PAIRS: usize = 12;
/// The most tool calls one reply keeps.
pub const MAX_TOOLS_PER_REPLY: usize = 24;
pub const MAX_TITLE_CHARS: usize = 80;
const SNIPPET_CHARS: usize = 220;
const PREVIEW_CHARS: usize = 140;
const MAX_QUOTE_CHARS: usize = 4_000;
const MAX_CONTEXT_CHARS: usize = 64;

/// `<vault>/.kintsugi/kin`, refusing links on the way.
pub fn vault_dir(root: &Path) -> Result<PathBuf> {
    let mut at = root.to_path_buf();
    for part in DIR.split('/') {
        at.push(part);
        if fs::symlink_metadata(&at).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(format!("{DIR}: links are not followed"));
        }
    }
    Ok(at)
}

fn is_false(b: &bool) -> bool {
    !*b
}

// --- Messages ---------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    /// Hussain.
    Owner,
    Kin,
    /// A helper agent reporting back.
    Helper,
}

impl Role {
    pub fn name(self) -> &'static str {
        match self {
            Role::Owner => "Hussain",
            Role::Kin => "Kin",
            Role::Helper => "Helper",
        }
    }
}

/// One message in a thread.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// Position in its thread, from 1. Never reused.
    pub seq: u64,
    /// The thread's id.
    #[serde(default)]
    pub thread: String,
    /// RFC 3339.
    pub at: String,
    pub role: Role,
    pub text: String,
    /// What was on screen (his messages).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub chips: Vec<Chip>,
    /// Kin's reply: the messages of his it answers (a burst is one turn).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub answers: Vec<u64>,
    /// Kin's reply was cut short by him typing or stopping it.
    #[serde(default, skip_serializing_if = "is_false")]
    pub interrupted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// A helper's report: its job id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usd: Option<f64>,
    /// "Kin, review this draft" and Kin's notes from it.
    #[serde(default, skip_serializing_if = "is_false")]
    pub review: bool,
    /// Kin's reply: the web searches and pages it used (KI-78). Never sent
    /// back to the model.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub web: Vec<super::web::WebCall>,
    /// Kin's reply: the tools it used on the way, in order (KI-79). Never
    /// sent back to the model.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<ToolUse>,
    /// Kin's reply: how long the turn took, in milliseconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ms: Option<u64>,
    /// Kin's reply: `provider/model` it ran on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Kin's reply ran with the month's cap already reached.
    #[serde(default, skip_serializing_if = "is_false")]
    pub cap_reached: bool,
    /// Moved from the old single log (KI-104): its `seq` there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub was: Option<u64>,
}

/// One tool call in a reply (KI-79): its name and arguments (long strings
/// cut), and whether it failed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolUse {
    pub name: String,
    #[serde(default)]
    pub arguments: Value,
    #[serde(default, skip_serializing_if = "is_false")]
    pub error: bool,
}

impl ToolUse {
    /// A tool call as a thread keeps it: strings over 200 characters cut.
    pub fn new(name: &str, arguments: &Value) -> Self {
        fn cut(value: &Value, depth: usize) -> Value {
            match value {
                Value::String(s) if s.chars().count() > 200 => {
                    Value::String(format!("{}…", s.chars().take(200).collect::<String>()))
                }
                Value::Array(items) if depth < 3 => {
                    Value::Array(items.iter().take(8).map(|v| cut(v, depth + 1)).collect())
                }
                Value::Object(map) if depth < 3 => Value::Object(
                    map.iter()
                        .map(|(k, v)| (k.clone(), cut(v, depth + 1)))
                        .collect(),
                ),
                Value::Array(_) | Value::Object(_) => Value::Null,
                other => other.clone(),
            }
        }
        ToolUse {
            name: name.into(),
            arguments: cut(arguments, 0),
            error: false,
        }
    }
}

/// What a new message says; the thread assigns `seq`, `thread` and `at`.
#[derive(Debug, Clone, Default)]
pub struct Draft {
    pub text: String,
    pub chips: Vec<Chip>,
    pub answers: Vec<u64>,
    pub interrupted: bool,
    pub error: Option<String>,
    pub job: Option<String>,
    pub usd: Option<f64>,
    pub review: bool,
    pub web: Vec<super::web::WebCall>,
    pub tools: Vec<ToolUse>,
    pub ms: Option<u64>,
    pub model: Option<String>,
    pub cap_reached: bool,
}

impl Draft {
    pub fn said(text: &str, chips: Vec<Chip>) -> Self {
        Draft {
            text: text.trim().into(),
            chips,
            ..Draft::default()
        }
    }
}

// --- Threads ----------------------------------------------------------------

/// Where a paragraph thread sits: the paragraph's text when last seen, a
/// little of what came before and after it, and its first line (a
/// tie-breaker). Re-resolved by the editor (`packages/editor/src/anchors.ts`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Quote {
    pub exact: String,
    #[serde(default)]
    pub prefix: String,
    #[serde(default)]
    pub suffix: String,
    #[serde(default)]
    pub line: u32,
}

impl Quote {
    /// Caps what the webview sends, so the index can't grow without bound.
    pub fn clamp(mut self) -> Self {
        self.exact = self.exact.chars().take(MAX_QUOTE_CHARS).collect();
        let n = self.prefix.chars().count();
        self.prefix = self
            .prefix
            .chars()
            .skip(n.saturating_sub(MAX_CONTEXT_CHARS))
            .collect();
        self.suffix = self.suffix.chars().take(MAX_CONTEXT_CHARS).collect();
        self
    }
}

/// What a thread is about.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Anchor {
    /// `"doc"`, `"paragraph"`, `"feed"`, `"clip"` or `"idea"`.
    pub kind: String,
    /// A vault path (a paragraph's document), a Feed item's id or an idea's id.
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// A paragraph (or a passage in it): where in the document.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quote: Option<Quote>,
    /// A paragraph thread whose paragraph is gone. Kept, with the text it was on.
    #[serde(default, skip_serializing_if = "is_false")]
    pub orphaned: bool,
}

pub const ANCHOR_KINDS: [&str; 5] = ["doc", "paragraph", "feed", "clip", "idea"];

impl Anchor {
    pub fn doc(path: &str) -> Self {
        Anchor {
            kind: "doc".into(),
            path: path.trim().into(),
            label: None,
            quote: None,
            orphaned: false,
        }
    }

    /// A checked anchor: a known kind, a path, a paragraph with its quote;
    /// labels and quotes capped.
    pub fn checked(mut self) -> Result<Self> {
        self.kind = self.kind.trim().to_string();
        if self.kind == "selection" {
            self.kind = "paragraph".into();
        }
        self.path = self.path.trim().to_string();
        if !ANCHOR_KINDS.contains(&self.kind.as_str()) {
            return Err(format!("A thread can't be about a {}.", self.kind));
        }
        if self.path.is_empty() || self.path.len() > 1_000 {
            return Err("A thread needs something to be about.".into());
        }
        if matches!(self.kind.as_str(), "doc" | "paragraph") {
            crate::sidecar::document(&self.path)?;
        }
        if self.kind == "paragraph" {
            let quote = self.quote.take().unwrap_or_default().clamp();
            if quote.exact.trim().is_empty() {
                return Err("Ask about a paragraph with some text in it.".into());
            }
            self.quote = Some(quote);
        } else {
            self.quote = None;
            self.orphaned = false;
        }
        self.label = self
            .label
            .map(|l| l.split_whitespace().collect::<Vec<_>>().join(" "))
            .map(|l| l.chars().take(MAX_TITLE_CHARS).collect::<String>())
            .filter(|l| !l.is_empty());
        Ok(self)
    }

    /// A thread about what a chip shows: a paragraph's chip is about its
    /// document unless a quote comes with it.
    pub fn from_chip(chip: &Chip) -> Option<Self> {
        let kind = match chip.kind.as_str() {
            "doc" | "paragraph" | "selection" => "doc",
            "clip" | "feed" | "idea" => chip.kind.as_str(),
            _ => return None,
        };
        Anchor {
            kind: kind.into(),
            path: chip.path.trim().into(),
            label: (kind != "doc" || chip.kind == "doc")
                .then(|| chip.label.clone())
                .flatten(),
            quote: None,
            orphaned: false,
        }
        .checked()
        .ok()
    }

    /// The chip that tells Kin what the thread is about.
    pub fn chip(&self) -> Chip {
        Chip {
            kind: if self.kind == "paragraph" {
                "doc".into()
            } else {
                self.kind.clone()
            },
            path: self.path.clone(),
            label: self.label.clone(),
            lines: None,
        }
    }

    /// One line for Kin's context and the `threads` tool.
    pub fn describe(&self) -> String {
        let label = self
            .label
            .as_deref()
            .map(|l| format!(" ({l})"))
            .unwrap_or_default();
        match self.kind.as_str() {
            "paragraph" => {
                let quote = self.quote.as_ref().map_or("", |q| q.exact.as_str());
                let flat: String = quote.split_whitespace().collect::<Vec<_>>().join(" ");
                let gone = if self.orphaned {
                    " (since deleted from the document)"
                } else {
                    ""
                };
                format!(
                    "a paragraph of {}{gone}: <data>{}</data>",
                    self.path,
                    flat.chars()
                        .take(1_500)
                        .collect::<String>()
                        .replace("</data", "<\\/data")
                )
            }
            "feed" => format!(
                "the Feed item feed:{}{label}",
                self.path.trim_start_matches("feed:")
            ),
            "clip" => format!("the clip {}{label}", self.path),
            "idea" => format!("the idea {}{label}", self.path),
            _ => format!("the document {}{label}", self.path),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    #[default]
    Open,
    Resolved,
}

/// A thread as the index keeps it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub id: String,
    pub title: String,
    /// He named it himself: it no longer follows the first message.
    #[serde(default, skip_serializing_if = "is_false")]
    pub titled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor: Option<Anchor>,
    #[serde(default)]
    pub status: Status,
    /// How it started: `"chat"`, `"discuss"`, `"mention"` (`@Kin`), `"ask"`
    /// (a quick ask), `"review"`, `"helper"` or `"earlier"` (moved from the
    /// old log).
    #[serde(default)]
    pub origin: String,
    /// RFC 3339.
    pub created: String,
    /// When its last message arrived, or it last changed.
    pub updated: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved: Option<String>,
    /// Messages in it; counted from its file on open.
    #[serde(default)]
    pub entries: usize,
    /// Its last message, cut short.
    #[serde(default)]
    pub preview: String,
}

/// What starts a new thread.
#[derive(Debug, Clone, Default)]
pub struct New {
    pub anchor: Option<Anchor>,
    pub origin: String,
    /// Otherwise from its first message.
    pub title: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Index {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    threads: Vec<Meta>,
    /// Old logs already turned into threads, by fingerprint ([`migrate`]).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    migrated: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct Thread {
    pub meta: Meta,
    pub entries: Vec<Entry>,
    /// His messages up to here have had their turn (in memory: a quit
    /// settles everything).
    answered: u64,
}

/// A paragraph anchor the editor re-resolved after edits (or found gone).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Moved {
    pub id: String,
    pub anchor: Quote,
    #[serde(default)]
    pub orphaned: bool,
}

/// Which threads to list.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Filter {
    /// Only threads about this path or id (a document's paragraphs count).
    #[serde(default)]
    pub about: Option<String>,
    /// Words to find in titles and messages.
    #[serde(default)]
    pub query: Option<String>,
    /// Resolved threads too.
    #[serde(default)]
    pub resolved: bool,
    #[serde(default)]
    pub limit: Option<usize>,
}

/// A thread in a list: its meta, and where a search found it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listed {
    #[serde(flatten)]
    pub meta: Meta,
    /// A search's best match in it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hit: Option<String>,
}

pub fn new_id() -> String {
    use std::sync::atomic::{AtomicU32, Ordering};
    static N: AtomicU32 = AtomicU32::new(0);
    let n = N.fetch_add(1, Ordering::Relaxed);
    format!(
        "t-{}-{:x}{:04x}",
        Local::now().format("%Y%m%d-%H%M%S"),
        std::process::id() & 0xfff,
        n & 0xffff
    )
}

/// Ids name files: letters, digits, `-` and `_` only.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// A title from a first message: its first line, at most a few words.
pub fn title_from(text: &str) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or_default();
    let line = line.trim_start_matches(['#', '>', '-', '*', ' ']);
    let flat: String = line.split_whitespace().collect::<Vec<_>>().join(" ");
    const MAX: usize = 60;
    if flat.chars().count() <= MAX {
        return flat;
    }
    let cut: String = flat.chars().take(MAX).collect();
    let cut = cut.rsplit_once(' ').map_or(cut.as_str(), |(head, _)| head);
    format!("{}…", cut.trim_end_matches([',', ';', ':', '.']))
}

fn preview(entry: &Entry) -> String {
    let text = if entry.error.is_some() && entry.text.trim().is_empty() {
        "Kin couldn’t answer."
    } else {
        entry.text.as_str()
    };
    snippet(text, 0, PREVIEW_CHARS)
}

fn parse_time(at: &str) -> Option<DateTime<FixedOffset>> {
    DateTime::parse_from_rfc3339(at).ok()
}

/// Newer first, by `updated` as a time (strings may differ in offset).
fn newer(a: &Meta, b: &Meta) -> std::cmp::Ordering {
    match (parse_time(&a.updated), parse_time(&b.updated)) {
        (Some(x), Some(y)) => y.cmp(&x),
        _ => b.updated.cmp(&a.updated),
    }
    .then_with(|| b.id.cmp(&a.id))
}

/// Reads a thread file's messages; a torn line is skipped.
pub(crate) fn read_entries(path: &Path, id: &str) -> Vec<Entry> {
    fs::read_to_string(path)
        .map(|text| {
            text.lines()
                .filter_map(|l| serde_json::from_str::<Entry>(l).ok())
                .map(|mut e| {
                    e.thread = id.to_string();
                    e
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Every thread of one vault.
pub struct Store {
    /// The vault these are the threads of, if any.
    vault: Option<PathBuf>,
    /// `None`: kept in memory only.
    dir: Option<PathBuf>,
    threads: HashMap<String, Thread>,
    migrated: Vec<String>,
}

impl Store {
    /// Opens the threads in `dir` (`<vault>/.kintsugi/kin/threads`; `None`:
    /// in memory). Messages a quit left unanswered stay, settled.
    pub fn open(dir: Option<PathBuf>) -> Self {
        let mut store = Store {
            vault: None,
            dir,
            threads: HashMap::new(),
            migrated: vec![],
        };
        let Some(dir) = store.dir.clone() else {
            return store;
        };
        let index: Index = match fs::read_to_string(dir.join(INDEX)) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_else(|error| {
                // Set aside, never overwritten: the files rebuild it.
                eprintln!("kin: the thread index is damaged ({error}); rebuilding it");
                let aside = dir.join(format!(
                    "{INDEX}.damaged-{}",
                    Local::now().format("%Y%m%d-%H%M%S")
                ));
                let _ = fs::rename(dir.join(INDEX), aside);
                Index::default()
            }),
            Err(_) => Index::default(),
        };
        store.migrated = index.migrated;
        for meta in index.threads {
            if valid_id(&meta.id) {
                let entries = read_entries(&dir.join(format!("{}.jsonl", meta.id)), &meta.id);
                store.threads.insert(
                    meta.id.clone(),
                    Thread {
                        meta,
                        entries,
                        answered: 0,
                    },
                );
            }
        }
        // A thread whose index line was lost (a crash between its first
        // message and the index) is found from its file.
        let mut recovered = false;
        if let Ok(files) = fs::read_dir(&dir) {
            for file in files.flatten() {
                let name = file.file_name().to_string_lossy().into_owned();
                let Some(id) = name.strip_suffix(".jsonl") else {
                    continue;
                };
                if !valid_id(id) || store.threads.contains_key(id) {
                    continue;
                }
                let entries = read_entries(&file.path(), id);
                let Some(first) = entries.first() else {
                    continue;
                };
                let title = entries
                    .iter()
                    .find(|e| e.role == Role::Owner)
                    .map_or_else(|| title_from(&first.text), |e| title_from(&e.text));
                store.threads.insert(
                    id.into(),
                    Thread {
                        meta: Meta {
                            id: id.into(),
                            title,
                            titled: false,
                            anchor: None,
                            status: Status::Open,
                            origin: "chat".into(),
                            created: first.at.clone(),
                            updated: first.at.clone(),
                            resolved: None,
                            entries: 0,
                            preview: String::new(),
                        },
                        entries,
                        answered: 0,
                    },
                );
                recovered = true;
            }
        }
        for thread in store.threads.values_mut() {
            Self::recount(thread);
            thread.answered = thread.entries.last().map_or(0, |e| e.seq);
        }
        if recovered {
            let _ = store.save_index();
        }
        store
    }

    /// Opens a vault's threads from `dir` (`None`: in memory).
    pub fn open_for(vault: &Path, dir: Option<PathBuf>) -> Self {
        let mut store = Store::open(dir);
        store.vault = Some(vault.to_path_buf());
        store
    }

    /// The vault these are the threads of; `None` before any vault is known.
    pub fn vault(&self) -> Option<&Path> {
        self.vault.as_deref()
    }

    fn recount(thread: &mut Thread) {
        thread.meta.entries = thread.entries.len();
        if let Some(last) = thread.entries.last() {
            thread.meta.preview = preview(last);
            if parse_time(&last.at) > parse_time(&thread.meta.updated) {
                thread.meta.updated = last.at.clone();
            }
        }
    }

    fn save_index(&self) -> Result<()> {
        let Some(dir) = &self.dir else { return Ok(()) };
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let mut threads: Vec<Meta> = self.threads.values().map(|t| t.meta.clone()).collect();
        threads.sort_by(|a, b| a.created.cmp(&b.created).then_with(|| a.id.cmp(&b.id)));
        let index = Index {
            version: 1,
            threads,
            migrated: self.migrated.clone(),
        };
        let json = serde_json::to_string_pretty(&index).map_err(|e| e.to_string())?;
        write_atomic(&dir.join(INDEX), &(json + "\n"))
    }

    /// Writes one line to a thread's file, creating it.
    fn write_line(&self, id: &str, entry: &Entry) -> Result<()> {
        let Some(dir) = &self.dir else { return Ok(()) };
        let line = serde_json::to_string(entry).map_err(|e| e.to_string())?;
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join(format!("{id}.jsonl")))
            .map_err(|e| e.to_string())?;
        writeln!(file, "{line}").map_err(|e| e.to_string())
    }

    /// Starts a thread with its first message. The message is on disk
    /// before the index names the thread.
    pub fn start(&mut self, new: New, role: Role, draft: Draft) -> Result<(Meta, Entry)> {
        self.start_at(new, role, draft, Local::now().fixed_offset())
    }

    pub fn start_at(
        &mut self,
        new: New,
        role: Role,
        draft: Draft,
        now: DateTime<FixedOffset>,
    ) -> Result<(Meta, Entry)> {
        let anchor = new.anchor.map(Anchor::checked).transpose()?;
        let mut id = new_id();
        while self.threads.contains_key(&id) {
            id = new_id();
        }
        let titled = new.title.as_deref().is_some_and(|t| !t.trim().is_empty());
        let title = new
            .title
            .filter(|t| !t.trim().is_empty())
            .map(|t| title_from(&t))
            .unwrap_or_else(|| title_from(&draft.text));
        let meta = Meta {
            id: id.clone(),
            title,
            titled,
            anchor,
            status: Status::Open,
            origin: if new.origin.is_empty() {
                "chat".into()
            } else {
                new.origin
            },
            created: now.to_rfc3339(),
            updated: now.to_rfc3339(),
            resolved: None,
            entries: 0,
            preview: String::new(),
        };
        self.threads.insert(
            id.clone(),
            Thread {
                meta,
                entries: vec![],
                answered: 0,
            },
        );
        match self.append_at(&id, role, draft, now) {
            Ok(entry) => Ok((self.threads[&id].meta.clone(), entry)),
            Err(error) => {
                self.threads.remove(&id);
                Err(error)
            }
        }
    }

    /// Appends a message to a thread. The line is written before anything else.
    pub fn append(&mut self, id: &str, role: Role, draft: Draft) -> Result<Entry> {
        self.append_at(id, role, draft, Local::now().fixed_offset())
    }

    pub fn append_at(
        &mut self,
        id: &str,
        role: Role,
        draft: Draft,
        now: DateTime<FixedOffset>,
    ) -> Result<Entry> {
        let thread = self.threads.get(id).ok_or("That thread is gone.")?;
        let entry = Entry {
            seq: thread.entries.last().map_or(1, |e| e.seq + 1),
            thread: id.into(),
            at: now.to_rfc3339(),
            role,
            text: draft.text,
            chips: draft.chips,
            answers: draft.answers,
            interrupted: draft.interrupted,
            error: draft.error,
            job: draft.job,
            usd: draft.usd,
            review: draft.review,
            web: draft.web,
            tools: draft.tools,
            ms: draft.ms,
            model: draft.model,
            cap_reached: draft.cap_reached,
            was: None,
        };
        self.write_line(id, &entry)?;
        let thread = self.threads.get_mut(id).ok_or("That thread is gone.")?;
        // His first message names a thread Kin started (a review note).
        if !thread.meta.titled
            && role == Role::Owner
            && !thread.entries.iter().any(|e| e.role == Role::Owner)
            && thread
                .entries
                .iter()
                .all(|e| e.role != Role::Kin || e.review)
            && thread.meta.origin != "review"
        {
            thread.meta.title = title_from(&entry.text);
        }
        thread.entries.push(entry.clone());
        thread.meta.updated = entry.at.clone();
        Self::recount(thread);
        if role == Role::Owner && entry.review {
            thread.answered = entry.seq;
        }
        let _ = self.save_index();
        Ok(entry)
    }

    pub fn get(&self, id: &str) -> Option<&Thread> {
        self.threads.get(id)
    }

    pub fn meta(&self, id: &str) -> Option<&Meta> {
        self.threads.get(id).map(|t| &t.meta)
    }

    /// His messages in a thread still waiting for Kin, oldest first.
    pub fn pending(&self, id: &str) -> Vec<Entry> {
        let Some(thread) = self.threads.get(id) else {
            return vec![];
        };
        thread
            .entries
            .iter()
            .filter(|e| e.role == Role::Owner && e.seq > thread.answered && !e.review)
            .cloned()
            .collect()
    }

    pub fn mark_answered(&mut self, id: &str, through: u64) {
        if let Some(thread) = self.threads.get_mut(id) {
            thread.answered = thread.answered.max(through);
        }
    }

    /// His last message in a thread, for "Ask again".
    pub fn last_said(&self, id: &str) -> Option<Entry> {
        self.threads
            .get(id)?
            .entries
            .iter()
            .rev()
            .find(|e| e.role == Role::Owner && !e.review)
            .cloned()
    }

    /// What the model sees of a thread: its latest answered exchanges.
    /// Interrupted and failed replies stay in the thread, out of the
    /// model's context. A note Kin started the thread with (a review's)
    /// stands on its own.
    pub fn context(&self, id: &str, max_pairs: usize) -> Vec<(String, String)> {
        let Some(thread) = self.threads.get(id) else {
            return vec![];
        };
        let said = |seq: &u64| {
            thread
                .entries
                .iter()
                .find(|e| e.seq == *seq)
                .map(|e| e.text.as_str())
        };
        let mut pairs: Vec<(String, String)> = thread
            .entries
            .iter()
            .filter(|e| e.role != Role::Owner)
            .filter(|e| !e.interrupted && e.error.is_none() && !e.text.trim().is_empty())
            .map(|reply| {
                let asked: Vec<&str> = reply.answers.iter().filter_map(said).collect();
                let asked = if !asked.is_empty() {
                    asked.join("\n\n")
                } else if reply.role == Role::Helper {
                    "(A helper reported back.)".into()
                } else if reply.review {
                    format!("{}\n(You left this note on the paragraph.)", REVIEW_REQUEST)
                } else {
                    String::new()
                };
                (asked, reply.text.clone())
            })
            .filter(|(asked, _)| !asked.trim().is_empty())
            .collect();
        if pairs.len() > max_pairs {
            pairs.drain(..pairs.len() - max_pairs);
        }
        pairs
    }

    /// Threads, newest first.
    pub fn list(&self, filter: &Filter) -> Vec<Listed> {
        let limit = filter.limit.unwrap_or(200).clamp(1, 1_000);
        let about = filter
            .about
            .as_deref()
            .map(|a| a.trim().trim_start_matches("feed:").to_string())
            .filter(|a| !a.is_empty());
        let query = filter
            .query
            .as_deref()
            .map(|q| q.trim().to_lowercase())
            .unwrap_or_default();
        let mut terms: Vec<&str> = query.split_whitespace().collect();
        terms.dedup();
        terms.truncate(8);
        let mut found: Vec<(usize, Listed)> = self
            .threads
            .values()
            .filter(|t| filter.resolved || t.meta.status == Status::Open)
            .filter(|t| {
                about.as_deref().is_none_or(|about| {
                    t.meta
                        .anchor
                        .as_ref()
                        .is_some_and(|a| a.path.trim_start_matches("feed:") == about)
                })
            })
            .filter(|t| t.meta.entries > 0 || t.meta.anchor.is_some())
            .filter_map(|t| {
                if terms.is_empty() {
                    return Some((
                        0,
                        Listed {
                            meta: t.meta.clone(),
                            hit: None,
                        },
                    ));
                }
                let (score, hit) = score(t, &terms, &query);
                (score > 0).then(|| {
                    (
                        score,
                        Listed {
                            meta: t.meta.clone(),
                            hit,
                        },
                    )
                })
            })
            .collect();
        found.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| newer(&a.1.meta, &b.1.meta)));
        found.into_iter().take(limit).map(|(_, l)| l).collect()
    }

    pub fn set_status(&mut self, id: &str, status: Status) -> Result<Meta> {
        let thread = self.threads.get_mut(id).ok_or("That thread is gone.")?;
        thread.meta.status = status;
        thread.meta.resolved = (status == Status::Resolved).then(|| Local::now().to_rfc3339());
        let meta = thread.meta.clone();
        self.save_index()?;
        Ok(meta)
    }

    /// He names a thread; an empty title goes back to its first message's.
    pub fn set_title(&mut self, id: &str, title: &str) -> Result<Meta> {
        let thread = self.threads.get_mut(id).ok_or("That thread is gone.")?;
        let title: String = title.split_whitespace().collect::<Vec<_>>().join(" ");
        if title.is_empty() {
            thread.meta.titled = false;
            thread.meta.title = thread
                .entries
                .iter()
                .find(|e| e.role == Role::Owner)
                .or(thread.entries.first())
                .map(|e| title_from(&e.text))
                .unwrap_or_default();
        } else {
            thread.meta.titled = true;
            thread.meta.title = title.chars().take(MAX_TITLE_CHARS).collect();
        }
        let meta = thread.meta.clone();
        self.save_index()?;
        Ok(meta)
    }

    /// Paragraph anchors of `doc` the editor re-resolved; true if any changed.
    /// An orphan keeps the last text it was on, so it can be shown and found again.
    pub fn moved(&mut self, doc: &str, moves: Vec<Moved>) -> Result<bool> {
        let doc = doc.trim();
        let mut changed = false;
        for m in moves {
            let Some(anchor) = self
                .threads
                .get_mut(&m.id)
                .and_then(|t| t.meta.anchor.as_mut())
                .filter(|a| a.kind == "paragraph" && a.path == doc)
            else {
                continue;
            };
            let quote = m.anchor.clamp();
            let quote = if m.orphaned || quote.exact.trim().is_empty() {
                Quote {
                    line: quote.line,
                    ..anchor.quote.clone().unwrap_or_default()
                }
            } else {
                quote
            };
            if anchor.quote.as_ref() != Some(&quote) || anchor.orphaned != m.orphaned {
                anchor.quote = Some(quote);
                anchor.orphaned = m.orphaned;
                changed = true;
            }
        }
        if changed {
            self.save_index()?;
        }
        Ok(changed)
    }

    /// A renamed or moved document (or folder) takes its threads along.
    pub fn renamed(&mut self, from: &str, to: &str) -> Result<bool> {
        let (from, to) = (
            from.trim().trim_end_matches('/'),
            to.trim().trim_end_matches('/'),
        );
        if from.is_empty() || to.is_empty() {
            return Ok(false);
        }
        let mut changed = false;
        for thread in self.threads.values_mut() {
            let Some(anchor) = thread.meta.anchor.as_mut() else {
                continue;
            };
            if !matches!(anchor.kind.as_str(), "doc" | "paragraph" | "clip") {
                continue;
            }
            if anchor.path == from {
                anchor.path = to.into();
                changed = true;
            } else if let Some(rest) = anchor.path.strip_prefix(&format!("{from}/")) {
                anchor.path = format!("{to}/{rest}");
                changed = true;
            }
        }
        if changed {
            self.save_index()?;
        }
        Ok(changed)
    }

    /// The `threads` tool: search, list what a thing's threads are, or read one.
    pub fn tool(&self, args: &Value, current: Option<&str>) -> String {
        if let Some(id) = args["id"].as_str() {
            let Some(thread) = self.threads.get(id.trim()) else {
                return format!("No thread {id:?}.");
            };
            let mut out = format!("Thread {} \"{}\"", thread.meta.id, thread.meta.title);
            if let Some(anchor) = &thread.meta.anchor {
                out.push_str(&format!(", about {}", anchor.describe()));
            }
            out.push_str(&format!(
                ", started {}{}.\n",
                &thread.meta.created[..thread.meta.created.len().min(10)],
                if thread.meta.status == Status::Resolved {
                    ", resolved"
                } else {
                    ""
                }
            ));
            let mut lines: Vec<String> = thread
                .entries
                .iter()
                .filter(|e| e.error.is_none())
                .map(|e| {
                    format!(
                        "\n#{} {} {}{}:\n{}\n",
                        e.seq,
                        &e.at[..e.at.len().min(16)],
                        e.role.name(),
                        if e.interrupted { " (interrupted)" } else { "" },
                        e.text.trim()
                    )
                })
                .collect();
            // The newest messages, when a thread is long.
            let mut total = 0;
            let mut keep = 0;
            for line in lines.iter().rev() {
                total += line.len();
                if total > 12_000 && keep > 0 {
                    break;
                }
                keep += 1;
            }
            let dropped = lines.len() - keep;
            if dropped > 0 {
                out.push_str(&format!("\n({dropped} earlier messages left out.)\n"));
            }
            for line in lines.drain(dropped..) {
                out.push_str(&line);
            }
            return out;
        }
        let limit = args["limit"]
            .as_u64()
            .map_or(10, |n| (n as usize).clamp(1, 30));
        let query = args["query"].as_str().unwrap_or_default();
        let about = args["about"].as_str().filter(|a| !a.trim().is_empty());
        let found: Vec<Listed> = self
            .list(&Filter {
                about: about.map(String::from),
                query: Some(query.into()),
                resolved: true,
                limit: Some(limit + 1),
            })
            .into_iter()
            .filter(|l| Some(l.meta.id.as_str()) != current)
            .take(limit)
            .collect();
        if found.is_empty() {
            return match (query.trim().is_empty(), about) {
                (_, Some(about)) if query.trim().is_empty() => {
                    format!("No other threads about {about}.")
                }
                _ => format!("No other thread matches {query:?}."),
            };
        }
        let mut out = format!(
            "{} thread(s), best first. Read one with {{\"id\": id}}.\n",
            found.len()
        );
        for l in found {
            out.push_str(&format!(
                "\n{} \"{}\" ({}{}){}: {}\n",
                l.meta.id,
                l.meta.title,
                &l.meta.updated[..l.meta.updated.len().min(10)],
                if l.meta.status == Status::Resolved {
                    ", resolved"
                } else {
                    ""
                },
                l.meta
                    .anchor
                    .as_ref()
                    .map(|a| format!(" about {}", short_anchor(a)))
                    .unwrap_or_default(),
                l.hit.unwrap_or(l.meta.preview)
            ));
        }
        out
    }

    /// The newest messages of every thread, newest first.
    pub fn recent(&self, limit: usize) -> Vec<Entry> {
        let mut all: Vec<&Entry> = self.threads.values().flat_map(|t| &t.entries).collect();
        all.sort_by(|a, b| match (parse_time(&a.at), parse_time(&b.at)) {
            (Some(x), Some(y)) => y.cmp(&x),
            _ => b.at.cmp(&a.at),
        });
        all.into_iter().take(limit).cloned().collect()
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.threads.len()
    }

    pub fn contains(&self, id: &str) -> bool {
        self.threads.contains_key(id)
    }
}

pub const REVIEW_REQUEST: &str = "Kin, review this draft.";

fn short_anchor(anchor: &Anchor) -> String {
    match anchor.kind.as_str() {
        "paragraph" => format!("a paragraph of {}", anchor.path),
        "feed" => format!("feed:{}", anchor.path.trim_start_matches("feed:")),
        _ => anchor.path.clone(),
    }
}

/// How well a thread matches: title words count most, then messages.
fn score(thread: &Thread, terms: &[&str], query: &str) -> (usize, Option<String>) {
    let title = thread.meta.title.to_lowercase();
    let about = thread
        .meta
        .anchor
        .as_ref()
        .map(|a| format!("{} {}", a.path, a.label.as_deref().unwrap_or_default()).to_lowercase())
        .unwrap_or_default();
    let mut score = terms
        .iter()
        .filter(|t| title.contains(*t) || about.contains(*t))
        .count()
        * 20;
    let mut best: Option<(usize, &Entry, usize)> = None;
    for entry in &thread.entries {
        let text = entry.text.to_lowercase();
        let found = terms.iter().filter(|t| text.contains(*t)).count();
        if found == 0 {
            continue;
        }
        let points = found * 10 + usize::from(terms.len() > 1 && text.contains(query)) * 5;
        if best.is_none_or(|(b, _, _)| points >= b) {
            let at = terms.iter().filter_map(|t| text.find(t)).min().unwrap_or(0);
            best = Some((points, entry, text[..at].chars().count()));
        }
    }
    let hit = best.map(|(points, entry, at)| {
        score += points;
        snippet(&entry.text, at, SNIPPET_CHARS)
    });
    (score, hit)
}

fn snippet(text: &str, center: usize, max: usize) -> String {
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let count = flat.chars().count();
    if count <= max {
        return flat;
    }
    let start = center.saturating_sub(max / 3).min(count - max);
    let body: String = flat.chars().skip(start).take(max).collect();
    format!(
        "{}{body}{}",
        if start > 0 { "…" } else { "" },
        if start + max < count { "…" } else { "" }
    )
}

#[cfg(test)]
mod tests;
