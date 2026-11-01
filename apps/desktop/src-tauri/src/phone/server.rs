//! The HTTP API the phone app talks to. It listens on localhost only and
//! reaches the tailnet through `tailscale serve`; every request must carry
//! the pairing token, so other local processes and web pages get nothing.
//! Mirrored by packages/core/src/remote.ts.

use crate::clip_capture;
use axum::extract::rejection::{JsonRejection, QueryRejection};
use axum::extract::{DefaultBodyLimit, Query, Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
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
    pub capture_ids: PathBuf,
    pub root: Arc<dyn Fn() -> Result<PathBuf, String> + Send + Sync>,
    pub changed: Arc<dyn Fn(Changed) + Send + Sync>,
    pub clip_changed: Arc<dyn Fn(String) + Send + Sync>,
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
        .route("/v1/library", get(library))
        .route("/v1/doc", get(read).put(write))
        .route("/v1/docs", post(create))
        .route("/v1/capture", post(capture))
        .route(
            "/v1/clips",
            get(clips).merge(post(create_clip).layer(DefaultBodyLimit::max(CLIP_BODY_LIMIT))),
        )
        .route("/v1/clip", get(read_clip))
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
    // 4: clip captures accept files (PDFs and EPUBs).
    Ok(Json(json!({ "app": "kintsugi", "api": 4, "vault": name })))
}

async fn tree(State(ctx): State<Ctx>) -> Reply<Vec<vault::Entry>> {
    Ok(Json(vault::tree(&ctx.root()?)?))
}

/// Every document's text and version: the phone's offline copy. Since API 3.
async fn library(State(ctx): State<Ctx>) -> Reply<Vec<vault::Document>> {
    Ok(Json(vault::library(&ctx.root()?)?))
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
    if vault::is_inspiration_path(&body.path) {
        return Err("use clip endpoints for inspiration".to_string().into());
    }
    crate::blog::repo::refuse_mirror(&ctx.root()?, &body.path)?;
    let result = vault::write(&ctx.root()?, &body.path, &body.text, body.base.as_deref())?;
    let status = match result {
        Write::Saved { .. } => {
            (ctx.host.changed)(Changed { path: body.path, text: Some(body.text) });
            StatusCode::OK
        }
        Write::Conflict { .. } => StatusCode::CONFLICT,
        // `write` creates a missing document (a note started offline).
        Write::Gone => StatusCode::NOT_FOUND,
    };
    Ok((status, Json(result)).into_response())
}

#[derive(Deserialize)]
struct CreateBody {
    dir: String,
    title: String,
}

