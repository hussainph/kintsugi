//! Captures KI-21's public sources through the real ingest adapters into a
//! scratch vault, the way clip enrichment does on the Mac (minus the AI
//! "think" step: no credentials are read, so summaries and tags stay empty).
//!
//! ```sh
//! cargo run --release -- <scratch dir under .headless> [slug…]
//! ```
//!
//! The scratch dir gets `vault/inspiration/*.md` (real clip files),
//! `items/<slug>.json` (the normalized items, media bytes omitted) and
//! `tools/` (yt-dlp and Deno, downloaded with consent granted here).

use kintsugi_ingest::{
    Adapter, CaptureOptions, Engine, Item, Target, Url,
    pdf::{PdfAdapter, PdfKitReader, PdfReader},
    podcast::PodcastAdapter,
    tools::{Tools, catalog},
    web::WebAdapter,
    youtube::YouTubeAdapter,
};
use kintsugi_vault::{ClipCapture, ClipUpdate, ClipVia};
use std::{path::Path, sync::Arc};

enum Source {
    /// Captured like a pasted or shared link.
    Url(&'static str),
    /// A podcast episode the Feed would hand over: its feed and GUID.
    Podcast {
        feed: &'static str,
        guid: Option<&'static str>,
    },
    /// A screenshot shared without a link: the image is the clip.
    Image(&'static str),
    /// Reddit refuses this network (403), so its `.json` listing was
    /// assembled by hand from a public archive and is served on loopback to
    /// the real Reddit adapter: the normalization is the product's.
    RedditListing {
        url: &'static str,
        listing: &'static str,
    },
    /// A thought typed on the phone: nothing to fetch.
    Note(&'static str),
}

const SOURCES: &[(&str, &str, Source)] = &[
    (
        "article",
        "2026-10-30T08:12",
        Source::Url("https://paulgraham.com/words.html"),
    ),
    (
        "x-thread",
        "2026-10-30T22:41",
        Source::Url("https://x.com/karpathy/status/2039805659525644595"),
    ),
    (
        "youtube",
        "2026-10-28T19:05",
        Source::Url("https://www.youtube.com/watch?v=vtIzMaLkCaM"),
    ),
    (
        "podcast",
        "2026-10-31T07:30",
        Source::Podcast {
            feed: "https://feeds.buzzsprout.com/231452.rss",
            guid: Some("Buzzsprout-20042854"),
        },
    ),
    (
        "paper",
        "2026-10-25T16:20",
        Source::Url("https://www.inkandswitch.com/local-first/static/local-first.pdf"),
    ),
    (
        "hn-thread",
        "2026-10-25T16:48",
        Source::Url("https://news.ycombinator.com/item?id=19804478"),
    ),
    (
        "reddit",
        "2026-10-29T12:02",
        Source::RedditListing {
            url: "https://www.reddit.com/r/PKMS/comments/1rqzo93/does_it_seem_to_anyone_that_their_pkm_system/",
            listing: include_str!("../reddit-1rqzo93.json"),
        },
    ),
    (
        "screenshot",
        "2026-10-31T10:15",
        Source::Image(
            "https://upload.wikimedia.org/wikipedia/commons/thumb/9/92/Kintsugi_art.jpg/960px-Kintsugi_art.jpg",
        ),
    ),
    (
        "note",
        "2026-10-31T23:58",
        Source::Note(
            "Kintsugi isn't about the gold. It's that someone decided the bowl was worth the weeks of lacquer. Saving a clip should feel like that decision, not like bookmarking.",
        ),
    ),
];

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let scratch = std::path::PathBuf::from(args.next().expect("scratch dir"));
    assert!(
        scratch.components().any(|c| c.as_os_str() == ".headless"),
        "the scratch dir must be under .headless"
    );
    let only: Vec<String> = args.collect();
    let vault = scratch.join("vault");
    std::fs::create_dir_all(vault.join("inspiration")).unwrap();
    std::fs::create_dir_all(scratch.join("items")).unwrap();

    let tools = Arc::new(Tools::new(scratch.join("tools")).unwrap());
    tools.grant(&catalog::YT_DLP).unwrap();
    tools.grant(&catalog::DENO).unwrap();
    let web = Arc::new(WebAdapter::new().unwrap());
    let pdf_helper = scratch.join("bin/kintsugi-pdf");
    let reader = pdf_helper
        .is_file()
        .then(|| Arc::new(PdfKitReader::new(&pdf_helper)) as Arc<dyn PdfReader>);
    let engine = Engine::new()
        .with(kintsugi_ingest::x::XAdapter::new().unwrap())
        .with(
            kintsugi_ingest::reddit::RedditAdapter::new()
                .unwrap()
                .with_fallback(web.clone()),
        )
        .with(
            YouTubeAdapter::new(tools.clone())
                .unwrap()
                .with_fallback(web.clone()),
        )
        .with(PdfAdapter::new(reader).unwrap())
        .with(web.clone());
    let podcast = PodcastAdapter::new().unwrap();
    let options = CaptureOptions { want_media: true };

    for (slug, captured, source) in SOURCES {
        if !only.is_empty() && !only.iter().any(|s| s == slug) {
            continue;
        }
        eprintln!("· {slug}");
        if let Source::Note(text) = source {
            let capture = ClipCapture {
                url: None,
                text: Some(text.to_string()),
                note: None,
                title: None,
                image: None,
                image_type: None,
                file: None,
                captured_at: captured.to_string(),
                via: ClipVia::Phone,
            };
            eprintln!(
                "  → {}",
                kintsugi_vault::clip_create(&vault, &capture).unwrap()
            );
            continue;
        }
        let item = match source {
            Source::Url(url) => engine.capture(&Target::url(url).unwrap(), options).await,
            Source::Image(url) => web.capture(&Target::url(url).unwrap(), options).await,
            Source::RedditListing { url, listing } => {
                reddit_on_loopback(url, listing, options).await
            }
            Source::Note(_) => unreachable!(),
            Source::Podcast { feed, guid } => {
                podcast
                    .capture_from_feed(&Url::parse(feed).unwrap(), *guid, options)
                    .await
            }
        };
        let mut item = match item {
            Ok(item) => item,
            Err(error) => {
                eprintln!("  failed: {error}");
                continue;
            }
        };
        report(&item);
        save(&vault, captured, source, &mut item);
        let json = serde_json::to_string_pretty(&item).unwrap();
        std::fs::write(scratch.join("items").join(format!("{slug}.json")), json).unwrap();
    }
}

/// Serves one Reddit `.json` listing on 127.0.0.1 to `RedditAdapter`.
async fn reddit_on_loopback(
    url: &str,
    listing: &'static str,
    options: CaptureOptions,
) -> kintsugi_ingest::Result<Item> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/", listener.local_addr().unwrap());
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut buffer = [0u8; 4096];
            let _ = socket.read(&mut buffer).await;
            let head = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                listing.len()
            );
            let _ = socket.write_all(head.as_bytes()).await;
            let _ = socket.write_all(listing.as_bytes()).await;
        }
    });
    let limits = kintsugi_ingest::api::ApiLimits {
        min_interval: std::time::Duration::ZERO,
        ..Default::default()
    };
    let adapter =
        kintsugi_ingest::reddit::RedditAdapter::with_endpoint(Url::parse(&base).unwrap(), limits)?;
    let mut item = adapter.capture(&Target::url(url).unwrap(), options).await?;
    item.extras.insert(
        "assembled".into(),
        "arctic-shift archive, served on loopback".into(),
    );
    Ok(item)
}

