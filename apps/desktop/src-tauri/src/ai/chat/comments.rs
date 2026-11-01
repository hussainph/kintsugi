//! Comment threads in drafts (KI-38): `@Kin` in a paragraph, ⌘K's "Discuss
//! this paragraph" and "Kin, review this draft" leave mini chat threads
//! anchored to paragraphs, the way a reviewer does.
//!
//! - **One log.** A thread's messages are entries in the one conversation
//!   log, about the document (their topic) and tagged with the thread's id
//!   (`comment`), with the paragraph as a chip. The chat shows them in the
//!   document's thread; Kin finds them with `history`.
//! - **Their own turns.** A message in a thread is answered by a turn for
//!   that thread alone (its exchanges are the history), not by the chat. A
//!   new message in the same thread interrupts its running reply, and the
//!   next turn answers both, like the chat.
//! - **Outside the document.** Where each thread sits and whether it's
//!   resolved is in `.kintsugi/comments/` (`ai::comments`). Nothing here
//!   writes to a document: Kin never inserts prose unasked.

use super::*;
use crate::ai::comments::{self as store, Anchor, Moved, Status, Thread as Stored};
use serde::Deserialize;
use std::collections::HashMap;

/// Tells Kin a turn is a comment reply; also how the mock recognizes one.
pub const COMMENT_NOTE: &str = "(You're replying in a comment thread anchored to a paragraph";
/// The review's brief; also how the mock recognizes one.
pub const REVIEW_BRIEF: &str = "Review this draft as a critical reader";
const MAX_REVIEW_PARAGRAPHS: usize = 120;
const MAX_REMARKS: usize = 6;
const MAX_REMARK_CHARS: usize = 1_500;
pub const REVIEW_REQUEST: &str = "Kin, review this draft.";

/// Comment turns running now, by thread id (or `review:<doc>`).
#[derive(Default)]
pub(super) struct Live {
    running: HashMap<String, Run>,
}

struct Run {
    turn: String,
    path: String,
    comment: Option<String>,
    cancel: Cancel,
    /// A new message arrived: answer again once this turn has ended.
    again: bool,
}

/// A thread with its messages from the log.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    #[serde(flatten)]
    pub thread: Stored,
    pub entries: Vec<Entry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Running {
    pub turn: String,
    /// `None`: a review of the whole document.
    pub comment: Option<String>,
}

/// A document's threads, for the editor.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comments {
    pub path: String,
    pub threads: Vec<View>,
    pub running: Vec<Running>,
}

/// A paragraph offered to a review: where it is and how to anchor to it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Paragraph {
    pub anchor: Anchor,
    pub lines: [u32; 2],
}

fn review_key(doc: &str) -> String {
    format!("review:{doc}")
}

/// The chips a comment message carries: only the ones about this document,
/// and the document itself.
fn doc_chips(doc: &str, chips: Vec<Chip>) -> Vec<Chip> {
    let mut chips: Vec<Chip> = chips.into_iter().filter(|c| c.path.trim() == doc).take(MAX_CHIPS).collect();
    if !chips.iter().any(|c| c.kind == "doc") {
        chips.push(Chip { kind: "doc".into(), path: doc.into(), label: None, lines: None });
    }
    chips
}

fn note(doc: &str, chips: &[Chip]) -> String {
    let lines = chips.iter().find_map(|c| c.lines).map(|[a, b]| if a == b { format!(", line {a}") } else { format!(", lines {a}-{b}") }).unwrap_or_default();
    format!(
        "{COMMENT_NOTE} of {doc}{lines}: the paragraph chip below. Reply the way a reviewer does in the margin: brief and specific, \
         a few sentences. Never write or rewrite his prose, not even as an example: question, point, find. Name anything you found \
         as a [[path]] link so he can drag it into the draft.)"
    )
}

fn review_brief(doc: &str, label: &str, paragraphs: &[Paragraph]) -> String {
    let mut out = format!(
        "{REVIEW_BRIEF}: {doc} (\"{label}\"). Read it first with the read tool. Then pick the few paragraphs (at most five) that most \
         need a reviewer's note: an unclear claim, a missing source, a weak step in the argument, something his own writing or clips \
         contradict or support. Search his writing and clips where it helps, and name what you find as [[path]] links.\n\
         Never write or rewrite his prose, not even as an example: question, point, find.\n\
         Answer with only a JSON array between <comments> tags, one object per note: \
         <comments>[{{\"paragraph\": 2, \"comment\": \"…\"}}]</comments>. \"paragraph\" is a number from the list below.\n\nParagraphs:\n"
    );
    for (i, p) in paragraphs.iter().enumerate() {
        let flat: String = p.anchor.exact.split_whitespace().collect::<Vec<_>>().join(" ");
        let head: String = flat.chars().take(140).collect();
        let more = if flat.chars().count() > 140 { "…" } else { "" };
        let [a, b] = p.lines;
        out.push_str(&format!("¶{} (lines {a}-{b}): {}{more}\n", i + 1, head.replace("</data", "<\\/data")));
    }
    out
}

