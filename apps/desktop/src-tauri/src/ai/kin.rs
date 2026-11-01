//! The webview's door to Kin: run a turn, cancel it, and read or change
//! Kin's settings (the monthly cap, the model for each task).
//!
//! Keys stay in Rust: the webview names a question and gets events back.

use super::agent::{self, Cancel, KinEvent, Limits, Remote};
use super::cost::{Report, Settings};
use super::memory::{Access, Source};
use super::prompt::Chip;
use super::tools::Tools;
use super::{ModelRef, Task, chosen_model, meter, preferences, ready, resolve, statuses, wire};
use crate::AppHandle;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::{Manager, State, async_runtime};

type Result<T> = std::result::Result<T, String>;

const MAX_QUESTION_BYTES: usize = 20_000;

/// Turns in flight, by id, so they can be cancelled.
#[derive(Default)]
pub struct Kin(Mutex<HashMap<String, Cancel>>);

/// Kin's data folder: `<config>/kin/` (ledger, settings, long outputs).
/// An isolated dev run without a scratch config dir keeps it all in memory,
/// so it never touches the real app's data.
pub(crate) fn data_dir(app: &AppHandle) -> Option<PathBuf> {
    #[cfg(not(feature = "headless"))]
    if crate::config::isolated_dev() && std::env::var_os("KINTSUGI_CONFIG_DIR").is_none_or(|p| p.is_empty()) {
        return None;
    }
    crate::config::directory(app).ok().map(|d| d.join("kin"))
}

/// A model Kin can talk to: a real provider, or (headless runs opted in with
/// `KINTSUGI_HEADLESS_KIN=mock`) a scripted stand-in that never calls out.
pub enum Connected {
    Remote(Remote),
    #[cfg(feature = "headless")]
    Mock(super::scripted::Scripted),
}

impl agent::Model for Connected {
    fn model(&self) -> &super::ModelRef {
        match self {
            Connected::Remote(r) => r.model(),
            #[cfg(feature = "headless")]
            Connected::Mock(m) => m.model(),
        }
    }

    async fn send(&self, ex: &wire::Exchange<'_>, on_text: &mut (dyn FnMut(&str) + Send)) -> Result<wire::Reply> {
        match self {
            Connected::Remote(r) => r.send(ex, on_text).await,
            #[cfg(feature = "headless")]
            Connected::Mock(m) => m.send(ex, on_text).await,
        }
    }
}

