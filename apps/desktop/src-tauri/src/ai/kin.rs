//! The webview's door to Kin: run a turn, cancel it, and read or change
//! Kin's settings (the monthly cap, the model for each task).
//!
//! Keys stay in Rust: the webview names a question and gets events back.

use super::agent::{self, Cancel, KinEvent, Limits, Remote};
use super::cost::{Report, Settings};
use super::memory::{Access, Source};
use super::prompt::Chip;
use super::tools::Tools;
use super::{
    ModelRef, Task, catalog, chosen_model, conversation_model, enabled_models, meter, picks,
    resolve, shown_statuses, statuses, toggle_enabled, wire,
};
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
    if crate::config::isolated_dev()
        && std::env::var_os("KINTSUGI_CONFIG_DIR").is_none_or(|p| p.is_empty())
    {
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

    async fn send(
        &self,
        ex: &wire::Exchange<'_>,
        on_text: &mut (dyn FnMut(&str) + Send),
    ) -> Result<wire::Reply> {
        match self {
            Connected::Remote(r) => r.send(ex, on_text).await,
            #[cfg(feature = "headless")]
            Connected::Mock(m) => m.send(ex, on_text).await,
        }
    }
}

/// The model for a Kin task, with credentials resolved in Rust.
pub(crate) async fn connect(task: Task) -> Result<Connected> {
    connect_to(task, None).await
}

/// The same, with the model and effort picked for a conversation (KI-61,
/// KI-77) in place of the task's defaults while its provider is usable.
pub(crate) async fn connect_to(task: Task, pick: Option<picks::Pick>) -> Result<Connected> {
    #[cfg(feature = "headless")]
    if crate::headless::kin_mock() {
        return Ok(Connected::Mock(super::scripted::Scripted::default()));
    }
    let statuses = statuses()?;
    let settings = meter().settings();
    let model = match pick {
        Some(pick) if task == Task::Chat => conversation_model(Some(&pick), &statuses, &settings),
        _ => chosen_model(task, &statuses, &settings),
    }
    .ok_or("No AI provider is set up. Run `pi`, log in or add an API key.")?;
    let provider = wire::provider(&model.provider).ok_or("unknown provider")?;
    let auth = resolve(provider).await?;
    let endpoint = wire::Endpoint::new(provider, &model.model, auth);
    Ok(Connected::Remote(Remote {
        model,
        route: endpoint.route,
        auth: endpoint.auth,
    }))
}

/// What one background request through Kin's connection came to.
pub(crate) enum Oneshot {
    Answer {
        text: String,
        /// `provider/model`.
        model: String,
        cost: f64,
    },
    /// The month's cap is reached; nothing was sent.
    Capped,
    /// No provider is set up.
    Unavailable,
    /// The request failed or timed out.
    Failed { model: String },
}

/// One request, no tools, for background work (the Feed's story summaries):
/// the task's model as `connect` picks it (the scripted mock in a headless
/// mock run), refused at the cap, its cost recorded.
pub(crate) async fn oneshot(
    task: Task,
    system: &str,
    prompt: String,
    max_tokens: u32,
    timeout: std::time::Duration,
) -> Oneshot {
    use agent::Model;
    if meter().allows(true).is_err() {
        return Oneshot::Capped;
    }
    let Ok(model) = connect(task).await else {
        return Oneshot::Unavailable;
    };
    let items = [wire::Item::User(prompt)];
    let exchange = wire::Exchange {
        model: &model.model().model,
        system,
        tools: &[],
        items: &items,
        max_tokens: Some(max_tokens),
        temperature: None,
        stop: None,
        reasoning: model.model().reasoning.as_deref(),
        cache_key: None,
    };
    let name = format!("{}/{}", model.model().provider, model.model().model);
    match tokio::time::timeout(timeout, model.send(&exchange, &mut |_| {})).await {
        Ok(Ok(reply)) => Oneshot::Answer {
            cost: meter().record(task, model.model(), &reply.usage),
            text: reply.text,
            model: name,
        },
        _ => Oneshot::Failed { model: name },
    }
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
        Some(id) => Task::from_id(id)
            .filter(|t| Task::KIN.contains(t))
            .ok_or_else(|| format!("unknown Kin task {id}")),
    }
}

