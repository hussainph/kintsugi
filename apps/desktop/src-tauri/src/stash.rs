//! The shared stash (KI-89), outside the draft and never published.
//! `.kintsugi/stash/<document path>.md` is ordinary Markdown: each item's
//! metadata is a comment, its text follows, and `---` separates items.

use crate::AppHandle;
use crate::ai::comments::Anchor;
use crate::vault::Vault;
use kintsugi_vault::write_atomic;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Emitter, State};

pub use crate::alternatives::Author;
type Result<T> = std::result::Result<T, String>;

pub const DIR: &str = ".kintsugi/stash";
pub const MAX_ITEMS: usize = 500;
pub const MAX_TEXT_CHARS: usize = 8_000;
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
const MARK: &str = "<!-- kintsugi-stash ";
const SEPARATOR: &str = "\n\n---\n\n";
/// A read-modify-write (Kin adds, dismiss) must not interleave with a save.
static EDIT: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Text,
    Idea,
    Rewrite,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StashItem {
    pub id: String,
    pub by: Author,
    pub kind: Kind,
    pub text: String,
    pub created: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor: Option<Anchor>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StashFile {
    pub path: String,
    pub items: Vec<StashItem>,
}

pub fn file_path(root: &Path, doc: &str) -> Result<PathBuf> {
    crate::sidecar::file_path_with_extension(root, DIR, doc, "md")
}

fn validate(items: &[StashItem]) -> Result<()> {
    if items.len() > MAX_ITEMS {
        return Err("The stash is full. Remove an item first.".into());
    }
    let mut ids = HashSet::new();
    for item in items {
        if item.id.trim().is_empty() || item.id.chars().count() > 128 || !ids.insert(&item.id) {
            return Err("Stash items need unique ids.".into());
        }
        if item.created.len() > 128 || item.id.chars().any(char::is_control) {
            return Err("Invalid stash metadata.".into());
        }
        if item.text.trim().is_empty() || item.text.chars().count() > MAX_TEXT_CHARS {
            return Err("Stash text is empty or too long.".into());
        }
        if item.kind == Kind::Rewrite && item.anchor.is_none() {
            return Err("A rewrite needs its original words.".into());
        }
        // Anchor.line is u32, so deserialization already rejects values
        // above JavaScript's safe-integer ceiling. Zero still needs a check.
        if let Some(a) = &item.anchor
            && (a.line == 0
                || a.exact.trim().is_empty()
                || a.exact.chars().count() > MAX_TEXT_CHARS
                || a.prefix.chars().count() > 64
                || a.suffix.chars().count() > 64)
        {
            return Err("Invalid stash anchor.".into());
        }
    }
    Ok(())
}

/// The same scan applies whether a Kin reply is saved or dismissed
/// before the editor's delayed save has reached disk.
fn validate_kin(items: &[StashItem]) -> Result<()> {
    for item in items.iter().filter(|item| item.by == Author::Kin) {
        for text in std::iter::once(item.text.as_str()).chain(
            item.anchor
                .iter()
                .flat_map(|a| [a.exact.as_str(), a.prefix.as_str(), a.suffix.as_str()]),
        ) {
            if let Some(why) = crate::ai::memory::scan(text) {
                return Err(format!("That stash item {why}."));
            }
        }
    }
    Ok(())
}

fn markdown(items: &[StashItem]) -> Result<String> {
    let mut blocks = Vec::new();
    for item in items {
        let mut value = serde_json::to_value(item).map_err(|e| e.to_string())?;
        value.as_object_mut().unwrap().remove("text");
        // A literal metadata marker in his prose stays prose, even after a
        // horizontal rule. Encode that rare case as readable Markdown
        // entities; the flag makes decoding unambiguous and lossless.
        let body = if item.text.contains(MARK) {
            value
                .as_object_mut()
                .unwrap()
                .insert("markerEscaped".into(), true.into());
            item.text
                .replace('&', "&amp;")
                .replace(MARK, "&lt;!-- kintsugi-stash ")
        } else {
            item.text.clone()
        };
        let meta = serde_json::to_string(&value)
            .map_err(|e| e.to_string())?
            .replace('<', "\\u003c")
            .replace('>', "\\u003e")
            .replace('&', "\\u0026");
        blocks.push(format!("{MARK}{meta} -->\n\n{body}"));
    }
    Ok(blocks.join(SEPARATOR) + "\n")
}

fn parse(text: &str) -> Result<Vec<StashItem>> {
    if text.trim().is_empty() {
        return Ok(vec![]);
    }
    let text = text.strip_suffix('\n').unwrap_or(text);
    let separator = format!("{SEPARATOR}{MARK}");
    let mut items = Vec::new();
    for (i, block) in text.split(&separator).enumerate() {
        let block = if i == 0 {
            block.strip_prefix(MARK).ok_or("Invalid stash marker.")?
        } else {
            block
        };
        let (meta, body) = block.split_once(" -->\n\n").ok_or("Invalid stash item.")?;
        let mut value: serde_json::Value =
            serde_json::from_str(meta).map_err(|_| "Invalid stash metadata.")?;
        let body = if value["markerEscaped"] == true {
            body.replace("&lt;!-- kintsugi-stash ", MARK)
                .replace("&amp;", "&")
        } else {
            body.into()
        };
        value
            .as_object_mut()
            .ok_or("Invalid stash metadata.")?
            .insert("text".into(), body.into());
        items.push(serde_json::from_value(value).map_err(|_| "Invalid stash item.")?);
        if items.len() > MAX_ITEMS {
            return Err("The stash is too large.".into());
        }
    }
    validate(&items)?;
    Ok(items)
}

/// Missing is empty; unreadable or damaged is an error, never an empty save.
pub fn load(root: &Path, doc: &str) -> Result<StashFile> {
    let path = file_path(root, doc)?;
    let items = match fs::metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => vec![],
        Err(e) => return Err(e.to_string()),
        Ok(meta) if !meta.is_file() || meta.len() > MAX_FILE_BYTES => {
            return Err("Invalid stash file.".into());
        }
        Ok(_) => parse(&fs::read_to_string(path).map_err(|e| e.to_string())?)?,
    };
    Ok(StashFile {
        path: doc.trim().into(),
        items,
    })
}