#[derive(Deserialize)]
struct Remark {
    paragraph: usize,
    comment: String,
}

/// The review's notes: paragraph index (from 0) and text. `None` if the
/// reply has no well-formed list.
fn remarks(text: &str, paragraphs: usize) -> Option<Vec<(usize, String)>> {
    let body = text.split("<comments>").nth(1)?.split("</comments>").next()?;
    let list: Vec<Remark> = serde_json::from_str(body.trim()).ok()?;
    let mut out: Vec<(usize, String)> = Vec::new();
    for remark in list {
        let comment = remark.comment.trim();
        if remark.paragraph == 0 || remark.paragraph > paragraphs || comment.is_empty() || out.iter().any(|(i, _)| *i == remark.paragraph - 1) {
            continue;
        }
        out.push((remark.paragraph - 1, comment.chars().take(MAX_REMARK_CHARS).collect()));
        if out.len() == MAX_REMARKS {
            break;
        }
    }
    Some(out)
}

impl<B: Brain> Engine<B> {
    fn topic_for(&self, doc: &str, chips: &[Chip]) -> Topic {
        let topic = self.0.log.lock().unwrap().infer("", chips, chrono::Local::now().fixed_offset());
        if topic.key == doc { topic } else { Topic { key: doc.into(), kind: "doc".into(), label: String::new() } }
    }

    /// A document's threads, each with its messages.
    pub fn comments(&self, doc: &str) -> Result<Comments> {
        let root = self.0.brain.vault()?;
        let live = self.0.comments.lock().unwrap();
        let file = store::load(&root, doc)?;
        let running = live
            .running
            .values()
            .filter(|r| r.path == file.path)
            .map(|r| Running { turn: r.turn.clone(), comment: r.comment.clone() })
            .collect();
        drop(live);
        let log = self.0.log.lock().unwrap();
        let threads = file.threads.into_iter().map(|thread| View { entries: log.comment_entries(&thread.id), thread }).collect();
        Ok(Comments { path: file.path, threads, running })
    }

    /// A new thread on a paragraph, with his first message; Kin replies.
    pub fn comment_create(&self, doc: &str, anchor: Anchor, origin: &str, text: &str, chips: Vec<Chip>) -> Result<View> {
        let text = text.trim();
        if text.is_empty() {
            return Err("Say something to Kin.".into());
        }
        if text.len() > MAX_MESSAGE_BYTES {
            return Err("That message is too long.".into());
        }
        let root = self.0.brain.vault()?;
        let thread = {
            let _live = self.0.comments.lock().unwrap();
            let mut file = store::load(&root, doc)?;
            let thread = file.add(anchor, origin)?;
            store::save(&root, &file)?;
            thread
        };
        let chips = doc_chips(doc.trim(), chips);
        let topic = self.topic_for(doc.trim(), &chips);
        let entry = self.0.log.lock().unwrap().say_in(&thread.id, text, chips, &topic)?;
        self.emit(ChatEvent::Entry { entry: entry.clone() });
        self.emit(ChatEvent::Comments { path: doc.trim().into() });
        self.comment_turn(doc.trim(), &thread.id);
        Ok(View { thread, entries: vec![entry] })
    }

    /// His reply in a thread; Kin answers. An empty reply asks Kin again
    /// (after a failed or stopped answer).
    pub fn comment_reply(&self, doc: &str, id: &str, text: &str, chips: Vec<Chip>) -> Result<Option<Entry>> {
        let doc = doc.trim();
        let root = self.0.brain.vault()?;
        store::load(&root, doc)?.get(id).ok_or("That comment thread is gone.")?;
        let text = text.trim();
        if text.len() > MAX_MESSAGE_BYTES {
            return Err("That message is too long.".into());
        }
        if text.is_empty() {
            let mut log = self.0.log.lock().unwrap();
            if log.comment_pending(id).is_empty() {
                // Ask the last question again.
                let Some(last) = log.comment_entries(id).into_iter().rev().find(|e| e.role == Role::Owner) else { return Ok(None) };
                let topic = Topic { key: doc.into(), kind: "doc".into(), label: String::new() };
                let entry = log.say_in(id, &last.text, last.chips.clone(), &topic)?;
                drop(log);
                self.emit(ChatEvent::Entry { entry: entry.clone() });
                self.comment_turn(doc, id);
                return Ok(Some(entry));
            }
            drop(log);
            self.comment_turn(doc, id);
            return Ok(None);
        }
        let chips = doc_chips(doc.trim(), chips);
        let topic = self.topic_for(doc, &chips);
        let entry = self.0.log.lock().unwrap().say_in(id, text, chips, &topic)?;
        self.emit(ChatEvent::Entry { entry: entry.clone() });
        self.comment_turn(doc, id);
        Ok(Some(entry))
    }

