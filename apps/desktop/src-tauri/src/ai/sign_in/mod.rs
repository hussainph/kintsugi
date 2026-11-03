//! Signing in to a provider from Settings › Providers (KI-92): every login
//! Pi offers, ported from pi-ai 1.5.0 (`flows.rs`), saved in Kintsugi's own
//! credential store in Pi's format (`pi_auth::Store::kintsugi`).
//!
//! A sign-in runs in Rust and talks to the webview over a Channel, the way
//! Pi's `/login` talks to its terminal: it asks (`Prompt`: a choice, a
//! domain, a pasted redirect URL), shows (`AuthUrl`, which the webview
//! opens with the validated `open_url`; `DeviceCode`; `Progress`) and ends
//! (`Done`, `Failed`). Nothing it sends holds a secret: tokens go straight
//! from the provider into the store.
//!
//! Headless runs never sign in: `ai_sign_in` plays a scripted sign-in of
//! the same shape instead (`mock`), saved in memory only.

// Headless runs only ever play `mock`; the real flows are still built and tested.
#[cfg_attr(feature = "headless", allow(dead_code))]
mod callback;
#[cfg_attr(feature = "headless", allow(dead_code))]
mod device;
#[cfg_attr(feature = "headless", allow(dead_code))]
mod flows;
#[cfg(test)]
mod tests;

use super::credentials;
use super::pi_auth::{self, Calls};
use super::wire;
use crate::AppHandle;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::{State, async_runtime};
use tokio::sync::{mpsc, oneshot};

type Result<T> = std::result::Result<T, String>;

/// Pi's logins, by provider id. Pi's Claude subscription login is left
/// out on purpose (`CLAUDE_REFUSED`), and so is its Radius gateway, which
/// Kintsugi doesn't speak.
pub const SIGN_IN: [&str; 7] = [
    "openai-codex",
    "openai",
    "github-copilot",
    "kimi-coding",
    "xai",
    "meta",
    "openrouter",
];

pub const CLAUDE_REFUSED: &str =
    "Kintsugi uses only Anthropic API keys, not a Claude subscription. Add an Anthropic API key.";

const CANCELLED: &str = "Sign-in cancelled";

pub fn can_sign_in(provider: &str) -> bool {
    SIGN_IN.contains(&provider)
}

/// What a sign-in asks him.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prompt {
    pub kind: PromptKind,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<Choice>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PromptKind {
    /// One of `options`, answered with its id.
    Select,
    /// A line of text.
    Text,
    /// The code or redirect URL from the browser, while the loopback
    /// server also waits for it.
    Paste,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Choice {
    pub id: &'static str,
    pub label: &'static str,
}

impl Prompt {
    pub fn select(message: &str, options: &[(&'static str, &'static str)]) -> Self {
        Prompt {
            kind: PromptKind::Select,
            message: message.into(),
            placeholder: None,
            options: options
                .iter()
                .map(|&(id, label)| Choice { id, label })
                .collect(),
        }
    }

    pub fn text(message: &str, placeholder: &str) -> Self {
        Prompt {
            kind: PromptKind::Text,
            message: message.into(),
            placeholder: Some(placeholder.into()),
            options: Vec::new(),
        }
    }

    pub fn paste(redirect: &str) -> Self {
        Prompt {
            kind: PromptKind::Paste,
            message: "Paste the redirect URL".into(),
            placeholder: Some(redirect.into()),
            options: Vec::new(),
        }
    }
}

/// What a sign-in tells the webview. Never a token or a key.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Event {
    Prompt {
        id: u32,
        #[serde(flatten)]
        prompt: Prompt,
    },
    /// The page to sign in on; `open` asks the webview to open it.
    AuthUrl {
        url: String,
        open: bool,
    },
    /// A device-code login: the code to enter, and where.
    DeviceCode {
        user_code: String,
        verification_uri: String,
    },
    #[cfg_attr(feature = "headless", allow(dead_code))]
    Progress {
        message: String,
    },
    Done,
    Failed {
        message: String,
    },
}

pub enum Message {
    Event(Event),
    Prompt(Prompt, oneshot::Sender<String>),
}

/// A sign-in's line to whoever drives it: the webview, or a test.
pub struct Interaction {
    tx: mpsc::UnboundedSender<Message>,
}

impl Interaction {
    pub fn new() -> (Self, mpsc::UnboundedReceiver<Message>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (Interaction { tx }, rx)
    }

    pub fn notify(&self, event: Event) {
        let _ = self.tx.send(Message::Event(event));
    }

    /// Asks, and waits for the answer. Fails once the sign-in is cancelled.
    pub async fn prompt(&self, prompt: Prompt) -> Result<String> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Message::Prompt(prompt, tx))
            .map_err(|_| CANCELLED.to_string())?;
        rx.await.map_err(|_| CANCELLED.into())
    }
}

