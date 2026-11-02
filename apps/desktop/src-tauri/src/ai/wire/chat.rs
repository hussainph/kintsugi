//! OpenAI-compatible chat completions, with every per-provider quirk Pi
//! knows (`src/api/openai-completions.ts`, `providers/compat-schema.ts`;
//! Mistral from `api/mistral-conversations.ts`).
//!
//! A model's quirks are Pi's `compat` flags: the catalog's values over what
//! Pi detects from the provider and base URL ([`Compat::of`]). They decide
//! the max-tokens field, `store`, the system role, strict tools, how thinking
//! is asked for (`thinkingFormat`), session headers, Anthropic-style cache
//! markers on OpenRouter, and how a step's reasoning is sent back.

use super::{
    Calls, Decode, Exchange, Item, Level, Mapped, Reply, Result, Route, Usage, arguments_string,
    reasoning_of, result_text, session_id, stream_error, token,
};
use crate::ai::pi_auth::Auth;
use serde_json::{Map, Value, json};

/// Pi's `thinkingFormat`: how a model's thinking is switched on and sized.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) enum Thinking {
    /// `reasoning_effort`.
    OpenAi,
    /// `reasoning: {effort}`.
    OpenRouter,
    /// `thinking: {type}` plus `reasoning_effort`.
    DeepSeek,
    /// `thinking: {type, clear_thinking: false}` plus `reasoning_effort`.
    Zai,
    /// `enable_thinking` plus `reasoning_effort`.
    Qwen,
    /// `reasoning: {enabled}` plus `reasoning_effort`.
    Together,
    /// `chat_template_args` from the catalog, plus `reasoning_effort`.
    Baseten,
    /// `reasoning: {effort}`, only for mapped levels.
    AntLing,
    /// `chat_template_kwargs: {enable_thinking, preserve_thinking}`.
    QwenChatTemplate,
    /// `chat_template_kwargs` from the catalog.
    ChatTemplate,
    /// A top-level `thinking` string.
    StringThinking,
    /// Mistral: `reasoning_effort` from the map, `"high"` for unmapped levels.
    Mistral,
}

/// Session affinity headers (Pi's `sessionAffinityFormat`).
#[derive(Debug, Clone, Copy, PartialEq)]
enum Affinity {
    OpenAi,
    OpenAiNoSession,
    OpenRouter,
}

/// A chat model's quirks, resolved: Pi's `detectCompat` overlaid with the
/// catalog's `compat`.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Compat {
    store: bool,
    developer_role: bool,
    reasoning_effort: bool,
    usage_in_streaming: bool,
    max_tokens_field: &'static str,
    tool_result_name: bool,
    reasoning_content_on_assistant: bool,
    thinking: Thinking,
    strict: bool,
    zai_tool_stream: bool,
    anthropic_cache: bool,
    affinity: Option<Affinity>,
    mistral: bool,
}

