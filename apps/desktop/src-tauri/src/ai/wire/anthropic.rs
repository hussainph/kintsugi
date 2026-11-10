//! Anthropic Messages, as Pi sends it (`src/api/anthropic-messages.ts`,
//! `api/simple-options.ts`): Anthropic itself, MiniMax, and the Claude
//! models of OpenRouter, OpenCode, Vercel AI Gateway, Fireworks and Copilot.
//!
//! Thinking is budget-based (older models, with the interleaved-thinking
//! beta) or adaptive with an effort (`forceAdaptiveThinking`). A step's
//! thinking blocks, with their signatures, are sent back in front of its
//! text and tool calls within the turn, as the API requires once thinking
//! is on.

use super::{
    Calls, Decode, Exchange, Item, Level, Mapped, Reply, Result, Route, object_arguments,
    reasoning_of, result_text, session_id, stream_error,
};
use crate::ai::pi_auth::Auth;
use serde_json::{Value, json};

/// Pi's default thinking budgets, by level (`xhigh` and `max` use `high`).
fn budget(level: Level) -> u32 {
    match level {
        Level::Off => 0,
        Level::Minimal => 1024,
        Level::Low => 2048,
        Level::Medium => 8192,
        Level::High | Level::Xhigh | Level::Max => 16384,
    }
}

pub(super) fn request(
    client: &reqwest::Client,
    route: &Route,
    auth: Option<&Auth>,
    ex: &Exchange,
) -> Result<(reqwest::RequestBuilder, Box<dyn Decode>)> {
    if let Some(Auth::ApiKey(key)) = auth
        && key.contains("sk-ant-oat")
    {
        return Err("That Anthropic key is a Claude subscription token, which Kintsugi doesn't use. Use an Anthropic API key.".into());
    }
    let (body, betas) = body(route, ex);
    let mut builder = client
        .post(format!("{}/v1/messages", route.base_url))
        .header("anthropic-version", "2023-06-01")
        .json(&body);
    builder = match auth {
        // Copilot (and any login) authenticates with a bearer token.
        Some(Auth::Bearer { token, .. }) => builder.bearer_auth(token),
        Some(Auth::ApiKey(key)) if route.is("github-copilot") => builder.bearer_auth(key),
        Some(Auth::ApiKey(key)) => builder.header("x-api-key", key),
        None => builder,
    };
    if !betas.is_empty() {
        builder = builder.header("anthropic-beta", betas.join(","));
    }
    let openrouter = route.is("openrouter") || route.host_is("openrouter.ai");
    let affinity = route
        .flag("sendSessionAffinityHeaders")
        .unwrap_or(openrouter);
    if affinity && ex.cache_key.is_some() && !route.is("github-copilot") {
        let format = route.text("sessionAffinityFormat");
        let header = if format == Some("openrouter") || (format.is_none() && openrouter) {
            "x-session-id"
        } else {
            "x-session-affinity"
        };
        builder = builder.header(header, session_id(ex));
    }
    Ok((builder, Box::new(Decoder::default())))
}

/// Marks a block as the end of a cacheable prefix.
fn cached(mut block: Value) -> Value {
    block["cache_control"] = json!({ "type": "ephemeral" });
    block
}

/// A replayed thinking block as the API takes it back (Pi's §7.2): a block
/// without a signature goes back as plain text unless the model allows
/// empty signatures.
fn replayed(block: &Value, empty_signature_ok: bool) -> Option<Value> {
    if block["type"] == "redacted_thinking" {
        return Some(block.clone());
    }
    let thinking = block["thinking"].as_str().unwrap_or_default();
    let signature = block["signature"].as_str().unwrap_or_default();
    if !signature.trim().is_empty() {
        return Some(json!({ "type": "thinking", "thinking": thinking, "signature": signature }));
    }
    if thinking.trim().is_empty() {
        return None;
    }
    Some(if empty_signature_ok {
        json!({ "type": "thinking", "thinking": thinking, "signature": "" })
    } else {
        json!({ "type": "text", "text": thinking })
    })
}

