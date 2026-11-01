//! The blog repository and the vault's mirror of it, as plain functions over
//! folders so they test without an app. See docs/publishing.md.

use kintsugi_vault::{self as vault, Entry};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};

type Result<T> = std::result::Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

pub const COLLECTIONS: [(&str, &str, &str); 2] = [
    // (repository folder, kind, URL route)
    ("src/content/writing", "writing", "essays"),
    ("src/content/notes", "note", "notes"),
];
const IMAGE_FOLDER: &str = "public/posts";
const IMAGE_EXTENSIONS: [&str; 7] = ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg"];
const MODULE_EXTENSIONS: [&str; 7] = ["", ".astro", ".jsx", ".tsx", ".ts", ".js", ".mdx"];

/// Does this folder look like the blog? Answers with its canonical path.
pub fn checked_repo(path: &Path) -> Result<PathBuf> {
    let path = path.canonicalize().map_err(|e| format!("{}: {e}", path.display()))?;
    if !path.join("src/content.config.ts").is_file() || !path.join("src/content/writing").is_dir() {
        return Err(format!(
            "{} doesn't look like the blog: it needs src/content.config.ts and src/content/writing/",
            path.display()
        ));
    }
    Ok(path)
}

/// Top-level YAML fields: scalars (unquoted) and lists (`[a, b]` or `- a`).
#[derive(Debug, Default, PartialEq)]
pub struct Front {
    pub scalars: HashMap<String, String>,
    pub lists: HashMap<String, Vec<String>>,
}

fn unquote(value: &str) -> String {
    let v = value.trim();
    for q in ['"', '\''] {
        if v.len() >= 2 && v.starts_with(q) && v.ends_with(q) {
            let inner = &v[1..v.len() - 1];
            return if q == '"' { inner.replace("\\\"", "\"") } else { inner.replace("''", "'") };
        }
    }
    v.to_string()
}

