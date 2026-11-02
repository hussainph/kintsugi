//! Every provider Kin speaks: Pi's providers on the wire formats Kin
//! implements (`wire.rs`), with their default base URL, environment keys and
//! whether a call is paid per token. Ported from Pi's provider files and
//! `env-api-keys.ts` (`@earendil-works/pi-ai` 1.5.0).
//!
//! A model's own wire format and base URL come from the catalog
//! (`catalog.rs`); a provider's defaults here serve models the catalog
//! doesn't list. Left out: Amazon Bedrock (AWS request signing), Azure and
//! Cloudflare (per-account URLs), and Pi's own Radius gateway.

use super::wire::Wire;

#[derive(Debug)]
pub struct Provider {
    pub id: &'static str,
    pub name: &'static str,
    /// For models the catalog doesn't list.
    pub base_url: &'static str,
    pub wire: Wire,
    /// Read, in order, when neither OpenCode nor Pi holds a credential
    /// (GUI apps rarely inherit shell env).
    pub env_keys: &'static [&'static str],
    /// Local servers take no key at all.
    pub keyless: bool,
    /// A flat-rate plan: its calls cost nothing in the ledger, though
    /// their tokens are still counted.
    pub subscription: bool,
}

const fn p(
    id: &'static str,
    name: &'static str,
    base_url: &'static str,
    wire: Wire,
    env_keys: &'static [&'static str],
) -> Provider {
    Provider {
        id,
        name,
        base_url,
        wire,
        env_keys,
        keyless: false,
        subscription: false,
    }
}

const fn plan(provider: Provider) -> Provider {
    Provider {
        subscription: true,
        ..provider
    }
}

use Wire::{Anthropic, Codex, Google, OpenAiChat, OpenAiResponses, Vertex};

