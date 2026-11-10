use super::super::{EXPIRE_AFTER, SCHEMA};
use super::*;

const NOW: i64 = 1_800_000_000;

fn entry(guid: &str, age: i64) -> NewItem {
    NewItem {
        guid: guid.into(),
        url: Some(format!("https://essays.example/{guid}")),
        title: Some(format!("Essay {guid}")),
        published_at: Some(NOW - age * DAY),
        content: Some("A body discovery must not store".into()),
        media: "article",
        ..Default::default()
    }
}

fn source(store: &Store) -> Source {
    store
        .add_source(
            "https://essays.example/feed",
            SourceKind::Feed,
            Some("Essays"),
            NOW,
        )
        .unwrap()
        .0
}

fn ids(store: &Store) -> Vec<i64> {
    store
        .rank_rows()
        .unwrap()
        .into_iter()
        .filter(|r| r.catalogue_candidate)
        .map(|r| r.id)
        .collect()
}

#[test]
fn v1_migration_keeps_decisions_text_dates_and_events() {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(SCHEMA).unwrap();
    db.pragma_update(None, "user_version", 1).unwrap();
    for (id, kind) in [
        (1, "feed"),
        (2, "page"),
        (3, "podcast"),
        (4, "x"),
        (5, "hn"),
        (6, "youtube"),
        (7, "author"),
    ] {
        db.execute(
            "INSERT INTO sources (id, url, kind, added_at) VALUES (?1, ?2, ?3, ?4)",
            params![id, format!("https://source{id}.example"), kind, NOW],
        )
        .unwrap();
    }
    db.execute_batch("
        INSERT INTO items (id, source_id, guid, url, title, content, full_text_at, published_at, fetched_at, sort_at, liked_at)
          VALUES (1, 1, 'a', 'https://essays.example/a?utm_source=feed', 'A', 'Full article', 500, 100, 900, 100, 700);
        INSERT INTO items (id, source_id, guid, url, title, published_at, fetched_at, sort_at, expired_at)
          VALUES (2, 1, 'b', 'https://essays.example/b', 'B', 100, 900, 100, 800);
        INSERT INTO items (id, source_id, guid, url, title, published_at, fetched_at, sort_at, dismissed_at)
          VALUES (3, 1, 'c', 'https://essays.example/c', 'C', 100, 900, 100, 800);
        INSERT INTO events (at, kind, item_id) VALUES (700, 'like', 1);
    ").unwrap();
    let store = Store::init(db).unwrap();
    assert_eq!(
        store
            .raw()
            .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        // Stories (KI-94) and news or writing (KI-105) migrate on top of the catalogue.
        4
    );
    assert_eq!(store.sources().unwrap().len(), 7);
    for s in store.sources().unwrap() {
        assert_eq!(
            s.catalogue_enabled,
            matches!(s.kind, SourceKind::Feed | SourceKind::Page)
        );
    }
    assert_eq!(store.events().unwrap().len(), 1);
    assert!(store.item(1).unwrap().liked && store.item(3).unwrap().dismissed);
    assert_eq!(store.item(1).unwrap().published_at, Some(100));
    assert_eq!(store.content(1).unwrap().as_deref(), Some("Full article"));
    assert!(store.full_text_tried(1).unwrap());
    let mut duplicate = entry("different-guid", 100);
    duplicate.url = Some("https://essays.example/a#section".into());
    assert_eq!(
        store
            .insert_catalogue_items(1, &[duplicate, entry("b", 100), entry("c", 100)], NOW)
            .unwrap(),
        0
    );
    assert_eq!(
        store
            .raw()
            .query_row("SELECT expired_at FROM items WHERE id = 2", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        800
    );
    assert_eq!(
        store
            .raw()
            .query_row("SELECT COUNT(*) FROM items", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        3
    );
}

#[test]
fn discovery_claims_status_counts_and_restart_recovery() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("feed.sqlite");
    let store = Store::open(&path).unwrap();
    let source = source(&store);
    assert_eq!(source.catalogue_state, "queued");
    assert_eq!(store.due_catalogues().unwrap().len(), 1);
    assert!(store.start_catalogue(source.id).unwrap());
    assert!(!store.start_catalogue(source.id).unwrap());
    assert!(store.due_catalogues().unwrap().is_empty());
    drop(store);
    let store = Store::open(&path).unwrap();
    assert_eq!(store.source(source.id).unwrap().catalogue_state, "queued");
    assert!(store.start_catalogue(source.id).unwrap());
    store
        .insert_catalogue_items(source.id, &[entry("a", 100)], NOW)
        .unwrap();
    let failed = store
        .finish_catalogue(source.id, Some("Archive unavailable."))
        .unwrap();
    assert_eq!(
        (failed.catalogue_state.as_str(), failed.catalogue_count),
        ("error", 1)
    );
    assert_eq!(
        failed.catalogue_error.as_deref(),
        Some("Archive unavailable.")
    );
    assert_eq!(
        store.retry_catalogue(source.id).unwrap().catalogue_state,
        "queued"
    );
    assert!(store.start_catalogue(source.id).unwrap());
    assert_eq!(
        store
            .finish_catalogue(source.id, None)
            .unwrap()
            .catalogue_state,
        "ready"
    );
    assert!(store.due_catalogues().unwrap().is_empty());
}

#[test]
fn only_article_sources_default_to_catalogue() {
    let store = Store::memory();
    for (n, kind) in [
        SourceKind::Feed,
        SourceKind::Page,
        SourceKind::Hn,
        SourceKind::X,
        SourceKind::Podcast,
        SourceKind::Youtube,
        SourceKind::Author,
    ]
    .into_iter()
    .enumerate()
    {
        let s = store
            .add_source(&format!("https://s{n}.example/feed"), kind, None, NOW)
            .unwrap()
            .0;
        assert_eq!(s.catalogue_enabled, n < 2);
    }
    assert_eq!(store.due_catalogues().unwrap().len(), 2);
}

#[test]
fn metadata_and_polls_deduplicate_canonical_urls_without_overwriting_actions() {
    let store = Store::memory();
    let source = source(&store);
    store
        .insert_items(source.id, &[entry("a", 0)], NOW, true)
        .unwrap();
    let id = store.items(0, 1, None).unwrap().items[0].id;
    store.set_liked(id, true, NOW).unwrap();
    store.set_note(id, "A useful point", NOW).unwrap();
    store.set_saved(id, "inspiration/a.md").unwrap();
    store
        .set_full_text(id, Some("The original full text"), NOW)
        .unwrap();
    let second = store
        .add_source("https://other.example/feed", SourceKind::Feed, None, NOW)
        .unwrap()
        .0;
    let mut duplicate = entry("archive-guid", 1000);
    duplicate.url = Some("https://essays.example/a?utm_medium=archive#heading".into());
    assert_eq!(
        store
            .insert_catalogue_items(second.id, &[duplicate.clone()], NOW)
            .unwrap(),
        0
    );
    assert_eq!(
        store
            .insert_items(second.id, &[duplicate], NOW, true)
            .unwrap(),
        0
    );
    let kept = store.item(id).unwrap();
    assert!(kept.liked && !kept.back_catalogue);
    assert_eq!(kept.note.as_deref(), Some("A useful point"));
    assert_eq!(kept.saved_path.as_deref(), Some("inspiration/a.md"));
    assert_eq!(
        store.content(id).unwrap().as_deref(),
        Some("The original full text")
    );
    assert_eq!(kept.published_at, Some(NOW));
    assert_eq!(
        store
            .insert_catalogue_items(source.id, &[entry("old", 500)], NOW)
            .unwrap(),
        1
    );
    let old = ids(&store)[0];
    assert_eq!(store.content(old).unwrap(), None);
    assert!(!store.item(old).unwrap().has_content);
    store
        .set_full_text(old, Some("Lazily fetched"), NOW)
        .unwrap();
    store
        .insert_catalogue_items(source.id, &[entry("old", 600)], NOW + DAY)
        .unwrap();
    store
        .insert_items(source.id, &[entry("old", 700)], NOW + DAY, false)
        .unwrap();
    assert_eq!(store.item(old).unwrap().published_at, Some(NOW - 500 * DAY));
    assert_eq!(
        store.content(old).unwrap().as_deref(),
        Some("Lazily fetched")
    );
}

#[test]
fn daily_admissions_survive_refresh_restart_size_changes_and_hidden_sources() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("feed.sqlite");
    let store = Store::open(&path).unwrap();
    let source = source(&store);
    let entries: Vec<_> = (0..10)
        .map(|n| entry(&format!("old{n}"), 100 + n))
        .collect();
    store
        .insert_catalogue_items(source.id, &entries, NOW)
        .unwrap();
    let order = ids(&store);
    assert_eq!(store.release_catalogue(&order, NOW).unwrap(), order[..2]);
    for n in [1, 8, 20] {
        assert!(
            store
                .release_catalogue(&order.iter().rev().copied().collect::<Vec<_>>(), NOW + 1)
                .unwrap()
                .is_empty()
        );
        assert!(store.items(0, n, None).unwrap().items.len() <= 2);
    }
    store.set_catalogue_enabled(source.id, false).unwrap();
    assert!(store.catalogue_visible_ids().unwrap().is_empty());
    assert!(store.release_catalogue(&order, NOW).unwrap().is_empty());
    store.set_catalogue_enabled(source.id, true).unwrap();
    drop(store);
    let store = Store::open(&path).unwrap();
    assert_eq!(store.catalogue_visible_ids().unwrap(), order[..2]);
    assert!(store.release_catalogue(&order, NOW + 2).unwrap().is_empty());
    assert_eq!(
        store.release_catalogue(&order, NOW + DAY).unwrap(),
        order[2..4]
    );
    assert_eq!(
        store.release_catalogue(&order, NOW + 2 * DAY).unwrap(),
        order[4..6]
    );
    let page = store.items(0, 100, None).unwrap();
    assert_eq!(page.total, 2);
    assert_eq!(
        page.items.len(),
        2,
        "newest must cap accumulated releases too"
    );
    for item in page.items {
        assert!(item.back_catalogue && item.published_at.unwrap() < NOW - 30 * DAY);
    }
}

#[test]
fn switch_hides_old_candidates_and_releases_but_not_new_posts() {
    let store = Store::memory();
    let source = source(&store);
    store
        .insert_items(
            source.id,
            &[entry("fresh", 0), entry("old", 100)],
            NOW,
            true,
        )
        .unwrap();
    assert_eq!(store.items(0, 10, None).unwrap().total, 1);
    let order = ids(&store);
    store.set_catalogue_enabled(source.id, false).unwrap();
    assert!(ids(&store).is_empty());
    assert!(store.release_catalogue(&order, NOW).unwrap().is_empty());
    assert_eq!(store.items(0, 10, None).unwrap().total, 1);
    store.set_catalogue_enabled(source.id, true).unwrap();
    assert_eq!(store.release_catalogue(&order, NOW).unwrap(), order);
    assert_eq!(store.items(0, 10, None).unwrap().total, 2);
    store.set_catalogue_enabled(source.id, false).unwrap();
    assert_eq!(store.items(0, 10, None).unwrap().total, 1);
    assert_eq!(store.source(source.id).unwrap().catalogue_count, 1);
}

#[test]
fn old_poll_entries_wait_indefinitely_and_keep_original_dates() {
    let store = Store::memory();
    let source = source(&store);
    assert_eq!(
        store
            .insert_items(source.id, &[entry("old", 3650)], NOW, true)
            .unwrap(),
        0
    );
    assert_eq!(store.items(0, 10, None).unwrap().total, 0);
    let order = ids(&store);
    let original = store.item(order[0]).unwrap();
    assert_eq!(original.published_at, Some(NOW - 3650 * DAY));
    assert_eq!(store.expire(NOW + 365 * DAY).unwrap(), 0);
    assert_eq!(ids(&store), order);
    let release = NOW + 366 * DAY;
    store.release_catalogue(&order, release).unwrap();
    let item = store.items(0, 10, None).unwrap().items.remove(0);
    assert_eq!(item.published_at, original.published_at);
    assert_eq!(item.sort_at, original.sort_at);
    store
        .log(&super::super::Event {
            at: release * 1000,
            kind: "impression".into(),
            item_id: Some(item.id),
            surface: Some("newest".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(store.expire(release + EXPIRE_AFTER - 1).unwrap(), 0);
    assert_eq!(store.expire(release + EXPIRE_AFTER + 1).unwrap(), 1);
    assert!(store.items(0, 10, None).unwrap().items.is_empty());
    assert!(ids(&store).is_empty());
    store
        .insert_catalogue_items(source.id, &[entry("old", 3650)], release + EXPIRE_AFTER + 2)
        .unwrap();
    assert!(
        ids(&store).is_empty(),
        "expired decisions cannot be revived by rediscovery"
    );
}

#[test]
fn ageing_feed_entries_join_pool_and_reacted_releases_persist() {
    let store = Store::memory();
    let source = source(&store);
    store
        .insert_items(source.id, &[entry("fresh", 0)], NOW, true)
        .unwrap();
    assert_eq!(store.expire(NOW + 31 * DAY).unwrap(), 1);
    let order = ids(&store);
    assert_eq!(order.len(), 1);
    store.release_catalogue(&order, NOW + 100 * DAY).unwrap();
    store.set_saved(order[0], "inspiration/a.md").unwrap();
    store
        .set_full_text(order[0], Some("Preserved full text"), NOW + 100 * DAY)
        .unwrap();
    assert_eq!(store.expire(NOW + 1000 * DAY).unwrap(), 0);
    assert_eq!(
        store.content(order[0]).unwrap().as_deref(),
        Some("Preserved full text")
    );
    assert_eq!(store.catalogue_visible_ids().unwrap(), order);
}

#[test]
fn neighbours_require_positive_link_and_share_total_quota_with_one_daily_slot() {
    let store = Store::memory();
    let source = source(&store);
    let mut anchor = entry("anchor", 0);
    anchor.content =
        Some("Read [A](https://a.example/essay) and [B](https://b.example/essay).".into());
    store.insert_items(source.id, &[anchor], NOW, true).unwrap();
    let anchor = store.items(0, 1, None).unwrap().items[0].id;
    assert!(
        store
            .insert_suggested_catalogue(
                "https://a.example/feed",
                Some("A"),
                anchor,
                &[entry("a1", 300)],
                NOW
            )
            .is_err()
    );
    store.set_liked(anchor, true, NOW).unwrap();
    assert!(
        store
            .insert_suggested_catalogue(
                "https://unlinked.example/feed",
                None,
                anchor,
                &[entry("a1", 300)],
                NOW
            )
            .is_err()
    );
    let a: Vec<_> = (0..5).map(|n| entry(&format!("a{n}"), 100)).collect();
    assert_eq!(
        store
            .insert_suggested_catalogue("https://a.example/feed", Some("A"), anchor, &a, NOW)
            .unwrap(),
        3
    );
    store
        .insert_suggested_catalogue(
            "https://b.example/feed",
            Some("B"),
            anchor,
            &[entry("b1", 300)],
            NOW,
        )
        .unwrap();
    assert_eq!(store.sources().unwrap().len(), 1);
    assert_eq!(store.due(NOW, true).unwrap().len(), 1);
    let suggestions = ids(&store);
    store
        .insert_catalogue_items(
            source.id,
            &[entry("followed1", 300), entry("followed2", 300)],
            NOW,
        )
        .unwrap();
    let mut order = suggestions.clone();
    order.extend(
        ids(&store)
            .into_iter()
            .filter(|id| !suggestions.contains(id)),
    );
    let released = store.release_catalogue(&order, NOW).unwrap();
    assert_eq!(released.len(), 2);
    assert_eq!(
        released
            .iter()
            .filter(|id| suggestions.contains(id))
            .count(),
        1
    );
    let item = store.item(released[0]).unwrap();
    let suggestion = item.suggestion.unwrap();
    assert_eq!(suggestion.source_url, "https://a.example/feed");
    assert!(suggestion.reason.contains("Essay anchor"));
    let followed = store.follow_suggestion(item.id, NOW).unwrap();
    assert_eq!(followed.catalogue_state, "queued");
    assert_eq!(store.sources().unwrap().len(), 2);
    assert!(store.item(item.id).unwrap().suggestion.is_none());
    assert!(store.release_catalogue(&order, NOW + 1).unwrap().is_empty());
    store
        .mark_neighbour_checked("https://b.example/feed?utm_source=link#top", NOW)
        .unwrap();
    assert!(store.neighbour_checked("https://b.example/feed").unwrap());
}

#[test]
fn undoing_positive_anchor_prevents_pending_neighbour_release() {
    let store = Store::memory();
    let source = source(&store);
    let mut anchor = entry("anchor", 0);
    anchor.content = Some("[A](https://a.example/essay)".into());
    store.insert_items(source.id, &[anchor], NOW, true).unwrap();
    let anchor = store.items(0, 1, None).unwrap().items[0].id;
    store.set_liked(anchor, true, NOW).unwrap();
    store
        .insert_suggested_catalogue(
            "https://a.example/feed",
            None,
            anchor,
            &[entry("a", 300)],
            NOW,
        )
        .unwrap();
    let order = ids(&store);
    store.set_liked(anchor, false, NOW + 1).unwrap();
    assert!(ids(&store).is_empty());
    assert!(store.release_catalogue(&order, NOW + 2).unwrap().is_empty());
}

#[test]
fn migration_recovers_only_unseen_stale_on_arrival_article_history() {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(SCHEMA).unwrap();
    db.pragma_update(None, "user_version", 1).unwrap();
    for (id, kind) in [(1, "feed"), (2, "podcast")] {
        db.execute(
            "INSERT INTO sources (id, url, kind, added_at) VALUES (?1, ?2, ?3, ?4)",
            params![id, format!("https://s{id}.example"), kind, NOW],
        )
        .unwrap();
    }
    for (id, source, expired) in [
        (1, 1, NOW),
        (2, 1, NOW),
        (3, 1, NOW + 31 * DAY),
        (4, 1, NOW),
        (5, 1, NOW),
        (6, 2, NOW),
    ] {
        db.execute("INSERT INTO items (id, source_id, guid, url, title, content, published_at, fetched_at, sort_at, expired_at)
            VALUES (?1, ?2, ?3, ?4, ?3, 'Feed text', ?5, ?6, ?5, ?7)",
            params![id, source, format!("old{id}"), format!("https://s{source}.example/{id}"), NOW - 100 * DAY, NOW, expired]).unwrap();
    }
    db.execute(
        "INSERT INTO events (at, kind, item_id) VALUES (?1, 'impression', 2)",
        [NOW * 1000],
    )
    .unwrap();
    db.execute(
        "INSERT INTO events (at, kind, item_id, surface) VALUES (?1, 'kin_pick', 4, 'kin')",
        [NOW * 1000],
    )
    .unwrap();
    db.execute("UPDATE items SET dismissed_at = ?1 WHERE id = 5", [NOW])
        .unwrap();
    let store = Store::init(db).unwrap();
    assert_eq!(ids(&store), [1, 4]);
    assert_eq!(store.item(1).unwrap().published_at, Some(NOW - 100 * DAY));
    assert_eq!(store.content(1).unwrap(), None);
    for id in [2, 3, 5, 6] {
        assert!(
            store
                .raw()
                .query_row(
                    "SELECT expired_at IS NOT NULL FROM items WHERE id = ?1",
                    [id],
                    |r| r.get::<_, bool>(0)
                )
                .unwrap()
        );
    }
}

#[test]
fn lazy_catalogue_metadata_fills_unknown_date_without_replacing_known_dates() {
    let store = Store::memory();
    let source = source(&store);
    let mut unknown = entry("slug-title", 0);
    unknown.title = Some("slug title".into());
    unknown.published_at = None;
    store
        .insert_catalogue_items(source.id, &[unknown, entry("dated", 500)], NOW)
        .unwrap();
    let order = ids(&store);
    let unknown = order[0];
    store
        .set_catalogue_metadata(
            unknown,
            Some("The original essay title"),
            Some("Author"),
            Some(NOW - 700 * DAY),
        )
        .unwrap();
    let item = store.item(unknown).unwrap();
    assert_eq!(item.title.as_deref(), Some("The original essay title"));
    assert_eq!(item.author.as_deref(), Some("Author"));
    assert_eq!(item.published_at, Some(NOW - 700 * DAY));
    assert_eq!(item.sort_at, NOW - 700 * DAY);
    store
        .set_catalogue_metadata(unknown, Some(""), Some("Changed author"), Some(NOW))
        .unwrap();
    assert_eq!(store.item(unknown).unwrap().published_at, item.published_at);
    assert_eq!(store.item(unknown).unwrap().author, item.author);
    store
        .set_catalogue_metadata(order[1], None, None, Some(NOW))
        .unwrap();
    assert_eq!(
        store.item(order[1]).unwrap().published_at,
        Some(NOW - 500 * DAY)
    );
    store
        .insert_items(source.id, &[entry("fresh", 0)], NOW, false)
        .unwrap();
    let fresh = store.items(0, 1, None).unwrap().items[0].id;
    store
        .set_catalogue_metadata(fresh, Some("Wrong title"), None, Some(NOW - 1000 * DAY))
        .unwrap();
    assert_eq!(
        store.item(fresh).unwrap().title.as_deref(),
        Some("Essay fresh")
    );
}

fn suggested_item(store: &Store, origin: &str) -> i64 {
    let source = source(store);
    let mut anchor = entry("anchor", 0);
    anchor.content = Some(format!("[A useful external essay]({origin}/essay)"));
    store.insert_items(source.id, &[anchor], NOW, true).unwrap();
    let anchor = store.items(0, 1, None).unwrap().items[0].id;
    store.set_liked(anchor, true, NOW).unwrap();
    let mut candidate = entry("shared-guid", 300);
    candidate.url = Some(format!("{origin}/essay"));
    store
        .insert_suggested_catalogue(origin, Some("Neighbour"), anchor, &[candidate], NOW)
        .unwrap();
    store
        .rank_rows()
        .unwrap()
        .into_iter()
        .find(|r| r.suggested)
        .unwrap()
        .id
}

#[test]
fn follow_promotes_real_feed_and_retries_are_idempotent() {
    let store = Store::memory();
    let item = suggested_item(&store, "https://near.example");
    let followed = store
        .follow_suggestion_target(item, NOW, "https://near.example/feed.xml", SourceKind::Feed)
        .unwrap();
    assert_eq!(followed.kind, SourceKind::Feed);
    assert_eq!(followed.url, "https://near.example/feed.xml");
    assert_eq!(store.item(item).unwrap().source_id, followed.id);
    assert!(store.item(item).unwrap().suggestion.is_none());
    assert_eq!(
        store.follow_suggestion(item, NOW + DAY).unwrap().added_at,
        NOW
    );
    assert_eq!(
        store
            .follow_suggestion_target(item, NOW + DAY, "https://near.example", SourceKind::Page)
            .unwrap()
            .id,
        followed.id
    );
    store.remove_source(followed.id, NOW + DAY).unwrap();
    assert!(store.follow_suggestion(item, NOW + DAY + 1).is_err());
}

#[test]
fn follow_merges_existing_target_without_losing_ids_actions_or_release_quotas() {
    let store = Store::memory();
    let item = suggested_item(&store, "https://near.example");
    let hidden = store.item(item).unwrap().source_id;
    store.release_catalogue(&[item], NOW).unwrap();
    store.set_saved(item, "inspiration/near.md").unwrap();
    store
        .set_full_text(item, Some("The whole neighbouring essay"), NOW)
        .unwrap();
    let target = store
        .add_source(
            "https://near.example/feed.xml",
            SourceKind::Feed,
            Some("Already followed"),
            NOW,
        )
        .unwrap()
        .0;
    // The target's unrelated item uses the same source-scoped GUID.
    let mut conflict = entry("shared-guid", 0);
    conflict.url = Some("https://near.example/another".into());
    store
        .insert_items(target.id, &[conflict], NOW, true)
        .unwrap();
    let followed = store
        .follow_suggestion_target(item, NOW, &target.url, SourceKind::Feed)
        .unwrap();
    assert_eq!(followed.id, target.id);
    let kept = store.item(item).unwrap();
    assert_eq!(kept.source_id, target.id);
    assert_eq!(kept.saved_path.as_deref(), Some("inspiration/near.md"));
    assert_eq!(
        store.content(item).unwrap().as_deref(),
        Some("The whole neighbouring essay")
    );
    assert!(kept.suggestion.is_none());
    assert_eq!(
        store
            .raw()
            .query_row(
                "SELECT COUNT(*) FROM items WHERE source_id = ?1",
                [target.id],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        2
    );
    assert!(store.source(hidden).is_err());
    assert_eq!(
        store
            .raw()
            .query_row(
                "SELECT COUNT(*) FROM catalogue_releases WHERE day = ?1 AND suggested = 1",
                [NOW.div_euclid(DAY)],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    assert_eq!(
        store.follow_suggestion(item, NOW + 1).unwrap().id,
        target.id
    );
}

#[test]
fn follow_never_revives_an_explicitly_removed_target() {
    let store = Store::memory();
    let item = suggested_item(&store, "https://near.example");
    let target = store
        .add_source("https://near.example/feed.xml", SourceKind::Feed, None, NOW)
        .unwrap()
        .0;
    store.remove_source(target.id, NOW).unwrap();
    assert!(
        store
            .follow_suggestion_target(item, NOW, &target.url, SourceKind::Feed)
            .is_err()
    );
    assert!(store.item(item).unwrap().suggestion.is_some());
    assert!(store.source(target.id).is_err());
}

#[test]
fn concurrent_connections_cannot_overspend_daily_quota() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("feed.sqlite");
    let store = Store::open(&path).unwrap();
    let source = source(&store);
    store
        .insert_catalogue_items(
            source.id,
            &(0..8)
                .map(|n| entry(&format!("old{n}"), 100))
                .collect::<Vec<_>>(),
            NOW,
        )
        .unwrap();
    let order = ids(&store);
    let other_order = order.iter().rev().copied().collect::<Vec<_>>();
    let other = Store::open(&path).unwrap();
    let handle = std::thread::spawn(move || other.release_catalogue(&other_order, NOW).unwrap());
    let first = store.release_catalogue(&order, NOW).unwrap();
    let second = handle.join().unwrap();
    assert_eq!(first.len() + second.len(), 2);
    assert_eq!(store.catalogue_visible_ids().unwrap().len(), 2);
}

#[test]
fn seen_ignored_articles_expire_but_unseen_work_can_enter_the_pool() {
    let store = Store::memory();
    let source = source(&store);
    store
        .insert_items(
            source.id,
            &[entry("seen", 0), entry("unseen", 0)],
            NOW,
            true,
        )
        .unwrap();
    let seen = store
        .items(0, 10, None)
        .unwrap()
        .items
        .into_iter()
        .find(|item| item.title.as_deref() == Some("Essay seen"))
        .unwrap()
        .id;
    store
        .log(&super::super::Event {
            at: NOW * 1000,
            kind: "impression".into(),
            item_id: Some(seen),
            surface: Some("newest".into()),
            ..Default::default()
        })
        .unwrap();
    store.expire(NOW + 31 * DAY).unwrap();
    let rows = store.rank_rows().unwrap();
    let seen = rows.iter().find(|row| row.id == seen).unwrap();
    assert!(!seen.visible && !seen.back_catalogue && !seen.catalogue_candidate);
    assert_eq!(rows.iter().filter(|row| row.catalogue_candidate).count(), 1);
}

#[test]
fn release_due_gate_checks_quota_candidates_and_source_switches() {
    let store = Store::memory();
    let source = source(&store);
    assert!(!store.catalogue_release_due(NOW).unwrap());
    let entries: Vec<_> = (0..4).map(|n| entry(&format!("old{n}"), 300)).collect();
    store
        .insert_catalogue_items(source.id, &entries, NOW)
        .unwrap();
    assert!(store.catalogue_release_due(NOW).unwrap());
    store.set_catalogue_enabled(source.id, false).unwrap();
    assert!(!store.catalogue_release_due(NOW).unwrap());
    store.set_catalogue_enabled(source.id, true).unwrap();
    store.set_muted(source.id, true).unwrap();
    assert!(!store.catalogue_release_due(NOW).unwrap());
    store.set_muted(source.id, false).unwrap();
    store.release_catalogue(&ids(&store), NOW).unwrap();
    assert!(!store.catalogue_release_due(NOW + 1).unwrap());
    assert!(store.catalogue_release_due(NOW + DAY).unwrap());
}

#[test]
fn release_due_gate_honours_neighbour_slot_before_total_quota_is_full() {
    let store = Store::memory();
    let first = suggested_item(&store, "https://a.example");
    suggested_item(&store, "https://b.example");
    let second = ids(&store).into_iter().find(|id| *id != first).unwrap();
    assert!(store.catalogue_release_due(NOW).unwrap());
    store.release_catalogue(&[first], NOW).unwrap();
    assert!(
        !store.catalogue_release_due(NOW).unwrap(),
        "only a second neighbour remains"
    );
    let source = source(&store);
    store
        .insert_catalogue_items(source.id, &[entry("followed", 300)], NOW)
        .unwrap();
    assert!(store.catalogue_release_due(NOW).unwrap());
    store.set_catalogue_enabled(source.id, false).unwrap();
    assert!(!store.catalogue_release_due(NOW).unwrap());
    assert!(store.catalogue_release_due(NOW + DAY).unwrap());
    assert!(
        store
            .rank_rows()
            .unwrap()
            .iter()
            .any(|r| r.id == second && r.catalogue_candidate)
    );
}

#[test]
fn dormant_metadata_skips_vectors_but_all_training_examples_remain() {
    let store = Store::memory();
    let source = source(&store);
    let entries: Vec<_> = [
        "plain",
        "liked",
        "noted",
        "saved",
        "dismissed",
        "human",
        "kin",
        "kin-surface",
    ]
    .iter()
    .map(|guid| entry(guid, 300))
    .collect();
    store
        .insert_catalogue_items(source.id, &entries, NOW)
        .unwrap();
    let rows = store.rank_rows().unwrap();
    let id = |guid: &str| {
        rows.iter()
            .find(|r| r.title == format!("Essay {guid}"))
            .unwrap()
            .id
    };
    store.set_liked(id("liked"), true, NOW).unwrap();
    store.set_note(id("noted"), "A note", NOW).unwrap();
    store
        .set_saved(id("saved"), "inspiration/saved.md")
        .unwrap();
    store.set_dismissed(id("dismissed"), true, NOW).unwrap();
    for (guid, kind, surface) in [
        ("human", "impression", "newest"),
        ("kin", "kin_pick", "kin"),
        ("kin-surface", "open", "kin"),
    ] {
        store
            .log(&super::super::Event {
                at: NOW * 1000,
                kind: kind.into(),
                item_id: Some(id(guid)),
                surface: Some(surface.into()),
                ..Default::default()
            })
            .unwrap();
    }
    for row in store.rank_rows().unwrap() {
        let signal = [
            "Essay liked",
            "Essay noted",
            "Essay saved",
            "Essay dismissed",
            "Essay human",
        ]
        .contains(&row.title.as_str());
        assert_eq!(row.has_signal, signal, "{}", row.title);
        assert_eq!(row.needed_for_ranking(false), signal, "{}", row.title);
        assert!(row.needed_for_ranking(true));
    }
    // A prior human action still trains after undo and source disablement.
    store.set_liked(id("liked"), false, NOW + 1).unwrap();
    store
        .log(&super::super::Event {
            at: (NOW + 1) * 1000,
            kind: "unlike".into(),
            item_id: Some(id("liked")),
            ..Default::default()
        })
        .unwrap();
    store.set_catalogue_enabled(source.id, false).unwrap();
    let rows = store.rank_rows().unwrap();
    assert!(
        rows.iter()
            .find(|r| r.id == id("liked"))
            .unwrap()
            .needed_for_ranking(false)
    );
    assert!(
        !rows
            .iter()
            .find(|r| r.id == id("plain"))
            .unwrap()
            .needed_for_ranking(true)
    );
}

#[test]
fn lazy_capture_preserves_authoritative_title_while_filling_unknown_metadata() {
    let store = Store::memory();
    let source = source(&store);
    let mut known = entry("accurate-title.html", 0);
    known.title = Some("The publisher's actual title".into());
    known.published_at = None;
    store
        .insert_catalogue_items(source.id, &[known], NOW)
        .unwrap();
    let id = ids(&store)[0];
    store
        .set_catalogue_metadata(
            id,
            Some("SEO title | Website"),
            Some("Author"),
            Some(NOW - 700 * DAY),
        )
        .unwrap();
    let item = store.item(id).unwrap();
    assert_eq!(item.title.as_deref(), Some("The publisher's actual title"));
    assert_eq!(item.author.as_deref(), Some("Author"));
    assert_eq!(item.published_at, Some(NOW - 700 * DAY));
    store
        .set_catalogue_metadata(
            id,
            Some("Another SEO title"),
            Some("Other author"),
            Some(NOW),
        )
        .unwrap();
    assert_eq!(store.item(id).unwrap(), item);
    assert_eq!(
        url_title("https://a.example/posts/a-useful_essay.html/"),
        Some("a useful essay".into())
    );
    assert_eq!(
        url_title("https://a.example/a_useful-essay.htm"),
        Some("a useful essay".into())
    );
}

#[test]
fn unseen_releases_wait_for_human_exposure_before_expiry_clock_starts() {
    let store = Store::memory();
    let source = source(&store);
    store
        .insert_catalogue_items(
            source.id,
            &[entry("unseen", 300), entry("seen-later", 300)],
            NOW,
        )
        .unwrap();
    let order = ids(&store);
    store.release_catalogue(&order, NOW).unwrap();
    for (kind, surface) in [("kin_pick", "kin"), ("open", "kin")] {
        store
            .log(&super::super::Event {
                at: NOW * 1000,
                kind: kind.into(),
                item_id: Some(order[0]),
                surface: Some(surface.into()),
                ..Default::default()
            })
            .unwrap();
    }
    let first_exposure = NOW + 100 * DAY;
    assert_eq!(store.expire(first_exposure).unwrap(), 0);
    assert_eq!(store.catalogue_visible_ids().unwrap(), order);
    assert!(
        store
            .rank_rows()
            .unwrap()
            .iter()
            .filter(|r| r.back_catalogue)
            .all(|r| r.needed_for_ranking(false))
    );
    store
        .log(&super::super::Event {
            at: first_exposure * 1000,
            kind: "impression".into(),
            item_id: Some(order[1]),
            surface: Some("picked".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(store.expire(first_exposure + 1).unwrap(), 0);
    assert_eq!(store.expire(first_exposure + EXPIRE_AFTER - 1).unwrap(), 0);
    assert_eq!(store.expire(first_exposure + EXPIRE_AFTER + 1).unwrap(), 1);
    assert_eq!(store.catalogue_visible_ids().unwrap(), [order[0]]);
}
