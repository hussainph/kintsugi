use super::*;

fn capture(text: &str) -> ClipCapture {
    ClipCapture {
        url: None,
        text: Some(text.into()),
        note: None,
        title: None,
        image: None,
        image_type: None,
        file: None,
        captured_at: "2026-10-29T14:05".into(),
        via: ClipVia::Mac,
    }
}

#[test]
fn receipt_reservation_happens_before_media_and_markdown_are_written() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let capture = ClipCapture {
        image: Some(vec![1, 2, 3]),
        image_type: Some("image/png".into()),
        file: None,
        ..capture("A note")
    };
    let error = clip_create_with_receipt(root, &capture, &[], |path| {
        assert_eq!(path, "inspiration/a-note.md");
        assert!(!root.join(path).exists());
        assert!(!root.join("inspiration/media").exists());
        Err("could not persist receipt".into())
    })
    .unwrap_err();
    assert_eq!(error, "could not persist receipt");
    assert!(clip_list(root).unwrap().is_empty());
    assert!(!root.join("inspiration/media").exists());
    assert_eq!(clip_create(root, &capture).unwrap(), "inspiration/a-note.md");
}

#[test]
fn captures_links_quotes_notes_and_images_without_enrichment() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let path = clip_create(
        root,
        &ClipCapture {
            url: Some("https://example.org/why-we-sleep?q=private".into()),
            text: Some("A passage\nwith two lines".into()),
            note: Some("My own thought".into()),
            ..capture("")
        },
    )
    .unwrap();
    assert_eq!(path, "inspiration/example-org-why-we-sleep.md");
    let clip = clip_read(root, &path).unwrap();
    assert_eq!(clip.summary.kind, ClipKind::Quote);
    assert_eq!(clip.summary.captured, "2026-10-29T14:05");
    assert_eq!(clip.summary.via, Some(ClipVia::Mac));
    assert_eq!(clip.text, "> A passage\n> with two lines\n\nMy own thought");
    assert!(!clip.has_source);
    assert!(clip.summary.enriched.is_none());
    assert!(clip.summary.title.is_none());
    assert_eq!(
        clip_create(
            root,
            &ClipCapture {
                url: Some("https://example.org/why-we-sleep?different".into()),
                ..capture("")
            }
        )
        .unwrap(),
        "inspiration/example-org-why-we-sleep-2.md"
    );

    let path = clip_create(root, &capture("# On repair\nA passing thought")).unwrap();
    assert_eq!(path, "inspiration/on-repair.md");
    assert_eq!(clip_read(root, &path).unwrap().summary.kind, ClipKind::Note);
    assert_eq!(
        clip_read(root, &path).unwrap().text,
        "# On repair\nA passing thought"
    );
    let path = clip_create(
        root,
        &ClipCapture {
            text: None,
            note: Some("Just a note".into()),
            ..capture("")
        },
    )
    .unwrap();
    assert_eq!(clip_read(root, &path).unwrap().text, "Just a note");
    assert_eq!(clip_read(root, &path).unwrap().summary.kind, ClipKind::Note);

    let bytes = vec![0, 1, 2, 3];
    let path = clip_create(
        root,
        &ClipCapture {
            text: None,
            title: Some("A screenshot".into()),
            image: Some(bytes.clone()),
            image_type: Some("image/png".into()),
            file: None,
            ..capture("")
        },
    )
    .unwrap();
    let clip = clip_read(root, &path).unwrap();
    assert_eq!(path, "inspiration/a-screenshot.md");
    assert_eq!(clip.summary.kind, ClipKind::Image);
    assert_eq!(
        clip.summary.image.as_deref(),
        Some("media/a-screenshot.png")
    );
    assert_eq!(
        fs::read(root.join("inspiration/media/a-screenshot.png")).unwrap(),
        bytes
    );
}

