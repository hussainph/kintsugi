//! Kintsugi's model harness: the owner's OpenCode or Pi credentials,
//! Kintsugi's own transport. The webview sends prompts and receives text;
//! keys never leave Rust.
//!
//! - `credentials`: where a credential comes from (OpenCode, Pi, Kintsugi's
//!   own store, env).
//! - `sign_in`: signing in to a provider from Settings, as Pi does.
//! - `providers`: every provider Kin speaks, with its defaults.
//! - `catalog`: every model (Pi's generated catalog): wire, limits, prices.
//! - `models`: `ai_models`, the models Kin can use now, for pickers.
//! - `wire`: the wire formats, streaming text, tool calls and reasoning.
//! - `agent`: Kin's loop, many tool calls per turn, cancellable.
//! - `tools`: Kin's read-only vault tools.
//! - `prompt`: the fixed, cacheable prefix and the dynamic tail.
//! - `cost`: prices, the usage ledger and the monthly cap.
//! - `kin`: the Tauri commands for Kin and its settings.
//! - `memory`: Kin's capped memory and skills in `.kintsugi/agent/`.
//! - `about`: the About you commands, and the memory snapshot for helpers.
//! - `threads`: Kin's threads, one file each, and their index (KI-104).
//! - `jobs`: the helper job table.
//! - `chat`: the live threads: batching, interrupts, reviews, helpers.
//! - `picks`: the model picked for each thread, in the vault.
//! - `ideas`: Kin's daily ideas, checked against their sources (KI-39).

pub mod about;
mod agent;
#[cfg(test)]
mod attachment_tests;
pub(crate) mod attachments;
pub(crate) mod catalog;
pub mod chat;
mod context;
pub mod cost;
mod credentials;
pub mod ideas;
mod jobs;
pub mod kin;
pub mod memory;
pub mod models;
mod opencode_auth;
mod pi_auth;
pub mod picks;
pub mod prompt;
mod providers;
#[cfg(feature = "headless")]
pub(crate) mod scripted;
pub mod sign_in;
pub mod stash;
pub mod threads;
pub(crate) mod tools;
pub mod web;
mod wire;
pub mod writing;

pub use chat::Chat;
pub use kin::Kin;
/// OpenCode's data folder (its credentials live there), for path guards.
#[cfg(feature = "headless")]
pub(crate) use opencode_auth::data_dir as opencode_data_dir;
pub use sign_in::SignIns;

use crate::AppHandle;
use credentials::{Chain, Kind, Source};
use pi_auth::Auth;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::task::Poll;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{Manager, State, async_runtime};
use wire::{Event, PROVIDERS, Provider, Request};

type Result<T> = std::result::Result<T, String>;

/// In-flight requests, so a new keystroke can cancel a stale completion.
#[derive(Default)]
pub struct Ai(Mutex<HashMap<String, async_runtime::JoinHandle<()>>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    id: &'static str,
    name: &'static str,
    /// What kind of credential there is (`api_key`, `login`, `local`), or
    /// why there isn't a usable one (`unsupported_login`, `expired_login`,
    /// `none`); `mock` in a scripted headless run.
    auth: &'static str,
    /// Where it comes from: `opencode`, `pi`, `kintsugi`, `env` or `local`.
    source: Option<Source>,
}

/// One provider in Settings › Providers. Holds no secret: only whether
/// Kintsugi has saved a key or a login, and where the one in use is from.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialView {
    id: &'static str,
    name: &'static str,
    /// As `ProviderStatus`.
    auth: &'static str,
    source: Option<Source>,
    /// What Kintsugi's own store holds for it.
    saved: Option<Kind>,
    /// A key can be added (every provider but ChatGPT for Codex).
    api_key: bool,
    /// Kintsugi can sign in to it, as Pi does.
    sign_in: bool,
    /// Listed before he picks it: a default model's provider, or one with
    /// a credential.
    listed: bool,
}

/// Settings › Providers: every provider, with what Kintsugi has saved for
/// it. Headless runs without real AI show only what's saved in memory.
#[tauri::command]
pub fn ai_credentials() -> Result<Vec<CredentialView>> {
    let defaults: Vec<&str> = Task::ALL
        .iter()
        .flat_map(|t| preferences(*t))
        .map(|m| m.provider.as_str())
        .collect();
    let store = credentials::kintsugi();
    #[allow(unused_mut)]
    let mut statuses = shown_statuses()?;
    #[cfg(feature = "headless")]
    if !crate::headless::ai_enabled() {
        for s in statuses.iter_mut().filter(|s| s.auth == "none") {
            let lookup = store.lookup(wire::provider(s.id).unwrap());
            let status = credentials::Status::of(
                Source::Kintsugi,
                lookup.unwrap_or(credentials::Lookup::Missing),
            );
            s.auth = status.auth;
            s.source = status.source;
        }
    }
    statuses
        .into_iter()
        .map(|s| {
            let provider = wire::provider(s.id).ok_or("unknown provider")?;
            // An unreadable store shows as holding nothing; it can't hide
            // the other sources.
            let saved = store.held(s.id).ok().flatten();
            Ok(CredentialView {
                id: s.id,
                name: s.name,
                auth: s.auth,
                source: s.source,
                saved,
                api_key: !provider.keyless && provider.id != "openai-codex",
                sign_in: sign_in::can_sign_in(s.id),
                listed: s.auth != "none" || saved.is_some() || defaults.contains(&s.id),
            })
        })
        .collect()
}

/// The longest API key accepted.
const MAX_KEY_CHARS: usize = 4096;

