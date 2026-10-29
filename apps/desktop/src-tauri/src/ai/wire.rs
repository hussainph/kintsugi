//! Three wire formats cover every provider Kintsugi talks to: Anthropic
//! Messages, OpenAI-compatible chat completions (OpenAI, OpenRouter, Z.AI,
//! local servers), and the ChatGPT Codex Responses backend. Each request is
//! a single streamed turn of plain text: no tools, no agent loop.

use super::pi_auth::Auth;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
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
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Event {
    Delta { text: String },
    #[serde(rename_all = "camelCase")]
    Done { stop_reason: Option<String> },
    Error { message: String },
}

type Result<T> = std::result::Result<T, String>;

const USER_AGENT: &str = concat!("kintsugi/", env!("CARGO_PKG_VERSION"));
const DEFAULT_MAX_TOKENS: u32 = 1024;

pub async fn stream(provider: &Provider, auth: Option<Auth>, req: &Request, mut emit: impl FnMut(Event)) -> Result<()> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| e.to_string())?;
    let builder = match provider.wire {
        Wire::Anthropic => anthropic(&client, provider, auth, req)?,
        Wire::OpenAiChat => openai_chat(&client, provider, auth, req),
        Wire::Codex => codex(&client, provider, auth, req)?,
    };
    let response = builder.send().await.map_err(|e| format!("{}: {e}", provider.name))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("{} returned {status}: {}", provider.name, error_text(&body)));
    }

    let mut sse = Sse::default();
    let mut body = response.bytes_stream();
    let mut stop_reason = None;
    while let Some(chunk) = body.next().await {
        let chunk = chunk.map_err(|e| format!("{}: {e}", provider.name))?;
        for (event, data) in sse.push(&chunk) {
            match parse(provider.wire, event.as_deref(), &data)? {
                Parsed::Text(text) => emit(Event::Delta { text }),
                Parsed::Stop(reason) => stop_reason = reason.or(stop_reason),
                Parsed::Done => {
                    emit(Event::Done { stop_reason });
                    return Ok(());
                }
                Parsed::Nothing => {}
            }
        }
    }
    // Some servers just close the stream.
    emit(Event::Done { stop_reason });
    Ok(())
}

fn anthropic(client: &reqwest::Client, p: &Provider, auth: Option<Auth>, req: &Request) -> Result<reqwest::RequestBuilder> {
    let Some(Auth::ApiKey(key)) = auth else {
        return Err("Anthropic needs an API key".into());
    };
    let mut body = json!({
        "model": req.model,
        "max_tokens": req.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS),
        "messages": req.messages,
        "stream": true,
    });
    if !req.system.is_empty() {
        body["system"] = req.system.clone().into();
    }
    if let Some(stop) = &req.stop {
        body["stop_sequences"] = json!(stop);
    }
    if let Some(t) = req.temperature {
        body["temperature"] = json!(t);
    }
    Ok(client
        .post(format!("{}/v1/messages", p.base_url))
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .json(&body))
}

fn openai_chat(client: &reqwest::Client, p: &Provider, auth: Option<Auth>, req: &Request) -> reqwest::RequestBuilder {
    let mut messages = Vec::new();
    if !req.system.is_empty() {
        messages.push(json!({ "role": "system", "content": req.system }));
    }
    messages.extend(req.messages.iter().map(|m| json!(m)));
    let mut body = json!({ "model": req.model, "messages": messages, "stream": true });
    // OpenAI's newer models reject `max_tokens`; compatible servers expect it.
    let max_key = if p.id == "openai" { "max_completion_tokens" } else { "max_tokens" };
    body[max_key] = json!(req.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS));
    if let Some(stop) = &req.stop {
        body["stop"] = json!(stop);
    }
    if let Some(t) = req.temperature {
        body["temperature"] = json!(t);
    }
    if let Some(effort) = &req.reasoning {
        body["reasoning_effort"] = json!(effort);
    }
    let builder = client.post(format!("{}/chat/completions", p.base_url)).json(&body);
    match auth {
        Some(Auth::ApiKey(key)) | Some(Auth::Bearer { token: key, .. }) => builder.bearer_auth(key),
        None => builder,
    }
}

/// The request pi-ai's `openai-codex-responses` API sends, minus tools.
fn codex(client: &reqwest::Client, p: &Provider, auth: Option<Auth>, req: &Request) -> Result<reqwest::RequestBuilder> {
    let Some(Auth::Bearer { token, account_id: Some(account) }) = auth else {
        return Err("ChatGPT needs a Codex login; run `pi` and log in to OpenAI Codex".into());
    };
    let input: Vec<Value> = req
        .messages
        .iter()
        .map(|m| {
            let kind = if m.role == Role::User { "input_text" } else { "output_text" };
            json!({ "role": m.role, "content": [{ "type": kind, "text": m.content }] })
        })
        .collect();
    let instructions = if req.system.is_empty() { "You are a helpful assistant." } else { &req.system };
    let mut body = json!({
        "model": req.model,
        "store": false,
        "stream": true,
        "instructions": instructions,
        "input": input,
        "text": { "verbosity": "low" },
        "include": [],
        "tool_choice": "auto",
        "parallel_tool_calls": false,
    });
    if let Some(effort) = &req.reasoning {
        body["reasoning"] = json!({ "effort": effort });
    }
    if let Some(t) = req.temperature {
        body["temperature"] = json!(t);
    }
    Ok(client
        .post(format!("{}/codex/responses", p.base_url))
        .bearer_auth(token)
        .header("chatgpt-account-id", account)
        .header("originator", "kintsugi")
        .header("OpenAI-Beta", "responses=experimental")
        .header("accept", "text/event-stream")
        .json(&body))
}

