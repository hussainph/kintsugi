//! Gemini, on Google AI Studio, Vertex AI (API key, "express" mode) and
//! OpenCode's gateways, as Pi sends it (`src/api/google-generative-ai.ts`,
//! `google-shared.ts`, `google-vertex.ts`, and the `@google/genai` SDK's
//! wire format).
//!
//! Gemini 3 and later take a thinking level, older models a token budget.
//! Thought signatures come back on parts (thinking, text, function calls)
//! and must go back on the same parts: a step's model parts are kept
//! verbatim and replayed within the turn.

use super::{
    Decode, Exchange, Item, Level, Mapped, Reply, Result, Route, ToolCall, Wire, reasoning_of,
    result_text, token,
};
use crate::ai::pi_auth::Auth;
use serde_json::{Map, Value, json};

pub(super) fn request(
    client: &reqwest::Client,
    route: &Route,
    auth: Option<&Auth>,
    ex: &Exchange,
) -> Result<(reqwest::RequestBuilder, Box<dyn Decode>)> {
    if ex.model.contains("..") || ex.model.contains(['?', '&', '/']) {
        return Err(format!("{} is not a Gemini model id", ex.model));
    }
    let url = if route.wire == Wire::Vertex {
        // Vertex AI with an API key ("express mode"): no project or
        // location in the path. Kin doesn't mint Google Cloud tokens, so
        // application-default credentials aren't used.
        let base = if route.base_url.contains("{location}") {
            "https://aiplatform.googleapis.com/v1".to_string()
        } else if has_version(&route.base_url) {
            route.base_url.clone()
        } else {
            format!("{}/v1", route.base_url)
        };
        format!(
            "{base}/publishers/google/models/{}:streamGenerateContent?alt=sse",
            ex.model
        )
    } else {
        format!(
            "{}/models/{}:streamGenerateContent?alt=sse",
            route.base_url, ex.model
        )
    };
    let mut builder = client.post(url).json(&body(route, ex));
    if let Some(key) = token(auth) {
        builder = builder.header("x-goog-api-key", key);
    }
    Ok((builder, Box::new(Decoder::default())))
}

/// A base URL with its own API version segment (`/v1`, `/v1beta1`).
fn has_version(url: &str) -> bool {
    url.split('/').any(|segment| {
        segment.len() >= 2
            && segment.starts_with('v')
            && segment[1..].starts_with(|c: char| c.is_ascii_digit())
            && segment[1..]
                .trim_start_matches(|c: char| c.is_ascii_digit())
                .trim_start_matches("beta")
                .chars()
                .all(|c| c.is_ascii_digit())
    })
}

