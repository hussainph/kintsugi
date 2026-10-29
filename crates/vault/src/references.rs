//! A disposable snapshot shared by reference pickers, the margin and backlinks.
//! Only writing documents have outgoing edges; clips are reference targets.
//! Rebuilding from disk (rather than maintaining mutation hooks) also picks up
//! edits made in another app, folder moves and newly enriched clips.

use crate::{ClipSummary, Result, clip_list, err, front_matter, is_doc, relative};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceDocument {
    pub path: String,
    pub title: Option<String>,
    pub status: Option<String>,
    /// The complete Markdown body, without frontmatter, for lexical matching
    /// and paragraph excerpts. This is not a write-back representation.
    pub text: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceLink {
    /// Vault-relative path of the writing document containing the link.
    pub source: String,
    /// First spelling of the file target, without the heading or alias.
    pub target: String,
    /// Null for unresolved (including unsafe or unsupported) targets.
    pub resolved: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceIndex {
    /// Stable case-insensitive path order (original spelling breaks ties).
    pub documents: Vec<ReferenceDocument>,
    /// Newest first, using the same ordering as `clip_list`.
    pub clips: Vec<ClipSummary>,
    /// One edge per source/resolved file, or source/unresolved target. Repeated
    /// links and different aliases/headings do not duplicate backlinks.
    pub links: Vec<ReferenceLink>,
}

/// A parsed Obsidian link. Headings and aliases are display/navigation data,
/// not part of the file name used for resolution. A heading-only link has an
/// empty target, which is unresolved just as in the shared editor resolver.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Wikilink {
    pub target: String,
    pub heading: Option<String>,
    pub alias: Option<String>,
}

/// Scans the current vault without caching or writing anything. Files outside
/// the writing tree and valid `inspiration/*.md` clips are not indexed. Hidden
/// writing entries and symlinks are skipped; clips use their existing safe-path
/// checks. Link text is only looked up in this snapshot, never joined onto the
/// filesystem. Disappearing files are skipped
/// so a concurrent rename/trash does not poison the next refresh.
pub fn reference_index(root: &Path) -> Result<ReferenceIndex> {
    let mut documents = Vec::new();
    scan_documents(root, root, &mut documents)?;
    documents.sort_by(|a, b| {
        a.path
            .to_lowercase()
            .cmp(&b.path.to_lowercase())
            .then_with(|| a.path.cmp(&b.path))
    });

    // Only summaries cross this boundary. Clip own/source text belongs to the
    // library's clip_read/clip_search APIs, not this shared vault snapshot.
    let clips = clip_list(root)?;

    let resolver = Resolver::new(&documents, &clips);
    let mut links = Vec::new();
    for document in &documents {
        let mut seen = HashSet::new();
        for link in wikilinks_in_body(&document.text) {
            let target = resolver.resolve(&link.target);
            let identity = match target {
                Some(target) => (true, target.path.clone()),
                None => (false, link.target.clone()),
            };
            if seen.insert(identity) {
                links.push(ReferenceLink {
                    source: document.path.clone(),
                    target: link.target,
                    resolved: target.map(|t| t.path.clone()),
                });
            }
        }
    }
    Ok(ReferenceIndex {
        documents,
        clips,
        links,
    })
}

fn scan_documents(root: &Path, dir: &Path, documents: &mut Vec<ReferenceDocument>) -> Result<()> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if dir != root && e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(err(e)),
    };
    for entry in entries {
        let entry = entry.map_err(err)?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') || (dir == root && name.eq_ignore_ascii_case(crate::INSPIRATION)) {
            continue;
        }
        // Unlike Path::is_dir, this does not follow a symlink outside the vault
        // or recurse forever through a linked ancestor.
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(err(e)),
        };
        let path = entry.path();
        if file_type.is_dir() {
            scan_documents(root, &path, documents)?;
        } else if file_type.is_file() && is_doc(&path) {
            let text = match fs::read_to_string(&path) {
                Ok(text) => text,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(err(e)),
            };
            let (title, status) = front_matter(text.trim_start_matches('\u{feff}'));
            documents.push(ReferenceDocument {
                path: relative(root, &path),
                title,
                status,
                text: body(&text).to_string(),
            });
        }
    }
    Ok(())
}

