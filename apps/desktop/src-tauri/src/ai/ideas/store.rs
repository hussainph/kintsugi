//! The Ideas store: `<config>/kin/ideas/<vault key>/ideas.json` in app data
//! (never the vault), rewritten atomically, plus an append-only
//! `signals.jsonl` of everything Hussain did with an idea. The signals steer
//! the next batch.
//!
//! Fading is computed, not stored: an idea is fresh for its first three
//! days, thins until day seven, then sits in "faded this week" until day
//! fourteen and leaves the list. Adopted ideas never fade.

use chrono::{DateTime, FixedOffset, NaiveDate};
use kintsugi_vault::write_atomic;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::PathBuf;

type Result<T> = std::result::Result<T, String>;

/// Days an idea is shown at full strength.
pub const THIN_FROM: i64 = 3;
/// Days until an unused idea fades out of the list.
pub const FADE_DAYS: i64 = 7;
/// Faded ideas stay listed ("faded this week") until this age.
pub const GONE_DAYS: i64 = 14;
/// Unused ideas are deleted from the file after this many days.
const KEEP_DAYS: i64 = 30;
/// Signals the brief reads back.
pub const SIGNALS_IN_BRIEF: usize = 40;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Quote {
    /// A vault path with its extension, or `feed:<id>`.
    pub source: String,
    /// Verbatim; checked against the source when the idea was made.
    pub text: String,
    pub title: String,
    pub origin: String,
    #[serde(default)]
    pub own: bool,
    /// Wikilink target (vault path without extension) or a URL.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub did: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub found: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reason {
    pub id: String,
    pub text: String,
    /// The About you line this reason rests on, verbatim, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_line: Option<String>,
    /// Hussain said it isn't a reason.
    #[serde(default)]
    pub removed: bool,
}

/// What the helper spent finding the batch this idea came from.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Footprint {
    pub searches: u32,
    pub files: u32,
    pub seconds: u32,
    pub usd: f64,
    #[serde(default)]
    pub model: String,
    /// Ideas the run produced (the footprint is the whole run's).
    #[serde(default)]
    pub batch: u32,
}

