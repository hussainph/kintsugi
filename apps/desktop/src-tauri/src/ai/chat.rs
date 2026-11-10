//! Kin's conversations: many small threads per vault (KI-104).
//!
//! A thread is the one primitive behind the chat, paragraph comments,
//! Discuss and quick asks ([`threads`]). Nothing is inferred: a new ask
//! starts a new thread, about what he asked from (a document, a paragraph,
//! a Feed story, a clip, an idea, or nothing), unless he replies inside one.
//! Each thread is answered on its own:
//!
//! - **Bursts batch.** A turn starts once he has been quiet in a thread for
//!   [`Timing::batch`]; every message waiting in it by then is answered
//!   together.
//! - **Typing interrupts.** A keystroke in a thread (a `typing` ping) or a
//!   new message cancels that thread's running turn. Its partial reply stays,
//!   marked interrupted, and the messages it was answering wait for the next
//!   turn, which starts once he stops typing. Other threads carry on.
//! - **Context per thread.** A turn sends the model that thread's latest
//!   exchanges and what it's about, plus memory and the tools. Continuity
//!   across threads comes from memory and the `threads` tool, not from one
//!   long context.
//! - **Helpers.** Heavy or background work runs as helper jobs ([`jobs`]):
//!   one at a time, each its own agent with a brief and the memory snapshot,
//!   reporting back in the thread that asked for it, else in one of its own.
//! - **Switching vaults switches the threads.** The next access after a
//!   switch opens the new vault's threads, stops what was running, and tells
//!   the webview (`Switched`). A turn that finishes after the switch writes
//!   to the vault it started in.
//!
//! The engine knows nothing about Tauri: a [`Brain`] gives it models, the
//! vault, memory, the meter and somewhere to send events, so tests run it
//! against scripted models.

use super::Task;
use super::agent::{self, Cancel, Harness, KinEvent, Limits, Model, Stop};
use super::cost::Meter;
use super::jobs::{Job, NewJob, Status, Table, Trace};
use super::memory::Access;
use super::prompt::{Chip, Memory};
use super::threads::{
    self, Anchor, Draft, Entry, Filter, Listed, Meta, Moved, New, Role, Status as ThreadStatus,
    Store,
};
use super::tools::Tools;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tauri::async_runtime;

type Result<T> = std::result::Result<T, String>;

pub const MAX_MESSAGE_BYTES: usize = 20_000;
const MAX_CHIPS: usize = 12;

/// Everything the engine needs from the outside world.
pub trait Brain: Send + Sync + 'static {
    type Model: Model + 'static;
    /// The model for a task, with credentials resolved.
    fn connect(&self, task: Task) -> impl Future<Output = Result<Self::Model>> + Send;
    /// The model he picked for one thread of a vault (KI-61):
    /// `models.json` in that vault.
    fn picked(&self, vault: &Path, thread: &str) -> Option<super::picks::Pick> {
        super::picks::get(&self.kin_dir(vault)?, thread)
    }
    /// The model for a task, or `pick` while its provider is usable.
    fn connect_to(
        &self,
        task: Task,
        pick: Option<super::picks::Pick>,
    ) -> impl Future<Output = Result<Self::Model>> + Send {
        let _ = pick;
        self.connect(task)
    }
    fn vault(&self) -> Result<PathBuf>;
    /// Kin's folder in a vault, `.kintsugi/kin` (`None`: in memory).
    fn kin_dir(&self, vault: &Path) -> Option<PathBuf> {
        match threads::vault_dir(vault) {
            Ok(dir) => Some(dir),
            Err(error) => {
                eprintln!("kin: threads are kept in memory ({error})");
                None
            }
        }
    }
    /// Kin's memory snapshot for a vault (About you, notes, the skills index).
    fn memory(&self, vault: &Path) -> Memory;
    /// Lets a turn update memory and skills. Helper jobs get none.
    fn memory_access(&self, _vault: &Path, _turn: &str, _question: &str) -> Option<Access> {
        None
    }
    /// The app's search index for Kin's `search` tool (else a throwaway one).
    fn searcher(&self) -> Option<super::tools::Searcher> {
        None
    }
    /// Reads one of Kin's ideas for the `idea` tool (KI-39).
    fn ideas(&self) -> Option<super::tools::IdeaReader> {
        None
    }
    /// A helper job finished with a report. The owner of its kind can turn
    /// the report into something else (Ideas stores and checks its ideas)
    /// and returns what goes in the thread; an error fails the job.
    fn finish_job(&self, _job: &Job, report: String, _trace: &Trace) -> Result<String> {
        Ok(report)
    }
    /// The Feed, for `read feed:<id>` and the ranking tools.
    fn feed(&self) -> Option<super::tools::FeedTool> {
        None
    }
    /// `web_search` and `web_fetch` (KI-78), while they're on in Settings.
    fn web(&self) -> Option<Arc<super::web::Web>> {
        None
    }
    /// Background helpers get the web tools too (Settings › Web, KI-81).
    fn web_for_helpers(&self) -> bool {
        false
    }
    fn meter(&self) -> &Meter;
    fn emit(&self, event: ChatEvent);
    fn today(&self) -> String {
        chrono::Local::now().format("%Y-%m-%d").to_string()
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Timing {
    /// Quiet after a message before Kin answers; messages sent within it
    /// are one turn.
    pub batch: Duration,
    /// Quiet after a keystroke before waiting messages are answered.
    pub typing: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Timing {
            batch: Duration::from_millis(1_200),
            typing: Duration::from_millis(3_500),
        }
    }
}

