//! Three wire formats cover every provider Kintsugi talks to: Anthropic
//! Messages, OpenAI-compatible chat completions (OpenAI, OpenRouter, Z.AI,
//! local servers), and the ChatGPT Codex Responses backend.
//!
//! One streamed request is an [`Exchange`]: a system prompt, optional tools
//! and a provider-neutral history of [`Item`]s. It comes back as a [`Reply`]
//! (text, tool calls, token usage) while text deltas stream to a callback.
//! The agent loop (`agent.rs`) runs many exchanges per turn; the webview's
//! plain streaming ([`stream`]) is one exchange without tools.

use super::pi_auth::Auth;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Wire {
    Anthropic,
    OpenAiChat,
    Codex,
}

pub struct Provider {
    pub id: &'static str,
    pub name: &'static str,
    pub base_url: &'static str,
    pub wire: Wire,
    /// Read when Pi holds no credential (GUI apps rarely inherit shell env).
    pub env_key: Option<&'static str>,
    /// Local servers take no key at all.
    pub keyless: bool,
}

pub const PROVIDERS: &[Provider] = &[
    Provider { id: "anthropic", name: "Anthropic", base_url: "https://api.anthropic.com", wire: Wire::Anthropic, env_key: Some("ANTHROPIC_API_KEY"), keyless: false },
    Provider { id: "openai-codex", name: "ChatGPT (Codex)", base_url: "https://chatgpt.com/backend-api", wire: Wire::Codex, env_key: None, keyless: false },
    Provider { id: "openai", name: "OpenAI", base_url: "https://api.openai.com/v1", wire: Wire::OpenAiChat, env_key: Some("OPENAI_API_KEY"), keyless: false },
    Provider { id: "openrouter", name: "OpenRouter", base_url: "https://openrouter.ai/api/v1", wire: Wire::OpenAiChat, env_key: Some("OPENROUTER_API_KEY"), keyless: false },
    Provider { id: "zai", name: "Z.AI", base_url: "https://api.z.ai/api/coding/paas/v4", wire: Wire::OpenAiChat, env_key: Some("ZAI_API_KEY"), keyless: false },
    Provider { id: "ollama", name: "Ollama (local)", base_url: "http://localhost:11434/v1", wire: Wire::OpenAiChat, env_key: None, keyless: true },
];

pub fn provider(id: &str) -> Option<&'static Provider> {
    PROVIDERS.iter().find(|p| p.id == id)
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Message {
    pub role: Role,
    pub content: String,
}

/// The webview's plain streaming request (⌘K edits, completions).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub id: String,
    pub provider: String,
    pub model: String,
    #[serde(default)]
    pub system: String,
    pub messages: Vec<Message>,
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
    /// Not supported by the Codex backend; callers trim client-side there.
    pub stop: Option<Vec<String>>,
    /// Reasoning effort for models that think (`"none"`, `"low"`, …).
    pub reasoning: Option<String>,
    /// What the call is for (`"edit"`, `"complete"`), for the cost ledger.
    #[serde(default)]
    pub task: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Event {
    Delta { text: String },
    #[serde(rename_all = "camelCase")]
    Done { stop_reason: Option<String> },
    Error { message: String },
}

/// A tool the model may call. `parameters` is a JSON Schema object.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    pub parameters: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    /// Parsed arguments; a malformed argument string arrives as a JSON string.
    pub arguments: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolResult {
    pub call_id: String,
    pub content: String,
    pub is_error: bool,
}

/// One entry in a conversation, in the order the provider saw it.
#[derive(Debug, Clone, PartialEq)]
pub enum Item {
    User(String),
    Assistant { text: String, calls: Vec<ToolCall> },
    Results(Vec<ToolResult>),
}

