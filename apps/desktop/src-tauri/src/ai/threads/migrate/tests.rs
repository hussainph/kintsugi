//! Moving a real-shaped old vault (the single log, its summaries, comment
//! threads and a model pick, as the app wrote them before KI-104) into
//! threads, and every crash along the way.

use super::*;
use crate::ai::threads::{Filter, Store};

const TOOLS: &str = "c-20261020-101500-a1b0000";
const REVIEWED: &str = "c-20261020-103000-a1b0001";
const UNTOUCHED: &str = "c-20261020-104500-a1b0002";

/// The log as `history::Log` wrote it: camelCase, empty fields left out,
/// one entry per line, and a torn last line from a crash.
fn old_log() -> String {
    let lines = [
        // A question with nothing on screen.
        r#"{"seq":1,"at":"2026-10-20T09:00:00+01:00","role":"owner","text":"What should I read tonight?","topic":""}"#.to_string(),
        r#"{"seq":2,"at":"2026-10-20T09:00:09+01:00","role":"kin","text":"Start with inspiration/kiln.md.","topic":"","answers":[1],"usd":0.0012,"tools":[{"name":"search","arguments":{"query":"read"}}],"ms":8400,"model":"opencode-go/qwen3.7-plus"}"#.to_string(),
        // About a draft that was on screen: a reliable topic.
        r#"{"seq":3,"at":"2026-10-20T09:05:00+01:00","role":"owner","text":"Is the opening too slow?","chips":[{"kind":"doc","path":"drafts/tools.mdx","label":"Tools that shape thinking"}],"topic":"drafts/tools.mdx"}"#.to_string(),
        r#"{"seq":4,"at":"2026-10-20T09:05:20+01:00","role":"kin","text":"A little. Cut the first two lines.","topic":"drafts/tools.mdx","answers":[3],"web":[{"tool":"search","query":"pencil thinking","provider":"exa","results":[{"url":"https://example.org/pencils","title":"Pencils"}]}],"ms":12000,"model":"opencode-go/qwen3.7-plus"}"#.to_string(),
        // Nothing on screen; the 30-minute rule guessed the draft: not reliable.
        r#"{"seq":5,"at":"2026-10-20T09:20:00+01:00","role":"owner","text":"And the ending?","topic":"drafts/tools.mdx"}"#.to_string(),
        r#"{"seq":6,"at":"2026-10-20T09:20:04+01:00","role":"kin","text":"The ending is","topic":"drafts/tools.mdx","answers":[5],"interrupted":true}"#.to_string(),
        // A comment thread on a paragraph.
        format!(r#"{{"seq":7,"at":"2026-10-20T10:15:00+01:00","role":"owner","text":"Is this too obvious?","chips":[{{"kind":"paragraph","path":"drafts/tools.mdx","label":"A pencil is a tool for thinking.","lines":[6,6]}},{{"kind":"doc","path":"drafts/tools.mdx"}}],"topic":"drafts/tools.mdx","comment":"{TOOLS}"}}"#),
        format!(r#"{{"seq":8,"at":"2026-10-20T10:15:12+01:00","role":"kin","text":"Which kind of thinking? Compare [[posts/kintsugi]].","topic":"drafts/tools.mdx","answers":[7],"usd":0.0004,"comment":"{TOOLS}"}}"#),
        // "Kin, review this draft": the request, a note on a paragraph, the summary.
        r#"{"seq":9,"at":"2026-10-20T10:30:00+01:00","role":"owner","text":"Kin, review this draft.","chips":[{"kind":"doc","path":"drafts/tools.mdx","label":"Tools that shape thinking"}],"topic":"drafts/tools.mdx","review":true}"#.to_string(),
        format!(r#"{{"seq":10,"at":"2026-10-20T10:30:40+01:00","role":"kin","text":"What does it cost?","topic":"drafts/tools.mdx","answers":[9],"comment":"{REVIEWED}"}}"#),
        r#"{"seq":11,"at":"2026-10-20T10:30:40+01:00","role":"kin","text":"I left 1 comment on Tools that shape thinking.","topic":"drafts/tools.mdx","answers":[9],"usd":0.003,"review":true}"#.to_string(),
        // A helper's report.
        r#"{"seq":12,"at":"2026-10-20T11:00:00+01:00","role":"helper","text":"Offered 2 ideas. Dropped 1: its quote isn't in posts/a.md.","topic":"","job":"job-20261020-110000000-1","usd":0.02}"#.to_string(),
        // The next day: a clip on screen, a failed reply, then a general question.
        r#"{"seq":13,"at":"2026-10-21T08:00:00+01:00","role":"owner","text":"Why did I keep this?","chips":[{"kind":"clip","path":"inspiration/kiln.md","label":"Anagama kilns"}],"topic":"inspiration/kiln.md"}"#.to_string(),
        r#"{"seq":14,"at":"2026-10-21T08:00:02+01:00","role":"kin","text":"","topic":"inspiration/kiln.md","answers":[13],"error":"Mock: 500 Internal Server Error"}"#.to_string(),
        r#"{"seq":15,"at":"2026-10-21T21:00:00+01:00","role":"owner","text":"Anything new on the Feed?","topic":""}"#.to_string(),
    ];
    let mut log = lines.join("\n");
    log.push_str("\n{\"seq\":16,\"at\":");
    log
}

const SUMMARIES: &str = r#"{
  "answeredThrough": 15,
  "threads": {
    "": { "key": "", "kind": "general", "label": "General", "summary": "Reading lists.", "summarizedThrough": 2, "entries": 4, "lastSeq": 15, "lastAt": "" },
    "drafts/tools.mdx": { "key": "drafts/tools.mdx", "kind": "doc", "label": "Tools that shape thinking", "summary": "", "summarizedThrough": 0, "entries": 9, "lastSeq": 11, "lastAt": "" },
    "inspiration/kiln.md": { "key": "inspiration/kiln.md", "kind": "clip", "label": "Anagama kilns", "summary": "", "summarizedThrough": 0, "entries": 2, "lastSeq": 14, "lastAt": "" }
  }
}"#;

fn comments() -> String {
    format!(
        r#"{{
  "version": 1,
  "path": "drafts/tools.mdx",
  "threads": [
    {{ "id": "{TOOLS}", "anchor": {{ "exact": "A pencil is a tool for thinking.", "prefix": "---\n\n", "suffix": "\n", "line": 6 }}, "status": "open", "origin": "mention", "created": "2026-10-20T10:15:00+01:00" }},
    {{ "id": "{REVIEWED}", "anchor": {{ "exact": "A second paragraph.", "prefix": "", "suffix": "", "line": 8 }}, "status": "resolved", "origin": "review", "created": "2026-10-20T10:30:40+01:00", "resolved": "2026-10-20T12:00:00+01:00", "orphaned": true }},
    {{ "id": "{UNTOUCHED}", "anchor": {{ "exact": "The last paragraph.", "line": 12 }}, "status": "open", "origin": "discuss", "created": "2026-10-20T10:45:00+01:00" }}
  ]
}}
"#
    )
}

