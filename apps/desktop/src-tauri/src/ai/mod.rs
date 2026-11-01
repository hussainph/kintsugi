//! Kintsugi's model harness: Pi's credentials, Kintsugi's own transport.
//! The webview sends prompts and receives text; keys never leave Rust.
//!
//! - `wire`: three wire formats, streaming text and tool calls.
//! - `agent`: Kin's loop, many tool calls per turn, cancellable.
//! - `tools`: Kin's read-only vault tools.
//! - `prompt`: the fixed, cacheable prefix and the dynamic tail.
//! - `cost`: prices, the usage ledger and the monthly cap.
//! - `kin`: the Tauri commands for Kin and its settings.
//! - `memory`: Kin's capped memory and skills in `.kintsugi/agent/`.
//! - `about`: the About you commands, and the memory snapshot for helpers.
//! - `history`: the one conversation log, its inferred threads and summaries.
//! - `jobs`: the helper job table.
//! - `chat`: the live conversation: batching, interrupts, helpers.
//! - `ideas`: Kin's daily ideas, checked against their sources (KI-39).

pub mod about;
mod agent;
pub mod chat;
pub mod cost;
mod history;
pub mod ideas;
mod jobs;
pub mod kin;
pub mod memory;
mod pi_auth;
pub mod prompt;
#[cfg(feature = "headless")]
mod scripted;
pub(crate) mod tools;
mod wire;

pub use chat::Chat;
pub use kin::Kin;

use crate::AppHandle;
use pi_auth::{Auth, Kind, Store};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::task::Poll;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{Manager, State, async_runtime};
use wire::{Event, PROVIDERS, Provider, Request, Wire};

type Result<T> = std::result::Result<T, String>;

/// In-flight requests, so a new keystroke can cancel a stale completion.
#[derive(Default)]
pub struct Ai(Mutex<HashMap<String, async_runtime::JoinHandle<()>>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    id: &'static str,
    name: &'static str,
    /// Where the credential comes from, or why there isn't a usable one.
    auth: &'static str,
}

/// Every provider Kintsugi speaks, and whether it can be used right now.
#[tauri::command]
pub fn ai_providers() -> Result<Vec<ProviderStatus>> {
    statuses()
}

fn statuses() -> Result<Vec<ProviderStatus>> {
    #[cfg(feature = "headless")]
    if !crate::headless::ai_enabled() {
        return Ok(PROVIDERS.iter().map(|p| ProviderStatus { id: p.id, name: p.name, auth: "none" }).collect());
    }
    let kinds: HashMap<String, Kind> = Store::default_location()?.list()?.into_iter().collect();
    Ok(PROVIDERS
        .iter()
        .map(|p| {
            let env = p.env_key.is_some_and(|k| std::env::var(k).is_ok_and(|v| !v.is_empty()));
            let auth = match (kinds.get(p.id), p.wire) {
                (Some(Kind::ApiKey), _) => "pi_api_key",
                (Some(Kind::Oauth), Wire::Codex | Wire::OpenAiChat) => "pi_login",
                // A Claude subscription login: Kintsugi only uses Anthropic API keys.
                (Some(Kind::Oauth), Wire::Anthropic) if !env => "unsupported_login",
                _ if env => "env",
                _ if p.keyless => "local",
                _ => "none",
            };
            ProviderStatus {
                id: p.id,
                name: p.name,
                auth,
            }
        })
        .collect())
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
    pub const ALL: [Task; 5] = [Task::Edit, Task::Complete, Task::Chat, Task::Ideas, Task::Triage];
    /// Tasks whose model the owner picks in Settings.
    pub const KIN: [Task; 3] = [Task::Chat, Task::Ideas, Task::Triage];

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
}

/// The webview's `src/lib/models.ts` reads the same file, so both sides
/// pick the same model for a task.
const PREFERENCES_JSON: &str = include_str!("../../../src/lib/models.json");

fn preferences(task: Task) -> &'static [ModelRef] {
    static PARSED: OnceLock<Preferences> = OnceLock::new();
    let parsed = PARSED.get_or_init(|| serde_json::from_str(PREFERENCES_JSON).expect("src/lib/models.json is valid"));
    match task {
        Task::Edit => &parsed.edit,
        Task::Complete => &parsed.complete,
        Task::Chat => &parsed.chat,
        Task::Ideas => &parsed.ideas,
        Task::Triage => &parsed.triage,
    }
}

/// Mirrors `usable` in src/lib/models.ts: local servers are never picked
/// automatically, and a login Kintsugi can't use doesn't count.
fn usable(auth: &str) -> bool {
    !matches!(auth, "none" | "unsupported_login" | "local")
}

fn ready(m: &ModelRef, statuses: &[ProviderStatus]) -> bool {
    statuses.iter().any(|s| s.id == m.provider && usable(s.auth))
}

/// The first preferred model whose provider is usable, as `modelFor` does.
fn model_for(task: Task, statuses: &[ProviderStatus]) -> Option<&'static ModelRef> {
    preferences(task).iter().find(|m| ready(m, statuses))
}