/// Everything one request sends. The system prompt and tools come first and
/// never change within a turn, so providers can cache them (see `prompt.rs`).
#[derive(Debug, Clone)]
pub struct Exchange<'a> {
    pub model: &'a str,
    pub system: &'a str,
    pub tools: &'a [ToolSpec],
    pub items: &'a [Item],
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
    pub stop: Option<&'a [String]>,
    pub reasoning: Option<&'a str>,
    /// Groups requests that share a prefix, for providers that route on it.
    pub cache_key: Option<&'a str>,
}

/// Token counts, normalized: `input` is uncached input billed at the full
/// rate, `cache_read` and `cache_write` are billed at their own rates.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

impl Usage {
    pub fn add(&mut self, other: &Usage) {
        self.input += other.input;
        self.output += other.output;
        self.cache_read += other.cache_read;
        self.cache_write += other.cache_write;
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Reply {
    pub text: String,
    pub calls: Vec<ToolCall>,
    pub usage: Usage,
    pub stop_reason: Option<String>,
}

type Result<T> = std::result::Result<T, String>;

const USER_AGENT: &str = concat!("kintsugi/", env!("CARGO_PKG_VERSION"));
const DEFAULT_MAX_TOKENS: u32 = 1024;

/// Where and how to send: a provider's wire format at a base URL. Tests
/// point `base_url` at a local mock server.
pub struct Endpoint<'a> {
    pub provider: &'a Provider,
    pub base_url: &'a str,
    pub auth: Option<Auth>,
}

impl<'a> Endpoint<'a> {
    pub fn new(provider: &'a Provider, auth: Option<Auth>) -> Self {
        Endpoint { provider, base_url: provider.base_url, auth }
    }
}

/// The webview's plain streaming call: one exchange, events as they come.
pub async fn stream(endpoint: Endpoint<'_>, req: &Request, mut emit: impl FnMut(Event)) -> Result<Reply> {
    let items: Vec<Item> = req
        .messages
        .iter()
        .map(|m| match m.role {
            Role::User => Item::User(m.content.clone()),
            Role::Assistant => Item::Assistant { text: m.content.clone(), calls: vec![] },
        })
        .collect();
    let exchange = Exchange {
        model: &req.model,
        system: &req.system,
        tools: &[],
        items: &items,
        max_tokens: req.max_tokens,
        temperature: req.temperature,
        stop: req.stop.as_deref(),
        reasoning: req.reasoning.as_deref(),
        cache_key: None,
    };
    let reply = send(endpoint, &exchange, |text| emit(Event::Delta { text: text.into() })).await?;
    emit(Event::Done { stop_reason: reply.stop_reason.clone() });
    Ok(reply)
}

/// Sends one exchange; text deltas go to `on_text` as they arrive.
pub async fn send(endpoint: Endpoint<'_>, ex: &Exchange<'_>, mut on_text: impl FnMut(&str)) -> Result<Reply> {
    let Endpoint { provider, base_url, auth } = endpoint;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| e.to_string())?;
    let builder = match provider.wire {
        Wire::Anthropic => {
            let Some(Auth::ApiKey(key)) = auth else {
                return Err("Anthropic needs an API key".into());
            };
            client
                .post(format!("{base_url}/v1/messages"))
                .header("x-api-key", key)
                .header("anthropic-version", "2023-06-01")
                .json(&anthropic_body(ex))
        }
        Wire::OpenAiChat => {
            let builder = client.post(format!("{base_url}/chat/completions")).json(&openai_body(provider.id, ex));
            match auth {
                Some(Auth::ApiKey(key)) | Some(Auth::Bearer { token: key, .. }) => builder.bearer_auth(key),
                None => builder,
            }
        }
        Wire::Codex => {
            let Some(Auth::Bearer { token, account_id: Some(account) }) = auth else {
                return Err("ChatGPT needs a Codex login; run `pi` and log in to OpenAI Codex".into());
            };
            client
                .post(format!("{base_url}/codex/responses"))
                .bearer_auth(token)
                .header("chatgpt-account-id", account)
                .header("originator", "kintsugi")
                .header("OpenAI-Beta", "responses=experimental")
                .header("accept", "text/event-stream")
                .json(&codex_body(ex))
        }
    };
    let response = builder.send().await.map_err(|e| format!("{}: {e}", provider.name))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("{} returned {status}: {}", provider.name, error_text(&body)));
    }

    let mut sse = Sse::default();
    let mut decoder = Decoder::new(provider.wire);
    let mut body = response.bytes_stream();
    'read: while let Some(chunk) = body.next().await {
        let chunk = chunk.map_err(|e| format!("{}: {e}", provider.name))?;
        for (event, data) in sse.push(&chunk) {
            if let Some(text) = decoder.feed(event.as_deref(), &data)? {
                on_text(&text);
            }
            if decoder.done {
                break 'read;
            }
        }
    }
    // Some servers just close the stream.
    Ok(decoder.finish())
}

