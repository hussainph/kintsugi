//! A scripted stand-in for a model, for headless runs only
//! (`KINTSUGI_HEADLESS_KIN=mock`). It never calls out and costs nothing,
//! but it exercises the real loop: it reads the first chip (a document,
//! clip or Feed item as `feed:<id>`) or searches,
//! then answers slowly, word by word, so interrupting and batching can be
//! seen and tested in a browser tab.
//!
//! Ideas briefs (KI-39) get a scripted helper too: it searches, reads the
//! top documents and offers ideas whose quotes are copied from what it read,
//! plus one with a made-up quote, which the grounding checks must drop.

use super::ModelRef;
use super::agent::Model;
use super::chat::{COMMENT_NOTE, REVIEW_BRIEF};
use super::wire::{Exchange, Item, Reply, ToolCall, Usage};
use super::writing::Tone;
use serde_json::json;
use std::time::Duration;

type Result<T> = std::result::Result<T, String>;

const WORD_DELAY: Duration = Duration::from_millis(70);
/// How long the mock "thinks" when asked to (KI-79).
const THINKING: Duration = Duration::from_millis(3_000);

pub struct Scripted {
    model: ModelRef,
}

impl Default for Scripted {
    fn default() -> Self {
        // Priced as a local model: free.
        Scripted {
            model: ModelRef {
                provider: "ollama".into(),
                model: "kin-headless-mock".into(),
                reasoning: None,
            },
        }
    }
}

/// The owner's words from a user message, without the dynamic context.
fn said(message: &str) -> &str {
    message
        .split("\n\n<context>")
        .next()
        .unwrap_or(message)
        .trim()
}

/// The first on-screen chip that's a vault path or a Feed item.
fn first_chip(message: &str) -> Option<String> {
    let context = message
        .split("On screen (read these if they matter):")
        .nth(1)?;
    context
        .lines()
        .skip(1)
        .take_while(|l| l.starts_with("- "))
        .find_map(|line| {
            let path = line[2..].split_whitespace().nth(1)?;
            (path.starts_with("feed:") || path.ends_with(".md") || path.ends_with(".mdx"))
                .then(|| path.to_string())
        })
}

const EDIT: &[&str] = &["tighten", "rewrite", "edit"];

/// Whether he used one of these words (or a longer form: "thinking").
fn asks(asked: &str, words: &[&str]) -> bool {
    asked
        .split(|c: char| !c.is_alphanumeric())
        .any(|w| words.iter().any(|word| w.starts_with(word)))
}

/// Whether his message starts with one of these words: "Tighten this", not
/// "Who disagrees? Don't rewrite it."
fn leads_with(asked: &str, words: &[&str]) -> bool {
    asked
        .split(|c: char| !c.is_alphanumeric())
        .find(|w| !w.is_empty())
        .is_some_and(|w| words.iter().any(|word| w.starts_with(word)))
}

/// The first paragraph chip: its document and line range.
fn paragraph_chip(message: &str) -> Option<(String, u64, u64)> {
    let context = message
        .split("On screen (read these if they matter):")
        .nth(1)?;
    context.lines().skip(1).find_map(|line| {
        let rest = line
            .strip_prefix("- paragraph ")
            .or_else(|| line.strip_prefix("- selection "))?;
        let mut words = rest.split_whitespace();
        let path = words.next()?.to_string();
        let (from, to) = words.nth(1)?.split_once('-')?;
        Some((path, from.parse().ok()?, to.parse().ok()?))
    })
}

fn longest_word(said: &str) -> &str {
    said.split(|c: char| !c.is_alphanumeric())
        .max_by_key(|w| w.len())
        .unwrap_or("kintsugi")
}

/// This turn's items: everything after his newest message.
fn this_turn(items: &[Item]) -> &[Item] {
    let start = items
        .iter()
        .rposition(|i| matches!(i, Item::User(_)))
        .map_or(0, |at| at + 1);
    &items[start..]
}

/// The tool results of the newest step, as they came back.
fn last_results(items: &[Item]) -> Vec<&str> {
    match items.last() {
        Some(Item::Results(results)) => results.iter().map(|r| r.content.as_str()).collect(),
        _ => vec![],
    }
}

/// "Compare …" (KI-79): after a search and a list in one step, read the
/// first two documents the search found, together.
fn compare_reads(question: &str, items: &[Item]) -> Option<Vec<ToolCall>> {
    if !leads_with(&said(question).to_lowercase(), &["compare"]) {
        return None;
    }
    let steps = this_turn(items)
        .iter()
        .filter(|i| matches!(i, Item::Assistant { .. }))
        .count();
    if steps != 1 {
        return None;
    }
    let found = last_results(items).first()?.to_string();
    let paths: Vec<String> = found
        .split("\"id\":")
        .skip(1)
        .filter_map(|rest| rest.trim_start().strip_prefix('"')?.split('"').next())
        .filter(|id| id.ends_with(".md") || id.ends_with(".mdx"))
        .take(2)
        .map(String::from)
        .collect();
    (!paths.is_empty()).then(|| {
        paths
            .into_iter()
            .enumerate()
            .map(|(i, path)| ToolCall {
                id: format!("mock-{}", 3 + i),
                name: "read".into(),
                arguments: json!({ "path": path, "limit": 20 }),
            })
            .collect()
    })
}

/// "Tighten this" on a paragraph (KI-79): the passage it read, with filler
/// words dropped (else its last sentence), as an edit block he can apply.
fn proposed_edit(question: &str, items: &[Item]) -> Option<String> {
    if !leads_with(&said(question).to_lowercase(), EDIT) {
        return None;
    }
    let (path, ..) = paragraph_chip(question)?;
    let content = last_results(items).into_iter().next()?;
    let body = content.split_once('\n')?.1;
    let passage: Vec<&str> = body
        .lines()
        .skip(1)
        .filter_map(|l| {
            let (n, text) = l.split_once(": ")?;
            n.trim().parse::<u64>().ok().map(|_| text)
        })
        .collect();
    let old = passage.join("\n").trim().to_string();
    if old.is_empty() {
        return None;
    }
    const FILLER: [&str; 6] = ["really", "very", "just", "actually", "quite", "basically"];
    let mut new = old
        .split(' ')
        .filter(|w| {
            !FILLER.contains(
                &w.to_lowercase()
                    .trim_matches(|c: char| !c.is_alphanumeric()),
            )
        })
        .collect::<Vec<_>>()
        .join(" ");
    if new == old {
        let sentences: Vec<&str> = old.split_inclusive(". ").collect();
        new = if sentences.len() > 1 {
            sentences[..sentences.len() - 1].concat().trim().to_string()
        } else {
            format!("{} (mock edit)", old.trim_end_matches('.'))
        };
    }
    Some(format!(
        "This version is shorter and keeps your point.\n\n```edit {path}\n<<<<<<< SEARCH\n{old}\n=======\n{new}\n>>>>>>> REPLACE\n```\n\n(Headless mock model; nothing was sent to a provider.)"
    ))
}

/// "The main points" (KI-79): an answer in Markdown, naming what it read.
fn points(items: &[Item]) -> String {
    let path = this_turn(items)
        .iter()
        .find_map(|i| match i {
            Item::Assistant { calls, .. } => calls
                .iter()
                .find_map(|c| c.arguments["path"].as_str().map(String::from)),
            _ => None,
        })
        .unwrap_or_else(|| "drafts/kintsugi-and-gold.md".into());
    format!(
        "Three things carry it:\n\n\
         1. **The bowl.** The opening rests on one object, and it's a good one.\n\
         2. **The repair.** You say it twice, in the second and the last paragraph. Keep one.\n\
         3. **The cost.** Nobody pays for anything yet, so the ending reads light.\n\n\
         From `{path}`. Compare [[golden-joinery]] for the part about lacquer.\n\n\
         > The repair is not hidden.\n\n\
         (Headless mock model; nothing was sent to a provider.)"
    )
}

