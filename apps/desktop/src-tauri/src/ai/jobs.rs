//! Helper jobs: background or heavy work (ranking the feed, generating
//! ideas, long searches) that runs as its own agent, with its own context,
//! so the main conversation stays lean.
//!
//! The table is `<config>/kin/jobs.json` in app data, rewritten atomically
//! on every change, so jobs survive quitting: a job that was running when
//! the app quit is queued again on the next start. Each job gets a clear
//! brief plus Kin's memory snapshot (About you and the notes file, in the
//! cached prefix), runs as background work (it waits once the monthly cap
//! is reached), and reports back quietly as a helper entry in the log.

use chrono::Local;
use kintsugi_vault::write_atomic;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

static NEXT: AtomicU32 = AtomicU32::new(1);

type Result<T> = std::result::Result<T, String>;

/// Finished jobs kept in the table; the log keeps their reports for good.
const KEEP_FINISHED: usize = 200;
pub const MAX_BRIEF_BYTES: usize = 20_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Queued,
    Running,
    /// The monthly cap is reached; it runs again when spending allows.
    Waiting,
    Done,
    Failed,
    Cancelled,
}

impl Status {
    pub fn finished(self) -> bool {
        matches!(self, Status::Done | Status::Failed | Status::Cancelled)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    /// What asked for it, e.g. `"feed-ranking"`, `"ideas"`, `"search"`.
    pub kind: String,
    /// Kin task whose model it runs on: `"chat"`, `"ideas"` or `"triage"`.
    pub task: String,
    /// What to do, in full. The helper sees nothing else of the conversation.
    pub brief: String,
    /// The thread its report belongs to, if any.
    #[serde(default)]
    pub topic: String,
    pub status: Status,
    pub created: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished: Option<String>,
    /// The helper's report.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default)]
    pub usd: f64,
    /// Times it has started (a quit or the cap can interrupt it).
    #[serde(default)]
    pub attempts: u32,
}

/// What a helper's run looked like: its footprint (searches, files read,
/// time, cost), collected from the loop's events.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Trace {
    /// Queries passed to `search`.
    pub searches: Vec<String>,
    /// Paths passed to `read`.
    pub files: Vec<String>,
    pub tool_calls: usize,
    pub millis: u64,
    pub usd: f64,
    /// `provider/model`.
    pub model: String,
}

impl Trace {
    /// Notes one tool call.
    pub fn call(&mut self, name: &str, arguments: &serde_json::Value) {
        self.tool_calls += 1;
        match name {
            "search" => self.searches.push(arguments["query"].as_str().unwrap_or_default().into()),
            "read" => {
                if let Some(path) = arguments["path"].as_str().filter(|p| !p.starts_with("@out/")) {
                    self.files.push(path.trim().into());
                }
            }
            _ => {}
        }
    }
}

/// What a caller (the Feed, Ideas, Kin itself) asks for.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewJob {
    pub kind: String,
    #[serde(default)]
    pub task: Option<String>,
    pub brief: String,
    #[serde(default)]
    pub topic: Option<String>,
}

pub struct Table {
    path: Option<PathBuf>,
    jobs: Vec<Job>,
}

fn now() -> String {
    Local::now().to_rfc3339()
}

