//! Image request fixtures, shared across the four wire formats.

use super::testing::*;
use super::*;

fn fixture_images() -> (Value, Image) {
    let fixture: Value = serde_json::from_str(&fixture("images.json")).unwrap();
    let image = serde_json::from_value(fixture["image"].clone()).unwrap();
    (fixture, image)
}

fn history(image: &Image) -> Vec<Item> {
    vec![
        Item::User("Compare these.".into()),
        Item::Images(vec![image.clone()]),
        Item::Assistant {
            text: String::new(),
            calls: vec![ToolCall {
                id: "c1".into(),
                name: "read".into(),
                arguments: json!({ "path": "photo.png" }),
            }],
        },
        Item::Results(vec![ToolResult {
            call_id: "c1".into(),
            content: "photo.png".into(),
            is_error: false,
        }]),
        Item::Images(vec![image.clone()]),
    ]
}

/// Extract only conversation content, without system prompt or options.
fn encoded(route: &Route, items: &[Item]) -> Value {
    let ex = Exchange {
        system: "",
        ..exchange(
            route.model.map_or("unknown-local", |m| m.id.as_str()),
            items,
            &[],
        )
    };
    match route.wire {
        Wire::Anthropic => anthropic::body(route, &ex).0["messages"].take(),
        Wire::OpenAiChat => {
            chat::body(route, &chat::Compat::of(route, ex.model), &ex)["messages"].take()
        }
        Wire::OpenAiResponses => responses::body(route, None, &ex)["input"].take(),
        Wire::Codex => responses::codex_body(route, &ex)["input"].take(),
        Wire::Google | Wire::Vertex => google::body(route, &ex)["contents"].take(),
    }
}

#[test]
fn image_requests_match_every_wire_fixture() {
    let (fixture, image) = fixture_images();
    let items = history(&image);
    for (provider, model, key) in [
        ("anthropic", "claude-sonnet-5-5", "anthropic"),
        ("groq", "qwen/qwen3.6-27b", "chat"),
        ("openai", "gpt-4o", "responses"),
        ("openai-codex", "gpt-6-luna", "responses"),
        ("google", "gemini-2.5-flash", "google"),
    ] {
        let route = route(provider, model);
        assert!(route.model.unwrap().images());
        assert_eq!(encoded(&route, &items), fixture[key], "{provider}/{model}");
    }
    // Vertex and Google share the same inlineData shape.
    let mut vertex = route("google", "gemini-2.5-flash");
    vertex.wire = Wire::Vertex;
    assert_eq!(encoded(&vertex, &items), fixture["google"]);
}

#[test]
fn nonvision_models_get_a_note_and_a_catalog_image_alternative() {
    let (_, image) = fixture_images();
    let items = history(&image);
    // Exercise the common guard through every encoder, including Codex.
    for wire in [
        Wire::Anthropic,
        Wire::OpenAiChat,
        Wire::OpenAiResponses,
        Wire::Codex,
        Wire::Google,
        Wire::Vertex,
    ] {
        let mut route = route("openai", "gpt-4");
        route.wire = wire;
        let body = encoded(&route, &items).to_string();
        assert!(!body.contains(&image.data), "{wire:?} leaked image bytes");
        assert!(!body.contains("input_image"));
        assert!(!body.contains("inlineData"));
        assert!(!body.contains("image_url"));
        assert!(body.contains("This model cannot read images. Try "));
        let alternative = catalog::models("openai").find(|m| m.images()).unwrap();
        assert!(body.contains(&alternative.id));
        assert!(body.contains("Compare these."));
        assert!(body.contains("photo.png"));
    }
    let mut text_only = route("ollama", "unknown");
    text_only.model = Some(catalog::find("openai", "gpt-4").unwrap());
    assert!(
        encoded(&text_only, &items)
            .to_string()
            .contains("This model cannot read images.")
    );
    assert!(!encoded(&text_only, &items).to_string().contains("Try "));
}

#[test]
fn unknown_local_models_still_receive_images() {
    let (_, image) = fixture_images();
    let route = route("ollama", "unknown-local");
    assert!(route.model.is_none());
    assert!(
        encoded(&route, &history(&image))
            .to_string()
            .contains(&image.data)
    );
}