    pub fn comment_status(&self, doc: &str, id: &str, status: Status) -> Result<Stored> {
        let root = self.0.brain.vault()?;
        let thread = {
            let _live = self.0.comments.lock().unwrap();
            let mut file = store::load(&root, doc)?;
            let thread = file.set_status(id, status)?;
            store::save(&root, &file)?;
            thread
        };
        self.emit(ChatEvent::Comments { path: doc.trim().into() });
        Ok(thread)
    }

    /// Anchors the editor re-resolved after edits (or found gone).
    pub fn comment_moved(&self, doc: &str, moves: Vec<Moved>) -> Result<()> {
        let root = self.0.brain.vault()?;
        let _live = self.0.comments.lock().unwrap();
        let mut file = store::load(&root, doc)?;
        if file.moved(moves) {
            store::save(&root, &file)?;
        }
        Ok(())
    }

    /// Stops Kin replying in a thread (or reviewing, with `review:<doc>`'s doc and no id).
    pub fn comment_stop(&self, doc: &str, id: Option<&str>) {
        let key = id.map_or_else(|| review_key(doc.trim()), String::from);
        if let Some(run) = self.0.comments.lock().unwrap().running.get_mut(&key) {
            run.again = false;
            run.cancel.cancel();
        }
    }

    /// Answers what's waiting in a thread, or interrupts its running reply
    /// so the next one answers everything.
    fn comment_turn(&self, doc: &str, id: &str) {
        let mut live = self.0.comments.lock().unwrap();
        if let Some(run) = live.running.get_mut(id) {
            run.again = true;
            run.cancel.cancel();
            return;
        }
        let pending = self.0.log.lock().unwrap().comment_pending(id);
        if pending.is_empty() {
            return;
        }
        let turn = format!("comment-{}-{}", std::process::id(), self.0.turns.fetch_add(1, Ordering::Relaxed) + 1);
        let cancel = Cancel::default();
        live.running.insert(id.into(), Run { turn: turn.clone(), path: doc.into(), comment: Some(id.into()), cancel: cancel.clone(), again: false });
        drop(live);
        self.emit(ChatEvent::CommentStarted { turn: turn.clone(), path: doc.into(), comment: Some(id.into()) });
        let engine = self.clone();
        let (doc, id) = (doc.to_string(), id.to_string());
        async_runtime::spawn(async move { engine.answer_comment(doc, id, turn, pending, cancel).await });
    }

    async fn answer_comment(&self, doc: String, id: String, turn: String, pending: Vec<Entry>, cancel: Cancel) {
        let history = self.0.log.lock().unwrap().comment_context(&id, history::HISTORY_PAIRS);
        let chips = pending.last().map(|e| e.chips.clone()).unwrap_or_default();
        let said = pending.iter().map(|e| e.text.as_str()).collect::<Vec<_>>().join("\n\n");
        let request = agent::Turn {
            task: Task::Chat,
            background: false,
            question: format!("{said}\n\n{}", note(&doc, &chips)),
            chips,
            today: self.0.brain.today(),
            remember: true,
            history,
            recap: None,
        };
        let (streamed, result, _) = self.execute(&turn, &request, &cancel, true).await;
        let base = Draft { topic: doc.clone(), answers: pending.iter().map(|e| e.seq).collect(), comment: Some(id.clone()), ..Draft::default() };
        let draft = match result {
            Ok(summary) if summary.stop == Stop::Cancelled => Some(Draft { text: streamed.trim().into(), interrupted: true, ..base }).filter(|d| !d.text.is_empty()),
            Ok(summary) if summary.text.trim().is_empty() => Some(Draft { text: "I ran out of steps before I could answer. Ask again, more narrowly?".into(), usd: Some(summary.usd), ..base }),
            Ok(summary) => Some(Draft { text: summary.text, usd: Some(summary.usd), ..base }),
            Err(message) => Some(Draft { error: Some(message), ..base }),
        };
        if let Some(draft) = draft
            && let Ok(entry) = self.0.log.lock().unwrap().reply(Role::Kin, draft)
        {
            self.emit(ChatEvent::Entry { entry });
        }
        let again = self.0.comments.lock().unwrap().running.remove(&id).is_some_and(|r| r.again);
        self.emit(ChatEvent::CommentEnded { turn, path: doc.clone(), comment: Some(id.clone()) });
        if again {
            self.comment_turn(&doc, &id);
        }
    }