fn save_unlocked(root: &Path, doc: &str, items: &[StashItem]) -> Result<()> {
    let path = file_path(root, doc)?;
    if !crate::sidecar::document_path(root, doc)?.is_file() {
        return Err("That document is no longer in the vault.".into());
    }
    validate(items)?;
    // Stashing a Kin reply uses the ordinary save command too. It must
    // pass the same scan as the model's narrow append tool.
    validate_kin(items)?;
    if items.is_empty() {
        return match fs::remove_file(path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        };
    }
    let text = markdown(items)?;
    if text.len() as u64 > MAX_FILE_BYTES {
        return Err("The stash is too large.".into());
    }
    fs::create_dir_all(path.parent().ok_or("Invalid stash path.")?).map_err(|e| e.to_string())?;
    write_atomic(&path, &text)
}

pub fn save(root: &Path, doc: &str, items: Vec<StashItem>) -> Result<()> {
    save_if_unchanged(root, doc, items, None)
}

/// An editor can pass the last loaded items as its base. The comparison
/// and save share the append lock, so a model addition cannot be lost
/// between a frontend load and save. A conflict requires a reload/retry.
pub fn save_if_unchanged(
    root: &Path,
    doc: &str,
    items: Vec<StashItem>,
    base: Option<Vec<StashItem>>,
) -> Result<()> {
    let _edit = EDIT.lock().unwrap();
    if let Some(base) = base
        && load(root, doc)?.items != base
    {
        return Err("The stash changed. Reload it and try again.".into());
    }
    save_unlocked(root, doc, &items)
}

/// Appends a batch together, without replacing the owner's existing items.
pub fn add(root: &Path, doc: &str, items: Vec<StashItem>) -> Result<StashFile> {
    let _edit = EDIT.lock().unwrap();
    let mut file = load(root, doc)?;
    file.items.extend(items);
    save_unlocked(root, doc, &file.items)?;
    Ok(file)
}

pub fn dismiss(root: &Path, doc: &str, id: &str) -> Result<Option<StashItem>> {
    let _edit = EDIT.lock().unwrap();
    let mut file = load(root, doc)?;
    let Some(at) = file.items.iter().position(|item| item.id == id) else {
        return Ok(None);
    };
    let item = file.items.remove(at);
    save_unlocked(root, doc, &file.items)?;
    Ok(Some(item))
}

/// Prefer the item actually removed from disk. A known editor snapshot
/// is only a fallback for a reply dismissed before its delayed save.
/// Owner items never produce Kin's dismissal signal.
fn dismissal_signal(
    stored: Option<StashItem>,
    fallback: Option<StashItem>,
    id: &str,
) -> Result<Option<StashItem>> {
    let selected = match stored {
        Some(item) => Some(item),
        None => match fallback {
            Some(item) => {
                if item.id != id {
                    return Err("The stash item doesn't match its id.".into());
                }
                validate(std::slice::from_ref(&item))?;
                validate_kin(std::slice::from_ref(&item))?;
                Some(item)
            }
            None => None,
        },
    };
    Ok(selected.filter(|item| item.by == Author::Kin))
}

