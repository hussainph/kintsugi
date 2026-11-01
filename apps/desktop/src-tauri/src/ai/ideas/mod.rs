//! Ideas (KI-39): a small daily batch of specific, grounded ideas about
//! Hussain's writing and collection, plus ideas on demand.
//!
//! - **Made by a helper.** A batch is a helper job (KI-31's job table) on
//!   the `ideas` model task: background work, so it waits at the monthly cap.
//!   Its brief ([`brief`]) carries the rules, what he did with earlier ideas
//!   and the Feed items he acted on; it searches and reads with Kin's tools
//!   and replies with JSON.
//! - **Checked before he sees it** ([`ground`]): every quote must appear
//!   verbatim in the vault file or Feed item it names, or the idea is
//!   dropped; ideas never carry draft prose.
//! - **Kept in app data** ([`store`]), never the vault, with an append-only
//!   signal log (dismissals and their reasons, removed reasons, adoptions,
//!   refinements, fading) that steers the next batch.
//! - **Adopt** ([`adopt`]) is the one vault write: a new draft with a working
//!   title, an empty body and the idea in its frontmatter, or the idea added
//!   to a draft's frontmatter. Both are Hussain's explicit action.

pub mod adopt;
pub mod brief;
pub mod ground;
pub mod store;
#[cfg(test)]
mod tests;

use super::Task;
use super::jobs::{Job, NewJob, Trace};
use crate::AppHandle;
use chrono::{DateTime, FixedOffset};
use ground::{Sources, SourceDoc};
use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use store::{Listed, Store};
use tauri::{Emitter, Manager, async_runtime};

type Result<T> = std::result::Result<T, String>;

/// The job kinds Ideas owns.
pub const BATCH: &str = "ideas";
pub const REFINE: &str = "ideas-refine";
const CHANGED: &str = "ideas:changed";
/// How far back the brief lists titles already offered.
const RECENT_DAYS: i64 = 14;
const FEED_SIGNALS: usize = 15;
const MAX_ASK: usize = 500;

/// The open vault's store. Reopened when the vault changes.
static STATE: Mutex<Option<(PathBuf, Store)>> = Mutex::new(None);

/// Local now. Headless runs can move the clock forward
/// (`KINTSUGI_HEADLESS_IDEAS_DAYS_AHEAD`) to see ideas thin and fade.
pub fn now() -> DateTime<FixedOffset> {
    #[allow(unused_mut)]
    let mut now = chrono::Local::now().fixed_offset();
    #[cfg(feature = "headless")]
    if let Some(days) = std::env::var("KINTSUGI_HEADLESS_IDEAS_DAYS_AHEAD").ok().and_then(|d| d.parse::<i64>().ok()) {
        now += chrono::Duration::days(days.clamp(0, 60));
    }
    now
}

fn store_dir(app: &AppHandle, root: &Path) -> Option<PathBuf> {
    let key = kintsugi_vault::version(&root.to_string_lossy());
    super::kin::data_dir(app).map(|d| d.join("ideas").join(key))
}

fn with<T>(app: &AppHandle, f: impl FnOnce(&mut Store, &Path) -> Result<T>) -> Result<T> {
    let root = crate::vault::current(app)?.canonicalize().map_err(|e| format!("vault: {e}"))?;
    let mut state = STATE.lock().map_err(|_| "Ideas are unavailable.")?;
    if state.as_ref().is_none_or(|(r, _)| *r != root) {
        *state = Some((root.clone(), Store::open(store_dir(app, &root))));
    }
    let (root, store) = state.as_mut().expect("just opened");
    let root = root.clone();
    f(store, &root)
}

fn changed(app: &AppHandle) {
    let _ = app.emit(CHANGED, ());
}

// --- Sources ----------------------------------------------------------------

/// Quotes come from the vault (not hidden files, not links) or the Feed.
pub struct VaultSources<'a> {
    pub root: &'a Path,
    pub feed: Option<&'a (dyn Fn(i64) -> Option<SourceDoc> + Sync)>,
}

fn field<'t>(head: &'t str, key: &str) -> Option<&'t str> {
    head.lines()
        .find_map(|l| l.strip_prefix(key)?.strip_prefix(':'))
        .map(|v| v.trim().trim_matches(|c| c == '"' || c == '\''))
        .filter(|v| !v.is_empty())
}

