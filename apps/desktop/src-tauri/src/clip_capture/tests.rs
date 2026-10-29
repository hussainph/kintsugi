use super::*;
use serde_json::json;
use std::sync::{Arc, Barrier};

const ID: &str = "6d329d64-6bda-4ca9-81d4-3a7e6fbcbcef";

fn capture(id: Option<&str>) -> Capture {
    serde_json::from_value(json!({
        "id": id, "text": "A passing thought", "capturedAt": "2026-10-29T09:14", "via": "mac"
    }))
    .unwrap()
}

fn fixtures() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("vault");
    fs::create_dir(&root).unwrap();
    let index = dir.path().join("config/clip-capture-ids.json");
    (dir, root, index)
}

#[test]
fn validates_uuid_without_echoing_it_or_writing() {
    let (_dir, root, index) = fixtures();
    for id in [
        "",
        "../private-note",
        "6d329d646bda4ca981d43a7e6fbcbcef",
        "6d329d64_6bda-4ca9-81d4-3a7e6fbcbcef",
        "6d329d64-6bda-4ca9-81d4-3a7e6fbcbceg",
        "6d329d64-6bda-4ca9-81d4-3a7e6fbcbceé",
    ] {
        let error = create(&root, &index, &capture(Some(id))).err().unwrap();
        assert!(matches!(error, Error::Invalid(_)));
        assert_eq!(error.to_string(), "Clip capture id must be a UUID.");
    }
    assert!(!index.exists());
    assert_eq!(fs::read_dir(root).unwrap().count(), 0);
}

#[test]
fn optional_id_preserves_legacy_creation_without_touching_the_index() {
    let (_dir, root, index) = fixtures();
    let first = create(&root, &index, &capture(None)).unwrap();
    let next = create(&root, &index, &capture(None)).unwrap();
    assert!(first.created && next.created);
    assert_ne!(first.path, next.path);
    assert!(!index.exists());
}