/// The model for a Kin task, with credentials resolved in Rust.
pub(crate) async fn connect(task: Task) -> Result<Connected> {
    #[cfg(feature = "headless")]
    if crate::headless::kin_mock() {
        return Ok(Connected::Mock(super::scripted::Scripted::default()));
    }
    let model = chosen_model(task, &statuses()?, &meter().settings())
        .ok_or("No AI provider is set up. Run `pi`, log in or add an API key.")?;
    let provider = wire::provider(&model.provider).ok_or("unknown provider")?;
    let auth = resolve(provider).await?;
    Ok(Connected::Remote(Remote { model, provider, base_url: provider.base_url.into(), auth }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnRequest {
    pub id: String,
    pub question: String,
    /// `"chat"` (default), `"ideas"` or `"triage"`.
    #[serde(default)]
    pub task: Option<String>,
    #[serde(default)]
    pub background: bool,
    /// What's on screen, as references.
    #[serde(default)]
    pub context: Vec<Chip>,
    /// False when the conversation is marked "don't remember this": Kin
    /// can't change memory or skills during it.
    #[serde(default = "yes")]
    pub remember: bool,
}

fn yes() -> bool {
    true
}

fn kin_task(id: Option<&str>) -> Result<Task> {
    match id {
        None => Ok(Task::Chat),
        Some(id) => Task::from_id(id).filter(|t| Task::KIN.contains(t)).ok_or_else(|| format!("unknown Kin task {id}")),
    }
}

/// Starts a turn; events arrive on `on_event`, ending in `done` or `error`.
#[tauri::command]
pub fn kin_turn(app: AppHandle, kin: State<Kin>, turn: TurnRequest, on_event: Channel<KinEvent>) -> Result<()> {
    let task = kin_task(turn.task.as_deref())?;
    if turn.question.trim().is_empty() {
        return Err("Ask Kin something.".into());
    }
    if turn.question.len() > MAX_QUESTION_BYTES {
        return Err("That question is too long.".into());
    }
    let cancel = Cancel::default();
    if let Some(previous) = kin.0.lock().unwrap().insert(turn.id.clone(), cancel.clone()) {
        previous.cancel();
    }
    async_runtime::spawn(async move {
        let mut emit = |event: KinEvent| {
            let _ = on_event.send(event);
        };
        let turn_id = turn.id.clone();
        if let Err(message) = start(&app, turn, task, &cancel, &mut emit).await {
            emit(KinEvent::Error { message });
        }
        let state = app.state::<Kin>();
        let mut running = state.0.lock().unwrap();
        // A newer turn may have reused the id; leave its handle alone.
        if running.get(&turn_id).is_some_and(|c| c.same(&cancel)) {
            running.remove(&turn_id);
        }
    });
    Ok(())
}

/// Sets up the model, tools and memory, then runs the loop. Errors before the
/// loop starts are returned; the loop reports its own.
async fn start(app: &AppHandle, turn: TurnRequest, task: Task, cancel: &Cancel, emit: &mut (dyn FnMut(KinEvent) + Send)) -> Result<()> {
    let root = crate::vault::current(app)?;
    let meter = meter();
    if turn.background && meter.allows(true).is_err() {
        return Err(super::cost::CapReached::MESSAGE.into());
    }
    let remote = connect(task).await?;
    // One snapshot per conversation (today, a turn), frozen for its prefix.
    let store = super::about::store(app, &root)?;
    let memory = store.snapshot();
    store.loaded(&memory);
    let access = Access { store, source: Source::chat(&turn.id, &turn.question), remember: turn.remember };
    let tools = Tools::new(&root, meter.outputs_dir(), &turn.id)?.with_memory(access).with_searcher(crate::search::searcher(app));
    let request = agent::Turn {
        task,
        background: turn.background,
        question: turn.question,
        chips: turn.context,
        today: chrono::Local::now().format("%Y-%m-%d").to_string(),
        remember: turn.remember,
        history: vec![],
        recap: None,
    };
    // The loop emits its own error event; don't send a second one.
    let harness = agent::Harness { tools: &tools, meter, memory: &memory, cancel, limits: Limits::default() };
    let _ = agent::run(&remote, &harness, &request, emit).await;
    Ok(())
}

#[tauri::command]
pub fn kin_cancel(kin: State<Kin>, id: String) {
    if let Some(cancel) = kin.0.lock().unwrap().remove(&id) {
        cancel.cancel();
    }
}

#[tauri::command]
pub fn kin_usage() -> Report {
    meter().report()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    #[serde(flatten)]
    pub model: ModelRef,
    /// Its provider has credentials right now.
    pub usable: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskModels {
    pub task: &'static str,
    /// The owner's pick, if any.
    pub chosen: Option<ModelRef>,
    /// What a turn would use now.
    pub resolved: Option<ModelRef>,
    pub options: Vec<ModelOption>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    pub cap_usd: Option<f64>,
    pub tasks: Vec<TaskModels>,
}

fn view(settings: &Settings) -> Result<SettingsView> {
    let statuses = statuses()?;
    // Every known model is an option for every Kin task, the task's own
    // preferences first.
    let mut all: Vec<ModelRef> = Vec::new();
    for task in Task::ALL {
        for m in preferences(task) {
            if !all.contains(m) {
                all.push(m.clone());
            }
        }
    }
    let tasks = Task::KIN
        .into_iter()
        .map(|task| {
            let mut options: Vec<ModelRef> = preferences(task).to_vec();
            options.extend(all.iter().filter(|m| !options.contains(m)).cloned().collect::<Vec<_>>());
            TaskModels {
                task: task.id(),
                chosen: settings.models.get(task.id()).cloned(),
                resolved: chosen_model(task, &statuses, settings),
                options: options.into_iter().map(|m| ModelOption { usable: ready(&m, &statuses), model: m }).collect(),
            }
        })
        .collect();
    Ok(SettingsView { cap_usd: settings.monthly_cap_usd, tasks })
}

#[tauri::command]
pub fn kin_settings() -> Result<SettingsView> {
    view(&meter().settings())
}

/// Sets or clears (`None`) the monthly cap, in US dollars.
#[tauri::command]
pub fn kin_set_cap(chat: State<super::chat::Chat>, cap_usd: Option<f64>) -> Result<Report> {
    meter().update_settings(|s| s.monthly_cap_usd = cap_usd)?;
    // Helpers waiting on the cap may run now.
    super::chat::cap_changed(&chat);
    Ok(meter().report())
}

/// Picks the model for a Kin task, or (`None`) goes back to the default.
#[tauri::command]
pub fn kin_set_model(task: String, model: Option<ModelRef>) -> Result<SettingsView> {
    let task = kin_task(Some(&task))?;
    if let Some(m) = &model
        && wire::provider(&m.provider).is_none()
    {
        return Err(format!("unknown provider {}", m.provider));
    }
    let settings = meter().update_settings(|s| match model {
        Some(m) => {
            s.models.insert(task.id().into(), m);
        }
        None => {
            s.models.remove(task.id());
        }
    })?;
    view(&settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_kin_tasks_are_accepted() {
        assert_eq!(kin_task(None), Ok(Task::Chat));
        assert_eq!(kin_task(Some("triage")), Ok(Task::Triage));
        assert!(kin_task(Some("edit")).is_err());
        assert!(kin_task(Some("nope")).is_err());
    }

    #[test]
    fn turn_requests_parse_from_the_webview() {
        let turn: TurnRequest = serde_json::from_str(
            r#"{"id":"a","question":"Why?","context":[{"kind":"doc","path":"posts/a.md"}]}"#,
        )
        .unwrap();
        assert_eq!(turn.context[0].path, "posts/a.md");
        assert!(!turn.background && turn.task.is_none() && turn.remember);
        let forgetful: TurnRequest = serde_json::from_str(r#"{"id":"b","question":"Hm","remember":false}"#).unwrap();
        assert!(!forgetful.remember);
    }
}
