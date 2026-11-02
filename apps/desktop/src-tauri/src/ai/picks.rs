//! The model picked for one conversation in Kin's chat (KI-61).
//!
//! `models.json` in a vault's conversation folder (`<vault>/.kintsugi/kin/`,
//! beside `log.jsonl` and `threads.json`; see `history::vault_dir`) maps a
//! conversation (a thread's topic key, `""` for general) to the model he
//! picked for it in the chat's composer:
//! `{ "<topic>": { provider, model, reasoning? } }`. It moves with the vault
//! and never applies to another vault's thread of the same name. Hidden like
//! the rest of `.kintsugi/`: the watcher, search and Kin's tools never see it.
//! Functions take that folder, not the vault.

use super::ModelRef;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

type Result<T> = std::result::Result<T, String>;

/// The file, in a vault's conversation folder.
pub const FILE: &str = "models.json";

/// The longest topic key kept; a key is a vault path or a short id.
const MAX_TOPIC_BYTES: usize = 1_024;

/// One write at a time, so two quick picks can't lose each other.
static WRITE: Mutex<()> = Mutex::new(());

fn path(dir: &Path) -> PathBuf {
    dir.join(FILE)
}

/// Every pick in this conversation folder. A missing or unreadable file is no picks.
pub fn all(dir: &Path) -> BTreeMap<String, ModelRef> {
    std::fs::read_to_string(path(dir))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// The model picked for this conversation, if any.
pub fn get(dir: &Path, topic: &str) -> Option<ModelRef> {
    all(dir).remove(topic)
}

/// Picks a model for this conversation, or (`None`) goes back to the chat
/// default.
pub fn set(dir: &Path, topic: &str, model: Option<ModelRef>) -> Result<()> {
    if topic.len() > MAX_TOPIC_BYTES {
        return Err("That conversation's name is too long.".into());
    }
    let _guard = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let mut picks = all(dir);
    match model {
        Some(m) => {
            picks.insert(topic.into(), m);
        }
        None => {
            if picks.remove(topic).is_none() {
                return Ok(());
            }
        }
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("Couldn't save the model choice: {e}"))?;
    let file = path(dir);
    let text = serde_json::to_string_pretty(&picks).map_err(|e| e.to_string())?;
    kintsugi_vault::write_atomic(&file, &text)
        .map_err(|e| format!("Couldn't save the model choice: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(id: &str) -> ModelRef {
        ModelRef {
            provider: "opencode-go".into(),
            model: id.into(),
            reasoning: None,
        }
    }

    #[test]
    fn picks_are_kept_per_conversation_and_cleared() {
        let vault = tempfile::tempdir().unwrap();
        assert_eq!(get(vault.path(), "drafts/a.md"), None);
        set(vault.path(), "drafts/a.md", Some(model("glm-5.3-flash"))).unwrap();
        set(vault.path(), "", Some(model("qwen3.7-plus"))).unwrap();
        assert_eq!(
            get(vault.path(), "drafts/a.md"),
            Some(model("glm-5.3-flash"))
        );
        assert_eq!(get(vault.path(), ""), Some(model("qwen3.7-plus")));
        assert_eq!(get(vault.path(), "drafts/b.md"), None);
        set(vault.path(), "drafts/a.md", None).unwrap();
        assert_eq!(get(vault.path(), "drafts/a.md"), None);
        assert_eq!(get(vault.path(), ""), Some(model("qwen3.7-plus")));
        // Clearing a conversation with no pick writes nothing new.
        set(vault.path(), "nothing", None).unwrap();
        assert_eq!(all(vault.path()).len(), 1);
        assert!(vault.path().join(FILE).is_file());
    }

    #[test]
    fn a_damaged_file_is_no_picks_and_the_next_pick_replaces_it() {
        let vault = tempfile::tempdir().unwrap();
        std::fs::write(vault.path().join(FILE), "{not json").unwrap();
        assert!(all(vault.path()).is_empty());
        set(vault.path(), "x", Some(model("glm-5.3-flash"))).unwrap();
        assert_eq!(get(vault.path(), "x"), Some(model("glm-5.3-flash")));
    }

    #[test]
    fn an_overlong_topic_is_refused() {
        let vault = tempfile::tempdir().unwrap();
        assert!(set(vault.path(), &"x".repeat(2_000), Some(model("a"))).is_err());
    }
}