/// The Feed's story summary (KI-94), from the articles in the prompt: a
/// paragraph per article (up to four, so long summaries get tested), each
/// sentence citing it; plus a sentence with no citation and one citing an
/// article that isn't there, which the Feed must drop. "mock-fail" in an
/// article makes it answer with no JSON at all. Its lead sentences follow
/// the tone in `system` (KI-102).
pub(crate) fn story_summary(system: &str, prompt: &str) -> String {
    let tone = Tone::in_prompt(system).unwrap_or_default();
    let articles: Vec<(String, String, String, String)> = prompt
        .split("<article id=\"")
        .skip(1)
        .filter_map(|part| {
            let (id, rest) = part.split_once('"')?;
            let source = rest.split("source=\"").nth(1)?.split('"').next()?;
            let body = rest.split_once('\n')?.1;
            let title = body.lines().next()?.trim_start_matches("Title: ").trim();
            let text = body
                .lines()
                .skip(1)
                .take_while(|l| !l.starts_with("</article>"))
                .collect::<Vec<_>>()
                .join(" ");
            let first = text
                .split(". ")
                .next()
                .unwrap_or_default()
                .trim()
                .trim_end_matches('.');
            Some((id.into(), source.into(), title.into(), first.into()))
        })
        .collect();
    if articles.is_empty() || prompt.contains("mock-fail") {
        return "Sorry, I couldn't summarise that.".into();
    }
    let mut paragraphs: Vec<serde_json::Value> = articles
        .iter()
        .take(4)
        .map(|(id, source, title, first)| {
            let mut sentences =
                vec![json!({ "text": story_lead(tone, source, title), "cite": [id] })];
            if !first.is_empty() {
                sentences.push(json!({ "text": format!("{first}."), "cite": [id] }));
            }
            json!(sentences)
        })
        .collect();
    paragraphs.push(json!([
        { "text": "This sentence cites nothing.", "cite": [] },
        { "text": "This one cites an article that isn't there.", "cite": ["A99"] }
    ]));
    json!({ "title": articles[0].2, "paragraphs": paragraphs }).to_string()
}

/// A story's first sentence about one article, in a tone.
fn story_lead(tone: Tone, source: &str, title: &str) -> String {
    let title = title.trim_end_matches(['.', '!', '?']);
    match tone {
        Tone::Plain => format!("{source} reports: {title}."),
        Tone::Editorial => format!("{title}, {source} reports."),
        Tone::Casual => format!("I read it in {source} first: {title}."),
        Tone::Dry => format!("{source}: {title}."),
    }
}

fn reply(text: String, calls: Vec<ToolCall>) -> Reply {
    Reply {
        text,
        calls,
        usage: Usage {
            input: 0,
            output: 0,
            cache_read: 0,
            cache_write: 0,
        },
        stop_reason: None,
        reasoning: vec![],
    }
}

/// The stash scenario reads its draft and stash, searches the vault, then
/// exercises the actual narrow writer with an idea and an anchored rewrite.
fn stash_step(question: &str, items: &[Item]) -> (String, Vec<ToolCall>) {
    let doc = first_chip(question).unwrap_or_default();
    let steps = this_turn(items)
        .iter()
        .filter(|i| matches!(i, Item::Assistant { .. }))
        .count();
    let call = |name: &str, arguments| ToolCall {
        id: format!("mock-stash-{steps}"),
        name: name.into(),
        arguments,
    };
    if steps == 0 {
        return (
            String::new(),
            vec![call("read", json!({ "path": doc, "limit": 80 }))],
        );
    }
    let read = this_turn(items)
        .iter()
        .find_map(|item| match item {
            Item::Results(results) => results
                .iter()
                .find(|r| r.call_id == "mock-stash-0")
                .map(|r| r.content.as_str()),
            _ => None,
        })
        .unwrap_or_default();
    let mut in_frontmatter = false;
    let mut passage = None;
    for line in read.lines() {
        let Some((n, text)) = line.split_once(": ") else {
            continue;
        };
        let Ok(n) = n.parse::<u32>() else {
            continue;
        };
        if n == 1 && text == "---" {
            in_frontmatter = true;
            continue;
        }
        if in_frontmatter {
            if text == "---" {
                in_frontmatter = false;
            }
            continue;
        }
        if !text.trim().is_empty() && !text.starts_with('#') {
            passage = Some((n, text));
            break;
        }
    }
    if steps == 1 {
        let query = longest_word(passage.map_or("writing", |(_, text)| text));
        return (
            String::new(),
            vec![call("search", json!({ "query": query, "k": 3 }))],
        );
    }
    if steps == 2 {
        let found = last_results(items).first().copied().unwrap_or_default();
        let hit = found
            .split("\"id\":")
            .skip(1)
            .filter_map(|s| s.trim_start().strip_prefix('"')?.split('"').next())
            .find(|id| id.ends_with(".md") || id.ends_with(".mdx"))
            .unwrap_or(&doc);
        let mut proposals = vec![
            json!({ "kind": "idea", "text": format!("Compare the draft with [[{}]].", hit.trim_end_matches(".mdx").trim_end_matches(".md")) }),
        ];
        if let Some((line, exact)) = passage {
            let revised = edit(
                "",
                &[super::wire::Message {
                    role: super::wire::Role::User,
                    content: format!("<passage>{exact}</passage>"),
                }],
            );
            let revised = if revised == exact {
                format!("Another version: {exact}")
            } else {
                revised
            };
            proposals.push(json!({ "kind": "rewrite", "text": revised, "anchor": { "exact": exact, "prefix": "", "suffix": "", "line": line } }));
        }
        return (
            String::new(),
            vec![call("stash_add", json!({ "items": proposals }))],
        );
    }
    ("Added suggestions to the stash.".into(), vec![])
}

impl Model for Scripted {
    fn model(&self) -> &ModelRef {
        &self.model
    }

