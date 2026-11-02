use super::super::testing::*;
use super::super::{Item, ToolCall, ToolResult, Usage};
use super::*;

fn decoded(name: &str) -> (Reply, String) {
    decode(Box::new(Decoder::default()), &fixture(name))
}

fn body_for(provider: &str, ex: &Exchange) -> Value {
    let route = route(provider, ex.model);
    body(&route, &Compat::of(&route, ex.model), ex)
}

#[test]
fn streams_text_parallel_tool_calls_and_usage() {
    let (reply, text) = decoded("openai-chat-tools.sse");
    assert_eq!(text, "Hi");
    assert_eq!(
        reply.calls,
        vec![
            ToolCall {
                id: "a".into(),
                name: "read".into(),
                arguments: json!({ "path": "x.md" })
            },
            ToolCall {
                id: "b".into(),
                name: "list".into(),
                arguments: json!({})
            }
        ]
    );
    assert_eq!(
        reply.usage,
        Usage {
            input: 200,
            output: 20,
            cache_read: 800,
            cache_write: 0
        }
    );
    assert_eq!(reply.stop_reason.as_deref(), Some("tool_calls"));
    assert!(reply.reasoning.is_empty());
}

#[test]
fn deepseek_reasoning_is_kept_for_replay_and_cache_hits_counted() {
    let (reply, text) = decoded("deepseek-thinking-tools.sse");
    assert_eq!(text, "Let me look.");
    assert_eq!(reply.calls[0].arguments, json!({ "query": "kiln" }));
    assert_eq!(
        reply.reasoning,
        vec![json!({
            "type": "chat.reasoning", "field": "reasoning_content",
            "text": "The owner asks about kilns. Search first.",
        })]
    );
    assert_eq!(
        reply.usage,
        Usage {
            input: 128,
            output: 61,
            cache_read: 1920,
            cache_write: 0
        }
    );

    // Sent back on the step's assistant message; every other assistant
    // message gets an empty one (DeepSeek requires the field).
    let mut items = vec![
        Item::User("earlier".into()),
        Item::Assistant {
            text: "Earlier answer.".into(),
            calls: vec![],
        },
    ];
    items.extend(sample_items());
    items.insert(3, Item::Reasoning(reply.reasoning.clone()));
    let tools = [tool()];
    let ex = thinking(exchange("deepseek-v4-pro", &items, &tools), "high");
    let body = body_for("deepseek", &ex);
    let messages = body["messages"].as_array().unwrap();
    assert_eq!(messages[2]["reasoning_content"], "");
    assert_eq!(
        messages[4]["reasoning_content"],
        "The owner asks about kilns. Search first."
    );
    assert_eq!(body["thinking"], json!({ "type": "enabled" }));
    assert_eq!(body["reasoning_effort"], "high");
    assert_eq!(body["max_tokens"], 100);
    assert!(body.get("store").is_none() && body.get("max_completion_tokens").is_none());
    // Thinking off where the model allows it.
    let off = body_for(
        "deepseek",
        &thinking(exchange("deepseek-v4-pro", &items, &tools), "off"),
    );
    assert_eq!(off["thinking"], json!({ "type": "disabled" }));
    assert!(off.get("reasoning_effort").is_none());
}

#[test]
fn openrouter_reasoning_details_merge_and_go_back_verbatim() {
    let (reply, text) = decoded("openrouter-reasoning-details.sse");
    assert_eq!(text, "Two drafts mention it.");
    let details = json!([
        { "type": "reasoning.text", "text": "Weighing the drafts.", "format": "google-gemini-v1", "index": 0 },
        { "type": "reasoning.encrypted", "data": "CiQB4/H/Xs", "id": "tool_search_1", "format": "google-gemini-v1", "index": 1 },
    ]);
    assert_eq!(
        reply.reasoning[0],
        json!({ "type": "chat.reasoning_details", "details": details })
    );
    assert_eq!(reply.reasoning[1]["field"], "reasoning");
    // OpenRouter's cache writes are counted apart from reads.
    assert_eq!(
        reply.usage,
        Usage {
            input: 1000,
            output: 40,
            cache_read: 3000,
            cache_write: 1000
        }
    );
    let mut items = sample_items();
    items.insert(1, Item::Reasoning(reply.reasoning.clone()));
    let ex = thinking(exchange("~google/gemini-flash-latest", &items, &[]), "low");
    let body = body_for("openrouter", &ex);
    let assistant = &body["messages"][2];
    assert_eq!(assistant["reasoning_details"], details);
    assert!(
        assistant.get("reasoning").is_none(),
        "details replace the raw text"
    );
    assert_eq!(body["reasoning"], json!({ "effort": "low" }));
    assert_eq!(body["store"], false);
    assert_eq!(body["max_completion_tokens"], 100);
    // Tool history without tools: OpenRouter's proxies want `tools`.
    assert_eq!(body["tools"], json!([]));
}

