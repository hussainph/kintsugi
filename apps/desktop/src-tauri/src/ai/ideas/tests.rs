//! Ideas without a model: grounding (quotes must be in their sources),
//! the store (fading, signals, refine and its undo), Adopt's frontmatter,
//! and the briefs.

use super::adopt;
use super::brief::{self, Ask, FeedSignal};
use super::ground::{self, Candidate, RawQuote, RawReason, SourceDoc, Sources};
use super::store::{Content, Footprint, SignalKind, Stage, Store};
use super::*;
use chrono::{DateTime, Duration as Days, FixedOffset};
use std::fs;

fn at(day: &str) -> DateTime<FixedOffset> {
    DateTime::parse_from_rfc3339(&format!("{day}T09:00:00+01:00")).unwrap()
}

fn vault() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let write = |rel: &str, text: &str| {
        let path = dir.path().join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    };
    write(
        "posts/on-craft.mdx",
        "---\ntitle: \"On craft and repair\"\nstatus: complete\n---\n\n# On craft and repair\n\nI keep returning to [[inspiration/golden-joinery]] because it says the same thing without words:\na repair is not a cover-up. It is a record of care.\n\n> The gold seam is not the flaw. It is the place where the object admits it was\n> handled.\n\nThe *practice* is unglamorous.\n",
    );
    write("notes/repair.md", "---\ntitle: Repair is a kind of attention\n---\n\nThe more interesting repair makes the history legible. The patch is not hidden.\n");
    write(
        "inspiration/golden-joinery.md",
        "---\nkind: quote\ntitle: \"Golden joinery\"\nsite: \"Encyclopaedia Britannica\"\n---\n\n> The repair is not hidden. It is given a color of its own.\n",
    );
    write("drafts/started.mdx", "---\ntitle: \"Started\"\nstatus: draft\ntags: [repair]\n---\n\nMy first paragraph, which is mine.\n");
    write(".kintsugi/agent/USER.md", "- Writes short essays about craft.\n");
    dir
}

struct Feed;
impl Sources for Feed {
    fn get(&self, _: &str) -> Option<SourceDoc> {
        None
    }
}

fn sources(root: &Path) -> VaultSources<'_> {
    VaultSources { root, feed: None }
}

fn quote(source: &str, text: &str) -> RawQuote {
    RawQuote { source: source.into(), text: text.into() }
}

fn candidate(title: &str, quotes: Vec<RawQuote>) -> Candidate {
    Candidate {
        kind: "Gap".into(),
        title: title.into(),
        draft_title: "What repair costs".into(),
        snippet: "Four pieces call repair care.".into(),
        observed: vec!["Repair is the subject of 2 documents.".into()],
        hunch: "The essay you haven't written is the cost side.".into(),
        quotes,
        steps: vec![ground::RawStep { did: "Searched for repair".into(), found: Some("2 documents".into()) }],
        reasons: vec![RawReason { text: "A theme with saves and no post".into(), profile_line: None }],
        about: vec!["drafts/started".into(), "../etc/passwd".into()],
    }
}

fn good_quotes() -> Vec<RawQuote> {
    vec![quote("posts/on-craft.mdx", "a repair is not a cover-up. It is a record of care."), quote("inspiration/golden-joinery", "The repair is not hidden.")]
}

fn content(title: &str) -> Content {
    let root = vault();
    ground::check_one(candidate(title, good_quotes()), &sources(root.path()), &[], &Footprint::default()).unwrap()
}

// --- Quotes ---------------------------------------------------------------

#[test]
fn quotes_must_appear_verbatim_in_their_source() {
    let source = "I keep returning to it:\na repair is not a cover-up. It is a record of care.\n\n> The gold seam is not the flaw. It is the place where the object admits it was\n> handled.\n\nThe *practice* is “unglamorous” — mostly.";
    // Exact, across a line wrap, and across blockquote markers.
    assert!(ground::quoted_in(source, "a repair is not a cover-up. It is a record of care."));
    assert!(ground::quoted_in(source, "I keep returning to it: a repair is not"));
    assert!(ground::quoted_in(source, "It is the place where the object admits it was handled."));
    // Typography and emphasis don't count against a quote.
    assert!(ground::quoted_in(source, "The practice is \"unglamorous\" - mostly."));
    // An ellipsis marks an omission: the parts appear in order.
    assert!(ground::quoted_in(source, "a repair is not a cover-up… admits it was handled"));
    assert!(!ground::quoted_in(source, "admits it was handled… a repair is not a cover-up"));
    // Paraphrase, invention, a changed word or case, and scraps fail.
    assert!(!ground::quoted_in(source, "a repair isn't a cover-up. It is a record of care."));
    assert!(!ground::quoted_in(source, "A Repair Is Not A Cover-Up."));
    assert!(!ground::quoted_in(source, "Repair is a record of love."));
    assert!(!ground::quoted_in(source, "care."));
    assert!(!ground::quoted_in(source, "…"));
}

