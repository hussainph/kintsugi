//! Debug-only HTTP transport into the *same* Tauri dispatcher. MockRuntime
//! has no OS event loop, NSApplication, native window, menu or Dock presence.
//! Mock webviews are IPC identities only; no Wry runtime is linked.

use crate::{AppHandle, Runtime};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Query, Request, State},
    http::{HeaderMap, StatusCode, header},
    middleware::{self, Next},
    response::{
        IntoResponse, Response, Sse,
        sse::{Event, KeepAlive},
    },
    routing::{get, post},
};
use futures_util::stream;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    convert::Infallible,
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{
    Emitter, Listener, Manager, Webview,
    ipc::{CallbackFn, InvokeBody, InvokeResponseBody},
    webview::InvokeRequest,
};
use tokio::sync::{mpsc, watch};

type Result<T> = std::result::Result<T, String>;
type Clients = Arc<Mutex<HashMap<String, Client>>>;

// The test helper accepts AsRef<Webview>, which Webview itself doesn't implement.
struct IpcIdentity(Webview<Runtime>);
impl AsRef<Webview<Runtime>> for IpcIdentity {
    fn as_ref(&self) -> &Webview<Runtime> {
        &self.0
    }
}

struct Client {
    webview: Webview<Runtime>,
    send: mpsc::Sender<Value>,
    listeners: HashMap<u32, tauri::EventId>,
    failed: watch::Sender<bool>,
    identity: Arc<()>,
}

#[derive(Clone)]
struct Bridge {
    app: AppHandle,
    clients: Clients,
    token: String,
    origin: String,
    base: String,
}

pub(crate) fn ai_enabled() -> bool {
    std::env::var("KINTSUGI_HEADLESS_PI_READONLY").as_deref() == Ok("1")
}

/// Guard both startup overrides and the folder prompt. Never allow an ancestor,
/// child or symlink of the owner's standard vault/config, even with a valid token.
fn checked_directory(path: &Path) -> Result<PathBuf> {
    let path = path.canonicalize().map_err(|e| e.to_string())?;
    if !path.is_dir() {
        return Err("scratch path must be a directory".into());
    }
    let home = PathBuf::from(std::env::var_os("HOME").ok_or("HOME missing")?);
    for forbidden in [
        home.join("Documents/Kintsugi"),
        home.join("Library/Application Support/dev.phalasiya.kintsugi"),
        home.join("Library/Application Support/Kintsugi"),
        home.join(".ssh"),
        home.join(".pi"),
    ] {
        let forbidden = forbidden.canonicalize().unwrap_or(forbidden);
        if path.starts_with(&forbidden) || forbidden.starts_with(&path) {
            return Err("headless refuses the owner's vault/config or their ancestors".into());
        }
    }
    Ok(path)
}

fn required_dir(name: &str) -> Result<PathBuf> {
    let path = std::env::var_os(name)
        .filter(|p| !p.is_empty())
        .ok_or_else(|| format!("{name} is required; use pnpm desktop:headless"))?;
    checked_directory(Path::new(&path))
}

/// A token grants access to this run's vault, not arbitrary folders on disk.
/// Pick a different top-level scratch vault by restarting with the env override.
pub(crate) fn scratch_path(path: &Path) -> Result<PathBuf> {
    let path = checked_directory(path)?;
    if !path.starts_with(required_dir("KINTSUGI_VAULT")?) {
        return Err("headless only opens folders inside this run's scratch vault".into());
    }
    Ok(path)
}

pub(crate) fn config_directory() -> Result<PathBuf> {
    required_dir("KINTSUGI_CONFIG_DIR")
}