/// What the webview hears, on the `kin:chat` event.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ChatEvent {
    /// A new message in a thread: his, Kin's, a helper's.
    Entry {
        entry: Entry,
    },
    /// A thread started or changed (title, status, anchor).
    Thread {
        thread: Meta,
    },
    /// Many threads changed at once (a document was renamed).
    Threads,
    /// Kin started answering these messages of a thread.
    TurnStarted {
        turn: String,
        thread: String,
        answers: Vec<u64>,
    },
    /// Streaming from a running turn (`thread` is empty for a review or a job).
    Turn {
        turn: String,
        thread: String,
        event: KinEvent,
    },
    TurnEnded {
        turn: String,
        thread: String,
    },
    /// Kin started or finished reviewing a document (KI-109). A finished
    /// review carries its suggestions, or an error, or that it was stopped.
    ReviewStarted {
        turn: String,
        path: String,
    },
    ReviewEnded {
        turn: String,
        path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        suggestions: Option<Vec<review::Suggestion>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        stopped: bool,
    },
    Job {
        job: Job,
    },
    /// Another vault was opened: its threads are the ones now.
    Switched,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningTurn {
    pub turn: String,
    pub thread: String,
    pub answers: Vec<u64>,
}

struct Running {
    info: RunningTurn,
    cancel: Cancel,
    /// Stopped by him (not interrupted by typing): its messages count as answered.
    stopped: bool,
}

#[derive(Default)]
struct ThreadLive {
    /// Bumped by every schedule; a timer that fires for an older one does nothing.
    generation: u64,
    running: Option<Running>,
    /// A turn was due while one was still finishing.
    want_turn: bool,
}

struct Reviewing {
    cancel: Cancel,
}

#[derive(Default)]
struct Live {
    threads: HashMap<String, ThreadLive>,
    /// Reviews running now, by document.
    reviews: HashMap<String, Reviewing>,
    job: Option<(String, Cancel)>,
}

struct Inner<B: Brain> {
    brain: B,
    /// The open vault's threads ([`Engine::store`] keeps it in step).
    store: Arc<Mutex<Store>>,
    /// The global log from before KI-59, moved into the first vault opened.
    old_log: Option<PathBuf>,
    migrated: AtomicBool,
    jobs: Mutex<Table>,
    live: Mutex<Live>,
    timing: Timing,
    turns: AtomicU64,
}

/// The live conversations. Cheap to clone.
pub struct Engine<B: Brain>(Arc<Inner<B>>);

impl<B: Brain> Clone for Engine<B> {
    fn clone(&self) -> Self {
        Engine(self.0.clone())
    }
}

/// One thread with its messages, for the Kin tab and the phone.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub thread: Meta,
    pub entries: Vec<Entry>,
    /// His messages still waiting for Kin.
    pub pending: Vec<u64>,
    pub running: Option<RunningTurn>,
}

/// A list of threads.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct List {
    pub threads: Vec<Listed>,
    /// Threads Kin is answering now.
    pub running: Vec<String>,
    /// Documents Kin is reviewing now.
    pub reviewing: Vec<String>,
}

/// What a message that starts a thread says about it.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Start {
    #[serde(default)]
    pub anchor: Option<Anchor>,
    /// `"chat"` (default), `"discuss"`, `"mention"` or `"ask"`.
    #[serde(default)]
    pub origin: Option<String>,
}

/// His message, and the thread it's in.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sent {
    pub thread: Meta,
    pub entry: Entry,
}

fn origin(origin: Option<&str>) -> String {
    match origin.map(str::trim) {
        Some(o @ ("discuss" | "mention" | "ask")) => o.into(),
        _ => "chat".into(),
    }
}

fn clean(text: &str) -> Result<&str> {
    let text = text.trim();
    if text.is_empty() {
        return Err("Say something to Kin.".into());
    }
    if text.len() > MAX_MESSAGE_BYTES {
        return Err("That message is too long.".into());
    }
    Ok(text)
}

fn clean_chips(chips: Vec<Chip>) -> Vec<Chip> {
    chips
        .into_iter()
        .filter(|c| !c.path.trim().is_empty())
        .take(MAX_CHIPS)
        .collect()
}

impl<B: Brain> Engine<B> {
    /// Opens the job table in `dir` (Kin's app data; `None`: in memory). The
    /// threads are the open vault's, opened on first use. Jobs a quit
    /// interrupted are queued again and start now.
    pub fn new(brain: B, dir: Option<PathBuf>, timing: Timing) -> Self {
        let engine = Engine(Arc::new(Inner {
            brain,
            store: Arc::new(Mutex::new(Store::open(None))),
            old_log: dir.as_ref().map(|d| d.join("conversation")),
            migrated: AtomicBool::new(false),
            jobs: Mutex::new(Table::open(dir)),
            live: Mutex::default(),
            timing,
            turns: AtomicU64::new(0),
        }));
        engine.kick_jobs();
        engine
    }

    fn emit(&self, event: ChatEvent) {
        self.0.brain.emit(event);
    }

    fn turn_id(&self, kind: &str) -> String {
        format!(
            "{kind}-{}-{}",
            std::process::id(),
            self.0.turns.fetch_add(1, Ordering::Relaxed) + 1
        )
    }

    // --- Which vault's threads --------------------------------------------

