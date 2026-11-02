//! The app behind the phone's Feed, Ideas and Kin: each request is the same
//! command the Mac's own webview calls, so ranking, events, captures, Kin's
//! turns and helper jobs behave exactly as they do on the Mac.

use super::sections::{Fail, Op, Outcome, Pending, Sections};
use crate::AppHandle;
use crate::ai::{Chat, chat, ideas};
use crate::feed::{self, NoteWrite, picked};
use serde::Serialize;
use serde_json::json;
use tauri::Manager;

pub struct Desk(pub AppHandle);

fn value<T: Serialize>(result: Result<T, String>) -> Outcome {
    let found = result.map_err(Fail::from)?;
    serde_json::to_value(found).map_err(|e| Fail::Invalid(e.to_string()))
}

impl Sections for Desk {
    fn call(&self, op: Op) -> Pending {
        let app = self.0.clone();
        Box::pin(async move { run(app, op).await })
    }
}

async fn run(app: AppHandle, op: Op) -> Outcome {
    match op {
        Op::Feed { offset, limit } => value(feed::feed_items(app, Some(offset), Some(limit), None)),
        Op::Picked => value(picked::feed_picked(app, None)),
        Op::FeedRead { id, place } => value(feed::feed_read(app, id, Some(place)).await),
        Op::FeedAct { id, action, place } => value(feed::feed_act(app, id, action, Some(place))),
        Op::FeedNote {
            id,
            note,
            base,
            place,
        } => match feed::note_checked(&app, id, &note, base.as_deref(), place)? {
            NoteWrite::Saved(item) => {
                let version = feed::note_version(&item);
                Ok(json!({ "result": "saved", "version": version, "item": item }))
            }
            NoteWrite::Conflict(item) => {
                let current = json!({ "text": item.note.clone().unwrap_or_default(), "version": feed::note_version(&item) });
                Err(Fail::Conflict(
                    json!({ "result": "conflict", "current": current, "item": item }),
                ))
            }
        },
        Op::FeedSave { id, place } => value(feed::feed_save(app, id, Some(place))),
        Op::FeedImpressions(impressions) => {
            value(feed::feed_impressions(app, impressions).map(|()| json!({})))
        }
        Op::FeedEffect { id } => value(picked::feed_effect(app, id)),
        Op::Ideas => value(ideas::ideas_list(app)),
        Op::IdeasMore => value(ideas::ideas_generate(app, None, None)),
        Op::IdeaAdopt { id, title } => {
            // A retried Adopt (the phone never heard back) must not make a
            // second draft: an adopted idea answers with the draft it made.
            let earlier = ideas::ideas_get(app.clone(), vec![id.clone()])?;
            if let Some(adopted) = earlier.first().and_then(|i| i.adopted.as_ref()) {
                let view = ideas::ideas_list(app)?;
                return value(Ok(json!({ "path": adopted.path, "view": view })));
            }
            value(ideas::ideas_adopt(app, id, title, None))
        }
        Op::IdeaDismiss { id, undo: false } => value(ideas::ideas_dismiss(app, id, None)),
        Op::IdeaDismiss { id, undo: true } => value(ideas::ideas_undismiss(app, id)),
        Op::IdeaDiscussed { id } => value(ideas::ideas_discussed(app, id).map(|()| json!({}))),
        Op::Kin { before, limit } => value(chat::kin_chat_log(
            app.state::<Chat>(),
            None,
            before,
            Some(limit),
        )),
        Op::KinSend { text, chips } => {
            value(chat::kin_chat_send(app.state::<Chat>(), text, Some(chips)))
        }
        Op::KinStop => value(chat::kin_chat_stop(app.state::<Chat>()).map(|()| json!({}))),
        Op::KinJobs => value(chat::kin_jobs(app.state::<Chat>())),
    }
}