/// Saves an API key for `provider` in Kintsugi's own store, replacing what
/// Kintsugi had for it. The key is never sent back.
#[tauri::command]
pub async fn ai_set_key(provider: String, key: String) -> Result<Vec<CredentialView>> {
    let provider = wire::provider(&provider).ok_or("Unknown provider")?;
    if provider.keyless || provider.id == "openai-codex" {
        return Err(format!("{} takes no API key.", provider.name));
    }
    let key = key.trim();
    if key.is_empty()
        || key.chars().count() > MAX_KEY_CHARS
        || key.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err("That doesn't look like an API key.".into());
    }
    let credential = serde_json::json!({ "type": "api_key", "key": pi_auth::literal_key(key) });
    let id = provider.id;
    async_runtime::spawn_blocking(move || credentials::kintsugi().save(id, credential))
        .await
        .map_err(|e| e.to_string())??;
    ai_credentials()
}

/// Removes the key or login Kintsugi saved for `provider` (a sign-out).
/// OpenCode's and Pi's are never touched.
#[tauri::command]
pub async fn ai_remove_credential(provider: String) -> Result<Vec<CredentialView>> {
    let id = wire::provider(&provider).ok_or("Unknown provider")?.id;
    async_runtime::spawn_blocking(move || credentials::kintsugi().remove(id))
        .await
        .map_err(|e| e.to_string())??;
    ai_credentials()
}

/// The providers Settings lists, and whether each can be used right now:
/// the ones the default models use, and any other with a credential (or a
/// login it can't use). Every provider is in `ai_models` with `all: true`.
#[tauri::command]
pub fn ai_providers() -> Result<Vec<ProviderStatus>> {
    let defaults: Vec<&str> = Task::ALL
        .iter()
        .flat_map(|t| preferences(*t))
        .map(|m| m.provider.as_str())
        .collect();
    Ok(shown_statuses()?
        .into_iter()
        .filter(|s| s.auth != "none" || defaults.contains(&s.id))
        .collect())
}

/// Every provider's status, a headless mock run's stand-in included.
fn shown_statuses() -> Result<Vec<ProviderStatus>> {
    #[allow(unused_mut)]
    let mut statuses = statuses()?;
    // A mock run offers the webview's first edit model, answered by
    // `scripted::edit` in `ai_stream`; Rust's own model choice is unchanged.
    #[cfg(feature = "headless")]
    if crate::headless::kin_mock() && !crate::headless::ai_enabled() {
        if let Some(edit) = preferences(Task::Edit).first() {
            statuses
                .iter_mut()
                .filter(|p| p.id == edit.provider)
                .for_each(|p| p.auth = "mock");
        }
    }
    Ok(statuses)
}

fn statuses() -> Result<Vec<ProviderStatus>> {
    #[cfg(feature = "headless")]
    if !crate::headless::ai_enabled() {
        return Ok(PROVIDERS
            .iter()
            .map(|p| ProviderStatus {
                id: p.id,
                name: p.name,
                auth: "none",
                source: None,
            })
            .collect());
    }
    let chain = Chain::default_location()?;
    PROVIDERS
        .iter()
        .map(|p| {
            let status = chain.status(p)?;
            Ok(ProviderStatus {
                id: p.id,
                name: p.name,
                auth: status.auth,
                source: status.source,
            })
        })
        .collect()
}

/// What a model is used for decides how fast and how strong it needs to be.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Task {
    /// Quality first: rewrites, and enrichment.
    Edit,
    /// Speed first: inline completions (currently requested by the webview).
    #[allow(dead_code)]
    Complete,
    /// Kin's conversation: strong, the owner is reading.
    Chat,
    /// Kin's Ideas: strong, mostly in the background.
    Ideas,
    /// Ranking and sorting the Feed: cheap, always in the background.
    #[allow(dead_code)]
    Triage,
}

impl Task {
    pub const ALL: [Task; 5] = [
        Task::Edit,
        Task::Complete,
        Task::Chat,
        Task::Ideas,
        Task::Triage,
    ];
    /// Tasks Kin's agent runs.
    pub const KIN: [Task; 3] = [Task::Chat, Task::Ideas, Task::Triage];
    /// Every task, in the order Settings lists their default models.
    pub const SETTINGS: [Task; 5] = [
        Task::Chat,
        Task::Ideas,
        Task::Edit,
        Task::Complete,
        Task::Triage,
    ];

    pub fn id(self) -> &'static str {
        match self {
            Task::Edit => "edit",
            Task::Complete => "complete",
            Task::Chat => "chat",
            Task::Ideas => "ideas",
            Task::Triage => "triage",
        }
    }

    pub fn from_id(id: &str) -> Option<Task> {
        Task::ALL.into_iter().find(|t| t.id() == id)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelRef {
    pub provider: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
}

#[derive(Deserialize)]
struct Preferences {
    edit: Vec<ModelRef>,
    complete: Vec<ModelRef>,
    chat: Vec<ModelRef>,
    ideas: Vec<ModelRef>,
    triage: Vec<ModelRef>,
    /// Models on in the pickers until he changes the list (KI-77), beside
    /// every task's preferences: one or two strong alternatives per provider.
    #[serde(default)]
    enabled: Vec<ModelRef>,
}

/// The webview's `src/lib/models.ts` reads the same file, so both sides
/// pick the same model for a task.
const PREFERENCES_JSON: &str = include_str!("../../../src/lib/models.json");

fn parsed() -> &'static Preferences {
    static PARSED: OnceLock<Preferences> = OnceLock::new();
    PARSED.get_or_init(|| {
        serde_json::from_str(PREFERENCES_JSON).expect("src/lib/models.json is valid")
    })
}