impl Sources for VaultSources<'_> {
    fn get(&self, source: &str) -> Option<SourceDoc> {
        let source = source.trim().trim_start_matches("[[").trim_end_matches("]]").trim_start_matches("./");
        let source = source.split(['#', '|']).next().unwrap_or_default().trim();
        if let Some(id) = source.strip_prefix("feed:") {
            return self.feed.and_then(|f| f(id.trim().parse().ok()?));
        }
        if source.is_empty() || Path::new(source).components().any(|c| !matches!(c, Component::Normal(_))) {
            return None;
        }
        if source.split('/').any(|part| part.starts_with('.')) {
            return None;
        }
        let has_ext = [".md", ".mdx", ".txt"].iter().any(|e| source.ends_with(e));
        let candidates: Vec<String> = if has_ext { vec![source.into()] } else { vec![format!("{source}.md"), format!("{source}.mdx")] };
        let root = self.root.canonicalize().ok()?;
        for rel in candidates {
            let mut at = root.clone();
            let mut linked = false;
            for part in rel.split('/') {
                at.push(part);
                if std::fs::symlink_metadata(&at).is_ok_and(|m| m.file_type().is_symlink()) {
                    linked = true;
                }
            }
            if linked || !at.is_file() {
                continue;
            }
            let text = std::fs::read_to_string(&at).ok()?;
            let head = text.strip_prefix("---").and_then(|t| t.split("\n---").next()).unwrap_or_default();
            let stem = rel.rsplit_once('.').map_or(rel.as_str(), |(s, _)| s).to_string();
            let name = stem.rsplit('/').next().unwrap_or(&stem).replace('-', " ");
            let clip = rel.starts_with(&format!("{}/", kintsugi_vault::INSPIRATION));
            let note = rel.starts_with(&format!("{}/", kintsugi_vault::INBOX));
            let origin = if clip {
                field(head, "site").map(str::to_string).unwrap_or_else(|| "Inspiration".into())
            } else if note {
                "Your note".into()
            } else {
                "Your writing".into()
            };
            return Some(SourceDoc {
                id: rel.clone(),
                title: field(head, "title").map(str::to_string).unwrap_or(name),
                origin,
                own: !clip,
                link: Some(stem),
                text,
            });
        }
        None
    }
}

fn feed_source(app: &AppHandle, id: i64) -> Option<SourceDoc> {
    let crate::feed::Quotable { title, source, url, text } = crate::feed::quotable(app, id).ok()??;
    Some(SourceDoc {
        id: format!("feed:{id}"),
        title,
        origin: if source.is_empty() { "Feed".into() } else { format!("Feed · {source}") },
        own: false,
        link: url,
        text,
    })
}

fn about_you(app: &AppHandle, root: &Path) -> Vec<String> {
    super::about::store(app, root).map(|s| s.snapshot().about).unwrap_or_default()
}

// --- Helper jobs ------------------------------------------------------------

/// For the `idea` tool: one idea as JSON.
pub fn reader(app: &AppHandle) -> super::tools::IdeaReader {
    let app = app.clone();
    std::sync::Arc::new(move |id: &str| {
        with(&app, |store, _| Ok(store.get(id.trim()).cloned())).ok().flatten().map(|idea| {
            let c = &idea.content;
            serde_json::json!({
                "id": idea.id,
                "offered": idea.created,
                "kind": c.kind,
                "title": c.title,
                "snippet": c.snippet,
                "observed": c.observed,
                "hunch": c.hunch,
                "quotes": c.quotes.iter().map(|q| serde_json::json!({ "source": q.source, "title": q.title, "text": q.text })).collect::<Vec<_>>(),
                "reasons": c.reasons.iter().filter(|r| !r.removed).map(|r| &r.text).collect::<Vec<_>>(),
                "removedReasons": c.reasons.iter().filter(|r| r.removed).map(|r| &r.text).collect::<Vec<_>>(),
                "steps": c.steps,
                "adoptedInto": idea.adopted.as_ref().map(|a| &a.path),
                "dismissed": idea.dismissed.is_some(),
            })
            .to_string()
        })
    })
}

