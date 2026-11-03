//! Conservative neighbours, using links already present in kept writing.
//! No search, recursive crawling, model calls or extra network requests.

use super::{NewItem, Result, with};
use crate::AppHandle;
use kintsugi_ingest::{Url, web};
use std::collections::{BTreeMap, HashSet};

#[derive(Clone, Debug, PartialEq)]
struct Link {
    url: String,
    title: String,
}

/// Only explicit, titled article links. Images, bare URLs and navigation
/// labels are not evidence of an author's recommendation.
fn links(markdown: &str, base: &Url) -> Vec<Link> {
    let mut links = Vec::new();
    let mut rest = markdown;
    while let Some(start) = rest.find('[') {
        let image = rest[..start].ends_with('!');
        rest = &rest[start + 1..];
        let Some(end) = rest.find("](") else { break };
        let title = rest[..end].trim();
        let destination = &rest[end + 2..];
        let Some(close) = destination.find(')') else {
            break;
        };
        let raw = destination[..close].split_whitespace().next().unwrap_or("");
        rest = &destination[close + 1..];
        if image
            || title.split_whitespace().count() < 3
            || title.len() > 300
            || title.contains(['[', ']', '<', '>'])
        {
            continue;
        }
        let Ok(url) = base.join(raw.trim_matches(['<', '>'])) else {
            continue;
        };
        if !web::allowed_url(&url)
            || url.origin() == base.origin()
            || url.path() == "/"
            || [".png", ".jpg", ".pdf", ".xml"]
                .iter()
                .any(|suffix| url.path().ends_with(*suffix))
        {
            continue;
        }
        let host = url
            .host_str()
            .unwrap_or_default()
            .trim_start_matches("www.");
        if [
            "youtube.com",
            "youtu.be",
            "x.com",
            "twitter.com",
            "facebook.com",
            "instagram.com",
            "amazon.com",
            "github.com",
        ]
        .contains(&host)
        {
            continue;
        }
        links.push(Link {
            url: web::canonical_url(&url).to_string(),
            title: title.to_string(),
        });
        if links.len() >= 8 {
            break;
        }
    }
    links
}

pub(super) fn discover(app: &AppHandle) -> Result<usize> {
    with(app, discover_in_store)
}

fn discover_in_store(store: &super::Store) -> Result<usize> {
    let favourites = store.favourite_links()?;
    let followed: HashSet<String> = store
        .sources()?
        .iter()
        .flat_map(|source| [&source.url, source.site_url.as_ref().unwrap_or(&source.url)])
        .filter_map(|raw| Url::parse(raw).ok())
        .map(|url| url.origin().ascii_serialization())
        .collect();
    let mut by_origin: BTreeMap<String, Vec<(i64, Link)>> = BTreeMap::new();
    for favourite in &favourites {
        let Ok(base) = Url::parse(&favourite.url) else {
            continue;
        };
        for link in links(&favourite.content, &base) {
            let url = Url::parse(&link.url).expect("checked article URL");
            let origin = url.origin().ascii_serialization();
            if !followed.contains(&origin) {
                by_origin
                    .entry(origin)
                    .or_default()
                    .push((favourite.id, link));
            }
        }
    }
    let mut added = 0;
    // Two distinct positive items must link to an origin. Take at most
    // three destinations per pass; the durable journal prevents repeats.
    for (origin, candidates) in by_origin {
        let source_title = Url::parse(&origin).ok().and_then(|url| {
            url.host_str()
                .map(|host| host.trim_start_matches("www.").to_string())
        });
        let anchors: HashSet<i64> = candidates.iter().map(|(id, _)| *id).collect();
        if anchors.len() < 2 {
            continue;
        }
        for (anchor, link) in candidates.into_iter().take(3) {
            if store.neighbour_checked(&link.url)? {
                continue;
            }
            let now = super::now();
            let entry = NewItem {
                guid: link.url.clone(),
                url: Some(link.url.clone()),
                title: Some(link.title),
                media: "article",
                ..Default::default()
            };
            added += store.insert_suggested_catalogue(
                &origin,
                source_title.as_deref(),
                anchor,
                &[entry],
                now,
            )?;
            store.mark_neighbour_checked(&link.url, now)?;
        }
    }
    Ok(added)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_kept_items_are_required_and_known_links_are_not_repeated() {
        let store = super::super::Store::memory();
        let (source, _) = store
            .add_source(
                "https://favourite.example/feed",
                super::super::SourceKind::Feed,
                Some("Favourites"),
                super::super::now(),
            )
            .unwrap();
        let entries: Vec<NewItem> = ["one", "two"]
            .into_iter()
            .map(|slug| NewItem {
                guid: slug.into(),
                url: Some(format!("https://favourite.example/{slug}")),
                title: Some(slug.into()),
                content: Some("[A thoughtful linked essay](https://near.example/essay)".into()),
                media: "article",
                ..Default::default()
            })
            .collect();
        store
            .insert_items(source.id, &entries, super::super::now(), true)
            .unwrap();
        let items = store.items(0, 10, None).unwrap().items;
        store
            .set_liked(items[0].id, true, super::super::now())
            .unwrap();
        assert_eq!(discover_in_store(&store).unwrap(), 0);
        store
            .set_note(items[1].id, "Worth reading", super::super::now())
            .unwrap();
        assert_eq!(discover_in_store(&store).unwrap(), 1);
        assert_eq!(discover_in_store(&store).unwrap(), 0);
        assert_eq!(
            store.sources().unwrap().len(),
            1,
            "a suggestion is not a subscription"
        );
        let pending: Vec<_> = store
            .rank_rows()
            .unwrap()
            .into_iter()
            .filter(|row| row.catalogue_candidate)
            .collect();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].title, "A thoughtful linked essay");
    }

    #[test]
    fn neighbours_need_titled_article_links_not_images_or_navigation() {
        let base = Url::parse("https://favourite.example/a").unwrap();
        let found = links(
            "[A thoughtful linked essay](https://near.example/essay?utm_source=feed) [Read more](https://other.example/a) ![An image of work](https://other.example/photo.png) [An article at home](/essay) [A bad external link](javascript:alert(1)) [A code repository](https://github.com/a/b)",
            &base,
        );
        assert_eq!(
            found,
            vec![Link {
                url: "https://near.example/essay".into(),
                title: "A thoughtful linked essay".into()
            }]
        );
    }
}