fn preferences(task: Task) -> &'static [ModelRef] {
    let parsed = parsed();
    match task {
        Task::Edit => &parsed.edit,
        Task::Complete => &parsed.complete,
        Task::Chat => &parsed.chat,
        Task::Ideas => &parsed.ideas,
        Task::Triage => &parsed.triage,
    }
}

/// The same model, whatever its thinking level.
pub(crate) fn same_model(a: &ModelRef, b: &ModelRef) -> bool {
    a.provider == b.provider && a.model == b.model
}

fn bare(m: &ModelRef) -> ModelRef {
    ModelRef {
        provider: m.provider.clone(),
        model: m.model.clone(),
        reasoning: None,
    }
}

fn add(list: &mut Vec<ModelRef>, m: &ModelRef) {
    if !list.iter().any(|x| same_model(x, m)) {
        list.push(bare(m));
    }
}

/// The models on in the pickers before he changes anything: every task's
/// preferences and `models.json`'s `enabled` alternatives.
fn default_enabled() -> Vec<ModelRef> {
    let mut list = Vec::new();
    for task in Task::SETTINGS {
        preferences(task).iter().for_each(|m| add(&mut list, m));
    }
    parsed().enabled.iter().for_each(|m| add(&mut list, m));
    list
}

/// The models the pickers offer (KI-77): the default set with his changes
/// from Settings, and every task's default as it resolves now, which is
/// always on. Not filtered by credential: the pickers list only usable
/// providers' models.
fn enabled_models(statuses: &[ProviderStatus], settings: &cost::Settings) -> Vec<ModelRef> {
    let mut list: Vec<ModelRef> = default_enabled()
        .into_iter()
        .filter(|m| !settings.disabled.iter().any(|x| same_model(x, m)))
        .collect();
    settings.enabled.iter().for_each(|m| add(&mut list, m));
    for task in Task::SETTINGS {
        if let Some(m) = chosen_base(task, statuses, settings) {
            add(&mut list, &m);
        }
    }
    list
}

/// Turns one model on or off in the pickers, as a change to the default set.
fn toggle_enabled(settings: &mut cost::Settings, model: &ModelRef, on: bool) {
    let model = bare(model);
    let default = default_enabled().iter().any(|m| same_model(m, &model));
    settings.enabled.retain(|m| !same_model(m, &model));
    settings.disabled.retain(|m| !same_model(m, &model));
    match (on, default) {
        (true, false) => settings.enabled.push(model),
        (false, true) => settings.disabled.push(model),
        _ => {}
    }
}

/// The thinking level a task runs at when nothing else names one, as Pi
/// defaults to `medium`: the owner's tasks think at `medium`, edits at
/// `low`, and the background's quick ones (completions, triage) as little
/// as the model allows.
fn nominal(task: Task) -> catalog::Level {
    match task {
        Task::Chat | Task::Ideas => catalog::Level::Medium,
        Task::Edit => catalog::Level::Low,
        Task::Complete | Task::Triage => catalog::Level::Off,
    }
}

/// `model` with the thinking level it runs at: `explicit` (his pick), else
/// the model choice's own, else the task's `nominal`, moved to the nearest
/// level the model supports. A model the catalog says doesn't think gets
/// none; one the catalog doesn't list keeps what was asked.
fn with_effort(mut model: ModelRef, explicit: Option<&str>, task: Task) -> ModelRef {
    let asked = explicit
        .or(model.reasoning.as_deref())
        .and_then(catalog::Level::parse);
    model.reasoning = match catalog::find(&model.provider, &model.model) {
        Some(m) if !m.reasoning => None,
        Some(m) => Some(m.clamp(asked.unwrap_or(nominal(task))).id().into()),
        None => asked.map(|l| l.id().into()),
    };
    model
}

/// Mirrors `usable` in src/lib/models.ts: local servers are never picked
/// automatically, and a login Kintsugi can't use doesn't count.
fn usable(auth: &str) -> bool {
    !matches!(
        auth,
        "none" | "unsupported_login" | "expired_login" | "local"
    )
}

fn ready(m: &ModelRef, statuses: &[ProviderStatus]) -> bool {
    statuses
        .iter()
        .any(|s| s.id == m.provider && usable(s.auth))
}

/// The first preferred model whose provider is usable, as `modelFor` does.
fn model_for(task: Task, statuses: &[ProviderStatus]) -> Option<&'static ModelRef> {
    preferences(task).iter().find(|m| ready(m, statuses))
}

/// The owner's choice for a task when its provider is usable, else the
/// first usable preference; its thinking level as chosen.
fn chosen_base(
    task: Task,
    statuses: &[ProviderStatus],
    settings: &cost::Settings,
) -> Option<ModelRef> {
    settings
        .models
        .get(task.id())
        .filter(|m| wire::provider(&m.provider).is_some() && ready(m, statuses))
        .cloned()
        .or_else(|| model_for(task, statuses).cloned())
}

/// The model a task runs on (`chosen_base`) and the thinking level it runs
/// at: his default effort for the task, else the choice's own, else the
/// task's (`with_effort`).
fn chosen_model(
    task: Task,
    statuses: &[ProviderStatus],
    settings: &cost::Settings,
) -> Option<ModelRef> {
    let model = chosen_base(task, statuses, settings)?;
    let effort = settings.efforts.get(task.id()).map(String::as_str);
    Some(with_effort(model, effort, task))
}

