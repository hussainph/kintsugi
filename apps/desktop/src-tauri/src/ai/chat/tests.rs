//! The live threads against scripted models: batching, interrupts,
//! per-thread context, the threads tool, paragraph threads and reviews,
//! helper jobs, and moving old conversations into threads.
//! Timings are shortened; nothing calls out or touches a real vault.

use super::*;
use crate::ai::ModelRef;
use crate::ai::agent::tests::{answer, calls};
use crate::ai::threads::Status as ThreadStatus;
use crate::ai::tools::tests::scratch_vault;
use crate::ai::wire::{Exchange, Item, Reply};
use review::REVIEW_BRIEF;
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
            model: ModelRef {
                provider: "anthropic".into(),
                model: "claude-sonnet-5-5".into(),
                reasoning: None,
            },
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

    async fn send(
        &self,
        ex: &Exchange<'_>,
        on_text: &mut (dyn FnMut(&str) + Send),
    ) -> Result<crate::ai::wire::Reply> {
        self.seen.lock().unwrap().push(Seen {
            system: ex.system.into(),
            tools: ex.tools.len(),
            items: ex.items.to_vec(),
        });
        let reply = self
            .replies
            .lock()
            .unwrap()
            .pop_front()
            .ok_or("the script ran out of replies")?;
        for word in reply.text.split_inclusive(' ') {
            on_text(word);
            tokio::time::sleep(self.delay).await;
        }
        Ok(reply)
    }
}

struct TestBrain {
    script: Arc<Script>,
    /// The open vault; tests switch it.
    vault: Mutex<PathBuf>,
    meter: Meter,
    events: Arc<Mutex<Vec<ChatEvent>>>,
    /// Jobs the finish hook saw, with their traces.
    finished: Arc<Mutex<Vec<(String, Trace)>>>,
    /// Every model asked for: the task and the conversation's pick.
    connected: Arc<Mutex<Vec<(Task, Option<crate::ai::picks::Pick>)>>>,
    /// Web tools on (scripted results, KI-78).
    web: Arc<Mutex<bool>>,
    /// Helpers get them too (KI-81).
    web_helpers: Arc<Mutex<bool>>,
}

impl Brain for TestBrain {
    type Model = Arc<Script>;

    async fn connect(&self, _task: Task) -> Result<Arc<Script>> {
        Ok(self.script.clone())
    }

    async fn connect_to(
        &self,
        task: Task,
        pick: Option<crate::ai::picks::Pick>,
    ) -> Result<Arc<Script>> {
        self.connected.lock().unwrap().push((task, pick));
        Ok(self.script.clone())
    }

    fn vault(&self) -> Result<PathBuf> {
        Ok(self.vault.lock().unwrap().clone())
    }

    fn memory(&self, _vault: &Path) -> Memory {
        Memory {
            about: vec!["Likes short essays.".into()],
            notes: vec!["Drafts live in drafts/.".into()],
            skills: vec![],
        }
    }

    fn meter(&self) -> &Meter {
        &self.meter
    }

    fn web(&self) -> Option<Arc<crate::ai::web::Web>> {
        (*self.web.lock().unwrap()).then(|| Arc::new(crate::ai::web::Web::scripted()))
    }

    fn web_for_helpers(&self) -> bool {
        *self.web_helpers.lock().unwrap()
    }

