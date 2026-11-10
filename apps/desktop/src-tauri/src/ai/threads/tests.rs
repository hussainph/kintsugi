use super::*;
use serde_json::json;

fn at(minute: i64) -> DateTime<FixedOffset> {
    DateTime::parse_from_rfc3339("2026-11-04T10:00:00+00:00").unwrap()
        + chrono::Duration::minutes(minute)
}

fn about(path: &str) -> New {
    New {
        anchor: Some(Anchor::doc(path)),
        origin: "chat".into(),
        title: None,
    }
}

#[test]
fn titles_come_from_the_first_message() {
    assert_eq!(
        title_from("  Is the opening too slow?\nMore."),
        "Is the opening too slow?"
    );
    assert_eq!(title_from("# Heading\n"), "Heading");
    let long = title_from(
        "Could you look at whether the argument in the third section holds up against what I wrote last year?",
    );
    assert!(long.ends_with('…') && long.chars().count() <= 61, "{long}");
    assert!(!long.contains("  "));
}

#[test]
fn anchors_are_checked() {
    assert!(Anchor::doc("drafts/x.md").checked().is_ok());
    assert!(Anchor::doc("../x.md").checked().is_err());
    assert!(Anchor::doc(".kintsugi/agent/USER.md").checked().is_err());
    let feed = Anchor {
        kind: "feed".into(),
        path: "12".into(),
        label: Some("  A  story ".into()),
        quote: Some(Quote::default()),
        orphaned: true,
    }
    .checked()
    .unwrap();
    assert_eq!(feed.label.as_deref(), Some("A story"));
    assert!(
        feed.quote.is_none() && !feed.orphaned,
        "only paragraphs have quotes"
    );
    let bare = Anchor {
        kind: "paragraph".into(),
        ..Anchor::doc("drafts/x.md")
    };
    assert!(bare.checked().is_err(), "a paragraph needs its text");
    let odd = Anchor {
        kind: "folder".into(),
        ..Anchor::doc("drafts/x.md")
    };
    assert!(odd.checked().is_err());
    // A chip's subject: a paragraph's chip is about its document.
    let chip = Chip {
        kind: "paragraph".into(),
        path: "drafts/x.md".into(),
        label: Some("A paragraph's text".into()),
        lines: Some([3, 4]),
    };
    let from = Anchor::from_chip(&chip).unwrap();
    assert_eq!((from.kind.as_str(), from.label), ("doc", None));
}

#[test]
fn a_thread_is_one_append_only_file_and_a_line_in_the_index() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("threads");
    let mut store = Store::open(Some(path.clone()));
    let (meta, first) = store
        .start_at(
            about("drafts/x.md"),
            Role::Owner,
            Draft::said("Kilns?", vec![]),
            at(0),
        )
        .unwrap();
    assert_eq!((first.seq, first.thread.as_str()), (1, meta.id.as_str()));
    assert_eq!(store.pending(&meta.id).len(), 1);
    let reply = store
        .append_at(
            &meta.id,
            Role::Kin,
            Draft {
                text: "Anagama kilns fire for days.".into(),
                answers: vec![1],
                ..Draft::default()
            },
            at(1),
        )
        .unwrap();
    store.mark_answered(&meta.id, 1);
    assert!(store.pending(&meta.id).is_empty());
    assert_eq!(reply.seq, 2);
    let file = path.join(format!("{}.jsonl", meta.id));
    assert_eq!(fs::read_to_string(&file).unwrap().lines().count(), 2);
    // A torn last line (a crash mid-write) is skipped.
    let mut open = OpenOptions::new().append(true).open(&file).unwrap();
    write!(open, "{{\"seq\":3,\"at\":").unwrap();
    let reopened = Store::open(Some(path.clone()));
    let thread = reopened.get(&meta.id).unwrap();
    assert_eq!(thread.entries.len(), 2);
    assert_eq!(thread.meta.entries, 2);
    assert_eq!(thread.meta.preview, "Anagama kilns fire for days.");
    assert_eq!(thread.meta.updated, at(1).to_rfc3339());
    assert!(
        reopened.pending(&meta.id).is_empty(),
        "a quit settles what waited"
    );
}