/// Signs in to `provider` for real, saving nothing: the credential, as Pi
/// would store it.
#[cfg_attr(feature = "headless", allow(dead_code))]
pub async fn login(
    provider: &str,
    i: &Interaction,
    endpoints: &pi_auth::Endpoints,
    device_id: Option<&str>,
) -> Result<Value> {
    let calls = Calls::new(endpoints, pi_auth::Owner::Kintsugi.relogin(), "sign-in");
    flows::login(provider, i, &calls, device_id).await
}

// --- The headless stand-in ---------------------------------------------------

/// The credential a scripted sign-in saves: Pi's shape for that provider,
/// field for field, with made-up values.
#[cfg_attr(not(any(test, feature = "headless")), allow(dead_code))]
pub fn mock_credential(provider: &str, enterprise: Option<&str>) -> Value {
    let expires = pi_auth::now_ms() + 60 * 60 * 1000;
    let mut credential = json!({ "type": "oauth", "access": "mock-access", "refresh": "mock-refresh", "expires": expires });
    match provider {
        "openai-codex" => credential["accountId"] = "mock-account".into(),
        "openai" => {
            credential["clientId"] = "mock-client".into();
            credential["scopes"] = json!(flows::CHATGPT_SCOPE.split(' ').collect::<Vec<_>>());
        }
        "github-copilot" => {
            if let Some(domain) = enterprise {
                credential["enterpriseUrl"] = domain.into();
            }
            credential["availableModelIds"] = json!([]);
        }
        "openrouter" => {
            credential["refresh"] = "".into();
            credential["expires"] = flows::OPENROUTER_EXPIRES.into();
        }
        _ => {}
    }
    credential
}

