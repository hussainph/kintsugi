//! Every login Pi offers, ported from pi-ai 1.5.0 (`src/auth/oauth/*.ts`):
//! the same flow, client ids, scopes, endpoints, callback ports and stored
//! fields. Each returns the credential exactly as Pi would store it.
//!
//! Where Kintsugi differs, on purpose: the loopback server always binds
//! 127.0.0.1 (Pi's `PI_OAUTH_CALLBACK_HOST` isn't read) and every browser
//! login times out after five minutes; errors never quote a server's body,
//! only its status and OAuth error code; and the ChatGPT consent page names
//! Kintsugi (Pi's `agentName` option) rather than Pi.

use super::callback::{self, Callback, Verdict};
use super::device::{self, Poll};
use super::{Event, Interaction, Prompt};
use crate::ai::pi_auth::{
    self, CHATGPT_RESOURCE, CODEX_CLIENT_ID, Calls, KIMI_CLIENT_ID, Retry, XAI_CLIENT_ID,
    chatgpt_credential, codex_credential, kimi_credential, normalize_domain, oauth_error,
    str_field, trusted_http_url, xai_credential,
};
use base64::Engine;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::time::Duration;

type Result<T> = std::result::Result<T, String>;

// OpenAI Codex (`openai-codex.ts`).
pub(super) const CODEX_SCOPE: &str = "openid profile email offline_access";
pub(super) const CODEX_CALLBACK_PATH: &str = "/auth/callback";
pub(super) const CODEX_DEVICE_TIMEOUT_S: f64 = 15.0 * 60.0;
pub(super) const CODEX_ORIGINATOR: &str = "pi";
// Sign in with ChatGPT (`openai-chatgpt.ts`).
pub(super) const CHATGPT_CLIENT_ID: &str = "dynamic_agent_client";
pub(super) const CHATGPT_AGENT_NAME: &str = "Kintsugi";
pub(super) const CHATGPT_SCOPE: &str =
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
// GitHub Copilot (`github-copilot.ts`); Pi keeps the client id base64'd.
pub(super) const COPILOT_CLIENT_ID: &str = "Iv1.b507a08c87ecfe98";
pub(super) const COPILOT_SCOPE: &str = "read:user";
pub(super) const COPILOT_USER_AGENT: &str = "GitHubCopilotChat/0.35.0";
// Kimi Code (`kimi-coding.ts`).
pub(super) const KIMI_DEVICE_TIMEOUT_S: f64 = 15.0 * 60.0;
pub(super) const KIMI_DEFAULT_INTERVAL_S: f64 = 5.0;
// xAI (`xai.ts`).
pub(super) const XAI_SCOPE: &str = "openid profile email offline_access grok-cli:access api:access";
pub(super) const XAI_REFERRER: &str = "pi";
// Meta (`meta.ts`): the Muse Code CLI's client.
pub(super) const META_CLIENT_ID: &str = "1031625952748946";
// OpenRouter (`openrouter.ts`): a key that never expires.
pub(super) const OPENROUTER_EXPIRES: u64 = 9007199254740991;

const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";

/// Signs in to `provider` the way Pi does. `device_id` is this
/// installation's UUID (Sign in with ChatGPT needs one).
pub async fn login(
    provider: &str,
    i: &Interaction,
    calls: &Calls<'_>,
    device_id: Option<&str>,
) -> Result<Value> {
    match provider {
        "openai-codex" => codex(i, calls).await,
        "openai" => chatgpt(i, calls, device_id).await,
        "github-copilot" => copilot(i, calls).await,
        "kimi-coding" => kimi(i, calls).await,
        "xai" => xai(i, calls).await,
        "meta" => meta(i, calls).await,
        "openrouter" => openrouter(i, calls).await,
        "anthropic" => Err(super::CLAUDE_REFUSED.into()),
        other => Err(format!("{other} has no sign-in; add a key instead")),
    }
}

fn random(len: usize) -> Vec<u8> {
    let mut bytes = vec![0u8; len];
    getrandom::fill(&mut bytes).expect("the system has randomness");
    bytes
}