/// Reversible dev trash stays entirely inside this run's config directory.
/// In particular, never call trash-rs's Finder/AppleScript default in headless.
pub(crate) fn trash(targets: &[PathBuf]) -> Result<()> {
    let root = required_dir("KINTSUGI_VAULT")?;
    let sources = targets
        .iter()
        .map(|path| {
            let source = path.canonicalize().map_err(|e| e.to_string())?;
            if source == root || !source.starts_with(&root) {
                return Err(
                    "refusing to trash outside the scratch vault or the vault itself".into(),
                );
            }
            Ok(source)
        })
        .collect::<Result<Vec<_>>>()?;
    let trash = config_directory()?.join("trash");
    if std::fs::symlink_metadata(&trash).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("scratch trash must not be a symlink".into());
    }
    std::fs::create_dir_all(&trash).map_err(|e| e.to_string())?;
    let batch = trash.join(random_token()?);
    std::fs::create_dir(&batch).map_err(|e| e.to_string())?;
    std::fs::write(
        batch.join("original-paths.json"),
        serde_json::to_vec_pretty(&sources).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let mut moved = Vec::new();
    for (index, source) in sources.iter().enumerate() {
        let target = batch.join(format!(
            "{index}-{}",
            source.file_name().unwrap().to_string_lossy()
        ));
        if let Err(error) = std::fs::rename(source, &target) {
            for (source, target) in moved.iter().rev() {
                let _ = std::fs::rename(target, source);
            }
            return Err(format!("could not move to scratch trash: {error}"));
        }
        moved.push((source, target));
    }
    Ok(())
}

fn random_token() -> Result<String> {
    let mut bytes = [0u8; 32];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .map_err(|e| e.to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn port(name: &str, default: u16) -> Result<u16> {
    std::env::var(name)
        .unwrap_or_else(|_| default.to_string())
        .parse::<u16>()
        .map_err(|_| format!("invalid {name}"))
        .and_then(|p| {
            if p == 0 {
                Err(format!("{name} must not be zero"))
            } else {
                Ok(p)
            }
        })
}

pub fn run() -> Result<()> {
    let vault = required_dir("KINTSUGI_VAULT")?;
    let config = required_dir("KINTSUGI_CONFIG_DIR")?;
    if vault.starts_with(&config) || config.starts_with(&vault) {
        return Err("scratch vault and config must be separate directories".into());
    }
    for file in ["config.json", "clip-capture-ids.json"] {
        if std::fs::symlink_metadata(config.join(file)).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err("headless config files must not be symlinks".into());
        }
    }
    let backend = port("KINTSUGI_BACKEND_PORT", 1423)?;
    let frontend = port("KINTSUGI_FRONTEND_PORT", 1422)?;
    let token = random_token()?;
    let origin = format!("http://127.0.0.1:{frontend}");
    let base = format!("http://127.0.0.1:{backend}");
    let clients = Clients::default();
    let app = build_app(clients.clone())?;
    // Never restore phone/Tailscale settings. Enrichment is opt-in with AI.
    if ai_enabled() {
        crate::enrich::start(app.handle());
    }
    let bridge = Bridge {
        app: app.handle().clone(),
        clients,
        token,
        origin,
        base,
    };
    let router = router(bridge.clone());
    tauri::async_runtime::block_on(async move {
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, backend))
            .await
            .map_err(|e| e.to_string())?;
        println!("Headless: MockRuntime only; no OS windows, Dock icon or focus activation.");
        println!("Vault: {}", required_dir("KINTSUGI_VAULT")?.display());
        println!("Config: {}", required_dir("KINTSUGI_CONFIG_DIR")?.display());
        println!("Open in a Volli Browser Tab (token is per-run):");
        println!(
            "{}/#headless={}&token={}",
            bridge.origin, bridge.base, bridge.token
        );
        axum::serve(listener, router)
            .await
            .map_err(|e| e.to_string())
    })?;
    drop(app);
    Ok(())
}

fn build_app(clients: Clients) -> Result<tauri::App<Runtime>> {
    build_app_with_context(
        clients,
        tauri::test::mock_context(tauri::test::noop_assets()),
    )
}

