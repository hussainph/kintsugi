//! Three wire formats cover every provider Kintsugi talks to: Anthropic
//! Messages, OpenAI-compatible chat completions (OpenAI, OpenRouter, Z.AI,
//! OpenCode Zen and Go, local servers), and the ChatGPT Codex Responses
//! backend.
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
    /// Read when neither OpenCode nor Pi holds a credential (GUI apps rarely
    /// inherit shell env).
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
    // OpenCode's gateways serve every text model over chat completions,
    // translating where a model's native API differs (opencode.ai/docs, Console › Harnesses).
    Provider { id: "opencode", name: "OpenCode Zen", base_url: "https://opencode.ai/inference/openai/v1", wire: Wire::OpenAiChat, env_key: Some("OPENCODE_API_KEY"), keyless: false },
    Provider { id: "opencode-go", name: "OpenCode Go", base_url: "https://opencode.ai/inference/go/openai/v1", wire: Wire::OpenAiChat, env_key: None, keyless: false },
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

/// How long one exchange waits on a quiet provider, and how often a failed
/// one is tried again.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Patience {
    /// The longest silence allowed before the response starts and between
    /// streamed chunks. Reasoning models can think quietly for a while.
    pub idle: Duration,
    /// Tries after the first, for a rate limit (429), a server error (5xx), a
    /// lost connection or a stall, and only while nothing has streamed yet.
    pub retries: u32,
    /// The first wait between tries; it doubles each time.
    pub backoff: Duration,
    /// A server asking (Retry-After) for a longer wait than this fails the
    /// call instead of holding the turn.
    pub max_wait: Duration,
}

pub(crate) const PATIENCE: Patience = Patience {
    idle: Duration::from_secs(120),
    retries: 3,
    backoff: Duration::from_secs(1),
    max_wait: Duration::from_secs(20),
};

/// Sends one exchange; text deltas go to `on_text` as they arrive.
pub async fn send(endpoint: Endpoint<'_>, ex: &Exchange<'_>, on_text: impl FnMut(&str)) -> Result<Reply> {
    send_with(endpoint, ex, on_text, PATIENCE).await
}

/// One attempt's failure, and whether trying again could help.
struct Failure {
    message: String,
    /// Some when the failure is transient: the wait the server asked for, if any.
    retry: Option<Option<Duration>>,
}

impl Failure {
    fn fatal(message: impl Into<String>) -> Self {
        Failure { message: message.into(), retry: None }
    }
    fn transient(message: impl Into<String>) -> Self {
        Failure { message: message.into(), retry: Some(None) }
    }
}

pub(crate) async fn send_with(endpoint: Endpoint<'_>, ex: &Exchange<'_>, mut on_text: impl FnMut(&str), patience: Patience) -> Result<Reply> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| e.to_string())?;
    let mut attempt = 0;
    loop {
        // Once text has reached the owner, a retry would repeat it: only a
        // call that has shown nothing yet is tried again.
        let mut streamed = false;
        let mut emit = |text: &str| {
            streamed = true;
            on_text(text);
        };
        let failure = match send_once(&client, &endpoint, ex, &mut emit, patience.idle).await {
            Ok(reply) => return Ok(reply),
            Err(failure) => failure,
        };
        let wait = match failure.retry {
            Some(asked) if !streamed && attempt < patience.retries => {
                let backoff = patience.backoff.saturating_mul(1 << attempt.min(16));
                match asked {
                    Some(asked) if asked > patience.max_wait => return Err(failure.message),
                    Some(asked) => asked.max(backoff),
                    None => backoff,
                }
            }
            _ => return Err(failure.message),
        };
        tokio::time::sleep(wait).await;
        attempt += 1;
    }
}

