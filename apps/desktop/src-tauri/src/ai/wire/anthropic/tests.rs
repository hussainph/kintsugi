use super::super::testing::*;
use super::super::{Item, ToolCall, Usage};
use super::*;

fn decoded(name: &str) -> (Reply, String) {
    decode(Box::new(Decoder::default()), &fixture(name))
}

#[test]
fn streams_thinking_text_and_a_tool_call_with_usage() {
    let (reply, text) = decoded("anthropic-thinking-tools.sse");
    assert_eq!(text, "Let me look.");
    assert_eq!(
        reply.calls,
        vec![ToolCall {
            id: "toolu_1".into(),
            name: "search".into(),
            arguments: json!({ "query": "kiln" })
        }]
    );
    assert_eq!(
        reply.usage,
        Usage {
            input: 12,
            output: 30,
            cache_read: 900,
            cache_write: 40
        }
    );
    assert_eq!(reply.stop_reason.as_deref(), Some("tool_use"));
    assert_eq!(
        reply.reasoning,
        vec![
            json!({ "type": "thinking", "thinking": "The owner wants kilns. Search.", "signature": "EqQBCgIYAhIM" }),
            json!({ "type": "redacted_thinking", "data": "EmwKAhgBEgy3va" }),
        ]
    );
}

#[test]
fn errors_in_the_stream_are_reported() {
    let error = decode_error(
        Box::new(Decoder::default()),
        &fixture("anthropic-overloaded.sse"),
    );
    assert_eq!(error, "Overloaded");
}

#[test]
fn thinking_blocks_go_back_first_in_the_steps_message() {
    let (reply, _) = decoded("anthropic-thinking-tools.sse");
    let mut items = sample_items();
    items.insert(1, Item::Reasoning(reply.reasoning));
    let tools = [tool()];
    let ex = thinking(exchange("claude-haiku-4-5", &items, &tools), "medium");
    let (body, betas) = body(&route("anthropic", "claude-haiku-4-5"), &ex);
    let content = body["messages"][1]["content"].as_array().unwrap();
    let kinds: Vec<_> = content
        .iter()
        .map(|b| b["type"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, ["thinking", "redacted_thinking", "text", "tool_use"]);
    assert_eq!(content[0]["signature"], "EqQBCgIYAhIM");
    // Budget thinking on an older model: the budget is added to max_tokens,
    // and leaves at least 1,024 tokens for the answer (Pi).
    assert_eq!(body["max_tokens"], 100 + 8192);
    assert_eq!(
        body["thinking"],
        json!({ "type": "enabled", "budget_tokens": 100 + 8192 - 1024, "display": "summarized" })
    );
    assert_eq!(betas, ["interleaved-thinking-2025-05-14"]);
}

#[test]
fn adaptive_models_take_an_effort_and_off_disables_thinking() {
    let items = sample_items();
    let ex = exchange("claude-haiku-5-5", &items, &[]);
    let r = route("anthropic", "claude-haiku-5-5");
    let (high, betas) = body(&r, &thinking(ex.clone(), "high"));
    assert_eq!(
        high["thinking"],
        json!({ "type": "adaptive", "display": "summarized" })
    );
    assert_eq!(high["output_config"], json!({ "effort": "high" }));
    assert!(betas.is_empty());
    let (max, _) = body(&r, &thinking(ex.clone(), "max"));
    assert_eq!(max["output_config"]["effort"], "max");
    // haiku-5-5 can turn thinking off; sonnet-5-5 can't, so "off" clamps up.
    let (off, _) = body(&r, &thinking(ex.clone(), "off"));
    assert_eq!(off["thinking"], json!({ "type": "disabled" }));
    let sonnet = exchange("claude-sonnet-5-5", &items, &[]);
    let (clamped, _) = body(
        &route("anthropic", "claude-sonnet-5-5"),
        &thinking(sonnet, "off"),
    );
    assert_eq!(clamped["thinking"]["type"], "adaptive");
    // No level: nothing about thinking.
    let (plain, _) = body(&r, &ex);
    assert!(plain.get("thinking").is_none() && plain.get("output_config").is_none());
}

#[test]
fn caches_the_prefix_and_the_newest_block_and_trims_tool_schemas() {
    let items = sample_items();
    let tools = [tool()];
    let (body, _) = body(
        &route("anthropic", "claude-sonnet-5-5"),
        &exchange("claude-sonnet-5-5", &items, &tools),
    );
    assert_eq!(body["system"][0]["cache_control"]["type"], "ephemeral");
    let schema = &body["tools"][0]["input_schema"];
    assert_eq!(schema["type"], "object");
    assert_eq!(schema["required"], json!(["query"]));
    assert!(schema.get("additionalProperties").is_none());
    assert_eq!(body["tools"][0]["eager_input_streaming"], true);
    let messages = body["messages"].as_array().unwrap();
    assert_eq!(messages[1]["content"][1]["input"]["query"], "kiln");
    let last = &messages[2]["content"][0];
    assert_eq!(last["type"], "tool_result");
    assert_eq!(last["cache_control"]["type"], "ephemeral");
    // Earlier blocks carry no breakpoint, so the cached prefix is byte-stable.
    assert!(messages[0]["content"][0].get("cache_control").is_none());
    // One-off calls: a plain system string, no markers.
    let (plain, _) = super::body(
        &route("anthropic", "claude-sonnet-5-5"),
        &exchange("claude-sonnet-5-5", &items[..1], &[]),
    );
    assert_eq!(plain["system"], "sys");
    assert!(!plain.to_string().contains("cache_control"));
}

#[test]
fn signatureless_thinking_is_text_unless_the_model_allows_it() {
    let block = json!({ "type": "thinking", "thinking": "hm", "signature": "" });
    assert_eq!(
        replayed(&block, false),
        Some(json!({ "type": "text", "text": "hm" }))
    );
    assert_eq!(replayed(&block, true).unwrap()["type"], "thinking");
    assert_eq!(
        replayed(
            &json!({ "type": "thinking", "thinking": " ", "signature": "" }),
            true
        ),
        None
    );
}