impl Compat {
    pub(super) fn of(route: &Route, model_id: &str) -> Compat {
        let id = route.provider.id;
        let url = route.base_url.to_lowercase();
        let has = |s: &str| url.contains(s);
        let mistral = id == "mistral" || has("api.mistral.ai");
        let zai =
            matches!(id, "zai" | "zai-coding-cn") || has("api.z.ai") || has("open.bigmodel.cn");
        let together = id == "together" || has("api.together.ai") || has("api.together.xyz");
        let moonshot = matches!(id, "moonshotai" | "moonshotai-cn") || has("api.moonshot.");
        let openrouter = id == "openrouter" || has("openrouter.ai");
        let nvidia = id == "nvidia" || has("integrate.api.nvidia.com");
        let ant_ling = id == "ant-ling" || has("api.ant-ling.com");
        let cerebras = id == "cerebras" || has("cerebras.ai");
        let deepseek = id == "deepseek" || has("deepseek.com");
        let grok = id == "xai" || has("api.x.ai");
        let opencode = id.starts_with("opencode") || has("opencode.ai");
        // A server on this Mac (Ollama, llama.cpp, LM Studio) takes the
        // older field and nothing OpenAI-only.
        let local = route.provider.keyless || has("localhost") || has("127.0.0.1");
        let non_standard = nvidia
            || cerebras
            || grok
            || together
            || has("chutes.ai")
            || deepseek
            || zai
            || moonshot
            || opencode
            || ant_ling
            || mistral
            || local;
        let use_max_tokens = has("chutes.ai")
            || deepseek
            || moonshot
            || together
            || nvidia
            || ant_ling
            || zai
            || mistral
            || local;
        let dev_role_model =
            openrouter && (model_id.starts_with("anthropic/") || model_id.starts_with("openai/"));
        let flag = |name: &str, detected: bool| route.flag(name).unwrap_or(detected);
        let thinking = if mistral {
            Thinking::Mistral
        } else {
            match route.text("thinkingFormat") {
                Some("openrouter") => Thinking::OpenRouter,
                Some("deepseek") => Thinking::DeepSeek,
                Some("zai") => Thinking::Zai,
                Some("qwen") => Thinking::Qwen,
                Some("together") => Thinking::Together,
                Some("baseten") => Thinking::Baseten,
                Some("ant-ling") => Thinking::AntLing,
                Some("qwen-chat-template") => Thinking::QwenChatTemplate,
                Some("chat-template") => Thinking::ChatTemplate,
                Some("string-thinking") => Thinking::StringThinking,
                Some(_) => Thinking::OpenAi,
                None if deepseek => Thinking::DeepSeek,
                None if zai => Thinking::Zai,
                None if together => Thinking::Together,
                None if ant_ling => Thinking::AntLing,
                None if openrouter => Thinking::OpenRouter,
                None => Thinking::OpenAi,
            }
        };
        let affinity = match route.text("sessionAffinityFormat") {
            Some("openrouter") => Some(Affinity::OpenRouter),
            Some("openai-nosession") => Some(Affinity::OpenAiNoSession),
            Some(_) => Some(Affinity::OpenAi),
            None if openrouter => Some(Affinity::OpenRouter),
            None => Some(Affinity::OpenAi),
        }
        .filter(|_| flag("sendSessionAffinityHeaders", openrouter));
        Compat {
            store: !mistral && flag("supportsStore", !non_standard),
            developer_role: !mistral
                && flag(
                    "supportsDeveloperRole",
                    dev_role_model || (!non_standard && !openrouter),
                ),
            reasoning_effort: flag(
                "supportsReasoningEffort",
                !grok && !zai && !moonshot && !together && !nvidia && !ant_ling,
            ),
            usage_in_streaming: !mistral && flag("supportsUsageInStreaming", true),
            max_tokens_field: match route.text("maxTokensField") {
                Some("max_tokens") => "max_tokens",
                Some(_) => "max_completion_tokens",
                None if use_max_tokens => "max_tokens",
                None => "max_completion_tokens",
            },
            tool_result_name: mistral || flag("requiresToolResultName", false),
            reasoning_content_on_assistant: flag(
                "requiresReasoningContentOnAssistantMessages",
                deepseek,
            ),
            thinking,
            strict: mistral || flag("supportsStrictMode", false),
            zai_tool_stream: flag("zaiToolStream", false),
            anthropic_cache: route.text("cacheControlFormat") == Some("anthropic")
                || (route.text("cacheControlFormat").is_none()
                    && id == "openrouter"
                    && model_id.starts_with("anthropic/")),
            affinity,
            mistral,
        }
    }
}

