//! Reusable lexical clip search and a narrow, byte-only image boundary.
//! Clip contents are read once per vault, then only for paths invalidated by a
//! clip mutation. Source text is searchable, but never returned in a card preview.

use crate::vault::Vault;
use kintsugi_vault::{self as vault, Clip, ClipCapture, ClipSummary, ClipVia};
use serde::Serialize;
use std::collections::{BTreeSet, HashMap};
use std::fs::File;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use crate::AppHandle;
use tauri::State;

type Result<T> = std::result::Result<T, String>;
const PREVIEW_CHARS: usize = 600;
const DEFAULT_LIMIT: usize = 60;
const MAX_LIMIT: usize = 120;

#[derive(Clone, Debug, Serialize)]
pub struct ClipPreview {
    #[serde(flatten)]
    pub summary: ClipSummary,
    /// Own text only, truncated on a Unicode character boundary.
    pub text: String,
}

#[derive(Debug, Serialize)]
pub struct ClipSearch {
    pub clips: Vec<ClipPreview>,
    pub total: usize,
    /// All tags in the vault, not just those on the current page or matches.
    pub tags: Vec<String>,
}

struct IndexedClip {
    preview: ClipPreview,
    searchable: String,
}

impl IndexedClip {
    fn new(clip: Clip) -> Self {
        let mut fields = vec![
            clip.summary.title.as_deref().unwrap_or_default(),
            clip.summary.summary.as_deref().unwrap_or_default(),
            clip.summary.site.as_deref().unwrap_or_default(),
            clip.summary.url.as_deref().unwrap_or_default(),
            &clip.text,
            clip.source.as_deref().unwrap_or_default(),
        ];
        fields.extend(clip.summary.tags.iter().map(String::as_str));
        let searchable = fields.join("\n").to_lowercase();
        Self {
            searchable,
            preview: ClipPreview {
                text: clip.text.chars().take(PREVIEW_CHARS).collect(),
                summary: clip.summary,
            },
        }
    }
}

#[derive(Default)]
struct Index {
    clips: Vec<IndexedClip>,
    tags: Vec<String>,
    dirty: BTreeSet<String>,
}

impl Index {
    fn load(root: &Path) -> Result<Self> {
        // Use the storage layer's validation and malformed-file tolerance. The
        // extra read is a one-time cost; cached searches don't reread clips.
        let clips = vault::clip_list(root)?
            .into_iter()
            .filter_map(|summary| vault::clip_read(root, &summary.path).ok())
            .map(IndexedClip::new)
            .collect();
        let mut index = Self {
            clips,
            ..Self::default()
        };
        index.sort_and_tags();
        Ok(index)
    }

    fn refresh(&mut self, root: &Path) {
        for path in std::mem::take(&mut self.dirty) {
            self.clips.retain(|clip| clip.preview.summary.path != path);
            if let Ok(clip) = vault::clip_read(root, &path) {
                self.clips.push(IndexedClip::new(clip));
            }
        }
        self.sort_and_tags();
    }

    fn sort_and_tags(&mut self) {
        self.clips.sort_by(|a, b| {
            b.preview
                .summary
                .captured
                .cmp(&a.preview.summary.captured)
                .then_with(|| a.preview.summary.path.cmp(&b.preview.summary.path))
        });
        self.tags = self
            .clips
            .iter()
            .flat_map(|clip| clip.preview.summary.tags.iter().cloned())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
    }

    fn search(
        &self,
        query: Option<&str>,
        tags: &[String],
        offset: usize,
        limit: usize,
    ) -> ClipSearch {
        let terms = query
            .unwrap_or_default()
            .split_whitespace()
            .map(str::to_lowercase)
            .collect::<Vec<_>>();
        let tags = tags
            .iter()
            .map(|tag| tag.trim().to_lowercase())
            .collect::<Vec<_>>();
        let mut total = 0;
        let mut clips = Vec::new();
        for clip in &self.clips {
            if !terms.iter().all(|term| clip.searchable.contains(term))
                || !tags
                    .iter()
                    .all(|tag| clip.preview.summary.tags.contains(tag))
            {
                continue;
            }
            if total >= offset && clips.len() < limit {
                clips.push(clip.preview.clone());
            }
            total += 1;
        }
        ClipSearch {
            clips,
            total,
            tags: self.tags.clone(),
        }
    }
}