    /// The open vault's threads. After a vault switch this opens the new
    /// vault's first (and stops what was running in the old one).
    fn store(&self) -> MutexGuard<'_, Store> {
        // Asked before locking: the brain may open the vault, which tells us.
        let vault = self.0.brain.vault().ok();
        let mut store = self.0.store.lock().unwrap();
        if let Some(vault) = vault
            && store.vault() != Some(vault.as_path())
        {
            let first = store.vault().is_none();
            *store = self.open_store(&vault);
            if !first {
                // Not under the store's lock: the lock order is live, then store.
                let engine = self.clone();
                async_runtime::spawn(async move { engine.switched() });
            }
        }
        store
    }

    /// Opens a vault's threads. The first vault opened adopts the global log
    /// from before KI-59; a vault's old log and comments become threads.
    fn open_store(&self, vault: &Path) -> Store {
        let kin = self.0.brain.kin_dir(vault);
        if let (Some(old), Some(kin)) = (&self.0.old_log, &kin)
            && !self.0.migrated.swap(true, Ordering::SeqCst)
        {
            match threads::global::migrate(old, kin) {
                Ok(threads::global::Migrated::Nothing) => {}
                Ok(moved) => eprintln!(
                    "kin: the conversation moved into {} ({moved:?})",
                    kin.display()
                ),
                Err(error) => eprintln!("kin: {error}"),
            }
        }
        if let Some(kin) = &kin {
            match threads::migrate::migrate(kin, vault) {
                Ok(threads::migrate::Migrated::Nothing) => {}
                Ok(moved) => eprintln!("kin: the conversation is threads now ({moved:?})"),
                // The old files stay as they are; the next open tries again.
                Err(error) => eprintln!("kin: {error}"),
            }
        }
        Store::open_for(vault, kin.map(|k| k.join(threads::FOLDER)))
    }

    /// Runs `f` on `vault`'s threads: the live ones if that vault is still
    /// open, else its threads on disk. True when it was the live one (so the
    /// webview should hear about it).
    fn in_store<T>(&self, vault: Option<&Path>, f: impl FnOnce(&mut Store) -> T) -> (T, bool) {
        let mut store = self.0.store.lock().unwrap();
        if store.vault() == vault {
            return (f(&mut store), true);
        }
        drop(store);
        let mut other = match vault {
            Some(vault) => Store::open_for(
                vault,
                self.0.brain.kin_dir(vault).map(|k| k.join(threads::FOLDER)),
            ),
            None => Store::open(None),
        };
        (f(&mut other), false)
    }

    /// Another vault's threads are open: nothing of the old ones keeps running.
    fn switched(&self) {
        let mut live = self.0.live.lock().unwrap();
        for thread in live.threads.values_mut() {
            thread.generation += 1;
            thread.want_turn = false;
            if let Some(running) = thread.running.as_mut() {
                running.stopped = true;
                running.cancel.cancel();
            }
        }
        for review in live.reviews.values() {
            review.cancel.cancel();
        }
        drop(live);
        self.emit(ChatEvent::Switched);
    }

    /// The vault may have changed: switch now rather than on next use.
    pub fn follow_vault(&self) {
        drop(self.store());
    }

    // --- Threads ----------------------------------------------------------

    /// He said something: in `thread`, or (`None`) in a new thread about
    /// `start.anchor`. It's on disk before this returns; Kin answers once he
    /// pauses.
    pub fn send(
        &self,
        thread: Option<&str>,
        text: &str,
        chips: Vec<Chip>,
        start: Start,
    ) -> Result<Sent> {
        let text = clean(text)?;
        let chips = clean_chips(chips);
        let (meta, entry, changed) = {
            let mut store = self.store();
            match thread {
                Some(id) => {
                    let reopen = store.meta(id).ok_or("That thread is gone.")?.status
                        == ThreadStatus::Resolved;
                    if reopen {
                        store.set_status(id, ThreadStatus::Open)?;
                    }
                    let entry = store.append(id, Role::Owner, Draft::said(text, chips))?;
                    (
                        store.meta(id).cloned().ok_or("That thread is gone.")?,
                        entry,
                        reopen,
                    )
                }
                None => {
                    let new = New {
                        anchor: start.anchor,
                        origin: origin(start.origin.as_deref()),
                        title: None,
                    };
                    let (meta, entry) = store.start(new, Role::Owner, Draft::said(text, chips))?;
                    // What he picked in the new thread's composer is this thread's now.
                    if let Some(kin) = store.vault().and_then(|v| self.0.brain.kin_dir(v)) {
                        let _ = super::picks::hand_over(&kin, &meta.id);
                    }
                    (meta, entry, true)
                }
            }
        };
        if changed {
            self.emit(ChatEvent::Thread {
                thread: meta.clone(),
            });
        }
        self.emit(ChatEvent::Entry {
            entry: entry.clone(),
        });
        self.interrupt(&meta.id);
        self.schedule(&meta.id, self.0.timing.batch);
        Ok(Sent {
            thread: meta,
            entry,
        })
    }

    /// He's typing in a thread: Kin stops talking there and waits for him.
    pub fn typing(&self, thread: &str) {
        let interrupted = self.interrupt(thread);
        if interrupted || !self.store().pending(thread).is_empty() {
            self.schedule(thread, self.0.timing.typing);
        }
    }

    /// The stop button: end the thread's running turn, and don't answer
    /// what's waiting in it.
    pub fn stop(&self, thread: &str) {
        let mut live = self.0.live.lock().unwrap();
        let state = live.threads.entry(thread.into()).or_default();
        state.generation += 1;
        state.want_turn = false;
        if let Some(running) = state.running.as_mut() {
            running.stopped = true;
            running.cancel.cancel();
        }
        drop(live);
        let mut store = self.store();
        if let Some(last) = store.pending(thread).last() {
            let seq = last.seq;
            store.mark_answered(thread, seq);
        }
    }

    /// Stops every thread's running turn (a phone from before threads).
    pub fn stop_all(&self) {
        let running: Vec<String> = self.running().into_iter().map(|r| r.thread).collect();
        for thread in running {
            self.stop(&thread);
        }
    }

    /// The latest messages of every thread, newest last, for a phone app
    /// from before threads (phone API 6's one conversation). `before` was a
    /// position in the one log; threads number their own messages, so it's
    /// ignored and the newest page comes back.
    pub fn recent(&self, _before: Option<u64>, limit: usize) -> Value {
        let mut entries = self.store().recent(limit.clamp(1, 500));
        entries.reverse();
        serde_json::json!({ "entries": entries, "threads": [], "pending": [], "running": null })
    }

    /// Ask again (after a failed, stopped or missing reply): answers what's
    /// waiting, else his last message once more.
    pub fn again(&self, thread: &str) -> Result<Option<Entry>> {
        let entry = {
            let mut store = self.store();
            store.meta(thread).ok_or("That thread is gone.")?;
            if store.pending(thread).is_empty() {
                let Some(last) = store.last_said(thread) else {
                    return Ok(None);
                };
                Some(store.append(thread, Role::Owner, Draft::said(&last.text, last.chips))?)
            } else {
                None
            }
        };
        if let Some(entry) = &entry {
            self.emit(ChatEvent::Entry {
                entry: entry.clone(),
            });
        }
        self.interrupt(thread);
        self.schedule(thread, Duration::ZERO);
        Ok(entry)
    }

    /// Cancels the thread's running turn, if any; true if there was one.
    fn interrupt(&self, thread: &str) -> bool {
        let live = self.0.live.lock().unwrap();
        match live.threads.get(thread).and_then(|t| t.running.as_ref()) {
            Some(running) if !running.stopped => {
                running.cancel.cancel();
                true
            }
            _ => false,
        }
    }

    fn schedule(&self, thread: &str, delay: Duration) {
        let generation = {
            let mut live = self.0.live.lock().unwrap();
            let state = live.threads.entry(thread.into()).or_default();
            state.generation += 1;
            state.generation
        };
        let engine = self.clone();
        let thread = thread.to_string();
        async_runtime::spawn(async move {
            tokio::time::sleep(delay).await;
            engine.fire(&thread, generation);
        });
    }

    fn fire(&self, thread: &str, generation: u64) {
        let mut live = self.0.live.lock().unwrap();
        let Some(state) = live.threads.get_mut(thread) else {
            return;
        };
        if state.generation != generation {
            return;
        }
        if state.running.is_some() {
            state.want_turn = true;
            return;
        }
        self.start_turn(&mut live, thread);
    }

    /// Starts a turn for everything waiting in a thread. Called with `live` held.
    fn start_turn(&self, live: &mut Live, thread: &str) {
        let state = live.threads.entry(thread.into()).or_default();
        state.want_turn = false;
        let (pending, meta, vault) = {
            let store = self.store();
            (
                store.pending(thread),
                store.meta(thread).cloned(),
                store.vault().map(Path::to_path_buf),
            )
        };
        let (Some(meta), false) = (meta, pending.is_empty()) else {
            return;
        };
        let info = RunningTurn {
            turn: self.turn_id("turn"),
            thread: thread.into(),
            answers: pending.iter().map(|e| e.seq).collect(),
        };
        let cancel = Cancel::default();
        state.running = Some(Running {
            info: info.clone(),
            cancel: cancel.clone(),
            stopped: false,
        });
        self.emit(ChatEvent::TurnStarted {
            turn: info.turn.clone(),
            thread: info.thread.clone(),
            answers: info.answers.clone(),
        });
        let engine = self.clone();
        async_runtime::spawn(
            async move { engine.answer(info, meta, pending, vault, cancel).await },
        );
    }

    async fn answer(
        &self,
        info: RunningTurn,
        meta: Meta,
        pending: Vec<Entry>,
        vault: Option<PathBuf>,
        cancel: Cancel,
    ) {
        let history = self.store().context(&info.thread, threads::HISTORY_PAIRS);
        let said = pending
            .iter()
            .map(|e| e.text.as_str())
            .collect::<Vec<_>>()
            .join("\n\n");
        // The newest message's chips first; the same chip once; then what
        // the thread is about.
        let mut chips: Vec<Chip> = Vec::new();
        let mut anchor_chips: Vec<Chip> =
            meta.anchor.as_ref().map(Anchor::chip).into_iter().collect();
        if let Some(anchor) = meta.anchor.as_ref().filter(|a| a.kind == "paragraph") {
            anchor_chips.push(Chip {
                kind: "doc".into(),
                path: anchor.path.clone(),
                label: None,
                lines: None,
            });
        }
        for chip in pending
            .iter()
            .rev()
            .flat_map(|e| e.chips.iter())
            .chain(anchor_chips.iter())
        {
            if !chips
                .iter()
                .any(|c| c.kind == chip.kind && c.path == chip.path && c.lines == chip.lines)
            {
                chips.push(chip.clone());
            }
        }
        chips.truncate(MAX_CHIPS);
        let paragraph = meta
            .anchor
            .as_ref()
            .filter(|a| a.kind == "paragraph")
            .map(|a| review::note(&a.path, &chips));
        let question = match paragraph {
            Some(note) => format!("{said}\n\n{note}"),
            None => said,
        };
        let request = agent::Turn {
            task: Task::Chat,
            background: false,
            question,
            chips,
            today: self.0.brain.today(),
            remember: true,
            history,
            about: meta.anchor.as_ref().map(Anchor::describe),
            anchor: meta.anchor.clone(),
        };
        // The model he picked for this thread, in the vault the turn started in (KI-61).
        let pick = vault
            .as_deref()
            .and_then(|vault| self.0.brain.picked(vault, &info.thread));
        let (streamed, result, trace) = self
            .execute(&info.turn, &info.thread, &request, &cancel, true, pick)
            .await;

        let stopped = self
            .0
            .live
            .lock()
            .unwrap()
            .threads
            .get(&info.thread)
            .and_then(|t| t.running.as_ref())
            .is_some_and(|r| r.stopped);
        let through = info.answers.last().copied().unwrap_or_default();
        let base = Draft {
            replay: result.as_ref().ok().map(|summary| summary.replay.clone()),
            answers: info.answers.clone(),
            web: trace.web,
            tools: trace.uses.into_iter().map(|(_, used)| used).collect(),
            ms: Some(trace.millis),
            model: Some(trace.model).filter(|m| !m.is_empty()),
            ..Draft::default()
        };
        let (draft, settled) = match result {
            Ok(summary) if summary.stop == Stop::Cancelled => (
                Some(Draft {
                    text: streamed.trim().into(),
                    interrupted: true,
                    ..base
                })
                .filter(|d| !d.text.is_empty()),
                stopped,
            ),
            Ok(summary) => {
                let text = if summary.text.trim().is_empty() {
                    "I ran out of steps before I could answer. Ask again, more narrowly?".into()
                } else {
                    summary.text
                };
                (
                    Some(Draft {
                        text,
                        usd: Some(summary.usd),
                        cap_reached: summary.cap_reached,
                        ..base
                    }),
                    true,
                )
            }
            Err(message) => (
                Some(Draft {
                    error: Some(message),
                    ..base
                }),
                true,
            ),
        };
        // Into the vault the turn started in, even after a switch.
        let (entry, live) = self.in_store(vault.as_deref(), |store| {
            let entry = draft.and_then(|draft| store.append(&info.thread, Role::Kin, draft).ok());
            if settled {
                store.mark_answered(&info.thread, through);
            }
            entry
        });
        if let Some(entry) = entry.filter(|_| live) {
            self.emit(ChatEvent::Entry { entry });
        }
        self.emit(ChatEvent::TurnEnded {
            turn: info.turn.clone(),
            thread: info.thread.clone(),
        });

        let mut live = self.0.live.lock().unwrap();
        let again = live.threads.get_mut(&info.thread).is_some_and(|t| {
            t.running = None;
            t.want_turn
        });
        if again {
            self.start_turn(&mut live, &info.thread);
        }
    }

    /// Runs one agent turn, streaming to the webview. Returns what was
    /// streamed of the current step (the partial reply, if interrupted).
    async fn execute(
        &self,
        turn: &str,
        thread: &str,
        request: &agent::Turn,
        cancel: &Cancel,
        chat: bool,
        pick: Option<super::picks::Pick>,
    ) -> (String, Result<agent::Summary>, Trace) {
        let mut streamed = String::new();
        let mut trace = Trace::default();
        let started = std::time::Instant::now();
        let result = async {
            let vault = self.0.brain.vault()?;
            let model = self.0.brain.connect_to(request.task, pick).await?;
            let meter = self.0.brain.meter();
            let store = self.0.store.clone();
            let current = Some(thread.to_string()).filter(|t| !t.is_empty());
            let threads_tool: super::tools::ThreadsTool =
                Arc::new(move |args: &Value| store.lock().unwrap().tool(args, current.as_deref()));
            let mut tools =
                Tools::new(&vault, meter.outputs_dir(), turn)?.with_threads(threads_tool);
            if let Some(searcher) = self.0.brain.searcher() {
                tools = tools.with_searcher(searcher);
            }
            if let Some(ideas) = self.0.brain.ideas() {
                tools = tools.with_ideas(ideas);
            }
            if let Some(feed) = self.0.brain.feed() {
                tools = tools.with_feed(feed);
            }
            // Helpers run unattended: web tools only while he allows it (KI-81).
            if (chat || self.0.brain.web_for_helpers())
                && let Some(web) = self.0.brain.web()
            {
                tools = tools.with_web(web);
            }
            if chat
                && let Some(access) = self.0.brain.memory_access(&vault, turn, &request.question)
            {
                tools = tools.with_memory(access);
            }
            let memory = self.0.brain.memory(&vault);
            // A helper's report (a batch of ideas) is long; give it room.
            let limits = if chat {
                Limits::default()
            } else {
                Limits::report()
            };
            let harness = Harness {
                tools: &tools,
                meter,
                memory: &memory,
                cancel,
                limits,
            };
            let mut emit = |event: KinEvent| {
                match &event {
                    KinEvent::Text { delta } => streamed.push_str(delta),
                    KinEvent::Step {
                        step,
                        usage,
                        stop_reason,
                        text_chars,
                        ..
                    } => trace.step(*step, stop_reason.as_deref(), *text_chars, usage.output),
                    // Text before a tool call was thinking aloud.
                    KinEvent::ToolCall {
                        id,
                        name,
                        arguments,
                    } => {
                        streamed.clear();
                        trace.call(name, arguments);
                        if trace.uses.len() < threads::MAX_TOOLS_PER_REPLY {
                            trace
                                .uses
                                .push((id.clone(), threads::ToolUse::new(name, arguments)));
                        }
                    }
                    KinEvent::ToolResult {
                        id, is_error, web, ..
                    } => {
                        if *is_error
                            && let Some((_, used)) = trace.uses.iter_mut().find(|(i, _)| i == id)
                        {
                            used.error = true;
                        }
                        if let Some(call) = web
                            && trace.web.len() < super::web::MAX_CALLS_PER_REPLY
                        {
                            trace.web.push(call.clone());
                        }
                    }
                    _ => {}
                }
                self.emit(ChatEvent::Turn {
                    turn: turn.into(),
                    thread: thread.into(),
                    event,
                });
            };
            // The loop emits its own error event.
            agent::run(&model, &harness, request, &mut emit).await
        }
        .await;
        if let Err(message) = &result {
            self.emit(ChatEvent::Turn {
                turn: turn.into(),
                thread: thread.into(),
                event: KinEvent::Error {
                    message: message.clone(),
                },
            });
        }
        trace.millis = started.elapsed().as_millis() as u64;
        if let Ok(summary) = &result {
            trace.usd = summary.usd;
            trace.model = summary.model.clone();
        }
        (streamed, result, trace)
    }

    fn running(&self) -> Vec<RunningTurn> {
        self.0
            .live
            .lock()
            .unwrap()
            .threads
            .values()
            .filter_map(|t| t.running.as_ref().map(|r| r.info.clone()))
            .collect()
    }

    /// Threads, newest first (best matches first for a search).
    pub fn list(&self, filter: &Filter) -> List {
        // Lock order: live, then store.
        let running: Vec<String> = self.running().into_iter().map(|r| r.thread).collect();
        let reviewing = self
            .0
            .live
            .lock()
            .unwrap()
            .reviews
            .keys()
            .cloned()
            .collect();
        List {
            threads: self.store().list(filter),
            running,
            reviewing,
        }
    }

    /// One thread with its messages.
    pub fn thread(&self, id: &str) -> Result<View> {
        let running = self.running().into_iter().find(|r| r.thread == id);
        let store = self.store();
        let thread = store.get(id).ok_or("That thread is gone.")?;
        Ok(View {
            thread: thread.meta.clone(),
            entries: thread.entries.clone(),
            pending: store.pending(id).iter().map(|e| e.seq).collect(),
            running,
        })
    }

    pub fn set_status(&self, id: &str, status: ThreadStatus) -> Result<Meta> {
        let meta = self.store().set_status(id, status)?;
        self.emit(ChatEvent::Thread {
            thread: meta.clone(),
        });
        Ok(meta)
    }

    pub fn set_title(&self, id: &str, title: &str) -> Result<Meta> {
        let meta = self.store().set_title(id, title)?;
        self.emit(ChatEvent::Thread {
            thread: meta.clone(),
        });
        Ok(meta)
    }

    /// Paragraph anchors the editor re-resolved after edits (or found gone).
    pub fn moved(&self, doc: &str, moves: Vec<Moved>) -> Result<()> {
        self.store().moved(doc, moves).map(drop)
    }

    /// A document or folder was renamed or moved: its threads follow.
    pub fn renamed(&self, vault: &Path, from: &str, to: &str) {
        let (changed, live) = self.in_store(Some(vault), |store| store.renamed(from, to));
        if live && changed.unwrap_or(false) {
            self.emit(ChatEvent::Threads);
        }
    }

    // --- Helper jobs ------------------------------------------------------

    pub fn create_job(&self, new: NewJob) -> Result<Job> {
        let task = match new.task.as_deref() {
            None => Task::Chat,
            Some(id) => Task::from_id(id)
                .filter(|t| Task::KIN.contains(t))
                .ok_or_else(|| format!("unknown Kin task {id}"))?,
        };
        let job = self.0.jobs.lock().unwrap().create(new, task.id())?;
        self.emit(ChatEvent::Job { job: job.clone() });
        self.kick_jobs();
        Ok(job)
    }

    pub fn jobs(&self) -> Vec<Job> {
        self.0.jobs.lock().unwrap().list()
    }

    pub fn cancel_job(&self, id: &str) -> Option<Job> {
        let live = self.0.live.lock().unwrap();
        if let Some((running, cancel)) = &live.job
            && running == id
        {
            cancel.cancel();
            return self.0.jobs.lock().unwrap().get(id).cloned();
        }
        drop(live);
        let job = self.0.jobs.lock().unwrap().update(id, |j| {
            if !j.status.finished() {
                j.status = Status::Cancelled;
            }
        })?;
        self.emit(ChatEvent::Job { job: job.clone() });
        Some(job)
    }

    /// Starts the next job if none is running. Waiting jobs (the cap) run
    /// again once spending allows: on a new job, a cap change, or the
    /// periodic check.
    pub fn kick_jobs(&self) {
        let mut live = self.0.live.lock().unwrap();
        if live.job.is_some() {
            return;
        }
        let allows = self.0.brain.meter().allows(true).is_ok();
        let mut jobs = self.0.jobs.lock().unwrap();
        let Some(next) = jobs.next(allows) else {
            return;
        };
        let Some(job) = jobs.start(&next.id) else {
            return;
        };
        drop(jobs);
        let cancel = Cancel::default();
        live.job = Some((job.id.clone(), cancel.clone()));
        drop(live);
        self.emit(ChatEvent::Job { job: job.clone() });
        let engine = self.clone();
        async_runtime::spawn(async move { engine.run_job(job, cancel).await });
    }

    async fn run_job(&self, job: Job, cancel: Cancel) {
        let vault = self.store().vault().map(Path::to_path_buf);
        let request = agent::Turn {
            task: Task::from_id(&job.task).unwrap_or(Task::Chat),
            background: true,
            question: brief(&job),
            chips: vec![],
            today: self.0.brain.today(),
            remember: true,
            history: vec![],
            about: None,
            anchor: None,
        };
        let (_, result, trace) = self
            .execute(&job.id, "", &request, &cancel, false, None)
            .await;
        let (status, text, error, usd) = match result {
            Ok(s) if s.stop == Stop::CapReached => (
                Status::Waiting,
                None,
                Some(super::cost::CapReached::MESSAGE.to_string()),
                s.usd,
            ),
            Ok(s) if s.stop == Stop::Cancelled => (Status::Cancelled, None, None, s.usd),
            Ok(s) if s.text.trim().is_empty() && s.stop == Stop::StepLimit => (
                Status::Failed,
                None,
                Some("The helper ran out of steps without a report.".into()),
                s.usd,
            ),
            Ok(s) if s.text.trim().is_empty() => {
                let why = match trace.steps.last().and_then(|t| t.stop.as_deref()) {
                    Some("length" | "max_tokens" | "max_output_tokens") => {
                        "it used its whole reply on thinking"
                    }
                    _ => "its reply was empty",
                };
                (
                    Status::Failed,
                    None,
                    Some(format!("The helper ended without a report: {why}.")),
                    s.usd,
                )
            }
            Ok(s) => match self.0.brain.finish_job(&job, s.text, &trace) {
                Ok(report) => (Status::Done, Some(report), None, s.usd),
                Err(e) => (Status::Failed, None, Some(e), s.usd),
            },
            Err(e) if e == super::cost::CapReached::MESSAGE => {
                (Status::Waiting, None, Some(e), 0.0)
            }
            Err(e) => (Status::Failed, None, Some(e), 0.0),
        };
        // The step trace, for working out why a helper failed: tool names,
        // stop reasons and token counts only.
        eprintln!(
            "kin: helper {} ({}) {:?}: {}",
            job.id,
            job.kind,
            status,
            trace.line()
        );
        self.0
            .jobs
            .lock()
            .unwrap()
            .update(&job.id, |j| j.steps = trace.steps.clone());
        // Report back quietly, before the job reads as finished: in the
        // thread that asked, else in a thread of its own.
        if matches!(status, Status::Done | Status::Failed) {
            let report = text.clone().unwrap_or_else(|| {
                format!("I couldn't finish: {}", error.clone().unwrap_or_default())
            });
            let draft = Draft {
                text: report,
                job: Some(job.id.clone()),
                usd: Some(job.usd + usd),
                ..Draft::default()
            };
            let (reported, live) = self.in_store(vault.as_deref(), |store| {
                match job.thread.as_deref().filter(|t| store.contains(t)) {
                    Some(thread) => store
                        .append(thread, Role::Helper, draft)
                        .map(|entry| (None, entry)),
                    None => {
                        let anchor = Some(job.about.trim())
                            .filter(|p| p.ends_with(".md") || p.ends_with(".mdx"))
                            .map(Anchor::doc)
                            .and_then(|a| a.checked().ok());
                        let new = New {
                            anchor,
                            origin: "helper".into(),
                            title: Some(helper_title(&job, &draft.text)),
                        };
                        store
                            .start(new, Role::Helper, draft)
                            .map(|(meta, entry)| (Some(meta), entry))
                    }
                }
            });
            if live && let Ok((meta, entry)) = reported {
                if let Some(thread) = meta {
                    self.emit(ChatEvent::Thread { thread });
                }
                self.emit(ChatEvent::Entry { entry });
            }
        }
        let finished = self
            .0
            .jobs
            .lock()
            .unwrap()
            .finish(&job.id, status, text, error, usd);
        if let Some(finished) = finished {
            self.emit(ChatEvent::Job { job: finished });
        }
        self.0.live.lock().unwrap().job = None;
        // A waiting job stays put until spending allows; others go on.
        if status != Status::Waiting {
            self.kick_jobs();
        }
    }
}