#[derive(Debug, PartialEq)]
enum Parsed {
    Text(String),
    Stop(Option<String>),
    Done,
    Nothing,
}

fn parse(wire: Wire, event: Option<&str>, data: &str) -> Result<Parsed> {
    if data == "[DONE]" {
        return Ok(Parsed::Done);
    }
    let Ok(json) = serde_json::from_str::<Value>(data) else { return Ok(Parsed::Nothing) };
    let kind = json["type"].as_str().or(event).unwrap_or("");
    let text = |v: &Value| v.as_str().filter(|s| !s.is_empty()).map(|s| Parsed::Text(s.into()));
    let error = |v: &Value| Err(v["message"].as_str().unwrap_or("the model returned an error").to_string());
    Ok(match wire {
        Wire::Anthropic => match kind {
            "content_block_delta" => text(&json["delta"]["text"]).unwrap_or(Parsed::Nothing),
            "message_delta" => Parsed::Stop(json["delta"]["stop_reason"].as_str().map(String::from)),
            "message_stop" => Parsed::Done,
            "error" => return error(&json["error"]),
            _ => Parsed::Nothing,
        },
        Wire::OpenAiChat => {
            if json.get("error").is_some() {
                return error(&json["error"]);
            }
            let choice = &json["choices"][0];
            if let Some(reason) = choice["finish_reason"].as_str() {
                // Some servers put the last text and the finish reason in one chunk.
                return Ok(text(&choice["delta"]["content"]).unwrap_or(Parsed::Stop(Some(reason.into()))));
            }
            text(&choice["delta"]["content"]).unwrap_or(Parsed::Nothing)
        }
        Wire::Codex => match kind {
            "response.output_text.delta" => text(&json["delta"]).unwrap_or(Parsed::Nothing),
            "response.completed" | "response.incomplete" => {
                let reason = json["response"]["incomplete_details"]["reason"].as_str().map(String::from);
                if reason.is_some() {
                    Parsed::Stop(reason)
                } else {
                    Parsed::Done
                }
            }
            "response.failed" => return error(&json["response"]["error"]),
            "error" => return error(&json),
            _ => Parsed::Nothing,
        },
    })
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
    fn parses_anthropic() {
        let delta = r#"{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}"#;
        assert_eq!(parse(Wire::Anthropic, None, delta), Ok(Parsed::Text("Hi".into())));
        let stop = r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"}}"#;
        assert_eq!(parse(Wire::Anthropic, None, stop), Ok(Parsed::Stop(Some("end_turn".into()))));
        assert_eq!(parse(Wire::Anthropic, None, r#"{"type":"message_stop"}"#), Ok(Parsed::Done));
        let err = r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#;
        assert_eq!(parse(Wire::Anthropic, None, err), Err("Overloaded".into()));
    }

    #[test]
    fn parses_openai_chat() {
        let delta = r#"{"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}"#;
        assert_eq!(parse(Wire::OpenAiChat, None, delta), Ok(Parsed::Text("Hi".into())));
        let stop = r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#;
        assert_eq!(parse(Wire::OpenAiChat, None, stop), Ok(Parsed::Stop(Some("stop".into()))));
        assert_eq!(parse(Wire::OpenAiChat, None, "[DONE]"), Ok(Parsed::Done));
    }

    #[test]
    fn parses_codex() {
        let delta = r#"{"type":"response.output_text.delta","delta":"Hi"}"#;
        assert_eq!(parse(Wire::Codex, None, delta), Ok(Parsed::Text("Hi".into())));
        let done = r#"{"type":"response.completed","response":{"status":"completed"}}"#;
        assert_eq!(parse(Wire::Codex, None, done), Ok(Parsed::Done));
        let failed = r#"{"type":"response.failed","response":{"error":{"message":"nope"}}}"#;
        assert_eq!(parse(Wire::Codex, None, failed), Err("nope".into()));
    }

    #[test]
    fn error_text_prefers_the_message() {
        assert_eq!(error_text(r#"{"error":{"message":"bad model"}}"#), "bad model");
        assert_eq!(error_text(r#"{"detail":"Unsupported parameter"}"#), "Unsupported parameter");
        assert_eq!(error_text("  plain  "), "plain");
    }
}
