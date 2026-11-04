//! The model and effort picked for one thread of Kin's (KI-61, KI-77,
//! KI-104).
//!
//! `models.json` in a vault's Kin folder (`<vault>/.kintsugi/kin/`, beside
//! `threads/`; see `threads::vault_dir`) maps a thread's id to what he
//! picked for it in the composer, and `""` to what he picked in a new
//! thread's composer before sending (the thread takes it when it starts):
//! `{ "<thread>": { provider?, model?, reasoning? } }`. `provider` and `model`
//! name the model (absent: the chat default); `reasoning` is the thinking
//! level (absent: the chat's default effort). It moves with the vault.
//! Hidden like the rest of `.kintsugi/`: the watcher, search and Kin's tools
//! never see it. Functions take that folder, not the vault.

use super::ModelRef;
use serde::{Deserialize, Serialize};
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

/// What he picked for one conversation: a model, an effort, or both.
/// Reads KI-61's `{ provider, model }` entries unchanged.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Pick {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// A thinking level (`catalog::Level`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
}

impl Pick {
    /// The model picked, without the effort.
    pub fn model_ref(&self) -> Option<ModelRef> {
        Some(ModelRef {
            provider: self.provider.clone()?,
            model: self.model.clone()?,
            reasoning: None,
        })
    }

    #[cfg(test)]
    pub fn with_model(model: ModelRef) -> Pick {
        Pick {
            provider: Some(model.provider),
            model: Some(model.model),
            reasoning: None,
        }
    }

    fn is_empty(&self) -> bool {
        self.model_ref().is_none() && self.reasoning.is_none()
    }
}

fn path(dir: &Path) -> PathBuf {
    dir.join(FILE)
}

/// Every pick in this conversation folder. A missing or unreadable file is no picks.
pub fn all(dir: &Path) -> BTreeMap<String, Pick> {
    std::fs::read_to_string(path(dir))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// What was picked for this conversation, if anything.
pub fn get(dir: &Path, topic: &str) -> Option<Pick> {
    all(dir).remove(topic).filter(|p| !p.is_empty())
}

/// Picks a model for this conversation, or (`None`) goes back to the chat
/// default. The effort picked for it stays.
pub fn set(dir: &Path, topic: &str, model: Option<ModelRef>) -> Result<()> {
    change(dir, topic, |pick| {
        let (provider, model) = model.map(|m| (m.provider, m.model)).unzip();
        pick.provider = provider;
        pick.model = model;
    })
}

/// Picks a thinking level for this conversation, or (`None`) goes back to
/// the chat's default effort. The model picked for it stays.
pub fn set_effort(dir: &Path, topic: &str, effort: Option<String>) -> Result<()> {
    change(dir, topic, |pick| pick.reasoning = effort)
}

/// A new thread takes what was picked in its composer before it started
/// (`""`), and the next new thread starts from the defaults again.
pub fn hand_over(dir: &Path, to: &str) -> Result<()> {
    let Some(pick) = get(dir, "") else {
        return Ok(());
    };
    put(dir, to, pick)?;
    change(dir, "", |p| *p = Pick::default())
}

/// Gives a conversation a whole pick (a thread taking over an old topic's).
pub fn put(dir: &Path, topic: &str, pick: Pick) -> Result<()> {
    change(dir, topic, |p| *p = pick)
}

fn change(dir: &Path, topic: &str, edit: impl FnOnce(&mut Pick)) -> Result<()> {
    if topic.len() > MAX_TOPIC_BYTES {
        return Err("That conversation's name is too long.".into());
    }
    let _guard = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let mut picks = all(dir);
    let before = picks.get(topic).cloned();
    let mut pick = before.clone().unwrap_or_default();
    edit(&mut pick);
    if pick.is_empty() {
        if picks.remove(topic).is_none() {
            return Ok(());
        }
    } else if before.as_ref() == Some(&pick) {
        return Ok(());
    } else {
        picks.insert(topic.into(), pick);
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

    fn picked(id: &str) -> Option<Pick> {
        Some(Pick::with_model(model(id)))
    }

    #[test]
    fn picks_are_kept_per_conversation_and_cleared() {
        let vault = tempfile::tempdir().unwrap();
        assert_eq!(get(vault.path(), "drafts/a.md"), None);
        set(vault.path(), "drafts/a.md", Some(model("glm-5.3-flash"))).unwrap();
        set(vault.path(), "", Some(model("qwen3.7-plus"))).unwrap();
        assert_eq!(get(vault.path(), "drafts/a.md"), picked("glm-5.3-flash"));
        assert_eq!(get(vault.path(), ""), picked("qwen3.7-plus"));
        assert_eq!(get(vault.path(), "drafts/b.md"), None);
        set(vault.path(), "drafts/a.md", None).unwrap();
        assert_eq!(get(vault.path(), "drafts/a.md"), None);
        assert_eq!(get(vault.path(), ""), picked("qwen3.7-plus"));
        // Clearing a conversation with no pick writes nothing new.
        set(vault.path(), "nothing", None).unwrap();
        assert_eq!(all(vault.path()).len(), 1);
        assert!(vault.path().join(FILE).is_file());
    }

    #[test]
    fn the_effort_is_kept_beside_the_model_and_cleared_on_its_own() {
        let vault = tempfile::tempdir().unwrap();
        let dir = vault.path();
        // An effort alone: the chat default model, at this level.
        set_effort(dir, "t", Some("high".into())).unwrap();
        let pick = get(dir, "t").unwrap();
        assert_eq!(
            (pick.model_ref(), pick.reasoning.as_deref()),
            (None, Some("high"))
        );
        // A model picked later keeps it, and so does going back to the default model.
        set(dir, "t", Some(model("glm-5.3"))).unwrap();
        let pick = get(dir, "t").unwrap();
        assert_eq!(pick.model_ref(), Some(model("glm-5.3")));
        assert_eq!(pick.reasoning.as_deref(), Some("high"));
        set_effort(dir, "t", None).unwrap();
        assert_eq!(get(dir, "t"), picked("glm-5.3"));
        set(dir, "t", None).unwrap();
        assert_eq!(get(dir, "t"), None);
        assert!(all(dir).is_empty());
        // KI-61's entries, on disk, stay readable and stay the same shape.
        set(dir, "u", Some(model("glm-5.3"))).unwrap();
        let text = std::fs::read_to_string(dir.join(FILE)).unwrap();
        let json: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            json["u"],
            serde_json::json!({ "provider": "opencode-go", "model": "glm-5.3" })
        );
    }

    #[test]
    fn a_damaged_file_is_no_picks_and_the_next_pick_replaces_it() {
        let vault = tempfile::tempdir().unwrap();
        std::fs::write(vault.path().join(FILE), "{not json").unwrap();
        assert!(all(vault.path()).is_empty());
        set(vault.path(), "x", Some(model("glm-5.3-flash"))).unwrap();
        assert_eq!(get(vault.path(), "x"), picked("glm-5.3-flash"));
    }

    #[test]
    fn an_overlong_topic_is_refused() {
        let vault = tempfile::tempdir().unwrap();
        assert!(set(vault.path(), &"x".repeat(2_000), Some(model("a"))).is_err());
    }
}