#[test]
fn a_lost_or_damaged_index_is_rebuilt_from_the_files() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("threads");
    let mut store = Store::open(Some(path.clone()));
    let (a, _) = store
        .start(
            New::default(),
            Role::Owner,
            Draft::said("First one", vec![]),
        )
        .unwrap();
    // A thread whose index line never made it (a crash in between).
    fs::write(
        path.join("t-20261104-100000-zz.jsonl"),
        "{\"seq\":1,\"at\":\"2026-11-04T10:00:00+00:00\",\"role\":\"owner\",\"text\":\"Orphaned question\"}\n",
    )
    .unwrap();
    let recovered = Store::open(Some(path.clone()));
    assert_eq!(recovered.len(), 2);
    assert_eq!(
        recovered.meta("t-20261104-100000-zz").unwrap().title,
        "Orphaned question"
    );
    // A damaged index is set aside, not overwritten blindly.
    fs::write(path.join("index.json"), "{ nope").unwrap();
    let rebuilt = Store::open(Some(path.clone()));
    assert_eq!(rebuilt.len(), 2);
    assert_eq!(rebuilt.meta(&a.id).unwrap().title, "First one");
    assert!(fs::read_dir(&path).unwrap().flatten().any(|e| {
        e.file_name()
            .to_string_lossy()
            .starts_with("index.json.damaged-")
    }));
}

#[test]
fn threads_list_newest_first_and_search_finds_words() {
    let mut store = Store::open(None);
    let (x, _) = store
        .start_at(
            about("drafts/x.md"),
            Role::Owner,
            Draft::said("Is the opening slow?", vec![]),
            at(0),
        )
        .unwrap();
    let (kiln, _) = store
        .start_at(
            New {
                anchor: Some(Anchor {
                    kind: "clip".into(),
                    path: "inspiration/kiln.md".into(),
                    label: Some("Anagama kilns".into()),
                    quote: None,
                    orphaned: false,
                }),
                ..New::default()
            },
            Role::Owner,
            Draft::said("Why did I keep this?", vec![]),
            at(5),
        )
        .unwrap();
    store
        .append_at(
            &kiln.id,
            Role::Kin,
            Draft {
                text: "Because firing takes days, which is about patience.".into(),
                answers: vec![1],
                ..Draft::default()
            },
            at(6),
        )
        .unwrap();
    let (general, _) = store
        .start_at(
            New::default(),
            Role::Owner,
            Draft::said("What should I read?", vec![]),
            at(10),
        )
        .unwrap();
    let ids = |l: Vec<Listed>| l.into_iter().map(|l| l.meta.id).collect::<Vec<_>>();
    assert_eq!(
        ids(store.list(&Filter::default())),
        [general.id.clone(), kiln.id.clone(), x.id.clone()]
    );
    assert_eq!(
        ids(store.list(&Filter {
            about: Some("inspiration/kiln.md".into()),
            ..Filter::default()
        })),
        [kiln.id.clone()]
    );
    let found = store.list(&Filter {
        query: Some("patience".into()),
        ..Filter::default()
    });
    assert_eq!(ids(found.clone()), [kiln.id.clone()]);
    assert!(found[0].hit.as_deref().unwrap().contains("patience"));
    // A title or what it's about counts most.
    assert_eq!(
        ids(store.list(&Filter {
            query: Some("anagama".into()),
            ..Filter::default()
        })),
        [kiln.id.clone()]
    );
    store.set_status(&x.id, Status::Resolved).unwrap();
    assert_eq!(
        store.list(&Filter::default()).len(),
        2,
        "resolved threads leave the list"
    );
    assert_eq!(
        store
            .list(&Filter {
                query: Some("opening".into()),
                resolved: true,
                ..Filter::default()
            })
            .len(),
        1,
        "but are still found"
    );
    // The newest messages anywhere, for an older phone.
    let recent: Vec<_> = store.recent(2).into_iter().map(|e| e.text).collect();
    assert_eq!(
        recent,
        [
            "What should I read?",
            "Because firing takes days, which is about patience."
        ]
    );
}

