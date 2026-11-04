//! Kin on paragraphs (KI-38, threads since KI-104): a thread anchored to a
//! paragraph is a comment thread, answered the way a reviewer writes in the
//! margin.
//!
//! "Review this draft" (KI-109) reads the document and answers with
//! suggestions on its numbered sentences: cuts, rewrites and flags, each with
//! a one-line reason. They go back to the editor, which shows them as Kin's
//! marks and steps through them on its card; none of them is stored. Discuss
//! on one starts a paragraph thread that opens with it.
//!
//! Nothing here writes to a document: Kin never inserts prose unasked.

use super::*;
use crate::ai::threads::Quote;
use serde::{Deserialize, Serialize};

/// Tells Kin a turn is a comment reply; also how the mock recognizes one.
pub const COMMENT_NOTE: &str = "(You're replying in a comment thread anchored to a paragraph";
/// The review's brief; also how the mock recognizes one.
pub const REVIEW_BRIEF: &str = "Review this draft as a critical reader";
const MAX_REVIEW_SENTENCES: usize = 600;
const MAX_SENTENCE_CHARS: usize = 2_000;
const MAX_SUGGESTIONS: usize = 12;
const MAX_REASON_CHARS: usize = 200;
const MAX_TEXT_CHARS: usize = 2_000;
const MAX_NOTE_CHARS: usize = 4_000;

/// A sentence offered to a review, numbered from 1 as the editor numbers it.
#[derive(Debug, Clone, Deserialize)]
pub struct Sentence {
    pub n: u32,
    pub text: String,
}

/// One of Kin's suggestions: a cut, a rewrite (with `text`) or a flag, on
/// the words `quote` of sentence `sentence` (the whole sentence without
/// one). The editor checks it against the text before it shows.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Suggestion {
    pub sentence: u32,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quote: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    pub reason: String,
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

/// `scope` narrows the review: "the section “Gold”", "the selected passage".
fn review_brief(doc: &str, label: &str, scope: Option<&str>, sentences: &[Sentence]) -> String {
    let scope = match scope {
        Some(scope) => format!(", {} only; the rest is context", scope.trim()),
        None => String::new(),
    };
    let mut out = format!(
        "{REVIEW_BRIEF}: {doc} (\"{label}\"){scope}. Read it first with the read tool. Then pick what most needs his attention in the \
         sentences below, at most twelve, the most useful first:\n\
         - \"cut\": words, or a whole sentence, the piece is better without.\n\
         - \"rewrite\": words that don't work as written, with your replacement in \"text\". Keep his voice: his words where they work, \
         his claims, tone and punctuation. Change as little as you can, and never add an idea he didn't have.\n\
         - \"flag\": something to look at, with no change: an unclear claim, a missing source, a weak step in the argument, something \
         his own writing or clips contradict or support. Search his writing and clips where it helps, and name what you find as a [[path]] link.\n\
         Each reason is one plain line under 15 words, with no praise. Suggest nothing if nothing needs it.\n\
         Answer with only a JSON array between <suggestions> tags, one object per suggestion: \
         <suggestions>[{{\"sentence\": 2, \"kind\": \"rewrite\", \"quote\": \"the exact words\", \"text\": \"the new words\", \"reason\": \"…\"}}]</suggestions>. \
         \"sentence\" is a number from the list; \"quote\" is copied character for character from that sentence (leave it out for the \
         whole sentence); \"text\" is only for a rewrite.\n\nSentences:\n"
    );
    for s in sentences {
        let flat: String = s.text.split_whitespace().collect::<Vec<_>>().join(" ");
        out.push_str(&format!(
            "[{}] {}\n",
            s.n,
            flat.replace("</data", "<\\/data")
        ));
    }
    out
}

