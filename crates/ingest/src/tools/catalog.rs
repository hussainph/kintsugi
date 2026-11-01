//! The optional tools Kintsugi knows how to fetch. Add a tool by adding a
//! spec here; [`ALL`] is what Settings lists.

use super::{Archive, Checksums, ToolSource, ToolSpec};
use std::time::Duration;

/// yt-dlp's standalone build. YouTube changes often (PO tokens, player
/// changes), so it checks for a new release at most daily, and adapters
/// retry once with a fresh release after a failure.
pub const YT_DLP: ToolSpec = ToolSpec {
    id: "yt-dlp",
    name: "yt-dlp",
    purpose: "YouTube transcripts",
    homepage: "https://github.com/yt-dlp/yt-dlp",
    license: "Unlicense",
    source: ToolSource::GitHubRelease { repo: "yt-dlp/yt-dlp", checksums: Checksums::SumsFile("SHA2-256SUMS") },
    assets: &[
        ("macos-aarch64", "yt-dlp_macos"),
        ("macos-x86_64", "yt-dlp_macos"),
        ("linux-x86_64", "yt-dlp_linux"),
        ("linux-aarch64", "yt-dlp_linux_aarch64"),
        ("windows-x86_64", "yt-dlp.exe"),
    ],
    archive: Archive::None,
    entry: "yt-dlp",
    executable: true,
    max_bytes: 200 * 1024 * 1024,
    approx_bytes: 35 * 1024 * 1024,
    update_every: Some(Duration::from_secs(24 * 60 * 60)),
};

/// Deno, the JavaScript runtime yt-dlp needs for full YouTube support
/// since 2025.11 (it solves YouTube's player challenges with it). Installed
/// alongside yt-dlp and passed with `--js-runtimes deno:<path>`.
pub const DENO: ToolSpec = ToolSpec {
    id: "deno",
    name: "Deno",
    purpose: "Lets yt-dlp read YouTube's player",
    homepage: "https://deno.com",
    license: "MIT",
    source: ToolSource::GitHubRelease { repo: "denoland/deno", checksums: Checksums::PerAsset(".sha256sum") },
    assets: &[
        ("macos-aarch64", "deno-aarch64-apple-darwin.zip"),
        ("macos-x86_64", "deno-x86_64-apple-darwin.zip"),
        ("linux-x86_64", "deno-x86_64-unknown-linux-gnu.zip"),
        ("linux-aarch64", "deno-aarch64-unknown-linux-gnu.zip"),
    ],
    archive: Archive::Zip,
    entry: "deno",
    executable: true,
    max_bytes: 200 * 1024 * 1024,
    approx_bytes: 40 * 1024 * 1024,
    update_every: Some(Duration::from_secs(7 * 24 * 60 * 60)),
};

/// Apple's on-device speech model for podcast transcription
/// (SpeechAnalyzer, macOS 26+). macOS downloads and updates it per
/// language, shared with other apps; Kintsugi only asks it to once the
/// person agreed. The assets entry lists where it exists; there is no file.
pub const APPLE_SPEECH: ToolSpec = ToolSpec {
    id: "apple-speech",
    name: "Apple speech model",
    purpose: "Podcast transcription on this Mac",
    homepage: "https://developer.apple.com/documentation/speech/speechanalyzer",
    license: "Apple (part of macOS)",
    source: ToolSource::System,
    assets: &[("macos-aarch64", ""), ("macos-x86_64", "")],
    archive: Archive::None,
    entry: "",
    executable: false,
    max_bytes: 0,
    approx_bytes: 0,
    update_every: None,
};

/// Every tool, in the order Settings shows them.
pub const ALL: &[&ToolSpec] = &[&YT_DLP, &DENO, &APPLE_SPEECH];

pub fn by_id(id: &str) -> Option<&'static ToolSpec> {
    ALL.iter().copied().find(|spec| spec.id == id)
}
