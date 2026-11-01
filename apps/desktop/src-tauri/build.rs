use std::path::Path;
use std::process::Command;

fn main() {
    transcription_helper();
    tauri_build::build()
}

/// Builds `kintsugi-transcribe`, the on-device transcription helper
/// (`crates/ingest/swift/transcribe.swift`, Apple SpeechAnalyzer), as a Tauri
/// sidecar: `binaries/kintsugi-transcribe-<target>`, shipped beside the app
/// binary. Off macOS, or without a Swift toolchain, a stub that reports
/// "unsupported" (exit 3) takes its place, so podcasts fall back to show
/// notes instead of breaking the build.
fn transcription_helper() {
    let source = Path::new("../../../crates/ingest/swift/transcribe.swift");
    println!("cargo:rerun-if-changed={}", source.display());
    let target = std::env::var("TARGET").expect("cargo sets TARGET");
    let out = Path::new("binaries").join(format!("kintsugi-transcribe-{target}"));
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
        println!("cargo:warning=kintsugi-transcribe was not built; podcast transcription is unavailable in this build");
        std::fs::write(&out, "#!/bin/sh\necho 'on-device transcription is not available in this build' >&2\nexit 3\n")
            .expect("write the helper stub");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&out, std::fs::Permissions::from_mode(0o755)).expect("chmod the helper stub");
        }
    }
}