pub fn renamed(root: &Path, from: &str, to: &str) -> Result<()> {
    let _edit = EDIT.lock().unwrap();
    crate::sidecar::renamed_with_extension(root, DIR, from, to, "md")
}

pub fn changed(app: &AppHandle, path: &str) {
    let _ = app.emit("stash:changed", serde_json::json!({ "path": path }));
}

/// Bind a queued frontend operation to the vault it originated in. Use
/// the returned snapshot throughout the operation, even if another vault
/// opens while it waits for the edit lock. No expected-path IO is needed.
pub fn check_expected_root(root: PathBuf, expected_root: Option<&str>) -> Result<PathBuf> {
    if expected_root.is_some_and(|expected| root.as_path() != Path::new(expected)) {
        return Err("The vault changed. Reopen the document.".into());
    }
    Ok(root)
}

// --- Tauri ---------------------------------------------------------------

#[tauri::command]
pub fn stash_load(
    vault: State<Vault>,
    path: String,
    expected_root: Option<String>,
) -> Result<StashFile> {
    let root = check_expected_root(vault.root()?, expected_root.as_deref())?;
    load(&root, &path)
}

#[tauri::command]
pub fn stash_save(
    vault: State<Vault>,
    path: String,
    items: Vec<StashItem>,
    base: Option<Vec<StashItem>>,
    expected_root: Option<String>,
) -> Result<()> {
    let root = check_expected_root(vault.root()?, expected_root.as_deref())?;
    save_if_unchanged(&root, &path, items, base)
}