/// The model for one conversation: the owner's pick for it when its
/// provider is usable, else the chat default (`chosen_base`), which falls
/// back to the next usable preference in turn. Its effort: the one picked
/// for the conversation, else the chat's default effort, else the model
/// choice's own, else `medium`.
fn conversation_model(
    pick: Option<&picks::Pick>,
    statuses: &[ProviderStatus],
    settings: &cost::Settings,
) -> Option<ModelRef> {
    let model = pick
        .and_then(picks::Pick::model_ref)
        .filter(|m| wire::provider(&m.provider).is_some() && ready(m, statuses))
        .or_else(|| chosen_base(Task::Chat, statuses, settings))?;
    let effort = pick
        .and_then(|p| p.reasoning.as_deref())
        .or(settings.efforts.get(Task::Chat.id()).map(String::as_str));
    Some(with_effort(model, effort, Task::Chat))
}

/// The model a task would use now: the owner's default for it in Settings,
/// else the first usable preference. The webview asks before an edit or a
/// completion, so it picks what Settings says.
#[tauri::command]
pub fn ai_model_for(task: String) -> Result<Option<ModelRef>> {
    let task = Task::from_id(&task).ok_or_else(|| format!("unknown task {task}"))?;
    Ok(chosen_model(task, &shown_statuses()?, &meter().settings()))
}

/// The process-wide cost meter. `complete` (enrichment) has no app handle,
/// so the meter lives here; `init` points it at the app's data folder.
static METER: OnceLock<cost::Meter> = OnceLock::new();

pub fn meter() -> &'static cost::Meter {
    METER.get_or_init(|| cost::Meter::open(None))
}

/// Opens the usage ledger and Kin's settings. Call once at startup, before
/// any AI work, in native and headless runs alike.
pub fn init(app: &AppHandle) {
    let config = kin::data_dir(app).and_then(|d| d.parent().map(std::path::Path::to_path_buf));
    credentials::init(config.as_deref());
    let _ = METER.set(cost::Meter::open(kin::data_dir(app)));
    web::init(kin::data_dir(app));
    chat::init(app);
    ideas::init(app);
}

/// One bounded, non-streamed completion for background work (no webview).
pub struct Ask {
    pub system: String,
    /// The single user message.
    pub prompt: String,
    pub max_tokens: u32,
    /// The response is abandoned once it grows past this many bytes
    /// (the Codex backend ignores `max_tokens`).
    pub max_response_bytes: usize,
    /// For the whole call: credentials, connection and the full response.
    pub timeout: Duration,
}

/// The longest prompt `complete` will send, system and user together.
pub const MAX_PROMPT_BYTES: usize = 200_000;

/// Why a completion failed. Deliberately nothing but the kind: provider
/// and credential errors can echo keys or prompts, so they're dropped here
/// and only these fixed messages (safe to store or show) remain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AiError {
    /// No usable provider, or credentials that can't be read or used.
    NotConfigured,
    /// The provider refused or failed the request, or the connection broke.
    Request,
    TimedOut,
    /// The prompt was over `MAX_PROMPT_BYTES`.
    PromptTooLong,
    /// The response hit `max_tokens` or `max_response_bytes`.
    ResponseTooLong,
    /// The month's spending cap is reached; background work waits.
    CapReached,
}

impl AiError {
    pub fn message(self) -> &'static str {
        match self {
            AiError::NotConfigured => {
                "No AI provider is set up. Add a key or sign in in Settings › Providers."
            }
            AiError::Request => "The AI provider request failed.",
            AiError::TimedOut => "The AI provider took too long to answer.",
            AiError::PromptTooLong => "The AI prompt was too long.",
            AiError::ResponseTooLong => "The AI answer was too long.",
            AiError::CapReached => cost::CapReached::MESSAGE,
        }
    }
}

impl fmt::Display for AiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for AiError {}

/// One completion with the task's preferred model, collected into a
/// string. Exactly one request: no fallback to another model on failure.
/// This is background work: it refuses to start once the monthly cap is
/// reached, and its cost is recorded.
pub async fn complete(task: Task, ask: &Ask) -> std::result::Result<String, AiError> {
    if ask.system.len() + ask.prompt.len() > MAX_PROMPT_BYTES {
        return Err(AiError::PromptTooLong);
    }
    let meter = meter();
    meter.allows(true).map_err(|_| AiError::CapReached)?;
    let statuses = statuses().map_err(|_| AiError::NotConfigured)?;
    let model = chosen_model(task, &statuses, &meter.settings()).ok_or(AiError::NotConfigured)?;
    let provider = wire::provider(&model.provider).ok_or(AiError::NotConfigured)?;
    let items = [wire::Item::User(ask.prompt.clone())];
    let exchange = wire::Exchange {
        model: &model.model,
        system: &ask.system,
        tools: &[],
        items: &items,
        max_tokens: Some(ask.max_tokens),
        temperature: None,
        stop: None,
        reasoning: model.reasoning.as_deref(),
        cache_key: None,
    };
    let run = async {
        let auth = resolve(provider)
            .await
            .map_err(|_| AiError::NotConfigured)?;
        let overflow = AtomicBool::new(false);
        let mut length = 0;
        let endpoint = wire::Endpoint::new(provider, &model.model, auth);
        let streaming = wire::send(endpoint, &exchange, |delta| {
            // Checked as it streams, so a runaway answer is never held.
            length += delta.len();
            if length > ask.max_response_bytes {
                overflow.store(true, Ordering::Relaxed);
            }
        });
        let Some(result) = until_overflow(streaming, &overflow).await else {
            return Err(AiError::ResponseTooLong);
        };
        let reply = result.map_err(|_| AiError::Request)?;
        meter.record(task, &model, &reply.usage);
        if reply.stop_reason.as_deref().is_some_and(truncated) {
            return Err(AiError::ResponseTooLong);
        }
        Ok(reply.text)
    };
    tokio::time::timeout(ask.timeout, run)
        .await
        .map_err(|_| AiError::TimedOut)?
}

