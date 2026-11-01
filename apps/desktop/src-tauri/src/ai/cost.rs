//! What AI calls cost, and the monthly cap.
//!
//! Every call's token usage is priced and appended to `usage.jsonl` in Kin's
//! data folder (`<config>/kin/`, never the vault); the month's total is kept
//! in memory. Kin's settings (the cap, per-task model choices) sit beside it
//! in `settings.json`. When the month's spend reaches the cap, background
//! work (enrichment, feed triage, daily Ideas) stops; a turn the owner asked
//! for still runs and reports that the cap is reached.
//!
//! Prices are estimates in US dollars per million tokens, matched on model
//! family. Subscription logins (ChatGPT Codex, the Z.AI coding plan) and
//! local models cost nothing per token; their tokens are still counted. An
//! unknown paid model is priced high, so the cap errs towards stopping early.

use super::wire::Usage;
use super::{ModelRef, Task};
use kintsugi_vault::write_atomic;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::Mutex;

type Result<T> = std::result::Result<T, String>;

/// USD per million tokens.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Price {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
}

const FREE: Price = Price { input: 0.0, output: 0.0, cache_read: 0.0, cache_write: 0.0 };
/// For a paid model we don't recognize: deliberately on the expensive side.
const UNKNOWN: Price = Price { input: 5.0, output: 25.0, cache_read: 0.5, cache_write: 6.25 };

/// Model families, matched as substrings of the model id, first match wins.
const FAMILIES: &[(&str, Price)] = &[
    ("opus", Price { input: 5.0, output: 25.0, cache_read: 0.5, cache_write: 6.25 }),
    ("sonnet", Price { input: 3.0, output: 15.0, cache_read: 0.3, cache_write: 3.75 }),
    ("haiku", Price { input: 1.0, output: 5.0, cache_read: 0.1, cache_write: 1.25 }),
    ("gemini-flash", Price { input: 0.3, output: 2.5, cache_read: 0.03, cache_write: 0.3 }),
    ("-mini", Price { input: 0.25, output: 2.0, cache_read: 0.025, cache_write: 0.25 }),
    ("gpt", Price { input: 1.25, output: 10.0, cache_read: 0.125, cache_write: 1.25 }),
];

/// The price of a model, and whether it's a guess.
pub fn price(provider: &str, model: &str) -> (Price, bool) {
    // Flat-rate subscriptions and the Mac's own models.
    if matches!(provider, "openai-codex" | "zai" | "ollama") {
        return (FREE, false);
    }
    let model = model.to_lowercase();
    match FAMILIES.iter().find(|(family, _)| model.contains(family)) {
        Some((_, price)) => (*price, false),
        None => (UNKNOWN, true),
    }
}

pub fn usd(price: &Price, usage: &Usage) -> f64 {
    (usage.input as f64 * price.input
        + usage.output as f64 * price.output
        + usage.cache_read as f64 * price.cache_read
        + usage.cache_write as f64 * price.cache_write)
        / 1_000_000.0
}

/// Kin's own settings, separate from `config.json` so they work in scratch runs.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// US dollars per calendar month; `None` means no cap.
    pub monthly_cap_usd: Option<f64>,
    /// The owner's model for a task (`"chat"`, `"ideas"`, `"triage"`),
    /// overriding the default preference list.
    #[serde(default)]
    pub models: BTreeMap<String, ModelRef>,
}

/// One priced call, as written to the ledger.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Charge {
    pub at: String,
    /// `YYYY-MM`, local time.
    pub month: String,
    pub task: String,
    pub provider: String,
    pub model: String,
    pub usage: Usage,
    pub usd: f64,
    #[serde(default)]
    pub estimated: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSpend {
    pub task: String,
    pub usd: f64,
    pub calls: u64,
    pub usage: Usage,
}

/// What Settings shows.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub month: String,
    pub spent_usd: f64,
    pub cap_usd: Option<f64>,
    pub cap_reached: bool,
    /// Some of the month's spend used a guessed price.
    pub estimated: bool,
    pub by_task: Vec<TaskSpend>,
    /// Where the ledger lives, or `None` when this run keeps it in memory.
    pub ledger: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CapReached;

impl CapReached {
    pub const MESSAGE: &str = "This month's AI spending cap is reached, so background work has stopped. Raise the cap in Settings to resume.";
}

#[derive(Default)]
struct State {
    month: String,
    by_task: BTreeMap<String, TaskSpend>,
    estimated: bool,
}

impl State {
    fn spent(&self) -> f64 {
        self.by_task.values().map(|t| t.usd).sum()
    }

