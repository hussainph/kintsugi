//! The mock's checks and trims (KI-90): ⌘K's "Weakest sentences", "Slight
//! trim −10%" and the rest, answered from the numbered sentences in the
//! request, the shape `src/refine/marks.ts` asks a real model for. Each
//! check also names one quote the draft doesn't have, which the webview
//! must drop; trims only ever quote words that are there.
//!
//! "Review this draft" (KI-109) is answered here too, from the sentences its
//! brief numbers: a flag on the first sentence with nothing else to change,
//! cuts of hedges and filler, rewrites of
//! words off the tone, and one quote the draft doesn't have.

use serde_json::{Value, json};

/// Sentences as the request numbers them: `[3] The text.`
fn numbered(block: &str) -> Vec<(u64, String)> {
    block
        .lines()
        .filter_map(|line| {
            let rest = line.strip_prefix('[')?;
            let (n, text) = rest.split_once("] ")?;
            Some((n.parse().ok()?, text.to_string()))
        })
        .collect()
}

/// The block between `<tag …>` and `</tag>`, with the tag's one attribute.
fn tagged<'a>(message: &'a str, tag: &str, attribute: &str) -> Option<(&'a str, &'a str)> {
    let open = format!("<{tag} {attribute}=\"");
    let (_, rest) = message.split_once(&open)?;
    let (value, rest) = rest.split_once("\">")?;
    let (body, _) = rest.split_once(&format!("</{tag}>"))?;
    Some((value, body))
}

fn word_count(text: &str) -> usize {
    text.split_whitespace()
        .filter(|w| w.chars().any(char::is_alphanumeric))
        .count()
}

const FILLER: [&str; 6] = ["really", "very", "just", "actually", "quite", "basically"];
const HEDGES: [&str; 6] = [
    "I think", "sort of", "kind of", "perhaps", "maybe", "in order",
];
const OFF_TONE: [&str; 10] = [
    "utilize", "leverage", "awesome", "super", "stuff", "gonna", "delve", "myriad", "pivotal",
    "crucial",
];

/// Each whole-word occurrence of `words` in `text`, as written there.
fn occurrences(text: &str, words: &[&str]) -> Vec<String> {
    let lower = text.to_lowercase();
    let mut found: Vec<(usize, String)> = Vec::new();
    for word in words {
        let needle = word.to_lowercase();
        let mut from = 0;
        while let Some(at) = lower[from..].find(&needle) {
            let start = from + at;
            let end = start + needle.len();
            let before = lower[..start].chars().next_back();
            let after = lower[end..].chars().next();
            let edge =
                |c: Option<char>| c.is_none_or(|c| !c.is_alphanumeric() && c != '\'' && c != '’');
            if edge(before)
                && edge(after)
                && text.is_char_boundary(start)
                && text.is_char_boundary(end)
            {
                found.push((start, text[start..end].to_string()));
            }
            from = end;
        }
    }
    found.sort_by_key(|(at, _)| *at);
    found.into_iter().map(|(_, word)| word).collect()
}

fn check(kind: &str, sentences: &[(u64, String)]) -> Vec<Value> {
    let mut out = Vec::new();
    match kind {
        "weakest" => {
            let mut by_length: Vec<&(u64, String)> = sentences.iter().collect();
            by_length.sort_by_key(|(n, text)| (word_count(text), *n));
            for (n, _) in by_length.into_iter().take(2) {
                out.push(json!({"sentence": n, "reason": "Says little the piece would miss."}));
            }
        }
        "long" => {
            for (n, text) in sentences.iter().filter(|(_, t)| word_count(t) > 18) {
                out.push(json!({"sentence": n, "reason": format!("{} words; it could break after a clause.", word_count(text))}));
            }
        }
        "convoluted" => {
            for (n, text) in sentences
                .iter()
                .filter(|(_, t)| t.matches(',').count() >= 2)
            {
                out.push(json!({"sentence": n, "reason": format!("{} clauses before it lands.", text.matches(',').count() + 1)}));
            }
        }
        "tone" => {
            for (n, text) in sentences {
                for word in occurrences(text, &OFF_TONE) {
                    out.push(json!({"sentence": n, "quote": word, "reason": "Doesn't sound like the rest of the draft."}));
                }
            }
        }
        "hedges" => {
            for (n, text) in sentences {
                for word in occurrences(text, &HEDGES) {
                    out.push(json!({"sentence": n, "quote": word, "reason": "A hedge; the sentence is firmer without it."}));
                }
                for word in occurrences(text, &FILLER) {
                    out.push(
                        json!({"sentence": n, "quote": word, "reason": "Filler; it adds nothing."}),
                    );
                }
            }
        }
        _ => {}
    }
    if let Some((n, _)) = sentences.first() {
        // Not in the draft: the webview must drop it.
        out.push(
            json!({"sentence": n, "quote": "words the draft never had", "reason": "Made up."}),
        );
    }
    out
}

