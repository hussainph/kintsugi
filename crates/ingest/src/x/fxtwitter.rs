//! The FxTwitter API (<https://github.com/FxEmbed/FxEmbed>): free, keyless,
//! best-effort. `/2/thread/{id}` returns the post with its ancestors and the
//! author's continuation; `/2/status/{id}` just the post;
//! `/2/profile/{handle}/statuses` an account's latest posts.

use super::{Article, Author, Card, Post, PostMedia, PostMediaKind, ReplyTo, Stats, Thread, XApi};
use crate::api::ApiClient;
use crate::{BoxFuture, Error, Result};
use reqwest::Url;
use serde::Deserialize;
use std::sync::Arc;

pub struct FxTwitter {
    client: Arc<ApiClient>,
    base: Url,
}

impl FxTwitter {
    pub(crate) fn new(client: Arc<ApiClient>, base: Url) -> Self {
        Self { client, base }
    }

    async fn status(&self, kind: &str, id: &str) -> Result<StatusResponse> {
        let url = self.base.join(&format!("2/{kind}/{id}")).map_err(|_| Error::InvalidUrl)?;
        let body = self.client.get(url).await?;
        serde_json::from_slice(&body.bytes).map_err(|_| Error::Unavailable)
    }
}

impl XApi for FxTwitter {
    fn name(&self) -> &'static str {
        "fxtwitter"
    }

    fn thread<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Thread>> {
        Box::pin(async move {
            let (response, complete) = match self.status("thread", id).await {
                Ok(response) => (response, true),
                // Rate limits apply to the whole API; don't ask twice.
                Err(Error::RateLimited) => return Err(Error::RateLimited),
                Err(_) => (self.status("status", id).await?, false),
            };
            let thread = match response.thread {
                Some(thread) if !thread.is_empty() => thread,
                _ => response.status.into_iter().collect(),
            };
            let posts: Vec<Post> = thread.into_iter().map(Post::from).filter(|p| !p.id.is_empty()).collect();
            if posts.is_empty() {
                return Err(Error::Unavailable);
            }
            Ok(Thread { posts, complete })
        })
    }

    fn timeline<'a>(&'a self, handle: &'a str) -> BoxFuture<'a, Result<Vec<Post>>> {
        Box::pin(async move {
            let url = self.base.join(&format!("2/profile/{handle}/statuses")).map_err(|_| Error::InvalidUrl)?;
            let body = self.client.get(url).await?;
            let page: ProfileResponse = serde_json::from_slice(&body.bytes).map_err(|_| Error::Unavailable)?;
            Ok(page.results.into_iter().map(Post::from).filter(|p| !p.id.is_empty()).collect())
        })
    }
}

#[derive(Deserialize)]
struct StatusResponse {
    status: Option<FxStatus>,
    thread: Option<Vec<FxStatus>>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ProfileResponse {
    results: Vec<FxStatus>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct FxStatus {
    id: String,
    text: String,
    author: FxAuthor,
    created_timestamp: Option<i64>,
    lang: Option<String>,
    media: Option<FxMedia>,
    quote: Option<Box<FxStatus>>,
    card: Option<FxCard>,
    article: Option<FxArticle>,
    replying_to: Option<FxReply>,
    reposted_by: Option<FxAuthor>,
    likes: Option<u64>,
    reposts: Option<u64>,
    replies: Option<u64>,
    quotes: Option<u64>,
    views: Option<u64>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct FxAuthor {
    screen_name: String,
    name: Option<String>,
    avatar_url: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct FxMedia {
    all: Vec<FxMediaItem>,
    photos: Vec<FxMediaItem>,
    videos: Vec<FxMediaItem>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct FxMediaItem {
    #[serde(rename = "type")]
    kind: String,
    url: Option<String>,
    thumbnail_url: Option<String>,
    #[serde(rename = "altText")]
    alt_text: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct FxCard {
    url: Option<String>,
    title: Option<String>,
    description: Option<String>,
    image: Option<FxImage>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct FxImage {
    url: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct FxArticle {
    id: Option<String>,
    title: Option<String>,
    preview_text: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct FxReply {
    status: Option<String>,
    screen_name: Option<String>,
}

impl From<FxStatus> for Post {
    fn from(s: FxStatus) -> Self {
        let media = s.media.unwrap_or_default();
        let items = if media.all.is_empty() { media.photos.into_iter().chain(media.videos).collect() } else { media.all };
        Post {
            id: s.id,
            author: Author { name: s.author.name, handle: s.author.screen_name, avatar: s.author.avatar_url },
            text: s.text,
            created: s.created_timestamp.and_then(rfc3339),
            lang: s.lang,
            media: items.into_iter().filter_map(media_item).collect(),
            quote: s.quote.map(|q| Box::new(Post::from(*q))),
            card: s.card.and_then(|c| {
                Some(Card {
                    url: c.url?,
                    title: c.title,
                    description: c.description,
                    image: c.image.and_then(|i| i.url),
                })
            }),
            article: s.article.map(|a| Article { id: a.id, title: a.title, preview: a.preview_text }),
            replying_to: s
                .replying_to
                .and_then(|r| Some(ReplyTo { id: r.status?, handle: r.screen_name })),
            reposted_by: s.reposted_by.map(|a| a.screen_name),
            stats: Stats { likes: s.likes, reposts: s.reposts, replies: s.replies, quotes: s.quotes, views: s.views },
        }
    }
}

fn media_item(m: FxMediaItem) -> Option<PostMedia> {
    let kind = match m.kind.as_str() {
        "photo" => PostMediaKind::Photo,
        "video" => PostMediaKind::Video,
        "gif" | "animated_gif" => PostMediaKind::Gif,
        _ => return None,
    };
    Some(PostMedia { kind, url: m.url, preview: m.thumbnail_url, alt: m.alt_text })
}

pub(crate) fn rfc3339(seconds: i64) -> Option<String> {
    chrono::DateTime::from_timestamp(seconds, 0).map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
}
