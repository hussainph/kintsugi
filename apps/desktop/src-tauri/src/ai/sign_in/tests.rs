//! Every sign-in against a local stand-in for the provider's servers (no
//! live calls): the requests Pi makes, the callback's state and PKCE
//! checks, device-code polling, the credential stored field for field, and
//! that nothing the webview sees holds a secret. `drift` checks the port
//! against Pi's own source (`auth.pi.json`).

use super::callback::{self, Callback};
use super::device::{self, Poll};
use super::flows;
use super::*;
use crate::ai::pi_auth::{self, Endpoints};
use base64::Engine;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const DEVICE: &str = "0b5e8f4c-2a1d-4e7b-9c3f-6d8a1b2c3e4f";

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap()
}

/// One request the stand-in saw.
#[derive(Debug, Clone)]
struct Seen {
    method: String,
    path: String,
    headers: axum::http::HeaderMap,
    body: String,
}

impl Seen {
    fn form(&self) -> Vec<(String, String)> {
        reqwest::Url::parse(&format!("http://x/?{}", self.body))
            .unwrap()
            .query_pairs()
            .into_owned()
            .collect()
    }
    fn field(&self, name: &str) -> Option<String> {
        if let Ok(json) = serde_json::from_str::<Value>(&self.body) {
            return json.get(name).and_then(Value::as_str).map(String::from);
        }
        self.form()
            .into_iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v)
    }
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|v| v.to_str().ok())
    }
}

type Log = Arc<Mutex<Vec<Seen>>>;

/// A stand-in for every server a login talks to. `reply` gets each request
/// and how many came to its path before it.
async fn server(
    reply: impl Fn(&Seen, usize) -> (u16, Value) + Send + Sync + 'static,
) -> (String, Log) {
    let log: Log = Arc::default();
    let seen = log.clone();
    let reply = Arc::new(reply);
    let app = axum::Router::new().fallback(
        move |method: axum::http::Method,
              uri: axum::http::Uri,
              headers: axum::http::HeaderMap,
              body: String| {
            let (seen, reply) = (seen.clone(), reply.clone());
            async move {
                let request = Seen {
                    method: method.to_string(),
                    path: uri.path().to_string(),
                    headers,
                    body,
                };
                let count = {
                    let mut seen = seen.lock().unwrap();
                    let n = seen.iter().filter(|s| s.path == request.path).count();
                    seen.push(request.clone());
                    n
                };
                let (status, body) = reply(&request, count);
                (
                    axum::http::StatusCode::from_u16(status).unwrap(),
                    axum::Json(body),
                )
            }
        },
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (base, log)
}

fn endpoints(base: &str) -> Endpoints {
    Endpoints {
        openai: base.into(),
        xai: base.into(),
        kimi: Some(base.into()),
        meta_auth: base.into(),
        meta_api: base.into(),
        openrouter: base.into(),
        github: Some(base.into()),
        openai_callback_port: 0,
        second: Duration::from_millis(5),
        login_timeout: Duration::from_secs(10),
    }
}

/// What the "browser" does with a sign-in page: the URL it is redirected
/// to, if any.
type Browser = Box<dyn Fn(&reqwest::Url) -> Vec<String> + Send>;

/// Drives a sign-in: answers its prompts in order (`paste:` answers a
/// paste prompt; other paste prompts stay open), follows its sign-in page
/// with `browser`, and returns the result with everything it showed.
async fn drive(
    provider: &'static str,
    endpoints: Endpoints,
    answers: &[&str],
    browser: Browser,
) -> (std::result::Result<Value, String>, Vec<Event>, Vec<u16>) {
    let (i, mut rx) = Interaction::new();
    let login = tokio::spawn(async move { login(provider, &i, &endpoints, Some(DEVICE)).await });
    let mut answers = answers.iter().map(|a| a.to_string());
    let (mut events, mut held, mut statuses) = (Vec::new(), Vec::new(), Vec::new());
    while let Some(message) = rx.recv().await {
        match message {
            Message::Event(event) => {
                if let Event::AuthUrl { url, .. } = &event {
                    let url = reqwest::Url::parse(url).unwrap();
                    for target in browser(&url) {
                        let target = target.replace("://localhost:", "://127.0.0.1:");
                        // The browser waits on the loopback server, which
                        // answers once the sign-in has finished with it.
                        let response = tokio::spawn(async move {
                            reqwest::get(target).await.map(|r| r.status().as_u16())
                        });
                        tokio::task::yield_now().await;
                        if let Ok(Ok(Ok(status))) =
                            tokio::time::timeout(Duration::from_millis(400), response).await
                        {
                            statuses.push(status);
                        }
                    }
                }
                events.push(event);
            }
            Message::Prompt(prompt, reply) => {
                let kind = prompt.kind;
                events.push(Event::Prompt { id: 0, prompt });
                match answers.next() {
                    Some(a) if kind == PromptKind::Paste => match a.strip_prefix("paste:") {
                        Some(pasted) => {
                            let _ = reply.send(pasted.into());
                        }
                        None => held.push(reply),
                    },
                    Some(a) => {
                        let _ = reply.send(a);
                    }
                    None => held.push(reply),
                }
            }
        }
    }
    (login.await.unwrap(), events, statuses)
}

fn no_browser() -> Browser {
    Box::new(|_| Vec::new())
}

fn query(url: &reqwest::Url, name: &str) -> String {
    url.query_pairs()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.into_owned())
        .unwrap_or_default()
}

fn keys(v: &Value) -> Vec<String> {
    let mut keys: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    keys
}

