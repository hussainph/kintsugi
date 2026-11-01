use super::*;
use std::fs;
use std::path::Path;
use std::sync::Arc;

const SLEEP: &[&str] = &["sleep", "rest", "nap", "insomnia", "tired", "bedtime", "dreams", "asleep"];
const POTTERY: &[&str] = &["kiln", "pottery", "ceramics", "glaze", "clay", "potter", "firing"];
const MONEY: &[&str] = &["money", "budget", "finance", "savings", "spending"];
const WRITING: &[&str] = &["writing", "essay", "draft", "prose", "blog"];
const ATTENTION: &[&str] = &["attention", "focus", "distraction", "concentration"];
const SOFTWARE: &[&str] = &["api", "endpoints", "verbs", "resources", "routes", "status", "codes", "server"];

fn model() -> Arc<dyn Embedder> {
    Arc::new(embed::fixture(&[SLEEP, POTTERY, MONEY, WRITING, ATTENTION, SOFTWARE]))
}

fn write(root: &Path, rel: &str, text: &str) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

fn clip(title: &str, site: &str, tags: &str, own: &str, source: &str) -> String {
    format!(
        "---\nkind: link\ntitle: \"{title}\"\nurl: \"https://www.example.com/{}\"\nsite: \"{site}\"\ncaptured: \"2026-10-29T14:05\"\ntags: [{tags}]\n---\n\n{own}\n\n<!-- kintsugi:source -->\n## Source\n\n{source}\n",
        title.len()
    )
}

/// A vault with writing, a note, clips, and things search must never see.
fn vault() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(root, "posts/why-i-nap.md", "---\ntitle: Why I nap\nstatus: complete\n---\n\nAn afternoon nap resets me. Dreams arrive fast.\n");
    write(root, "posts/rest-api.md", "---\ntitle: Designing a REST API\n---\n\nRest endpoints, verbs, resources, routes and status codes for the server.\n");
    write(root, "drafts/kiln.mdx", "---\ntitle: Firing the kiln\nstatus: draft\n---\n\nMy grandmother's kiln. The glaze ran and the clay cracked.\n");
    write(root, "posts/budget.md", "# Monthly budget\n\nTracking spending and savings every month.\n");
    write(root, "inbox/2026-11-01.md", "On the train: distraction everywhere, focus is a muscle.\n");
    write(
        root,
        "inspiration/why-we-sleep.md",
        &clip("Why we sleep", "The New Yorker", "science", "Insomnia at bedtime.", "A long article about insomnia and being tired."),
    );
    write(root, "inspiration/anagama.md", &clip("Anagama", "Ceramics Monthly", "craft", "", "Pottery fired for days in a tunnel kiln."));
    write(root, ".kintsugi/agent/NOTES.md", "secret insomnia notes\n");
    write(root, "posts/image.png", "insomnia");
    dir
}

fn indexed(root: &Path, embedder: Option<Arc<dyn Embedder>>) -> Index {
    let mut index = Index::open_in_memory().unwrap();
    if let Some(embedder) = embedder {
        index.set_embedder(embedder).unwrap();
    }
    vault::sync(&mut index, "v", root).unwrap();
    index
}

fn ids(index: &mut Index, query: &Query) -> Vec<String> {
    index.search(query).unwrap().into_iter().map(|h| h.id).collect()
}

fn q(text: &str) -> Query {
    Query::new(text, &["v"])
}

