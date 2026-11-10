//! Kin's model catalog: every chat model of every provider Kin speaks, with
//! its wire format (`api`), base URL, limits, prices, reasoning support,
//! input modalities and per-model quirks.
//!
//! `catalog.json` is generated from Pi's catalog (`@earendil-works/pi-ai`,
//! `dist/providers/data/*.json`) by `pnpm gen:models` (`scripts/gen-models.mjs`)
//! and checked in; `catalog.extra.json` holds hand-maintained entries for
//! models Pi lacks. Field names and meanings are Pi's (`packages/ai/src/
//! providers/model-schema.ts`), so a refresh is a regenerate, not a port.
//!
//! The catalog decides, per model: the wire format and base URL a request
//! uses (`wire::Route`), what a call costs (`cost`), which thinking levels
//! exist (`levels`), and the largest output it may ask for.

use super::wire::Usage;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::sync::OnceLock;

const CATALOG_JSON: &str = include_str!("catalog.json");

/// USD per million tokens.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rates {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
}

/// Rates for a whole request whose input (fresh, cached and cache-written
/// tokens together) is over `input_tokens_above`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tier {
    pub input_tokens_above: f64,
    #[serde(flatten)]
    pub rates: Rates,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cost {
    #[serde(flatten)]
    pub rates: Rates,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tiers: Vec<Tier>,
}

impl Cost {
    /// The rates for one request: the tier with the highest threshold its
    /// input exceeds, else the base rates (Pi's `calculateCost`).
    pub fn rates_for(&self, usage: &Usage) -> Rates {
        let input = (usage.input + usage.cache_read + usage.cache_write) as f64;
        self.tiers
            .iter()
            .filter(|t| input > t.input_tokens_above)
            .max_by(|a, b| a.input_tokens_above.total_cmp(&b.input_tokens_above))
            .map_or(self.rates, |t| t.rates)
    }

    pub fn usd(&self, usage: &Usage) -> f64 {
        let r = self.rates_for(usage);
        (usage.input as f64 * r.input
            + usage.output as f64 * r.output
            + usage.cache_read as f64 * r.cache_read
            + usage.cache_write as f64 * r.cache_write)
            / 1_000_000.0
    }

    pub const FREE: Cost = Cost {
        rates: Rates {
            input: 0.0,
            output: 0.0,
            cache_read: 0.0,
            cache_write: 0.0,
        },
        tiers: Vec::new(),
    };
}

/// Pi's optional image resize profile. `max_bytes` measures base64 bytes,
/// not the decoded file size. Missing fields use wire-safe defaults.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageResize {
    pub max_width: Option<u32>,
    pub max_height: Option<u32>,
    pub max_bytes: Option<usize>,
    pub jpeg_quality: Option<u8>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInputLimits {
    pub resize: Option<ImageResize>,
    pub max_per_message: Option<usize>,
    pub max_per_request: Option<usize>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputLimits {
    pub max_request_bytes: Option<usize>,
    pub images: Option<ImageInputLimits>,
}

/// One chat model, as Pi describes it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub provider: String,
    pub id: String,
    pub name: String,
    /// Pi's API id: `openai-completions`, `openai-responses`,
    /// `openai-codex-responses`, `anthropic-messages`, `google-generative-ai`,
    /// `google-vertex` or `mistral-conversations`.
    pub api: String,
    pub base_url: String,
    pub reasoning: bool,
    /// `text`, and `image` when it reads images.
    pub input: Vec<String>,
    #[serde(default)]
    pub input_limits: InputLimits,
    pub context_window: u64,
    /// The most output tokens one request may ask for.
    pub max_tokens: u64,
    pub cost: Cost,
    /// The provider's value for each thinking level: a string, `null` for a
    /// level the model doesn't support, absent for the provider's default.
    #[serde(default)]
    pub thinking_level_map: Map<String, Value>,
    /// Per-model quirks, Pi's `compat` (see `wire.rs`).
    #[serde(default)]
    pub compat: Map<String, Value>,
    /// Extra request headers.
    #[serde(default)]
    pub headers: Map<String, Value>,
}

impl Model {
    pub fn flag(&self, name: &str) -> Option<bool> {
        self.compat.get(name).and_then(Value::as_bool)
    }

    pub fn text(&self, name: &str) -> Option<&str> {
        self.compat.get(name).and_then(Value::as_str)
    }

    pub fn images(&self) -> bool {
        self.input.iter().any(|i| i == "image")
    }

    /// The thinking levels this model accepts, `off` first (Pi's
    /// `getSupportedThinkingLevels`).
    pub fn levels(&self) -> Vec<Level> {
        if !self.reasoning {
            return vec![Level::Off];
        }
        Level::ALL
            .into_iter()
            .filter(|level| match self.thinking_level_map.get(level.id()) {
                Some(Value::Null) => false,
                None => !matches!(level, Level::Xhigh | Level::Max),
                Some(_) => true,
            })
            .collect()
    }