    async fn send(
        &self,
        ex: &Exchange<'_>,
        on_text: &mut (dyn FnMut(&str) + Send),
    ) -> Result<Reply> {
        let Some(question) = ex.items.iter().rev().find_map(|i| match i {
            Item::User(text) => Some(text.as_str()),
            _ => None,
        }) else {
            return Err("nothing to answer".into());
        };
        if ex.system.starts_with(crate::feed::STORY_SUMMARIZER) {
            let text = story_summary(ex.system, question);
            on_text(&text);
            return Ok(reply(text, vec![]));
        }
        if let Some(Item::User(brief)) = ex.items.first()
            && brief.contains(super::ideas::brief::FORMAT)
        {
            let (text, calls) = ideas::step(ex.system, brief, ex.items);
            on_text(&text);
            return Ok(reply(text, calls));
        }
        if question.starts_with(super::stash::BRIEF) {
            let (text, calls) = stash_step(question, ex.items);
            on_text(&text);
            return Ok(reply(text, calls));
        }
        if question.contains(COMMENT_NOTE) || question.starts_with(REVIEW_BRIEF) {
            return Ok(comments::step(question, ex.items, on_text).await);
        }
        let text = if let Some(Item::User(message)) = ex.items.last() {
            // First step of a turn: look something up.
            let asked = said(message).to_lowercase();
            // The chat's design scenarios (KI-79), by what he asked.
            if leads_with(&asked, &["timeout"]) {
                tokio::time::sleep(Duration::from_millis(1_500)).await;
                return Err("Mock stopped responding (nothing for 120 s)".into());
            }
            if leads_with(&asked, &["fail"]) {
                return Err("Mock: 500 Internal Server Error".into());
            }
            if leads_with(&asked, &["think"]) {
                // A reasoning model, thinking before it says or calls anything.
                tokio::time::sleep(THINKING).await;
            }
            if let Some((path, from, to)) =
                paragraph_chip(message).filter(|_| leads_with(&asked, EDIT))
            {
                let call = ToolCall {
                    id: "mock-1".into(),
                    name: "read".into(),
                    arguments: json!({ "path": path, "offset": from, "limit": to + 1 - from }),
                };
                return Ok(reply(String::new(), vec![call]));
            }
            if leads_with(&asked, &["compare"]) {
                // What to compare: the longest word after "compare".
                let word = longest_word(
                    said(message)
                        .split_once(|c: char| c.is_whitespace())
                        .map_or(said(message), |(_, rest)| rest),
                );
                let calls = vec![
                    ToolCall {
                        id: "mock-1".into(),
                        name: "search".into(),
                        arguments: json!({ "query": word }),
                    },
                    ToolCall {
                        id: "mock-2".into(),
                        name: "list".into(),
                        arguments: json!({ "path": "drafts" }),
                    },
                ];
                return Ok(reply(String::new(), calls));
            }
            let call = match first_chip(message) {
                // The web tools (KI-78): a scripted search, then a page.
                _ if ex.tools.iter().any(|t| t.name == "web_search")
                    && (asked.contains("web") || asked.contains("online")) =>
                {
                    ToolCall {
                        id: "mock-1".into(),
                        name: "web_search".into(),
                        arguments: json!({ "query": web_query(said(message)) }),
                    }
                }
                // The Feed's ranking tools, so headless runs can drive them.
                _ if said(message).to_lowercase().contains("shortlist") => ToolCall {
                    id: "mock-1".into(),
                    name: "tool".into(),
                    arguments: json!({ "name": "shortlist", "args": { "n": 5 } }),
                },
                Some(path) => ToolCall {
                    id: "mock-1".into(),
                    name: "read".into(),
                    arguments: json!({ "path": path, "limit": 20 }),
                },
                None => {
                    let word = said(message)
                        .split(|c: char| !c.is_alphanumeric())
                        .max_by_key(|w| w.len())
                        .unwrap_or("kintsugi");
                    ToolCall {
                        id: "mock-1".into(),
                        name: "search".into(),
                        arguments: json!({ "query": word }),
                    }
                }
            };
            return Ok(reply(String::new(), vec![call]));
        } else if let Some(call) = read_first_web_result(ex.items) {
            return Ok(reply(String::new(), vec![call]));
        } else if let Some(calls) = compare_reads(question, ex.items) {
            return Ok(reply(String::new(), calls));
        } else if let Some(text) = proposed_edit(question, ex.items) {
            text
        } else if asks(&said(question).to_lowercase(), &["points", "markdown"]) {
            points(ex.items)
        } else {
            let looked = ex.items.iter().rev().find_map(|i| match i {
                Item::Assistant { calls, .. } => {
                    calls.first().map(|c| format!("{} {}", c.name, c.arguments))
                }
                _ => None,
            });
            // The start of what the tool returned, so a test can see Kin got it.
            let returned = ex.items.iter().rev().find_map(|i| match i {
                Item::Results(results) => results.first().map(|r| {
                    let text = r
                        .content
                        .replace("<data tool=\"read\">", "")
                        .replace("<data tool=\"tool\">", "")
                        .replace("<data tool=\"web_fetch\">", "");
                    text.split_whitespace()
                        .collect::<Vec<_>>()
                        .join(" ")
                        .chars()
                        .take(160)
                        .collect::<String>()
                }),
                _ => None,
            });
            let earlier = ex
                .items
                .iter()
                .filter(|i| matches!(i, Item::Assistant { calls, .. } if calls.is_empty()))
                .count();
            let about = question.contains("This thread is about");
            format!(
                "You said: “{}”. I looked with {}. This thread has {earlier} earlier exchange(s){}. \
                 This reply comes from the headless mock model, so nothing was sent to a provider.{}",
                said(question)
                    .lines()
                    .filter(|l| !l.trim().is_empty())
                    .collect::<Vec<_>>()
                    .join(" / "),
                looked.unwrap_or_else(|| "nothing".into()),
                if about {
                    " and knows what it's about"
                } else {
                    ""
                },
                returned
                    .map(|r| format!(" It returned: {r}"))
                    .unwrap_or_default(),
            )
        };
        let mut words = text.split_inclusive(' ').peekable();
        while let Some(word) = words.next() {
            on_text(word);
            if words.peek().is_some() {
                tokio::time::sleep(WORD_DELAY).await;
            }
        }
        Ok(reply(text, vec![]))
    }
}

/// "Search the web for golden joinery" asks the scripted provider for
/// "golden joinery".
fn web_query(said: &str) -> String {
    let lower = said.to_lowercase();
    let mut query = said;
    for lead in [
        "search the web for",
        "search online for",
        "look up online",
        "on the web",
        "online",
        "the web",
        "web",
    ] {
        if let Some(at) = lower.find(lead)
            && let (Some(before), Some(rest)) = (said.get(..at), said.get(at + lead.len()..))
        {
            query = if rest.trim().len() > 2 {
                rest.trim()
            } else {
                before.trim()
            };
            break;
        }
    }
    let query = query.trim_matches(|c: char| !c.is_alphanumeric());
    let query = ["for ", "about "]
        .iter()
        .find_map(|lead| query.strip_prefix(lead))
        .unwrap_or(query);
    let query: String = query.chars().take(80).collect();
    if query.is_empty() {
        "kintsugi".into()
    } else {
        query
    }
}

/// After a web search, read its first result.
fn read_first_web_result(items: &[Item]) -> Option<ToolCall> {
    let Some(Item::Assistant { calls, .. }) = items.iter().rev().nth(1) else {
        return None;
    };
    if calls.first()?.name != "web_search" {
        return None;
    }
    let Some(Item::Results(results)) = items.last() else {
        return None;
    };
    let content = &results.first()?.content;
    let url = content
        .split("\"url\":\"")
        .nth(1)?
        .split('"')
        .next()?
        .to_string();
    Some(ToolCall {
        id: "mock-2".into(),
        name: "web_fetch".into(),
        arguments: json!({ "url": url }),
    })
}

/// Comment threads and reviews (KI-38): a reviewer's note that names what
/// it found as a [[link]], and a review that comments on the first and last
/// paragraphs.
mod comments {
    use super::*;

    fn found(items: &[Item]) -> Option<String> {
        items.iter().rev().find_map(|i| match i {
            Item::Results(results) => results.first().map(|r| r.content.clone()),
            _ => None,
        })
    }

    /// The thread's paragraph (else the paragraph chip's label), from the
    /// dynamic context.
    fn paragraph(question: &str) -> String {
        if let Some(text) = question
            .lines()
            .find(|l| l.starts_with("This thread is about a paragraph of"))
            .and_then(|l| l.split_once("<data>"))
            .and_then(|(_, rest)| rest.split_once("</data>"))
        {
            return text.0.to_string();
        }
        question
            .lines()
            .find(|l| l.starts_with("- paragraph "))
            .and_then(|l| l.split_once(" ("))
            .map(|(_, label)| label.trim_end_matches(')').to_string())
            .unwrap_or_default()
    }

