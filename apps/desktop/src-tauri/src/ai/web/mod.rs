//! Kin's web tools (KI-78): `web_search` through the search provider he
//! picks in Settings › Web (Exa, Brave Search or Tavily, each with its own
//! key), and `web_fetch`, which reads a public page as Markdown with the
//! ingest engine's web-page adapter, guarded to the public internet.
//!
//! - **Keys** live in `<config>/kin/web.json`, owner-only (0600), beside
//!   Kin's other app data and never in the vault. They are read in Rust and
//!   never sent to the webview, logged or put in an error. Without a saved
//!   key, the provider's environment variable is used (`EXA_API_KEY`,
//!   `BRAVE_API_KEY`, `TAVILY_API_KEY`).
//! - **Off switch.** With web tools off, the turn's tool list has neither
//!   tool. With them on and no key, `web_search` says how to set one up and
//!   `web_fetch` still works: it needs no service.
//! - **Untrusted.** Results are wrapped as `<data>` like every tool output,
//!   and the prompt says pages are strangers' claims, never instructions.
//!   [`guard`] adds hard limits (KI-81): `web_fetch` opens only links with
//!   provenance in the turn, queries can't quote the vault, and after a web
//!   call memory is read-only for the rest of the turn.
//! - **Helpers.** Background helper jobs (the daily Ideas batch and the
//!   rest) get web tools only while Settings › Web allows it; off by default.

pub mod guard;
pub mod search;

use kintsugi_ingest::web::{Limits, WebAdapter};
use kintsugi_ingest::{CaptureOptions, Error as IngestError, Item};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, VecDeque};
use std::fs;
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

type Result<T> = std::result::Result<T, String>;

const FILE: &str = "web.json";
/// The most of a page one `web_fetch` returns; `start` reads on.
pub const PAGE_CHARS: usize = 12_000;
/// Fetched pages kept for paging within a turn.
const CACHED_PAGES: usize = 8;
const MAX_KEY_CHARS: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Exa,
    Brave,
    Tavily,
}

impl Provider {
    pub const ALL: [Provider; 3] = [Provider::Exa, Provider::Brave, Provider::Tavily];

    pub fn id(self) -> &'static str {
        match self {
            Provider::Exa => "exa",
            Provider::Brave => "brave",
            Provider::Tavily => "tavily",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Provider::Exa => "Exa",
            Provider::Brave => "Brave Search",
            Provider::Tavily => "Tavily",
        }
    }

    /// Environment variables read when no key is saved, first wins.
    pub fn env(self) -> &'static [&'static str] {
        match self {
            Provider::Exa => &["EXA_API_KEY"],
            Provider::Brave => &["BRAVE_API_KEY", "BRAVE_SEARCH_API_KEY"],
            Provider::Tavily => &["TAVILY_API_KEY"],
        }
    }
}

/// What `web.json` holds.
#[derive(Clone, Serialize, Deserialize)]
struct Stored {
    #[serde(default = "yes")]
    enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    provider: Option<Provider>,
    #[serde(default)]
    keys: BTreeMap<Provider, String>,
    /// Background helpers may use the web too (KI-81).
    #[serde(default)]
    helpers: bool,
}

impl Default for Stored {
    fn default() -> Self {
        Stored {
            enabled: true,
            provider: None,
            keys: BTreeMap::new(),
            helpers: false,
        }
    }
}

fn yes() -> bool {
    true
}

/// Where a provider's key comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum KeySource {
    Settings,
    Environment,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderView {
    pub id: Provider,
    pub name: &'static str,
    /// Where its key comes from; `None` without one. Never the key.
    pub key: Option<KeySource>,
}

/// Settings › Web, as the webview sees it. Holds no secret.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub enabled: bool,
    /// Background helpers get the web tools too.
    pub helpers: bool,
    /// His pick, if any.
    pub provider: Option<Provider>,
    /// What `web_search` uses now: his pick while it has a key, else the
    /// first provider with one.
    pub active: Option<Provider>,
    pub providers: Vec<ProviderView>,
}