#[test]
fn orphan_and_multiple_image_parts_are_user_messages() {
    let (_, image) = fixture_images();
    for (provider, model, key) in [
        ("anthropic", "claude-sonnet-5-5", "content"),
        ("groq", "qwen/qwen3.6-27b", "content"),
        ("openai", "gpt-4o", "content"),
        ("google", "gemini-2.5-flash", "parts"),
    ] {
        let route = route(provider, model);
        let items = [
            Item::Images(vec![image.clone(), image.clone()]),
            Item::Images(vec![image.clone()]),
        ];
        let body = encoded(&route, &items);
        assert_eq!(body.as_array().unwrap().len(), 1);
        assert_eq!(body[0]["role"], "user");
        assert_eq!(body[0][key].as_array().unwrap().len(), 3);
        let empty = encoded(&route, &[Item::Images(vec![])]);
        assert_eq!(empty, json!([]));
    }
}

#[test]
fn copilot_image_attachments_do_not_change_the_initiator() {
    let (_, image) = fixture_images();
    let route = route("github-copilot", "gpt-4o");
    let client = reqwest::Client::new();
    for (items, initiator) in [
        (
            vec![
                Item::User("Look.".into()),
                Item::Images(vec![image.clone()]),
            ],
            "user",
        ),
        (history(&image), "agent"),
        (
            vec![
                Item::Assistant {
                    text: "".into(),
                    calls: vec![],
                },
                Item::User("Continue.".into()),
                Item::Images(vec![image]),
            ],
            "agent",
        ),
    ] {
        let ex = exchange("gpt-4o", &items, &[]);
        let request = common_headers(client.post("http://127.0.0.1/"), &route, &ex)
            .build()
            .unwrap();
        assert_eq!(request.headers()["X-Initiator"], initiator);
    }
}

#[test]
fn images_are_serializable_and_the_trace_never_includes_bytes() {
    let (_, image) = fixture_images();
    assert_eq!(
        serde_json::from_str::<Image>(&serde_json::to_string(&image).unwrap()).unwrap(),
        image
    );
    let items = history(&image);
    let route = route("google", "gemini-2.5-flash");
    let trace = shape(
        &route,
        &exchange("gemini-2.5-flash", &items, &[]),
        &Reply::default(),
    );
    assert!(trace.contains("images1"));
    assert!(!trace.contains(&image.data));
}

fn generated_image(width: u32, height: u32) -> Image {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    let mut pixels = image::RgbImage::new(width, height);
    for (x, y, pixel) in pixels.enumerate_pixels_mut() {
        let value = x
            .wrapping_mul(17_839)
            .wrapping_add(y.wrapping_mul(961_748_941));
        *pixel = image::Rgb([value as u8, (value >> 8) as u8, (value >> 16) as u8]);
    }
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(pixels)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    Image {
        mime_type: "image/png".into(),
        data: STANDARD.encode(bytes.into_inner()),
    }
}

fn decoded_image(image: &Image) -> image::DynamicImage {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    image::load_from_memory(&STANDARD.decode(&image.data).unwrap()).unwrap()
}

#[test]
fn catalog_image_profile_bounds_dimensions_bytes_and_preserves_history() {
    let mut route = route("openai", "gpt-4o");
    let mut model = route.model.unwrap().clone();
    model.input_limits = serde_json::from_value(json!({
        "maxRequestBytes": 20000000,
        "images": { "resize": { "maxWidth": 128, "maxHeight": 64, "maxBytes": 2048, "jpegQuality": 75 }, "maxPerMessage": 8, "maxPerRequest": 100 },
    })).unwrap();
    // The production catalog has a static lifetime; this test entry does too.
    route.model = Some(Box::leak(Box::new(model)));
    let original = generated_image(800, 400);
    let history = vec![Item::Images(vec![original.clone()])];
    let prepared = super::images::prepare(&route, &history).unwrap();
    let Item::Images(images) = &prepared[0] else {
        panic!("images")
    };
    assert_eq!(images[0].mime_type, "image/jpeg");
    assert!(images[0].data.len() <= 2048);
    let decoded = decoded_image(&images[0]);
    assert!(decoded.width() <= 128 && decoded.height() <= 64);
    assert!((decoded.width() as f64 / decoded.height() as f64 - 2.0).abs() < 0.2);
    assert_eq!(history, [Item::Images(vec![original])]);
    assert!(matches!(
        super::images::prepare(&route, &prepared).unwrap(),
        std::borrow::Cow::Borrowed(_)
    ));
}