/// The canonical vault root is part of every cache key. Switching vaults can
/// never reuse another vault's clips, even when clip paths happen to match.
#[derive(Clone, Default)]
pub struct Library {
    indexes: Arc<Mutex<HashMap<PathBuf, Index>>>,
    changed: Arc<Mutex<BTreeSet<String>>>,
}

impl Library {
    pub fn invalidate(&self, path: &str) {
        // A separate queue means an event never waits for a large index build.
        // The event carries no root: a phone write can finish after a switch.
        // Search applies it within each cached root, never mixing their data.
        if let Ok(mut changed) = self.changed.lock() {
            changed.insert(path.to_owned());
        }
    }

    fn search(
        &self,
        root: &Path,
        query: Option<&str>,
        tags: &[String],
        offset: Option<usize>,
        limit: Option<usize>,
    ) -> Result<ClipSearch> {
        let root = root
            .canonicalize()
            .map_err(|_| "could not open library vault")?;
        let mut indexes = self.indexes.lock().map_err(|_| "library unavailable")?;
        let changed = std::mem::take(&mut *self.changed.lock().map_err(|_| "library unavailable")?);
        for index in indexes.values_mut() {
            index.dirty.extend(changed.iter().cloned());
        }
        if !indexes.contains_key(&root) {
            indexes.insert(root.clone(), Index::load(&root)?);
        }
        let index = indexes.get_mut(&root).expect("inserted vault index");
        if !index.dirty.is_empty() {
            index.refresh(&root);
        }
        Ok(index.search(
            query,
            tags,
            offset.unwrap_or(0),
            limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT),
        ))
    }
}

#[tauri::command]
pub async fn clip_search(
    vault: State<'_, Vault>,
    library: State<'_, Library>,
    query: Option<String>,
    tags: Option<Vec<String>>,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<ClipSearch> {
    let root = vault.root()?;
    let library = library.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        library.search(
            &root,
            query.as_deref(),
            &tags.unwrap_or_default(),
            offset,
            limit,
        )
    })
    .await
    .map_err(|_| "library search task failed")?
}

/// Only a clip path is accepted, never an arbitrary media or absolute path.
#[tauri::command]
pub async fn clip_image(vault: State<'_, Vault>, path: String) -> Result<tauri::ipc::Response> {
    let root = vault.root()?;
    tauri::async_runtime::spawn_blocking(move || primary_image(&root, &path))
        .await
        .map_err(|_| "clip image task failed")?
        .map(tauri::ipc::Response::new)
}

fn primary_image(root: &Path, path: &str) -> Result<Vec<u8>> {
    let root = root
        .canonicalize()
        .map_err(|_| "could not open library vault")?;
    let clip = vault::clip_read(&root, path)?;
    let image = clip.summary.image.ok_or("clip has no primary image")?;
    let target = vault::clip_media_path(&root, path, &image)?;
    read_raster(&target).map(|(bytes, _)| bytes)
}

/// Native file drops are read by Rust, never by an asset-protocol permission.
/// The normal capture path owns naming, writes and the shared change event.
#[tauri::command]
pub async fn clip_capture_image(
    app: AppHandle,
    vault: State<'_, Vault>,
    path: String,
    captured_at: String,
) -> Result<String> {
    let root = vault.root()?;
    tauri::async_runtime::spawn_blocking(move || {
        let capture = image_capture(Path::new(&path), captured_at)?;
        let path = vault::clip_create(&root, &capture)?;
        crate::vault::clips_changed(&app, &path);
        Ok(path)
    })
    .await
    .map_err(|_| "image capture task failed")?
}

fn image_capture(path: &Path, captured_at: String) -> Result<ClipCapture> {
    let (bytes, mime) = read_raster(path)?;
    Ok(ClipCapture {
        url: None,
        text: None,
        note: None,
        title: None,
        image: Some(bytes),
        image_type: Some(mime.into()),
        captured_at,
        via: ClipVia::Mac,
    })
}

fn extension_mime(path: &Path) -> Result<&'static str> {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => Ok("image/jpeg"),
        "png" => Ok("image/png"),
        "gif" => Ok("image/gif"),
        "webp" => Ok("image/webp"),
        "heic" => Ok("image/heic"),
        "heif" => Ok("image/heif"),
        "avif" => Ok("image/avif"),
        _ => Err("unsupported clip image type".into()),
    }
}

