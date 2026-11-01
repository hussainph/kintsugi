use std::path::Path;
use std::process::Command;

fn main() {
    swift_helper("transcribe", "podcast transcription");
    swift_helper("pdf", "reading PDFs");
    tauri_build::build()
}

/// Builds a Swift helper from `crates/ingest/swift/<name>.swift` as a Tauri
/// sidecar: `binaries/kintsugi-<name>-<target>`, shipped beside the app
/// binary. `transcribe` is on-device transcription (Apple SpeechAnalyzer);
/// `pdf` reads PDFs with Apple PDFKit. Off macOS, or without a Swift
/// toolchain, a stub that reports "unsupported" (exit 3) takes its place,
/// so podcasts fall back to show notes (and PDFs to Docling, if installed)
/// instead of breaking the build.
fn swift_helper(name: &str, purpose: &str) {
    let source = Path::new("../../../crates/ingest/swift").join(format!("{name}.swift"));
    let source = source.as_path();
    println!("cargo:rerun-if-changed={}", source.display());
    let target = std::env::var("TARGET").expect("cargo sets TARGET");
    let out = Path::new("binaries").join(format!("kintsugi-{name}-{target}"));
    std::fs::create_dir_all("binaries").expect("create binaries/");
    let fresh = match (std::fs::metadata(&out).and_then(|m| m.modified()), std::fs::metadata(source).and_then(|m| m.modified())) {
        (Ok(built), Ok(changed)) => built >= changed,
        _ => false,
    };
    if fresh {
        return;
    }
    let swift_target = match target.as_str() {
        "aarch64-apple-darwin" => Some("arm64-apple-macos13.0"),
        "x86_64-apple-darwin" => Some("x86_64-apple-macos13.0"),
        _ => None,
    };
    let built = swift_target.is_some_and(|swift_target| {
        Command::new("xcrun")
            .args(["swiftc", "-O", "-parse-as-library", "-target", swift_target])
            .arg(source)
            .arg("-o")
            .arg(&out)
            .status()
            .is_ok_and(|status| status.success())
    });
    if !built {
        println!("cargo:warning=kintsugi-{name} was not built; {purpose} is unavailable in this build");
        std::fs::write(&out, format!("#!/bin/sh\necho '{purpose} is not available in this build' >&2\nexit 3\n"))
            .expect("write the helper stub");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&out, std::fs::Permissions::from_mode(0o755)).expect("chmod the helper stub");
        }
    }
}
