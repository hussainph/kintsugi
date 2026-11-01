//! A synthetic reader with known taste, for the offline evaluation: six
//! topics with their own vocabulary, sources that mix them, and a reader who
//! loves pottery and writing, likes tools, ignores most finance and gadgets,
//! and marks football Not interested. What he's shown each day arrives in
//! random order relative to his taste, so newest first can't know it.

use crate::ranker::{Clip, DAY_MS, Event, HOUR_MS, Item, Media, Source, World};
use crate::rng::Rng;
use crate::text;

const TOPICS: [(&str, [&str; 8], f64); 6] = [
    ("pottery", ["kiln", "glaze", "clay", "ceramic", "pottery", "porcelain", "firing", "stoneware"], 0.9),
    ("writing", ["essay", "prose", "draft", "writing", "sentence", "paragraph", "revision", "editor"], 0.8),
    ("tools", ["software", "interface", "keyboard", "notebook", "workflow", "terminal", "plugin", "shortcut"], 0.45),
    ("finance", ["stocks", "market", "earnings", "trading", "investor", "dividend", "portfolio", "bonds"], 0.12),
    ("gadgets", ["phone", "battery", "camera", "unboxing", "laptop", "charger", "headset", "tablet"], 0.08),
    ("football", ["football", "league", "striker", "transfer", "goalkeeper", "stadium", "derby", "fixture"], 0.02),
];
const FILLER: [&str; 10] = ["notes", "story", "guide", "weekly", "report", "journal", "letter", "digest", "dispatch", "review"];
/// Each source's topic mix (indices into TOPICS, with weights).
const SOURCES: [(&str, [(usize, f64); 2]); 6] = [
    ("Studio Notes", [(0, 0.7), (4, 0.3)]),
    ("The Margin", [(1, 0.6), (3, 0.4)]),
    ("Tool Shed", [(2, 0.6), (4, 0.4)]),
    ("Daily Markets", [(3, 0.8), (1, 0.2)]),
    ("Matchday", [(5, 0.8), (0, 0.2)]),
    ("Mixed Bag", [(5, 0.5), (1, 0.5)]),
];

pub struct Fixture {
    pub world: World,
    pub events: Vec<Event>,
    /// When the fixture ends (ms).
    pub end: i64,
}

fn words(rng: &mut Rng, vocab: &[&str; 8], n: usize) -> Vec<String> {
    (0..n).map(|_| vocab[rng.below(vocab.len())].to_string()).collect()
}

/// `days` of history from `start_ms` (a day boundary), seeded.
pub fn fixture(seed: u64, days: i64, start_ms: i64) -> Fixture {
    let mut rng = Rng::new(seed);
    let mut world = World::default();
    for (i, (title, _)) in SOURCES.iter().enumerate() {
        let id = i as i64 + 1;
        world.sources.insert(id, Source { id, title: title.to_string(), added: (start_ms - 60 * DAY_MS) / 1000 });
    }
    // What he kept before the Feed: a few pottery and writing clips.
    for (n, topic) in [0usize, 0, 1].iter().enumerate() {
        let (name, vocab, _) = &TOPICS[*topic];
        let title = format!("{} {}", words(&mut rng, vocab, 2).join(" "), name);
        let body = words(&mut rng, vocab, 20).join(" ");
        world.clips.push(Clip {
            key: format!("inspiration/clip-{n}.md"),
            title: title.clone(),
            captured: (start_ms - 20 * DAY_MS) / 1000,
            vector: text::hashed(&title, &body),
            site: None,
            author: None,
            topics: vec![name.to_string()],
            item: None,
        });
    }
    let mut events = Vec::new();
    let mut next_event = 1;
    let mut push = |events: &mut Vec<Event>, at: i64, kind: &str, item: i64, source: i64| {
        events.push(Event { id: next_event, at, kind: kind.into(), item: Some(item), source: Some(source), surface: Some("newest".into()), data: None });
        next_event += 1;
    };
    let mut next_item = 1;
    for day in 0..days {
        let day_start = start_ms + day * DAY_MS;
        let mut today: Vec<(i64, i64, f64, usize)> = Vec::new();
        for (s, (_, mix)) in SOURCES.iter().enumerate() {
            let source = s as i64 + 1;
            for _ in 0..(1 + rng.below(3)) {
                let topic = if rng.uniform() < mix[0].1 { mix[0].0 } else { mix[1].0 };
                let (name, vocab, taste) = &TOPICS[topic];
                let published = day_start + (rng.uniform() * 18.0 * HOUR_MS as f64) as i64;
                let mut title_words = words(&mut rng, vocab, 2);
                title_words.push(FILLER[rng.below(FILLER.len())].into());
                let title = title_words.join(" ");
                let mut body_words = words(&mut rng, vocab, 12);
                body_words.extend((0..8).map(|_| FILLER[rng.below(FILLER.len())].to_string()));
                let body = body_words.join(" ");
                let id = next_item;
                next_item += 1;
                world.items.insert(
                    id,
                    Item {
                        id,
                        source,
                        author: Some(format!("{} writer {}", SOURCES[s].0, rng.below(2))),
                        title: title.clone(),
                        url: Some(format!("https://example.com/{id}")),
                        topics: text::topics(&title, &body, &[]),
                        media: if topic == 4 { Media::Video } else { Media::Article },
                        published: published / 1000,
                        length: body.len() * (5 + rng.below(20)),
                        vector: text::hashed(&title, &body),
                    },
                );
                let _ = name;
                today.push((id, source, *taste, topic));
            }
        }
        // He reads in the evening: everything from today, newest first.
        let evening = day_start + 20 * HOUR_MS;
        today.sort_by_key(|(id, ..)| std::cmp::Reverse((world.items[id].published, *id)));
        for (position, (id, source, ..)) in today.iter().enumerate() {
            push(&mut events, evening + position as i64, "impression", *id, *source);
        }
        for (n, (id, source, taste, topic)) in today.iter().enumerate() {
            let at = evening + HOUR_MS / 2 + n as i64 * 1000;
            let r = rng.uniform();
            if r < taste * 0.3 {
                push(&mut events, at, "open", *id, *source);
                push(&mut events, at + 100, "save", *id, *source);
            } else if r < taste * 0.55 {
                push(&mut events, at, "like", *id, *source);
            } else if r < taste * 0.7 {
                push(&mut events, at, "open", *id, *source);
            } else if *topic == 5 && rng.uniform() < 0.35 {
                push(&mut events, at, "not_interested", *id, *source);
            }
        }
    }
    Fixture { world, events, end: start_ms + days * DAY_MS }
}