/// Marks a block as the end of a cacheable prefix (Anthropic).
fn cached(mut block: Value) -> Value {
    block["cache_control"] = json!({ "type": "ephemeral" });
    block
}

pub(crate) fn anthropic_body(ex: &Exchange) -> Value {
    let mut messages: Vec<Value> = ex
        .items
        .iter()
        .map(|item| match item {
            Item::User(text) => json!({ "role": "user", "content": [{ "type": "text", "text": text }] }),
            Item::Assistant { text, calls } => {
                let mut content = Vec::new();
                if !text.is_empty() {
                    content.push(json!({ "type": "text", "text": text }));
                }
                content.extend(calls.iter().map(|c| {
                    json!({ "type": "tool_use", "id": c.id, "name": c.name, "input": object_arguments(&c.arguments) })
                }));
                if content.is_empty() {
                    content.push(json!({ "type": "text", "text": "…" }));
                }
                json!({ "role": "assistant", "content": content })
            }
            Item::Results(results) => json!({
                "role": "user",
                "content": results.iter().map(|r| json!({
                    "type": "tool_result", "tool_use_id": r.call_id, "content": r.content, "is_error": r.is_error,
                })).collect::<Vec<_>>(),
            }),
        })
        .collect();
    // A rolling breakpoint on the newest block: the next step reads the whole
    // conversation so far from cache.
    if !ex.tools.is_empty()
        && let Some(last) = messages.last_mut().and_then(|m| m["content"].as_array_mut()).and_then(|c| c.last_mut())
    {
        *last = cached(last.take());
    }
    let mut body = json!({
        "model": ex.model,
        "max_tokens": ex.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS),
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
        body["tools"] = ex
            .tools
            .iter()
            .map(|t| json!({ "name": t.name, "description": t.description, "input_schema": t.parameters }))
            .collect();
    }
    if let Some(stop) = ex.stop {
        body["stop_sequences"] = json!(stop);
    }
    if let Some(t) = ex.temperature {
        body["temperature"] = json!(t);
    }
    body
}

pub(crate) fn openai_body(provider_id: &str, ex: &Exchange) -> Value {
    let mut messages = Vec::new();
    if !ex.system.is_empty() {
        messages.push(json!({ "role": "system", "content": ex.system }));
    }
    for item in ex.items {
        match item {
            Item::User(text) => messages.push(json!({ "role": "user", "content": text })),
            Item::Assistant { text, calls } if calls.is_empty() => {
                messages.push(json!({ "role": "assistant", "content": text }))
            }
            Item::Assistant { text, calls } => messages.push(json!({
                "role": "assistant",
                "content": if text.is_empty() { Value::Null } else { json!(text) },
                "tool_calls": calls.iter().map(|c| json!({
                    "id": c.id, "type": "function",
                    "function": { "name": c.name, "arguments": arguments_string(&c.arguments) },
                })).collect::<Vec<_>>(),
            })),
            Item::Results(results) => messages.extend(
                results
                    .iter()
                    .map(|r| json!({ "role": "tool", "tool_call_id": r.call_id, "content": r.content })),
            ),
        }
    }
    let mut body = json!({
        "model": ex.model,
        "messages": messages,
        "stream": true,
        "stream_options": { "include_usage": true },
    });
    // OpenAI's newer models reject `max_tokens`; compatible servers expect it.
    let max_key = if provider_id == "openai" { "max_completion_tokens" } else { "max_tokens" };
    body[max_key] = json!(ex.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS));
    if !ex.tools.is_empty() {
        body["tools"] = ex
            .tools
            .iter()
            .map(|t| json!({ "type": "function", "function": {
                "name": t.name, "description": t.description, "parameters": t.parameters,
            }}))
            .collect();
    }
    if provider_id == "openai"
        && let Some(key) = ex.cache_key
    {
        body["prompt_cache_key"] = json!(key);
    }
    if let Some(stop) = ex.stop {
        body["stop"] = json!(stop);
    }
    if let Some(t) = ex.temperature {
        body["temperature"] = json!(t);
    }
    if let Some(effort) = ex.reasoning {
        body["reasoning_effort"] = json!(effort);
    }
    body
}

