//! oEmbed for platforms whose public pages are login walls or players.

use super::{Draft, allowed_url, extract};
use crate::markdown;
use reqwest::Url;
use serde::Deserialize;

#[derive(Deserialize)]
pub(crate) struct OEmbed {
    title: Option<String>,
    author_name: Option<String>,
    provider_name: Option<String>,
    thumbnail_url: Option<String>,
    html: Option<String>,
}

/// Exact platform hosts only; a look-alike domain gets no embed request.
pub(crate) fn endpoint(url: &Url) -> Option<Url> {
    let host = url.host_str()?.trim_start_matches("www.");
    let endpoint = match host {
        "youtube.com" | "m.youtube.com" | "youtu.be" => "https://www.youtube.com/oembed",
        "x.com" | "mobile.x.com" | "twitter.com" | "mobile.twitter.com" => "https://publish.twitter.com/oembed",
        "bsky.app" => "https://embed.bsky.app/oembed",
        "tiktok.com" | "vm.tiktok.com" | "vt.tiktok.com" | "m.tiktok.com" => "https://www.tiktok.com/oembed",
        "vimeo.com" | "player.vimeo.com" => "https://vimeo.com/api/oembed.json",
        _ => return None,
    };
    let mut endpoint = Url::parse(endpoint).ok()?;
    endpoint
        .query_pairs_mut()
        .append_pair("url", url.as_str())
        .append_pair("format", "json")
        .append_pair("omit_script", "true");
    Some(endpoint)
}

/// Fills metadata gaps without overwriting what the page declared. A social
/// page often renders only a login prompt while its embed holds the post, so
/// embed text replaces the body; a video's iframe embed has no text and
/// leaves the page's body alone.
pub(crate) fn merge(draft: &mut Draft, embed: OEmbed) {
    let field = |s: Option<String>| s.and_then(|s| markdown::field(&s, 500));
    super::fill(&mut draft.title, field(embed.title));
    super::fill(&mut draft.author, field(embed.author_name));
    super::fill(&mut draft.site, field(embed.provider_name));
    if draft.image_url.is_none() {
        draft.image_url = embed.thumbnail_url.and_then(|s| draft.final_url.join(&s).ok()).filter(allowed_url);
    }
    if let Some(html) = embed.html {
        let text = extract::fragment(&html);
        if !text.is_empty() {
            draft.body = text;
            draft.extractor = "oembed";
        }
    }
}