/// Starts a turn; events arrive on `on_event`, ending in `done` or `error`.
#[tauri::command]
pub fn kin_turn(
    app: AppHandle,
    kin: State<Kin>,
    turn: TurnRequest,
    on_event: Channel<KinEvent>,
) -> Result<()> {
    let task = kin_task(turn.task.as_deref())?;
    if turn.question.trim().is_empty() {
        return Err("Ask Kin something.".into());
    }
    if turn.question.len() > MAX_QUESTION_BYTES {
        return Err("That question is too long.".into());
    }
    let cancel = Cancel::default();
    if let Some(previous) = kin
        .0
        .lock()
        .unwrap()
        .insert(turn.id.clone(), cancel.clone())
    {
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
async fn start(
    app: &AppHandle,
    turn: TurnRequest,
    task: Task,
    cancel: &Cancel,
    emit: &mut (dyn FnMut(KinEvent) + Send),
) -> Result<()> {
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
    let access = Access {
        store,
        source: Source::chat(&turn.id, &turn.question),
        remember: turn.remember,
    };
    let mut tools = Tools::new(&root, meter.outputs_dir(), &turn.id)?
        .with_memory(access)
        .with_searcher(crate::search::searcher(app))
        .with_feed(crate::feed::kin_hook(app));
    if let Some(web) = super::web::for_turn(turn.background) {
        tools = tools.with_web(web);
    }
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
    let harness = agent::Harness {
        tools: &tools,
        meter,
        memory: &memory,
        cancel,
        limits: Limits::default(),
    };
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
pub struct TaskModels {
    pub task: &'static str,
    /// The owner's default for it, if any.
    pub chosen: Option<ModelRef>,
    /// His default thinking level for it, if any.
    pub effort: Option<String>,
    /// What it would use now: the default while its provider is usable,
    /// else the first usable preference, at the level it runs at.
    pub resolved: Option<ModelRef>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    pub cap_usd: Option<f64>,
    pub tasks: Vec<TaskModels>,
    /// The models the pickers offer (KI-77), every task's default included.
    pub enabled: Vec<ModelRef>,
    /// The tone summaries and Ideas are written in (KI-102).
    pub tone: super::writing::Tone,
}

fn view(settings: &Settings) -> Result<SettingsView> {
    let statuses = shown_statuses()?;
    let tasks = Task::SETTINGS
        .into_iter()
        .map(|task| TaskModels {
            task: task.id(),
            chosen: settings.models.get(task.id()).cloned(),
            effort: settings.efforts.get(task.id()).cloned(),
            resolved: chosen_model(task, &statuses, settings),
        })
        .collect();
    Ok(SettingsView {
        cap_usd: settings.monthly_cap_usd,
        tasks,
        enabled: enabled_models(&statuses, settings),
        tone: settings.tone,
    })
}

#[tauri::command]
pub fn kin_settings() -> Result<SettingsView> {
    view(&meter().settings())
}

/// Sets or clears (`None`) the monthly cap, in US dollars.
#[tauri::command]
pub fn kin_set_cap(
    app: AppHandle,
    chat: State<super::chat::Chat>,
    cap_usd: Option<f64>,
) -> Result<Report> {
    meter().update_settings(|s| s.monthly_cap_usd = cap_usd)?;
    // Helpers and Feed summaries waiting on the cap may run now.
    super::chat::cap_changed(&chat);
    crate::feed::wake_summaries(&app);
    Ok(meter().report())
}

/// Sets the default model for a task (`chat`, `ideas`, `edit`, `complete`
/// or `triage`), or (`None`) goes back to the automatic choice.
#[tauri::command]
pub fn kin_set_model(task: String, model: Option<ModelRef>) -> Result<SettingsView> {
    let task = Task::from_id(&task).ok_or_else(|| format!("unknown task {task}"))?;
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

/// A thinking level from the webview: one of Pi's levels (`none` is `off`).
fn level(effort: Option<String>) -> Result<Option<String>> {
    effort
        .map(|e| {
            catalog::Level::parse(&e)
                .map(|l| l.id().to_string())
                .ok_or_else(|| format!("unknown thinking level {e}"))
        })
        .transpose()
}

/// Sets the default thinking level for a task, or (`None`) goes back to
/// the model choice's own.
#[tauri::command]
pub fn kin_set_effort(task: String, effort: Option<String>) -> Result<SettingsView> {
    let task = Task::from_id(&task).ok_or_else(|| format!("unknown task {task}"))?;
    let effort = level(effort)?;
    let settings = meter().update_settings(|s| match effort {
        Some(e) => {
            s.efforts.insert(task.id().into(), e);
        }
        None => {
            s.efforts.remove(task.id());
        }
    })?;
    view(&settings)
}

/// Sets the tone Kin writes Feed summaries and Ideas in (KI-102):
/// `plain`, `editorial`, `casual` or `dry`. What's written already stays.
#[tauri::command]
pub fn kin_set_tone(tone: String) -> Result<SettingsView> {
    let tone =
        super::writing::Tone::from_id(&tone).ok_or_else(|| format!("unknown tone {tone}"))?;
    let settings = meter().update_settings(|s| s.tone = tone)?;
    view(&settings)
}

/// Turns a catalog model on or off in the pickers (KI-77). A task's
/// default stays on either way.
#[tauri::command]
pub fn kin_set_enabled(model: ModelRef, on: bool) -> Result<SettingsView> {
    if catalog::find(&model.provider, &model.model).is_none() {
        return Err(format!("unknown model {}/{}", model.provider, model.model));
    }
    let settings = meter().update_settings(|s| toggle_enabled(s, &model, on))?;
    view(&settings)
}

/// The model for one conversation in the chat: his picks for it, and what
/// a turn would use now.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatModel {
    pub topic: String,
    /// The model picked for it, if any.
    pub chosen: Option<ModelRef>,
    /// The thinking level picked for it, if any.
    pub effort: Option<String>,
    /// The model a turn runs on now, at the level it runs at.
    pub resolved: Option<ModelRef>,
}

/// The vault's conversation folder, where its log and picks live.
fn conversation_dir(app: &AppHandle) -> Result<PathBuf> {
    super::history::vault_dir(&crate::vault::current(app)?)
}

fn chat_model(dir: &std::path::Path, topic: String) -> Result<ChatModel> {
    let pick = picks::get(dir, &topic);
    let resolved = conversation_model(pick.as_ref(), &shown_statuses()?, &meter().settings());
    Ok(ChatModel {
        topic,
        chosen: pick.as_ref().and_then(picks::Pick::model_ref),
        effort: pick.and_then(|p| p.reasoning),
        resolved,
    })
}

/// The model for the conversation `topic` (a thread's key, `""` for general).
#[tauri::command]
pub fn kin_chat_model(app: AppHandle, topic: String) -> Result<ChatModel> {
    chat_model(&conversation_dir(&app)?, topic)
}

/// Picks the model for the conversation `topic`, or (`None`) goes back to
/// the chat default. Kept beside the vault's conversation log (`picks`).
#[tauri::command]
pub fn kin_chat_set_model(
    app: AppHandle,
    topic: String,
    model: Option<ModelRef>,
) -> Result<ChatModel> {
    if let Some(m) = &model
        && wire::provider(&m.provider).is_none()
    {
        return Err(format!("unknown provider {}", m.provider));
    }
    let dir = conversation_dir(&app)?;
    picks::set(&dir, &topic, model)?;
    chat_model(&dir, topic)
}

/// Picks the thinking level for the conversation `topic`, or (`None`) goes
/// back to the chat's default effort.
#[tauri::command]
pub fn kin_chat_set_effort(
    app: AppHandle,
    topic: String,
    effort: Option<String>,
) -> Result<ChatModel> {
    let effort = level(effort)?;
    let dir = conversation_dir(&app)?;
    picks::set_effort(&dir, &topic, effort)?;
    chat_model(&dir, topic)
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
        let forgetful: TurnRequest =
            serde_json::from_str(r#"{"id":"b","question":"Hm","remember":false}"#).unwrap();
        assert!(!forgetful.remember);
    }
}