/// The request body and the betas it needs.
pub(super) fn body(route: &Route, ex: &Exchange) -> (Value, Vec<&'static str>) {
    let empty_signature_ok = route.flag("allowEmptySignature") == Some(true);
    let mut pending: Vec<Value> = Vec::new();
    let mut messages: Vec<Value> = Vec::new();
    for item in ex.items {
        match item {
            Item::User(text) => {
                messages.push(json!({ "role": "user", "content": [{ "type": "text", "text": text }] }))
            }
            Item::Images(images) => super::append_user_parts(
                &mut messages,
                "content",
                super::image_parts(
                    route,
                    images,
                    |image| json!({
                        "type": "image",
                        "source": { "type": "base64", "media_type": image.mime_type, "data": image.data },
                    }),
                    |note| json!({ "type": "text", "text": note }),
                ),
            ),
            Item::Reasoning(values) => {
                pending = reasoning_of(values, &["thinking", "redacted_thinking"])
                    .filter_map(|b| replayed(b, empty_signature_ok))
                    .collect()
            }
            Item::Assistant { text, calls } => {
                let mut content = std::mem::take(&mut pending);
                if !text.trim().is_empty() {
                    content.push(json!({ "type": "text", "text": text }));
                }
                content.extend(calls.iter().map(|c| {
                    json!({ "type": "tool_use", "id": c.id, "name": c.name, "input": object_arguments(&c.arguments) })
                }));
                // Pi drops an empty assistant message; two user messages in
                // a row are merged by the API.
                if !content.is_empty() {
                    messages.push(json!({ "role": "assistant", "content": content }));
                }
            }
            Item::Results(results) => messages.push(json!({
                "role": "user",
                "content": results.iter().map(|r| json!({
                    "type": "tool_result", "tool_use_id": r.call_id, "content": result_text(r), "is_error": r.is_error,
                })).collect::<Vec<_>>(),
            })),
        }
    }
    // A rolling breakpoint on the newest block: the next step reads the whole
    // conversation so far from cache.
    if !ex.tools.is_empty()
        && let Some(last) = messages
            .last_mut()
            .filter(|m| m["role"] == "user")
            .and_then(|m| m["content"].as_array_mut())
            .and_then(|c| c.last_mut())
    {
        *last = cached(last.take());
    }
    let mut betas = Vec::new();
    let mut max_tokens = route.max_tokens(ex);
    let mut body = json!({
        "model": ex.model,
        "messages": messages,
        "stream": true,
    });
    if !ex.system.is_empty() && ex.tools.is_empty() {
        body["system"] = ex.system.into();
    } else if !ex.system.is_empty() {
        // Tools and system together form the agent's fixed prefix. One-off
        // calls skip caching: a cache write costs more than a plain read.
        body["system"] = json!([cached(json!({ "type": "text", "text": ex.system }))]);
    }
    if !ex.tools.is_empty() {
        let eager = route.flag("supportsEagerToolInputStreaming") != Some(false);
        if !eager {
            betas.push("fine-grained-tool-streaming-2025-05-14");
        }
        body["tools"] = ex
            .tools
            .iter()
            .map(|t| {
                // Pi keeps only `properties` and `required`: Anthropic
                // rejects some root keywords.
                let schema = json!({
                    "type": "object",
                    "properties": t.parameters.get("properties").cloned().unwrap_or_else(|| json!({})),
                    "required": t.parameters.get("required").cloned().unwrap_or_else(|| json!([])),
                });
                let mut tool = json!({ "name": t.name, "description": t.description, "input_schema": schema });
                if eager {
                    tool["eager_input_streaming"] = json!(true);
                }
                tool
            })
            .collect();
    }
    let mut thinking_on = false;
    if let Some(level) = route.level(ex) {
        let adaptive = route.flag("forceAdaptiveThinking") == Some(true);
        if level == Level::Off {
            if route.mapped(Level::Off) != Mapped::Unsupported {
                body["thinking"] = json!({ "type": "disabled" });
            }
        } else if adaptive {
            thinking_on = true;
            body["thinking"] = json!({ "type": "adaptive", "display": "summarized" });
            body["output_config"] = json!({ "effort": effort(route, level) });
        } else {
            thinking_on = true;
            let ceiling = route.model.map_or(u32::MAX, |m| {
                u32::try_from(m.max_tokens).unwrap_or(u32::MAX)
            });
            max_tokens = max_tokens.saturating_add(budget(level)).min(ceiling);
            let tokens = match budget(level).min(max_tokens.saturating_sub(1024)) {
                0 => 1024,
                tokens => tokens,
            };
            body["thinking"] =
                json!({ "type": "enabled", "budget_tokens": tokens, "display": "summarized" });
            betas.push("interleaved-thinking-2025-05-14");
        }
    }
    body["max_tokens"] = json!(max_tokens);
    if let Some(stop) = ex.stop {
        body["stop_sequences"] = json!(stop);
    }
    if let Some(t) = ex.temperature
        && !thinking_on
        && route.flag("supportsTemperature") != Some(false)
    {
        body["temperature"] = json!(t);
    }
    (body, betas)
}

/// Pi's `mapThinkingLevelToEffort`.
fn effort(route: &Route, level: Level) -> &'static str {
    match route.mapped(level) {
        Mapped::To(value) => value,
        _ => match level {
            Level::Off | Level::Minimal | Level::Low => "low",
            Level::Medium => "medium",
            _ => "high",
        },
    }
}