fn base64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Pi's `generatePKCE`: a 32-byte verifier and its S256 challenge.
pub(super) fn pkce() -> (String, String) {
    let verifier = base64url(&random(32));
    let challenge = base64url(&Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

fn with_query(base: &str, params: &[(&str, &str)]) -> String {
    let mut url = reqwest::Url::parse(base).expect("a valid base URL");
    url.query_pairs_mut().extend_pairs(params);
    url.to_string()
}

fn param(url: &reqwest::Url, name: &str) -> Option<String> {
    url.query_pairs()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.into_owned())
}

/// Waits for the browser's callback, or for him to paste the code or the
/// redirect URL (when the browser can't reach the loopback server). Pi's
/// `waitForCallbackOrManualInput`.
enum Got<T> {
    Callback(T),
    Pasted(String),
}

async fn callback_or_paste<A, T, F>(
    i: &Interaction,
    server: Option<Callback>,
    check: impl FnMut(&reqwest::Url) -> Verdict<A>,
    complete: impl FnOnce(A) -> F,
    prompt: Prompt,
) -> Result<Got<T>>
where
    F: std::future::Future<Output = Result<T>>,
{
    let paste = i.prompt(prompt);
    match server {
        None => paste.await.map(Got::Pasted),
        Some(server) => tokio::select! {
            got = server.wait(check, complete) => got.map(Got::Callback),
            pasted = paste => pasted.map(Got::Pasted),
        },
    }
}

/// Pi's `parseAuthorizationInput`: a redirect URL, `code#state`, a query
/// string, or the bare code.
pub(super) fn parse_pasted(input: &str) -> (Option<String>, Option<String>) {
    let value = input.trim();
    if value.is_empty() {
        return (None, None);
    }
    if let Ok(url) = reqwest::Url::parse(value) {
        return (param(&url, "code"), param(&url, "state"));
    }
    if let Some((code, state)) = value.split_once('#') {
        return (Some(code.into()), Some(state.into()));
    }
    if value.contains("code=") {
        let pairs: Vec<(String, String)> = reqwest::Url::parse(&format!("http://x/?{value}"))
            .map(|u| u.query_pairs().into_owned().collect())
            .unwrap_or_default();
        let get = |k: &str| pairs.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
        return (get("code"), get("state"));
    }
    (Some(value.into()), None)
}

// --- OpenAI Codex ------------------------------------------------------------

async fn codex(i: &Interaction, calls: &Calls<'_>) -> Result<Value> {
    let method = i
        .prompt(Prompt::select(
            "Sign in with",
            &[("browser", "Browser"), ("device_code", "Device code")],
        ))
        .await?;
    match method.as_str() {
        "browser" => codex_browser(i, calls).await,
        "device_code" => codex_device(i, calls).await,
        other => Err(format!("Unknown OpenAI Codex login method: {other}")),
    }
}

async fn codex_exchange(calls: &Calls<'_>, code: &str, verifier: &str, redirect: &str) -> Result<Value> {
    let json = calls
        .json(
            "OpenAI Codex",
            calls
                .client
                .post(format!("{}/oauth/token", calls.endpoints.openai))
                .form(&[
                    ("grant_type", "authorization_code"),
                    ("client_id", CODEX_CLIENT_ID),
                    ("code", code),
                    ("code_verifier", verifier),
                    ("redirect_uri", redirect),
                ]),
        )
        .await?;
    codex_credential(&json, "exchange")
}

async fn codex_browser(i: &Interaction, calls: &Calls<'_>) -> Result<Value> {
    let (verifier, challenge) = pkce();
    let state = random(16).iter().map(|b| format!("{b:02x}")).collect::<String>();
    let e = calls.endpoints;
    // Port 1455 is shared with the Codex CLI; when it's taken, the pasted
    // redirect URL is the only way back, as in Pi.
    let server = Callback::bind(e.openai_callback_port, CODEX_CALLBACK_PATH, "OpenAI", e.login_timeout)
        .await
        .ok();
    let port = server.as_ref().map_or(e.openai_callback_port, Callback::port);
    let redirect = format!("http://localhost:{port}{CODEX_CALLBACK_PATH}");
    let url = with_query(
        &format!("{}/oauth/authorize", e.openai),
        &[
            ("response_type", "code"),
            ("client_id", CODEX_CLIENT_ID),
            ("redirect_uri", &redirect),
            ("scope", CODEX_SCOPE),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
            ("state", &state),
            ("id_token_add_organizations", "true"),
            ("codex_cli_simplified_flow", "true"),
            ("originator", CODEX_ORIGINATOR),
        ],
    );
    i.notify(Event::AuthUrl { url, open: true });
    let got = callback_or_paste(
        i,
        server,
        callback::standard(Some(state.clone()), "OpenAI"),
        |code| async move { Ok(code) },
        Prompt::paste(&redirect),
    )
    .await?;
    let code = match got {
        Got::Callback(code) => Some(code),
        Got::Pasted(input) => {
            let (code, pasted_state) = parse_pasted(&input);
            if pasted_state.is_some_and(|s| s != state) {
                return Err("State mismatch".into());
            }
            code
        }
    };
    let code = code.filter(|c| !c.is_empty()).ok_or("Missing authorization code")?;
    codex_exchange(calls, &code, &verifier, &redirect).await
}

async fn codex_device(i: &Interaction, calls: &Calls<'_>) -> Result<Value> {
    let e = calls.endpoints;
    let (status, json) = calls
        .send(
            "OpenAI Codex",
            calls
                .client
                .post(format!("{}/api/accounts/deviceauth/usercode", e.openai))
                .json(&json!({ "client_id": CODEX_CLIENT_ID })),
        )
        .await?;
    if status == 404 {
        return Err("OpenAI Codex device code login is not enabled for this server. Use the browser login.".into());
    }
    if !(200..300).contains(&status) {
        return Err(format!("OpenAI Codex device code request failed ({status})"));
    }
    let interval = match json.get("interval") {
        Some(Value::String(s)) => s.trim().parse::<f64>().ok(),
        Some(v) => v.as_f64(),
        None => None,
    }
    .filter(|s| s.is_finite() && *s >= 0.0);
    let (Some(auth_id), Some(user_code), Some(interval)) = (
        str_field(&json, "device_auth_id"),
        str_field(&json, "user_code"),
        interval,
    ) else {
        return Err("Invalid OpenAI Codex device code response".into());
    };
    i.notify(Event::DeviceCode {
        user_code: user_code.clone(),
        verification_uri: format!("{}/codex/device", e.openai),
    });
    let (code, verifier) = device::poll(
        device::Options {
            interval: Some(interval),
            expires_in: Some(CODEX_DEVICE_TIMEOUT_S),
            wait_first: false,
            second: e.second,
        },
        || async {
            let (status, json) = calls
                .send(
                    "OpenAI Codex",
                    calls
                        .client
                        .post(format!("{}/api/accounts/deviceauth/token", e.openai))
                        .json(&json!({ "device_auth_id": auth_id, "user_code": user_code })),
                )
                .await?;
            if (200..300).contains(&status) {
                return Ok(match (str_field(&json, "authorization_code"), str_field(&json, "code_verifier")) {
                    (Some(code), Some(verifier)) => Poll::Complete((code, verifier)),
                    _ => Poll::Failed("Invalid OpenAI Codex device auth token response".into()),
                });
            }
            if status == 403 || status == 404 {
                return Ok(Poll::Pending);
            }
            let code = match json.get("error") {
                Some(Value::Object(error)) => error.get("code").and_then(Value::as_str),
                Some(error) => error.as_str(),
                None => None,
            };
            Ok(match code {
                Some("deviceauth_authorization_pending") => Poll::Pending,
                Some("slow_down") => Poll::SlowDown(None),
                _ => Poll::Failed(format!("OpenAI Codex device auth failed ({status})")),
            })
        },
    )
    .await?;
    codex_exchange(calls, &code, &verifier, &format!("{}/deviceauth/callback", e.openai)).await
}

// --- Sign in with ChatGPT (the OpenAI API) ----------------------------------

/// OpenAI names each installation by a stable `urn:uuid:<uuid>`.
pub(super) fn agent_host_id(device_id: Option<&str>) -> Result<String> {
    match device_id.and_then(|d| uuid::Uuid::parse_str(d).ok()) {
        Some(id) if device_id.is_some_and(|d| d.len() == 36) => Ok(format!("urn:uuid:{}", id.hyphenated())),
        _ => Err("Sign in with ChatGPT requires a device ID (UUID) for this installation".into()),
    }
}

/// Pi's `authorizationResultFromCallback`: the code, the matching state,
/// and the client id OpenAI issued for this login.
fn chatgpt_result(url: &reqwest::Url, expected: &str) -> Result<(String, String)> {
    let code = param(url, "code").filter(|c| !c.is_empty()).ok_or("Missing authorization code")?;
    let state = param(url, "state").filter(|s| !s.is_empty()).ok_or("Missing OAuth state")?;
    if state != expected {
        return Err("OAuth state mismatch".into());
    }
    let client_id = param(url, "client_id")
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .ok_or("OpenAI OAuth registration callback did not contain an issued client ID")?;
    Ok((code, client_id))
}

async fn chatgpt(i: &Interaction, calls: &Calls<'_>, device_id: Option<&str>) -> Result<Value> {
    let host = agent_host_id(device_id)?;
    let e = calls.endpoints;
    let (verifier, challenge) = pkce();
    let state = base64url(&random(32));
    let nonce = base64url(&random(32));
    let server = Callback::bind(e.openai_callback_port, CODEX_CALLBACK_PATH, "ChatGPT", e.login_timeout)
        .await
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::AddrInUse => format!(
                "Port {} is in use, probably by an unfinished login in another app or by the Codex CLI. \
                 Cancel that login and try again.",
                e.openai_callback_port
            ),
            _ => "Couldn't listen for the ChatGPT sign-in.".to_string(),
        })?;
    let redirect = server.redirect_uri("127.0.0.1");
    let url = with_query(
        &format!("{}/api/accounts/authorize", e.openai),
        &[
            ("client_id", CHATGPT_CLIENT_ID),
            ("agent_name_hint", CHATGPT_AGENT_NAME),
            ("ext_agent_host_id", &host),
            ("response_type", "code"),
            ("redirect_uri", &redirect),
            ("resource", CHATGPT_RESOURCE),
            ("scope", CHATGPT_SCOPE),
            ("state", &state),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
            ("nonce", &nonce),
        ],
    );
    i.notify(Event::AuthUrl { url, open: true });
    let expected = state.clone();
    let got = callback_or_paste(
        i,
        Some(server),
        move |url| {
            if let Some(error) = param(url, "error") {
                return Verdict::Fail(format!("ChatGPT authorization failed: {error}"));
            }
            match chatgpt_result(url, &expected) {
                Ok(result) => Verdict::Accept(result),
                Err(message) => Verdict::Ignore(400, message),
            }
        },
        |result| async move { Ok(result) },
        Prompt::paste(&redirect),
    )
    .await?;
    let (code, client_id) = match got {
        Got::Callback(result) => result,
        Got::Pasted(input) => {
            let url = reqwest::Url::parse(input.trim())
                .map_err(|_| "Paste the full callback URL from the browser")?;
            let expected = reqwest::Url::parse(&redirect).map_err(|e| e.to_string())?;
            if url.origin() != expected.origin() || url.path() != expected.path() {
                return Err(format!("The pasted callback URL must start with {redirect}"));
            }
            if let Some(error) = param(&url, "error") {
                return Err(format!("ChatGPT authorization failed: {error}"));
            }
            chatgpt_result(&url, &state)?
        }
    };
    i.notify(Event::Progress { message: "Finishing sign-in…".into() });
    let json = calls
        .json(
            "ChatGPT",
            calls
                .client
                .post(format!("{}/api/accounts/oauth/token", e.openai))
                .form(&[
                    ("grant_type", "authorization_code"),
                    ("client_id", client_id.as_str()),
                    ("code", code.as_str()),
                    ("code_verifier", verifier.as_str()),
                    ("redirect_uri", redirect.as_str()),
                    ("resource", CHATGPT_RESOURCE),
                ]),
        )
        .await?;
    // Pi doesn't use the ID token, but requires one.
    if str_field(&json, "id_token").is_none_or(|t| t.trim().is_empty()) {
        return Err("OpenAI OAuth token response did not contain an ID token".into());
    }
    chatgpt_credential(&json, &client_id)
}