struct Old {
    _tmp: tempfile::TempDir,
    vault: PathBuf,
    kin: PathBuf,
}

fn old_vault() -> Old {
    let tmp = tempfile::tempdir().unwrap();
    let vault = tmp.path().join("vault");
    let kin = vault.join(".kintsugi/kin");
    fs::create_dir_all(&kin).unwrap();
    fs::create_dir_all(vault.join(".kintsugi/comments/drafts")).unwrap();
    fs::write(kin.join("log.jsonl"), old_log()).unwrap();
    fs::write(kin.join("threads.json"), SUMMARIES).unwrap();
    fs::write(
        kin.join("models.json"),
        r#"{ "drafts/tools.mdx": { "provider": "opencode-go", "model": "glm-5.3-flash" }, "": { "reasoning": "high" } }"#,
    )
    .unwrap();
    fs::write(
        vault.join(".kintsugi/comments/drafts/tools.mdx.json"),
        comments(),
    )
    .unwrap();
    Old {
        _tmp: tmp,
        vault,
        kin,
    }
}

fn store(old: &Old) -> Store {
    Store::open_for(&old.vault, Some(old.kin.join("threads")))
}

fn by_title<'a>(store: &'a Store, title: &str) -> Vec<&'a crate::ai::threads::Thread> {
    let all = store.list(&Filter {
        resolved: true,
        ..Filter::default()
    });
    all.iter()
        .filter(|l| l.meta.title == title)
        .map(|l| store.get(&l.meta.id).unwrap())
        .collect()
}

