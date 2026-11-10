//! The transport: server-sent events, retries, stalls, and what each wire
//! puts on the HTTP request (path, auth, headers), against a local server
//! that replays recorded streams.

use super::testing::*;
use super::*;
use std::sync::{Arc, Mutex};

#[test]
fn sse_handles_split_chunks_crlf_and_multibyte_text() {
    let mut sse = Sse::default();
    let bytes = "event: a\r\ndata: {\"t\":\"ké\"}\r\n\r\ndata: x\ndata: y\n\n".as_bytes();
    let (first, rest) = bytes.split_at(22); // splits inside "é"
    let mut events = sse.push(first);
    events.extend(sse.push(rest));
    assert_eq!(
        events,
        vec![
            (Some("a".into()), "{\"t\":\"ké\"}".into()),
            (None, "x\ny".into())
        ]
    );
    // A last event the server never terminated still counts.
    let mut sse = Sse::default();
    assert!(sse.push(b"data: {\"end\":1}").is_empty());
    assert_eq!(sse.flush(), vec![(None, "{\"end\":1}".into())]);
}

#[test]
fn every_catalog_api_has_a_wire_and_routes_follow_the_catalog() {
    for api in [
        "openai-completions",
        "openai-responses",
        "openai-codex-responses",
        "anthropic-messages",
        "google-generative-ai",
        "google-vertex",
        "mistral-conversations",
    ] {
        assert!(Wire::from_api(api).is_some(), "{api}");
    }
    assert_eq!(Wire::from_api("bedrock-converse-stream"), None);
    // OpenRouter serves Claude over Anthropic Messages, the rest over chat.
    let claude = route("openrouter", "~anthropic/claude-haiku-latest");
    assert_eq!(claude.wire, Wire::Anthropic);
    assert_eq!(claude.base_url, "https://openrouter.ai/api");
    let gemini = route("openrouter", "~google/gemini-flash-latest");
    assert_eq!(gemini.wire, Wire::OpenAiChat);
    assert_eq!(gemini.base_url, "https://openrouter.ai/api/v1");
    // OpenCode serves each model on its native API.
    assert_eq!(route("opencode-go", "kimi-k3").wire, Wire::OpenAiChat);
    assert_eq!(route("opencode", "claude-sonnet-5-5").wire, Wire::Anthropic);
    assert_eq!(route("opencode", "gpt-6-luna").wire, Wire::OpenAiResponses);
    assert_eq!(route("opencode", "gemini-3.1-pro").wire, Wire::Google);
    // Mistral's API is its chat completions, under /v1.
    let mistral = route("mistral", "codestral-2508");
    assert_eq!(
        (mistral.wire, mistral.base_url.as_str()),
        (Wire::OpenAiChat, "https://api.mistral.ai/v1")
    );
    // A model the catalog doesn't list takes its provider's defaults.
    let unknown = route("groq", "next-year-model");
    assert!(unknown.model.is_none());
    assert_eq!(
        (unknown.wire, unknown.base_url.as_str()),
        (Wire::OpenAiChat, "https://api.groq.com/openai/v1")
    );
}

#[test]
fn max_tokens_stay_within_the_model_limit_and_levels_are_clamped() {
    let items = sample_items();
    let r = route("groq", "llama-3.1-8b-instant");
    let limit = r.model.unwrap().max_tokens as u32;
    let ex = Exchange {
        max_tokens: Some(limit + 1000),
        ..exchange("llama-3.1-8b-instant", &items, &[])
    };
    assert_eq!(r.max_tokens(&ex), limit);
    // Not a reasoning model: no level at all.
    assert_eq!(r.level(&thinking(ex.clone(), "high")), None);
    // GLM-5.3 can't turn thinking off: off becomes its lowest level.
    let glm = route("zai", "glm-5.3");
    let ex = exchange("glm-5.3", &items, &[]);
    assert_eq!(glm.level(&thinking(ex.clone(), "none")), Some(Level::Low));
    assert_eq!(glm.level(&thinking(ex.clone(), "bogus")), None);
    assert_eq!(glm.level(&ex), None);
}