/// In the order Settings lists them: the ones the default models use first.
pub const PROVIDERS: &[Provider] = &[
    p(
        "anthropic",
        "Anthropic",
        "https://api.anthropic.com",
        Anthropic,
        &["ANTHROPIC_API_KEY"],
    ),
    plan(p(
        "openai-codex",
        "ChatGPT (Codex)",
        "https://chatgpt.com/backend-api",
        Codex,
        &[],
    )),
    p(
        "openai",
        "OpenAI",
        "https://api.openai.com/v1",
        OpenAiResponses,
        &["OPENAI_API_KEY"],
    ),
    p(
        "openrouter",
        "OpenRouter",
        "https://openrouter.ai/api/v1",
        OpenAiChat,
        &["OPENROUTER_API_KEY"],
    ),
    plan(p(
        "zai",
        "Z.AI",
        "https://api.z.ai/api/coding/paas/v4",
        OpenAiChat,
        &["ZAI_API_KEY"],
    )),
    // OpenCode's gateways serve each model on its native API; the catalog
    // names it per model.
    p(
        "opencode",
        "OpenCode Zen",
        "https://opencode.ai/inference/openai/v1",
        OpenAiChat,
        &["OPENCODE_API_KEY"],
    ),
    plan(p(
        "opencode-go",
        "OpenCode Go",
        "https://opencode.ai/inference/go/openai/v1",
        OpenAiChat,
        &["OPENCODE_API_KEY"],
    )),
    p(
        "google",
        "Google Gemini",
        "https://generativelanguage.googleapis.com/v1beta",
        Google,
        &["GEMINI_API_KEY"],
    ),
    p(
        "google-vertex",
        "Google Vertex AI",
        "https://aiplatform.googleapis.com",
        Vertex,
        &["GOOGLE_CLOUD_API_KEY"],
    ),
    p(
        "xai",
        "xAI",
        "https://api.x.ai/v1",
        OpenAiResponses,
        &["XAI_API_KEY"],
    ),
    p(
        "groq",
        "Groq",
        "https://api.groq.com/openai/v1",
        OpenAiChat,
        &["GROQ_API_KEY"],
    ),
    p(
        "cerebras",
        "Cerebras",
        "https://api.cerebras.ai/v1",
        OpenAiChat,
        &["CEREBRAS_API_KEY"],
    ),
    p(
        "mistral",
        "Mistral",
        "https://api.mistral.ai/v1",
        OpenAiChat,
        &["MISTRAL_API_KEY"],
    ),
    p(
        "deepseek",
        "DeepSeek",
        "https://api.deepseek.com",
        OpenAiChat,
        &["DEEPSEEK_API_KEY"],
    ),
    p(
        "together",
        "Together",
        "https://api.together.ai/v1",
        OpenAiChat,
        &["TOGETHER_API_KEY"],
    ),
    p(
        "fireworks",
        "Fireworks",
        "https://api.fireworks.ai/inference/v1",
        OpenAiChat,
        &["FIREWORKS_API_KEY"],
    ),
    p(
        "vercel-ai-gateway",
        "Vercel AI Gateway",
        "https://ai-gateway.vercel.sh",
        Anthropic,
        &["AI_GATEWAY_API_KEY"],
    ),
    plan(p(
        "github-copilot",
        "GitHub Copilot",
        "https://api.individual.githubcopilot.com",
        OpenAiChat,
        &["COPILOT_GITHUB_TOKEN"],
    )),
    p(
        "moonshotai",
        "Moonshot AI",
        "https://api.moonshot.ai/v1",
        OpenAiChat,
        &["MOONSHOT_API_KEY"],
    ),
    p(
        "moonshotai-cn",
        "Moonshot AI (China)",
        "https://api.moonshot.cn/v1",
        OpenAiChat,
        &["MOONSHOT_API_KEY"],
    ),
    plan(p(
        "kimi-coding",
        "Kimi For Coding",
        "https://api.kimi.com/coding/v1",
        OpenAiChat,
        &["KIMI_API_KEY"],
    )),
    p(
        "minimax",
        "MiniMax",
        "https://api.minimax.io/anthropic",
        Anthropic,
        &["MINIMAX_API_KEY"],
    ),
    p(
        "minimax-cn",
        "MiniMax (China)",
        "https://api.minimaxi.com/anthropic",
        Anthropic,
        &["MINIMAX_CN_API_KEY"],
    ),
    plan(p(
        "zai-coding-cn",
        "Z.AI Coding (China)",
        "https://open.bigmodel.cn/api/coding/paas/v4",
        OpenAiChat,
        &["ZAI_CODING_CN_API_KEY"],
    )),
    p(
        "meta",
        "Meta",
        "https://api.meta.ai/v1",
        OpenAiResponses,
        &["META_API_KEY"],
    ),
    p(
        "huggingface",
        "Hugging Face",
        "https://router.huggingface.co/v1",
        OpenAiChat,
        &["HF_TOKEN"],
    ),
    p(
        "nvidia",
        "NVIDIA",
        "https://integrate.api.nvidia.com/v1",
        OpenAiChat,
        &["NVIDIA_API_KEY"],
    ),
    p(
        "baseten",
        "Baseten",
        "https://inference.baseten.co/v1",
        OpenAiChat,
        &["BASETEN_API_KEY"],
    ),
    p(
        "ant-ling",
        "Ant Ling",
        "https://api.ant-ling.com/v1",
        OpenAiChat,
        &["ANT_LING_API_KEY"],
    ),
    p(
        "xiaomi",
        "Xiaomi",
        "https://api.xiaomimimo.com/v1",
        OpenAiChat,
        &["XIAOMI_API_KEY"],
    ),
    plan(p(
        "xiaomi-token-plan-ams",
        "Xiaomi Token Plan (Amsterdam)",
        "https://token-plan-ams.xiaomimimo.com/v1",
        OpenAiChat,
        &["XIAOMI_TOKEN_PLAN_AMS_API_KEY"],
    )),
    plan(p(
        "xiaomi-token-plan-cn",
        "Xiaomi Token Plan (China)",
        "https://token-plan-cn.xiaomimimo.com/v1",
        OpenAiChat,
        &["XIAOMI_TOKEN_PLAN_CN_API_KEY"],
    )),
    plan(p(
        "xiaomi-token-plan-sgp",
        "Xiaomi Token Plan (Singapore)",
        "https://token-plan-sgp.xiaomimimo.com/v1",
        OpenAiChat,
        &["XIAOMI_TOKEN_PLAN_SGP_API_KEY"],
    )),
    plan(p(
        "qwen-token-plan",
        "Qwen Token Plan",
        "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
        OpenAiChat,
        &["QWEN_TOKEN_PLAN_API_KEY"],
    )),
    plan(p(
        "qwen-token-plan-individual",
        "Qwen Token Plan Individual",
        "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
        OpenAiChat,
        &["QWEN_TOKEN_PLAN_API_KEY"],
    )),
    plan(p(
        "qwen-token-plan-cn",
        "Qwen Token Plan (China)",
        "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
        OpenAiChat,
        &["QWEN_TOKEN_PLAN_CN_API_KEY"],
    )),
    Provider {
        keyless: true,
        subscription: true,
        ..p(
            "ollama",
            "Ollama (local)",
            "http://localhost:11434/v1",
            OpenAiChat,
            &[],
        )
    },
];

pub fn provider(id: &str) -> Option<&'static Provider> {
    PROVIDERS.iter().find(|p| p.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::catalog;

    #[test]
    fn ids_are_unique_and_every_catalog_provider_is_known() {
        for (i, a) in PROVIDERS.iter().enumerate() {
            assert!(PROVIDERS[i + 1..].iter().all(|b| b.id != a.id), "{}", a.id);
        }
        for model in catalog::all() {
            let provider = provider(&model.provider)
                .unwrap_or_else(|| panic!("no provider {}", model.provider));
            assert!(
                Wire::from_api(&model.api).is_some(),
                "{}/{}: {}",
                provider.id,
                model.id,
                model.api
            );
        }
        for p in PROVIDERS.iter().filter(|p| p.id != "ollama") {
            assert!(
                catalog::models(p.id).next().is_some(),
                "{} has no models",
                p.id
            );
        }
    }
}
