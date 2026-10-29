//! The HTTP API the phone app talks to. It listens on localhost only and
//! reaches the tailnet through `tailscale serve`; every request must carry
//! the pairing token, so other local processes and web pages get nothing.
//! Mirrored by packages/core/src/remote.ts.

use axum::extract::{Query, Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use kintsugi_vault::{self as vault, Write};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::oneshot;

/// A document the phone changed, so the desktop can show it straight away.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Changed {
    pub path: String,
    /// The new text when the phone edited it; `None` for a new document.
    pub text: Option<String>,
}

/// What the server needs from the app, kept abstract so tests can run it bare.
#[derive(Clone)]
pub struct Host {
    pub root: Arc<dyn Fn() -> Result<PathBuf, String> + Send + Sync>,
    pub changed: Arc<dyn Fn(Changed) + Send + Sync>,
}

#[derive(Clone)]
struct Ctx {
    host: Host,
    token: Arc<str>,
}

struct Error(StatusCode, String);

impl From<String> for Error {
    fn from(message: String) -> Self {
        Error(StatusCode::BAD_REQUEST, message)
    }
}

impl IntoResponse for Error {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

type Reply<T> = Result<Json<T>, Error>;

impl Ctx {
    fn root(&self) -> Result<PathBuf, Error> {
        (self.host.root)().map_err(|e| Error(StatusCode::SERVICE_UNAVAILABLE, e))
    }
}

pub fn router(host: Host, token: &str) -> Router {
    let ctx = Ctx { host, token: token.into() };
    Router::new()
        .route("/v1/hello", get(hello))
        .route("/v1/tree", get(tree))
        .route("/v1/doc", get(read).put(write))
        .route("/v1/docs", post(create))
        .route("/v1/capture", post(capture))
        .layer(middleware::from_fn_with_state(ctx.clone(), authorize))
        .with_state(ctx)
}

/// Binds first, so a taken port is reported to whoever turned the server on.
/// A server that was just stopped can hold the port for a moment, so retry briefly.
pub async fn start(host: Host, token: &str, port: u16) -> Result<oneshot::Sender<()>, String> {
    let mut attempt = 0;
    let listener = loop {
        match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(listener) => break listener,
            Err(_) if attempt < 20 => {
                attempt += 1;
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            Err(e) => return Err(format!("couldn't listen on port {port}: {e}")),
        }
    };
    let (stop, stopped) = oneshot::channel::<()>();
    let app = router(host, token);
    tauri::async_runtime::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await;
    });
    Ok(stop)
}

async fn authorize(State(ctx): State<Ctx>, request: Request, next: Next) -> Response {
    let presented = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or_default();
    if !same(presented.as_bytes(), ctx.token.as_bytes()) {
        return Error(StatusCode::UNAUTHORIZED, "This phone isn't paired with Kintsugi.".into()).into_response();
    }
    next.run(request).await
}

/// Compares without stopping at the first difference, so timing says nothing.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0, |acc, (x, y)| acc | (x ^ y)) == 0
}

async fn hello(State(ctx): State<Ctx>) -> Reply<serde_json::Value> {
    let root = ctx.root()?;
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(Json(json!({ "app": "kintsugi", "api": 1, "vault": name })))
}

async fn tree(State(ctx): State<Ctx>) -> Reply<Vec<vault::Entry>> {
    Ok(Json(vault::tree(&ctx.root()?)?))
}

#[derive(Deserialize)]
struct PathQuery {
    path: String,
}

async fn read(State(ctx): State<Ctx>, Query(q): Query<PathQuery>) -> Reply<vault::Versioned> {
    let root = ctx.root()?;
    if !vault::resolve(&root, &q.path)?.is_file() {
        return Err(Error(StatusCode::NOT_FOUND, format!("no document at {}", q.path)));
    }
    Ok(Json(vault::read(&root, &q.path)?))
}

#[derive(Deserialize)]
struct WriteBody {
    path: String,
    text: String,
    /// The version the phone last read; omitted only to overwrite on purpose.
    base: Option<String>,
}

async fn write(State(ctx): State<Ctx>, Json(body): Json<WriteBody>) -> Result<Response, Error> {
    let result = vault::write(&ctx.root()?, &body.path, &body.text, body.base.as_deref())?;
    let status = match result {
        Write::Saved { .. } => {
            (ctx.host.changed)(Changed { path: body.path, text: Some(body.text) });
            StatusCode::OK
        }
        Write::Conflict { .. } => StatusCode::CONFLICT,
    };
    Ok((status, Json(result)).into_response())
}

