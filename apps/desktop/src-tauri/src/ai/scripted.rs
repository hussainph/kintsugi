//! A scripted stand-in for a model, for headless runs only
//! (`KINTSUGI_HEADLESS_KIN=mock`). It never calls out and costs nothing,
//! but it exercises the real loop: it reads the first chip (or searches),
//! then answers slowly, word by word, so interrupting and batching can be
//! seen and tested in a browser tab.

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

/// The first on-screen chip that's a vault path.
fn first_chip(message: &str) -> Option<String> {
    let context = message.split("On screen (read these if they matter):").nth(1)?;
    context.lines().skip(1).take_while(|l| l.starts_with("- ")).find_map(|line| {
        let mut parts = line[2..].split_whitespace();
        let kind = parts.next()?;
        let path = parts.next()?;
        (kind != "feed" && (path.ends_with(".md") || path.ends_with(".mdx"))).then(|| path.to_string())
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
        let text = if ex.system.starts_with(SUMMARIZER) {
            let lines = question.lines().filter(|l| l.starts_with("Hussain:")).count();
            let last = question.lines().rev().find(|l| l.starts_with("Hussain:")).unwrap_or_default();
            format!("Mock summary: Hussain asked {lines} thing(s); most recently “{}”.", last.trim_start_matches("Hussain:").trim())
        } else if let Some(Item::User(message)) = ex.items.last() {
            // First step of a turn: look something up.
            let call = match first_chip(message) {
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
            let earlier = ex.items.iter().filter(|i| matches!(i, Item::Assistant { calls, .. } if calls.is_empty())).count();
            let recap = question.contains("Earlier in this conversation");
            format!(
                "You said: “{}”. I looked with {}. This thread has {earlier} earlier exchange(s){}. \
                 This reply comes from the headless mock model, so nothing was sent to a provider.",
                said(question).lines().filter(|l| !l.trim().is_empty()).collect::<Vec<_>>().join(" / "),
                looked.unwrap_or_else(|| "nothing".into()),
                if recap { " and a summary" } else { "" },
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
