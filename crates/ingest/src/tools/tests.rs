//! A fake GitHub release on a loopback server; nothing is downloaded from
//! the internet.

use super::*;
use crate::test_http::{Server, run};
use sha2::{Digest, Sha256};

fn platform() -> &'static str {
    Box::leak(format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH).into_boxed_str())
}

fn spec(checksums: Checksums, archive: Archive) -> ToolSpec {
    let assets: &'static [(&'static str, &'static str)] =
        Box::leak(vec![(platform(), "tool_bin"), ("plan9-mips", "tool_plan9")].into_boxed_slice());
    ToolSpec {
        id: "fake-tool",
        name: "Fake tool",
        purpose: "testing",
        homepage: "https://example.org",
        license: "MIT",
        source: ToolSource::GitHubRelease { repo: "owner/fake", checksums },
        assets,
        archive,
        entry: "fake-tool",
        executable: true,
        max_bytes: 1024 * 1024,
        approx_bytes: 10,
        update_every: None,
    }
}

fn sha(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn release_json(tag: &str, extra: &[&str]) -> Vec<u8> {
    let mut assets = vec![
        format!(r#"{{"name":"tool_bin","browser_download_url":"{{base}}/dl/{tag}/tool_bin"}}"#),
        format!(r#"{{"name":"SUMS","browser_download_url":"{{base}}/dl/{tag}/SUMS"}}"#),
    ];
    assets.extend(extra.iter().map(|name| format!(r#"{{"name":"{name}","browser_download_url":"{{base}}/dl/{tag}/{name}"}}"#)));
    format!(r#"{{"tag_name":"{tag}","assets":[{}]}}"#, assets.join(",")).into_bytes()
}

fn release(tag: &str, binary: &[u8], sums_hash: &str) -> Vec<(&'static str, u16, &'static str, Vec<u8>)> {
    let leak = |s: String| -> &'static str { Box::leak(s.into_boxed_str()) };
    vec![
        ("/repos/owner/fake/releases/latest", 200, "application/json", release_json(tag, &[])),
        (leak(format!("/dl/{tag}/tool_bin")), 200, "application/octet-stream", binary.to_vec()),
        (
            leak(format!("/dl/{tag}/SUMS")),
            200,
            "text/plain",
            format!("{}  other_file\n{sums_hash}  tool_bin\n", "0".repeat(64)).into_bytes(),
        ),
    ]
}

fn tools(server: &Server) -> (tempfile::TempDir, Tools) {
    let dir = tempfile::tempdir().unwrap();
    let tools = Tools::new(dir.path().join("tools")).unwrap().with_github_api(&server.base);
    (dir, tools)
}

#[test]
fn nothing_downloads_without_consent() {
    let binary = b"#!/bin/sh\necho hi\n";
    let server = Server::start(release("v1", binary, &sha(binary)));
    let (_dir, tools) = tools(&server);
    let spec = spec(Checksums::SumsFile("SUMS"), Archive::None);
    assert_eq!(run(tools.ensure(&spec)), Err(ToolError::NeedsConsent));
    assert_eq!(run(tools.install(&spec)), Err(ToolError::NeedsConsent));
    assert_eq!(server.hits("/repos/owner/fake/releases/latest"), 0);
    let status = tools.status(&spec);
    assert!(status.supported && !status.consented && status.installed.is_none() && status.path.is_none());
}

#[test]
fn a_consented_tool_installs_on_first_need_with_a_verified_checksum() {
    let binary = b"#!/bin/sh\necho hi\n";
    let server = Server::start(release("v1.2", binary, &sha(binary)));
    let (_dir, tools) = tools(&server);
    let spec = spec(Checksums::SumsFile("SUMS"), Archive::None);
    tools.grant(&spec).unwrap();
    let path = run(tools.ensure(&spec)).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), binary);
    assert!(path.ends_with("fake-tool/v1.2/fake-tool"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o755);
    }
    let status = tools.status(&spec);
    assert_eq!(status.installed.as_ref().unwrap().version, "v1.2");
    assert_eq!(status.installed.unwrap().sha256, sha(binary));
    assert_eq!(status.latest.as_deref(), Some("v1.2"));
    // Installed: the next ensure does no network at all.
    assert_eq!(run(tools.ensure(&spec)).unwrap(), path);
    assert_eq!(server.hits("/dl/v1.2/tool_bin"), 1);
}

#[test]
fn a_checksum_mismatch_discards_the_download() {
    let server = Server::start(release("v1", b"tampered", &sha(b"original")));
    let (_dir, tools) = tools(&server);
    let spec = spec(Checksums::SumsFile("SUMS"), Archive::None);
    tools.grant(&spec).unwrap();
    assert_eq!(run(tools.install(&spec)), Err(ToolError::ChecksumMismatch));
    assert!(tools.path(&spec).is_none());
    let leftovers: Vec<_> = std::fs::read_dir(tools.root().join("fake-tool"))
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(leftovers, vec!["tool.json".to_string()]);
}

#[test]
fn oversized_downloads_are_refused() {
    let big = vec![b'x'; 2048];
    let server = Server::start(release("v1", &big, &sha(&big)));
    let (_dir, tools) = tools(&server);
    let mut spec = spec(Checksums::SumsFile("SUMS"), Archive::None);
    spec.max_bytes = 1024;
    tools.grant(&spec).unwrap();
    assert_eq!(run(tools.install(&spec)), Err(ToolError::TooLarge));
}

#[test]
fn per_asset_checksums_and_zip_archives() {
    let binary = b"\x7fELF fake deno".to_vec();
    let mut zipped = Vec::new();
    {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut zipped));
        zip.start_file("bin/fake-tool", zip::write::SimpleFileOptions::default()).unwrap();
        std::io::Write::write_all(&mut zip, &binary).unwrap();
        zip.finish().unwrap();
    }
    let server = Server::start(vec![
        ("/repos/owner/fake/releases/latest", 200, "application/json", release_json("v2.0.0", &["tool_bin.sha256sum"])),
        ("/dl/v2.0.0/tool_bin", 200, "application/zip", zipped.clone()),
        ("/dl/v2.0.0/tool_bin.sha256sum", 200, "text/plain", format!("{}  tool_bin\n", sha(&zipped)).into_bytes()),
    ]);
    let (_dir, tools) = tools(&server);
    let spec = spec(Checksums::PerAsset(".sha256sum"), Archive::Zip);
    tools.grant(&spec).unwrap();
    let path = run(tools.ensure(&spec)).unwrap();
    assert_eq!(std::fs::read(path).unwrap(), binary);
}

#[test]
fn github_recorded_digests_verify_downloads() {
    let binary = b"digest checked".to_vec();
    let json = format!(
        r#"{{"tag_name":"v3","assets":[{{"name":"tool_bin","browser_download_url":"{{base}}/dl/v3/tool_bin","digest":"sha256:{}"}}]}}"#,
        sha(&binary)
    );
    let server = Server::start(vec![
        ("/repos/owner/fake/releases/latest", 200, "application/json", json.into_bytes()),
        ("/dl/v3/tool_bin", 200, "application/octet-stream", binary.clone()),
    ]);
    let (_dir, tools) = tools(&server);
    let spec = spec(Checksums::GitHubDigest, Archive::None);
    tools.grant(&spec).unwrap();
    assert_eq!(std::fs::read(run(tools.ensure(&spec)).unwrap()).unwrap(), binary);
}

#[test]
fn stale_tools_update_and_old_versions_are_removed() {
    let old = b"old".to_vec();
    let server = Server::start(release("v1", &old, &sha(&old)));
    let (_dir, tools) = tools(&server);
    let mut spec = spec(Checksums::SumsFile("SUMS"), Archive::None);
    spec.update_every = Some(Duration::from_secs(3600));
    tools.grant(&spec).unwrap();
    let first = run(tools.ensure(&spec)).unwrap();

    // A recent check means no network, even though a new release exists.
    let new = b"new".to_vec();
    let next = Server::start(release("v2", &new, &sha(&new)));
    let tools = Tools::new(tools.root().to_path_buf()).unwrap().with_github_api(&next.base);
    assert_eq!(run(tools.ensure(&spec)).unwrap(), first);
    assert_eq!(next.hits("/repos/owner/fake/releases/latest"), 0);

    // A failure (or an old check) asks again and installs the new release.
    let path = run(tools.update_if_stale(&spec, Duration::ZERO)).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), new);
    assert!(!first.exists(), "the old version is removed");
    assert_eq!(tools.status(&spec).installed.unwrap().version, "v2");
}

#[test]
fn a_failed_update_keeps_the_working_version() {
    let binary = b"works".to_vec();
    let server = Server::start(release("v1", &binary, &sha(&binary)));
    let (_dir, tools) = tools(&server);
    let mut spec = spec(Checksums::SumsFile("SUMS"), Archive::None);
    spec.update_every = Some(Duration::ZERO);
    tools.grant(&spec).unwrap();
    let path = run(tools.install(&spec)).map(|_| tools.path(&spec).unwrap()).unwrap();
    let offline = Tools::new(tools.root().to_path_buf()).unwrap().with_github_api("http://127.0.0.1:9");
    assert_eq!(run(offline.ensure(&spec)).unwrap(), path);
    assert_eq!(run(offline.update_if_stale(&spec, Duration::ZERO)), Err(ToolError::Unavailable));
    assert_eq!(std::fs::read(&path).unwrap(), binary);
}

#[test]
fn platforms_without_an_asset_and_removal() {
    let server = Server::start(vec![]);
    let (_dir, tools) = tools(&server);
    let mut spec = spec(Checksums::SumsFile("SUMS"), Archive::None);
    spec.assets = &[("plan9-mips", "tool_plan9")];
    assert!(!tools.status(&spec).supported);
    tools.grant(&spec).unwrap();
    assert_eq!(run(tools.install(&spec)), Err(ToolError::UnsupportedPlatform));
    tools.remove(&spec).unwrap();
    assert!(!tools.status(&spec).consented);
    tools.remove(&spec).unwrap();
}

#[test]
fn sums_files_and_versions_are_parsed_strictly() {
    let hash = "a".repeat(64);
    assert_eq!(sum_for(&format!("{hash}  yt-dlp_macos\n{}  yt-dlp\n", "b".repeat(64)), "yt-dlp_macos"), Some(hash.clone()));
    assert_eq!(sum_for(&format!("{hash} *tool.zip"), "tool.zip"), Some(hash.clone()));
    assert_eq!(sum_for(&hash, "anything"), Some(hash.clone()));
    assert_eq!(sum_for(&format!("{hash}  other\n"), "tool"), None);
    assert_eq!(sum_for("not-a-hash  tool", "tool"), None);
    assert_eq!(safe_component("2026.10.01"), Some("2026.10.01"));
    for bad in ["", "..", "../x", "a/b", ".hidden"] {
        assert_eq!(safe_component(bad), None, "{bad}");
    }
}

#[test]
fn the_catalog_has_unique_ids_and_yt_dlp_for_this_mac() {
    let mut ids: Vec<_> = catalog::ALL.iter().map(|s| s.id).collect();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), catalog::ALL.len());
    assert!(catalog::by_id("yt-dlp").is_some());
    if cfg!(target_os = "macos") {
        assert_eq!(catalog::YT_DLP.asset(), Some("yt-dlp_macos"));
    }
}

#[test]
fn system_tools_only_record_consent() {
    let server = Server::start(vec![]);
    let (_dir, tools) = tools(&server);
    let spec = &catalog::APPLE_SPEECH;
    assert_eq!(run(tools.ensure(spec)), Err(ToolError::NeedsConsent));
    assert!(!tools.consented(spec));
    tools.grant(spec).unwrap();
    assert!(tools.consented(spec));
    assert_eq!(run(tools.ensure(spec)), Err(ToolError::SystemManaged));
    assert_eq!(run(tools.install(spec)), Err(ToolError::SystemManaged));
    let status = tools.status(spec);
    assert_eq!(status.kind, "system");
    assert_eq!(status.supported, cfg!(target_os = "macos"));
    assert!(status.path.is_none());
}