    /// The nearest level this model supports: the requested one, else the
    /// next stronger, else the next weaker (Pi's `clampThinkingLevel`).
    pub fn clamp(&self, level: Level) -> Level {
        let levels = self.levels();
        if levels.contains(&level) {
            return level;
        }
        let at = Level::ALL.iter().position(|l| *l == level).unwrap_or(0);
        Level::ALL[at..]
            .iter()
            .chain(Level::ALL[..at].iter().rev())
            .find(|l| levels.contains(l))
            .copied()
            .unwrap_or(Level::Off)
    }
}

/// Pi's thinking levels. Kin's model choices name one as `reasoning`;
/// `"none"` is read as `off`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl Level {
    pub const ALL: [Level; 7] = [
        Level::Off,
        Level::Minimal,
        Level::Low,
        Level::Medium,
        Level::High,
        Level::Xhigh,
        Level::Max,
    ];

    pub fn id(self) -> &'static str {
        match self {
            Level::Off => "off",
            Level::Minimal => "minimal",
            Level::Low => "low",
            Level::Medium => "medium",
            Level::High => "high",
            Level::Xhigh => "xhigh",
            Level::Max => "max",
        }
    }

    pub fn parse(id: &str) -> Option<Level> {
        match id {
            "none" => Some(Level::Off),
            other => Level::ALL.into_iter().find(|l| l.id() == other),
        }
    }
}

#[derive(Deserialize)]
struct File {
    models: Vec<Model>,
}

struct Catalog {
    models: Vec<Model>,
    index: HashMap<(String, String), usize>,
}

fn catalog() -> &'static Catalog {
    static CATALOG: OnceLock<Catalog> = OnceLock::new();
    CATALOG.get_or_init(|| {
        let file: File = serde_json::from_str(CATALOG_JSON).expect("ai/catalog.json is valid");
        let index = file
            .models
            .iter()
            .enumerate()
            .map(|(i, m)| ((m.provider.clone(), m.id.clone()), i))
            .collect();
        Catalog {
            models: file.models,
            index,
        }
    })
}

/// The catalog entry for a provider's model.
pub fn find(provider: &str, id: &str) -> Option<&'static Model> {
    let catalog = catalog();
    catalog
        .index
        .get(&(provider.to_string(), id.to_string()))
        .map(|&i| &catalog.models[i])
}

/// A provider's models, in catalog order (by id).
pub fn models(provider: &str) -> impl Iterator<Item = &'static Model> + use<'_> {
    catalog()
        .models
        .iter()
        .filter(move |m| m.provider == provider)
}

/// Every model, by provider then id.
pub fn all() -> &'static [Model] {
    &catalog().models
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn model(map: Value, reasoning: bool) -> Model {
        serde_json::from_value(json!({
            "provider": "p", "id": "m", "name": "M", "api": "openai-completions",
            "baseUrl": "https://example.com", "reasoning": reasoning, "input": ["text"],
            "contextWindow": 1000, "maxTokens": 100,
            "cost": { "input": 1.0, "output": 2.0, "cacheRead": 0.1, "cacheWrite": 1.25,
                      "tiers": [{ "inputTokensAbove": 200000, "input": 2.0, "output": 4.0, "cacheRead": 0.2, "cacheWrite": 2.5 }] },
            "thinkingLevelMap": map,
        }))
        .unwrap()
    }

    #[test]
    fn the_catalog_parses_and_indexes_every_model() {
        assert!(all().len() > 100);
        let sonnet = find("anthropic", "claude-sonnet-5-5").expect("in Pi's catalog");
        assert_eq!(sonnet.api, "anthropic-messages");
        assert!(sonnet.reasoning && sonnet.images() && sonnet.max_tokens > 0);
        assert!(models("zai").all(|m| m.provider == "zai"));
        assert!(find("anthropic", "no-such-model").is_none());
    }

    #[test]
    fn levels_follow_the_thinking_level_map() {
        let plain = model(json!({}), false);
        assert_eq!(plain.levels(), [Level::Off]);
        let default = model(json!({}), true);
        assert_eq!(
            default.levels(),
            [
                Level::Off,
                Level::Minimal,
                Level::Low,
                Level::Medium,
                Level::High
            ]
        );
        let mapped = model(
            json!({ "off": null, "minimal": null, "xhigh": "xhigh", "max": "max" }),
            true,
        );
        assert_eq!(
            mapped.levels(),
            [
                Level::Low,
                Level::Medium,
                Level::High,
                Level::Xhigh,
                Level::Max
            ]
        );
        assert_eq!(mapped.clamp(Level::Off), Level::Low);
        assert_eq!(default.clamp(Level::Max), Level::High);
        assert_eq!(Level::parse("none"), Some(Level::Off));
        assert_eq!(Level::parse("xhigh"), Some(Level::Xhigh));
        assert_eq!(Level::parse("extreme"), None);
    }

    #[test]
    fn costs_use_the_highest_tier_the_whole_input_exceeds() {
        let m = model(json!({}), false);
        let small = Usage {
            input: 100_000,
            output: 50_000,
            cache_read: 0,
            cache_write: 0,
        };
        assert!((m.cost.usd(&small) - 0.2).abs() < 1e-12);
        let big = Usage {
            input: 100_000,
            output: 0,
            cache_read: 150_000,
            cache_write: 0,
        };
        // 250k input in all: the tier applies to every token.
        assert!((m.cost.usd(&big) - (0.2 + 0.03)).abs() < 1e-9);
    }
}
