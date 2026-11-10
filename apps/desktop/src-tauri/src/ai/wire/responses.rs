//! The OpenAI Responses API (OpenAI, xAI, Meta, OpenCode's GPT and Grok
//! models, Copilot) and the ChatGPT Codex backend that speaks it, as Pi does
//! (`src/api/openai-responses.ts`, `openai-responses-shared.ts`,
//! `openai-codex-responses.ts`).
//!
//! Both run with `store: false`: the server keeps nothing between requests,
//! so the model's reasoning comes back encrypted (`include`) and is replayed
//! verbatim, before the step's message and function calls, on every later
//! request of the turn ([`Item::Reasoning`]).

use super::{
    Calls, Decode, Exchange, Item, Level, Mapped, Reply, Result, Route, Wire, arguments_string,
    parse_arguments, reasoning_of, result_text, session_id, stream_error, token,
};
use crate::ai::pi_auth::Auth;
use serde_json::{Value, json};

pub(super) fn request(
    client: &reqwest::Client,
    route: &Route,
    auth: Option<&Auth>,
    ex: &Exchange,
) -> Result<(reqwest::RequestBuilder, Box<dyn Decode>)> {
    let builder = if route.wire == Wire::Codex {
        let Some(Auth::Bearer {
            token,
            account_id: Some(account),
        }) = auth
        else {
            return Err(
                "ChatGPT needs a ChatGPT login; log in to OpenAI in OpenCode (or Pi)".into(),
            );
        };
        let mut builder = client
            .post(format!("{}/codex/responses", route.base_url))
            .bearer_auth(token)
            .header("chatgpt-account-id", account)
            .header("originator", "kintsugi")
            .header("OpenAI-Beta", "responses=experimental")
            .header("accept", "text/event-stream")
            .json(&codex_body(route, ex));
        if ex.cache_key.is_some() {
            let session = session_id(ex);
            builder = builder
                .header("session-id", &session)
                .header("x-client-request-id", &session);
        }
        builder
    } else {
        let mut builder = client
            .post(format!("{}/responses", route.base_url))
            .json(&body(route, auth, ex));
        if let Some(key) = token(auth) {
            builder = builder.bearer_auth(key);
        }
        if ex.cache_key.is_some() {
            let session = session_id(ex);
            match affinity(route) {
                "openrouter" => builder = builder.header("x-session-id", &session),
                format => {
                    if format == "openai" {
                        builder = builder.header("session_id", &session);
                    }
                    builder = builder.header("x-client-request-id", &session);
                }
            }
        }
        builder
    };
    Ok((builder, Box::new(Decoder::default())))
}

fn affinity(route: &Route) -> &'static str {
    match route.text("sessionAffinityFormat") {
        Some("openrouter") => "openrouter",
        Some("openai-nosession") => "openai-nosession",
        Some(_) => "openai",
        None if route.is("openrouter") || route.host_is("openrouter.ai") => "openrouter",
        None => "openai",
    }
}

/// The history as Responses input items. Reasoning items are replayed
/// verbatim (id, summary, encrypted content) where they came back.
fn input(route: &Route, ex: &Exchange) -> Vec<Value> {
    let mut input = Vec::new();
    for item in ex.items {
        match item {
            Item::User(text) => input.push(
                json!({ "role": "user", "content": [{ "type": "input_text", "text": text }] }),
            ),
            Item::Images(images) => super::append_user_parts(
                &mut input,
                "content",
                super::image_parts(
                    route,
                    images,
                    |image| json!({ "type": "input_image", "image_url": image.data_url(), "detail": "auto" }),
                    |note| json!({ "type": "input_text", "text": note }),
                ),
            ),
            Item::Assistant { text, calls } => {
                if !text.is_empty() {
                    input.push(json!({
                        "type": "message", "role": "assistant",
                        "content": [{ "type": "output_text", "text": text }],
                    }));
                }
                input.extend(calls.iter().map(|c| {
                    json!({
                        "type": "function_call", "call_id": c.id, "name": c.name,
                        "arguments": arguments_string(&c.arguments),
                    })
                }));
            }
            Item::Results(results) => input.extend(results.iter().map(|r| {
                json!({
                    "type": "function_call_output", "call_id": r.call_id, "output": result_text(r),
                })
            })),
            Item::Reasoning(values) => input.extend(reasoning_of(values, &["reasoning"]).cloned()),
        }
    }
    input
}