/// Strip only a leading YAML block, regardless of the YAML fields it contains.
/// An unfinished frontmatter block is not prose and has no outgoing links.
fn body(text: &str) -> &str {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut lines = text.split_inclusive('\n');
    if lines.next().map(str::trim_end) != Some("---") {
        return text;
    }
    let mut offset = text.find('\n').map_or(text.len(), |i| i + 1);
    for line in lines {
        offset += line.len();
        if matches!(line.trim_end(), "---" | "...") {
            return &text[offset..];
        }
    }
    ""
}

/// Parses links in prose, ignoring YAML frontmatter, backtick/tilde fences,
/// inline code (including multiline spans), HTML comments and escaped openers.
/// Offsets are deliberately not exposed: the editor owns its live syntax tree.
pub fn wikilinks(text: &str) -> Vec<Wikilink> {
    wikilinks_in_body(body(text))
}

fn wikilinks_in_body(text: &str) -> Vec<Wikilink> {
    let mut prose = text.as_bytes().to_vec();
    let fences = mask_fences(text, &mut prose);
    mask_inline_code(&mut prose, &fences);
    let mut links = Vec::new();
    let mut i = 0;
    while i + 1 < prose.len() {
        if prose[i..].starts_with(b"[[") && !escaped(&prose, i) {
            let start = i + 2;
            let mut end = start;
            while end + 1 < prose.len() {
                if prose[end..].starts_with(b"]]") && !escaped(&prose, end) {
                    break;
                }
                if matches!(prose[end], b'[' | b'\n' | b'\r') {
                    break;
                }
                end += 1;
            }
            if prose.get(end..end + 2) == Some(b"]]") {
                // A link intersecting code or a comment is not prose either.
                if prose[start..end] == text.as_bytes()[start..end]
                    && let Some(link) = parse_link(&text[start..end])
                {
                    links.push(link);
                }
                i = end + 2;
                continue;
            }
        }
        i += 1;
    }
    links
}

fn parse_link(inner: &str) -> Option<Wikilink> {
    if inner.contains(['[', ']', '\n', '\r']) {
        return None;
    }
    let (destination, alias) = inner
        .split_once('|')
        .map_or((inner, None), |(target, alias)| {
            // Obsidian's table syntax escapes the alias separator: [[file\|alias]].
            (
                target.strip_suffix('\\').unwrap_or(target),
                Some(alias.trim().to_string()),
            )
        });
    let (target, heading) = destination
        .split_once('#')
        .map_or((destination, None), |(target, heading)| {
            (target, Some(heading.trim().to_string()))
        });
    let target = target.trim();
    if target.is_empty() && heading.as_ref().is_none_or(String::is_empty) {
        return None;
    }
    Some(Wikilink {
        target: target.into(),
        heading,
        alias,
    })
}

fn escaped(bytes: &[u8], index: usize) -> bool {
    bytes[..index]
        .iter()
        .rev()
        .take_while(|b| **b == b'\\')
        .count()
        % 2
        == 1
}

fn mask(bytes: &mut [u8]) {
    for byte in bytes {
        if !matches!(*byte, b'\r' | b'\n') {
            *byte = b' ';
        }
    }
}

fn fence_line(mut line: &str) -> &str {
    // Fences can live inside a blockquote or a list, as quoted examples often
    // do. The 0–3-space rule still applies to the fence within its container.
    loop {
        let trimmed = line.trim_start_matches(' ');
        if line.len() - trimmed.len() > 3 {
            return "";
        }
        line = trimmed;
        if let Some(rest) = line.strip_prefix('>') {
            line = rest.strip_prefix(' ').unwrap_or(rest);
        } else {
            break;
        }
    }
    for mark in ["- ", "* ", "+ "] {
        if let Some(rest) = line.strip_prefix(mark) {
            return rest.trim_start_matches(' ');
        }
    }
    line
}

fn mask_fences(text: &str, prose: &mut [u8]) -> Vec<std::ops::Range<usize>> {
    let mut fence: Option<(u8, usize)> = None;
    let mut ranges = Vec::new();
    let mut start = 0;
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        let plain = fence_line(line.trim_end_matches(['\r', '\n']));
        let bytes = plain.as_bytes();
        let marker = bytes.first().copied().unwrap_or_default();
        let length = bytes.iter().take_while(|b| **b == marker).count();
        let was_fenced = fence.is_some();
        if matches!(marker, b'`' | b'~') && length >= 3 {
            let rest = &plain[length..];
            match fence {
                None if marker != b'`' || !rest.contains('`') => fence = Some((marker, length)),
                Some((mark, size))
                    if marker == mark && length >= size && rest.trim().is_empty() =>
                {
                    fence = None;
                }
                _ => {}
            }
        }
        if !was_fenced && fence.is_some() {
            start = offset;
        }
        if was_fenced && fence.is_none() {
            ranges.push(start..offset + line.len());
        }
        if was_fenced || fence.is_some() {
            mask(&mut prose[offset..offset + line.len()]);
        }
        offset += line.len();
    }
    if fence.is_some() {
        ranges.push(start..text.len());
    }
    ranges
}