    /// "Kin, review this draft": one turn that reads the document and
    /// leaves a few comment threads on the paragraphs that need them.
    pub fn review(&self, doc: &str, paragraphs: Vec<Paragraph>, chips: Vec<Chip>) -> Result<Entry> {
        let doc = doc.trim();
        store::file_path(&self.0.brain.vault()?, doc)?;
        let paragraphs: Vec<Paragraph> = paragraphs.into_iter().filter(|p| !p.anchor.exact.trim().is_empty()).take(MAX_REVIEW_PARAGRAPHS).collect();
        if paragraphs.is_empty() {
            return Err("Write a paragraph or two first, then ask for a review.".into());
        }
        let key = review_key(doc);
        let mut live = self.0.comments.lock().unwrap();
        if live.running.contains_key(&key) {
            return Err("Kin is already reviewing this draft.".into());
        }
        let chips = doc_chips(doc, chips.into_iter().filter(|c| c.kind == "doc").collect());
        let topic = self.topic_for(doc, &chips);
        let draft = Draft { text: REVIEW_REQUEST.into(), chips: chips.clone(), topic: doc.into(), review: true, ..Draft::default() };
        let entry = self.0.log.lock().unwrap().say_draft(draft, &topic)?;
        let turn = format!("review-{}-{}", std::process::id(), self.0.turns.fetch_add(1, Ordering::Relaxed) + 1);
        let cancel = Cancel::default();
        live.running.insert(key.clone(), Run { turn: turn.clone(), path: doc.into(), comment: None, cancel: cancel.clone(), again: false });
        drop(live);
        self.emit(ChatEvent::Entry { entry: entry.clone() });
        self.emit(ChatEvent::CommentStarted { turn: turn.clone(), path: doc.into(), comment: None });
        let label = chips.iter().find_map(|c| c.label.clone()).unwrap_or_else(|| topic.label.clone());
        let engine = self.clone();
        let (doc, request_seq) = (doc.to_string(), entry.seq);
        async_runtime::spawn(async move { engine.answer_review(doc, label, paragraphs, chips, request_seq, turn, cancel).await });
        Ok(entry)
    }

    #[allow(clippy::too_many_arguments)]
    async fn answer_review(&self, doc: String, label: String, paragraphs: Vec<Paragraph>, chips: Vec<Chip>, request: u64, turn: String, cancel: Cancel) {
        let ask = agent::Turn {
            task: Task::Chat,
            background: false,
            question: review_brief(&doc, &label, &paragraphs),
            chips,
            today: self.0.brain.today(),
            remember: true,
            history: vec![],
            recap: None,
        };
        let (_, result, _) = self.execute(&turn, &ask, &cancel, true).await;
        let base = Draft { topic: doc.clone(), answers: vec![request], review: true, ..Draft::default() };
        let (note, comments) = match result {
            Ok(summary) if summary.stop == Stop::Cancelled => (Draft { text: "Review stopped.".into(), interrupted: true, ..base }, vec![]),
            Ok(summary) => match remarks(&summary.text, paragraphs.len()) {
                Some(found) if found.is_empty() => (Draft { text: "I read it through and have nothing worth a comment right now.".into(), usd: Some(summary.usd), ..base }, vec![]),
                Some(found) => {
                    let n = found.len();
                    let text = format!("I left {n} comment{} on {label}.", if n == 1 { "" } else { "s" });
                    (Draft { text, usd: Some(summary.usd), ..base }, found)
                }
                None => (Draft { error: Some("Kin's review didn't come back as comments. Ask again?".into()), usd: Some(summary.usd), ..base }, vec![]),
            },
            Err(message) => (Draft { error: Some(message), ..base }, vec![]),
        };
        let mut threads: Vec<(Stored, String)> = Vec::new();
        if !comments.is_empty()
            && let Ok(root) = self.0.brain.vault()
        {
            let _live = self.0.comments.lock().unwrap();
            if let Ok(mut file) = store::load(&root, &doc) {
                for (i, text) in comments {
                    if let Ok(thread) = file.add(paragraphs[i].anchor.clone(), "review") {
                        threads.push((thread, text));
                    }
                }
                if store::save(&root, &file).is_err() {
                    threads.clear();
                }
            }
        }
        {
            let mut log = self.0.log.lock().unwrap();
            for (thread, text) in &threads {
                let draft = Draft { text: text.clone(), topic: doc.clone(), answers: vec![request], comment: Some(thread.id.clone()), ..Draft::default() };
                if let Ok(entry) = log.reply(Role::Kin, draft) {
                    self.emit(ChatEvent::Entry { entry });
                }
            }
            if let Ok(entry) = log.reply(Role::Kin, note) {
                self.emit(ChatEvent::Entry { entry });
            }
        }
        self.0.comments.lock().unwrap().running.remove(&review_key(&doc));
        self.emit(ChatEvent::Comments { path: doc.clone() });
        self.emit(ChatEvent::CommentEnded { turn, path: doc, comment: None });
    }
}

