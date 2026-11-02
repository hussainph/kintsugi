//! The Feed, Ideas and Kin on the phone (phone API 6). They live in the
//! app's data, not the vault, and the desktop does all the work: ranking,
//! full text, Kin's turns and its helper jobs all run on the Mac. The phone
//! only reads and asks; it never calls a model and never holds a key.
//!
//! The routes are the HTTP side; [`Sections`] is what they ask the app for,
//! kept abstract so tests can run the server without one.

use super::server::{Ctx, Error};
use crate::ai::prompt::Chip;
use crate::feed::{Action, Impression, Place};
use axum::extract::rejection::{JsonRejection, QueryRejection};
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;

/// One request for the app.
pub enum Op {
    /// The newest-first list (`feed_items`).
    Feed {
        offset: i64,
        limit: i64,
    },
    /// Picked for you (`feed_picked`).
    Picked,
    /// Reading an item: logs an `open` and fetches the full text if needed.
    FeedRead {
        id: i64,
        place: Place,
    },
    FeedAct {
        id: i64,
        action: Action,
        place: Place,
    },
    /// A note, checked against the version of the note it started from.
    FeedNote {
        id: i64,
        note: String,
        base: Option<String>,
        place: Place,
    },
    FeedSave {
        id: i64,
        place: Place,
    },
    FeedImpressions(Vec<Impression>),
    /// What a like changed in Picked for you.
    FeedEffect {
        id: i64,
    },
    Ideas,
    /// "Ask for more": a few ideas on demand.
    IdeasMore,
    /// A new draft from the idea. An idea already adopted answers with its draft.
    IdeaAdopt {
        id: String,
        title: Option<String>,
    },
    IdeaDismiss {
        id: String,
        undo: bool,
    },
    IdeaDiscussed {
        id: String,
    },
    /// The one conversation, newest last.
    Kin {
        before: Option<u64>,
        limit: usize,
    },
    KinSend {
        text: String,
        chips: Vec<Chip>,
    },
    KinStop,
    KinJobs,
}

/// Why the app couldn't do it.
#[derive(Debug)]
pub enum Fail {
    /// 400: the request can't be done as asked (an unknown item, an empty message).
    Invalid(String),
    /// 409, for a note: what the Mac has now. Nothing was written.
    Conflict(Value),
    /// 503: the app isn't ready (Kin still starting).
    Unavailable(String),
}

impl From<String> for Fail {
    fn from(message: String) -> Self {
        if message.contains("isn't ready") {
            Fail::Unavailable(message)
        } else {
            Fail::Invalid(message)
        }
    }
}

pub type Outcome = Result<Value, Fail>;
pub type Pending = Pin<Box<dyn Future<Output = Outcome> + Send>>;

/// The app's Feed, Ideas and Kin.
pub trait Sections: Send + Sync {
    fn call(&self, op: Op) -> Pending;
}

const NO_SECTIONS: &str = "The Feed, Ideas and Kin need Kintsugi running on your Mac.";

async fn ask(ctx: &Ctx, op: Op) -> Result<Value, Error> {
    let sections = ctx
        .host
        .sections
        .clone()
        .ok_or_else(|| Error(StatusCode::SERVICE_UNAVAILABLE, NO_SECTIONS.into()))?;
    sections.call(op).await.map_err(|fail| match fail {
        Fail::Invalid(message) => Error(StatusCode::BAD_REQUEST, message),
        Fail::Unavailable(message) => Error(StatusCode::SERVICE_UNAVAILABLE, message),
        // Only the note route returns a conflict, and it handles it itself.
        Fail::Conflict(_) => Error(StatusCode::CONFLICT, "That changed on your Mac.".into()),
    })
}

/// A body parsed without echoing what was sent (it can carry private words).
fn body<T>(body: Result<Json<T>, JsonRejection>) -> Result<T, Error> {
    body.map(|Json(b)| b)
        .map_err(|e| Error(e.status(), "Invalid request JSON.".into()))
}

fn query<T>(query: Result<Query<T>, QueryRejection>) -> Result<T, Error> {
    query
        .map(|Query(q)| q)
        .map_err(|_| Error(StatusCode::BAD_REQUEST, "Invalid query.".into()))
}