#[test]
fn sources_resolve_inside_the_vault_only() {
    let root = vault();
    let s = sources(root.path());
    let post = s.get("posts/on-craft").unwrap();
    assert_eq!((post.id.as_str(), post.title.as_str(), post.origin.as_str(), post.own), ("posts/on-craft.mdx", "On craft and repair", "Your writing", true));
    assert_eq!(post.link.as_deref(), Some("posts/on-craft"));
    let clip = s.get("[[inspiration/golden-joinery]]").unwrap();
    assert_eq!((clip.title.as_str(), clip.origin.as_str(), clip.own), ("Golden joinery", "Encyclopaedia Britannica", false));
    assert_eq!(s.get("notes/repair.md#The patch").unwrap().id, "notes/repair.md");
    for refused in [".kintsugi/agent/USER.md", "../outside.md", "/etc/hosts", "posts/missing.md", "feed:1", ""] {
        assert!(s.get(refused).is_none(), "{refused}");
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(root.path().join("notes/repair.md"), root.path().join("notes/link.md")).unwrap();
        assert!(s.get("notes/link.md").is_none(), "links are not followed");
    }
}

// --- Parsing and checks ----------------------------------------------------

#[test]
fn reports_parse_in_the_shapes_models_send() {
    let one = r#"{"title":"A","quotes":[]}"#;
    for report in [
        format!("<ideas>\n[{one}]\n</ideas>"),
        format!("Here you go:\n```json\n[{one}]\n```"),
        format!("{{\"ideas\": [{one}]}}"),
        one.to_string(),
        format!("Sure. [{one}] Hope that helps."),
    ] {
        let parsed = ground::parse(&report).unwrap();
        assert_eq!(parsed.len(), 1, "{report}");
        assert_eq!(parsed[0].title, "A");
    }
    assert!(ground::parse("I couldn't find anything.").is_err());
}

#[test]
fn an_idea_with_one_invented_quote_is_dropped_whole() {
    let root = vault();
    let s = sources(root.path());
    let about = vec!["Writes short essays about craft.".to_string()];
    let mut good = candidate("Repair's cost", good_quotes());
    good.reasons.push(RawReason { text: "You write about craft".into(), profile_line: Some("writes short essays about craft.".into()) });
    good.reasons.push(RawReason { text: "Invented belief".into(), profile_line: Some("Loves listicles.".into()) });
    let invented = candidate("Invented", vec![good_quotes()[0].clone(), quote("notes/repair", "The patch is always hidden.")]);
    let elsewhere = candidate("Wrong source", vec![good_quotes()[0].clone(), quote("notes/repair", "The repair is not hidden.")]);
    let thin = candidate("One quote", vec![good_quotes()[0].clone()]);
    let mut prose = candidate("Prose", good_quotes());
    prose.hunch = "Here's an opening:\n\nThe bowl broke on a Tuesday.".into();
    let hidden = candidate("Hidden", vec![good_quotes()[0].clone(), quote(".kintsugi/agent/USER.md", "Writes short essays about craft.")]);
    let checked = ground::check(vec![good, invented, elsewhere, thin, prose, hidden], &s, &about, &Footprint::default(), 5);

    assert_eq!(checked.accepted.len(), 1);
    let idea = &checked.accepted[0];
    assert_eq!(idea.kind, "gap");
    assert_eq!(idea.quotes[0].source, "posts/on-craft.mdx");
    assert_eq!(idea.quotes[1].source, "inspiration/golden-joinery.md");
    assert_eq!(idea.quotes[1].origin, "Encyclopaedia Britannica");
    assert_eq!(idea.about, ["drafts/started.mdx"], "only real documents");
    // A profile line is kept only when it's really in About you.
    assert_eq!(idea.reasons[1].profile_line.as_deref(), Some("Writes short essays about craft."));
    assert_eq!(idea.reasons[2].profile_line, None);
    let why: Vec<&str> = checked.dropped.iter().map(|(t, _)| t.as_str()).collect();
    assert_eq!(why, ["Invented", "Wrong source", "One quote", "Prose", "Hidden"]);
    assert!(checked.dropped[0].1.contains("a quote isn't in notes/repair.md"), "{:?}", checked.dropped[0]);
}