#[test]
fn words_alone_find_and_rank_writing_notes_and_clips() {
    let dir = vault();
    let mut index = indexed(dir.path(), None);
    let hits = index.search(&q("insomnia")).unwrap();
    assert_eq!(hits.iter().map(|h| h.id.as_str()).collect::<Vec<_>>(), ["inspiration/why-we-sleep.md"]);
    let hit = &hits[0];
    assert_eq!(hit.kind, Kind::Clip);
    assert_eq!(hit.title.as_deref(), Some("Why we sleep"));
    assert_eq!(hit.source.as_deref(), Some("The New Yorker"));
    assert!(hit.snippet.contains("nsomnia"), "{hit:?}");
    assert_eq!(hit.score, 1.0);
    assert!(hit.matched.words && !hit.matched.meaning);

    // Prefixes and stems: "kiln" finds the clip's "kiln", "kilns" finds "kiln".
    assert_eq!(ids(&mut index, &q("kilns")), ["drafts/kiln.mdx", "inspiration/anagama.md"]);
    assert_eq!(ids(&mut index, &q("distractions")), ["inbox/2026-11-01.md"]);
    assert_eq!(ids(&mut index, &q("budg")), ["posts/budget.md"]);
    // Titles weigh more than bodies.
    assert_eq!(ids(&mut index, &q("rest"))[0], "posts/rest-api.md");
    // Documents with every word rank above those with some.
    let found = ids(&mut index, &q("glaze train"));
    assert_eq!(found.len(), 2);
    let mut strict = q("glaze train");
    strict.all_terms = true;
    assert!(ids(&mut index, &strict).is_empty());
    // Kinds and folders filter.
    let mut notes = q("focus kiln");
    notes.kinds = vec![Kind::Note];
    assert_eq!(ids(&mut index, &notes), ["inbox/2026-11-01.md"]);
    let mut posts = q("kiln nap");
    posts.within = Some("posts/".into());
    assert_eq!(ids(&mut index, &posts), ["posts/why-i-nap.md"]);
    // Headings title untitled documents; hidden folders and non-text files are never indexed.
    assert_eq!(index.search(&q("budget")).unwrap()[0].title.as_deref(), Some("Monthly budget"));
    assert!(ids(&mut index, &q("secret")).is_empty());
    assert!(index.search(&q("   ")).unwrap().is_empty());
    // Query syntax is never interpreted.
    assert!(index.search(&q("\"kiln* OR NEAR(")).is_ok());
}

/// The relevance check: queries a person would type, with the documents
/// that should come back. Meaning finds what words alone miss, and fusing
/// both keeps exact matches on top.
#[test]
fn hybrid_search_finds_by_meaning_and_keeps_exact_matches_first() {
    let dir = vault();
    let cases: &[(&str, &[&str])] = &[
        ("insomnia", &["inspiration/why-we-sleep.md", "posts/why-i-nap.md"]),
        ("ceramics", &["inspiration/anagama.md", "drafts/kiln.mdx"]),
        ("savings", &["posts/budget.md"]),
        ("concentration", &["inbox/2026-11-01.md"]),
        ("tired at bedtime", &["inspiration/why-we-sleep.md", "posts/why-i-nap.md"]),
    ];
    let recall = |index: &mut Index| {
        let mut found = 0;
        let mut total = 0;
        for (query, expected) in cases {
            let top = ids(index, &Query { limit: expected.len().max(2), ..q(query) });
            found += expected.iter().filter(|e| top.contains(&e.to_string())).count();
            total += expected.len();
        }
        found as f32 / total as f32
    };
    let mut lexical = indexed(dir.path(), None);
    let mut hybrid = indexed(dir.path(), Some(model()));
    let (words, both) = (recall(&mut lexical), recall(&mut hybrid));
    assert_eq!(both, 1.0, "hybrid recall");
    assert!(words < 0.6, "words alone should miss the synonyms, got {words}");

    // The exact match leads; the meaning-only match follows.
    let hits = hybrid.search(&q("insomnia")).unwrap();
    assert_eq!(hits[0].id, "inspiration/why-we-sleep.md");
    assert!(hits[0].matched.words && hits[0].matched.meaning && hits[0].score == 1.0);
    let nap = hits.iter().find(|h| h.id == "posts/why-i-nap.md").unwrap();
    assert!(nap.matched.meaning && !nap.matched.words && nap.score < 1.0);
    assert!(nap.snippet.contains("nap"), "a meaning match shows its chunk: {nap:?}");
    // Unrelated documents don't ride along on noise.
    assert!(!hits.iter().any(|h| h.id == "posts/budget.md"), "{hits:?}");
    // "rest" is ambiguous: the REST API (words) and sleep (meaning) both show.
    let rest = ids(&mut hybrid, &q("rest"));
    assert!(rest.contains(&"posts/rest-api.md".into()) && rest.contains(&"posts/why-i-nap.md".into()), "{rest:?}");
    // Filters apply to meaning too.
    let mut clips = q("tired");
    clips.kinds = vec![Kind::Clip];
    assert_eq!(ids(&mut hybrid, &clips), ["inspiration/why-we-sleep.md"]);
}