pub(super) fn routes() -> Router<Ctx> {
    Router::new()
        .route("/v1/feed", get(feed))
        .route("/v1/feed/picked", get(picked))
        .route("/v1/feed/read", post(feed_read))
        .route("/v1/feed/act", post(feed_act))
        .route("/v1/feed/note", axum::routing::put(feed_note))
        .route("/v1/feed/save", post(feed_save))
        .route("/v1/feed/impressions", post(feed_impressions))
        .route("/v1/feed/effect", get(feed_effect))
        .route("/v1/ideas", get(ideas))
        .route("/v1/ideas/more", post(ideas_more))
        .route("/v1/ideas/adopt", post(idea_adopt))
        .route("/v1/ideas/dismiss", post(idea_dismiss))
        .route("/v1/ideas/discussed", post(idea_discussed))
        .route("/v1/kin", get(kin).post(kin_send))
        .route("/v1/kin/stop", post(kin_stop))
        .route("/v1/kin/jobs", get(kin_jobs))
}

type Reply = Result<Json<Value>, Error>;

// ── Feed ──────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct PageQuery {
    offset: Option<i64>,
    limit: Option<i64>,
}

async fn feed(State(ctx): State<Ctx>, q: Result<Query<PageQuery>, QueryRejection>) -> Reply {
    let q = query(q)?;
    let op = Op::Feed {
        offset: q.offset.unwrap_or(0).max(0),
        limit: q.limit.unwrap_or(40).clamp(1, 100),
    };
    Ok(Json(ask(&ctx, op).await?))
}

async fn picked(State(ctx): State<Ctx>) -> Reply {
    Ok(Json(ask(&ctx, Op::Picked).await?))
}

#[derive(Deserialize)]
struct ItemBody {
    id: i64,
    #[serde(default)]
    place: Option<Place>,
}

async fn feed_read(State(ctx): State<Ctx>, b: Result<Json<ItemBody>, JsonRejection>) -> Reply {
    let b = body(b)?;
    Ok(Json(
        ask(
            &ctx,
            Op::FeedRead {
                id: b.id,
                place: b.place.unwrap_or_default(),
            },
        )
        .await?,
    ))
}

#[derive(Deserialize)]
struct ActBody {
    id: i64,
    action: Action,
    #[serde(default)]
    place: Option<Place>,
}

async fn feed_act(State(ctx): State<Ctx>, b: Result<Json<ActBody>, JsonRejection>) -> Reply {
    let b = body(b)?;
    Ok(Json(
        ask(
            &ctx,
            Op::FeedAct {
                id: b.id,
                action: b.action,
                place: b.place.unwrap_or_default(),
            },
        )
        .await?,
    ))
}

#[derive(Deserialize)]
struct NoteBody {
    id: i64,
    note: String,
    /// The version of the note the phone started from; omitted only to
    /// overwrite on purpose.
    base: Option<String>,
    #[serde(default)]
    place: Option<Place>,
}

/// `{ result: "saved", version, item }`, or 409 with
/// `{ result: "conflict", current: { text, version }, item }`.
async fn feed_note(
    State(ctx): State<Ctx>,
    b: Result<Json<NoteBody>, JsonRejection>,
) -> Result<Response, Error> {
    let b = body(b)?;
    let sections = ctx
        .host
        .sections
        .clone()
        .ok_or_else(|| Error(StatusCode::SERVICE_UNAVAILABLE, NO_SECTIONS.into()))?;
    let op = Op::FeedNote {
        id: b.id,
        note: b.note,
        base: b.base,
        place: b.place.unwrap_or_default(),
    };
    Ok(match sections.call(op).await {
        Ok(saved) => (StatusCode::OK, Json(saved)).into_response(),
        Err(Fail::Conflict(current)) => (StatusCode::CONFLICT, Json(current)).into_response(),
        Err(Fail::Invalid(message)) => return Err(Error(StatusCode::BAD_REQUEST, message)),
        Err(Fail::Unavailable(message)) => {
            return Err(Error(StatusCode::SERVICE_UNAVAILABLE, message));
        }
    })
}

async fn feed_save(State(ctx): State<Ctx>, b: Result<Json<ItemBody>, JsonRejection>) -> Reply {
    let b = body(b)?;
    Ok(Json(
        ask(
            &ctx,
            Op::FeedSave {
                id: b.id,
                place: b.place.unwrap_or_default(),
            },
        )
        .await?,
    ))
}

#[derive(Deserialize)]
struct ImpressionsBody {
    impressions: Vec<Impression>,
}

async fn feed_impressions(
    State(ctx): State<Ctx>,
    b: Result<Json<ImpressionsBody>, JsonRejection>,
) -> Reply {
    let b = body(b)?;
    if b.impressions.len() > 500 {
        return Err(Error(
            StatusCode::BAD_REQUEST,
            "Too many impressions at once.".into(),
        ));
    }
    Ok(Json(ask(&ctx, Op::FeedImpressions(b.impressions)).await?))
}

