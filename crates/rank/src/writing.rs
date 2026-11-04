//! News or writing (KI-105): which Feed items may be grouped into stories
//! and summarised by Kin, and which are an author's own words that always
//! stand alone. Local and cheap: no model calls, no network.
//!
//! Two levels decide it, and both must say "news" for an item to group:
//!
//! - **The source**: a personal or individual-author blog, or a publication
//!   or news site ([`personal`]), from what its items say about it: how many
//!   authors write there, whether the byline is the blog's own name, how
//!   often it speaks in the first person, datelines, and how often it
//!   publishes. A per-source switch overrides it (the app keeps that).
//! - **The item** ([`Signals::writing`]): a long read, a first-person piece,
//!   or a byline that is the source's own name is writing even on a news
//!   site; a dateline ("SAN FRANCISCO —", "(Reuters)") says news.
//!
//! When the signals say nothing either way, a source counts as personal: a
//! missed group costs less than an essay folded into Kin's summary.

use std::collections::HashSet;

/// A long read: this many words or more.
pub const LONG_READ_WORDS: usize = 2_000;
/// First-person voice: at least this many "I", "my", "me"… outside quotes,
/// and at least one per this many words.
const FIRST_PERSON_MIN: usize = 2;
const FIRST_PERSON_PER_WORDS: usize = 100;

/// What one item's text says about it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Signals {
    /// Words in its text (or summary).
    pub words: usize,
    /// "I", "me", "my" and the like, outside quotation marks.
    pub first_person: usize,
    /// Its author is the source's own name ("Simon Willison" on "Simon
    /// Willison's Weblog" or simonwillison.net).
    pub byline_is_source: bool,
    /// It opens with a news dateline.
    pub dateline: bool,
}

impl Signals {
    /// Reads an item: its author, its text (Markdown or plain), and its
    /// source's title and site.
    pub fn read(author: Option<&str>, text: &str, source_title: Option<&str>, site: &str) -> Self {
        let unquoted = without_quotes(text);
        let words: Vec<&str> = unquoted.split_whitespace().collect();
        let first_person = words.iter().filter(|w| first_person(w)).count();
        Signals {
            words: text.split_whitespace().count(),
            first_person,
            byline_is_source: author.is_some_and(|a| byline_matches(a, source_title, site)),
            dateline: dateline(text),
        }
    }

    pub fn first_person_voice(&self) -> bool {
        self.first_person >= FIRST_PERSON_MIN
            && self.first_person * FIRST_PERSON_PER_WORDS >= self.words
    }

    pub fn long_read(&self) -> bool {
        self.words >= LONG_READ_WORDS
    }

    /// An author's own writing (an essay, a personal post, a long read),
    /// never grouped, whatever its source.
    pub fn writing(&self) -> bool {
        let mut score = 0i32;
        if self.byline_is_source {
            score += 2;
        }
        if self.first_person_voice() {
            score += 2;
        }
        if self.long_read() {
            score += 2;
        }
        if self.dateline {
            score -= 3;
        }
        score >= 2
    }
}

/// One of a source's items, as [`personal`] reads it.
#[derive(Clone, Debug, Default)]
pub struct SourceItem {
    pub author: Option<String>,
    pub signals: Signals,
    /// Seconds since the epoch.
    pub published: i64,
}