/// The web settings and keys. One per process (`store`), like the meter.
pub struct Store {
    path: Option<PathBuf>,
    state: Mutex<Stored>,
    /// Reads the environment (tests swap it out; headless runs read none
    /// unless AI is enabled read-only).
    env: Box<dyn Fn(&str) -> Option<String> + Send + Sync>,
}

impl Store {
    /// `dir` is Kin's data folder; `None` keeps everything in memory.
    pub fn open(dir: Option<PathBuf>) -> Self {
        let path = dir.map(|d| d.join(FILE));
        let state = path
            .as_ref()
            .and_then(|p| fs::read_to_string(p).ok())
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        Store {
            path,
            state: Mutex::new(state),
            env: Box::new(|name| {
                #[cfg(feature = "headless")]
                if !crate::headless::ai_enabled() {
                    let _ = name;
                    return None;
                }
                std::env::var(name).ok()
            }),
        }
    }

    #[cfg(test)]
    pub fn with_env(
        mut self,
        env: impl Fn(&str) -> Option<String> + Send + Sync + 'static,
    ) -> Self {
        self.env = Box::new(env);
        self
    }

    fn key_of(&self, state: &Stored, provider: Provider) -> Option<(String, KeySource)> {
        if let Some(key) = state.keys.get(&provider).filter(|k| !k.is_empty()) {
            return Some((key.clone(), KeySource::Settings));
        }
        provider.env().iter().find_map(|name| {
            (self.env)(name)
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
                .map(|v| (v, KeySource::Environment))
        })
    }

    fn active(&self, state: &Stored) -> Option<(Provider, String)> {
        let order = state.provider.into_iter().chain(
            Provider::ALL
                .into_iter()
                .filter(|p| Some(*p) != state.provider),
        );
        for provider in order {
            if let Some((key, _)) = self.key_of(state, provider) {
                return Some((provider, key));
            }
        }
        None
    }

    pub fn view(&self) -> View {
        let state = self.state.lock().unwrap();
        View {
            enabled: state.enabled,
            helpers: state.helpers,
            provider: state.provider,
            active: self.active(&state).map(|(p, _)| p),
            providers: Provider::ALL
                .into_iter()
                .map(|id| ProviderView {
                    id,
                    name: id.name(),
                    key: self.key_of(&state, id).map(|(_, source)| source),
                })
                .collect(),
        }
    }

    fn update(&self, change: impl FnOnce(&mut Stored)) -> Result<View> {
        {
            let mut state = self.state.lock().unwrap();
            let mut next = state.clone();
            change(&mut next);
            if let Some(path) = &self.path {
                write_private(path, &next)?;
            }
            *state = next;
        }
        Ok(self.view())
    }

    pub fn set_enabled(&self, enabled: bool) -> Result<View> {
        self.update(|s| s.enabled = enabled)
    }

    /// Background helpers get the web tools too.
    pub fn helpers(&self) -> bool {
        self.state.lock().unwrap().helpers
    }

    pub fn set_helpers(&self, helpers: bool) -> Result<View> {
        self.update(|s| s.helpers = helpers)
    }

    pub fn set_provider(&self, provider: Option<Provider>) -> Result<View> {
        self.update(|s| s.provider = provider)
    }

    /// Saves (or, empty or `None`, removes) a provider's key.
    pub fn set_key(&self, provider: Provider, key: Option<String>) -> Result<View> {
        let key = key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty());
        if let Some(key) = &key
            && (key.chars().count() > MAX_KEY_CHARS
                || key.chars().any(|c| c.is_whitespace() || c.is_control()))
        {
            return Err("That doesn't look like an API key.".into());
        }
        self.update(|s| match key {
            Some(key) => {
                s.keys.insert(provider, key);
                // The first key he adds is the one Kin uses.
                if s.provider.is_none() {
                    s.provider = Some(provider);
                }
            }
            None => {
                s.keys.remove(&provider);
            }
        })
    }

    /// The web tools for one turn, or `None` when they are off. A
    /// `helper` (a background job nobody is watching) gets them only while
    /// helpers are allowed.
    pub fn tools(&self, helper: bool) -> Option<Arc<Web>> {
        let state = self.state.lock().unwrap();
        if !state.enabled || (helper && !state.helpers) {
            return None;
        }
        let search = self
            .active(&state)
            .map(|(provider, key)| search::Searcher::new(provider, key));
        Some(Arc::new(Web::new(search, Reader::Live)))
    }
}

