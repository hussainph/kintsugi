//! Kintsugi's model harness: Pi's credentials, Kintsugi's own transport.
//! The webview sends prompts and receives text; keys never leave Rust.

mod pi_auth;
mod wire;

use pi_auth::{Auth, Kind, Store};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::{async_runtime, AppHandle, Manager, State};
use wire::{Event, Provider, Request, Wire, PROVIDERS};

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
            ProviderStatus { id: p.id, name: p.name, auth }
        })
        .collect())
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
                wire::stream(provider, auth, &request, |event| {
                    let _ = on_event.send(event);
                })
                .await
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

async fn resolve(provider: &Provider) -> Result<Option<Auth>> {
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
            None => Err(format!("No credentials for {}. Run `pi` and log in, or add an API key.", provider.name)),
        },
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
            messages: vec![Message { role: Role::User, content: "ping".into() }],
            max_tokens: Some(64),
            temperature: None,
            stop: None,
            reasoning: reasoning.map(String::from),
        };
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let mut text = String::new();
        let mut done = None;
        runtime
            .block_on(async {
                let auth = resolve(provider).await?;
                wire::stream(provider, auth, &request, |event| match event {
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
                wire::stream(provider, auth, &request, |event| {
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
