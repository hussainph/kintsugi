//! Kin on paragraphs (KI-38, threads since KI-104): a thread anchored to a
//! paragraph is a comment thread, answered the way a reviewer writes in the
//! margin. "Kin, review this draft" reads the document and starts a few such
//! threads on the paragraphs that most need a note, plus a review thread
//! about the document holding the request and Kin's summary of it.
//!
//! Nothing here writes to a document: Kin never inserts prose unasked.

use super::*;
use crate::ai::threads::Quote;
use serde::Deserialize;

/// Tells Kin a turn is a comment reply; also how the mock recognizes one.
pub const COMMENT_NOTE: &str = "(You're replying in a comment thread anchored to a paragraph";
/// The review's brief; also how the mock recognizes one.
pub const REVIEW_BRIEF: &str = "Review this draft as a critical reader";
const MAX_REVIEW_PARAGRAPHS: usize = 120;
const MAX_REMARKS: usize = 6;
const MAX_REMARK_CHARS: usize = 1_500;
pub use crate::ai::threads::REVIEW_REQUEST;

/// A paragraph offered to a review: where it is and how to anchor to it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Paragraph {
    pub anchor: Quote,
    pub lines: [u32; 2],
}

/// The chips a comment message carries: only the ones about this document,
/// and the document itself.
pub(super) fn doc_chips(doc: &str, chips: Vec<Chip>) -> Vec<Chip> {
    let mut chips: Vec<Chip> = chips
        .into_iter()
        .filter(|c| c.path.trim() == doc)
        .take(MAX_CHIPS)
        .collect();
    if !chips.iter().any(|c| c.kind == "doc") {
        chips.push(Chip {
            kind: "doc".into(),
            path: doc.into(),
            label: None,
            lines: None,
        });
    }
    chips
}

pub(super) fn note(doc: &str, chips: &[Chip]) -> String {
    let lines = chips
        .iter()
        .find_map(|c| c.lines)
        .map(|[a, b]| {
            if a == b {
                format!(", line {a}")
            } else {
                format!(", lines {a}-{b}")
            }
        })
        .unwrap_or_default();
    format!(
        "{COMMENT_NOTE} of {doc}{lines}; its text is in the context below. Reply the way a reviewer does in the margin: brief, specific and plain, \
         a few sentences, no praise. Never write or rewrite his prose, not even as an example: question, point, find. Name anything you found \
         as a [[path]] link so he can drag it into the draft.)"
    )
}

