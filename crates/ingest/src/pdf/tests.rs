//! PDFs from a two-page fixture (`fixtures/pdf/repair.pdf`, made by
//! `fixtures/pdf/make.py`) and the helper's saved output for it
//! (`repair.json`). The real PDFKit helper is compiled and run when this
//! Mac has a Swift toolchain; Docling is a fake installed through a fake uv.

use super::*;
use crate::test_http::{Server, run};
use crate::tools::{ToolSource, ToolSpec};

const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/pdf/repair.pdf");

fn saved() -> PdfText {
    serde_json::from_str(include_str!("../../fixtures/pdf/repair.json")).unwrap()
}

/// Returns the saved helper output, and a tiny PNG as the thumbnail.
struct Saved;

impl PdfReader for Saved {
    fn read<'a>(&'a self, _: &'a Path, thumbnail: Option<&'a Path>) -> BoxFuture<'a, Result<PdfText>> {
        Box::pin(async move {
            if let Some(path) = thumbnail {
                std::fs::write(path, b"\x89PNG\r\n\x1a\nfake").unwrap();
            }
            Ok(saved())
        })
    }
}

struct Failing(Error);

impl PdfConverter for Failing {
    fn name(&self) -> &'static str {
        "docling"
    }
    fn convert<'a>(&'a self, _: &'a Path) -> BoxFuture<'a, Result<String>> {
        Box::pin(async move { Err(self.0) })
    }
}

const EXPECTED: &str = "## The golden seam

Kintsugi repairs broken pottery with lacquer dusted in gold, so the crack becomes the most visible part of the bowl. The repair is not hidden; it is part of the object’s history and its beauty.

Menders work slowly, in thin layers.

## Patience

Urushi lacquer cures in a humid cabinet over weeks. Each coat must harden before the next, and rushing it ruins the seam.";

#[test]
fn lines_become_headings_and_paragraphs_without_running_headers() {
    assert_eq!(layout::markdown(&saved()), EXPECTED);
}

#[test]
fn layout_joins_pages_mid_sentence_and_keeps_lists() {
    let line = |text: &str, size: f64, y: f64| layout::Line { text: text.into(), size, bold: false, y };
    let doc = PdfText {
        pages: vec![
            layout::PageText {
                page: 1,
                lines: vec![
                    line("A sentence that carries", 10.0, 700.0),
                    line("over the page", 10.0, 688.0),
                    line("iv", 8.0, 40.0),
                ],
            },
            layout::PageText {
                page: 2,
                lines: vec![
                    line("break and ends here.", 10.0, 700.0),
                    line("• first point", 10.0, 688.0),
                    line("• # not a heading", 10.0, 676.0),
                    line("<script> stays text", 10.0, 650.0),
                ],
            },
        ],
        ..Default::default()
    };
    assert_eq!(
        layout::markdown(&doc),
        "A sentence that carries over the page break and ends here.\n\n- first point\n\n- \\# not a heading\n\n\\<script> stays text"
    );
}

#[test]
fn a_file_becomes_an_item_with_metadata_and_a_thumbnail() {
    let adapter = PdfAdapter::new(Some(Arc::new(Saved))).unwrap();
    let target = Target::File(FIXTURE.into());
    assert!(adapter.matches(&target));
    assert!(!adapter.matches(&Target::File("/tmp/book.epub".into())));
    let item = run(adapter.capture(&target, CaptureOptions { want_media: true })).unwrap();
    assert_eq!(item.source, SourceType::Pdf);
    assert!(item.id.starts_with("pdf:sha256:") && item.id.len() == "pdf:sha256:".len() + 64);
    assert_eq!(item.url, None);
    assert_eq!(item.title.as_deref(), Some("Kintsugi and the Art of Repair"));
    assert_eq!(item.author.as_deref(), Some("Ada Example"));
    assert_eq!(item.description.as_deref(), Some("Mending pottery with gold"));
    assert_eq!(item.published.as_deref(), Some("2024-05-01T10:00:00Z"));
    assert_eq!(item.body, EXPECTED);
    assert_eq!(item.extras["extractor"], "pdfkit");
    assert_eq!(item.extras["pages"], 2);
    assert_eq!(item.extras["keywords"], json!(["kintsugi", "repair"]));
    assert_eq!(item.primary_image().unwrap().mime, "image/png");

    let without = run(adapter.capture(&target, CaptureOptions::default())).unwrap();
    assert!(without.media.is_empty());
}

#[test]
fn files_that_are_not_pdfs_are_refused() {
    let dir = tempfile::tempdir().unwrap();
    let fake = dir.path().join("fake.pdf");
    std::fs::write(&fake, "<html>not a pdf</html>").unwrap();
    let adapter = PdfAdapter::new(Some(Arc::new(Saved))).unwrap();
    assert_eq!(run(adapter.capture(&Target::File(fake), CaptureOptions::default())), Err(Error::Unsupported));
    let none = PdfAdapter::new(None).unwrap();
    assert_eq!(run(none.capture(&Target::File(FIXTURE.into()), CaptureOptions::default())), Err(Error::Unsupported));
}

