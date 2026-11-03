//! The one-time archive scan runs separately from routine source polling.
//! Network work holds no SQLite lock. Only metadata enters the candidate pool.
use super::{Feed, NewItem, Result, changed, now, with};
use crate::AppHandle;
use kintsugi_ingest::{Url, catalogue::Catalogue};
use std::sync::atomic::Ordering;
use tauri::Manager;

pub(super) fn mark_neighbours(app: &AppHandle) {
    app.state::<Feed>()
        .neighbours_dirty
        .store(true, Ordering::Relaxed);
    super::wake(app);
}

pub(super) fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let feed = app.state::<Feed>();
        let Ok(_pass) = feed.cataloguing.try_lock() else {
            return;
        };
        let queued = with(&app, |s| s.due_catalogues()).is_ok_and(|sources| !sources.is_empty());
        let neighbours = feed.neighbours_dirty.swap(false, Ordering::Relaxed);
        let release = with(&app, |s| s.catalogue_release_due(now())).unwrap_or(false);
        if !queued && !neighbours && !release {
            return;
        }
        if queued {
            let _ = discover(&app).await;
        }
        if neighbours {
            let _ = super::neighbours::discover(&app);
        }
        if with(&app, |s| s.catalogue_release_due(now())).unwrap_or(false)
            && super::picked::prepare_catalogue(&app).is_ok()
        {
            changed(&app);
        }
    });
}

async fn discover(app: &AppHandle) -> Result<()> {
    let catalogue = Catalogue::new().map_err(|e| e.to_string())?;
    for source in with(app, |s| s.due_catalogues())? {
        if !with(app, |s| s.start_catalogue(source.id))? {
            continue;
        }
        changed(app);
        let outcome = async {
            let url = Url::parse(&source.url).map_err(|_| "Invalid source URL.".to_string())?;
            let site = source
                .site_url
                .as_deref()
                .and_then(|url| Url::parse(url).ok());
            let report = catalogue
                .discover(&url, site.as_ref())
                .await
                .map_err(|e| e.to_string())?;
            let entries: Vec<NewItem> = report
                .entries
                .into_iter()
                .map(|entry| NewItem {
                    guid: entry.url.clone(),
                    url: Some(entry.url),
                    title: Some(entry.title),
                    media: "article",
                    published_at: entry
                        .published_at
                        .and_then(|date| chrono::DateTime::parse_from_rfc3339(&date).ok())
                        .map(|date| date.timestamp()),
                    ..Default::default()
                })
                .collect();
            with(app, |s| {
                s.insert_catalogue_items(source.id, &entries, now())
            })?;
            if report.truncated {
                return Err("Archive scan reached its limit.".into());
            }
            if entries.is_empty()
                && let Some(issue) = report.issues.first()
            {
                return Err(issue.error.clone());
            }
            Ok(())
        }
        .await;
        // An unfollow while discovery ran is allowed; its rows stay hidden.
        let _ = with(app, |s| {
            s.finish_catalogue(source.id, outcome.as_ref().err().map(String::as_str))
        });
        changed(app);
    }
    Ok(())
}

/// Switching discovery off never mutes new posts. Retry is explicit; ordinary
/// Refresh does not re-scan a source's archives.
#[tauri::command]
pub fn feed_catalogue(
    app: AppHandle,
    id: i64,
    enabled: Option<bool>,
    retry: Option<bool>,
) -> Result<super::Source> {
    let source = with(&app, |s| {
        if let Some(enabled) = enabled {
            s.set_catalogue_enabled(id, enabled)?;
        }
        if retry.unwrap_or(false) {
            s.retry_catalogue(id)?;
        }
        s.source(id)
    })?;
    changed(&app);
    start(&app);
    Ok(source)
}

#[tauri::command]
pub async fn feed_follow_suggestion(app: AppHandle, id: i64) -> Result<super::Source> {
    let item = with(&app, |s| s.item(id))?;
    let target = if let Some(suggestion) = item.suggestion {
        let url =
            Url::parse(&suggestion.source_url).map_err(|_| "Invalid source URL.".to_string())?;
        let feeds = app.state::<Feed>().ingest(&app)?.feeds.clone();
        Some(match feeds.discover(&url).await {
            Ok(feed) => (feed.to_string(), super::SourceKind::Feed),
            Err(_) => (url.to_string(), super::SourceKind::Page),
        })
    } else {
        None
    };
    let source = with(&app, |s| {
        let source = match target.as_ref() {
            Some((url, kind)) => s.follow_suggestion_target(id, now(), url, *kind)?,
            None => s.follow_suggestion(id, now())?,
        };
        s.log(&super::Event {
            at: super::now_ms(),
            kind: "subscribe".into(),
            source_id: Some(source.id),
            ..Default::default()
        })?;
        Ok(source)
    })?;
    super::wake(&app);
    changed(&app);
    Ok(source)
}