/// What `reasoning.effort` a level sends: the mapped value, else the
/// level's own name; `off` sends the map's `off`, else `"none"`.
fn effort(route: &Route, level: Level) -> Option<&'static str> {
    match (level, route.mapped(level)) {
        (Level::Off, Mapped::To(v)) => Some(v),
        (Level::Off, Mapped::Default) => Some("none"),
        (Level::Off, Mapped::Unsupported) => None,
        (level, mapped) => Some(mapped.or(level)),
    }
}

fn tools(ex: &Exchange, strict: Option<Value>) -> Option<Value> {
    if ex.tools.is_empty() {
        return None;
    }
    Some(
        ex.tools
            .iter()
            .map(|t| {
                let mut tool = json!({
                    "type": "function", "name": t.name, "description": t.description,
                    "parameters": t.parameters,
                });
                if let Some(strict) = &strict {
                    tool["strict"] = strict.clone();
                }
                tool
            })
            .collect(),
    )
}

/// Plain Responses (`openai-responses.ts` `buildParams`).
pub(super) fn body(route: &Route, auth: Option<&Auth>, ex: &Exchange) -> Value {
    let reasons = route.reasons();
    // A ChatGPT sign-in token (not an `sk-` key) on api.openai.com refuses
    // a few fields (Pi's `isChatGPTSignIn`).
    let chatgpt = route.is("openai")
        && route.base_url == "https://api.openai.com/v1"
        && token(auth).is_some_and(|t| !t.starts_with("sk-"));
    let mut input = Vec::new();
    if !ex.system.is_empty() {
        let developer = reasons && route.flag("supportsDeveloperRole") != Some(false);
        let role = if developer { "developer" } else { "system" };
        input.push(json!({ "role": role, "content": ex.system }));
    }
    input.extend(self::input(route, ex));
    let mut body = json!({
        "model": ex.model,
        "input": input,
        "stream": true,
        "store": false,
    });
    if let Some(key) = ex.cache_key {
        body["prompt_cache_key"] = json!(key.chars().take(64).collect::<String>());
    }
    if route.flag("supportsMaxOutputTokens") != Some(false) && !chatgpt {
        body["max_output_tokens"] = json!(route.max_tokens(ex).max(16));
    }
    if let Some(t) = ex.temperature
        && !chatgpt
    {
        body["temperature"] = json!(t);
    }
    let strict = (route.flag("supportsStrictMode") == Some(true)).then(|| json!(false));
    if let Some(tools) = tools(ex, strict) {
        body["tools"] = tools;
    }
    if let Some(level) = route.level(ex) {
        if level != Level::Off {
            body["reasoning"] = json!({ "effort": effort(route, level), "summary": "auto" });
            body["include"] = json!(["reasoning.encrypted_content"]);
        } else if !route.is("github-copilot")
            && let Some(off) = effort(route, Level::Off)
        {
            body["reasoning"] = json!({ "effort": off });
        }
    }
    if reasons {
        // Encrypted reasoning comes back only when asked for (xAI always
        // asks, Pi says): asked for whenever the model reasons, so a step's
        // reasoning goes back with the next one even at the default effort.
        body["include"] = json!(["reasoning.encrypted_content"]);
    }
    body
}

/// The request Pi's `openai-codex-responses` API sends.
pub(super) fn codex_body(route: &Route, ex: &Exchange) -> Value {
    let instructions = if ex.system.is_empty() {
        "You are a helpful assistant."
    } else {
        ex.system
    };
    let mut body = json!({
        "model": ex.model,
        "store": false,
        "stream": true,
        "instructions": instructions,
        "input": input(route, ex),
        "text": { "verbosity": "low" },
        "include": ["reasoning.encrypted_content"],
        "tool_choice": "auto",
        // Kin runs tools one at a time.
        "parallel_tool_calls": false,
    });
    if let Some(tools) = tools(ex, Some(json!(false))) {
        body["tools"] = tools;
    }
    if let Some(key) = ex.cache_key {
        body["prompt_cache_key"] = json!(key.chars().take(64).collect::<String>());
    }
    if let Some(level) = route.level(ex)
        && let Some(effort) = effort(route, level)
    {
        // Pi asks for summaries too ("auto"); Kin doesn't show them.
        body["reasoning"] = if level == Level::Off {
            json!({ "effort": effort })
        } else {
            json!({ "effort": effort, "summary": "auto" })
        };
    }
    if let Some(t) = ex.temperature {
        body["temperature"] = json!(t);
    }
    body
}

/// Streams Responses events into a [`Reply`] (Pi's `processResponsesStream`).
#[derive(Default)]
struct Decoder {
    reply: Reply,
    calls: Calls,
    /// Reasoning items by output index.
    reasoning: Vec<(u64, Value)>,
    done: bool,
}