/// Everything the old vault said is in threads, as it should be.
fn moved_intact(old: &Old) {
    let store = store(old);
    let all = store.list(&Filter {
        resolved: true,
        ..Filter::default()
    });
    assert_eq!(
        all.len(),
        9,
        "{:#?}",
        all.iter().map(|l| &l.meta.title).collect::<Vec<_>>()
    );
    // Every old message is in exactly one thread, unchanged.
    let mut was: Vec<u64> = all
        .iter()
        .flat_map(|l| {
            store
                .get(&l.meta.id)
                .unwrap()
                .entries
                .iter()
                .filter_map(|e| e.was)
        })
        .collect();
    was.sort();
    assert_eq!(was, (1..=15).collect::<Vec<_>>());

    // The draft's reliable messages are one thread about it, named as before.
    let draft = by_title(&store, "Tools that shape thinking");
    assert_eq!(draft.len(), 1);
    let draft = draft[0];
    assert_eq!(draft.meta.origin, "chat");
    let anchor = draft.meta.anchor.as_ref().unwrap();
    assert_eq!(
        (anchor.kind.as_str(), anchor.path.as_str()),
        ("doc", "drafts/tools.mdx")
    );
    let texts: Vec<_> = draft.entries.iter().map(|e| e.text.as_str()).collect();
    assert_eq!(
        texts,
        [
            "Is the opening too slow?",
            "A little. Cut the first two lines."
        ]
    );
    assert_eq!(
        draft.entries[1].answers,
        [1],
        "answers follow the new numbering"
    );
    assert_eq!(
        draft.entries[1].web[0].results[0].url,
        "https://example.org/pencils"
    );
    assert_eq!(
        draft.entries[1].model.as_deref(),
        Some("opencode-go/qwen3.7-plus")
    );
    assert_eq!(
        draft.entries[0].chips[0].label.as_deref(),
        Some("Tools that shape thinking")
    );

    // Guessed topics and nothing on screen: one "Earlier conversation" per day.
    let earlier = by_title(&store, EARLIER);
    assert_eq!(earlier.len(), 2);
    let days: Vec<Vec<&str>> = earlier
        .iter()
        .map(|t| t.entries.iter().map(|e| e.text.as_str()).collect())
        .collect();
    assert!(days.contains(&vec![
        "What should I read tonight?",
        "Start with inspiration/kiln.md.",
        "And the ending?",
        "The ending is",
    ]));
    assert!(days.contains(&vec!["Anything new on the Feed?"]));
    let first_day = earlier.iter().find(|t| t.entries.len() == 4).unwrap();
    assert!(first_day.meta.anchor.is_none());
    assert_eq!(first_day.meta.origin, "earlier");
    assert!(first_day.entries[3].interrupted);
    assert_eq!(first_day.entries[3].answers, [3]);
    assert_eq!(first_day.entries[1].tools[0].name, "search");

    // A comment thread keeps its id, paragraph, status and origin.
    let comment = store.get(TOOLS).unwrap();
    let anchor = comment.meta.anchor.as_ref().unwrap();
    assert_eq!(
        (anchor.kind.as_str(), anchor.path.as_str()),
        ("paragraph", "drafts/tools.mdx")
    );
    let quote = anchor.quote.as_ref().unwrap();
    assert_eq!(
        (quote.exact.as_str(), quote.prefix.as_str(), quote.line),
        ("A pencil is a tool for thinking.", "---\n\n", 6)
    );
    assert_eq!(comment.meta.title, "Is this too obvious?");
    assert_eq!(
        (comment.meta.origin.as_str(), comment.meta.status),
        ("mention", Status::Open)
    );
    assert_eq!(comment.entries.len(), 2);
    assert_eq!(comment.entries[1].answers, [1]);

    // A review's note is a resolved, orphaned paragraph thread Kin started.
    let reviewed = store.get(REVIEWED).unwrap();
    assert_eq!(reviewed.meta.status, Status::Resolved);
    assert_eq!(
        reviewed.meta.resolved.as_deref(),
        Some("2026-10-20T12:00:00+01:00")
    );
    assert!(reviewed.meta.anchor.as_ref().unwrap().orphaned);
    assert_eq!(reviewed.meta.origin, "review");
    assert_eq!(
        (reviewed.entries[0].role, reviewed.entries[0].review),
        (Role::Kin, true)
    );
    assert!(reviewed.entries[0].answers.is_empty());
    // A thread nobody wrote in is kept too.
    let untouched = store.get(UNTOUCHED).unwrap();
    assert!(untouched.entries.is_empty());
    assert_eq!(untouched.meta.title, "The last paragraph.");
    assert_eq!(untouched.meta.origin, "discuss");

    // The review's request and summary are a review thread about the draft.
    let review = by_title(&store, "Review")[0];
    assert_eq!(
        review.meta.anchor.as_ref().unwrap().path,
        "drafts/tools.mdx"
    );
    let texts: Vec<_> = review.entries.iter().map(|e| e.text.as_str()).collect();
    assert_eq!(
        texts,
        [
            "Kin, review this draft.",
            "I left 1 comment on Tools that shape thinking."
        ]
    );
    assert_eq!(review.entries[1].answers, [1]);

    // The helper's report is its own thread.
    let helper = all.iter().find(|l| l.meta.origin == "helper").unwrap();
    let helper = store.get(&helper.meta.id).unwrap();
    assert_eq!(
        helper.entries[0].job.as_deref(),
        Some("job-20261020-110000000-1")
    );
    assert!(helper.meta.title.starts_with("Offered 2 ideas"));

    // The clip's thread, with its failed reply.
    let clip = by_title(&store, "Anagama kilns")[0];
    let anchor = clip.meta.anchor.as_ref().unwrap();
    assert_eq!(
        (anchor.kind.as_str(), anchor.path.as_str()),
        ("clip", "inspiration/kiln.md")
    );
    assert_eq!(
        clip.entries[1].error.as_deref(),
        Some("Mock: 500 Internal Server Error")
    );
    assert_eq!(clip.meta.preview, "Kin couldn’t answer.");

    // Listed by what they're about, newest first.
    let about = store.list(&Filter {
        about: Some("drafts/tools.mdx".into()),
        resolved: true,
        ..Filter::default()
    });
    assert_eq!(
        about.len(),
        5,
        "the draft's thread, its review and three paragraphs"
    );
    // Nothing waits for an answer after the move.
    for listed in &all {
        assert!(
            store.pending(&listed.meta.id).is_empty(),
            "{}",
            listed.meta.title
        );
    }

    // The model picked for the draft's topic follows its thread.
    assert_eq!(
        crate::ai::picks::get(&old.kin, &draft.meta.id).and_then(|p| p.model),
        Some("glm-5.3-flash".into())
    );
    assert_eq!(
        crate::ai::picks::get(&old.kin, "").and_then(|p| p.reasoning),
        Some("high".into()),
        "the general pick stays the one for new threads"
    );

    // The old files are kept, out of the way; nothing was deleted.
    assert!(!old.kin.join("log.jsonl").exists());
    assert!(!old.kin.join("threads.json").exists());
    assert!(!old.vault.join(COMMENTS).exists());
    let archive = old.kin.join(ARCHIVE);
    let names: Vec<String> = fs::read_dir(&archive)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    let log = names.iter().find(|n| n.starts_with("log-")).unwrap();
    assert_eq!(fs::read_to_string(archive.join(log)).unwrap(), old_log());
    assert!(names.iter().any(|n| n.starts_with("threads-")));
    assert_eq!(
        fs::read_to_string(archive.join("comments/drafts/tools.mdx.json")).unwrap(),
        comments()
    );
}

