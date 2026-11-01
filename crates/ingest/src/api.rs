//! A polite, bounded HTTP client for the JSON APIs behind the platform
//! adapters (FxTwitter, X's syndication and oEmbed endpoints, Reddit).
//!
//! - Requests to the API are spaced at least `min_interval` apart.
//! - A `429` (or a `x-ratelimit-remaining: 0` header) blocks that host until
//!   its `Retry-After` / `x-ratelimit-reset` passes, bounded to an hour; until
//!   then calls fail fast with [`Error::RateLimited`] and send nothing.
//! - Redirects (at most 5) are re-checked against the web URL policy, and
//!   every body is size-capped while it streams.
//!
//! No cookies, tokens or passwords are ever sent.

use crate::web::allowed_url;
use crate::{Error, Result};
use futures_util::StreamExt;
use reqwest::{Client, Response, StatusCode, Url, header::HeaderMap};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tokio::time::Instant;

/// Caps and pacing for one platform adapter.
#[derive(Debug, Clone)]
pub struct ApiLimits {
    /// The largest JSON (or embed HTML) body accepted.
    pub json_bytes: usize,
    pub image_bytes: usize,
    pub connect_timeout: Duration,
    pub request_timeout: Duration,
    /// Covers a whole capture or poll, including waiting for a polite slot.
    pub deadline: Duration,
    /// The least time between two API requests from this adapter.
    pub min_interval: Duration,
}

impl Default for ApiLimits {
    fn default() -> Self {
        Self {
            json_bytes: 2 * 1024 * 1024,
            image_bytes: 8 * 1024 * 1024,
            connect_timeout: Duration::from_secs(5),
            request_timeout: Duration::from_secs(15),
            deadline: Duration::from_secs(45),
            min_interval: Duration::from_secs(1),
        }
    }
}

/// The longest a rate limit is honoured for; a hostile header can't park the
/// adapter forever.
const MAX_BLOCK: Duration = Duration::from_secs(60 * 60);
/// When a 429 carries no usable hint.
const DEFAULT_BLOCK: Duration = Duration::from_secs(60);

pub(crate) struct ApiClient {
    client: Client,
    /// Follows no redirects, to read where a share link points.
    direct: Client,
    pub(crate) limits: ApiLimits,
    next_slot: Mutex<Option<Instant>>,
    blocked: Mutex<HashMap<String, Instant>>,
}

pub(crate) struct Body {
    pub bytes: Vec<u8>,
}

impl ApiClient {
    pub fn new(user_agent: &str, limits: ApiLimits) -> Result<Self> {
        let direct = Client::builder()
            .user_agent(user_agent)
            .connect_timeout(limits.connect_timeout)
            .timeout(limits.request_timeout)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| Error::Setup)?;
        let client = Client::builder()
            .user_agent(user_agent)
            .connect_timeout(limits.connect_timeout)
            .timeout(limits.request_timeout)
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= 5 || !allowed_url(attempt.url()) {
                    attempt.error("unsupported redirect")
                } else {
                    attempt.follow()
                }
            }))
            .build()
            .map_err(|_| Error::Setup)?;
        Ok(Self { client, direct, limits, next_slot: Mutex::new(None), blocked: Mutex::new(HashMap::new()) })
    }

    /// An API request: waits for its polite slot, honours rate limits, and
    /// fails on any non-success status.
    pub async fn get(&self, url: Url) -> Result<Body> {
        let response = self.send(url).await?;
        if !response.status().is_success() {
            return Err(Error::Unavailable);
        }
        read(response, self.limits.json_bytes).await
    }

    /// Where a redirect at `url` points, without following it (the target
    /// may be a page that refuses bots). Paced like an API request.
    pub async fn location(&self, url: Url) -> Result<Option<Url>> {
        let response = self.send_with(&self.direct, url.clone()).await?;
        if !response.status().is_redirection() {
            return Ok(None);
        }
        let target = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| url.join(v).ok())
            .filter(allowed_url);
        Ok(target)
    }

    /// A media download from a CDN: not paced like the API, but still bounded.
    pub async fn media(&self, url: Url) -> Result<Vec<u8>> {
        if !allowed_url(&url) {
            return Err(Error::InvalidUrl);
        }
        let response = self.client.get(url).send().await.map_err(|_| Error::Unavailable)?;
        if !response.status().is_success() {
            return Err(Error::Unavailable);
        }
        Ok(read(response, self.limits.image_bytes).await?.bytes)
    }

    async fn send(&self, url: Url) -> Result<Response> {
        self.send_with(&self.client, url).await
    }

    async fn send_with(&self, client: &Client, url: Url) -> Result<Response> {
        if !allowed_url(&url) {
            return Err(Error::InvalidUrl);
        }
        let host = url.host_str().unwrap_or_default().to_string();
        if self.blocked_until(&host).is_some() {
            return Err(Error::RateLimited);
        }
        tokio::time::sleep_until(self.slot()).await;
        let response = client.get(url).send().await.map_err(|_| Error::Unavailable)?;
        let now = Instant::now();
        if let Some(wait) = block_for(response.status(), response.headers()) {
            self.blocked.lock().unwrap().insert(host, now + wait);
            if response.status() == StatusCode::TOO_MANY_REQUESTS {
                return Err(Error::RateLimited);
            }
        }
        Ok(response)
    }

    /// Reserves the next request slot and returns when it starts.
    fn slot(&self) -> Instant {
        let mut next = self.next_slot.lock().unwrap();
        let now = Instant::now();
        let start = next.map_or(now, |at| at.max(now));
        *next = Some(start + self.limits.min_interval);
        start
    }

    fn blocked_until(&self, host: &str) -> Option<Instant> {
        let mut blocked = self.blocked.lock().unwrap();
        match blocked.get(host) {
            Some(&until) if until > Instant::now() => Some(until),
            Some(_) => {
                blocked.remove(host);
                None
            }
            None => None,
        }
    }
}

