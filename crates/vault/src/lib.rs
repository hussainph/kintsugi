//! The vault: a plain folder of `.md` / `.mdx` files. Every path given to or
//! returned from this crate is relative to the vault root and uses `/`.

use serde::Serialize;
use std::fs;
use std::io::Write as _;
use std::path::{Component, Path, PathBuf};

mod clip_frontmatter;
mod clips;
pub use clips::*;

const DOC_EXTENSIONS: [&str; 2] = ["md", "mdx"];

/// Where ideas captured away from the desk land.
pub const INBOX: &str = "inbox";

pub type Result<T> = std::result::Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Entry {
    Folder {
        name: String,
        path: String,
        children: Vec<Entry>,
    },
    Doc {
        name: String,
        path: String,
        title: Option<String>,
        status: Option<String>,
    },
}

/// A document's text and the version it was read at.
#[derive(Serialize, Debug, PartialEq)]
pub struct Versioned {
    pub text: String,
    pub version: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "result", rename_all = "lowercase")]
pub enum Write {
    Saved { version: String },
    /// Someone else saved since `base`; nothing was written.
    Conflict { current: Versioned },
}

/// Identifies a document's contents, so a writer that read an older copy can
/// be told rather than silently overwrite newer text. FNV-1a: stable across
/// builds and platforms, which `std`'s hasher doesn't promise.
pub fn version(text: &str) -> String {
    let hash = text
        .bytes()
        .fold(0xcbf29ce484222325u64, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3));
    format!("{hash:016x}")
}

/// Joins a vault-relative path onto the root, refusing anything that could
/// escape it (absolute paths, `..`, drive prefixes).
pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf> {
    let rel = Path::new(rel);
    if rel
        .components()
        .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
    {
        return Err(format!("path escapes the vault: {}", rel.display()));
    }
    Ok(root.join(rel))
}

pub fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn is_doc(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| DOC_EXTENSIONS.contains(&e))
}

/// Reads `title` and `status` from top-level YAML frontmatter. Deliberately
/// tiny: the editor owns the full frontmatter, the tree only needs these two.
pub fn front_matter(text: &str) -> (Option<String>, Option<String>) {
    let mut lines = text.lines();
    if lines.next().map(str::trim_end) != Some("---") {
        return (None, None);
    }
    let (mut title, mut status) = (None, None);
    for line in lines {
        if line.trim_end() == "---" {
            break;
        }
        if line.starts_with(char::is_whitespace) {
            continue;
        }
        if let Some((key, value)) = line.split_once(':') {
            let value = value.trim().trim_matches(|c| c == '"' || c == '\'');
            if value.is_empty() {
                continue;
            }
            match key.trim() {
                "title" => title = Some(value.to_string()),
                "status" => status = Some(value.to_string()),
                _ => {}
            }
        }
    }
    (title, status)
}

/// Every folder and document under the root, folders first.
pub fn tree(root: &Path) -> Result<Vec<Entry>> {
    tree_in(root, root)
}

fn tree_in(root: &Path, dir: &Path) -> Result<Vec<Entry>> {
    let mut entries = Vec::new();
    for item in fs::read_dir(dir).map_err(err)? {
        let path = item.map_err(err)?.path();
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if name.starts_with('.') || (dir == root && name.eq_ignore_ascii_case(INSPIRATION)) {
            continue;
        }
        if path.is_dir() {
            entries.push(Entry::Folder {
                children: tree_in(root, &path)?,
                path: relative(root, &path),
                name,
            });
        } else if is_doc(&path) {
            let (title, status) = fs::read_to_string(&path)
                .map(|text| front_matter(&text))
                .unwrap_or_default();
            entries.push(Entry::Doc {
                path: relative(root, &path),
                name,
                title,
                status,
            });
        }
    }
    entries.sort_by_key(|e| match e {
        Entry::Folder { name, .. } => (0, name.to_lowercase()),
        Entry::Doc { name, .. } => (1, name.to_lowercase()),
    });
    Ok(entries)
}