// --- GitHub Copilot ----------------------------------------------------------

async fn copilot(i: &Interaction, calls: &Calls<'_>) -> Result<Value> {
    let e = calls.endpoints;
    let input = i
        .prompt(Prompt::text("GitHub Enterprise domain", "Leave empty for github.com"))
        .await?;
    let enterprise = normalize_domain(&input);
    if !input.trim().is_empty() && enterprise.is_none() {
        return Err("Invalid GitHub Enterprise URL/domain".into());
    }
    let domain = enterprise.as_deref().unwrap_or("github.com");
    let json = calls
        .json(
            "GitHub",
            calls
                .client
                .post(e.github_url(domain, "/login/device/code"))
                .header("User-Agent", COPILOT_USER_AGENT)
                .form(&[("client_id", COPILOT_CLIENT_ID), ("scope", COPILOT_SCOPE)]),
        )
        .await?;
    let interval = json.get("interval");
    let (Some(device_code), Some(user_code), Some(verification), Some(expires_in)) = (
        json.get("device_code").and_then(Value::as_str),
        json.get("user_code").and_then(Value::as_str),
        json.get("verification_uri").and_then(Value::as_str),
        json.get("expires_in").and_then(Value::as_f64),
    ) else {
        return Err("Invalid device code response fields".into());
    };
    if interval.is_some_and(|v| !v.is_number()) {
        return Err("Invalid device code response fields".into());
    }
    let verification = trusted_http_url(verification).ok_or("Untrusted verification_uri in device code response")?;
    i.notify(Event::DeviceCode {
        user_code: user_code.into(),
        verification_uri: verification,
    });
    let github = device::poll(
        device::Options {
            interval: interval.and_then(Value::as_f64),
            expires_in: Some(expires_in),
            wait_first: true,
            second: e.second,
        },
        || async {
            let raw = calls
                .json(
                    "GitHub",
                    calls
                        .client
                        .post(e.github_url(domain, "/login/oauth/access_token"))
                        .header("User-Agent", COPILOT_USER_AGENT)
                        .form(&[
                            ("client_id", COPILOT_CLIENT_ID),
                            ("device_code", device_code),
                            ("grant_type", DEVICE_GRANT),
                        ]),
                )
                .await?;
            if let Some(token) = raw.get("access_token").and_then(Value::as_str) {
                return Ok(Poll::Complete(token.to_string()));
            }
            Ok(match raw.get("error").and_then(Value::as_str) {
                Some("authorization_pending") => Poll::Pending,
                Some("slow_down") => Poll::SlowDown(raw.get("interval").and_then(Value::as_f64)),
                Some(_) => Poll::Failed(format!("Device flow failed{}", oauth_error(&raw))),
                None => Poll::Failed("Invalid device token response".into()),
            })
        },
    )
    .await?;
    let mut credential = pi_auth::copilot_token(calls, &github, enterprise.as_deref()).await?;
    let token = credential.get("access").and_then(Value::as_str).unwrap_or_default().to_string();
    let retry = Retry { max: 2, budget: Duration::from_secs(5) };
    let (mut available, policy) = pi_auth::copilot_models(calls, &token, enterprise.as_deref(), retry).await?;
    if !policy.is_empty() {
        i.notify(Event::Progress { message: "Turning on models…".into() });
        let base = e.copilot_api(&token, enterprise.as_deref());
        for id in policy {
            let url = format!("{base}/models/{id}/policy");
            let sent = pi_auth::copilot_send(
                calls,
                || {
                    let mut request = calls
                        .client
                        .post(&url)
                        .bearer_auth(&token)
                        .header("openai-intent", "chat-policy")
                        .header("x-interaction-type", "chat-policy")
                        .json(&json!({ "state": "enabled" }));
                    for (name, value) in pi_auth::COPILOT_HEADERS {
                        request = request.header(name, value);
                    }
                    request
                },
                retry,
            )
            .await;
            match sent {
                // Best effort, as in Pi: a failed policy update is skipped,
                // and an exhausted rate limit stops the batch.
                Err(_) => continue,
                Ok((429, _)) => break,
                Ok((status, _)) if (200..300).contains(&status) => {
                    if !available.contains(&id) {
                        available.push(id);
                    }
                }
                Ok(_) => {}
            }
        }
    }
    credential.insert("availableModelIds".into(), available.into());
    Ok(Value::Object(credential))
}

