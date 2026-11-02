//! Kin's transport: a handful of wire formats cover every provider Kin
//! talks to, ported from Pi (`@earendil-works/pi-ai` 1.5.0, `src/api/`):
//!
//! - [`chat`]: OpenAI-compatible chat completions (OpenRouter, Groq,
//!   Cerebras, Mistral, DeepSeek, Z.AI, Together, Fireworks, OpenCode,
//!   Moonshot, local servers, …), with Pi's per-provider quirks (`compat`).
//! - [`responses`]: the OpenAI Responses API (OpenAI, xAI, Meta, OpenCode's
//!   GPT models) and the ChatGPT Codex backend.
//! - [`anthropic`]: Anthropic Messages (Anthropic, MiniMax, OpenRouter's and
//!   OpenCode's Claude models, Vercel AI Gateway, Fireworks).
//! - [`google`]: Gemini (Google AI Studio, Vertex AI, OpenCode's Gemini).
//!
//! The catalog (`catalog.rs`) decides per model which wire and base URL a
//! request uses ([`Route`]); a provider's defaults serve unlisted models.
//!
//! One streamed request is an [`Exchange`]: a system prompt, optional tools
//! and a provider-neutral history of [`Item`]s. It comes back as a [`Reply`]
//! (text, tool calls, token usage, reasoning to replay) while text deltas
//! stream to a callback. The agent loop (`agent.rs`) runs many exchanges per
//! turn; the webview's plain streaming ([`stream`]) is one exchange without
//! tools.

mod anthropic;
mod chat;
mod google;
mod responses;

use super::catalog::{self, Level};
use super::pi_auth::Auth;
pub use super::providers::{PROVIDERS, Provider, provider};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::Duration;

/// A wire format: Pi's API ids map onto these.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Wire {
    Anthropic,
    OpenAiChat,
    OpenAiResponses,
    Codex,
    Google,
    Vertex,
}

impl Wire {
    /// The wire for one of Pi's API ids. Mistral's own API is its
    /// OpenAI-compatible chat completions (Pi served it that way until
    /// March 2026; its native module posts to the same endpoint).
    pub fn from_api(api: &str) -> Option<Wire> {
        Some(match api {
            "anthropic-messages" => Wire::Anthropic,
            "openai-completions" | "mistral-conversations" => Wire::OpenAiChat,
            "openai-responses" => Wire::OpenAiResponses,
            "openai-codex-responses" => Wire::Codex,
            "google-generative-ai" => Wire::Google,
            "google-vertex" => Wire::Vertex,
            _ => return None,
        })
    }

    /// Pi's name for it, as `ai_models` reports it.
    pub fn api(self) -> &'static str {
        match self {
            Wire::Anthropic => "anthropic-messages",
            Wire::OpenAiChat => "openai-completions",
            Wire::OpenAiResponses => "openai-responses",
            Wire::Codex => "openai-codex-responses",
            Wire::Google => "google-generative-ai",
            Wire::Vertex => "google-vertex",
        }
    }
}

/// Where one model's requests go and how: its wire, base URL and catalog
/// entry (quirks, limits, thinking levels).
#[derive(Debug, Clone)]
pub struct Route {
    pub provider: &'static Provider,
    pub wire: Wire,
    pub base_url: String,
    pub model: Option<&'static catalog::Model>,
}

impl Route {
    pub fn new(provider: &'static Provider, model_id: &str) -> Route {
        match catalog::find(provider.id, model_id) {
            Some(model) => {
                let wire = Wire::from_api(&model.api).unwrap_or(provider.wire);
                let base = model.base_url.trim_end_matches('/');
                let base_url = if model.api == "mistral-conversations" {
                    format!("{base}/v1")
                } else {
                    base.to_string()
                };
                Route {
                    provider,
                    wire,
                    base_url,
                    model: Some(model),
                }
            }
            None => Route {
                provider,
                wire: provider.wire,
                base_url: provider.base_url.to_string(),
                model: None,
            },
        }
    }

    /// A catalog quirk (Pi's `compat`), if the model sets it.
    pub(crate) fn flag(&self, name: &str) -> Option<bool> {
        self.model.and_then(|m| m.flag(name))
    }