fn trim(percent: u32, sentences: &[(u64, String)]) -> Vec<Value> {
    let mut out = Vec::new();
    for (i, (n, text)) in sentences.iter().enumerate() {
        if percent >= 50 && i % 2 == 1 {
            out.push(json!({"sentence": n, "cut": text}));
            continue;
        }
        let mut cuts = occurrences(text, &FILLER);
        if percent >= 20 {
            cuts.extend(occurrences(text, &HEDGES));
        }
        if percent >= 30 {
            let mut rest = text.as_str();
            while let Some(open) = rest.find(" (") {
                let Some(close) = rest[open..].find(')') else {
                    break;
                };
                cuts.push(rest[open + 1..open + close + 1].to_string());
                rest = &rest[open + close + 1..];
            }
        }
        for cut in cuts {
            out.push(json!({"sentence": n, "cut": cut}));
        }
    }
    out
}

/// Plainer words for the mock's rewrites.
const PLAINER: [(&str, &str); 5] = [
    ("utilize", "use"),
    ("leverage", "use"),
    ("delve", "dig"),
    ("myriad", "many"),
    ("pivotal", "key"),
];

/// The mock review's `<suggestions>`, from the brief's `[n] text` lines.
pub fn review(brief: &str) -> String {
    let sentences = numbered(brief.split("\nSentences:\n").nth(1).unwrap_or_default());
    let mut out = Vec::new();
    let plain: Vec<&str> = PLAINER.iter().map(|(word, _)| *word).collect();
    // A flag on the first sentence nothing else touches.
    if let Some((n, _)) = sentences.iter().find(|(_, text)| {
        occurrences(text, &HEDGES).is_empty()
            && occurrences(text, &FILLER).is_empty()
            && occurrences(text, &plain).is_empty()
    }) {
        out.push(json!({"sentence": n, "kind": "flag", "reason": "Mock: what is this claim resting on?"}));
    }
    for (n, text) in &sentences {
        for word in occurrences(text, &HEDGES) {
            out.push(json!({"sentence": n, "kind": "cut", "quote": word, "reason": "A hedge; it's firmer without it."}));
        }
        for word in occurrences(text, &FILLER) {
            out.push(json!({"sentence": n, "kind": "cut", "quote": word, "reason": "Filler; it adds nothing."}));
        }
        for word in occurrences(text, &plain) {
            let lower = word.to_lowercase();
            let (_, with) = PLAINER.iter().find(|(w, _)| *w == lower).unwrap();
            out.push(json!({"sentence": n, "kind": "rewrite", "quote": word, "text": with, "reason": "Plainer, and how you'd say it."}));
        }
    }
    if let Some((n, _)) = sentences.first() {
        out.push(json!({"sentence": n, "kind": "cut", "quote": "words the draft never had", "reason": "Made up."}));
    }
    out.truncate(12);
    format!("<suggestions>{}</suggestions>", Value::Array(out))
}