fn build_app_with_context(
    clients: Clients,
    context: tauri::Context<Runtime>,
) -> Result<tauri::App<Runtime>> {
    let channels = clients.clone();
    let app = crate::builder()
        .channel_interceptor(move |webview, callback, index, body| {
            let clients = channels.lock().unwrap();
            if let Some(client) = clients.values().find(|c| c.webview.label() == webview.label()) {
                let payload = match body {
                    InvokeResponseBody::Json(text) => serde_json::from_str(text).unwrap_or(Value::Null),
                    InvokeResponseBody::Raw(bytes) => json!({ "__headlessBytes": bytes }),
                };
                // Bounded queue: a stalled/disconnected browser cannot grow RAM.
                if client.send.try_send(json!({ "callback": callback.0, "payload": { "index": index, "message": payload } })).is_err() {
                    let _ = client.failed.send(true);
                }
            }
            true
        })
        .build(context)
        .map_err(|e| e.to_string())?;
    // One permanent mock host; child Webview::close synchronously unregisters
    // IPC identities even without an event loop (Window::close does not).
    tauri::WindowBuilder::new(&app, "headless-host")
        .build()
        .map_err(|e| e.to_string())?;
    Ok(app)
}

fn router(bridge: Bridge) -> Router {
    Router::new()
        .route("/invoke", post(invoke))
        .route("/events", get(events))
        .route("/asset", get(asset))
        .route(
            "/health",
            get(|| async { Json(json!({ "runtime": "mock", "nativeWindows": 0 })) }),
        )
        .layer(DefaultBodyLimit::max(16 * 1024 * 1024))
        .layer(middleware::from_fn_with_state(bridge.clone(), secure))
        .with_state(bridge)
}

/// No wildcard CORS, no arbitrary Host (DNS rebinding), no unauthenticated
/// endpoint. EventSource/img cannot set Authorization, so use query tokens.
async fn secure(State(bridge): State<Bridge>, request: Request, next: Next) -> Response {
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok());
    let expected_host = bridge.base.trim_start_matches("http://");
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok());
    if host != Some(expected_host) || origin.is_some_and(|o| o != bridge.origin) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if request.method() == axum::http::Method::OPTIONS {
        let mut response = StatusCode::NO_CONTENT.into_response();
        cors(&mut response, &bridge.origin);
        return response;
    }
    let bearer = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    let query_token = request
        .uri()
        .query()
        .and_then(|q| q.split('&').find_map(|part| part.strip_prefix("token=")));
    if bearer.or(query_token) != Some(bridge.token.as_str()) {
        let mut response = StatusCode::UNAUTHORIZED.into_response();
        cors(&mut response, &bridge.origin);
        return response;
    }
    let mut response = next.run(request).await;
    cors(&mut response, &bridge.origin);
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert("referrer-policy", "no-referrer".parse().unwrap());
    response
}

fn cors(response: &mut Response, origin: &str) {
    let headers = response.headers_mut();
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin.parse().unwrap());
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        "GET, POST, OPTIONS".parse().unwrap(),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        "authorization, content-type".parse().unwrap(),
    );
    headers.insert(header::VARY, "Origin".parse().unwrap());
}

#[derive(Deserialize)]
struct Connect {
    client: String,
}

struct Connection {
    bridge: Bridge,
    client: String,
    receive: mpsc::Receiver<Value>,
    failed: watch::Receiver<bool>,
    identity: Arc<()>,
}

impl Drop for Connection {
    fn drop(&mut self) {
        let mut clients = self.bridge.clients.lock().unwrap();
        if !clients
            .get(&self.client)
            .is_some_and(|c| Arc::ptr_eq(&c.identity, &self.identity))
        {
            return; // An old stream must not remove its replacement.
        }
        let removed = clients.remove(&self.client);
        drop(clients);
        if let Some(client) = removed {
            for id in client.listeners.values() {
                self.bridge.app.unlisten(*id);
            }
            let _ = client.webview.close();
        }
    }
}

