//! X's public syndication endpoint (what embedded posts load): the post, its
//! parent and its quoted post, without the rest of the thread.

use super::{Author, Card, Post, PostMedia, PostMediaKind, ReplyTo, Stats, Thread};
use crate::api::ApiClient;
use crate::{Error, Result};
use reqwest::Url;
use serde::Deserialize;

pub(crate) async fn thread(client: &ApiClient, base: &Url, id: &str) -> Result<Thread> {
    let mut url = base.join("tweet-result").map_err(|_| Error::InvalidUrl)?;
    url.query_pairs_mut().append_pair("id", id).append_pair("lang", "en").append_pair("token", &token(id));
    let body = client.get(url).await?;
    let tweet: Tweet = serde_json::from_slice(&body.bytes).map_err(|_| Error::Unavailable)?;
    if tweet.id_str.is_empty() || tweet.typename.as_deref() == Some("TweetTombstone") {
        return Err(Error::Unavailable);
    }
    let mut posts = Vec::new();
    let mut tweet = tweet;
    if let Some(parent) = tweet.parent.take()
        && !parent.id_str.is_empty()
    {
        posts.push(Post::from(*parent));
    }
    posts.push(Post::from(tweet));
    Ok(Thread { posts, complete: false })
}

/// The token embeds compute: `(id / 1e15 * π)` in base 36 without zeros or
/// the point. The endpoint is lenient about its exact tail.
pub(crate) fn token(id: &str) -> String {
    let n = id.parse::<f64>().unwrap_or(0.0) / 1e15 * std::f64::consts::PI;
    let digit = |d: u32| char::from_digit(d, 36).unwrap_or('0');
    let mut int = n.trunc() as u64;
    let mut whole = Vec::new();
    while int > 0 {
        whole.push(digit((int % 36) as u32));
        int /= 36;
    }
    whole.reverse();
    let mut fraction = n.fract();
    for _ in 0..11 {
        fraction *= 36.0;
        let d = fraction.trunc();
        whole.push(digit(d as u32));
        fraction -= d;
    }
    whole.into_iter().filter(|&c| c != '0').collect()
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Tweet {
    #[serde(rename = "__typename")]
    typename: Option<String>,
    id_str: String,
    text: String,
    display_text_range: Option<(usize, usize)>,
    entities: Entities,
    user: User,
    created_at: Option<String>,
    lang: Option<String>,
    #[serde(rename = "mediaDetails")]
    media_details: Vec<MediaDetail>,
    quoted_tweet: Option<Box<Tweet>>,
    parent: Option<Box<Tweet>>,
    in_reply_to_status_id_str: Option<String>,
    in_reply_to_screen_name: Option<String>,
    favorite_count: Option<u64>,
    conversation_count: Option<u64>,
    reply_count: Option<u64>,
    retweet_count: Option<u64>,
    card: Option<SynCard>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Entities {
    urls: Vec<UrlEntity>,
    media: Vec<UrlEntity>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct UrlEntity {
    url: String,
    expanded_url: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct User {
    name: Option<String>,
    screen_name: String,
    profile_image_url_https: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct MediaDetail {
    #[serde(rename = "type")]
    kind: String,
    media_url_https: Option<String>,
    ext_alt_text: Option<String>,
    video_info: Option<VideoInfo>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct VideoInfo {
    variants: Vec<Variant>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Variant {
    content_type: Option<String>,
    url: Option<String>,
    bitrate: Option<u64>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct SynCard {
    binding_values: serde_json::Value,
}

impl From<Tweet> for Post {
    fn from(t: Tweet) -> Self {
        let mut text = match t.display_text_range {
            Some((start, end)) if start <= end => t.text.chars().skip(start).take(end - start).collect(),
            _ => t.text.clone(),
        };
        for entity in &t.entities.urls {
            if !entity.url.is_empty() {
                text = text.replace(&entity.url, entity.expanded_url.as_deref().unwrap_or(&entity.url));
            }
        }
        for entity in &t.entities.media {
            if !entity.url.is_empty() {
                text = text.replace(&entity.url, "");
            }
        }
        let text = text.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&");
        let media = t.media_details.into_iter().filter_map(media_item).collect();
        Post {
            id: t.id_str,
            author: Author { name: t.user.name, handle: t.user.screen_name, avatar: t.user.profile_image_url_https },
            text: text.trim().to_string(),
            created: t.created_at,
            lang: t.lang,
            media,
            quote: t.quoted_tweet.filter(|q| !q.id_str.is_empty()).map(|q| Box::new(Post::from(*q))),
            card: t.card.and_then(card),
            article: None,
            replying_to: t.in_reply_to_status_id_str.map(|id| ReplyTo { id, handle: t.in_reply_to_screen_name }),
            reposted_by: None,
            stats: Stats {
                likes: t.favorite_count,
                reposts: t.retweet_count,
                replies: t.reply_count.or(t.conversation_count),
                quotes: None,
                views: None,
            },
        }
    }
}

fn media_item(m: MediaDetail) -> Option<PostMedia> {
    let kind = match m.kind.as_str() {
        "photo" => PostMediaKind::Photo,
        "video" => PostMediaKind::Video,
        "animated_gif" => PostMediaKind::Gif,
        _ => return None,
    };
    let still = m.media_url_https;
    if kind == PostMediaKind::Photo {
        return Some(PostMedia { kind, url: still, preview: None, alt: m.ext_alt_text });
    }
    let video = m
        .video_info
        .unwrap_or_default()
        .variants
        .into_iter()
        .filter(|v| v.content_type.as_deref() == Some("video/mp4"))
        .max_by_key(|v| v.bitrate.unwrap_or(0))
        .and_then(|v| v.url);
    Some(PostMedia { kind, url: video, preview: still, alt: m.ext_alt_text })
}

/// Link cards carry their fields as `binding_values.<name>.string_value`.
fn card(c: SynCard) -> Option<Card> {
    let value = |name: &str| c.binding_values.get(name)?.get("string_value")?.as_str().map(str::to_string);
    let image = c
        .binding_values
        .get("thumbnail_image_large")
        .or_else(|| c.binding_values.get("summary_photo_image_large"))
        .and_then(|v| v.get("image_value")?.get("url")?.as_str())
        .map(str::to_string);
    Some(Card { url: value("card_url")?, title: value("title"), description: value("description"), image })
}