impl Decode for Decoder {
    fn feed(&mut self, event: Option<&str>, data: &str) -> Result<Option<String>> {
        if data == "[DONE]" {
            self.done = true;
            return Ok(None);
        }
        let Ok(json) = serde_json::from_str::<Value>(data) else {
            return Ok(None);
        };
        let kind = json["type"].as_str().or(event).unwrap_or("").to_string();
        let n = |v: &Value| v.as_u64().unwrap_or(0);
        match kind.as_str() {
            "response.output_text.delta" | "response.refusal.delta" => {
                let delta = json["delta"].as_str().unwrap_or_default();
                if delta.is_empty() {
                    return Ok(None);
                }
                self.reply.text.push_str(delta);
                return Ok(Some(delta.to_string()));
            }
            "response.output_item.added" | "response.output_item.done"
                if json["item"]["type"] == "function_call" =>
            {
                let item = &json["item"];
                let call = self.calls.at(n(&json["output_index"]));
                call.id = item["call_id"].as_str().unwrap_or_default().into();
                call.name = item["name"].as_str().unwrap_or_default().into();
                if kind == "response.output_item.done" {
                    call.complete = Some(parse_arguments(
                        item["arguments"].as_str().unwrap_or(&call.arguments),
                    ));
                }
            }
            "response.output_item.done" if json["item"]["type"] == "reasoning" => {
                self.reasoning
                    .push((n(&json["output_index"]), json["item"].clone()));
            }
            "response.function_call_arguments.delta" => {
                let delta = json["delta"].as_str().unwrap_or_default().to_string();
                self.calls
                    .at(n(&json["output_index"]))
                    .arguments
                    .push_str(&delta);
            }
            "response.function_call_arguments.done" => {
                if let Some(arguments) = json["arguments"].as_str() {
                    self.calls.at(n(&json["output_index"])).arguments = arguments.into();
                }
            }
            "response.completed" | "response.incomplete" | "response.done" => {
                let response = &json["response"];
                let usage = &response["usage"];
                let cached = n(&usage["input_tokens_details"]["cached_tokens"]);
                let written = n(&usage["input_tokens_details"]["cache_write_tokens"]);
                self.reply.usage.input = n(&usage["input_tokens"]).saturating_sub(cached + written);
                self.reply.usage.cache_read = cached;
                self.reply.usage.cache_write = written;
                self.reply.usage.output = n(&usage["output_tokens"]);
                self.reply.stop_reason = response["incomplete_details"]["reason"]
                    .as_str()
                    .or(response["status"].as_str())
                    .map(String::from);
                // The final output repeats every item: fill in reasoning
                // whose `done` event was missed or came without its
                // encrypted content.
                for (index, item) in response["output"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .enumerate()
                {
                    if item["type"] != "reasoning" {
                        continue;
                    }
                    let index = index as u64;
                    match self.reasoning.iter_mut().find(|(i, _)| *i == index) {
                        Some((_, kept))
                            if kept.get("encrypted_content").is_none_or(Value::is_null) =>
                        {
                            *kept = item.clone()
                        }
                        Some(_) => {}
                        None => self.reasoning.push((index, item.clone())),
                    }
                }
                self.done = true;
            }
            "response.failed" => {
                let response = &json["response"];
                if response["error"].is_object() {
                    return Err(stream_error(&response["error"]));
                }
                return Err(match response["incomplete_details"]["reason"].as_str() {
                    Some(reason) => format!("incomplete: {reason}"),
                    None => "the model returned an error".into(),
                });
            }
            "error" => return Err(stream_error(&json)),
            _ => {}
        }
        Ok(None)
    }

    fn done(&self) -> bool {
        self.done
    }

    fn ended(&self) -> bool {
        self.done
    }

    fn finish(self: Box<Self>) -> Result<Reply> {
        if let Some(reason) = self.reply.stop_reason.as_deref()
            && matches!(reason, "content_filter" | "failed" | "cancelled")
        {
            super::refused(reason)?;
        }
        let mut reply = self.reply;
        let mut reasoning = self.reasoning;
        reasoning.sort_by_key(|(i, _)| *i);
        // Without its encrypted content an item can't be replayed.
        reply.reasoning = reasoning
            .into_iter()
            .map(|(_, item)| item)
            .filter(|item| {
                item["encrypted_content"]
                    .as_str()
                    .is_some_and(|c| !c.is_empty())
            })
            .collect();
        reply.calls = self.calls.finish();
        if reply.stop_reason.as_deref() == Some("completed") && !reply.calls.is_empty() {
            reply.stop_reason = Some("tool_calls".into());
        }
        Ok(reply)
    }
}

#[cfg(test)]
mod tests;