pub(super) fn request(
    client: &reqwest::Client,
    route: &Route,
    auth: Option<&Auth>,
    ex: &Exchange,
) -> Result<(reqwest::RequestBuilder, Box<dyn Decode>)> {
    let compat = Compat::of(route, ex.model);
    let mut builder = client
        .post(format!("{}/chat/completions", route.base_url))
        .json(&body(route, &compat, ex));
    if let Some(key) = token(auth) {
        builder = builder.bearer_auth(key);
    }
    if ex.cache_key.is_some() {
        let session = session_id(ex);
        if compat.mistral {
            builder = builder.header("x-affinity", &session);
        }
        match compat.affinity {
            Some(Affinity::OpenRouter) => builder = builder.header("x-session-id", &session),
            Some(format) => {
                if format == Affinity::OpenAi {
                    builder = builder.header("session_id", &session);
                }
                builder = builder
                    .header("x-client-request-id", &session)
                    .header("x-session-affinity", &session);
            }
            None => {}
        }
    }
    let decoder = Decoder {
        reasoning_field: if route.is("opencode-go") {
            "reasoning_content"
        } else {
            ""
        },
        ..Decoder::default()
    };
    Ok((builder, Box::new(decoder)))
}

/// Marks a message's content as the end of a cacheable prefix (OpenRouter's
/// Anthropic models).
fn cache_marked(message: &mut Value) -> bool {
    let marker = json!({ "type": "ephemeral" });
    match message.get_mut("content") {
        Some(Value::String(text)) if !text.is_empty() => {
            let text = std::mem::take(text);
            message["content"] = json!([{ "type": "text", "text": text, "cache_control": marker }]);
            true
        }
        Some(Value::Array(parts)) => match parts.iter_mut().rev().find(|p| p["type"] == "text") {
            Some(part) => {
                part["cache_control"] = marker;
                true
            }
            None => false,
        },
        _ => false,
    }
}

/// Mistral accepts only tool call ids of exactly nine letters and digits.
/// Its own ids already are; anything else is mapped, deterministically.
fn mistral_id(id: &str) -> String {
    let clean: String = id.chars().filter(char::is_ascii_alphanumeric).collect();
    if clean.len() == 9 {
        return clean;
    }
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    id.hash(&mut hasher);
    let alphabet = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let mut n = hasher.finish();
    (0..9)
        .map(|_| {
            let c = alphabet[(n % 62) as usize] as char;
            n /= 62;
            c
        })
        .collect()
}

