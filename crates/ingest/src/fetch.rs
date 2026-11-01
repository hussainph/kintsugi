//! Bounded downloads for the transcript adapters: thumbnails, publisher
//! transcripts and podcast audio. The same URL policy as web pages applies
//! to every request and redirect.

use crate::web::allowed_url;
use crate::{Error, Result};
use futures_util::StreamExt;
use reqwest::{Client, Url};
use std::io::Write;
use std::path::Path;
use std::time::Duration;

pub(crate) struct Fetcher {
    client: Client,
}

pub(crate) struct Fetched {
    pub bytes: Vec<u8>,
    pub mime: String,
}

impl Fetcher {
    pub fn new() -> Result<Self> {
        let client = Client::builder()
            .user_agent(concat!("Kintsugi/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(10))
            .read_timeout(Duration::from_secs(60))
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= 10 || !allowed_url(attempt.url()) {
                    attempt.error("unsupported redirect")
                } else {
                    attempt.follow()
                }
            }))
            .build()
            .map_err(|_| Error::Setup)?;
        Ok(Self { client })
    }

    async fn send(&self, url: &Url, limit: u64) -> Result<reqwest::Response> {
        if !allowed_url(url) {
            return Err(Error::InvalidUrl);
        }
        let response = self.client.get(url.clone()).send().await.map_err(|_| Error::Unavailable)?;
        if !response.status().is_success() {
            return Err(Error::Unavailable);
        }
        if response.content_length().is_some_and(|n| n > limit) {
            return Err(Error::TooLarge);
        }
        Ok(response)
    }

    /// The whole body in memory, at most `limit` bytes.
    pub async fn bytes(&self, url: &Url, limit: u64) -> Result<Fetched> {
        let response = self.send(url, limit).await?;
        let mime = mime_of(&response);
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| Error::Unavailable)?;
            if bytes.len() as u64 + chunk.len() as u64 > limit {
                return Err(Error::TooLarge);
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(Fetched { bytes, mime })
    }

    /// Streams the body to `path`, at most `limit` bytes. Returns the MIME type.
    pub async fn to_file(&self, url: &Url, limit: u64, path: &Path) -> Result<String> {
        let response = self.send(url, limit).await?;
        let mime = mime_of(&response);
        let mut file = std::fs::File::create(path).map_err(|_| Error::Setup)?;
        let mut written = 0u64;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| Error::Unavailable)?;
            written += chunk.len() as u64;
            if written > limit {
                return Err(Error::TooLarge);
            }
            file.write_all(&chunk).map_err(|_| Error::Setup)?;
        }
        Ok(mime)
    }
}

fn mime_of(response: &reqwest::Response) -> String {
    response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}