#[test]
fn quotes_are_capped_at_four_and_batches_at_five() {
    let root = vault();
    let s = sources(root.path());
    let mut many = good_quotes();
    many.extend([quote("notes/repair", "The patch is not hidden."), quote("posts/on-craft", "The practice is unglamorous."), quote("nowhere", "Never checked.")]);
    let idea = ground::check_one(candidate("Many", many), &s, &[], &Footprint::default()).unwrap();
    assert_eq!(idea.quotes.len(), 4);
    let batch: Vec<Candidate> = (0..7).map(|i| candidate(&format!("Idea {i}"), good_quotes())).chain([candidate("idea 0", good_quotes())]).collect();
    let checked = ground::check(batch, &s, &[], &Footprint::default(), ground::MAX_BATCH);
    assert_eq!(checked.accepted.len(), 5);
    assert_eq!(checked.dropped.len(), 3);
}

fn job(id: &str, kind: &str) -> Job {
    serde_json::from_value(json!({ "id": id, "kind": kind, "task": "ideas", "brief": "b", "status": "running", "created": "2026-11-01T09:00:00+01:00" })).unwrap()
}
use serde_json::json;

#[test]
fn a_batch_is_checked_stored_and_reported() {
    let root = vault();
    let s = sources(root.path());
    let mut store = Store::open(None);
    let trace = Trace { searches: vec!["repair".into(), "care".into()], files: vec!["a.md".into(), "a.md".into(), "b.md".into()], tool_calls: 5, millis: 12_400, usd: 0.031, model: "anthropic/x".into(), steps: vec![] };
    let ideas = serde_json::json!([
        { "title": "Repair's cost", "hunch": "The cost side.", "observed": ["2 docs"], "quotes": [{ "source": "posts/on-craft", "text": "It is a record of care." }, { "source": "notes/repair", "text": "The patch is not hidden." }] },
        { "title": "Invented", "hunch": "x", "observed": ["y"], "quotes": [{ "source": "posts/on-craft", "text": "It is a record of care." }, { "source": "notes/repair", "text": "Made up entirely here." }] }
    ]);
    let report = format!("<ideas>{ideas}</ideas>");
    let out = finish_batch(&mut store, &s, &[], &job("job-1", BATCH), &report, &trace, at("2026-11-01")).unwrap();
    assert!(out.starts_with("1 new idea in Ideas: “Repair's cost”.") && out.contains("I dropped 1: “Invented”, because a quote isn't in notes/repair.md"), "{out}");
    let listed = store.list(at("2026-11-01"));
    assert_eq!(listed.len(), 1);
    let fp = &listed[0].idea.content.footprint;
    assert_eq!((fp.searches, fp.files, fp.seconds, fp.batch), (2, 2, 12, 1));
    assert_eq!(listed[0].idea.job, "job-1");

    // The same title again is a repeat; a batch where nothing survives fails.
    let err = finish_batch(&mut store, &s, &[], &job("job-2", BATCH), &report, &trace, at("2026-11-02")).unwrap_err();
    assert!(err.starts_with("None of the 2 ideas passed the checks") && err.contains("offered already"), "{err}");
    assert_eq!(finish_batch(&mut store, &s, &[], &job("job-3", BATCH), "<ideas>[]</ideas>", &trace, at("2026-11-02")).unwrap(), "No ideas worth your time this round.");
    assert!(finish_batch(&mut store, &s, &[], &job("job-4", BATCH), "Sorry, I failed.", &trace, at("2026-11-02")).is_err());
}

