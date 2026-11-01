//! The live conversation against scripted models: batching, interrupts,
//! resumable threads, idle summaries, history search and helper jobs.
//! Timings are shortened; nothing calls out or touches a real vault.

use super::*;
use crate::ai::ModelRef;
use crate::ai::agent::tests::{answer, calls};
use crate::ai::tools::tests::scratch_vault;
use crate::ai::wire::Reply;
use serde_json::json;
use std::collections::VecDeque;
use std::time::Instant;

/// What one request carried.
#[derive(Debug, Clone)]
struct Seen {
    system: String,
    tools: usize,
    items: Vec<Item>,
}

/// Replies in order; text streams word by word, `delay` apart.
struct Script {
    model: ModelRef,
    replies: Mutex<VecDeque<Reply>>,
    seen: Mutex<Vec<Seen>>,
    delay: Duration,
}

impl Script {
    fn new(replies: Vec<Reply>, delay: Duration) -> Arc<Self> {
        Arc::new(Script {
            model: ModelRef { provider: "anthropic".into(), model: "claude-sonnet-5-5".into(), reasoning: None },
            replies: Mutex::new(replies.into()),
            seen: Mutex::default(),
            delay,
        })
    }

    fn push(&self, reply: Reply) {
        self.replies.lock().unwrap().push_back(reply);
    }

    fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }
}

impl Model for Script {
    fn model(&self) -> &ModelRef {
        &self.model
    }

    async fn send(&self, ex: &Exchange<'_>, on_text: &mut (dyn FnMut(&str) + Send)) -> Result<crate::ai::wire::Reply> {
        self.seen.lock().unwrap().push(Seen { system: ex.system.into(), tools: ex.tools.len(), items: ex.items.to_vec() });
        let reply = self.replies.lock().unwrap().pop_front().ok_or("the script ran out of replies")?;
        for word in reply.text.split_inclusive(' ') {
            on_text(word);
            tokio::time::sleep(self.delay).await;
        }
        Ok(reply)
    }
}

struct TestBrain {
    script: Arc<Script>,
    vault: PathBuf,
    meter: Meter,
    events: Arc<Mutex<Vec<ChatEvent>>>,
    /// Jobs the finish hook saw, with their traces.
    finished: Arc<Mutex<Vec<(String, Trace)>>>,
}

impl Brain for TestBrain {
    type Model = Arc<Script>;

    async fn connect(&self, _task: Task) -> Result<Arc<Script>> {
        Ok(self.script.clone())
    }

    fn vault(&self) -> Result<PathBuf> {
        Ok(self.vault.clone())
    }

    fn memory(&self, _vault: &Path) -> Memory {
        Memory { about: vec!["Likes short essays.".into()], notes: vec!["Drafts live in drafts/.".into()], skills: vec![] }
    }

    fn meter(&self) -> &Meter {
        &self.meter
    }

    fn finish_job(&self, job: &Job, report: String, trace: &Trace) -> Result<String> {
        self.finished.lock().unwrap().push((job.kind.clone(), trace.clone()));
        match job.kind.as_str() {
            "reject" => Err("Nothing passed the checks.".into()),
            "rewrite" => Ok(format!("Checked: {report}")),
            _ => Ok(report),
        }
    }

    fn emit(&self, event: ChatEvent) {
        self.events.lock().unwrap().push(event);
    }

    fn today(&self) -> String {
        "2026-11-02".into()
    }
}

struct Fixture {
    engine: Engine<TestBrain>,
    script: Arc<Script>,
    events: Arc<Mutex<Vec<ChatEvent>>>,
    _vault: tempfile::TempDir,
    _ledger: tempfile::TempDir,
}

const FAST: Timing = Timing {
    batch: Duration::from_millis(120),
    typing: Duration::from_millis(250),
    idle: Duration::from_secs(3600),
    summary_after: 4,
};

