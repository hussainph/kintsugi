//! The mock must earn a reused read: current inline text, or an unchanged
//! revision and an actual successful read result retained in wire history.
use super::{Item, first_chip, paragraph_chip, said};
use serde_json::Value;

fn document(question: &str, path: &str) -> Option<Value> {
    let (_, tail) = question.rsplit_once("<data tool=\"context\">\n")?;
    let (json, _) = tail.split_once("\n</data>")?;
    let value: Value = serde_json::from_str(json).ok()?;
    value["documents"]
        .as_array()?
        .iter()
        .find(|d| d["path"] == path)
        .cloned()
}

fn inline(question: &str, path: &str) -> Option<String> {
    let doc = document(question, path)?;
    if let Some((_, from, to)) = paragraph_chip(question) {
        if let Some(paragraphs) = doc["paragraphs"].as_array() {
            // A resolved saved quote may have moved from the chip's old
            // range. Never fall back to that range after a stale notice.
            let paragraph = paragraphs
                .iter()
                .find(|p| p["lines"] == serde_json::json!([from, to]))
                .or_else(|| (paragraphs.len() == 1).then(|| &paragraphs[0]))?;
            return paragraph["text"]
                .as_str()
                .map(|text| text.trim_end_matches('\n').to_string());
        }
        let text = doc["text"].as_str()?;
        return Some(
            text.split_inclusive('\n')
                .skip(from.saturating_sub(1) as usize)
                .take((to + 1 - from) as usize)
                .collect::<String>()
                .trim_end_matches('\n')
                .to_string(),
        );
    }
    doc["text"].as_str().map(String::from)
}

/// Strip the reader's envelope and numeric prefixes, never prose characters.
/// Only accept a successful read matched to its own immediately preceding
/// assistant call, not a similarly named file in a search result.
fn read(items: &[Item], path: &str) -> Option<String> {
    items.iter().enumerate().rev().find_map(|(at, item)| {
        let Item::Results(results) = item else {
            return None;
        };
        let Some(Item::Assistant { calls, .. }) = at.checked_sub(1).and_then(|n| items.get(n))
        else {
            return None;
        };
        let call = calls
            .iter()
            .find(|c| c.name == "read" && c.arguments["path"] == path)?;
        let result = results
            .iter()
            .find(|r| r.call_id == call.id && !r.is_error)?;
        let body = result
            .content
            .strip_prefix("<data tool=\"read\">\n")?
            .strip_suffix("\n</data>")?;
        let (_, body) = body.split_once('\n')?;
        let lines: Vec<&str> = body
            .lines()
            .filter_map(|line| {
                let (number, text) = line.split_once(": ")?;
                number.parse::<u64>().ok().map(|_| text)
            })
            .collect();
        (!lines.is_empty()).then(|| lines.join("\n"))
    })
}

pub(super) fn passage(question: &str, items: &[Item]) -> Option<String> {
    let path = paragraph_chip(question)
        .map(|(path, ..)| path)
        .or_else(|| first_chip(question))?;
    let doc = document(question, &path);
    if paragraph_chip(question).is_some()
        && doc.as_ref().is_some_and(|doc| {
            doc["paragraphs"]
                .as_array()
                .is_some_and(|paragraphs| paragraphs.iter().any(|p| p["state"] == "stale anchor"))
        })
    {
        return None;
    }
    if let Some(text) = inline(question, &path) {
        return Some(text);
    }
    let start = items
        .iter()
        .rposition(|i| matches!(i, Item::User(_)))
        .map_or(0, |n| n + 1);
    if let Some(text) = read(&items[start..], &path) {
        return Some(text);
    }
    let doc = doc?;
    if doc["state"] == "unchanged" && doc["revision"].as_str().is_some_and(|s| !s.is_empty()) {
        return read(&items[..start], &path);
    }
    None
}

pub(super) fn followup(question: &str, items: &[Item]) -> Option<String> {
    if !said(question).eq_ignore_ascii_case("better?") {
        return None;
    }
    let passage = passage(question, items)?;
    if paragraph_chip(question).is_some() {
        let end = passage
            .rsplit_once(". ")
            .map_or(passage.as_str(), |(_, end)| end)
            .trim();
        Some(format!("I still have the passage. It ends: {end}"))
    } else {
        let opening = passage
            .lines()
            .find(|line| !line.trim().is_empty() && !line.starts_with('#'))?;
        Some(format!("I have the current opening: {opening}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::wire::{ToolCall, ToolResult};
    use serde_json::json;

    fn question(state: &str, inline: bool) -> String {
        let mut doc = json!({"path":"drafts/a.md", "revision":"abc", "state":state});
        if inline {
            doc["text"] = json!("Current words.");
        }
        format!(
            "better?\n\n<context>\nOn screen (read these if they matter):\n- doc drafts/a.md\n<data tool=\"context\">\n{}\n</data>\n</context>",
            json!({"documents":[doc]})
        )
    }

    fn history() -> Vec<Item> {
        vec![
            Item::User("Earlier question".into()),
            Item::Assistant {
                text: String::new(),
                calls: vec![ToolCall {
                    id: "read-1".into(),
                    name: "read".into(),
                    arguments: json!({"path":"drafts/a.md"}),
                }],
            },
            Item::Results(vec![ToolResult {
                call_id: "read-1".into(),
                content:
                    "<data tool=\"read\">\ndrafts/a.md, lines 1-1 of 1\n1: Earlier words.\n</data>"
                        .into(),
                is_error: false,
            }]),
        ]
    }

    #[test]
    fn reuse_requires_inline_text_or_unchanged_revision_and_a_real_read() {
        let mut items = history();
        items.push(Item::User(question("unchanged", false)));
        assert_eq!(
            passage(&question("unchanged", false), &items).as_deref(),
            Some("Earlier words.")
        );
        assert!(passage(&question("changed", false), &items).is_none());
        assert!(passage(&question("not previously read", false), &items).is_none());
        assert!(passage(&question("unchanged", false), &[]).is_none());
        assert_eq!(
            passage(&question("changed", true), &items).as_deref(),
            Some("Current words.")
        );
    }

    #[test]
    fn relocated_paragraphs_use_current_text_and_stale_anchors_use_nothing() {
        let question = |paragraph: Value| {
            format!(
                "better?\n\n<context>\nOn screen (read these if they matter):\n- paragraph drafts/a.md lines 3-3\n<data tool=\"context\">\n{}\n</data>\n</context>",
                json!({"documents":[{"path":"drafts/a.md", "revision":"new", "state":"changed", "text":"# A\n\nUnrelated old range.\n\nCurrent words.", "paragraphs":[paragraph]}]})
            )
        };
        assert_eq!(
            passage(
                &question(json!({"lines":[5,5], "text":"Current words.\n"})),
                &[]
            )
            .as_deref(),
            Some("Current words.")
        );
        assert!(passage(&question(json!({"state":"stale anchor"})), &history()).is_none());
    }

    #[test]
    fn failed_or_unmatched_results_are_not_memory() {
        let mut items = history();
        if let Item::Results(results) = &mut items[2] {
            results[0].is_error = true;
        }
        items.push(Item::User(question("unchanged", false)));
        assert!(passage(&question("unchanged", false), &items).is_none());
        if let Item::Results(results) = &mut items[2] {
            results[0].is_error = false;
            results[0].call_id = "not-the-call".into();
        }
        assert!(passage(&question("unchanged", false), &items).is_none());
    }
}