#[test]
fn refine_keeps_the_earlier_version_and_undo_restores_it() {
    let root = vault();
    let s = sources(root.path());
    let mut store = Store::open(None);
    let idea = store.add("job-1", vec![content("Repair's cost")], at("2026-11-01")).unwrap().remove(0);
    store.set_reason(&idea.id, "r1", true, at("2026-11-01")).unwrap();
    store.set_refining(&idea.id, Some("job-r".into())).unwrap();
    let mut refine_job = job("job-r", REFINE);
    refine_job.brief = brief::refine(store.get(&idea.id).unwrap(), "Narrower");
    assert!(!refine_job.brief.contains("\"A theme with saves and no post\"\n"), "removed reasons aren't offered back as reasons");
    let report = r#"{"title":"Narrower: the cost of one bowl","hunch":"One bowl.","observed":["1 doc"],"reasons":[{"text":"A theme with saves and no post"}],
        "quotes":[{"source":"posts/on-craft.mdx","text":"It is a record of care."},{"source":"inspiration/golden-joinery.md","text":"It is given a color of its own."}]}"#;
    let out = finish_refine(&mut store, &s, &[], &refine_job, report, &Trace::default(), at("2026-11-02")).unwrap();
    assert!(out.contains("Narrower: the cost of one bowl"));
    let now = store.get(&idea.id).unwrap().clone();
    assert_eq!((now.content.title.as_str(), now.versions.len(), now.refining.as_deref()), ("Narrower: the cost of one bowl", 1, None));
    assert_eq!(now.versions[0].asked, "Narrower");
    assert!(now.content.reasons[0].removed, "a removed reason stays removed");
    let undone = store.undo_refine(&idea.id, at("2026-11-02")).unwrap();
    assert_eq!((undone.content.title.as_str(), undone.versions.len()), ("Repair's cost", 0));
    assert!(store.undo_refine(&idea.id, at("2026-11-02")).is_err());

    // A refinement with an invented quote is refused; the idea is unchanged.
    store.set_refining(&idea.id, Some("job-r2".into())).unwrap();
    let bad = r#"{"title":"T","hunch":"h","observed":["o"],"quotes":[{"source":"notes/repair","text":"Totally invented words."},{"source":"notes/repair","text":"The patch is not hidden."}]}"#;
    assert!(finish_refine(&mut store, &s, &[], &job("job-r2", REFINE), bad, &Trace::default(), at("2026-11-02")).is_err());
    let after = store.get(&idea.id).unwrap();
    assert_eq!((after.content.title.as_str(), after.refining.is_none(), after.refine_error.is_some()), ("Repair's cost", true, true));
    let kinds: Vec<SignalKind> = store.signals(10).iter().map(|s| s.kind).collect();
    assert_eq!(kinds, [SignalKind::ReasonRemoved, SignalKind::Refined, SignalKind::RefineUndone]);
}

// --- The store -----------------------------------------------------------

#[test]
fn unused_ideas_thin_from_day_three_and_fade_after_a_week() {
    let data = tempfile::tempdir().unwrap();
    let mut store = Store::open(Some(data.path().into()));
    let start = at("2026-11-01");
    let ideas = store.add("job-1", vec![content("Unused"), content("Adopted")], start).unwrap();
    store.adopted(&ideas[1].id, "drafts/a.mdx", true, start).unwrap();
    let stage_on = |store: &mut Store, days: i64| -> Vec<(i64, Stage)> { store.list(start + Days::days(days)).iter().map(|l| (l.age, l.stage)).collect() };
    assert_eq!(stage_on(&mut store, 0), [(0, Stage::Fresh), (0, Stage::Fresh)]);
    assert_eq!(stage_on(&mut store, 2), [(2, Stage::Fresh), (2, Stage::Fresh)]);
    assert_eq!(stage_on(&mut store, 3), [(3, Stage::Thin), (3, Stage::Fresh)]);
    assert_eq!(stage_on(&mut store, 6), [(6, Stage::Thin), (6, Stage::Fresh)]);
    assert_eq!(stage_on(&mut store, 7), [(7, Stage::Faded), (7, Stage::Fresh)], "faded this week; adopted ideas never fade");
    // Fading is recorded once, as a faint no.
    stage_on(&mut store, 8);
    let faded: Vec<_> = store.signals(50).into_iter().filter(|s| s.kind == SignalKind::Faded).collect();
    assert_eq!(faded.len(), 1);
    assert_eq!(faded[0].title, "Unused");
    // Gone from the list after two weeks, from the file after a month.
    assert_eq!(stage_on(&mut store, 14), [(14, Stage::Fresh)]);
    assert_eq!(stage_on(&mut store, 40).len(), 1);
    let reopened = Store::open(Some(data.path().into()));
    assert!(reopened.get(&ideas[0].id).is_none() && reopened.get(&ideas[1].id).is_some());
}

