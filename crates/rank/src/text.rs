//! Words, topics and the hashed fallback embedding.
//!
//! Topics are cheap keywords (a clip's tags, else the most telling words of
//! a title), not an LLM's labels. The hashed embedding is a signed
//! feature-hashing bag of words: it stands in for model2vec vectors when the
//! model isn't available (headless runs, tests, the first minutes after
//! install), so similarity still means something.

use crate::vector::{DIMS, normalize};

/// Common English words that say nothing about a topic.
const STOPWORDS: &[&str] = &[
    "about", "above", "after", "again", "against", "all", "also", "and", "any", "are", "around", "because", "been", "before",
    "being", "below", "best", "better", "between", "both", "but", "can", "could", "did", "does", "doing", "done", "down",
    "during", "each", "even", "every", "few", "for", "from", "further", "get", "gets", "getting", "going", "good", "great",
    "had", "has", "have", "having", "her", "here", "hers", "him", "his", "how", "into", "its", "itself", "just", "know",
    "last", "less", "let", "like", "little", "long", "made", "make", "makes", "making", "many", "more", "most", "much",
    "must", "new", "next", "not", "now", "off", "old", "once", "one", "only", "other", "our", "ours", "out", "over", "own",
    "part", "people", "post", "posts", "read", "really", "right", "same", "say", "says", "see", "she", "should", "show",
    "since", "some", "still", "such", "take", "than", "that", "the", "their", "theirs", "them", "then", "there", "these",
    "they", "thing", "things", "think", "this", "those", "through", "time", "today", "too", "two", "under", "until", "upon",
    "use", "used", "using", "very", "via", "want", "was", "way", "ways", "week", "well", "were", "what", "when", "where",
    "which", "while", "who", "whom", "why", "will", "with", "without", "work", "would", "year", "years", "yet", "you",
    "your", "yours", "episode", "video", "podcast", "http", "https", "www", "com",
];

fn stopword(word: &str) -> bool {
    static SET: std::sync::OnceLock<std::collections::HashSet<&'static str>> = std::sync::OnceLock::new();
    SET.get_or_init(|| STOPWORDS.iter().copied().collect()).contains(word)
}

/// Lowercased words of three or more letters, without stopwords or digits-only runs.
pub fn words(text: &str) -> impl Iterator<Item = String> + '_ {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.chars().count() >= 3 && !w.chars().all(|c| c.is_ascii_digit()))
        .map(str::to_lowercase)
        .filter(|w| !stopword(w))
}

/// A word as a topic key: plurals folded ("tools" → "tool").
pub fn topic_key(word: &str) -> String {
    let word = word.trim().to_lowercase();
    if word.chars().count() > 4 && word.ends_with('s') && !word.ends_with("ss") && !word.ends_with("us") && !word.ends_with("is") {
        word[..word.len() - 1].to_string()
    } else {
        word
    }
}

/// Folds endings so "mending", "mended" and "mends" hash together.
fn stem(word: &str) -> String {
    let word = topic_key(word);
    for suffix in ["ing", "ed", "es"] {
        if let Some(base) = word.strip_suffix(suffix)
            && base.chars().count() >= 4
        {
            return base.to_string();
        }
    }
    word
}

/// Up to three topics: tags first, then the title's words, then the body's.
/// A title word counts double. Ties keep the first word seen.
pub fn topics(title: &str, body: &str, tags: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for tag in tags {
        let key = topic_key(&tag.replace(['-', '_'], " "));
        if !key.is_empty() && !out.contains(&key) && out.len() < 3 {
            out.push(key);
        }
    }
    let mut counts: Vec<(String, f32)> = Vec::new();
    let body: String = body.chars().take(800).collect();
    for (text, weight) in [(title, 2.0f32), (body.as_str(), 1.0)] {
        for word in words(text).filter(|w| w.chars().count() >= 4) {
            let key = topic_key(&word);
            match counts.iter_mut().find(|(k, _)| *k == key) {
                Some(entry) => entry.1 += weight,
                None => counts.push((key, weight)),
            }
        }
    }
    // Stable: equal counts keep their first-seen order.
    counts.sort_by(|a, b| b.1.total_cmp(&a.1));
    for (key, count) in counts {
        if out.len() >= 3 {
            break;
        }
        // A lone body word isn't a topic.
        if count >= 2.0 && !out.contains(&key) {
            out.push(key);
        }
    }
    out
}

fn fnv1a(text: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash
}

/// A signed feature-hashing embedding of `title` (counted double) and `body`,
/// normalized. Text without content words gives the zero vector.
pub fn hashed(title: &str, body: &str) -> Vec<f32> {
    let mut vector = vec![0f32; DIMS];
    let body: String = body.chars().take(4_000).collect();
    for (text, weight) in [(title, 2.0f32), (body.as_str(), 1.0)] {
        for word in words(text) {
            let hash = fnv1a(&stem(&word));
            let sign = if hash >> 63 == 0 { 1.0 } else { -1.0 };
            vector[(hash % DIMS as u64) as usize] += sign * weight;
        }
    }
    // Sublinear term frequency, so one repeated word doesn't dominate.
    for x in &mut vector {
        *x = x.signum() * x.abs().ln_1p();
    }
    normalize(&mut vector);
    vector
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vector::cosine;

    #[test]
    fn topics_prefer_tags_then_title_words() {
        assert_eq!(topics("Anything", "", &["Wood-working".into(), "craft".into()]), ["wood working", "craft", "anything"]);
        assert_eq!(topics("Hand-cut dovetails, slowly", "Dovetails take patience.", &[]), ["dovetail", "hand", "slowly"]);
        // A word only once in the body isn't a topic.
        assert!(topics("Hi", "glaze", &[]).is_empty());
    }

    #[test]
    fn hashed_vectors_find_shared_words() {
        let a = hashed("Mending pottery with gold", "Kintsugi repairs broken ceramics.");
        let b = hashed("On mended ceramics", "Repair as a design material for pottery.");
        let c = hashed("Football transfer rumours", "The striker signed for the league leaders.");
        assert!(cosine(&a, &b) > 0.3, "{}", cosine(&a, &b));
        assert!(cosine(&a, &c) < 0.15, "{}", cosine(&a, &c));
        assert!(hashed("the and of", "").iter().all(|x| *x == 0.0));
    }
}