// --- Kimi Code ---------------------------------------------------------------

async fn kimi(i: &Interaction, calls: &Calls<'_>) -> Result<Value> {
    let e = calls.endpoints;
    let host = e.kimi_host();
    let (status, json) = calls
        .send(
            "Kimi",
            calls
                .client
                .post(format!("{host}/api/oauth/device_authorization"))
                .form(&[("client_id", KIMI_CLIENT_ID)]),
        )
        .await?;
    if !(200..300).contains(&status) {
        return Err(format!("Kimi Code device authorization failed ({status})"));
    }
    let uri = |k: &str| json.get(k).and_then(Value::as_str).and_then(trusted_http_url);
    let (Some(device_code), Some(user_code), Some(_), Some(complete)) = (
        json.get("device_code").and_then(Value::as_str),
        json.get("user_code").and_then(Value::as_str),
        uri("verification_uri"),
        uri("verification_uri_complete"),
    ) else {
        return Err("Invalid Kimi Code device authorization response".into());
    };
    let positive = |k: &str| json.get(k).and_then(Value::as_f64).filter(|s| s.is_finite() && *s > 0.0);
    i.notify(Event::DeviceCode {
        user_code: user_code.into(),
        verification_uri: complete,
    });
    device::poll(
        device::Options {
            interval: Some(positive("interval").unwrap_or(KIMI_DEFAULT_INTERVAL_S)),
            expires_in: Some(positive("expires_in").unwrap_or(KIMI_DEVICE_TIMEOUT_S)),
            wait_first: true,
            second: e.second,
        },
        || async {
            let (status, json) = calls
                .send(
                    "Kimi",
                    calls
                        .client
                        .post(format!("{host}/api/oauth/token"))
                        .form(&[
                            ("client_id", KIMI_CLIENT_ID),
                            ("device_code", device_code),
                            ("grant_type", DEVICE_GRANT),
                        ]),
                )
                .await?;
            if status >= 500 {
                return Ok(Poll::Failed(format!("Kimi Code device token request failed ({status})")));
            }
            if (200..300).contains(&status) && json.get("access_token").is_some_and(Value::is_string) {
                return Ok(match kimi_credential(&json, "poll") {
                    Ok(credential) => Poll::Complete(credential),
                    Err(message) => Poll::Failed(message),
                });
            }
            Ok(match json.get("error").and_then(Value::as_str) {
                Some("authorization_pending") => Poll::Pending,
                Some("slow_down") => Poll::SlowDown(
                    json.get("interval").and_then(Value::as_f64).filter(|s| *s > 0.0),
                ),
                Some("expired_token") => {
                    Poll::Failed("Kimi Code device authorization expired. Sign in again.".into())
                }
                Some("access_denied") => Poll::Failed("Kimi Code login was denied.".into()),
                _ => Poll::Failed(format!(
                    "Kimi Code device token request failed ({status}){}",
                    oauth_error(&json)
                )),
            })
        },
    )
    .await
}

