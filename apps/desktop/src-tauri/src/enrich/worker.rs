//! One task owns all enrichment. Captures wake it; periodic scans also pick up
//! clips written by other apps without requiring a filesystem watcher.

use crate::AppHandle;
use super::{
    storage::{Clip, Store, Update, VaultStore},
    think,
};
use kintsugi_ingest::{CaptureOptions, Engine as Ingest, Item, SourceType, Target};
use std::{future::Future, path::Path, time::Duration};
use tauri::{Listener, Manager};
use tokio::sync::Notify;

type Result<T> = std::result::Result<T, String>;
const BACKOFF: [Duration; 2] = [Duration::from_secs(2), Duration::from_secs(10)];
const CHANGED: &str = "clips:changed";

#[derive(Default)]
pub struct Worker {
    wake: Notify,
}

/// Coalesces rapid captures and vault changes rather than spawning more workers.
pub fn wake(app: &AppHandle) {
    if let Some(worker) = app.try_state::<Worker>() {
        worker.wake.notify_one();
    }
}

pub fn start(app: &AppHandle) {
    let app = app.clone();
    // KI-1 emits this for local and phone changes. Scanning remains a fallback
    // for captures from an older client or a plain-file tool such as Obsidian.
    let handle = app.clone();
    app.listen(CHANGED, move |_| wake(&handle));
    tauri::async_runtime::spawn(async move {
        // Initializes the last/default vault even before the webview asks.
        let _ = crate::vault::current(&app);
        let engine = loop {
            match super::ingest_engine(&app) {
                Ok(ingest) => break Enricher(ingest),
                Err(_) => {
                    eprintln!("Could not start clip enrichment; retrying.");
                    tokio::time::sleep(Duration::from_secs(5)).await;
                }
            }
        };
        let store = VaultStore;
        loop {
            if let Ok(root) = app.state::<crate::vault::Vault>().root() {
                if drain(
                    &store,
                    &engine,
                    &root,
                    &BACKOFF,
                    || app.state::<crate::vault::Vault>().root().ok().as_deref() == Some(root.as_path()),
                    |path| crate::vault::clips_changed(&app, path),
                )
                .await
                .is_err()
                {
                    eprintln!("Could not scan clips for enrichment.");
                }
            }
            let worker = app.state::<Worker>();
            let _ = tokio::time::timeout(Duration::from_secs(5), worker.wake.notified()).await;
        }
    });
}

trait Engine {
    fn enrich(&self, root: &Path, clip: &Clip, existing_tags: Vec<String>) -> impl Future<Output = Result<Update>> + Send;
}

/// Enrichment is one consumer of the ingest engine: the clip's URL becomes a
/// normalized item, and the item's Markdown body becomes the clip's source.
struct Enricher(Ingest);

impl Enricher {
    async fn page(&self, root: &Path, clip: &Clip) -> Result<Page> {
        let options = CaptureOptions {
            want_media: clip.summary.image.is_none(),
        };
        // A saved PDF or EPUB is the source itself; its link (if any) is
        // only where it came from. A picture with no link is read on this
        // Mac, when this build can (machine-made text and labels).
        let target = match (&clip.summary.file, &clip.summary.url, &clip.summary.image) {
            (Some(file), _, _) => kintsugi_vault::clip_file_path(root, &clip.summary.path, file)
                .map(Target::File)
                .map_err(|_| kintsugi_ingest::Error::Unavailable),
            (None, Some(url), _) => Target::url(url),
            (None, None, Some(image)) => {
                let Ok(image) = kintsugi_vault::clip_media_path(root, &clip.summary.path, image) else {
                    return Ok(Page::default());
                };
                let target = Target::File(image);
                if self.0.adapter_for(&target).is_none() {
                    return Ok(Page::default());
                }
                // Reading a picture is a bonus: a failure leaves the clip
                // to be organized from what it has.
                return Ok(self.0.capture(&target, options).await.map(Page::from).unwrap_or_default());
            }
            (None, None, None) => return Ok(Page::default()),
        };
        let item = match target {
            Ok(target) => self.0.capture(&target, options).await,
            Err(error) => Err(error),
        };
        source_or_shared(clip, item.map(Page::from).map_err(|e| e.to_string()))
    }
}

impl Engine for Enricher {
    async fn enrich(&self, root: &Path, clip: &Clip, existing_tags: Vec<String>) -> Result<Update> {
        let page = self.page(root, clip).await?;
        build_update(clip, page, existing_tags).await
    }
}

