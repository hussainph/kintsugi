//! The slop lint (KI-102), for tests: scores a piece of model output for
//! the tells `rules.json` tells Kin to avoid.
//!
//! - **P0**, zero allowed: stock AI words, inflated significance, trailing
//!   `-ing` analysis, negative parallelism, summing-up openers, chat residue
//!   and placeholders.
//! - **P1**, a density budget: about 2 per 100 words (at least 1), and no
//!   one phrase used more than once per 150 words (at least once).
//! - **Structure**: em dashes and "x, y and z" lists, each at most 1 per 100
//!   words (at least 1); no emoji; and from four sentences up, a floor on
//!   how much sentence lengths vary.
//!
//! The thresholds come from humanizer's restraint notes (hannsxpeter, MIT):
//! one em dash, one tricolon, one passive or one formal word is not a tell;
//! recurrence is. Three corpora keep it honest (`corpus/`): recorded Kin
//! output that must pass, slop that must fail, and human prose that must
//! pass, so the lint doesn't over-flag.
//!
//! `score` runs from 100 (clean) down to 0. Every hit costs points, inside
//! the budget too, so a regression shows before it fails.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Sentence lengths (in words) must vary at least this much, as a share
/// of the mean (the coefficient of variation), from `MIN_SENTENCES` up.
pub const SPREAD_FLOOR: f64 = 0.2;
const MIN_SENTENCES: usize = 4;

#[derive(Debug, Clone, PartialEq)]
pub struct Hit {
    pub rule: &'static str,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Report {
    pub words: usize,
    pub sentences: usize,
    pub p0: Vec<Hit>,
    pub p1: Vec<Hit>,
    pub dashes: usize,
    pub tricolons: usize,
    pub emoji: usize,
    /// The coefficient of variation of sentence lengths; `None` under
    /// `MIN_SENTENCES` sentences.
    pub spread: Option<f64>,
    pub score: f64,
}

fn rules(patterns: &[(&'static str, &str)]) -> Vec<(&'static str, Regex)> {
    patterns
        .iter()
        .map(|(rule, p)| (*rule, Regex::new(&format!("(?i){p}")).expect(rule)))
        .collect()
}

fn p0() -> &'static [(&'static str, Regex)] {
    static P0: OnceLock<Vec<(&'static str, Regex)>> = OnceLock::new();
    P0.get_or_init(|| {
        rules(&[
            ("stock AI word", r"\b(delve[sd]?|delving|tapestry|testament to|a testament|myriad|plethora)\b"),
            ("inflated significance", r"\b(stands as an?|plays? an? (pivotal|crucial|vital) role|underscores?|underscoring|evolving landscape|indelible mark|reflects? broader)\b"),
            ("trailing -ing analysis", r",\s+(highlighting|underscoring|emphasi[sz]ing|showcasing|reflecting|ensuring|fostering|paving the way|contributing to)\b"),
            ("not only, but also", r"\bnot only\b[^.!?]{0,120}\bbut also\b"),
            ("it's not X, it's Y", r"\b(it's|it is|that's|this is) not\b[^.!?;]{1,80}[,;:.]\s*(it's|it is)\b"),
            ("not just X, it's Y", r"\b(isn't|is not|not) (just|only|merely)\b[^.!?;]{1,80}[,;:.]\s*(it's|it is|they're|but)\b"),
            ("summing-up opener", r"\b(in summary|in conclusion|ultimately|overall)\s*,"),
            ("chat residue", r"(\bas an ai\b|i hope this helps|let me know if|great question|turn\d+search|:contentreference|oai_citation|\[web:\d+\])"),
            ("placeholder", r"\[(insert|company|name|year|placeholder)[^\]]*\]"),
        ])
    })
}

fn p1() -> &'static [(&'static str, Regex)] {
    static P1: OnceLock<Vec<(&'static str, Regex)>> = OnceLock::new();
    P1.get_or_init(|| {
        rules(&[
            ("copula avoidance", r"\b(stands? as|serves? as|boasts?|represents a)\b"),
            ("promotional word", r"\b(crucial|pivotal|vital|robust|seamless(ly)?|vibrant|landscape|realm|leverage|game-changing|groundbreaking|unprecedented|transformative|must-have|elevate|unlock)\b"),
            ("filler adverb", r"\b(really|just|literally|genuinely|honestly|simply|actually|crucially|importantly)\b"),
            ("vague attribution", r"\b(experts say|studies show|widely regarded|it is believed)\b"),
            ("throat-clearing", r"(\bat its core\b|\bit's worth noting\b|\bwhen it comes to\b|\bin today's\b|\bhere's the thing\b|\bit turns out\b|\blet's dive in\b|\bin this (piece|post|article),? (i|we)'ll\b)"),
            ("lazy extreme", r"\b(every|always|never|everyone|nobody)\b"),
            ("stacked hedge", r"\b(may potentially|could arguably|might possibly)\b"),
            ("false agency", r"\b(the data (tells|shows) us|the decision emerged)\b"),
            ("bold in prose", r"\*\*[^*\n]+\*\*"),
        ])
    })
}

fn tricolon() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\b\w+,\s+\w+,?\s+and\s+\w+\b").unwrap())
}