    fn add(&mut self, charge: &Charge) {
        let entry = self.by_task.entry(charge.task.clone()).or_insert_with(|| TaskSpend {
            task: charge.task.clone(),
            ..Default::default()
        });
        entry.usd += charge.usd;
        entry.calls += 1;
        entry.usage.add(&charge.usage);
        self.estimated |= charge.estimated;
    }
}

pub struct Meter {
    /// `None`: an isolated run that must not persist anything.
    dir: Option<PathBuf>,
    clock: fn() -> String,
    settings: Mutex<Settings>,
    state: Mutex<State>,
}

fn this_month() -> String {
    chrono::Local::now().format("%Y-%m").to_string()
}

impl Meter {
    pub fn open(dir: Option<PathBuf>) -> Self {
        Self::with_clock(dir, this_month)
    }

    pub fn with_clock(dir: Option<PathBuf>, clock: fn() -> String) -> Self {
        let settings = dir
            .as_ref()
            .and_then(|d| fs::read_to_string(d.join("settings.json")).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let meter = Meter { dir, clock, settings: Mutex::new(settings), state: Mutex::default() };
        meter.reload(&mut meter.state.lock().unwrap());
        meter
    }

    /// Sums this month's ledger lines. A torn last line is skipped.
    fn reload(&self, state: &mut State) {
        let month = (self.clock)();
        *state = State { month: month.clone(), ..Default::default() };
        let Some(text) = self.dir.as_ref().and_then(|d| fs::read_to_string(d.join("usage.jsonl")).ok()) else {
            return;
        };
        for charge in text.lines().filter_map(|l| serde_json::from_str::<Charge>(l).ok()) {
            if charge.month == month {
                state.add(&charge);
            }
        }
    }

    /// The month's state, starting fresh when the month has turned.
    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        let mut state = self.state.lock().unwrap();
        if state.month != (self.clock)() {
            self.reload(&mut state);
        }
        state
    }

    pub fn settings(&self) -> Settings {
        self.settings.lock().unwrap().clone()
    }

    pub fn update_settings(&self, change: impl FnOnce(&mut Settings)) -> Result<Settings> {
        let mut settings = self.settings.lock().unwrap();
        let mut next = settings.clone();
        change(&mut next);
        if let Some(cap) = next.monthly_cap_usd
            && !(cap.is_finite() && cap >= 0.0)
        {
            return Err("The cap must be zero or more dollars.".into());
        }
        if let Some(dir) = &self.dir {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            let json = serde_json::to_string_pretty(&next).map_err(|e| e.to_string())?;
            write_atomic(&dir.join("settings.json"), &json)?;
        }
        *settings = next.clone();
        Ok(next)
    }

    pub fn cap_reached(&self) -> bool {
        let cap = self.settings.lock().unwrap().monthly_cap_usd;
        cap.is_some_and(|cap| self.state().spent() >= cap)
    }

    /// May work start? Background work stops at the cap; foreground work
    /// (the owner is waiting) always may.
    pub fn allows(&self, background: bool) -> std::result::Result<(), CapReached> {
        if background && self.cap_reached() { Err(CapReached) } else { Ok(()) }
    }

    /// Prices and records one call; returns its cost. A ledger that can't be
    /// written still counts the spend in memory, so the cap holds.
    pub fn record(&self, task: Task, model: &ModelRef, usage: &Usage) -> f64 {
        let (price, estimated) = price(&model.provider, &model.model);
        let mut state = self.state();
        let charge = Charge {
            at: chrono::Local::now().to_rfc3339(),
            month: state.month.clone(),
            task: task.id().into(),
            provider: model.provider.clone(),
            model: model.model.clone(),
            usage: *usage,
            usd: usd(&price, usage),
            estimated,
        };
        state.add(&charge);
        if let Some(dir) = &self.dir {
            let line = serde_json::to_string(&charge).unwrap_or_default();
            let _ = fs::create_dir_all(dir).and_then(|_| {
                let mut file = OpenOptions::new().create(true).append(true).open(dir.join("usage.jsonl"))?;
                writeln!(file, "{line}")
            });
        }
        charge.usd
    }

    pub fn report(&self) -> Report {
        let cap = self.settings.lock().unwrap().monthly_cap_usd;
        let state = self.state();
        let spent = state.spent();
        Report {
            month: state.month.clone(),
            spent_usd: spent,
            cap_usd: cap,
            cap_reached: cap.is_some_and(|c| spent >= c),
            estimated: state.estimated,
            by_task: state.by_task.values().cloned().collect(),
            ledger: self.dir.as_ref().map(|d| d.join("usage.jsonl").to_string_lossy().into()),
        }
    }