/// Polls `future` until it finishes or `overflow` is set, which drops it
/// and so closes the connection.
async fn until_overflow<F: std::future::Future>(
    future: F,
    overflow: &AtomicBool,
) -> Option<F::Output> {
    let mut future = std::pin::pin!(future);
    let over = || overflow.load(Ordering::Relaxed);
    std::future::poll_fn(|cx| {
        if over() {
            return Poll::Ready(None);
        }
        match future.as_mut().poll(cx) {
            Poll::Ready(_) if over() => Poll::Ready(None),
            Poll::Ready(output) => Poll::Ready(Some(output)),
            Poll::Pending if over() => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    })
    .await
}

/// Stop reasons meaning the output was cut off (Anthropic, OpenAI, Codex).
fn truncated(reason: &str) -> bool {
    matches!(reason, "max_tokens" | "length" | "max_output_tokens")
}

/// Starts a streamed completion; events arrive on `on_event`. Returns at once.
#[tauri::command]
pub fn ai_stream(
    app: AppHandle,
    ai: State<Ai>,
    request: Request,
    on_event: Channel<Event>,
) -> Result<()> {
    let provider = wire::provider(&request.provider)
        .ok_or_else(|| format!("unknown provider {}", request.provider))?;
    let id = request.id.clone();
    #[cfg(feature = "headless")]
    if crate::headless::kin_mock() && !crate::headless::ai_enabled() {
        let text = scripted::edit(&request.system, &request.messages);
        let task = async_runtime::spawn(async move {
            for word in text.split_inclusive(' ') {
                tokio::time::sleep(Duration::from_millis(40)).await;
                let _ = on_event.send(Event::Delta { text: word.into() });
            }
            let _ = on_event.send(Event::Done {
                stop_reason: Some("mock".into()),
            });
            app.state::<Ai>().0.lock().unwrap().remove(&id);
        });
        if let Some(previous) = ai.0.lock().unwrap().insert(request.id.clone(), task) {
            previous.abort();
        }
        return Ok(());
    }
    let task = async_runtime::spawn({
        let id = id.clone();
        async move {
            let result = async {
                let auth = resolve(provider).await?;
                let endpoint = wire::Endpoint::new(provider, &request.model, auth);
                let reply = wire::stream(endpoint, &request, |event| {
                    let _ = on_event.send(event);
                })
                .await?;
                // The owner asked for this one, so the cap never blocks it.
                let task = request
                    .task
                    .as_deref()
                    .and_then(Task::from_id)
                    .unwrap_or(Task::Edit);
                let model = ModelRef {
                    provider: provider.id.into(),
                    model: request.model.clone(),
                    reasoning: None,
                };
                meter().record(task, &model, &reply.usage);
                Ok::<_, String>(())
            }
            .await;
            if let Err(message) = result {
                let _ = on_event.send(Event::Error { message });
            }
            app.state::<Ai>().0.lock().unwrap().remove(&id);
        }
    });
    if let Some(previous) = ai.0.lock().unwrap().insert(id, task) {
        previous.abort();
    }
    Ok(())
}

#[tauri::command]
pub fn ai_cancel(ai: State<Ai>, id: String) {
    if let Some(task) = ai.0.lock().unwrap().remove(&id) {
        task.abort();
    }
}

pub(crate) async fn resolve(provider: &Provider) -> Result<Option<Auth>> {
    #[cfg(feature = "headless")]
    if !crate::headless::ai_enabled() {
        return Err("AI is disabled in headless mode".into());
    }
    Chain::default_location()?.resolve(provider).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(id: &'static str, auth: &'static str) -> ProviderStatus {
        ProviderStatus {
            id,
            name: id,
            auth,
            source: None,
        }
    }

    #[test]
    fn preferences_parse_and_name_known_providers_and_catalog_models() {
        for task in Task::ALL {
            assert!(!preferences(task).is_empty());
            for m in preferences(task) {
                assert!(
                    wire::provider(&m.provider).is_some(),
                    "unknown provider {}",
                    m.provider
                );
                let model = catalog::find(&m.provider, &m.model)
                    .unwrap_or_else(|| panic!("{}/{} is not in the catalog", m.provider, m.model));
                if let Some(level) = &m.reasoning {
                    assert!(catalog::Level::parse(level).is_some(), "{level}");
                    assert!(model.reasoning, "{} doesn't think", m.model);
                }
            }
        }
    }

    #[test]
    fn model_for_takes_the_first_usable_preference() {
        let first = &preferences(Task::Edit)[0];
        let second = &preferences(Task::Edit)[1];
        let id = |m: &ModelRef| wire::provider(&m.provider).unwrap().id;
        let all_usable = vec![status(id(first), "login"), status(id(second), "api_key")];
        assert_eq!(model_for(Task::Edit, &all_usable), Some(first));
        for unusable in ["none", "unsupported_login", "expired_login", "local"] {
            let statuses = vec![status(id(first), unusable), status(id(second), "api_key")];
            assert_eq!(model_for(Task::Edit, &statuses), Some(second), "{unusable}");
        }
        assert_eq!(model_for(Task::Edit, &[]), None);
    }

    fn model(provider: &str, id: &str) -> ModelRef {
        ModelRef {
            provider: provider.into(),
            model: id.into(),
            reasoning: None,
        }
    }

    fn at(m: &ModelRef, level: &str) -> ModelRef {
        ModelRef {
            reasoning: Some(level.into()),
            ..m.clone()
        }
    }

    fn pick(m: &ModelRef) -> picks::Pick {
        picks::Pick::with_model(m.clone())
    }

    #[test]
    fn defaults_and_picks_fall_back_to_the_next_usable_model() {
        let first = preferences(Task::Chat)[0].clone();
        let second = preferences(Task::Chat)[1].clone();
        let id = |m: &ModelRef| wire::provider(&m.provider).unwrap().id;
        let mut settings = cost::Settings::default();
        let haiku = model("anthropic", "claude-haiku-5-5");
        settings.models.insert("chat".into(), haiku.clone());
        let flash = model("zai", "glm-5.3-flash");

        // Everything usable: the pick, then the default.
        let all = vec![
            status(id(&first), "login"),
            status(id(&second), "login"),
            status("anthropic", "api_key"),
            status("zai", "api_key"),
        ];
        // Chat thinks at medium, moved to what the model supports (GLM: high).
        assert_eq!(
            conversation_model(Some(&pick(&flash)), &all, &settings),
            Some(at(&flash, "high"))
        );
        assert_eq!(
            conversation_model(None, &all, &settings),
            Some(at(&haiku, "medium"))
        );
        assert_eq!(
            chosen_model(Task::Chat, &all, &settings),
            Some(at(&haiku, "medium"))
        );
        // No credential for the pick or the default: the next usable
        // preference, at its own level.
        let few = vec![status(id(&first), "none"), status(id(&second), "login")];
        assert_eq!(second.reasoning.as_deref(), Some("medium"));
        assert_eq!(
            conversation_model(Some(&pick(&flash)), &few, &settings),
            Some(second.clone())
        );
        assert_eq!(chosen_model(Task::Chat, &few, &settings), Some(second));
        // Edits and completions take a default too; completions think as
        // little as the model allows.
        settings.models.insert("complete".into(), flash.clone());
        assert_eq!(
            chosen_model(Task::Complete, &all, &settings),
            Some(at(&flash, "low"))
        );
    }

    #[test]
    fn efforts_come_from_the_conversation_then_settings_then_the_choice() {
        let codex = model("openai-codex", "gpt-6-luna");
        let all = vec![
            status("openai-codex", "login"),
            status("opencode-go", "login"),
        ];
        let mut settings = cost::Settings::default();
        settings.models.insert("chat".into(), codex.clone());
        // Nothing named: the task's own level.
        assert_eq!(
            chosen_model(Task::Chat, &all, &settings),
            Some(at(&codex, "medium"))
        );
        // Edits on a model the preferences don't name a level for: low.
        settings
            .models
            .insert("edit".into(), model("opencode-go", "glm-5.3"));
        assert_eq!(
            chosen_model(Task::Edit, &all, &settings)
                .unwrap()
                .reasoning
                .as_deref(),
            Some("low")
        );
        // A default effort per task in Settings.
        settings.efforts.insert("chat".into(), "high".into());
        assert_eq!(
            chosen_model(Task::Chat, &all, &settings),
            Some(at(&codex, "high"))
        );
        assert_eq!(
            conversation_model(None, &all, &settings),
            Some(at(&codex, "high"))
        );
        // The conversation's effort wins, with or without a model of its own.
        let effort_only = picks::Pick {
            reasoning: Some("xhigh".into()),
            ..Default::default()
        };
        assert_eq!(
            conversation_model(Some(&effort_only), &all, &settings),
            Some(at(&codex, "xhigh"))
        );
        let glm = model("opencode-go", "glm-5.3");
        let both = picks::Pick {
            reasoning: Some("medium".into()),
            ..pick(&glm)
        };
        // GLM-5.3 has no medium: the next stronger.
        assert_eq!(
            conversation_model(Some(&both), &all, &settings),
            Some(at(&glm, "high"))
        );
        // A model that doesn't think gets no level at all.
        let plain = crate::ai::catalog::all()
            .iter()
            .find(|m| m.provider == "opencode-go" && !m.reasoning);
        if let Some(plain) = plain {
            let plain = model("opencode-go", &plain.id);
            assert_eq!(
                conversation_model(
                    Some(&picks::Pick {
                        reasoning: Some("high".into()),
                        ..pick(&plain)
                    }),
                    &all,
                    &settings
                ),
                Some(plain)
            );
        }
        // Background work keeps the preference's own level.
        let triage = chosen_model(Task::Triage, &all, &settings).unwrap();
        assert_eq!(triage.model, "glm-5.3-flash");
        assert_eq!(triage.reasoning.as_deref(), Some("low"));
    }

    #[test]
    fn the_enabled_list_starts_short_follows_his_changes_and_keeps_task_defaults() {
        let mut settings = cost::Settings::default();
        let all = vec![
            status("opencode-go", "login"),
            status("anthropic", "api_key"),
        ];
        let defaults = enabled_models(&all, &settings);
        // A short list: every preference and a few alternatives, all in the catalog.
        assert!(defaults.len() < 60, "{}", defaults.len());
        for m in &defaults {
            assert!(
                catalog::find(&m.provider, &m.model).is_some(),
                "{}/{} isn't in the catalog",
                m.provider,
                m.model
            );
            assert!(m.reasoning.is_none());
        }
        let per = |provider: &str| defaults.iter().filter(|m| m.provider == provider).count();
        for provider in [
            "opencode-go",
            "anthropic",
            "openai-codex",
            "zai",
            "opencode",
            "openrouter",
        ] {
            assert!(
                (2..=6).contains(&per(provider)),
                "{provider}: {}",
                per(provider)
            );
        }
        let on = |s: &cost::Settings, m: &ModelRef| {
            enabled_models(&all, s).iter().any(|x| same_model(x, m))
        };

        // One turned on, one of the defaults turned off.
        let minimax = model("opencode-go", "minimax-m3");
        let opus = model("anthropic", "claude-opus-5-5");
        assert!(!on(&settings, &minimax) && on(&settings, &opus));
        toggle_enabled(&mut settings, &minimax, true);
        toggle_enabled(&mut settings, &opus, false);
        assert!(on(&settings, &minimax) && !on(&settings, &opus));
        assert_eq!((settings.enabled.len(), settings.disabled.len()), (1, 1));
        // Back again leaves nothing stored.
        toggle_enabled(&mut settings, &minimax, false);
        toggle_enabled(&mut settings, &opus, true);
        assert_eq!(settings, cost::Settings::default());

        // A task's default is always on, even turned off.
        settings.models.insert("chat".into(), minimax.clone());
        toggle_enabled(&mut settings, &minimax, false);
        assert!(on(&settings, &minimax));
        let resolved = chosen_base(Task::Triage, &all, &settings).unwrap();
        toggle_enabled(&mut settings, &resolved, false);
        assert!(on(&settings, &resolved));
    }

    #[test]
    fn errors_are_fixed_messages() {
        assert_eq!(
            AiError::Request.to_string(),
            "The AI provider request failed."
        );
        assert_eq!(format!("{:?}", AiError::TimedOut), "TimedOut");
    }

    #[test]
    fn until_overflow_drops_the_future_once_flagged() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let overflow = AtomicBool::new(false);
        let finished = runtime.block_on(until_overflow(async { 7 }, &overflow));
        assert_eq!(finished, Some(7));
        let never = async {
            overflow.store(true, Ordering::Relaxed);
            std::future::pending::<()>().await
        };
        assert_eq!(runtime.block_on(until_overflow(never, &overflow)), None);
    }

    #[test]
    fn truncation_stop_reasons() {
        for reason in ["max_tokens", "length", "max_output_tokens"] {
            assert!(truncated(reason));
        }
        assert!(!truncated("stop") && !truncated("end_turn"));
    }

    /// Headless only: there, statuses never read the owner's OpenCode or
    /// Pi files, and Kintsugi's store is in memory.
    #[cfg(feature = "headless")]
    #[test]
    fn credential_commands_never_return_a_secret() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let secret = "sk-ki92-command-secret";
        let views = rt
            .block_on(ai_set_key("deepseek".into(), format!("  {secret} ")))
            .unwrap();
        let text = serde_json::to_string(&views).unwrap();
        assert!(!text.contains(secret), "{text}");
        let deepseek = serde_json::to_value(&views)
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["id"] == "deepseek")
            .cloned()
            .unwrap();
        assert_eq!(deepseek["saved"], "api_key");
        assert_eq!(deepseek["source"], "kintsugi");
        assert_eq!(deepseek["auth"], "api_key");
        assert_eq!(deepseek["listed"], true);
        // Saved as Pi stores it, and read back as typed.
        assert_eq!(
            rt.block_on(credentials::kintsugi().auth("deepseek"))
                .unwrap(),
            Some(Auth::ApiKey(secret.into()))
        );
        assert!(
            rt.block_on(ai_set_key("deepseek".into(), "has space".into()))
                .unwrap_err()
                .contains("API key")
        );
        assert!(
            rt.block_on(ai_set_key("openai-codex".into(), "k".into()))
                .is_err()
        );
        assert!(
            rt.block_on(ai_set_key("ollama".into(), "k".into()))
                .is_err()
        );
        let views = rt
            .block_on(ai_remove_credential("deepseek".into()))
            .unwrap();
        let deepseek = views.iter().find(|v| v.id == "deepseek").unwrap();
        assert_eq!((deepseek.saved, deepseek.auth), (None, "none"));
        // Ollama, a keyless local server, takes neither.
        let ollama = views.iter().find(|v| v.id == "ollama").unwrap();
        assert!(!ollama.api_key && !ollama.sign_in);
        assert!(
            views
                .iter()
                .find(|v| v.id == "openai-codex")
                .is_some_and(|v| v.sign_in && !v.api_key)
        );
    }
}