/// A helper's own thread is named for what it did.
fn helper_title(job: &Job, report: &str) -> String {
    match job.kind.as_str() {
        "ideas" => "New ideas".into(),
        "ideas-refine" => "A refined idea".into(),
        _ => threads::title_from(report),
    }
}

/// A helper's whole context besides the prefix: one clear brief.
fn brief(job: &Job) -> String {
    format!(
        "You're working as one of Kin's helpers, in the background, with your own context. Hussain isn't watching; \
         your report goes in a thread for him to read later.\n\nBrief ({}):\n{}\n\n\
         Work it through with your tools, then report back as the brief asks; if it doesn't say how, briefly: what you found, with paths. \
         Say plainly what you couldn't do.",
        job.kind, job.brief
    )
}

// --- Tauri ----------------------------------------------------------------

use super::kin::Connected;
use crate::AppHandle;
use std::sync::OnceLock;
use tauri::{Emitter, State};

pub struct AppBrain(AppHandle);

impl Brain for AppBrain {
    type Model = Connected;

    async fn connect(&self, task: Task) -> Result<Connected> {
        super::kin::connect(task).await
    }

    async fn connect_to(&self, task: Task, pick: Option<super::picks::Pick>) -> Result<Connected> {
        super::kin::connect_to(task, pick).await
    }