/// The owner's choice for a task when its provider is usable, else the
/// first usable preference.
fn chosen_model(task: Task, statuses: &[ProviderStatus], settings: &cost::Settings) -> Option<ModelRef> {
    settings
        .models
        .get(task.id())
        .filter(|m| wire::provider(&m.provider).is_some() && ready(m, statuses))
        .cloned()
        .or_else(|| model_for(task, statuses).cloned())
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
    let _ = METER.set(cost::Meter::open(kin::data_dir(app)));
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
            AiError::NotConfigured => "No AI provider is set up. Run `pi`, log in or add an API key.",
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
        let auth = resolve(provider).await.map_err(|_| AiError::NotConfigured)?;
        let overflow = AtomicBool::new(false);
        let mut length = 0;
        let streaming = wire::send(wire::Endpoint::new(provider, auth), &exchange, |delta| {
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
    tokio::time::timeout(ask.timeout, run).await.map_err(|_| AiError::TimedOut)?
}

/// Polls `future` until it finishes or `overflow` is set, which drops it
/// and so closes the connection.
async fn until_overflow<F: std::future::Future>(future: F, overflow: &AtomicBool) -> Option<F::Output> {
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
pub fn ai_stream(app: AppHandle, ai: State<Ai>, request: Request, on_event: Channel<Event>) -> Result<()> {
    let provider = wire::provider(&request.provider).ok_or_else(|| format!("unknown provider {}", request.provider))?;
    let id = request.id.clone();
    let task = async_runtime::spawn({
        let id = id.clone();
        async move {
            let result = async {
                let auth = resolve(provider).await?;
                let reply = wire::stream(wire::Endpoint::new(provider, auth), &request, |event| {
                    let _ = on_event.send(event);
                })
                .await?;
                // The owner asked for this one, so the cap never blocks it.
                let task = request.task.as_deref().and_then(Task::from_id).unwrap_or(Task::Edit);
                let model = ModelRef { provider: provider.id.into(), model: request.model.clone(), reasoning: None };
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
    let env = || provider.env_key.and_then(|k| std::env::var(k).ok()).filter(|v| !v.is_empty());
    match Store::default_location()?.auth(provider.id).await? {
        Some(Auth::Bearer { .. }) if provider.wire == Wire::Anthropic => match env() {
            Some(key) => Ok(Some(Auth::ApiKey(key))),
            None => Err("Pi has a Claude subscription login, but Kintsugi needs an Anthropic API key. \
                         Run `pi` and add an API key for Anthropic, or set ANTHROPIC_API_KEY."
                .into()),
        },
        Some(auth) => Ok(Some(auth)),
        None => match env() {
            Some(key) => Ok(Some(Auth::ApiKey(key))),
            None if provider.keyless => Ok(None),
            None => Err(format!(
                "No credentials for {}. Run `pi` and log in, or add an API key.",
                provider.name
            )),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(id: &'static str, auth: &'static str) -> ProviderStatus {
        ProviderStatus { id, name: id, auth }
    }

    #[test]
    fn preferences_parse_and_name_known_providers() {
        for task in [Task::Edit, Task::Complete] {
            assert!(!preferences(task).is_empty());
            for m in preferences(task) {
                assert!(wire::provider(&m.provider).is_some(), "unknown provider {}", m.provider);
            }
        }
    }

    #[test]
    fn model_for_takes_the_first_usable_preference() {
        let first = &preferences(Task::Edit)[0];
        let second = &preferences(Task::Edit)[1];
        let id = |m: &ModelRef| wire::provider(&m.provider).unwrap().id;
        let all_usable = vec![status(id(first), "pi_login"), status(id(second), "env")];
        assert_eq!(model_for(Task::Edit, &all_usable), Some(first));
        for unusable in ["none", "unsupported_login", "local"] {
            let statuses = vec![status(id(first), unusable), status(id(second), "pi_api_key")];
            assert_eq!(model_for(Task::Edit, &statuses), Some(second), "{unusable}");
        }
        assert_eq!(model_for(Task::Edit, &[]), None);
    }

    #[test]
    fn errors_are_fixed_messages() {
        assert_eq!(AiError::Request.to_string(), "The AI provider request failed.");
        assert_eq!(format!("{:?}", AiError::TimedOut), "TimedOut");
    }

    #[test]
    fn until_overflow_drops_the_future_once_flagged() {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
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
}

/// Real requests against Pi's credentials: `cargo test live -- --ignored --nocapture`.
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
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let mut text = String::new();
        let mut done = None;
        runtime
            .block_on(async {
                let auth = resolve(provider).await?;
                wire::stream(wire::Endpoint::new(provider, auth), &request, |event| match event {
                    Event::Delta { text: t } => text.push_str(&t),
                    other => done = Some(other),
                })
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
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let text = runtime.block_on(complete(Task::Edit, &ask)).unwrap();
        println!("{text:?}");
        assert!(text.to_lowercase().contains("ok"));
    }

    /// Replays a request built by the webview's prompt code, for tuning prompts:
    /// `KINTSUGI_REQUEST=req.json cargo test live_request -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_request() {
        let path = std::env::var("KINTSUGI_REQUEST").expect("set KINTSUGI_REQUEST to a request JSON file");
        let request: Request = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let provider = wire::provider(&request.provider).unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let mut text = String::new();
        runtime
            .block_on(async {
                let auth = resolve(provider).await?;
                wire::stream(wire::Endpoint::new(provider, auth), &request, |event| {
                    if let Event::Delta { text: t } = event {
                        text.push_str(&t)
                    }
                })
                .await
            })
            .unwrap();
        println!("---\n{text}\n---");
    }
}
