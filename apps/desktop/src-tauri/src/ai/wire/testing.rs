//! Shared test helpers for the wire formats: recorded streams (fixtures),
//! routes and a sample conversation.

use super::*;

/// A recorded stream from `wire/fixtures/` (server-sent events as a
/// provider sends them).
pub(crate) fn fixture(name: &str) -> String {
    let path = format!("{}/src/ai/wire/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
}

/// Runs a whole stream through a decoder, in awkward chunks, as the
/// transport does; returns the reply and the text shown along the way.
pub(crate) fn decode(mut decoder: Box<dyn Decode>, stream: &str) -> (Reply, String) {
    let mut text = String::new();
    let mut sse = Sse::default();
    let bytes = stream.as_bytes();
    let mut events = Vec::new();
    // Seven-byte chunks split lines, events and characters.
    for chunk in bytes.chunks(7) {
        events.extend(sse.push(chunk));
    }
    events.extend(sse.flush());
    for (event, data) in events {
        if let Some(delta) = decoder.feed(event.as_deref(), &data).unwrap() {
            text.push_str(&delta);
        }
        if decoder.done() {
            break;
        }
    }
    assert!(decoder.ended(), "the stream should have ended");
    (decoder.finish().unwrap(), text)
}

/// The first error a stream reports.
pub(crate) fn decode_error(mut decoder: Box<dyn Decode>, stream: &str) -> String {
    let mut sse = Sse::default();
    let mut events = sse.push(stream.as_bytes());
    events.extend(sse.flush());
    for (event, data) in events {
        if let Err(e) = decoder.feed(event.as_deref(), &data) {
            return e;
        }
    }
    panic!("the stream reported no error");
}

pub(crate) fn route(provider: &str, model: &str) -> Route {
    Route::new(super::provider(provider).expect("a known provider"), model)
}

pub(crate) fn sample_items() -> Vec<Item> {
    vec![
        Item::User("Where did I write about kilns?".into()),
        Item::Assistant {
            text: "Searching.".into(),
            calls: vec![ToolCall {
                id: "c1".into(),
                name: "search".into(),
                arguments: json!({ "query": "kiln" }),
            }],
        },
        Item::Results(vec![ToolResult {
            call_id: "c1".into(),
            content: "posts/kiln.md".into(),
            is_error: false,
        }]),
    ]
}

pub(crate) fn tool() -> ToolSpec {
    ToolSpec {
        name: "search",
        description: "Search.",
        parameters: json!({
            "type": "object",
            "properties": { "query": { "type": "string" }, "kind": { "const": "note" } },
            "required": ["query"],
            "additionalProperties": false,
        }),
    }
}

pub(crate) fn exchange<'a>(
    model: &'a str,
    items: &'a [Item],
    tools: &'a [ToolSpec],
) -> Exchange<'a> {
    Exchange {
        model,
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

/// The actual prepared Anthropic body, for agent prefix/cache regressions.
pub(crate) fn prepared_anthropic_body(route: &Route, ex: &Exchange) -> Value {
    let prepared = super::images::prepare_request(route, None, ex).unwrap();
    super::anthropic::body(route, &prepared.exchange(ex)).0
}

/// An exchange with a thinking level.
pub(crate) fn thinking<'a>(ex: Exchange<'a>, level: &'a str) -> Exchange<'a> {
    Exchange {
        reasoning: Some(level),
        ..ex
    }
}