fn report(item: &Item) {
    eprintln!(
        "  {} · {} · {} chars · extras {}",
        item.title.as_deref().unwrap_or("(untitled)"),
        item.author.as_deref().unwrap_or("-"),
        item.body.chars().count(),
        serde_json::to_string(&item.extras).unwrap()
    );
}

/// Capture first (what arrived), then enrich (what the adapter found), like
/// the Mac: the clip is a real `inspiration/*.md` written by the vault crate.
fn save(vault: &Path, captured: &str, source: &Source, item: &mut Item) {
    let image = item.media.first_mut().and_then(|m| m.data.take());
    let capture = match source {
        Source::Image(_) => ClipCapture {
            url: None,
            text: None,
            note: None,
            title: None,
            image: image.as_ref().map(|i| i.bytes.clone()),
            image_type: image.as_ref().map(|i| i.mime.clone()),
            file: None,
            captured_at: captured.into(),
            via: ClipVia::Share,
        },
        _ => ClipCapture {
            url: item.url.clone().or_else(|| match source {
                Source::Url(url) | Source::RedditListing { url, .. } => Some(url.to_string()),
                _ => None,
            }),
            text: None,
            note: None,
            title: None,
            image: None,
            image_type: None,
            file: None,
            captured_at: captured.into(),
            via: if matches!(source, Source::Podcast { .. }) {
                ClipVia::Feed
            } else {
                ClipVia::Share
            },
        },
    };
    let path = kintsugi_vault::clip_create(vault, &capture).unwrap();
    let baseline = kintsugi_vault::clip_read(vault, &path).unwrap().summary;
    if let (Some(image), false) = (&image, matches!(source, Source::Image(_))) {
        let _ = kintsugi_vault::clip_save_media(vault, &path, &image.bytes, &image.mime);
    }
    let patch = ClipUpdate {
        title: item.title.clone(),
        site: item.site.clone(),
        author: item.author.clone(),
        source: (!item.body.is_empty()).then(|| item.body.clone()),
        enriched: Some(captured.to_string()),
        ..Default::default()
    };
    kintsugi_vault::clip_enrich(vault, &path, &baseline, &patch).unwrap();
    eprintln!("  → {path}");
}
