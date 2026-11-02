//! `ai_models`: what the model picker and per-task defaults are built on
//! (KI-61). Every provider with a usable credential, and its models with
//! their capabilities and prices, straight from the catalog.
//!
//! ```ts
//! invoke<ProviderModels[]>("ai_models", { all?: boolean })
//! ```
//!
//! By default only providers whose credential works now are listed;
//! `all: true` lists every provider Kin speaks, each with `usable` and the
//! reason in `auth`/`source` (as `ai_providers` reports them). Providers
//! come in Settings order, models sorted by name. Nothing here is secret: no
//! key, token or account id is ever part of the answer.

use super::catalog::{self, Cost, Level};
use super::credentials::Source;
use super::providers::PROVIDERS;
use super::wire::Wire;
use super::{ProviderStatus, Result, shown_statuses, usable};
use serde::Serialize;

/// One provider and its models.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModels {
    pub id: &'static str,
    pub name: &'static str,
    /// What kind of credential there is, or why there isn't a usable one
    /// (as `ai_providers`): `api_key`, `login`, `local`, `mock`,
    /// `unsupported_login`, `expired_login` or `none`.
    pub auth: &'static str,
    /// Where it comes from: `opencode`, `pi`, `env` or `local`.
    pub source: Option<Source>,
    /// A request would find a credential now.
    pub usable: bool,
    /// A flat-rate plan or a local server: calls cost nothing in the ledger,
    /// whatever `price` says.
    pub subscription: bool,
    pub models: Vec<ModelInfo>,
}

/// One model: what it can do and what it costs.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    /// The id to put in a `ModelRef` (`{ provider, model, reasoning? }`).
    pub id: String,
    pub name: String,
    /// The wire format Kin speaks to it (Pi's API id), e.g.
    /// `openai-completions`, `anthropic-messages`.
    pub api: &'static str,
    /// Input tokens it reads, prompt included.
    pub context_window: u64,
    /// The most output tokens one reply may have.
    pub max_output: u64,
    /// It thinks before answering.
    pub reasoning: bool,
    /// The thinking levels it accepts, weakest first: `off`, `minimal`,
    /// `low`, `medium`, `high`, `xhigh`, `max`. A `ModelRef`'s `reasoning`
    /// is one of these; another is moved to the nearest one it supports.
    pub thinking_levels: Vec<Level>,
    /// It calls tools. Always true: Pi's catalog keeps only models that do,
    /// and Kin needs them.
    pub tools: bool,
    /// It reads images.
    pub images: bool,
    /// US dollars per million tokens: `input`, `output`, `cacheRead`,
    /// `cacheWrite`, and `tiers` (`inputTokensAbove` plus the same four),
    /// the rates for a whole request whose input is over that size.
    pub price: Cost,
}

impl ModelInfo {
    fn of(model: &catalog::Model) -> Option<ModelInfo> {
        let wire = Wire::from_api(&model.api)?;
        Some(ModelInfo {
            id: model.id.clone(),
            name: model.name.clone(),
            api: wire.api(),
            context_window: model.context_window,
            max_output: model.max_tokens,
            reasoning: model.reasoning,
            thinking_levels: model.levels(),
            tools: true,
            images: model.images(),
            price: model.cost.clone(),
        })
    }
}

/// Every provider (or only the usable ones) with its catalog models.
pub(super) fn list(statuses: &[ProviderStatus], all: bool) -> Vec<ProviderModels> {
    PROVIDERS
        .iter()
        .filter_map(|p| {
            let status = statuses.iter().find(|s| s.id == p.id)?;
            let ok = usable(status.auth);
            // A local server is usable by hand, never picked automatically.
            if !all && !(ok || status.auth == "local") {
                return None;
            }
            let mut models: Vec<ModelInfo> =
                catalog::models(p.id).filter_map(ModelInfo::of).collect();
            models.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.id.cmp(&b.id)));
            Some(ProviderModels {
                id: p.id,
                name: p.name,
                auth: status.auth,
                source: status.source,
                usable: ok || status.auth == "local",
                subscription: p.subscription,
                models,
            })
        })
        .collect()
}

/// The models Kin can use now, by provider (or, with `all`, every
/// provider's). See the module docs.
#[tauri::command]
pub fn ai_models(all: Option<bool>) -> Result<Vec<ProviderModels>> {
    Ok(list(&shown_statuses()?, all.unwrap_or(false)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(id: &'static str, auth: &'static str) -> ProviderStatus {
        ProviderStatus {
            id,
            name: id,
            auth,
            source: None,
        }
    }

    #[test]
    fn lists_usable_providers_with_capabilities_and_prices() {
        let statuses = vec![
            status("anthropic", "api_key"),
            status("zai", "none"),
            status("openai-codex", "expired_login"),
        ];
        let usable = list(&statuses, false);
        assert_eq!(usable.len(), 1);
        let anthropic = &usable[0];
        assert!(anthropic.usable && !anthropic.subscription);
        let sonnet = anthropic
            .models
            .iter()
            .find(|m| m.id == "claude-sonnet-5-5")
            .unwrap();
        assert_eq!(sonnet.api, "anthropic-messages");
        assert!(sonnet.reasoning && sonnet.tools && sonnet.images);
        assert!(sonnet.context_window > 0 && sonnet.max_output > 0);
        assert!(sonnet.price.rates.input > 0.0);
        // Sonnet 5.5 can't turn thinking off.
        assert!(!sonnet.thinking_levels.contains(&Level::Off));

        let all = list(&statuses, true);
        assert_eq!(all.len(), 3);
        let codex = all.iter().find(|p| p.id == "openai-codex").unwrap();
        assert!(!codex.usable && codex.subscription);
        assert_eq!(codex.auth, "expired_login");
    }

    #[test]
    fn serializes_as_documented() {
        let models = list(&[status("zai", "api_key")], false);
        let json = serde_json::to_value(&models).unwrap();
        let provider = &json[0];
        assert_eq!(provider["id"], "zai");
        assert_eq!(provider["usable"], true);
        let glm = provider["models"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["id"] == "glm-5.3")
            .unwrap();
        for key in [
            "name",
            "api",
            "contextWindow",
            "maxOutput",
            "reasoning",
            "thinkingLevels",
            "tools",
            "images",
        ] {
            assert!(glm.get(key).is_some(), "{key}");
        }
        assert!(glm["price"]["input"].is_number() && glm["price"]["cacheRead"].is_number());
        assert_eq!(glm["thinkingLevels"][0], "low");
        assert!(!json.to_string().to_lowercase().contains("key\":\""));
    }
}