/// The request pi-ai's `openai-codex-responses` API sends.
pub(crate) fn codex_body(ex: &Exchange) -> Value {
    let mut input = Vec::new();
    for item in ex.items {
        match item {
            Item::User(text) => {
                input.push(json!({ "role": "user", "content": [{ "type": "input_text", "text": text }] }))
            }
            Item::Assistant { text, calls } => {
                if !text.is_empty() {
                    input.push(json!({
                        "type": "message", "role": "assistant",
                        "content": [{ "type": "output_text", "text": text }],
                    }));
                }
                input.extend(calls.iter().map(|c| json!({
                    "type": "function_call", "call_id": c.id, "name": c.name,
                    "arguments": arguments_string(&c.arguments),
                })));
            }
            Item::Results(results) => input.extend(results.iter().map(|r| json!({
                "type": "function_call_output", "call_id": r.call_id, "output": r.content,
            }))),
        }
    }
    let instructions = if ex.system.is_empty() { "You are a helpful assistant." } else { ex.system };
    let mut body = json!({
        "model": ex.model,
        "store": false,
        "stream": true,
        "instructions": instructions,
        "input": input,
        "text": { "verbosity": "low" },
        "include": [],
        "tool_choice": "auto",
        "parallel_tool_calls": false,
    });
    if !ex.tools.is_empty() {
        body["tools"] = ex
            .tools
            .iter()
            .map(|t| json!({
                "type": "function", "name": t.name, "description": t.description,
                "parameters": t.parameters, "strict": false,
            }))
            .collect();
    }
    if let Some(key) = ex.cache_key {
        body["prompt_cache_key"] = json!(key);
    }
    if let Some(effort) = ex.reasoning {
        body["reasoning"] = json!({ "effort": effort });
    }
    if let Some(t) = ex.temperature {
        body["temperature"] = json!(t);
    }
    body
}

/// Anthropic wants an object; anything else the model sent is wrapped.
fn object_arguments(arguments: &Value) -> Value {
    if arguments.is_object() { arguments.clone() } else { json!({ "value": arguments }) }
}

fn arguments_string(arguments: &Value) -> String {
    match arguments {
        Value::String(raw) => raw.clone(),
        other => other.to_string(),
    }
}

fn parse_arguments(raw: &str) -> Value {
    if raw.trim().is_empty() {
        return json!({});
    }
    serde_json::from_str(raw).unwrap_or_else(|_| Value::String(raw.into()))
}

#[derive(Debug, Default)]
struct PartialCall {
    /// Anthropic's content block index, OpenAI's tool call index, or
    /// Codex's output index.
    index: u64,
    id: String,
    name: String,
    arguments: String,
    /// Codex sends the finished arguments once the item is done.
    complete: Option<Value>,
}

/// Turns one provider's stream of events into a [`Reply`].
struct Decoder {
    wire: Wire,
    reply: Reply,
    calls: Vec<PartialCall>,
    done: bool,
}