    fn vault(&self) -> Result<PathBuf> {
        crate::vault::current(&self.0)
    }

    fn memory(&self, vault: &Path) -> Memory {
        // KI-30's seam: USER.md, NOTES.md and the skills index, frozen per turn or job.
        super::about::snapshot(&self.0, vault).unwrap_or_default()
    }

    fn memory_access(&self, vault: &Path, turn: &str, question: &str) -> Option<Access> {
        let store = super::about::store(&self.0, vault).ok()?;
        Some(Access {
            store,
            source: super::memory::Source::chat(turn, question),
            remember: true,
        })
    }

    fn searcher(&self) -> Option<super::tools::Searcher> {
        Some(crate::search::searcher(&self.0))
    }

    fn ideas(&self) -> Option<super::tools::IdeaReader> {
        Some(super::ideas::reader(&self.0))
    }

    fn finish_job(&self, job: &Job, report: String, trace: &Trace) -> Result<String> {
        super::ideas::finish_job(&self.0, job, report, trace)
    }

    fn feed(&self) -> Option<super::tools::FeedTool> {
        Some(crate::feed::kin_hook(&self.0))
    }

    fn web(&self) -> Option<Arc<super::web::Web>> {
        super::web::for_turn(false)
    }

    fn web_for_helpers(&self) -> bool {
        super::web::store().helpers()
    }