#[test]
fn the_threads_tool_searches_lists_and_reads() {
    let mut store = Store::open(None);
    let (kiln, _) = store
        .start_at(
            about("drafts/kiln.md"),
            Role::Owner,
            Draft::said("What about anagama kilns?", vec![]),
            at(0),
        )
        .unwrap();
    store
        .append_at(
            &kiln.id,
            Role::Kin,
            Draft {
                text: "They fire for days.".into(),
                answers: vec![1],
                ..Draft::default()
            },
            at(1),
        )
        .unwrap();
    let (now, _) = store
        .start_at(
            New::default(),
            Role::Owner,
            Draft::said("Kilns again?", vec![]),
            at(5),
        )
        .unwrap();
    let found = store.tool(&serde_json::json!({ "query": "kilns" }), Some(&now.id));
    assert!(found.starts_with("1 thread(s)"), "{found}");
    assert!(
        found.contains(&kiln.id) && found.contains("about drafts/kiln.md"),
        "{found}"
    );
    assert!(!found.contains(&now.id), "not the thread it's asked from");
    let listed = store.tool(&serde_json::json!({ "about": "drafts/kiln.md" }), None);
    assert!(listed.contains(&kiln.id), "{listed}");
    let read = store.tool(&serde_json::json!({ "id": kiln.id }), None);
    assert!(
        read.contains("about the document drafts/kiln.md")
            && read.contains("Hussain:\nWhat about anagama kilns?")
            && read.contains("Kin:\nThey fire for days."),
        "{read}"
    );
    assert!(
        store
            .tool(&serde_json::json!({ "id": "t-nope" }), None)
            .starts_with("No thread")
    );
    assert!(
        store
            .tool(&serde_json::json!({ "query": "zebra" }), None)
            .starts_with("No other thread")
    );
}

#[test]
fn paragraph_anchors_move_and_documents_rename() {
    let mut store = Store::open(None);
    let quote = Quote {
        exact: "A pencil is a tool.".into(),
        prefix: String::new(),
        suffix: String::new(),
        line: 3,
    };
    let (p, _) = store
        .start(
            New {
                anchor: Some(Anchor {
                    kind: "paragraph".into(),
                    path: "drafts/a.md".into(),
                    label: None,
                    quote: Some(quote.clone()),
                    orphaned: false,
                }),
                ..New::default()
            },
            Role::Owner,
            Draft::said("Hm?", vec![]),
        )
        .unwrap();
    let moved = |exact: &str, orphaned| Moved {
        id: p.id.clone(),
        anchor: Quote {
            exact: exact.into(),
            ..quote.clone()
        },
        orphaned,
    };
    assert!(
        !store
            .moved("drafts/a.md", vec![moved("A pencil is a tool.", false)])
            .unwrap()
    );
    assert!(
        !store
            .moved("drafts/b.md", vec![moved("Elsewhere.", false)])
            .unwrap(),
        "only that document's threads"
    );
    assert!(
        store
            .moved("drafts/a.md", vec![moved("A pencil.", false)])
            .unwrap()
    );
    assert!(store.moved("drafts/a.md", vec![moved("", true)]).unwrap());
    let anchor = store.meta(&p.id).unwrap().anchor.clone().unwrap();
    assert!(anchor.orphaned);
    assert_eq!(anchor.quote.unwrap().exact, "A pencil.");
    assert!(store.renamed("drafts", "essays").unwrap());
    assert_eq!(
        store.meta(&p.id).unwrap().anchor.as_ref().unwrap().path,
        "essays/a.md"
    );
    assert!(!store.renamed("drafts", "essays").unwrap());
}

#[test]
fn context_is_the_threads_answered_exchanges() {
    let mut store = Store::open(None);
    let (t, _) = store
        .start(
            New::default(),
            Role::Owner,
            Draft::said("First question", vec![]),
        )
        .unwrap();
    let kin = |store: &mut Store, text: &str, answers: Vec<u64>, interrupted| {
        store
            .append(
                &t.id,
                Role::Kin,
                Draft {
                    text: text.into(),
                    answers,
                    interrupted,
                    ..Draft::default()
                },
            )
            .unwrap()
    };
    kin(&mut store, "First answer", vec![1], false);
    store
        .append(&t.id, Role::Owner, Draft::said("Second", vec![]))
        .unwrap();
    store
        .append(&t.id, Role::Owner, Draft::said("and third", vec![]))
        .unwrap();
    kin(&mut store, "Half an ans", vec![3, 4], true);
    kin(&mut store, "Both answered", vec![3, 4], false);
    assert_eq!(
        store
            .context(&t.id, HISTORY_PAIRS)
            .into_iter()
            .map(|r| r.items)
            .collect::<Vec<_>>(),
        [
            vec![
                super::super::wire::Item::User("First question".into()),
                super::super::wire::Item::Assistant {
                    text: "First answer".into(),
                    calls: vec![]
                }
            ],
            vec![
                super::super::wire::Item::User("Second\n\nand third".into()),
                super::super::wire::Item::Assistant {
                    text: "Both answered".into(),
                    calls: vec![]
                }
            ],
        ]
    );
    assert_eq!(store.context(&t.id, 1).len(), 1);
    assert_eq!(store.context(&t.id, 1)[0].heard, ["Second", "and third"]);
    assert_eq!(store.last_said(&t.id).unwrap().text, "and third");
}

