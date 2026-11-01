//! X's oEmbed endpoint, the last resort: the post's text and author only.

use super::{Author, Post};
use crate::api::ApiClient;
use crate::{Error, Result};
use dom_query::Document;
use reqwest::Url;
use serde::Deserialize;

#[derive(Deserialize, Default)]
#[serde(default)]
struct Embed {
    author_name: Option<String>,
    author_url: Option<String>,
    html: Option<String>,
}

pub(crate) async fn post(client: &ApiClient, base: &Url, url: &Url, id: &str) -> Result<Post> {
    let mut endpoint = base.join("oembed").map_err(|_| Error::InvalidUrl)?;
    // Always ask about the canonical x.com form: mirrors aren't X's to embed.
    let handle = url.path_segments().and_then(|mut s| s.next()).filter(|h| super::valid_handle(h) && *h != "i");
    let canonical = format!("https://x.com/{}/status/{id}", handle.unwrap_or("i"));
    endpoint
        .query_pairs_mut()
        .append_pair("url", &canonical)
        .append_pair("omit_script", "true")
        .append_pair("dnt", "true");
    let body = client.get(endpoint).await?;
    let embed: Embed = serde_json::from_slice(&body.bytes).map_err(|_| Error::Unavailable)?;
    let text = embed.html.as_deref().map(post_text).unwrap_or_default();
    let handle = embed
        .author_url
        .as_deref()
        .and_then(super::profile_handle)
        .or_else(|| handle.map(str::to_ascii_lowercase))
        .ok_or(Error::Unavailable)?;
    if text.is_empty() {
        return Err(Error::Unavailable);
    }
    Ok(Post { id: id.to_string(), author: Author { name: embed.author_name, handle, avatar: None }, text, ..Post::default() })
}

/// The embed's `<blockquote><p>` holds the post; the rest is a byline. Text
/// only: no markup from the embed reaches the item.
fn post_text(html: &str) -> String {
    let doc = Document::from(html);
    let paragraphs: Vec<String> = doc
        .select("blockquote p")
        .iter()
        .map(|p| {
            p.select("br").replace_with_html("\n");
            p.text().trim().to_string()
        })
        .filter(|t| !t.is_empty())
        .collect();
    paragraphs.join("\n\n")
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_the_post_paragraphs_are_kept() {
        let html = r#"<blockquote class="twitter-tweet"><p lang="en">Line one<br>line two <a href="https://t.co/x">pic.twitter.com/x</a></p>&mdash; Writer (@writer) <a href="https://twitter.com/writer/status/1">May 1</a></blockquote><script>evil()</script>"#;
        assert_eq!(super::post_text(html), "Line one\nline two pic.twitter.com/x");
    }
}