/// A helper finished: store a batch's checked ideas, or a refinement.
pub fn finish_job(app: &AppHandle, job: &Job, report: String, trace: &Trace) -> Result<String> {
    let result = match job.kind.as_str() {
        BATCH => with(app, |store, root| {
            let feed = |id| feed_source(app, id);
            let sources = VaultSources { root, feed: Some(&feed) };
            finish_batch(store, &sources, &about_you(app, root), job, &report, trace, now())
        }),
        REFINE => with(app, |store, root| {
            let feed = |id| feed_source(app, id);
            let sources = VaultSources { root, feed: Some(&feed) };
            finish_refine(store, &sources, &about_you(app, root), job, &report, trace, now())
        }),
        _ => return Ok(report),
    };
    changed(app);
    result
}

/// Checks and stores a batch; returns the report for the conversation log.
pub fn finish_batch(
    store: &mut Store,
    sources: &dyn Sources,
    about_you: &[String],
    job: &Job,
    report: &str,
    trace: &Trace,
    now: DateTime<FixedOffset>,
) -> Result<String> {
    let candidates = ground::parse(report)?;
    let offered = candidates.len();
    let recent: Vec<String> = store.recent(RECENT_DAYS, now).iter().map(|i| i.content.title.to_lowercase()).collect();
    let (fresh, repeats): (Vec<_>, Vec<_>) = candidates.into_iter().partition(|c| !recent.contains(&c.title.trim().to_lowercase()));
    let mut checked = ground::check(fresh, sources, about_you, &ground::footprint(trace, 0), ground::MAX_BATCH);
    checked.dropped.extend(repeats.into_iter().map(|c| (c.title, "it was offered already".to_string())));
    let n = checked.accepted.len();
    for content in checked.accepted.iter_mut() {
        content.footprint.batch = n as u32;
    }
    if n == 0 && offered > 0 {
        let why: Vec<String> = checked.dropped.iter().map(|(t, w)| format!("“{t}” ({w})")).collect();
        return Err(format!("None of the {offered} ideas passed the checks: {}.", why.join("; ")));
    }
    let added = store.add(&job.id, checked.accepted, now)?;
    if added.is_empty() {
        return Ok("No ideas worth your time this round.".into());
    }
    let titles: Vec<String> = added.iter().map(|i| format!("“{}”", i.content.title)).collect();
    let mut out = format!("{} new idea{} in Ideas: {}.", added.len(), if added.len() == 1 { "" } else { "s" }, titles.join(", "));
    if !checked.dropped.is_empty() {
        let why: Vec<String> = checked.dropped.iter().map(|(t, w)| format!("“{t}”, because {w}")).collect();
        out.push_str(&format!(" I dropped {}: {}.", checked.dropped.len(), why.join("; ")));
    }
    Ok(out)
}

/// Checks a refinement; the idea keeps its earlier version.
pub fn finish_refine(
    store: &mut Store,
    sources: &dyn Sources,
    about_you: &[String],
    job: &Job,
    report: &str,
    trace: &Trace,
    now: DateTime<FixedOffset>,
) -> Result<String> {
    let Some(idea) = store.recent(i64::MAX, now).into_iter().find(|i| i.refining.as_deref() == Some(job.id.as_str())).cloned() else {
        return Ok("The idea I was refining is gone.".into());
    };
    let asked = job.brief.split("He asked: \"").nth(1).and_then(|r| r.split('"').next()).unwrap_or_default().to_string();
    let checked = ground::parse(report).and_then(|mut c| {
        let first = c.drain(..).next().ok_or("The helper returned no idea.")?;
        ground::check_one(first, sources, about_you, &ground::footprint(trace, 1)).map_err(|why| format!("The refined idea was dropped: {why}."))
    });
    match checked {
        Ok(content) => {
            let refined = store.refined(&idea.id, content, &asked, now)?;
            Ok(format!("Refined “{}” into “{}”. The earlier version is kept.", idea.content.title, refined.content.title))
        }
        Err(e) => {
            store.refine_failed(&idea.id, &e)?;
            Err(e)
        }
    }
}

fn engine(app: &AppHandle) -> Result<super::chat::Engine<super::chat::AppBrain>> {
    Ok(app.state::<super::Chat>().engine()?.clone())
}

fn feed_signals(app: &AppHandle) -> Vec<brief::FeedSignal> {
    crate::feed::acted_on(app, FEED_SIGNALS)
        .unwrap_or_default()
        .into_iter()
        .map(|a| brief::FeedSignal { id: a.id, title: a.title, source: a.source, liked: a.liked, saved: a.saved, note: a.note })
        .collect()
}