/// Real requests, ignored by default. `live_codex`, `live_zai`, `live_complete`
/// and `live_request` use the owner's credentials (OpenCode, Pi, env):
/// `cargo test live -- --ignored --nocapture`; the per-provider ones read only
/// that provider's environment key.
#[cfg(test)]
mod live {
    use super::*;
    use wire::{Message, Role};

    fn ping(provider: &str, model: &str, reasoning: Option<&str>) {
        let provider = wire::provider(provider).unwrap();
        let request = Request {
            id: "live".into(),
            provider: provider.id.into(),
            model: model.into(),
            system: "Reply with exactly the word: ok".into(),
            messages: vec![Message {
                role: Role::User,
                content: "ping".into(),
            }],
            max_tokens: Some(64),
            temperature: None,
            stop: None,
            reasoning: reasoning.map(String::from),
            task: None,
        };
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let mut text = String::new();
        let mut done = None;
        runtime
            .block_on(async {
                let auth = resolve(provider).await?;
                wire::stream(
                    wire::Endpoint::new(provider, &request.model, auth),
                    &request,
                    |event| match event {
                        Event::Delta { text: t } => text.push_str(&t),
                        other => done = Some(other),
                    },
                )
                .await
            })
            .unwrap();
        println!("{}: {text:?} {done:?}", provider.id);
        assert!(text.to_lowercase().contains("ok"));
    }