    /// Where long tool outputs go (see `tools.rs`).
    pub fn outputs_dir(&self) -> PathBuf {
        match &self.dir {
            Some(dir) => dir.join("outputs"),
            None => std::env::temp_dir().join(format!("kintsugi-kin-{}", std::process::id())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(provider: &str, model: &str) -> ModelRef {
        ModelRef { provider: provider.into(), model: model.into(), reasoning: None }
    }

    const MILLION_IN: Usage = Usage { input: 1_000_000, output: 0, cache_read: 0, cache_write: 0 };

    #[test]
    fn prices_by_family_with_free_subscriptions_and_a_high_default() {
        assert_eq!(price("anthropic", "claude-sonnet-5-5").0.input, 3.0);
        assert_eq!(price("openrouter", "~anthropic/claude-haiku-latest").0.output, 5.0);
        assert_eq!(price("openai-codex", "gpt-6-luna"), (FREE, false));
        assert_eq!(price("zai", "glm-5.3"), (FREE, false));
        assert_eq!(price("openrouter", "mystery-model"), (UNKNOWN, true));
        let usage = Usage { input: 1000, output: 2000, cache_read: 10_000, cache_write: 4000 };
        let cost = usd(&price("anthropic", "claude-sonnet-5-5").0, &usage);
        assert!((cost - (0.003 + 0.03 + 0.003 + 0.015)).abs() < 1e-9, "{cost}");
    }

    #[test]
    fn records_to_the_ledger_and_reloads_this_month_only() {
        let dir = tempfile::tempdir().unwrap();
        let meter = Meter::with_clock(Some(dir.path().into()), || "2026-11".into());
        let spent = meter.record(Task::Chat, &model("anthropic", "claude-sonnet-5-5"), &MILLION_IN);
        assert_eq!(spent, 3.0);
        meter.record(Task::Triage, &model("anthropic", "claude-haiku-5-5"), &MILLION_IN);
        // A charge from last month and a torn line are ignored.
        let ledger = dir.path().join("usage.jsonl");
        let mut text = fs::read_to_string(&ledger).unwrap();
        text.push_str(&text.lines().next().unwrap().replace("2026-11", "2026-10"));
        text.push_str("\n{\"torn\":");
        fs::write(&ledger, text).unwrap();

        let reopened = Meter::with_clock(Some(dir.path().into()), || "2026-11".into());
        let report = reopened.report();
        assert_eq!(report.spent_usd, 4.0);
        assert_eq!(report.by_task.iter().map(|t| (t.task.as_str(), t.calls)).collect::<Vec<_>>(), [("chat", 1), ("triage", 1)]);
        assert!(!report.estimated);
        let next_month = Meter::with_clock(Some(dir.path().into()), || "2026-12".into());
        assert_eq!(next_month.report().spent_usd, 0.0);
    }

    #[test]
    fn the_cap_stops_background_work_only() {
        let dir = tempfile::tempdir().unwrap();
        let meter = Meter::with_clock(Some(dir.path().into()), || "2026-11".into());
        assert_eq!(meter.allows(true), Ok(()));
        meter.update_settings(|s| s.monthly_cap_usd = Some(3.0)).unwrap();
        meter.record(Task::Chat, &model("anthropic", "claude-sonnet-5-5"), &MILLION_IN);
        assert!(meter.cap_reached());
        assert_eq!(meter.allows(true), Err(CapReached));
        assert_eq!(meter.allows(false), Ok(()));
        // The cap persists.
        let reopened = Meter::with_clock(Some(dir.path().into()), || "2026-11".into());
        assert_eq!(reopened.settings().monthly_cap_usd, Some(3.0));
        assert!(reopened.report().cap_reached);
        assert!(meter.update_settings(|s| s.monthly_cap_usd = Some(-1.0)).is_err());
        assert!(meter.update_settings(|s| s.monthly_cap_usd = Some(f64::NAN)).is_err());
    }

    #[test]
    fn an_isolated_meter_writes_nothing() {
        let meter = Meter::with_clock(None, || "2026-11".into());
        meter.update_settings(|s| s.monthly_cap_usd = Some(1.0)).unwrap();
        meter.record(Task::Chat, &model("openrouter", "unknown"), &MILLION_IN);
        let report = meter.report();
        assert_eq!(report.spent_usd, 5.0);
        assert!(report.estimated && report.cap_reached && report.ledger.is_none());
    }
}