fn s256(verifier: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// Nothing the webview is sent may hold one of these.
fn assert_no_secrets(events: &[Event], secrets: &[&str]) {
    let shown = serde_json::to_string(events).unwrap();
    for secret in secrets {
        assert!(
            !shown.contains(secret),
            "{secret} reached the webview: {shown}"
        );
    }
}

fn auth_url(events: &[Event]) -> reqwest::Url {
    events
        .iter()
        .find_map(|e| match e {
            Event::AuthUrl { url, .. } => Some(reqwest::Url::parse(url).unwrap()),
            _ => None,
        })
        .expect("a sign-in page")
}

fn codex_jwt(n: &str) -> String {
    let claims =
        json!({ "https://api.openai.com/auth": { "chatgpt_account_id": "acct-1" }, "n": n });
    format!(
        "h.{}.s",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(claims.to_string())
    )
}

// --- The pieces ----------------------------------------------------------------

#[test]
fn device_polling_waits_slows_down_succeeds_and_expires() {
    let rt = runtime();
    rt.block_on(async {
        let second = Duration::from_millis(10);
        // pending, slow_down (server's interval), slow_down (+5s), success.
        let calls = Arc::new(Mutex::new(Vec::new()));
        let seen = calls.clone();
        let started = tokio::time::Instant::now();
        let value = device::poll(
            device::Options {
                interval: Some(1.0),
                expires_in: Some(60.0),
                wait_first: true,
                second,
            },
            || {
                let seen = seen.clone();
                async move {
                    let mut seen = seen.lock().unwrap();
                    seen.push(started.elapsed());
                    Ok(match seen.len() {
                        1 => Poll::Pending,
                        2 => Poll::SlowDown(Some(3.0)),
                        3 => Poll::SlowDown(None),
                        _ => Poll::Complete("done"),
                    })
                }
            },
        )
        .await
        .unwrap();
        assert_eq!(value, "done");
        let at = calls.lock().unwrap().clone();
        assert_eq!(at.len(), 4);
        // Waited one interval first; then 1s, 3s (asked), 3s + 5s.
        let gaps: Vec<u128> = [at[0], at[1] - at[0], at[2] - at[1], at[3] - at[2]]
            .iter()
            .map(|d| d.as_millis())
            .collect();
        assert!(
            gaps[0] >= 10 && gaps[1] >= 10 && gaps[2] >= 30 && gaps[3] >= 80,
            "{gaps:?}"
        );

        // Expiry: always pending gives up at the code's lifetime.
        let err = device::poll(
            device::Options {
                interval: Some(1.0),
                expires_in: Some(3.0),
                wait_first: false,
                second,
            },
            || async { Ok(Poll::<()>::Pending) },
        )
        .await
        .unwrap_err();
        assert_eq!(err, device::TIMED_OUT);
        let err = device::poll(
            device::Options {
                interval: None,
                expires_in: Some(2.0),
                wait_first: false,
                second,
            },
            || async { Ok(Poll::<()>::SlowDown(None)) },
        )
        .await
        .unwrap_err();
        assert_eq!(err, device::SLOW_DOWN_TIMED_OUT);
        // A denial ends it at once.
        let err = device::poll(
            device::Options {
                interval: Some(1.0),
                expires_in: None,
                wait_first: false,
                second,
            },
            || async { Ok(Poll::<()>::Failed("denied".into())) },
        )
        .await
        .unwrap_err();
        assert_eq!(err, "denied");
    });
}

#[test]
fn the_callback_server_listens_on_loopback_only_and_checks_path_and_state() {
    let rt = runtime();
    rt.block_on(async {
        let server = Callback::bind(0, "/auth/callback", "OpenAI", Duration::from_secs(5))
            .await
            .unwrap();
        let port = server.port();
        // 127.0.0.1 only: nothing answers on the machine's other addresses.
        assert!(
            server
                .redirect_uri("localhost")
                .starts_with("http://localhost:")
        );
        let wait = tokio::spawn(server.wait(
            callback::standard(Some("good".into()), "OpenAI"),
            |code| async move { Ok(code) },
        ));
        let get = |path: String| async move {
            reqwest::get(format!("http://127.0.0.1:{port}{path}"))
                .await
                .unwrap()
                .status()
                .as_u16()
        };
        assert_eq!(get("/elsewhere?code=x&state=good".into()).await, 404);
        assert_eq!(get("/auth/callback?code=x&state=forged".into()).await, 400);
        assert_eq!(get("/auth/callback?state=good".into()).await, 400);
        assert_eq!(
            get("/auth/callback?code=the-code&state=good".into()).await,
            200
        );
        assert_eq!(wait.await.unwrap().unwrap(), "the-code");
        // The listener is gone with the sign-in.
        assert!(
            reqwest::get(format!("http://127.0.0.1:{port}/auth/callback"))
                .await
                .is_err()
        );

        // The provider's refusal ends it; so does the timeout.
        let server = Callback::bind(0, "/cb", "OpenRouter", Duration::from_secs(5))
            .await
            .unwrap();
        let port = server.port();
        let wait = tokio::spawn(
            server.wait(callback::standard(None, "OpenRouter"), |code| async move {
                Ok(code)
            }),
        );
        assert_eq!(
            get_status(port, "/cb?error=access_denied&error_description=No").await,
            400
        );
        assert_eq!(
            wait.await.unwrap().unwrap_err(),
            "OpenRouter authorization failed: No"
        );
        let server = Callback::bind(0, "/cb", "OpenRouter", Duration::from_millis(50))
            .await
            .unwrap();
        let err = server
            .wait(
                callback::standard(None, "OpenRouter"),
                |c| async move { Ok(c) },
            )
            .await
            .unwrap_err();
        assert_eq!(err, "OpenRouter sign-in timed out");
    });
}

async fn get_status(port: u16, path: &str) -> u16 {
    reqwest::get(format!("http://127.0.0.1:{port}{path}"))
        .await
        .unwrap()
        .status()
        .as_u16()
}

#[test]
fn pasted_codes_are_read_as_pi_reads_them() {
    let p = |s| flows::parse_pasted(s);
    assert_eq!(
        p("http://localhost:1455/auth/callback?code=c&state=s"),
        (Some("c".into()), Some("s".into()))
    );
    assert_eq!(p("c#s"), (Some("c".into()), Some("s".into())));
    assert_eq!(p("code=c&state=s"), (Some("c".into()), Some("s".into())));
    assert_eq!(p(" c "), (Some("c".into()), None));
    assert_eq!(p(""), (None, None));
    let (verifier, challenge) = flows::pkce();
    assert_eq!(s256(&verifier), challenge);
    assert_eq!(verifier.len(), 43);
    assert!(flows::agent_host_id(Some("not-a-uuid")).is_err());
    assert_eq!(
        flows::agent_host_id(Some(DEVICE)).unwrap(),
        format!("urn:uuid:{DEVICE}")
    );
}

// --- Each login ------------------------------------------------------------------

#[test]
fn codex_browser_login_checks_state_and_pkce_and_stores_pis_fields() {
    let rt = runtime();
    rt.block_on(async {
        let (base, log) = server(|req, _| match req.path.as_str() {
            "/oauth/token" => (200, json!({ "access_token": codex_jwt("1"), "refresh_token": "rt-1", "expires_in": 3600, "id_token": "idt" })),
            _ => (404, json!({})),
        })
        .await;
        let browser: Browser = Box::new(|url| {
            let (redirect, state) = (query(url, "redirect_uri"), query(url, "state"));
            vec![format!("{redirect}?code=forged&state=wrong"), format!("{redirect}?code=the-code&state={state}")]
        });
        let (result, events, statuses) = drive("openai-codex", endpoints(&base), &["browser"], browser).await;
        let credential = result.unwrap();
        assert_eq!(statuses, [400, 200]);
        let url = auth_url(&events);
        assert_eq!(url.path(), "/oauth/authorize");
        assert_eq!(query(&url, "client_id"), pi_auth::CODEX_CLIENT_ID);
        assert_eq!(query(&url, "scope"), flows::CODEX_SCOPE);
        assert_eq!(query(&url, "code_challenge_method"), "S256");
        assert_eq!(query(&url, "originator"), "pi");
        assert!(query(&url, "redirect_uri").starts_with("http://localhost:"));
        let token = log.lock().unwrap().iter().find(|s| s.path == "/oauth/token").cloned().unwrap();
        assert_eq!(token.field("grant_type").as_deref(), Some("authorization_code"));
        assert_eq!(token.field("code").as_deref(), Some("the-code"));
        assert_eq!(s256(&token.field("code_verifier").unwrap()), query(&url, "code_challenge"));
        assert_eq!(token.field("redirect_uri").unwrap(), query(&url, "redirect_uri"));
        assert_eq!(keys(&credential), ["access", "accountId", "expires", "refresh", "type"]);
        assert_eq!(credential["accountId"], "acct-1");
        assert_eq!(credential["refresh"], "rt-1");
        assert_no_secrets(&events, &["rt-1", &codex_jwt("1"), &token.field("code_verifier").unwrap()]);
        assert_eq!(keys(&credential), keys(&mock_credential("openai-codex", None)));
    });
}

#[test]
fn codex_falls_back_to_a_pasted_url_and_refuses_a_pasted_state_mismatch() {
    let rt = runtime();
    rt.block_on(async {
        let (base, _log) = server(|_, _| {
            (
                200,
                json!({ "access_token": codex_jwt("2"), "refresh_token": "rt", "expires_in": 60 }),
            )
        })
        .await;
        let (result, ..) = drive(
            "openai-codex",
            endpoints(&base),
            &[
                "browser",
                "paste:http://localhost:1455/auth/callback?code=c&state=nope",
            ],
            no_browser(),
        )
        .await;
        assert_eq!(result.unwrap_err(), "State mismatch");
        let (result, ..) = drive(
            "openai-codex",
            endpoints(&base),
            &["browser", "paste:just-the-code"],
            no_browser(),
        )
        .await;
        assert_eq!(result.unwrap()["accountId"], "acct-1");
    });
}

#[test]
fn codex_device_code_login_polls_then_exchanges() {
    let rt = runtime();
    rt.block_on(async {
        let (base, log) = server(|req, n| match req.path.as_str() {
            "/api/accounts/deviceauth/usercode" => (200, json!({ "device_auth_id": "dev-1", "user_code": "ABCD-1234", "interval": "1" })),
            "/api/accounts/deviceauth/token" => match n {
                0 => (403, json!({})),
                1 => (400, json!({ "error": { "code": "deviceauth_authorization_pending" } })),
                2 => (400, json!({ "error": "slow_down" })),
                _ => (200, json!({ "authorization_code": "auth-code", "code_verifier": "server-verifier" })),
            },
            "/oauth/token" => (200, json!({ "access_token": codex_jwt("3"), "refresh_token": "rt-3", "expires_in": 3600 })),
            _ => (404, json!({})),
        })
        .await;
        let (result, events, _) = drive("openai-codex", endpoints(&base), &["device_code"], no_browser()).await;
        let credential = result.unwrap();
        assert!(events.contains(&Event::DeviceCode { user_code: "ABCD-1234".into(), verification_uri: format!("{base}/codex/device") }));
        let log = log.lock().unwrap();
        assert_eq!(log.iter().filter(|s| s.path == "/api/accounts/deviceauth/token").count(), 4);
        let token = log.iter().find(|s| s.path == "/oauth/token").unwrap();
        assert_eq!(token.field("code_verifier").as_deref(), Some("server-verifier"));
        assert_eq!(token.field("redirect_uri"), Some(format!("{base}/deviceauth/callback")));
        assert_eq!(keys(&credential), ["access", "accountId", "expires", "refresh", "type"]);
        assert_no_secrets(&events, &["auth-code", "server-verifier", "rt-3"]);
    });
}

#[test]
fn sign_in_with_chatgpt_needs_the_issued_client_and_the_direct_scope() {
    let rt = runtime();
    rt.block_on(async {
        let (base, log) = server(|req, _| match req.path.as_str() {
            "/api/accounts/oauth/token" => (200, json!({
                "access_token": "chatgpt-access", "refresh_token": "chatgpt-refresh", "id_token": "idt",
                "expires_in": 3600, "scope": "openid offline_access chatgpt.tokens.use.direct",
            })),
            _ => (404, json!({})),
        })
        .await;
        let browser: Browser = Box::new(|url| {
            let (redirect, state) = (query(url, "redirect_uri"), query(url, "state"));
            vec![
                // No issued client: not the callback; keep waiting.
                format!("{redirect}?code=c&state={state}"),
                format!("{redirect}?code=c&state=forged&client_id=app_x"),
                format!("{redirect}?code=c&state={state}&client_id=app_issued"),
            ]
        });
        let (result, events, statuses) = drive("openai", endpoints(&base), &[], browser).await;
        let credential = result.unwrap();
        assert_eq!(statuses, [400, 400, 200]);
        let url = auth_url(&events);
        assert_eq!(url.path(), "/api/accounts/authorize");
        assert_eq!(query(&url, "client_id"), "dynamic_agent_client");
        assert_eq!(query(&url, "ext_agent_host_id"), format!("urn:uuid:{DEVICE}"));
        assert_eq!(query(&url, "agent_name_hint"), "Kintsugi");
        assert_eq!(query(&url, "resource"), "https://api.openai.com/v1");
        assert_eq!(query(&url, "scope"), flows::CHATGPT_SCOPE);
        assert!(query(&url, "redirect_uri").starts_with("http://127.0.0.1:"));
        assert!(!query(&url, "nonce").is_empty());
        let token = log.lock().unwrap().last().cloned().unwrap();
        assert_eq!(token.field("client_id").as_deref(), Some("app_issued"));
        assert_eq!(token.field("resource").as_deref(), Some("https://api.openai.com/v1"));
        assert_eq!(s256(&token.field("code_verifier").unwrap()), query(&url, "code_challenge"));
        assert_eq!(keys(&credential), ["access", "clientId", "expires", "refresh", "scopes", "type"]);
        assert_eq!(credential["clientId"], "app_issued");
        assert_eq!(credential["scopes"], json!(["openid", "offline_access", "chatgpt.tokens.use.direct"]));
        assert_eq!(keys(&credential), keys(&mock_credential("openai", None)));
        assert_no_secrets(&events, &["chatgpt-access", "chatgpt-refresh"]);
    });
    // Without the direct-token scope the grant is refused.
    rt.block_on(async {
        let (base, _) = server(|_, _| (200, json!({ "access_token": "a", "refresh_token": "r", "id_token": "i", "expires_in": 60, "scope": "openid" }))).await;
        let browser: Browser = Box::new(|url| vec![format!("{}?code=c&state={}&client_id=x", query(url, "redirect_uri"), query(url, "state"))]);
        let (result, ..) = drive("openai", endpoints(&base), &[], browser).await;
        assert!(result.unwrap_err().contains("chatgpt.tokens.use.direct"));
    });
}

#[test]
fn copilot_asks_for_an_enterprise_polls_github_and_stores_its_models() {
    let rt = runtime();
    let known = crate::ai::catalog::models("github-copilot")
        .next()
        .unwrap()
        .id
        .clone();
    let model = known.clone();
    rt.block_on(async move {
        let (base, log) = server(move |req, n| match req.path.as_str() {
            "/login/device/code" => (200, json!({ "device_code": "dc", "user_code": "WXYZ-0000", "verification_uri": "https://github.com/login/device", "interval": 1, "expires_in": 900 })),
            "/login/oauth/access_token" => match n {
                0 => (200, json!({ "error": "authorization_pending" })),
                1 => (200, json!({ "error": "slow_down", "interval": 2 })),
                _ => (200, json!({ "access_token": "gho_github" })),
            },
            "/copilot_internal/v2/token" => (200, json!({ "token": "tid=1;proxy-ep=proxy.individual.githubcopilot.com", "expires_at": 4_000_000_000u64 })),
            "/models" => (200, json!({ "data": [
                { "id": model, "model_picker_enabled": true, "policy": { "state": "unconfigured" } },
                { "id": "gpt-on", "model_picker_enabled": true, "policy": { "state": "enabled" } },
                { "id": "gpt-off", "model_picker_enabled": true, "policy": { "state": "disabled" } },
                { "id": "no-tools", "model_picker_enabled": true, "capabilities": { "supports": { "tool_calls": false } } },
            ] })),
            path if path.ends_with("/policy") => (200, json!({})),
            _ => (404, json!({})),
        })
        .await;
        let (result, events, _) = drive("github-copilot", endpoints(&base), &["https://acme.ghe.com/"], no_browser()).await;
        let credential = result.unwrap();
        assert!(matches!(&events[0], Event::Prompt { prompt, .. } if prompt.kind == PromptKind::Text));
        assert!(events.contains(&Event::DeviceCode { user_code: "WXYZ-0000".into(), verification_uri: "https://github.com/login/device".into() }));
        assert_eq!(keys(&credential), ["access", "availableModelIds", "enterpriseUrl", "expires", "refresh", "type"]);
        assert_eq!(credential["enterpriseUrl"], "acme.ghe.com");
        assert_eq!(credential["refresh"], "gho_github");
        assert_eq!(credential["expires"], 4_000_000_000u64 * 1000 - 5 * 60 * 1000);
        assert_eq!(credential["availableModelIds"], json!([known, "gpt-on"]));
        let log = log.lock().unwrap();
        let device = log.iter().find(|s| s.path == "/login/device/code").unwrap();
        assert_eq!(device.field("client_id").as_deref(), Some(flows::COPILOT_CLIENT_ID));
        assert_eq!(device.field("scope").as_deref(), Some("read:user"));
        let exchange = log.iter().find(|s| s.path == "/copilot_internal/v2/token").unwrap();
        assert_eq!(exchange.header("authorization"), Some("Bearer gho_github"));
        assert_eq!(exchange.header("editor-version"), Some("vscode/1.107.0"));
        let policy = log.iter().find(|s| s.path.ends_with("/policy")).unwrap();
        assert_eq!(policy.path, format!("/models/{known}/policy"));
        assert_eq!(policy.header("openai-intent"), Some("chat-policy"));
        assert_eq!(log.iter().filter(|s| s.path == "/login/oauth/access_token").count(), 3);
        assert_no_secrets(&events, &["gho_github", "tid=1"]);
        assert_eq!(keys(&credential), keys(&mock_credential("github-copilot", Some("acme.ghe.com"))));
    });
}

#[test]
fn kimi_xai_and_meta_device_logins_store_pis_fields() {
    let rt = runtime();
    rt.block_on(async {
        let (base, log) = server(|req, n| match req.path.as_str() {
            // Kimi
            "/api/oauth/device_authorization" => (200, json!({ "device_code": "k-dc", "user_code": "KIMI-1", "verification_uri": "https://www.kimi.com/device", "verification_uri_complete": "https://www.kimi.com/device?code=KIMI-1", "interval": 1, "expires_in": 600 })),
            "/api/oauth/token" if n == 0 => (400, json!({ "error": "authorization_pending" })),
            "/api/oauth/token" => (200, json!({ "access_token": "kimi-access", "refresh_token": "kimi-refresh", "expires_in": 3600 })),
            // xAI
            "/oauth2/device/code" => (200, json!({ "device_code": "x-dc", "user_code": "XAI-1", "verification_uri": "https://accounts.x.ai/device", "expires_in": 600, "interval": 1 })),
            "/oauth2/token" => match n {
                0 => (400, json!({ "error": "authorization_pending" })),
                1 => (400, json!({ "error": "slow_down" })),
                _ => (200, json!({ "access_token": "xai-access", "refresh_token": "xai-refresh", "expires_in": 3600 })),
            },
            // Meta
            "/oidc/device/authorization/" => (200, json!({ "device_code": "m-dc", "user_code": "META-1", "verification_uri_complete": "https://meta.com/device?c=META-1" })),
            "/oidc/device/token/" => (200, json!({ "access_token": "meta-identity" })),
            "/muse-code/key" => (200, json!({ "api_key": "meta-key" })),
            _ => (404, json!({})),
        })
        .await;
        let e = endpoints(&base);

        let (kimi, events, _) = drive("kimi-coding", e.clone(), &[], no_browser()).await;
        let kimi = kimi.unwrap();
        assert!(events.contains(&Event::DeviceCode { user_code: "KIMI-1".into(), verification_uri: "https://www.kimi.com/device?code=KIMI-1".into() }));
        assert_eq!(keys(&kimi), ["access", "expires", "refresh", "type"]);
        assert_eq!(kimi["refresh"], "kimi-refresh");
        assert_no_secrets(&events, &["kimi-access", "kimi-refresh", "k-dc"]);

        let (xai, events, _) = drive("xai", e.clone(), &[], no_browser()).await;
        let xai = xai.unwrap();
        assert_eq!(keys(&xai), ["access", "expires", "refresh", "type"]);
        let now = pi_auth::now_ms();
        let expires = xai["expires"].as_u64().unwrap();
        assert!(expires <= now + 3600 * 1000 - 5 * 60 * 1000 && expires > now + 3000 * 1000);
        assert_no_secrets(&events, &["xai-access", "xai-refresh"]);

        let (meta, events, _) = drive("meta", e.clone(), &[], no_browser()).await;
        let meta = meta.unwrap();
        assert_eq!(keys(&meta), ["access", "expires", "refresh", "type"]);
        assert_eq!((meta["access"].as_str(), meta["refresh"].as_str()), (Some("meta-key"), Some("meta-identity")));
        assert!(events.iter().any(|e| matches!(e, Event::Progress { .. })));
        assert_no_secrets(&events, &["meta-key", "meta-identity"]);

        for (id, credential) in [("kimi-coding", &kimi), ("xai", &xai), ("meta", &meta)] {
            assert_eq!(keys(credential), keys(&mock_credential(id, None)), "{id}");
        }
        let log = log.lock().unwrap();
        let x = log.iter().find(|s| s.path == "/oauth2/device/code").unwrap();
        assert_eq!(x.field("scope").as_deref(), Some(flows::XAI_SCOPE));
        assert_eq!(x.field("referrer").as_deref(), Some("pi"));
        let mint = log.iter().find(|s| s.path == "/muse-code/key").unwrap();
        assert_eq!(mint.method, "POST");
        assert_eq!(mint.header("authorization"), Some("Bearer meta-identity"));
        assert_eq!(mint.header("x-api-version"), Some("1.0.0"));
        let m = log.iter().find(|s| s.path == "/oidc/device/authorization/").unwrap();
        assert_eq!(m.field("client_id").as_deref(), Some(flows::META_CLIENT_ID));
    });
}

#[test]
fn device_logins_report_denial_and_expiry() {
    let rt = runtime();
    rt.block_on(async {
        let (base, _) = server(|req, _| match req.path.as_str() {
            "/oauth2/device/code" => (200, json!({ "device_code": "d", "user_code": "u", "verification_uri": "https://x.ai/d", "expires_in": 3, "interval": 1 })),
            "/oauth2/token" => (400, json!({ "error": "authorization_pending" })),
            "/api/oauth/device_authorization" => (200, json!({ "device_code": "d", "user_code": "u", "verification_uri": "https://k/d", "verification_uri_complete": "https://k/d?u" })),
            "/api/oauth/token" => (400, json!({ "error": "access_denied" })),
            _ => (404, json!({})),
        })
        .await;
        let (xai, ..) = drive("xai", endpoints(&base), &[], no_browser()).await;
        assert_eq!(xai.unwrap_err(), device::TIMED_OUT);
        let (kimi, ..) = drive("kimi-coding", endpoints(&base), &[], no_browser()).await;
        assert_eq!(kimi.unwrap_err(), "Kimi Code login was denied.");
        // An untrusted verification page is refused before it is shown.
        let (base, _) = server(|_, _| (200, json!({ "device_code": "d", "user_code": "u", "verification_uri": "javascript:alert(1)", "expires_in": 9 }))).await;
        let (xai, events, _) = drive("xai", endpoints(&base), &[], no_browser()).await;
        assert!(xai.unwrap_err().contains("Untrusted"));
        assert!(events.is_empty());
    });
}

#[test]
fn openrouter_exchanges_its_callback_for_a_key_that_never_expires() {
    let rt = runtime();
    rt.block_on(async {
        let (base, log) = server(|req, _| match req.path.as_str() {
            "/api/v1/auth/keys" => (200, json!({ "key": "sk-or-v1-secret" })),
            _ => (404, json!({})),
        })
        .await;
        let browser: Browser = Box::new(|url| {
            let callback = query(url, "callback_url");
            vec![format!("{}/other?code=x", callback.rsplit_once('/').unwrap().0), format!("{callback}?code=or-code")]
        });
        let (result, events, statuses) = drive("openrouter", endpoints(&base), &[], browser).await;
        let credential = result.unwrap();
        assert_eq!(statuses, [404, 200]);
        let url = auth_url(&events);
        let callback = query(&url, "callback_url");
        assert!(callback.starts_with("http://127.0.0.1:") && callback.contains("/oauth/callback/"));
        assert_eq!(credential, json!({ "type": "oauth", "access": "sk-or-v1-secret", "refresh": "", "expires": 9007199254740991u64 }));
        let exchange = log.lock().unwrap().last().cloned().unwrap();
        assert_eq!(exchange.field("code").as_deref(), Some("or-code"));
        assert_eq!(exchange.field("code_challenge_method").as_deref(), Some("S256"));
        assert_eq!(s256(&exchange.field("code_verifier").unwrap()), query(&url, "code_challenge"));
        assert_no_secrets(&events, &["sk-or-v1-secret"]);
        assert_eq!(keys(&credential), keys(&mock_credential("openrouter", None)));
        // Pasted instead.
        let (pasted, ..) = drive("openrouter", endpoints(&base), &["paste:http://127.0.0.1:1/oauth/callback/x?code=c2"], no_browser()).await;
        assert_eq!(pasted.unwrap()["access"], "sk-or-v1-secret");
    });
}

#[test]
fn claude_logins_and_providers_without_one_are_refused() {
    let rt = runtime();
    rt.block_on(async {
        let (result, ..) = drive("anthropic", Endpoints::default(), &[], no_browser()).await;
        assert_eq!(result.unwrap_err(), CLAUDE_REFUSED);
        let (result, ..) = drive("groq", Endpoints::default(), &[], no_browser()).await;
        assert!(result.unwrap_err().contains("add a key"));
    });
    assert!(!can_sign_in("anthropic") && can_sign_in("openai-codex"));
}

#[test]
fn the_headless_mock_has_each_flows_shape_and_saves_pis_fields() {
    let rt = runtime();
    rt.block_on(async {
        // SAFETY: tests in this binary don't read this variable elsewhere.
        unsafe { std::env::set_var("KINTSUGI_HEADLESS_SIGN_IN_MS", "10") };
        for (provider, answers, kind) in [
            ("xai", vec![], "device"),
            ("openai-codex", vec!["device_code"], "device"),
            (
                "openai-codex",
                vec!["browser", "paste:http://x/?code=c"],
                "browser",
            ),
            ("openrouter", vec!["paste:http://x/?code=c"], "browser"),
            ("github-copilot", vec![""], "device"),
        ] {
            let (i, mut rx) = Interaction::new();
            let run = tokio::spawn(async move { mock(provider, &i).await });
            let mut answers = answers.into_iter();
            let mut shown = Vec::new();
            while let Some(message) = rx.recv().await {
                match message {
                    Message::Event(e) => shown.push(e),
                    Message::Prompt(p, reply) => {
                        let a = answers.next().unwrap();
                        let _ = reply.send(a.strip_prefix("paste:").unwrap_or(a).into());
                        shown.push(Event::Prompt { id: 0, prompt: p });
                    }
                }
            }
            let credential = run.await.unwrap().unwrap();
            assert_eq!(
                keys(&credential),
                keys(&mock_credential(provider, None)),
                "{provider}"
            );
            let device = shown.iter().any(|e| matches!(e, Event::DeviceCode { .. }));
            let page = shown
                .iter()
                .any(|e| matches!(e, Event::AuthUrl { open: false, .. }));
            assert_eq!(
                (device, page),
                (kind == "device", kind == "browser"),
                "{provider}"
            );
        }
    });
}

#[test]
fn events_serialize_for_the_webview() {
    let prompt = Event::Prompt {
        id: 3,
        prompt: Prompt::select("Sign in with", &[("browser", "Browser")]),
    };
    assert_eq!(
        serde_json::to_value(prompt).unwrap(),
        json!({ "type": "prompt", "id": 3, "kind": "select", "message": "Sign in with", "options": [{ "id": "browser", "label": "Browser" }] })
    );
    assert_eq!(
        serde_json::to_value(Event::DeviceCode {
            user_code: "A".into(),
            verification_uri: "https://x".into()
        })
        .unwrap(),
        json!({ "type": "device_code", "userCode": "A", "verificationUri": "https://x" })
    );
    assert_eq!(
        serde_json::to_value(Event::Done).unwrap(),
        json!({ "type": "done" })
    );
}

// --- Drift against Pi's source -----------------------------------------------------

/// Pi's sign-ins and API keys at the pinned version (`pnpm gen:models`).
const AUTH_PI: &str = include_str!("../auth.pi.json");

/// Pi's login modules Kintsugi doesn't port, and why.
const NOT_PORTED: [(&str, &str); 2] = [
    (
        "anthropic",
        "Claude subscription logins are refused; Anthropic is API keys only",
    ),
    (
        "radius",
        "Pi's own Radius gateway, which Kintsugi doesn't speak",
    ),
];

/// Pi's helper modules: no constants of their own to port.
const HELPERS: [&str; 5] = [
    "callback-server",
    "device-code",
    "load",
    "pkce",
    "trusted-url",
];

/// Pi constants Kintsugi deliberately differs on: (module, name, Pi's
/// value, why). Pi's value is still checked, so a change shows up.
fn deviations() -> Vec<(&'static str, &'static str, Value, &'static str)> {
    vec![
        (
            "openai-chatgpt",
            "AGENT_NAME_HINT",
            json!("Pi"),
            "the consent page names Kintsugi",
        ),
        (
            "openai-chatgpt",
            "CALLBACK_HOST",
            json!({ "source": "getProviderEnvValue(\"PI_OAUTH_CALLBACK_HOST\") || \"127.0.0.1\"" }),
            "always 127.0.0.1",
        ),
        (
            "openai-chatgpt",
            "UUID_PATTERN",
            json!({ "source": "/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i" }),
            "checked with the uuid crate",
        ),
        (
            "github-copilot",
            "decode",
            json!({ "source": "(s) => atob(s)" }),
            "the client id is kept decoded",
        ),
        (
            "kimi-coding",
            "REQUEST_TIMEOUT_MS",
            json!(30000),
            "every request is capped at 15s",
        ),
        (
            "kimi-coding",
            "REFRESH_MAX_RETRIES",
            json!(3),
            "a refresh holds the lock, so it's tried once within 15s",
        ),
        (
            "meta",
            "REQUEST_TIMEOUT_MS",
            json!(30000),
            "every request is capped at 15s",
        ),
        (
            "openrouter",
            "TOKEN_EXCHANGE_TIMEOUT_MS",
            json!(30000),
            "every request is capped at 15s",
        ),
        (
            "device-code",
            "CANCEL_MESSAGE",
            json!("Login cancelled"),
            "Kintsugi's own wording",
        ),
        (
            "device-code",
            "SLOW_DOWN_TIMEOUT_MESSAGE",
            json!(
                "Device flow timed out after one or more slow_down responses. This is often caused by clock drift in WSL or VM environments. Please sync or restart the VM clock and try again."
            ),
            "shortened",
        ),
    ]
}

/// Every other constant of Pi's login modules, as Kintsugi has it.
fn ported() -> Vec<(&'static str, &'static str, Value)> {
    let e = Endpoints::default();
    let o = &e.openai;
    let port = e.openai_callback_port;
    vec![
        ("openai-codex", "CLIENT_ID", json!(pi_auth::CODEX_CLIENT_ID)),
        ("openai-codex", "AUTH_BASE_URL", json!(o)),
        (
            "openai-codex",
            "AUTHORIZE_URL",
            json!(format!("{o}/oauth/authorize")),
        ),
        (
            "openai-codex",
            "TOKEN_URL",
            json!(format!("{o}/oauth/token")),
        ),
        (
            "openai-codex",
            "REDIRECT_URI",
            json!(format!(
                "http://localhost:{port}{}",
                flows::CODEX_CALLBACK_PATH
            )),
        ),
        (
            "openai-codex",
            "DEVICE_USER_CODE_URL",
            json!(format!("{o}/api/accounts/deviceauth/usercode")),
        ),
        (
            "openai-codex",
            "DEVICE_TOKEN_URL",
            json!(format!("{o}/api/accounts/deviceauth/token")),
        ),
        (
            "openai-codex",
            "DEVICE_VERIFICATION_URI",
            json!(format!("{o}/codex/device")),
        ),
        (
            "openai-codex",
            "DEVICE_REDIRECT_URI",
            json!(format!("{o}/deviceauth/callback")),
        ),
        (
            "openai-codex",
            "DEVICE_CODE_TIMEOUT_SECONDS",
            json!(flows::CODEX_DEVICE_TIMEOUT_S as u64),
        ),
        (
            "openai-codex",
            "OPENAI_CODEX_BROWSER_LOGIN_METHOD",
            json!("browser"),
        ),
        (
            "openai-codex",
            "OPENAI_CODEX_DEVICE_CODE_LOGIN_METHOD",
            json!("device_code"),
        ),
        ("openai-codex", "SCOPE", json!(flows::CODEX_SCOPE)),
        (
            "openai-codex",
            "JWT_CLAIM_PATH",
            json!(pi_auth::CODEX_JWT_CLAIM),
        ),
        (
            "openai-chatgpt",
            "DYNAMIC_CLIENT_ID",
            json!(flows::CHATGPT_CLIENT_ID),
        ),
        (
            "openai-chatgpt",
            "AUTHORIZE_URL",
            json!(format!("{o}/api/accounts/authorize")),
        ),
        (
            "openai-chatgpt",
            "TOKEN_URL",
            json!(format!("{o}/api/accounts/oauth/token")),
        ),
        (
            "openai-chatgpt",
            "RESOURCE",
            json!(pi_auth::CHATGPT_RESOURCE),
        ),
        ("openai-chatgpt", "CALLBACK_PORT", json!(port)),
        (
            "openai-chatgpt",
            "CALLBACK_PATH",
            json!(flows::CODEX_CALLBACK_PATH),
        ),
        (
            "openai-chatgpt",
            "REDIRECT_URI",
            json!(format!(
                "http://127.0.0.1:{port}{}",
                flows::CODEX_CALLBACK_PATH
            )),
        ),
        (
            "openai-chatgpt",
            "DIRECT_TOKEN_SCOPE",
            json!(pi_auth::CHATGPT_DIRECT_SCOPE),
        ),
        ("openai-chatgpt", "SCOPE", json!(flows::CHATGPT_SCOPE)),
        (
            "openai-chatgpt",
            "EXPIRY_MARGIN_MS",
            json!(pi_auth::CHATGPT_EXPIRY_MARGIN_MS),
        ),
        (
            "github-copilot",
            "CLIENT_ID",
            json!(flows::COPILOT_CLIENT_ID),
        ),
        (
            "github-copilot",
            "COPILOT_API_VERSION",
            json!(pi_auth::COPILOT_API_VERSION),
        ),
        ("kimi-coding", "CLIENT_ID", json!(pi_auth::KIMI_CLIENT_ID)),
        (
            "kimi-coding",
            "DEFAULT_OAUTH_HOST",
            json!(pi_auth::KIMI_HOST),
        ),
        (
            "kimi-coding",
            "DEVICE_CODE_TIMEOUT_SECONDS",
            json!(flows::KIMI_DEVICE_TIMEOUT_S as u64),
        ),
        (
            "kimi-coding",
            "DEFAULT_POLL_INTERVAL_SECONDS",
            json!(flows::KIMI_DEFAULT_INTERVAL_S as u64),
        ),
        ("meta", "CLIENT_ID", json!(flows::META_CLIENT_ID)),
        ("meta", "AUTH_HOST", json!(e.meta_auth)),
        (
            "meta",
            "DEVICE_AUTHORIZATION_URL",
            json!(format!("{}/oidc/device/authorization/", e.meta_auth)),
        ),
        (
            "meta",
            "DEVICE_TOKEN_URL",
            json!(format!("{}/oidc/device/token/", e.meta_auth)),
        ),
        (
            "meta",
            "API_KEY_MINT_URL",
            json!(format!("{}/muse-code/key", e.meta_api)),
        ),
        (
            "meta",
            "API_KEY_LIFETIME_MS",
            json!(pi_auth::META_KEY_LIFETIME_MS),
        ),
        (
            "openrouter",
            "AUTHORIZE_URL",
            json!(format!("{}/auth", e.openrouter)),
        ),
        (
            "openrouter",
            "TOKEN_URL",
            json!(format!("{}/api/v1/auth/keys", e.openrouter)),
        ),
        (
            "openrouter",
            "LOGIN_TIMEOUT_MS",
            json!(e.login_timeout.as_millis() as u64),
        ),
        ("xai", "XAI_CLIENT_ID", json!(pi_auth::XAI_CLIENT_ID)),
        ("xai", "XAI_SCOPE", json!(flows::XAI_SCOPE)),
        (
            "xai",
            "XAI_DEVICE_CODE_URL",
            json!(format!("{}/oauth2/device/code", e.xai)),
        ),
        (
            "xai",
            "XAI_TOKEN_URL",
            json!(format!("{}/oauth2/token", e.xai)),
        ),
        (
            "xai",
            "REFRESH_SKEW_MS",
            json!(pi_auth::MINIMUM_VALIDITY_MS),
        ),
        (
            "xai",
            "DEFAULT_TOKEN_LIFETIME_SECONDS",
            json!(pi_auth::XAI_DEFAULT_LIFETIME_S),
        ),
        ("device-code", "TIMEOUT_MESSAGE", json!(device::TIMED_OUT)),
        ("device-code", "MINIMUM_INTERVAL_MS", json!(1000)),
        (
            "device-code",
            "DEFAULT_POLL_INTERVAL_SECONDS",
            json!(device::DEFAULT_INTERVAL_S as u64),
        ),
        (
            "device-code",
            "SLOW_DOWN_INTERVAL_INCREMENT_MS",
            json!(device::SLOW_DOWN_INCREMENT_S * 1000),
        ),
    ]
}

/// Literals Kintsugi sends as Pi does, which Pi's module must still have.
const LITERALS: &[(&str, &str)] = &[
    ("openai-codex", "id_token_add_organizations"),
    ("openai-codex", "codex_cli_simplified_flow"),
    ("openai-codex", "originator"),
    ("openai-codex", "pi"),
    ("openai-codex", "deviceauth_authorization_pending"),
    ("openai-codex", "slow_down"),
    ("openai-codex", "S256"),
    ("openai-chatgpt", "client_id"),
    ("openai-chatgpt", "urn:uuid:${deviceId.toLowerCase()}"),
    ("github-copilot", "read:user"),
    ("github-copilot", "https://${domain}/login/device/code"),
    (
        "github-copilot",
        "https://${domain}/login/oauth/access_token",
    ),
    (
        "github-copilot",
        "https://api.${domain}/copilot_internal/v2/token",
    ),
    ("github-copilot", "https://api.individual.githubcopilot.com"),
    ("github-copilot", "https://copilot-api.${enterpriseDomain}"),
    ("github-copilot", "${baseUrl}/models"),
    ("github-copilot", "${baseUrl}/models/${modelId}/policy"),
    ("github-copilot", "GitHubCopilotChat/0.35.0"),
    ("github-copilot", "vscode/1.107.0"),
    ("github-copilot", "copilot-chat/0.35.0"),
    ("github-copilot", "vscode-chat"),
    ("github-copilot", "chat-policy"),
    ("github-copilot", "X-GitHub-Api-Version"),
    ("github-copilot", "unconfigured"),
    ("kimi-coding", "${oauthHost}/api/oauth/device_authorization"),
    ("kimi-coding", "${oauthHost}/api/oauth/token"),
    ("kimi-coding", "KIMI_CODE_OAUTH_HOST"),
    ("kimi-coding", "KIMI_OAUTH_HOST"),
    (
        "kimi-coding",
        "urn:ietf:params:oauth:grant-type:device_code",
    ),
    ("xai", "pi"),
    ("xai", "authorization_denied"),
    ("meta", "x-api-version"),
    ("meta", "1.0.0"),
    ("openrouter", "/oauth/callback/${crypto.randomUUID()}"),
    ("openrouter", "S256"),
];

/// The fields of every form, JSON body and query Pi's login modules
/// build, in order, as Kintsugi's requests send them.
const BODIES: &[(&str, &[&[&str]])] = &[
    (
        "openai-codex",
        &[
            &[
                "grant_type",
                "client_id",
                "code",
                "code_verifier",
                "redirect_uri",
            ],
            &["grant_type", "refresh_token", "client_id"],
            &["client_id"],
            &["device_auth_id", "user_code"],
        ],
    ),
    (
        "openai-chatgpt",
        &[
            &[
                "grant_type",
                "client_id",
                "code",
                "code_verifier",
                "redirect_uri",
                "resource",
            ],
            &["grant_type", "client_id", "refresh_token", "resource"],
            &[
                "client_id",
                "agent_name_hint",
                "ext_agent_host_id",
                "response_type",
                "redirect_uri",
                "resource",
                "scope",
                "state",
                "code_challenge",
                "code_challenge_method",
                "nonce",
            ],
        ],
    ),
    (
        "github-copilot",
        &[
            &["client_id", "scope"],
            &["client_id", "device_code", "grant_type"],
            &["state"],
        ],
    ),
    (
        "kimi-coding",
        &[
            &["client_id"],
            &["client_id", "device_code", "grant_type"],
            &["client_id", "grant_type", "refresh_token"],
        ],
    ),
    (
        "xai",
        &[
            &["client_id", "scope", "referrer"],
            &["grant_type", "client_id", "device_code"],
            &["grant_type", "client_id", "refresh_token"],
        ],
    ),
    (
        "meta",
        &[&["client_id"], &["grant_type", "device_code", "client_id"]],
    ),
    (
        "openrouter",
        &[
            &["code", "code_verifier", "code_challenge_method"],
            &["callback_url", "code_challenge", "code_challenge_method"],
        ],
    ),
];

#[test]
fn drift() {
    let pi: Value = serde_json::from_str(AUTH_PI).unwrap();
    assert_eq!(
        pi["source"]["version"], "1.5.0",
        "update the port with the version"
    );
    let oauth = pi["oauth"].as_object().unwrap();
    let deviations = deviations();
    let ported = ported();

    // Every module is ported, a helper, or left out on purpose.
    let flows_ported = [
        "github-copilot",
        "kimi-coding",
        "meta",
        "openai-chatgpt",
        "openai-codex",
        "openrouter",
        "xai",
    ];
    for module in oauth.keys() {
        assert!(
            flows_ported.contains(&module.as_str())
                || HELPERS.contains(&module.as_str())
                || NOT_PORTED.iter().any(|(m, _)| m == module),
            "Pi has a new login module: {module}"
        );
    }
    for module in flows_ported.iter().chain(HELPERS.iter()) {
        assert!(oauth.contains_key(*module), "Pi no longer has {module}");
    }

    // Every constant matches, or is a recorded deviation whose Pi value is unchanged.
    for (module, body) in oauth {
        if NOT_PORTED.iter().any(|(m, _)| m == module) {
            continue;
        }
        for (name, value) in body["constants"].as_object().unwrap() {
            if let Some((.., pis, why)) = deviations
                .iter()
                .find(|(m, n, ..)| m == module && n == name)
            {
                assert_eq!(
                    value, pis,
                    "{module}.{name} changed in Pi (Kintsugi differs: {why})"
                );
            } else {
                let ours = ported
                    .iter()
                    .find(|(m, n, _)| m == module && n == name)
                    .unwrap_or_else(|| panic!("{module}.{name} = {value} isn't ported"));
                assert_eq!(value, &ours.2, "{module}.{name}");
            }
        }
    }
    for (module, name, _) in &ported {
        assert!(
            oauth[*module]["constants"].get(*name).is_some(),
            "Pi no longer has {module}.{name}"
        );
    }
    for (module, literal) in LITERALS {
        let strings = oauth[*module]["strings"].as_array().unwrap();
        assert!(
            strings.iter().any(|s| s == literal),
            "Pi's {module} no longer has {literal:?}"
        );
    }
    for (module, bodies) in BODIES {
        assert_eq!(
            oauth[*module]["bodies"],
            json!(bodies),
            "the requests {module} builds changed in Pi"
        );
    }
    for (header, value) in pi_auth::COPILOT_HEADERS {
        let strings = oauth["github-copilot"]["strings"].as_array().unwrap();
        assert!(
            strings.iter().any(|s| s == header) && strings.iter().any(|s| s == value),
            "{header}"
        );
    }

    // Providers: a key wherever Pi takes one, by Pi's environment names; a
    // sign-in wherever Pi has one, but Claude's.
    let providers = pi["providers"].as_object().unwrap();
    for p in crate::ai::wire::PROVIDERS.iter().filter(|p| !p.keyless) {
        let pis = providers
            .get(p.id)
            .unwrap_or_else(|| panic!("Pi has no provider {}", p.id));
        match &pis["apiKey"] {
            env @ Value::Array(_) => assert_eq!(env, &json!(p.env_keys), "{}", p.id),
            Value::String(custom) => assert_eq!(custom, "custom", "{}", p.id),
            _ => assert_eq!(p.id, "openai-codex", "Pi takes no key for {}", p.id),
        }
        let login = pis["oauth"].as_str();
        assert_eq!(
            can_sign_in(p.id),
            login.is_some() && p.id != "anthropic",
            "{}",
            p.id
        );
    }
}

#[test]
fn server_times_never_panic_huge_nan_or_negative() {
    let rt = runtime();
    rt.block_on(async {
        let second = Duration::from_millis(5);
        let options = |interval, expires_in, wait_first| device::Options {
            interval,
            expires_in,
            wait_first,
            second,
        };
        // The arithmetic on what the server said: none of it may panic.
        for (interval, expires_in) in [
            (Some(f64::MAX), Some(f64::MAX)),
            (Some(1e308), Some(f64::NAN)),
            (Some(f64::NAN), Some(f64::INFINITY)),
            (Some(-1.0), Some(-5.0)),
            (Some(f64::INFINITY), None),
        ] {
            let done = device::poll(options(interval, expires_in, false), || async {
                Ok(Poll::Complete(()))
            });
            let result = tokio::time::timeout(Duration::from_secs(5), done)
                .await
                .expect("ends");
            // A negative lifetime is already over; the rest poll once.
            assert_eq!(
                result.is_ok(),
                expires_in != Some(-5.0),
                "{interval:?} {expires_in:?}"
            );
        }
        // slow_down asking for an absurd interval stays within the lifetime.
        for asked in [
            Some(f64::MAX),
            Some(f64::NAN),
            Some(-3.0),
            Some(f64::INFINITY),
        ] {
            let done = device::poll(options(Some(f64::MAX), Some(4.0), true), || async move {
                Ok(Poll::<()>::SlowDown(asked))
            });
            let result = tokio::time::timeout(Duration::from_secs(5), done)
                .await
                .expect("ends at the code's expiry");
            assert!(result.unwrap_err().starts_with("Device flow timed out"));
        }
    });
}

#[test]
fn device_logins_survive_absurd_numbers_from_the_server() {
    let rt = runtime();
    rt.block_on(async {
        let (base, _) = server(|req, _| match req.path.as_str() {
            // xAI: a lifetime of 2 seconds but an interval of 1e308.
            "/oauth2/device/code" => (200, json!({ "device_code": "d", "user_code": "u", "verification_uri": "https://x.ai/d", "expires_in": 2, "interval": 1e308 })),
            "/oauth2/token" => (400, json!({ "error": "slow_down", "interval": 1e308 })),
            // Copilot: nothing is filtered before polling; negative and huge.
            "/login/device/code" => (200, json!({ "device_code": "dc", "user_code": "C", "verification_uri": "https://github.com/login/device", "interval": -5, "expires_in": 1e308 })),
            "/login/oauth/access_token" => (200, json!({ "access_token": "gho" })),
            "/copilot_internal/v2/token" => (200, json!({ "token": "t", "expires_at": 1e308 })),
            "/models" => (200, json!({ "data": [] })),
            _ => (404, json!({})),
        })
        .await;
        let (xai, events, _) = drive("xai", endpoints(&base), &[], no_browser()).await;
        // Waited out the code's two seconds (not 1e308 of them), then stopped.
        assert_eq!(xai.unwrap_err(), device::TIMED_OUT);
        assert!(events.iter().any(|e| matches!(e, Event::DeviceCode { .. })));
        let (copilot, ..) = drive("github-copilot", endpoints(&base), &[""], no_browser()).await;
        let copilot = copilot.unwrap();
        assert_eq!(copilot["refresh"], "gho");
        assert!(copilot["expires"].as_u64().is_some());
    });
}

#[test]
fn codex_waits_for_a_paste_only_as_long_as_a_callback() {
    let rt = runtime();
    rt.block_on(async {
        // Port taken (by the Codex CLI, say): only a paste could finish it.
        let taken = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let mut e = endpoints("http://127.0.0.1:1");
        e.openai_callback_port = taken.local_addr().unwrap().port();
        e.login_timeout = Duration::from_millis(100);
        let (result, events, _) = drive("openai-codex", e, &["browser"], no_browser()).await;
        assert_eq!(result.unwrap_err(), "OpenAI sign-in timed out");
        assert!(events.iter().any(
            |e| matches!(e, Event::Prompt { prompt, .. } if prompt.kind == PromptKind::Paste)
        ));
    });
}