#[derive(Deserialize)]
struct IdQuery {
    id: i64,
}

async fn feed_effect(State(ctx): State<Ctx>, q: Result<Query<IdQuery>, QueryRejection>) -> Reply {
    let q = query(q)?;
    Ok(Json(ask(&ctx, Op::FeedEffect { id: q.id }).await?))
}

// ── Ideas ─────────────────────────────────────────────────────────────────

async fn ideas(State(ctx): State<Ctx>) -> Reply {
    Ok(Json(ask(&ctx, Op::Ideas).await?))
}

async fn ideas_more(State(ctx): State<Ctx>) -> Reply {
    Ok(Json(ask(&ctx, Op::IdeasMore).await?))
}

#[derive(Deserialize)]
struct AdoptBody {
    id: String,
    title: Option<String>,
}

async fn idea_adopt(State(ctx): State<Ctx>, b: Result<Json<AdoptBody>, JsonRejection>) -> Reply {
    let b = body(b)?;
    Ok(Json(
        ask(
            &ctx,
            Op::IdeaAdopt {
                id: b.id,
                title: b.title,
            },
        )
        .await?,
    ))
}

#[derive(Deserialize)]
struct DismissBody {
    id: String,
    #[serde(default)]
    undo: bool,
}

async fn idea_dismiss(
    State(ctx): State<Ctx>,
    b: Result<Json<DismissBody>, JsonRejection>,
) -> Reply {
    let b = body(b)?;
    Ok(Json(
        ask(
            &ctx,
            Op::IdeaDismiss {
                id: b.id,
                undo: b.undo,
            },
        )
        .await?,
    ))
}

#[derive(Deserialize)]
struct IdeaBody {
    id: String,
}

async fn idea_discussed(State(ctx): State<Ctx>, b: Result<Json<IdeaBody>, JsonRejection>) -> Reply {
    let b = body(b)?;
    Ok(Json(ask(&ctx, Op::IdeaDiscussed { id: b.id }).await?))
}

// ── Kin ───────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct LogQuery {
    before: Option<u64>,
    limit: Option<usize>,
}

/// The conversation's latest entries (every thread, newest last), its
/// threads, the messages still waiting and whether Kin is answering.
async fn kin(State(ctx): State<Ctx>, q: Result<Query<LogQuery>, QueryRejection>) -> Reply {
    let q = query(q)?;
    Ok(Json(
        ask(
            &ctx,
            Op::Kin {
                before: q.before,
                limit: q.limit.unwrap_or(100).clamp(1, 500),
            },
        )
        .await?,
    ))
}

#[derive(Deserialize)]
struct SendBody {
    /// The phone's id for the message, so one sent again after an
    /// uncertain failure (or from the offline queue) lands once.
    id: String,
    text: String,
    #[serde(default)]
    chips: Vec<Chip>,
}

/// The phone's message ids that already reached the log, oldest first,
/// persisted beside the capture receipts so a retry after a restart still
/// lands once.
pub(super) struct Receipts {
    path: Option<PathBuf>,
    sent: VecDeque<(String, u64)>,
}

const KEPT_RECEIPTS: usize = 500;

impl Receipts {
    pub(super) fn open(path: Option<PathBuf>) -> Self {
        let sent = path
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|text| serde_json::from_str::<VecDeque<(String, u64)>>(&text).ok())
            .unwrap_or_default();
        Receipts { path, sent }
    }

    fn seq(&self, id: &str) -> Option<u64> {
        self.sent
            .iter()
            .find(|(sent, _)| sent == id)
            .map(|(_, seq)| *seq)
    }

    fn record(&mut self, id: String, seq: u64) {
        self.sent.push_back((id, seq));
        while self.sent.len() > KEPT_RECEIPTS {
            self.sent.pop_front();
        }
        if let Some(path) = &self.path {
            if let Ok(text) = serde_json::to_string(&self.sent) {
                // Best effort: the message is in the log either way.
                let _ = kintsugi_vault::write_atomic(path, &text);
            }
        }
    }
}