    fn meter(&self) -> &Meter {
        super::meter()
    }

    fn emit(&self, event: ChatEvent) {
        let _ = self.0.emit("kin:chat", event);
    }
}

/// The open vault's threads, set up by `ai::init`.
#[derive(Default)]
pub struct Chat(OnceLock<Engine<AppBrain>>);

impl Chat {
    pub(crate) fn engine(&self) -> Result<&Engine<AppBrain>> {
        self.0.get().ok_or_else(|| "Kin isn't ready yet.".into())
    }
}

/// Opens the job table in Kin's data folder, starts any queued jobs, and
/// opens the threads of the vault that's open (or was last used), moving
/// old conversations into threads the first time.
pub fn init(app: &AppHandle) {
    use tauri::Manager;
    let engine = Engine::new(
        AppBrain(app.clone()),
        super::kin::data_dir(app),
        Timing::default(),
    );
    if app.state::<Chat>().0.set(engine.clone()).is_ok() {
        engine.follow_vault();
        // Waiting jobs resume when a new month (or a higher cap) allows.
        async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(300)).await;
                engine.kick_jobs();
            }
        });
    }
}

/// Another vault was opened: its threads are the ones now. Called by
/// `vault::open`, which may run under the engine's own locks (the first
/// `vault::current`), so the switch happens off this thread.
pub fn vault_changed(app: &AppHandle) {
    use tauri::Manager;
    if let Ok(engine) = app.state::<Chat>().engine() {
        let engine = engine.clone();
        async_runtime::spawn(async move { engine.follow_vault() });
    }
}

