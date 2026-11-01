//! Enrichment writes only through the vault's per-clip lock and patch APIs.
//! The vault owns Markdown/source boundaries, media names and concurrent edits;
//! the worker never renders a clip file or saves a previously read body.

use super::tags;
use kintsugi_ingest::{MediaData as Image, media::image_mime};
use kintsugi_vault::{self as vault, ClipKind, ClipUpdate};
use std::path::Path;

pub use vault::Clip;
type Result<T> = std::result::Result<T, String>;

#[derive(Debug, Clone, Default)]
pub struct Update {
    pub title: Option<String>,
    pub summary: String,
    pub tags: Vec<String>,
    pub kind: String,
    pub site: Option<String>,
    pub author: Option<String>,
    pub source_text: Option<String>,
    pub image: Option<Image>,
}

/// The seam keeps worker tests independent of network, credentials and disk.
pub trait Store {
    fn pending(&self, root: &Path) -> Result<Vec<Clip>>;
    fn tags(&self, root: &Path) -> Result<Vec<String>>;
    fn apply(&self, root: &Path, clip: &Clip, update: &Update) -> Result<()>;
    fn fail(&self, root: &Path, clip: &Clip, message: &str) -> Result<()>;
}

pub struct VaultStore;

impl Store for VaultStore {
    fn pending(&self, root: &Path) -> Result<Vec<Clip>> {
        let pending = vault::clips_needing_enrichment(root).map_err(|_| "could not list clips for enrichment")?;
        Ok(pending
            .into_iter()
            .filter_map(|summary| {
                // A clip can be edited, finished or trashed between listing and read.
                vault::clip_read(root, &summary.path)
                    .ok()
                    .filter(|clip| clip.summary.enriched.is_none() && clip.summary.enrich_error.is_none())
            })
            .collect())
    }

    fn tags(&self, root: &Path) -> Result<Vec<String>> {
        tags::vocabulary(root)
    }

    fn apply(&self, root: &Path, clip: &Clip, update: &Update) -> Result<()> {
        let baseline = &clip.summary;
        let current = vault::clip_read(root, &baseline.path).map_err(|_| "could not read clip for enrichment")?;
        if current.summary.enriched.is_some() {
            return Ok(());
        }
        let kind: ClipKind = serde_json::from_value(serde_json::json!(update.kind)).map_err(|_| "invalid enrichment kind")?;
        let mut tags = baseline.tags.clone();
        for tag in &update.tags {
            if !tags.contains(tag) {
                tags.push(tag.clone());
            }
        }
        let patch = ClipUpdate {
            title: update.title.clone(),
            // A saved PDF or EPUB stays a document or book whatever the model says.
            kind: (current.summary.kind == baseline.kind && baseline.file.is_none()).then_some(kind),
            site: current.summary.site.is_none().then(|| update.site.clone()).flatten(),
            author: current.summary.author.is_none().then(|| update.author.clone()).flatten(),
            tags: Some(tags),
            summary: Some(update.summary.clone()),
            source: update.source_text.clone(),
            enriched: Some(chrono::Local::now().format("%Y-%m-%dT%H:%M").to_string()),
            enrich_error: Some(String::new()),
            // No note, URL or image patch: own text is inaccessible here, and
            // clip_save_media alone owns fill-only image installation.
            ..ClipUpdate::default()
        };
        if baseline.image.is_none() {
            if let Some(image) = &update.image {
                if image_mime(&image.bytes) == Some(image.mime.as_str()) {
                    // Best effort. The shared lock makes an arriving screenshot
                    // win, and a trashed clip cannot be resurrected by media.
                    let _ = vault::clip_save_media(root, &baseline.path, &image.bytes, &image.mime);
                }
            }
        }
        vault::clip_enrich(root, &baseline.path, baseline, &patch)
            .map(drop)
            .map_err(|_| "could not save clip enrichment".into())
    }