async fn events(State(bridge): State<Bridge>, Query(connect): Query<Connect>) -> Response {
    if connect.client.len() > 64
        || connect.client.is_empty()
        || !connect
            .client
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let (send, receive) = mpsc::channel(256);
    let (failed, failure) = watch::channel(false);
    let identity = Arc::new(());
    {
        let mut clients = bridge.clients.lock().unwrap();
        // A browser may reconnect before TCP teardown drops the previous SSE.
        if let Some(previous) = clients.remove(&connect.client) {
            let _ = previous.failed.send(true);
            for id in previous.listeners.values() {
                bridge.app.unlisten(*id);
            }
            let _ = previous.webview.close();
        }
        if clients.len() >= 16 {
            return StatusCode::TOO_MANY_REQUESTS.into_response();
        }
        static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let label = format!(
            "browser-{}",
            NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        let host = bridge.app.get_window("headless-host").unwrap();
        let webview = match host.add_child(
            tauri::webview::WebviewBuilder::new(label, Default::default()),
            tauri::LogicalPosition::new(0., 0.),
            tauri::LogicalSize::new(1., 1.),
        ) {
            Ok(webview) => webview,
            Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        };
        clients.insert(
            connect.client.clone(),
            Client {
                webview,
                send: send.clone(),
                listeners: HashMap::new(),
                failed,
                identity: identity.clone(),
            },
        );
    }
    let _ = send.try_send(json!({ "ready": true }));
    let connection = Connection {
        bridge,
        client: connect.client,
        receive,
        failed: failure,
        identity,
    };
    Sse::new(stream::unfold(connection, |mut connection| async move {
        let packet = tokio::select! {
            packet = connection.receive.recv() => packet?,
            _ = connection.failed.changed() => return None,
        };
        Some((
            Ok::<_, Infallible>(Event::default().data(packet.to_string())),
            connection,
        ))
    }))
    .keep_alive(KeepAlive::new().interval(Duration::from_secs(10)))
    .into_response()
}

#[derive(Deserialize)]
struct Call {
    client: String,
    cmd: String,
    #[serde(default)]
    args: Value,
}

async fn invoke(State(bridge): State<Bridge>, Json(call): Json<Call>) -> Json<Value> {
    let result = dispatch(&bridge, call).await;
    Json(match result {
        Ok(value) => json!({ "ok": true, "value": value }),
        Err(error) => json!({ "ok": false, "error": error }),
    })
}

async fn dispatch(bridge: &Bridge, call: Call) -> std::result::Result<Value, Value> {
    let webview = bridge
        .clients
        .lock()
        .unwrap()
        .get(&call.client)
        .map(|c| c.webview.clone())
        .ok_or(json!("event connection is not ready"))?;
    // Only platform transport adapters live here. App commands ALL go through
    // generate_handler!, including commands added in other tickets.
    match call.cmd.as_str() {
        "plugin:event|listen" => {
            let event = call.args["event"].as_str().ok_or(json!("missing event"))?;
            if !event
                .chars()
                .all(|c| c.is_alphanumeric() || matches!(c, '-' | '/' | ':' | '_'))
            {
                return Err(json!("invalid event name"));
            }
            let callback = call.args["handler"]
                .as_u64()
                .and_then(|id| u32::try_from(id).ok())
                .ok_or(json!("invalid callback"))?;
            let mut clients = bridge.clients.lock().unwrap();
            let client = clients
                .get_mut(&call.client)
                .ok_or(json!("event connection closed"))?;
            let send = client.send.clone();
            let failed = client.failed.clone();
            let event_name = event.to_string();
            let id = bridge.app.listen_any(event, move |e| {
                let payload: Value = serde_json::from_str(e.payload()).unwrap_or(Value::Null);
                if send.try_send(json!({ "callback": callback, "payload": { "event": event_name, "id": callback, "payload": payload } })).is_err() {
                    let _ = failed.send(true);
                }
            });
            if let Some(previous) = client.listeners.insert(callback, id) {
                bridge.app.unlisten(previous);
            }
            return Ok(json!(callback));
        }
        "plugin:event|unlisten" => {
            if let Some(id) = call.args["eventId"].as_u64().and_then(|id| {
                bridge
                    .clients
                    .lock()
                    .unwrap()
                    .get_mut(&call.client)
                    .and_then(|c| c.listeners.remove(&(id as u32)))
            }) {
                bridge.app.unlisten(id);
            }
            return Ok(Value::Null);
        }
        "plugin:event|emit" | "plugin:event|emit_to" => {
            let event = call.args["event"].as_str().ok_or(json!("missing event"))?;
            if call.cmd == "plugin:event|emit_to" {
                let mut target = call.args["target"].clone();
                if target["label"] == "main" {
                    target["label"] = json!(webview.label());
                }
                let target: tauri::EventTarget =
                    serde_json::from_value(target).map_err(|_| json!("invalid event target"))?;
                bridge
                    .app
                    .emit_to(target, event, &call.args["payload"])
                    .map_err(|e| json!(e.to_string()))?;
            } else {
                bridge
                    .app
                    .emit(event, &call.args["payload"])
                    .map_err(|e| json!(e.to_string()))?;
            }
            return Ok(Value::Null);
        }
        "plugin:window|start_dragging" => return Ok(Value::Null),
        "plugin:opener|open_url" => {
            let url = call.args["url"].as_str().ok_or(json!("missing URL"))?;
            let parsed = tauri::Url::parse(url).map_err(|_| json!("invalid URL"))?;
            if !matches!(parsed.scheme(), "http" | "https") {
                return Err(json!("only http(s) URLs can open in headless mode"));
            }
            return Ok(json!({ "url": url }));
        }
        "plugin:opener|open_path" => {
            let path = call.args["path"].as_str().ok_or(json!("missing path"))?;
            asset_path(&bridge.app, path).map_err(|e| json!(e))?;
            let mut url = tauri::Url::parse(&format!("{}/asset", bridge.base)).unwrap();
            url.query_pairs_mut()
                .append_pair("token", &bridge.token)
                .append_pair("path", path);
            return Ok(json!({ "url": url.as_str() }));
        }
        "plugin:opener|reveal_item_in_dir" => {
            return Err(json!(
                "Finder is unavailable in headless mode; use the vault path"
            ));
        }
        _ => {}
    }
    let request = InvokeRequest {
        cmd: call.cmd,
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: "tauri://localhost".parse().unwrap(),
        body: InvokeBody::Json(call.args),
        headers: HeaderMap::new(),
        invoke_key: tauri::test::INVOKE_KEY.into(),
    };
    tokio::task::spawn_blocking(move || {
        tauri::test::get_ipc_response(&IpcIdentity(webview), request).and_then(|body| match body {
            InvokeResponseBody::Json(text) => {
                serde_json::from_str(&text).map_err(|e| json!(e.to_string()))
            }
            InvokeResponseBody::Raw(bytes) => Ok(json!({ "__headlessBytes": bytes })),
        })
    })
    .await
    .map_err(|_| json!("command task failed"))?
}

#[derive(Deserialize)]
struct Asset {
    path: String,
}

fn asset_path(app: &AppHandle, path: &str) -> Result<PathBuf> {
    let root = crate::vault::current(app)?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let candidate = Path::new(path);
    let path = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        root.join(candidate)
    }
    .canonicalize()
    .map_err(|e| e.to_string())?;
    if !path.starts_with(root) || !path.is_file() {
        return Err("asset is outside the scratch vault".into());
    }
    Ok(path)
}