#[derive(Deserialize)]
struct CreateBody {
    dir: String,
    title: String,
}

async fn create(State(ctx): State<Ctx>, Json(body): Json<CreateBody>) -> Reply<serde_json::Value> {
    let path = vault::create_doc(&ctx.root()?, &body.dir, &body.title)?;
    (ctx.host.changed)(Changed { path: path.clone(), text: None });
    Ok(Json(json!({ "path": path })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaptureBody {
    text: String,
    #[serde(default)]
    captured_at: String,
}

async fn capture(State(ctx): State<Ctx>, Json(body): Json<CaptureBody>) -> Reply<serde_json::Value> {
    let path = vault::capture(&ctx.root()?, &body.text, &body.captured_at)?;
    (ctx.host.changed)(Changed { path: path.clone(), text: None });
    Ok(Json(json!({ "path": path })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    const TOKEN: &str = "TEST-TOKEN";

    /// Serves a temp vault on a free port and runs `test` against it.
    fn with_server(test: impl AsyncFnOnce(String, reqwest::Client, PathBuf, Arc<Mutex<Vec<Changed>>>)) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let changes = Arc::new(Mutex::new(Vec::new()));
        let host = Host {
            root: Arc::new({
                let root = root.clone();
                move || Ok(root.clone())
            }),
            changed: Arc::new({
                let changes = changes.clone();
                move |c| changes.lock().unwrap().push(c)
            }),
        };
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        runtime.block_on(async {
            let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            tokio::spawn(async move { axum::serve(listener, router(host, TOKEN)).await.unwrap() });
            test(base, reqwest::Client::new(), root, changes).await;
        });
    }

    #[test]
    fn refuses_requests_without_the_token() {
        with_server(async |base, http, _, _| {
            let bare = http.get(format!("{base}/v1/tree")).send().await.unwrap();
            assert_eq!(bare.status(), 401);
            let wrong = http.get(format!("{base}/v1/tree")).bearer_auth("TEST-TOKEX").send().await.unwrap();
            assert_eq!(wrong.status(), 401);
            let right = http.get(format!("{base}/v1/tree")).bearer_auth(TOKEN).send().await.unwrap();
            assert_eq!(right.status(), 200);
        });
    }

    #[test]
    fn edits_check_the_version_and_tell_the_desktop() {
        with_server(async |base, http, root, changes| {
            let path = vault::create_doc(&root, "", "Repair").unwrap();
            let doc: serde_json::Value = http
                .get(format!("{base}/v1/doc?path={path}"))
                .bearer_auth(TOKEN)
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            let put = |text: &'static str| {
                http.put(format!("{base}/v1/doc"))
                    .bearer_auth(TOKEN)
                    .json(&json!({ "path": path, "text": text, "base": doc["version"] }))
                    .send()
            };
            assert_eq!(put("from the phone").await.unwrap().status(), 200);
            let stale = put("again, from an old copy").await.unwrap();
            assert_eq!(stale.status(), 409);
            let body: serde_json::Value = stale.json().await.unwrap();
            assert_eq!(body["current"]["text"], "from the phone");
            assert_eq!(
                *changes.lock().unwrap(),
                vec![Changed { path: path.clone(), text: Some("from the phone".into()) }]
            );

            let missing = http
                .get(format!("{base}/v1/doc?path=nope.mdx"))
                .bearer_auth(TOKEN)
                .send()
                .await
                .unwrap();
            assert_eq!(missing.status(), 404);
            let escape = http
                .get(format!("{base}/v1/doc?path=../secrets.md"))
                .bearer_auth(TOKEN)
                .send()
                .await
                .unwrap();
            assert_eq!(escape.status(), 400);
        });
    }

    #[test]
    fn captures_go_to_the_inbox() {
        with_server(async |base, http, root, changes| {
            let reply: serde_json::Value = http
                .post(format!("{base}/v1/capture"))
                .bearer_auth(TOKEN)
                .json(&json!({ "text": "Gold seams for AI edits", "capturedAt": "2026-10-29T09:14" }))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert_eq!(reply["path"], "inbox/gold-seams-for-ai-edits.mdx");
            assert!(root.join("inbox/gold-seams-for-ai-edits.mdx").is_file());
            assert_eq!(changes.lock().unwrap().len(), 1);
        });
    }
}