#[test]
fn dismissals_and_reasons_are_signals_with_undo() {
    let data = tempfile::tempdir().unwrap();
    let mut store = Store::open(Some(data.path().into()));
    let day = at("2026-11-01");
    let idea = store.add("job-1", vec![content("Repair's cost")], day).unwrap().remove(0);
    store.dismiss(&idea.id, vec!["Not for me".into(), "  ".into()], day).unwrap();
    assert_eq!(store.get(&idea.id).unwrap().dismissed.as_ref().unwrap().reasons, ["Not for me"]);
    store.undismiss(&idea.id, day).unwrap();
    store.dismiss(&idea.id, vec![], day).unwrap();
    store.set_reason(&idea.id, "r1", true, day).unwrap();
    assert!(store.get(&idea.id).unwrap().content.reasons[0].removed);
    store.set_reason(&idea.id, "r1", false, day).unwrap();
    assert!(store.set_reason(&idea.id, "nope", true, day).is_err());
    store.discussed(&idea.id, day).unwrap();
    // Everything lands in app data and survives a restart.
    let reopened = Store::open(Some(data.path().into()));
    let signals = reopened.signals(50);
    let kinds: Vec<SignalKind> = signals.iter().map(|s| s.kind).collect();
    assert_eq!(kinds, [SignalKind::Dismissed, SignalKind::Undismissed, SignalKind::Dismissed, SignalKind::ReasonRemoved, SignalKind::ReasonRestored, SignalKind::Discussed]);
    assert_eq!(signals[0].detail.as_deref(), Some("Not for me"));
    assert_eq!(signals[3].detail.as_deref(), Some("A theme with saves and no post"));
    assert!(reopened.get(&idea.id).unwrap().dismissed.is_some());
    assert!(data.path().join("ideas.json").is_file() && data.path().join("signals.jsonl").is_file());
}

// --- Adopt -----------------------------------------------------------------

#[test]
fn adopt_makes_an_empty_draft_with_the_idea_in_frontmatter() {
    let root = vault();
    let mut store = Store::open(None);
    let mut c = content("You've written about what repair is, never what it costs");
    c.quotes.push(store::Quote { source: "feed:3".into(), text: "x".into(), title: "F".into(), origin: "Feed".into(), own: false, link: None });
    let idea = store.add("job-1", vec![c], at("2026-11-01")).unwrap().remove(0);
    let (path, text) = adopt_in(&mut store, root.path(), &idea.id, Some("What repair costs"), None, at("2026-11-02")).unwrap();
    assert_eq!(path, "drafts/what-repair-costs.mdx");
    assert_eq!(
        text,
        format!(
            "---\ntitle: \"What repair costs\"\nstatus: draft\nideas:\n  - id: {}\n    from: kin\n    offered: 2026-11-01\n    title: \"You've written about what repair is, never what it costs\"\n    hunch: \"The essay you haven't written is the cost side.\"\n    clips:\n      - \"[[posts/on-craft]]\"\n      - \"[[inspiration/golden-joinery]]\"\n---\n\n",
            idea.id
        )
    );
    assert_eq!(fs::read_to_string(root.path().join(&path)).unwrap(), text);
    assert_eq!(kintsugi_vault::front_matter(&text).0.as_deref(), Some("What repair costs"));
    let adopted = store.get(&idea.id).unwrap().adopted.clone().unwrap();
    assert_eq!((adopted.path.as_str(), adopted.new), ("drafts/what-repair-costs.mdx", true));
    // Another adoption with the same title doesn't overwrite it.
    let (again, _) = adopt_in(&mut store, root.path(), &idea.id, Some("What repair costs"), None, at("2026-11-02")).unwrap();
    assert_eq!(again, "drafts/what-repair-costs-2.mdx");
    assert!(store.dismiss(&idea.id, vec![], at("2026-11-02")).is_err(), "adopted ideas can't be dismissed");
}

#[test]
fn adopting_into_a_draft_touches_only_its_frontmatter() {
    let root = vault();
    let mut store = Store::open(None);
    let ideas = store.add("job-1", vec![content("First"), content("Second")], at("2026-11-01")).unwrap();
    let (_, once) = adopt_in(&mut store, root.path(), &ideas[0].id, None, Some("drafts/started.mdx"), at("2026-11-02")).unwrap();
    assert!(once.starts_with("---\ntitle: \"Started\"\nstatus: draft\ntags: [repair]\nideas:\n  - id: "), "{once}");
    assert!(once.ends_with("---\n\nMy first paragraph, which is mine.\n"));
    let (_, twice) = adopt_in(&mut store, root.path(), &ideas[1].id, None, Some("drafts/started.mdx"), at("2026-11-02")).unwrap();
    assert_eq!(twice.matches("  - id: ").count(), 2);
    assert!(twice.find(&ideas[0].id).unwrap() < twice.find(&ideas[1].id).unwrap());
    assert!(twice.ends_with("---\n\nMy first paragraph, which is mine.\n"));
    // Adding the same idea again changes nothing.
    assert_eq!(adopt::attach(&twice, store.get(&ideas[1].id).unwrap(), "2026-11-01", "drafts/started.mdx").unwrap(), twice);
    // A draft never links to itself.
    let on_craft = adopt::attach("---\ntitle: x\n---\nBody\n", store.get(&ideas[0].id).unwrap(), "2026-11-01", "posts/on-craft.mdx").unwrap();
    assert!(!on_craft.contains("[[posts/on-craft]]") && on_craft.contains("[[inspiration/golden-joinery]]"));
    assert!(on_craft.ends_with("---\nBody\n"));
}