/// The answer to a check or trim request, or None for any other edit.
pub fn answer(message: &str) -> Option<String> {
    if let Some((kind, body)) = tagged(message, "check", "kind") {
        let marks = check(kind, &numbered(body));
        return Some(format!("<marks>{}</marks>", Value::Array(marks)));
    }
    if let Some((percent, body)) = tagged(message, "trim", "percent") {
        let cuts = trim(percent.parse().unwrap_or(10), &numbered(body));
        return Some(format!("<cuts>{}</cuts>", Value::Array(cuts)));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::answer;
    use serde_json::Value;

    fn list(reply: &str, tag: &str) -> Vec<Value> {
        let body = reply
            .split(&format!("<{tag}>"))
            .nth(1)
            .and_then(|r| r.split(&format!("</{tag}>")).next())
            .expect("tagged");
        serde_json::from_str(body).expect("a JSON list")
    }

    const SENTENCES: &str = "[1] The bowl is really very old.\n[2] I think it was just broken once (maybe twice), and then, later, mended with gold.\n[3] We utilize gold.";

    #[test]
    fn checks_point_at_sentences_and_quoted_words() {
        let weakest = list(
            &answer(&format!(
                "<check kind=\"weakest\">\n{SENTENCES}\n</check>\n\nFind…"
            ))
            .unwrap(),
            "marks",
        );
        assert_eq!(weakest[0]["sentence"], 3);
        assert_eq!(
            weakest.last().unwrap()["quote"],
            "words the draft never had"
        );
        let hedges = list(
            &answer(&format!("<check kind=\"hedges\">\n{SENTENCES}\n</check>")).unwrap(),
            "marks",
        );
        let quotes: Vec<_> = hedges.iter().filter_map(|m| m["quote"].as_str()).collect();
        assert_eq!(
            quotes,
            [
                "really",
                "very",
                "I think",
                "maybe",
                "just",
                "words the draft never had"
            ]
        );
        let tone = list(
            &answer(&format!("<check kind=\"tone\">\n{SENTENCES}\n</check>")).unwrap(),
            "marks",
        );
        assert_eq!(tone[0]["quote"], "utilize");
        let convoluted = list(
            &answer(&format!(
                "<check kind=\"convoluted\">\n{SENTENCES}\n</check>"
            ))
            .unwrap(),
            "marks",
        );
        assert_eq!(convoluted[0]["sentence"], 2);
    }

    fn list_of(reply: &str) -> Vec<Value> {
        list(reply, "suggestions")
    }

    #[test]
    fn a_review_flags_cuts_and_rewrites() {
        let brief =
            format!("Review this draft as a critical reader: a.md. …\n\nSentences:\n{SENTENCES}\n");
        let list = list(&super::review(&brief), "suggestions");
        let kinds: Vec<_> = list
            .iter()
            .map(|s| {
                (
                    s["kind"].as_str().unwrap(),
                    s["quote"].as_str().unwrap_or(""),
                )
            })
            .collect();
        assert_eq!(
            kinds,
            [
                ("cut", "really"),
                ("cut", "very"),
                ("cut", "I think"),
                ("cut", "maybe"),
                ("cut", "just"),
                ("rewrite", "utilize"),
                ("cut", "words the draft never had")
            ]
        );
        assert_eq!(list[5]["text"], "use");
        let flagged = list_of(&super::review(&format!(
            "Review…\n\nSentences:\n{SENTENCES}\n[4] Plain words.\n"
        )));
        assert_eq!(
            (flagged[0]["kind"].as_str(), flagged[0]["sentence"].as_u64()),
            (Some("flag"), Some(4))
        );
    }

    #[test]
    fn trims_only_quote_words_that_are_there() {
        let slight = list(
            &answer(&format!("<trim percent=\"10\">\n{SENTENCES}\n</trim>")).unwrap(),
            "cuts",
        );
        let cuts: Vec<_> = slight.iter().map(|c| c["cut"].as_str().unwrap()).collect();
        assert_eq!(cuts, ["really", "very", "just"]);
        let sharper = list(
            &answer(&format!("<trim percent=\"30\">\n{SENTENCES}\n</trim>")).unwrap(),
            "cuts",
        );
        assert!(sharper.iter().any(|c| c["cut"] == "(maybe twice)"));
        let half = list(
            &answer(&format!("<trim percent=\"50\">\n{SENTENCES}\n</trim>")).unwrap(),
            "cuts",
        );
        assert!(
            half.iter()
                .any(|c| c["sentence"] == 2 && c["cut"].as_str().unwrap().starts_with("I think"))
        );
        for cut in sharper.iter().chain(&half) {
            assert!(SENTENCES.contains(cut["cut"].as_str().unwrap()));
            assert_eq!(cut.as_object().unwrap().len(), 2, "only sentence and cut");
        }
        assert!(answer("<passage>x</passage>").is_none());
    }
}