/// Frontmatter fields and the body after them (blank lines trimmed).
pub fn split(text: &str) -> (Front, &str) {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut front = Front::default();
    let Some(rest) = text.strip_prefix("---\n").or_else(|| text.strip_prefix("---\r\n")) else {
        return (front, text);
    };
    let mut offset = text.len() - rest.len();
    let mut list: Option<String> = None;
    for line in rest.split_inclusive('\n') {
        offset += line.len();
        let line = line.trim_end_matches(['\r', '\n']);
        if line.trim_end() == "---" {
            let body = &text[offset.min(text.len())..];
            return (front, body.trim_start_matches(['\r', '\n']));
        }
        if let (Some(key), Some(item)) = (&list, line.trim_start().strip_prefix("- ")) {
            if line.starts_with(char::is_whitespace) || line.starts_with('-') {
                front.lists.entry(key.clone()).or_default().push(unquote(item));
                continue;
            }
        }
        list = None;
        if line.starts_with(char::is_whitespace) {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else { continue };
        let (key, value) = (key.trim().to_string(), value.trim());
        if value.is_empty() {
            list = Some(key);
        } else if let Some(inner) = value.strip_prefix('[').and_then(|v| v.strip_suffix(']')) {
            let items = inner.split(',').map(unquote).filter(|s| !s.is_empty()).collect();
            front.lists.insert(key, items);
        } else {
            front.scalars.insert(key, unquote(value));
        }
    }
    (Front::default(), text)
}

pub fn field(text: &str, key: &str) -> Option<String> {
    split(text).0.scalars.remove(key).filter(|v| !v.is_empty())
}

/// The mirror marker. Mirror files are generated from the blog and read-only.
pub fn is_mirror(text: &str) -> bool {
    field(text, "mirror").is_some()
}

/// Refuses to change a mirror file through the ordinary writing commands.
pub fn refuse_mirror(root: &Path, rel: &str) -> Result<()> {
    let Ok(path) = vault::resolve(root, rel) else { return Ok(()) };
    match fs::read_to_string(path) {
        Ok(text) if is_mirror(&text) => Err(format!(
            "{rel} mirrors a post on the blog; edit it in the blog repository and import again"
        )),
        _ => Ok(()),
    }
}

/// The site's host name: the mirror's folder in the vault.
pub fn host(site: &str) -> String {
    let host = site.split("://").nth(1).unwrap_or(site).split(['/', ':']).next().unwrap_or("");
    let safe: String = host.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-')).collect();
    let safe = safe.trim_matches('.').to_string();
    if safe.is_empty() { "blog".into() } else { safe }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Post {
    pub kind: &'static str,
    /// Repository-relative, e.g. src/content/writing/2026-09-16-the-sixth-attempt.md
    pub file: String,
    pub date: String,
    pub slug: String,
    pub ext: String,
    pub title: Option<String>,
    pub tags: Vec<String>,
    pub url: String,
    #[serde(skip)]
    pub body: String,
}

/// `YYYY-MM-DD-slug.(md|mdx)` → (date, slug, ext).
pub fn dated(name: &str) -> Option<(String, String, String)> {
    let (stem, ext) = name.rsplit_once('.')?;
    if !matches!(ext, "md" | "mdx") || stem.len() < 12 {
        return None;
    }
    let (date, slug) = (stem.get(..10)?, stem.get(11..)?);
    let digits = date.bytes().enumerate().all(|(i, b)| if i == 4 || i == 7 { b == b'-' } else { b.is_ascii_digit() });
    let slug_ok = !slug.is_empty() && slug.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    (digits && stem.as_bytes()[10] == b'-' && slug_ok).then(|| (date.into(), slug.into(), ext.into()))
}

/// Is this a post file Kintsugi may write? Answers with (kind, id).
pub fn post_file(file: &str) -> Option<(&'static str, String)> {
    let (folder, name) = file.rsplit_once('/')?;
    let (_, kind, _) = COLLECTIONS.iter().find(|(f, _, _)| *f == folder)?;
    let (date, slug, _) = dated(name)?;
    Some((kind, format!("{date}-{slug}")))
}

pub fn url(site: &str, kind: &str, slug: &str) -> String {
    let route = COLLECTIONS.iter().find(|(_, k, _)| *k == kind).map(|c| c.2).unwrap_or("essays");
    format!("{}/{route}/{slug}/", site.trim_end_matches('/'))
}

/// Every post in the repository, newest first. Flat files only, as the blog's
/// own loader requires; symlinks and anything undated are skipped.
pub fn posts(repo: &Path, site: &str) -> Result<Vec<Post>> {
    let mut posts = Vec::new();
    for (folder, kind, _) in COLLECTIONS {
        let Ok(entries) = fs::read_dir(repo.join(folder)) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some((date, slug, ext)) = dated(&name) else { continue };
            if !entry.file_type().is_ok_and(|t| t.is_file()) {
                continue;
            }
            let Ok(text) = fs::read_to_string(entry.path()) else { continue };
            let (mut front, body) = split(&text);
            posts.push(Post {
                kind,
                file: format!("{folder}/{name}"),
                url: url(site, kind, &slug),
                title: front.scalars.remove("title").filter(|t| !t.is_empty()),
                tags: front.lists.remove("tags").unwrap_or_default(),
                body: body.to_string(),
                date,
                slug,
                ext,
            });
        }
    }
    posts.sort_by(|a, b| b.date.cmp(&a.date).then_with(|| a.file.cmp(&b.file)));
    Ok(posts)
}

/// A note's stand-in title: its first sentence, as the blog's feed does.
fn short(body: &str) -> String {
    let line = body
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with("import ") && !l.starts_with("export ") && !l.starts_with('<'))
        .unwrap_or("Note");
    let plain: String = line.trim_start_matches(['#', '>', '-', '*', ' ']).replace(['*', '_', '`'], "");
    let sentence = plain.find(['.', '!', '?']).map(|i| &plain[..i]).unwrap_or(&plain);
    if sentence.chars().count() <= 60 {
        return sentence.trim().to_string();
    }
    let cut: String = sentence.chars().take(60).collect();
    format!("{}…", cut.rsplit_once(' ').map(|(a, _)| a).unwrap_or(&cut).trim_end_matches([',', ';', ':']))
}

