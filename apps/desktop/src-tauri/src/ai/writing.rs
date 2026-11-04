//! Kin's writing (KI-102): the rules every prompt that writes prose
//! carries, and the tone Hussain picks for what Kin writes for him to read.
//!
//! - `rules()`: the prioritised never-do list, from `writing/rules.json`.
//!   That file is the one copy: the editor's edits read it too
//!   (`src/refine/prompts.ts`), as `lists()` renders it here. The rules
//!   adapt stop-slop (Hardik Pandya, MIT) and humanizer (hannsxpeter, MIT),
//!   and paraphrase Wikipedia's "Signs of AI writing" (CC BY-SA 4.0); see
//!   `docs/kin.md` › Kin's writing.
//! - `Tone`: four presets, each an instruction block (instructions, not
//!   examples) plus a reminder that goes last in the prompt, as models drift
//!   from rules stated once. Story summaries and Ideas follow it; the chat
//!   keeps Kin's own voice, and edits keep Hussain's.
//! - `lint` (tests only): scores model output against the same tells.

use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

#[cfg(test)]
pub mod lint;

#[derive(Deserialize)]
struct Rules {
    intro: Vec<String>,
    never: Vec<String>,
    avoid: Vec<String>,
}

fn parsed() -> &'static Rules {
    static RULES: OnceLock<Rules> = OnceLock::new();
    RULES.get_or_init(|| {
        serde_json::from_str(include_str!("writing/rules.json")).expect("writing/rules.json")
    })
}

fn bullets(lines: &[String]) -> String {
    lines
        .iter()
        .map(|l| format!("- {l}"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The two lists alone: P0, never; P1, unless the source says it.
pub fn lists() -> &'static str {
    static TEXT: OnceLock<String> = OnceLock::new();
    TEXT.get_or_init(|| {
        let rules = parsed();
        format!(
            "Never, whatever the tone:\n{}\n\nAvoid unless the source says it:\n{}",
            bullets(&rules.never),
            bullets(&rules.avoid)
        )
    })
}

/// The whole block for a prompt that writes prose.
pub fn rules() -> &'static str {
    static TEXT: OnceLock<String> = OnceLock::new();
    TEXT.get_or_init(|| format!("{}\n\n{}", parsed().intro.join("\n"), lists()))
}

/// How Kin writes what he writes for Hussain to read: Feed story summaries
/// and Ideas. Settings › Kin and models; Plain unless he picks another.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tone {
    #[default]
    Plain,
    Editorial,
    Casual,
    Dry,
}

impl Tone {
    pub const ALL: [Tone; 4] = [Tone::Plain, Tone::Editorial, Tone::Casual, Tone::Dry];

    pub fn id(self) -> &'static str {
        match self {
            Tone::Plain => "plain",
            Tone::Editorial => "editorial",
            Tone::Casual => "casual",
            Tone::Dry => "dry",
        }
    }

    pub fn from_id(id: &str) -> Option<Tone> {
        Tone::ALL.into_iter().find(|t| t.id() == id)
    }

    pub fn is_plain(&self) -> bool {
        *self == Tone::Plain
    }

    /// The instruction block. Starts "Tone: <id>." (the headless mock reads
    /// it back with `in_prompt`).
    pub fn voice(self) -> &'static str {
        match self {
            Tone::Plain => {
                "Tone: plain. Write the thing itself, in ordinary words and short sentences. State the facts and skip \
                 the wind-up. No adjectives doing the work of evidence."
            }
            Tone::Editorial => {
                "Tone: editorial. Write like a magazine brief: the point first, then why it matters in one sentence, \
                 attributed to whoever says so. No scene-setting and no moral."
            }
            Tone::Casual => {
                "Tone: casual. Write the way you'd tell a friend what you read: contractions, first person where it \
                 fits, no jargon you wouldn't say out loud. Keep it level: no slang for show, no exclamation marks."
            }
            Tone::Dry => {
                "Tone: dry. Understate. State the fact and stop. No enthusiasm, no irony, no exclamation marks."
            }
        }
    }

    /// The key constraint again, for the end of the prompt.
    pub fn reminder(self) -> &'static str {
        match self {
            Tone::Plain => "Above all: plain words, facts first, nothing the sources don't say.",
            Tone::Editorial => {
                "Above all: the point first, why it matters once and attributed, nothing the sources don't say."
            }
            Tone::Casual => {
                "Above all: say it the way you'd tell a friend, and add nothing the sources don't say."
            }
            Tone::Dry => {
                "Above all: understate, state the fact and stop, nothing the sources don't say."
            }
        }
    }

    /// The tone a prompt asks for: its last "Tone: <id>." line.
    #[cfg(any(test, feature = "headless"))]
    pub fn in_prompt(text: &str) -> Option<Tone> {
        text.rmatch_indices("Tone: ").find_map(|(at, _)| {
            let rest = &text[at + "Tone: ".len()..];
            Tone::from_id(rest.split('.').next()?)
        })
    }
}

/// The tone he picked, for background work.
pub fn tone() -> Tone {
    super::meter().settings().tone
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_rules_carry_both_priorities_and_the_key_idea() {
        let text = rules();
        assert!(text.starts_with("How to write"));
        assert!(text.contains("Never, whatever the tone:\n- Inflated significance"));
        assert!(text.contains("Avoid unless the source says it:\n- Lists of three"));
        assert!(text.contains("Never invent a specific"));
        assert!(text.contains("fix the thought"));
        assert!(text.ends_with(lists()));
    }

    #[test]
    fn tones_round_trip_and_read_back_from_a_prompt() {
        for tone in Tone::ALL {
            assert_eq!(Tone::from_id(tone.id()), Some(tone));
            assert_eq!(
                serde_json::to_value(tone).unwrap(),
                serde_json::json!(tone.id())
            );
            let prompt = format!("Rules.\n\n{}\n\nData.\n\n{}", tone.voice(), tone.reminder());
            assert_eq!(Tone::in_prompt(&prompt), Some(tone));
            assert!(
                tone.reminder().contains("nothing the sources don't say")
                    || tone.reminder().contains("add nothing")
            );
        }
        assert_eq!(Tone::from_id("loud"), None);
        assert_eq!(Tone::in_prompt("no tone here"), None);
        assert_eq!(Tone::default(), Tone::Plain);
    }

    /// The tone blocks and reminders follow the rules they ask for.
    #[test]
    fn the_tone_blocks_pass_the_lint() {
        for tone in Tone::ALL {
            for text in [tone.voice(), tone.reminder()] {
                let report = lint::check(text);
                assert!(report.p0.is_empty(), "{text}: {report}");
                assert_eq!(report.dashes, 0, "{text}");
            }
        }
    }
}