    pub async fn step(
        question: &str,
        items: &[Item],
        on_text: &mut (dyn FnMut(&str) + Send),
    ) -> Reply {
        let review = question.starts_with(REVIEW_BRIEF);
        let first = matches!(items.last(), Some(Item::User(_)));
        if first {
            let call = if review {
                let doc = first_chip(question).unwrap_or_default();
                ToolCall {
                    id: "mock-1".into(),
                    name: "read".into(),
                    arguments: json!({ "path": doc, "limit": 40 }),
                }
            } else {
                let label = paragraph(question);
                let word = label
                    .split(|c: char| !c.is_alphanumeric())
                    .max_by_key(|w| w.len())
                    .filter(|w| w.len() > 2)
                    .unwrap_or("kintsugi")
                    .to_lowercase();
                ToolCall {
                    id: "mock-1".into(),
                    name: "search".into(),
                    arguments: json!({ "query": word }),
                }
            };
            return reply(String::new(), vec![call]);
        }
        let text = if review {
            let n = question
                .lines()
                .filter(|l| l.starts_with('¶'))
                .count()
                .max(1);
            let mut notes = vec![
                json!({ "paragraph": 1, "comment": "Mock review: the opening makes a claim without a source. What's it resting on?" }),
            ];
            if n > 1 {
                notes.push(json!({ "paragraph": n, "comment": format!("Mock review: ¶{n} ends without saying what it costs. Is that the point?") }));
            }
            format!("<comments>{}</comments>", serde_json::Value::Array(notes))
        } else {
            let doc = first_chip(question).unwrap_or_default();
            let said = said(question)
                .split(COMMENT_NOTE)
                .next()
                .unwrap_or_default()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            // The first search hit that isn't this document, as a link to drag in.
            let hit = found(items).and_then(|data| {
                data.split("\"id\":")
                    .skip(1)
                    .filter_map(|rest| rest.trim_start().strip_prefix('"')?.split('"').next())
                    .find(|id| *id != doc && !id.starts_with("feed:"))
                    .map(String::from)
            });
            let link = hit
                .map(|id| {
                    format!(
                        " Compare [[{}]].",
                        id.trim_end_matches(".mdx").trim_end_matches(".md")
                    )
                })
                .unwrap_or_else(|| " I found nothing to compare it with.".into());
            format!(
                "Mock note: you asked “{said}”. This paragraph leans on one example, so the whole claim rests on a single case.{link} (Headless mock model; nothing was sent to a provider.)"
            )
        };
        for word in text.split_inclusive(' ') {
            on_text(word);
            tokio::time::sleep(WORD_DELAY).await;
        }
        reply(text, vec![])
    }
}

/// The scripted Ideas helper.
mod ideas {
    use super::super::ideas::brief::CURRENT;
    use super::super::wire::{Item, ToolCall};
    use super::super::writing::Tone;
    use serde_json::{Value, json};

    fn call(n: usize, name: &str, arguments: Value) -> ToolCall {
        ToolCall {
            id: format!("mock-{n}"),
            name: name.into(),
            arguments,
        }
    }

    /// The `<data>` body of every tool result so far, newest last.
    fn results(items: &[Item]) -> Vec<String> {
        items
            .iter()
            .filter_map(|i| match i {
                Item::Results(r) => Some(
                    r.iter()
                        .filter(|r| !r.is_error)
                        .map(|r| r.content.clone())
                        .collect::<Vec<_>>(),
                ),
                _ => None,
            })
            .flatten()
            .map(|c| {
                c.split_once('\n')
                    .map_or(c.as_str(), |(_, rest)| rest)
                    .trim_end_matches("</data>")
                    .to_string()
            })
            .collect()
    }