fn yaml_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".into())
}

/// The vault file for a post: frontmatter that says where it lives, then the
/// post's own body, verbatim.
pub fn mirror_text(post: &Post, host: &str) -> String {
    let title = post.title.clone().unwrap_or_else(|| short(&post.body));
    let tags = post.tags.iter().map(|t| yaml_string(t)).collect::<Vec<_>>().join(", ");
    format!(
        "---\ntitle: {}\nstatus: published\ntags: [{tags}]\ndate: {}\nurl: {}\npost: {}\nmirror: {host}\n---\n\n{}",
        yaml_string(&title),
        post.date,
        post.url,
        post.file,
        post.body,
    )
}

pub fn mirror_path(post: &Post, host: &str) -> String {
    let route = COLLECTIONS.iter().find(|(_, k, _)| *k == post.kind).map(|c| c.2).unwrap_or("essays");
    format!("{host}/{route}/{}.{}", post.slug, post.ext)
}

/// A vault document on the blog: a mirror, or one that was published.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Linked {
    pub path: String,
    pub url: String,
    pub post: Option<String>,
    pub mirror: bool,
}

fn flatten(entries: Vec<Entry>, out: &mut Vec<String>) {
    for entry in entries {
        match entry {
            Entry::Folder { children, .. } => flatten(children, out),
            Entry::Doc { path, .. } => out.push(path),
        }
    }
}

/// Every vault document with a `url:` (mirrors and published documents).
pub fn linked(root: &Path) -> Result<Vec<Linked>> {
    let mut paths = Vec::new();
    flatten(vault::tree(root)?, &mut paths);
    let mut out = Vec::new();
    for path in paths {
        let Ok(text) = fs::read_to_string(root.join(&path)) else { continue };
        let (mut front, _) = split(&text);
        if let Some(url) = front.scalars.remove("url").filter(|u| u.starts_with("http")) {
            out.push(Linked {
                path,
                url,
                post: front.scalars.remove("post"),
                mirror: front.scalars.get("mirror").is_some_and(|m| !m.is_empty()),
            });
        }
    }
    Ok(out)
}

#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub folder: String,
    pub posts: usize,
    pub written: Vec<String>,
    pub unchanged: usize,
    pub removed: Vec<String>,
    /// Posts a vault document already publishes (it is their source).
    pub sourced: usize,
    /// Files in the mirror folder that aren't mirrors; never overwritten.
    pub skipped: Vec<String>,
}

/// Writes the mirror: one read-only file per post, rewritten only when it
/// changed; mirrors whose post is gone are removed. Only marked files are
/// ever written or removed.
/// `sourced` names a post a document is about to claim (just published).
pub fn import(root: &Path, repo: &Path, site: &str, sourced: Option<&str>) -> Result<ImportReport> {
    let host = host(site);
    let posts = posts(repo, site)?;
    let mut paths = Vec::new();
    flatten(vault::tree(root)?, &mut paths);
    let mut claimed: HashSet<String> = sourced.map(String::from).into_iter().collect();
    let mut existing = Vec::new();
    for path in &paths {
        let Ok(text) = fs::read_to_string(root.join(path)) else { continue };
        if is_mirror(&text) {
            existing.push(path.clone());
        } else if let Some(post) = field(&text, "post") {
            claimed.insert(post);
        }
    }
    let mut report = ImportReport { folder: host.clone(), posts: posts.len(), ..Default::default() };
    let mut keep = HashSet::new();
    for post in &posts {
        if claimed.contains(&post.file) {
            report.sourced += 1;
            continue;
        }
        let rel = mirror_path(post, &host);
        let target = vault::resolve(root, &rel)?;
        let text = mirror_text(post, &host);
        if fs::symlink_metadata(&target).is_ok_and(|m| m.file_type().is_symlink()) {
            report.skipped.push(rel);
            continue;
        }
        match fs::read_to_string(&target) {
            Ok(current) if !is_mirror(&current) => {
                report.skipped.push(rel);
                continue;
            }
            Ok(current) if current == text => report.unchanged += 1,
            _ => {
                fs::create_dir_all(target.parent().unwrap()).map_err(err)?;
                vault::write_atomic(&target, &text)?;
                report.written.push(rel.clone());
            }
        }
        keep.insert(rel);
    }
    for path in existing {
        if !keep.contains(&path) && path.starts_with(&format!("{host}/")) {
            fs::remove_file(root.join(&path)).map_err(err)?;
            report.removed.push(path);
        }
    }
    Ok(report)
}