/// Owner-only, whole-file atomic replace.
fn write_private(path: &std::path::Path, state: &Stored) -> Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let fail = |_| "Couldn't save the web settings.".to_string();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(fail)?;
    }
    let tmp = path.with_file_name(format!(".{FILE}.{}", std::process::id()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)
        .map_err(fail)?;
    let bytes = serde_json::to_vec_pretty(state).map_err(|_| "Couldn't save the web settings.")?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(fail)?;
    fs::rename(&tmp, path).map_err(fail)
}

static STORE: OnceLock<Store> = OnceLock::new();

/// The process-wide web settings; `init` points them at Kin's data folder.
pub fn store() -> &'static Store {
    STORE.get_or_init(|| Store::open(None))
}

pub fn init(dir: Option<PathBuf>) {
    let _ = STORE.set(Store::open(dir));
}

/// One turn's web tools, or `None` while they're off (for a background
/// `helper`, unless helpers are allowed). The headless mock model gets
/// scripted results: no keys, no network.
pub fn for_turn(helper: bool) -> Option<Arc<Web>> {
    let web = store().tools(helper)?;
    #[cfg(feature = "headless")]
    if crate::headless::kin_mock() && !crate::headless::ai_enabled() {
        return Some(Arc::new(Web::scripted()));
    }
    Some(web)
}

// --- What the chat shows ----------------------------------------------------

/// One result or page, as the chat shows it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub url: String,
    #[serde(default)]
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
    /// `YYYY-MM-DD` when known, else the provider's own words ("2 days ago").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub favicon: Option<String>,
}

/// A web tool call that worked, kept on Kin's reply in the log so the chat
/// can show its sources after the turn.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebCall {
    /// `"search"` or `"fetch"`.
    pub tool: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    /// The search provider's id (`"mock"` in a scripted headless run).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default)]
    pub results: Vec<Source>,
}

/// The most web calls one reply keeps.
pub const MAX_CALLS_PER_REPLY: usize = 12;

// --- The tools --------------------------------------------------------------

enum Reader {
    Live,
    /// A scripted page for headless mock runs: no network.
    #[cfg(any(test, feature = "headless"))]
    Scripted,
    /// A guarded reader with names pinned to loopback (tests).
    #[cfg(test)]
    Pinned(Vec<(String, std::net::SocketAddr)>),
}

/// A fetched page, kept for paging.
struct Page {
    /// The URL Kin asked for; `url` is where it ended up.
    asked: String,
    url: String,
    title: Option<String>,
    author: Option<String>,
    site: Option<String>,
    published: Option<String>,
    description: Option<String>,
    body: String,
}

/// One turn's web tools.
pub struct Web {
    search: Option<search::Searcher>,
    reader: Reader,
    pages: Mutex<VecDeque<Arc<Page>>>,
    /// What this turn may fetch and search, and whether web text came in.
    guard: Mutex<guard::Guard>,
}

/// What a web tool returns: text for the model, and what the chat shows.
pub struct Answer {
    pub text: String,
    pub call: WebCall,
}

impl Web {
    fn new(search: Option<search::Searcher>, reader: Reader) -> Self {
        Web {
            search,
            reader,
            pages: Mutex::new(VecDeque::new()),
            guard: Mutex::default(),
        }
    }

    /// The thread keeps provenance and hashed private phrases, not page bodies.
    pub(crate) fn provenance(&self) -> guard::Guard {
        self.guard.lock().unwrap().clone()
    }

    pub(crate) fn restore_provenance(&self, previous: &guard::Guard) {
        self.guard.lock().unwrap().restore(previous);
    }

    /// Hussain's own words this turn: his links may be opened, his phrases
    /// searched as written.
    pub fn heard(&self, text: &str) {
        self.guard.lock().unwrap().heard(text);
    }

    /// Vault or Feed text Kin read this turn: its links may be opened, and
    /// queries may not quote it.
    pub fn read(&self, text: &str) {
        self.guard.lock().unwrap().read(text);
    }