/// Whether a feed is a personal or individual-author blog (its items never
/// group by default) rather than a publication or news site. Reads its most
/// recent items.
pub fn personal(items: &[SourceItem]) -> bool {
    if items.is_empty() {
        return true;
    }
    let n = items.len();
    let authors: HashSet<String> = items
        .iter()
        .filter_map(|i| i.author.as_deref())
        .map(|a| a.trim().to_lowercase())
        .filter(|a| !a.is_empty())
        .collect();
    let with_author = items.iter().filter(|i| i.author.is_some()).count();
    let share = |f: &dyn Fn(&SourceItem) -> bool| items.iter().filter(|i| f(i)).count() * 10 / n;
    let (mut news, mut own) = (0, 0);
    match authors.len() {
        0 => {}
        1 if with_author * 2 >= n => own += 1,
        1 => {}
        2 => news += 1,
        _ => news += 3,
    }
    // The byline is the blog's own name: share in tenths.
    if share(&|i| i.signals.byline_is_source) >= 5 {
        own += 3;
    }
    if share(&|i| i.signals.first_person_voice()) >= 4 {
        own += 2;
    }
    if share(&|i| i.signals.dateline) >= 2 {
        news += 2;
    }
    // A publication publishes several pieces a day.
    if n >= 6 {
        let newest = items.iter().map(|i| i.published).max().unwrap_or(0);
        let oldest = items.iter().map(|i| i.published).min().unwrap_or(0);
        let days = ((newest - oldest) as f64 / 86_400.0).max(1.0);
        if n as f64 / days >= 3.0 {
            news += 1;
        }
    }
    own >= news
}

const FIRST_PERSON: &[&str] = &[
    "i", "i'm", "i've", "i'd", "i'll", "me", "my", "mine", "myself",
];

fn first_person(word: &str) -> bool {
    let w = word
        .trim_matches(|c: char| !c.is_alphanumeric() && c != '\'' && c != '’')
        .replace('’', "'")
        .to_lowercase();
    FIRST_PERSON.contains(&w.as_str())
}

/// The text with quoted speech removed ("…", “…”), so a news story quoting
/// someone's "I" doesn't read as first person.
fn without_quotes(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut quoted = false;
    let mut straight = false;
    for c in text.chars() {
        match c {
            '“' if !straight => quoted = true,
            '”' if !straight => {
                quoted = false;
                out.push(' ');
            }
            '"' => {
                straight = !straight;
                quoted = straight;
                out.push(' ');
            }
            // A paragraph ends any quote a lost mark left open.
            '\n' => {
                quoted = false;
                straight = false;
                out.push(c);
            }
            _ if !quoted => out.push(c),
            _ => {}
        }
    }
    out
}

/// The name's words (three letters or more; no initials or titles).
fn name_words(name: &str) -> Vec<String> {
    name.split(|c: char| !c.is_alphanumeric())
        .map(str::to_lowercase)
        .filter(|w| w.chars().count() >= 3 && !matches!(w.as_str(), "the" | "and" | "by"))
        .collect()
}

/// The author's name is the source's: every word of it in the source's
/// title, or the name run together in its site's host.
fn byline_matches(author: &str, title: Option<&str>, site: &str) -> bool {
    let name = name_words(author);
    if name.is_empty() {
        return false;
    }
    if let Some(title) = title {
        let title: HashSet<String> = name_words(&title.replace("’s", "").replace("'s", ""))
            .into_iter()
            .collect();
        if name.iter().all(|w| title.contains(w)) {
            return true;
        }
    }
    let host = site
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .split('/')
        .next()
        .unwrap_or("")
        .trim_start_matches("www.")
        .to_lowercase()
        .replace(['-', '.'], "");
    let joined: String = name.concat();
    joined.chars().count() >= 5 && host.contains(&joined)
}

