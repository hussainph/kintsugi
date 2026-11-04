//! Stories: items about the same thing from different sources, grouped
//! locally (KI-72, KI-94). No LLM calls: a vector cosine against the story's
//! centroid, gated by the titles sharing a name or a number.
//!
//! Clustering is incremental and its decisions are kept by the caller (the
//! Feed's store), so a story keeps its id while sources join it. An item is
//! compared only with items published within [`WINDOW_SECS`] of its own
//! publish date, never "now": a back-catalogue post can group with posts
//! from its own time, and never with today's news.
//!
//! A cluster whose items span one source isn't a story; the app shows its
//! items as plain items (see [`multi_source`]).

use crate::vector::{cosine, normalize};
use std::collections::{BTreeMap, HashMap, HashSet};

/// Two items this far apart in publish time are never the same story.
pub const WINDOW_SECS: i64 = 72 * 60 * 60;

/// Which vectors clustering is comparing, which decides how close is "the
/// same story".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Space {
    /// The search index's model2vec vectors (potion-base-8M). KI-72: search's
    /// "related" band is 0.3–0.8, so the same story needs a stricter cut.
    Model,
    /// The hashed bag of words (`text::hashed`): headless runs, tests and the
    /// first minutes after install. Shared words count for more here, so the
    /// cut is lower, and the title gate does more of the work.
    Hashed,
}

impl Space {
    /// Cosine to the story's centroid (or the other item) that joins.
    pub fn threshold(self) -> f32 {
        match self {
            Space::Model => 0.6,
            Space::Hashed => 0.35,
        }
    }
}

/// An item as clustering sees it.
#[derive(Clone, Debug)]
pub struct Member {
    pub id: i64,
    pub source: i64,
    pub title: String,
    pub url: Option<String>,
    /// Seconds since the epoch.
    pub published: i64,
    /// Normalized, or empty when unknown.
    pub vector: Vec<f32>,
    /// The story it is already in.
    pub story: Option<i64>,
}

/// Where a fresh item goes. New stories get negative keys (-1, -2, …) that
/// the caller turns into real ids; items that join nothing aren't listed.
pub type Assignment = (i64, i64);

/// Words of a title that name something: a capitalised word ("Apple",
/// "iPhone", "Claude") or a token with a digit ("Q4", "$114.5", "3%").
/// A bare year is too common to count.
pub fn names(title: &str) -> HashSet<String> {
    title
        .split(|c: char| {
            c.is_whitespace()
                || matches!(c, ',' | ';' | ':' | '"' | '“' | '”' | '(' | ')' | '!' | '?')
        })
        .map(|w| {
            w.trim_matches(|c: char| !c.is_alphanumeric())
                .trim_end_matches("'s")
                .trim_end_matches("’s")
        })
        .filter(|w| w.chars().count() >= 2)
        .filter(|w| {
            let digit = w.chars().any(|c| c.is_ascii_digit());
            let year = w.len() == 4
                && w.chars().all(|c| c.is_ascii_digit())
                && (w.starts_with("19") || w.starts_with("20"));
            // "The", "Why": capitalised, but stopwords.
            let capital =
                w.chars().any(char::is_uppercase) && crate::text::words(w).next().is_some();
            (digit && !year) || capital
        })
        .map(str::to_lowercase)
        .collect()
}

fn shares_a_name(a: &HashSet<String>, b: &HashSet<String>) -> bool {
    a.iter().any(|n| b.contains(n))
}

/// The same link, ignoring the scheme, `www.` and a trailing slash.
pub fn same_url(a: Option<&str>, b: Option<&str>) -> bool {
    let key = |u: &str| {
        u.trim()
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .trim_start_matches("www.")
            .trim_end_matches('/')
            .to_lowercase()
    };
    matches!((a, b), (Some(a), Some(b)) if !a.trim().is_empty() && key(a) == key(b))
}

fn centroid<'a>(vectors: impl Iterator<Item = &'a Vec<f32>>) -> Vec<f32> {
    let mut sum: Vec<f32> = Vec::new();
    for v in vectors.filter(|v| !v.is_empty()) {
        if sum.is_empty() {
            sum = vec![0.0; v.len()];
        }
        if sum.len() == v.len() {
            sum.iter_mut().zip(v).for_each(|(s, x)| *s += x);
        }
    }
    normalize(&mut sum);
    sum
}