async fn send_once(
    client: &reqwest::Client,
    endpoint: &Endpoint<'_>,
    ex: &Exchange<'_>,
    on_text: &mut impl FnMut(&str),
    idle: Duration,
) -> std::result::Result<Reply, Failure> {
    let Endpoint { provider, base_url, auth } = endpoint;
    let builder = match provider.wire {
        Wire::Anthropic => {
            let Some(Auth::ApiKey(key)) = auth else {
                return Err(Failure::fatal("Anthropic needs an API key"));
            };
            client
                .post(format!("{base_url}/v1/messages"))
                .header("x-api-key", key)
                .header("anthropic-version", "2023-06-01")
                .json(&anthropic_body(ex))
        }
        Wire::OpenAiChat => {
            let mut builder = client.post(format!("{base_url}/chat/completions")).json(&openai_body(provider.id, ex));
            if provider.id.starts_with("opencode") {
                // OpenCode routes and caches by session; Go requires one.
                builder = builder.header("x-opencode-session", opencode_session(ex));
            }
            match auth {
                Some(Auth::ApiKey(key)) | Some(Auth::Bearer { token: key, .. }) => builder.bearer_auth(key),
                None => builder,
            }
        }
        Wire::Codex => {
            let Some(Auth::Bearer { token, account_id: Some(account) }) = auth else {
                return Err(Failure::fatal("ChatGPT needs a ChatGPT login; log in to OpenAI in OpenCode (or Pi)"));
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
    let name = provider.name;
    let stalled = || Failure::transient(format!("{name} stopped responding (nothing for {} s)", idle.as_secs()));
    let response = match tokio::time::timeout(idle, builder.send()).await {
        Err(_) => return Err(stalled()),
        Ok(Err(e)) if e.is_builder() => return Err(Failure::fatal(format!("{name}: {e}"))),
        Ok(Err(e)) => return Err(Failure::transient(format!("{name}: {e}"))),
        Ok(Ok(response)) => response,
    };
    let status = response.status();
    if !status.is_success() {
        let asked = retry_after(response.headers());
        let body = tokio::time::timeout(idle, response.text()).await.ok().and_then(|r| r.ok()).unwrap_or_default();
        let message = format!("{name} returned {status}: {}", error_text(&body));
        let transient = status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error();
        return Err(if transient { Failure { message, retry: Some(asked) } } else { Failure::fatal(message) });
    }

    let mut sse = Sse::default();
    let mut decoder = Decoder::new(provider.wire);
    let mut body = response.bytes_stream();
    'read: loop {
        let chunk = match tokio::time::timeout(idle, body.next()).await {
            Err(_) => return Err(stalled()),
            Ok(None) => break,
            Ok(Some(chunk)) => chunk.map_err(|e| Failure::transient(format!("{name}: {e}")))?,
        };
        for (event, data) in sse.push(&chunk) {
            if let Some(text) = decoder.feed(event.as_deref(), &data).map_err(Failure::fatal)? {
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

/// A Retry-After header in seconds (the HTTP-date form is ignored).
fn retry_after(headers: &reqwest::header::HeaderMap) -> Option<Duration> {
    let value = headers.get(reqwest::header::RETRY_AFTER)?.to_str().ok()?;
    value.trim().parse::<f64>().ok().filter(|s| s.is_finite() && *s >= 0.0).map(Duration::from_secs_f64)
}

/// A stable session id for OpenCode's gateways: requests sharing a model
/// and a fixed prefix (Kin's conversation, one helper's brief) share one, so
/// they're routed together and reuse the prompt cache. No randomness, no
/// content: only a hash.
fn opencode_session(ex: &Exchange) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    (ex.model, ex.system, ex.cache_key).hash(&mut hasher);
    format!("ses_kintsugi_{:016x}", hasher.finish())
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
    fn opencode_sessions_are_stable_per_prefix() {
        let items = sample_items();
        let a = exchange(&items, &[]);
        assert_eq!(opencode_session(&a), opencode_session(&exchange(&items[..1], &[])));
        assert!(opencode_session(&a).starts_with("ses_"));
        let other = Exchange { system: "another brief", ..a.clone() };
        assert_ne!(opencode_session(&a), opencode_session(&other));
    }

    #[test]
    fn error_text_prefers_the_message() {
        assert_eq!(error_text(r#"{"error":{"message":"bad model"}}"#), "bad model");
        assert_eq!(error_text(r#"{"detail":"Unsupported parameter"}"#), "Unsupported parameter");
        assert_eq!(error_text("  plain  "), "plain");
    }

    /// What the mock provider does with one request.
    enum Reply_ {
        /// A status with an optional Retry-After and a JSON error body.
        Status(u16, Option<&'static str>),
        /// A 200 event stream; `stall` holds the connection open after the
        /// events instead of finishing.
        Stream { events: Vec<String>, stall: bool },
    }

    /// A raw HTTP server answering one scripted reply per connection.
    async fn mock(script: Vec<Reply_>) -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        use std::sync::atomic::Ordering;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen = count.clone();
        tokio::spawn(async move {
            let mut script = script.into_iter();
            while let Ok((mut socket, _)) = listener.accept().await {
                let Some(reply) = script.next() else { return };
                seen.fetch_add(1, Ordering::SeqCst);
                // Read the whole request so the client never sees a reset.
                let mut request = Vec::new();
                let mut buf = [0u8; 4096];
                loop {
                    let n = socket.read(&mut buf).await.unwrap();
                    request.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&request);
                    if let Some(end) = text.find("\r\n\r\n") {
                        let length = text[..end]
                            .lines()
                            .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                            .unwrap_or(0);
                        if request.len() >= end + 4 + length {
                            break;
                        }
                    }
                    if n == 0 {
                        break;
                    }
                }
                tokio::spawn(async move {
                    match reply {
                        Reply_::Status(code, after) => {
                            let body = r#"{"error":{"message":"try later"}}"#;
                            let after = after.map(|a| format!("retry-after: {a}\r\n")).unwrap_or_default();
                            let head = format!("HTTP/1.1 {code} X\r\ncontent-type: application/json\r\n{after}content-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
                            socket.write_all(head.as_bytes()).await.unwrap();
                        }
                        Reply_::Stream { events, stall } => {
                            let head = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n";
                            socket.write_all(head.as_bytes()).await.unwrap();
                            for event in events {
                                socket.write_all(format!("data: {event}\n\n").as_bytes()).await.unwrap();
                            }
                            if stall {
                                tokio::time::sleep(Duration::from_secs(30)).await;
                            }
                        }
                    }
                    let _ = socket.shutdown().await;
                });
            }
        });
        (base, count)
    }

    fn text_event(text: &str) -> String {
        json!({ "choices": [{ "delta": { "content": text }, "finish_reason": null }] }).to_string()
    }

    fn answer(text: &str) -> Reply_ {
        let stop = json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }] }).to_string();
        Reply_::Stream { events: vec![text_event(text), stop, "[DONE]".into()], stall: false }
    }

    const QUICK: Patience = Patience {
        idle: Duration::from_millis(300),
        retries: 3,
        backoff: Duration::from_millis(10),
        max_wait: Duration::from_secs(1),
    };

    /// Sends one exchange to `base` (an OpenAI-compatible local server);
    /// returns the outcome, the streamed text and how many requests arrived.
    fn call(script: Vec<Reply_>) -> (Result<Reply>, String, usize) {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let (base, count) = mock(script).await;
            let items = vec![Item::User("hi".into())];
            let ex = exchange(&items, &[]);
            let endpoint = Endpoint { provider: provider("ollama").unwrap(), base_url: &base, auth: None };
            let mut text = String::new();
            let result = send_with(endpoint, &ex, |t| text.push_str(t), QUICK).await;
            (result, text, count.load(std::sync::atomic::Ordering::SeqCst))
        })
    }

    #[test]
    fn rate_limits_and_server_errors_are_retried_with_backoff() {
        let (result, text, requests) = call(vec![Reply_::Status(429, Some("0")), Reply_::Status(503, None), answer("Hello.")]);
        assert_eq!(result.unwrap().text, "Hello.");
        assert_eq!(text, "Hello.");
        assert_eq!(requests, 3);
    }

    #[test]
    fn retries_are_bounded() {
        let script = (0..10).map(|_| Reply_::Status(502, None)).collect();
        let (result, _, requests) = call(script);
        assert!(result.unwrap_err().contains("502"));
        assert_eq!(requests, 1 + QUICK.retries as usize);
    }

    #[test]
    fn client_errors_and_long_retry_after_are_not_retried() {
        let (result, _, requests) = call(vec![Reply_::Status(400, None), answer("no")]);
        assert!(result.unwrap_err().contains("400"));
        assert_eq!(requests, 1);
        let (result, _, requests) = call(vec![Reply_::Status(429, Some("3600")), answer("no")]);
        assert!(result.unwrap_err().contains("429"));
        assert_eq!(requests, 1);
    }

    #[test]
    fn a_stalled_stream_times_out_and_is_retried_before_any_output() {
        let (result, text, requests) = call(vec![Reply_::Stream { events: vec![], stall: true }, answer("Back.")]);
        assert_eq!(result.unwrap().text, "Back.");
        assert_eq!(text, "Back.");
        assert_eq!(requests, 2);
    }

    #[test]
    fn a_stream_that_stalls_after_output_fails_without_repeating_it() {
        let stalled = Reply_::Stream { events: vec![text_event("Half")], stall: true };
        let (result, text, requests) = call(vec![stalled, answer("Again")]);
        assert!(result.unwrap_err().contains("stopped responding"));
        assert_eq!(text, "Half");
        assert_eq!(requests, 1);
    }

    #[test]
    fn a_refused_connection_is_retried_then_fails() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let base = rt.block_on(async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            format!("http://{}", listener.local_addr().unwrap())
        });
        let items = vec![Item::User("hi".into())];
        let ex = exchange(&items, &[]);
        let endpoint = Endpoint { provider: provider("ollama").unwrap(), base_url: &base, auth: None };
        let started = std::time::Instant::now();
        let result = rt.block_on(send_with(endpoint, &ex, |_| {}, QUICK));
        assert!(result.unwrap_err().starts_with("Ollama"));
        // Three backoffs: 10 + 20 + 40 ms.
        assert!(started.elapsed() >= Duration::from_millis(70));
    }
}
