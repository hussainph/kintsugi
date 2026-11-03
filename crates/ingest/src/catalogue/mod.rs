//! Metadata-only back-catalogue discovery. Reads feeds, archive indexes and
//! sitemaps, never individual articles, images, scripts or rendered pages.
//! Results are best effort: a report keeps entries even if another index fails.

mod parse;
mod robots;
#[cfg(test)]
mod tests;

use crate::{
    Error, Result, Url,
    web::{allowed_url, canonical_url},
};
use futures_util::StreamExt;
use reqwest::{Client, StatusCode};
use robots::Robots;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::Arc,
    time::Duration,
};
use tokio::{sync::Mutex, time::Instant};

/// No article body is carried or fetched by discovery. Dates are RFC 3339
/// when the source declares a publication date; sitemap lastmod is NOT one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub url: String,
    pub title: String,
    pub published_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub url: String,
    /// Fixed error text, never a server response body.
    pub error: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub entries: Vec<Entry>,
    /// Index documents attempted, excluding robots.txt and redirect hops.
    pub pages_fetched: usize,
    /// A page, entry, byte or time bound stopped discovery. This is not a
    /// claim that the source has no more writing when false.
    pub truncated: bool,
    pub issues: Vec<Issue>,
}

#[derive(Clone, Debug)]
pub struct Progress {
    pub pages_fetched: usize,
    pub entries_found: usize,
}

#[derive(Clone, Debug)]
pub struct Limits {
    pub max_pages: usize,
    pub max_entries: usize,
    pub page_bytes: usize,
    /// Includes robots, redirects and compressed AND decompressed bytes.
    pub total_bytes: usize,
    pub request_timeout: Duration,
    pub deadline: Duration,
    pub min_interval: Duration,
    pub max_redirects: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_pages: 40,
            max_entries: 5_000,
            page_bytes: 8 * 1024 * 1024,
            total_bytes: 32 * 1024 * 1024,
            request_timeout: Duration::from_secs(25),
            deadline: Duration::from_secs(180),
            min_interval: Duration::from_secs(1),
            max_redirects: 5,
        }
    }
}

type Callback = Arc<dyn Fn(&Progress) + Send + Sync>;

/// Reuse one instance: concurrent discoveries share per-origin rate limits.
/// Scope is the explicit feed/site hosts (plus their www aliases), not every
/// host an untrusted index mentions. Uses the feed adapter's HTTP URL policy.
pub struct Catalogue {
    client: Client,
    limits: Limits,
    next_request: Mutex<HashMap<String, (Instant, Duration)>>,
    progress: Option<Callback>,
}

#[derive(Clone, Copy)]
enum Kind {
    Feed,
    Index,
    Sitemap,
}
struct Job {
    url: Url,
    kind: Kind,
}
pub(super) struct Parsed {
    entries: Vec<Entry>,
    links: Vec<(Url, Kind)>,
}
struct Body {
    bytes: Vec<u8>,
    url: Url,
}
struct Run<'a> {
    catalogue: &'a Catalogue,
    scope: Vec<Url>,
    robots: HashMap<String, Robots>,
    bytes: usize,
    report: Report,
}

impl Catalogue {
    pub fn new() -> Result<Self> {
        Self::with_limits(Limits::default())
    }

    pub fn with_limits(limits: Limits) -> Result<Self> {
        let client = Client::builder()
            .user_agent(concat!(
                "Kintsugi/",
                env!("CARGO_PKG_VERSION"),
                " (feed catalogue; +https://github.com/hussainph/kintsugi)"
            ))
            .connect_timeout(Duration::from_secs(10))
            .timeout(limits.request_timeout)
            // Redirects are manual so EACH destination checks robots and pace.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| Error::Setup)?;
        Ok(Self {
            client,
            limits,
            next_request: Mutex::new(HashMap::new()),
            progress: None,
        })
    }

    pub fn with_progress(mut self, callback: impl Fn(&Progress) + Send + Sync + 'static) -> Self {
        self.progress = Some(Arc::new(callback));
        self
    }

    /// Only invalid input/setup fails the call. Network and parsing failures
    /// are in `report.issues`; partial entries survive the overall deadline.
    /// Dropping this future cancels discovery, with no detached requests.
    pub async fn discover(&self, feed_url: &Url, site_url: Option<&Url>) -> Result<Report> {
        if !allowed_url(feed_url) || site_url.is_some_and(|u| !allowed_url(u)) {
            return Err(Error::InvalidUrl);
        }
        let mut scope = vec![feed_url.clone()];
        if let Some(site) = site_url {
            scope.push(site.clone());
        }
        let mut run = Run {
            catalogue: self,
            scope,
            robots: HashMap::new(),
            bytes: 0,
            report: Report::default(),
        };
        if tokio::time::timeout(self.limits.deadline, run.walk(feed_url, site_url))
            .await
            .is_err()
        {
            run.report.truncated = true;
            run.issue(feed_url, Error::TimedOut.to_string());
        }
        Ok(run.report)
    }