#[test]
fn an_old_log_and_comments_become_threads_without_loss() {
    let old = old_vault();
    assert_eq!(
        migrate(&old.kin, &old.vault).unwrap(),
        Migrated::Moved {
            threads: 9,
            entries: 15
        }
    );
    moved_intact(&old);
    // Next open: nothing more to do, and nothing changes.
    let index = fs::read(old.kin.join("threads/index.json")).unwrap();
    assert_eq!(migrate(&old.kin, &old.vault).unwrap(), Migrated::Nothing);
    assert_eq!(fs::read(old.kin.join("threads/index.json")).unwrap(), index);
}

#[test]
fn a_crash_at_any_step_loses_nothing_and_the_next_open_finishes() {
    // Eight thread files, the index, the check, then the log kept.
    for steps in 0..11 {
        let old = old_vault();
        assert!(
            migrate_until(&old.kin, &old.vault, steps).is_err(),
            "step {steps} should stop"
        );
        // Until the threads are written and checked, the old files stay put.
        if steps < 10 {
            assert_eq!(
                fs::read_to_string(old.kin.join("log.jsonl")).unwrap(),
                old_log()
            );
            assert!(old.vault.join(COMMENTS).is_dir());
        }
        assert!(
            matches!(migrate(&old.kin, &old.vault), Ok(Migrated::Moved { .. })),
            "after a crash at step {steps}"
        );
        moved_intact(&old);
    }
}

