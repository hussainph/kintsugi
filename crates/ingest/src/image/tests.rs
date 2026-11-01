//! A fake reader for the item's shape, fake helper scripts for the protocol,
//! and (on a Mac with a Swift toolchain) the real Vision helper.

use super::*;
use crate::test_server::run;
use std::process::Stdio;

const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/image/seams.png");

struct Fake(ImageText);

impl ImageReader for Fake {
    fn read<'a>(&'a self, _: &'a Path) -> BoxFuture<'a, Result<ImageText>> {
        let text = self.0.clone();
        Box::pin(async move { Ok(text) })
    }
}

fn label(label: &str, confidence: f64) -> Label {
    Label { label: label.into(), confidence }
}

#[test]
fn recognised_text_and_labels_are_labelled_machine_made() {
    let reader = Fake(ImageText {
        width: 800,
        height: 600,
        lines: vec!["Golden  seams".into(), "# Repair is <the> story".into(), "  ".into()],
        labels: vec![label("bowl", 0.4), label("ceramic", 0.9), label("noise", 0.05), label("Ceramic", 0.5), label("gold_leaf", 0.3)],
    });
    let item = run(ImageAdapter::new(Arc::new(reader)).capture(&Target::File(FIXTURE.into()), CaptureOptions::default())).unwrap();
    assert_eq!(item.source, SourceType::Image);
    assert!(item.id.starts_with("image:sha256:"), "{}", item.id);
    assert_eq!(
        item.body,
        "_Text recognised in the image on this Mac (machine-made, may contain errors):_\n\n\
         Golden seams  \n\\# Repair is \\<the> story\n\n\
         _What the image shows, as guessed on this Mac (machine-made):_ ceramic, bowl, gold leaf"
    );
    assert_eq!(item.extras["machine"], true);
    assert_eq!(item.extras["extractor"], "vision");
    assert_eq!(item.extras["labels"], json!(["ceramic", "bowl", "gold leaf"]));
    assert_eq!(item.extras["ocrLines"], 2);
    assert_eq!(item.title, None);
}

#[test]
fn a_picture_with_nothing_recognised_has_an_empty_body() {
    let item = run(ImageAdapter::new(Arc::new(Fake(ImageText::default()))).capture_file(Path::new(FIXTURE))).unwrap();
    assert_eq!(item.body, "");
    assert!(!item.extras.contains_key("labels"));
}

#[test]
fn only_image_files_match() {
    let adapter = ImageAdapter::new(Arc::new(Fake(ImageText::default())));
    assert!(adapter.matches(&Target::File("/x/media/a.PNG".into())));
    assert!(adapter.matches(&Target::File("/x/media/a.heic".into())));
    assert!(!adapter.matches(&Target::File("/x/files/a.pdf".into())));
    assert!(!adapter.matches(&Target::url("https://example.org/a.png").unwrap()));
}

#[cfg(unix)]
#[test]
fn the_helper_protocol_is_json_on_stdout_and_exit_codes() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let script = |name: &str, body: &str| {
        let path = dir.path().join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    };
    let ok = script("ok", r#"echo '{"width":2,"height":1,"lines":["hi"],"labels":[{"label":"sky","confidence":0.5}]}'"#);
    let read = run(VisionReader::new(ok).read(Path::new(FIXTURE))).unwrap();
    assert_eq!(read.lines, ["hi"]);
    assert_eq!(read.labels, [label("sky", 0.5)]);
    let stub = script("stub", "echo 'unsupported' >&2; exit 3");
    assert_eq!(run(VisionReader::new(stub).read(Path::new(FIXTURE))), Err(Error::Unsupported));
    let broken = script("broken", "exit 5");
    assert_eq!(run(VisionReader::new(broken).read(Path::new(FIXTURE))), Err(Error::Unavailable));
    let slow = script("slow", "sleep 5");
    let reader = VisionReader::new(slow).with_timeout(Duration::from_millis(200));
    assert_eq!(run(reader.read(Path::new(FIXTURE))), Err(Error::TimedOut));
}

/// Compiles `swift/vision.swift` and reads the fixture with real Vision.
/// Skips where there is no Swift toolchain (not macOS, no Xcode tools).
#[test]
fn vision_helper_reads_the_fixture() {
    if !cfg!(target_os = "macos") {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let program = dir.path().join("kintsugi-vision");
    let target = if cfg!(target_arch = "aarch64") { "arm64-apple-macos13.0" } else { "x86_64-apple-macos13.0" };
    let built = std::process::Command::new("xcrun")
        .args(["swiftc", "-O", "-parse-as-library", "-target", target])
        .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/swift/vision.swift"))
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
    let adapter = ImageAdapter::new(Arc::new(VisionReader::new(&program)));
    let item = run(adapter.capture(&Target::File(FIXTURE.into()), CaptureOptions::default())).unwrap();
    assert!(item.body.contains("Golden seams"), "{}", item.body);
    assert!(item.body.contains("\\# Repair is the story"), "{}", item.body);
    let garbage = dir.path().join("garbage.png");
    std::fs::write(&garbage, "not an image").unwrap();
    assert_eq!(run(adapter.capture_file(&garbage)), Err(Error::Unavailable));
}