/// A signature allowlist is intentionally narrower than trusting an extension
/// or supplied MIME type. It is not a full image decoder.
fn signature_matches(bytes: &[u8], mime: &str) -> bool {
    match mime {
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
        "image/heic" | "image/heif" | "image/avif" => {
            if bytes.get(4..8) != Some(b"ftyp") || bytes.len() < 16 {
                return false;
            }
            let size = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
            if size < 16 || size > bytes.len() || size % 4 != 0 {
                return false;
            }
            let allowed: &[&[u8]] = match mime {
                "image/heic" => &[b"heic", b"heix", b"hevc", b"hevx"],
                "image/heif" => &[b"mif1", b"msf1", b"heic", b"heix"],
                _ => &[b"avif", b"avis"],
            };
            std::iter::once(&bytes[8..12])
                .chain(bytes[16..size].chunks_exact(4))
                .any(|brand| allowed.contains(&brand))
        }
        _ => false,
    }
}

fn read_raster(path: &Path) -> Result<(Vec<u8>, &'static str)> {
    let mime = extension_mime(path)?;
    let file = open_regular_file(path)?;
    let size = file
        .metadata()
        .map_err(|_| "could not inspect clip image")?
        .len();
    if size == 0 || size > vault::MAX_CLIP_IMAGE_BYTES as u64 {
        return Err("clip images must be between 1 byte and 15 MiB".into());
    }
    let mut bytes = Vec::new();
    // Bound the actual read too, in case the file grows after metadata().
    file.take(vault::MAX_CLIP_IMAGE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "could not read clip image")?;
    if bytes.len() > vault::MAX_CLIP_IMAGE_BYTES || !signature_matches(&bytes, mime) {
        return Err("invalid or oversized clip image".into());
    }
    Ok((bytes, mime))
}