// --- xAI ---------------------------------------------------------------------

/// xAI's verification URI is opened in the browser: https only.
fn xai_uri(raw: &str) -> Result<String> {
    reqwest::Url::parse(raw)
        .ok()
        .filter(|u| u.scheme() == "https")
        .map(|u| u.to_string())
        .ok_or_else(|| "Untrusted verification URI in xAI OAuth response".into())
}

async fn xai(i: &Interaction, calls: &Calls<'_>) -> Result<Value> {
    let e = calls.endpoints;
    let (status, body) = calls
        .send(
            "xAI",
            calls
                .client
                .post(format!("{}/oauth2/device/code", e.xai))
                .form(&[("client_id", XAI_CLIENT_ID), ("scope", XAI_SCOPE), ("referrer", XAI_REFERRER)]),
        )
        .await?;
    if !(200..300).contains(&status) {
        return Err(format!("xAI OAuth device authorization failed ({status}){}", oauth_error(&body)));
    }
    let invalid = |f: &str| format!("Invalid xAI OAuth response field: {f}");
    let required = |f: &str| str_field(&body, f).ok_or_else(|| invalid(f));
    let complete = match body.get("verification_uri_complete").and_then(Value::as_str) {
        Some(raw) if !raw.is_empty() => Some(xai_uri(raw)?),
        _ => None,
    };
    let device_code = required("device_code")?;
    let user_code = required("user_code")?;
    let uri = xai_uri(&required("verification_uri")?)?;
    let expires_in = body
        .get("expires_in")
        .and_then(Value::as_f64)
        .filter(|s| s.is_finite() && *s > 0.0)
        .ok_or_else(|| invalid("expires_in"))?;
    let interval = body.get("interval").and_then(Value::as_f64).filter(|s| s.is_finite() && *s > 0.0);
    i.notify(Event::DeviceCode {
        user_code,
        verification_uri: complete.unwrap_or(uri),
    });
    device::poll(
        device::Options {
            interval,
            expires_in: Some(expires_in),
            wait_first: true,
            second: e.second,
        },
        || async {
            let (status, body) = calls
                .send(
                    "xAI",
                    calls
                        .client
                        .post(format!("{}/oauth2/token", e.xai))
                        .form(&[
                            ("grant_type", DEVICE_GRANT),
                            ("client_id", XAI_CLIENT_ID),
                            ("device_code", device_code.as_str()),
                        ]),
                )
                .await?;
            if (200..300).contains(&status) {
                return xai_credential(&body, None).map(Poll::Complete);
            }
            Ok(match body.get("error").and_then(Value::as_str) {
                Some("authorization_pending") => Poll::Pending,
                Some("slow_down") => Poll::SlowDown(body.get("interval").and_then(Value::as_f64)),
                Some("access_denied" | "authorization_denied") => {
                    Poll::Failed("xAI device authorization was denied".into())
                }
                Some("expired_token") => Poll::Failed("xAI device code expired".into()),
                _ => Poll::Failed(format!(
                    "xAI OAuth device token polling failed ({status}){}",
                    oauth_error(&body)
                )),
            })
        },
    )
    .await
}