pub(super) fn body(route: &Route, compat: &Compat, ex: &Exchange) -> Value {
    let reasons = route.reasons();
    let call_id = |id: &str| {
        if compat.mistral {
            mistral_id(id)
        } else {
            id.to_string()
        }
    };
    let mut messages = Vec::new();
    if !ex.system.is_empty() {
        let role = if reasons && compat.developer_role {
            "developer"
        } else {
            "system"
        };
        messages.push(json!({ "role": role, "content": ex.system }));
    }
    let mut pending: Vec<Value> = Vec::new();
    for item in ex.items {
        match item {
            Item::User(text) => messages.push(json!({ "role": "user", "content": text })),
            Item::Reasoning(values) => {
                pending = reasoning_of(values, &["chat.reasoning", "chat.reasoning_details"])
                    .cloned()
                    .collect()
            }
            Item::Assistant { text, calls } => {
                let replay = std::mem::take(&mut pending);
                let mut message = Map::new();
                message.insert("role".into(), "assistant".into());
                let thinking = replay
                    .iter()
                    .find(|v| v["type"] == "chat.reasoning")
                    .and_then(|v| Some((v["field"].as_str()?, v["text"].as_str()?)));
                let details = replay
                    .iter()
                    .find(|v| v["type"] == "chat.reasoning_details")
                    .map(|v| v["details"].clone());
                if compat.mistral && let Some((_, thought)) = thinking {
                    // Exactly one leading thinking chunk, then the text.
                    let mut parts =
                        vec![json!({ "type": "thinking", "thinking": [{ "type": "text", "text": thought }] })];
                    if !text.trim().is_empty() {
                        parts.push(json!({ "type": "text", "text": text }));
                    }
                    message.insert("content".into(), Value::Array(parts));
                } else if !text.trim().is_empty() {
                    message.insert("content".into(), json!(text));
                } else {
                    message.insert("content".into(), Value::Null);
                }
                if let Some(details) = details {
                    message.insert("reasoning_details".into(), details);
                } else if !compat.mistral
                    && let Some((field, thought)) = thinking
                    && matches!(field, "reasoning" | "reasoning_content" | "reasoning_text")
                {
                    message.insert(field.into(), json!(thought));
                }
                if !calls.is_empty() {
                    let calls: Vec<Value> = calls
                        .iter()
                        .map(|c| {
                            json!({
                                "id": call_id(&c.id), "type": "function",
                                "function": { "name": c.name, "arguments": arguments_string(&c.arguments) },
                            })
                        })
                        .collect();
                    message.insert("tool_calls".into(), Value::Array(calls));
                }
                if compat.reasoning_content_on_assistant
                    && reasons
                    && !message.contains_key("reasoning_content")
                {
                    message.insert("reasoning_content".into(), json!(""));
                }
                // Pi skips an assistant message with nothing in it.
                if message["content"].is_null() && !message.contains_key("tool_calls") {
                    continue;
                }
                messages.push(Value::Object(message));
            }
            Item::Results(results) => messages.extend(results.iter().map(|r| {
                let content = if compat.mistral && r.is_error {
                    format!("[tool error] {}", result_text(r))
                } else {
                    result_text(r).to_string()
                };
                let mut message =
                    json!({ "role": "tool", "tool_call_id": call_id(&r.call_id), "content": content });
                if compat.tool_result_name
                    && let Some(name) = ex.items.iter().find_map(|i| match i {
                        Item::Assistant { calls, .. } => {
                            calls.iter().find(|c| c.id == r.call_id).map(|c| c.name.clone())
                        }
                        _ => None,
                    })
                {
                    message["name"] = json!(name);
                }
                message
            })),
        }
    }
    // Cache markers for OpenRouter's Anthropic models, on Kin's agent calls
    // only (one-off calls skip caching: a cache write costs more than a
    // plain read): the system prompt and the newest message.
    if compat.anthropic_cache && !ex.tools.is_empty() {
        if let Some(first) = messages.first_mut()
            && matches!(first["role"].as_str(), Some("system" | "developer"))
        {
            cache_marked(first);
        }
        for message in messages.iter_mut().rev() {
            if cache_marked(message) {
                break;
            }
        }
    }
    let mut body = json!({
        "model": ex.model,
        "messages": messages,
        "stream": true,
    });
    if route.host_is("api.openai.com")
        && let Some(key) = ex.cache_key
    {
        body["prompt_cache_key"] = json!(key);
    }
    if compat.mistral && ex.cache_key.is_some() {
        body["prompt_cache_key"] = json!(session_id(ex));
    }
    if compat.usage_in_streaming {
        body["stream_options"] = json!({ "include_usage": true });
    }
    if compat.store {
        body["store"] = json!(false);
    }
    body[compat.max_tokens_field] = json!(route.max_tokens(ex));
    if let Some(t) = ex.temperature {
        body["temperature"] = json!(t);
    }
    if let Some(stop) = ex.stop {
        body["stop"] = json!(stop);
    }
    if !ex.tools.is_empty() {
        body["tools"] = ex
            .tools
            .iter()
            .map(|t| {
                let mut function = json!({
                    "name": t.name, "description": t.description, "parameters": t.parameters,
                });
                if compat.strict {
                    function["strict"] = json!(false);
                }
                json!({ "type": "function", "function": function })
            })
            .collect();
        if compat.zai_tool_stream {
            body["tool_stream"] = json!(true);
        }
    } else if ex.items.iter().any(|i| {
        matches!(i, Item::Results(_))
            || matches!(i, Item::Assistant { calls, .. } if !calls.is_empty())
    }) {
        // Proxies in front of Anthropic want `tools` whenever the history
        // has tool calls (Pi).
        body["tools"] = json!([]);
    }
    if let Some(level) = route.level(ex) {
        thinking_params(&mut body, route, compat, level);
    }
    body
}