    fn after<'a>(text: &'a str, marker: &str) -> Option<&'a str> {
        text.split_once(marker)
            .map(|(_, rest)| rest.lines().next().unwrap_or_default().trim())
    }

    /// A read file: its path, title and quotable sentences.
    struct Read {
        path: String,
        title: String,
        sentences: Vec<String>,
    }

    fn parse_read(content: &str) -> Option<Read> {
        let (head, body) = content.split_once('\n')?;
        let path = head.split(", lines").next()?.trim().to_string();
        let lines: Vec<&str> = body
            .lines()
            .filter_map(|l| l.split_once(": ").map(|(_, t)| t))
            .collect();
        let mut title = path.rsplit('/').next().unwrap_or(&path).to_string();
        let mut in_front = lines.first().is_some_and(|l| l.trim() == "---");
        let mut sentences = Vec::new();
        for (i, line) in lines.iter().enumerate() {
            if in_front {
                if i > 0 && line.trim() == "---" {
                    in_front = false;
                } else if let Some(t) = line.strip_prefix("title:") {
                    title = t.trim().trim_matches('"').to_string();
                }
                continue;
            }
            let line = line.trim().trim_start_matches('>').trim();
            if line.starts_with('#')
                || line.starts_with("<!--")
                || line.contains("[[")
                || line.ends_with('…')
            {
                continue;
            }
            // The first full sentence on the line, copied as it is.
            let sentence = match line.find(". ") {
                Some(end) => &line[..=end],
                None => line,
            };
            if (24..=220).contains(&sentence.chars().count()) && sentence.ends_with('.') {
                sentences.push(sentence.to_string());
            }
        }
        (!sentences.is_empty()).then_some(Read {
            path,
            title,
            sentences,
        })
    }

    fn refine(brief: &str) -> String {
        let asked = brief
            .split("He asked: \"")
            .nth(1)
            .and_then(|r| r.split('"').next())
            .unwrap_or("Sharper");
        let current = brief.split(CURRENT).nth(1).and_then(|r| {
            let start = r.find('{')?;
            let mut depth = 0;
            for (i, c) in r[start..].char_indices() {
                match c {
                    '{' => depth += 1,
                    '}' => {
                        depth -= 1;
                        if depth == 0 {
                            return serde_json::from_str::<Value>(&r[start..=start + i]).ok();
                        }
                    }
                    _ => {}
                }
            }
            None
        });
        let Some(mut idea) = current else {
            return "<ideas>[]</ideas>".into();
        };
        let title = idea["title"].as_str().unwrap_or_default().to_string();
        let short: String = asked.chars().take(30).collect();
        idea["title"] = json!(
            format!("{short}: {title}")
                .chars()
                .take(110)
                .collect::<String>()
        );
        idea["snippet"] = json!(format!("Reworked after you asked for “{short}”."));
        format!(
            "<ideas>\n{}\n</ideas>",
            serde_json::to_string_pretty(&idea).unwrap_or_default()
        )
    }

    // The mock's words for an idea, in each tone (KI-102).

    fn connection_title(tone: Tone, a: &Read, b: &Read) -> String {
        let (a, b) = (&a.title, &b.title);
        match tone {
            Tone::Plain => format!("{a} and {b} ask the same question"),
            Tone::Editorial => format!("{a} sets up what {b} answers"),
            Tone::Casual => format!("I think {a} and {b} are one question"),
            Tone::Dry => format!("{a} and {b} overlap"),
        }
    }

    fn connection_hunch(tone: Tone, a: &Read, b: &Read) -> String {
        let (a, b) = (&a.title, &b.title);
        match tone {
            Tone::Plain => {
                format!("There may be one piece here that {a} sets up [1] and {b} answers [2].")
            }
            Tone::Editorial => format!(
                "{a} poses the question [1] and {b} answers it [2]. Read together, they make a single post."
            ),
            Tone::Casual => format!(
                "{a} sets something up [1] that {b} gets round to answering [2]. I'd put them in one post."
            ),
            Tone::Dry => format!("{a} asks [1]. {b} answers [2]."),
        }
    }

    fn gap_title(tone: Tone, b: &Read) -> String {
        let b = &b.title;
        match tone {
            Tone::Plain => format!(
                "You keep returning to {} without writing it down",
                b.to_lowercase()
            ),
            Tone::Editorial => format!("{b} keeps coming up, and there's no post on it"),
            Tone::Casual => format!(
                "You keep circling {} and haven't written it up",
                b.to_lowercase()
            ),
            Tone::Dry => format!("{b} has no post yet"),
        }
    }

    fn gap_hunch(tone: Tone, b: &Read) -> String {
        let b = &b.title;
        match tone {
            Tone::Plain => format!("A short post could say plainly what {b} only hints at [2]."),
            Tone::Editorial => {
                format!("{b} hints at an argument [2] that no post of yours makes yet.")
            }
            Tone::Casual => {
                format!("You hint at this in {b} [2]. A short post could say it straight.")
            }
            Tone::Dry => format!("{b} hints at it [2]. Nothing published says it."),
        }
    }

    fn snippet(tone: Tone, a: &Read, b: &Read, query: &str) -> String {
        let (a, b) = (&a.title, &b.title);
        match tone {
            Tone::Plain => format!("{a} and {b} came up together when I searched for “{query}”."),
            Tone::Editorial => format!("A search for “{query}” turned up {a} beside {b}."),
            Tone::Casual => format!("I searched for “{query}” and got {a} and {b} back together."),
            Tone::Dry => format!("Both came up for “{query}”."),
        }
    }

    fn batch(brief: &str, query: &str, reads: &[Read]) -> String {
        let tone = Tone::in_prompt(brief).unwrap_or_default();
        let about = after(brief, "every idea is about one document: ")
            .map(|a| a.trim_end_matches('.').to_string());
        let mut ideas = Vec::new();
        let pairs: Vec<(usize, usize)> = match reads.len() {
            0 | 1 => vec![],
            2 => vec![(0, 1)],
            _ => vec![(0, 1), (1, 2)],
        };
        for (n, (i, j)) in pairs.into_iter().enumerate() {
            let (a, b) = (&reads[i], &reads[j]);
            let (kind, title, hunch) = if n == 0 {
                (
                    "connection",
                    connection_title(tone, a, b),
                    connection_hunch(tone, a, b),
                )
            } else {
                ("gap", gap_title(tone, b), gap_hunch(tone, b))
            };
            ideas.push(json!({
                "kind": kind,
                "title": title,
                "draftTitle": if n == 0 { format!("What {} answers", b.title) } else { b.title.clone() },
                "snippet": snippet(tone, a, b, query),
                "observed": [format!("{} and {} both turned up for “{query}” [1][2].", a.path, b.path), format!("Neither links to the other.")],
                "hunch": hunch,
                "quotes": [{ "source": a.path, "text": a.sentences[0] }, { "source": b.path, "text": b.sentences.get(1).unwrap_or(&b.sentences[0]) }],
                "about": about.iter().cloned().chain([a.path.clone(), b.path.clone()]).collect::<Vec<_>>(),
            }));
        }
        if reads.len() >= 2 {
            ideas.push(json!({
                "kind": "tension",
                "title": "An idea resting on a quote the mock invented",
                "snippet": "This one must never reach the list.",
                "observed": ["A fact."],
                "hunch": "A guess.",
                "quotes": [{ "source": reads[0].path, "text": reads[0].sentences[0] }, { "source": reads[1].path, "text": "This sentence was invented by the headless mock and is in no file." }],
            }));
        }
        format!(
            "<ideas>\n{}\n</ideas>",
            serde_json::to_string_pretty(&Value::Array(ideas)).unwrap_or_default()
        )
    }

    /// One step of the scripted helper: tool calls, or the final JSON.
    pub fn step(_system: &str, brief: &str, items: &[Item]) -> (String, Vec<ToolCall>) {
        if brief.contains(CURRENT) {
            return (refine(brief), vec![]);
        }
        let about = after(brief, "every idea is about one document: ")
            .map(|a| a.trim_end_matches('.').to_string());
        let query = after(brief, "He asked for ideas about: ")
            .and_then(|f| {
                f.split(|c: char| !c.is_alphanumeric())
                    .filter(|w| w.len() > 3)
                    .max_by_key(|w| w.len())
            })
            .map(str::to_string)
            .unwrap_or_else(|| {
                // A new subject for each round, so "more" isn't a repeat.
                let offered = brief.split("Already offered lately").nth(1).map_or(0, |r| {
                    r.split("\n\n")
                        .next()
                        .unwrap_or_default()
                        .lines()
                        .filter(|l| l.starts_with("- "))
                        .count()
                });
                ["repair", "attention", "quiet", "light"][(offered / 2) % 4].to_string()
            });
        let found = results(items);
        let reads: Vec<Read> = found
            .iter()
            .filter(|c| c.contains(", lines "))
            .filter_map(|c| parse_read(c))
            .collect();
        if !reads.is_empty() {
            return (batch(brief, &query, &reads), vec![]);
        }
        let steps = items
            .iter()
            .filter(|i| matches!(i, Item::Assistant { .. }))
            .count();
        if steps == 0 {
            return (
                String::new(),
                vec![call(1, "search", json!({ "query": query, "k": 8 }))],
            );
        }
        // Paths from the search results (or, failing those, recent documents).
        let mut paths: Vec<String> = about.into_iter().collect();
        for content in &found {
            if let Ok(Value::Array(hits)) = serde_json::from_str::<Value>(content.trim()) {
                paths.extend(
                    hits.iter()
                        .filter_map(|h| h["id"].as_str())
                        .filter(|id| !id.starts_with("feed:"))
                        .map(str::to_string),
                );
            } else {
                paths.extend(
                    content
                        .split_whitespace()
                        .filter(|w| w.ends_with(".md") || w.ends_with(".mdx"))
                        .map(str::to_string),
                );
            }
        }
        paths.dedup();
        let mut seen = Vec::new();
        paths.retain(|p| {
            !seen.contains(p) && {
                seen.push(p.clone());
                true
            }
        });
        if paths.is_empty() && steps == 1 {
            return (
                String::new(),
                vec![call(
                    2,
                    "tool",
                    json!({ "name": "recent", "args": { "limit": 5 } }),
                )],
            );
        }
        if paths.is_empty() {
            return ("<ideas>[]</ideas>".into(), vec![]);
        }
        let calls = paths
            .iter()
            .take(3)
            .enumerate()
            .map(|(i, p)| call(10 + i, "read", json!({ "path": p, "limit": 80 })))
            .collect();
        (String::new(), calls)
    }
}

#[cfg(test)]
mod tests {
    use super::super::Task;
    use super::super::agent::tests::block_on;
    use super::super::agent::{self, Cancel, Harness, Limits, Turn};
    use super::super::cost::Meter;
    use super::super::ideas::store::Store;
    use super::super::ideas::{self, VaultSources, brief};
    use super::super::jobs::{Job, Trace};
    use super::super::prompt::Memory;
    use super::super::tools::Tools;
    use super::*;
    use std::fs;

    /// The headless mock's ideas go through the real loop, tools and checks:
    /// the grounded ones land, the one with an invented quote is dropped.
    #[test]
    fn the_mock_offers_grounded_ideas_and_the_checks_drop_its_invention() {
        let vault = tempfile::tempdir().unwrap();
        let outputs = tempfile::tempdir().unwrap();
        let write = |rel: &str, text: &str| {
            let path = vault.path().join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        };
        write(
            "posts/on-craft.mdx",
            "---\ntitle: \"On craft and repair\"\n---\n\n# On craft\n\nA repair is not a cover-up. It is a record of care.\nThe practice of repair is unglamorous and slow.\n",
        );
        write(
            "notes/repair.md",
            "---\ntitle: Repair is a kind of attention\n---\n\nThe more interesting repair makes the history legible. The patch is not hidden.\nWe tend to think of repair as restoration of the old.\n",
        );
        write(
            "inspiration/golden-joinery.md",
            "---\ntitle: Golden joinery\nsite: Britannica\n---\n\n> The repair is not hidden. It is given a color of its own.\nKintsugi repair uses lacquer dusted with powdered gold.\n",
        );
        let meter = Meter::open(None);
        let tools = Tools::new(vault.path(), outputs.path().into(), "job-1").unwrap();
        let memory = Memory {
            about: vec!["Writes about craft.".into()],
            ..Memory::default()
        };
        let cancel = Cancel::default();
        let harness = Harness {
            tools: &tools,
            meter: &meter,
            memory: &memory,
            cancel: &cancel,
            limits: Limits::default(),
        };
        let text = brief::batch(
            &brief::Ask {
                count: 5,
                ..Default::default()
            },
            &[],
            &[],
            &[],
        );
        let turn = Turn {
            task: Task::Ideas,
            background: true,
            question: text,
            chips: vec![],
            today: "2026-11-02".into(),
            remember: true,
            history: vec![],
            about: None,
        };
        let mut trace = Trace::default();
        let summary = block_on(agent::run(
            &Scripted::default(),
            &harness,
            &turn,
            &mut |e| {
                if let agent::KinEvent::ToolCall {
                    name, arguments, ..
                } = &e
                {
                    trace.call(name, arguments);
                }
            },
        ))
        .unwrap();
        assert_eq!(trace.searches, ["repair"]);
        assert_eq!(trace.files.len(), 3);

        let mut store = Store::open(None);
        let job: Job = serde_json::from_value(json!({ "id": "job-1", "kind": "ideas", "task": "ideas", "brief": "b", "status": "running", "created": "2026-11-02T09:00:00+00:00" })).unwrap();
        let sources = VaultSources {
            root: vault.path(),
            feed: None,
        };
        let now = chrono::DateTime::parse_from_rfc3339("2026-11-02T09:00:00+00:00").unwrap();
        let report = ideas::finish_batch(
            &mut store,
            &sources,
            &memory.about,
            &job,
            &summary.text,
            &trace,
            now,
        )
        .unwrap();
        assert!(
            report.starts_with("2 new ideas in Ideas")
                && report.contains(
                    "“An idea resting on a quote the mock invented”, because a quote isn't in"
                ),
            "{report}"
        );
        let listed = store.list(now);
        assert_eq!(listed.len(), 2);
        for idea in &listed {
            assert!(idea.idea.content.quotes.len() >= 2);
            assert!(idea.idea.content.hunch.contains("[2]"), "cites inline");
        }
    }
}