/// How long a response says to stay away, if at all.
fn block_for(status: StatusCode, headers: &HeaderMap) -> Option<Duration> {
    let seconds = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<f64>().ok())
            .filter(|n| n.is_finite() && *n >= 0.0)
    };
    let bounded = |s: f64| Duration::from_secs_f64(s.min(MAX_BLOCK.as_secs_f64()));
    if status == StatusCode::TOO_MANY_REQUESTS {
        return Some(seconds("retry-after").or_else(|| seconds("x-ratelimit-reset")).map_or(DEFAULT_BLOCK, bounded));
    }
    // Reddit announces an exhausted budget before refusing.
    if seconds("x-ratelimit-remaining").is_some_and(|n| n < 1.0) {
        return Some(seconds("x-ratelimit-reset").map_or(DEFAULT_BLOCK, bounded));
    }
    None
}

async fn read(response: Response, limit: usize) -> Result<Body> {
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err(Error::TooLarge);
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| Error::Unavailable)?;
        if chunk.len() > limit.saturating_sub(bytes.len()) {
            return Err(Error::TooLarge);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(Body { bytes })
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::HeaderValue;

    fn headers(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (k, v) in pairs {
            map.insert(*k, HeaderValue::from_static(v));
        }
        map
    }

    #[test]
    fn rate_limit_hints_are_honoured_and_bounded() {
        let tmr = StatusCode::TOO_MANY_REQUESTS;
        assert_eq!(block_for(tmr, &headers(&[("retry-after", "30")])), Some(Duration::from_secs(30)));
        assert_eq!(block_for(tmr, &headers(&[])), Some(DEFAULT_BLOCK));
        assert_eq!(block_for(tmr, &headers(&[("retry-after", "99999999")])), Some(MAX_BLOCK));
        assert_eq!(block_for(tmr, &headers(&[("retry-after", "soon")])), Some(DEFAULT_BLOCK));
        let ok = StatusCode::OK;
        assert_eq!(
            block_for(ok, &headers(&[("x-ratelimit-remaining", "0.0"), ("x-ratelimit-reset", "12")])),
            Some(Duration::from_secs(12))
        );
        assert_eq!(block_for(ok, &headers(&[("x-ratelimit-remaining", "57.0")])), None);
        assert_eq!(block_for(ok, &headers(&[])), None);
    }

    #[test]
    fn requests_are_spaced_by_the_minimum_interval() {
        let client =
            ApiClient::new("test", ApiLimits { min_interval: Duration::from_secs(2), ..ApiLimits::default() }).unwrap();
        let first = client.slot();
        let second = client.slot();
        assert_eq!(second - first, Duration::from_secs(2));
    }
}