    pub(crate) fn text(&self, name: &str) -> Option<&'static str> {
        self.model.and_then(|m| m.text(name))
    }

    /// Whether the catalog says the model reasons (Pi assumes a model it
    /// doesn't list doesn't, for roles and replay; a thinking level asked for
    /// is still sent to it).
    pub(crate) fn reasons(&self) -> bool {
        self.model.is_some_and(|m| m.reasoning)
    }

    /// The thinking level a request asks for, clamped to what the model
    /// supports; `None` leaves thinking at the provider's default. A model
    /// that doesn't reason gets nothing.
    pub(crate) fn level(&self, ex: &Exchange) -> Option<Level> {
        let level = Level::parse(ex.reasoning?)?;
        match self.model {
            Some(m) if !m.reasoning => None,
            Some(m) => Some(m.clamp(level)),
            None => Some(level),
        }
    }

    /// What the model's `thinkingLevelMap` says about a level.
    pub(crate) fn mapped(&self, level: Level) -> Mapped {
        let entry = self
            .model
            .and_then(|m| m.thinking_level_map.get(level.id()));
        match entry {
            None => Mapped::Default,
            Some(Value::String(s)) => Mapped::To(s),
            Some(_) => Mapped::Unsupported,
        }
    }

    /// The largest output a request may ask for: the caller's, within the
    /// model's limit.
    pub(crate) fn max_tokens(&self, ex: &Exchange) -> u32 {
        let wanted = ex.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS);
        match self.model {
            Some(m) => wanted.min(u32::try_from(m.max_tokens).unwrap_or(u32::MAX)),
            None => wanted,
        }
    }

    pub(crate) fn host_is(&self, host: &str) -> bool {
        self.base_url.contains(host)
    }

    pub(crate) fn is(&self, provider: &str) -> bool {
        self.provider.id == provider
    }
}

/// A `thinkingLevelMap` entry.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum Mapped {
    /// Absent: the wire's own value for the level.
    Default,
    /// `null`: the model doesn't support the level.
    Unsupported,
    To(&'static str),
}

impl Mapped {
    /// The mapped value, else the level's own name (Pi's `map[level] ?? level`).
    pub(crate) fn or(self, level: Level) -> &'static str {
        match self {
            Mapped::To(value) => value,
            _ => level.id(),
        }
    }
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
    /// A thinking level (`"off"`, `"low"`, …, Pi's levels; `"none"` is
    /// `off`) for models that think.
    pub reasoning: Option<String>,
    /// What the call is for (`"edit"`, `"complete"`), for the cost ledger.
    #[serde(default)]
    pub task: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Event {
    Delta {
        text: String,
    },
    #[serde(rename_all = "camelCase")]
    Done {
        stop_reason: Option<String>,
    },
    Error {
        message: String,
    },
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
    Assistant {
        text: String,
        calls: Vec<ToolCall>,
    },
    Results(Vec<ToolResult>),
    /// A step's reasoning, opaque and wire-specific, exactly as
    /// [`Reply::reasoning`] returned it. It precedes the step's
    /// [`Item::Assistant`] and is sent back, in place, within the turn; each
    /// wire reads only its own shapes and skips the rest.
    Reasoning(Vec<Value>),
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
    /// A thinking level; `None` leaves thinking at the provider's default.
    pub reasoning: Option<&'a str>,
    /// Groups requests that share a prefix, for providers that route or
    /// cache on it.
    pub cache_key: Option<&'a str>,
}

/// Token counts, normalized: `input` is uncached input billed at the full
/// rate, `cache_read` and `cache_write` are billed at their own rates.
/// `output` includes reasoning tokens.
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
    /// The step's reasoning in the wire's own form (Responses reasoning
    /// items, Anthropic thinking blocks, chat `reasoning_content`, Gemini
    /// thought signatures), to replay with the next request of the same turn.
    pub reasoning: Vec<Value>,
}

type Result<T> = std::result::Result<T, String>;

const USER_AGENT: &str = concat!("kintsugi/", env!("CARGO_PKG_VERSION"));
const DEFAULT_MAX_TOKENS: u32 = 1024;

/// Where and how to send. Tests point `route.base_url` at a local mock.
pub struct Endpoint {
    pub route: Route,
    pub auth: Option<Auth>,
}

impl Endpoint {
    pub fn new(provider: &'static Provider, model: &str, auth: Option<Auth>) -> Self {
        let mut route = Route::new(provider, model);
        // A Copilot login's token names its own API host (Pi's
        // `github-copilot.ts`); a token from the environment doesn't.
        if provider.id == "github-copilot"
            && let Some(base) = token(auth.as_ref()).and_then(copilot_base)
        {
            route.base_url = base;
        }
        Endpoint { route, auth }
    }
}