/// Pi's thinking parameters for each `thinkingFormat` (`buildParams`).
/// `level` is already clamped to what the model supports.
fn thinking_params(body: &mut Value, route: &Route, compat: &Compat, level: Level) {
    let on = level != Level::Off;
    let map = |level: Level| route.mapped(level);
    // `reasoning_effort` when the model takes it: the mapped value, else
    // the level's name; a level mapped to null sends nothing.
    let effort = |body: &mut Value| {
        if compat.reasoning_effort && on {
            body["reasoning_effort"] = json!(map(level).or(level));
        }
    };
    match compat.thinking {
        Thinking::Zai => {
            if on {
                body["thinking"] = json!({ "type": "enabled", "clear_thinking": false });
                effort(body);
            } else {
                body["thinking"] = json!({ "type": "disabled" });
            }
        }
        Thinking::Qwen => {
            body["enable_thinking"] = json!(on);
            effort(body);
        }
        Thinking::QwenChatTemplate => {
            body["chat_template_kwargs"] =
                json!({ "enable_thinking": on, "preserve_thinking": true });
        }
        Thinking::ChatTemplate | Thinking::Baseten => {
            let (field, key) = match compat.thinking {
                Thinking::Baseten => ("chat_template_args", "chatTemplateArgs"),
                _ => ("chat_template_kwargs", "chatTemplateKwargs"),
            };
            let template = route
                .model
                .and_then(|m| m.compat.get(key))
                .and_then(Value::as_object);
            let mut args = Map::new();
            for (name, value) in template.into_iter().flatten() {
                if let Some(value) = template_value(value, route, level) {
                    args.insert(name.clone(), value);
                }
            }
            if !args.is_empty() {
                body[field] = Value::Object(args);
            }
            if compat.thinking == Thinking::Baseten && compat.reasoning_effort {
                let value = if on { map(level) } else { map(Level::Off) };
                match value {
                    super::Mapped::To(v) => body["reasoning_effort"] = json!(v),
                    super::Mapped::Default if on => body["reasoning_effort"] = json!(level.id()),
                    _ => {}
                }
            }
        }
        Thinking::DeepSeek => {
            if on {
                body["thinking"] = json!({ "type": "enabled" });
                effort(body);
            } else if map(Level::Off) != Mapped::Unsupported {
                body["thinking"] = json!({ "type": "disabled" });
            }
        }
        Thinking::OpenRouter => {
            if on {
                body["reasoning"] = json!({ "effort": map(level).or(level) });
            } else if let Some(off) = match map(Level::Off) {
                Mapped::To(v) => Some(v),
                Mapped::Default => Some("none"),
                Mapped::Unsupported => None,
            } {
                body["reasoning"] = json!({ "effort": off });
            }
        }
        Thinking::AntLing => {
            if on && let Mapped::To(v) = map(level) {
                body["reasoning"] = json!({ "effort": v });
            }
        }
        Thinking::Together => {
            body["reasoning"] = json!({ "enabled": on });
            effort(body);
        }
        Thinking::StringThinking => {
            if on {
                body["thinking"] = json!(map(level).or(level));
            } else if let Some(off) = match map(Level::Off) {
                Mapped::To(v) => Some(v),
                Mapped::Default => Some("none"),
                Mapped::Unsupported => None,
            } {
                body["thinking"] = json!(off);
            }
        }
        Thinking::Mistral => {
            let value = match (on, map(level)) {
                (true, Mapped::To(v)) => Some(v),
                (true, _) => Some("high"),
                (false, Mapped::To(v)) => Some(v),
                (false, _) => None,
            };
            if let Some(value) = value {
                body["reasoning_effort"] = json!(value);
            }
        }
        Thinking::OpenAi => {
            if on {
                effort(body);
            } else if compat.reasoning_effort
                && let Mapped::To(off) = map(Level::Off)
            {
                body["reasoning_effort"] = json!(off);
            }
        }
    }
}