#[test]
fn guesses_hosts_without_matching_lookalike_domains() {
    for (url, kind) in [
        ("https://www.youtube.com/watch?v=1", ClipKind::Video),
        ("https://youtu.be/1", ClipKind::Video),
        ("https://player.vimeo.com/video/1", ClipKind::Video),
        ("https://x.com/writer/status/1", ClipKind::Post),
        ("https://bsky.app/profile/writer/post/1", ClipKind::Post),
        ("https://m.tiktok.com/something", ClipKind::Post),
        ("https://threads.com/@writer", ClipKind::Post),
        ("https://notyoutube.com/watch?v=1", ClipKind::Link),
        ("https://youtube.com.evil.test/", ClipKind::Link),
        ("https://x.com@unrelated.test/", ClipKind::Link),
    ] {
        assert_eq!(clip_guess_kind(Some(url), None, false), kind, "{url}");
    }
    assert_eq!(
        clip_guess_kind(Some("https://example.org"), Some("passage"), true),
        ClipKind::Quote
    );
    assert_eq!(
        clip_guess_kind(None, Some("caption"), true),
        ClipKind::Image
    );
    assert_eq!(
        clip_guess_kind(None, Some("thought"), false),
        ClipKind::Note
    );
}

#[test]
fn lists_newest_first_and_hides_clips_from_the_writing_tree() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    assert!(clip_list(root).unwrap().is_empty());
    crate::create_doc(root, "", "My essay").unwrap();
    let first = clip_create(root, &capture("First")).unwrap();
    let second = clip_create(
        root,
        &ClipCapture {
            captured_at: "2026-10-30T09:00".into(),
            ..capture("Second")
        },
    )
    .unwrap();
    fs::write(root.join("inspiration/not-a-clip.md"), "just text").unwrap();
    fs::create_dir(root.join("notes")).unwrap();
    fs::create_dir(root.join("notes/inspiration")).unwrap();
    let clips = clip_list(root).unwrap();
    assert_eq!(
        clips.iter().map(|c| c.path.as_str()).collect::<Vec<_>>(),
        [&second, &first]
    );
    let tree = crate::tree(root).unwrap();
    assert_eq!(tree.len(), 2);
    let crate::Entry::Folder { children, .. } = &tree[0] else {
        panic!("expected notes")
    };
    assert_eq!(children.len(), 1, "only root inspiration is hidden");
    assert_eq!(clips_needing_enrichment(root).unwrap().len(), 2);
    clip_update(
        root,
        &first,
        &ClipUpdate {
            enriched: Some("2026-10-29T14:06".into()),
            ..Default::default()
        },
    )
    .unwrap();
    clip_update(
        root,
        &second,
        &ClipUpdate {
            enrich_error: Some("could not extract page".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(clips_needing_enrichment(root).unwrap().is_empty());
    clip_update(
        root,
        &second,
        &ClipUpdate {
            enrich_error: Some(String::new()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(clips_needing_enrichment(root).unwrap().len(), 1);
}

#[test]
fn enrichment_preserves_the_latest_own_text_and_unknown_frontmatter() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let path = clip_create(root, &capture("A thought")).unwrap();
    let own = "\r\n> A writer's passage\r\n\r\n  Their exact whitespace.  \r\n\r\n";
    let raw = format!(
        "---\r\nkind: quote\r\ncaptured: '2026-10-29T14:05'\r\ntags:\r\n  - SCIENCE\r\n  - 'a, b'\r\ncustom: 'keep me'\r\n---\r\n{own}## Source\r\n\r\nOld source\r\n"
    );
    fs::write(root.join(&path), raw).unwrap();
    let clip = clip_update(
        root,
        &path,
        &ClipUpdate {
            title: Some("A better title".into()),
            site: Some("The site".into()),
            author: Some("Jane Doe".into()),
            summary: Some("A summary".into()),
            source: Some("New readable source".into()),
            enriched: Some("2026-10-29T14:06".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(clip.summary.path, path);
    assert_eq!(clip.summary.tags, ["science", "a, b"]);
    assert_eq!(clip.source.as_deref(), Some("New readable source"));
    let saved = fs::read_to_string(root.join(&path)).unwrap();
    let fm = Frontmatter::parse(&saved).unwrap();
    assert_eq!(
        sections(fm.body).0,
        own,
        "the writer's exact bytes survive enrichment"
    );
    assert_eq!(fm.scalar("custom").as_deref(), Some("keep me"));

    let clip = clip_update(
        root,
        &path,
        &ClipUpdate {
            title: Some("An edited title".into()),
            tags: Some(vec![
                " Sleep ".into(),
                "sleep".into(),
                "Science".into(),
                "".into(),
            ]),
            note: Some("The writer's edited text".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(clip.text, "The writer's edited text");
    assert_eq!(clip.source.as_deref(), Some("New readable source"));
    assert_eq!(clip.summary.tags, ["sleep", "science"]);
    assert_eq!(clip.summary.path, path, "title edits do not rename files");
}

#[test]
fn metadata_only_updates_leave_the_entire_body_byte_for_byte() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let path = clip_create(root, &capture("Thought")).unwrap();
    let body = "\r\n  My text.  \r\n\r\n## Source\r\n\r\n  Source.  \r\n";
    fs::write(
        root.join(&path),
        format!("---\nkind: note\ncaptured: 2026-10-29T14:05\n---\n{body}"),
    )
    .unwrap();
    clip_update(
        root,
        &path,
        &ClipUpdate {
            tags: Some(vec!["writing".into()]),
            ..Default::default()
        },
    )
    .unwrap();
    let saved = fs::read_to_string(root.join(path)).unwrap();
    assert_eq!(Frontmatter::parse(&saved).unwrap().body, body);
}

#[test]
fn source_headings_inside_code_are_not_extracted_text() {
    let own = "\nMy example:\n\n```markdown\n## Source\n```\n\n~~~md\n## Source\n~~~\n\n";
    let body = format!("{own}## Source\n\nReadable text\n");
    assert_eq!(sections(&body), (own, Some("\nReadable text\n")));
}

#[test]
fn source_updates_are_bounded_and_can_be_cleared() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let path = clip_create(root, &capture("My note")).unwrap();
    let clip = clip_update(
        root,
        &path,
        &ClipUpdate {
            source: Some("金".repeat(25_000)),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(clip.source.as_ref().unwrap().chars().count(), 20_000);
    assert!(clip.has_source);
    assert_eq!(clip.text, "My note");
    let clip = clip_update(
        root,
        &path,
        &ClipUpdate {
            source: Some(String::new()),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(!clip.has_source);
    assert!(clip.source.is_none());
    assert_eq!(clip.text, "My note");
}

#[test]
fn media_saves_fill_only_a_missing_image_and_preserve_screenshots() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let path = clip_create(root, &capture("My note")).unwrap();
    assert_eq!(
        clip_save_media(root, &path, &[1, 2, 3], "image/jpeg").unwrap(),
        "media/my-note.jpg"
    );
    assert_eq!(
        clip_save_media(root, &path, &[4, 5], "image/webp").unwrap(),
        "media/my-note.jpg"
    );
    assert!(!root.join("inspiration/media/my-note.webp").exists());
    assert_eq!(
        fs::read(root.join("inspiration/media/my-note.jpg")).unwrap(),
        [1, 2, 3]
    );
    assert_eq!(
        clip_save_media(root, &path, &[9], "image/jpeg").unwrap(),
        "media/my-note.jpg"
    );
    assert_eq!(
        fs::read(root.join("inspiration/media/my-note.jpg")).unwrap(),
        [1, 2, 3]
    );
    let clip = clip_read(root, &path).unwrap();
    assert_eq!(clip.text, "My note");
    assert_eq!(clip.summary.image.as_deref(), Some("media/my-note.jpg"));
    assert!(clip_save_media(root, &path, &[1], "image/svg+xml").is_err());
    assert!(clip_save_media(root, &path, &[], "image/png").is_err());
    assert!(clip_save_media(root, &path, &vec![1; MAX_CLIP_IMAGE_BYTES + 1], "image/png").is_err());
    assert_eq!(
        clip_read(root, &path).unwrap(),
        clip,
        "failed saves leave the clip alone"
    );
    assert!(fs::read_dir(root.join(INSPIRATION)).unwrap().all(|e| {
        !e.unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".kintsugi-")
    }));
}

#[test]
fn invalid_captures_write_nothing_and_errors_do_not_echo_content() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let secret = "PRIVATE-CAPTURE-CONTENT";
    for capture in [
        capture("  "),
        ClipCapture {
            url: Some(format!("file:///etc/{secret}")),
            ..capture("")
        },
        ClipCapture {
            url: Some(format!("https://{secret} invalid")),
            ..capture("")
        },
        ClipCapture {
            captured_at: "2026-02-29T09:00".into(),
            ..capture("note")
        },
        ClipCapture {
            captured_at: "2026-01-01T24:00".into(),
            ..capture("note")
        },
        ClipCapture {
            captured_at: "bad\nkind: link".into(),
            ..capture("note")
        },
        ClipCapture {
            image: Some(vec![1]),
            image_type: None,
            file: None,
            ..capture("note")
        },
        ClipCapture {
            image_type: Some("image/png".into()),
            file: None,
            ..capture("note")
        },
        ClipCapture {
            image: Some(vec![1]),
            image_type: Some(format!("image/{secret}")),
            file: None,
            ..capture("note")
        },
    ] {
        let error = clip_create(root, &capture).unwrap_err();
        assert!(!error.contains(secret));
        assert!(!root.join(INSPIRATION).exists());
    }
}

#[test]
fn clip_operations_refuse_document_and_traversal_paths() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    crate::create_doc(root, "", "Writing").unwrap();
    for path in [
        "writing.mdx",
        "writing.md",
        "inspiration/../writing.md",
        "/inspiration/x.md",
        "inspiration/media/x.md",
        "inspiration/.hidden.md",
        "inspiration/x.mdx",
        "inspiration/./x.md",
        "inspiration//x.md",
    ] {
        assert!(clip_read(root, path).is_err(), "{path}");
        assert!(
            clip_update(root, path, &ClipUpdate::default()).is_err(),
            "{path}"
        );
        assert!(
            clip_save_media(root, path, &[1], "image/png").is_err(),
            "{path}"
        );
    }
    let path = clip_create(root, &capture("note")).unwrap();
    for image in [
        "../writing.md",
        "media/../../writing.md",
        "/etc/passwd",
        "media/other.png",
        "media/note.svg",
    ] {
        assert!(
            clip_update(
                root,
                &path,
                &ClipUpdate {
                    image: Some(image.into()),
                    ..Default::default()
                }
            )
            .is_err()
        );
        assert!(clip_media_path(root, &path, image).is_err());
    }
}

#[cfg(unix)]
#[test]
fn symlinked_clip_directories_files_and_media_cannot_escape_the_vault() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("vault");
    let outside = dir.path().join("outside");
    fs::create_dir(&root).unwrap();
    fs::create_dir(&outside).unwrap();
    symlink(&outside, root.join(INSPIRATION)).unwrap();
    assert!(clip_create(&root, &capture("note")).is_err());
    assert!(clip_list(&root).is_err());
    fs::remove_file(root.join(INSPIRATION)).unwrap();
    let path = clip_create(&root, &capture("note")).unwrap();
    symlink(&outside, root.join("inspiration/media")).unwrap();
    assert!(clip_save_media(&root, &path, &[1], "image/png").is_err());
    assert!(fs::read_dir(&outside).unwrap().next().is_none());
    fs::remove_file(root.join(&path)).unwrap();
    fs::write(outside.join("note.md"), "outside text").unwrap();
    symlink(outside.join("note.md"), root.join(&path)).unwrap();
    assert!(clip_read(&root, &path).is_err());
    assert!(clip_update(&root, &path, &ClipUpdate::default()).is_err());
    assert_eq!(
        fs::read_to_string(outside.join("note.md")).unwrap(),
        "outside text"
    );
}

#[test]
fn simultaneous_captures_get_unique_stable_paths() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::thread::scope(|scope| {
        let handles = (0..8)
            .map(|_| scope.spawn(|| clip_create(root, &capture("Same title")).unwrap()))
            .collect::<Vec<_>>();
        let mut paths = handles
            .into_iter()
            .map(|h| h.join().unwrap())
            .collect::<Vec<_>>();
        paths.sort();
        paths.dedup();
        assert_eq!(paths.len(), 8);
    });
    assert_eq!(clip_list(root).unwrap().len(), 8);
}

#[test]
fn enrichment_does_not_overwrite_metadata_edited_during_the_fetch() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let path = clip_create(root, &capture("Own text")).unwrap();
    let baseline = clip_read(root, &path).unwrap().summary;
    clip_update(
        root,
        &path,
        &ClipUpdate {
            title: Some("My title".into()),
            tags: Some(vec!["my-tag".into()]),
            note: Some("My latest thought".into()),
            ..Default::default()
        },
    )
    .unwrap();
    let enriched = clip_enrich(
        root,
        &path,
        &baseline,
        &ClipUpdate {
            title: Some("AI title".into()),
            tags: Some(vec!["ai-tag".into()]),
            source: Some("Extracted text".into()),
            summary: Some("A summary".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(enriched.summary.title.as_deref(), Some("My title"));
    assert_eq!(enriched.summary.tags, ["my-tag"]);
    assert_eq!(enriched.text, "My latest thought");
    assert_eq!(enriched.source.as_deref(), Some("Extracted text"));
    assert!(
        clip_enrich(
            root,
            &path,
            &baseline,
            &ClipUpdate {
                note: Some("never".into()),
                ..Default::default()
            }
        )
        .is_err()
    );

    let path = clip_create(root, &capture("Another thought")).unwrap();
    let baseline = clip_read(root, &path).unwrap().summary;
    let enriched = clip_enrich(
        root,
        &path,
        &baseline,
        &ClipUpdate {
            title: Some("A new title".into()),
            tags: Some(vec!["writing".into()]),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(enriched.summary.title.as_deref(), Some("A new title"));
    assert_eq!(enriched.summary.tags, ["writing"]);
}

#[test]
fn trash_selects_only_the_clip_and_its_primary_image() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let path = clip_create(root, &capture("Own text")).unwrap();
    clip_save_media(root, &path, &[1], "image/png").unwrap();
    let error = clip_trash(root, &path, |_| Err("Trash unavailable".into())).unwrap_err();
    assert_eq!(error, "Trash unavailable");
    assert!(clip_read(root, &path).is_ok());
    clip_trash(root, &path, |targets| {
        assert_eq!(
            targets,
            [
                root.join(&path),
                root.join("inspiration/media/own-text.png")
            ]
        );
        for target in targets {
            fs::remove_file(target).unwrap();
        }
        Ok(())
    })
    .unwrap();
    assert!(clip_list(root).unwrap().is_empty());
    assert!(
        clip_update(
            root,
            &path,
            &ClipUpdate {
                source: Some("Late fetch".into()),
                ..Default::default()
            }
        )
        .is_err()
    );
    assert!(
        !root.join(&path).exists(),
        "late enrichment never recreates a clip"
    );
}

#[test]
fn arbitrary_captured_markdown_survives_source_updates_and_note_edits() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let own = "A note\n\n## Source\n\nThese are my words.\n\n```md\nAn unfinished example";
    let path = clip_create(root, &capture(own)).unwrap();
    assert_eq!(clip_read(root, &path).unwrap().text, own);
    for source in ["Extracted page", "A second extraction"] {
        let clip = clip_update(
            root,
            &path,
            &ClipUpdate {
                source: Some(source.into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(clip.text, own);
        assert_eq!(clip.source.as_deref(), Some(source));
    }
    let edited = "New note\n## Source\nStill mine\n~~~md\nUnclosed";
    let clip = clip_update(
        root,
        &path,
        &ClipUpdate {
            note: Some(edited.into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(clip.text, edited);
    assert_eq!(clip.source.as_deref(), Some("A second extraction"));
}

#[test]
fn orphan_media_is_never_overwritten_by_capture_or_enrichment() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fs::create_dir_all(root.join("inspiration/media")).unwrap();
    fs::write(root.join("inspiration/media/screenshot.png"), "keep me").unwrap();
    let path = clip_create(
        root,
        &ClipCapture {
            title: Some("Screenshot".into()),
            image: Some(vec![1]),
            image_type: Some("image/jpeg".into()),
            file: None,
            ..capture("")
        },
    )
    .unwrap();
    assert_eq!(path, "inspiration/screenshot-2.md");
    assert_eq!(
        fs::read(root.join("inspiration/media/screenshot.png")).unwrap(),
        b"keep me"
    );
    let path = clip_create(root, &capture("New note")).unwrap();
    fs::write(root.join("inspiration/media/new-note.png"), "also keep").unwrap();
    assert!(clip_save_media(root, &path, &[2], "image/png").is_err());
    assert_eq!(
        fs::read(root.join("inspiration/media/new-note.png")).unwrap(),
        b"also keep"
    );
    assert!(clip_read(root, &path).unwrap().summary.image.is_none());
}

#[test]
fn interleaved_writer_enrichment_and_media_updates_keep_every_change() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let path = clip_create(root, &capture("Initial text")).unwrap();
    for round in 0..12 {
        let baseline = clip_read(root, &path).unwrap().summary;
        let barrier = std::sync::Barrier::new(3);
        let note = format!("Writer's latest text {round}");
        let source = format!("Extracted source {round}");
        std::thread::scope(|scope| {
            let writer = scope.spawn(|| {
                barrier.wait();
                clip_update(
                    root,
                    &path,
                    &ClipUpdate {
                        note: Some(note.clone()),
                        tags: Some(vec!["writer".into()]),
                        ..Default::default()
                    },
                )
                .unwrap();
            });
            let worker = scope.spawn(|| {
                barrier.wait();
                clip_enrich(
                    root,
                    &path,
                    &baseline,
                    &ClipUpdate {
                        source: Some(source.clone()),
                        summary: Some("A summary".into()),
                        ..Default::default()
                    },
                )
                .unwrap();
            });
            let media = scope.spawn(|| {
                barrier.wait();
                clip_save_media(root, &path, &[1, 2, 3], "image/png").unwrap();
            });
            writer.join().unwrap();
            worker.join().unwrap();
            media.join().unwrap();
        });
        let clip = clip_read(root, &path).unwrap();
        assert_eq!(clip.text, note);
        assert_eq!(clip.source.as_deref(), Some(source.as_str()));
        assert_eq!(clip.summary.tags, ["writer"]);
        assert_eq!(clip.summary.summary.as_deref(), Some("A summary"));
        assert_eq!(
            clip.summary.image.as_deref(),
            Some("media/initial-text.png")
        );
    }
}

#[test]
fn writing_appended_below_an_empty_boundary_remains_own_text() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let path = clip_create(root, &capture("My note\n## Source\nMy own heading")).unwrap();
    let mut raw = fs::read_to_string(root.join(&path)).unwrap();
    raw.push_str("\nAppended in Obsidian.\n");
    fs::write(root.join(&path), &raw).unwrap();
    let before = clip_read(root, &path).unwrap();
    assert!(before.text.contains("Appended in Obsidian."));
    assert!(before.text.contains("My own heading"));
    assert!(!before.has_source);
    let clip = clip_update(
        root,
        &path,
        &ClipUpdate {
            source: Some("Readable source".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(clip.text, before.text);
    assert_eq!(clip.source.as_deref(), Some("Readable source"));
}

#[test]
fn case_aliases_share_a_clip_lock_and_the_reserved_namespace() {
    let dir = tempfile::tempdir().unwrap();
    let lower = clip_lock(dir.path(), "inspiration/note.md").unwrap();
    let upper = clip_lock(dir.path(), "inspiration/Note.md").unwrap();
    assert!(Arc::ptr_eq(&lower, &upper));
    for path in [
        "inspiration",
        "Inspiration/x.md",
        "INSPIRATION",
        "./inspiration/x.md",
    ] {
        assert!(is_inspiration_path(path));
    }
    assert!(!is_inspiration_path("essays/inspiration/x.md"));
}

#[cfg(unix)]
#[test]
fn failed_media_metadata_saves_remove_only_the_new_image_so_retries_work() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let path = clip_create(root, &capture("My note")).unwrap();
    let inspiration = root.join(INSPIRATION);
    fs::create_dir(inspiration.join("media")).unwrap();
    let permissions = fs::metadata(&inspiration).unwrap().permissions();
    fs::set_permissions(&inspiration, fs::Permissions::from_mode(0o555)).unwrap();
    // Privileged test runners can bypass directory permissions.
    let probe = inspiration.join("probe");
    if fs::write(&probe, "probe").is_ok() {
        fs::remove_file(probe).unwrap();
        fs::set_permissions(&inspiration, permissions).unwrap();
        return;
    }
    let result = clip_save_media(root, &path, &[1], "image/png");
    fs::set_permissions(&inspiration, permissions).unwrap();
    assert!(result.is_err());
    assert!(!inspiration.join("media/my-note.png").exists());
    assert!(clip_read(root, &path).unwrap().summary.image.is_none());
    assert_eq!(
        clip_save_media(root, &path, &[2], "image/png").unwrap(),
        "media/my-note.png"
    );
    assert_eq!(
        fs::read(inspiration.join("media/my-note.png")).unwrap(),
        [2]
    );
}

#[test]
fn phone_serialization_exposes_own_text_but_not_the_large_source() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let path = clip_create(root, &capture("Own text")).unwrap();
    let clip = clip_update(
        root,
        &path,
        &ClipUpdate {
            source: Some("Large source".into()),
            enrich_error: Some("Failed".into()),
            ..Default::default()
        },
    )
    .unwrap();
    let json = serde_json::to_value(clip).unwrap();
    assert_eq!(json["path"], path);
    assert_eq!(json["kind"], "note");
    assert_eq!(json["text"], "Own text");
    assert_eq!(json["hasSource"], true);
    assert_eq!(json["enrichError"], "Failed");
    assert!(json["title"].is_null());
    assert_eq!(json["tags"], serde_json::json!([]));
    assert!(json.get("source").is_none());
    assert!(
        json.get("summary").unwrap().is_null(),
        "summary field is text, not a nested object"
    );
}

fn pdf_bytes() -> Vec<u8> {
    b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n".to_vec()
}

fn file_capture(bytes: Vec<u8>, mime: &str, name: Option<&str>) -> ClipCapture {
    ClipCapture {
        text: None,
        file: Some(ClipFile { bytes, mime: mime.into(), name: name.map(Into::into) }),
        ..capture("unused")
    }
}

#[test]
fn pdfs_and_epubs_are_saved_beside_the_clip_and_named_from_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let path = clip_create(root, &file_capture(pdf_bytes(), "application/pdf", Some("Golden_Seam-draft.v2.pdf"))).unwrap();
    assert_eq!(path, "inspiration/golden-seam-draft-v2.md");
    let clip = clip_read(root, &path).unwrap();
    assert_eq!(clip.summary.kind, ClipKind::Document);
    assert_eq!(clip.summary.title, None);
    assert_eq!(clip.summary.file.as_deref(), Some("files/golden-seam-draft-v2.pdf"));
    let saved = clip_file_path(root, &path, "files/golden-seam-draft-v2.pdf").unwrap();
    assert_eq!(fs::read(&saved).unwrap(), pdf_bytes());
    let json = serde_json::to_value(&clip.summary).unwrap();
    assert_eq!(json["file"], "files/golden-seam-draft-v2.pdf");

    // A second capture with the same name never overwrites the file.
    let again = clip_create(root, &file_capture(pdf_bytes(), "application/pdf", Some("Golden_Seam-draft.v2.pdf"))).unwrap();
    assert_eq!(again, "inspiration/golden-seam-draft-v2-2.md");
    // An orphan file reserves its name too.
    fs::write(root.join("inspiration/files/orphan.pdf"), b"x").unwrap();
    let orphan = clip_create(root, &file_capture(pdf_bytes(), "application/pdf", Some("orphan.pdf"))).unwrap();
    assert_eq!(orphan, "inspiration/orphan-2.md");

    let epub = clip_create(root, &file_capture(b"PK\x03\x04mimetypeapplication/epub+zip".to_vec(), "application/epub+zip", None)).unwrap();
    assert_eq!(epub, "inspiration/document.md");
    let clip = clip_read(root, &epub).unwrap();
    assert_eq!(clip.summary.kind, ClipKind::Book);
    assert_eq!(clip.summary.file.as_deref(), Some("files/document.epub"));

    // Trash takes the file with the clip.
    let mut trashed = Vec::new();
    clip_trash(root, &path, |targets| {
        trashed = targets.to_vec();
        Ok(())
    })
    .unwrap();
    assert_eq!(trashed, vec![root.join(&path), saved]);
}

#[test]
fn files_must_be_what_they_claim_and_within_the_cap() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    for (bytes, mime, error) in [
        (b"<html>".to_vec(), "application/pdf", "clip file does not match its type"),
        (pdf_bytes(), "application/epub+zip", "clip file does not match its type"),
        (pdf_bytes(), "text/html", "unsupported clip file type"),
        (Vec::new(), "application/pdf", "clip files must be between 1 byte and 50 MiB"),
        (vec![b'%'; MAX_CLIP_FILE_BYTES + 1], "application/pdf", "clip files must be between 1 byte and 50 MiB"),
    ] {
        assert_eq!(clip_create(root, &file_capture(bytes, mime, Some("x.pdf"))).unwrap_err(), error);
    }
    assert!(!root.join("inspiration/files").exists());
    // Hand-edited paths outside files/<stem> are refused.
    let path = clip_create(root, &capture("A note")).unwrap();
    for file in ["files/other.pdf", "../secret.pdf", "files/a-note.exe", "media/a-note.pdf"] {
        assert!(clip_file_path(root, &path, file).is_err(), "{file}");
    }
}

#[test]
fn open_library_links_are_books() {
    assert_eq!(clip_guess_kind(Some("https://openlibrary.org/isbn/9780140328721"), None, false), ClipKind::Book);
    assert_eq!(clip_guess_kind(Some("https://openlibrary.org.evil.test/works/OL1W"), None, false), ClipKind::Link);
}
