//! Rewriting `[[links]]` after a document or folder is renamed or moved
//! (KI-13), Obsidian-style: plan first, write only when the writer agrees,
//! and every write (and its undo) is version-checked.
//!
//! A link is rewritten only when it resolved to the old path in the vault as
//! it was before the move, and its text no longer reaches the new path. Its
//! alias, heading, spacing and spelling style (bare name or vault path, with
//! or without an extension, a leading `./`) are kept. Only writing documents
//! are sources, as in the reference index: clips, `inspiration/sources/*.txt`,
//! hidden folders and symlinks are never scanned, and read-only files (the
//! blog mirror) are left out by the caller's `read_only` test.

use crate::references::{Resolver, body, scan_documents, wikilink_spans, without_extension};
use crate::{Result, Write, clip_list, version};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::ops::Range;
use std::path::Path;

/// One link's target replaced. Offsets are UTF-16 code units into the file's
/// `before` text, as the editor counts them.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinkEdit {
    pub from: usize,
    pub to: usize,
    pub insert: String,
}

/// A document whose links need rewriting.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Relink {
    pub path: String,
    /// The version `before` was read at; writing `after` is checked against it.
    pub version: String,
    pub before: String,
    pub after: String,
    /// One per rewritten link, in order.
    pub edits: Vec<LinkEdit>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RelinkPlan {
    pub from: String,
    pub to: String,
    /// Sorted by path.
    pub files: Vec<Relink>,
    /// Links rewritten across all files.
    pub links: usize,
}

/// Where `path` lives after `from` moved to `to`: `from` itself, or anything
/// inside it when it is a folder. `None` when the move doesn't touch it.
pub fn moved_path(path: &str, from: &str, to: &str) -> Option<String> {
    if path == from {
        return Some(to.to_string());
    }
    let rest = path.strip_prefix(from)?.strip_prefix('/')?;
    Some(format!("{to}/{rest}"))
}

/// Plans the rewrite after `from` was renamed or moved to `to` (already done
/// on disk). `open` holds the editor's text for documents open there, which
/// stands in for the disk copy. Nothing is written.
pub fn relink_plan(
    root: &Path,
    from: &str,
    to: &str,
    open: &HashMap<String, String>,
    read_only: impl Fn(&str) -> bool,
) -> Result<RelinkPlan> {
    let mut plan = RelinkPlan {
        from: from.into(),
        to: to.into(),
        files: Vec::new(),
        links: 0,
    };
    if from.is_empty() || to.is_empty() || from == to {
        return Ok(plan);
    }
    let mut documents = Vec::new();
    scan_documents(root, root, &mut documents, &mut HashMap::new())?;
    let mut paths: Vec<String> = documents.into_iter().map(|d| d.path).collect();
    paths.sort();
    let clips = clip_list(root)?;
    let after = Resolver::from_paths(paths.iter().map(String::as_str), &clips);
    let old: Vec<String> = paths
        .iter()
        .map(|p| moved_path(p, to, from).unwrap_or_else(|| p.clone()))
        .collect();
    let before = Resolver::from_paths(old.iter().map(String::as_str), &clips);

    for path in paths {
        let text = match open.get(&path) {
            Some(text) => text.clone(),
            None => match fs::read_to_string(root.join(&path)) {
                Ok(text) => text,
                // Gone or unreadable since the scan: nothing to rewrite.
                Err(_) => continue,
            },
        };
        if read_only(&text) {
            continue;
        }
        let (after_text, edits) = rewrite(&text, from, to, &before, &after);
        if edits.is_empty() {
            continue;
        }
        plan.links += edits.len();
        plan.files.push(Relink {
            path,
            version: version(&text),
            before: text,
            after: after_text,
            edits,
        });
    }
    Ok(plan)
}

/// Rewrites one document's links. Returns the new text and the edits.
fn rewrite(
    text: &str,
    from: &str,
    to: &str,
    before: &Resolver,
    after: &Resolver,
) -> (String, Vec<LinkEdit>) {
    let offset = text.len() - body(text).len();
    let mut changes: Vec<(Range<usize>, String)> = Vec::new();
    for (inner, link) in wikilink_spans(&text[offset..]) {
        if link.target.is_empty() {
            continue;
        }
        let Some(old) = before.resolve(&link.target).filter(|t| t.document) else {
            continue;
        };
        let Some(new_path) = moved_path(&old.path, from, to) else {
            continue;
        };
        // A bare name still finds a document moved to another folder.
        if after.resolve(&link.target).map(|t| t.path.as_str()) == Some(new_path.as_str()) {
            continue;
        }
        let Some(target) = retarget(&link.target, &new_path, after) else {
            continue;
        };
        let range = target_range(&text[offset + inner.start..offset + inner.end]);
        let start = offset + inner.start + range.start;
        changes.push((start..start + range.len(), target));
    }

    let mut out = String::with_capacity(text.len());
    let mut edits = Vec::with_capacity(changes.len());
    let (mut last, mut units) = (0, 0);
    for (range, insert) in changes {
        units += text[last..range.start].encode_utf16().count();
        let from = units;
        units += text[range.clone()].encode_utf16().count();
        out.push_str(&text[last..range.start]);
        out.push_str(&insert);
        edits.push(LinkEdit {
            from,
            to: units,
            insert,
        });
        last = range.end;
    }
    out.push_str(&text[last..]);
    (out, edits)
}