impl Decoder {
    fn new(wire: Wire) -> Self {
        Decoder { wire, reply: Reply::default(), calls: Vec::new(), done: false }
    }

    fn call(&mut self, index: u64) -> &mut PartialCall {
        let position = match self.calls.iter().position(|c| c.index == index) {
            Some(position) => position,
            None => {
                self.calls.push(PartialCall { index, ..Default::default() });
                self.calls.len() - 1
            }
        };
        &mut self.calls[position]
    }

    fn stop(&mut self, reason: Option<&str>) {
        if let Some(reason) = reason {
            self.reply.stop_reason = Some(reason.into());
        }
    }

    /// Feeds one server-sent event; returns any text to show now.
    fn feed(&mut self, event: Option<&str>, data: &str) -> Result<Option<String>> {
        if data == "[DONE]" {
            self.done = true;
            return Ok(None);
        }
        let Ok(json) = serde_json::from_str::<Value>(data) else { return Ok(None) };
        let kind = json["type"].as_str().or(event).unwrap_or("").to_string();
        let text = |v: &Value| v.as_str().filter(|s| !s.is_empty()).map(String::from);
        let error = |v: &Value| Err(v["message"].as_str().unwrap_or("the model returned an error").to_string());
        let n = |v: &Value| v.as_u64().unwrap_or(0);
        match self.wire {
            Wire::Anthropic => match kind.as_str() {
                "message_start" => {
                    let usage = &json["message"]["usage"];
                    self.reply.usage.input = n(&usage["input_tokens"]);
                    self.reply.usage.cache_read = n(&usage["cache_read_input_tokens"]);
                    self.reply.usage.cache_write = n(&usage["cache_creation_input_tokens"]);
                    self.reply.usage.output = n(&usage["output_tokens"]);
                }
                "content_block_start" if json["content_block"]["type"] == "tool_use" => {
                    let block = &json["content_block"];
                    let call = self.call(n(&json["index"]));
                    call.id = block["id"].as_str().unwrap_or_default().into();
                    call.name = block["name"].as_str().unwrap_or_default().into();
                }
                "content_block_delta" => {
                    let delta = &json["delta"];
                    match delta["type"].as_str() {
                        Some("input_json_delta") => {
                            let partial = delta["partial_json"].as_str().unwrap_or_default().to_string();
                            self.call(n(&json["index"])).arguments.push_str(&partial);
                        }
                        _ => return Ok(self.text(text(&delta["text"]))),
                    }
                }
                "message_delta" => {
                    self.stop(json["delta"]["stop_reason"].as_str());
                    if let Some(output) = json["usage"]["output_tokens"].as_u64() {
                        self.reply.usage.output = output;
                    }
                }
                "message_stop" => self.done = true,
                "error" => return error(&json["error"]),
                _ => {}
            },
            Wire::OpenAiChat => {
                if json.get("error").is_some() {
                    return error(&json["error"]);
                }
                let usage = &json["usage"];
                if usage.is_object() {
                    let cached = n(&usage["prompt_tokens_details"]["cached_tokens"]);
                    self.reply.usage.input = n(&usage["prompt_tokens"]).saturating_sub(cached);
                    self.reply.usage.cache_read = cached;
                    self.reply.usage.output = n(&usage["completion_tokens"]);
                }
                let choice = &json["choices"][0];
                if let Some(calls) = choice["delta"]["tool_calls"].as_array() {
                    for delta in calls {
                        let call = self.call(n(&delta["index"]));
                        if let Some(id) = delta["id"].as_str() {
                            call.id = id.into();
                        }
                        if let Some(name) = delta["function"]["name"].as_str() {
                            call.name.push_str(name);
                        }
                        if let Some(arguments) = delta["function"]["arguments"].as_str() {
                            call.arguments.push_str(arguments);
                        }
                    }
                }
                // Some servers put the last text and the finish reason in one chunk.
                self.stop(choice["finish_reason"].as_str());
                return Ok(self.text(text(&choice["delta"]["content"])));
            }
            Wire::Codex => match kind.as_str() {
                "response.output_text.delta" => return Ok(self.text(text(&json["delta"]))),
                "response.output_item.added" | "response.output_item.done"
                    if json["item"]["type"] == "function_call" =>
                {
                    let item = &json["item"];
                    let done = kind == "response.output_item.done";
                    let call = self.call(n(&json["output_index"]));
                    call.id = item["call_id"].as_str().unwrap_or_default().into();
                    call.name = item["name"].as_str().unwrap_or_default().into();
                    if done {
                        call.complete = Some(parse_arguments(item["arguments"].as_str().unwrap_or_default()));
                    }
                }
                "response.function_call_arguments.delta" => {
                    let delta = json["delta"].as_str().unwrap_or_default().to_string();
                    self.call(n(&json["output_index"])).arguments.push_str(&delta);
                }
                "response.completed" | "response.incomplete" => {
                    let response = &json["response"];
                    let usage = &response["usage"];
                    let cached = n(&usage["input_tokens_details"]["cached_tokens"]);
                    self.reply.usage.input = n(&usage["input_tokens"]).saturating_sub(cached);
                    self.reply.usage.cache_read = cached;
                    self.reply.usage.output = n(&usage["output_tokens"]);
                    self.stop(response["incomplete_details"]["reason"].as_str());
                    self.done = true;
                }
                "response.failed" => return error(&json["response"]["error"]),
                "error" => return error(&json),
                _ => {}
            },
        }
        Ok(None)
    }