    #[test]
    #[ignore]
    fn live_codex() {
        ping("openai-codex", "gpt-6-luna", Some("low"));
    }

    #[test]
    #[ignore]
    fn live_zai() {
        ping("zai", "glm-5.3-flash", None);
    }

    /// One tiny request per provider with the key from its environment
    /// variable only (never OpenCode's or Pi's stores), to the provider's
    /// cheapest catalog model, thinking at its lowest. Skipped, and passing,
    /// without the key: `GROQ_API_KEY=… cargo test live_groq -- --ignored --nocapture`.
    fn live_env(id: &str) {
        let provider = wire::provider(id).unwrap();
        let Some(key) = provider
            .env_keys
            .iter()
            .find_map(|k| std::env::var(k).ok().filter(|v| !v.trim().is_empty()))
        else {
            println!("{id}: skipped, none of {:?} is set", provider.env_keys);
            return;
        };
        let model = catalog::models(id)
            .min_by(|a, b| {
                let price = |m: &catalog::Model| m.cost.rates.input + m.cost.rates.output;
                price(a).total_cmp(&price(b))
            })
            .expect("the provider has catalog models");
        let request = Request {
            id: "live".into(),
            provider: id.into(),
            model: model.id.clone(),
            system: "Reply with exactly the word: ok".into(),
            messages: vec![Message {
                role: Role::User,
                content: "ping".into(),
            }],
            max_tokens: Some(256),
            temperature: None,
            stop: None,
            reasoning: Some("off".into()),
            task: None,
        };
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let mut text = String::new();
        let reply = runtime
            .block_on(wire::stream(
                wire::Endpoint::new(provider, &model.id, Some(Auth::ApiKey(key))),
                &request,
                |event| {
                    if let Event::Delta { text: t } = event {
                        text.push_str(&t)
                    }
                },
            ))
            .unwrap();
        let (price, _) = cost::price(id, &model.id);
        println!(
            "{id}/{}: {text:?} {:?} ${:.6}",
            model.id,
            reply.usage,
            cost::usd(&price, &reply.usage)
        );
        assert!(!text.trim().is_empty());
    }