#[test]
fn sync_reads_only_what_changed() {
    let dir = vault();
    let root = dir.path();
    let mut index = Index::open_in_memory().unwrap();
    assert_eq!(vault::sync(&mut index, "v", root).unwrap(), vault::Synced { indexed: 7, removed: 0 });
    assert_eq!(vault::sync(&mut index, "v", root).unwrap(), vault::Synced::default());

    write(root, "posts/budget.md", "# Monthly budget\n\nNow about lighthouses.\n");
    fs::remove_file(root.join("posts/why-i-nap.md")).unwrap();
    write(root, "drafts/new.md", "A lighthouse keeper's log.\n");
    assert_eq!(vault::sync(&mut index, "v", root).unwrap(), vault::Synced { indexed: 2, removed: 1 });
    assert_eq!(ids(&mut index, &q("lighthouse")), ["drafts/new.md", "posts/budget.md"]);
    assert!(ids(&mut index, &q("savings")).is_empty());
    assert!(ids(&mut index, &q("nap")).is_empty());
}

#[test]
fn feed_items_share_the_index_in_their_own_scope() {
    let dir = vault();
    let mut index = indexed(dir.path(), Some(model()));
    let item = Doc {
        id: "feed:42".into(),
        kind: Some(Kind::Feed),
        title: Some("Naps at work".into()),
        source: Some("Hacker News".into()),
        body: "A study of afternoon naps.".into(),
        stamp: "1".into(),
        ..Doc::default()
    };
    index.upsert(FEED_SCOPE, &[item]).unwrap();
    // Vault searches don't see the Feed unless they ask for it.
    assert!(!ids(&mut index, &q("naps")).contains(&"feed:42".into()));
    let both = Query::new("naps", &["v", FEED_SCOPE]);
    let hits = index.search(&both).unwrap();
    let feed = hits.iter().find(|h| h.id == "feed:42").unwrap();
    assert_eq!((feed.kind, feed.source.as_deref()), (Kind::Feed, Some("Hacker News")));
    // A vault sync never removes feed items.
    vault::sync(&mut index, "v", dir.path()).unwrap();
    assert_eq!(index.stamps(FEED_SCOPE).unwrap().len(), 1);
    index.remove(FEED_SCOPE, &["feed:42".into()]).unwrap();
    assert!(index.stamps(FEED_SCOPE).unwrap().is_empty());
}

#[test]
fn the_index_persists_and_re_embeds_when_the_model_changes() {
    let dir = vault();
    let data = tempfile::tempdir().unwrap();
    let file = data.path().join("search/index.sqlite");
    {
        let mut index = Index::open(&file).unwrap();
        vault::sync(&mut index, "v", dir.path()).unwrap();
    }
    // Reopened: nothing to re-read, and a model fills in every vector.
    let mut index = Index::open(&file).unwrap();
    assert_eq!(vault::sync(&mut index, "v", dir.path()).unwrap(), vault::Synced::default());
    index.set_embedder(model()).unwrap();
    assert_eq!(index.embed_missing(usize::MAX).unwrap(), 7);
    assert_eq!(index.embed_missing(usize::MAX).unwrap(), 0);
    assert!(index.search(&q("concentration")).unwrap()[0].matched.meaning);

    struct Other;
    impl Embedder for Other {
        fn id(&self) -> &str {
            "other"
        }
        fn embed(&self, texts: &[String]) -> Vec<Vec<f32>> {
            texts.iter().map(|_| vec![1.0]).collect()
        }
    }
    index.set_embedder(Arc::new(Other)).unwrap();
    assert_eq!(index.embed_missing(usize::MAX).unwrap(), 7, "a new model re-embeds everything");
}

