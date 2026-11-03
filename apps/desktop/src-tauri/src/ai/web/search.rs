//! The search providers: one request and one response mapping each.
//!
//! | Provider | Request | Key | Results |
//! | --- | --- | --- | --- |
//! | Exa | `POST https://api.exa.ai/search` `{query, numResults, type: "auto", contents: {highlights}}` | `x-api-key` | `results[]`: `title`, `url`, `publishedDate`, `highlights`, `favicon` |
//! | Brave Search | `GET https://api.search.brave.com/res/v1/web/search?q&count` | `X-Subscription-Token` | `web.results[]`: `title`, `url`, `description` (with `<strong>`), `page_age` or `age`, `meta_url.favicon` |
//! | Tavily | `POST https://api.tavily.com/search` `{query, max_results, search_depth: "basic", include_favicon, include_published_date}` | `Authorization: Bearer` | `results[]`: `title`, `url`, `content`, `published_date`, `favicon` |

use super::{Provider, Source};
use serde_json::{Value, json};
use std::time::Duration;

type Result<T> = std::result::Result<T, String>;

pub const DEFAULT_RESULTS: usize = 8;
pub const MAX_RESULTS: usize = 20;
pub const SNIPPET_CHARS: usize = 300;
const TITLE_CHARS: usize = 200;
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(20);

enum Backend {
    Live {
        provider: Provider,
        key: String,
        endpoint: String,
    },
    /// Canned results for headless mock runs and tests: nothing leaves the Mac.
    #[cfg(any(test, feature = "headless"))]
    Scripted,
}

/// Searches with one provider and its key.
pub struct Searcher(Backend);

impl Searcher {
    pub fn new(provider: Provider, key: String) -> Self {
        let endpoint = match provider {
            Provider::Exa => "https://api.exa.ai/search",
            Provider::Brave => "https://api.search.brave.com/res/v1/web/search",
            Provider::Tavily => "https://api.tavily.com/search",
        };
        Searcher(Backend::Live {
            provider,
            key,
            endpoint: endpoint.into(),
        })
    }

    /// The same provider at another address (a local mock server).
    #[cfg(test)]
    pub fn at(provider: Provider, key: &str, endpoint: String) -> Self {
        Searcher(Backend::Live {
            provider,
            key: key.into(),
            endpoint,
        })
    }

    #[cfg(any(test, feature = "headless"))]
    pub fn scripted() -> Self {
        Searcher(Backend::Scripted)
    }

    pub fn id(&self) -> &'static str {
        match &self.0 {
            Backend::Live { provider, .. } => provider.id(),
            #[cfg(any(test, feature = "headless"))]
            Backend::Scripted => "mock",
        }
    }

    pub async fn search(&self, query: &str, count: usize) -> Result<Vec<Source>> {
        let (provider, key, endpoint) = match &self.0 {
            Backend::Live {
                provider,
                key,
                endpoint,
            } => (*provider, key.as_str(), endpoint.as_str()),
            #[cfg(any(test, feature = "headless"))]
            Backend::Scripted => return Ok(scripted(query, count)),
        };
        let client = reqwest::Client::builder()
            .user_agent(concat!("Kintsugi/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(10))
            .timeout(TIMEOUT)
            .build()
            .map_err(|_| "Couldn't start web search.".to_string())?;
        let request = match provider {
            Provider::Exa => client
                .post(endpoint)
                .header("x-api-key", key)
                .json(&exa_request(query, count)),
            Provider::Brave => {
                let mut url = reqwest::Url::parse(endpoint)
                    .map_err(|_| "Couldn't start web search.".to_string())?;
                url.query_pairs_mut()
                    .extend_pairs(brave_query(query, count));
                client
                    .get(url)
                    .header("X-Subscription-Token", key)
                    .header(reqwest::header::ACCEPT, "application/json")
            }
            Provider::Tavily => client
                .post(endpoint)
                .bearer_auth(key)
                .json(&tavily_request(query, count)),
        };
        let name = provider.name();
        // Errors are fixed strings: never the URL, the query or the key.
        let response = request.send().await.map_err(|e: reqwest::Error| {
            if e.is_timeout() {
                format!("{name} didn't answer in time.")
            } else {
                format!("Couldn't reach {name}.")
            }
        })?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            return Err(status_error(name, status));
        }
        let mut body = Vec::new();
        let mut response = response;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| format!("{name}'s answer was cut off."))?
        {
            if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
                return Err(format!("{name}'s answer was too large."));
            }
            body.extend_from_slice(&chunk);
        }
        let value: Value = serde_json::from_slice(&body)
            .map_err(|_| format!("{name} answered with something that isn't JSON."))?;
        let mut results = match provider {
            Provider::Exa => exa_results(&value),
            Provider::Brave => brave_results(&value),
            Provider::Tavily => tavily_results(&value),
        };
        results.truncate(count);
        Ok(results)
    }
}

fn status_error(name: &str, status: u16) -> String {
    match status {
        401 | 403 => format!("{name} refused the API key. Hussain can check it in Settings › Web."),
        402 | 432 | 433 => format!("{name} says the account is out of credits or over its limit."),
        429 => format!("{name} is rate limiting searches. Try again in a minute."),
        _ => format!("{name} search failed (HTTP {status})."),
    }
}

// --- Requests ---------------------------------------------------------------

pub(crate) fn exa_request(query: &str, count: usize) -> Value {
    json!({
        "query": query,
        "numResults": count,
        "type": "auto",
        "contents": { "highlights": { "maxCharacters": 600 } }
    })
}

pub(crate) fn brave_query(query: &str, count: usize) -> Vec<(&'static str, String)> {
    vec![("q", query.to_string()), ("count", count.to_string())]
}