/// Places `fresh` items (oldest first) into stories. Each joins the closest
/// story or item within the window whose cosine clears the space's
/// threshold and whose title shares a name with it, or that links to the
/// same page. An item joined with a lone item starts a new story (a negative
/// key). Returns only the items that joined something.
pub fn assign(pool: &[Member], fresh: &[i64], space: Space) -> Vec<Assignment> {
    let by_id: HashMap<i64, &Member> = pool.iter().map(|m| (m.id, m)).collect();
    let mut story: HashMap<i64, i64> = pool.iter().filter_map(|m| Some((m.id, m.story?))).collect();
    let names_of: HashMap<i64, HashSet<String>> =
        pool.iter().map(|m| (m.id, names(&m.title))).collect();
    let mut order: Vec<&Member> = fresh
        .iter()
        .filter_map(|id| by_id.get(id).copied())
        .collect();
    order.sort_by_key(|m| (m.published, m.id));
    let mut next_new = -1;
    let mut out = Vec::new();
    for item in order {
        if story.contains_key(&item.id) {
            continue;
        }
        let near: Vec<&Member> = pool
            .iter()
            .filter(|m| m.id != item.id && (m.published - item.published).abs() <= WINDOW_SECS)
            .collect();
        // Stories within the window, with all their members (the members
        // themselves may sit just outside it).
        let mut groups: BTreeMap<i64, Vec<&Member>> = BTreeMap::new();
        for m in &near {
            if let Some(&s) = story.get(&m.id) {
                groups.entry(s).or_default();
            }
        }
        for m in pool {
            if let Some(group) = story.get(&m.id).and_then(|s| groups.get_mut(s)) {
                group.push(m);
            }
        }
        let mine = &names_of[&item.id];
        let mut best: Option<(f32, i64, Option<i64>)> = None;
        let mut consider = |score: f32, target: i64, partner: Option<i64>| {
            if best.is_none_or(|(b, _, _)| score > b) {
                best = Some((score, target, partner));
            }
        };
        for (&key, members) in &groups {
            let linked = members
                .iter()
                .any(|m| same_url(item.url.as_deref(), m.url.as_deref()));
            let similarity = cosine(&item.vector, &centroid(members.iter().map(|m| &m.vector)));
            let named = members
                .iter()
                .any(|m| shares_a_name(mine, &names_of[&m.id]));
            if linked || (similarity >= space.threshold() && named) {
                consider(if linked { 2.0 } else { similarity }, key, None);
            }
        }
        for m in near.iter().filter(|m| !story.contains_key(&m.id)) {
            let linked = same_url(item.url.as_deref(), m.url.as_deref());
            let similarity = cosine(&item.vector, &m.vector);
            if linked || (similarity >= space.threshold() && shares_a_name(mine, &names_of[&m.id]))
            {
                consider(if linked { 2.0 } else { similarity }, 0, Some(m.id));
            }
        }
        let Some((_, key, partner)) = best else {
            continue;
        };
        let key = match partner {
            Some(partner) => {
                let key = next_new;
                next_new -= 1;
                story.insert(partner, key);
                out.push((partner, key));
                key
            }
            None => key,
        };
        story.insert(item.id, key);
        out.push((item.id, key));
    }
    out
}

/// News about the same thing as a piece of writing (KI-105): (writing,
/// news) pairs that would have grouped by the same rule as [`assign`], with
/// at least one of the two in `fresh`. Writing never joins a story; the
/// reader links to the news instead.
pub fn related(
    writing: &[Member],
    news: &[Member],
    fresh: &HashSet<i64>,
    space: Space,
) -> Vec<(i64, i64)> {
    let mut out = Vec::new();
    for w in writing {
        let mine = names(&w.title);
        for n in news {
            if w.id == n.id
                || w.source == n.source
                || (!fresh.contains(&w.id) && !fresh.contains(&n.id))
                || (w.published - n.published).abs() > WINDOW_SECS
            {
                continue;
            }
            let linked = same_url(w.url.as_deref(), n.url.as_deref());
            if linked
                || (cosine(&w.vector, &n.vector) >= space.threshold()
                    && shares_a_name(&mine, &names(&n.title)))
            {
                out.push((w.id, n.id));
            }
        }
    }
    out
}