    macro_rules! live {
        ($($name:ident => $id:literal),* $(,)?) => {
            $(
                #[test]
                #[ignore]
                fn $name() {
                    live_env($id);
                }
            )*
            const LIVE: &[&str] = &[$($id),*];
        };
    }

    live! {
        live_anthropic => "anthropic",
        live_openai => "openai",
        live_openrouter => "openrouter",
        live_zai_env => "zai",
        live_opencode => "opencode",
        live_opencode_go => "opencode-go",
        live_google => "google",
        live_google_vertex => "google-vertex",
        live_xai => "xai",
        live_groq => "groq",
        live_cerebras => "cerebras",
        live_mistral => "mistral",
        live_deepseek => "deepseek",
        live_together => "together",
        live_fireworks => "fireworks",
        live_vercel_ai_gateway => "vercel-ai-gateway",
        live_github_copilot => "github-copilot",
        live_moonshotai => "moonshotai",
        live_moonshotai_cn => "moonshotai-cn",
        live_kimi_coding => "kimi-coding",
        live_minimax => "minimax",
        live_minimax_cn => "minimax-cn",
        live_zai_coding_cn => "zai-coding-cn",
        live_meta => "meta",
        live_huggingface => "huggingface",
        live_nvidia => "nvidia",
        live_baseten => "baseten",
        live_ant_ling => "ant-ling",
        live_xiaomi => "xiaomi",
        live_xiaomi_token_plan_ams => "xiaomi-token-plan-ams",
        live_xiaomi_token_plan_cn => "xiaomi-token-plan-cn",
        live_xiaomi_token_plan_sgp => "xiaomi-token-plan-sgp",
        live_qwen_token_plan => "qwen-token-plan",
        live_qwen_token_plan_individual => "qwen-token-plan-individual",
        live_qwen_token_plan_cn => "qwen-token-plan-cn",
    }

    #[test]
    fn every_provider_with_a_key_has_a_live_test() {
        for p in PROVIDERS.iter().filter(|p| !p.env_keys.is_empty()) {
            assert!(LIVE.contains(&p.id), "no live test for {}", p.id);
        }
    }

    /// `complete` end to end with the edit model.
    #[test]
    #[ignore]
    fn live_complete() {
        let ask = Ask {
            system: "Reply with exactly the word: ok".into(),
            prompt: "ping".into(),
            max_tokens: 256,
            max_response_bytes: 1000,
            timeout: Duration::from_secs(60),
        };
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let text = runtime.block_on(complete(Task::Edit, &ask)).unwrap();
        println!("{text:?}");
        assert!(text.to_lowercase().contains("ok"));
    }

    /// Replays a request built by the webview's prompt code, for tuning prompts:
    /// `KINTSUGI_REQUEST=req.json cargo test live_request -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_request() {
        let path =
            std::env::var("KINTSUGI_REQUEST").expect("set KINTSUGI_REQUEST to a request JSON file");
        let request: Request =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let provider = wire::provider(&request.provider).unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let mut text = String::new();
        runtime
            .block_on(async {
                let auth = resolve(provider).await?;
                wire::stream(
                    wire::Endpoint::new(provider, &request.model, auth),
                    &request,
                    |event| {
                        if let Event::Delta { text: t } = event {
                            text.push_str(&t)
                        }
                    },
                )
                .await
            })
            .unwrap();
        println!("---\n{text}\n---");
    }
}