#[test]
fn error_text_prefers_the_message() {
    assert_eq!(
        error_text(r#"{"error":{"message":"bad model"}}"#),
        "bad model"
    );
    assert_eq!(
        error_text(r#"{"detail":"Unsupported parameter"}"#),
        "Unsupported parameter"
    );
    assert_eq!(
        error_text(r#"[{"error":{"code":400,"message":"API key not valid"}}]"#),
        "API key not valid"
    );
    assert_eq!(error_text("  plain  "), "plain");
}

#[test]
fn sessions_are_stable_per_prefix() {
    let items = sample_items();
    let a = exchange("m", &items, &[]);
    assert_eq!(session_id(&a), session_id(&exchange("m", &items[..1], &[])));
    assert!(session_id(&a).starts_with("ses_"));
    let other = Exchange {
        system: "another brief",
        ..a.clone()
    };
    assert_ne!(session_id(&a), session_id(&other));
}

/// What the mock provider does with one request.
pub(crate) enum Reply_ {
    /// A status with an optional Retry-After and a JSON error body.
    Status(u16, Option<&'static str>),
    /// A 200 event stream; `stall` holds the connection open after the
    /// events instead of finishing.
    Stream { events: Vec<String>, stall: bool },
    /// A 200 with this raw event-stream body (a recorded fixture).
    Raw(String),
}

/// A raw HTTP server answering one scripted reply per connection; it keeps
/// every request (head and body) it was sent.
async fn mock(script: Vec<Reply_>) -> (String, Arc<Mutex<Vec<String>>>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let requests = seen.clone();
    tokio::spawn(async move {
        let mut script = script.into_iter();
        while let Ok((mut socket, _)) = listener.accept().await {
            let Some(reply) = script.next() else { return };
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
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if request.len() >= end + 4 + length {
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            requests
                .lock()
                .unwrap()
                .push(String::from_utf8_lossy(&request).into_owned());
            tokio::spawn(async move {
                let head = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n";
                match reply {
                    Reply_::Status(code, after) => {
                        let body = r#"{"error":{"message":"try later"}}"#;
                        let after = after
                            .map(|a| format!("retry-after: {a}\r\n"))
                            .unwrap_or_default();
                        let head = format!(
                            "HTTP/1.1 {code} X\r\ncontent-type: application/json\r\n{after}content-length: {}\r\nconnection: close\r\n\r\n{body}",
                            body.len()
                        );
                        socket.write_all(head.as_bytes()).await.unwrap();
                    }
                    Reply_::Stream { events, stall } => {
                        socket.write_all(head.as_bytes()).await.unwrap();
                        for event in events {
                            socket
                                .write_all(format!("data: {event}\n\n").as_bytes())
                                .await
                                .unwrap();
                        }
                        if stall {
                            tokio::time::sleep(Duration::from_secs(30)).await;
                        }
                    }
                    Reply_::Raw(body) => {
                        socket.write_all(head.as_bytes()).await.unwrap();
                        socket.write_all(body.as_bytes()).await.unwrap();
                    }
                }
                let _ = socket.shutdown().await;
            });
        }
    });
    (base, seen)
}

fn text_event(text: &str) -> String {
    json!({ "choices": [{ "delta": { "content": text }, "finish_reason": null }] }).to_string()
}

fn answer(text: &str) -> Reply_ {
    let stop = json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }] }).to_string();
    Reply_::Stream {
        events: vec![text_event(text), stop, "[DONE]".into()],
        stall: false,
    }
}

const QUICK: Patience = Patience {
    idle: Duration::from_millis(300),
    retries: 3,
    backoff: Duration::from_millis(10),
    max_wait: Duration::from_secs(1),
};

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

/// Sends `ex` for `provider`/`model` to a local server that answers with
/// `script`; returns the outcome, the streamed text and the raw requests.
fn send_to(
    provider: &str,
    auth: Option<Auth>,
    ex: &Exchange,
    script: Vec<Reply_>,
) -> (Result<Reply>, String, Vec<String>) {
    runtime().block_on(async {
        let (base, seen) = mock(script).await;
        let endpoint = Endpoint {
            route: Route {
                base_url: base,
                ..route(provider, ex.model)
            },
            auth,
        };
        let mut text = String::new();
        let result = send_with(endpoint, ex, |t| text.push_str(t), QUICK).await;
        let requests = seen.lock().unwrap().clone();
        (result, text, requests)
    })
}

/// Sends one plain exchange to a local OpenAI-compatible server.
fn call(script: Vec<Reply_>) -> (Result<Reply>, String, usize) {
    let items = vec![Item::User("hi".into())];
    let ex = exchange("m", &items, &[]);
    let (result, text, requests) = send_to("ollama", None, &ex, script);
    (result, text, requests.len())
}

#[test]
fn rate_limits_and_server_errors_are_retried_with_backoff() {
    let (result, text, requests) = call(vec![
        Reply_::Status(429, Some("0")),
        Reply_::Status(503, None),
        answer("Hello."),
    ]);
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
    let (result, text, requests) = call(vec![
        Reply_::Stream {
            events: vec![],
            stall: true,
        },
        answer("Back."),
    ]);
    assert_eq!(result.unwrap().text, "Back.");
    assert_eq!(text, "Back.");
    assert_eq!(requests, 2);
}

#[test]
fn a_stream_that_stalls_after_output_fails_without_repeating_it() {
    let stalled = Reply_::Stream {
        events: vec![text_event("Half")],
        stall: true,
    };
    let (result, text, requests) = call(vec![stalled, answer("Again")]);
    assert!(result.unwrap_err().contains("stopped responding"));
    assert_eq!(text, "Half");
    assert_eq!(requests, 1);
}

#[test]
fn a_refused_connection_is_retried_then_fails() {
    let rt = runtime();
    let base = rt.block_on(async {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        format!("http://{}", listener.local_addr().unwrap())
    });
    let items = vec![Item::User("hi".into())];
    let ex = exchange("m", &items, &[]);
    let endpoint = Endpoint {
        route: Route {
            base_url: base,
            ..route("ollama", "m")
        },
        auth: None,
    };
    let started = std::time::Instant::now();
    let result = rt.block_on(send_with(endpoint, &ex, |_| {}, QUICK));
    assert!(result.unwrap_err().starts_with("Ollama"));
    // Three backoffs: 10 + 20 + 40 ms.
    assert!(started.elapsed() >= Duration::from_millis(70));
}

/// The request line and headers of a raw request, lowercased.
fn head(request: &str) -> String {
    request
        .split("\r\n\r\n")
        .next()
        .unwrap_or_default()
        .to_lowercase()
}

fn body_of(request: &str) -> Value {
    serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap_or_default()).unwrap()
}

