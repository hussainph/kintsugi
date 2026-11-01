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
use super::chat::SUMMARIZER;
use super::wire::{Exchange, Item, Reply, ToolCall, Usage};
use serde_json::json;
use std::time::Duration;

type Result<T> = std::result::Result<T, String>;

const WORD_DELAY: Duration = Duration::from_millis(70);

pub struct Scripted {
    model: ModelRef,
}

impl Default for Scripted {
    fn default() -> Self {
        // Priced as a local model: free.
        Scripted { model: ModelRef { provider: "ollama".into(), model: "kin-headless-mock".into(), reasoning: None } }
    }
}

/// The owner's words from a user message, without the dynamic context.
fn said(message: &str) -> &str {
    message.split("\n\n<context>").next().unwrap_or(message).trim()
}

/// The first on-screen chip that's a vault path or a Feed item.
fn first_chip(message: &str) -> Option<String> {
    let context = message.split("On screen (read these if they matter):").nth(1)?;
    context.lines().skip(1).take_while(|l| l.starts_with("- ")).find_map(|line| {
        let path = line[2..].split_whitespace().nth(1)?;
        (path.starts_with("feed:") || path.ends_with(".md") || path.ends_with(".mdx")).then(|| path.to_string())
    })
}

fn reply(text: String, calls: Vec<ToolCall>) -> Reply {
    Reply { text, calls, usage: Usage { input: 0, output: 0, cache_read: 0, cache_write: 0 }, stop_reason: None }
}

impl Model for Scripted {
    fn model(&self) -> &ModelRef {
        &self.model
    }

