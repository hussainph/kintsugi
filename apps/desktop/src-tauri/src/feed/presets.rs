//! Ways to subscribe: any feed or page URL, and presets for Hacker News
//! (hnrss.org), YouTube channels and podcasts. All of them end up as one
//! source polled by the ingest engine's feed adapter, which also does the
//! fetching parts (feed discovery, channel pages, iTunes Search).

use super::store::SourceKind;
use kintsugi_ingest::Url;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", rename_all_fields = "camelCase")]
pub enum Subscribe {
    /// A feed, or a page that links to one.
    Url { url: String },
    /// An hnrss.org list, optionally above a points threshold.
    Hn { list: String, points: Option<u32> },
    /// A channel URL, @handle, channel ID or playlist URL.
    Youtube { channel: String },
    /// A podcast feed, usually picked from `feed_podcast_search`.
    Podcast { feed_url: String, title: Option<String> },
}

pub const HN_LISTS: [&str; 5] = ["frontpage", "best", "newest", "show", "ask"];

pub fn hn_url(list: &str, points: Option<u32>) -> Result<String, String> {
    if !HN_LISTS.contains(&list) {
        return Err(format!("unknown Hacker News list “{list}”"));
    }
    Ok(match points.filter(|p| *p > 0) {
        Some(points) => format!("https://hnrss.org/{list}?points={points}"),
        None => format!("https://hnrss.org/{list}"),
    })
}

/// A YouTube input is either already a feed, or a page whose channel ID
/// has to be read from its HTML.
#[derive(Debug, PartialEq)]
pub enum Youtube {
    Feed(String),
    Page(String),
}

const YOUTUBE_FEED: &str = "https://www.youtube.com/feeds/videos.xml";

fn is_channel_id(value: &str) -> bool {
    value.len() == 24 && value.starts_with("UC") && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub(crate) fn youtube_feed(channel_id: &str) -> String {
    format!("{YOUTUBE_FEED}?channel_id={channel_id}")
}

pub fn youtube(input: &str) -> Result<Youtube, String> {
    let input = input.trim();
    if is_channel_id(input) {
        return Ok(Youtube::Feed(youtube_feed(input)));
    }
    if let Some(handle) = input.strip_prefix('@') {
        if handle.is_empty() || handle.contains(['/', '?', '#', ' ']) {
            return Err("that doesn't look like a YouTube handle".into());
        }
        return Ok(Youtube::Page(format!("https://www.youtube.com/@{handle}")));
    }
    let with_scheme = if input.contains("://") { input.to_string() } else { format!("https://{input}") };
    let url = Url::parse(&with_scheme).map_err(|_| "enter a YouTube channel URL, @handle or channel ID".to_string())?;
    let host = url.host_str().unwrap_or_default().trim_start_matches("www.").trim_start_matches("m.");
    if host != "youtube.com" {
        return Err("that isn't a YouTube URL".into());
    }
    if url.path() == "/feeds/videos.xml" {
        return Ok(Youtube::Feed(url.to_string()));
    }
    if let Some((_, list)) = url.query_pairs().find(|(k, _)| k == "list") {
        return Ok(Youtube::Feed(format!("{YOUTUBE_FEED}?playlist_id={list}")));
    }
    let mut segments = url.path_segments().into_iter().flatten().filter(|s| !s.is_empty());
    match (segments.next(), segments.next()) {
        (Some("channel"), Some(id)) if is_channel_id(id) => Ok(Youtube::Feed(youtube_feed(id))),
        (Some("user"), Some(user)) => Ok(Youtube::Feed(format!("{YOUTUBE_FEED}?user={user}"))),
        (Some(first), _) if first.starts_with('@') || first == "c" => Ok(Youtube::Page(url.to_string())),
        _ => Err("enter a YouTube channel URL, @handle or channel ID".into()),
    }
}

/// What kind of source a bare feed URL is, for OPML imports and URL subscribes.
pub fn kind_for_url(url: &str) -> SourceKind {
    let Ok(parsed) = Url::parse(url) else { return SourceKind::Feed };
    match parsed.host_str().unwrap_or_default().trim_start_matches("www.") {
        "hnrss.org" => SourceKind::Hn,
        "youtube.com" if parsed.path() == "/feeds/videos.xml" => SourceKind::Youtube,
        _ => SourceKind::Feed,
    }
}

/// Only plain HTTP(S) URLs without embedded credentials are followed.
pub fn checked_url(input: &str) -> Result<Url, String> {
    let input = input.trim();
    let with_scheme = if input.contains("://") { input.to_string() } else { format!("https://{input}") };
    let url = Url::parse(&with_scheme).map_err(|_| "that isn't a valid URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("only http and https feeds can be followed".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("feed URLs can't carry a username or password".into());
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hacker_news_lists() {
        assert_eq!(hn_url("frontpage", None).unwrap(), "https://hnrss.org/frontpage");
        assert_eq!(hn_url("best", Some(200)).unwrap(), "https://hnrss.org/best?points=200");
        assert!(hn_url("../etc", None).is_err());
    }

    #[test]
    fn youtube_inputs() {
        let feed = youtube_feed("UCabcdefghijklmnopqrstuv");
        assert_eq!(youtube("UCabcdefghijklmnopqrstuv").unwrap(), Youtube::Feed(feed.clone()));
        assert_eq!(youtube("https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv").unwrap(), Youtube::Feed(feed.clone()));
        assert_eq!(youtube("youtube.com/channel/UCabcdefghijklmnopqrstuv/videos").unwrap(), Youtube::Feed(feed));
        assert_eq!(youtube("@slowcraft").unwrap(), Youtube::Page("https://www.youtube.com/@slowcraft".into()));
        assert_eq!(youtube("https://www.youtube.com/@slowcraft/videos").unwrap(), Youtube::Page("https://www.youtube.com/@slowcraft/videos".into()));
        assert_eq!(
            youtube("https://www.youtube.com/playlist?list=PL123").unwrap(),
            Youtube::Feed("https://www.youtube.com/feeds/videos.xml?playlist_id=PL123".into())
        );
        assert!(youtube("https://vimeo.com/123").is_err());
    }

    #[test]
    fn urls() {
        assert_eq!(kind_for_url("https://hnrss.org/frontpage"), SourceKind::Hn);
        assert_eq!(kind_for_url(&youtube_feed("UCabcdefghijklmnopqrstuv")), SourceKind::Youtube);
        assert_eq!(kind_for_url("https://quiet.example/feed.xml"), SourceKind::Feed);
        assert_eq!(checked_url("quiet.example/feed").unwrap().as_str(), "https://quiet.example/feed");
        assert!(checked_url("file:///etc/passwd").is_err());
        assert!(checked_url("https://user:pw@example.com/feed").is_err());
    }
}