#[test]
fn default_image_bounds_are_conservative_and_never_upscale() {
    let original = generated_image(2100, 16);
    for (provider, model, edge) in [
        ("anthropic", "claude-sonnet-5-5", 1568),
        ("openai", "gpt-4o", 2000),
    ] {
        let route = route(provider, model);
        let items = [Item::Images(vec![original.clone()])];
        let prepared = super::images::prepare(&route, &items).unwrap();
        let Item::Images(images) = &prepared[0] else {
            panic!("images")
        };
        assert!(decoded_image(&images[0]).width() <= edge);
        let small = [Item::Images(vec![generated_image(10, 5)])];
        assert!(matches!(
            super::images::prepare(&route, &small).unwrap(),
            std::borrow::Cow::Borrowed(_)
        ));
    }
}

#[test]
fn impossible_image_limits_and_invalid_images_fail_before_network() {
    let mut route = route("openai", "gpt-4o");
    let bad = [Item::Images(vec![Image {
        mime_type: "image/png".into(),
        data: "not base64".into(),
    }])];
    assert!(super::images::prepare(&route, &bad).is_err());
    let mut model = route.model.unwrap().clone();
    model.input_limits =
        serde_json::from_value(json!({"images": {"resize": {"maxBytes": 1}}})).unwrap();
    route.model = Some(Box::leak(Box::new(model)));
    assert!(super::images::prepare(&route, &[Item::Images(vec![generated_image(1, 1)])]).is_err());
    let text_only = super::testing::route("openai", "gpt-4");
    assert!(super::images::prepare(&text_only, &bad).is_ok());
}

const WIRES: [Wire; 6] = [
    Wire::Anthropic,
    Wire::OpenAiChat,
    Wire::OpenAiResponses,
    Wire::Codex,
    Wire::Google,
    Wire::Vertex,
];

fn limited_route(wire: Wire, limits: Value) -> Route {
    let mut route = route("openai", "gpt-4o");
    route.wire = wire;
    let mut model = route.model.unwrap().clone();
    model.input_limits = serde_json::from_value(limits).unwrap();
    route.model = Some(Box::leak(Box::new(model)));
    route
}

fn retained(items: &[Item]) -> Vec<Image> {
    items
        .iter()
        .flat_map(|item| match item {
            Item::Images(images) => images.as_slice(),
            _ => &[],
        })
        .cloned()
        .collect()
}

/// Read the real RequestBuilder body, not another test-only byte estimate.
fn request_bytes(route: &Route, auth: Option<Auth>, ex: &Exchange) -> Vec<u8> {
    let endpoint = Endpoint {
        route: route.clone(),
        auth,
    };
    request(&reqwest::Client::new(), &endpoint, ex)
        .unwrap_or_else(|failure| panic!("{}", failure.message))
        .0
        .build()
        .unwrap()
        .body()
        .unwrap()
        .as_bytes()
        .unwrap()
        .to_vec()
}

fn test_auth() -> Auth {
    Auth::Bearer {
        token: "test-access".into(),
        account_id: Some("test-account".into()),
    }
}