    async fn send(&self, ex: &Exchange<'_>, on_text: &mut (dyn FnMut(&str) + Send)) -> Result<Reply> {
        let Some(question) = ex.items.iter().rev().find_map(|i| match i {
            Item::User(text) => Some(text.as_str()),
            _ => None,
        }) else {
            return Err("nothing to answer".into());
        };
        if let Some(Item::User(brief)) = ex.items.first()
            && brief.contains(super::ideas::brief::FORMAT)
        {
            let (text, calls) = ideas::step(ex.system, brief, ex.items);
            on_text(&text);
            return Ok(reply(text, calls));
        }
        let text = if ex.system.starts_with(SUMMARIZER) {
            let lines = question.lines().filter(|l| l.starts_with("Hussain:")).count();
            let last = question.lines().rev().find(|l| l.starts_with("Hussain:")).unwrap_or_default();
            format!("Mock summary: Hussain asked {lines} thing(s); most recently “{}”.", last.trim_start_matches("Hussain:").trim())
        } else if let Some(Item::User(message)) = ex.items.last() {
            // First step of a turn: look something up.
            let call = match first_chip(message) {
                // The Feed's ranking tools, so headless runs can drive them.
                _ if said(message).to_lowercase().contains("shortlist") => {
                    ToolCall { id: "mock-1".into(), name: "tool".into(), arguments: json!({ "name": "shortlist", "args": { "n": 5 } }) }
                }
                Some(path) => ToolCall { id: "mock-1".into(), name: "read".into(), arguments: json!({ "path": path, "limit": 20 }) },
                None => {
                    let word = said(message).split(|c: char| !c.is_alphanumeric()).max_by_key(|w| w.len()).unwrap_or("kintsugi");
                    ToolCall { id: "mock-1".into(), name: "search".into(), arguments: json!({ "query": word }) }
                }
            };
            return Ok(reply(String::new(), vec![call]));
        } else {
            let looked = ex.items.iter().rev().find_map(|i| match i {
                Item::Assistant { calls, .. } => calls.first().map(|c| format!("{} {}", c.name, c.arguments)),
                _ => None,
            });
            // The start of what the tool returned, so a test can see Kin got it.
            let returned = ex.items.iter().rev().find_map(|i| match i {
                Item::Results(results) => results.first().map(|r| {
                    let text = r.content.replace("<data tool=\"read\">", "").replace("<data tool=\"tool\">", "");
                    text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(160).collect::<String>()
                }),
                _ => None,
            });
            let earlier = ex.items.iter().filter(|i| matches!(i, Item::Assistant { calls, .. } if calls.is_empty())).count();
            let recap = question.contains("Earlier in this conversation");
            format!(
                "You said: “{}”. I looked with {}. This thread has {earlier} earlier exchange(s){}. \
                 This reply comes from the headless mock model, so nothing was sent to a provider.{}",
                said(question).lines().filter(|l| !l.trim().is_empty()).collect::<Vec<_>>().join(" / "),
                looked.unwrap_or_else(|| "nothing".into()),
                if recap { " and a summary" } else { "" },
                returned.map(|r| format!(" It returned: {r}")).unwrap_or_default(),
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

/// The scripted Ideas helper.
mod ideas {
    use super::super::ideas::brief::CURRENT;
    use super::super::wire::{Item, ToolCall};
    use serde_json::{Value, json};

    fn call(n: usize, name: &str, arguments: Value) -> ToolCall {
        ToolCall { id: format!("mock-{n}"), name: name.into(), arguments }
    }

    /// The `<data>` body of every tool result so far, newest last.
    fn results(items: &[Item]) -> Vec<String> {
        items
            .iter()
            .filter_map(|i| match i {
                Item::Results(r) => Some(r.iter().filter(|r| !r.is_error).map(|r| r.content.clone()).collect::<Vec<_>>()),
                _ => None,
            })
            .flatten()
            .map(|c| c.split_once('\n').map_or(c.as_str(), |(_, rest)| rest).trim_end_matches("</data>").to_string())
            .collect()
    }

    fn after<'a>(text: &'a str, marker: &str) -> Option<&'a str> {
        text.split_once(marker).map(|(_, rest)| rest.lines().next().unwrap_or_default().trim())
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
        let lines: Vec<&str> = body.lines().filter_map(|l| l.split_once(": ").map(|(_, t)| t)).collect();
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
            if line.starts_with('#') || line.starts_with("<!--") || line.contains("[[") || line.ends_with('…') {
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
        (!sentences.is_empty()).then_some(Read { path, title, sentences })
    }

    fn profile_line(system: &str) -> Option<String> {
        let section = system.split("## About Hussain").nth(1)?;
        section.lines().skip(1).take_while(|l| !l.starts_with("## ")).find_map(|l| l.strip_prefix("- ").map(str::to_string))
    }

    fn refine(brief: &str) -> String {
        let asked = brief.split("He asked: \"").nth(1).and_then(|r| r.split('"').next()).unwrap_or("Sharper");
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
        let Some(mut idea) = current else { return "<ideas>[]</ideas>".into() };
        let title = idea["title"].as_str().unwrap_or_default().to_string();
        let short: String = asked.chars().take(30).collect();
        idea["title"] = json!(format!("{short}: {title}").chars().take(110).collect::<String>());
        idea["snippet"] = json!(format!("Reworked after you asked for “{short}”."));
        idea["steps"] = json!([{ "did": format!("Reread the quotes with “{short}” in mind") }]);
        format!("<ideas>\n{}\n</ideas>", serde_json::to_string_pretty(&idea).unwrap_or_default())
    }

    fn batch(system: &str, brief: &str, query: &str, reads: &[Read]) -> String {
        let about = after(brief, "every idea is about one document: ").map(|a| a.trim_end_matches('.').to_string());
        let profile = profile_line(system);
        let reason = |text: &str| match &profile {
            Some(line) => json!([{ "text": text }, { "text": "It fits what you told Kin about yourself", "profileLine": line }]),
            None => json!([{ "text": text }]),
        };
        let steps = |a: &Read, b: &Read| {
            json!([
                { "did": format!("Searched your vault for “{query}”"), "found": format!("{} documents worth reading", reads.len()) },
                { "did": format!("Read {} and {}", a.path, b.path) },
                { "did": "Copied the lines that answer each other" }
            ])
        };
        let mut ideas = Vec::new();
        let pairs: Vec<(usize, usize)> = match reads.len() {
            0 | 1 => vec![],
            2 => vec![(0, 1)],
            _ => vec![(0, 1), (1, 2)],
        };
        for (n, (i, j)) in pairs.into_iter().enumerate() {
            let (a, b) = (&reads[i], &reads[j]);
            let (kind, title, hunch) = if n == 0 {
                ("connection", format!("{} and {} circle the same question", a.title, b.title), format!("There may be one piece here that {} sets up and {} answers.", a.title, b.title))
            } else {
                ("gap", format!("You keep returning to {} without writing it down", b.title.to_lowercase()), format!("A short post could say plainly what {} only hints at.", b.title))
            };
            ideas.push(json!({
                "kind": kind,
                "title": title,
                "draftTitle": if n == 0 { format!("What {} answers", b.title) } else { b.title.clone() },
                "snippet": format!("{} and {} came up together when I searched for “{query}”.", a.title, b.title),
                "observed": [format!("{} and {} both turned up for “{query}”.", a.path, b.path), format!("Neither links to the other.")],
                "hunch": hunch,
                "quotes": [{ "source": a.path, "text": a.sentences[0] }, { "source": b.path, "text": b.sentences.get(1).unwrap_or(&b.sentences[0]) }],
                "steps": steps(a, b),
                "reasons": reason("Your own writing is the strongest evidence"),
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
                "reasons": [{ "text": "None" }],
            }));
        }
        format!("<ideas>\n{}\n</ideas>", serde_json::to_string_pretty(&Value::Array(ideas)).unwrap_or_default())
    }

    /// One step of the scripted helper: tool calls, or the final JSON.
    pub fn step(system: &str, brief: &str, items: &[Item]) -> (String, Vec<ToolCall>) {
        if brief.contains(CURRENT) {
            return (refine(brief), vec![]);
        }
        let about = after(brief, "every idea is about one document: ").map(|a| a.trim_end_matches('.').to_string());
        let query = after(brief, "He asked for ideas about: ")
            .and_then(|f| f.split(|c: char| !c.is_alphanumeric()).filter(|w| w.len() > 3).max_by_key(|w| w.len()))
            .map(str::to_string)
            .unwrap_or_else(|| {
                // A new subject for each round, so "more" isn't a repeat.
                let offered = brief.split("Already offered lately").nth(1).map_or(0, |r| r.split("\n\n").next().unwrap_or_default().lines().filter(|l| l.starts_with("- ")).count());
                ["repair", "attention", "quiet", "light"][(offered / 2) % 4].to_string()
            });
        let found = results(items);
        let reads: Vec<Read> = found.iter().filter(|c| c.contains(", lines ")).filter_map(|c| parse_read(c)).collect();
        if !reads.is_empty() {
            return (batch(system, brief, &query, &reads), vec![]);
        }
        let steps = items.iter().filter(|i| matches!(i, Item::Assistant { .. })).count();
        if steps == 0 {
            return (String::new(), vec![call(1, "search", json!({ "query": query, "k": 8 }))]);
        }
        // Paths from the search results (or, failing those, recent documents).
        let mut paths: Vec<String> = about.into_iter().collect();
        for content in &found {
            if let Ok(Value::Array(hits)) = serde_json::from_str::<Value>(content.trim()) {
                paths.extend(hits.iter().filter_map(|h| h["id"].as_str()).filter(|id| !id.starts_with("feed:")).map(str::to_string));
            } else {
                paths.extend(content.split_whitespace().filter(|w| w.ends_with(".md") || w.ends_with(".mdx")).map(str::to_string));
            }
        }
        paths.dedup();
        let mut seen = Vec::new();
        paths.retain(|p| !seen.contains(p) && {
            seen.push(p.clone());
            true
        });
        if paths.is_empty() && steps == 1 {
            return (String::new(), vec![call(2, "tool", json!({ "name": "recent", "args": { "limit": 5 } }))]);
        }
        if paths.is_empty() {
            return ("<ideas>[]</ideas>".into(), vec![]);
        }
        let calls = paths.iter().take(3).enumerate().map(|(i, p)| call(10 + i, "read", json!({ "path": p, "limit": 80 }))).collect();
        (String::new(), calls)
    }
}

#[cfg(test)]
mod tests {
    use super::super::agent::tests::block_on;
    use super::super::agent::{self, Cancel, Harness, Limits, Turn};
    use super::super::cost::Meter;
    use super::super::ideas::store::Store;
    use super::super::ideas::{self, brief, VaultSources};
    use super::super::jobs::{Job, Trace};
    use super::super::prompt::Memory;
    use super::super::tools::Tools;
    use super::super::Task;
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
        write("posts/on-craft.mdx", "---\ntitle: \"On craft and repair\"\n---\n\n# On craft\n\nA repair is not a cover-up. It is a record of care.\nThe practice of repair is unglamorous and slow.\n");
        write("notes/repair.md", "---\ntitle: Repair is a kind of attention\n---\n\nThe more interesting repair makes the history legible. The patch is not hidden.\nWe tend to think of repair as restoration of the old.\n");
        write("inspiration/golden-joinery.md", "---\ntitle: Golden joinery\nsite: Britannica\n---\n\n> The repair is not hidden. It is given a color of its own.\nKintsugi repair uses lacquer dusted with powdered gold.\n");
        let meter = Meter::open(None);
        let tools = Tools::new(vault.path(), outputs.path().into(), "job-1").unwrap();
        let memory = Memory { about: vec!["Writes about craft.".into()], ..Memory::default() };
        let cancel = Cancel::default();
        let harness = Harness { tools: &tools, meter: &meter, memory: &memory, cancel: &cancel, limits: Limits::default() };
        let text = brief::batch(&brief::Ask { count: 5, ..Default::default() }, &[], &[], &[]);
        let turn = Turn { task: Task::Ideas, background: true, question: text, chips: vec![], today: "2026-11-02".into(), remember: true, history: vec![], recap: None };
        let mut trace = Trace::default();
        let summary = block_on(agent::run(&Scripted::default(), &harness, &turn, &mut |e| {
            if let agent::KinEvent::ToolCall { name, arguments, .. } = &e {
                trace.call(name, arguments);
            }
        }))
        .unwrap();
        assert_eq!(trace.searches, ["repair"]);
        assert_eq!(trace.files.len(), 3);

        let mut store = Store::open(None);
        let job: Job = serde_json::from_value(json!({ "id": "job-1", "kind": "ideas", "task": "ideas", "brief": "b", "status": "running", "created": "2026-11-02T09:00:00+00:00" })).unwrap();
        let sources = VaultSources { root: vault.path(), feed: None };
        let now = chrono::DateTime::parse_from_rfc3339("2026-11-02T09:00:00+00:00").unwrap();
        let report = ideas::finish_batch(&mut store, &sources, &memory.about, &job, &summary.text, &trace, now).unwrap();
        assert!(report.starts_with("2 new ideas in Ideas") && report.contains("“An idea resting on a quote the mock invented”, because a quote isn't in"), "{report}");
        let listed = store.list(now);
        assert_eq!(listed.len(), 2);
        for idea in &listed {
            assert!(idea.idea.content.quotes.len() >= 2);
            assert_eq!(idea.idea.content.reasons[1].profile_line.as_deref(), Some("Writes about craft."));
        }
    }
}