fn emoji() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\p{Extended_Pictographic}").unwrap())
}

/// Straight quotes, so patterns needn't care which a model used.
fn normal(text: &str) -> String {
    text.replace(['\u{2019}', '\u{2018}'], "'")
        .replace(['\u{201c}', '\u{201d}'], "\"")
}

fn is_word(token: &str) -> bool {
    token.chars().any(char::is_alphanumeric)
}

/// Sentence lengths in words. A sentence ends at `.`, `!` or `?` before
/// a space (or the end), or at a line break.
fn sentence_lengths(text: &str) -> Vec<usize> {
    let mut lengths = Vec::new();
    for line in text.lines() {
        let mut words = 0;
        for token in line.split_whitespace() {
            if is_word(token) {
                words += 1;
            }
            let end = token.trim_end_matches(['"', '\'', ')', ']', '*']);
            if words > 0 && end.ends_with(['.', '!', '?']) {
                lengths.push(words);
                words = 0;
            }
        }
        if words > 0 {
            lengths.push(words);
        }
    }
    lengths
}

fn spread(lengths: &[usize]) -> Option<f64> {
    if lengths.len() < MIN_SENTENCES {
        return None;
    }
    let n = lengths.len() as f64;
    let mean = lengths.iter().sum::<usize>() as f64 / n;
    let variance = lengths
        .iter()
        .map(|&l| (l as f64 - mean).powi(2))
        .sum::<f64>()
        / n;
    Some(variance.sqrt() / mean)
}

fn hits(text: &str, rules: &[(&'static str, Regex)]) -> Vec<Hit> {
    rules
        .iter()
        .flat_map(|(rule, re)| {
            re.find_iter(text).map(|m| Hit {
                rule,
                text: m.as_str().to_lowercase(),
            })
        })
        .collect()
}

/// At least one, else `per_100` for every hundred words.
fn budget(words: usize, per_100: f64) -> f64 {
    (words as f64 * per_100 / 100.0).max(1.0)
}

/// Scores one piece of text.
pub fn check(text: &str) -> Report {
    let text = normal(text);
    let words = text.split_whitespace().filter(|t| is_word(t)).count();
    let lengths = sentence_lengths(&text);
    let dashes = text.matches('\u{2014}').count()
        + text.matches(" \u{2013} ").count()
        + text.matches(" -- ").count();
    let mut report = Report {
        words,
        sentences: lengths.len(),
        p0: hits(&text, p0()),
        p1: hits(&text, p1()),
        dashes,
        tricolons: tricolon().find_iter(&text).count(),
        emoji: emoji().find_iter(&text).count(),
        spread: spread(&lengths),
        score: 0.0,
    };
    let over = |n: usize, allowed: f64| (n as f64 - allowed).max(0.0);
    let p1_over = over(report.p1.len(), budget(words, 2.0));
    let dash_over = over(dashes, budget(words, 1.0));
    let tricolon_over = over(report.tricolons, budget(words, 1.0));
    let flat = report.spread.map_or(0.0, |s| {
        if s < SPREAD_FLOOR {
            15.0 + 50.0 * (SPREAD_FLOOR - s)
        } else {
            0.0
        }
    });
    let penalty = 30.0 * report.p0.len() as f64
        + 3.0 * report.p1.len() as f64
        + 10.0 * p1_over
        + 2.0 * dashes as f64
        + 10.0 * dash_over
        + 2.0 * report.tricolons as f64
        + 10.0 * tricolon_over
        + 15.0 * report.emoji as f64
        + 8.0 * report.repeats().len() as f64
        + flat;
    report.score = (100.0 - penalty).clamp(0.0, 100.0);
    report
}

impl Report {
    /// P1 phrases used more often than once per 150 words (at least once).
    pub fn repeats(&self) -> Vec<String> {
        let allowed = budget(self.words, 100.0 / 150.0);
        let mut seen: Vec<(&str, usize)> = Vec::new();
        for hit in &self.p1 {
            match seen.iter_mut().find(|(t, _)| *t == hit.text) {
                Some((_, n)) => *n += 1,
                None => seen.push((&hit.text, 1)),
            }
        }
        seen.into_iter()
            .filter(|(_, n)| *n as f64 > allowed)
            .map(|(t, n)| format!("{t} ×{n}"))
            .collect()
    }

    /// Why it fails, if it does: one line per broken budget.
    pub fn failures(&self) -> Vec<String> {
        let mut out = Vec::new();
        for hit in &self.p0 {
            out.push(format!("P0 {}: \"{}\"", hit.rule, hit.text));
        }
        if self.p1.len() as f64 > budget(self.words, 2.0) {
            let list: Vec<String> = self.p1.iter().map(|h| format!("\"{}\"", h.text)).collect();
            out.push(format!(
                "P1 {} in {} words: {}",
                self.p1.len(),
                self.words,
                list.join(", ")
            ));
        }
        for repeat in self.repeats() {
            out.push(format!("P1 repeated: {repeat}"));
        }
        if self.dashes as f64 > budget(self.words, 1.0) {
            out.push(format!("{} em dashes in {} words", self.dashes, self.words));
        }
        if self.tricolons as f64 > budget(self.words, 1.0) {
            out.push(format!(
                "{} lists of three in {} words",
                self.tricolons, self.words
            ));
        }
        if self.emoji > 0 {
            out.push(format!("{} emoji", self.emoji));
        }
        if let Some(s) = self.spread.filter(|s| *s < SPREAD_FLOOR) {
            out.push(format!(
                "even rhythm: {} sentences vary by {s:.2} (floor {SPREAD_FLOOR})",
                self.sentences
            ));
        }
        out
    }

    pub fn passes(&self) -> bool {
        self.failures().is_empty()
    }
}

impl fmt::Display for Report {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "score {:.0}, {} words, {} P0, {} P1, {} dashes, {} threes, spread {}",
            self.score,
            self.words,
            self.p0.len(),
            self.p1.len(),
            self.dashes,
            self.tricolons,
            self.spread.map_or("-".into(), |s| format!("{s:.2}"))
        )?;
        for failure in self.failures() {
            write!(f, "\n  {failure}")?;
        }
        Ok(())
    }
}