/// An image the post refers to, as `planPublish` described it.
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImageRef {
    pub key: String,
    pub embed: bool,
    pub candidates: Vec<String>,
    pub name: String,
}

fn is_image(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| IMAGE_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

fn regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_file())
}

/// Every image file in the vault by file name, for `![[name.png]]` embeds.
fn images_by_name(root: &Path, dir: &Path, out: &mut HashMap<String, Vec<String>>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(kind) = entry.file_type() else { continue };
        if name.starts_with('.') || kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            images_by_name(root, &entry.path(), out);
        } else if kind.is_file() && is_image(&entry.path()) {
            out.entry(name).or_default().push(vault::relative(root, &entry.path()));
        }
    }
}

/// Vault paths for images: the first candidate that exists, else (embeds) a
/// unique file of that name anywhere in the vault.
pub fn resolve_images(root: &Path, refs: &[ImageRef]) -> BTreeMap<String, Option<String>> {
    let mut by_name: Option<HashMap<String, Vec<String>>> = None;
    refs.iter()
        .map(|r| {
            let found = r.candidates.iter().find(|c| {
                vault::resolve(root, c).is_ok_and(|p| regular_file(&p) && is_image(&p))
            });
            let found = found.cloned().or_else(|| {
                if !r.embed {
                    return None;
                }
                let names = by_name.get_or_insert_with(|| {
                    let mut map = HashMap::new();
                    images_by_name(root, root, &mut map);
                    map
                });
                match names.get(&r.name).map(Vec::as_slice) {
                    Some([only]) => Some(only.clone()),
                    _ => None,
                }
            });
            (r.key.clone(), found)
        })
        .collect()
}

fn safe_relative(rel: &str) -> Result<&Path> {
    let path = Path::new(rel);
    if rel.is_empty() || !path.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err(format!("not a path inside the blog: {rel}"));
    }
    Ok(path)
}

/// Repository modules an `.mdx` post imports: does each exist?
pub fn resolve_imports(repo: &Path, imports: &[String]) -> BTreeMap<String, bool> {
    imports
        .iter()
        .map(|spec| {
            let found = safe_relative(spec).is_ok()
                && MODULE_EXTENSIONS.iter().any(|ext| regular_file(&repo.join(format!("{spec}{ext}"))));
            (spec.clone(), found)
        })
        .collect()
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CopyImage {
    pub from: String,
    pub to: String,
}

#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Written {
    /// Repository-relative files written.
    pub written: Vec<String>,
    pub removed: Vec<String>,
}

/// Creates `rel`'s folder inside the repository, refusing symlinked folders
/// that would lead the write outside it.
fn inside(repo: &Path, rel: &str) -> Result<PathBuf> {
    let path = repo.join(safe_relative(rel)?);
    let parent = path.parent().ok_or("not a file path")?;
    fs::create_dir_all(parent).map_err(err)?;
    if !parent.canonicalize().map_err(err)?.starts_with(repo) {
        return Err(format!("{rel} leads outside the blog repository"));
    }
    if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(format!("refusing to write through a symlink: {rel}"));
    }
    Ok(path)
}