/// One `chat_template_args`/`kwargs` value from the catalog (Pi's
/// `resolveChatTemplateKwargValue`): literals as they are, `{$var}` from
/// the thinking level. Kin sends no token budgets, so `thinking.budget` is
/// left out.
fn template_value(value: &Value, route: &Route, level: Level) -> Option<Value> {
    let Some(var) = value.get("$var").and_then(Value::as_str) else {
        return Some(value.clone());
    };
    let on = level != Level::Off;
    if !on && value["omitWhenOff"] == true {
        return None;
    }
    match var {
        "thinking.enabled" => Some(json!(on)),
        "thinking.budget" => None,
        _ => match route.mapped(level) {
            Mapped::To(v) => Some(json!(v)),
            Mapped::Default if on => Some(json!(level.id())),
            _ => None,
        },
    }
}

/// Streams chat completion chunks into a [`Reply`] (Pi's stream loop).
#[derive(Default)]
struct Decoder {
    reply: Reply,
    calls: Calls,
    /// Where the reasoning text came from (`reasoning_content`, …), so it
    /// goes back the same way; preset for OpenCode Go.
    reasoning_field: &'static str,
    reasoning: String,
    /// OpenRouter's `reasoning_details`, merged.
    details: Vec<Value>,
    /// Tool call ids seen without an index, by position.
    by_id: Vec<String>,
    done: bool,
}

impl Decoder {
    fn usage(&mut self, raw: &Value) {
        let n = |v: &Value| v.as_u64().unwrap_or(0);
        let prompt = n(&raw["prompt_tokens"]);
        let details = &raw["prompt_tokens_details"]["cached_tokens"];
        let cache_read = if !details.is_null() {
            n(details)
        } else if !raw["prompt_cache_hit_tokens"].is_null() {
            n(&raw["prompt_cache_hit_tokens"])
        } else {
            n(&raw["cached_tokens"])
        };
        let cache_write = n(&raw["prompt_tokens_details"]["cache_write_tokens"]);
        self.reply.usage = Usage {
            input: prompt.saturating_sub(cache_read + cache_write),
            output: n(&raw["completion_tokens"]),
            cache_read,
            cache_write,
        };
    }

    fn think(&mut self, field: &'static str, text: &str) {
        if self.reasoning_field.is_empty() {
            self.reasoning_field = field;
        }
        self.reasoning.push_str(text);
    }

    fn detail(&mut self, detail: &Value) {
        let kind = detail["type"].as_str().unwrap_or_default();
        if let Some(last) = self.details.last_mut()
            && last["type"] == kind
        {
            let joined = match kind {
                "reasoning.text" => Some("text"),
                "reasoning.summary" => Some("summary"),
                _ => None,
            };
            if let Some(field) = joined {
                let more = detail[field].as_str().unwrap_or_default();
                let text = format!("{}{more}", last[field].as_str().unwrap_or_default());
                last[field] = json!(text);
                for key in ["signature", "id", "format", "index"] {
                    if last[key].is_null() && !detail[key].is_null() {
                        last[key] = detail[key].clone();
                    }
                }
                return;
            }
        }
        self.details.push(detail.clone());
    }