/// The major version in a Gemini id (`gemini-3.1-pro` → 3).
fn major(model: &str) -> Option<u32> {
    let id = model.to_lowercase();
    let rest = id
        .strip_prefix("gemini-live-")
        .or_else(|| id.strip_prefix("gemini-"))?;
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

/// Gemini 3 and later want call ids echoed back (Pi's `requiresToolCallId`).
fn sends_ids(model: &str) -> bool {
    model.starts_with("claude-")
        || model.starts_with("gpt-oss-")
        || major(model).is_some_and(|v| v >= 3)
}

/// Models that take `thinkingLevel` rather than a budget
/// (Pi's `usesGoogleThinkingLevel`).
fn uses_level(model: &str) -> bool {
    let id = model.to_lowercase();
    let gemini3 = ["pro", "flash"].iter().any(|kind| {
        id.strip_prefix("gemini-3").is_some_and(|rest| {
            let rest = rest.trim_start_matches(|c: char| c == '.' || c.is_ascii_digit());
            rest.starts_with(&format!("-{kind}"))
        })
    });
    gemini3
        || major(&id).is_some_and(|v| v >= 4)
        || matches!(
            id.as_str(),
            "gemini-flash-latest" | "gemini-flash-lite-latest"
        )
        || id.contains("gemma-4")
        || id.contains("gemma4")
}

/// Pi's per-family thinking budgets; `-1` lets the model decide.
fn budget(route: &Route, model: &str, level: Level) -> i64 {
    let table: [i64; 4] = if model.contains("2.5-pro") {
        [128, 2048, 8192, 32768]
    } else if model.contains("2.5-flash-lite") && route.wire == Wire::Google {
        [512, 2048, 8192, 24576]
    } else if model.contains("2.5-flash") {
        [128, 2048, 8192, 24576]
    } else {
        return -1;
    };
    match level {
        Level::Off => 0,
        Level::Minimal => table[0],
        Level::Low => table[1],
        Level::Medium => table[2],
        _ => table[3],
    }
}

/// Gemini ignores `const` in a JSON schema but honours `enum` (Pi's
/// `rewriteConstAsEnum`).
fn const_as_enum(schema: &Value) -> Value {
    match schema {
        Value::Object(map) => {
            let mut out = Map::new();
            for (key, value) in map {
                out.insert(key.clone(), const_as_enum(value));
            }
            if let Some(value) = map.get("const")
                && (value.is_string() || value.is_number())
                && !map.contains_key("enum")
            {
                out.remove("const");
                out.insert("enum".into(), json!([value]));
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(const_as_enum).collect()),
        other => other.clone(),
    }
}

pub(super) fn body(route: &Route, ex: &Exchange) -> Value {
    let ids = sends_ids(ex.model);
    let mut contents: Vec<Value> = Vec::new();
    let mut pending: Option<Value> = None;
    for item in ex.items {
        match item {
            Item::User(text) => {
                contents.push(json!({ "role": "user", "parts": [{ "text": text }] }))
            }
            Item::Reasoning(values) => {
                pending = reasoning_of(values, &["gemini.parts"])
                    .next()
                    .map(|v| v["parts"].clone())
            }
            Item::Assistant { text, calls } => {
                let parts = match pending.take() {
                    // The model's own parts, signatures and all.
                    Some(Value::Array(parts)) if !parts.is_empty() => parts,
                    _ => {
                        let mut parts = Vec::new();
                        if !text.trim().is_empty() {
                            parts.push(json!({ "text": text }));
                        }
                        parts.extend(calls.iter().map(|c| {
                            let mut call = json!({ "name": c.name, "args": super::object_arguments(&c.arguments) });
                            if ids {
                                call["id"] = json!(c.id);
                            }
                            json!({ "functionCall": call })
                        }));
                        parts
                    }
                };
                if !parts.is_empty() {
                    contents.push(json!({ "role": "model", "parts": parts }));
                }
            }
            Item::Results(results) => {
                let parts: Vec<Value> = results
                    .iter()
                    .map(|r| {
                        let name = name_of(ex, &r.call_id);
                        let text = result_text(r);
                        let response = if r.is_error {
                            json!({ "error": text })
                        } else {
                            json!({ "output": text })
                        };
                        let mut part = json!({ "name": name, "response": response });
                        if ids {
                            part["id"] = json!(r.call_id);
                        }
                        json!({ "functionResponse": part })
                    })
                    .collect();
                contents.push(json!({ "role": "user", "parts": parts }));
            }
        }
    }
    let mut body = json!({ "contents": contents });
    if !ex.system.is_empty() {
        body["systemInstruction"] = json!({ "role": "user", "parts": [{ "text": ex.system }] });
    }
    if !ex.tools.is_empty() {
        let declarations: Vec<Value> = ex
            .tools
            .iter()
            .map(|t| {
                json!({
                    "name": t.name, "description": t.description,
                    "parametersJsonSchema": const_as_enum(&t.parameters),
                })
            })
            .collect();
        body["tools"] = json!([{ "functionDeclarations": declarations }]);
    }
    let mut config = json!({ "maxOutputTokens": route.max_tokens(ex) });
    if let Some(t) = ex.temperature {
        config["temperature"] = json!(t);
    }
    if let Some(stop) = ex.stop {
        config["stopSequences"] = json!(stop);
    }
    if let Some(level) = route.level(ex) {
        config["thinkingConfig"] = if level == Level::Off {
            json!({ "thinkingBudget": 0 })
        } else if uses_level(ex.model) {
            let resolved = match route.mapped(level) {
                Mapped::To(value) => value.to_lowercase(),
                _ => level.id().to_string(),
            };
            let resolved = match resolved.as_str() {
                "minimal" | "low" | "medium" | "high" => resolved,
                _ => "high".into(),
            };
            json!({ "includeThoughts": true, "thinkingLevel": resolved.to_uppercase() })
        } else {
            json!({ "includeThoughts": true, "thinkingBudget": budget(route, ex.model, level) })
        };
    }
    body["generationConfig"] = config;
    body
}

/// The tool a call id belongs to: Gemini matches responses by name.
fn name_of(ex: &Exchange, call_id: &str) -> String {
    ex.items
        .iter()
        .find_map(|item| match item {
            Item::Assistant { calls, .. } => calls.iter().find(|c| c.id == call_id),
            _ => None,
        })
        .map(|c| c.name.clone())
        .unwrap_or_default()
}

/// Streams `GenerateContentResponse` chunks into a [`Reply`].
#[derive(Default)]
struct Decoder {
    reply: Reply,
    calls: Vec<ToolCall>,
    /// The model's parts, consecutive text of one kind merged, as they go
    /// back on the next request.
    parts: Vec<Value>,
    /// Some part carried a thought or a signature: the parts must be
    /// replayed as they are.
    signed: bool,
}

impl Decoder {
    fn text_part(&mut self, text: &str, thought: bool, signature: Option<&str>) {
        let same = self
            .parts
            .last()
            .is_some_and(|p| p.get("text").is_some() && (p["thought"] == true) == thought);
        if !same {
            let mut part = json!({ "text": "" });
            if thought {
                part["thought"] = json!(true);
            }
            self.parts.push(part);
        }
        let part = self.parts.last_mut().expect("just pushed");
        let joined = format!("{}{text}", part["text"].as_str().unwrap_or_default());
        part["text"] = json!(joined);
        if let Some(signature) = signature.filter(|s| !s.is_empty()) {
            part["thoughtSignature"] = json!(signature);
        }
    }
}

impl Decode for Decoder {
    fn feed(&mut self, _event: Option<&str>, data: &str) -> Result<Option<String>> {
        let Ok(json) = serde_json::from_str::<Value>(data) else {
            return Ok(None);
        };
        if json["error"].is_object() {
            return Err(super::stream_error(&json["error"]));
        }
        let candidate = &json["candidates"][0];
        let mut shown = String::new();
        for part in candidate["content"]["parts"]
            .as_array()
            .into_iter()
            .flatten()
        {
            let signature = part["thoughtSignature"].as_str();
            if signature.is_some() {
                self.signed = true;
            }
            if let Some(text) = part["text"].as_str() {
                let thought = part["thought"] == true;
                if thought {
                    self.signed = true;
                } else {
                    shown.push_str(text);
                }
                self.text_part(text, thought, signature);
            }
            if let Some(call) = part.get("functionCall") {
                let name = call["name"].as_str().unwrap_or_default().to_string();
                let given = call["id"].as_str().filter(|id| !id.is_empty());
                let id = match given {
                    Some(id) if !self.calls.iter().any(|c| c.id == id) => id.to_string(),
                    _ => format!("{name}_{}", self.calls.len() + 1),
                };
                self.calls.push(ToolCall {
                    id,
                    name,
                    arguments: if call["args"].is_null() {
                        json!({})
                    } else {
                        call["args"].clone()
                    },
                });
                self.parts.push(part.clone());
            }
        }
        if let Some(reason) = candidate["finishReason"].as_str() {
            self.reply.stop_reason = Some(match reason {
                "STOP" => "stop".into(),
                "MAX_TOKENS" => "max_tokens".into(),
                other => other.to_string(),
            });
        }
        let usage = &json["usageMetadata"];
        if usage.is_object() {
            let n = |v: &Value| v.as_u64().unwrap_or(0);
            let cached = n(&usage["cachedContentTokenCount"]);
            self.reply.usage.input = n(&usage["promptTokenCount"]).saturating_sub(cached);
            self.reply.usage.cache_read = cached;
            self.reply.usage.cache_write = 0;
            self.reply.usage.output =
                n(&usage["candidatesTokenCount"]) + n(&usage["thoughtsTokenCount"]);
        }
        if shown.is_empty() {
            return Ok(None);
        }
        self.reply.text.push_str(&shown);
        Ok(Some(shown))
    }

    fn done(&self) -> bool {
        false
    }

    fn finish(self: Box<Self>) -> Reply {
        let mut reply = self.reply;
        if self.signed && !self.parts.is_empty() {
            reply
                .reasoning
                .push(json!({ "type": "gemini.parts", "parts": self.parts }));
        }
        if reply.stop_reason.as_deref() == Some("stop") && !self.calls.is_empty() {
            reply.stop_reason = Some("tool_calls".into());
        }
        reply.calls = self.calls;
        reply
    }
}

#[cfg(test)]
mod tests;