fn mask_inline_code(prose: &mut [u8], fences: &[std::ops::Range<usize>]) {
    let mut i = 0;
    let mut region = 0;
    while i < prose.len() {
        while region < fences.len() && i >= fences[region].end {
            region += 1;
        }
        if region < fences.len() && i >= fences[region].start {
            i = fences[region].end;
            continue;
        }
        if prose[i..].starts_with(b"<!--") {
            let end = prose[i + 4..]
                .windows(3)
                .position(|s| s == b"-->")
                .map_or(prose.len(), |end| i + 4 + end + 3);
            mask(&mut prose[i..end]);
            i = end;
            continue;
        }
        if prose[i] != b'`' || escaped(prose, i) {
            i += 1;
            continue;
        }
        let length = prose[i..].iter().take_while(|b| **b == b'`').count();
        let mut end = i + length;
        let mut matched = None;
        // As in the editor parser, a code span may cross line breaks, but must
        // not reach through a fenced code block to find a closing delimiter.
        let limit = fences.get(region).map_or(prose.len(), |range| range.start);
        while end < limit {
            if prose[end] == b'`' {
                let size = prose[end..].iter().take_while(|b| **b == b'`').count();
                if size == length {
                    matched = Some(end + size);
                    break;
                }
                end += size;
            } else {
                end += 1;
            }
        }
        if let Some(end) = matched {
            mask(&mut prose[i..end]);
            i = end;
        } else {
            // An unmatched delimiter is literal Markdown, not an endless span.
            i += length;
        }
    }
}

#[derive(Clone)]
struct Target {
    path: String,
    document: bool,
}

struct Resolver {
    basenames: HashMap<String, Vec<Target>>,
    paths: HashMap<String, Target>,
    stems: HashMap<String, Target>,
}

impl Resolver {
    fn new(documents: &[ReferenceDocument], clips: &[ClipSummary]) -> Self {
        let mut resolver = Self {
            basenames: HashMap::new(),
            paths: HashMap::new(),
            stems: HashMap::new(),
        };
        // Keep the same source order and rules as core's resolveReference:
        // documents first, exact root name preferred, ambiguous basenames
        // unresolved. Exact paths disambiguate without guessing a folder.
        for document in documents {
            resolver.insert(&document.path, true);
        }
        for clip in clips {
            resolver.insert(&clip.path, false);
        }
        resolver
    }

    fn insert(&mut self, path: &str, document: bool) {
        let target = Target {
            path: path.into(),
            document,
        };
        let stem = without_extension(path);
        let basename = stem.rsplit('/').next().unwrap_or(stem);
        self.basenames
            .entry(basename.into())
            .or_default()
            .push(target.clone());
        self.paths.insert(path.into(), target.clone());
        self.stems.entry(stem.into()).or_insert(target);
    }

    fn resolve(&self, target: &str) -> Option<&Target> {
        let target = target.strip_prefix("./").unwrap_or(target);
        // Links are names, not filesystem paths. Never join link text onto the
        // filesystem or normalize traversal into an otherwise valid target.
        if target.contains(['\\', '\0'])
            || target
                .split('/')
                .any(|part| part.is_empty() || matches!(part, "." | ".."))
        {
            return None;
        }
        let stem = without_extension(target);
        if target.contains('/') || stem != target {
            return self.paths.get(target).or_else(|| self.stems.get(stem));
        }
        let candidates = self.basenames.get(target)?;
        let documents = candidates.iter().any(|target| target.document);
        let mut preferred = candidates
            .iter()
            .filter(|target| target.document == documents);
        // A root-level same-kind file is the exact name, even if another folder
        // contains that basename. Otherwise multiple candidates stay unresolved.
        if let Some(root) = preferred
            .clone()
            .find(|target| without_extension(&target.path) == stem)
        {
            return Some(root);
        }
        let first = preferred.next()?;
        preferred.next().is_none().then_some(first)
    }
}