pub fn slugify(title: &str) -> String {
    let mut slug = String::new();
    for c in title.trim().to_lowercase().chars() {
        if c.is_alphanumeric() {
            slug.push(c);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_matches('-');
    if slug.is_empty() {
        "untitled".into()
    } else {
        slug.chars().take(72).collect::<String>().trim_end_matches('-').into()
    }
}

/// `dir/stem.ext`, or `dir/stem-2.ext`, `-3`… if that is taken.
fn unique(dir: &Path, stem: &str, ext: Option<&str>) -> PathBuf {
    let name = |n: u32| {
        let stem = if n == 1 { stem.to_string() } else { format!("{stem}-{n}") };
        match ext {
            Some(ext) => format!("{stem}.{ext}"),
            None => stem,
        }
    };
    (1..)
        .map(|n| dir.join(name(n)))
        .find(|p| !p.exists())
        .expect("an unused name")
}

/// Writes via a sibling temp file and a rename, so a crash mid-save never
/// leaves a half-written document.
pub fn write_atomic(path: &Path, contents: &str) -> Result<()> {
    write_bytes_atomic(path, contents.as_bytes())
}

fn write_bytes_atomic(path: &Path, contents: &[u8]) -> Result<()> {
    write_bytes(path, contents, true)
}

fn write_bytes_new_atomic(path: &Path, contents: &[u8]) -> Result<()> {
    write_bytes(path, contents, false)
}

fn write_bytes(path: &Path, contents: &[u8], replace: bool) -> Result<()> {
    let parent = path.parent().ok_or("not a file path")?;
    // Unique sibling files keep simultaneous saves from sharing a temp name.
    let mut builder = tempfile::Builder::new();
    builder.prefix(".kintsugi-");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // New vault files follow the writer's umask, as ordinary files do.
        builder.permissions(fs::Permissions::from_mode(0o666));
    }
    let mut tmp = builder.tempfile_in(parent).map_err(err)?;
    tmp.write_all(contents).map_err(err)?;
    if let Ok(metadata) = fs::metadata(path) {
        tmp.as_file().set_permissions(metadata.permissions()).map_err(err)?;
    }
    tmp.as_file().sync_all().map_err(err)?;
    if replace {
        tmp.persist(path).map_err(err)?;
    } else {
        tmp.persist_noclobber(path).map_err(err)?;
    }
    Ok(())
}

pub fn read(root: &Path, path: &str) -> Result<Versioned> {
    let text = fs::read_to_string(resolve(root, path)?).map_err(err)?;
    Ok(Versioned { version: version(&text), text })
}

/// Saves `text`. With a `base` version, only if the document is still at it.
pub fn write(root: &Path, path: &str, text: &str, base: Option<&str>) -> Result<Write> {
    let target = resolve(root, path)?;
    if !is_doc(&target) {
        return Err(format!("not a document: {path}"));
    }
    if let Some(base) = base {
        if let Ok(current) = fs::read_to_string(&target) {
            if version(&current) != base {
                return Ok(Write::Conflict {
                    current: Versioned { version: version(&current), text: current },
                });
            }
        }
    }
    write_atomic(&target, text)?;
    Ok(Write::Saved { version: version(text) })
}

fn quoted(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Creates a draft in `dir` named after `title`; returns its path.
pub fn create_doc(root: &Path, dir: &str, title: &str) -> Result<String> {
    let path = unique(&resolve(root, dir)?, &slugify(title), Some("mdx"));
    write_atomic(&path, &format!("---\ntitle: {}\nstatus: draft\n---\n\n", quoted(title)))?;
    Ok(relative(root, &path))
}

pub fn create_folder(root: &Path, dir: &str, name: &str) -> Result<String> {
    let path = unique(&resolve(root, dir)?, &slugify(name), None);
    fs::create_dir(&path).map_err(err)?;
    Ok(relative(root, &path))
}

/// Renames in place (same folder); returns the new path.
pub fn rename(root: &Path, path: &str, name: &str) -> Result<String> {
    let from = resolve(root, path)?;
    if path.is_empty() {
        return Err("refusing to rename the vault itself".into());
    }
    if name.is_empty() || name.contains('/') || name.starts_with('.') {
        return Err(format!("not a valid name: {name}"));
    }
    let to = from.with_file_name(name);
    if to.exists() {
        return Err(format!("{name} already exists"));
    }
    fs::rename(&from, &to).map_err(err)?;
    Ok(relative(root, &to))
}

/// A quick note from wherever the writer is: a new draft in the inbox, titled
/// by its first line. `captured_at` is the capturing device's local time.
pub fn capture(root: &Path, text: &str, captured_at: &str) -> Result<String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("nothing to capture".into());
    }
    let title = capture_title(text);
    let dir = root.join(INBOX);
    fs::create_dir_all(&dir).map_err(err)?;
    let path = unique(&dir, &slugify(&title), Some("mdx"));
    let stamp: String = captured_at
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || "-:+.".contains(*c))
        .take(40)
        .collect();
    let mut doc = format!("---\ntitle: {}\nstatus: draft\n", quoted(&title));
    if !stamp.is_empty() {
        doc.push_str(&format!("captured: {}\n", quoted(&stamp)));
    }
    doc.push_str(&format!("---\n\n{text}\n"));
    write_atomic(&path, &doc)?;
    Ok(relative(root, &path))
}