// --- Meta ----------------------------------------------------------------------

async fn meta(i: &Interaction, calls: &Calls<'_>) -> Result<Value> {
    let e = calls.endpoints;
    let (status, json) = calls
        .send(
            "Meta",
            calls
                .client
                .post(format!("{}/oidc/device/authorization/", e.meta_auth))
                .form(&[("client_id", META_CLIENT_ID)]),
        )
        .await?;
    if !(200..300).contains(&status) {
        return Err(format!("Meta device authorization failed ({status})"));
    }
    let uri = |k: &str| json.get(k).and_then(Value::as_str).and_then(trusted_http_url);
    let positive = |k: &str| json.get(k).and_then(Value::as_f64).filter(|s| s.is_finite() && *s > 0.0);
    let (Some(device_code), Some(user_code), Some(verification)) = (
        str_field(&json, "device_code"),
        str_field(&json, "user_code"),
        uri("verification_uri_complete").or_else(|| uri("verification_uri")),
    ) else {
        return Err("Invalid Meta device authorization response".into());
    };
    i.notify(Event::DeviceCode {
        user_code,
        verification_uri: verification,
    });
    let identity = device::poll(
        device::Options {
            interval: positive("interval"),
            expires_in: positive("expires_in"),
            wait_first: true,
            second: e.second,
        },
        || async {
            let (status, json) = calls
                .send(
                    "Meta",
                    calls
                        .client
                        .post(format!("{}/oidc/device/token/", e.meta_auth))
                        .form(&[
                            ("grant_type", DEVICE_GRANT),
                            ("device_code", device_code.as_str()),
                            ("client_id", META_CLIENT_ID),
                        ]),
                )
                .await?;
            if (200..300).contains(&status)
                && let Some(token) = str_field(&json, "access_token")
            {
                return Ok(Poll::Complete(token));
            }
            Ok(match json.get("error").and_then(Value::as_str) {
                Some("authorization_pending") => Poll::Pending,
                Some("slow_down") => Poll::SlowDown(
                    json.get("interval").and_then(Value::as_f64).filter(|s| s.is_finite() && *s > 0.0),
                ),
                Some("access_denied") => Poll::Failed("Meta login was denied.".into()),
                Some("expired_token") => {
                    Poll::Failed("Meta device authorization expired. Sign in again.".into())
                }
                _ => Poll::Failed(format!("Meta device token request failed ({status})")),
            })
        },
    )
    .await?;
    i.notify(Event::Progress { message: "Turning on Meta Model API access…".into() });
    pi_auth::meta_mint(calls, &identity).await
}