/// A small vocabulary for meaningful, repeatable alternatives in scratch
/// documents. Unknown words get no suggestions rather than invented synonyms.
const SYNONYMS: &[(&str, [&str; 3])] = &[
    ("good", ["fine", "nice", "great"]),
    ("quick", ["fast", "swift", "speedy"]),
    ("important", ["significant", "key", "major"]),
    ("clear", ["plain", "direct", "explicit"]),
    ("small", ["little", "modest", "slight"]),
    ("difficult", ["hard", "tough", "challenging"]),
    ("simple", ["plain", "straightforward", "uncomplicated"]),
    ("useful", ["helpful", "practical", "handy"]),
    ("beautiful", ["lovely", "handsome", "attractive"]),
    ("visible", ["noticeable", "apparent", "in view"]),
    ("repair", ["restoration", "mend", "patch"]),
    ("quiet", ["silent", "still", "hushed"]),
    ("in order to", ["to", "so as to", "with the intent to"]), // copy-lint-allow: input phrase for the mock synonym lookup
    ("a lot of", ["plenty of", "lots of", "a great deal of"]),
    ("at the moment", ["now", "currently", "at present"]),
];

fn matching_case(original: &str, replacement: &str) -> String {
    if original
        .chars()
        .all(|c| !c.is_alphabetic() || c.is_uppercase())
    {
        replacement.to_uppercase()
    } else if original.chars().next().is_some_and(char::is_uppercase) {
        let mut chars = replacement.chars();
        let first = chars.next().unwrap_or_default();
        first.to_uppercase().to_string() + chars.as_str()
    } else {
        replacement.to_string()
    }
}

/// Reword the full passage without discarding sentences or line breaks.
fn alternative_passage(passage: &str, version: usize) -> String {
    let mut base = passage.to_string();
    for (phrase, replacements) in SYNONYMS.iter().filter(|(phrase, _)| phrase.contains(' ')) {
        base = base.replace(phrase, replacements[version]);
    }
    base.split_inclusive(|c: char| !c.is_alphabetic())
        .map(|piece| {
            let word = piece.trim_end_matches(|c: char| !c.is_alphabetic());
            let lower = word.to_lowercase();
            if piece.strip_suffix(' ') == Some(word)
                && ["really", "very", "just", "actually", "quite", "basically"]
                    .contains(&lower.as_str())
            {
                return String::new();
            }
            if let Some((_, replacements)) = SYNONYMS.iter().find(|(key, _)| *key == lower) {
                matching_case(word, replacements[version]) + &piece[word.len()..]
            } else {
                piece.to_string()
            }
        })
        .collect()
}

fn alternatives(level: &str, passage: &str) -> String {
    let original = passage.trim();
    let candidates: Vec<String> = match level {
        "word" | "phrase" => SYNONYMS
            .iter()
            .find(|(word, _)| *word == original.to_lowercase())
            .map(|(_, replacements)| {
                replacements
                    .iter()
                    .map(|s| matching_case(original, s))
                    .collect()
            })
            .unwrap_or_default(),
        "sentence" | "paragraph" => (0..3)
            .map(|version| alternative_passage(original, version))
            .collect(),
        _ => vec![],
    };
    let mut choices = Vec::new();
    for candidate in candidates {
        if !candidate.trim().is_empty() && candidate != original && !choices.contains(&candidate) {
            choices.push(candidate);
        }
    }
    json!(choices).to_string()
}

/// The webview's ⌘K edits (and `/` skills) in a mock run: a deterministic
/// edit of `<passage>`, so a diff can be reviewed without a provider. It
/// drops filler words; KI-87 alternatives use JSON, older synonyms keep
/// their line list; retried edits say which attempt this is.
pub fn edit(system: &str, messages: &[super::wire::Message]) -> String {
    use super::wire::Role;
    let first = messages
        .iter()
        .find(|m| matches!(m.role, Role::User))
        .map(|m| m.content.as_str())
        .unwrap_or_default();
    let passage = first
        .split("<passage>")
        .nth(1)
        .and_then(|rest| rest.split("</passage>").next())
        .unwrap_or_default();
    if system.contains("JSON array of up to 3 distinct strings")
        && let Some(level) = first
            .split_once("<alternatives level=\"")
            .and_then(|(_, rest)| rest.split_once("\">"))
            .map(|(level, _)| level)
    {
        return alternatives(level, passage);
    }
    if system.contains("alternatives") {
        let word = passage.trim();
        return format!("{word} (mock one)\n{word} (mock two)\n{word} (mock three)");
    }
    const FILLER: [&str; 6] = ["really", "very", "just", "actually", "quite", "basically"];
    let mut out: Vec<&str> = passage
        .split(' ')
        .filter(|w| {
            !FILLER.contains(
                &w.to_lowercase()
                    .trim_matches(|c: char| !c.is_alphanumeric()),
            )
        })
        .collect();
    let retries = messages
        .iter()
        .filter(|m| matches!(m.role, Role::Assistant))
        .count();
    let tag;
    if retries > 0 {
        tag = format!("(mock version {})", retries + 1);
        out.push(&tag);
    }
    out.join(" ").trim().to_string()
}

#[cfg(test)]
mod edit_tests {
    use super::super::wire::{Message, Role};
    use super::edit;

    fn ask(passage: &str) -> Vec<Message> {
        vec![Message {
            role: Role::User,
            content: format!(
                "<context_before></context_before>\n<passage>{passage}</passage>\n<context_after></context_after>\n\nTighten."
            ),
        }]
    }

    #[test]
    fn mock_edits_drop_filler_and_vary_on_retry() {
        assert_eq!(
            edit("rewrite", &ask("It was really very good.")),
            "It was good."
        );
        let mut retry = ask("Plain words.");
        retry.push(Message {
            role: Role::Assistant,
            content: "Plain words.".into(),
        });
        retry.push(Message {
            role: Role::User,
            content: "Give me a different version.".into(),
        });
        assert_eq!(edit("rewrite", &retry), "Plain words. (mock version 2)");
        assert_eq!(
            edit("Reply with up to six alternatives", &ask("gold")),
            "gold (mock one)\ngold (mock two)\ngold (mock three)"
        );
    }

    fn alternative_choices(level: &str, passage: &str) -> Vec<String> {
        let mut messages = ask(passage);
        messages[0].content = format!(
            "<alternatives level=\"{level}\">\n{}\n</alternatives>",
            messages[0].content
        );
        let answer = edit(
            "Reply only with a JSON array of up to 3 distinct strings",
            &messages,
        );
        assert_eq!(
            answer,
            edit(
                "Reply only with a JSON array of up to 3 distinct strings",
                &messages
            ),
            "the same request is deterministic"
        );
        serde_json::from_str(&answer).expect("one JSON string array, not a line list")
    }