fn key(value: &str) -> Option<Auth> {
    Some(Auth::ApiKey(value.into()))
}

#[test]
fn chat_completions_end_to_end_with_bearer_auth_and_session_headers() {
    let items = sample_items();
    let tools = [tool()];
    let ex = exchange("~google/gemini-flash-latest", &items, &tools);
    let (result, text, requests) = send_to(
        "openrouter",
        key("or-key"),
        &ex,
        vec![Reply_::Raw(fixture("openrouter-reasoning-details.sse"))],
    );
    let reply = result.unwrap();
    assert_eq!(text, "Two drafts mention it.");
    assert_eq!(reply.stop_reason.as_deref(), Some("stop"));
    let head = head(&requests[0]);
    assert!(head.starts_with("post /chat/completions "), "{head}");
    assert!(head.contains("authorization: bearer or-key"));
    assert!(head.contains("x-session-id: ses_kintsugi_"));
    assert!(!head.contains("x-api-key"));
}

#[test]
fn opencode_sends_its_session_on_every_wire() {
    let items = sample_items();
    for (model, path, fixture_name) in [
        ("kimi-k3", "/chat/completions", "opencode-go-reasoning.sse"),
        (
            "gpt-6-luna",
            "/responses",
            "openai-responses-thinking-tools.sse",
        ),
        (
            "claude-haiku-5-5",
            "/v1/messages",
            "anthropic-thinking-tools.sse",
        ),
        (
            "gemini-4-argon",
            "/models/gemini-4-argon:streamgeneratecontent?alt=sse",
            "gemini-3-thinking-tools.sse",
        ),
    ] {
        let ex = exchange(model, &items, &[]);
        let (result, _, requests) = send_to(
            "opencode-go",
            key("oc-key"),
            &ex,
            vec![Reply_::Raw(fixture(fixture_name))],
        );
        result.unwrap();
        let head = head(&requests[0]);
        assert!(
            head.starts_with(&format!("post {path} ")),
            "{model}: {head}"
        );
        assert!(
            head.contains(&format!("x-opencode-session: {}", session_id(&ex))),
            "{model}"
        );
    }
}

#[test]
fn anthropic_sends_its_key_version_and_betas() {
    let items = sample_items();
    let tools = [tool()];
    let ex = thinking(exchange("claude-haiku-4-5", &items, &tools), "medium");
    let (result, text, requests) = send_to(
        "anthropic",
        key("sk-ant-api"),
        &ex,
        vec![Reply_::Raw(fixture("anthropic-thinking-tools.sse"))],
    );
    let reply = result.unwrap();
    assert_eq!(text, "Let me look.");
    assert_eq!(reply.calls[0].name, "search");
    let head = head(&requests[0]);
    assert!(head.starts_with("post /v1/messages "));
    assert!(head.contains("x-api-key: sk-ant-api"));
    assert!(head.contains("anthropic-version: 2023-06-01"));
    assert!(head.contains("anthropic-beta: interleaved-thinking-2025-05-14"));
    assert!(!head.contains("authorization:"));
}