// ── Corpora ───────────────────────────────────────────────────────────────

/// One text in a corpus.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Sample {
    /// Where it came from: `mock` (the headless model), `live provider/model`,
    /// or a citation for human and slop samples.
    pub from: String,
    /// What it is: `story`, `idea`, `chat`, `comment`, `review`, `recap` (older),
    /// `edit`, or for slop and human samples the case it covers.
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tone: Option<String>,
    pub text: String,
}

pub fn corpus_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src/ai/writing/corpus")
}

/// Every sample in a corpus file, or in every file of a folder.
pub fn corpus(name: &str) -> Vec<(String, Sample)> {
    let path = corpus_dir().join(name);
    let files: Vec<PathBuf> = if path.is_dir() {
        let mut files: Vec<PathBuf> = std::fs::read_dir(&path)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.extension().is_some_and(|e| e == "json"))
            .collect();
        files.sort();
        files
    } else {
        vec![path]
    };
    files
        .iter()
        .flat_map(|file| {
            let label = file.file_name().unwrap().to_string_lossy().to_string();
            let samples: Vec<Sample> =
                serde_json::from_str(&std::fs::read_to_string(file).unwrap())
                    .unwrap_or_else(|e| panic!("{label}: {e}"));
            samples.into_iter().map(move |s| (label.clone(), s))
        })
        .collect()
}

/// Lints every sample, prints a line per sample and the mean score, and
/// returns the mean with the samples that fail.
pub fn run(name: &str, samples: &[(String, Sample)]) -> (f64, Vec<String>) {
    let mut failing = Vec::new();
    let mut total = 0.0;
    for (file, sample) in samples {
        let report = check(&sample.text);
        total += report.score;
        let tone = sample
            .tone
            .as_deref()
            .map_or(String::new(), |t| format!(" {t}"));
        println!("{name} {file} {}{tone}: {report}", sample.kind);
        if !report.passes() {
            failing.push(format!(
                "{file} {}{tone}: {report}\n  {}",
                sample.kind, sample.text
            ));
        }
    }
    let mean = total / samples.len().max(1) as f64;
    println!("{name}: {} samples, mean score {mean:.1}", samples.len());
    (mean, failing)
}