    fn call(&mut self, delta: &Value) {
        let id = delta["id"]
            .as_str()
            .filter(|id| !id.is_empty() && *id != "null");
        let index = match delta["index"].as_u64() {
            Some(index) => index,
            None => {
                // No index: find the call by id, else start a new one.
                let at = id
                    .and_then(|id| self.by_id.iter().position(|seen| seen == id))
                    .unwrap_or_else(|| {
                        self.by_id.push(id.unwrap_or_default().to_string());
                        self.by_id.len() - 1
                    });
                1_000_000 + at as u64
            }
        };
        let call = self.calls.at(index);
        if let Some(id) = id
            && call.id.is_empty()
        {
            call.id = id.into();
        }
        if let Some(name) = delta["function"]["name"].as_str()
            && call.name.is_empty()
        {
            call.name = name.into();
        }
        match &delta["function"]["arguments"] {
            Value::String(more) => call.arguments.push_str(more),
            Value::Object(_) => call.arguments = delta["function"]["arguments"].to_string(),
            _ => {}
        }
    }
}

impl Decode for Decoder {
    fn feed(&mut self, _event: Option<&str>, data: &str) -> Result<Option<String>> {
        if data == "[DONE]" {
            self.done = true;
            return Ok(None);
        }
        let Ok(json) = serde_json::from_str::<Value>(data) else {
            return Ok(None);
        };
        if json
            .get("error")
            .is_some_and(|e| !e.is_null() && e != false)
        {
            let mut message = stream_error(&json["error"]);
            if let Some(raw) = json["error"]["metadata"]["raw"].as_str()
                && !message.contains(raw)
            {
                message = format!("{message}\n{raw}");
            }
            return Err(message);
        }
        if json["usage"].is_object() {
            self.usage(&json["usage"]);
        }
        let choice = &json["choices"][0];
        if choice.is_null() {
            return Ok(None);
        }
        if !json["usage"].is_object() && choice["usage"].is_object() {
            self.usage(&choice["usage"]);
        }
        // Some servers put the last text and the finish reason in one chunk.
        if let Some(reason) = choice["finish_reason"].as_str() {
            self.reply.stop_reason = Some(reason.into());
        }
        let delta = &choice["delta"];
        for field in ["reasoning_content", "reasoning", "reasoning_text"] {
            if let Some(text) = delta[field].as_str().filter(|t| !t.is_empty()) {
                self.think(field, text);
                break;
            }
        }
        for detail in delta["reasoning_details"].as_array().into_iter().flatten() {
            if detail.is_object() {
                self.detail(detail);
            }
        }
        let mut shown = String::new();
        match &delta["content"] {
            Value::String(text) => shown.push_str(text),
            // Mistral sends chunks: text, and thinking as nested text parts.
            Value::Array(chunks) => {
                for chunk in chunks {
                    match chunk["type"].as_str() {
                        Some("text") => shown.push_str(chunk["text"].as_str().unwrap_or_default()),
                        Some("thinking") => {
                            let thought: String = chunk["thinking"]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .filter_map(|t| t["text"].as_str())
                                .collect();
                            if !thought.is_empty() {
                                self.think("thinking", &thought);
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
        for call in delta["tool_calls"].as_array().into_iter().flatten() {
            self.call(call);
        }
        if shown.is_empty() {
            return Ok(None);
        }
        self.reply.text.push_str(&shown);
        Ok(Some(shown))
    }

    fn done(&self) -> bool {
        self.done
    }

    fn ended(&self) -> bool {
        self.done || self.reply.stop_reason.is_some()
    }

    fn finish(self: Box<Self>) -> Result<Reply> {
        if let Some(reason) = self.reply.stop_reason.as_deref()
            && matches!(reason, "content_filter" | "error" | "network_error")
        {
            super::refused(reason)?;
        }
        let mut reply = self.reply;
        if !self.details.is_empty() {
            reply
                .reasoning
                .push(json!({ "type": "chat.reasoning_details", "details": self.details }));
        }
        if !self.reasoning.is_empty() {
            reply.reasoning.push(json!({
                "type": "chat.reasoning", "field": self.reasoning_field, "text": self.reasoning,
            }));
        }
        if reply.stop_reason.is_none() && !self.calls.is_empty() {
            reply.stop_reason = Some("tool_calls".into());
        }
        reply.calls = self.calls.finish();
        Ok(reply)
    }
}

#[cfg(test)]
mod tests;