// --- Tauri ----------------------------------------------------------------

#[tauri::command]
pub fn kin_comments(chat: State<Chat>, path: String) -> Result<Comments> {
    chat.engine()?.comments(&path)
}

#[tauri::command]
pub fn kin_comment_create(chat: State<Chat>, path: String, anchor: Anchor, origin: Option<String>, text: String, chips: Option<Vec<Chip>>) -> Result<View> {
    chat.engine()?.comment_create(&path, anchor, origin.as_deref().unwrap_or("mention"), &text, chips.unwrap_or_default())
}

#[tauri::command]
pub fn kin_comment_reply(chat: State<Chat>, path: String, id: String, text: String, chips: Option<Vec<Chip>>) -> Result<Option<Entry>> {
    chat.engine()?.comment_reply(&path, &id, &text, chips.unwrap_or_default())
}

#[tauri::command]
pub fn kin_comment_status(chat: State<Chat>, path: String, id: String, status: Status) -> Result<Stored> {
    chat.engine()?.comment_status(&path, &id, status)
}

#[tauri::command]
pub fn kin_comment_moved(chat: State<Chat>, path: String, moves: Vec<Moved>) -> Result<()> {
    chat.engine()?.comment_moved(&path, moves)
}

#[tauri::command]
pub fn kin_comment_stop(chat: State<Chat>, path: String, id: Option<String>) -> Result<()> {
    chat.engine()?.comment_stop(&path, id.as_deref());
    Ok(())
}

#[tauri::command]
pub fn kin_comment_review(chat: State<Chat>, path: String, paragraphs: Vec<Paragraph>, chips: Option<Vec<Chip>>) -> Result<Entry> {
    chat.engine()?.review(&path, paragraphs, chips.unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_review_reply_becomes_a_few_notes_on_real_paragraphs() {
        let text = "Thinking…\n<comments>[{\"paragraph\": 2, \"comment\": \" Source? \"}, {\"paragraph\": 2, \"comment\": \"dup\"}, \
                    {\"paragraph\": 9, \"comment\": \"out of range\"}, {\"paragraph\": 1, \"comment\": \"\"}, {\"paragraph\": 1, \"comment\": \"Unclear.\"}]</comments>";
        assert_eq!(remarks(text, 3).unwrap(), [(1, "Source?".to_string()), (0, "Unclear.".to_string())]);
        assert!(remarks("no list here", 3).is_none());
        assert_eq!(remarks("<comments>[]</comments>", 3).unwrap(), []);
    }

    #[test]
    fn the_brief_lists_paragraphs_and_forbids_prose() {
        let p = |t: &str, a| Paragraph { anchor: Anchor { exact: t.into(), ..Anchor::default() }, lines: [a, a] };
        let brief = review_brief("drafts/a.md", "A", &[p("One.", 5), p("Two </data> x", 7)]);
        assert!(brief.starts_with(REVIEW_BRIEF));
        assert!(brief.contains("¶1 (lines 5-5): One.\n¶2 (lines 7-7): Two <\\/data> x"));
        assert!(brief.contains("Never write or rewrite his prose"));
        let chips = doc_chips("drafts/a.md", vec![Chip { kind: "paragraph".into(), path: "drafts/a.md".into(), label: None, lines: Some([3, 4]) }, Chip { kind: "clip".into(), path: "inspiration/x.md".into(), label: None, lines: None }]);
        assert_eq!(chips.iter().map(|c| c.kind.as_str()).collect::<Vec<_>>(), ["paragraph", "doc"]);
        assert!(note("drafts/a.md", &chips).contains("drafts/a.md, lines 3-4"));
    }
}