#[test]
fn a_missing_or_failing_converter_falls_back_to_pdfkit() {
    for (error, reason) in [(Error::ToolNeeded, "tool-not-installed"), (Error::TimedOut, "failed")] {
        let adapter = PdfAdapter::new(Some(Arc::new(Saved))).unwrap().with_converter(Arc::new(Failing(error)));
        let item = run(adapter.capture(&Target::File(FIXTURE.into()), CaptureOptions::default())).unwrap();
        assert_eq!(item.extras["extractor"], "pdfkit");
        assert_eq!(item.extras["converterReason"], reason);
        assert_eq!(item.body, EXPECTED);
    }
}

#[test]
fn untitled_documents_take_their_first_heading() {
    let mut text = saved();
    text.title = Some("Microsoft Word - draft3.docx".into());
    assert_eq!(title(&text, EXPECTED).as_deref(), Some("The golden seam"));
    text.title = None;
    assert_eq!(title(&text, "Just text").as_deref(), None);
}

#[test]
fn links_to_pdfs_are_downloaded_and_read() {
    let pdf = std::fs::read(FIXTURE).unwrap();
    let server = Server::start(vec![
        ("/papers/repair.pdf", 200, "application/pdf", pdf),
        ("/papers/fake.pdf", 200, "text/html", b"<html>login</html>".to_vec()),
    ]);
    let adapter = PdfAdapter::new(Some(Arc::new(Saved))).unwrap();
    let target = Target::url(&server.url("/papers/repair.pdf#page=2")).unwrap();
    assert!(adapter.matches(&target));
    let item = run(adapter.capture(&target, CaptureOptions::default())).unwrap();
    let canonical = server.url("/papers/repair.pdf");
    assert_eq!(item.url.as_deref(), Some(canonical.as_str()));
    assert_eq!(item.id, format!("pdf:{canonical}"));
    assert_eq!(item.body, EXPECTED);
    let fake = Target::url(&server.url("/papers/fake.pdf")).unwrap();
    assert_eq!(run(adapter.capture(&fake, CaptureOptions::default())), Err(Error::Unavailable));

    for (url, expected) in [
        ("https://arxiv.org/pdf/2408.09869", true),
        ("https://example.org/a/Paper.PDF", true),
        ("https://example.org/a/paper", false),
        ("https://arxiv.org/abs/2408.09869", false),
    ] {
        assert_eq!(pdf_url(&reqwest::Url::parse(url).unwrap()), expected, "{url}");
    }
}

/// Writes an executable shell script.
fn script(path: &Path, body: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}

/// A Docling spec for this platform, installed by a fake uv.
fn docling_spec(runner: &'static ToolSpec) -> &'static ToolSpec {
    let platform: &'static str =
        Box::leak(format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH).into_boxed_str());
    Box::leak(Box::new(ToolSpec {
        id: "docling",
        source: ToolSource::PythonPackage {
            runner,
            package: "docling[ocrmac]",
            version: "2.145.0",
            python: "3.12",
            prepare: &["docling-tools", "models", "download", "-o", "{dir}/models", "layout"],
        },
        assets: Box::leak(vec![(platform, "")].into_boxed_slice()),
        ..catalog::DOCLING
    }))
}