/// A sign-in of the same shape as the real one for `provider`, with no
/// network: a browser login waits for a pasted URL; a device-code login
/// finishes by itself after `KINTSUGI_HEADLESS_SIGN_IN_MS` (5s).
#[cfg_attr(not(any(test, feature = "headless")), allow(dead_code))]
pub async fn mock(provider: &str, i: &Interaction) -> Result<Value> {
    let delay = std::env::var("KINTSUGI_HEADLESS_SIGN_IN_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(5000u64);
    let browser = async |i: &Interaction| -> Result<()> {
        i.notify(Event::AuthUrl {
            url: "https://example.com/kintsugi/mock-sign-in".into(),
            open: false,
        });
        i.prompt(Prompt::paste("http://localhost:1455/auth/callback"))
            .await?;
        Ok(())
    };
    let device = async |i: &Interaction| {
        i.notify(Event::DeviceCode {
            user_code: "MOCK-1234".into(),
            verification_uri: "https://example.com/kintsugi/device".into(),
        });
        tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
    };
    let mut enterprise = None;
    match provider {
        "openai-codex" => {
            let method = i
                .prompt(Prompt::select(
                    "Sign in with",
                    &[("browser", "Browser"), ("device_code", "Device code")],
                ))
                .await?;
            if method == "device_code" {
                device(i).await
            } else {
                browser(i).await?
            }
        }
        "openai" | "openrouter" => browser(i).await?,
        "github-copilot" => {
            let input = i
                .prompt(Prompt::text(
                    "GitHub Enterprise domain",
                    "Leave empty for github.com",
                ))
                .await?;
            enterprise = pi_auth::normalize_domain(&input);
            device(i).await
        }
        id if can_sign_in(id) => device(i).await,
        "anthropic" => return Err(CLAUDE_REFUSED.into()),
        other => return Err(format!("{other} has no sign-in; add a key instead")),
    }
    Ok(mock_credential(provider, enterprise.as_deref()))
}

// --- The commands --------------------------------------------------------------

type Pending = Arc<Mutex<HashMap<u32, oneshot::Sender<String>>>>;

struct Session {
    task: async_runtime::JoinHandle<()>,
    pending: Pending,
    /// Set on cancel, so a save already under way is skipped.
    cancelled: Arc<AtomicBool>,
}

impl Session {
    /// Stops it and waits until it has stopped, so its loopback port is
    /// free before another sign-in binds it.
    async fn stop(self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.task.abort();
        let _ = self.task.await;
    }
}

/// The sign-in under way, if any.
#[derive(Default)]
pub struct SignIns {
    /// Held from stopping the old sign-in to registering the new one, so
    /// two quick clicks can't leave two sign-ins fighting over port 1455.
    starting: tokio::sync::Mutex<()>,
    /// Each removes itself when it ends.
    sessions: Arc<Mutex<HashMap<String, Session>>>,
}

/// This installation's UUID, which Sign in with ChatGPT sends OpenAI as
/// its agent host: `device-id` in the config folder, made on first use.
fn device_id(app: &AppHandle) -> Option<String> {
    let Some(dir) = super::kin::data_dir(app).and_then(|d| d.parent().map(|p| p.to_path_buf()))
    else {
        return Some(uuid::Uuid::new_v4().to_string());
    };
    let path = dir.join("device-id");
    if let Ok(text) = std::fs::read_to_string(&path)
        && let Ok(id) = uuid::Uuid::parse_str(text.trim())
    {
        return Some(id.hyphenated().to_string());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let _ = std::fs::create_dir_all(&dir);
    kintsugi_vault::write_atomic(&path, &id).ok()?;
    Some(id)
}

/// Starts signing in to `provider`, cancelling any other sign-in (both
/// OpenAI logins listen on port 1455). `events` gets its prompts and
/// progress; the answer is the sign-in's id.
#[tauri::command]
pub async fn ai_sign_in(
    app: AppHandle,
    state: State<'_, SignIns>,
    provider: String,
    events: Channel<Event>,
) -> Result<String> {
    let provider = wire::provider(&provider).ok_or("Unknown provider")?.id;
    if provider == "anthropic" {
        return Err(CLAUDE_REFUSED.into());
    }
    if !can_sign_in(provider) {
        return Err("This provider has no sign-in; add a key instead.".into());
    }
    let device = (provider == "openai" && !cfg!(feature = "headless"))
        .then(|| device_id(&app))
        .flatten();
    let _ = &app;
    let _starting = state.starting.lock().await;
    let old: Vec<Session> = state
        .sessions
        .lock()
        .unwrap()
        .drain()
        .map(|(_, s)| s)
        .collect();
    for session in old {
        session.stop().await;
    }
    let id = uuid::Uuid::new_v4().to_string();
    let pending = Pending::default();
    let (interaction, mut rx) = Interaction::new();
    let forwarded = pending.clone();
    async_runtime::spawn(async move {
        let mut next = 0;
        while let Some(message) = rx.recv().await {
            match message {
                Message::Event(event) => {
                    let _ = events.send(event);
                }
                Message::Prompt(prompt, reply) => {
                    next += 1;
                    forwarded.lock().unwrap().insert(next, reply);
                    let _ = events.send(Event::Prompt { id: next, prompt });
                }
            }
        }
    });
    let store = credentials::kintsugi().clone();
    let cancelled = Arc::new(AtomicBool::new(false));
    let stopped = cancelled.clone();
    let (registered, is_registered) = oneshot::channel::<()>();
    let sessions = state.sessions.clone();
    let ours = id.clone();
    let task = async_runtime::spawn(async move {
        // Starts once it's in `sessions`, so it can always remove itself.
        let _ = is_registered.await;
        let result = async {
            #[cfg(feature = "headless")]
            let credential = {
                let _ = &device;
                mock(provider, &interaction).await?
            };
            #[cfg(not(feature = "headless"))]
            let credential = login(
                provider,
                &interaction,
                &store.endpoints(),
                device.as_deref(),
            )
            .await?;
            let saving = store.clone();
            tokio::task::spawn_blocking(move || {
                if stopped.load(Ordering::SeqCst) {
                    return Err(CANCELLED.to_string());
                }
                saving.save(provider, credential)
            })
            .await
            .map_err(|_| "Couldn't save the sign-in.".to_string())?
        }
        .await;
        interaction.notify(match result {
            Ok(()) => Event::Done,
            Err(message) => Event::Failed { message },
        });
        sessions.lock().unwrap().remove(&ours);
    });
    state.sessions.lock().unwrap().insert(
        id.clone(),
        Session {
            task,
            pending,
            cancelled,
        },
    );
    let _ = registered.send(());
    Ok(id)
}

/// Answers the sign-in's prompt `prompt`.
#[tauri::command]
pub fn ai_sign_in_answer(
    state: State<'_, SignIns>,
    id: String,
    prompt: u32,
    value: String,
) -> Result<()> {
    let sessions = state.sessions.lock().unwrap();
    let reply = sessions
        .get(&id)
        .and_then(|s| s.pending.lock().unwrap().remove(&prompt))
        .ok_or("That sign-in has ended.")?;
    reply
        .send(value)
        .map_err(|_| "That sign-in has ended.".to_string())
}

/// Stops a sign-in: its loopback server closes and nothing is saved.
#[tauri::command]
pub async fn ai_sign_in_cancel(state: State<'_, SignIns>, id: String) -> Result<()> {
    let _starting = state.starting.lock().await;
    let session = state.sessions.lock().unwrap().remove(&id);
    if let Some(session) = session {
        session.stop().await;
    }
    Ok(())
}