#[test]
fn mistral_chunks_ids_and_tool_result_names() {
    let (reply, text) = decoded("mistral-thinking-tools.sse");
    assert_eq!(text, "Searching.");
    assert_eq!(
        reply.calls,
        vec![ToolCall {
            id: "D681PevKs".into(),
            name: "search".into(),
            arguments: json!({ "query": "kiln" })
        }]
    );
    assert_eq!(reply.reasoning[0]["text"], "Need the vault. Search it.");
    assert_eq!(reply.usage.cache_read, 512);
    assert_eq!(reply.usage.input, 300);

    let mut items = sample_items();
    items.insert(1, Item::Reasoning(reply.reasoning.clone()));
    let tools = [tool()];
    let ex = thinking(exchange("magistral-medium-latest", &items, &tools), "high");
    let body = body_for("mistral", &ex);
    let messages = body["messages"].as_array().unwrap();
    // One leading thinking chunk, then the text.
    assert_eq!(
        messages[2]["content"],
        json!([
            { "type": "thinking", "thinking": [{ "type": "text", "text": "Need the vault. Search it." }] },
            { "type": "text", "text": "Searching." },
        ])
    );
    // Ids become nine letters and digits, the same on call and result.
    let id = messages[2]["tool_calls"][0]["id"].as_str().unwrap();
    assert_eq!(id.len(), 9);
    assert!(id.chars().all(|c| c.is_ascii_alphanumeric()));
    assert_eq!(messages[3]["tool_call_id"], id);
    assert_eq!(messages[3]["name"], "search");
    assert_eq!(messages[0]["role"], "system");
    assert!(body.get("stream_options").is_none() && body.get("store").is_none());
    assert_eq!(body["tools"][0]["function"]["strict"], false);
    assert_eq!(body["prompt_cache_key"], session_id(&ex));
    assert_eq!(mistral_id("D681PevKs"), "D681PevKs");
    assert_eq!(mistral_id("call_0"), mistral_id("call_0"));
}

#[test]
fn opencode_go_reasoning_goes_back_as_reasoning_content() {
    let decoder = Decoder {
        reasoning_field: "reasoning_content",
        ..Decoder::default()
    };
    let (reply, text) = decode(Box::new(decoder), &fixture("opencode-go-reasoning.sse"));
    assert_eq!(text, "Kilns are in posts/kiln.md.");
    assert_eq!(reply.reasoning[0]["field"], "reasoning_content");
    // Moonshot-style usage: cached tokens at the top level.
    assert_eq!(reply.usage.cache_read, 200);
    assert_eq!(reply.usage.input, 100);
}

#[test]
fn errors_in_the_stream_carry_the_upstream_detail() {
    let error = decode_error(Box::new(Decoder::default()), &fixture("zai-error.sse"));
    assert_eq!(error, "Model glm-9 not found\nupstream: unknown model");
}