/// The first line, without Markdown heading or list marks, cut at a word
/// boundary if it runs long.
fn capture_title(text: &str) -> String {
    const LIMIT: usize = 60;
    let line = text.lines().next().unwrap_or_default();
    let line = line.trim_start_matches(['#', '-', '*', '>', ' ']).trim();
    if line.chars().count() <= LIMIT {
        return line.to_string();
    }
    let cut: String = line.chars().take(LIMIT).collect();
    let cut = cut.rsplit_once(' ').map_or(cut.as_str(), |(head, _)| head);
    format!("{}…", cut.trim_end_matches([',', ';', ':', '.']))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_stays_inside_the_vault() {
        let root = Path::new("/vault");
        assert_eq!(resolve(root, "a/b.mdx").unwrap(), root.join("a/b.mdx"));
        assert!(resolve(root, "../etc/passwd").is_err());
        assert!(resolve(root, "a/../../x").is_err());
        assert!(resolve(root, "/etc/passwd").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn atomic_saves_keep_existing_permissions_and_new_files_follow_the_umask() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("writing.md");
        let ordinary = dir.path().join("ordinary.md");
        fs::write(&ordinary, "ordinary").unwrap();
        write_atomic(&path, "first").unwrap();
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode(), fs::metadata(&ordinary).unwrap().permissions().mode());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        write_atomic(&path, "second").unwrap();
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o640);
        assert_eq!(fs::read_to_string(path).unwrap(), "second");
    }

    #[test]
    fn reads_title_and_status() {
        let text = "---\ntitle: \"On repair\"\nstatus: complete\ntags:\n  - status: nested\n---\n\nBody";
        assert_eq!(
            front_matter(text),
            (Some("On repair".into()), Some("complete".into()))
        );
        assert_eq!(front_matter("# No frontmatter"), (None, None));
        assert_eq!(front_matter("---\ntitle:\n---"), (None, None));
    }

    #[test]
    fn slugs() {
        assert_eq!(slugify("On Repair: gold & glue!"), "on-repair-gold-glue");
        assert_eq!(slugify("  "), "untitled");
        assert_eq!(slugify("Café"), "café");
    }

    #[test]
    fn tree_lists_folders_first_and_skips_hidden_and_non_docs() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("essays")).unwrap();
        fs::write(root.join("b.md"), "---\nstatus: draft\n---\n").unwrap();
        fs::write(root.join("essays/a.mdx"), "hi").unwrap();
        fs::write(root.join("notes.txt"), "skip").unwrap();
        fs::write(root.join(".hidden.md"), "skip").unwrap();

        assert_eq!(
            tree(root).unwrap(),
            vec![
                Entry::Folder {
                    name: "essays".into(),
                    path: "essays".into(),
                    children: vec![Entry::Doc {
                        name: "a.mdx".into(),
                        path: "essays/a.mdx".into(),
                        title: None,
                        status: None
                    }],
                },
                Entry::Doc {
                    name: "b.md".into(),
                    path: "b.md".into(),
                    title: None,
                    status: Some("draft".into())
                },
            ]
        );
    }

    #[test]
    fn write_refuses_a_stale_base() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let path = create_doc(root, "", "Repair").unwrap();
        let first = read(root, &path).unwrap();

        let Write::Saved { version: second } = write(root, &path, "from the mac", Some(&first.version)).unwrap()
        else {
            panic!("expected a save")
        };
        // The phone still holds the first version.
        assert_eq!(
            write(root, &path, "from the phone", Some(&first.version)).unwrap(),
            Write::Conflict {
                current: Versioned { text: "from the mac".into(), version: second.clone() }
            }
        );
        assert_eq!(read(root, &path).unwrap().text, "from the mac");
        assert!(write(root, "notes.txt", "x", None).is_err());
    }

    #[test]
    fn captures_land_in_the_inbox_titled_by_their_first_line() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let path = capture(root, "  # Gold seams\nshow where the AI touched a draft\n", "2026-10-29T09:14").unwrap();
        assert_eq!(path, "inbox/gold-seams.mdx");
        assert_eq!(
            read(root, &path).unwrap().text,
            "---\ntitle: \"Gold seams\"\nstatus: draft\ncaptured: \"2026-10-29T09:14\"\n---\n\n# Gold seams\nshow where the AI touched a draft\n"
        );
        assert_eq!(capture(root, "Gold seams", "").unwrap(), "inbox/gold-seams-2.mdx");
        assert!(capture(root, "   ", "").is_err());

        let long = "a sentence that keeps going well past the point where a title would be useful";
        assert_eq!(capture_title(long), "a sentence that keeps going well past the point where a…");
        assert_eq!(capture_title("say \"hi\""), "say \"hi\"");
        assert_eq!(front_matter(&read(root, "inbox/gold-seams-2.mdx").unwrap().text).0.as_deref(), Some("Gold seams"));
    }
}