#[test]
fn threads_started_since_a_crash_are_kept() {
    let old = old_vault();
    let _ = migrate_until(&old.kin, &old.vault, 9);
    // The app opened the threads after the crash and he asked something.
    let mut live = store(&old);
    let (meta, _) = live
        .start(
            crate::ai::threads::New::default(),
            Role::Owner,
            crate::ai::threads::Draft::said("A new question.", vec![]),
        )
        .unwrap();
    drop(live);
    migrate(&old.kin, &old.vault).unwrap();
    let after = store(&old);
    assert_eq!(
        after.get(&meta.id).unwrap().entries[0].text,
        "A new question."
    );
    assert_eq!(
        after
            .list(&Filter {
                resolved: true,
                ..Filter::default()
            })
            .len(),
        10
    );
}

#[test]
fn a_damaged_comments_file_stops_the_move_and_keeps_everything() {
    let old = old_vault();
    fs::write(
        old.vault.join(".kintsugi/comments/drafts/broken.md.json"),
        "{ not json",
    )
    .unwrap();
    assert!(migrate(&old.kin, &old.vault).is_err());
    assert_eq!(
        fs::read_to_string(old.kin.join("log.jsonl")).unwrap(),
        old_log()
    );
    assert!(!old.kin.join("threads").exists());
    assert!(!old.kin.join(ARCHIVE).exists());
}

#[test]
fn comments_alone_move_too() {
    let old = old_vault();
    fs::remove_file(old.kin.join("log.jsonl")).unwrap();
    assert!(matches!(
        migrate(&old.kin, &old.vault).unwrap(),
        Migrated::Moved { threads: 3, .. }
    ));
    let store = store(&old);
    assert!(store.get(TOOLS).is_some_and(|t| t.entries.is_empty()));
    assert!(!old.vault.join(COMMENTS).exists());
}

#[test]
fn a_fresh_vault_has_nothing_to_move() {
    let tmp = tempfile::tempdir().unwrap();
    let kin = tmp.path().join(".kintsugi/kin");
    assert_eq!(migrate(&kin, tmp.path()).unwrap(), Migrated::Nothing);
    assert!(!kin.exists(), "nothing is created");
}
