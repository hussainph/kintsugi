//! Reusable clip search and a narrow, byte-only image boundary.
//! Each search checks cheap file metadata; only changed clip contents are read.
//! Source text is searchable, but never returned in a card preview.
//! With a query, the app's hybrid index (`crate::search`) ranks the matches,
//! adding clips close in meaning; this lexical index stays as the filter of
//! record and the fallback.

use crate::vault::Vault;
use kintsugi_vault::{self as vault, Clip, ClipSummary};
use serde::Serialize;
use std::collections::{BTreeSet, HashMap};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;
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

#[derive(Debug, PartialEq, Eq)]
struct FileStamp {
    modified: SystemTime,
    bytes: u64,
    // Detect atomic replacements and writes that preserve mtime/size too.
    #[cfg(unix)]
    identity_and_change: (u64, u64, i64, i64),
}

/// Include malformed clips in the metadata snapshot so fixing one externally
/// makes it discoverable. Do not follow symlinks or inspect the media folder.
fn clip_files(root: &Path) -> Result<HashMap<String, FileStamp>> {
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;

    let dir = root.join(vault::INSPIRATION);
    let metadata = match fs::symlink_metadata(&dir) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(_) => return Err("could not inspect library folder".into()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("library folder must be a directory without symlinks".into());
    }
    let mut files = HashMap::new();
    for entry in fs::read_dir(dir).map_err(|_| "could not list library files")? {
        let entry = entry.map_err(|_| "could not inspect library file")?;
        let name = entry.file_name();
        let Some(name) = name
            .to_str()
            .filter(|name| !name.starts_with('.') && name.ends_with(".md"))
        else {
            continue;
        };
        let metadata = match fs::symlink_metadata(entry.path()) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err("could not inspect library file".into()),
        };
        if metadata.is_file() {
            files.insert(
                format!("{}/{name}", vault::INSPIRATION),
                FileStamp {
                    modified: metadata
                        .modified()
                        .map_err(|_| "could not inspect library file time")?,
                    bytes: metadata.len(),
                    #[cfg(unix)]
                    identity_and_change: (
                        metadata.dev(),
                        metadata.ino(),
                        metadata.ctime(),
                        metadata.ctime_nsec(),
                    ),
                },
            );
        }
    }
    Ok(files)
}

#[derive(Default)]
struct Index {
    clips: Vec<IndexedClip>,
    tags: Vec<String>,
    dirty: BTreeSet<String>,
    files: HashMap<String, FileStamp>,
    #[cfg(test)]
    reads: usize,
}

impl Index {
    fn sync(&mut self, root: &Path) -> Result<()> {
        let files = clip_files(root)?;
        self.dirty.extend(
            files
                .iter()
                .filter(|(path, stamp)| self.files.get(*path) != Some(*stamp))
                .map(|(path, _)| path.clone()),
        );
        self.dirty.extend(
            self.files
                .keys()
                .filter(|path| !files.contains_key(*path))
                .cloned(),
        );
        self.files = files;
        if !self.dirty.is_empty() {
            self.refresh(root);
        }
        Ok(())
    }