#[test]
fn responses_and_codex_take_their_paths_and_headers() {
    let items = sample_items();
    let ex = exchange("gpt-5.5", &items, &[]);
    let (result, _, requests) = send_to(
        "openai",
        key("sk-proj"),
        &ex,
        vec![Reply_::Raw(fixture("openai-responses-thinking-tools.sse"))],
    );
    result.unwrap();
    let head_ = head(&requests[0]);
    assert!(head_.starts_with("post /responses "));
    assert!(head_.contains("authorization: bearer sk-proj"));
    assert!(head_.contains("session_id: ses_kintsugi_"));

    let codex = Some(Auth::Bearer {
        token: "jwt".into(),
        account_id: Some("acct".into()),
    });
    let ex = exchange("gpt-6-luna", &items, &[]);
    let (result, _, requests) = send_to(
        "openai-codex",
        codex,
        &ex,
        vec![Reply_::Raw(fixture("codex-tools.sse"))],
    );
    result.unwrap();
    let head_ = head(&requests[0]);
    assert!(head_.starts_with("post /codex/responses "));
    assert!(head_.contains("chatgpt-account-id: acct"));
    assert!(head_.contains("session-id: ses_kintsugi_"));
    // Codex needs a ChatGPT login, not a key.
    let (result, _, requests) = send_to("openai-codex", key("sk"), &ex, vec![]);
    assert!(result.unwrap_err().contains("ChatGPT login"));
    assert!(requests.is_empty());
}

#[test]
fn gemini_and_vertex_send_the_key_in_a_header() {
    let items = sample_items();
    let ex = exchange("gemini-2.5-flash", &items, &[]);
    let (result, text, requests) = send_to(
        "google",
        key("AIza-test"),
        &ex,
        vec![Reply_::Raw(fixture("gemini-2-tools.sse"))],
    );
    let reply = result.unwrap();
    assert_eq!(text, "Two files.");
    assert_eq!(reply.calls.len(), 2);
    let head_ = head(&requests[0]);
    assert!(head_.starts_with("post /models/gemini-2.5-flash:streamgeneratecontent?alt=sse "));
    assert!(head_.contains("x-goog-api-key: aiza-test"));
    assert!(!head_.contains("key="));
    assert_eq!(body_of(&requests[0])["contents"][0]["role"], "user");

    // Vertex with an API key: express mode, no project or location.
    let route = route("google-vertex", "gemini-2.5-flash");
    assert!(route.base_url.contains("{location}"));
    let rt = runtime();
    let built = rt.block_on(async {
        let client = reqwest::Client::new();
        let endpoint = Endpoint {
            route,
            auth: key("vertex-key"),
        };
        let (builder, _) = request(&client, &endpoint, &ex).ok().unwrap();
        builder.build().unwrap()
    });
    assert_eq!(
        built.url().as_str(),
        "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-flash:streamGenerateContent?alt=sse"
    );
    assert_eq!(built.headers()["x-goog-api-key"], "vertex-key");
}

#[test]
fn copilot_and_catalog_headers_are_sent() {
    let items = sample_items();
    let ex = exchange("kimi-k3", &items, &[]);
    let (result, _, requests) = send_to(
        "github-copilot",
        key("gho-token"),
        &ex,
        vec![Reply_::Raw(fixture("opencode-go-reasoning.sse"))],
    );
    result.unwrap();
    let head = head(&requests[0]);
    assert!(head.contains("copilot-integration-id: vscode-chat"));
    assert!(head.contains("x-initiator: agent"));
    assert!(head.contains("openai-intent: conversation-edits"));
    assert!(head.contains("authorization: bearer gho-token"));
}

#[test]
fn a_copilot_login_names_its_own_api_host() {
    let token = "tid=abc;exp=1800000000;proxy-ep=proxy.business.githubcopilot.com;st=dotcom";
    assert_eq!(
        copilot_base(token).as_deref(),
        Some("https://api.business.githubcopilot.com")
    );
    let copilot = super::provider("github-copilot").unwrap();
    let endpoint = Endpoint::new(copilot, "kimi-k3", Some(Auth::ApiKey(token.into())));
    assert_eq!(
        endpoint.route.base_url,
        "https://api.business.githubcopilot.com"
    );
    // A token from the environment keeps the catalog's host.
    let endpoint = Endpoint::new(copilot, "kimi-k3", Some(Auth::ApiKey("gho_plain".into())));
    assert_eq!(
        endpoint.route.base_url,
        "https://api.individual.githubcopilot.com"
    );
}

