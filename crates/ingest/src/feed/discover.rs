//! Finding feeds: the ones a page advertises, a YouTube channel's, and
//! podcasts from iTunes Search.

use crate::{Error, Result, web::allowed_url};
use dom_query::Document;
use reqwest::Url;
use serde::{Deserialize, Serialize};

/// Feed links a page advertises with `<link rel="alternate">`, resolved
/// against the page URL. Only credential-free HTTP(S).
pub fn feed_links(html: &str, base: &Url) -> Vec<Url> {
    let doc = Document::from(html);
    let mut found = Vec::new();
    for link in doc.select(r#"link[rel~="alternate"][href]"#).iter() {
        let kind = link.attr("type").map(|t| t.to_ascii_lowercase()).unwrap_or_default();
        if !(kind.contains("rss") || kind.contains("atom") || kind.contains("feed+json") || kind == "application/json") {
            continue;
        }
        if let Some(url) = link.attr("href").and_then(|h| base.join(&h).ok()).filter(allowed_url)
            && !found.contains(&url)
        {
            found.push(url);
        }
    }
    found
}

fn is_channel_id(value: &str) -> bool {
    value.len() == 24 && value.starts_with("UC") && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The channel ID in a YouTube channel page: its canonical link or metadata,
/// or the page data.
pub fn channel_id(html: &str) -> Option<String> {
    let doc = Document::from(html);
    for element in doc.select(r#"link[rel="canonical"], meta[itemprop="channelId"], meta[itemprop="identifier"]"#).iter() {
        let value = element.attr("href").or_else(|| element.attr("content")).map(|v| v.to_string()).unwrap_or_default();
        let id = value.rsplit('/').next().unwrap_or_default();
        if is_channel_id(id) {
            return Some(id.to_string());
        }
    }
    for marker in ["\"externalId\":\"", "\"channelId\":\""] {
        if let Some(at) = html.find(marker) {
            let id: String = html[at + marker.len()..].chars().take(24).collect();
            if is_channel_id(&id) {
                return Some(id);
            }
        }
    }
    None
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Podcast {
    pub title: String,
    pub author: Option<String>,
    pub feed_url: String,
    pub artwork: Option<String>,
    pub url: Option<String>,
}

/// iTunes Search results that have a public feed; shows without one can't
/// be followed.
pub fn podcasts(json: &[u8]) -> Result<Vec<Podcast>> {
    #[derive(Deserialize)]
    struct Results {
        results: Vec<Found>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Found {
        collection_name: Option<String>,
        artist_name: Option<String>,
        feed_url: Option<String>,
        artwork_url600: Option<String>,
        artwork_url100: Option<String>,
        collection_view_url: Option<String>,
    }
    let parsed: Results = serde_json::from_slice(json).map_err(|_| Error::Unavailable)?;
    let web = |u: &String| Url::parse(u).ok().is_some_and(|u| allowed_url(&u));
    Ok(parsed
        .results
        .into_iter()
        .filter_map(|r| {
            let feed_url = r.feed_url.filter(web)?;
            Some(Podcast {
                title: r.collection_name.unwrap_or_else(|| feed_url.clone()),
                author: r.artist_name,
                feed_url,
                artwork: r.artwork_url600.or(r.artwork_url100).filter(web),
                url: r.collection_view_url.filter(web),
            })
        })
        .collect())
}