#[test]
fn snippets_stay_short_on_long_documents() {
    let dir = tempfile::tempdir().unwrap();
    let long = (0..400).map(|i| format!("Paragraph {i} about nothing much at all.")).collect::<Vec<_>>().join("\n\n");
    write(dir.path(), "posts/long.md", &format!("{long}\n\nThe lighthouse appears near the end.\n\n{long}"));
    let mut index = indexed(dir.path(), None);
    let hit = &index.search(&q("lighthouse")).unwrap()[0];
    assert!(hit.snippet.contains("lighthouse") && hit.snippet.chars().count() <= SNIPPET_CHARS + 1, "{hit:?}");
}

/// The real model, downloaded into a temporary folder. Run with
/// `cargo test -p kintsugi-search -- --ignored` to check the pinned hashes
/// and that potion-base-8M separates meaning at `MIN_SIMILARITY`.
#[test]
#[ignore]
fn live_potion_base_8m() {
    // Kept between runs, outside the repository.
    let models = std::env::temp_dir().join("kintsugi-search-live-model");
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let model = runtime.block_on(POTION_BASE_8M.ensure(&models, &reqwest::Client::new())).unwrap();
    assert!(POTION_BASE_8M.verified(&models));
    let model: Arc<dyn Embedder> = Arc::new(model);
    let v = model.embed(&[
        "I can't sleep at night".into(),
        "insomnia and being tired".into(),
        "the quarterly budget spreadsheet".into(),
    ]);
    let cos = |a: &[f32], b: &[f32]| a.iter().zip(b).map(|(x, y)| x * y).sum::<f32>();
    println!("related {} unrelated {}", cos(&v[0], &v[1]), cos(&v[0], &v[2]));
    let probes = ["trouble falling asleep", "ceramics", "personal finance", "staying focused", "insomnia", "rest", "zebra", "the"];
    let docs = ["Why I nap\nAn afternoon nap resets me. Dreams arrive fast.", "Designing a REST API\nRest endpoints, verbs, resources, routes and status codes for the server.", "Firing the kiln\nMy grandmother's kiln. The glaze ran and the clay cracked.", "Monthly budget\nTracking spending and savings every month.", "On the train: distraction everywhere, focus is a muscle.", "Why we sleep\nscience\nInsomnia at bedtime.\n\nA long article about insomnia and being tired.", "Anagama\ncraft\nPottery fired for days in a tunnel kiln."];
    let dv = model.embed(&docs.iter().map(|d| d.to_string()).collect::<Vec<_>>());
    for p in probes {
        let pv = model.embed(&[p.to_string()]).pop().unwrap();
        println!("{p:>24}: {:?}", dv.iter().map(|d| (cos(&pv, d) * 100.0).round() / 100.0).collect::<Vec<_>>());
    }
    assert!(cos(&v[0], &v[1]) > MIN_SIMILARITY && cos(&v[0], &v[2]) < MIN_SIMILARITY);

    let dir = vault();
    let mut index = indexed(dir.path(), Some(model));
    for query in ["trouble falling asleep", "ceramics", "personal finance", "staying focused"] {
        let hits = index.search(&q(query)).unwrap();
        println!("{query}: {:?}", hits.iter().map(|h| (&h.id, h.score)).collect::<Vec<_>>());
    }
    let top = |index: &mut Index, query: &str, n: usize| ids(index, &Query { limit: n, ..q(query) });
    let asleep = top(&mut index, "trouble falling asleep", 2);
    assert!(asleep.contains(&"posts/why-i-nap.md".into()) && asleep.contains(&"inspiration/why-we-sleep.md".into()));
    assert_eq!(top(&mut index, "personal finance", 1), ["posts/budget.md"]);
    assert_eq!(top(&mut index, "staying focused", 1), ["inbox/2026-11-01.md"]);
    assert!(top(&mut index, "zebra", 5).is_empty());
}