#[test]
fn a_cut_off_stream_is_a_failure_retried_only_before_any_output() {
    let closed = |events: Vec<String>| Reply_::Stream {
        events,
        stall: false,
    };
    let (result, text, requests) = call(vec![closed(vec![]), answer("Whole.")]);
    assert_eq!(result.unwrap().text, "Whole.");
    assert_eq!((text.as_str(), requests), ("Whole.", 2));
    let (result, text, requests) = call(vec![closed(vec![text_event("Hal")]), answer("no")]);
    assert!(result.unwrap_err().contains("cut off"));
    assert_eq!((text.as_str(), requests), ("Hal", 1));
}

#[test]
fn refusals_and_subscription_tokens_are_errors() {
    let items = sample_items();
    let ex = exchange("claude-haiku-4-5", &items, &[]);
    let refusal = "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":3}}}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"refusal\"}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";
    let (result, _, _) = send_to(
        "anthropic",
        key("sk-ant-api"),
        &ex,
        vec![Reply_::Raw(refusal.into())],
    );
    assert!(result.unwrap_err().contains("refusal"));
    let (result, _, requests) = send_to("anthropic", key("sk-ant-oat01-x"), &ex, vec![]);
    assert!(result.unwrap_err().contains("subscription token"));
    assert!(requests.is_empty());
    let filtered = "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"content_filter\"}]}\n\ndata: [DONE]\n\n";
    let items = vec![Item::User("hi".into())];
    let (result, _, _) = send_to(
        "ollama",
        None,
        &exchange("m", &items, &[]),
        vec![Reply_::Raw(filtered.into())],
    );
    assert!(result.unwrap_err().contains("content_filter"));
}

#[test]
fn an_unlisted_mistral_model_still_reaches_v1() {
    assert_eq!(
        route("mistral", "next-year-model").base_url,
        "https://api.mistral.ai/v1"
    );
    // A huge Retry-After is just ignored.
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(reqwest::header::RETRY_AFTER, "1e300".parse().unwrap());
    assert_eq!(retry_after(&headers), None);
}

#[test]
fn aggregate_image_preparation_is_request_local_and_identical_on_retry() {
    runtime().block_on(async {
        let (base, seen) = mock(vec![Reply_::Status(503, None), answer("Done.")]).await;
        let fixture: Value = serde_json::from_str(&fixture("images.json")).unwrap();
        let image: Image = serde_json::from_value(fixture["image"].clone()).unwrap();
        let items = [
            Item::User("Look.".into()),
            Item::Images(vec![image.clone(), image]),
        ];
        let original = items.clone();
        let mut route = route("openai", "gpt-4o");
        route.base_url = base;
        route.wire = Wire::OpenAiChat;
        let mut model = route.model.unwrap().clone();
        model.input_limits =
            serde_json::from_value(json!({"images": {"maxPerRequest": 1}})).unwrap();
        route.model = Some(Box::leak(Box::new(model)));
        let ex = exchange("gpt-4o", &items, &[]);
        let reply = send_with(Endpoint { route, auth: None }, &ex, |_| {}, QUICK)
            .await
            .unwrap();
        assert_eq!(reply.text, "Done.");
        assert_eq!(items, original);
        let requests = seen.lock().unwrap();
        assert_eq!(requests.len(), 2);
        let bodies: Vec<&str> = requests
            .iter()
            .map(|request| request.split_once("\r\n\r\n").unwrap().1)
            .collect();
        assert_eq!(bodies[0], bodies[1]);
        assert_eq!(bodies[0].matches("image_url\":{").count(), 1);
        assert_eq!(bodies[0].matches("Older images omitted").count(), 1);
        assert_eq!(ex.system, "sys");
    });
}

#[test]
fn nonimage_request_over_budget_is_refused_without_contacting_provider() {
    runtime().block_on(async {
        let (base, seen) = mock(vec![answer("Should not be called.")]).await;
        let mut route = route("openai", "gpt-4o");
        route.base_url = base;
        let mut model = route.model.unwrap().clone();
        model.input_limits = serde_json::from_value(json!({"maxRequestBytes": 1})).unwrap();
        route.model = Some(Box::leak(Box::new(model)));
        let items = [Item::User("Too large.".into())];
        let ex = exchange("gpt-4o", &items, &[]);
        let error = send_with(
            Endpoint { route, auth: None },
            &ex,
            |_| panic!("unexpected stream"),
            QUICK,
        )
        .await
        .unwrap_err();
        assert!(error.contains("without images"));
        assert!(seen.lock().unwrap().is_empty());
    });
}