/// Walk from an open directory descriptor, refusing symlinks at every step.
/// Unlike a check-then-open sequence this also resists symlink replacement
/// between validation and reading. O_NONBLOCK prevents a dropped FIFO hanging
/// the command before its regular-file check.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn open_regular_file(path: &Path) -> Result<File> {
    use std::ffi::{CString, c_char, c_int};
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;

    #[cfg(target_os = "macos")]
    const NOFOLLOW: c_int = 0x100;
    #[cfg(target_os = "macos")]
    const CLOEXEC: c_int = 0x1000000;
    #[cfg(target_os = "macos")]
    const DIRECTORY: c_int = 0x100000;
    #[cfg(target_os = "macos")]
    const NONBLOCK: c_int = 0x4;
    #[cfg(target_os = "linux")]
    const NOFOLLOW: c_int = 0o400000;
    #[cfg(target_os = "linux")]
    const CLOEXEC: c_int = 0o2000000;
    #[cfg(target_os = "linux")]
    const DIRECTORY: c_int = 0o200000;
    #[cfg(target_os = "linux")]
    const NONBLOCK: c_int = 0o4000;

    unsafe extern "C" {
        fn openat(fd: c_int, path: *const c_char, flags: c_int, ...) -> c_int;
    }

    let parts = path.components().collect::<Vec<_>>();
    if !path.is_absolute()
        || parts.len() < 2
        || parts[0] != Component::RootDir
        || parts[1..]
            .iter()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("image needs an absolute path without traversal".into());
    }
    let mut file = File::open("/").map_err(|_| "could not open image directory")?;
    for (index, part) in parts[1..].iter().enumerate() {
        let Component::Normal(name) = part else {
            unreachable!()
        };
        let name = CString::new(name.as_bytes()).map_err(|_| "invalid image path")?;
        let last = index == parts.len() - 2;
        let flags = NOFOLLOW | CLOEXEC | if last { NONBLOCK } else { DIRECTORY };
        // SAFETY: file owns a live directory fd, name is NUL-terminated, and
        // flags never create a file (so openat needs no mode argument).
        let fd = unsafe { openat(file.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err("could not open image without following symlinks".into());
        }
        // SAFETY: openat returned a new, owned descriptor on success.
        file = unsafe { File::from_raw_fd(fd) };
    }
    if !file
        .metadata()
        .map_err(|_| "could not inspect clip image")?
        .is_file()
    {
        return Err("image must be a regular file".into());
    }
    Ok(file)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn open_regular_file(_path: &Path) -> Result<File> {
    Err("secure image file loading is unavailable on this platform".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn capture(text: &str) -> ClipCapture {
        ClipCapture {
            url: None,
            text: Some(text.into()),
            note: None,
            title: None,
            image: None,
            image_type: None,
            captured_at: "2026-10-29T14:05".into(),
            via: ClipVia::Mac,
        }
    }

    fn search(library: &Library, root: &Path, query: &str, tags: &[&str]) -> ClipSearch {
        library
            .search(
                root,
                Some(query),
                &tags.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
                None,
                None,
            )
            .unwrap()
    }

    #[test]
    fn searches_every_field_with_case_insensitive_whitespace_and_terms() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let path = vault::clip_create(
            root,
            &ClipCapture {
                title: Some("Quiet CRAFT".into()),
                url: Some("https://example.org/Needle".into()),
                ..capture("Own words")
            },
        )
        .unwrap();
        vault::clip_update(
            root,
            &path,
            &vault::ClipUpdate {
                summary: Some("Repairing porcelain".into()),
                site: Some("The Journal".into()),
                tags: Some(vec!["attention".into(), "art".into()]),
                source: Some("Hidden source passage".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let library = Library::default();
        for query in [
            "craft",
            "PORCELAIN",
            "journal",
            "attention",
            "own",
            "hidden",
            "needle",
            "example.org",
            "CrAfT \n hidden\tOWN",
        ] {
            assert_eq!(search(&library, root, query, &[]).total, 1, "{query}");
        }
        assert_eq!(search(&library, root, "craft absent", &[]).total, 0);
        assert_eq!(search(&library, root, "", &["ATTENTION", "art"]).total, 1);
        assert_eq!(search(&library, root, "", &["art", "missing"]).total, 0);
        assert_eq!(
            search(&library, root, "", &["att"]).total,
            0,
            "tags are exact, not substring matches"
        );
        let result = search(&library, root, "hidden", &[]);
        assert_eq!(result.tags, ["art", "attention"]);
        assert_eq!(result.clips[0].text, "> Own words");
        let json = serde_json::to_value(&result.clips[0]).unwrap();
        assert_eq!(json["path"], path);
        assert!(json.get("summary").unwrap().is_string());
        assert!(json.get("source").is_none());
        assert!(!json.to_string().contains("Hidden source passage"));
        assert_eq!(
            search(&library, root, "nothing", &[]).tags,
            ["art", "attention"]
        );
    }

    #[test]
    fn newest_order_stable_ties_and_bounded_pagination_match_clip_list() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for n in 0..125 {
            vault::clip_create(
                root,
                &ClipCapture {
                    title: Some(format!("Clip {n:03}")),
                    captured_at: if n < 3 {
                        "2026-10-30T10:00"
                    } else {
                        "2026-10-29T14:05"
                    }
                    .into(),
                    ..capture("text")
                },
            )
            .unwrap();
        }
        let library = Library::default();
        let all = vault::clip_list(root).unwrap();
        let first = library.search(root, None, &[], None, None).unwrap();
        assert_eq!(first.total, 125);
        assert_eq!(first.clips.len(), 60);
        assert_eq!(
            first
                .clips
                .iter()
                .map(|c| &c.summary.path)
                .collect::<Vec<_>>(),
            all[..60].iter().map(|c| &c.path).collect::<Vec<_>>()
        );
        let second = library
            .search(root, None, &[], Some(60), Some(500))
            .unwrap();
        assert_eq!(second.clips.len(), 65);
        assert_eq!(second.clips[0].summary.path, all[60].path);
        assert_eq!(
            library
                .search(root, None, &[], None, Some(500))
                .unwrap()
                .clips
                .len(),
            120
        );
        assert_eq!(
            library
                .search(root, None, &[], None, Some(0))
                .unwrap()
                .clips
                .len(),
            1
        );
        assert!(
            library
                .search(root, None, &[], Some(usize::MAX), Some(120))
                .unwrap()
                .clips
                .is_empty()
        );
    }

    #[test]
    fn cache_invalidation_refreshes_edits_additions_and_deletions_per_vault() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let library = Library::default();
        let path = vault::clip_create(a.path(), &capture("Original")).unwrap();
        let same_path = vault::clip_create(b.path(), &capture("Original")).unwrap();
        assert_eq!(path, same_path);
        assert_eq!(search(&library, a.path(), "original", &[]).total, 1);
        assert_eq!(search(&library, b.path(), "original", &[]).total, 1);
        vault::clip_update(
            a.path(),
            &path,
            &vault::ClipUpdate {
                note: Some("Updated".into()),
                tags: Some(vec!["new-tag".into()]),
                source: Some("New source".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            search(&library, a.path(), "updated", &[]).total,
            0,
            "search reuses its index until invalidation"
        );
        library.invalidate(&path);
        library.invalidate(&path);
        assert_eq!(
            search(&library, a.path(), "updated source", &["new-tag"]).total,
            1
        );
        assert_eq!(search(&library, a.path(), "original", &[]).total, 0);
        assert_eq!(search(&library, b.path(), "original", &[]).total, 1);
        assert!(search(&library, b.path(), "", &[]).tags.is_empty());
        let added = vault::clip_create(a.path(), &capture("Added")).unwrap();
        library.invalidate(&added);
        assert_eq!(search(&library, a.path(), "", &[]).total, 2);
        fs::remove_file(a.path().join(&path)).unwrap();
        library.invalidate(&path);
        let result = search(&library, a.path(), "", &[]);
        assert_eq!(result.total, 1);
        assert!(result.tags.is_empty());
    }

    #[test]
    fn invalidation_never_waits_for_a_search_or_loses_an_event_during_build() {
        use std::{sync::mpsc, thread, time::Duration};
        let dir = tempfile::tempdir().unwrap();
        let library = Library::default();
        let path = vault::clip_create(dir.path(), &capture("Before")).unwrap();
        assert_eq!(search(&library, dir.path(), "before", &[]).total, 1);
        vault::clip_update(
            dir.path(),
            &path,
            &vault::ClipUpdate {
                note: Some("Queued".into()),
                ..Default::default()
            },
        )
        .unwrap();
        // Simulate a blocking search/build holding the index lock. The event
        // queue must remain independently available to native commands.
        let guard = library.indexes.lock().unwrap();
        let writer = library.clone();
        let (tx, rx) = mpsc::channel();
        let worker = thread::spawn(move || {
            writer.invalidate(&path);
            tx.send(()).unwrap();
        });
        assert!(rx.recv_timeout(Duration::from_secs(2)).is_ok());
        drop(guard);
        worker.join().unwrap();
        assert_eq!(search(&library, dir.path(), "queued", &[]).total, 1);
        assert!(library.changed.lock().unwrap().is_empty());
    }

    #[test]
    fn preview_is_unicode_bounded_but_full_own_text_is_indexed() {
        let dir = tempfile::tempdir().unwrap();
        vault::clip_create(
            dir.path(),
            &capture(&format!("{} after-preview", "界".repeat(650))),
        )
        .unwrap();
        let result = search(&Library::default(), dir.path(), "after-preview", &[]);
        assert_eq!(result.total, 1);
        assert_eq!(result.clips[0].text.chars().count(), PREVIEW_CHARS);
    }

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nimage fixture";

    fn image_clip(root: &Path) -> String {
        vault::clip_create(
            root,
            &ClipCapture {
                image: Some(PNG.to_vec()),
                image_type: Some("image/png".into()),
                ..capture("")
            },
        )
        .unwrap()
    }

    #[test]
    fn image_command_accepts_only_a_clips_primary_supported_media() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let path = image_clip(root);
        assert_eq!(primary_image(root, &path).unwrap(), PNG);
        for invalid in [
            "../outside.png",
            "/etc/passwd",
            "inspiration/media/image.png",
            "inspiration/../image.md",
            "inspiration//image.md",
            "other.md",
        ] {
            assert!(primary_image(root, invalid).is_err(), "{invalid}");
        }
        let note = vault::clip_create(root, &capture("No image")).unwrap();
        assert!(primary_image(root, &note).is_err());
        let media = root.join("inspiration/media/image.png");
        fs::write(&media, b"<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>").unwrap();
        assert!(
            primary_image(root, &path).is_err(),
            "a PNG extension cannot disguise SVG"
        );
        for image in [
            "../outside.png",
            "media/../outside.png",
            "media/another.png",
            "media/image.svg",
            "/outside.png",
        ] {
            fs::write(
                root.join(&path),
                format!("---\nkind: image\ncaptured: 2026-10-29T14:05\nimage: {image}\n---\n"),
            )
            .unwrap();
            assert!(primary_image(root, &path).is_err(), "{image}");
        }
    }

    #[test]
    fn dropped_images_are_signature_checked_bounded_and_captured_via_mac() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let file = root.join("dropped.PNG");
        fs::write(&file, PNG).unwrap();
        let capture = image_capture(&file, "2026-10-29T14:05".into()).unwrap();
        assert_eq!(capture.via, ClipVia::Mac);
        assert_eq!(capture.image_type.as_deref(), Some("image/png"));
        let path = vault::clip_create(&root, &capture).unwrap();
        assert_eq!(primary_image(&root, &path).unwrap(), PNG);
        let invalid = image_capture(&file, "not a timestamp".into()).unwrap();
        assert!(vault::clip_create(&root, &invalid).is_err());
        assert!(image_capture(Path::new("relative.png"), "2026-10-29T14:05".into()).is_err());
        assert!(image_capture(&root.join("../outside.png"), "2026-10-29T14:05".into()).is_err());
        let svg = root.join("dropped.svg");
        fs::write(&svg, PNG).unwrap();
        assert!(read_raster(&svg).is_err());
        fs::write(&file, b"<svg/>").unwrap();
        assert!(read_raster(&file).is_err());
        fs::write(&file, []).unwrap();
        assert!(read_raster(&file).is_err());
        let mut bytes = vec![0; vault::MAX_CLIP_IMAGE_BYTES];
        bytes[..PNG.len()].copy_from_slice(PNG);
        fs::write(&file, &bytes).unwrap();
        assert_eq!(
            read_raster(&file).unwrap().0.len(),
            vault::MAX_CLIP_IMAGE_BYTES
        );
        bytes.push(0);
        fs::write(&file, bytes).unwrap();
        assert!(read_raster(&file).is_err());
        let media = root.join("inspiration/media/image.png");
        File::options()
            .write(true)
            .open(&media)
            .unwrap()
            .set_len(vault::MAX_CLIP_IMAGE_BYTES as u64 + 1)
            .unwrap();
        assert!(primary_image(&root, &path).is_err());
        let directory = root.join("directory.png");
        fs::create_dir(&directory).unwrap();
        assert!(read_raster(&directory).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinked_clip_media_directories_and_native_drops() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let path = image_clip(&root);
        let media = root.join("inspiration/media/image.png");
        let outside = root.join("outside.png");
        fs::write(&outside, PNG).unwrap();
        fs::remove_file(&media).unwrap();
        symlink(&outside, &media).unwrap();
        assert!(primary_image(&root, &path).is_err());
        assert!(read_raster(&media).is_err());
        fs::remove_file(&media).unwrap();
        fs::remove_dir(root.join("inspiration/media")).unwrap();
        symlink(&root, root.join("inspiration/media")).unwrap();
        assert!(primary_image(&root, &path).is_err());
        assert!(read_raster(&root.join("inspiration/media/outside.png")).is_err());
        let alias = root.join("alias.md");
        fs::rename(root.join(&path), &alias).unwrap();
        symlink(&alias, root.join(&path)).unwrap();
        assert!(primary_image(&root, &path).is_err());
    }

    #[test]
    fn recognizes_supported_raster_signatures_and_rejects_mismatches() {
        for (bytes, mime) in [
            (&b"\xff\xd8\xfffixture"[..], "image/jpeg"),
            (PNG, "image/png"),
            (&b"GIF87afixture"[..], "image/gif"),
            (&b"GIF89afixture"[..], "image/gif"),
            (&b"RIFF\x04\0\0\0WEBPfixture"[..], "image/webp"),
            (&b"\0\0\0\x18ftypheic\0\0\0\0mif1heic"[..], "image/heic"),
            (&b"\0\0\0\x18ftypmif1\0\0\0\0mif1heic"[..], "image/heif"),
            (&b"\0\0\0\x18ftypavif\0\0\0\0mif1avif"[..], "image/avif"),
        ] {
            assert!(signature_matches(bytes, mime), "{mime}");
            assert!(!signature_matches(b"<svg/>", mime));
        }
        assert!(!signature_matches(PNG, "image/jpeg"));
        assert!(!signature_matches(
            b"\0\0\0\xffftypavif\0\0\0\0",
            "image/avif"
        ));
        assert!(!signature_matches(b"RIFFtruncated", "image/webp"));
    }
}