#[test]
fn recent_tool_results_survive_reopen_and_history_stays_within_budget() {
    use crate::ai::context::{HISTORY_BYTES, Replay, TOOL_TURNS};
    use crate::ai::wire::{Item, ToolCall, ToolResult};
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(Some(dir.path().into()));
    let chip = Chip {
        kind: "paragraph".into(),
        path: "drafts/x.md".into(),
        label: Some("a pointed-at paragraph".into()),
        lines: Some([9, 9]),
    };
    let (thread, _) = store
        .start(
            New::default(),
            Role::Owner,
            Draft::said("First", vec![chip.clone()]),
        )
        .unwrap();
    for n in 0..8 {
        let asked = if n == 0 {
            1
        } else {
            store
                .append(
                    &thread.id,
                    Role::Owner,
                    Draft::said(&format!("Question {n}"), vec![chip.clone()]),
                )
                .unwrap()
                .seq
        };
        let replay = Replay {
            items: vec![
                Item::User(crate::ai::context::question(
                    &format!("Question {n}"),
                    std::slice::from_ref(&chip),
                )),
                Item::Assistant {
                    text: String::new(),
                    calls: vec![ToolCall {
                        id: format!("read-{n}"),
                        name: "read".into(),
                        arguments: json!({"path":"drafts/x.md"}),
                    }],
                },
                Item::Results(vec![ToolResult {
                    call_id: format!("read-{n}"),
                    content: format!(
                        "<data tool=\"read\">{} whole paragraph end {n}</data>",
                        "x".repeat(36_000)
                    ),
                    is_error: false,
                }]),
                Item::Assistant {
                    text: format!("Answer {n}"),
                    calls: vec![],
                },
            ],
            ..Default::default()
        };
        store
            .append(
                &thread.id,
                Role::Kin,
                Draft {
                    text: format!("Answer {n}"),
                    answers: vec![asked],
                    replay: Some(replay),
                    ..Default::default()
                },
            )
            .unwrap();
    }
    let reopened = Store::open(Some(dir.path().into()));
    let history = reopened.context(&thread.id, HISTORY_PAIRS);
    assert!(history.iter().map(Replay::bytes).sum::<usize>() <= HISTORY_BYTES);
    let tool_turns = history
        .iter()
        .filter(|h| h.items.iter().any(|i| matches!(i, Item::Results(_))))
        .count();
    assert!(tool_turns > 0 && tool_turns <= TOOL_TURNS);
    assert!(history.last().unwrap().items.iter().any(
        |i| matches!(i, Item::Results(r) if r[0].content.ends_with("whole paragraph end 7</data>"))
    ));
    for turn in &history {
        assert!(
            matches!(&turn.items[0], Item::User(s) if s.contains("\"lines\":[9,9]")),
            "old questions keep their chips"
        );
        for pair in turn.items.windows(2) {
            if let Item::Results(results) = &pair[1] {
                assert!(
                    matches!(&pair[0], Item::Assistant { calls, .. } if calls.len() == results.len() && calls[0].id == results[0].call_id)
                );
            }
        }
    }
}

#[test]
fn failed_turns_keep_tool_emitted_web_provenance_but_not_links_from_kin_prose() {
    let mut store = Store::open(None);
    let (thread, owner) = store
        .start(
            New::default(),
            Role::Owner,
            Draft::said("Find a source", vec![]),
        )
        .unwrap();
    store
        .append(
            &thread.id,
            Role::Kin,
            Draft {
                text: "Try https://invented.example/private".into(),
                answers: vec![owner.seq],
                error: Some("Provider failed after searching".into()),
                web: vec![crate::ai::web::WebCall {
                    tool: "search".into(),
                    query: Some("kiln".into()),
                    provider: None,
                    results: vec![crate::ai::web::Source {
                        url: "https://source.example/article".into(),
                        title: "A source".into(),
                        snippet: None,
                        date: None,
                        favicon: None,
                    }],
                }],
                ..Default::default()
            },
        )
        .unwrap();
    let context = store.context(&thread.id, HISTORY_PAIRS);
    assert!(
        context.iter().all(|c| c.items.is_empty()),
        "failed replies aren't replayed"
    );
    let guard = context.last().unwrap().provenance.as_ref().unwrap();
    assert!(
        guard
            .may_fetch(&reqwest::Url::parse("https://source.example/article").unwrap())
            .is_ok()
    );
    assert!(
        guard
            .may_fetch(&reqwest::Url::parse("https://invented.example/private").unwrap())
            .is_err()
    );
}