/// `proxy-ep=proxy.X` in a Copilot token means its API is at `https://api.X`.
fn copilot_base(token: &str) -> Option<String> {
    let host = token
        .split(';')
        .find_map(|part| part.trim().strip_prefix("proxy-ep="))?;
    let host = match host.strip_prefix("proxy.") {
        Some(rest) => format!("api.{rest}"),
        None => host.to_string(),
    };
    Some(format!("https://{host}"))
}

/// The webview's plain streaming call: one exchange, events as they come.
pub async fn stream(
    endpoint: Endpoint,
    req: &Request,
    mut emit: impl FnMut(Event),
) -> Result<Reply> {
    let items: Vec<Item> = req
        .messages
        .iter()
        .map(|m| match m.role {
            Role::User => Item::User(m.content.clone()),
            Role::Assistant => Item::Assistant {
                text: m.content.clone(),
                calls: vec![],
            },
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
    let reply = send(endpoint, &exchange, |text| {
        emit(Event::Delta { text: text.into() })
    })
    .await?;
    emit(Event::Done {
        stop_reason: reply.stop_reason.clone(),
    });
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
pub async fn send(
    endpoint: Endpoint,
    ex: &Exchange<'_>,
    on_text: impl FnMut(&str),
) -> Result<Reply> {
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
        Failure {
            message: message.into(),
            retry: None,
        }
    }
    fn transient(message: impl Into<String>) -> Self {
        Failure {
            message: message.into(),
            retry: Some(None),
        }
    }
}

pub(crate) async fn send_with(
    endpoint: Endpoint,
    ex: &Exchange<'_>,
    mut on_text: impl FnMut(&str),
    patience: Patience,
) -> Result<Reply> {
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
            Ok(reply) => {
                #[cfg(feature = "headless")]
                if crate::headless::wire_trace() {
                    eprintln!("{}", shape(&endpoint.route, ex, &reply));
                }
                return Ok(reply);
            }
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

/// Turns one wire's server-sent events into a [`Reply`].
pub(crate) trait Decode: Send {
    /// Feeds one event; returns any text to show now.
    fn feed(&mut self, event: Option<&str>, data: &str) -> Result<Option<String>>;
    /// The stream said it is finished: stop reading.
    fn done(&self) -> bool;
    /// The reply is whole: the stream ended the way the wire ends a reply
    /// (a finish reason, a terminal event). A stream cut off before that is
    /// a failure, never a short answer with half a tool call.
    fn ended(&self) -> bool;
    /// The reply, or why the model stopped without one (a refusal, a
    /// content filter).
    fn finish(self: Box<Self>) -> Result<Reply>;
}

/// A stop reason that means the model gave up rather than answered.
fn refused(reason: &str) -> Result<()> {
    Err(format!("The model stopped without answering ({reason})."))
}

/// Builds one wire's request: the HTTP request with its body and auth.
fn request(
    client: &reqwest::Client,
    endpoint: &Endpoint,
    ex: &Exchange,
) -> std::result::Result<(reqwest::RequestBuilder, Box<dyn Decode>), Failure> {
    let route = &endpoint.route;
    let auth = endpoint.auth.as_ref();
    let built = match route.wire {
        Wire::Anthropic => anthropic::request(client, route, auth, ex),
        Wire::OpenAiChat => chat::request(client, route, auth, ex),
        Wire::OpenAiResponses | Wire::Codex => responses::request(client, route, auth, ex),
        Wire::Google | Wire::Vertex => google::request(client, route, auth, ex),
    };
    let (builder, decoder) = built.map_err(Failure::fatal)?;
    Ok((common_headers(builder, route, ex), decoder))
}

/// Headers every wire sends for some providers: the catalog's per-model
/// headers, OpenCode's session, Copilot's per-request ones.
fn common_headers(
    mut builder: reqwest::RequestBuilder,
    route: &Route,
    ex: &Exchange,
) -> reqwest::RequestBuilder {
    if let Some(model) = route.model {
        for (name, value) in &model.headers {
            if let Some(value) = value.as_str() {
                builder = builder.header(name.as_str(), value);
            }
        }
    }
    if route.provider.id.starts_with("opencode") || route.host_is("opencode.ai") {
        // OpenCode routes and caches by session; Go requires one.
        builder = builder.header("x-opencode-session", session_id(ex));
    }
    if route.is("github-copilot") {
        // Pi's `github-copilot-headers.ts`: a request the owner started
        // is "user", the agent's own follow-ups "agent" (Copilot bills
        // them differently). Kin's wrap-up and empty-reply notes are user
        // messages, but follow tool results or an empty reply.
        let n = ex.items.len();
        let owner = matches!(ex.items.last(), Some(Item::User(_)))
            && !ex.items.iter().any(|i| matches!(i, Item::Results(_)))
            && !matches!(
                n.checked_sub(2).map(|i| &ex.items[i]),
                Some(Item::Assistant { text, calls }) if text.is_empty() && calls.is_empty()
            );
        let initiator = if owner { "user" } else { "agent" };
        builder = builder
            .header("X-Initiator", initiator)
            .header("Openai-Intent", "conversation-edits");
    }
    builder
}

/// The bearer token a request carries, whatever kind of credential it is.
fn token(auth: Option<&Auth>) -> Option<&str> {
    match auth {
        Some(Auth::ApiKey(key)) => Some(key),
        Some(Auth::Bearer { token, .. }) => Some(token),
        None => None,
    }
}

async fn send_once(
    client: &reqwest::Client,
    endpoint: &Endpoint,
    ex: &Exchange<'_>,
    on_text: &mut impl FnMut(&str),
    idle: Duration,
) -> std::result::Result<Reply, Failure> {
    let (builder, mut decoder) = request(client, endpoint, ex)?;
    let name = endpoint.route.provider.name;
    let stalled = || {
        Failure::transient(format!(
            "{name} stopped responding (nothing for {} s)",
            idle.as_secs()
        ))
    };
    let response = match tokio::time::timeout(idle, builder.send()).await {
        Err(_) => return Err(stalled()),
        Ok(Err(e)) if e.is_builder() => return Err(Failure::fatal(format!("{name}: {e}"))),
        Ok(Err(e)) => return Err(Failure::transient(format!("{name}: {e}"))),
        Ok(Ok(response)) => response,
    };
    let status = response.status();
    if !status.is_success() {
        let asked = retry_after(response.headers());
        let body = tokio::time::timeout(idle, response.text())
            .await
            .ok()
            .and_then(|r| r.ok())
            .unwrap_or_default();
        let message = format!("{name} returned {status}: {}", error_text(&body));
        let transient =
            status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error();
        return Err(if transient {
            Failure {
                message,
                retry: Some(asked),
            }
        } else {
            Failure::fatal(message)
        });
    }

    let mut sse = Sse::default();
    let mut body = response.bytes_stream();
    'read: loop {
        let chunk = match tokio::time::timeout(idle, body.next()).await {
            Err(_) => return Err(stalled()),
            Ok(None) => break,
            Ok(Some(chunk)) => chunk.map_err(|e| Failure::transient(format!("{name}: {e}")))?,
        };
        for (event, data) in sse.push(&chunk) {
            if let Some(text) = decoder
                .feed(event.as_deref(), &data)
                .map_err(Failure::fatal)?
            {
                on_text(&text);
            }
            if decoder.done() {
                break 'read;
            }
        }
    }
    // A server that just closes the stream ends it too.
    for (event, data) in sse.flush() {
        if let Some(text) = decoder
            .feed(event.as_deref(), &data)
            .map_err(Failure::fatal)?
        {
            on_text(&text);
        }
    }
    if !decoder.ended() {
        return Err(Failure::transient(format!(
            "{name}: the reply was cut off before it finished"
        )));
    }
    decoder.finish().map_err(Failure::fatal)
}

/// One request and its reply as shapes only, never content: what the
/// headless wire trace (`KINTSUGI_HEADLESS_WIRE_TRACE=1`) prints.
#[cfg_attr(not(feature = "headless"), allow(dead_code))]
fn shape(route: &Route, ex: &Exchange, reply: &Reply) -> String {
    let sent: Vec<String> = ex
        .items
        .iter()
        .map(|item| match item {
            Item::User(_) => "user".into(),
            Item::Assistant { calls, .. } => format!("assistant+{}calls", calls.len()),
            Item::Results(results) => format!("results{}", results.len()),
            Item::Reasoning(items) => format!("reasoning{}", items.len()),
        })
        .collect();
    format!(
        "wire: {}/{} ({}) sent [{}] got calls={} reasoning={} text={} stop={} out={}",
        route.provider.id,
        ex.model,
        route.wire.api(),
        sent.join(","),
        reply.calls.len(),
        reply.reasoning.len(),
        reply.text.chars().count(),
        reply.stop_reason.as_deref().unwrap_or("-"),
        reply.usage.output,
    )
}

/// A Retry-After header in seconds (the HTTP-date form is ignored).
fn retry_after(headers: &reqwest::header::HeaderMap) -> Option<Duration> {
    let value = headers.get(reqwest::header::RETRY_AFTER)?.to_str().ok()?;
    value
        .trim()
        .parse::<f64>()
        .ok()
        .and_then(|s| Duration::try_from_secs_f64(s).ok())
}

/// A stable session id: requests sharing a model and a fixed prefix (Kin's
/// conversation, one helper's brief) share one, so gateways route them
/// together and reuse the prompt cache. No randomness, no content: only a
/// hash. Sent as OpenCode's `x-opencode-session` and as the session
/// affinity headers Pi sends.
fn session_id(ex: &Exchange) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    (ex.model, ex.system, ex.cache_key).hash(&mut hasher);
    format!("ses_kintsugi_{:016x}", hasher.finish())
}

/// Anthropic wants an object; anything else the model sent is wrapped.
fn object_arguments(arguments: &Value) -> Value {
    if arguments.is_object() {
        arguments.clone()
    } else {
        json!({ "value": arguments })
    }
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

/// The text of a tool result as the model sees it: never empty (Pi).
fn result_text(result: &ToolResult) -> &str {
    if result.content.trim().is_empty() {
        "(no tool output)"
    } else {
        &result.content
    }
}

#[derive(Debug, Default)]
struct PartialCall {
    /// The wire's own index for the call (a content block, a tool call
    /// index, an output item).
    index: u64,
    id: String,
    name: String,
    arguments: String,
    /// Some wires send the finished arguments whole.
    complete: Option<Value>,
}

/// Tool calls assembled from streamed pieces.
#[derive(Debug, Default)]
struct Calls(Vec<PartialCall>);

impl Calls {
    fn at(&mut self, index: u64) -> &mut PartialCall {
        let position = match self.0.iter().position(|c| c.index == index) {
            Some(position) => position,
            None => {
                self.0.push(PartialCall {
                    index,
                    ..Default::default()
                });
                self.0.len() - 1
            }
        };
        &mut self.0[position]
    }

    fn is_empty(&self) -> bool {
        self.0.iter().all(|c| c.name.is_empty())
    }

    fn finish(mut self) -> Vec<ToolCall> {
        self.0.sort_by_key(|c| c.index);
        self.0
            .into_iter()
            .filter(|c| !c.name.is_empty())
            .enumerate()
            .map(|(i, c)| ToolCall {
                // Every call needs an id to pair it with its result.
                id: if c.id.is_empty() {
                    made_up_id("call", i)
                } else {
                    c.id
                },
                arguments: c.complete.unwrap_or_else(|| parse_arguments(&c.arguments)),
                name: c.name,
            })
            .collect()
    }
}

/// An id for a call the provider sent without one: unique in the process,
/// so ids never repeat across a turn's steps.
fn made_up_id(prefix: &str, index: usize) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    format!("{prefix}_{index}_{}", NEXT.fetch_add(1, Ordering::Relaxed))
}

/// The reasoning items of one wire, from an [`Item::Reasoning`]: the values
/// whose `type` is one of `kinds`.
fn reasoning_of<'a>(values: &'a [Value], kinds: &'a [&str]) -> impl Iterator<Item = &'a Value> {
    values
        .iter()
        .filter(move |v| v["type"].as_str().is_some_and(|t| kinds.contains(&t)))
}

/// The useful part of an error body, without echoing anything huge.
fn error_text(body: &str) -> String {
    let message = serde_json::from_str::<Value>(body).ok().and_then(|json| {
        let json = match json {
            // Gemini wraps streamed errors in an array.
            Value::Array(mut items) if !items.is_empty() => items.swap_remove(0),
            other => other,
        };
        let candidates = [
            &json["error"]["message"],
            &json["message"],
            &json["detail"],
            &json["error"],
        ];
        candidates
            .into_iter()
            .find_map(|v| v.as_str().map(String::from))
    });
    let text = message.unwrap_or_else(|| body.trim().to_string());
    text.chars().take(300).collect()
}

/// An error a provider sent inside the stream.
fn stream_error(error: &Value) -> String {
    error["message"]
        .as_str()
        .or_else(|| error.as_str())
        .unwrap_or("the model returned an error")
        .to_string()
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
            self.line(line, &mut out);
        }
        out
    }

    fn line(&mut self, line: &str, out: &mut Vec<(Option<String>, String)>) {
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

    /// An event the server left unterminated when it closed the stream.
    fn flush(&mut self) -> Vec<(Option<String>, String)> {
        let mut out = Vec::new();
        let rest = String::from_utf8_lossy(&std::mem::take(&mut self.buf)).into_owned();
        for line in rest.lines() {
            self.line(line.trim_end_matches('\r'), &mut out);
        }
        self.line("", &mut out);
        out
    }
}

#[cfg(test)]
pub(crate) mod testing;

#[cfg(test)]
mod tests;