    fn refresh(&mut self, root: &Path) {
        let dirty = std::mem::take(&mut self.dirty);
        self.clips
            .retain(|clip| !dirty.contains(&clip.preview.summary.path));
        for path in dirty {
            if !self.files.contains_key(&path) {
                continue;
            }
            #[cfg(test)]
            {
                self.reads += 1;
            }
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

    /// `ranked` (clip paths, best first) orders the results: ranked clips
    /// first, then any other lexical match, newest first.
    fn search(
        &self,
        query: Option<&str>,
        tags: &[String],
        offset: usize,
        limit: usize,
        ranked: Option<&[String]>,
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
        let tagged = |clip: &IndexedClip| {
            tags.iter()
                .all(|tag| clip.preview.summary.tags.contains(tag))
        };
        let lexical = |clip: &IndexedClip| terms.iter().all(|term| clip.searchable.contains(term));
        let mut order: Vec<&IndexedClip> = Vec::new();
        match ranked.filter(|_| !terms.is_empty()) {
            Some(ranked) => {
                let by_path: HashMap<&str, &IndexedClip> = self
                    .clips
                    .iter()
                    .map(|clip| (clip.preview.summary.path.as_str(), clip))
                    .collect();
                let mut seen = BTreeSet::new();
                for path in ranked {
                    if let Some(clip) = by_path.get(path.as_str())
                        && seen.insert(path.as_str())
                    {
                        order.push(clip);
                    }
                }
                order.extend(
                    self.clips
                        .iter()
                        .filter(|clip| !seen.contains(clip.preview.summary.path.as_str()) && lexical(clip)),
                );
            }
            None => order.extend(self.clips.iter().filter(|clip| lexical(clip))),
        }
        let mut total = 0;
        let mut clips = Vec::new();
        for clip in order {
            if !tagged(clip) {
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

    #[cfg(test)]
    fn search(
        &self,
        root: &Path,
        query: Option<&str>,
        tags: &[String],
        offset: Option<usize>,
        limit: Option<usize>,
    ) -> Result<ClipSearch> {
        self.search_ranked(root, query, tags, offset, limit, None)
    }

    fn search_ranked(
        &self,
        root: &Path,
        query: Option<&str>,
        tags: &[String],
        offset: Option<usize>,
        limit: Option<usize>,
        ranked: Option<Vec<String>>,
    ) -> Result<ClipSearch> {
        let root = root
            .canonicalize()
            .map_err(|_| "could not open library vault")?;
        let mut indexes = self.indexes.lock().map_err(|_| "library unavailable")?;
        let changed = std::mem::take(&mut *self.changed.lock().map_err(|_| "library unavailable")?);
        for index in indexes.values_mut() {
            index.dirty.extend(changed.iter().cloned());
        }
        let index = indexes.entry(root.clone()).or_default();
        index.sync(&root)?;
        Ok(index.search(
            query,
            tags,
            offset.unwrap_or(0),
            limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT),
            ranked.as_deref(),
        ))
    }
}

#[tauri::command]
pub async fn clip_search(
    app: crate::AppHandle,
    vault: State<'_, Vault>,
    library: State<'_, Library>,
    query: Option<String>,
    tags: Option<Vec<String>>,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<ClipSearch> {
    let root = vault.root()?;
    let library = library.inner().clone();
    let search = tauri::Manager::state::<crate::search::Search>(&app).inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let ranked = query
            .as_deref()
            .filter(|q| !q.trim().is_empty())
            .and_then(|q| search.rank_clips(&app, &root, q));
        library.search_ranked(
            &root,
            query.as_deref(),
            &tags.unwrap_or_default(),
            offset,
            limit,
            ranked,
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
/// between validation and reading. O_NONBLOCK prevents a FIFO hanging the
/// command before its regular-file check. libc supplies architecture-correct
/// flags (notably Linux arm64's O_DIRECTORY and O_NOFOLLOW).
#[cfg(unix)]
fn open_regular_file(path: &Path) -> Result<File> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;

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
        let flags = libc::O_RDONLY
            | libc::O_NOFOLLOW
            | libc::O_CLOEXEC
            | if last {
                libc::O_NONBLOCK
            } else {
                libc::O_DIRECTORY
            };
        // SAFETY: file owns a live directory fd, name is NUL-terminated, and
        // flags never create a file (so openat needs no mode argument).
        let fd = unsafe { libc::openat(file.as_raw_fd(), name.as_ptr(), flags) };
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

#[cfg(not(unix))]
fn open_regular_file(_path: &Path) -> Result<File> {
    Err("secure image file loading is unavailable on this platform".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use kintsugi_vault::{ClipCapture, ClipVia};

    fn capture(text: &str) -> ClipCapture {
        ClipCapture {
            url: None,
            text: Some(text.into()),
            note: None,
            title: None,
            image: None,
            image_type: None,
            file: None,
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

    /// The hybrid index ranks; the lexical index filters by tag and keeps
    /// every plain match it would have shown, after the ranked ones.
    #[test]
    fn hybrid_ranking_orders_results_and_adds_meaning_matches() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let older = vault::clip_create(root, &capture("Sleep science, older")).unwrap();
        let mut newer = capture("Sleep and the brain, newer");
        newer.captured_at = "2026-10-30T09:00".into();
        let newer = vault::clip_create(root, &newer).unwrap();
        let insomnia = vault::clip_create(root, &capture("Insomnia at bedtime")).unwrap();
        let unrelated = vault::clip_create(root, &capture("Kilns")).unwrap();
        vault::clip_update(root, &insomnia, &vault::ClipUpdate { tags: Some(vec!["night".into()]), ..Default::default() }).unwrap();
        let library = Library::default();
        let paths = |result: ClipSearch| result.clips.into_iter().map(|c| c.summary.path).collect::<Vec<_>>();

        // Lexical alone: newest first, word matches only.
        assert_eq!(paths(search(&library, root, "sleep", &[])), [newer.clone(), older.clone()]);
        // Ranked: the order given, the meaning-only match included, and any
        // lexical match the ranking missed appended; unknown paths ignored.
        let ranked = vec![older.clone(), insomnia.clone(), "inspiration/gone.md".into()];
        let result = library.search_ranked(root, Some("sleep"), &[], None, None, Some(ranked.clone())).unwrap();
        assert_eq!(result.total, 3);
        assert_eq!(paths(result), [older.clone(), insomnia.clone(), newer.clone()]);
        // Tags still filter, and pages slice the ranked order.
        let tagged = library.search_ranked(root, Some("sleep"), &["night".into()], None, None, Some(ranked.clone())).unwrap();
        assert_eq!(paths(tagged), vec![insomnia.clone()]);
        let page = library.search_ranked(root, Some("sleep"), &[], Some(1), Some(1), Some(ranked.clone())).unwrap();
        assert_eq!((page.total, paths(page)), (3, vec![insomnia.clone()]));
        // No query: newest first, the ranking unused.
        let all = library.search_ranked(root, None, &[], None, None, Some(ranked)).unwrap();
        assert_eq!(all.total, 4);
        assert!(paths(all).contains(&unrelated));
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
    fn external_edits_creates_deletes_and_reopening_refresh_only_changed_files() {
        use std::time::Duration;
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let library = Library::default();
        let path = vault::clip_create(a.path(), &capture("Original")).unwrap();
        let stable = vault::clip_create(a.path(), &capture("Stable")).unwrap();
        assert_eq!(
            vault::clip_create(b.path(), &capture("Original")).unwrap(),
            path
        );
        assert_eq!(search(&library, a.path(), "", &[]).total, 2);
        assert_eq!(search(&library, b.path(), "original", &[]).total, 1);
        assert_eq!(read_count(&library, a.path()), 2);

        // Obsidian-style in-place, same-length edit, without clips_changed.
        let target = a.path().join(&path);
        let modified = fs::metadata(&target).unwrap().modified().unwrap();
        let raw = fs::read_to_string(&target)
            .unwrap()
            .replace("Original", "Modified");
        fs::write(&target, raw).unwrap();
        File::options()
            .write(true)
            .open(&target)
            .unwrap()
            .set_modified(modified + Duration::from_secs(1))
            .unwrap();
        assert_eq!(search(&library, a.path(), "modified", &[]).total, 1);
        assert_eq!(search(&library, a.path(), "original", &[]).total, 0);
        assert_eq!(read_count(&library, a.path()), 3);

        // Finder-style new file and rename are discovered by their names.
        let added = a.path().join("inspiration/external.md");
        fs::write(&added, "---\nkind: note\ntitle: External\ncaptured: 2026-10-30T12:00\ntags: [outside]\n---\nAdded from outside\n").unwrap();
        let result = search(&library, a.path(), "", &[]);
        assert_eq!(result.total, 3);
        assert_eq!(result.clips[0].summary.path, "inspiration/external.md");
        assert_eq!(result.tags, ["outside"]);
        assert_eq!(read_count(&library, a.path()), 4);
        fs::rename(&added, a.path().join("inspiration/renamed.md")).unwrap();
        assert_eq!(
            search(&library, a.path(), "external", &[]).clips[0]
                .summary
                .path,
            "inspiration/renamed.md"
        );
        assert_eq!(read_count(&library, a.path()), 5);

        // Switch away, delete files, then reopen the already-cached root.
        assert_eq!(search(&library, b.path(), "original", &[]).total, 1);
        fs::remove_file(&target).unwrap();
        fs::remove_file(a.path().join("inspiration/renamed.md")).unwrap();
        let result = search(&library, a.path(), "", &[]);
        assert_eq!(result.total, 1);
        assert_eq!(result.clips[0].summary.path, stable);
        assert!(result.tags.is_empty());
        assert_eq!(
            read_count(&library, a.path()),
            5,
            "deletions do not reread unchanged clips"
        );
        assert_eq!(search(&library, b.path(), "original", &[]).total, 1);
        assert_eq!(
            read_count(&library, b.path()),
            1,
            "other roots keep their own content cache"
        );
    }

    #[cfg(unix)]
    #[test]
    fn external_atomic_replacement_with_preserved_size_and_mtime_is_detected() {
        let dir = tempfile::tempdir().unwrap();
        let library = Library::default();
        let path = vault::clip_create(dir.path(), &capture("Original")).unwrap();
        assert_eq!(search(&library, dir.path(), "original", &[]).total, 1);
        let target = dir.path().join(&path);
        let before = fs::metadata(&target).unwrap();
        let replacement = dir.path().join("replacement.md");
        fs::write(
            &replacement,
            fs::read_to_string(&target)
                .unwrap()
                .replace("Original", "Repaired"),
        )
        .unwrap();
        File::options()
            .write(true)
            .open(&replacement)
            .unwrap()
            .set_modified(before.modified().unwrap())
            .unwrap();
        fs::rename(replacement, &target).unwrap();
        assert_eq!(fs::metadata(&target).unwrap().len(), before.len());
        assert_eq!(
            fs::metadata(&target).unwrap().modified().unwrap(),
            before.modified().unwrap()
        );
        assert_eq!(search(&library, dir.path(), "repaired", &[]).total, 1);
        assert_eq!(read_count(&library, dir.path()), 2);
    }

    #[test]
    fn externally_repaired_invalid_files_are_discovered_without_reloading_valid_clips() {
        let dir = tempfile::tempdir().unwrap();
        let library = Library::default();
        let path = vault::clip_create(dir.path(), &capture("Valid")).unwrap();
        let broken = dir.path().join("inspiration/broken.md");
        fs::write(&broken, "not a clip yet").unwrap();
        assert_eq!(search(&library, dir.path(), "", &[]).total, 1);
        assert_eq!(read_count(&library, dir.path()), 2);
        fs::write(&broken, fs::read(dir.path().join(&path)).unwrap()).unwrap();
        assert_eq!(search(&library, dir.path(), "valid", &[]).total, 2);
        assert_eq!(read_count(&library, dir.path()), 3);
    }

    fn read_count(library: &Library, root: &Path) -> usize {
        library
            .indexes
            .lock()
            .unwrap()
            .get(&root.canonicalize().unwrap())
            .unwrap()
            .reads
    }

    #[test]
    fn unchanged_metadata_retains_cached_content_but_events_can_force_a_refresh() {
        let dir = tempfile::tempdir().unwrap();
        let library = Library::default();
        let path = vault::clip_create(dir.path(), &capture("Cached")).unwrap();
        assert_eq!(search(&library, dir.path(), "cached", &[]).total, 1);
        assert_eq!(read_count(&library, dir.path()), 1);
        for _ in 0..3 {
            assert_eq!(search(&library, dir.path(), "cached", &[]).total, 1);
        }
        assert_eq!(read_count(&library, dir.path()), 1);
        library.invalidate(&path);
        assert_eq!(search(&library, dir.path(), "cached", &[]).total, 1);
        assert_eq!(read_count(&library, dir.path()), 2);
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
                file: None,
                ..capture("")
            },
        )
        .unwrap()
    }

    /// An image clip's primary image file (named for when it arrived).
    fn media_of(root: &Path, path: &str) -> std::path::PathBuf {
        let image = vault::clip_read(root, path).unwrap().summary.image.unwrap();
        root.join("inspiration").join(image)
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
        let media = media_of(root, &path);
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
    fn primary_images_are_signature_checked_bounded_regular_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let path = image_clip(&root);
        let media = media_of(&root, &path);
        fs::write(&media, b"<svg/>").unwrap();
        assert!(primary_image(&root, &path).is_err());
        fs::write(&media, []).unwrap();
        assert!(primary_image(&root, &path).is_err());
        let mut bytes = vec![0; vault::MAX_CLIP_IMAGE_BYTES];
        bytes[..PNG.len()].copy_from_slice(PNG);
        fs::write(&media, &bytes).unwrap();
        assert_eq!(
            primary_image(&root, &path).unwrap().len(),
            vault::MAX_CLIP_IMAGE_BYTES
        );
        bytes.push(0);
        fs::write(&media, bytes).unwrap();
        assert!(primary_image(&root, &path).is_err());
        fs::remove_file(&media).unwrap();
        fs::create_dir(&media).unwrap();
        assert!(primary_image(&root, &path).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinked_clip_media_and_directories() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let path = image_clip(&root);
        let media = media_of(&root, &path);
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