    fn finish_job(&self, job: &Job, report: String, trace: &Trace) -> Result<String> {
        self.finished
            .lock()
            .unwrap()
            .push((job.kind.clone(), trace.clone()));
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
    connected: Arc<Mutex<Vec<(Task, Option<crate::ai::picks::Pick>)>>>,
    web: Arc<Mutex<bool>>,
    web_helpers: Arc<Mutex<bool>>,
    _vault: tempfile::TempDir,
    _ledger: tempfile::TempDir,
}

const FAST: Timing = Timing {
    batch: Duration::from_millis(120),
    typing: Duration::from_millis(250),
};

fn fixture_in(
    dir: Option<PathBuf>,
    replies: Vec<Reply>,
    delay: Duration,
    timing: Timing,
) -> Fixture {
    let vault = scratch_vault();
    let ledger = tempfile::tempdir().unwrap();
    let script = Script::new(replies, delay);
    let events: Arc<Mutex<Vec<ChatEvent>>> = Arc::default();
    let connected: Arc<Mutex<Vec<(Task, Option<crate::ai::picks::Pick>)>>> = Arc::default();
    let web: Arc<Mutex<bool>> = Arc::default();
    let web_helpers: Arc<Mutex<bool>> = Arc::default();
    let brain = TestBrain {
        web: web.clone(),
        web_helpers: web_helpers.clone(),
        script: script.clone(),
        vault: Mutex::new(vault.path().into()),
        meter: Meter::with_clock(Some(ledger.path().into()), || "2026-11".into()),
        events: events.clone(),
        finished: Arc::default(),
        connected: connected.clone(),
    };
    let engine = Engine::new(brain, dir, timing);
    Fixture {
        engine,
        script,
        events,
        connected,
        web,
        web_helpers,
        _vault: vault,
        _ledger: ledger,
    }
}

fn fixture(replies: Vec<Reply>, delay: Duration) -> Fixture {
    fixture_in(None, replies, delay, FAST)
}

fn wait(what: &str, mut done: impl FnMut() -> bool) {
    let start = Instant::now();
    while !done() {
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "timed out waiting for {what}"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn all() -> Filter {
    Filter {
        resolved: true,
        ..Filter::default()
    }
}

impl Fixture {
    /// A new thread about the first chip, as the Kin tab starts one.
    fn ask(&self, text: &str, chips: Vec<Chip>) -> Sent {
        let anchor = chips.iter().find_map(Anchor::from_chip);
        self.engine
            .send(
                None,
                text,
                chips,
                Start {
                    anchor,
                    origin: None,
                },
            )
            .unwrap()
    }

    fn reply(&self, thread: &str, text: &str) -> Sent {
        self.engine
            .send(Some(thread), text, vec![], Start::default())
            .unwrap()
    }

    fn thread(&self, id: &str) -> Vec<Entry> {
        self.engine.thread(id).unwrap().entries
    }

    /// Every message of every thread, oldest first.
    fn entries(&self) -> Vec<Entry> {
        let mut entries: Vec<Entry> = self
            .engine
            .list(&all())
            .threads
            .iter()
            .flat_map(|t| self.thread(&t.meta.id))
            .collect();
        entries.sort_by(|a, b| {
            chrono::DateTime::parse_from_rfc3339(&a.at)
                .unwrap()
                .cmp(&chrono::DateTime::parse_from_rfc3339(&b.at).unwrap())
        });
        entries
    }

    fn kin_replies(&self) -> Vec<Entry> {
        self.entries()
            .into_iter()
            .filter(|e| e.role == Role::Kin)
            .collect()
    }

    fn wait_replies(&self, n: usize) -> Vec<Entry> {
        wait(&format!("{n} Kin replies"), || {
            self.kin_replies().len() >= n
        });
        wait("the turns to end", || self.engine.running().is_empty());
        self.kin_replies()
    }

    fn events(&self) -> Vec<ChatEvent> {
        self.events.lock().unwrap().clone()
    }

    fn talking(&self, starting: &str) -> bool {
        self.events().iter().any(|e| matches!(e, ChatEvent::Turn { event: KinEvent::Text { delta }, .. } if delta.starts_with(starting)))
    }

    fn vault(&self) -> PathBuf {
        self.engine.0.brain.vault().unwrap()
    }
}

fn last_user(seen: &Seen) -> String {
    match seen.items.last() {
        Some(Item::User(text)) => text.clone(),
        other => panic!("expected a user message last, got {other:?}"),
    }
}

fn doc(path: &str, label: &str) -> Chip {
    Chip {
        kind: "doc".into(),
        path: path.into(),
        label: Some(label.into()),
        lines: None,
    }
}

fn clip(path: &str) -> Chip {
    Chip {
        kind: "clip".into(),
        path: path.into(),
        label: None,
        lines: None,
    }
}

#[test]
fn a_burst_of_messages_in_a_thread_is_one_turn() {
    let f = fixture(vec![answer("Both, briefly.")], Duration::ZERO);
    let a = f.ask(
        "Is the opening too slow?",
        vec![doc("drafts/tools.mdx", "Tools")],
    );
    let thread = a.thread.id.clone();
    assert_eq!(a.thread.title, "Is the opening too slow?");
    assert_eq!(
        a.thread
            .anchor
            .as_ref()
            .map(|a| (a.kind.as_str(), a.path.as_str())),
        Some(("doc", "drafts/tools.mdx"))
    );
    let b = f.reply(&thread, "And is the title right?");
    assert!(
        f.engine
            .send(Some(&thread), "   ", vec![], Start::default())
            .is_err()
    );
    assert!(
        f.engine
            .send(Some("t-nope"), "Hi", vec![], Start::default())
            .is_err()
    );
    // Both are on disk at once, before Kin says anything.
    assert_eq!(
        f.engine.thread(&thread).unwrap().pending,
        [a.entry.seq, b.entry.seq]
    );

    let replies = f.wait_replies(1);
    assert_eq!(replies[0].answers, [a.entry.seq, b.entry.seq]);
    assert_eq!(replies[0].text, "Both, briefly.");
    assert_eq!(replies[0].thread, thread);
    let seen = f.script.seen();
    assert_eq!(seen.len(), 1, "one turn, one request");
    let message = last_user(&seen[0]);
    assert!(
        message.starts_with("Is the opening too slow?\n\nAnd is the title right?\n\n<context>"),
        "{message}"
    );
    assert!(
        message.contains("- doc drafts/tools.mdx (Tools)"),
        "chips go in the dynamic context: {message}"
    );
    assert!(
        message.contains("This thread is about the document drafts/tools.mdx"),
        "{message}"
    );
    assert!(f.engine.thread(&thread).unwrap().pending.is_empty());
    // The prefix carries the memory snapshot and the fixed tool list.
    assert!(seen[0].system.contains("- Likes short essays."));
    assert_eq!(seen[0].tools, crate::ai::tools::specs().len());
    let started: Vec<_> = f
        .events()
        .into_iter()
        .filter(|e| matches!(e, ChatEvent::TurnStarted { .. }))
        .collect();
    assert_eq!(started.len(), 1);
    // On disk: one file for the thread, and the index naming it.
    let dir = f.vault().join(".kintsugi/kin/threads");
    let file = std::fs::read_to_string(dir.join(format!("{thread}.jsonl"))).unwrap();
    assert_eq!(file.lines().count(), 3);
    assert!(
        std::fs::read_to_string(dir.join("index.json"))
            .unwrap()
            .contains(&thread)
    );
}

/// KI-104: nothing is inferred. Each new ask is its own thread, and a turn
/// carries only its own thread's exchanges.
#[test]
fn each_ask_starts_its_own_thread_with_its_own_context() {
    let f = fixture(
        vec![
            answer("About the draft."),
            answer("About the clip."),
            answer("Nothing in particular."),
            answer("Back on the draft."),
        ],
        Duration::ZERO,
    );
    let draft = doc("drafts/x.md", "Draft X");
    let x = f.ask("What's weak in this draft?", vec![draft.clone()]);
    f.wait_replies(1);
    let k = f.ask(
        "Why did I keep this?",
        vec![clip("inspiration/clip-kiln.md")],
    );
    f.wait_replies(2);
    // The same words with nothing on screen: a new thread, about nothing.
    let g = f.ask("What's weak in this draft?", vec![]);
    f.wait_replies(3);
    assert_ne!(x.thread.id, g.thread.id);
    assert!(g.thread.anchor.is_none());
    // Back in draft X's thread: the model sees its exchange only.
    f.reply(&x.thread.id, "Did I fix it?");
    let replies = f.wait_replies(4);
    assert_eq!(replies[3].thread, x.thread.id);
    let seen = f.script.seen();
    assert_eq!(seen[1].items.len(), 1, "a new thread starts with nothing");
    assert_eq!(seen[2].items.len(), 1);
    let items = &seen[3].items;
    assert_eq!(items.len(), 3, "{items:?}");
    assert_eq!(items[0], Item::User("What's weak in this draft?".into()));
    assert_eq!(
        items[1],
        Item::Assistant {
            text: "About the draft.".into(),
            calls: vec![]
        }
    );
    assert!(last_user(&seen[3]).starts_with("Did I fix it?"));
    // The prefix is the same for every thread: a cache hit.
    assert!(seen.windows(2).all(|w| w[0].system == w[1].system));
    let list = f.engine.list(&Filter::default()).threads;
    assert_eq!(list.len(), 3);
    assert_eq!(list[0].meta.id, x.thread.id, "newest first");
    let about = f.engine.list(&Filter {
        about: Some("inspiration/clip-kiln.md".into()),
        ..Filter::default()
    });
    assert_eq!(about.threads.len(), 1);
    assert_eq!(about.threads[0].meta.id, k.thread.id);
    assert_eq!(f.thread(&x.thread.id).len(), 4);
}

#[test]
fn threads_answer_on_their_own() {
    let f = fixture(
        vec![
            answer("one two three four five six seven eight nine ten"),
            answer("Quick."),
        ],
        Duration::from_millis(40),
    );
    let slow = f.ask("A slow one", vec![]);
    wait("Kin to start the first", || f.talking("two"));
    // Another thread doesn't interrupt the first.
    let quick = f.ask("A quick one", vec![]);
    let replies = f.wait_replies(2);
    assert!(replies.iter().all(|r| !r.interrupted), "{replies:?}");
    assert_eq!(f.thread(&slow.thread.id)[1].text.split(' ').count(), 10);
    assert_eq!(f.thread(&quick.thread.id)[1].text, "Quick.");
}

/// KI-78: a reply keeps the web searches and pages its turn used, for the
/// chat to show as sources, and the turn's tool list grows by the web tools.
#[test]
fn a_reply_keeps_its_web_sources() {
    let f = fixture(
        vec![
            calls(
                &[("w1", "web_search", json!({ "query": "golden joinery" }))],
                "",
            ),
            calls(
                &[(
                    "w2",
                    "web_fetch",
                    json!({ "url": "https://example.org/essays/golden-joinery" }),
                )],
                "",
            ),
            answer("Two sources say so."),
        ],
        Duration::ZERO,
    );
    *f.web.lock().unwrap() = true;
    f.ask("What do others say about golden joinery?", vec![]);
    let reply = f.wait_replies(1).remove(0);
    assert_eq!(reply.text, "Two sources say so.");
    assert_eq!(reply.web.len(), 2);
    assert_eq!(reply.web[0].tool, "search");
    assert_eq!(reply.web[0].query.as_deref(), Some("golden joinery"));
    assert_eq!(reply.web[0].results.len(), 3);
    assert_eq!(reply.web[1].tool, "fetch");
    assert_eq!(
        reply.web[1].results[0].url,
        "https://example.org/essays/golden-joinery"
    );
    let seen = f.script.seen();
    assert_eq!(seen[0].tools, crate::ai::tools::specs_with_web().len());
    let line = serde_json::to_value(&reply).unwrap();
    assert_eq!(line["web"][0]["results"][0]["date"], "2025-06-14");
    // KI-79: and the tools it used, in order, with how long it took.
    let names: Vec<_> = reply.tools.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(names, ["web_search", "web_fetch"]);
    assert_eq!(
        reply.tools[0].arguments,
        json!({ "query": "golden joinery" })
    );
    assert!(!reply.tools[0].error && reply.ms.is_some() && !reply.cap_reached);
    assert_eq!(line["tools"][1]["name"], "web_fetch");
    assert!(
        line.get("capReached").is_none(),
        "false flags stay out of the thread"
    );
}

/// KI-79: a long argument is cut before it's kept.
#[test]
fn a_tool_use_cuts_long_strings() {
    let long = "x".repeat(500);
    let used = threads::ToolUse::new("read", &json!({ "path": long, "n": 3 }));
    assert_eq!(
        used.arguments["path"].as_str().unwrap().chars().count(),
        201
    );
    assert_eq!(used.arguments["n"], 3);
}

#[test]
fn typing_interrupts_kin_and_the_next_turn_answers_everything_waiting() {
    let slow = answer(
        "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen",
    );
    let f = fixture(
        vec![slow, answer("Answered both.")],
        Duration::from_millis(60),
    );
    let first = f.ask("Tell me about kilns", vec![]);
    let id = first.thread.id.clone();
    wait("Kin to start talking", || f.talking("three"));
    f.engine.typing(&id);
    let replies = f.wait_replies(1);
    assert!(replies[0].interrupted);
    assert!(
        replies[0].text.starts_with("one two three"),
        "{}",
        replies[0].text
    );
    assert!(!replies[0].text.contains("sixteen"));
    // Still waiting: the interrupted message is answered with the next one.
    assert_eq!(f.engine.thread(&id).unwrap().pending, [first.entry.seq]);
    let second = f.reply(&id, "Actually, only Japanese ones");
    let replies = f.wait_replies(2);
    assert_eq!(replies[1].answers, [first.entry.seq, second.entry.seq]);
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
    let id = f.ask("Question", vec![]).thread.id;
    wait("Kin to start", || f.talking(""));
    f.engine.typing(&id);
    let replies = f.wait_replies(2);
    assert!(replies[0].interrupted && !replies[1].interrupted);
    assert_eq!(replies[1].text, "Done.");
}

#[test]
fn stop_ends_the_turn_and_settles_its_messages() {
    let f = fixture(
        vec![answer("a b c d e f g h i j k l m n o p q r s t")],
        Duration::from_millis(60),
    );
    let id = f.ask("Question", vec![]).thread.id;
    wait("Kin to start", || f.talking(""));
    f.engine.stop(&id);
    let replies = f.wait_replies(1);
    assert!(replies[0].interrupted);
    assert!(f.engine.thread(&id).unwrap().pending.is_empty());
    std::thread::sleep(FAST.typing * 2);
    assert_eq!(f.script.seen().len(), 1, "no new turn after a stop");
}

#[test]
fn ask_again_answers_his_last_message_once_more() {
    let f = fixture(vec![], Duration::ZERO);
    let id = f.ask("Hello?", vec![]).thread.id;
    let failed = f.wait_replies(1);
    assert_eq!(
        failed[0].error.as_deref(),
        Some("the script ran out of replies")
    );
    assert!(f.engine.thread(&id).unwrap().pending.is_empty());
    f.script.push(answer("Hi."));
    let again = f.engine.again(&id).unwrap().unwrap();
    assert_eq!(again.text, "Hello?");
    let replies = f.wait_replies(2);
    assert_eq!(replies[1].text, "Hi.");
    assert_eq!(replies[1].answers, [again.seq]);
}

#[test]
fn a_thread_runs_on_the_model_picked_for_it() {
    let f = fixture(
        vec![
            answer("On the light model."),
            answer("On the default."),
            answer("On what he picked before sending."),
        ],
        Duration::ZERO,
    );
    let light = ModelRef {
        provider: "opencode-go".into(),
        model: "glm-5.3-flash".into(),
        reasoning: None,
    };
    let first = f.ask("Tighten this?", vec![doc("drafts/x.md", "Draft X")]);
    let dir = crate::ai::threads::vault_dir(f._vault.path()).unwrap();
    crate::ai::picks::set(&dir, &first.thread.id, Some(light.clone())).unwrap();
    crate::ai::picks::set_effort(&dir, &first.thread.id, Some("high".into())).unwrap();
    f.wait_replies(1);
    f.ask("Unrelated: what's a kiln?", vec![]);
    f.wait_replies(2);
    assert_eq!(
        *f.connected.lock().unwrap(),
        [
            (
                Task::Chat,
                Some(crate::ai::picks::Pick {
                    reasoning: Some("high".into()),
                    ..crate::ai::picks::Pick::with_model(light.clone())
                })
            ),
            (Task::Chat, None)
        ]
    );
    // Picked in a new thread's composer (`""`): that thread takes it, and
    // the next new thread starts from the defaults.
    crate::ai::picks::set(&dir, "", Some(light.clone())).unwrap();
    let third = f.ask("A third thread", vec![]);
    f.wait_replies(3);
    assert_eq!(
        f.connected.lock().unwrap().last().unwrap().1,
        Some(crate::ai::picks::Pick::with_model(light))
    );
    assert!(crate::ai::picks::get(&dir, &third.thread.id).is_some());
    assert!(crate::ai::picks::get(&dir, "").is_none());
}

#[test]
fn resolving_keeps_a_thread_findable_and_a_reply_reopens_it() {
    let f = fixture(vec![answer("Done."), answer("Reopened.")], Duration::ZERO);
    let id = f
        .ask(
            "Does the anagama ending work?",
            vec![doc("drafts/x.md", "X")],
        )
        .thread
        .id;
    f.wait_replies(1);
    let renamed = f.engine.set_title(&id, "  The ending  ").unwrap();
    assert_eq!(
        (renamed.title.as_str(), renamed.titled),
        ("The ending", true)
    );
    f.engine.set_status(&id, ThreadStatus::Resolved).unwrap();
    assert!(f.engine.list(&Filter::default()).threads.is_empty());
    let found = f.engine.list(&Filter {
        query: Some("anagama".into()),
        resolved: true,
        ..Filter::default()
    });
    assert_eq!(found.threads.len(), 1);
    assert!(
        found.threads[0]
            .hit
            .as_deref()
            .is_some_and(|h| h.contains("anagama"))
    );
    f.reply(&id, "One more thing.");
    f.wait_replies(2);
    let meta = f.engine.thread(&id).unwrap().thread;
    assert_eq!(meta.status, ThreadStatus::Open);
    assert_eq!(meta.title, "The ending", "his title stays");
    assert!(
        f.engine
            .set_title(&id, "")
            .unwrap()
            .title
            .starts_with("Does the")
    );
}

#[test]
fn kin_finds_earlier_threads_with_a_tool() {
    let f = fixture(
        vec![
            answer("Noted."),
            calls(
                &[(
                    "c1",
                    "tool",
                    json!({ "name": "threads", "args": { "query": "anagama" } }),
                )],
                "",
            ),
            calls(
                &[(
                    "c2",
                    "tool",
                    json!({ "name": "threads", "args": { "id": "PLACEHOLDER" } }),
                )],
                "",
            ),
            answer("You asked about anagama kilns earlier."),
        ],
        Duration::ZERO,
    );
    let earlier = f.ask("Remember the anagama kilns", vec![]).thread.id;
    f.wait_replies(1);
    // Kin reads the thread it found by id.
    {
        let mut replies = f.script.replies.lock().unwrap();
        replies[1] = calls(
            &[(
                "c2",
                "tool",
                json!({ "name": "threads", "args": { "id": earlier } }),
            )],
            "",
        );
    }
    f.ask("What did I ask before?", vec![]);
    f.wait_replies(2);
    let seen = f.script.seen();
    let Some(Item::Results(found)) = seen[2].items.last() else {
        panic!("expected results")
    };
    assert!(
        found[0].content.contains(&earlier)
            && found[0].content.contains("Remember the anagama kilns"),
        "{}",
        found[0].content
    );
    assert!(found[0].content.starts_with("<data tool=\"tool\">"));
    assert!(
        !found[0].content.contains("What did I ask before"),
        "not the thread it's in"
    );
    let Some(Item::Results(read)) = seen[3].items.last() else {
        panic!("expected results")
    };
    assert!(
        read[0]
            .content
            .contains("Hussain:\nRemember the anagama kilns")
            && read[0].content.contains("Kin:\nNoted."),
        "{}",
        read[0].content
    );
}

#[test]
fn helper_jobs_report_in_their_own_thread_or_the_one_that_asked() {
    let f = fixture(
        vec![
            calls(&[("c1", "search", json!({ "query": "kiln" }))], ""),
            answer("Three kiln clips; ranked posts/kintsugi.md first."),
            answer("Asked for it."),
            answer("Found it, in the thread that asked."),
        ],
        Duration::ZERO,
    );
    let job = f
        .engine
        .create_job(NewJob {
            kind: "feed-ranking".into(),
            task: Some("triage".into()),
            brief: "Rank today's kiln items.".into(),
            about: Some("posts/kintsugi.md".into()),
            thread: None,
        })
        .unwrap();
    assert!(
        f.engine
            .create_job(NewJob {
                kind: "x".into(),
                task: Some("edit".into()),
                brief: "b".into(),
                about: None,
                thread: None,
            })
            .is_err()
    );
    wait("the job to finish", || {
        f.engine.jobs()[0].status == Status::Done
    });
    let done = &f.engine.jobs()[0];
    assert_eq!(
        done.result.as_deref(),
        Some("Three kiln clips; ranked posts/kintsugi.md first.")
    );
    // Its step trace is kept: tool names and stop reasons, no content.
    let steps: Vec<_> = done
        .steps
        .iter()
        .map(|s| (s.step, s.tools.clone()))
        .collect();
    assert_eq!(steps, [(1, vec!["search".to_string()]), (2, vec![])]);
    // Its own context: the brief and the memory snapshot, nothing else.
    let seen = f.script.seen();
    assert!(
        seen[0].system.contains("Likes short essays.")
            && seen[0].system.contains("Drafts live in drafts/.")
    );
    assert_eq!(seen[0].items.len(), 1);
    let brief = last_user(&seen[0]);
    assert!(
        brief.contains("Kin's helpers")
            && brief.contains("Brief (feed-ranking):\nRank today's kiln items."),
        "{brief}"
    );
    // It reported back in a thread of its own, about what it was about.
    let threads = f.engine.list(&Filter::default()).threads;
    assert_eq!(threads.len(), 1);
    let own = &threads[0].meta;
    assert_eq!(own.origin, "helper");
    assert_eq!(own.anchor.as_ref().unwrap().path, "posts/kintsugi.md");
    let report = &f.thread(&own.id)[0];
    assert_eq!(
        (report.role, report.job.as_deref()),
        (Role::Helper, Some(job.id.as_str()))
    );
    assert!(
        f.events()
            .iter()
            .any(|e| matches!(e, ChatEvent::Job { job } if job.status == Status::Running))
    );
    assert_eq!(f.engine.0.brain.meter.report().by_task[0].task, "triage");

    // A job a thread asked for reports there.
    let asking = f.ask("Can a helper look?", vec![]).thread.id;
    f.wait_replies(1);
    f.engine
        .create_job(NewJob {
            kind: "search".into(),
            task: None,
            brief: "Look for it.".into(),
            about: None,
            thread: Some(asking.clone()),
        })
        .unwrap();
    wait("the second report", || f.thread(&asking).len() == 3);
    assert_eq!(f.thread(&asking)[2].role, Role::Helper);
    assert_eq!(f.engine.list(&Filter::default()).threads.len(), 2);
    // His next message there sees the report as part of the thread.
    f.script.push(answer("Using the report."));
    f.reply(&asking, "Thanks, and?");
    f.wait_replies(2);
    let last = f.script.seen().last().unwrap().items.clone();
    assert!(
        last.iter().any(|i| matches!(i, Item::Assistant { text, .. } if text == "Found it, in the thread that asked.")),
        "{last:?}"
    );
}

/// KI-81: helpers run unattended, so they get the web tools only while
/// Settings › Web allows it.
#[test]
fn helpers_get_the_web_only_when_allowed() {
    let f = fixture(
        vec![answer("Nothing new."), answer("Still nothing.")],
        Duration::ZERO,
    );
    *f.web.lock().unwrap() = true;
    let job = |brief: &str| NewJob {
        kind: "ideas".into(),
        task: Some("ideas".into()),
        brief: brief.into(),
        about: None,
        thread: None,
    };
    f.engine.create_job(job("Today's ideas.")).unwrap();
    wait("the first job", || {
        f.engine.jobs().iter().any(|j| j.status == Status::Done)
    });
    *f.web_helpers.lock().unwrap() = true;
    f.engine.create_job(job("Tomorrow's ideas.")).unwrap();
    wait("the second job", || {
        f.engine
            .jobs()
            .iter()
            .filter(|j| j.status == Status::Done)
            .count()
            == 2
    });
    let seen = f.script.seen();
    assert_eq!(seen[0].tools, crate::ai::tools::specs().len());
    assert_eq!(seen[1].tools, crate::ai::tools::specs_with_web().len());
    let titles: Vec<_> = f
        .engine
        .list(&Filter::default())
        .threads
        .into_iter()
        .map(|t| t.meta.title)
        .collect();
    assert_eq!(titles, ["New ideas", "New ideas"]);
}

fn job(kind: &str, brief: &str) -> NewJob {
    NewJob {
        kind: kind.into(),
        task: Some("ideas".into()),
        brief: brief.into(),
        about: None,
        thread: None,
    }
}

#[test]
fn a_helper_that_never_reports_says_why() {
    let mut empty = answer("");
    empty.stop_reason = Some("length".into());
    let f = fixture(vec![empty.clone(), empty], Duration::ZERO);
    f.engine.create_job(job("ideas", "Find ideas.")).unwrap();
    wait("the job to fail", || {
        f.engine.jobs()[0].status == Status::Failed
    });
    let failed = &f.engine.jobs()[0];
    assert_eq!(
        failed.error.as_deref(),
        Some("The helper ended without a report: it used its whole reply on thinking.")
    );
    assert_eq!(failed.steps.len(), 2, "asked once more before giving up");
    assert_eq!(failed.steps[1].stop.as_deref(), Some("length"));
}

#[test]
fn helper_jobs_wait_at_the_cap_and_resume_when_it_allows() {
    let f = fixture(vec![answer("Done after the cap rose.")], Duration::ZERO);
    f.engine
        .0
        .brain
        .meter
        .update_settings(|s| s.monthly_cap_usd = Some(0.0))
        .unwrap();
    f.engine.create_job(job("ideas", "Find ideas.")).unwrap();
    wait("the job to wait", || {
        f.engine.jobs()[0].status == Status::Waiting
    });
    assert!(f.script.seen().is_empty(), "no request over the cap");
    f.engine.kick_jobs();
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(f.engine.jobs()[0].status, Status::Waiting, "still capped");

    f.engine
        .0
        .brain
        .meter
        .update_settings(|s| s.monthly_cap_usd = Some(10.0))
        .unwrap();
    f.engine.kick_jobs();
    wait("the job to finish", || {
        f.engine.jobs()[0].status == Status::Done
    });
    assert_eq!(f.engine.jobs()[0].attempts, 2);
}

#[test]
fn jobs_survive_quitting_and_resume_on_start() {
    let data = tempfile::tempdir().unwrap();
    {
        let mut table = Table::open(Some(data.path().into()));
        let job = table
            .create(
                NewJob {
                    kind: "search".into(),
                    task: None,
                    brief: "Find every kiln.".into(),
                    about: None,
                    thread: None,
                },
                "chat",
            )
            .unwrap();
        table.start(&job.id).unwrap();
        // The app quits here, mid-job.
    }
    let f = fixture_in(
        Some(data.path().into()),
        vec![answer("Found two kilns.")],
        Duration::ZERO,
        FAST,
    );
    wait("the resumed job to finish", || {
        f.engine.jobs()[0].status == Status::Done
    });
    let job = &f.engine.jobs()[0];
    assert_eq!(
        (job.attempts, job.result.as_deref()),
        (2, Some("Found two kilns."))
    );
    // The table lives in app data, the threads in the vault.
    assert!(data.path().join("jobs.json").is_file());
    assert!(!data.path().join("conversation").exists());
    wait("the report", || {
        f.vault().join(".kintsugi/kin/threads/index.json").is_file()
    });
}

#[test]
fn a_running_job_can_be_cancelled() {
    let f = fixture(
        vec![answer(
            "a b c d e f g h i j k l m n o p q r s t u v w x y z",
        )],
        Duration::from_millis(50),
    );
    let job = f.engine.create_job(job("ideas", "Long work.")).unwrap();
    wait("the job to start", || f.talking(""));
    f.engine.cancel_job(&job.id);
    wait("the job to stop", || {
        f.engine.jobs()[0].status == Status::Cancelled
    });
    assert!(f.entries().is_empty(), "a cancelled job doesn't report");
}

#[test]
fn a_finished_job_goes_through_its_owner_with_a_footprint() {
    let f = fixture(
        vec![
            calls(
                &[
                    ("c1", "search", json!({ "query": "kiln" })),
                    ("c2", "read", json!({ "path": "posts/kintsugi.md" })),
                ],
                "",
            ),
            answer("[raw json]"),
            answer("[nothing good]"),
        ],
        Duration::ZERO,
    );
    f.engine.create_job(job("rewrite", "Find ideas.")).unwrap();
    wait("the job to finish", || {
        f.engine
            .jobs()
            .first()
            .is_some_and(|j| j.status == Status::Done)
    });
    assert_eq!(
        f.engine.jobs()[0].result.as_deref(),
        Some("Checked: [raw json]")
    );
    let (kind, trace) = f.engine.0.brain.finished.lock().unwrap()[0].clone();
    assert_eq!(
        (
            kind.as_str(),
            trace.searches.as_slice(),
            trace.files.as_slice(),
            trace.tool_calls
        ),
        (
            "rewrite",
            &["kiln".to_string()][..],
            &["posts/kintsugi.md".to_string()][..],
            2
        )
    );
    assert_eq!(trace.model, "anthropic/claude-sonnet-5-5");
    // The owner can fail it; its thread says so.
    f.engine.create_job(job("reject", "Find more.")).unwrap();
    wait("the job to fail", || {
        f.engine.jobs()[0].status == Status::Failed
    });
    assert_eq!(
        f.engine.jobs()[0].error.as_deref(),
        Some("Nothing passed the checks.")
    );
    wait("the failure report", || {
        f.entries()
            .iter()
            .any(|e| e.role == Role::Helper && e.text.contains("Nothing passed the checks."))
    });
}

// --- Threads on paragraphs (KI-38's comments) -------------------------------

mod paragraphs {
    use super::*;
    use crate::ai::chat::review::Paragraph;
    use crate::ai::threads::Quote;

    fn pencil() -> Quote {
        Quote {
            exact: "A pencil is a tool for thinking.".into(),
            prefix: "---\n\n".into(),
            suffix: "\n".into(),
            line: 6,
        }
    }

    fn paragraph_chip() -> Chip {
        Chip {
            kind: "paragraph".into(),
            path: "drafts/tools.mdx".into(),
            label: Some("A pencil is a tool for thinking.".into()),
            lines: Some([6, 6]),
        }
    }

    fn on_pencil() -> Start {
        Start {
            anchor: Some(Anchor {
                kind: "paragraph".into(),
                path: "drafts/tools.mdx".into(),
                label: None,
                quote: Some(pencil()),
                orphaned: false,
            }),
            origin: Some("mention".into()),
        }
    }

    fn ask(f: &Fixture, text: &str) -> Sent {
        f.engine
            .send(None, text, vec![paragraph_chip()], on_pencil())
            .unwrap()
    }

    #[test]
    fn a_paragraph_thread_is_answered_like_a_margin_note() {
        let f = fixture(
            vec![answer(
                "Which kind of thinking? Compare [[posts/kintsugi]].",
            )],
            Duration::ZERO,
        );
        let before = std::fs::read_to_string(f.vault().join("drafts/tools.mdx")).unwrap();
        let sent = ask(&f, "Is this too obvious?");
        assert_eq!(sent.thread.origin, "mention");
        assert_eq!(
            sent.thread
                .anchor
                .as_ref()
                .unwrap()
                .quote
                .as_ref()
                .unwrap()
                .exact,
            "A pencil is a tool for thinking."
        );
        let replies = f.wait_replies(1);
        assert_eq!(replies[0].answers, [sent.entry.seq]);
        let seen = f.script.seen();
        let message = last_user(&seen[0]);
        assert!(
            message.starts_with("Is this too obvious?\n\n(You're replying in a comment thread"),
            "{message}"
        );
        assert!(
            message.contains("- paragraph drafts/tools.mdx lines 6-6"),
            "{message}"
        );
        assert!(message.contains("- doc drafts/tools.mdx"), "{message}");
        assert!(
            message.contains(
                "This thread is about a paragraph of drafts/tools.mdx: <data>A pencil is a tool for thinking.</data>"
            ),
            "the anchor's content goes with it: {message}"
        );
        // Kept outside the document.
        assert_eq!(
            std::fs::read_to_string(f.vault().join("drafts/tools.mdx")).unwrap(),
            before
        );
        // Listed among the document's threads.
        let listed = f.engine.list(&Filter {
            about: Some("drafts/tools.mdx".into()),
            ..Filter::default()
        });
        assert_eq!(listed.threads.len(), 1);
        // A paragraph needs text to be about.
        assert!(
            f.engine
                .send(
                    None,
                    "Hm",
                    vec![],
                    Start {
                        anchor: Some(Anchor {
                            quote: Some(Quote::default()),
                            ..on_pencil().anchor.unwrap()
                        }),
                        origin: None
                    }
                )
                .is_err()
        );
    }

    #[test]
    fn a_reply_interrupts_a_running_answer_and_the_next_answers_both() {
        let slow = answer("one two three four five six seven eight nine ten eleven twelve");
        let f = fixture(
            vec![answer("First thought."), slow, answer("Both, then.")],
            Duration::from_millis(40),
        );
        let id = ask(&f, "Is this too obvious?").thread.id;
        f.wait_replies(1);
        f.reply(&id, "Say more.");
        wait("Kin to start talking", || f.talking("three"));
        f.reply(&id, "Actually, briefly.");
        wait("the final reply", || {
            f.thread(&id).iter().any(|e| e.text == "Both, then.")
        });
        f.wait_replies(3);
        let entries = f.thread(&id);
        assert_eq!(entries.iter().filter(|e| e.interrupted).count(), 1);
        assert_eq!(entries.last().unwrap().answers.len(), 2);
        let seen = f.script.seen();
        let last_request = seen.last().unwrap();
        assert!(
            matches!(&last_request.items[1], Item::Assistant { text, .. } if text == "First thought."),
            "{:?}",
            last_request.items
        );
    }

    #[test]
    fn moved_anchors_persist_and_an_orphan_keeps_its_text() {
        let f = fixture(vec![answer("Noted.")], Duration::ZERO);
        let id = ask(&f, "Hm?").thread.id;
        f.wait_replies(1);
        f.engine
            .moved(
                "drafts/tools.mdx",
                vec![Moved {
                    id: id.clone(),
                    anchor: Quote {
                        exact: "A pencil is a tool.".into(),
                        ..pencil()
                    },
                    orphaned: false,
                }],
            )
            .unwrap();
        f.engine
            .moved(
                "drafts/tools.mdx",
                vec![Moved {
                    id: id.clone(),
                    anchor: Quote::default(),
                    orphaned: true,
                }],
            )
            .unwrap();
        let anchor = f.engine.thread(&id).unwrap().thread.anchor.unwrap();
        assert!(anchor.orphaned);
        assert_eq!(
            anchor.quote.unwrap().exact,
            "A pencil is a tool.",
            "an orphan is kept with the last text it was on"
        );
        // A renamed document takes its threads along.
        f.engine
            .renamed(&f.vault(), "drafts/tools.mdx", "posts/tools.mdx");
        let anchor = f.engine.thread(&id).unwrap().thread.anchor.unwrap();
        assert_eq!(anchor.path, "posts/tools.mdx");
        assert!(f.events().iter().any(|e| matches!(e, ChatEvent::Threads)));
        // Reopened from disk, it's all still there.
        let reopened = Store::open(Some(f.vault().join(".kintsugi/kin/threads")));
        let meta = reopened.meta(&id).unwrap();
        assert_eq!(meta.anchor.as_ref().unwrap().path, "posts/tools.mdx");
        assert_eq!(meta.entries, 2);
    }

    #[test]
    fn a_review_starts_threads_on_the_paragraphs_it_names() {
        let review = "<comments>[{\"paragraph\": 2, \"comment\": \"What does it cost?\"}, {\"paragraph\": 7, \"comment\": \"nope\"}]</comments>";
        let f = fixture(
            vec![answer(review), answer("It costs time.")],
            Duration::ZERO,
        );
        let p = |exact: &str, line| Paragraph {
            anchor: Quote {
                exact: exact.into(),
                line,
                ..Quote::default()
            },
            lines: [line, line],
        };
        let own = f
            .engine
            .review(
                "drafts/tools.mdx",
                vec![
                    p("A pencil is a tool for thinking.", 6),
                    p("A second paragraph.", 8),
                ],
                vec![doc("drafts/tools.mdx", "Tools that shape thinking")],
            )
            .unwrap();
        assert_eq!(
            (own.title.as_str(), own.origin.as_str()),
            ("Review", "review")
        );
        assert!(
            f.engine
                .review("drafts/tools.mdx", vec![p("x", 1)], vec![])
                .is_err(),
            "one review at a time"
        );
        wait("the review to end", || {
            f.events()
                .iter()
                .any(|e| matches!(e, ChatEvent::ReviewEnded { .. }))
        });
        let threads = f
            .engine
            .list(&Filter {
                about: Some("drafts/tools.mdx".into()),
                ..Filter::default()
            })
            .threads;
        assert_eq!(threads.len(), 2, "the review's own thread and one note");
        let note = threads
            .iter()
            .find(|t| t.meta.anchor.as_ref().unwrap().kind == "paragraph")
            .unwrap();
        assert_eq!(note.meta.origin, "review");
        assert_eq!(note.meta.title, "What does it cost?");
        assert_eq!(
            note.meta
                .anchor
                .as_ref()
                .unwrap()
                .quote
                .as_ref()
                .unwrap()
                .exact,
            "A second paragraph."
        );
        let entries = f.thread(&note.meta.id);
        assert_eq!(
            (entries[0].role, entries[0].text.as_str(), entries[0].review),
            (Role::Kin, "What does it cost?", true)
        );
        let summary = f.thread(&own.id);
        assert_eq!(summary[0].text, threads::REVIEW_REQUEST);
        assert!(
            summary[1]
                .text
                .starts_with("I left 1 comment on Tools that shape thinking"),
            "{}",
            summary[1].text
        );
        assert!(last_user(&f.script.seen()[0]).starts_with(REVIEW_BRIEF));
        assert!(f.engine.review("drafts/tools.mdx", vec![], vec![]).is_err());
        // He replies to the note: Kin sees its note as the thread so far.
        f.reply(&note.meta.id, "Time, mostly?");
        f.wait_replies(3);
        let seen = f.script.seen();
        let items = &seen.last().unwrap().items;
        assert!(
            matches!(&items[1], Item::Assistant { text, .. } if text == "What does it cost?"),
            "{items:?}"
        );
        assert_eq!(
            f.engine.thread(&note.meta.id).unwrap().thread.title,
            "What does it cost?",
            "a review note keeps its title"
        );
    }
}

// --- Vaults: each has its own threads (KI-59, KI-104) ----------------------

mod vaults {
    use super::*;
    use std::fs;

    fn open(f: &Fixture, vault: &Path) {
        *f.engine.0.brain.vault.lock().unwrap() = vault.into();
    }

    fn texts(f: &Fixture) -> Vec<String> {
        f.entries().into_iter().map(|e| e.text).collect()
    }

    /// A global log as the app kept it before KI-59.
    fn old_global_log(data: &Path) -> Vec<u8> {
        let dir = data.join("conversation");
        fs::create_dir_all(&dir).unwrap();
        let line = r#"{"seq":1,"at":"2026-10-01T09:00:00+00:00","role":"owner","text":"From before the update.","topic":""}"#;
        fs::write(dir.join("log.jsonl"), format!("{line}\n")).unwrap();
        fs::read(dir.join("log.jsonl")).unwrap()
    }

    #[test]
    fn a_fresh_install_starts_with_no_threads() {
        let data = tempfile::tempdir().unwrap();
        let f = fixture_in(
            Some(data.path().into()),
            vec![answer("Hi.")],
            Duration::ZERO,
            FAST,
        );
        assert!(f.entries().is_empty());
        let id = f.ask("Hello", vec![]).thread.id;
        f.wait_replies(1);
        let kin = f.vault().join(".kintsugi/kin");
        let file = fs::read_to_string(kin.join(format!("threads/{id}.jsonl"))).unwrap();
        assert_eq!(file.lines().count(), 2);
        assert!(!kin.join("log.jsonl").exists());
        assert!(!data.path().join("conversation").exists());
    }

    #[test]
    fn the_old_global_log_moves_into_the_open_vault_as_threads() {
        let data = tempfile::tempdir().unwrap();
        let bytes = old_global_log(data.path());
        let f = fixture_in(Some(data.path().into()), vec![], Duration::ZERO, FAST);
        assert_eq!(texts(&f), ["From before the update."]);
        let threads = f.engine.list(&Filter::default()).threads;
        assert_eq!(threads[0].meta.title, "Earlier conversation");
        let kin = f.vault().join(".kintsugi/kin");
        // Kept, never deleted, once it's threads.
        let archived: Vec<_> = fs::read_dir(kin.join("archive"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(archived.len(), 1, "{archived:?}");
        assert!(archived[0].starts_with("log-"));
        assert_eq!(
            fs::read(kin.join("archive").join(&archived[0])).unwrap(),
            bytes
        );
        assert!(!kin.join("log.jsonl").exists());
        assert!(!data.path().join("conversation").exists());
        assert!(!data.path().join("conversation.moving").exists());

        // A second vault starts with nothing, and doesn't get the old log.
        let second = scratch_vault();
        open(&f, second.path());
        assert!(f.entries().is_empty());
        assert!(!second.path().join(".kintsugi/kin/archive").exists());
    }

    #[test]
    fn a_move_cut_short_by_a_crash_finishes_on_the_next_launch() {
        let data = tempfile::tempdir().unwrap();
        old_global_log(data.path());
        // The crash left the old log claimed as a backup, nothing copied yet.
        fs::rename(
            data.path().join("conversation"),
            data.path().join("conversation.moving"),
        )
        .unwrap();
        let f = fixture_in(Some(data.path().into()), vec![], Duration::ZERO, FAST);
        assert_eq!(texts(&f), ["From before the update."]);
        assert!(!data.path().join("conversation.moving").exists());
    }

    #[test]
    fn switching_vaults_switches_the_threads() {
        let f = fixture(vec![answer("About A."), answer("About B.")], Duration::ZERO);
        let a = f.vault();
        f.ask("Kilns, in vault A", vec![]);
        f.wait_replies(1);

        let b = scratch_vault();
        open(&f, b.path());
        assert!(f.entries().is_empty(), "vault B starts empty");
        wait("the switch event", || {
            f.events().iter().any(|e| matches!(e, ChatEvent::Switched))
        });
        f.ask("In vault B", vec![]);
        f.wait_replies(1);
        assert_eq!(texts(&f), ["In vault B", "About B."]);
        assert!(
            f.engine
                .list(&Filter {
                    query: Some("kilns".into()),
                    resolved: true,
                    ..Filter::default()
                })
                .threads
                .is_empty(),
            "search only sees the open vault"
        );

        open(&f, &a);
        assert_eq!(texts(&f), ["Kilns, in vault A", "About A."]);
    }

    #[test]
    fn a_turn_running_when_the_vault_switches_finishes_in_its_own_vault() {
        let f = fixture(
            vec![answer("one two three four five six seven eight nine ten")],
            Duration::from_millis(40),
        );
        let a = f.vault();
        let id = f.ask("Slow question in A", vec![]).thread.id;
        wait("Kin to start answering", || f.talking(""));
        let b = scratch_vault();
        open(&f, b.path());
        assert!(f.entries().is_empty());
        let file = a.join(format!(".kintsugi/kin/threads/{id}.jsonl"));
        wait("the cut-short reply to land in A", || {
            fs::read_to_string(&file).is_ok_and(|log| log.lines().count() == 2)
        });
        std::thread::sleep(Duration::from_millis(200));
        assert!(f.entries().is_empty(), "nothing of A's turn reached B");
        open(&f, &a);
        let entries = f.entries();
        assert!(entries[1].interrupted, "{entries:?}");
        assert!(f.engine.thread(&id).unwrap().pending.is_empty());
    }
}