pub(crate) fn tavily_request(query: &str, count: usize) -> Value {
    json!({
        "query": query,
        "max_results": count,
        "search_depth": "basic",
        "include_favicon": true,
        "include_published_date": true
    })
}

// --- Responses --------------------------------------------------------------

fn text(value: &Value) -> Option<&str> {
    value.as_str().map(str::trim).filter(|s| !s.is_empty())
}

/// A result's URL: absolute http(s) only, so a link in the chat can't be
/// `javascript:` or a file.
fn link(value: &Value) -> Option<String> {
    let url = reqwest::Url::parse(text(value)?).ok()?;
    matches!(url.scheme(), "http" | "https").then(|| url.to_string())
}

fn source(
    url: String,
    title: Option<&str>,
    snippet: Option<String>,
    date: Option<String>,
    favicon: Option<String>,
) -> Source {
    Source {
        title: title.map_or_else(String::new, |t| clean(t, TITLE_CHARS)),
        snippet: snippet
            .map(|s| clean(&s, SNIPPET_CHARS))
            .filter(|s| !s.is_empty()),
        date,
        favicon: favicon.filter(|f| f.starts_with("https://")),
        url,
    }
}

pub(crate) fn exa_results(value: &Value) -> Vec<Source> {
    let Some(results) = value["results"].as_array() else {
        return vec![];
    };
    results
        .iter()
        .filter_map(|r| {
            let url = link(&r["url"])?;
            let snippet = r["highlights"]
                .as_array()
                .map(|h| h.iter().filter_map(text).collect::<Vec<_>>().join(" … "))
                .filter(|s| !s.is_empty())
                .or_else(|| text(&r["summary"]).map(String::from))
                .or_else(|| text(&r["text"]).map(String::from));
            Some(source(
                url,
                text(&r["title"]),
                snippet,
                text(&r["publishedDate"]).map(day),
                link(&r["favicon"]),
            ))
        })
        .collect()
}

pub(crate) fn brave_results(value: &Value) -> Vec<Source> {
    let Some(results) = value["web"]["results"].as_array() else {
        return vec![];
    };
    results
        .iter()
        .filter_map(|r| {
            let url = link(&r["url"])?;
            let date = text(&r["page_age"])
                .map(day)
                .or_else(|| text(&r["age"]).map(String::from));
            Some(source(
                url,
                text(&r["title"]),
                text(&r["description"]).map(String::from),
                date,
                link(&r["meta_url"]["favicon"]).or_else(|| link(&r["profile"]["img"])),
            ))
        })
        .collect()
}

pub(crate) fn tavily_results(value: &Value) -> Vec<Source> {
    let Some(results) = value["results"].as_array() else {
        return vec![];
    };
    results
        .iter()
        .filter_map(|r| {
            let url = link(&r["url"])?;
            Some(source(
                url,
                text(&r["title"]),
                text(&r["content"]).map(String::from),
                text(&r["published_date"]).map(day),
                link(&r["favicon"]),
            ))
        })
        .collect()
}

/// `YYYY-MM-DD` from an ISO 8601 or RFC 2822 date; anything else as given.
pub fn day(raw: &str) -> String {
    let raw = raw.trim();
    if let Ok(at) = chrono::DateTime::parse_from_rfc2822(raw) {
        return at.format("%Y-%m-%d").to_string();
    }
    let head: String = raw.chars().take(10).collect();
    let bytes = head.as_bytes();
    if bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && head
            .chars()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
    {
        return head;
    }
    raw.chars().take(40).collect()
}

/// One line of plain text: tags dropped (Brave marks matches with
/// `<strong>`), common entities decoded, whitespace collapsed, at most
/// `max` characters.
pub fn clean(raw: &str, max: usize) -> String {
    let mut out = String::with_capacity(raw.len().min(max * 4));
    let mut in_tag = false;
    for c in raw.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    let decoded = out
        .replace("&nbsp;", " ")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&");
    let line = decoded.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= max {
        return line;
    }
    line.chars()
        .take(max)
        .collect::<String>()
        .trim_end()
        .to_string()
        + "…"
}

// --- Scripted (headless mock) -----------------------------------------------

#[cfg(any(test, feature = "headless"))]
fn scripted(query: &str, count: usize) -> Vec<Source> {
    let slug: String = query
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let rows = [
        ("en.wikipedia.org", "wiki", "Wikipedia", "2025-06-14"),
        (
            "www.newyorker.com",
            "magazine",
            "The New Yorker",
            "2024-11-02",
        ),
        ("example.org", "essays", "Example Essays", "2023-03-08"),
    ];
    rows.iter()
        .take(count)
        .map(|(host, path, site, date)| Source {
            url: format!("https://{host}/{path}/{slug}"),
            title: format!("{query}: {site} (mock result)"),
            snippet: Some(format!(
                "A scripted search result about {query} from the headless mock. Nothing was sent to a search provider."
            )),
            date: Some((*date).into()),
            favicon: None,
        })
        .collect()
}

#[cfg(any(test, feature = "headless"))]
pub(super) fn scripted_page(url: &reqwest::Url) -> super::Page {
    super::Page {
        asked: url.to_string(),
        url: url.to_string(),
        title: Some(format!("Mock page at {}", url.host_str().unwrap_or("the web"))),
        author: Some("Headless Mock".into()),
        site: url.host_str().map(String::from),
        published: Some("2025-06-14".into()),
        description: Some("A scripted page from the headless mock.".into()),
        body: "This page comes from the headless mock. Nothing was fetched from the web.\n\nIt has two paragraphs, so a reply can quote one.".into(),
    }
}