#[test]
fn docling_installs_through_uv_with_consent_and_converts_offline() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("log");
    let tools = Arc::new(crate::tools::Tools::new(dir.path().join("tools")).unwrap());
    let uv: &'static ToolSpec = Box::leak(Box::new(catalog::UV));
    // The fake uv records its arguments and environment, then writes the
    // two scripts uv would install: docling-tools makes the models folder,
    // docling writes Markdown and records whether it ran offline.
    let fake_uv = format!(
        r#"echo "uv $* tool_dir=$UV_TOOL_DIR bin=$UV_TOOL_BIN_DIR no_config=$UV_NO_CONFIG" >> {log}
mkdir -p "$UV_TOOL_BIN_DIR"
printf '#!/bin/sh\necho "docling-tools $*" >> {log}\nmkdir -p "$5"\n' > "$UV_TOOL_BIN_DIR/docling-tools"
cat > "$UV_TOOL_BIN_DIR/docling" <<'SCRIPT'
#!/bin/sh
echo "docling $* offline=$HF_HUB_OFFLINE" >> {log}
while [ "$1" != "--output" ]; do shift; done
mkdir -p "$2"
printf '## Docling heading\n\n<!-- image -->\n\n| a | b |\n|---|---|\n| 1 | 2 |\n' > "$2/document.md"
SCRIPT
chmod +x "$UV_TOOL_BIN_DIR/docling-tools" "$UV_TOOL_BIN_DIR/docling""#,
        log = log.display()
    );
    let uv_path = dir.path().join("fake-uv");
    script(&uv_path, &fake_uv);
    tools.install_local(uv, "0.13.6", &std::fs::read(&uv_path).unwrap());
    let spec = docling_spec(uv);

    // Without consent nothing runs.
    assert_eq!(run(tools.ensure(spec)), Err(ToolError::NeedsConsent));
    assert!(!log.exists());
    // The app grants uv alongside Docling (it is how Docling installs).
    tools.grant(spec).unwrap();
    tools.grant(uv).unwrap();
    let entry = run(tools.ensure(spec)).unwrap();
    assert!(entry.ends_with("2.145.0/bin/docling"), "{entry:?}");
    let status = tools.status(spec);
    assert!(status.supported && status.consented && status.installed.as_ref().unwrap().version == "2.145.0");
    let logged = std::fs::read_to_string(&log).unwrap();
    assert!(logged.contains("uv tool install --python 3.12 docling[ocrmac]==2.145.0"), "{logged}");
    assert!(logged.contains("no_config=1") && logged.contains("2.145.0/env"), "{logged}");
    assert!(logged.contains("docling-tools models download -o ") && logged.contains("2.145.0/models layout"), "{logged}");
    // Installed once; ensure doesn't reinstall.
    run(tools.ensure(spec)).unwrap();
    assert_eq!(std::fs::read_to_string(&log).unwrap().matches("tool install").count(), 1);

    struct Installed(Arc<crate::tools::Tools>, &'static ToolSpec);
    impl PdfConverter for Installed {
        fn name(&self) -> &'static str {
            "docling"
        }
        fn convert<'a>(&'a self, pdf: &'a Path) -> BoxFuture<'a, Result<String>> {
            Box::pin(async move { Docling::new(self.0.clone()).run_with(self.1, pdf).await })
        }
    }
    let adapter =
        PdfAdapter::new(Some(Arc::new(Saved))).unwrap().with_converter(Arc::new(Installed(tools.clone(), spec)));
    let item = run(adapter.capture(&Target::File(FIXTURE.into()), CaptureOptions::default())).unwrap();
    assert_eq!(item.extras["extractor"], "docling");
    assert_eq!(item.body, "## Docling heading\n\n| a | b |\n|---|---|\n| 1 | 2 |");
    assert_eq!(item.title.as_deref(), Some("Kintsugi and the Art of Repair"));
    let logged = std::fs::read_to_string(&log).unwrap();
    assert!(logged.contains("--to md --image-export-mode placeholder --ocr-engine ocrmac --artifacts-path"), "{logged}");
    assert!(logged.contains("offline=1"), "{logged}");

    tools.remove(spec).unwrap();
    assert_eq!(run(tools.ensure(spec)), Err(ToolError::NeedsConsent));
}

#[test]
fn docling_without_consent_asks_for_the_tool() {
    let dir = tempfile::tempdir().unwrap();
    let tools = Arc::new(crate::tools::Tools::new(dir.path().join("tools")).unwrap());
    assert_eq!(run(Docling::new(tools).convert(Path::new(FIXTURE))), Err(Error::ToolNeeded));
}

/// Compiles `swift/pdf.swift` and reads the fixture with real PDFKit. Skips
/// where there is no Swift toolchain (not macOS, no Xcode tools).
#[test]
fn pdfkit_helper_reads_the_fixture() {
    if !cfg!(target_os = "macos") {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let program = dir.path().join("kintsugi-pdf");
    let target = if cfg!(target_arch = "aarch64") { "arm64-apple-macos13.0" } else { "x86_64-apple-macos13.0" };
    let built = std::process::Command::new("xcrun")
        .args(["swiftc", "-O", "-parse-as-library", "-target", target])
        .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/swift/pdf.swift"))
        .arg("-o")
        .arg(&program)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success());
    if !built {
        eprintln!("skipping: no Swift toolchain");
        return;
    }
    let adapter = PdfAdapter::new(Some(Arc::new(PdfKitReader::new(&program)))).unwrap();
    let item = run(adapter.capture(&Target::File(FIXTURE.into()), CaptureOptions { want_media: true })).unwrap();
    assert_eq!(item.body, EXPECTED);
    assert_eq!(item.title.as_deref(), Some("Kintsugi and the Art of Repair"));
    assert_eq!(item.primary_image().unwrap().mime, "image/png");

    let garbage = dir.path().join("garbage.pdf");
    std::fs::write(&garbage, "%PDF-1.4\nnot really").unwrap();
    assert_eq!(run(adapter.capture(&Target::File(garbage), CaptureOptions::default())), Err(Error::Unavailable));
}

/// Downloads uv and Docling (about 1.5 GB, with Python and the layout and
/// table models) into `target/live-tools/` and converts the fixture.
#[test]
#[ignore = "downloads uv, Python, Docling and its models"]
fn live_docling() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/live-tools");
    let tools = Arc::new(crate::tools::Tools::new(root).unwrap());
    tools.grant(&catalog::UV).unwrap();
    tools.grant(&catalog::DOCLING).unwrap();
    let markdown = run(Docling::new(tools).convert(Path::new(FIXTURE))).unwrap();
    println!("{markdown}");
    assert!(markdown.contains("golden seam"), "{markdown}");
}