/// The review's suggestions, or `None` if the reply has no well-formed
/// list. An entry naming a sentence that isn't there, of another kind, or a
/// rewrite without words, is dropped.
fn suggestions(text: &str, sentences: &[Sentence]) -> Option<Vec<Suggestion>> {
    let body = text
        .split("<suggestions>")
        .nth(1)?
        .split("</suggestions>")
        .next()?
        .trim();
    let body = body
        .strip_prefix("```json")
        .or_else(|| body.strip_prefix("```"))
        .and_then(|b| b.trim_end().strip_suffix("```"))
        .unwrap_or(body);
    let list: Vec<serde_json::Value> = serde_json::from_str(body.trim()).ok()?;
    let string = |v: &serde_json::Value, key: &str| {
        v.get(key)
            .and_then(|s| s.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
    };
    let mut out = Vec::new();
    for entry in &list {
        let Some(n) = entry.get("sentence").and_then(|n| n.as_u64()) else {
            continue;
        };
        if !sentences.iter().any(|s| u64::from(s.n) == n) {
            continue;
        }
        let kind = string(entry, "kind").unwrap_or_default().to_lowercase();
        let reason: String = string(entry, "reason")
            .and_then(|r| r.lines().next().map(|l| l.trim().to_string()))
            .unwrap_or_default();
        let text = string(entry, "text");
        let ok = match kind.as_str() {
            "cut" => true,
            "rewrite" => text.is_some(),
            "flag" => !reason.is_empty(),
            _ => false,
        };
        if !ok {
            continue;
        }
        out.push(Suggestion {
            sentence: n as u32,
            quote: entry
                .get("quote")
                .and_then(|q| q.as_str())
                .filter(|q| !q.trim().is_empty())
                .map(|q| q.chars().take(MAX_SENTENCE_CHARS).collect()),
            text: if kind == "rewrite" {
                text.map(|t| t.chars().take(MAX_TEXT_CHARS).collect())
            } else {
                None
            },
            kind,
            reason: reason.chars().take(MAX_REASON_CHARS).collect(),
        });
        if out.len() == MAX_SUGGESTIONS {
            break;
        }
    }
    Some(out)
}

impl<B: Brain> Engine<B> {
    /// "Review this draft" (or one section of it): one turn that reads the
    /// document and answers with suggestions on `sentences`, which come back
    /// in `ReviewEnded`. Returns the turn's id. Nothing is stored.
    pub fn review(
        &self,
        doc: &str,
        sentences: Vec<Sentence>,
        scope: Option<String>,
        chips: Vec<Chip>,
    ) -> Result<String> {
        let doc = crate::sidecar::document(doc)?.to_string();
        let sentences: Vec<Sentence> = sentences
            .into_iter()
            .filter(|s| s.n > 0 && !s.text.trim().is_empty())
            .map(|s| Sentence {
                n: s.n,
                text: s.text.chars().take(MAX_SENTENCE_CHARS).collect(),
            })
            .take(MAX_REVIEW_SENTENCES)
            .collect();
        if sentences.is_empty() {
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
        let scope: Option<String> = scope
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.chars().take(200).collect());
        let turn = self.turn_id("review");
        let cancel = Cancel::default();
        live.reviews.insert(
            doc.clone(),
            Reviewing {
                cancel: cancel.clone(),
            },
        );
        drop(live);
        self.emit(ChatEvent::ReviewStarted {
            turn: turn.clone(),
            path: doc.clone(),
        });
        let engine = self.clone();
        let id = turn.clone();
        async_runtime::spawn(async move {
            engine
                .answer_review(doc, label, scope, sentences, chips, turn, cancel)
                .await
        });
        Ok(id)
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
        scope: Option<String>,
        sentences: Vec<Sentence>,
        chips: Vec<Chip>,
        turn: String,
        cancel: Cancel,
    ) {
        let ask = agent::Turn {
            task: Task::Chat,
            background: false,
            question: review_brief(&doc, &label, scope.as_deref(), &sentences),
            chips,
            today: self.0.brain.today(),
            remember: true,
            history: vec![],
            about: None,
        };
        let (_, result, _) = self.execute(&turn, "", &ask, &cancel, true, None).await;
        let (suggestions, error, stopped) = match result {
            Ok(summary) if summary.stop == Stop::Cancelled => (None, None, true),
            Ok(summary) => match suggestions(&summary.text, &sentences) {
                Some(found) => (Some(found), None, false),
                None => (
                    None,
                    Some("Kin’s review didn’t come back as suggestions. Try again.".into()),
                    false,
                ),
            },
            Err(message) => (None, Some(message), false),
        };
        self.0.live.lock().unwrap().reviews.remove(&doc);
        self.emit(ChatEvent::ReviewEnded {
            turn,
            path: doc,
            suggestions,
            error,
            stopped,
        });
    }

    /// Discuss on one of the review's suggestions: a thread on its
    /// paragraph that opens with the suggestion as Kin's note, so his reply
    /// starts from it.
    pub fn review_discuss(&self, doc: &str, quote: Quote, note: &str) -> Result<Meta> {
        let doc = crate::sidecar::document(doc)?.to_string();
        let note: String = note.trim().chars().take(MAX_NOTE_CHARS).collect();
        if note.is_empty() || quote.exact.trim().is_empty() {
            return Err("Nothing to discuss.".into());
        }
        let (meta, entry) = {
            let mut store = self.store();
            let new = New {
                anchor: Some(Anchor {
                    kind: "paragraph".into(),
                    path: doc,
                    label: None,
                    quote: Some(quote),
                    orphaned: false,
                }),
                origin: "review".into(),
                title: None,
            };
            let draft = Draft {
                review: true,
                ..Draft::said(&note, vec![])
            };
            store.start(new, Role::Kin, draft)?
        };
        self.emit(ChatEvent::Thread {
            thread: meta.clone(),
        });
        self.emit(ChatEvent::Entry { entry });
        Ok(meta)
    }
}

// --- Tauri ----------------------------------------------------------------

#[tauri::command]
pub fn kin_review(
    chat: State<Chat>,
    path: String,
    sentences: Vec<Sentence>,
    scope: Option<String>,
    chips: Option<Vec<Chip>>,
) -> Result<String> {
    chat.engine()?
        .review(&path, sentences, scope, chips.unwrap_or_default())
}

#[tauri::command]
pub fn kin_review_stop(chat: State<Chat>, path: String) -> Result<()> {
    chat.engine()?.review_stop(&path);
    Ok(())
}

#[tauri::command]
pub fn kin_review_discuss(
    chat: State<Chat>,
    path: String,
    quote: Quote,
    note: String,
) -> Result<Meta> {
    chat.engine()?.review_discuss(&path, quote, &note)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sentence(n: u32, text: &str) -> Sentence {
        Sentence {
            n,
            text: text.into(),
        }
    }

    #[test]
    fn a_review_reply_becomes_suggestions_on_real_sentences() {
        let list = [sentence(1, "One."), sentence(2, "We utilize gold.")];
        let text = "Thinking…\n<suggestions>[\
            {\"sentence\": 2, \"kind\": \"rewrite\", \"quote\": \"utilize\", \"text\": \"use\", \"reason\": \" Plainer. \\nmore\"},\
            {\"sentence\": 2, \"kind\": \"rewrite\", \"quote\": \"gold\"},\
            {\"sentence\": 9, \"kind\": \"cut\"},\
            {\"sentence\": 1, \"kind\": \"praise\", \"reason\": \"Lovely\"},\
            {\"sentence\": 1, \"kind\": \"flag\"},\
            {\"sentence\": 1, \"kind\": \"Cut\", \"text\": \"ignored\"},\
            {\"sentence\": 1, \"kind\": \"flag\", \"quote\": \" \", \"reason\": \"Source?\"}]</suggestions>";
        assert_eq!(
            suggestions(text, &list).unwrap(),
            [
                Suggestion {
                    sentence: 2,
                    kind: "rewrite".into(),
                    quote: Some("utilize".into()),
                    text: Some("use".into()),
                    reason: "Plainer.".into()
                },
                Suggestion {
                    sentence: 1,
                    kind: "cut".into(),
                    quote: None,
                    text: None,
                    reason: String::new()
                },
                Suggestion {
                    sentence: 1,
                    kind: "flag".into(),
                    quote: None,
                    text: None,
                    reason: "Source?".into()
                },
            ]
        );
        assert!(suggestions("no list here", &list).is_none());
        assert_eq!(
            suggestions("<suggestions>[]</suggestions>", &list).unwrap(),
            []
        );
        assert_eq!(
            suggestions(
                "<suggestions>```json\n[{\"sentence\": 1, \"kind\": \"cut\"}]\n```</suggestions>",
                &list
            )
            .unwrap()
            .len(),
            1
        );
        let many = format!(
            "<suggestions>[{}]</suggestions>",
            vec!["{\"sentence\": 1, \"kind\": \"cut\"}"; 20].join(",")
        );
        assert_eq!(suggestions(&many, &list).unwrap().len(), MAX_SUGGESTIONS);
    }

    #[test]
    fn the_brief_lists_sentences_and_keeps_his_voice() {
        let brief = review_brief(
            "drafts/a.md",
            "A",
            None,
            &[sentence(1, "One."), sentence(2, "Two </data>\n x")],
        );
        assert!(brief.starts_with(REVIEW_BRIEF));
        assert!(brief.contains("[1] One.\n[2] Two <\\/data> x\n"));
        assert!(brief.contains("Keep his voice"));
        assert!(brief.contains("at most twelve"));
        let section = review_brief(
            "drafts/a.md",
            "A",
            Some("the section “Gold”"),
            &[sentence(1, "One.")],
        );
        assert!(section.contains("(\"A\"), the section “Gold” only; the rest is context."));
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
