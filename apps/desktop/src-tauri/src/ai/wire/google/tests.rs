use super::super::testing::*;
use super::super::{Item, ToolCall, Usage};
use super::*;

fn decoded(name: &str) -> (Reply, String) {
    decode(Box::new(Decoder::default()), &fixture(name))
}

#[test]
fn gemini_3_streams_thoughts_signed_parts_and_a_call() {
    let (reply, text) = decoded("gemini-3-thinking-tools.sse");
    assert_eq!(text, "Searching.");
    assert_eq!(
        reply.calls,
        vec![ToolCall {
            id: "fc-77".into(),
            name: "search".into(),
            arguments: json!({ "query": "kiln" })
        }]
    );
    assert_eq!(
        reply.usage,
        Usage {
            input: 128,
            output: 280,
            cache_read: 512,
            cache_write: 0
        }
    );
    assert_eq!(reply.stop_reason.as_deref(), Some("tool_calls"));
    let parts = json!([
        { "text": "Looking for kiln notes.", "thought": true },
        { "text": "Searching.", "thoughtSignature": "Q2lRQjRY" },
        { "functionCall": { "name": "search", "args": { "query": "kiln" }, "id": "fc-77" }, "thoughtSignature": "Q2lVQmNm" },
    ]);
    assert_eq!(
        reply.reasoning,
        vec![json!({ "type": "gemini.parts", "parts": parts })]
    );

    // Replayed verbatim as the model's turn; the response carries the id.
    let mut items = vec![
        Item::User("Where?".into()),
        Item::Reasoning(reply.reasoning),
    ];
    items.push(Item::Assistant {
        text: reply.text,
        calls: reply.calls,
    });
    items.push(Item::Results(vec![super::super::ToolResult {
        call_id: "fc-77".into(),
        content: "posts/kiln.md".into(),
        is_error: false,
    }]));
    let ex = exchange("gemini-3.1-pro", &items, &[]);
    let body = body(&route("opencode", "gemini-3.1-pro"), &ex);
    assert_eq!(
        body["contents"][1],
        json!({ "role": "model", "parts": parts })
    );
    assert_eq!(
        body["contents"][2]["parts"][0],
        json!({ "functionResponse": { "name": "search", "response": { "output": "posts/kiln.md" }, "id": "fc-77" } })
    );
}

#[test]
fn gemini_2_calls_get_made_up_ids_that_are_never_sent() {
    let (reply, text) = decoded("gemini-2-tools.sse");
    assert_eq!(text, "Two files.");
    let ids: Vec<_> = reply.calls.iter().map(|c| c.id.clone()).collect();
    assert!(ids[0].starts_with("read_1_") && ids[1].starts_with("read_2_"));
    assert!(
        reply.reasoning.is_empty(),
        "nothing signed, nothing to replay"
    );
    assert_eq!(reply.usage.input, 100);
    let mut items = vec![Item::User("Read both.".into())];
    items.push(Item::Assistant {
        text: reply.text,
        calls: reply.calls,
    });
    items.push(Item::Results(vec![super::super::ToolResult {
        call_id: ids[1].clone(),
        content: "B".into(),
        is_error: true,
    }]));
    let body = body(
        &route("google", "gemini-2.5-flash"),
        &exchange("gemini-2.5-flash", &items, &[]),
    );
    assert_eq!(
        body["contents"][1]["parts"][1],
        json!({ "functionCall": { "name": "read", "args": { "path": "a.md" } } })
    );
    assert_eq!(
        body["contents"][2]["parts"][0],
        json!({ "functionResponse": { "name": "read", "response": { "error": "B" } } })
    );
}

#[test]
fn thinking_levels_for_gemini_3_and_budgets_for_2_5() {
    let items = sample_items();
    let tools = [tool()];
    let pro = exchange("gemini-3.1-pro", &items, &tools);
    let r = route("opencode", "gemini-3.1-pro");
    let high = body(&r, &thinking(pro.clone(), "high"));
    assert_eq!(
        high["generationConfig"]["thinkingConfig"],
        json!({ "includeThoughts": true, "thinkingLevel": "HIGH" })
    );
    // 3.1 Pro can't stop thinking: off clamps to its lowest level.
    let off = body(&r, &thinking(pro.clone(), "off"));
    assert_eq!(
        off["generationConfig"]["thinkingConfig"]["thinkingLevel"],
        "LOW"
    );
    let flash = exchange("gemini-2.5-flash", &items, &tools);
    let g = route("google", "gemini-2.5-flash");
    let medium = body(&g, &thinking(flash.clone(), "medium"));
    assert_eq!(
        medium["generationConfig"]["thinkingConfig"],
        json!({ "includeThoughts": true, "thinkingBudget": 8192 })
    );
    let off = body(&g, &thinking(flash.clone(), "off"));
    assert_eq!(
        off["generationConfig"]["thinkingConfig"],
        json!({ "thinkingBudget": 0 })
    );
    let plain = body(&g, &flash);
    assert!(plain["generationConfig"].get("thinkingConfig").is_none());
    assert_eq!(plain["generationConfig"]["maxOutputTokens"], 100);
    assert_eq!(plain["systemInstruction"]["parts"][0]["text"], "sys");
    // Tools as JSON Schema, `const` turned into `enum`.
    let declaration = &plain["tools"][0]["functionDeclarations"][0];
    assert_eq!(
        declaration["parametersJsonSchema"]["properties"]["kind"],
        json!({ "enum": ["note"] })
    );
    assert!(uses_level("gemini-4-argon") && uses_level("gemini-3-flash-preview"));
    assert!(!uses_level("gemini-2.5-pro") && !uses_level("gemini-pro-latest"));
    assert!(sends_ids("gemini-3.1-pro") && !sends_ids("gemini-2.5-flash"));
    assert!(has_version("https://example.com/v1beta1/") && !has_version("https://v.example.com"));
}

#[test]
fn errors_in_the_stream_are_reported() {
    let stream = r#"data: {"error":{"code":429,"message":"Resource exhausted","status":"RESOURCE_EXHAUSTED"}}"#;
    assert_eq!(
        decode_error(Box::new(Decoder::default()), stream),
        "Resource exhausted"
    );
}

#[test]
fn a_gemini_3_call_without_an_id_goes_back_with_the_one_kin_gave_it() {
    let stream = r#"data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"search","args":{}},"thoughtSignature":"Q2lR"}],"role":"model"},"finishReason":"STOP"}]}"#;
    let decoder = Decoder {
        model: "gemini-3.1-pro".into(),
        ..Decoder::default()
    };
    let (reply, _) = decode(Box::new(decoder), stream);
    let id = reply.calls[0].id.clone();
    assert!(id.starts_with("search_1_"));
    assert_eq!(
        reply.reasoning[0]["parts"][0]["functionCall"]["id"],
        json!(id)
    );
    // A safety stop is an error, not an empty answer.
    let blocked = r#"data: {"candidates":[{"finishReason":"SAFETY"}]}"#;
    let mut decoder: Box<dyn Decode> = Box::new(Decoder::default());
    decoder
        .feed(None, blocked.trim_start_matches("data: "))
        .unwrap();
    assert!(decoder.ended());
    assert!(decoder.finish().unwrap_err().contains("SAFETY"));
}