/// What enrichment takes from an ingested item.
#[derive(Debug, Default)]
struct Page {
    title: Option<String>,
    site: Option<String>,
    author: Option<String>,
    description: Option<String>,
    /// The whole extracted text (the vault keeps an excerpt in the clip and
    /// the rest beside it).
    source_text: String,
    image: Option<kintsugi_ingest::MediaData>,
    /// The kind the source makes certain (a podcast episode, a PDF), which
    /// wins over the model's guess.
    kind: Option<&'static str>,
    /// A better URL for the clip: an episode's page, or its audio file
    /// without the tracking redirects in front of it.
    url: Option<String>,
}

/// The clip kind an ingest source settles, if it does.
fn source_kind(source: SourceType) -> Option<&'static str> {
    match source {
        SourceType::Podcast => Some("podcast"),
        SourceType::Youtube => Some("video"),
        SourceType::Pdf => Some("document"),
        SourceType::Epub | SourceType::Book | SourceType::Author => Some("book"),
        SourceType::X => Some("post"),
        SourceType::Image => Some("image"),
        SourceType::Web | SourceType::Rss | SourceType::Reddit | SourceType::Hn => None,
    }
}

impl From<Item> for Page {
    fn from(mut item: Item) -> Self {
        Page {
            kind: source_kind(item.source),
            url: item.url.take().filter(|_| item.source == SourceType::Podcast),
            image: item.media.first_mut().and_then(|m| m.data.take()),
            title: item.title,
            site: item.site,
            author: item.author,
            description: item.description,
            source_text: item.body,
        }
    }
}

/// A login wall or dead URL must not prevent organizing a shared passage.
/// Bare URLs still retry; without any source, the model would only be guessing.
fn source_or_shared(clip: &Clip, fetched: Result<Page>) -> Result<Page> {
    match fetched {
        Err(_) if !clip.text.trim().is_empty() || clip.source.as_deref().is_some_and(|s| !s.trim().is_empty()) => {
            Ok(Page::default())
        }
        other => other,
    }
}

async fn build_update(clip: &Clip, page: Page, existing_tags: Vec<String>) -> Result<Update> {
    // The think module owns prompt construction and structured-output checks.
    let baseline = &clip.summary;
    let known_source = clip.source.clone().unwrap_or_default();
    let input = think::Input {
        title: baseline
            .title
            .clone()
            .filter(|s| !s.trim().is_empty())
            .or_else(|| page.title.clone()),
        kind: kind_name(baseline.kind).into(),
        own_text: clip.text.clone(),
        source_text: if page.source_text.is_empty() { known_source.clone() } else { page.source_text.clone() },
        metadata: [
            ("page title", page.title.clone()),
            ("site", page.site.clone().or_else(|| baseline.site.clone())),
            ("author", page.author.clone().or_else(|| baseline.author.clone())),
            ("description", page.description),
            ("url", baseline.url.clone()),
        ]
        .into_iter()
        .filter_map(|(label, value)| value.map(|value| (label.to_string(), value)))
        .collect(),
        existing_tags,
    };
    let thought = think::think(&input).await.map_err(|e| e.to_string())?;
    let kind = page.kind.map(String::from).unwrap_or(thought.kind);
    let url = page.url.filter(|u| baseline.url.as_deref() != Some(u.as_str()));
    let source = if page.source_text.is_empty() { &known_source } else { &page.source_text };
    let quote = quote(clip, source, url.as_deref().or(baseline.url.as_deref()), &kind);
    Ok(Update {
        title: page.title.or(thought.title),
        summary: thought.summary,
        tags: thought.tags,
        kind,
        site: page.site,
        author: page.author,
        source_text: (!page.source_text.is_empty()).then_some(page.source_text),
        image: page.image,
        url,
        quote_by: quote.by,
        quote_link: quote.link,
    })
}

/// Who said the clip's shared passage and where it is, from the source's
/// comment headings, timestamps, page markers or (for articles) a text
/// fragment.
fn quote(clip: &Clip, source: &str, url: Option<&str>, kind: &str) -> kintsugi_vault::QuoteAttribution {
    let Some(passage) = kintsugi_vault::leading_passage(&clip.text) else { return Default::default() };
    let source = kintsugi_vault::QuoteSource {
        text: source,
        url,
        file: clip.summary.file.as_deref(),
        fragments: matches!(kind, "link" | "quote"),
    };
    kintsugi_vault::quote_attribution(source, &passage)
}

fn kind_name(kind: kintsugi_vault::ClipKind) -> &'static str {
    use kintsugi_vault::ClipKind;
    match kind {
        ClipKind::Link => "link",
        ClipKind::Post => "post",
        ClipKind::Video => "video",
        ClipKind::Image => "image",
        ClipKind::Quote => "quote",
        ClipKind::Note => "note",
        ClipKind::Document => "document",
        ClipKind::Book => "book",
        ClipKind::Podcast => "podcast",
    }
}