impl Table {
    /// Loads the table. Jobs that were running when the app quit go back in
    /// the queue.
    pub fn open(dir: Option<PathBuf>) -> Self {
        let path = dir.map(|d| d.join("jobs.json"));
        let mut jobs: Vec<Job> = path
            .as_ref()
            .and_then(|p| fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let mut resumed = false;
        for job in jobs.iter_mut().filter(|j| j.status == Status::Running) {
            job.status = Status::Queued;
            resumed = true;
        }
        let table = Table { path, jobs };
        if resumed {
            let _ = table.save();
        }
        table
    }

    fn save(&self) -> Result<()> {
        let Some(path) = &self.path else { return Ok(()) };
        fs::create_dir_all(path.parent().ok_or("bad jobs path")?).map_err(|e| e.to_string())?;
        write_atomic(path, &serde_json::to_string_pretty(&self.jobs).map_err(|e| e.to_string())?)
    }

    pub fn create(&mut self, new: NewJob, task: &str) -> Result<Job> {
        let brief = new.brief.trim();
        if brief.is_empty() {
            return Err("A helper needs a brief.".into());
        }
        if brief.len() > MAX_BRIEF_BYTES {
            return Err("That brief is too long.".into());
        }
        let job = Job {
            id: format!("job-{}-{}", Local::now().format("%Y%m%d-%H%M%S%3f"), NEXT.fetch_add(1, Ordering::Relaxed)),
            kind: new.kind.trim().chars().take(40).collect(),
            task: task.into(),
            brief: brief.into(),
            topic: new.topic.unwrap_or_default(),
            status: Status::Queued,
            created: now(),
            started: None,
            finished: None,
            result: None,
            error: None,
            usd: 0.0,
            attempts: 0,
        };
        self.jobs.push(job.clone());
        self.prune();
        self.save()?;
        Ok(job)
    }

    fn prune(&mut self) {
        let finished = self.jobs.iter().filter(|j| j.status.finished()).count();
        let mut drop = finished.saturating_sub(KEEP_FINISHED);
        self.jobs.retain(|j| {
            if drop > 0 && j.status.finished() {
                drop -= 1;
                return false;
            }
            true
        });
    }

    pub fn list(&self) -> Vec<Job> {
        self.jobs.iter().rev().cloned().collect()
    }

    pub fn get(&self, id: &str) -> Option<&Job> {
        self.jobs.iter().find(|j| j.id == id)
    }

    /// The next job to run: the oldest queued one; waiting ones too when
    /// spending allows.
    pub fn next(&self, cap_allows: bool) -> Option<Job> {
        self.jobs
            .iter()
            .find(|j| j.status == Status::Queued || (cap_allows && j.status == Status::Waiting))
            .cloned()
    }

    pub fn update(&mut self, id: &str, change: impl FnOnce(&mut Job)) -> Option<Job> {
        let job = self.jobs.iter_mut().find(|j| j.id == id)?;
        change(job);
        let job = job.clone();
        let _ = self.save();
        Some(job)
    }

    pub fn start(&mut self, id: &str) -> Option<Job> {
        self.update(id, |j| {
            j.status = Status::Running;
            j.started = Some(now());
            j.attempts += 1;
        })
    }

    pub fn finish(&mut self, id: &str, status: Status, result: Option<String>, error: Option<String>, usd: f64) -> Option<Job> {
        self.update(id, |j| {
            j.status = status;
            j.usd += usd;
            if status.finished() {
                j.finished = Some(now());
            }
            if result.is_some() {
                j.result = result;
            }
            j.error = error;
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn new(brief: &str) -> NewJob {
        NewJob { kind: "ideas".into(), task: None, brief: brief.into(), topic: None }
    }

    #[test]
    fn jobs_survive_quitting_and_running_ones_are_queued_again() {
        let dir = tempfile::tempdir().unwrap();
        let mut table = Table::open(Some(dir.path().into()));
        let a = table.create(new("Rank today's feed"), "triage").unwrap();
        let b = table.create(new("Find three ideas"), "ideas").unwrap();
        assert!(table.create(new("  "), "chat").is_err());
        assert_ne!(a.id, b.id);
        table.start(&a.id).unwrap();
        assert_eq!(table.next(true).unwrap().id, b.id, "a running job isn't picked twice");

        // Quit mid-run: the running job is queued again, first in line.
        let reopened = Table::open(Some(dir.path().into()));
        let job = reopened.get(&a.id).unwrap();
        assert_eq!((job.status, job.attempts), (Status::Queued, 1));
        assert_eq!(reopened.next(true).unwrap().id, a.id);
        assert_eq!(reopened.list()[0].id, b.id, "newest first");
    }

    #[test]
    fn waiting_jobs_resume_only_when_the_cap_allows() {
        let mut table = Table::open(None);
        let a = table.create(new("Rank the feed"), "triage").unwrap();
        table.start(&a.id);
        table.finish(&a.id, Status::Waiting, None, Some("cap".into()), 0.5).unwrap();
        assert!(table.next(false).is_none());
        assert_eq!(table.next(true).unwrap().id, a.id);
        let done = table.finish(&a.id, Status::Done, Some("Ranked.".into()), None, 0.25).unwrap();
        assert_eq!((done.usd, done.result.as_deref(), done.error), (0.75, Some("Ranked."), None));
        assert!(done.finished.is_some());
    }
}