/// A document or folder was renamed or moved: its threads follow. Best effort.
pub fn renamed(app: &AppHandle, vault: &Path, from: &str, to: &str) {
    use tauri::Manager;
    if let Ok(engine) = app.state::<Chat>().engine() {
        engine.renamed(vault, from, to);
    }
}

/// After the cap changes, waiting jobs may run.
pub fn cap_changed(chat: &Chat) {
    if let Ok(engine) = chat.engine() {
        engine.kick_jobs();
    }
}

#[tauri::command]
pub fn kin_threads(chat: State<Chat>, filter: Option<Filter>) -> Result<List> {
    Ok(chat.engine()?.list(&filter.unwrap_or_default()))
}

#[tauri::command]
pub fn kin_thread(chat: State<Chat>, id: String) -> Result<View> {
    chat.engine()?.thread(&id)
}

/// His message: in `thread`, or in a new thread about `start.anchor`.
#[tauri::command]
pub fn kin_thread_send(
    chat: State<Chat>,
    thread: Option<String>,
    text: String,
    chips: Option<Vec<Chip>>,
    start: Option<Start>,
) -> Result<Sent> {
    chat.engine()?.send(
        thread.as_deref().filter(|t| !t.is_empty()),
        &text,
        chips.unwrap_or_default(),
        start.unwrap_or_default(),
    )
}