fn fixture_in(dir: Option<PathBuf>, replies: Vec<Reply>, delay: Duration, timing: Timing) -> Fixture {
    let vault = scratch_vault();
    let ledger = tempfile::tempdir().unwrap();
    let script = Script::new(replies, delay);
    let events: Arc<Mutex<Vec<ChatEvent>>> = Arc::default();
    let brain = TestBrain {
        script: script.clone(),
        vault: vault.path().into(),
        meter: Meter::with_clock(Some(ledger.path().into()), || "2026-11".into()),
        events: events.clone(),
        finished: Arc::default(),
    };
    let engine = Engine::new(brain, dir, timing);
    Fixture { engine, script, events, _vault: vault, _ledger: ledger }
}

fn fixture(replies: Vec<Reply>, delay: Duration) -> Fixture {
    fixture_in(None, replies, delay, FAST)
}

fn wait(what: &str, mut done: impl FnMut() -> bool) {
    let start = Instant::now();
    while !done() {
        assert!(start.elapsed() < Duration::from_secs(10), "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

impl Fixture {
    fn entries(&self) -> Vec<Entry> {
        self.engine.page(None, None, 500).entries
    }

    fn kin_replies(&self) -> Vec<Entry> {
        self.entries().into_iter().filter(|e| e.role == Role::Kin).collect()
    }

    fn wait_replies(&self, n: usize) -> Vec<Entry> {
        wait(&format!("{n} Kin replies"), || self.kin_replies().len() >= n);
        wait("the turn to end", || self.engine.page(None, None, 1).running.is_none());
        self.kin_replies()
    }

    fn events(&self) -> Vec<ChatEvent> {
        self.events.lock().unwrap().clone()
    }
}

fn last_user(seen: &Seen) -> String {
    match seen.items.last() {
        Some(Item::User(text)) => text.clone(),
        other => panic!("expected a user message last, got {other:?}"),
    }
}

fn doc(path: &str, label: &str) -> Chip {
    Chip { kind: "doc".into(), path: path.into(), label: Some(label.into()), lines: None }
}

#[test]
fn a_burst_of_messages_is_one_turn() {
    let f = fixture(vec![answer("Both, briefly.")], Duration::ZERO);
    let a = f.engine.send("Is the opening too slow?", vec![doc("drafts/tools.mdx", "Tools")]).unwrap();
    let b = f.engine.send("And is the title right?", vec![]).unwrap();
    assert!(f.engine.send("   ", vec![]).is_err());
    // Both are in the log at once, before Kin says anything.
    assert_eq!(f.engine.page(None, None, 10).pending, [a.seq, b.seq]);

    let replies = f.wait_replies(1);
    assert_eq!(replies[0].answers, [a.seq, b.seq]);
    assert_eq!(replies[0].text, "Both, briefly.");
    assert_eq!(replies[0].topic, "drafts/tools.mdx", "the second message stays on the draft");
    let seen = f.script.seen();
    assert_eq!(seen.len(), 1, "one turn, one request");
    let message = last_user(&seen[0]);
    assert!(message.starts_with("Is the opening too slow?\n\nAnd is the title right?\n\n<context>"), "{message}");
    assert!(message.contains("- doc drafts/tools.mdx (Tools)"), "chips go in the dynamic context: {message}");
    assert!(f.engine.page(None, None, 10).pending.is_empty());
    // The prefix carries the memory snapshot and the fixed tool list.
    assert!(seen[0].system.contains("- Likes short essays."));
    assert_eq!(seen[0].tools, crate::ai::tools::specs().len());
    let started: Vec<_> = f.events().into_iter().filter(|e| matches!(e, ChatEvent::TurnStarted { .. })).collect();
    assert_eq!(started.len(), 1);
}

#[test]
fn typing_interrupts_kin_and_the_next_turn_answers_everything_waiting() {
    let slow = answer("one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen");
    let f = fixture(vec![slow, answer("Answered both.")], Duration::from_millis(60));
    let first = f.engine.send("Tell me about kilns", vec![]).unwrap();
    // Wait until Kin is mid-sentence.
    wait("Kin to start talking", || {
        f.events().iter().any(|e| matches!(e, ChatEvent::Turn { event: KinEvent::Text { delta }, .. } if delta.starts_with("three")))
    });
    f.engine.typing();
    let replies = f.wait_replies(1);
    assert!(replies[0].interrupted);
    assert!(replies[0].text.starts_with("one two three"), "{}", replies[0].text);
    assert!(!replies[0].text.contains("sixteen"));
    // Still waiting: the interrupted message is answered with the next one.
    assert_eq!(f.engine.page(None, None, 10).pending, [first.seq]);
    let second = f.engine.send("Actually, only Japanese ones", vec![]).unwrap();
    let replies = f.wait_replies(2);
    assert_eq!(replies[1].answers, [first.seq, second.seq]);
    assert!(!replies[1].interrupted);
    let seen = f.script.seen();
    assert_eq!(seen.len(), 2);
    assert!(last_user(&seen[1]).starts_with("Tell me about kilns\n\nActually, only Japanese ones"));
    // The interrupted reply isn't sent back to the model as history.
    assert_eq!(seen[1].items.len(), 1);
}

#[test]
fn typing_without_sending_lets_waiting_messages_be_answered_after_a_pause() {
    let slow = answer("a b c d e f g h i j k l m n o p");
    let f = fixture(vec![slow, answer("Done.")], Duration::from_millis(60));
    f.engine.send("Question", vec![]).unwrap();
    wait("Kin to start", || f.events().iter().any(|e| matches!(e, ChatEvent::Turn { event: KinEvent::Text { .. }, .. })));
    f.engine.typing();
    let replies = f.wait_replies(2);
    assert!(replies[0].interrupted && !replies[1].interrupted);
    assert_eq!(replies[1].text, "Done.");
}

#[test]
fn stop_ends_the_turn_and_settles_its_messages() {
    let f = fixture(vec![answer("a b c d e f g h i j k l m n o p q r s t")], Duration::from_millis(60));
    f.engine.send("Question", vec![]).unwrap();
    wait("Kin to start", || f.events().iter().any(|e| matches!(e, ChatEvent::Turn { event: KinEvent::Text { .. }, .. })));
    f.engine.stop();
    let replies = f.wait_replies(1);
    assert!(replies[0].interrupted);
    assert!(f.engine.page(None, None, 10).pending.is_empty());
    std::thread::sleep(FAST.typing * 2);
    assert_eq!(f.script.seen().len(), 1, "no new turn after a stop");
}

#[test]
fn threads_resume_with_their_own_history() {
    let f = fixture(vec![answer("About the draft."), answer("About the clip."), answer("Back on the draft.")], Duration::ZERO);
    let draft = doc("drafts/x.md", "Draft X");
    f.engine.send("What's weak in this draft?", vec![draft.clone()]).unwrap();
    f.wait_replies(1);
    f.engine.send("Why did I keep this?", vec![Chip { kind: "clip".into(), path: "inspiration/clip-kiln.md".into(), label: None, lines: None }]).unwrap();
    f.wait_replies(2);
    // Back to draft X: the model sees that thread's exchange, not the clip's.
    f.engine.send("Did I fix it?", vec![draft]).unwrap();
    let replies = f.wait_replies(3);
    assert_eq!(replies[2].topic, "drafts/x.md");
    let seen = f.script.seen();
    let items = &seen[2].items;
    assert_eq!(items.len(), 3, "{items:?}");
    assert_eq!(items[0], Item::User("What's weak in this draft?".into()));
    assert_eq!(items[1], Item::Assistant { text: "About the draft.".into(), calls: vec![] });
    assert!(last_user(&seen[2]).starts_with("Did I fix it?"));
    // The prefix is the same for every thread: a cache hit.
    assert!(seen.windows(2).all(|w| w[0].system == w[1].system));
    let threads: Vec<String> = f.engine.page(None, None, 1).threads.into_iter().map(|t| t.key).collect();
    assert_eq!(threads, ["drafts/x.md", "inspiration/clip-kiln.md"]);
    assert_eq!(f.engine.page(Some("drafts/x.md"), None, 100).entries.len(), 4);
}

#[test]
fn summaries_are_made_while_idle_and_used_to_resume() {
    let timing = Timing { idle: Duration::from_millis(200), ..FAST };
    let f = fixture_in(None, vec![answer("One."), answer("Two.")], Duration::ZERO, timing);
    let draft = doc("drafts/x.md", "Draft X");
    f.engine.send("First", vec![draft.clone()]).unwrap();
    f.wait_replies(1);
    f.engine.send("Second", vec![draft.clone()]).unwrap();
    f.wait_replies(2);
    // Four entries in the thread; once idle, it's summarized.
    f.script.push(answer("Asked twice about draft X; Kin answered One and Two."));
    wait("an idle summary", || f.events().iter().any(|e| matches!(e, ChatEvent::Thread { .. })));
    let seen = f.script.seen();
    let request = seen.last().unwrap();
    assert!(request.system.starts_with(SUMMARIZER));
    assert_eq!(request.tools, 0);
    let Item::User(prompt) = &request.items[0] else { panic!() };
    assert!(prompt.contains("Hussain: First\nKin: One.\nHussain: Second\nKin: Two."), "{prompt}");
    let thread = f.engine.page(None, None, 1).threads.into_iter().find(|t| t.key == "drafts/x.md").unwrap();
    assert_eq!(thread.summary, "Asked twice about draft X; Kin answered One and Two.");
    assert_eq!(thread.summarized_through, 4);

    // Resuming sends the summary instead of the old exchanges.
    f.script.push(answer("Three."));
    f.engine.send("Third", vec![draft]).unwrap();
    f.wait_replies(3);
    let seen = f.script.seen();
    let last = seen.last().unwrap();
    assert_eq!(last.items.len(), 1);
    assert!(last_user(last).contains("Earlier in this conversation (your summary; search history for details):\nAsked twice"));
    // Nothing was deleted.
    assert_eq!(f.entries().len(), 6);
}

#[test]
fn summaries_wait_while_he_is_active() {
    let timing = Timing { idle: Duration::from_millis(300), summary_after: 2, ..FAST };
    let f = fixture_in(None, vec![answer("One.")], Duration::ZERO, timing);
    f.engine.send("First", vec![]).unwrap();
    f.wait_replies(1);
    // Keep typing: no summary while he's around.
    for _ in 0..6 {
        std::thread::sleep(Duration::from_millis(100));
        f.engine.typing();
    }
    assert_eq!(f.script.seen().len(), 1);
}

#[test]
fn kin_searches_its_history_with_a_tool() {
    let f = fixture(
        vec![
            answer("Noted."),
            calls(&[("c1", "tool", json!({ "name": "history", "args": { "query": "anagama" } }))], ""),
            answer("You asked about anagama kilns earlier."),
        ],
        Duration::ZERO,
    );
    f.engine.send("Remember the anagama kilns", vec![]).unwrap();
    f.wait_replies(1);
    f.engine.send("What did I ask before?", vec![]).unwrap();
    f.wait_replies(2);
    let seen = f.script.seen();
    let Some(Item::Results(results)) = seen[2].items.last() else { panic!("expected results") };
    assert!(results[0].content.contains("Hussain: Remember the anagama kilns"), "{}", results[0].content);
    assert!(results[0].content.starts_with("<data tool=\"tool\">"));
    assert_eq!(f.engine.search("anagama", None, 10).len(), 2);
}

#[test]
fn errors_are_logged_and_settle_the_turn() {
    let f = fixture(vec![], Duration::ZERO);
    f.engine.send("Hello?", vec![]).unwrap();
    let replies = f.wait_replies(1);
    assert_eq!(replies[0].error.as_deref(), Some("the script ran out of replies"));
    assert!(f.engine.page(None, None, 10).pending.is_empty());
}

#[test]
fn helper_jobs_run_in_the_background_and_report_quietly() {
    let f = fixture(
        vec![calls(&[("c1", "search", json!({ "query": "kiln" }))], ""), answer("Three kiln clips; ranked posts/kintsugi.md first.")],
        Duration::ZERO,
    );
    let job = f
        .engine
        .create_job(NewJob { kind: "feed-ranking".into(), task: Some("triage".into()), brief: "Rank today's kiln items.".into(), topic: Some("inspiration/clip-kiln.md".into()) })
        .unwrap();
    assert!(f.engine.create_job(NewJob { kind: "x".into(), task: Some("edit".into()), brief: "b".into(), topic: None }).is_err());
    wait("the job to finish", || f.engine.jobs()[0].status == Status::Done);
    let done = &f.engine.jobs()[0];
    assert_eq!(done.result.as_deref(), Some("Three kiln clips; ranked posts/kintsugi.md first."));
    // Its step trace is kept: tool names and stop reasons, no content.
    let steps: Vec<_> = done.steps.iter().map(|s| (s.step, s.tools.clone())).collect();
    assert_eq!(steps, [(1, vec!["search".to_string()]), (2, vec![])]);
    // Its own context: the brief and the memory snapshot, nothing of the chat.
    let seen = f.script.seen();
    assert!(seen[0].system.contains("Likes short essays.") && seen[0].system.contains("Drafts live in drafts/."));
    assert_eq!(seen[0].items.len(), 1);
    let brief = last_user(&seen[0]);
    assert!(brief.contains("Kin's helpers") && brief.contains("Brief (feed-ranking):\nRank today's kiln items."), "{brief}");
    // It reported back quietly, in the log, and nothing waits for Kin.
    let report = f.entries().into_iter().find(|e| e.role == Role::Helper).unwrap();
    assert_eq!((report.job.as_deref(), report.topic.as_str()), (Some(job.id.as_str()), "inspiration/clip-kiln.md"));
    assert!(f.engine.page(None, None, 10).pending.is_empty());
    assert!(f.events().iter().any(|e| matches!(e, ChatEvent::Job { job } if job.status == Status::Running)));
    // Its cost went on the ledger as the triage task.
    assert_eq!(f.engine.0.brain.meter.report().by_task[0].task, "triage");
}

#[test]
fn a_helper_that_never_reports_says_why() {
    let mut empty = answer("");
    empty.stop_reason = Some("length".into());
    let f = fixture(vec![empty.clone(), empty], Duration::ZERO);
    f.engine.create_job(NewJob { kind: "ideas".into(), task: Some("ideas".into()), brief: "Find ideas.".into(), topic: None }).unwrap();
    wait("the job to fail", || f.engine.jobs()[0].status == Status::Failed);
    let failed = &f.engine.jobs()[0];
    assert_eq!(failed.error.as_deref(), Some("The helper ended without a report: it used its whole reply on thinking."));
    assert_eq!(failed.steps.len(), 2, "asked once more before giving up");
    assert_eq!(failed.steps[1].stop.as_deref(), Some("length"));
}

#[test]
fn helper_jobs_wait_at_the_cap_and_resume_when_it_allows() {
    let f = fixture(vec![answer("Done after the cap rose.")], Duration::ZERO);
    f.engine.0.brain.meter.update_settings(|s| s.monthly_cap_usd = Some(0.0)).unwrap();
    f.engine.create_job(NewJob { kind: "ideas".into(), task: Some("ideas".into()), brief: "Find ideas.".into(), topic: None }).unwrap();
    wait("the job to wait", || f.engine.jobs()[0].status == Status::Waiting);
    assert!(f.script.seen().is_empty(), "no request over the cap");
    f.engine.kick_jobs();
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(f.engine.jobs()[0].status, Status::Waiting, "still capped");

    f.engine.0.brain.meter.update_settings(|s| s.monthly_cap_usd = Some(10.0)).unwrap();
    f.engine.kick_jobs();
    wait("the job to finish", || f.engine.jobs()[0].status == Status::Done);
    assert_eq!(f.engine.jobs()[0].attempts, 2);
}

#[test]
fn jobs_survive_quitting_and_resume_on_start() {
    let data = tempfile::tempdir().unwrap();
    {
        let mut table = Table::open(Some(data.path().into()));
        let job = table.create(NewJob { kind: "search".into(), task: None, brief: "Find every kiln.".into(), topic: None }, "chat").unwrap();
        table.start(&job.id).unwrap();
        // The app quits here, mid-job.
    }
    let f = fixture_in(Some(data.path().into()), vec![answer("Found two kilns.")], Duration::ZERO, FAST);
    wait("the resumed job to finish", || f.engine.jobs()[0].status == Status::Done);
    let job = &f.engine.jobs()[0];
    assert_eq!((job.attempts, job.result.as_deref()), (2, Some("Found two kilns.")));
    // The table and the conversation live in app data.
    assert!(data.path().join("jobs.json").is_file());
    assert!(data.path().join("conversation/log.jsonl").is_file());
}

#[test]
fn a_running_job_can_be_cancelled() {
    let f = fixture(vec![answer("a b c d e f g h i j k l m n o p q r s t u v w x y z")], Duration::from_millis(50));
    let job = f.engine.create_job(NewJob { kind: "ideas".into(), task: None, brief: "Long work.".into(), topic: None }).unwrap();
    wait("the job to start", || f.events().iter().any(|e| matches!(e, ChatEvent::Turn { event: KinEvent::Text { .. }, .. })));
    f.engine.cancel_job(&job.id);
    wait("the job to stop", || f.engine.jobs()[0].status == Status::Cancelled);
    assert!(f.entries().is_empty(), "a cancelled job doesn't report");
}

#[test]
fn a_finished_job_goes_through_its_owner_with_a_footprint() {
    let f = fixture(
        vec![
            calls(&[("c1", "search", json!({ "query": "kiln" })), ("c2", "read", json!({ "path": "posts/kintsugi.md" }))], ""),
            answer("[raw json]"),
            answer("[nothing good]"),
        ],
        Duration::ZERO,
    );
    f.engine.create_job(NewJob { kind: "rewrite".into(), task: Some("ideas".into()), brief: "Find ideas.".into(), topic: None }).unwrap();
    wait("the job to finish", || f.engine.jobs().first().is_some_and(|j| j.status == Status::Done));
    assert_eq!(f.engine.jobs()[0].result.as_deref(), Some("Checked: [raw json]"));
    let (kind, trace) = f.engine.0.brain.finished.lock().unwrap()[0].clone();
    assert_eq!((kind.as_str(), trace.searches.as_slice(), trace.files.as_slice(), trace.tool_calls), ("rewrite", &["kiln".to_string()][..], &["posts/kintsugi.md".to_string()][..], 2));
    assert_eq!(trace.model, "anthropic/claude-sonnet-5-5");
    // The owner can fail it; the log says so.
    f.engine.create_job(NewJob { kind: "reject".into(), task: Some("ideas".into()), brief: "Find more.".into(), topic: None }).unwrap();
    wait("the job to fail", || f.engine.jobs()[0].status == Status::Failed);
    assert_eq!(f.engine.jobs()[0].error.as_deref(), Some("Nothing passed the checks."));
    let report = f.entries().into_iter().rev().find(|e| e.role == Role::Helper).unwrap();
    assert!(report.text.contains("Nothing passed the checks."), "{}", report.text);
}

// --- Comment threads (KI-38) -------------------------------------------------

mod comment_threads {
    use super::*;
    use crate::ai::comments::{Anchor, Moved, Status};
    use crate::ai::chat::comments::Paragraph;

    fn pencil() -> Anchor {
        Anchor { exact: "A pencil is a tool for thinking.".into(), prefix: "---\n\n".into(), suffix: "\n".into(), line: 6 }
    }

    fn paragraph_chip() -> Chip {
        Chip { kind: "paragraph".into(), path: "drafts/tools.mdx".into(), label: Some("A pencil is a tool for thinking.".into()), lines: Some([6, 6]) }
    }

    fn vault(f: &Fixture) -> PathBuf {
        f.engine.0.brain.vault().unwrap()
    }

    fn settled(f: &Fixture) {
        wait("comment turns to end", || f.engine.comments("drafts/tools.mdx").unwrap().running.is_empty());
    }

    #[test]
    fn a_thread_is_rows_in_the_one_log_with_its_own_turns() {
        let f = fixture(vec![answer("Which kind of thinking? Compare [[posts/kintsugi]].")], Duration::ZERO);
        let before = std::fs::read_to_string(vault(&f).join("drafts/tools.mdx")).unwrap();
        let view = f.engine.comment_create("drafts/tools.mdx", pencil(), "mention", "Is this too obvious?", vec![paragraph_chip()]).unwrap();
        assert_eq!(view.thread.status, Status::Open);
        // Not the chat's to answer.
        assert!(f.engine.page(None, None, 10).pending.is_empty());
        wait("Kin's reply", || f.engine.comments("drafts/tools.mdx").unwrap().threads[0].entries.len() == 2);
        settled(&f);

        let page = f.engine.comments("drafts/tools.mdx").unwrap();
        let entries = &page.threads[0].entries;
        assert_eq!((entries[0].role, entries[1].role), (Role::Owner, Role::Kin));
        assert_eq!(entries[1].text, "Which kind of thinking? Compare [[posts/kintsugi]].");
        assert_eq!(entries[1].answers, [entries[0].seq]);
        for e in entries {
            assert_eq!(e.topic, "drafts/tools.mdx", "about the document");
            assert_eq!(e.comment.as_deref(), Some(view.thread.id.as_str()));
        }
        // The same rows are in the document's thread of the one log.
        assert_eq!(f.engine.page(Some("drafts/tools.mdx"), None, 10).entries.len(), 2);
        let seen = f.script.seen();
        let message = last_user(&seen[0]);
        assert!(message.starts_with("Is this too obvious?\n\n(You're replying in a comment thread"), "{message}");
        assert!(message.contains("- paragraph drafts/tools.mdx lines 6-6"), "{message}");
        assert!(message.contains("- doc drafts/tools.mdx"), "{message}");
        // Stored beside the document, never in it.
        assert_eq!(std::fs::read_to_string(vault(&f).join("drafts/tools.mdx")).unwrap(), before);
        assert!(vault(&f).join(".kintsugi/comments/drafts/tools.mdx.json").is_file());
        let started = f.events().iter().filter(|e| matches!(e, ChatEvent::CommentStarted { comment: Some(_), .. })).count();
        assert_eq!(started, 1);
        assert!(!f.events().iter().any(|e| matches!(e, ChatEvent::TurnStarted { .. })), "the chat's turn machinery isn't involved");
    }

    #[test]
    fn a_reply_resumes_the_thread_and_interrupts_a_running_answer() {
        let slow = answer("one two three four five six seven eight nine ten eleven twelve");
        let f = fixture(vec![answer("First thought."), slow, answer("Both, then.")], Duration::from_millis(40));
        let view = f.engine.comment_create("drafts/tools.mdx", pencil(), "discuss", "Is this too obvious?", vec![paragraph_chip()]).unwrap();
        let id = view.thread.id.clone();
        wait("the first reply", || f.engine.comments("drafts/tools.mdx").unwrap().threads[0].entries.len() == 2);
        settled(&f);
        f.engine.comment_reply("drafts/tools.mdx", &id, "Say more.", vec![paragraph_chip()]).unwrap();
        wait("Kin to start talking", || f.events().iter().any(|e| matches!(e, ChatEvent::Turn { event: KinEvent::Text { delta }, .. } if delta.starts_with("three"))));
        f.engine.comment_reply("drafts/tools.mdx", &id, "Actually, briefly.", vec![paragraph_chip()]).unwrap();
        wait("the final reply", || f.engine.comments("drafts/tools.mdx").unwrap().threads[0].entries.iter().any(|e| e.text == "Both, then."));
        settled(&f);
        let entries = f.engine.comments("drafts/tools.mdx").unwrap().threads[0].entries.clone();
        let interrupted: Vec<_> = entries.iter().filter(|e| e.interrupted).collect();
        assert_eq!(interrupted.len(), 1);
        let last = entries.last().unwrap();
        assert_eq!(last.answers.len(), 2, "answers both waiting messages");
        // The thread's own exchanges are its history.
        let seen = f.script.seen();
        let last_request = seen.last().unwrap();
        assert!(matches!(&last_request.items[1], Item::Assistant { text, .. } if text == "First thought."), "{:?}", last_request.items);
        assert!(f.engine.comment_reply("drafts/tools.mdx", "c-nope", "x", vec![]).is_err());
    }

    #[test]
    fn resolve_reopen_and_moved_anchors_persist() {
        let f = fixture(vec![answer("Noted.")], Duration::ZERO);
        let id = f.engine.comment_create("drafts/tools.mdx", pencil(), "mention", "Hm?", vec![]).unwrap().thread.id;
        settled(&f);
        f.engine.comment_status("drafts/tools.mdx", &id, Status::Resolved).unwrap();
        assert_eq!(f.engine.comments("drafts/tools.mdx").unwrap().threads[0].thread.status, Status::Resolved);
        f.engine.comment_status("drafts/tools.mdx", &id, Status::Open).unwrap();
        f.engine.comment_moved("drafts/tools.mdx", vec![Moved { id: id.clone(), anchor: Anchor { exact: "A pencil is a tool.".into(), ..pencil() }, orphaned: false }]).unwrap();
        f.engine.comment_moved("drafts/tools.mdx", vec![Moved { id: id.clone(), anchor: Anchor::default(), orphaned: true }]).unwrap();
        let thread = f.engine.comments("drafts/tools.mdx").unwrap().threads[0].thread.clone();
        assert!(thread.orphaned && thread.status == Status::Open);
        assert_eq!(thread.anchor.exact, "A pencil is a tool.", "an orphan is kept with the last text it was on");
    }

    #[test]
    fn a_review_leaves_threads_on_the_paragraphs_it_names() {
        let review = "<comments>[{\"paragraph\": 2, \"comment\": \"What does it cost?\"}, {\"paragraph\": 7, \"comment\": \"nope\"}]</comments>";
        let f = fixture(vec![answer(review)], Duration::ZERO);
        let p = |exact: &str, line| Paragraph { anchor: Anchor { exact: exact.into(), line, ..Anchor::default() }, lines: [line, line] };
        let request = f.engine.review("drafts/tools.mdx", vec![p("A pencil is a tool for thinking.", 6), p("A second paragraph.", 8)], vec![]).unwrap();
        assert!(request.review && f.engine.page(None, None, 10).pending.is_empty());
        assert!(f.engine.review("drafts/tools.mdx", vec![p("x", 1)], vec![]).is_err(), "one review at a time");
        settled(&f);
        let page = f.engine.comments("drafts/tools.mdx").unwrap();
        assert_eq!(page.threads.len(), 1);
        let thread = &page.threads[0];
        assert_eq!((thread.thread.origin.as_str(), thread.thread.anchor.exact.as_str()), ("review", "A second paragraph."));
        assert_eq!(thread.entries.len(), 1);
        assert_eq!((thread.entries[0].role, thread.entries[0].text.as_str()), (Role::Kin, "What does it cost?"));
        assert_eq!(thread.entries[0].answers, [request.seq]);
        let note = f.engine.page(Some("drafts/tools.mdx"), None, 10).entries.into_iter().rev().find(|e| e.review && e.role == Role::Kin).unwrap();
        assert!(note.text.starts_with("I left 1 comment on"), "{}", note.text);
        assert!(last_user(&f.script.seen()[0]).starts_with(REVIEW_BRIEF));
        assert!(f.engine.review("drafts/tools.mdx", vec![], vec![]).is_err());
    }
}