fn without_extension(path: &str) -> &str {
    for extension in [".mdx", ".md"] {
        if let Some(start) = path.len().checked_sub(extension.len())
            && path
                .get(start..)
                .is_some_and(|end| end.eq_ignore_ascii_case(extension))
        {
            return &path[..start];
        }
    }
    path
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ClipCapture, ClipUpdate, ClipVia, clip_create, clip_trash, clip_update};

    fn put(root: &Path, path: &str, text: &str) {
        let path = root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn capture(root: &Path, title: &str, text: &str) -> String {
        clip_create(
            root,
            &ClipCapture {
                title: Some(title.into()),
                text: Some(text.into()),
                url: None,
                note: None,
                image: None,
                image_type: None,
                captured_at: "2026-10-29T14:05".into(),
                via: ClipVia::Mac,
            },
        )
        .unwrap()
    }

    fn targets(text: &str) -> Vec<String> {
        wikilinks(text)
            .into_iter()
            .map(|link| link.target)
            .collect()
    }

    #[test]
    fn parses_aliases_headings_extensions_and_unicode() {
        assert_eq!(
            wikilinks(
                "[[ on-craft.mdx#A heading | Craft ]] [[café]] [[#Local]] [[x\\|table alias]]"
            ),
            vec![
                Wikilink {
                    target: "on-craft.mdx".into(),
                    heading: Some("A heading".into()),
                    alias: Some("Craft".into())
                },
                Wikilink {
                    target: "café".into(),
                    heading: None,
                    alias: None
                },
                Wikilink {
                    target: "".into(),
                    heading: Some("Local".into()),
                    alias: None
                },
                Wikilink {
                    target: "x".into(),
                    heading: None,
                    alias: Some("table alias".into())
                },
            ]
        );
        assert_eq!(
            targets("[[]] [[ ]] [[|alias]] [[#]] [[unfinished [[yes]] [[two\nlines]]"),
            ["yes"]
        );
    }

    #[test]
    fn ignores_frontmatter_code_and_escaped_links() {
        let text = concat!(
            "\u{feff}---\r\ntitle: '[[frontmatter]]'\r\n---\r\n",
            "[[visible]] `[[inline]]` ``a ` [[long-inline]]``\n",
            "`multiline\n[[multiline-code]]` [[after]]\n\n",
            "```md\n[[backticks]]\n````\n",
            "  ~~~~md\n[[tilde]]\n~~~\n[[still-in-tilde]]\n~~~~\n",
            "> ```\n> [[quoted-code]]\n> ```\n",
            "- ```md\n  [[list-code]]\n  ```\n",
            "\\[[escaped]] \\\\[[not-escaped]] \\\\\\[[escaped-again]]\n",
            "<!-- [[comment]] --> [[last#part|alias]]\n",
            "[[intersecting `code`]] [[intersecting <!--comment-->]]\n",
            "`<!--literal comment in code` [[after-comment]]\n",
        );
        assert_eq!(
            targets(text),
            ["visible", "after", "not-escaped", "last", "after-comment"]
        );
        assert!(targets("---\ntitle: [[unfinished-frontmatter]]").is_empty());
        assert_eq!(targets("---\ntitle: ignored\n...\n[[body]]"), ["body"]);
        assert!(targets("`multiline [[code]]\n\n[[more-code]] `").is_empty());
        assert_eq!(targets("`unclosed [[literal]]"), ["literal"]);
        assert_eq!(targets("\\`literal [[not-code]]"), ["not-code"]);
        assert_eq!(targets("~~~\n[[unfinished-fence]]"), Vec::<String>::new());
    }

    #[test]
    fn resolves_documents_first_explicit_clips_and_deterministic_duplicates() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        // Deliberately create in reverse order: filesystem enumeration and the
        // source's own directory must not turn ambiguity into a chosen file.
        put(root, "z/same.mdx", "Z");
        put(
            root,
            "a/same.md",
            "---\ntitle: The first\nstatus: complete\n---\nA body",
        );
        let same_clip = capture(root, "Same", "Clip, not writing");
        let lone_clip = capture(root, "Only clip", "Captured thought");
        put(
            root,
            "z/source.mdx",
            concat!(
                "[[same]] [[same#Heading|alias]] [[SAME]] [[a/same.md]] ",
                "[[same.md]] [[same.mdx]] [[z/same]] [[inspiration/same]] ",
                "[[inspiration/same.md#Heading|clip alias]] [[only-clip]] ",
                "[[missing]] [[missing#part|other]] [[MISSING]] ",
                "[[../same]] [[/a/same]] [[a/../same]] [[inspiration/missing]] [[#local]]",
            ),
        );
        let index = reference_index(root).unwrap();
        assert_eq!(
            index
                .documents
                .iter()
                .map(|d| d.path.as_str())
                .collect::<Vec<_>>(),
            ["a/same.md", "z/same.mdx", "z/source.mdx"]
        );
        assert_eq!(index.documents[0].title.as_deref(), Some("The first"));
        assert_eq!(index.documents[0].status.as_deref(), Some("complete"));
        assert_eq!(index.documents[0].text, "A body");
        let resolved: Vec<_> = index
            .links
            .iter()
            .filter_map(|edge| edge.resolved.as_deref())
            .collect();
        assert_eq!(
            resolved,
            ["a/same.md", "z/same.mdx", &same_clip, &lone_clip]
        );
        assert_eq!(
            index
                .links
                .iter()
                .filter(|edge| edge.resolved.is_none())
                .map(|e| e.target.as_str())
                .collect::<Vec<_>>(),
            [
                "same",
                "SAME",
                "same.md",
                "same.mdx",
                "missing",
                "MISSING",
                "../same",
                "/a/same",
                "a/../same",
                "inspiration/missing",
                ""
            ]
        );
    }

    #[test]
    fn root_names_disambiguate_and_explicit_paths_match_shared_core_rules() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        put(root, "z/same.md", "Z");
        put(root, "a/same.mdx", "A");
        put(root, "same.mdx", "Root");
        put(
            root,
            "drafts/idea.md",
            "A writing document always beats its clip",
        );
        put(root, "café.md", "Unicode names");
        let clip = capture(root, "Idea", "A clip");
        put(
            root,
            "source.md",
            concat!(
                "[[same]] [[same.md]] [[same.mdx]] [[./same]] [[a/same]] ",
                "[[idea]] [[inspiration/idea]] [[drafts/idea.mdx#^block|Alias]] ",
                "[[café]] [[CAFÉ]]",
            ),
        );
        let index = reference_index(root).unwrap();
        assert_eq!(
            index
                .links
                .iter()
                .map(|link| (link.target.as_str(), link.resolved.as_deref()))
                .collect::<Vec<_>>(),
            [
                ("same", Some("same.mdx")),
                ("a/same", Some("a/same.mdx")),
                ("idea", Some("drafts/idea.md")),
                ("inspiration/idea", Some(clip.as_str())),
                ("café", Some("café.md")),
                ("CAFÉ", None),
            ]
        );
    }

    #[test]
    fn document_body_is_not_stripped_as_frontmatter_a_second_time() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        put(
            root,
            "source.md",
            "---\ntitle: Source\n---\n---\n[[target]]\n",
        );
        put(root, "target.md", "Target");
        let index = reference_index(root).unwrap();
        assert_eq!(index.documents[0].text, "---\n[[target]]\n");
        assert_eq!(index.links[0].resolved.as_deref(), Some("target.md"));
    }

    #[test]
    fn snapshot_has_summaries_but_no_clip_text_or_outgoing_edges() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        put(
            root,
            "essay.md",
            "---\ntitle: Essay\nstatus: draft\nref: [[not-an-edge]]\n---\nA paragraph about repair. [[clay]]",
        );
        let path = capture(root, "Clay", "A note [[essay]]");
        clip_update(
            root,
            &path,
            &ClipUpdate {
                summary: Some("Ceramic inspiration".into()),
                site: Some("Craft journal".into()),
                tags: Some(vec!["gold".into()]),
                source: Some("Kintsugi joins broken pottery".into()),
                ..Default::default()
            },
        )
        .unwrap();
        put(root, "inspiration/invalid.md", "[[essay]]");
        put(root, "inspiration/media/not-writing.md", "[[essay]]");
        put(root, ".hidden.md", "[[essay]]");
        put(root, ".private/secret.md", "[[essay]]");
        put(root, "notes.txt", "[[essay]]");
        put(
            root,
            "notes/inspiration/nested.md",
            "A writing document, not a root clip",
        );
        let index = reference_index(root).unwrap();
        assert_eq!(index.documents.len(), 2);
        assert_eq!(index.clips.len(), 1);
        assert_eq!(index.links.len(), 1);
        assert_eq!(index.links[0].source, "essay.md");
        let clip = &index.clips[0];
        assert_eq!(clip.title.as_deref(), Some("Clay"));
        assert_eq!(clip.summary.as_deref(), Some("Ceramic inspiration"));
        assert_eq!(clip.site.as_deref(), Some("Craft journal"));
        assert_eq!(clip.tags, ["gold"]);
        let json = serde_json::to_value(&index).unwrap();
        assert_eq!(json["links"][0]["resolved"], path);
        assert_eq!(json["clips"][0]["path"], path);
        assert!(json["clips"][0].get("text").is_none());
        assert!(json["clips"][0].get("searchText").is_none());
        assert!(json["clips"][0].get("source").is_none());
    }

    #[test]
    fn fresh_scans_follow_saves_folder_renames_trash_and_clip_changes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        put(
            root,
            "drafts/essay.mdx",
            "[[idea]] [[future]] [[drafts/idea]]",
        );
        put(
            root,
            "drafts/idea.md",
            "---\nstatus: draft\n---\nOriginal body",
        );
        let clip = capture(root, "Idea", "A clip");
        let first = reference_index(root).unwrap();
        assert_eq!(first.links[0].resolved.as_deref(), Some("drafts/idea.md"));
        assert!(first.links[1].resolved.is_none());

        crate::rename(root, "drafts", "essays").unwrap();
        crate::write(
            root,
            "essays/idea.md",
            "---\nstatus: complete\n---\nFresh words",
            None,
        )
        .unwrap();
        let future = capture(root, "Future", "New capture");
        clip_update(
            root,
            &clip,
            &ClipUpdate {
                title: Some("Retitled idea".into()),
                summary: Some("Enriched summary".into()),
                source: Some("Enriched source".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let second = reference_index(root).unwrap();
        assert_eq!(second.links[0].source, "essays/essay.mdx");
        assert_eq!(second.links[0].resolved.as_deref(), Some("essays/idea.md"));
        assert_eq!(second.links[1].resolved.as_deref(), Some(future.as_str()));
        assert!(
            second.links[2].resolved.is_none(),
            "explicit old folder paths become unresolved"
        );
        assert_eq!(second.documents[1].status.as_deref(), Some("complete"));
        assert_eq!(second.documents[1].text, "Fresh words");
        assert_eq!(
            second
                .clips
                .iter()
                .find(|c| c.path == clip)
                .unwrap()
                .title
                .as_deref(),
            Some("Retitled idea")
        );
        assert_eq!(
            second
                .clips
                .iter()
                .find(|c| c.path == clip)
                .unwrap()
                .summary
                .as_deref(),
            Some("Enriched summary")
        );

        // Simulate a writing document moving to OS Trash, outside the vault.
        fs::remove_file(root.join("essays/idea.md")).unwrap();
        let third = reference_index(root).unwrap();
        assert_eq!(
            third.links[0].resolved.as_deref(),
            Some(clip.as_str()),
            "clip is the fallback only once the writing document is gone"
        );
        clip_trash(root, &clip, |paths| {
            for path in paths {
                fs::remove_file(path).map_err(err)?;
            }
            Ok(())
        })
        .unwrap();
        let fourth = reference_index(root).unwrap();
        assert!(fourth.links[0].resolved.is_none());
        assert_eq!(fourth.clips.len(), 1);
        fs::remove_dir_all(root.join("essays")).unwrap();
        assert!(reference_index(root).unwrap().links.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn never_follows_document_symlinks_or_link_text_outside_the_vault() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        // The target is inside the test workspace but outside the indexed root.
        let vault = root.join("vault");
        fs::create_dir(&vault).unwrap();
        put(root, "outside.md", "[[private-edge]]");
        symlink(root.join("outside.md"), vault.join("linked.md")).unwrap();
        symlink(root, vault.join("loop")).unwrap();
        put(
            &vault,
            "safe.md",
            "[[linked]] [[loop/outside]] [[../outside]]",
        );
        let index = reference_index(&vault).unwrap();
        assert_eq!(index.documents.len(), 1);
        assert_eq!(index.links.len(), 3);
        assert!(index.links.iter().all(|edge| edge.resolved.is_none()));
    }
}