fn review_brief(doc: &str, label: &str, paragraphs: &[Paragraph]) -> String {
    let mut out = format!(
        "{REVIEW_BRIEF}: {doc} (\"{label}\"). Read it first with the read tool. Then pick the few paragraphs (at most five) that most \
         need a reviewer's note: an unclear claim, a missing source, a weak step in the argument, something his own writing or clips \
         contradict or support. Search his writing and clips where it helps, and name what you find as [[path]] links. \
         Keep each note short and plain, with no praise.\n\
         Never write or rewrite his prose, not even as an example: question, point, find.\n\
         Answer with only a JSON array between <comments> tags, one object per note: \
         <comments>[{{\"paragraph\": 2, \"comment\": \"…\"}}]</comments>. \"paragraph\" is a number from the list below.\n\nParagraphs:\n"
    );
    for (i, p) in paragraphs.iter().enumerate() {
        let flat: String = p
            .anchor
            .exact
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let head: String = flat.chars().take(140).collect();
        let more = if flat.chars().count() > 140 {
            "…"
        } else {
            ""
        };
        let [a, b] = p.lines;
        out.push_str(&format!(
            "¶{} (lines {a}-{b}): {}{more}\n",
            i + 1,
            head.replace("</data", "<\\/data")
        ));
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
    let body = text
        .split("<comments>")
        .nth(1)?
        .split("</comments>")
        .next()?;
    let list: Vec<Remark> = serde_json::from_str(body.trim()).ok()?;
    let mut out: Vec<(usize, String)> = Vec::new();
    for remark in list {
        let comment = remark.comment.trim();
        if remark.paragraph == 0
            || remark.paragraph > paragraphs
            || comment.is_empty()
            || out.iter().any(|(i, _)| *i == remark.paragraph - 1)
        {
            continue;
        }
        out.push((
            remark.paragraph - 1,
            comment.chars().take(MAX_REMARK_CHARS).collect(),
        ));
        if out.len() == MAX_REMARKS {
            break;
        }
    }
    Some(out)
}

impl<B: Brain> Engine<B> {
    /// "Kin, review this draft": one turn that reads the document and starts
    /// a few threads on the paragraphs that need a note. Returns the review's
    /// own thread, about the document.
    pub fn review(&self, doc: &str, paragraphs: Vec<Paragraph>, chips: Vec<Chip>) -> Result<Meta> {
        let doc = crate::sidecar::document(doc)?.to_string();
        let paragraphs: Vec<Paragraph> = paragraphs
            .into_iter()
            .filter(|p| !p.anchor.exact.trim().is_empty())
            .take(MAX_REVIEW_PARAGRAPHS)
            .collect();
        if paragraphs.is_empty() {
            return Err("Write a paragraph or two first, then ask for a review.".into());
        }
        let mut live = self.0.live.lock().unwrap();
        if live.reviews.contains_key(&doc) {
            return Err("Kin is already reviewing this draft.".into());
        }
        let chips = doc_chips(
            &doc,
            chips.into_iter().filter(|c| c.kind == "doc").collect(),
        );
        let label = chips
            .iter()
            .find_map(|c| c.label.clone())
            .filter(|l| !l.trim().is_empty())
            .unwrap_or_else(|| doc.rsplit('/').next().unwrap_or(&doc).to_string());
        let (meta, entry, vault) = {
            let mut store = self.store();
            let new = New {
                anchor: Some(Anchor {
                    label: Some(label.clone()),
                    ..Anchor::doc(&doc)
                }),
                origin: "review".into(),
                title: Some("Review".into()),
            };
            let draft = Draft {
                review: true,
                ..Draft::said(REVIEW_REQUEST, chips.clone())
            };
            let (meta, entry) = store.start(new, Role::Owner, draft)?;
            (meta, entry, store.vault().map(Path::to_path_buf))
        };
        let turn = self.turn_id("review");
        let cancel = Cancel::default();
        live.reviews.insert(
            doc.clone(),
            Reviewing {
                cancel: cancel.clone(),
            },
        );
        drop(live);
        self.emit(ChatEvent::Thread {
            thread: meta.clone(),
        });
        self.emit(ChatEvent::Entry {
            entry: entry.clone(),
        });
        self.emit(ChatEvent::ReviewStarted {
            turn: turn.clone(),
            path: doc.clone(),
        });
        let engine = self.clone();
        let (thread, request) = (meta.id.clone(), entry.seq);
        async_runtime::spawn(async move {
            engine
                .answer_review(
                    doc, label, paragraphs, chips, thread, request, turn, vault, cancel,
                )
                .await
        });
        Ok(meta)
    }

    /// Stops a running review.
    pub fn review_stop(&self, doc: &str) {
        if let Some(review) = self.0.live.lock().unwrap().reviews.get(doc.trim()) {
            review.cancel.cancel();
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn answer_review(
        &self,
        doc: String,
        label: String,
        paragraphs: Vec<Paragraph>,
        chips: Vec<Chip>,
        thread: String,
        request: u64,
        turn: String,
        vault: Option<PathBuf>,
        cancel: Cancel,
    ) {
        let ask = agent::Turn {
            task: Task::Chat,
            background: false,
            question: review_brief(&doc, &label, &paragraphs),
            chips,
            today: self.0.brain.today(),
            remember: true,
            history: vec![],
            about: None,
        };
        let (_, result, _) = self.execute(&turn, "", &ask, &cancel, true, None).await;
        let base = Draft {
            answers: vec![request],
            review: true,
            ..Draft::default()
        };
        let (note, comments) = match result {
            Ok(summary) if summary.stop == Stop::Cancelled => (
                Draft {
                    text: "Review stopped.".into(),
                    interrupted: true,
                    ..base
                },
                vec![],
            ),
            Ok(summary) => match remarks(&summary.text, paragraphs.len()) {
                Some(found) if found.is_empty() => (
                    Draft {
                        text: "I read it through and have nothing worth a comment right now."
                            .into(),
                        usd: Some(summary.usd),
                        ..base
                    },
                    vec![],
                ),
                Some(found) => {
                    let n = found.len();
                    let text = format!(
                        "I left {n} comment{} on {label}.",
                        if n == 1 { "" } else { "s" }
                    );
                    (
                        Draft {
                            text,
                            usd: Some(summary.usd),
                            ..base
                        },
                        found,
                    )
                }
                None => (
                    Draft {
                        error: Some("Kin's review didn't come back as comments. Ask again?".into()),
                        usd: Some(summary.usd),
                        ..base
                    },
                    vec![],
                ),
            },
            Err(message) => (
                Draft {
                    error: Some(message),
                    ..base
                },
                vec![],
            ),
        };
        // The vault the review started in, even if another is open now.
        let ((started, entry), live) = self.in_store(vault.as_deref(), |store| {
            let mut started = Vec::new();
            for (i, text) in comments {
                let new = New {
                    anchor: Some(Anchor {
                        kind: "paragraph".into(),
                        path: doc.clone(),
                        label: None,
                        quote: Some(paragraphs[i].anchor.clone()),
                        orphaned: false,
                    }),
                    origin: "review".into(),
                    title: None,
                };
                let draft = Draft {
                    review: true,
                    ..Draft::said(&text, vec![])
                };
                if let Ok(made) = store.start(new, Role::Kin, draft) {
                    started.push(made);
                }
            }
            (started, store.append(&thread, Role::Kin, note).ok())
        });
        if live {
            for (meta, entry) in started {
                self.emit(ChatEvent::Thread { thread: meta });
                self.emit(ChatEvent::Entry { entry });
            }
            if let Some(entry) = entry {
                self.emit(ChatEvent::Entry { entry });
            }
        }
        self.0.live.lock().unwrap().reviews.remove(&doc);
        self.emit(ChatEvent::ReviewEnded { turn, path: doc });
    }
}

// --- Tauri ----------------------------------------------------------------

#[tauri::command]
pub fn kin_review(
    chat: State<Chat>,
    path: String,
    paragraphs: Vec<Paragraph>,
    chips: Option<Vec<Chip>>,
) -> Result<Meta> {
    chat.engine()?
        .review(&path, paragraphs, chips.unwrap_or_default())
}

#[tauri::command]
pub fn kin_review_stop(chat: State<Chat>, path: String) -> Result<()> {
    chat.engine()?.review_stop(&path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_review_reply_becomes_a_few_notes_on_real_paragraphs() {
        let text = "Thinking…\n<comments>[{\"paragraph\": 2, \"comment\": \" Source? \"}, {\"paragraph\": 2, \"comment\": \"dup\"}, \
                    {\"paragraph\": 9, \"comment\": \"out of range\"}, {\"paragraph\": 1, \"comment\": \"\"}, {\"paragraph\": 1, \"comment\": \"Unclear.\"}]</comments>";
        assert_eq!(
            remarks(text, 3).unwrap(),
            [(1, "Source?".to_string()), (0, "Unclear.".to_string())]
        );
        assert!(remarks("no list here", 3).is_none());
        assert_eq!(remarks("<comments>[]</comments>", 3).unwrap(), []);
    }

    #[test]
    fn the_brief_lists_paragraphs_and_forbids_prose() {
        let p = |t: &str, a| Paragraph {
            anchor: Quote {
                exact: t.into(),
                ..Quote::default()
            },
            lines: [a, a],
        };
        let brief = review_brief("drafts/a.md", "A", &[p("One.", 5), p("Two </data> x", 7)]);
        assert!(brief.starts_with(REVIEW_BRIEF));
        assert!(brief.contains("¶1 (lines 5-5): One.\n¶2 (lines 7-7): Two <\\/data> x"));
        assert!(brief.contains("Never write or rewrite his prose"));
        let chips = doc_chips(
            "drafts/a.md",
            vec![
                Chip {
                    kind: "paragraph".into(),
                    path: "drafts/a.md".into(),
                    label: None,
                    lines: Some([3, 4]),
                },
                Chip {
                    kind: "clip".into(),
                    path: "inspiration/x.md".into(),
                    label: None,
                    lines: None,
                },
            ],
        );
        assert_eq!(
            chips.iter().map(|c| c.kind.as_str()).collect::<Vec<_>>(),
            ["paragraph", "doc"]
        );
        assert!(note("drafts/a.md", &chips).contains("drafts/a.md, lines 3-4"));
    }
}