#[test]
fn repeats_use_the_persisted_receipt_and_do_not_write_even_after_trash() {
    let (_dir, root, index) = fixtures();
    let mut request = capture(Some(ID));
    request.clip.image = Some(vec![1, 2, 3]);
    request.clip.image_type = Some("image/png".into());
    let first = create(&root, &index, &request).unwrap();
    assert!(first.created);
    let original = fs::read(root.join(&first.path)).unwrap();
    let stored = fs::read(&index).unwrap();
    let modified = fs::metadata(&index).unwrap().modified().unwrap();
    // Every call reloads the file; no in-memory cache is needed after restart.
    request.id = Some(ID.to_uppercase());
    request.clip.text = Some("Changed retry content must not replace the original".into());
    let retry = create(&root.join("."), &index, &request).unwrap();
    assert_eq!(retry.path, first.path);
    assert!(!retry.created);
    assert_eq!(fs::read(root.join(&first.path)).unwrap(), original);
    vault::clip_trash(&root, &first.path, |paths| {
        for path in paths {
            fs::remove_file(path).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .unwrap();
    let retry = create(&root, &index, &request).unwrap();
    assert_eq!(retry.path, first.path);
    assert!(!retry.created);
    assert!(vault::clip_list(&root).unwrap().is_empty());
    assert_eq!(
        fs::read_dir(root.join("inspiration/media"))
            .unwrap()
            .count(),
        0
    );
    assert_eq!(fs::read(&index).unwrap(), stored);
    assert_eq!(fs::metadata(&index).unwrap().modified().unwrap(), modified);
    assert!(!root.join("clip-capture-ids.json").exists());
}

#[test]
fn concurrent_duplicates_create_exactly_one_clip() {
    let (_dir, root, index) = fixtures();
    let barrier = Arc::new(Barrier::new(12));
    let handles: Vec<_> = (0..12)
        .map(|_| {
            let (root, index, barrier) = (root.clone(), index.clone(), barrier.clone());
            std::thread::spawn(move || {
                barrier.wait();
                create(&root, &index, &capture(Some(ID))).unwrap()
            })
        })
        .collect();
    let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|r| r.created).count(), 1);
    assert!(results.iter().all(|r| r.path == results[0].path));
    assert_eq!(vault::clip_list(&root).unwrap().len(), 1);
    assert_eq!(load(&index).unwrap().len(), 1);
}

#[test]
fn ids_are_scoped_to_the_canonical_vault_root() {
    let (dir, root, index) = fixtures();
    let other = dir.path().join("other-vault");
    fs::create_dir(&other).unwrap();
    assert!(create(&root, &index, &capture(Some(ID))).unwrap().created);
    assert!(create(&other, &index, &capture(Some(ID))).unwrap().created);
    assert!(!create(&root, &index, &capture(Some(ID))).unwrap().created);
    assert_eq!(load(&index).unwrap().len(), 2);
}

#[test]
fn evicts_oldest_after_1024_distinct_ids_not_duplicate_reads() {
    let (_dir, root, index) = fixtures();
    let root = root.canonicalize().unwrap();
    let receipts: Vec<_> = (0..MAX_RECEIPTS)
        .map(|n| Receipt {
            root: root.clone(),
            id: format!("00000000-0000-4000-8000-{n:012x}"),
            path: format!("inspiration/clip-{n}.md"),
            complete: true,
        })
        .collect();
    let oldest = receipts[0].id.clone();
    let retained = receipts[1].id.clone();
    save(&index, &receipts).unwrap();
    fs::create_dir(root.join("inspiration")).unwrap();
    fs::write(root.join("inspiration/media"), "blocks media writes").unwrap();
    let mut failed = capture(Some(ID));
    failed.clip.image = Some(vec![1, 2, 3]);
    failed.clip.image_type = Some("image/png".into());
    assert!(matches!(
        create(&root, &index, &failed),
        Err(Error::Storage)
    ));
    assert_eq!(load(&index).unwrap().len(), MAX_RECEIPTS);
    assert_eq!(load(&index).unwrap()[0].id, oldest);
    fs::remove_file(root.join("inspiration/media")).unwrap();
    assert!(
        !create(&root, &index, &capture(Some(&oldest)))
            .unwrap()
            .created
    );
    assert!(create(&root, &index, &capture(Some(ID))).unwrap().created);
    let stored = load(&index).unwrap();
    assert_eq!(stored.len(), MAX_RECEIPTS);
    assert!(!stored.iter().any(|r| r.id == oldest));
    assert!(
        !create(&root, &index, &capture(Some(&retained)))
            .unwrap()
            .created
    );
    // Evicted IDs have no remaining deduplication guarantee.
    assert!(
        create(&root, &index, &capture(Some(&oldest)))
            .unwrap()
            .created
    );
}

#[test]
fn malformed_or_unavailable_store_fails_closed_before_capture_files_are_written() {
    let (_dir, root, index) = fixtures();
    fs::create_dir_all(index.parent().unwrap()).unwrap();
    for content in [
        "invalid JSON",
        "{}",
        "[{\"root\":\"/tmp\",\"id\":\"invalid\",\"path\":\"../private.md\",\"complete\":true}]",
    ] {
        fs::write(&index, content).unwrap();
        assert!(matches!(
            create(&root, &index, &capture(Some(ID))),
            Err(Error::Storage)
        ));
        assert!(matches!(
            create(&root, &index, &capture(None)),
            Err(Error::Storage)
        ));
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
    }
    fs::remove_file(&index).unwrap();
    fs::create_dir(&index).unwrap();
    assert!(matches!(
        create(&root, &index, &capture(Some(ID))),
        Err(Error::Storage)
    ));
    assert!(vault::clip_list(&root).unwrap().is_empty());
    fs::remove_dir(&index).unwrap();
    fs::remove_dir(index.parent().unwrap()).unwrap();
    fs::write(index.parent().unwrap(), "blocks journal creation").unwrap();
    let mut request = capture(Some(ID));
    request.clip.image = Some(vec![1, 2, 3]);
    request.clip.image_type = Some("image/png".into());
    assert!(matches!(
        create(&root, &index, &request),
        Err(Error::Storage)
    ));
    assert!(vault::clip_list(&root).unwrap().is_empty());
    assert!(!root.join("inspiration/media").exists());
}

#[test]
fn invalid_captures_do_not_reserve_an_id() {
    let (_dir, root, index) = fixtures();
    let mut invalid = capture(Some(ID));
    invalid.clip.captured_at = "not a date".into();
    assert!(matches!(
        create(&root, &index, &invalid),
        Err(Error::Invalid(_))
    ));
    assert!(!index.exists());
    assert!(create(&root, &index, &capture(Some(ID))).unwrap().created);
}

#[test]
fn recovers_a_pending_receipt_after_clip_save_without_creating_another_clip() {
    let (_dir, root, index) = fixtures();
    let root = root.canonicalize().unwrap();
    let path = vault::clip_create(&root, &capture(None).clip).unwrap();
    save(
        &index,
        &[Receipt {
            root: root.clone(),
            id: ID.into(),
            path: path.clone(),
            complete: false,
        }],
    )
    .unwrap();
    let result = create(&root, &index, &capture(Some(ID))).unwrap();
    assert_eq!(result.path, path);
    assert!(load(&index).unwrap()[0].complete);
    assert_eq!(vault::clip_list(&root).unwrap().len(), 1);
    assert!(!create(&root, &index, &capture(Some(ID))).unwrap().created);
}

#[test]
fn all_app_captures_skip_other_pending_names() {
    let (_dir, root, index) = fixtures();
    let root = root.canonicalize().unwrap();
    let original = "inspiration/a-passing-thought.md";
    save(
        &index,
        &[Receipt {
            root: root.clone(),
            id: ID.into(),
            path: original.into(),
            complete: false,
        }],
    )
    .unwrap();
    let other = create(&root, &index, &capture(None)).unwrap();
    assert_eq!(other.path, "inspiration/a-passing-thought-2.md");
    let different = create(
        &root,
        &index,
        &capture(Some("00000000-0000-4000-8000-000000000001")),
    )
    .unwrap();
    assert_eq!(different.path, "inspiration/a-passing-thought-3.md");
    let retry = create(&root, &index, &capture(Some(ID))).unwrap();
    assert_eq!(retry.path, original);
    assert_eq!(vault::clip_list(&root).unwrap().len(), 3);
}

#[test]
fn pending_receipts_survive_enrichment_writer_edits_and_missing_media() {
    let (_dir, root, index) = fixtures();
    let mut request = capture(Some(ID));
    request.clip.image = Some(vec![1, 2, 3]);
    request.clip.image_type = Some("image/png".into());
    let result = create(&root, &index, &request).unwrap();
    let mut receipts = load(&index).unwrap();
    receipts[0].complete = false;
    save(&index, &receipts).unwrap();
    let clip = vault::clip_read(&root, &result.path).unwrap();
    vault::clip_enrich(
        &root,
        &result.path,
        &clip.summary,
        &vault::ClipUpdate {
            title: Some("Enriched title".into()),
            summary: Some("New summary".into()),
            enriched: Some("2026-10-29T09:15".into()),
            ..Default::default()
        },
    )
    .unwrap();
    vault::clip_update(
        &root,
        &result.path,
        &vault::ClipUpdate {
            note: Some("The writer edited this".into()),
            ..Default::default()
        },
    )
    .unwrap();
    let image = vault::clip_media_path(&root, &result.path, clip.summary.image.as_deref().unwrap())
        .unwrap();
    fs::remove_file(image).unwrap();
    let retry = create(&root, &index, &request).unwrap();
    assert_eq!(retry.path, result.path);
    assert!(load(&index).unwrap()[0].complete);
    assert_eq!(vault::clip_list(&root).unwrap().len(), 1);
    assert_eq!(
        vault::clip_read(&root, &result.path).unwrap().text,
        "The writer edited this"
    );
}

#[test]
fn trashing_a_pending_capture_in_the_app_does_not_resurrect_it_on_retry() {
    let (_dir, root, index) = fixtures();
    let request = capture(Some(ID));
    let result = create(&root, &index, &request).unwrap();
    let mut receipts = load(&index).unwrap();
    receipts[0].complete = false;
    save(&index, &receipts).unwrap();
    trash(&root, &index, &result.path, |targets| {
        for path in targets {
            fs::remove_file(path).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .unwrap();
    let retry = create(&root, &index, &request).unwrap();
    assert_eq!(retry.path, result.path);
    assert!(!retry.created);
    assert!(vault::clip_list(&root).unwrap().is_empty());
}

#[test]
fn failed_media_writes_release_the_reservation_and_can_be_retried() {
    let (_dir, root, index) = fixtures();
    fs::create_dir(root.join("inspiration")).unwrap();
    fs::write(root.join("inspiration/media"), "blocks media writes").unwrap();
    let request: Capture = serde_json::from_value(json!({
        "id": ID, "image": [1, 2, 3], "imageType": "image/png",
        "capturedAt": "2026-10-29T09:14", "via": "mac"
    }))
    .unwrap();
    assert!(matches!(
        create(&root, &index, &request),
        Err(Error::Storage)
    ));
    assert!(load(&index).unwrap().is_empty());
    assert!(vault::clip_list(&root).unwrap().is_empty());
    fs::remove_file(root.join("inspiration/media")).unwrap();
    assert!(create(&root, &index, &request).unwrap().created);
    assert_eq!(vault::clip_list(&root).unwrap().len(), 1);
}

#[test]
fn retries_a_pending_reservation_if_the_clip_was_never_saved() {
    let (_dir, root, index) = fixtures();
    let root = root.canonicalize().unwrap();
    save(
        &index,
        &[Receipt {
            root: root.clone(),
            id: ID.into(),
            path: "inspiration/a-passing-thought.md".into(),
            complete: false,
        }],
    )
    .unwrap();
    let result = create(&root, &index, &capture(Some(ID))).unwrap();
    assert!(result.created);
    assert_eq!(result.path, "inspiration/a-passing-thought.md");
    assert!(load(&index).unwrap()[0].complete);
    assert_eq!(vault::clip_list(&root).unwrap().len(), 1);
}