/// A news dateline at the start: "SAN FRANCISCO —", "LONDON, Nov 3
/// (Reuters) -", "(AP) —" or "CUPERTINO, CALIFORNIA Apple today…".
fn dateline(text: &str) -> bool {
    let start: String = text
        .trim_start()
        .trim_start_matches(['*', '_', '#', ' '])
        .chars()
        .take(90)
        .collect();
    let agency = [
        "(Reuters)",
        "(AP)",
        "(AFP)",
        "(Bloomberg)",
        "(UPI)",
        "(CNN)",
    ];
    if agency.iter().any(|a| start.contains(a)) {
        return true;
    }
    // An all-capitals place name, then a dash.
    let Some(dash) = start.find(['—', '–']).or_else(|| start.find(" - ")) else {
        return false;
    };
    let head = start[..dash].trim().trim_end_matches(['*', '_']).trim();
    let first = head.split([',', ' ']).next().unwrap_or("");
    let letters = first.chars().filter(|c| c.is_alphabetic()).count();
    letters >= 3
        && first
            .chars()
            .all(|c| !c.is_alphabetic() || c.is_uppercase())
        && head.chars().count() <= 60
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_dateline_says_news() {
        assert!(dateline("SAN FRANCISCO — Apple said on Thursday…"));
        assert!(dateline("LONDON, Nov 3 (Reuters) - Shares fell"));
        assert!(dateline(
            "**CUPERTINO, CALIFORNIA** — Apple today announced"
        ));
        assert!(!dateline(
            "I spent the weekend — finally — fixing the bowl."
        ));
        assert!(!dateline("Apple today announced its results."));
    }

    #[test]
    fn quoted_speech_is_not_the_writer_speaking() {
        let quoted = Signals::read(
            None,
            "“I think my team did well and I am proud of me,” Tim Cook told analysts. Revenue rose.",
            Some("The Ledger"),
            "https://ledger.example",
        );
        assert_eq!(quoted.first_person, 0);
        let own = Signals::read(
            None,
            "I spent my weekend mending a bowl. My hands still smell of lacquer, and I liked it.",
            Some("Mara's notes"),
            "https://mara.example",
        );
        assert!(own.first_person_voice() && own.writing());
    }

    #[test]
    fn a_byline_that_is_the_blog_is_writing() {
        let s = Signals::read(
            Some("Simon Willison"),
            "A new release of the tool.",
            Some("Simon Willison's Weblog"),
            "https://simonwillison.net/",
        );
        assert!(s.byline_is_source && s.writing());
        assert!(byline_matches(
            "Paul Graham",
            None,
            "https://paulgraham.com/articles.html"
        ));
        assert!(byline_matches(
            "Hussain",
            Some("Notes"),
            "https://hussain.ph"
        ));
        assert!(!byline_matches(
            "Jane Doe",
            Some("The Verge"),
            "https://www.theverge.com"
        ));
    }

    #[test]
    fn a_long_read_is_writing_unless_it_has_a_dateline() {
        let long = "word ".repeat(LONG_READ_WORDS);
        assert!(Signals::read(None, &long, None, "").writing());
        let dated = format!("WASHINGTON — {long}");
        assert!(!Signals::read(None, &dated, None, "").writing());
        assert!(
            !Signals::read(None, "Apple reported revenue of $114.5 billion.", None, "").writing()
        );
    }

    fn item(author: Option<&str>, signals: Signals, hours: i64) -> SourceItem {
        SourceItem {
            author: author.map(str::to_string),
            signals,
            published: 1_800_000_000 - hours * 3_600,
        }
    }

    #[test]
    fn many_authors_and_a_busy_day_is_a_publication() {
        let plain = Signals {
            words: 300,
            ..Default::default()
        };
        let items: Vec<SourceItem> = ["Ana", "Ben", "Cy", "Ana", "Dee", "Ben"]
            .iter()
            .enumerate()
            .map(|(n, a)| item(Some(a), plain, n as i64 * 3))
            .collect();
        assert!(!personal(&items));
    }

    #[test]
    fn one_author_or_no_signal_at_all_is_personal() {
        let plain = Signals {
            words: 300,
            ..Default::default()
        };
        let one: Vec<SourceItem> = (0..5)
            .map(|n| item(Some("Mara Ito"), plain, n * 48))
            .collect();
        assert!(personal(&one));
        let silent: Vec<SourceItem> = (0..3).map(|n| item(None, plain, n * 48)).collect();
        assert!(personal(&silent), "unknown leans personal");
        assert!(personal(&[]));
        // No bylines, but datelines and several pieces a day: a wire.
        let dated = Signals {
            words: 300,
            dateline: true,
            ..Default::default()
        };
        let wire: Vec<SourceItem> = (0..8).map(|n| item(None, dated, n)).collect();
        assert!(!personal(&wire));
    }
}
