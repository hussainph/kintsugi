//! About you: the webview's door to Kin's memory and skills, and the
//! snapshot other Kin work (helper jobs, background reviews) starts from.
//!
//! - `kin_memory`: everything About you shows (current memory, where each
//!   line came from, usage, the change log).
//! - `kin_memory_undo` undoes one change; `kin_memory_edit` is Hussain's own
//!   add / patch / remove (forgetting a line, correcting Kin).
//! - `kin_skills` lists skills with their `/`-menu flag; `kin_skill` reads
//!   one (the editor's `/` menu, KI-37, builds on these).

use super::kin::data_dir;
use super::memory::{Edit, File, Skill, Source, Store, View};
use super::prompt::Memory;
use crate::AppHandle;
use std::path::Path;

type Result<T> = std::result::Result<T, String>;

/// Kin's memory for a vault, with its change log in app data.
pub fn store(app: &AppHandle, root: &Path) -> Result<Store> {
    Store::open(root, data_dir(app).as_deref())
}

/// The frozen memory snapshot for a conversation or a helper job: USER.md,
/// NOTES.md and the skills index. Take it once when the conversation (or
/// job) starts and pass the same value to every turn, so the prompt prefix
/// stays byte-for-byte cached. Counts as one use of each line.
///
/// A background review that updates memory runs the agent loop with this
/// snapshot and `Tools::with_memory(Access { store, source: Source::Review { .. }, remember: true })`,
/// and skips conversations marked "don't remember this".
pub fn snapshot(app: &AppHandle, root: &Path) -> Result<Memory> {
    let store = store(app, root)?;
    let memory = store.snapshot();
    store.loaded(&memory);
    Ok(memory)
}

fn open(app: &AppHandle) -> Result<Store> {
    store(app, &crate::vault::current(app)?)
}

#[tauri::command]
pub fn kin_memory(app: AppHandle) -> Result<View> {
    Ok(open(&app)?.view())
}

#[tauri::command]
pub fn kin_memory_undo(app: AppHandle, change: String) -> Result<View> {
    let store = open(&app)?;
    store.undo(&change, Source::Owner)?;
    Ok(store.view())
}

/// Hussain's own edits, checked like Kin's: caps, duplicates, the scan.
#[tauri::command]
pub fn kin_memory_edit(app: AppHandle, file: String, edits: Vec<Edit>) -> Result<View> {
    let file = File::from_id(&file).ok_or_else(|| format!("unknown memory file {file}"))?;
    let store = open(&app)?;
    store.apply(file, &edits, Source::Owner)?;
    Ok(store.view())
}

#[tauri::command]
pub fn kin_skills(app: AppHandle) -> Result<Vec<Skill>> {
    Ok(open(&app)?.skills())
}

#[tauri::command]
pub fn kin_skill(app: AppHandle, name: String) -> Result<Skill> {
    open(&app)?.skill(&name)
}

#[cfg(test)]
mod tests {
    use super::super::memory::tests::fixture;
    use super::*;

    #[test]
    fn owner_edits_deserialize_from_the_webview() {
        let edits: Vec<Edit> = serde_json::from_str(r#"[{"op":"remove","old":"Likes kilns."},{"op":"add","text":"Hates kilns."}]"#).unwrap();
        let f = fixture();
        let store = f.store();
        store.apply(File::User, &[Edit::Add { text: "Likes kilns.".into() }], Source::Owner).unwrap();
        store.apply(File::User, &edits, Source::Owner).unwrap();
        assert_eq!(store.entries(File::User), ["Hates kilns."]);
        let view = serde_json::to_value(store.view()).unwrap();
        assert_eq!(view["files"][0]["entries"][0]["origin"]["source"]["kind"], "owner");
        assert_eq!(view["changes"][0]["ops"][0]["op"], "remove");
        assert_eq!(view["files"][1]["name"], "NOTES.md");
    }
}