async fn asset(State(bridge): State<Bridge>, Query(asset): Query<Asset>) -> Response {
    let Ok(path) = asset_path(&bridge.app, &asset.path) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    if !std::fs::metadata(&path).is_ok_and(|m| m.len() <= 16 * 1024 * 1024) {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    }
    let mime = match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        // Never serve executable HTML/SVG/JS with the bridge's token origin.
        _ => "text/plain; charset=utf-8",
    };
    match std::fs::read(path) {
        Ok(bytes) => (
            [
                (header::CONTENT_TYPE, mime),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            ],
            bytes,
        )
            .into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::StreamExt;

    #[test]
    fn real_dispatcher_over_authenticated_http_sse() {
        if std::env::var_os("KINTSUGI_HEADLESS_TEST_CHILD").is_none() {
            let result = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "headless::tests::real_dispatcher_over_authenticated_http_sse",
                    "--nocapture",
                    "--test-threads=1",
                ])
                .env("KINTSUGI_HEADLESS_TEST_CHILD", "1")
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&result.stdout),
                String::from_utf8_lossy(&result.stderr)
            );
            return;
        }
        let workspace = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
        std::fs::create_dir_all(workspace.join(".headless")).unwrap();
        let scratch = tempfile::tempdir_in(workspace.join(".headless")).unwrap();
        let vault = scratch.path().join("vault");
        let config = scratch.path().join("config");
        std::fs::create_dir_all(&vault).unwrap();
        std::fs::create_dir_all(&config).unwrap();
        std::fs::write(vault.join("test.md"), "---\nstatus: draft\n---\n\nBefore\n").unwrap();
        std::fs::write(
            config.join("config.json"),
            r#"{"vault":"previous-vault","phone":{"enabled":false,"token":"scratch-token"}}"#,
        )
        .unwrap();
        // Give Tauri a synthetic "real app config" location, never the owner's
        // actual directory. Missing headless overrides MUST NOT fall back here.
        let owner_config = scratch.path().join("synthetic-owner-config");
        std::fs::create_dir(&owner_config).unwrap();
        let sentinel = b"{\"vault\":\"owner-writing\",\"phone\":{\"enabled\":false,\"token\":\"owner-token\"}}";
        std::fs::write(owner_config.join("config.json"), sentinel).unwrap();
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().app.app_directories_override = Some(
            tauri::utils::config::AppDirectoriesOverride::Root(owner_config.clone()),
        );
        // Isolate this env-mutating test in its own single-test process below.
        unsafe {
            std::env::remove_var("KINTSUGI_VAULT");
            std::env::remove_var("KINTSUGI_CONFIG_DIR");
            std::env::remove_var("KINTSUGI_HEADLESS_PI_READONLY");
        }
        let clients = Clients::default();
        let app = build_app_with_context(clients.clone(), context).unwrap();
        assert!(crate::config::directory(app.handle()).is_err());
        assert!(
            crate::config::update(app.handle(), |c| c.phone.token =
                Some("must-not-write".into()))
            .is_err()
        );
        assert!(crate::clip_capture::index_path(app.handle()).is_err());
        assert!(crate::config::load(app.handle()).vault.is_none());
        assert_eq!(
            std::fs::read(owner_config.join("config.json")).unwrap(),
            sentinel
        );
        unsafe {
            std::env::set_var("KINTSUGI_VAULT", &vault);
            std::env::set_var("KINTSUGI_CONFIG_DIR", &config);
        }
        tauri::async_runtime::block_on(async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let bridge = Bridge {
                app: app.handle().clone(),
                clients,
                token: random_token().unwrap(),
                origin: "http://127.0.0.1:1422".into(),
                base: base.clone(),
            };
            let server = tokio::spawn(axum::serve(listener, router(bridge.clone())).into_future());
            let client = reqwest::Client::new();
            assert_eq!(
                client
                    .get(format!("{base}/health"))
                    .send()
                    .await
                    .unwrap()
                    .status(),
                StatusCode::UNAUTHORIZED
            );
            assert_eq!(
                client
                    .get(format!("{base}/health"))
                    .bearer_auth("wrong")
                    .send()
                    .await
                    .unwrap()
                    .status(),
                StatusCode::UNAUTHORIZED
            );
            assert_eq!(
                client
                    .get(format!("{base}/health"))
                    .bearer_auth(&bridge.token)
                    .header("Origin", "https://evil.example")
                    .send()
                    .await
                    .unwrap()
                    .status(),
                StatusCode::FORBIDDEN
            );
            assert_eq!(
                client
                    .get(format!("{base}/health"))
                    .bearer_auth(&bridge.token)
                    .header("Host", "evil.example")
                    .send()
                    .await
                    .unwrap()
                    .status(),
                StatusCode::FORBIDDEN
            );
            let healthy: Value = client
                .get(format!("{base}/health"))
                .bearer_auth(&bridge.token)
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert_eq!(healthy["nativeWindows"], 0);
            let events = client
                .get(format!(
                    "{base}/events?token={}&client=test-client",
                    bridge.token
                ))
                .send()
                .await
                .unwrap();
            assert!(events.status().is_success());
            let mut events = events.bytes_stream();
            async fn packet(
                events: &mut (
                         impl futures_util::Stream<
                    Item = std::result::Result<axum::body::Bytes, reqwest::Error>,
                > + Unpin
                     ),
            ) -> Value {
                let bytes = tokio::time::timeout(Duration::from_secs(5), events.next())
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap();
                let text = String::from_utf8(bytes.to_vec()).unwrap();
                let data = text.lines().find_map(|s| s.strip_prefix("data: ")).unwrap();
                serde_json::from_str(data).unwrap()
            }
            assert_eq!(packet(&mut events).await, json!({"ready":true}));
            async fn call(
                client: &reqwest::Client,
                bridge: &Bridge,
                cmd: &str,
                args: Value,
            ) -> Value {
                client
                    .post(format!("{}/invoke", bridge.base))
                    .bearer_auth(&bridge.token)
                    .json(&json!({"client":"test-client","cmd":cmd,"args":args}))
                    .send()
                    .await
                    .unwrap()
                    .json()
                    .await
                    .unwrap()
            }
            let current = call(&client, &bridge, "vault_current", json!({})).await;
            assert_eq!(current["value"], json!(vault.to_string_lossy()));
            assert_eq!(
                call(
                    &client,
                    &bridge,
                    "doc_write",
                    json!({"path":"test.md","contents":"Saved via real IPC"})
                )
                .await["ok"],
                true
            );
            assert_eq!(
                std::fs::read_to_string(vault.join("test.md")).unwrap(),
                "Saved via real IPC"
            );
            assert_eq!(
                call(&client, &bridge, "doc_read", json!({"path":"test.md"})).await["value"],
                "Saved via real IPC"
            );
            assert_eq!(
                call(
                    &client,
                    &bridge,
                    "plugin:event|listen",
                    json!({"event":"clips:changed","handler":42})
                )
                .await["value"],
                42
            );
            let captured = call(&client, &bridge, "clip_create", json!({"capture":{"id":"11111111-1111-4111-8111-111111111111","text":"A scratch capture", "capturedAt":"2026-10-29T15:00","via":"mac"}})).await;
            assert_eq!(captured["ok"], true, "{captured}");
            let changed = packet(&mut events).await;
            assert_eq!(changed["callback"], 42);
            assert_eq!(changed["payload"]["event"], "clips:changed");
            assert_eq!(
                call(
                    &client,
                    &bridge,
                    "plugin:event|unlisten",
                    json!({"event":"clips:changed","eventId":42})
                )
                .await["ok"],
                true
            );
            assert!(
                bridge.clients.lock().unwrap()["test-client"]
                    .listeners
                    .is_empty()
            );
            // Commands merged from KI-7/KI-8 need no bridge routes. In
            // particular, clip_image's Raw body must not turn into JSON text.
            let png = b"\x89PNG\r\n\x1a\nimage fixture";
            let image = call(&client, &bridge, "clip_create", json!({"capture":{"image":png.to_vec(),"imageType":"image/png","capturedAt":"2026-10-29T15:01","via":"mac"}})).await;
            assert_eq!(image["ok"], true, "{image}");
            let raw = call(
                &client,
                &bridge,
                "clip_image",
                json!({"path":image["value"]}),
            )
            .await;
            assert_eq!(
                raw["value"]["__headlessBytes"],
                json!(png.to_vec()),
                "{raw}"
            );
            assert_eq!(
                call(&client, &bridge, "clip_search", json!({})).await["value"]["total"],
                2
            );
            assert_eq!(
                call(&client, &bridge, "reference_index", json!({})).await["ok"],
                true
            );
            assert_eq!(
                call(
                    &client,
                    &bridge,
                    "vault_open",
                    json!({"path":scratch.path().to_string_lossy()})
                )
                .await["ok"],
                false
            );
            assert_eq!(
                std::fs::read(owner_config.join("config.json")).unwrap(),
                sentinel
            );
            assert!(!owner_config.join("clip-capture-ids.json").exists());
            let ai = call(&client, &bridge, "ai_providers", json!({})).await;
            assert!(
                ai["value"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|p| p["auth"] == "none")
            );
            // The REAL ai_stream handler deserializes Channel and streams its
            // disabled error. No provider, credentials or network call needed.
            let ai = call(&client, &bridge, "ai_stream", json!({"request":{"id":"test-ai","provider":"openai","model":"disabled","system":"","messages":[]}, "onEvent":"__CHANNEL__:99"})).await;
            assert_eq!(ai["ok"], true, "{ai}");
            let channel = packet(&mut events).await;
            assert_eq!(channel["callback"], 99);
            assert_eq!(channel["payload"]["index"], 0);
            assert_eq!(channel["payload"]["message"]["type"], "error");
            assert_eq!(
                channel["payload"]["message"]["message"],
                "AI is disabled in headless mode"
            );
            assert_eq!(
                call(&client, &bridge, "not_a_command", json!({})).await["ok"],
                false
            );
            assert_eq!(
                call(&client, &bridge, "phone_enable", json!({"enabled":true})).await["ok"],
                false
            );
            let persisted: Value =
                serde_json::from_str(&std::fs::read_to_string(config.join("config.json")).unwrap())
                    .unwrap();
            assert_eq!(persisted["vault"], "previous-vault");
            assert_eq!(persisted["phone"]["token"], "scratch-token");
            assert!(config.join("clip-capture-ids.json").exists());
            assert!(asset_path(app.handle(), "/etc/hosts").is_err());
            assert!(asset_path(app.handle(), "test.md").is_ok());
            assert_eq!(
                call(
                    &client,
                    &bridge,
                    "plugin:event|listen",
                    json!({"event":"invalid event!","handler":1})
                )
                .await["ok"],
                false
            );
            let disposable = call(
                &client,
                &bridge,
                "doc_create",
                json!({"dir":"","title":"Trash regression"}),
            )
            .await;
            assert_eq!(
                call(
                    &client,
                    &bridge,
                    "entry_trash",
                    json!({"path":disposable["value"]})
                )
                .await["ok"],
                true
            );
            assert!(!vault.join(disposable["value"].as_str().unwrap()).exists());
            assert_eq!(
                call(&client, &bridge, "entry_trash", json!({"path":"."})).await["ok"],
                false
            );
            assert_eq!(
                call(
                    &client,
                    &bridge,
                    "clip_trash",
                    json!({"path":image["value"]})
                )
                .await["ok"],
                true
            );
            assert!(!vault.join(image["value"].as_str().unwrap()).exists());
            assert_eq!(std::fs::read_dir(config.join("trash")).unwrap().count(), 2);
            // Reconnect before old TCP teardown; the old stream must not
            // remove the new identity, and mock registrations stay bounded.
            let reconnected = client
                .get(format!(
                    "{base}/events?token={}&client=test-client",
                    bridge.token
                ))
                .send()
                .await
                .unwrap();
            assert!(reconnected.status().is_success());
            let mut reconnected = reconnected.bytes_stream();
            assert_eq!(packet(&mut reconnected).await, json!({"ready":true}));
            drop(events);
            tokio::task::yield_now().await;
            assert_eq!(bridge.clients.lock().unwrap().len(), 1);
            assert_eq!(app.webviews().len(), 1);
            assert_eq!(app.windows().len(), 1); // mock host, never an OS window
            assert_eq!(
                call(&client, &bridge, "doc_read", json!({"path":"test.md"})).await["ok"],
                true
            );
            server.abort();
        });
    }
}
