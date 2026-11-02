use super::super::testing::*;
use super::super::{Item, ToolCall, Usage};
use super::*;

fn decoded(name: &str) -> (Reply, String) {
    decode(Box::new(Decoder::default()), &fixture(name))
}

#[test]
fn streams_reasoning_text_and_a_function_call() {
    let (reply, text) = decoded("openai-responses-thinking-tools.sse");
    assert_eq!(text, "Looking.");
    assert_eq!(
        reply.calls,
        vec![ToolCall {
            id: "call_9".into(),
            name: "search".into(),
            arguments: json!({ "query": "kiln" })
        }]
    );
    assert_eq!(reply.reasoning.len(), 1);
    assert_eq!(reply.reasoning[0]["encrypted_content"], "gAAAAB-enc-1");
    assert_eq!(reply.reasoning[0]["id"], "rs_1");
    assert_eq!(
        reply.usage,
        Usage {
            input: 100,
            output: 90,
            cache_read: 400,
            cache_write: 0
        }
    );
    assert_eq!(reply.stop_reason.as_deref(), Some("tool_calls"));
}

#[test]
fn codex_streams_function_calls_and_usage() {
    let (reply, text) = decoded("codex-tools.sse");
    assert_eq!(text, "Hi");
    assert_eq!(reply.calls[0].arguments, json!({ "query": "kiln" }));
    assert_eq!(reply.usage.input, 100);
    assert_eq!(reply.usage.cache_read, 400);
}

#[test]
fn a_response_cut_off_reports_max_output_tokens() {
    let (reply, text) = decoded("responses-incomplete.sse");
    assert_eq!(text, "A long");
    assert_eq!(reply.stop_reason.as_deref(), Some("max_output_tokens"));
    let failed = r#"data: {"type":"response.failed","response":{"error":{"message":"nope"}}}"#;
    assert_eq!(decode_error(Box::new(Decoder::default()), failed), "nope");
}

#[test]
fn reasoning_missing_from_its_done_event_is_filled_from_the_final_output() {
    let bare = json!({ "type": "reasoning", "id": "rs_2", "summary": [] });
    let full =
        json!({ "type": "reasoning", "id": "rs_2", "summary": [], "encrypted_content": "gBBB" });
    let lost = json!({ "type": "reasoning", "id": "rs_3", "summary": [] });
    let stream = format!(
        "data: {}\n\ndata: {}\n\n",
        json!({ "type": "response.output_item.done", "output_index": 0, "item": bare }),
        json!({ "type": "response.completed", "response": { "output": [full, { "type": "message" }, lost], "usage": {} } }),
    );
    let (reply, _) = decode(Box::new(Decoder::default()), &stream);
    assert_eq!(reply.reasoning, vec![full]);
}

#[test]
fn reasoning_goes_back_verbatim_before_the_steps_items() {
    let reasoning =
        json!({ "type": "reasoning", "id": "rs_1", "summary": [], "encrypted_content": "gAAA" });
    let mut items = sample_items();
    items.insert(1, Item::Reasoning(vec![reasoning.clone()]));
    let tools = [tool()];
    let ex = thinking(exchange("gpt-5.5", &items, &tools), "high");
    let body = body(&route("openai", "gpt-5.5"), None, &ex);
    let input = body["input"].as_array().unwrap();
    let kinds: Vec<_> = input
        .iter()
        .map(|i| i["type"].as_str().or(i["role"].as_str()).unwrap())
        .collect();
    assert_eq!(
        kinds,
        [
            "developer",
            "user",
            "reasoning",
            "message",
            "function_call",
            "function_call_output"
        ]
    );
    assert_eq!(input[2], reasoning);
    assert_eq!(
        body["reasoning"],
        json!({ "effort": "high", "summary": "auto" })
    );
    assert_eq!(body["include"], json!(["reasoning.encrypted_content"]));
    assert_eq!(body["store"], false);
    assert_eq!(body["max_output_tokens"], 100);
    assert_eq!(body["prompt_cache_key"], "kin");
    assert_eq!(body["tools"][0]["strict"], false);
    assert!(body.get("instructions").is_none());
    // Off sends the model's own "off" value.
    let off = super::body(
        &route("openai", "gpt-5.5"),
        None,
        &thinking(ex.clone(), "off"),
    );
    assert_eq!(off["reasoning"], json!({ "effort": "none" }));
    assert!(off.get("include").is_none());
    // The other wires never see it.
    let chat_route = route("cerebras", "gpt-oss-120b");
    let compat = crate::ai::wire::chat::Compat::of(&chat_route, "gpt-oss-120b");
    let chat = crate::ai::wire::chat::body(&chat_route, &compat, &ex);
    assert!(!chat.to_string().contains("gAAA"));
    let (anthropic, _) =
        crate::ai::wire::anthropic::body(&route("anthropic", "claude-haiku-4-5"), &ex);
    assert!(!anthropic.to_string().contains("gAAA"));
}

#[test]
fn xai_always_asks_for_encrypted_reasoning_and_omits_strict() {
    let items = sample_items();
    let tools = [tool()];
    let ex = exchange("grok-4.3", &items, &tools);
    let body = body(&route("xai", "grok-4.3"), None, &ex);
    assert_eq!(body["include"], json!(["reasoning.encrypted_content"]));
    assert!(body["tools"][0].get("strict").is_none());
    assert!(body.get("reasoning").is_none(), "no level asked");
    // A ChatGPT sign-in token on api.openai.com refuses a few fields.
    let chatgpt = Auth::Bearer {
        token: "eyJ-chatgpt".into(),
        account_id: None,
    };
    let body = super::body(&route("openai", "gpt-5.5"), Some(&chatgpt), &ex);
    assert!(body.get("max_output_tokens").is_none());
}

#[test]
fn codex_body_asks_for_and_replays_encrypted_reasoning() {
    let reasoning =
        json!({ "type": "reasoning", "id": "rs_1", "summary": [], "encrypted_content": "gAAA" });
    let mut items = sample_items();
    items.insert(1, Item::Reasoning(vec![reasoning.clone()]));
    let tools = [tool()];
    let r = route("openai-codex", "gpt-6-luna");
    let body = codex_body(
        &r,
        &thinking(exchange("gpt-6-luna", &items, &tools), "high"),
    );
    assert_eq!(body["include"], json!(["reasoning.encrypted_content"]));
    assert_eq!(
        body["reasoning"],
        json!({ "effort": "high", "summary": "auto" })
    );
    assert_eq!(body["store"], false);
    assert_eq!(body["instructions"], "sys");
    let input = body["input"].as_array().unwrap();
    let kinds: Vec<_> = input
        .iter()
        .map(|i| i["type"].as_str().unwrap_or("user"))
        .collect();
    assert_eq!(
        kinds,
        [
            "user",
            "reasoning",
            "message",
            "function_call",
            "function_call_output"
        ]
    );
    assert_eq!(input[1], reasoning);
    assert_eq!(
        input[4],
        json!({ "type": "function_call_output", "call_id": "c1", "output": "posts/kiln.md" })
    );
    // "none" is off: the map's value, else "none"; minimal maps to low.
    let none = codex_body(
        &r,
        &thinking(exchange("gpt-6-luna", &items, &tools), "none"),
    );
    assert_eq!(none["reasoning"], json!({ "effort": "none" }));
    let minimal = codex_body(
        &r,
        &thinking(exchange("gpt-6-luna", &items, &tools), "minimal"),
    );
    assert_eq!(minimal["reasoning"]["effort"], "low");
}