    #[test]
    fn mock_word_and_phrase_alternatives_are_synonyms() {
        assert_eq!(
            alternative_choices("word", "quick"),
            ["fast", "swift", "speedy"]
        );
        assert_eq!(
            alternative_choices("word", "Quick"),
            ["Fast", "Swift", "Speedy"]
        );
        assert_eq!(
            alternative_choices("word", "QUICK"),
            ["FAST", "SWIFT", "SPEEDY"]
        );
        assert_eq!(
            alternative_choices("phrase", "  in order to  "),
            ["to", "so as to", "with the intent to"]
        );
        assert!(alternative_choices("word", "unknown").is_empty());
    }

    #[test]
    fn mock_sentence_alternatives_reword_the_whole_sentence() {
        assert_eq!(
            alternative_choices("sentence", "It was really very good."),
            ["It was fine.", "It was nice.", "It was great."]
        );
        assert_eq!(
            alternative_choices("sentence", "Adjust it in order to make it useful."),
            [
                "Adjust it to make it helpful.",
                "Adjust it so as to make it practical.",
                "Adjust it with the intent to make it handy.",
            ]
        );
    }

    #[test]
    fn mock_paragraph_alternatives_keep_every_sentence_and_line_break() {
        let choices = alternative_choices("paragraph", "It was really good.\nKeep **every** mark.");
        assert_eq!(
            choices,
            [
                "It was fine.\nKeep **every** mark.",
                "It was nice.\nKeep **every** mark.",
                "It was great.\nKeep **every** mark.",
            ]
        );
    }

    #[test]
    fn mock_alternatives_exclude_unchanged_and_duplicate_passages() {
        assert!(alternative_choices("paragraph", "Keep every mark.").is_empty());
        assert!(alternative_choices("sentence", "").is_empty());
        assert_eq!(
            alternative_choices("sentence", "It was really here."),
            ["It was here."]
        );
        assert!(alternative_choices("other", "good").is_empty());
    }
}

#[cfg(test)]
mod web_tests {
    use super::super::Task;
    use super::super::agent::tests::block_on;
    use super::super::agent::{self, Cancel, Harness, KinEvent, Limits, Turn};
    use super::super::cost::Meter;
    use super::super::prompt::Memory;
    use super::super::tools::Tools;
    use super::super::web::Web;
    use super::*;
    use std::sync::Arc;

    /// KI-78: the mock searches the web (scripted results, no network),
    /// reads the first result, and the results reach the events the chat
    /// keeps as sources.
    #[test]
    fn the_mock_searches_the_web_and_reads_the_first_result() {
        let vault = tempfile::tempdir().unwrap();
        let outputs = tempfile::tempdir().unwrap();
        let meter = Meter::open(None);
        let tools = Tools::new(vault.path(), outputs.path().into(), "t")
            .unwrap()
            .with_web(Arc::new(Web::scripted()));
        let memory = Memory::default();
        let cancel = Cancel::default();
        let harness = Harness {
            tools: &tools,
            meter: &meter,
            memory: &memory,
            cancel: &cancel,
            limits: Limits::default(),
        };
        let turn = Turn {
            task: Task::Chat,
            background: false,
            question: "Search the web for golden joinery".into(),
            chips: vec![],
            today: "2026-11-03".into(),
            remember: true,
            history: vec![],
            about: None,
        };
        let mut events = vec![];
        let summary = block_on(agent::run(
            &Scripted::default(),
            &harness,
            &turn,
            &mut |e| events.push(e),
        ))
        .unwrap();
        let calls: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                KinEvent::ToolCall {
                    name, arguments, ..
                } => Some((name.clone(), arguments.clone())),
                _ => None,
            })
            .collect();
        assert_eq!(
            calls[0],
            ("web_search".into(), json!({ "query": "golden joinery" }))
        );
        assert_eq!(
            calls[1],
            (
                "web_fetch".into(),
                json!({ "url": "https://en.wikipedia.org/wiki/golden-joinery" })
            )
        );
        let web: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                KinEvent::ToolResult {
                    web: Some(call), ..
                } => Some(call.tool.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(web, ["search", "fetch"]);
        assert!(
            summary
                .text
                .contains("It returned: # Mock page at en.wikipedia.org"),
            "{}",
            summary.text
        );

        // Without web tools, the mock never asks for them.
        let plain = Tools::new(vault.path(), outputs.path().into(), "t2").unwrap();
        let harness = Harness {
            tools: &plain,
            ..harness
        };
        let mut names = vec![];
        block_on(agent::run(
            &Scripted::default(),
            &harness,
            &turn,
            &mut |e| {
                if let KinEvent::ToolCall { name, .. } = e {
                    names.push(name);
                }
            },
        ))
        .unwrap();
        assert_eq!(names, ["search"]);
    }
}

#[cfg(test)]
mod scenario_tests {
    use super::super::Task;
    use super::super::agent::tests::block_on;
    use super::super::agent::{self, Cancel, Harness, KinEvent, Limits, Turn};
    use super::super::cost::Meter;
    use super::super::prompt::{Chip, Memory};
    use super::super::tools::Tools;
    use super::*;
    use std::fs;

    fn run(
        vault: &std::path::Path,
        question: &str,
        chips: Vec<Chip>,
    ) -> (Vec<String>, Result<agent::Summary>) {
        let outputs = tempfile::tempdir().unwrap();
        let meter = Meter::open(None);
        let tools = Tools::new(vault, outputs.path().into(), "t").unwrap();
        let memory = Memory::default();
        let cancel = Cancel::default();
        let harness = Harness {
            tools: &tools,
            meter: &meter,
            memory: &memory,
            cancel: &cancel,
            limits: Limits::default(),
        };
        let turn = Turn {
            task: Task::Chat,
            background: false,
            question: question.into(),
            chips,
            today: "2026-11-03".into(),
            remember: true,
            history: vec![],
            about: None,
        };
        let mut calls = vec![];
        let summary = block_on(agent::run(
            &Scripted::default(),
            &harness,
            &turn,
            &mut |e| {
                if let KinEvent::ToolCall { name, .. } = e {
                    calls.push(name);
                }
            },
        ));
        (calls, summary)
    }

    fn vault() -> tempfile::TempDir {
        let vault = tempfile::tempdir().unwrap();
        fs::create_dir_all(vault.path().join("drafts")).unwrap();
        fs::create_dir_all(vault.path().join("notes")).unwrap();
        fs::write(
            vault.path().join("drafts/a.md"),
            "# A\n\nRepair is really slow work.\n",
        )
        .unwrap();
        fs::write(vault.path().join("notes/b.md"), "# B\n\nRepair, again.\n").unwrap();
        vault
    }

    /// KI-79: "compare" runs two tools in one step, then reads two documents.
    #[test]
    fn compare_runs_several_tools_in_a_turn() {
        let vault = vault();
        let (calls, summary) = run(vault.path(), "Compare my notes about repair", vec![]);
        assert_eq!(calls, ["search", "list", "read", "read"]);
        assert!(summary.unwrap().text.starts_with("You said"));
    }

    /// KI-79: "tighten" on a paragraph proposes an edit block of its lines.
    #[test]
    fn tighten_proposes_an_edit() {
        let vault = vault();
        let chip = Chip {
            kind: "paragraph".into(),
            path: "drafts/a.md".into(),
            label: None,
            lines: Some([3, 3]),
        };
        let (calls, summary) = run(vault.path(), "Tighten this", vec![chip]);
        assert_eq!(calls, ["read"]);
        let text = summary.unwrap().text;
        assert!(
            text.contains("```edit drafts/a.md\n<<<<<<< SEARCH\nRepair is really slow work.\n=======\nRepair is slow work.\n>>>>>>> REPLACE\n```"),
            "{text}"
        );
    }