    /// Web text came into this turn: memory and skills are read-only.
    pub fn tainted(&self) -> bool {
        self.guard.lock().unwrap().tainted()
    }

    /// The headless mock's web: scripted results and pages, no network,
    /// no keys (`KINTSUGI_HEADLESS_KIN=mock`).
    #[cfg(any(test, feature = "headless"))]
    pub fn scripted() -> Self {
        Web::new(Some(search::Searcher::scripted()), Reader::Scripted)
    }

    #[cfg(test)]
    fn for_tests(
        search: Option<search::Searcher>,
        pinned: Vec<(String, std::net::SocketAddr)>,
    ) -> Self {
        Web::new(search, Reader::Pinned(pinned))
    }

    pub async fn search(&self, args: &Value) -> Result<Answer> {
        let query = args["query"].as_str().unwrap_or_default().trim();
        if query.is_empty() {
            return Err("web_search needs a query".into());
        }
        self.guard.lock().unwrap().may_search(query)?;
        let count = args["count"]
            .as_u64()
            .or_else(|| args["k"].as_u64())
            .map_or(search::DEFAULT_RESULTS, |n| {
                (n as usize).clamp(1, search::MAX_RESULTS)
            });
        let Some(searcher) = &self.search else {
            return Err("Web search isn't set up: there's no Exa, Brave Search or Tavily key. Hussain can add one in Settings › Web. web_fetch still works.".into());
        };
        let results = searcher.search(query, count).await?;
        self.guard
            .lock()
            .unwrap()
            .searched(results.iter().map(|r| r.url.as_str()));
        let lines: Vec<String> = results
            .iter()
            .filter_map(|r| {
                let mut hit = serde_json::json!({ "title": r.title, "url": r.url });
                if let Some(snippet) = &r.snippet {
                    hit["snippet"] = snippet.clone().into();
                }
                if let Some(date) = &r.date {
                    hit["date"] = date.clone().into();
                }
                serde_json::to_string(&hit).ok()
            })
            .collect();
        let text = if lines.is_empty() {
            "[]".to_string()
        } else {
            format!("[\n{}\n]", lines.join(",\n"))
        };
        Ok(Answer {
            text,
            call: WebCall {
                tool: "search".into(),
                query: Some(query.into()),
                provider: Some(searcher.id().into()),
                results,
            },
        })
    }

    pub async fn fetch(&self, args: &Value) -> Result<Answer> {
        let raw = args["url"].as_str().unwrap_or_default().trim();
        if raw.is_empty() {
            return Err("web_fetch needs a url".into());
        }
        let url = reqwest::Url::parse(raw)
            .ok()
            .filter(kintsugi_ingest::web::guard::public_url)
            .ok_or(
                "web_fetch reads public http(s) pages only: no local, private or file addresses.",
            )?;
        let start = args["start"].as_u64().unwrap_or(0) as usize;
        let page = match self.cached(url.as_str()) {
            Some(page) => page,
            None => {
                self.guard.lock().unwrap().may_fetch(&url)?;
                let page = Arc::new(self.load(&url).await?);
                self.guard
                    .lock()
                    .unwrap()
                    .fetched(&url, &page.url, &page.body);
                let mut pages = self.pages.lock().unwrap();
                if pages.len() >= CACHED_PAGES {
                    pages.pop_front();
                }
                pages.push_back(page.clone());
                page
            }
        };
        Ok(Answer {
            text: render(&page, raw, start),
            call: WebCall {
                tool: "fetch".into(),
                query: None,
                provider: None,
                results: vec![Source {
                    url: page.url.clone(),
                    title: page.title.clone().unwrap_or_default(),
                    snippet: page
                        .description
                        .as_deref()
                        .map(|d| search::clean(d, search::SNIPPET_CHARS)),
                    date: page.published.as_deref().map(search::day),
                    favicon: None,
                }],
            },
        })
    }

    fn cached(&self, url: &str) -> Option<Arc<Page>> {
        self.pages
            .lock()
            .unwrap()
            .iter()
            .find(|p| p.url == url || p.asked == url)
            .cloned()
    }