async fn create(State(ctx): State<Ctx>, Json(body): Json<CreateBody>) -> Reply<serde_json::Value> {
    if vault::is_inspiration_path(&body.dir) {
        return Err("use clip endpoints for inspiration".to_string().into());
    }
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

// Base64 adds a third to the image size; leave room for the capture's text.
// This larger limit applies only to POST /v1/clips, not document writes.
// Files (PDFs, EPUBs) are larger than images: 50 MiB decoded.
const CLIP_BODY_LIMIT: usize = clip_capture::MAX_ENCODED_FILE_BYTES + 2 * 1024 * 1024;
const MAX_CLIP_IMAGE_BYTES: usize = vault::MAX_CLIP_IMAGE_BYTES;
const MAX_ENCODED_IMAGE_BYTES: usize = MAX_CLIP_IMAGE_BYTES.div_ceil(3) * 4;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClipBody {
    id: Option<String>,
    url: Option<String>,
    text: Option<String>,
    note: Option<String>,
    title: Option<String>,
    image: Option<String>,
    image_type: Option<String>,
    file: Option<String>,
    file_type: Option<String>,
    file_name: Option<String>,
    captured_at: String,
    via: vault::ClipVia,
}

impl ClipBody {
    fn capture(self) -> Result<clip_capture::Capture, Error> {
        let image = self
            .image
            .map(|encoded| {
                let too_large = || {
                    Error(
                        StatusCode::PAYLOAD_TOO_LARGE,
                        "Clip images must be 15 MiB or smaller.".into(),
                    )
                };
                if encoded.len() > MAX_ENCODED_IMAGE_BYTES {
                    return Err(too_large());
                }
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .map_err(|_| {
                        Error(
                            StatusCode::BAD_REQUEST,
                            "The clip image must be valid base64.".into(),
                        )
                    })?;
                if bytes.len() > MAX_CLIP_IMAGE_BYTES {
                    return Err(too_large());
                }
                Ok(bytes)
            })
            .transpose()?;
        let file = clip_capture::decode_file(self.file, self.file_type, self.file_name).map_err(|e| {
            let status = match e {
                clip_capture::FileError::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
                clip_capture::FileError::Invalid(_) => StatusCode::BAD_REQUEST,
            };
            Error(status, e.to_string())
        })?;
        Ok(clip_capture::Capture {
            id: self.id,
            clip: vault::ClipCapture {
                url: self.url,
                text: self.text,
                note: self.note,
                title: self.title,
                image,
                image_type: self.image_type,
                file,
                captured_at: self.captured_at,
                via: self.via,
            },
        })
    }
}

async fn create_clip(
    State(ctx): State<Ctx>,
    body: Result<Json<ClipBody>, JsonRejection>,
) -> Reply<serde_json::Value> {
    let Json(body) = body.map_err(|e| {
        let message = match e.status() {
            StatusCode::PAYLOAD_TOO_LARGE => "The clip capture exceeds the request size limit.",
            StatusCode::UNSUPPORTED_MEDIA_TYPE => "Clip captures must use application/json.",
            _ => "Invalid clip capture JSON.",
        };
        // Serde's detailed rejection can echo a private input value.
        Error(e.status(), message.into())
    })?;
    let capture = body.capture()?;
    let created = clip_capture::create(&ctx.root()?, &ctx.host.capture_ids, &capture).map_err(|e| {
        let status = match &e {
            clip_capture::Error::Invalid(_) => StatusCode::BAD_REQUEST,
            clip_capture::Error::Storage => StatusCode::INTERNAL_SERVER_ERROR,
        };
        Error(status, e.to_string())
    })?;
    if created.created {
        (ctx.host.clip_changed)(created.path.clone());
    }
    Ok(Json(json!({ "path": created.path })))
}

async fn clips(State(ctx): State<Ctx>) -> Reply<Vec<vault::ClipSummary>> {
    Ok(Json(vault::clip_list(&ctx.root()?)?))
}

async fn read_clip(
    State(ctx): State<Ctx>,
    query: Result<Query<PathQuery>, QueryRejection>,
) -> Reply<vault::Clip> {
    let Query(q) = query.map_err(|_| Error(StatusCode::BAD_REQUEST, "A clip path is required.".into()))?;
    let root = ctx.root()?;
    if !vault::clip_path(&root, &q.path)?.is_file() {
        return Err(Error(
            StatusCode::NOT_FOUND,
            "No clip exists at that path.".into(),
        ));
    }
    Ok(Json(vault::clip_read(&root, &q.path)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    const TOKEN: &str = "TEST-TOKEN";

    fn clip_url(base: &str, path: &str) -> reqwest::Url {
        let mut url = reqwest::Url::parse(&format!("{base}/v1/clip")).unwrap();
        url.query_pairs_mut().append_pair("path", path);
        url
    }

    /// The real phone API on a scratch vault, for driving the app in the iOS
    /// Simulator without the desktop app, Tailscale or the owner's vault:
    ///
    /// KINTSUGI_PHONE_DEV_VAULT="$PWD/.headless/phone-vault" \
    ///   cargo test -p kintsugi phone_dev_server -- --ignored --nocapture
    ///
    /// It listens on 127.0.0.1:47475 (KINTSUGI_PHONE_DEV_PORT) and prints the
    /// pair link; open it with `xcrun simctl openurl`. Stop it with Ctrl-C.
    #[test]
    #[ignore]
    fn phone_dev_server() {
        let vault = std::env::var("KINTSUGI_PHONE_DEV_VAULT").expect("set KINTSUGI_PHONE_DEV_VAULT");
        let root = std::fs::canonicalize(&vault).expect("the scratch vault must exist");
        assert!(
            root.components().any(|c| c.as_os_str() == ".headless"),
            "refusing {}: use a scratch vault under a .headless folder",
            root.display()
        );
        let port: u16 = std::env::var("KINTSUGI_PHONE_DEV_PORT").map_or(47475, |p| p.parse().unwrap());
        let config = tempfile::tempdir().unwrap();
        let host = Host {
            capture_ids: config.path().join("clip-capture-ids.json"),
            root: Arc::new(move || Ok(root.clone())),
            changed: Arc::new(|c| println!("changed: {}", c.path)),
            clip_changed: Arc::new(|path| println!("clip changed: {path}")),
        };
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        runtime.block_on(async {
            let listener = TcpListener::bind(("127.0.0.1", port)).await.unwrap();
            println!("kintsugi://pair?url=http%3A%2F%2F127.0.0.1%3A{port}&token={TOKEN}");
            axum::serve(listener, router(host, TOKEN)).await.unwrap();
        });
    }

    /// Serves a temp vault on a free port and runs `test` against it.
    fn with_server(
        test: impl AsyncFnOnce(
            String,
            reqwest::Client,
            PathBuf,
            Arc<Mutex<Vec<Changed>>>,
            Arc<Mutex<Vec<String>>>,
        ),
    ) {
        let dir = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let changes = Arc::new(Mutex::new(Vec::new()));
        let clip_changes = Arc::new(Mutex::new(Vec::new()));
        let host = Host {
            capture_ids: config.path().join("clip-capture-ids.json"),
            root: Arc::new({
                let root = root.clone();
                move || Ok(root.clone())
            }),
            changed: Arc::new({
                let changes = changes.clone();
                move |c| changes.lock().unwrap().push(c)
            }),
            clip_changed: Arc::new({
                let changes = clip_changes.clone();
                move |path| changes.lock().unwrap().push(path)
            }),
        };
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            tokio::spawn(async move { axum::serve(listener, router(host, TOKEN)).await.unwrap() });
            test(base, reqwest::Client::new(), root, changes, clip_changes).await;
        });
    }

    #[test]
    fn refuses_requests_without_the_token() {
        with_server(async |base, http, _, _, _| {
            let bare = http.get(format!("{base}/v1/tree")).send().await.unwrap();
            assert_eq!(bare.status(), 401);
            let wrong = http
                .get(format!("{base}/v1/tree"))
                .bearer_auth("TEST-TOKEX")
                .send()
                .await
                .unwrap();
            assert_eq!(wrong.status(), 401);
            let right = http
                .get(format!("{base}/v1/tree"))
                .bearer_auth(TOKEN)
                .send()
                .await
                .unwrap();
            assert_eq!(right.status(), 200);
        });
    }

    #[test]
    fn edits_check_the_version_and_tell_the_desktop() {
        with_server(async |base, http, root, changes, _| {
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
                vec![Changed {
                    path: path.clone(),
                    text: Some("from the phone".into())
                }]
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
    fn library_and_offline_notes_round_trip() {
        with_server(async |base, http, root, changes, _| {
            std::fs::create_dir_all(root.join("essays")).unwrap();
            let path = vault::create_doc(&root, "essays", "Repair").unwrap();
            std::fs::create_dir_all(root.join("inspiration")).unwrap();
            std::fs::write(root.join("inspiration/clip.md"), "a clip").unwrap();
            let docs: serde_json::Value = http
                .get(format!("{base}/v1/library"))
                .bearer_auth(TOKEN)
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            let text = std::fs::read_to_string(root.join(&path)).unwrap();
            assert_eq!(docs, json!([{ "path": path, "text": text, "version": vault::version(&text) }]));

            // A note started offline: written where the phone put it, with
            // its folder, once, even if the phone sends it again.
            let put = || {
                http.put(format!("{base}/v1/doc"))
                    .bearer_auth(TOKEN)
                    .json(&json!({ "path": "inbox/on-a-plane.mdx", "text": "on a plane", "base": vault::version("") }))
                    .send()
            };
            assert_eq!(put().await.unwrap().status(), 200);
            assert_eq!(put().await.unwrap().status(), 200);
            assert_eq!(std::fs::read_to_string(root.join("inbox/on-a-plane.mdx")).unwrap(), "on a plane");
            assert_eq!(changes.lock().unwrap().len(), 2);
            let taken = http
                .put(format!("{base}/v1/doc"))
                .bearer_auth(TOKEN)
                .json(&json!({ "path": "inbox/on-a-plane.mdx", "text": "a different note", "base": vault::version("") }))
                .send()
                .await
                .unwrap();
            assert_eq!(taken.status(), 409);
        });
    }

    #[test]
    fn captures_go_to_the_inbox() {
        with_server(async |base, http, root, changes, _| {
            let reply: serde_json::Value = http
                .post(format!("{base}/v1/capture"))
                .bearer_auth(TOKEN)
                .json(
                    &json!({ "text": "Gold seams for AI edits", "capturedAt": "2026-10-29T09:14" }),
                )
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

    const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

    #[test]
    fn hello_advertises_the_clip_api() {
        with_server(async |base, http, root, _, _| {
            let response = http
                .get(format!("{base}/v1/hello"))
                .bearer_auth(TOKEN)
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), 200);
            let body: serde_json::Value = response.json().await.unwrap();
            assert_eq!(
                body,
                json!({ "app": "kintsugi", "api": 4, "vault": root.file_name().unwrap().to_str().unwrap() })
            );
        });
    }

    #[test]
    fn shared_pdfs_are_saved_beside_their_clip_and_bad_files_rejected() {
        with_server(async |base, http, root, _changes, clip_changes| {
            use base64::Engine;
            let pdf = b"%PDF-1.4\n%%EOF\n";
            let encoded = base64::engine::general_purpose::STANDARD.encode(pdf);
            let response = http
                .post(format!("{base}/v1/clips"))
                .bearer_auth(TOKEN)
                .json(&json!({
                    "id": "22222222-2222-4222-8222-222222222222",
                    "file": encoded,
                    "fileType": "application/pdf",
                    "fileName": "../../Field Notes.pdf",
                    "note": "Read the second half",
                    "capturedAt": "2026-10-29T09:14",
                    "via": "share"
                }))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), 200);
            let created: serde_json::Value = response.json().await.unwrap();
            let path = created["path"].as_str().unwrap();
            assert_eq!(path, "inspiration/field-notes.md");
            let clip: serde_json::Value =
                http.get(clip_url(&base, path)).bearer_auth(TOKEN).send().await.unwrap().json().await.unwrap();
            assert_eq!(clip["kind"], "document");
            assert_eq!(clip["file"], "files/field-notes.pdf");
            assert_eq!(std::fs::read(root.join("inspiration/files/field-notes.pdf")).unwrap(), pdf);
            assert_eq!(*clip_changes.lock().unwrap(), vec![path.to_string()]);

            for (body, status) in [
                (json!({ "file": "not base64!", "fileType": "application/pdf" }), 400),
                (json!({ "file": encoded, "fileType": "text/html" }), 400),
                (json!({ "file": encoded }), 400),
                (json!({ "file": base64::engine::general_purpose::STANDARD.encode(b"<html>"), "fileType": "application/pdf" }), 400),
                (json!({ "file": "A".repeat(crate::clip_capture::MAX_ENCODED_FILE_BYTES + 4), "fileType": "application/pdf" }), 413),
            ] {
                let mut body = body;
                body["capturedAt"] = json!("2026-10-29T09:15");
                body["via"] = json!("share");
                let response = http.post(format!("{base}/v1/clips")).bearer_auth(TOKEN).json(&body).send().await.unwrap();
                assert_eq!(response.status(), status, "{}", &body.to_string()[..80.min(body.to_string().len())]);
            }
            assert_eq!(std::fs::read_dir(root.join("inspiration/files")).unwrap().count(), 1);
        });
    }

    #[test]
    fn image_clips_round_trip_and_only_notify_the_clip_library() {
        with_server(async |base, http, root, changes, clip_changes| {
            let response = http
                .post(format!("{base}/v1/clips"))
                .bearer_auth(TOKEN)
                .json(&json!({
                    "title": "Window light",
                    "note": "A private note",
                    "image": PNG,
                    "imageType": "image/png",
                    "capturedAt": "2026-10-29T09:14",
                    "via": "share"
                }))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), 200);
            let created: serde_json::Value = response.json().await.unwrap();
            let path = created["path"].as_str().unwrap();
            assert_eq!(path, "inspiration/window-light.md");

            let response = http
                .get(clip_url(&base, path))
                .bearer_auth(TOKEN)
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), 200);
            let clip: serde_json::Value = response.json().await.unwrap();
            assert_eq!(clip["path"], path);
            assert_eq!(clip["title"], "Window light");
            assert_eq!(clip["kind"], "image");
            assert_eq!(clip["via"], "share");
            assert_eq!(clip["hasSource"], false);
            assert!(clip["text"].as_str().unwrap().contains("A private note"));
            assert_eq!(clip["image"], "media/window-light.png");
            assert_eq!(
                std::fs::read(root.join("inspiration/media/window-light.png")).unwrap(),
                base64::engine::general_purpose::STANDARD
                    .decode(PNG)
                    .unwrap()
            );

            let original = std::fs::read_to_string(root.join(path)).unwrap();
            std::fs::write(
                root.join(path),
                format!("{original}\n## Source\n\nExtracted source, not the writer's words.\n"),
            )
            .unwrap();
            let read: serde_json::Value = http
                .get(clip_url(&base, path))
                .bearer_auth(TOKEN)
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert_eq!(read["hasSource"], true);
            assert!(read["text"].as_str().unwrap().contains("A private note"));
            assert!(!read["text"].as_str().unwrap().contains("Extracted source"));
            assert_eq!(*clip_changes.lock().unwrap(), vec![path.to_string()]);
            assert!(changes.lock().unwrap().is_empty());
        });
    }

    #[test]
    fn retrying_a_clip_id_returns_the_original_path_without_writes_or_events() {
        with_server(async |base, http, root, changes, clip_changes| {
            let body = json!({
                "id": "6d329d64-6bda-4ca9-81d4-3a7e6fbcbcef",
                "title": "Window light", "image": PNG, "imageType": "image/png",
                "capturedAt": "2026-10-29T09:14", "via": "share"
            });
            let post = || http.post(format!("{base}/v1/clips")).bearer_auth(TOKEN).json(&body).send();
            let (a, b) = futures_util::future::join(post(), post()).await;
            let a = a.unwrap();
            let b = b.unwrap();
            assert_eq!(a.status(), 200);
            assert_eq!(b.status(), 200);
            let original: serde_json::Value = a.json().await.unwrap();
            assert_eq!(b.json::<serde_json::Value>().await.unwrap(), original);
            let path = original["path"].as_str().unwrap();
            assert_eq!(vault::clip_list(&root).unwrap().len(), 1);
            vault::clip_trash(&root, path, |paths| {
                for path in paths { std::fs::remove_file(path).map_err(|e| e.to_string())?; }
                Ok(())
            }).unwrap();
            let retry = post().await.unwrap();
            assert_eq!(retry.status(), 200);
            assert_eq!(retry.json::<serde_json::Value>().await.unwrap(), original);
            assert!(vault::clip_list(&root).unwrap().is_empty());
            assert_eq!(std::fs::read_dir(root.join("inspiration/media")).unwrap().count(), 0);
            assert_eq!(*clip_changes.lock().unwrap(), vec![path.to_string()]);
            assert!(changes.lock().unwrap().is_empty());
        });
    }

    #[test]
    fn clip_storage_failures_are_retryable_and_do_not_echo_capture_content() {
        with_server(async |base, http, root, _, clip_changes| {
            std::fs::write(root.join("inspiration"), "blocks clip storage").unwrap();
            let response = http.post(format!("{base}/v1/clips")).bearer_auth(TOKEN)
                .json(&json!({ "id": "6d329d64-6bda-4ca9-81d4-3a7e6fbcbcef", "text": "PRIVATE-CAPTURE-CONTENT", "capturedAt": "2026-10-29T09:14", "via": "phone" }))
                .send().await.unwrap();
            assert_eq!(response.status(), 500);
            assert_eq!(response.json::<serde_json::Value>().await.unwrap()["error"], "Could not save the clip capture. Please retry.");
            assert!(clip_changes.lock().unwrap().is_empty());
        });
    }

    #[test]
    fn clips_list_newest_first_and_stay_out_of_the_document_tree() {
        with_server(async |base, http, root, changes, clip_changes| {
            let empty = http
                .get(format!("{base}/v1/clips"))
                .bearer_auth(TOKEN)
                .send()
                .await
                .unwrap();
            assert_eq!(empty.status(), 200);
            assert_eq!(empty.json::<serde_json::Value>().await.unwrap(), json!([]));
            vault::create_doc(&root, "", "Essay").unwrap();
            let mut paths = Vec::new();
            for (title, captured_at, via) in [
                ("Newest", "2026-10-30T10:00", "phone"),
                ("Oldest", "2026-10-28T10:00", "mac"),
                ("Middle", "2026-10-29T10:00", "share"),
            ] {
                let response = http.post(format!("{base}/v1/clips"))
                    .bearer_auth(TOKEN)
                    .json(&json!({ "title": title, "url": "https://example.com/essay", "text": "Shared passage", "note": "My note", "capturedAt": captured_at, "via": via }))
                    .send().await.unwrap();
                assert_eq!(response.status(), 200);
                let created: serde_json::Value = response.json().await.unwrap();
                paths.push(created["path"].as_str().unwrap().to_string());
            }
            let list: serde_json::Value = http
                .get(format!("{base}/v1/clips"))
                .bearer_auth(TOKEN)
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            let listed: Vec<&str> = list
                .as_array()
                .unwrap()
                .iter()
                .map(|clip| clip["path"].as_str().unwrap())
                .collect();
            assert_eq!(
                listed,
                vec![paths[0].as_str(), paths[2].as_str(), paths[1].as_str()]
            );
            assert_eq!(list[0]["title"], "Newest");
            assert_eq!(list[0]["kind"], "quote");
            let clip: serde_json::Value = http
                .get(clip_url(&base, &paths[0]))
                .bearer_auth(TOKEN)
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert_eq!(clip["url"], "https://example.com/essay");
            assert!(clip["text"].as_str().unwrap().contains("> Shared passage"));
            assert!(clip["text"].as_str().unwrap().contains("My note"));
            let tree: serde_json::Value = http
                .get(format!("{base}/v1/tree"))
                .bearer_auth(TOKEN)
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert_eq!(tree.as_array().unwrap().len(), 1);
            assert_eq!(tree[0]["path"], "essay.mdx");
            assert_eq!(*clip_changes.lock().unwrap(), paths);
            assert!(changes.lock().unwrap().is_empty());
        });
    }

    #[test]
    fn clips_require_pairing_before_parsing_or_mutating() {
        with_server(async |base, http, root, changes, clip_changes| {
            for token in [None, Some("WRONG-TOKEN")] {
                for endpoint in ["/v1/clips", "/v1/clip?path=inspiration/nope.md"] {
                    let mut request = http.get(format!("{base}{endpoint}"));
                    if let Some(token) = token {
                        request = request.bearer_auth(token);
                    }
                    let response = request.send().await.unwrap();
                    assert_eq!(response.status(), 401);
                    assert!(
                        response.json::<serde_json::Value>().await.unwrap()["error"].is_string()
                    );
                }
                let mut request = http.post(format!("{base}/v1/clips")).body("not JSON");
                if let Some(token) = token {
                    request = request.bearer_auth(token);
                }
                assert_eq!(request.send().await.unwrap().status(), 401);
            }
            assert_eq!(std::fs::read_dir(root).unwrap().count(), 0);
            assert!(changes.lock().unwrap().is_empty());
            assert!(clip_changes.lock().unwrap().is_empty());
        });
    }

    #[test]
    fn invalid_clip_bodies_return_json_errors_without_mutating() {
        with_server(async |base, http, root, changes, clip_changes| {
            for body in [
                json!({}),
                json!({ "text": "A note", "via": "phone" }),
                json!({ "text": "A note", "capturedAt": "2026-10-29T10:00" }),
                json!({ "text": "A note", "capturedAt": "2026-10-29T10:00", "via": "PRIVATE-CAPTURE-SECRET" }),
                json!({ "text": "A note", "capturedAt": 42, "via": "phone" }),
                json!({ "image": false, "capturedAt": "2026-10-29T10:00", "via": "phone" }),
                json!({ "url": [], "capturedAt": "2026-10-29T10:00", "via": "phone" }),
                json!({ "id": 42, "text": "A note", "capturedAt": "2026-10-29T10:00", "via": "phone" }),
            ] {
                let response = http
                    .post(format!("{base}/v1/clips"))
                    .bearer_auth(TOKEN)
                    .json(&body)
                    .send()
                    .await
                    .unwrap();
                assert_eq!(response.status(), 422, "body: {body}");
                let error: serde_json::Value = response.json().await.unwrap();
                assert_eq!(error["error"], "Invalid clip capture JSON.");
                assert!(!error.to_string().contains("PRIVATE-CAPTURE-SECRET"));
            }
            let malformed = http
                .post(format!("{base}/v1/clips"))
                .bearer_auth(TOKEN)
                .header(header::CONTENT_TYPE, "application/json")
                .body("{\"text\":")
                .send()
                .await
                .unwrap();
            assert_eq!(malformed.status(), 400);
            assert!(malformed.json::<serde_json::Value>().await.unwrap()["error"].is_string());
            let wrong_content_type = http
                .post(format!("{base}/v1/clips"))
                .bearer_auth(TOKEN)
                .body("{}")
                .send()
                .await
                .unwrap();
            assert_eq!(wrong_content_type.status(), 415);
            assert!(
                wrong_content_type
                    .json::<serde_json::Value>()
                    .await
                    .unwrap()["error"]
                    .is_string()
            );
            assert_eq!(std::fs::read_dir(root).unwrap().count(), 0);
            assert!(changes.lock().unwrap().is_empty());
            assert!(clip_changes.lock().unwrap().is_empty());
        });
    }

    #[test]
    fn rejects_empty_clips_invalid_images_and_unsupported_mime_types() {
        with_server(async |base, http, root, changes, clip_changes| {
            for fields in [
                json!({}),
                json!({ "text": " \n ", "url": " ", "note": " " }),
                json!({ "title": "A title without content" }),
                json!({ "id": "PRIVATE-INVALID-ID", "text": "A note" }),
                json!({ "image": "private-image-invalid-base64!", "imageType": "image/png" }),
                json!({ "image": "", "imageType": "image/png" }),
                json!({ "image": PNG }),
                json!({ "image": PNG, "imageType": "image/svg+xml" }),
                json!({ "image": PNG, "imageType": "text/plain" }),
            ] {
                let mut body = json!({ "capturedAt": "2026-10-29T10:00", "via": "phone" });
                body.as_object_mut()
                    .unwrap()
                    .extend(fields.as_object().unwrap().clone());
                let response = http
                    .post(format!("{base}/v1/clips"))
                    .bearer_auth(TOKEN)
                    .json(&body)
                    .send()
                    .await
                    .unwrap();
                assert_eq!(response.status(), 400);
                let error = response.json::<serde_json::Value>().await.unwrap()["error"]
                    .as_str()
                    .unwrap()
                    .to_string();
                assert!(!error.is_empty());
                assert!(!error.contains(PNG));
                assert!(!error.contains("private-image-invalid-base64"));
                assert!(!error.contains("PRIVATE-INVALID-ID"));
            }
            assert_eq!(std::fs::read_dir(root).unwrap().count(), 0);
            assert!(changes.lock().unwrap().is_empty());
            assert!(clip_changes.lock().unwrap().is_empty());
        });
    }

    #[test]
    fn clip_paths_distinguish_invalid_from_missing_and_reject_symlinks() {
        with_server(async |base, http, root, _, clip_changes| {
            for path in [
                "../secrets.md",
                "/etc/passwd",
                "essay.md",
                "inspiration/media/secret.md",
                "inspiration/nope.mdx",
                "inspiration/nested/nope.md",
                "inspiration",
                "",
            ] {
                let response = http
                    .get(clip_url(&base, path))
                    .bearer_auth(TOKEN)
                    .send()
                    .await
                    .unwrap();
                assert_eq!(response.status(), 400, "path: {path}");
                assert!(response.json::<serde_json::Value>().await.unwrap()["error"].is_string());
            }
            let missing = http
                .get(clip_url(&base, "inspiration/nope.md"))
                .bearer_auth(TOKEN)
                .send()
                .await
                .unwrap();
            assert_eq!(missing.status(), 404);
            assert!(missing.json::<serde_json::Value>().await.unwrap()["error"].is_string());
            let no_query = http
                .get(format!("{base}/v1/clip"))
                .bearer_auth(TOKEN)
                .send()
                .await
                .unwrap();
            assert_eq!(no_query.status(), 400);
            assert!(no_query.json::<serde_json::Value>().await.unwrap()["error"].is_string());
            #[cfg(unix)]
            {
                std::fs::create_dir(root.join("inspiration")).unwrap();
                std::fs::write(root.join("secret.md"), "Not a clip").unwrap();
                std::os::unix::fs::symlink(
                    root.join("secret.md"),
                    root.join("inspiration/shortcut.md"),
                )
                .unwrap();
                let symlink = http
                    .get(clip_url(&base, "inspiration/shortcut.md"))
                    .bearer_auth(TOKEN)
                    .send()
                    .await
                    .unwrap();
                assert_eq!(symlink.status(), 400);
            }
            assert!(clip_changes.lock().unwrap().is_empty());
        });
    }

    #[test]
    fn document_mutation_endpoints_cannot_bypass_clip_updates() {
        with_server(async |base, http, root, changes, clip_changes| {
            let path = vault::clip_create(&root, &vault::ClipCapture {
                url: None, text: Some("Own text".into()), note: None, title: None,
                image: None, image_type: None, file: None, captured_at: "2026-10-29T10:00".into(), via: vault::ClipVia::Phone,
            }).unwrap();
            let write = http.put(format!("{base}/v1/doc")).bearer_auth(TOKEN)
                .json(&json!({"path": path, "text": "overwrite"})).send().await.unwrap();
            assert_eq!(write.status(), 400);
            let create = http.post(format!("{base}/v1/docs")).bearer_auth(TOKEN)
                .json(&json!({"dir": "inspiration", "title": "Not a document"})).send().await.unwrap();
            assert_eq!(create.status(), 400);
            assert_eq!(vault::clip_read(&root, &path).unwrap().text, "Own text");
            assert_eq!(vault::clip_list(&root).unwrap().len(), 1);
            assert!(changes.lock().unwrap().is_empty());
            assert!(clip_changes.lock().unwrap().is_empty());
        });
    }

    #[test]
    fn clip_image_and_request_size_limits_leave_document_limits_unchanged() {
        with_server(async |base, http, root, changes, clip_changes| {
            let mut image = base64::engine::general_purpose::STANDARD
                .decode(PNG)
                .unwrap();
            image.resize(MAX_CLIP_IMAGE_BYTES, 0);
            let encoded = base64::engine::general_purpose::STANDARD.encode(&image);
            let accepted = http.post(format!("{base}/v1/clips"))
                .bearer_auth(TOKEN).json(&json!({ "title": "At the limit", "image": encoded, "imageType": "image/png", "capturedAt": "2026-10-29T10:00", "via": "phone" }))
                .send().await.unwrap();
            assert_eq!(accepted.status(), 200);
            assert_eq!(
                std::fs::metadata(root.join("inspiration/media/at-the-limit.png"))
                    .unwrap()
                    .len(),
                MAX_CLIP_IMAGE_BYTES as u64
            );

            image.push(0);
            let encoded = base64::engine::general_purpose::STANDARD.encode(image);
            let oversized_image = http.post(format!("{base}/v1/clips"))
                .bearer_auth(TOKEN).json(&json!({ "image": encoded, "imageType": "image/png", "capturedAt": "2026-10-29T10:00", "via": "phone" }))
                .send().await.unwrap();
            assert_eq!(oversized_image.status(), 413);
            let error = oversized_image.json::<serde_json::Value>().await.unwrap();
            assert!(error["error"].as_str().unwrap().contains("15 MiB"));
            assert!(error["error"].as_str().unwrap().len() < 100);

            let oversized_body = http.post(format!("{base}/v1/clips"))
                .bearer_auth(TOKEN).json(&json!({ "text": "x".repeat(CLIP_BODY_LIMIT), "capturedAt": "2026-10-29T10:00", "via": "phone" }))
                .send().await.unwrap();
            assert_eq!(oversized_body.status(), 413);
            assert!(oversized_body.json::<serde_json::Value>().await.unwrap()["error"].is_string());
            let old_capture = http
                .post(format!("{base}/v1/capture"))
                .bearer_auth(TOKEN)
                .json(&json!({ "text": "x".repeat(2 * 1024 * 1024 + 1) }))
                .send()
                .await
                .unwrap();
            assert_eq!(old_capture.status(), 413);
            assert_eq!(clip_changes.lock().unwrap().len(), 1);
            assert!(changes.lock().unwrap().is_empty());
        });
    }
}