/// The byte range of the file target inside a link's inner text, excluding
/// surrounding spaces, the `#heading` and the `|alias` (also `\|` in tables).
fn target_range(inner: &str) -> Range<usize> {
    let mut end = inner.find('|').unwrap_or(inner.len());
    if inner[..end].ends_with('\\') {
        end -= 1;
    }
    let end = inner[..end].find('#').unwrap_or(end);
    let raw = &inner[..end];
    let start = raw.len() - raw.trim_start().len();
    start..raw.trim_end().len()
}

/// The new spelling for a link that used `original` to reach a document now
/// at `new_path`: the same style (bare name or path, extension or not, `./`)
/// when that resolves unambiguously, else the explicit path. None when no
/// spelling can be a link (a name with `|`, `#` or brackets).
fn retarget(original: &str, new_path: &str, after: &Resolver) -> Option<String> {
    let (prefix, plain) = match original.strip_prefix("./") {
        Some(rest) => ("./", rest),
        None => ("", original),
    };
    let extension = without_extension(plain) != plain;
    let stem = without_extension(new_path);
    let base = |path: &str| path.rsplit('/').next().unwrap_or(path).to_string();
    let preferred = match (plain.contains('/'), extension) {
        (false, false) => base(stem),
        (false, true) => base(new_path),
        (true, false) => stem.to_string(),
        (true, true) => new_path.to_string(),
    };
    for candidate in [preferred, stem.to_string(), new_path.to_string()] {
        if candidate.contains(['|', '#', '[', ']', '\\', '\n', '\r']) {
            return None;
        }
        let spelled = format!("{prefix}{candidate}");
        if after.resolve(&spelled).map(|t| t.path.as_str()) == Some(new_path) {
            return Some(spelled);
        }
    }
    None
}

/// One version-checked write: `text` lands only if the file is still at `base`.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct RelinkWrite {
    pub path: String,
    pub text: String,
    pub base: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "result", rename_all = "lowercase")]