/// Starts a batch: the daily one, or ideas on demand.
fn generate(app: &AppHandle, ask: brief::Ask) -> Result<Job> {
    let now = now();
    let text = with(app, |store, root| {
        if let Some(about) = &ask.about
            && (VaultSources { root, feed: None }).get(about).is_none()
        {
            return Err(format!("{about} isn't a document in this vault."));
        }
        let recent = store.recent(RECENT_DAYS, now);
        Ok(brief::batch(&ask, &recent, &store.signals(store::SIGNALS_IN_BRIEF), &feed_signals(app)))
    })?;
    let job = engine(app)?.create_job(NewJob { kind: BATCH.into(), task: Some(Task::Ideas.id().into()), brief: text, topic: ask.about.clone() })?;
    changed(app);
    Ok(job)
}

/// A batch is already queued or running (or waiting at the cap).
fn busy(jobs: &[Job]) -> bool {
    jobs.iter().any(|j| j.kind == BATCH && !j.status.finished())
}

/// Makes today's batch if it isn't made yet, Kin can reach a model for
/// Ideas, and the month's cap allows.
pub async fn daily(app: &AppHandle) -> Result<bool> {
    let today = now().format("%Y-%m-%d").to_string();
    if with(app, |store, _| Ok(store.last_daily() == Some(today.as_str())))? {
        return Ok(false);
    }
    let engine = engine(app)?;
    if busy(&engine.jobs()) || super::meter().allows(true).is_err() || super::kin::connect(Task::Ideas).await.is_err() {
        return Ok(false);
    }
    generate(app, brief::Ask { count: ground::MAX_BATCH, ..Default::default() })?;
    with(app, |store, _| store.set_last_daily(&today))?;
    Ok(true)
}

/// Checks for the daily batch soon after start, then every half hour.
pub fn init(app: &AppHandle) {
    let app = app.clone();
    async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(8)).await;
        loop {
            if let Err(e) = daily(&app).await {
                eprintln!("ideas: no daily batch ({e})");
            }
            tokio::time::sleep(Duration::from_secs(30 * 60)).await;
        }
    });
}

// --- Commands ---------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub ideas: Vec<Listed>,
    /// The newest batch job, if any.
    pub job: Option<Job>,
    pub today: String,
    pub cap_reached: bool,
}

fn view(app: &AppHandle) -> Result<View> {
    let jobs = engine(app).map(|e| e.jobs()).unwrap_or_default();
    let now = now();
    let ideas = with(app, |store, _| {
        // A refinement whose job ended without a result (no provider, cancelled).
        let stuck: Vec<(String, String)> = store
            .recent(i64::MAX, now)
            .iter()
            .filter_map(|i| {
                let job = jobs.iter().find(|j| Some(&j.id) == i.refining.as_ref())?;
                job.status.finished().then(|| (i.id.clone(), job.error.clone().unwrap_or_else(|| "Refine stopped before it finished.".into())))
            })
            .collect();
        for (id, error) in stuck {
            store.refine_failed(&id, &error)?;
        }
        Ok(store.list(now))
    })?;
    Ok(View {
        ideas,
        job: jobs.into_iter().find(|j| j.kind == BATCH),
        today: now.format("%A, %-d %B").to_string(),
        cap_reached: super::meter().cap_reached(),
    })
}

fn act(app: &AppHandle, f: impl FnOnce(&mut Store, &Path) -> Result<()>) -> Result<View> {
    with(app, f)?;
    changed(app);
    view(app)
}

#[tauri::command]
pub fn ideas_list(app: AppHandle) -> Result<View> {
    view(&app)
}

/// Ideas on demand: optionally about a focus, or for one document.
#[tauri::command]
pub fn ideas_generate(app: AppHandle, focus: Option<String>, about: Option<String>) -> Result<View> {
    if busy(&engine(&app)?.jobs()) {
        return Err("Kin is already finding ideas.".into());
    }
    let focus = focus.map(|f| f.chars().take(MAX_ASK).collect());
    generate(&app, brief::Ask { focus, about: about.filter(|a| !a.trim().is_empty()), count: 3 })?;
    view(&app)
}

#[tauri::command]
pub fn ideas_dismiss(app: AppHandle, id: String, reasons: Option<Vec<String>>) -> Result<View> {
    act(&app, |s, _| s.dismiss(&id, reasons.unwrap_or_default(), now()).map(drop))
}

#[tauri::command]
pub fn ideas_undismiss(app: AppHandle, id: String) -> Result<View> {
    act(&app, |s, _| s.undismiss(&id, now()).map(drop))
}