#[test]
fn aggregate_counts_keep_newest_across_tool_reads_without_changing_history() {
    let images: Vec<Image> = (1..=9).map(|width| generated_image(width, 1)).collect();
    let mut items = vec![Item::User("Compare.".into())];
    // Adjacent image batches, reasoning and an omitted empty assistant all
    // belong to the same encoded user message.
    items.extend([
        Item::Images(images[0..2].to_vec()),
        Item::Reasoning(vec![]),
        Item::Images(images[2..3].to_vec()),
        Item::Assistant {
            text: String::new(),
            calls: vec![],
        },
        Item::Images(images[3..4].to_vec()),
    ]);
    for (i, batch) in [
        images[4..6].to_vec(),
        images[6..7].to_vec(),
        images[7..9].to_vec(),
    ]
    .into_iter()
    .enumerate()
    {
        items.extend([
            Item::Assistant {
                text: String::new(),
                calls: vec![ToolCall {
                    id: format!("c{i}"),
                    name: "read".into(),
                    arguments: json!({"path": "image.png"}),
                }],
            },
            Item::Results(vec![ToolResult {
                call_id: format!("c{i}"),
                content: "image.png".into(),
                is_error: false,
            }]),
            Item::Images(batch),
        ]);
    }
    let original = items.clone();
    for wire in WIRES {
        let route = limited_route(
            wire,
            json!({"images": {"maxPerMessage": 2, "maxPerRequest": 5}}),
        );
        let ex = exchange("gpt-4o", &items, &[]);
        let prepared = images::prepare_request(&route, None, &ex).unwrap();
        assert_eq!(retained(&prepared.items), images[4..], "{wire:?}");
        assert!(prepared.system.contains("Older images omitted"));
        assert_eq!(items, original);
        let encoded: Value = serde_json::from_slice(&request_bytes(
            &route,
            Some(test_auth()),
            &prepared.exchange(&ex),
        ))
        .unwrap();
        assert!(encoded.to_string().contains("Older images omitted"));
    }
}

#[test]
fn per_message_counts_follow_encoder_grouping_even_when_items_are_skipped() {
    let images: Vec<Image> = (1..=3).map(|width| generated_image(width, 1)).collect();
    let items = [
        Item::User("Compare.".into()),
        Item::Images(images[0..1].to_vec()),
        // Anthropic/Gemini emit a new user message; other wires emit no
        // tool output, so the following images merge with the earlier user.
        Item::Results(vec![]),
        Item::Images(images[1..].to_vec()),
    ];
    for wire in WIRES {
        let route = limited_route(wire, json!({"images": {"maxPerMessage": 2}}));
        let ex = exchange("gpt-4o", &items, &[]);
        let prepared = images::prepare_request(&route, None, &ex).unwrap();
        let expected = if matches!(wire, Wire::Anthropic | Wire::Google | Wire::Vertex) {
            &images[..]
        } else {
            &images[1..]
        };
        assert_eq!(retained(&prepared.items), expected, "{wire:?}");
    }
}

#[test]
fn aggregate_count_exact_boundary_and_zero_limits() {
    let image = generated_image(1, 1);
    let items = [
        Item::User("Look.".into()),
        Item::Images(vec![image.clone(), image]),
    ];
    for wire in WIRES {
        for limit in [0, 1, 2] {
            let route = limited_route(
                wire,
                json!({"images": {"maxPerMessage": limit, "maxPerRequest": limit}}),
            );
            let ex = exchange("gpt-4o", &items, &[]);
            let prepared = images::prepare_request(&route, None, &ex).unwrap();
            assert_eq!(retained(&prepared.items).len(), limit, "{wire:?}");
            if limit == 2 {
                assert!(matches!(prepared.items, std::borrow::Cow::Borrowed(_)));
                assert_eq!(prepared.system, ex.system);
            }
        }
    }
}