async fn drain<S: Store, E: Engine>(
    store: &S,
    engine: &E,
    root: &Path,
    delays: &[Duration],
    still_current: impl Fn() -> bool,
    changed: impl Fn(&str),
) -> Result<()> {
    for clip in store.pending(root)? {
        // Finish an in-flight clip, but don't drain a vault the writer has left.
        if !still_current() {
            break;
        }
        // An unreadable/deleted clip must not starve every other capture.
        if process(store, engine, root, &clip, delays).await.is_ok() {
            changed(&clip.summary.path);
        } else {
            eprintln!("Could not save clip enrichment or its error.");
        }
    }
    Ok(())
}

/// Delays are injected so retry behavior is tested without sleeping. Errors
/// originate in bounded fetch/think/storage APIs, never raw provider responses.
async fn process<S: Store, E: Engine>(store: &S, engine: &E, root: &Path, clip: &Clip, delays: &[Duration]) -> Result<()> {
    let mut last_error = "could not enrich clip".to_string();
    for attempt in 0..=delays.len() {
        let result = async {
            let tags = store.tags(root)?;
            let update = engine.enrich(root, clip, tags).await?;
            store.apply(root, clip, &update)
        }
        .await;
        match result {
            Ok(()) => return Ok(()),
            Err(message) => last_error = message,
        }
        if let Some(delay) = delays.get(attempt) {
            tokio::time::sleep(*delay).await;
        }
    }
    store.fail(root, clip, &last_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct Memory {
        applied: Mutex<Vec<String>>,
        failed: Mutex<Vec<String>>,
    }

    impl Store for Memory {
        fn pending(&self, _: &Path) -> Result<Vec<Clip>> {
            let first = clip();
            let mut second = clip();
            second.summary.path = "inspiration/second.md".into();
            Ok(vec![first, second])
        }
        fn tags(&self, _: &Path) -> Result<Vec<String>> {
            Ok(vec!["writing".into()])
        }
        fn apply(&self, _: &Path, clip: &Clip, _: &Update) -> Result<()> {
            self.applied.lock().unwrap().push(clip.summary.path.clone());
            Ok(())
        }
        fn fail(&self, _: &Path, _: &Clip, message: &str) -> Result<()> {
            self.failed.lock().unwrap().push(message.into());
            Ok(())
        }
    }

    struct Flaky(Mutex<usize>);

    impl Engine for Flaky {
        async fn enrich(&self, _: &Path, _: &Clip, tags: Vec<String>) -> Result<Update> {
            assert_eq!(tags, ["writing"]);
            let mut left = self.0.lock().unwrap();
            if *left > 0 {
                *left -= 1;
                return Err("page fetch timed out".into());
            }
            Ok(Update {
                title: None,
                summary: "A thought.".into(),
                tags: vec!["writing".into(), "ideas".into()],
                kind: "note".into(),
                site: None,
                author: None,
                source_text: None,
                image: None,
                ..Update::default()
            })
        }
    }

    fn clip() -> Clip {
        Clip {
            summary: kintsugi_vault::ClipSummary {
                path: "inspiration/note.md".into(),
                kind: kintsugi_vault::ClipKind::Note,
                title: None,
                url: None,
                site: None,
                author: None,
                image: None,
                file: None,
                full_source: None,
                captured: "2026-10-29T14:05".into(),
                via: None,
                tags: vec![],
                summary: None,
                enriched: None,
                enrich_error: None,
                quote_by: None,
                quote_link: None,
            },
            text: "My own words.".into(),
            source: None,
            has_source: false,
        }
    }

    fn run(f: impl Future<Output = ()>) {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(f)
    }

    #[test]
    fn clip_urls_are_ingested_as_markdown_source_through_the_engine() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/post", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = stream.read(&mut [0; 4096]);
            let body = include_bytes!("../../../../../crates/ingest/fixtures/blog.html");
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            stream.write_all(body).unwrap();
        });
        let enricher = Enricher(Ingest::new().with(kintsugi_ingest::web::WebAdapter::new().unwrap()));
        let mut link = clip();
        link.summary.url = Some(url);
        // A clip that already has its image never downloads another.
        link.summary.image = Some("media/shot.png".into());
        let page = futures_block(enricher.page(Path::new("/nonexistent"), &link)).unwrap();
        server.join().unwrap();
        assert_eq!(page.title.as_deref(), Some("On slow software"));
        assert_eq!(page.site.as_deref(), Some("Field Notes"));
        assert!(page.source_text.contains("## What waiting looks like"));
        assert!(!page.source_text.contains("Popular posts"));
        assert!(page.image.is_none());

        // Unfetchable URLs fail with the engine's fixed message, which the
        // retry loop stores as `enrich_error` for bare links.
        let mut bare = clip();
        bare.text.clear();
        bare.summary.url = Some("https://user:secret@example.org/".into());
        let error = futures_block(enricher.page(Path::new("/nonexistent"), &bare)).unwrap_err();
        assert_eq!(error, "source must use http or https without credentials");
    }

    #[test]
    fn saved_files_are_read_from_the_vault_not_their_link() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let epub = std::fs::read("../../../crates/ingest/fixtures/epub/repair.epub").unwrap();
        let path = kintsugi_vault::clip_create(
            root,
            &kintsugi_vault::ClipCapture {
                // The link is never fetched: the file is the source.
                url: Some("https://user:secret@example.org/repair.epub".into()),
                text: None,
                note: None,
                title: None,
                image: None,
                image_type: None,
                file: Some(kintsugi_vault::ClipFile { bytes: epub, mime: "application/epub+zip".into(), name: Some("repair.epub".into()) }),
                captured_at: "2026-10-29T14:05".into(),
                via: kintsugi_vault::ClipVia::Mac,
            },
        )
        .unwrap();
        let clip = kintsugi_vault::clip_read(root, &path).unwrap();
        let enricher = Enricher(Ingest::new().with(kintsugi_ingest::epub::EpubAdapter::new().unwrap()));
        let page = futures_block(enricher.page(root, &clip)).unwrap();
        assert_eq!(page.title.as_deref(), Some("The Golden Seam"));
        assert_eq!(page.author.as_deref(), Some("Ada Example, Ben Sample"));
        assert!(page.source_text.starts_with("# One: The crack"));
        assert_eq!(page.image.unwrap().mime, "image/png");
        // A hand-edited file path outside the clip's own is refused.
        let mut moved = clip.clone();
        moved.summary.file = Some("files/elsewhere.epub".into());
        assert_eq!(futures_block(enricher.page(root, &moved)).unwrap_err(), "could not fetch source page");
    }

    #[test]
    fn a_hacker_news_reply_is_attributed_to_its_commenter() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = stream.read(&mut [0; 4096]);
            let body = include_bytes!("../../../../../crates/ingest/fixtures/hn/story.json");
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len())
                .unwrap();
            stream.write_all(body).unwrap();
        });
        let limits = kintsugi_ingest::api::ApiLimits { min_interval: Duration::ZERO, ..Default::default() };
        let hn = kintsugi_ingest::hn::HackerNewsAdapter::with_endpoint(kintsugi_ingest::Url::parse(&base).unwrap(), limits).unwrap();
        let enricher = Enricher(Ingest::new().with(hn));
        let mut shared = clip();
        shared.summary.url = Some("https://news.ycombinator.com/item?id=19804478".into());
        shared.text = "> Thanks, Joseph!\n\nHe built the thing.".into();
        let page = futures_block(enricher.page(Path::new("/nonexistent"), &shared)).unwrap();
        server.join().unwrap();
        assert_eq!(page.title.as_deref(), Some("Local-first software: You own your data, in spite of the cloud"));
        assert_eq!(page.kind, None);
        let quote = quote(&shared, &page.source_text, shared.summary.url.as_deref(), "link");
        assert_eq!(quote.by.as_deref(), Some("pvh"));
        assert_eq!(quote.link.as_deref(), Some("https://news.ycombinator.com/item?id=19805123"));
    }

    struct Ocr;

    impl kintsugi_ingest::image::ImageReader for Ocr {
        fn read<'a>(&'a self, _: &'a Path) -> kintsugi_ingest::BoxFuture<'a, kintsugi_ingest::Result<kintsugi_ingest::image::ImageText>> {
            Box::pin(async {
                Ok(kintsugi_ingest::image::ImageText { lines: vec!["Golden seams".into()], ..Default::default() })
            })
        }
    }

    #[test]
    fn a_picture_alone_is_read_on_this_mac_when_it_can_be() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let path = kintsugi_vault::clip_create(
            root,
            &kintsugi_vault::ClipCapture {
                url: None,
                text: None,
                note: None,
                title: None,
                image: Some(b"\x89PNG\r\n\x1a\nfake".to_vec()),
                image_type: Some("image/png".into()),
                file: None,
                captured_at: "2026-10-31T10:15".into(),
                via: kintsugi_vault::ClipVia::Share,
            },
        )
        .unwrap();
        assert_eq!(path, "inspiration/image-2026-10-31-10-15.md");
        let clip = kintsugi_vault::clip_read(root, &path).unwrap();
        let reading = Enricher(Ingest::new().with(kintsugi_ingest::image::ImageAdapter::new(std::sync::Arc::new(Ocr))));
        let page = futures_block(reading.page(root, &clip)).unwrap();
        assert!(page.source_text.contains("machine-made") && page.source_text.contains("Golden seams"), "{}", page.source_text);
        assert_eq!(page.kind, Some("image"));
        // Without the helper (headless, or an old build), nothing is read and nothing fails.
        let page = futures_block(Enricher(Ingest::new()).page(root, &clip)).unwrap();
        assert!(page.source_text.is_empty());
    }

    #[test]
    fn sources_settle_the_kinds_they_are_sure_of() {
        assert_eq!(source_kind(SourceType::Podcast), Some("podcast"));
        assert_eq!(source_kind(SourceType::Pdf), Some("document"));
        assert_eq!(source_kind(SourceType::Web), None);
        let podcast = Item {
            source: SourceType::Podcast,
            id: "podcast:x".into(),
            url: Some("https://media.example.com/idea.mp3".into()),
            title: None,
            author: None,
            site: None,
            description: None,
            published: None,
            captured: String::new(),
            media: vec![],
            body: String::new(),
            extras: Default::default(),
        };
        assert_eq!(Page::from(podcast.clone()).url.as_deref(), Some("https://media.example.com/idea.mp3"));
        assert_eq!(Page::from(Item { source: SourceType::Web, ..podcast }).url, None);
    }

    fn futures_block<T>(f: impl Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(f)
    }

    #[test]
    fn a_shared_passage_can_be_organized_when_its_page_is_unavailable() {
        let clip = clip();
        assert!(source_or_shared(&clip, Err("could not fetch source page".into())).is_ok());
        let bare = Clip {
            text: String::new(),
            ..clip
        };
        assert!(source_or_shared(&bare, Err("could not fetch source page".into())).is_err());
    }

    #[test]
    fn queued_clips_are_processed_one_at_a_time() {
        struct Serial(Mutex<Vec<String>>);
        impl Engine for Serial {
            async fn enrich(&self, root: &Path, clip: &Clip, tags: Vec<String>) -> Result<Update> {
                self.0.lock().unwrap().push(format!("start {}", clip.summary.path));
                tokio::task::yield_now().await;
                self.0.lock().unwrap().push(format!("end {}", clip.summary.path));
                Flaky(Mutex::new(0)).enrich(root, clip, tags).await
            }
        }
        run(async {
            let store = Memory::default();
            let engine = Serial(Mutex::new(vec![]));
            drain(&store, &engine, Path::new("."), &[], || true, |_| {}).await.unwrap();
            assert_eq!(
                *engine.0.lock().unwrap(),
                [
                    "start inspiration/note.md",
                    "end inspiration/note.md",
                    "start inspiration/second.md",
                    "end inspiration/second.md",
                ]
            );
        });
    }

    #[test]
    fn changing_vaults_stops_the_previous_queue() {
        run(async {
            let store = Memory::default();
            let engine = Flaky(Mutex::new(0));
            let current = std::cell::Cell::new(true);
            drain(&store, &engine, Path::new("."), &[], || current.get(), |_| current.set(false))
                .await
                .unwrap();
            assert_eq!(*store.applied.lock().unwrap(), ["inspiration/note.md"]);
        });
    }

    #[test]
    fn transient_failures_retry_then_write_once() {
        run(async {
            let store = Memory::default();
            let engine = Flaky(Mutex::new(2));
            process(&store, &engine, Path::new("."), &clip(), &[Duration::ZERO; 2])
                .await
                .unwrap();
            assert_eq!(*store.applied.lock().unwrap(), ["inspiration/note.md"]);
            assert!(store.failed.lock().unwrap().is_empty());
        });
    }

    #[test]
    fn exhausted_retries_set_one_terminal_error() {
        run(async {
            let store = Memory::default();
            let engine = Flaky(Mutex::new(10));
            process(&store, &engine, Path::new("."), &clip(), &[Duration::ZERO; 2])
                .await
                .unwrap();
            assert!(store.applied.lock().unwrap().is_empty());
            assert_eq!(*store.failed.lock().unwrap(), ["page fetch timed out"]);
            assert_eq!(*engine.0.lock().unwrap(), 7);
        });
    }
}