/// "Not a reason" in Why this?, or its undo.
#[tauri::command]
pub fn ideas_reason(app: AppHandle, id: String, reason: String, removed: bool) -> Result<View> {
    act(&app, |s, _| s.set_reason(&id, &reason, removed, now()).map(drop))
}

#[tauri::command]
pub fn ideas_refine(app: AppHandle, id: String, ask: String) -> Result<View> {
    let ask: String = ask.trim().chars().take(MAX_ASK).collect();
    if ask.is_empty() {
        return Err("Say what Kin should change.".into());
    }
    let idea = with(&app, |s, _| s.get(&id).cloned().ok_or_else(|| "That idea is gone.".to_string()))?;
    if idea.refining.is_some() {
        return Err("Kin is already refining this idea.".into());
    }
    let job = engine(&app)?.create_job(NewJob {
        kind: REFINE.into(),
        task: Some(Task::Ideas.id().into()),
        brief: brief::refine(&idea, &ask),
        topic: idea.content.about.first().cloned(),
    })?;
    act(&app, |s, _| s.set_refining(&id, Some(job.id)).map(drop))
}

#[tauri::command]
pub fn ideas_refine_undo(app: AppHandle, id: String) -> Result<View> {
    act(&app, |s, _| s.undo_refine(&id, now()).map(drop))
}

#[tauri::command]
pub fn ideas_discussed(app: AppHandle, id: String) -> Result<()> {
    with(&app, |s, _| s.discussed(&id, now()).map(drop))
}

/// Ideas by id (the panel beside an adopted draft).
#[tauri::command]
pub fn ideas_get(app: AppHandle, ids: Vec<String>) -> Result<Vec<store::Idea>> {
    with(&app, |s, _| Ok(ids.iter().filter_map(|id| s.get(id).cloned()).collect()))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Adopted {
    pub path: String,
    pub view: View,
}

/// Where a new draft goes: `drafts/` if the vault has one.
fn new_path(root: &Path, title: &str) -> String {
    let dir = if root.join("drafts").is_dir() { "drafts/" } else { "" };
    let slug = kintsugi_vault::slugify(title);
    (1..)
        .map(|n| if n == 1 { format!("{dir}{slug}.mdx") } else { format!("{dir}{slug}-{n}.mdx") })
        .find(|p| !root.join(p).exists())
        .expect("an unused name")
}

/// Adopt: a new draft (`into` empty) or the idea added to `into`.
pub fn adopt_in(store: &mut Store, root: &Path, id: &str, title: Option<&str>, into: Option<&str>, now: DateTime<FixedOffset>) -> Result<(String, String)> {
    let idea = store.get(id).cloned().ok_or("That idea is gone.")?;
    let offered = idea.created.get(..10).unwrap_or_default().to_string();
    let (path, text, new) = match into.map(str::trim).filter(|p| !p.is_empty()) {
        None => {
            let title = title.map(str::trim).filter(|t| !t.is_empty()).unwrap_or(&idea.content.draft_title);
            if title.chars().count() > 120 {
                return Err("That title is too long.".into());
            }
            let path = new_path(root, title);
            let text = adopt::new_draft(title, &idea, &offered, &path);
            kintsugi_vault::write(root, &path, &text, None)?;
            (path, text, true)
        }
        Some(into) => {
            let current = kintsugi_vault::read(root, into)?;
            let text = adopt::attach(&current.text, &idea, &offered, into)?;
            match kintsugi_vault::write(root, into, &text, Some(&current.version))? {
                kintsugi_vault::Write::Saved { .. } => {}
                kintsugi_vault::Write::Conflict { .. } => return Err("That draft changed while the idea was being added. Try again.".into()),
            }
            (into.to_string(), text, false)
        }
    };
    store.adopted(id, &path, new, now)?;
    Ok((path, text))
}

#[tauri::command]
pub fn ideas_adopt(app: AppHandle, id: String, title: Option<String>, into: Option<String>) -> Result<Adopted> {
    let (path, text) = with(&app, |s, root| adopt_in(s, root, &id, title.as_deref(), into.as_deref(), now()))?;
    // An open editor picks up the change the way it does the phone's.
    let _ = app.emit("vault:changed", serde_json::json!({ "path": path, "text": text }));
    changed(&app);
    Ok(Adopted { path, view: view(&app)? })
}