    /// KI-79: "fail" and "timeout" fail like a provider would.
    #[test]
    fn fail_and_timeout_are_errors() {
        let vault = vault();
        let (_, failed) = run(vault.path(), "Fail on purpose", vec![]);
        assert!(failed.unwrap_err().contains("500"));
        let (_, stalled) = run(vault.path(), "Timeout on purpose", vec![]);
        assert!(stalled.unwrap_err().contains("stopped responding"));
    }
}

/// KI-102: what the mock writes passes the slop lint, in every tone, and
/// is the output frozen in `writing/corpus/kin/` (the corpus `pnpm test`
/// lints). `KINTSUGI_RECORD_WRITING=1` records it again.
#[cfg(test)]
mod writing_tests {
    use super::super::Task;
    use super::super::agent::tests::block_on;
    use super::super::agent::{self, Cancel, Harness, Limits, Turn};
    use super::super::chat::{COMMENT_NOTE, REVIEW_BRIEF};
    use super::super::cost::Meter;
    use super::super::ideas::store::Store;
    use super::super::ideas::{self, VaultSources, brief};
    use super::super::jobs::{Job, Trace};
    use super::super::prompt::{Chip, Memory};
    use super::super::tools::Tools;
    use super::super::wire::{Exchange, Message, Role};
    use super::super::writing::{
        Tone,
        lint::{Sample, freeze},
    };
    use super::*;
    use std::fs;
    use std::path::Path;

    fn vault() -> tempfile::TempDir {
        let vault = tempfile::tempdir().unwrap();
        for (rel, text) in [
            (
                "posts/on-craft.mdx",
                "---\ntitle: \"On craft and repair\"\n---\n\n# On craft\n\nA repair is not a cover-up. It is a record of care.\nThe practice of repair is unglamorous and slow.\n",
            ),
            (
                "notes/repair.md",
                "---\ntitle: Repair is a kind of attention\n---\n\nThe more interesting repair makes the history legible. The patch is not hidden.\nWe tend to think of repair as restoration of the old.\n",
            ),
            (
                "inspiration/golden-joinery.md",
                "---\ntitle: Golden joinery\nsite: Britannica\n---\n\n> The repair is not hidden. It is given a color of its own.\nKintsugi repair uses lacquer dusted with powdered gold.\n",
            ),
            (
                "drafts/bowl.md",
                "# The bowl\n\nThe bowl broke along an old line.\n\nI glued it on a Sunday and it held for a year.\n\nThen it broke again, somewhere new.\n",
            ),
        ] {
            let path = vault.path().join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        }
        vault
    }

    /// One turn through the real loop, tools and all.
    fn turn(vault: &Path, task: Task, question: String, chips: Vec<Chip>) -> (String, Trace) {
        let outputs = tempfile::tempdir().unwrap();
        let meter = Meter::open(None);
        let tools = Tools::new(vault, outputs.path().into(), "job-1").unwrap();
        let memory = Memory::default();
        let cancel = Cancel::default();
        let harness = Harness {
            tools: &tools,
            meter: &meter,
            memory: &memory,
            cancel: &cancel,
            limits: Limits::default(),
        };
        let turn = Turn {
            task,
            background: task == Task::Ideas,
            question,
            chips,
            today: "2026-11-04".into(),
            remember: true,
            history: vec![],
            about: None,
        };
        let mut trace = Trace::default();
        let summary = block_on(agent::run(
            &Scripted::default(),
            &harness,
            &turn,
            &mut |e| {
                if let agent::KinEvent::ToolCall {
                    name, arguments, ..
                } = &e
                {
                    trace.call(name, arguments);
                }
            },
        ))
        .unwrap();
        (summary.text, trace)
    }

    fn sample(kind: &str, tone: Option<Tone>, text: String) -> Sample {
        Sample {
            from: "mock".into(),
            kind: kind.into(),
            tone: tone.map(|t| t.id().into()),
            text,
        }
    }

    /// The ideas the mock offers in each tone, as their cards read: title,
    /// snippet, hunch and what Kin observed.
    #[test]
    fn mock_ideas() {
        let vault = vault();
        let mut samples = Vec::new();
        let mut seen = Vec::new();
        for tone in Tone::ALL {
            let text = brief::batch(
                &brief::Ask {
                    count: 5,
                    tone,
                    ..Default::default()
                },
                &[],
                &[],
                &[],
            );
            let (reply, trace) = turn(vault.path(), Task::Ideas, text, vec![]);
            let mut store = Store::open(None);
            let job: Job = serde_json::from_value(json!({ "id": "job-1", "kind": "ideas", "task": "ideas", "brief": "b", "status": "running", "created": "2026-11-04T09:00:00+00:00" })).unwrap();
            let sources = VaultSources {
                root: vault.path(),
                feed: None,
            };
            let now = chrono::DateTime::parse_from_rfc3339("2026-11-04T09:00:00+00:00").unwrap();
            ideas::finish_batch(&mut store, &sources, &[], &job, &reply, &trace, now).unwrap();
            let listed = store.list(now);
            assert_eq!(listed.len(), 2, "{tone:?}");
            for idea in listed {
                let c = &idea.idea.content;
                seen.push(c.hunch.clone());
                let mut lines = vec![c.title.clone(), c.snippet.clone(), c.hunch.clone()];
                lines.extend(c.observed.iter().cloned());
                samples.push(sample("idea", Some(tone), lines.join("\n")));
            }
        }
        // Each tone reads differently.
        seen.sort();
        seen.dedup();
        assert_eq!(seen.len(), 8, "{seen:?}");
        freeze("mock-ideas.json", samples);
    }

    /// The chat's prose: an answer, a margin note, a review and an edit.
    /// (Threads keep no running summary since KI-104.)
    #[test]
    fn mock_chat() {
        let vault = vault();
        let mut samples = Vec::new();
        let (answer, _) = turn(
            vault.path(),
            Task::Chat,
            "What did I write about repair?".into(),
            vec![],
        );
        samples.push(sample("chat", None, answer));

        let chip = Chip {
            kind: "paragraph".into(),
            path: "drafts/bowl.md".into(),
            label: Some("I glued it on a Sunday".into()),
            lines: Some([5, 5]),
        };
        let note = format!(
            "Is this too neat?\n\n{COMMENT_NOTE} of drafts/bowl.md, line 5: the paragraph chip below. Reply the way a reviewer does.)"
        );
        let (note, _) = turn(vault.path(), Task::Chat, note, vec![chip]);
        samples.push(sample("comment", None, note));

        let review = format!(
            "{REVIEW_BRIEF}: drafts/bowl.md (\"The bowl\"). Read it first.\n\nParagraphs:\n¶1 The bowl broke along an old line.\n¶2 I glued it on a Sunday and it held for a year.\n¶3 Then it broke again, somewhere new."
        );
        let doc = Chip {
            kind: "doc".into(),
            path: "drafts/bowl.md".into(),
            label: None,
            lines: None,
        };
        let (review, _) = turn(vault.path(), Task::Chat, review, vec![doc]);
        let notes: serde_json::Value = serde_json::from_str(
            review
                .split("<comments>")
                .nth(1)
                .unwrap()
                .split("</comments>")
                .next()
                .unwrap(),
        )
        .unwrap();
        let notes: Vec<&str> = notes
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|n| n["comment"].as_str())
            .collect();
        assert_eq!(notes.len(), 2);
        samples.push(sample("review", None, notes.join("\n")));

        let passage = "I really just wanted the bowl to hold. It held for a year, which is longer than the shop said it would.";
        let edit = super::edit(
            "You are a careful editor helping a writer revise their own prose.",
            &[Message {
                role: Role::User,
                content: format!(
                    "<context_before></context_before>\n<passage>{passage}</passage>\n<context_after></context_after>\n\nTighten this passage."
                ),
            }],
        );
        samples.push(sample("edit", None, edit));
        freeze("mock-chat.json", samples);
    }
}