fn valid_id(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

const MAX_CHIP_LABEL: usize = 200;
const PHONE_CHIPS: [&str; 4] = ["doc", "clip", "feed", "idea"];

/// `{ entry, duplicate }`: the message as it landed in the log. A message id
/// seen before answers `{ seq, duplicate: true }` without sending it again.
async fn kin_send(State(ctx): State<Ctx>, b: Result<Json<SendBody>, JsonRejection>) -> Reply {
    let b = body(b)?;
    if !valid_id(&b.id) {
        return Err(Error(
            StatusCode::BAD_REQUEST,
            "A message id is required.".into(),
        ));
    }
    if b.chips.len() > 12
        || b.chips.iter().any(|c| {
            !PHONE_CHIPS.contains(&c.kind.as_str())
                || c.path.len() > 1024
                || c.label.as_ref().is_some_and(|l| l.len() > MAX_CHIP_LABEL)
        })
    {
        return Err(Error(
            StatusCode::BAD_REQUEST,
            "The phone can attach documents, clips, feed items and ideas.".into(),
        ));
    }
    // One send at a time, so a retry racing the original still lands once.
    let mut receipts = ctx.kin_sent.lock().await;
    if let Some(seq) = receipts.seq(&b.id) {
        return Ok(Json(json!({ "seq": seq, "duplicate": true })));
    }
    let entry = ask(
        &ctx,
        Op::KinSend {
            text: b.text,
            chips: b.chips,
        },
    )
    .await?;
    if let Some(seq) = entry.get("seq").and_then(Value::as_u64) {
        receipts.record(b.id, seq);
    }
    Ok(Json(json!({ "entry": entry, "duplicate": false })))
}

async fn kin_stop(State(ctx): State<Ctx>) -> Reply {
    Ok(Json(ask(&ctx, Op::KinStop).await?))
}

async fn kin_jobs(State(ctx): State<Ctx>) -> Reply {
    Ok(Json(ask(&ctx, Op::KinJobs).await?))
}

#[cfg(test)]
mod tests {
    use super::super::server::tests::{TOKEN, with_sections};
    use super::*;
    use std::sync::{Arc, Mutex};

    /// Answers every request with what it was asked, and records it.
    #[derive(Default)]
    struct Fake {
        asked: Mutex<Vec<String>>,
        sends: Mutex<u64>,
    }

    impl Sections for Fake {
        fn call(&self, op: Op) -> Pending {
            let (name, answer): (String, Outcome) = match op {
                Op::Feed { offset, limit } => (
                    format!("feed {offset} {limit}"),
                    Ok(json!({ "items": [], "total": 0 })),
                ),
                Op::Picked => ("picked".into(), Ok(json!({ "picks": [] }))),
                Op::FeedRead { id, place } => (
                    format!("read {id} {:?} {:?}", place.surface, place.position),
                    Ok(json!({ "text": null })),
                ),
                Op::FeedAct { id, action, place } => (
                    format!("act {id} {action:?} {:?}", place.surface),
                    Ok(json!({ "id": id })),
                ),
                Op::FeedNote { id, note, base, .. } => match base.as_deref() {
                    Some("stale") => (
                        format!("note {id}"),
                        Err(Fail::Conflict(
                            json!({ "result": "conflict", "current": { "text": "mac", "version": "v2" } }),
                        )),
                    ),
                    _ => (
                        format!("note {id} {note}"),
                        Ok(json!({ "result": "saved", "version": "v3" })),
                    ),
                },
                Op::FeedSave { id, .. } => (
                    format!("save {id}"),
                    Ok(json!({ "savedPath": "inspiration/x.md" })),
                ),
                Op::FeedImpressions(list) => (format!("impressions {}", list.len()), Ok(json!({}))),
                Op::FeedEffect { id } => (format!("effect {id}"), Ok(json!({ "changes": [] }))),
                Op::Ideas => ("ideas".into(), Ok(json!({ "ideas": [] }))),
                Op::IdeasMore => (
                    "more".into(),
                    Err(Fail::Invalid("Kin is already finding ideas.".into())),
                ),
                Op::IdeaAdopt { id, title } => (
                    format!("adopt {id} {title:?}"),
                    Ok(json!({ "path": "drafts/x.mdx" })),
                ),
                Op::IdeaDismiss { id, undo } => {
                    (format!("dismiss {id} {undo}"), Ok(json!({ "ideas": [] })))
                }
                Op::IdeaDiscussed { id } => (format!("discussed {id}"), Ok(json!({}))),
                Op::Kin { before, limit } => (
                    format!("kin {before:?} {limit}"),
                    Ok(json!({ "entries": [] })),
                ),
                Op::KinSend { text, chips } => {
                    let mut sends = self.sends.lock().unwrap();
                    *sends += 1;
                    (
                        format!("send {text} {}", chips.len()),
                        Ok(json!({ "seq": *sends, "text": text })),
                    )
                }
                Op::KinStop => (
                    "stop".into(),
                    Err(Fail::Unavailable("Kin isn't ready yet.".into())),
                ),
                Op::KinJobs => ("jobs".into(), Ok(json!([]))),
            };
            self.asked.lock().unwrap().push(name);
            Box::pin(async move { answer })
        }
    }

    #[test]
    fn routes_ask_the_app_and_map_its_answers() {
        let fake = Arc::new(Fake::default());
        with_sections(Some(fake.clone()), None, async |base, http, _, _, _| {
            let get = |path: &str| http.get(format!("{base}{path}")).bearer_auth(TOKEN).send();
            let post = |path: &str, body: Value| {
                http.post(format!("{base}{path}"))
                    .bearer_auth(TOKEN)
                    .json(&body)
                    .send()
            };
            assert_eq!(
                get("/v1/feed?offset=-3&limit=1000").await.unwrap().status(),
                200
            );
            assert_eq!(get("/v1/feed/picked").await.unwrap().status(), 200);
            let place = json!({ "surface": "picked", "position": 2 });
            assert_eq!(
                post("/v1/feed/read", json!({ "id": 4, "place": place }))
                    .await
                    .unwrap()
                    .status(),
                200
            );
            assert_eq!(
                post(
                    "/v1/feed/act",
                    json!({ "id": 4, "action": "notInterested", "place": place })
                )
                .await
                .unwrap()
                .status(),
                200
            );
            // An action the Mac doesn't know is refused before it is asked.
            assert_eq!(
                post("/v1/feed/act", json!({ "id": 4, "action": "delete" }))
                    .await
                    .unwrap()
                    .status(),
                422
            );
            let saved = http
                .put(format!("{base}/v1/feed/note"))
                .bearer_auth(TOKEN)
                .json(&json!({ "id": 4, "note": "mine", "base": "v1" }))
                .send()
                .await
                .unwrap();
            assert_eq!(saved.status(), 200);
            let stale = http
                .put(format!("{base}/v1/feed/note"))
                .bearer_auth(TOKEN)
                .json(&json!({ "id": 4, "note": "mine", "base": "stale" }))
                .send()
                .await
                .unwrap();
            assert_eq!(stale.status(), 409);
            assert_eq!(
                stale.json::<Value>().await.unwrap()["current"]["text"],
                "mac"
            );
            assert_eq!(
                post("/v1/feed/save", json!({ "id": 4 }))
                    .await
                    .unwrap()
                    .status(),
                200
            );
            let many: Vec<Value> = (0..501)
                .map(|i| json!({ "id": i, "position": i, "surface": "newest" }))
                .collect();
            assert_eq!(
                post("/v1/feed/impressions", json!({ "impressions": many }))
                    .await
                    .unwrap()
                    .status(),
                400
            );
            assert_eq!(
                post(
                    "/v1/feed/impressions",
                    json!({ "impressions": [{ "id": 4, "position": 0, "surface": "newest" }] })
                )
                .await
                .unwrap()
                .status(),
                200
            );
            assert_eq!(get("/v1/feed/effect?id=4").await.unwrap().status(), 200);
            assert_eq!(get("/v1/feed/effect?id=four").await.unwrap().status(), 400);
            assert_eq!(get("/v1/ideas").await.unwrap().status(), 200);
            let busy = post("/v1/ideas/more", json!({})).await.unwrap();
            assert_eq!(busy.status(), 400);
            assert_eq!(
                busy.json::<Value>().await.unwrap()["error"],
                "Kin is already finding ideas."
            );
            assert_eq!(
                post("/v1/ideas/adopt", json!({ "id": "idea-1" }))
                    .await
                    .unwrap()
                    .status(),
                200
            );
            assert_eq!(
                post("/v1/ideas/dismiss", json!({ "id": "idea-1", "undo": true }))
                    .await
                    .unwrap()
                    .status(),
                200
            );
            assert_eq!(
                post("/v1/ideas/discussed", json!({ "id": "idea-1" }))
                    .await
                    .unwrap()
                    .status(),
                200
            );
            assert_eq!(get("/v1/kin?before=9").await.unwrap().status(), 200);
            assert_eq!(post("/v1/kin/stop", json!({})).await.unwrap().status(), 503);
            assert_eq!(get("/v1/kin/jobs").await.unwrap().status(), 200);
        });
        assert_eq!(
            *fake.asked.lock().unwrap(),
            [
                "feed 0 100",
                "picked",
                "read 4 Some(\"picked\") Some(2)",
                "act 4 NotInterested Some(\"picked\")",
                "note 4 mine",
                "note 4",
                "save 4",
                "impressions 1",
                "effect 4",
                "ideas",
                "more",
                "adopt idea-1 None",
                "dismiss idea-1 true",
                "discussed idea-1",
                "kin Some(9) 100",
                "stop",
                "jobs",
            ]
        );
    }

    #[test]
    fn a_kin_message_sent_again_lands_once_even_after_a_restart() {
        let config = tempfile::tempdir().unwrap();
        let ids = config.path().join("phone-kin-ids.json");
        let fake = Arc::new(Fake::default());
        let message = json!({ "id": "6d329d64-6bda-4ca9-81d4-3a7e6fbcbcef", "text": "Is this any good?", "chips": [{ "kind": "clip", "path": "inspiration/a.md", "label": "A" }] });
        for _ in 0..2 {
            let message = message.clone();
            with_sections(
                Some(fake.clone()),
                Some(ids.clone()),
                async move |base, http, _, _, _| {
                    let send = || {
                        http.post(format!("{base}/v1/kin"))
                            .bearer_auth(TOKEN)
                            .json(&message)
                            .send()
                    };
                    let (a, b) = futures_util::future::join(send(), send()).await;
                    let (a, b): (Value, Value) = (
                        a.unwrap().json().await.unwrap(),
                        b.unwrap().json().await.unwrap(),
                    );
                    let first = if a["duplicate"] == false { &a } else { &b };
                    let second = if a["duplicate"] == false { &b } else { &a };
                    // After the restart both are duplicates of the first run's send.
                    assert!(first["duplicate"] == true || first["entry"]["seq"] == 1);
                    assert_eq!(second["duplicate"], true);
                    assert_eq!(second["seq"], 1);
                },
            );
        }
        assert_eq!(
            *fake.sends.lock().unwrap(),
            1,
            "the message reached Kin more than once"
        );
        for (body, status) in [
            (json!({ "text": "no id" }), 422),
            (json!({ "id": "short", "text": "hi" }), 400),
            (json!({ "id": "../../etc/passwd-0000", "text": "hi" }), 400),
            (
                json!({ "id": "7d329d64-6bda-4ca9-81d4-3a7e6fbcbcef", "text": "hi", "chips": [{ "kind": "paragraph", "path": "a.md" }] }),
                400,
            ),
            (
                json!({ "id": "7d329d64-6bda-4ca9-81d4-3a7e6fbcbcef", "text": "PRIVATE-WORDS", "chips": "nope" }),
                422,
            ),
        ] {
            with_sections(Some(fake.clone()), None, async |base, http, _, _, _| {
                let response = http
                    .post(format!("{base}/v1/kin"))
                    .bearer_auth(TOKEN)
                    .json(&body)
                    .send()
                    .await
                    .unwrap();
                assert_eq!(response.status(), status, "{body}");
                assert!(!response.text().await.unwrap().contains("PRIVATE-WORDS"));
            });
        }
        assert_eq!(*fake.sends.lock().unwrap(), 1);
    }

    #[test]
    fn without_the_app_the_sections_say_they_need_the_mac_and_all_need_pairing() {
        with_sections(None, None, async |base, http, _, _, _| {
            for path in [
                "/v1/feed",
                "/v1/feed/picked",
                "/v1/ideas",
                "/v1/kin",
                "/v1/kin/jobs",
            ] {
                let response = http
                    .get(format!("{base}{path}"))
                    .bearer_auth(TOKEN)
                    .send()
                    .await
                    .unwrap();
                assert_eq!(response.status(), 503, "{path}");
                assert_eq!(
                    response.json::<Value>().await.unwrap()["error"],
                    NO_SECTIONS
                );
                assert_eq!(
                    http.get(format!("{base}{path}"))
                        .send()
                        .await
                        .unwrap()
                        .status(),
                    401,
                    "{path}"
                );
            }
            for path in [
                "/v1/feed/act",
                "/v1/feed/save",
                "/v1/ideas/adopt",
                "/v1/kin",
                "/v1/kin/stop",
            ] {
                let response = http
                    .post(format!("{base}{path}"))
                    .bearer_auth("WRONG")
                    .json(&json!({}))
                    .send()
                    .await
                    .unwrap();
                assert_eq!(response.status(), 401, "{path}");
            }
        });
    }
}