    async fn load(&self, url: &reqwest::Url) -> Result<Page> {
        let limits = Limits {
            deadline: Duration::from_secs(30),
            ..Limits::default()
        };
        let adapter = match &self.reader {
            Reader::Live => WebAdapter::reader(limits),
            #[cfg(any(test, feature = "headless"))]
            Reader::Scripted => return Ok(search::scripted_page(url)),
            #[cfg(test)]
            Reader::Pinned(pinned) => {
                let pinned: Vec<(&str, std::net::SocketAddr)> =
                    pinned.iter().map(|(n, a)| (n.as_str(), *a)).collect();
                WebAdapter::reader_pinned(limits, &pinned)
            }
        }
        .map_err(|_| "Couldn't start the page reader.".to_string())?;
        let item = adapter
            .fetch(url, CaptureOptions { want_media: false })
            .await
            .map_err(|e| fetch_error(&e))?;
        Ok(Page::from_item(item, url.as_str()))
    }
}

impl Page {
    fn from_item(item: Item, requested: &str) -> Self {
        Page {
            asked: requested.to_string(),
            url: item.url.unwrap_or_else(|| requested.to_string()),
            title: item.title,
            author: item.author,
            site: item.site,
            published: item.published,
            description: item.description,
            body: item.body,
        }
    }
}

fn fetch_error(error: &IngestError) -> String {
    match error {
        IngestError::InvalidUrl => {
            "web_fetch reads public http(s) pages only: no local, private or file addresses.".into()
        }
        IngestError::TooLarge => "That page is too large to read.".into(),
        IngestError::TimedOut => "The page took too long to load.".into(),
        IngestError::Status(code) => format!("The page answered HTTP {code}."),
        _ => "Couldn't read that page (unreachable, blocked, or nothing readable on it).".into(),
    }
}

/// A page for the model: what it is, then up to [`PAGE_CHARS`] of its text
/// from `start`, and where to read on.
fn render(page: &Page, asked: &str, start: usize) -> String {
    let mut out = String::new();
    if let Some(title) = &page.title {
        out.push_str(&format!("# {title}\n"));
    }
    out.push_str(&format!("URL: {}\n", page.url));
    if page.url != asked {
        out.push_str(&format!("(asked for {asked})\n"));
    }
    let facts: Vec<String> = [
        page.author.as_ref().map(|a| format!("By {a}")),
        page.site.clone(),
        page.published
            .as_ref()
            .map(|p| format!("Published {}", search::day(p))),
    ]
    .into_iter()
    .flatten()
    .collect();
    if !facts.is_empty() {
        out.push_str(&facts.join(" · "));
        out.push('\n');
    }
    let total = page.body.chars().count();
    if total == 0 {
        out.push_str("\n(No readable text on this page.)\n");
        return out;
    }
    if start >= total {
        out.push_str(&format!(
            "\nThe page has {total} characters; start is past the end.\n"
        ));
        return out;
    }
    let text: String = page.body.chars().skip(start).take(PAGE_CHARS).collect();
    let end = start + text.chars().count();
    out.push('\n');
    if start > 0 {
        out.push_str(&format!("(characters {start}-{end} of {total})\n"));
    }
    out.push_str(&text);
    if end < total {
        out.push_str(&format!(
            "\n\n(more: {} characters left; call web_fetch with start {end})",
            total - end
        ));
    }
    out
}

// --- Tauri ------------------------------------------------------------------

#[tauri::command]
pub fn web_settings() -> View {
    store().view()
}

#[tauri::command]
pub fn web_set_enabled(enabled: bool) -> Result<View> {
    store().set_enabled(enabled)
}

#[tauri::command]
pub fn web_set_helpers(helpers: bool) -> Result<View> {
    store().set_helpers(helpers)
}

#[tauri::command]
pub fn web_set_provider(provider: Option<Provider>) -> Result<View> {
    store().set_provider(provider)
}

#[tauri::command]
pub fn web_set_key(provider: Provider, key: Option<String>) -> Result<View> {
    store().set_key(provider, key)
}

#[cfg(test)]
mod tests;