pub enum RelinkResult {
    Saved,
    /// Changed since it was read; left alone.
    Conflict,
    /// Deleted or moved since it was read; left alone.
    Gone,
    /// Refused (a read-only file) or failed; left alone.
    Failed {
        error: String,
    },
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct RelinkOutcome {
    pub path: String,
    #[serde(flatten)]
    pub result: RelinkResult,
}

/// Writes each file with [`crate::update`], so a file changed outside since
/// it was read is never overwritten. Used both to apply a plan and to undo it
/// (with `before`/`after` swapped). `refuse` vetoes a file (read-only ones).
pub fn relink_write(
    root: &Path,
    writes: &[RelinkWrite],
    refuse: impl Fn(&str) -> Result<()>,
) -> Vec<RelinkOutcome> {
    writes
        .iter()
        .map(|write| {
            let result = match refuse(&write.path)
                .and_then(|()| crate::update(root, &write.path, &write.text, &write.base))
            {
                Ok(Write::Saved { .. }) => RelinkResult::Saved,
                Ok(Write::Conflict { .. }) => RelinkResult::Conflict,
                Ok(Write::Gone) => RelinkResult::Gone,
                Err(error) => RelinkResult::Failed { error },
            };
            RelinkOutcome {
                path: write.path.clone(),
                result,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn put(root: &Path, path: &str, text: &str) {
        let path = root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn disk(root: &Path, path: &str) -> String {
        fs::read_to_string(root.join(path)).unwrap()
    }

    fn mirror(text: &str) -> bool {
        text.contains("\nmirror: ")
    }

    /// Renames `from` to `to` on disk, then plans.
    fn plan_after(root: &Path, from: &str, to: &str) -> RelinkPlan {
        fs::rename(root.join(from), root.join(to)).unwrap();
        relink_plan(root, from, to, &HashMap::new(), mirror).unwrap()
    }

    fn after<'a>(plan: &'a RelinkPlan, path: &str) -> &'a str {
        &plan.files.iter().find(|f| f.path == path).unwrap().after
    }

    #[test]
    fn rewrites_a_renamed_document_keeping_style_alias_and_heading() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        put(
            root,
            "notes/repair.md",
            "# Repair\n\nSee [[repair#Gold]] above.\n",
        );
        put(
            root,
            "posts/on-craft.mdx",
            concat!(
                "---\ntitle: \"[[repair]] in the title\"\n---\n\n",
                "[[repair]] and [[notes/repair]] and [[ notes/repair.md | the note ]].\n",
                "[[repair#The gold|gold]] [[./notes/repair]] ![[repair]]\n",
                "| [[repair\\|table]] |\n",
                "`[[repair]]` and\n```\n[[repair]]\n```\n",
                "<!-- [[repair]] --> \\[[repair]] [[repair-not]] [[#Local]]\n",
            ),
        );
        let plan = plan_after(root, "notes/repair.md", "notes/mending.md");
        assert_eq!(
            after(&plan, "posts/on-craft.mdx"),
            concat!(
                "---\ntitle: \"[[repair]] in the title\"\n---\n\n",
                "[[mending]] and [[notes/mending]] and [[ notes/mending.md | the note ]].\n",
                "[[mending#The gold|gold]] [[./notes/mending]] ![[mending]]\n",
                "| [[mending\\|table]] |\n",
                "`[[repair]]` and\n```\n[[repair]]\n```\n",
                "<!-- [[repair]] --> \\[[repair]] [[repair-not]] [[#Local]]\n",
            )
        );
        // The renamed document's links to itself follow it too.
        assert_eq!(
            after(&plan, "notes/mending.md"),
            "# Repair\n\nSee [[mending#Gold]] above.\n"
        );
        assert_eq!(plan.links, 8);
        assert_eq!(plan.files.len(), 2);
        // Nothing is written by planning.
        assert!(disk(root, "posts/on-craft.mdx").contains("[[notes/repair]]"));
    }

    #[test]
    fn a_folder_move_rewrites_paths_but_bare_names_still_resolve() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        put(root, "notes/repair.md", "Repair.\n");
        put(root, "notes/deep/attention.md", "Attention.\n");
        put(
            root,
            "welcome.md",
            "[[repair]] [[notes/repair]] [[notes/deep/attention#Cost|cost]] [[attention]] [[notes-old/x]]\n",
        );
        let plan = plan_after(root, "notes", "jottings");
        assert_eq!(plan.files.len(), 1);
        assert_eq!(
            after(&plan, "welcome.md"),
            "[[repair]] [[jottings/repair]] [[jottings/deep/attention#Cost|cost]] [[attention]] [[notes-old/x]]\n"
        );
        assert_eq!(plan.links, 2);
    }

    #[test]
    fn only_links_that_resolved_to_the_old_path_are_touched() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        put(root, "a/x.md", "A.\n");
        put(root, "b/x.md", "B.\n");
        put(root, "c/y.md", "Y.\n");
        put(
            root,
            "inspiration/y.md",
            "---\ntitle: A clip\nurl: https://example.com\n---\n\nClip.\n",
        );
        // [[x]] is ambiguous (unresolved), [[b/x]] is someone else, and
        // [[inspiration/y]] is the clip, not the document.
        put(
            root,
            "links.md",
            "[[x]] [[b/x]] [[a/x]] [[y]] [[inspiration/y]]\n",
        );
        let plan = plan_after(root, "a/x.md", "a/z.md");
        assert_eq!(
            after(&plan, "links.md"),
            "[[x]] [[b/x]] [[a/z]] [[y]] [[inspiration/y]]\n"
        );
        fs::rename(root.join("c/y.md"), root.join("c/w.md")).unwrap();
        let plan = relink_plan(root, "c/y.md", "c/w.md", &HashMap::new(), mirror).unwrap();
        // The document won [[y]] over the clip, so the link follows it.
        assert_eq!(
            after(&plan, "links.md"),
            "[[x]] [[b/x]] [[a/x]] [[w]] [[inspiration/y]]\n"
        );
    }