// --- OpenRouter --------------------------------------------------------------

async fn openrouter_exchange(calls: &Calls<'_>, code: &str, verifier: &str) -> Result<Value> {
    let (status, body) = calls
        .send(
            "OpenRouter",
            calls
                .client
                .post(format!("{}/api/v1/auth/keys", calls.endpoints.openrouter))
                .json(&json!({ "code": code, "code_verifier": verifier, "code_challenge_method": "S256" })),
        )
        .await?;
    if !(200..300).contains(&status) {
        let detail = ["error_description", "message", "error"]
            .iter()
            .find_map(|k| body.get(*k).and_then(Value::as_str))
            .or_else(|| body.pointer("/error/message").and_then(Value::as_str))
            .map(|d| format!(": {}", d.chars().take(200).collect::<String>()))
            .unwrap_or_default();
        return Err(format!("OpenRouter OAuth key exchange failed ({status}){detail}"));
    }
    let key = str_field(&body, "key").ok_or("OpenRouter OAuth response carries no \"key\"")?;
    Ok(json!({ "type": "oauth", "access": key, "refresh": "", "expires": OPENROUTER_EXPIRES }))
}

async fn openrouter(i: &Interaction, calls: &Calls<'_>) -> Result<Value> {
    let e = calls.endpoints;
    let (verifier, challenge) = pkce();
    // OpenRouter sends no `state`; the random path keeps stray requests
    // from completing the sign-in.
    let path = format!("/oauth/callback/{}", uuid::Uuid::new_v4());
    let server = Callback::bind(0, &path, "OpenRouter", e.login_timeout)
        .await
        .map_err(|_| "Couldn't listen for the OpenRouter sign-in.".to_string())?;
    let redirect = server.redirect_uri("127.0.0.1");
    let url = with_query(
        &format!("{}/auth", e.openrouter),
        &[
            ("callback_url", &redirect),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
        ],
    );
    i.notify(Event::AuthUrl { url, open: true });
    let got = callback_or_paste(
        i,
        Some(server),
        callback::standard(None, "OpenRouter"),
        |code| {
            let verifier = verifier.clone();
            async move { openrouter_exchange(calls, &code, &verifier).await }
        },
        Prompt::paste(&redirect),
    )
    .await?;
    match got {
        Got::Callback(credential) => Ok(credential),
        Got::Pasted(input) => {
            let value = input.trim();
            let code = match reqwest::Url::parse(value) {
                Ok(url) => param(&url, "code"),
                Err(_) => parse_pasted(value).0,
            }
            .filter(|c| !c.is_empty())
            .ok_or("Missing authorization code")?;
            i.notify(Event::Progress { message: "Finishing sign-in…".into() });
            openrouter_exchange(calls, &code, &verifier).await
        }
    }
}