#[test]
fn encoded_byte_budget_is_exact_for_every_wire_and_keeps_newest() {
    let images: Vec<Image> = (1..=3)
        .map(|width| generated_image(width * 10, 4))
        .collect();
    let items = [
        Item::User("Quotes: \" \\ \n \0 and 日本語".into()),
        Item::Images(images[0..2].to_vec()),
        Item::Reasoning(vec![
            json!({"type": "thinking", "thinking": "replayed reasoning \"\n雪", "signature": "signed"}),
            json!({"type": "chat.reasoning", "field": "reasoning_content", "text": "replayed reasoning \"\n雪"}),
            json!({"type": "reasoning", "id": "r", "encrypted_content": "replayed reasoning \"\n雪", "summary": []}),
            json!({"type": "gemini.parts", "parts": [{"text": "replayed reasoning \"\n雪", "thought": true, "thoughtSignature": "signed"}]}),
        ]),
        Item::Assistant {
            text: "Reading.".into(),
            calls: vec![ToolCall {
                id: "c".into(),
                name: "read".into(),
                arguments: json!({"path": "雪.png"}),
            }],
        },
        Item::Results(vec![ToolResult {
            call_id: "c".into(),
            content: "tool output \"\n".into(),
            is_error: false,
        }]),
        Item::Images(images[2..].to_vec()),
    ];
    let original = items.clone();
    let tools = [tool()];
    for wire in WIRES {
        // Count eviction supplies the exact same harness note as byte eviction.
        let reference = limited_route(wire, json!({"images": {"maxPerRequest": 2}}));
        let ex = Exchange {
            system: "System \"\n雪",
            ..exchange("gpt-4o", &items, &tools)
        };
        let prepared = images::prepare_request(&reference, Some(&test_auth()), &ex).unwrap();
        let encoded = request_bytes(&reference, Some(test_auth()), &prepared.exchange(&ex));
        assert!(
            String::from_utf8_lossy(&encoded).contains("replayed reasoning"),
            "{wire:?}"
        );
        let boundary = encoded.len();
        for (max_bytes, expected) in [
            (boundary, images[1..].to_vec()),
            (boundary - 1, images[2..].to_vec()),
        ] {
            let route = limited_route(wire, json!({"maxRequestBytes": max_bytes}));
            let prepared = images::prepare_request(&route, Some(&test_auth()), &ex).unwrap();
            let bytes = request_bytes(&route, Some(test_auth()), &prepared.exchange(&ex));
            assert!(
                bytes.len() <= max_bytes,
                "{wire:?}: {} > {max_bytes}",
                bytes.len()
            );
            assert_eq!(retained(&prepared.items), expected, "{wire:?}");
        }
        // The untouched request fits at its exact byte boundary, without a note.
        let boundary = request_bytes(&reference, Some(test_auth()), &ex).len();
        let route = limited_route(wire, json!({"maxRequestBytes": boundary}));
        let prepared = images::prepare_request(&route, Some(&test_auth()), &ex).unwrap();
        assert_eq!(prepared.items.as_ref(), items);
        assert_eq!(prepared.system, ex.system);
        assert_eq!(items, original);
    }
}

#[test]
fn oversized_nonimage_content_is_refused_at_the_exact_encoded_boundary() {
    let items = [Item::User("Text with escaping \"\n\0 and 雪".into())];
    let tools = [tool()];
    for wire in WIRES {
        let reference = limited_route(wire, json!({}));
        let ex = exchange("gpt-4o", &items, &tools);
        let boundary = request_bytes(&reference, Some(test_auth()), &ex).len();
        let route = limited_route(wire, json!({"maxRequestBytes": boundary}));
        assert!(images::prepare_request(&route, Some(&test_auth()), &ex).is_ok());
        let route = limited_route(wire, json!({"maxRequestBytes": boundary - 1}));
        let error = images::prepare_request(&route, Some(&test_auth()), &ex)
            .err()
            .unwrap();
        assert!(error.contains("without images"), "{wire:?}: {error}");
        let with_image = [items[0].clone(), Item::Images(vec![generated_image(1, 1)])];
        let ex = exchange("gpt-4o", &with_image, &tools);
        assert!(images::prepare_request(&route, Some(&test_auth()), &ex).is_err());
    }
}

#[test]
fn absent_catalog_limits_have_conservative_aggregate_defaults() {
    let image = generated_image(1, 1);
    let mut items = Vec::new();
    for _ in 0..6 {
        items.extend([
            Item::User("Look.".into()),
            Item::Images(vec![image.clone(); 21]),
        ]);
    }
    for wire in WIRES {
        let mut route = limited_route(wire, json!({}));
        for unlisted in [false, true] {
            if unlisted {
                route.model = None;
            }
            let ex = exchange("unknown", &items, &[]);
            let prepared = images::prepare_request(&route, None, &ex).unwrap();
            assert_eq!(
                retained(&prepared.items).len(),
                100,
                "{wire:?}, unlisted={unlisted}"
            );
            let counts: Vec<usize> = prepared
                .items
                .iter()
                .filter_map(|item| match item {
                    Item::Images(images) => Some(images.len()),
                    _ => None,
                })
                .collect();
            assert_eq!(counts, [0, 20, 20, 20, 20, 20]);
            let text = [Item::User("x".repeat(20 * 1024 * 1024))];
            assert!(
                images::prepare_request(&route, None, &exchange("unknown", &text, &[])).is_err()
            );
        }
    }
}