#[test]
fn attach_handles_odd_frontmatter() {
    let mut store = Store::open(None);
    let idea = store.add("job-1", vec![content("Odd")], at("2026-11-01")).unwrap().remove(0);
    let none = adopt::attach("Just a note.\n", &idea, "2026-11-01", "inbox/n.md").unwrap();
    assert!(none.starts_with("---\nideas:\n  - id: ") && none.ends_with("---\n\nJust a note.\n"));
    let empty_list = adopt::attach("---\ntitle: t\nideas: []\nstatus: draft\n---\n", &idea, "2026-11-01", "a.md").unwrap();
    assert!(empty_list.contains("ideas:\n  - id: ") && empty_list.contains("      - \"[[inspiration/golden-joinery]]\"\nstatus: draft\n---\n"), "{empty_list}");
    assert!(adopt::attach("---\nideas: lots\n---\n", &idea, "2026-11-01", "a.md").is_err());
    assert!(adopt::attach("---\ntitle: open\n", &idea, "2026-11-01", "a.md").is_err());
}

// --- Briefs ---------------------------------------------------------------

#[test]
fn the_batch_brief_carries_rules_signals_and_the_feed() {
    let mut store = Store::open(None);
    let day = at("2026-11-01");
    let idea = store.add("job-1", vec![content("Repair's cost")], day).unwrap().remove(0);
    store.dismiss(&idea.id, vec!["Already on it".into()], day).unwrap();
    store.set_reason(&idea.id, "r1", true, day).unwrap();
    let feed = [FeedSignal { id: "feed:7".into(), title: "Tools shape us".into(), source: "HN".into(), liked: true, saved: false, note: Some("yes!".into()) }];
    let text = brief::batch(&Ask { count: 9, about: Some("drafts/started.mdx".into()), focus: Some("tools".into()) }, &store.recent(14, day), &store.signals(40), &feed);
    assert!(text.starts_with("Find up to 5 ideas"));
    assert!(text.contains("Never write his prose"));
    assert!(text.contains("every idea is about one document: drafts/started.mdx"));
    assert!(text.contains("He asked for ideas about: tools"));
    assert!(text.contains("- Repair's cost"), "recent titles");
    assert!(text.contains("\"Repair's cost\": dismissed (\"Already on it\")"));
    assert!(text.contains("said \"A theme with saves and no post\" was not a reason"));
    assert!(text.contains("- feed:7 \"Tools shape us\" (HN): liked, noted \"yes!\""));
    assert!(text.contains(brief::FORMAT) && text.trim_end().ends_with("</ideas>"));
}

#[test]
fn the_idea_tool_reads_through_the_reader() {
    let root = vault();
    let outputs = tempfile::tempdir().unwrap();
    let reader: crate::ai::tools::IdeaReader = std::sync::Arc::new(|id: &str| (id == "idea-1").then(|| "{\"title\":\"Repair\"}".to_string()));
    let tools = crate::ai::tools::Tools::new(root.path(), outputs.path().into(), "t").unwrap().with_ideas(reader);
    let run = |args: serde_json::Value| tools.run(&crate::ai::wire::ToolCall { id: "c".into(), name: "tool".into(), arguments: args });
    let found = run(json!({ "name": "idea", "args": { "id": "idea-1" } }));
    assert!(!found.is_error && found.content.contains("{\"title\":\"Repair\"}") && found.content.starts_with("<data"));
    assert!(run(json!({ "name": "idea", "args": { "id": "nope" } })).is_error);
    assert!(run(json!({ "name": "idea" })).content.contains("Usage: idea:"));
    let _ = Feed;
}