    fn text(&mut self, delta: Option<String>) -> Option<String> {
        let delta = delta?;
        self.reply.text.push_str(&delta);
        Some(delta)
    }

    fn finish(mut self) -> Reply {
        self.calls.sort_by_key(|c| c.index);
        self.reply.calls = self
            .calls
            .into_iter()
            .filter(|c| !c.name.is_empty())
            .enumerate()
            .map(|(i, c)| ToolCall {
                // Every call needs an id to pair it with its result.
                id: if c.id.is_empty() { format!("call_{i}") } else { c.id },
                arguments: c.complete.unwrap_or_else(|| parse_arguments(&c.arguments)),
                name: c.name,
            })
            .collect();
        self.reply
    }
}

/// The useful part of an error body, without echoing anything huge.
fn error_text(body: &str) -> String {
    let message = serde_json::from_str::<Value>(body).ok().and_then(|json| {
        let candidates = [&json["error"]["message"], &json["message"], &json["detail"], &json["error"]];
        candidates.into_iter().find_map(|v| v.as_str().map(String::from))
    });
    let text = message.unwrap_or_else(|| body.trim().to_string());
    text.chars().take(300).collect()
}

/// Server-sent events, decoded line by line so a UTF-8 character split
/// across network chunks is never cut.
#[derive(Default)]
struct Sse {
    buf: Vec<u8>,
    event: Option<String>,
    data: Vec<String>,
}

