//! One task owns all enrichment. Captures wake it; periodic scans also pick up
//! clips written by other apps without requiring a filesystem watcher.

use crate::AppHandle;
use super::{
    storage::{Clip, Store, Update, VaultStore},
    think,
};
use kintsugi_ingest::{CaptureOptions, Engine as Ingest, Item, Target};
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
        // only where it came from.
        let target = match (&clip.summary.file, &clip.summary.url) {
            (Some(file), _) => kintsugi_vault::clip_file_path(root, &clip.summary.path, file)
                .map(Target::File)
                .map_err(|_| kintsugi_ingest::Error::Unavailable),
            (None, Some(url)) => Target::url(url),
            (None, None) => return Ok(Page::default()),
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
    source_text: String,
    image: Option<kintsugi_ingest::MediaData>,
}

impl From<Item> for Page {
    fn from(mut item: Item) -> Self {
        Page {
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
    let input = think::Input {
        title: baseline
            .title
            .clone()
            .filter(|s| !s.trim().is_empty())
            .or_else(|| page.title.clone()),
        kind: kind_name(baseline.kind).into(),
        own_text: clip.text.clone(),
        source_text: if page.source_text.is_empty() {
            clip.source.clone().unwrap_or_default()
        } else {
            page.source_text.clone()
        },
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
    Ok(Update {
        title: page.title.or(thought.title),
        summary: thought.summary,
        tags: thought.tags,
        kind: thought.kind,
        site: page.site,
        author: page.author,
        source_text: (!page.source_text.is_empty()).then_some(page.source_text),
        image: page.image,
    })
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
                captured: "2026-10-29T14:05".into(),
                via: None,
                tags: vec![],
                summary: None,
                enriched: None,
                enrich_error: None,
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