/// Everything Kin wrote for an idea; Refine replaces it as a whole.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Content {
    /// gap, tension, stalled, connection or other.
    pub kind: String,
    pub title: String,
    /// The short working title Adopt gives a new draft.
    pub draft_title: String,
    pub snippet: String,
    pub observed: Vec<String>,
    pub hunch: String,
    pub quotes: Vec<Quote>,
    #[serde(default)]
    pub steps: Vec<Step>,
    #[serde(default)]
    pub reasons: Vec<Reason>,
    /// Documents the idea is about, for "ideas for this draft".
    #[serde(default)]
    pub about: Vec<String>,
    #[serde(default)]
    pub footprint: Footprint,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub content: Content,
    /// What Hussain asked Refine to change.
    pub asked: String,
    pub at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dismissal {
    pub at: String,
    #[serde(default)]
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Adoption {
    pub path: String,
    pub at: String,
    /// A new draft (else added to one already started).
    pub new: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Idea {
    pub id: String,
    pub created: String,
    /// The helper job that made it.
    pub job: String,
    #[serde(flatten)]
    pub content: Content,
    /// Earlier versions, oldest first; Refine's undo restores the last.
    #[serde(default)]
    pub versions: Vec<Version>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dismissed: Option<Dismissal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adopted: Option<Adoption>,
    /// A Refine job in flight.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refining: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refine_error: Option<String>,
    /// Its fading was recorded as a faint "no".
    #[serde(default)]
    pub faded_noted: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Stage {
    Fresh,
    Thin,
    Faded,
}

/// An idea as the list shows it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listed {
    #[serde(flatten)]
    pub idea: Idea,
    /// Days since Kin offered it.
    pub age: i64,
    pub stage: Stage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SignalKind {
    Dismissed,
    Undismissed,
    ReasonRemoved,
    ReasonRestored,
    Adopted,
    Discussed,
    Refined,
    RefineUndone,
    /// Unused for a week: a faint "no".
    Faded,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Signal {
    pub at: String,
    pub idea: String,
    pub title: String,
    pub kind: SignalKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct File {
    #[serde(default)]
    ideas: Vec<Idea>,
    /// The local date of the last daily batch.
    #[serde(default)]
    last_daily: Option<String>,
}

pub struct Store {
    dir: Option<PathBuf>,
    file: File,
    /// In-memory signals when there's no directory.
    signals: Vec<Signal>,
    next: u32,
}

fn date(at: &str) -> Option<NaiveDate> {
    DateTime::parse_from_rfc3339(at).ok().map(|d| d.date_naive())
}

/// Whole local days between `created` and `now`.
pub fn age(created: &str, now: DateTime<FixedOffset>) -> i64 {
    date(created).map_or(0, |d| (now.date_naive() - d).num_days().max(0))
}

pub fn stage(idea: &Idea, age: i64) -> Stage {
    if idea.adopted.is_some() || age < THIN_FROM {
        Stage::Fresh
    } else if age < FADE_DAYS {
        Stage::Thin
    } else {
        Stage::Faded
    }
}

impl Store {
    /// Opens the store in `dir` (`None`: in memory, for isolated runs and tests).
    pub fn open(dir: Option<PathBuf>) -> Self {
        let file = dir
            .as_ref()
            .and_then(|d| fs::read_to_string(d.join("ideas.json")).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Store { dir, file, signals: Vec::new(), next: 0 }
    }

    fn save(&self) -> Result<()> {
        let Some(dir) = &self.dir else { return Ok(()) };
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        write_atomic(&dir.join("ideas.json"), &serde_json::to_string_pretty(&self.file).map_err(|e| e.to_string())?)
    }

    fn signal(&mut self, idea: &Idea, kind: SignalKind, detail: Option<String>, now: DateTime<FixedOffset>) {
        let signal = Signal { at: now.to_rfc3339(), idea: idea.id.clone(), title: idea.content.title.clone(), kind, detail };
        match &self.dir {
            Some(dir) => {
                let _ = fs::create_dir_all(dir);
                if let (Ok(mut f), Ok(line)) = (
                    fs::OpenOptions::new().create(true).append(true).open(dir.join("signals.jsonl")),
                    serde_json::to_string(&signal),
                ) {
                    let _ = writeln!(f, "{line}");
                }
            }
            None => self.signals.push(signal),
        }
    }

    /// The newest `limit` signals, oldest first.
    pub fn signals(&self, limit: usize) -> Vec<Signal> {
        let all: Vec<Signal> = match &self.dir {
            Some(dir) => fs::read_to_string(dir.join("signals.jsonl"))
                .unwrap_or_default()
                .lines()
                .filter_map(|l| serde_json::from_str(l).ok())
                .collect(),
            None => self.signals.clone(),
        };
        all[all.len().saturating_sub(limit)..].to_vec()
    }

    pub fn last_daily(&self) -> Option<&str> {
        self.file.last_daily.as_deref()
    }

    pub fn set_last_daily(&mut self, day: &str) -> Result<()> {
        self.file.last_daily = Some(day.into());
        self.save()
    }

    /// New ideas from a helper job, in the order it gave them.
    pub fn add(&mut self, job: &str, contents: Vec<Content>, now: DateTime<FixedOffset>) -> Result<Vec<Idea>> {
        let stamp = now.format("%Y%m%d-%H%M%S").to_string();
        let mut added = Vec::new();
        for content in contents {
            self.next += 1;
            let mut id = format!("idea-{stamp}-{}", self.next);
            while self.file.ideas.iter().any(|i| i.id == id) {
                self.next += 1;
                id = format!("idea-{stamp}-{}", self.next);
            }
            let idea = Idea {
                id,
                created: now.to_rfc3339(),
                job: job.into(),
                content,
                versions: vec![],
                dismissed: None,
                adopted: None,
                refining: None,
                refine_error: None,
                faded_noted: false,
            };
            self.file.ideas.push(idea.clone());
            added.push(idea);
        }
        self.save()?;
        Ok(added)
    }

    pub fn get(&self, id: &str) -> Option<&Idea> {
        self.file.ideas.iter().find(|i| i.id == id)
    }

    fn change(&mut self, id: &str, f: impl FnOnce(&mut Idea) -> Result<()>) -> Result<Idea> {
        let idea = self.file.ideas.iter_mut().find(|i| i.id == id).ok_or("That idea is gone.")?;
        f(idea)?;
        let idea = idea.clone();
        self.save()?;
        Ok(idea)
    }

    /// The list, newest first. Ideas that just faded are recorded as a faint
    /// "no"; unused ones past [`KEEP_DAYS`] are deleted.
    pub fn list(&mut self, now: DateTime<FixedOffset>) -> Vec<Listed> {
        let before = self.file.ideas.len();
        self.file.ideas.retain(|i| i.adopted.is_some() || age(&i.created, now) < KEEP_DAYS);
        let mut changed = before != self.file.ideas.len();
        let newly: Vec<Idea> = self
            .file
            .ideas
            .iter_mut()
            .filter(|i| !i.faded_noted && i.dismissed.is_none() && stage(i, age(&i.created, now)) == Stage::Faded)
            .map(|i| {
                i.faded_noted = true;
                i.clone()
            })
            .collect();
        for idea in &newly {
            self.signal(idea, SignalKind::Faded, None, now);
            changed = true;
        }
        if changed {
            let _ = self.save();
        }
        let mut out: Vec<Listed> = self
            .file
            .ideas
            .iter()
            .map(|i| {
                let age = age(&i.created, now);
                Listed { stage: stage(i, age), age, idea: i.clone() }
            })
            .filter(|l| l.idea.adopted.is_some() || l.age < GONE_DAYS)
            .collect();
        // Newest batch first; within a batch, the helper's order.
        out.sort_by(|a, b| b.idea.created.cmp(&a.idea.created).then_with(|| seq(&a.idea.id).cmp(&seq(&b.idea.id))));
        out
    }

    /// Titles offered lately, so a batch doesn't repeat them.
    pub fn recent(&self, days: i64, now: DateTime<FixedOffset>) -> Vec<&Idea> {
        self.file.ideas.iter().filter(|i| age(&i.created, now) < days).collect()
    }

    pub fn dismiss(&mut self, id: &str, reasons: Vec<String>, now: DateTime<FixedOffset>) -> Result<Idea> {
        let reasons: Vec<String> = reasons.into_iter().map(|r| r.trim().chars().take(200).collect::<String>()).filter(|r| !r.is_empty()).take(6).collect();
        let idea = self.change(id, |i| {
            if i.adopted.is_some() {
                return Err("An adopted idea can't be dismissed.".into());
            }
            i.dismissed = Some(Dismissal { at: now.to_rfc3339(), reasons: reasons.clone() });
            Ok(())
        })?;
        self.signal(&idea, SignalKind::Dismissed, Some(reasons.join("; ")).filter(|r| !r.is_empty()), now);
        Ok(idea)
    }

    pub fn undismiss(&mut self, id: &str, now: DateTime<FixedOffset>) -> Result<Idea> {
        let idea = self.change(id, |i| {
            i.dismissed = None;
            Ok(())
        })?;
        self.signal(&idea, SignalKind::Undismissed, None, now);
        Ok(idea)
    }

    /// "Not a reason" (or its undo) in Why this?.
    pub fn set_reason(&mut self, id: &str, reason: &str, removed: bool, now: DateTime<FixedOffset>) -> Result<Idea> {
        let mut text = String::new();
        let idea = self.change(id, |i| {
            let r = i.content.reasons.iter_mut().find(|r| r.id == reason).ok_or("No such reason.")?;
            r.removed = removed;
            text = r.text.clone();
            Ok(())
        })?;
        let kind = if removed { SignalKind::ReasonRemoved } else { SignalKind::ReasonRestored };
        self.signal(&idea, kind, Some(text), now);
        Ok(idea)
    }

    pub fn set_refining(&mut self, id: &str, job: Option<String>) -> Result<Idea> {
        self.change(id, |i| {
            i.refining = job;
            i.refine_error = None;
            Ok(())
        })
    }

    pub fn refine_failed(&mut self, id: &str, error: &str) -> Result<Idea> {
        self.change(id, |i| {
            i.refining = None;
            i.refine_error = Some(error.into());
            Ok(())
        })
    }

    /// Refine's result replaces the idea; the earlier version is kept.
    pub fn refined(&mut self, id: &str, mut content: Content, asked: &str, now: DateTime<FixedOffset>) -> Result<Idea> {
        let idea = self.change(id, |i| {
            // Reasons he removed stay removed if Kin gives them again.
            for r in content.reasons.iter_mut() {
                r.removed = i.content.reasons.iter().any(|old| old.removed && old.text.eq_ignore_ascii_case(&r.text));
            }
            let previous = std::mem::replace(&mut i.content, content);
            i.versions.push(Version { content: previous, asked: asked.into(), at: now.to_rfc3339() });
            i.refining = None;
            i.refine_error = None;
            Ok(())
        })?;
        self.signal(&idea, SignalKind::Refined, Some(asked.into()), now);
        Ok(idea)
    }

    pub fn undo_refine(&mut self, id: &str, now: DateTime<FixedOffset>) -> Result<Idea> {
        let idea = self.change(id, |i| {
            let last = i.versions.pop().ok_or("Nothing to undo.")?;
            i.content = last.content;
            Ok(())
        })?;
        self.signal(&idea, SignalKind::RefineUndone, None, now);
        Ok(idea)
    }

    pub fn adopted(&mut self, id: &str, path: &str, new: bool, now: DateTime<FixedOffset>) -> Result<Idea> {
        let idea = self.change(id, |i| {
            i.adopted = Some(Adoption { path: path.into(), at: now.to_rfc3339(), new });
            i.dismissed = None;
            Ok(())
        })?;
        self.signal(&idea, SignalKind::Adopted, Some(path.into()), now);
        Ok(idea)
    }

    pub fn discussed(&mut self, id: &str, now: DateTime<FixedOffset>) -> Result<Idea> {
        let idea = self.get(id).cloned().ok_or("That idea is gone.")?;
        self.signal(&idea, SignalKind::Discussed, None, now);
        Ok(idea)
    }
}

/// The counter at the end of an id, for ordering within a batch.
fn seq(id: &str) -> u32 {
    id.rsplit('-').next().and_then(|n| n.parse().ok()).unwrap_or(0)
}