#[test]
fn quirks_per_provider_follow_pi() {
    let items = sample_items();
    let tools = [tool()];
    // Z.AI: thinking object, effort, tool streaming, max_tokens, system.
    let glm = body_for(
        "zai",
        &thinking(exchange("glm-5.3", &items, &tools), "high"),
    );
    assert_eq!(
        glm["thinking"],
        json!({ "type": "enabled", "clear_thinking": false })
    );
    assert_eq!(glm["reasoning_effort"], "high");
    assert_eq!(glm["tool_stream"], true);
    assert_eq!(glm["messages"][0]["role"], "system");
    assert_eq!(glm["tools"][0]["function"]["strict"], false);
    // No level asked: thinking stays at the provider's default.
    let plain = body_for("zai", &exchange("glm-5.3", &items, &tools));
    assert!(plain.get("thinking").is_none() && plain.get("reasoning_effort").is_none());
    // Groq: standard OpenAI quirks (store, developer role on reasoning models).
    let groq = body_for(
        "groq",
        &thinking(exchange("openai/gpt-oss-120b", &items, &tools), "medium"),
    );
    assert_eq!(groq["store"], false);
    assert_eq!(groq["messages"][0]["role"], "developer");
    assert_eq!(groq["max_completion_tokens"], 100);
    assert_eq!(groq["reasoning_effort"], "medium");
    // Together: reasoning toggle, no strict, max_tokens.
    let together = body_for(
        "together",
        &thinking(exchange("MiniMaxAI/MiniMax-M3", &items, &tools), "off"),
    );
    assert!(together["tools"][0]["function"].get("strict").is_none());
    assert_eq!(together["max_tokens"], 100);
    // Cerebras: no strict, no store, no developer role.
    let cerebras = body_for("cerebras", &exchange("gpt-oss-120b", &items, &tools));
    assert!(cerebras.get("store").is_none());
    assert!(cerebras["tools"][0]["function"].get("strict").is_none());
    assert_eq!(cerebras["messages"][0]["role"], "system");
    // A model the catalog doesn't list on a custom server: plain OpenAI.
    let local = body_for(
        "ollama",
        &thinking(exchange("qwen3:8b", &items, &tools), "low"),
    );
    assert_eq!(local["reasoning_effort"], "low");
    assert_eq!(local["messages"][0]["role"], "system");
    assert_eq!(local["max_tokens"], 100);
    assert!(local.get("store").is_none());
    assert_eq!(local["stream_options"]["include_usage"], true);
}

#[test]
fn openrouter_claude_batch_models_get_cache_markers_on_agent_calls() {
    let items = sample_items();
    let tools = [tool()];
    let r = route("openrouter", "anthropic/claude-x:batch");
    let compat = Compat {
        anthropic_cache: true,
        ..Compat::of(&r, "anthropic/claude-x:batch")
    };
    let body = body(
        &r,
        &compat,
        &exchange("anthropic/claude-x:batch", &items, &tools),
    );
    let messages = body["messages"].as_array().unwrap();
    assert_eq!(
        messages[0]["content"][0]["cache_control"]["type"],
        "ephemeral"
    );
    assert_eq!(
        messages[3]["content"][0]["cache_control"]["type"],
        "ephemeral"
    );
    assert!(
        messages[1]["content"].is_string(),
        "only the ends are marked"
    );
    // One-off calls skip it.
    let plain = super::body(
        &r,
        &compat,
        &exchange("anthropic/claude-x:batch", &items, &[]),
    );
    assert!(!plain.to_string().contains("cache_control"));
}

#[test]
fn tool_calls_results_and_the_system_prompt_are_sent() {
    let items = sample_items();
    let tools = [tool()];
    let ex = exchange("gpt-oss-120b", &items, &tools);
    let body = body_for("cerebras", &ex);
    let messages = body["messages"].as_array().unwrap();
    assert_eq!(messages[0], json!({ "role": "system", "content": "sys" }));
    assert_eq!(
        messages[2]["tool_calls"][0]["function"]["arguments"],
        r#"{"query":"kiln"}"#
    );
    assert_eq!(
        messages[3],
        json!({ "role": "tool", "tool_call_id": "c1", "content": "posts/kiln.md" })
    );
    // An empty result is never sent empty; an empty assistant is skipped.
    let items = vec![
        Item::User("a".into()),
        Item::Assistant {
            text: String::new(),
            calls: vec![],
        },
        Item::User("b".into()),
        Item::Results(vec![ToolResult {
            call_id: "x".into(),
            content: " ".into(),
            is_error: false,
        }]),
    ];
    let body = body_for("cerebras", &exchange("gpt-oss-120b", &items, &[]));
    let roles: Vec<_> = body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["role"].as_str().unwrap())
        .collect();
    assert_eq!(roles, ["system", "user", "user", "tool"]);
    assert_eq!(body["messages"][3]["content"], "(no tool output)");
}

#[test]
fn malformed_arguments_are_kept_as_a_string() {
    let stream = "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"read\",\"arguments\":\"{oops\"}}]}}]}\n\ndata: [DONE]\n\n";
    let (reply, _) = decode(Box::new(Decoder::default()), stream);
    assert_eq!(reply.calls[0].arguments, json!("{oops"));
    assert!(reply.calls[0].id.starts_with("call_0_"));
    // Made-up ids never repeat across a turn's steps.
    let (again, _) = decode(Box::new(Decoder::default()), stream);
    assert_ne!(again.calls[0].id, reply.calls[0].id);
}