    fn fail(&self, root: &Path, clip: &Clip, message: &str) -> Result<()> {
        let baseline = &clip.summary;
        let current = vault::clip_read(root, &baseline.path).map_err(|_| "could not read clip for enrichment")?;
        if current.summary.enriched.is_some() {
            return Ok(());
        }
        // Callers provide fixed fetch/think/storage errors, never provider text.
        let message: String = message
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .filter(|c| !c.is_control())
            .take(200)
            .collect();
        let patch = ClipUpdate {
            enrich_error: Some(message),
            ..ClipUpdate::default()
        };
        vault::clip_enrich(root, &baseline.path, baseline, &patch)
            .map(drop)
            .map_err(|_| "could not save clip enrichment error".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        sync::{Arc, Barrier},
    };
    use vault::{ClipCapture, ClipVia};

    fn capture(root: &Path, text: &str) -> String {
        vault::clip_create(
            root,
            &ClipCapture {
                text: Some(text.into()),
                url: None,
                note: None,
                title: None,
                image: None,
                image_type: None,
                file: None,
                captured_at: "2026-10-29T14:05".into(),
                via: ClipVia::Mac,
            },
        )
        .unwrap()
    }

    fn image() -> Image {
        Image {
            bytes: b"\x89PNG\r\n\x1a\nhero".to_vec(),
            mime: "image/png".into(),
        }
    }

    fn update() -> Update {
        Update {
            title: Some("Organized title".into()),
            summary: "A useful idea.".into(),
            tags: vec!["writing".into(), "ideas".into()],
            kind: "note".into(),
            source_text: Some("Extracted text.".into()),
            image: Some(image()),
            ..Update::default()
        }
    }

    #[test]
    fn the_vault_owns_source_boundaries_even_in_arbitrary_writer_markdown() {
        let dir = tempfile::tempdir().unwrap();
        let path = capture(
            dir.path(),
            "My note.\n\n## Source\nMy own heading.\n\n```markdown\nAn unfinished example",
        );
        let before = vault::clip_read(dir.path(), &path).unwrap();
        VaultStore.apply(dir.path(), &before, &update()).unwrap();
        let after = vault::clip_read(dir.path(), &path).unwrap();
        assert_eq!(before.text, after.text);
        assert_eq!(after.source.as_deref(), Some("Extracted text."));
        assert!(
            fs::read_to_string(dir.path().join(&path))
                .unwrap()
                .contains("<!-- kintsugi:source -->")
        );
        assert!(after.summary.enriched.is_some());
        assert!(VaultStore.pending(dir.path()).unwrap().is_empty());
    }

    #[test]
    fn writeback_keeps_writer_edits_and_a_screenshot_arriving_during_fetch() {
        let dir = tempfile::tempdir().unwrap();
        let path = capture(dir.path(), "Before fetching.");
        let before = vault::clip_read(dir.path(), &path).unwrap();
        vault::clip_update(
            dir.path(),
            &path,
            &ClipUpdate {
                note: Some("My revised note.".into()),
                title: Some("My title".into()),
                tags: Some(vec!["mine".into()]),
                ..ClipUpdate::default()
            },
        )
        .unwrap();
        let screenshot = b"\x89PNG\r\n\x1a\nscreenshot";
        let media = vault::clip_save_media(dir.path(), &path, screenshot, "image/png").unwrap();
        VaultStore.apply(dir.path(), &before, &update()).unwrap();
        let after = vault::clip_read(dir.path(), &path).unwrap();
        assert_eq!(after.text, "My revised note.");
        assert_eq!(after.summary.title.as_deref(), Some("My title"));
        assert_eq!(after.summary.tags, ["mine"]);
        assert_eq!(after.source.as_deref(), Some("Extracted text."));
        assert_eq!(
            fs::read(vault::clip_media_path(dir.path(), &path, &media).unwrap()).unwrap(),
            screenshot
        );
    }

    #[test]
    fn the_adapter_shares_the_writer_and_media_lock_under_interleaving() {
        let dir = tempfile::tempdir().unwrap();
        for _ in 0..12 {
            let path = capture(dir.path(), "Before.");
            let before = vault::clip_read(dir.path(), &path).unwrap();
            let barrier = Arc::new(Barrier::new(3));
            std::thread::scope(|scope| {
                let ready = barrier.clone();
                let path = &path;
                let root = dir.path();
                scope.spawn(move || {
                    ready.wait();
                    vault::clip_update(
                        root,
                        path,
                        &ClipUpdate {
                            note: Some("Writer's current words.".into()),
                            tags: Some(vec!["mine".into()]),
                            ..ClipUpdate::default()
                        },
                    )
                    .unwrap();
                });
                let ready = barrier.clone();
                let before = &before;
                scope.spawn(move || {
                    ready.wait();
                    VaultStore.apply(root, before, &update()).unwrap();
                });
                let ready = barrier.clone();
                scope.spawn(move || {
                    ready.wait();
                    vault::clip_save_media(root, path, b"capture", "image/jpeg").unwrap();
                });
            });
            let after = vault::clip_read(dir.path(), &path).unwrap();
            assert_eq!(after.text, "Writer's current words.");
            assert_eq!(after.summary.tags, ["mine"]);
            assert_eq!(after.source.as_deref(), Some("Extracted text."));
            assert!(after.summary.image.is_some());
            assert!(after.summary.summary.is_some());
        }
    }

    #[test]
    fn a_trashed_clip_is_never_recreated_by_success_or_failure() {
        let dir = tempfile::tempdir().unwrap();
        let path = capture(dir.path(), "Throw this away.");
        let before = vault::clip_read(dir.path(), &path).unwrap();
        vault::clip_trash(dir.path(), &path, |targets| {
            for target in targets {
                fs::remove_file(target).unwrap();
            }
            Ok(())
        })
        .unwrap();
        assert!(VaultStore.apply(dir.path(), &before, &update()).is_err());
        assert!(VaultStore.fail(dir.path(), &before, "page fetch timed out").is_err());
        assert!(!dir.path().join(path).exists());
    }

    #[test]
    fn failures_are_terminal_without_changing_writer_or_source_text() {
        let dir = tempfile::tempdir().unwrap();
        let path = capture(dir.path(), "My own note.");
        let before = vault::clip_read(dir.path(), &path).unwrap();
        VaultStore.fail(dir.path(), &before, "page fetch timed out").unwrap();
        let after = vault::clip_read(dir.path(), &path).unwrap();
        assert_eq!(after.text, before.text);
        assert_eq!(after.source, before.source);
        assert_eq!(after.summary.enrich_error.as_deref(), Some("page fetch timed out"));
        assert!(VaultStore.pending(dir.path()).unwrap().is_empty());
    }
}