#[tauri::command]
pub fn stash_dismiss(
    app: AppHandle,
    vault: State<Vault>,
    path: String,
    id: String,
    expected_root: Option<String>,
    item: Option<StashItem>,
) -> Result<()> {
    let root = check_expected_root(vault.root()?, expected_root.as_deref())?;
    let stored = dismiss(&root, &path, &id)?;
    let removed = stored.is_some();
    if let Some(item) = dismissal_signal(stored, item, &id)? {
        crate::ai::stash::dismissed(&app, &root, &path, &item);
    }
    if removed {
        changed(&app, path.trim());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn item(id: &str, text: &str) -> StashItem {
        StashItem {
            id: id.into(),
            by: Author::Owner,
            kind: Kind::Text,
            text: text.into(),
            created: "2026-11-04T10:00:00Z".into(),
            anchor: None,
        }
    }

    #[test]
    fn queued_operations_reject_a_different_vault_without_touching_either_root() {
        let old = tempfile::tempdir().unwrap();
        let current = tempfile::tempdir().unwrap();
        let doc = "a.md";
        for (root, text) in [(old.path(), "Old vault"), (current.path(), "Current vault")] {
            fs::write(root.join(doc), text).unwrap();
            save(root, doc, vec![item("same-id", text)]).unwrap();
        }
        let snapshots: Vec<_> = [old.path(), current.path()]
            .into_iter()
            .map(|root| {
                (
                    root.to_path_buf(),
                    fs::read(root.join(doc)).unwrap(),
                    fs::read(file_path(root, doc).unwrap()).unwrap(),
                )
            })
            .collect();
        let expected = old.path().to_str().unwrap();
        for operation in ["load", "save", "dismiss"] {
            let called = std::cell::Cell::new(false);
            let result =
                check_expected_root(current.path().into(), Some(expected)).and_then(|root| {
                    called.set(true);
                    match operation {
                        "load" => load(&root, doc).map(|_| ()),
                        "save" => save_if_unchanged(
                            &root,
                            doc,
                            vec![item("queued", "Old queued edit")],
                            None,
                        ),
                        "dismiss" => dismiss(&root, doc, "same-id").map(|_| ()),
                        _ => unreachable!(),
                    }
                });
            assert_eq!(
                result.unwrap_err(),
                "The vault changed. Reopen the document."
            );
            assert!(!called.get(), "{operation} ran before the vault check");
        }
        for (root, draft, stash) in snapshots {
            assert_eq!(fs::read(root.join(doc)).unwrap(), draft);
            assert_eq!(fs::read(file_path(&root, doc).unwrap()).unwrap(), stash);
        }
        // Optional guards preserve the older command contract, and a
        // matching expected root returns the same captured path.
        assert_eq!(
            check_expected_root(current.path().into(), None).unwrap(),
            current.path()
        );
        assert_eq!(
            check_expected_root(old.path().into(), Some(expected)).unwrap(),
            old.path()
        );
    }

    #[test]
    fn markdown_roundtrips_multiline_prose_rules_and_anchors_without_changing_the_draft() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.mdx"), "His draft.\n").unwrap();
        let owner = item(
            "one",
            "\nHis *prose*.\n\n---\n\nAnd [[posts/notes]].\n\n---\n\n<!-- kintsugi-stash {literal marker} --> &lt;!-- kintsugi-stash &amp;\n",
        );
        let mut kin = item("two", "A suggested version.");
        kin.by = Author::Kin;
        kin.kind = Kind::Rewrite;
        kin.anchor = Some(Anchor {
            exact: "His draft.".into(),
            prefix: "<!--".into(),
            suffix: "-->".into(),
            line: 1,
        });
        save(root, "a.mdx", vec![owner.clone(), kin.clone()]).unwrap();
        let raw = fs::read_to_string(root.join(DIR).join("a.mdx.md")).unwrap();
        assert!(raw.contains("His *prose*."));
        assert!(raw.contains("\"by\":\"kin\""));
        assert_eq!(load(root, "a.mdx").unwrap().items, [owner, kin]);
        assert_eq!(
            fs::read_to_string(root.join("a.mdx")).unwrap(),
            "His draft.\n"
        );
        assert!(dismiss(root, "a.mdx", "one").unwrap().is_some());
        assert!(dismiss(root, "a.mdx", "one").unwrap().is_none());
        assert_eq!(load(root, "a.mdx").unwrap().items.len(), 1);
        save(root, "a.mdx", vec![]).unwrap();
        assert!(!file_path(root, "a.mdx").unwrap().exists());
    }

    #[test]
    fn appends_moves_and_reorders_are_lossless() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir(root.join("drafts")).unwrap();
        fs::write(root.join("drafts/a.md"), "Draft.").unwrap();
        save(root, "drafts/a.md", vec![item("1", "First")]).unwrap();
        add(root, "drafts/a.md", vec![item("2", "Second")]).unwrap();
        let mut items = load(root, "drafts/a.md").unwrap().items;
        items.reverse();
        save(root, "drafts/a.md", items.clone()).unwrap();
        renamed(root, "drafts/a.md", "drafts/b.md").unwrap();
        assert_eq!(load(root, "drafts/b.md").unwrap().items, items);
        renamed(root, "drafts", "posts").unwrap();
        assert_eq!(load(root, "posts/b.md").unwrap().items, items);
        assert!(!file_path(root, "drafts/a.md").unwrap().exists());
    }

    /// An editor save queued before a real document/folder rename must
    /// never recreate the old sidecar, whether it uses CAS or not.
    fn late_saves_after_rename(folder: bool) {
        for guarded in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            let old = "drafts/a.md";
            let new = if folder { "posts/a.md" } else { "drafts/b.md" };
            fs::create_dir(root.join("drafts")).unwrap();
            fs::write(root.join(old), "The unchanged draft.").unwrap();
            let original = vec![item("1", "Saved before the rename")];
            save(root, old, original.clone()).unwrap();
            let queued = vec![item("2", "An edit queued before the rename")];

            // Match entry_rename/entry_move: move the real source first,
            // then move its sidecar under the stash edit lock.
            let (from, to) = if folder {
                ("drafts", "posts")
            } else {
                (old, new)
            };
            fs::rename(root.join(from), root.join(to)).unwrap();
            renamed(root, from, to).unwrap();
            assert!(!root.join(old).exists());
            let moved = file_path(root, new).unwrap();
            let before = fs::read(&moved).unwrap();

            let base = guarded.then(|| original.clone());
            assert!(save_if_unchanged(root, old, queued, base).is_err());
            assert!(
                !file_path(root, old).unwrap().exists(),
                "old stash recreated; CAS: {guarded}"
            );
            assert_eq!(
                fs::read(&moved).unwrap(),
                before,
                "moved stash changed; CAS: {guarded}"
            );
            assert_eq!(load(root, new).unwrap().items, original);
            assert_eq!(
                fs::read_to_string(root.join(new)).unwrap(),
                "The unchanged draft."
            );
        }
    }

    #[test]
    fn late_saves_after_a_document_rename_cannot_recreate_the_old_stash() {
        late_saves_after_rename(false);
    }

    #[test]
    fn late_saves_after_a_folder_rename_cannot_recreate_the_old_stash() {
        late_saves_after_rename(true);
    }

    #[test]
    fn damaged_files_and_invalid_batches_are_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.md"), "Draft.").unwrap();
        save(root, "a.md", vec![item("1", "First")]).unwrap();
        let path = file_path(root, "a.md").unwrap();
        let before = fs::read(&path).unwrap();
        assert!(add(root, "a.md", vec![item("1", "Duplicate")]).is_err());
        let mut invalid_anchor = item("2", "A rewrite.");
        invalid_anchor.kind = Kind::Rewrite;
        invalid_anchor.anchor = Some(Anchor {
            exact: "Draft.".into(),
            line: 0,
            ..Anchor::default()
        });
        assert!(save(root, "a.md", vec![invalid_anchor.clone()]).is_err());
        let mut unsafe_line = serde_json::to_value(&invalid_anchor).unwrap();
        unsafe_line["anchor"]["line"] = serde_json::json!(9_007_199_254_740_992u64);
        assert!(serde_json::from_value::<StashItem>(unsafe_line).is_err());
        invalid_anchor.anchor.as_mut().unwrap().line = 1;
        assert!(validate(&[invalid_anchor]).is_ok());
        assert_eq!(fs::read(&path).unwrap(), before);
        fs::write(&path, "damaged").unwrap();
        assert!(load(root, "a.md").is_err());
        assert!(add(root, "a.md", vec![item("2", "Second")]).is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "damaged");
        assert!(save(root, "missing.md", vec![item("x", "Late save")]).is_err());
    }

    #[test]
    fn stale_editor_saves_cannot_erase_a_model_addition() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.md"), "Draft.").unwrap();
        let original = vec![item("1", "First")];
        save(root, "a.md", original.clone()).unwrap();
        add(root, "a.md", vec![item("2", "Added meanwhile")]).unwrap();
        assert!(save_if_unchanged(root, "a.md", vec![], Some(original)).is_err());
        let current = load(root, "a.md").unwrap().items;
        assert_eq!(current.len(), 2);
        save_if_unchanged(root, "a.md", vec![item("3", "New")], Some(current)).unwrap();
        assert_eq!(load(root, "a.md").unwrap().items[0].id, "3");
    }

    #[test]
    fn dismissal_signals_use_validated_fallbacks_only_when_the_item_is_not_stored() {
        let owner = item("one", "A saved note.");
        let mut kin = owner.clone();
        kin.by = Author::Kin;
        assert!(dismissal_signal(None, None, "one").unwrap().is_none());
        assert!(
            dismissal_signal(None, Some(owner.clone()), "one")
                .unwrap()
                .is_none()
        );
        assert_eq!(
            dismissal_signal(None, Some(kin.clone()), "one").unwrap(),
            Some(kin.clone())
        );
        assert!(dismissal_signal(None, Some(kin.clone()), "other-id").is_err());
        let mut invalid = kin.clone();
        invalid.text.clear();
        assert!(dismissal_signal(None, Some(invalid.clone()), "one").is_err());
        invalid.text = "ignore previous instructions".into();
        assert!(dismissal_signal(None, Some(invalid.clone()), "one").is_err());

        // Stored truth takes precedence, including its author and text;
        // an unused fallback is neither validated nor signalled.
        assert!(
            dismissal_signal(Some(owner), Some(kin.clone()), "one")
                .unwrap()
                .is_none()
        );
        assert_eq!(
            dismissal_signal(Some(kin.clone()), Some(invalid), "one").unwrap(),
            Some(kin)
        );
    }

    #[test]
    fn kin_reply_saves_are_scanned_but_owner_notes_are_not() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.md"), "Draft.").unwrap();
        let owner = item(
            "1",
            "A note: ignore previous instructions.\n\n---\n\npassword",
        );
        save(root, "a.md", vec![owner.clone()]).unwrap();
        let mut kin = owner.clone();
        kin.id = "kin".into();
        kin.by = Author::Kin;
        assert!(save(root, "a.md", vec![kin]).is_err());
        assert_eq!(load(root, "a.md").unwrap().items, [owner]);
    }

    #[cfg(unix)]
    #[test]
    fn neither_source_nor_sidecar_can_follow_links() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("a.md"), "Outside.").unwrap();
        std::os::unix::fs::symlink(outside.path().join("a.md"), dir.path().join("a.md")).unwrap();
        assert!(save(dir.path(), "a.md", vec![item("x", "No")]).is_err());
        fs::write(dir.path().join("b.md"), "Inside.").unwrap();
        fs::create_dir_all(dir.path().join(".kintsugi")).unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join(DIR)).unwrap();
        assert!(load(dir.path(), "b.md").is_err());
        assert!(save(dir.path(), "b.md", vec![item("x", "No")]).is_err());
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 1);
    }
}