#[tauri::command]
pub fn kin_thread_typing(chat: State<Chat>, thread: String) -> Result<()> {
    chat.engine()?.typing(&thread);
    Ok(())
}

#[tauri::command]
pub fn kin_thread_stop(chat: State<Chat>, thread: String) -> Result<()> {
    chat.engine()?.stop(&thread);
    Ok(())
}

#[tauri::command]
pub fn kin_thread_again(chat: State<Chat>, thread: String) -> Result<Option<Entry>> {
    chat.engine()?.again(&thread)
}

#[tauri::command]
pub fn kin_thread_update(
    chat: State<Chat>,
    id: String,
    title: Option<String>,
    status: Option<ThreadStatus>,
) -> Result<Meta> {
    let engine = chat.engine()?;
    let mut meta = None;
    if let Some(title) = title {
        meta = Some(engine.set_title(&id, &title)?);
    }
    if let Some(status) = status {
        meta = Some(engine.set_status(&id, status)?);
    }
    match meta {
        Some(meta) => Ok(meta),
        None => engine.thread(&id).map(|v| v.thread),
    }
}

#[tauri::command]
pub fn kin_thread_moved(chat: State<Chat>, path: String, moves: Vec<Moved>) -> Result<()> {
    chat.engine()?.moved(&path, moves)
}

#[tauri::command]
pub fn kin_job_create(chat: State<Chat>, job: NewJob) -> Result<Job> {
    chat.engine()?.create_job(job)
}

#[tauri::command]
pub fn kin_jobs(chat: State<Chat>) -> Result<Vec<Job>> {
    Ok(chat.engine()?.jobs())
}

#[tauri::command]
pub fn kin_job_cancel(chat: State<Chat>, id: String) -> Result<Option<Job>> {
    Ok(chat.engine()?.cancel_job(&id))
}

pub mod review;
#[cfg(feature = "headless")]
pub(crate) use review::{COMMENT_NOTE, REVIEW_BRIEF};

#[cfg(test)]
mod tests;