    async fn pace(&self, url: &Url, interval: Duration) {
        // Reserve the next slot under a short lock; never hold it during I/O.
        let when = {
            let mut slots = self.next_request.lock().await;
            let now = Instant::now();
            let previous = slots.get(&origin(url)).copied();
            let interval = interval.max(previous.map(|(_, delay)| delay).unwrap_or_default());
            let when = previous
                .map(|(last, _)| last + interval)
                .unwrap_or(now)
                .max(now);
            slots.insert(origin(url), (when, interval));
            when
        };
        tokio::time::sleep_until(when).await;
    }
}

impl Run<'_> {
    fn issue(&mut self, url: &Url, error: String) {
        self.report.issues.push(Issue {
            url: url.to_string(),
            error,
        });
    }

    fn in_scope(&self, url: &Url) -> bool {
        allowed_url(url)
            && self.scope.iter().any(|base| {
                let bare = |u: &Url| {
                    u.host_str()
                        .unwrap_or("")
                        .trim_start_matches("www.")
                        .to_string()
                };
                bare(url) == bare(base)
                    && (url.port_or_known_default() == base.port_or_known_default()
                        || (base.port().is_none() && url.port().is_none()))
            })
    }

    async fn walk(&mut self, feed: &Url, site: Option<&Url>) {
        let mut queue = VecDeque::from([Job {
            url: canonical_url(feed),
            kind: Kind::Feed,
        }]);
        let site = site.cloned().unwrap_or_else(|| feed.join("/").unwrap());
        queue.push_back(Job {
            url: canonical_url(&site),
            kind: Kind::Index,
        });
        // Generic fallback, after links actually advertised by the source.
        let mut fallback = VecDeque::new();
        for path in [
            "sitemap.xml",
            "sitemap_index.xml",
            "archives/",
            "archive/",
            "articles.html",
        ] {
            if let Ok(url) = site.join(path) {
                fallback.push_back(Job {
                    url,
                    kind: if path.contains("xml") {
                        Kind::Sitemap
                    } else {
                        Kind::Index
                    },
                });
            }
        }
        let mut seen = HashSet::new();
        let mut entries = HashMap::<String, usize>::new();
        loop {
            let Some(job) = queue.pop_front().or_else(|| fallback.pop_front()) else {
                break;
            };
            if !self.in_scope(&job.url) || !seen.insert(job.url.to_string()) {
                continue;
            }
            if self.report.pages_fetched >= self.catalogue.limits.max_pages {
                self.report.truncated = true;
                break;
            }
            self.report.pages_fetched += 1;
            match self.get(&job.url).await {
                Ok(body) => {
                    // Redirect loops and aliases cannot re-crawl a whole index.
                    seen.insert(body.url.to_string());
                    match parse::document(&body.bytes, &body.url, job.kind) {
                        Some(parsed) => {
                            for entry in parsed.entries {
                                let Ok(url) = Url::parse(&entry.url) else {
                                    continue;
                                };
                                if !self.in_scope(&url) {
                                    continue;
                                }
                                if let Some(&at) = entries.get(&entry.url) {
                                    let old = &mut self.report.entries[at];
                                    if old.published_at.is_none() {
                                        old.published_at = entry.published_at;
                                    }
                                    if old.title == parse::url_title(&url) {
                                        old.title = entry.title;
                                    }
                                    continue;
                                }
                                if self.report.entries.len() >= self.catalogue.limits.max_entries {
                                    self.report.truncated = true;
                                    break;
                                }
                                entries.insert(entry.url.clone(), self.report.entries.len());
                                self.report.entries.push(entry);
                            }
                            // Keep the queue bounded even for huge sitemap indexes.
                            for (url, kind) in parsed.links {
                                if self.in_scope(&url) && !seen.contains(url.as_str()) {
                                    if queue.len() >= self.catalogue.limits.max_pages {
                                        self.report.truncated = true;
                                        break;
                                    }
                                    queue.push_back(Job { url, kind });
                                }
                            }
                        }
                        None => self.issue(&body.url, Error::NotAFeed.to_string()),
                    }
                }
                Err(error) => {
                    if error == Error::TooLarge {
                        self.report.truncated = true;
                    }
                    self.issue(&job.url, error.to_string());
                }
            }
            // robots.txt can advertise a sitemap not at a conventional path.
            for robot in self.robots.values() {
                for url in &robot.sitemaps {
                    if self.in_scope(url)
                        && !seen.contains(url.as_str())
                        && queue.len() < self.catalogue.limits.max_pages
                        && !queue.iter().any(|j| j.url == *url)
                    {
                        queue.push_back(Job {
                            url: url.clone(),
                            kind: Kind::Sitemap,
                        });
                    }
                }
            }
            if let Some(progress) = &self.catalogue.progress {
                progress(&Progress {
                    pages_fetched: self.report.pages_fetched,
                    entries_found: self.report.entries.len(),
                });
            }
            if self.report.entries.len() >= self.catalogue.limits.max_entries
                || self.bytes >= self.catalogue.limits.total_bytes
            {
                self.report.truncated = true;
                break;
            }
        }
    }

    async fn get(&mut self, start: &Url) -> Result<Body> {
        let mut url = start.clone();
        for hop in 0..=self.catalogue.limits.max_redirects {
            if !self.in_scope(&url) {
                return Err(Error::InvalidUrl);
            }
            let key = origin(&url);
            if !self.robots.contains_key(&key) {
                let policy = self.load_robots(&url).await;
                self.robots.insert(key.clone(), policy);
            }
            let robot = &self.robots[&key];
            if !robot.allows(&url) {
                return Err(Error::Status(403));
            }
            let delay = self.catalogue.limits.min_interval.max(robot.delay);
            let response = self.request(&url, delay).await?;
            if response.status().is_redirection() {
                if hop == self.catalogue.limits.max_redirects {
                    return Err(Error::Unavailable);
                }
                url = redirect(&response, &url)?;
            } else {
                if !response.status().is_success() {
                    if response.status() == StatusCode::TOO_MANY_REQUESTS {
                        // Do not probe fallback paths after a rate limit.
                        self.robots.insert(key, Robots::deny());
                    }
                    return Err(Error::Status(response.status().as_u16()));
                }
                return Ok(Body {
                    bytes: self
                        .body(response, self.catalogue.limits.page_bytes)
                        .await?,
                    url,
                });
            }
        }
        Err(Error::Unavailable)
    }

    async fn load_robots(&mut self, page: &Url) -> Robots {
        let mut url = page.join("/robots.txt").unwrap();
        for hop in 0..=self.catalogue.limits.max_redirects {
            let response = match self.request(&url, self.catalogue.limits.min_interval).await {
                Ok(r) => r,
                Err(e) => {
                    self.issue(&url, e.to_string());
                    return Robots::deny();
                }
            };
            if response.status().is_redirection() {
                // Never borrow another origin's policy or bypass its robots.
                let Ok(next) = redirect(&response, &url) else {
                    return Robots::deny();
                };
                if hop == self.catalogue.limits.max_redirects || origin(&next) != origin(page) {
                    return Robots::deny();
                }
                url = next;
                continue;
            }
            return match response.status() {
                StatusCode::NOT_FOUND | StatusCode::GONE => Robots::default(),
                s if s.is_success() => match self.body(response, 512 * 1024).await {
                    Ok(bytes) => Robots::parse(&String::from_utf8_lossy(&bytes), page),
                    Err(e) => {
                        self.issue(&url, e.to_string());
                        Robots::deny()
                    }
                },
                s => {
                    self.issue(&url, Error::Status(s.as_u16()).to_string());
                    Robots::deny()
                }
            };
        }
        Robots::deny()
    }

    async fn request(&mut self, url: &Url, delay: Duration) -> Result<reqwest::Response> {
        if !allowed_url(url) {
            return Err(Error::InvalidUrl);
        }
        if self.bytes >= self.catalogue.limits.total_bytes {
            return Err(Error::TooLarge);
        }
        self.catalogue.pace(url, delay).await;
        self.catalogue
            .client
            .get(url.clone())
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    Error::TimedOut
                } else {
                    Error::Unavailable
                }
            })
    }

    async fn body(&mut self, response: reqwest::Response, limit: usize) -> Result<Vec<u8>> {
        let limit = limit.min(self.catalogue.limits.total_bytes.saturating_sub(self.bytes));
        if response.content_length().is_some_and(|n| n > limit as u64) {
            self.report.truncated = true;
            return Err(Error::TooLarge);
        }
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| {
                if e.is_timeout() {
                    Error::TimedOut
                } else {
                    Error::Unavailable
                }
            })?;
            self.bytes = self.bytes.saturating_add(chunk.len());
            if chunk.len() > limit.saturating_sub(bytes.len()) {
                self.report.truncated = true;
                return Err(Error::TooLarge);
            }
            bytes.extend_from_slice(&chunk);
        }
        // Some publishers advertise gzip sitemaps. Limit expansion separately.
        if bytes.starts_with(&[0x1f, 0x8b]) {
            use std::io::Read;
            let mut plain = Vec::new();
            flate2::read::GzDecoder::new(bytes.as_slice())
                .take(limit as u64 + 1)
                .read_to_end(&mut plain)
                .map_err(|_| Error::Unavailable)?;
            self.bytes = self.bytes.saturating_add(plain.len());
            if plain.len() > limit || self.bytes > self.catalogue.limits.total_bytes {
                self.report.truncated = true;
                return Err(Error::TooLarge);
            }
            return Ok(plain);
        }
        Ok(bytes)
    }
}

fn origin(url: &Url) -> String {
    url.origin().ascii_serialization()
}
fn redirect(response: &reqwest::Response, url: &Url) -> Result<Url> {
    response
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| url.join(h).ok())
        .filter(allowed_url)
        .map(|u| canonical_url(&u))
        .ok_or(Error::InvalidUrl)
}