/// Streams Messages events into a [`Reply`].
#[derive(Default)]
struct Decoder {
    reply: Reply,
    calls: Calls,
    /// Thinking blocks by content index, as they will be replayed.
    thinking: Vec<(u64, Value)>,
    done: bool,
}

impl Decoder {
    fn thought(&mut self, index: u64) -> Option<&mut Value> {
        self.thinking
            .iter_mut()
            .find(|(i, _)| *i == index)
            .map(|(_, b)| b)
    }

    fn usage(&mut self, usage: &Value, start: bool) {
        // A delta overwrites only what it carries (proxies omit input).
        let set = |field: &mut u64, value: &Value| {
            if let Some(n) = value.as_u64() {
                *field = n;
            } else if start {
                *field = 0;
            }
        };
        let u = &mut self.reply.usage;
        set(&mut u.input, &usage["input_tokens"]);
        set(&mut u.output, &usage["output_tokens"]);
        set(&mut u.cache_read, &usage["cache_read_input_tokens"]);
        set(&mut u.cache_write, &usage["cache_creation_input_tokens"]);
    }
}

impl Decode for Decoder {
    fn feed(&mut self, event: Option<&str>, data: &str) -> Result<Option<String>> {
        let Ok(json) = serde_json::from_str::<Value>(data) else {
            return Ok(None);
        };
        let kind = json["type"].as_str().or(event).unwrap_or("").to_string();
        let n = |v: &Value| v.as_u64().unwrap_or(0);
        match kind.as_str() {
            "message_start" => self.usage(&json["message"]["usage"], true),
            "content_block_start" => {
                let block = &json["content_block"];
                let index = n(&json["index"]);
                match block["type"].as_str() {
                    Some("tool_use") => {
                        let call = self.calls.at(index);
                        call.id = block["id"].as_str().unwrap_or_default().into();
                        call.name = block["name"].as_str().unwrap_or_default().into();
                    }
                    Some("thinking") => self.thinking.push((
                        index,
                        json!({
                            "type": "thinking",
                            "thinking": block["thinking"].as_str().unwrap_or_default(),
                            "signature": block["signature"].as_str().unwrap_or_default(),
                        }),
                    )),
                    Some("redacted_thinking") => self.thinking.push((
                        index,
                        json!({ "type": "redacted_thinking", "data": block["data"] }),
                    )),
                    _ => {}
                }
            }
            "content_block_delta" => {
                let delta = &json["delta"];
                let index = n(&json["index"]);
                match delta["type"].as_str() {
                    Some("input_json_delta") => {
                        let partial = delta["partial_json"].as_str().unwrap_or_default();
                        self.calls.at(index).arguments.push_str(partial);
                    }
                    Some("thinking_delta") => {
                        let more = delta["thinking"].as_str().unwrap_or_default();
                        if let Some(block) = self.thought(index) {
                            let text =
                                format!("{}{more}", block["thinking"].as_str().unwrap_or_default());
                            block["thinking"] = json!(text);
                        }
                    }
                    Some("signature_delta") => {
                        let more = delta["signature"].as_str().unwrap_or_default();
                        if let Some(block) = self.thought(index) {
                            let sig = format!(
                                "{}{more}",
                                block["signature"].as_str().unwrap_or_default()
                            );
                            block["signature"] = json!(sig);
                        }
                    }
                    Some("text_delta") => {
                        let text = delta["text"].as_str().unwrap_or_default();
                        if !text.is_empty() {
                            self.reply.text.push_str(text);
                            return Ok(Some(text.to_string()));
                        }
                    }
                    _ => {}
                }
            }
            "message_delta" => {
                if let Some(reason) = json["delta"]["stop_reason"].as_str() {
                    self.reply.stop_reason = Some(reason.into());
                }
                if json["usage"].is_object() {
                    self.usage(&json["usage"], false);
                }
            }
            "message_stop" => self.done = true,
            "error" => return Err(stream_error(&json["error"])),
            _ => {}
        }
        Ok(None)
    }

    fn done(&self) -> bool {
        self.done
    }

    fn ended(&self) -> bool {
        self.done || self.reply.stop_reason.is_some()
    }

    fn finish(self: Box<Self>) -> Result<Reply> {
        if let Some(reason) = self.reply.stop_reason.as_deref()
            && matches!(reason, "refusal" | "sensitive")
        {
            super::refused(reason)?;
        }
        let mut reply = self.reply;
        let mut thinking = self.thinking;
        thinking.sort_by_key(|(i, _)| *i);
        reply.reasoning = thinking.into_iter().map(|(_, b)| b).collect();
        reply.calls = self.calls.finish();
        Ok(reply)
    }
}

#[cfg(test)]
mod tests;