/// Writes a post and its images. `owned` says the document already published
/// this post (or the file it `replaces`); otherwise an existing file is never
/// replaced. Stale images in the post's own image folder are removed.
pub fn write_post(
    root: &Path,
    repo: &Path,
    file: &str,
    replaces: Option<&str>,
    content: &str,
    images: &[CopyImage],
    owned: bool,
) -> Result<Written> {
    let (_, id) = post_file(file).ok_or_else(|| format!("not a blog post file: {file}"))?;
    let target = inside(repo, file)?;
    if target.exists() && !owned {
        return Err(format!("{file} already exists and wasn't published from this document"));
    }
    let folder = format!("{IMAGE_FOLDER}/{id}");
    let mut names = HashSet::new();
    for image in images {
        let name = image.to.strip_prefix(&format!("{folder}/")).unwrap_or("");
        let ok_name = !name.is_empty()
            && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'.'))
            && !name.starts_with('.')
            && is_image(Path::new(name));
        if !ok_name {
            return Err(format!("images go in {folder}/, not {}", image.to));
        }
        let from = vault::resolve(root, &image.from)?;
        if !regular_file(&from) || !is_image(&from) {
            return Err(format!("not an image in the vault: {}", image.from));
        }
        names.insert(name.to_string());
    }
    let mut out = Written::default();
    for image in images {
        let to = inside(repo, &image.to)?;
        let bytes = fs::read(vault::resolve(root, &image.from)?).map_err(err)?;
        if fs::read(&to).ok().as_deref() != Some(&bytes[..]) {
            fs::write(&to, bytes).map_err(err)?;
            out.written.push(image.to.clone());
        }
    }
    if let Ok(entries) = fs::read_dir(repo.join(&folder)) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if entry.file_type().is_ok_and(|t| t.is_file()) && !names.contains(&name) {
                fs::remove_file(entry.path()).map_err(err)?;
                out.removed.push(format!("{folder}/{name}"));
            }
        }
    }
    vault::write_atomic(&target, content)?;
    out.written.push(file.to_string());
    if let Some(old) = replaces.filter(|old| *old != file) {
        let same_post = post_file(old).is_some_and(|(_, old_id)| old_id == id);
        let path = inside(repo, old)?;
        if owned && same_post && regular_file(&path) {
            fs::remove_file(path).map_err(err)?;
            out.removed.push(old.to_string());
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blog() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        fs::create_dir_all(p.join("src/content/writing")).unwrap();
        fs::create_dir_all(p.join("src/content/notes")).unwrap();
        fs::create_dir_all(p.join("src/components")).unwrap();
        fs::write(p.join("src/content.config.ts"), "export const collections = {};").unwrap();
        fs::write(p.join("src/components/Demo.jsx"), "export default () => null;").unwrap();
        fs::write(
            p.join("src/content/writing/2026-09-16-the-sixth-attempt.md"),
            "---\ntitle: The sixth attempt\ntags: [writing, design]\n---\n\nI have built five portfolio websites.\n",
        )
        .unwrap();
        fs::write(p.join("src/content/notes/2026-09-12-friction.md"), "---\ntags:\n  - writing\n---\n\nThe distance between a thought and publishing it. More.\n").unwrap();
        fs::write(p.join("src/content/notes/README.md"), "not a post").unwrap();
        dir
    }

    #[test]
    fn reads_frontmatter_scalars_and_lists() {
        let (front, body) = split("---\ntitle: \"A \\\"b\\\"\"\ntags: [a, 'b c']\nlist:\n  - x\n  - y\nstatus: complete\n---\n\nBody\n");
        assert_eq!(front.scalars["title"], "A \"b\"");
        assert_eq!(front.lists["tags"], ["a", "b c"]);
        assert_eq!(front.lists["list"], ["x", "y"]);
        assert_eq!(front.scalars["status"], "complete");
        assert_eq!(body, "Body\n");
        assert_eq!(split("No frontmatter").1, "No frontmatter");
        assert_eq!(split("---\nunclosed: yes\n").0, Front::default());
    }

    #[test]
    fn lists_posts_and_checks_the_repo() {
        let dir = blog();
        assert!(checked_repo(dir.path()).is_ok());
        assert!(checked_repo(&dir.path().join("src")).is_err());
        let posts = posts(dir.path(), "https://hussain.ph").unwrap();
        assert_eq!(posts.len(), 2);
        assert_eq!(posts[0].file, "src/content/writing/2026-09-16-the-sixth-attempt.md");
        assert_eq!(posts[0].url, "https://hussain.ph/essays/the-sixth-attempt/");
        assert_eq!(posts[0].tags, ["writing", "design"]);
        assert_eq!(posts[1].kind, "note");
        assert_eq!(posts[1].tags, ["writing"]);
        assert_eq!(host("https://hussain.ph/"), "hussain.ph");
        assert_eq!(post_file("src/content/notes/2026-01-02-x.mdx"), Some(("note", "2026-01-02-x".into())));
        assert_eq!(post_file("src/content/other/2026-01-02-x.md"), None);
        assert_eq!(post_file("src/content/writing/../2026-01-02-x.md"), None);
    }

    #[test]
    fn mirrors_posts_read_only_and_keeps_one_source_of_truth() {
        let dir = blog();
        let vault_dir = tempfile::tempdir().unwrap();
        let root = vault_dir.path();
        // A document that published a post is its source: not mirrored again.
        fs::create_dir_all(root.join("posts")).unwrap();
        fs::write(root.join("posts/friction.md"), "---\ntitle: Friction\npost: src/content/notes/2026-09-12-friction.md\nurl: https://hussain.ph/notes/friction/\n---\n\nWords\n").unwrap();
        let report = import(root, dir.path(), "https://hussain.ph", None).unwrap();
        assert_eq!(report.written, ["hussain.ph/essays/the-sixth-attempt.md"]);
        assert_eq!(report.sourced, 1);
        let text = fs::read_to_string(root.join("hussain.ph/essays/the-sixth-attempt.md")).unwrap();
        assert!(text.starts_with("---\ntitle: \"The sixth attempt\"\nstatus: published\ntags: [\"writing\", \"design\"]\ndate: 2026-09-16\nurl: https://hussain.ph/essays/the-sixth-attempt/\npost: src/content/writing/2026-09-16-the-sixth-attempt.md\nmirror: hussain.ph\n---\n\nI have built"));
        assert!(refuse_mirror(root, "hussain.ph/essays/the-sixth-attempt.md").is_err());
        assert!(refuse_mirror(root, "posts/friction.md").is_ok());

        // Unchanged files aren't rewritten; a hand-written file is left alone.
        fs::write(root.join("hussain.ph/notes-mine.md"), "mine").unwrap();
        let again = import(root, dir.path(), "https://hussain.ph", None).unwrap();
        assert!(again.written.is_empty());
        assert_eq!(again.unchanged, 1);

        // The note's source goes away: now it is mirrored, with a stand-in title.
        fs::remove_file(root.join("posts/friction.md")).unwrap();
        import(root, dir.path(), "https://hussain.ph", None).unwrap();
        let note = fs::read_to_string(root.join("hussain.ph/notes/friction.md")).unwrap();
        assert!(note.contains("title: \"The distance between a thought and publishing it\""), "{note}");

        // A post removed from the blog loses its mirror; other files stay.
        fs::remove_file(dir.path().join("src/content/writing/2026-09-16-the-sixth-attempt.md")).unwrap();
        let pruned = import(root, dir.path(), "https://hussain.ph", None).unwrap();
        assert_eq!(pruned.removed, ["hussain.ph/essays/the-sixth-attempt.md"]);
        assert!(root.join("hussain.ph/notes-mine.md").exists());

        let linked = linked(root).unwrap();
        assert_eq!(linked.len(), 1);
        assert!(linked[0].mirror);
    }

    #[test]
    fn writes_posts_and_images_only_where_they_belong() {
        let dir = blog();
        let repo = dir.path().canonicalize().unwrap();
        let vault_dir = tempfile::tempdir().unwrap();
        let root = vault_dir.path();
        fs::create_dir_all(root.join("media")).unwrap();
        fs::write(root.join("media/Bowl.PNG"), b"png").unwrap();
        fs::write(root.join("media/notes.txt"), b"text").unwrap();

        let refs = vec![
            ImageRef { key: "md:../media/Bowl.PNG".into(), embed: false, candidates: vec!["media/Bowl.PNG".into()], name: "Bowl.PNG".into() },
            ImageRef { key: "embed:Bowl.PNG".into(), embed: true, candidates: vec!["posts/Bowl.PNG".into()], name: "Bowl.PNG".into() },
            ImageRef { key: "md:notes.txt".into(), embed: false, candidates: vec!["media/notes.txt".into()], name: "notes.txt".into() },
        ];
        let found = resolve_images(root, &refs);
        assert_eq!(found["md:../media/Bowl.PNG"].as_deref(), Some("media/Bowl.PNG"));
        assert_eq!(found["embed:Bowl.PNG"].as_deref(), Some("media/Bowl.PNG"));
        assert_eq!(found["md:notes.txt"], None);
        let imports = resolve_imports(&repo, &["src/components/Demo".into(), "src/components/Nope".into(), "../etc/passwd".into()]);
        assert_eq!(imports.values().copied().collect::<Vec<_>>(), [false, true, false]);

        let file = "src/content/writing/2026-11-02-on-craft.md";
        let images = [CopyImage { from: "media/Bowl.PNG".into(), to: "public/posts/2026-11-02-on-craft/bowl.png".into() }];
        let written = write_post(root, &repo, file, None, "---\ntitle: x\n---\n\nBody\n", &images, false).unwrap();
        assert_eq!(written.written, ["public/posts/2026-11-02-on-craft/bowl.png", file]);
        assert_eq!(fs::read(repo.join("public/posts/2026-11-02-on-craft/bowl.png")).unwrap(), b"png");

        // Not owned: never replaced. Owned: replaced, stale images removed.
        assert!(write_post(root, &repo, file, None, "other", &[], false).is_err());
        let again = write_post(root, &repo, file, None, "new", &[], true).unwrap();
        assert_eq!(again.removed, ["public/posts/2026-11-02-on-craft/bowl.png"]);
        assert_eq!(fs::read_to_string(repo.join(file)).unwrap(), "new");

        // .md → .mdx replaces the same post's old file.
        let mdx = "src/content/writing/2026-11-02-on-craft.mdx";
        let swapped = write_post(root, &repo, mdx, Some(file), "mdx", &[], true).unwrap();
        assert_eq!(swapped.removed, [file]);
        assert!(!repo.join(file).exists());

        // Paths outside the collections or the post's image folder are refused.
        for bad in ["src/pages/index.md", "src/content/writing/../../x.md", "src/content/writing/2026-11-02-x.txt"] {
            assert!(write_post(root, &repo, bad, None, "x", &[], true).is_err(), "{bad}");
        }
        let elsewhere = [CopyImage { from: "media/Bowl.PNG".into(), to: "public/world/bowl.png".into() }];
        assert!(write_post(root, &repo, mdx, None, "x", &elsewhere, true).is_err());
        let escape = [CopyImage { from: "../outside.png".into(), to: "public/posts/2026-11-02-on-craft/x.png".into() }];
        assert!(write_post(root, &repo, mdx, None, "x", &escape, true).is_err());
    }
}