impl Sse {
    fn push(&mut self, chunk: &[u8]) -> Vec<(Option<String>, String)> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some(nl) = self.buf.iter().position(|&b| b == b'\n') {
            let raw: Vec<u8> = self.buf.drain(..=nl).collect();
            let line = String::from_utf8_lossy(&raw);
            let line = line.trim_end_matches(['\n', '\r']);
            if line.is_empty() {
                if !self.data.is_empty() {
                    out.push((self.event.take(), self.data.join("\n")));
                    self.data.clear();
                }
                self.event = None;
            } else if let Some(v) = line.strip_prefix("data:") {
                self.data.push(v.strip_prefix(' ').unwrap_or(v).to_string());
            } else if let Some(v) = line.strip_prefix("event:") {
                self.event = Some(v.trim().to_string());
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode(wire: Wire, events: &[&str]) -> (Reply, String) {
        let mut decoder = Decoder::new(wire);
        let mut text = String::new();
        for data in events {
            if let Some(delta) = decoder.feed(None, data).unwrap() {
                text.push_str(&delta);
            }
        }
        assert!(decoder.done, "stream should have ended");
        (decoder.finish(), text)
    }

    fn sample_items() -> Vec<Item> {
        vec![
            Item::User("Where did I write about kilns?".into()),
            Item::Assistant {
                text: "Searching.".into(),
                calls: vec![ToolCall { id: "c1".into(), name: "search".into(), arguments: json!({ "query": "kiln" }) }],
            },
            Item::Results(vec![ToolResult { call_id: "c1".into(), content: "posts/kiln.md".into(), is_error: false }]),
        ]
    }

    fn tool() -> ToolSpec {
        ToolSpec { name: "search", description: "Search.", parameters: json!({ "type": "object" }) }
    }

    fn exchange<'a>(items: &'a [Item], tools: &'a [ToolSpec]) -> Exchange<'a> {
        Exchange {
            model: "m",
            system: "sys",
            tools,
            items,
            max_tokens: Some(100),
            temperature: None,
            stop: None,
            reasoning: None,
            cache_key: Some("kin"),
        }
    }

    #[test]
    fn sse_handles_split_chunks_crlf_and_multibyte_text() {
        let mut sse = Sse::default();
        let bytes = "event: a\r\ndata: {\"t\":\"ké\"}\r\n\r\ndata: x\ndata: y\n\n".as_bytes();
        let (first, rest) = bytes.split_at(22); // splits inside "é"
        let mut events = sse.push(first);
        events.extend(sse.push(rest));
        assert_eq!(
            events,
            vec![(Some("a".into()), "{\"t\":\"ké\"}".into()), (None, "x\ny".into())]
        );
    }

    #[test]
    fn decodes_anthropic_text_tools_and_usage() {
        let (reply, text) = decode(Wire::Anthropic, &[
            r#"{"type":"message_start","message":{"usage":{"input_tokens":12,"cache_read_input_tokens":900,"cache_creation_input_tokens":40,"output_tokens":1}}}"#,
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Let me look."}}"#,
            r#"{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"search","input":{}}}"#,
            r#"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"query\":"}}"#,
            r#"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\"kiln\"}"}}"#,
            r#"{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":30}}"#,
            r#"{"type":"message_stop"}"#,
        ]);
        assert_eq!(text, "Let me look.");
        assert_eq!(reply.calls, vec![ToolCall { id: "toolu_1".into(), name: "search".into(), arguments: json!({ "query": "kiln" }) }]);
        assert_eq!(reply.usage, Usage { input: 12, output: 30, cache_read: 900, cache_write: 40 });
        assert_eq!(reply.stop_reason.as_deref(), Some("tool_use"));
        let err = r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#;
        assert_eq!(Decoder::new(Wire::Anthropic).feed(None, err), Err("Overloaded".into()));
    }

    #[test]
    fn decodes_openai_chat_parallel_tool_calls_and_usage() {
        let (reply, text) = decode(Wire::OpenAiChat, &[
            r#"{"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","type":"function","function":{"name":"read","arguments":"{\"pa"}}]}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":1,"id":"b","type":"function","function":{"name":"list","arguments":"{}"}}]}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\":\"x.md\"}"}}]}}]}"#,
            r#"{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#,
            r#"{"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":800}}}"#,
            "[DONE]",
        ]);
        assert_eq!(text, "Hi");
        assert_eq!(reply.calls.len(), 2);
        assert_eq!(reply.calls[0], ToolCall { id: "a".into(), name: "read".into(), arguments: json!({ "path": "x.md" }) });
        assert_eq!(reply.calls[1].name, "list");
        assert_eq!(reply.usage, Usage { input: 200, output: 20, cache_read: 800, cache_write: 0 });
        assert_eq!(reply.stop_reason.as_deref(), Some("tool_calls"));
    }

    #[test]
    fn decodes_codex_function_calls_and_usage() {
        let (reply, text) = decode(Wire::Codex, &[
            r#"{"type":"response.output_text.delta","delta":"Hi"}"#,
            r#"{"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","call_id":"call_9","name":"search","arguments":""}}"#,
            r#"{"type":"response.function_call_arguments.delta","output_index":1,"delta":"{\"query\":\"ki"}"#,
            r#"{"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","call_id":"call_9","name":"search","arguments":"{\"query\":\"kiln\"}"}}"#,
            r#"{"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":500,"input_tokens_details":{"cached_tokens":400},"output_tokens":9}}}"#,
        ]);
        assert_eq!(text, "Hi");
        assert_eq!(reply.calls, vec![ToolCall { id: "call_9".into(), name: "search".into(), arguments: json!({ "query": "kiln" }) }]);
        assert_eq!(reply.usage, Usage { input: 100, output: 9, cache_read: 400, cache_write: 0 });
        let failed = r#"{"type":"response.failed","response":{"error":{"message":"nope"}}}"#;
        assert_eq!(Decoder::new(Wire::Codex).feed(None, failed), Err("nope".into()));
    }

    #[test]
    fn malformed_arguments_are_kept_as_a_string() {
        let (reply, _) = decode(Wire::OpenAiChat, &[
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"read","arguments":"{oops"}}]}}]}"#,
            "[DONE]",
        ]);
        assert_eq!(reply.calls[0].arguments, json!("{oops"));
        assert_eq!(reply.calls[0].id, "call_0");
    }

    #[test]
    fn anthropic_body_caches_the_prefix_and_the_newest_block() {
        let items = sample_items();
        let tools = [tool()];
        let body = anthropic_body(&exchange(&items, &tools));
        assert_eq!(body["system"][0]["cache_control"]["type"], "ephemeral");
        assert_eq!(body["tools"][0]["input_schema"]["type"], "object");
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(messages[1]["content"][1]["type"], "tool_use");
        assert_eq!(messages[1]["content"][1]["input"]["query"], "kiln");
        let last = &messages[2]["content"][0];
        assert_eq!(last["type"], "tool_result");
        assert_eq!(last["cache_control"]["type"], "ephemeral");
        // Earlier blocks carry no breakpoint, so the cached prefix is byte-stable.
        assert!(messages[0]["content"][0].get("cache_control").is_none());
    }

    #[test]
    fn openai_body_sends_tools_calls_and_results() {
        let items = sample_items();
        let tools = [tool()];
        let body = openai_body("openai", &exchange(&items, &tools));
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(messages[0]["role"], "system");
        assert_eq!(messages[2]["tool_calls"][0]["function"]["arguments"], r#"{"query":"kiln"}"#);
        assert_eq!(messages[3], json!({ "role": "tool", "tool_call_id": "c1", "content": "posts/kiln.md" }));
        assert_eq!(body["tools"][0]["function"]["name"], "search");
        assert_eq!(body["stream_options"]["include_usage"], true);
        assert_eq!(body["prompt_cache_key"], "kin");
        assert!(openai_body("zai", &exchange(&items, &tools)).get("prompt_cache_key").is_none());
    }

    #[test]
    fn codex_body_sends_function_calls_and_outputs() {
        let items = sample_items();
        let tools = [tool()];
        let body = codex_body(&exchange(&items, &tools));
        let input = body["input"].as_array().unwrap();
        assert_eq!(input[2]["type"], "function_call");
        assert_eq!(input[2]["call_id"], "c1");
        assert_eq!(input[3], json!({ "type": "function_call_output", "call_id": "c1", "output": "posts/kiln.md" }));
        assert_eq!(body["tools"][0]["type"], "function");
        assert_eq!(body["instructions"], "sys");
    }

    #[test]
    fn error_text_prefers_the_message() {
        assert_eq!(error_text(r#"{"error":{"message":"bad model"}}"#), "bad model");
        assert_eq!(error_text(r#"{"detail":"Unsupported parameter"}"#), "Unsupported parameter");
        assert_eq!(error_text("  plain  "), "plain");
    }
}