    #[test]
    fn a_name_that_becomes_ambiguous_falls_back_to_the_path() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        put(root, "notes/repair.md", "Repair.\n");
        put(root, "posts/craft.mdx", "Craft.\n");
        put(root, "links.md", "[[repair|mend]] [[craft]]\n");
        let plan = plan_after(root, "notes/repair.md", "notes/craft.md");
        // [[craft]] meant posts/craft and is now ambiguous, but it never
        // pointed at the renamed file, so it is left for the writer.
        assert_eq!(after(&plan, "links.md"), "[[notes/craft|mend]] [[craft]]\n");
    }

    #[test]
    fn skips_mirrors_hidden_folders_and_clips_and_reads_open_documents() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        put(root, "notes/repair.md", "Repair.\n");
        put(
            root,
            "hussain.ph/post.md",
            "---\ntitle: Post\nmirror: hussain.ph\n---\n\n[[repair]]\n",
        );
        put(root, ".obsidian/x.md", "[[repair]]\n");
        put(
            root,
            "inspiration/clip.md",
            "---\ntitle: Clip\n---\n\n[[repair]]\n",
        );
        put(root, "inspiration/sources/clip.txt", "[[repair]]\n");
        put(root, "open.md", "On disk: [[repair]]\n");
        fs::rename(root.join("notes/repair.md"), root.join("notes/mended.md")).unwrap();
        let open = HashMap::from([("open.md".to_string(), "Typed 😀 [[repair]]\n".to_string())]);
        let plan = relink_plan(root, "notes/repair.md", "notes/mended.md", &open, mirror).unwrap();
        assert_eq!(plan.files.len(), 1);
        let file = &plan.files[0];
        assert_eq!(file.path, "open.md");
        assert_eq!(file.before, "Typed 😀 [[repair]]\n");
        assert_eq!(file.after, "Typed 😀 [[mended]]\n");
        assert_eq!(file.version, version(&file.before));
        // UTF-16: the emoji is two units, so the target starts at 11.
        assert_eq!(
            file.edits,
            [LinkEdit {
                from: 11,
                to: 17,
                insert: "mended".into()
            }]
        );
    }

    #[test]
    fn writes_are_version_checked_and_undo_restores() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        put(root, "notes/repair.md", "Repair.\n");
        put(root, "one.md", "[[notes/repair]]\n");
        put(root, "two.md", "[[repair]]\n");
        put(root, "three.md", "[[repair]] too\n");
        let plan = plan_after(root, "notes/repair.md", "notes/mended.md");
        assert_eq!(plan.files.len(), 3);
        // Changed and removed by another app after the plan was read.
        put(root, "two.md", "[[repair]] edited elsewhere\n");
        fs::remove_file(root.join("three.md")).unwrap();
        let writes: Vec<RelinkWrite> = plan
            .files
            .iter()
            .map(|f| RelinkWrite {
                path: f.path.clone(),
                text: f.after.clone(),
                base: f.version.clone(),
            })
            .collect();
        let outcomes = relink_write(root, &writes, |_| Ok(()));
        let results: Vec<_> = outcomes
            .iter()
            .map(|o| (o.path.as_str(), o.result.clone()))
            .collect();
        assert_eq!(
            results,
            [
                ("one.md", RelinkResult::Saved),
                ("three.md", RelinkResult::Gone),
                ("two.md", RelinkResult::Conflict),
            ]
        );
        assert_eq!(disk(root, "one.md"), "[[notes/mended]]\n");
        assert_eq!(disk(root, "two.md"), "[[repair]] edited elsewhere\n");
        assert!(
            !root.join("three.md").exists(),
            "a gone file is not recreated"
        );

        // A refused file is never written.
        let refused = relink_write(root, &writes[..1], |p| Err(format!("{p} is read-only")));
        assert_eq!(
            refused[0].result,
            RelinkResult::Failed {
                error: "one.md is read-only".into()
            }
        );

        // Undo: the old text back, checked against what was written.
        let undo = |file: &Relink| RelinkWrite {
            path: file.path.clone(),
            text: file.before.clone(),
            base: version(&file.after),
        };
        let one = plan.files.iter().find(|f| f.path == "one.md").unwrap();
        put(root, "four.md", "x");
        let edited = RelinkWrite {
            path: "four.md".into(),
            text: "y".into(),
            base: version("not x"),
        };
        let undone = relink_write(root, &[undo(one), edited], |_| Ok(()));
        assert_eq!(undone[0].result, RelinkResult::Saved);
        assert_eq!(disk(root, "one.md"), "[[notes/repair]]\n");
        // Edited since the rewrite: undo leaves it alone.
        assert_eq!(undone[1].result, RelinkResult::Conflict);
        assert_eq!(disk(root, "four.md"), "x");
    }

    #[test]
    fn moved_paths_cover_files_and_folder_contents_only() {
        assert_eq!(
            moved_path("notes/a.md", "notes/a.md", "notes/b.md").as_deref(),
            Some("notes/b.md")
        );
        assert_eq!(
            moved_path("notes/a.md", "notes", "jot").as_deref(),
            Some("jot/a.md")
        );
        assert_eq!(moved_path("notes-2/a.md", "notes", "jot"), None);
        assert_eq!(moved_path("other.md", "notes", "jot"), None);
    }
}