/// For the headless mock's tests: lints `samples`, then checks they're the
/// ones frozen in `corpus/kin/<file>`, or with `KINTSUGI_RECORD_WRITING=1`
/// writes them there.
#[cfg(feature = "headless")]
pub fn freeze(file: &str, samples: Vec<Sample>) {
    let labelled: Vec<(String, Sample)> = samples
        .iter()
        .map(|s| (file.to_string(), s.clone()))
        .collect();
    let (_, failing) = run("mock", &labelled);
    assert!(
        failing.is_empty(),
        "the mock's output fails the slop lint:\n{}",
        failing.join("\n")
    );
    let path = corpus_dir().join("kin").join(file);
    let json = serde_json::to_string_pretty(&samples).unwrap() + "\n";
    if std::env::var_os("KINTSUGI_RECORD_WRITING").is_some() {
        std::fs::write(&path, json).unwrap();
        return;
    }
    let frozen = std::fs::read_to_string(&path).unwrap_or_default();
    assert_eq!(
        frozen, json,
        "the mock's output changed; record it again: KINTSUGI_RECORD_WRITING=1 cargo test -p kintsugi --no-default-features --features headless {file}"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn p0_tells_fail_and_plain_text_passes() {
        let plain = check(
            "Apple shipped a smaller model today. It costs a third as much and matches the old one on most benchmarks.",
        );
        assert!(plain.passes(), "{plain}");
        assert!(plain.score > 95.0, "{plain}");
        for slop in [
            "The launch stands as a testament to Apple's vision.",
            "Sales rose, highlighting the need for more stock.",
            "It's not a phone. It's a platform.",
            "In conclusion, the quarter went well.",
            "Great question! I hope this helps.",
            "Founded in [year] by [name].",
        ] {
            let report = check(slop);
            assert!(!report.p0.is_empty(), "{slop}: {report}");
            assert!(!report.passes());
        }
    }

    #[test]
    fn one_dash_and_one_three_are_fine_and_recurrence_is_not() {
        assert!(check("The patch shipped on Friday \u{2014} two days late.").passes());
        assert!(check("He packed bread, cheese and a knife.").passes());
        let dashes = check("It shipped \u{2014} late \u{2014} and broke \u{2014} twice.");
        assert!(!dashes.passes(), "{dashes}");
        let threes = check("We need speed, scale and trust. We want calm, focus and joy.");
        assert!(!threes.passes(), "{threes}");
    }

    #[test]
    fn even_rhythm_fails_and_varied_rhythm_passes() {
        let even = check(
            "The team shipped the new build. The users liked the new look. The press wrote a kind review. The stock went up a bit.",
        );
        assert!(even.spread.unwrap() < SPREAD_FLOOR, "{even}");
        assert!(!even.passes());
        let varied = check(
            "It broke. Nobody on the team could say why, and the logs from that night were gone by the time anyone looked. We rebuilt it. Twice.",
        );
        assert!(varied.passes(), "{varied}");
    }

    #[test]
    fn curly_quotes_count_as_straight_ones() {
        assert!(!check("It\u{2019}s not a bug, it\u{2019}s a feature.").passes());
    }

    #[test]
    fn the_score_drops_with_each_hit_inside_the_budget() {
        let one = check(
            "The plan is really simple, and it came out on time after a long winter of work.",
        );
        let none =
            check("The plan is simple, and it came out on time after a long winter of work.");
        assert!(one.passes() && none.passes());
        assert!(one.score < none.score);
    }

    /// Slop must fail: each sample breaks the budget its kind names.
    #[test]
    fn the_slop_corpus_fails() {
        let samples = corpus("slop.json");
        assert!(samples.len() >= 10);
        let (mean, failing) = run("slop", &samples);
        let passing: Vec<&str> = samples
            .iter()
            .filter(|(_, s)| check(&s.text).passes())
            .map(|(_, s)| s.kind.as_str())
            .collect();
        assert!(passing.is_empty(), "slop that passes the lint: {passing:?}");
        assert_eq!(failing.len(), samples.len());
        assert!(mean < 50.0, "slop scores {mean:.1}");
    }

    /// Human prose must pass, so the lint doesn't over-flag: public-domain
    /// passages and humanizer's do-not-flag cases.
    #[test]
    fn the_human_corpus_passes() {
        let samples = corpus("human.json");
        assert!(samples.len() >= 15);
        let (mean, failing) = run("human", &samples);
        assert!(
            failing.is_empty(),
            "human prose the lint flags:\n{}",
            failing.join("\n")
        );
        assert!(mean > 85.0, "human prose scores {mean:.1}");
    }

    /// Kin's recorded output must pass, and hold its score.
    #[test]
    fn the_recorded_kin_corpus_passes() {
        let samples = corpus("kin");
        assert!(samples.len() >= 20);
        let (mean, failing) = run("kin", &samples);
        assert!(
            failing.is_empty(),
            "Kin output the lint flags:\n{}",
            failing.join("\n")
        );
        assert!(
            mean >= KIN_BASELINE,
            "Kin's output scores {mean:.1}, under its baseline {KIN_BASELINE}"
        );
    }

    /// The recorded corpus's mean score when it was last recorded, less a
    /// little. Raise it when Kin's output gets cleaner.
    const KIN_BASELINE: f64 = 95.0;
}