/// Stories whose items (among `items`: id, story, source) span two or more
/// sources, with how many. Only these are shown and ranked as stories.
pub fn multi_source(
    items: impl IntoIterator<Item = (i64, Option<i64>, i64)>,
) -> HashMap<i64, usize> {
    let mut sources: HashMap<i64, HashSet<i64>> = HashMap::new();
    for (_, story, source) in items {
        if let Some(story) = story {
            sources.entry(story).or_default().insert(source);
        }
    }
    sources
        .into_iter()
        .filter(|(_, s)| s.len() >= 2)
        .map(|(story, s)| (story, s.len()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::text::hashed;

    const HOUR: i64 = 3_600;
    const NOW: i64 = 1_793_700_000;

    /// Real headlines and summaries from the KI-72 headless run (Nov 2–3),
    /// as (id, source, title, summary, hours ago, url).
    fn day() -> Vec<(i64, i64, &'static str, &'static str, i64, &'static str)> {
        vec![
            (
                1,
                1,
                "Apple reports Q4 2026 earnings: $114.5 billion in revenue, up 12%",
                "Apple today announced its earnings for the fourth fiscal quarter of 2026, with revenue of $114.5 billion, up 12 percent year over year. iPhone revenue hit a record.",
                3,
                "https://9to5mac.com/q4-2026-earnings",
            ),
            (
                2,
                2,
                "Apple set an iPhone sales record even without a new standard iPhone",
                "Apple's fourth quarter revenue was $114.5 billion, and iPhone made $57.6 billion, a record for the quarter, without a new standard model this year.",
                2,
                "https://www.theverge.com/apple-q4-2026-earnings",
            ),
            (
                3,
                1,
                "Apple forecasts its biggest revenue quarter ever despite supply constraints",
                "Apple expects the December quarter to be its best ever, with revenue growth of 10 to 12 percent, despite iPhone Duo supply constraints after record fourth quarter earnings.",
                1,
                "https://9to5mac.com/apple-forecast",
            ),
            (
                4,
                3,
                "Apple reports fourth quarter results",
                "Apple today announced financial results for its fiscal 2026 fourth quarter ended September 26. The Company posted quarterly revenue of $114.5 billion, up 12 percent year over year. iPhone revenue was a record.",
                3,
                "https://www.apple.com/newsroom/q4-results",
            ),
            (
                5,
                2,
                "Claude Code now refuses to clone existing games",
                "Anthropic changed Claude Code's system prompt so it won't re-create existing video games after a wave of AI-made ports and decompilations.",
                7,
                "https://www.theverge.com/claude-code-games",
            ),
            (
                6,
                4,
                "Claude Code's new rule against cloning games won't slow the copying much",
                "Anthropic's Claude Code system prompt now tells the model not to clone existing video games. Ars Technica thinks the rule won't slow AI game ports and decompilations much.",
                6,
                "https://arstechnica.com/claude-code-games",
            ),
            (
                7,
                4,
                "Why large dogs age faster than small ones",
                "Plus invisible tattoo inks, a medieval skeleton identified, and a single antimatter particle trapped for months.",
                2,
                "https://arstechnica.com/dogs",
            ),
            (
                8,
                5,
                "llm 0.37",
                "A new release of my LLM command-line tool, with support for tool schemas and fragments from plugins.",
                1,
                "https://simonwillison.net/llm-0-37",
            ),
            (
                9,
                2,
                "Meta will end Quest 2 OS updates in 2027",
                "Meta says the Quest 2 headset will stop receiving operating system updates in 2027, though apps keep working.",
                3,
                "https://www.theverge.com/meta-quest-2",
            ),
            (
                10,
                2,
                "One of Google's Android partners turned 1.3 million set-top boxes into a botnet",
                "Researchers say cheap Android TV boxes shipped with malware that turned 1.3 million devices into a botnet.",
                4,
                "https://www.theverge.com/android-botnet",
            ),
            (
                11,
                4,
                "“At Home in Space” opens, caps Air and Space Museum renovation",
                "The Smithsonian's Air and Space Museum finishes its renovation with a new gallery about living in space.",
                1,
                "https://arstechnica.com/air-space",
            ),
            (
                12,
                1,
                "Apple stock drops nearly 3% after hours following Q4 2026 results",
                "Apple shares fell nearly 3 percent in after-hours trading following its fourth quarter 2026 earnings report, as investors weighed margin guidance.",
                1,
                "https://9to5mac.com/apple-stock-drops",
            ),
            (
                13,
                2,
                "Apple says it isn't able to predict when it'll have enough iPhone Duos",
                "Tim Cook told analysts on the earnings call that supply of iPhone Duo won't meet demand for a while.",
                0,
                "https://www.theverge.com/iphone-duo-supply",
            ),
            (
                14,
                6,
                "Most of our measures of a key cognitive process don't agree",
                "Psychologists compared dozens of tests of executive function and found they barely correlate.",
                5,
                "https://arstechnica.com/cognition",
            ),
        ]
    }

    fn pool() -> Vec<Member> {
        day()
            .into_iter()
            .map(|(id, source, title, summary, hours, url)| Member {
                id,
                source,
                title: title.into(),
                url: Some(url.into()),
                published: NOW - hours * HOUR,
                vector: hashed(title, summary),
                story: None,
            })
            .collect()
    }

    fn groups(assigned: &[Assignment]) -> Vec<Vec<i64>> {
        let mut by: BTreeMap<i64, Vec<i64>> = BTreeMap::new();
        for (item, story) in assigned {
            by.entry(*story).or_default().push(*item);
        }
        let mut out: Vec<Vec<i64>> = by
            .into_values()
            .map(|mut v| {
                v.sort();
                v
            })
            .collect();
        out.sort();
        out
    }

    #[test]
    fn names_are_capitalised_words_and_numbers_but_not_years() {
        let n = names("Apple's record quarter: $114.5 billion, and iPhone Q4 in 2026");
        for expected in ["apple", "114.5", "iphone", "q4"] {
            assert!(n.contains(expected), "{expected} in {n:?}");
        }
        assert!(!n.contains("2026"));
        assert!(!n.contains("record"));
        assert!(names("llm 0.37").contains("0.37"));
    }

    #[test]
    fn a_day_of_headlines_groups_into_its_two_stories() {
        let pool = pool();
        let fresh: Vec<i64> = pool.iter().map(|m| m.id).collect();
        let assigned = assign(&pool, &fresh, Space::Hashed);
        let found = groups(&assigned);
        let apple = found
            .iter()
            .find(|g| g.contains(&1))
            .expect("Apple's quarter is a story");
        for id in [1, 2, 4] {
            assert!(apple.contains(&id), "{id} in {apple:?}");
        }
        assert!(found.contains(&vec![5, 6]), "Claude Code: {found:?}");
        // Unrelated items stay plain.
        for loner in [7, 8, 9, 10, 11, 14] {
            assert!(
                !assigned.iter().any(|(i, _)| *i == loner),
                "{loner} joined {found:?}"
            );
        }
        let multi = multi_source(pool.iter().map(|m| {
            (
                m.id,
                assigned.iter().find(|a| a.0 == m.id).map(|a| a.1),
                m.source,
            )
        }));
        assert_eq!(multi.len(), 2);
    }

    #[test]
    fn a_new_source_joins_the_story_it_covers() {
        let mut pool = pool();
        for m in &mut pool {
            if [5, 6].contains(&m.id) {
                m.story = Some(40);
            }
        }
        pool.push(Member {
            id: 20,
            source: 7,
            title: "Claude Code won't clone existing games any more".into(),
            url: None,
            published: NOW,
            vector: hashed(
                "Claude Code won't clone existing games any more",
                "Anthropic's system prompt for Claude Code tells it not to re-create existing video games.",
            ),
            story: None,
        });
        assert_eq!(assign(&pool, &[20], Space::Hashed), vec![(20, 40)]);
    }

    #[test]
    fn the_same_link_joins_without_shared_words() {
        let mut pool = pool();
        pool.push(Member {
            id: 30,
            source: 8,
            title: "Show HN discussion".into(),
            url: Some("http://arstechnica.com/dogs/".into()),
            published: NOW,
            vector: hashed("Show HN discussion", ""),
            story: None,
        });
        let assigned = assign(&pool, &[30], Space::Hashed);
        assert_eq!(groups(&assigned), vec![vec![7, 30]]);
    }

    #[test]
    fn old_items_only_group_with_items_from_their_own_time() {
        let mut pool = pool();
        let title = "Apple reports Q4 2026 earnings: $114.5 billion in revenue, up 12%";
        // The same words, published a year earlier (a back catalogue).
        pool.push(Member {
            id: 50,
            source: 9,
            title: title.into(),
            url: None,
            published: NOW - 365 * 24 * HOUR,
            vector: hashed(title, "Apple today announced its earnings."),
            story: None,
        });
        assert!(assign(&pool, &[50], Space::Hashed).is_empty());
    }

    /// A podcast episode and a newsletter post that only share the word
    /// "Mending" (cosine 0.33 in the hashed space) aren't one story.
    #[test]
    fn a_shared_ordinary_word_is_not_enough() {
        let pool: Vec<Member> = [
            (
                1,
                1,
                "Episode 12: Mending",
                "Why broken things are interesting.",
            ),
            (
                2,
                2,
                "Mending a cracked glaze with gold",
                "A cracked glaze, mended with gold: kintsugi repair, lacquer and patience.",
            ),
        ]
        .into_iter()
        .map(|(id, source, title, body)| Member {
            id,
            source,
            title: title.into(),
            url: None,
            published: NOW,
            vector: hashed(title, body),
            story: None,
        })
        .collect();
        assert!(assign(&pool, &[1, 2], Space::Hashed).is_empty());
    }

    #[test]
    fn similar_topics_without_a_shared_name_stay_apart() {
        let pool: Vec<Member> = [
            (
                1,
                1,
                "Rust 2.0 is out",
                "The Rust project released version two of the language compiler today.",
            ),
            (
                2,
                2,
                "Why I stopped writing compilers",
                "Writing a compiler for a language taught me what I didn't want to do today.",
            ),
        ]
        .into_iter()
        .map(|(id, source, title, body)| Member {
            id,
            source,
            title: title.into(),
            url: None,
            published: NOW,
            vector: hashed(title, body),
            story: None,
        })
        .collect();
        assert!(assign(&pool, &[1, 2], Space::Hashed).is_empty());
    }
}
