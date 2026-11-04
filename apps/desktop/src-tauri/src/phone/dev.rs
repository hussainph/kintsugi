//! The phone API served from the whole app on a scratch vault, for driving
//! the phone in the iOS Simulator with the Feed, Ideas and Kin, and the test
//! that the phone's routes reach the real commands. Headless builds only:
//! Kin answers with the scripted mock model (`KINTSUGI_HEADLESS_KIN=mock`),
//! so nothing reads a credential or leaves the machine.

use super::server::{router, tests::TOKEN};
use std::path::{Path, PathBuf};

/// Points the headless app at `vault` and a config folder beside it (both
/// under a `.headless` folder) with the mock Kin, and builds it.
fn app(vault: &Path, config: &Path) -> tauri::App<crate::Runtime> {
    for dir in [vault, config] {
        assert!(
            dir.components().any(|c| c.as_os_str() == ".headless"),
            "refusing {}: use a scratch folder under .headless",
            dir.display()
        );
        std::fs::create_dir_all(dir).unwrap();
    }
    // Single-threaded setup, before the app or any server thread exists.
    unsafe {
        std::env::set_var("KINTSUGI_VAULT", vault);
        std::env::set_var("KINTSUGI_CONFIG_DIR", config);
        std::env::set_var("KINTSUGI_HEADLESS_KIN", "mock");
        std::env::remove_var("KINTSUGI_HEADLESS_AI_READONLY");
        std::env::remove_var("KINTSUGI_HEADLESS_PI_READONLY");
        std::env::remove_var("KINTSUGI_HEADLESS_IDEAS_DAILY");
    }
    crate::headless::phone_app().unwrap()
}

/// The real phone API on a scratch vault, with the Feed (a seeded sample),
/// Ideas and Kin (the mock model) behind it:
///
/// KINTSUGI_PHONE_DEV_VAULT="$PWD/.headless/phone-vault" \
///   cargo test -p kintsugi --no-default-features --features headless \
///   phone_dev_server -- --ignored --nocapture
///
/// It listens on 127.0.0.1:47475 (KINTSUGI_PHONE_DEV_PORT), keeps app data
/// in `<vault>-config` (KINTSUGI_PHONE_DEV_CONFIG), and prints the pair link.
#[test]
#[ignore]
fn phone_dev_server() {
    let vault = std::env::var("KINTSUGI_PHONE_DEV_VAULT").expect("set KINTSUGI_PHONE_DEV_VAULT");
    let vault = std::fs::canonicalize(&vault).expect("the scratch vault must exist");
    let config = std::env::var_os("KINTSUGI_PHONE_DEV_CONFIG")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(format!("{}-config", vault.display())));
    let port: u16 = std::env::var("KINTSUGI_PHONE_DEV_PORT").map_or(47475, |p| p.parse().unwrap());
    let app = app(&vault, &config);
    let base = format!("http://127.0.0.1:{port}");
    let added = crate::feed::seed_sample(app.handle(), &base).unwrap();
    println!("feed: {added} sample items; Kin: mock");
    let host = super::host(app.handle()).unwrap();
    tauri::async_runtime::block_on(async move {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
            .await
            .unwrap();
        println!("kintsugi://pair?url=http%3A%2F%2F127.0.0.1%3A{port}&token={TOKEN}");
        axum::serve(listener, router(host, TOKEN)).await.unwrap();
    });
    drop(app);
}

/// Each phone route reaches the app's own command: the Feed's list, picks,
/// reading, like, a version-checked note and save into Inspiration; Ideas
/// made by the mock helper, adopted into a draft once even when retried, and
/// dismissed; Kin answering a message sent twice with one id. Runs in its own
/// process, since it sets the scratch environment.
#[test]
fn the_phone_reaches_the_real_feed_ideas_and_kin() {
    const NAME: &str = "phone::dev::the_phone_reaches_the_real_feed_ideas_and_kin";
    if std::env::var_os("KINTSUGI_PHONE_TEST_CHILD").is_none() {
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", NAME, "--nocapture", "--test-threads=1"])
            .env("KINTSUGI_PHONE_TEST_CHILD", "1")
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        return;
    }
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    std::fs::create_dir_all(workspace.join(".headless")).unwrap();
    let scratch = tempfile::tempdir_in(workspace.join(".headless")).unwrap();
    let vault = scratch.path().join("vault");
    let config = scratch.path().join("config");
    std::fs::create_dir_all(vault.join("drafts")).unwrap();
    std::fs::write(
        vault.join("drafts/on-repair.md"),
        "---\ntitle: On repair\n---\n\nRepair is a kind of attention. The seam is where the story is.\n\nA mended bowl is honest about its past.\n",
    )
    .unwrap();
    std::fs::write(
        vault.join("drafts/attention.md"),
        "---\ntitle: Attention\n---\n\nAttention has a cost, and repair is where we pay it.\n\nSlow reading is a kind of repair.\n",
    )
    .unwrap();
    let app = app(&vault, &config);
    crate::feed::seed_sample(app.handle(), "http://127.0.0.1:9").unwrap();
    let host = super::host(app.handle()).unwrap();
    assert!(host.sections.is_some());
    let handle = app.handle().clone();
    // Headless only opens folders inside its scratch vault.
    let other_vault = vault.join("other-vault");
    std::fs::create_dir_all(&other_vault).unwrap();
    tauri::async_runtime::block_on(async move {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, router(host, TOKEN)).await });
        let http = reqwest::Client::new();
        let get = |path: &str| {
            let request = http.get(format!("{base}{path}")).bearer_auth(TOKEN);
            async move {
                let response = request.send().await.unwrap();
                assert_eq!(response.status(), 200, "GET {}", response.url());
                response.json::<serde_json::Value>().await.unwrap()
            }
        };
        let send = |method: reqwest::Method, path: &str, body: serde_json::Value| {
            http.request(method, format!("{base}{path}"))
                .bearer_auth(TOKEN)
                .json(&body)
                .send()
        };
        let post = |path: &str, body: serde_json::Value| send(reqwest::Method::POST, path, body);

        // The Feed: newest first, and Picked for you from the same items.
        let page = get("/v1/feed").await;
        assert_eq!(page["total"], 7);
        let first = page["items"][0].clone();
        assert_eq!(
            first["title"],
            "Mending Workshop 2026 measures the cost of visible repair"
        );
        let id = first["id"].as_i64().unwrap();
        let picked = get("/v1/feed/picked").await;
        assert!(!picked["picks"].as_array().unwrap().is_empty());

        let place = serde_json::json!({ "surface": "newest", "position": 0 });
        let read: serde_json::Value = post(
            "/v1/feed/read",
            serde_json::json!({ "id": id, "place": place }),
        )
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
        assert!(read["text"].as_str().unwrap().contains("kintsugi"));
        let liked: serde_json::Value = post(
            "/v1/feed/act",
            serde_json::json!({ "id": id, "action": "like", "place": place }),
        )
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
        assert_eq!(liked["liked"], true);
        let effect = get(&format!("/v1/feed/effect?id={id}")).await;
        assert!(effect["changes"].is_array());

        // A note, version-checked: a stale base is a conflict, not a write.
        let empty = kintsugi_vault::version("");
        let note = |text: &str, base: &str| {
            send(
                reqwest::Method::PUT,
                "/v1/feed/note",
                serde_json::json!({ "id": id, "note": text, "base": base, "place": place }),
            )
        };
        let saved = note("Seams as a method", &empty).await.unwrap();
        assert_eq!(saved.status(), 200);
        let saved: serde_json::Value = saved.json().await.unwrap();
        assert_eq!(
            saved["version"],
            kintsugi_vault::version("Seams as a method")
        );
        let stale = note("An offline note", &empty).await.unwrap();
        assert_eq!(stale.status(), 409);
        let stale: serde_json::Value = stale.json().await.unwrap();
        assert_eq!(stale["current"]["text"], "Seams as a method");

        // Save: into Inspiration with the note, once even if sent twice.
        for _ in 0..2 {
            let saved: serde_json::Value = post(
                "/v1/feed/save",
                serde_json::json!({ "id": id, "place": place }),
            )
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
            assert_eq!(
                saved["savedPath"],
                "inspiration/mending-workshop-2026-measures-the-cost-of-visible-repair.md"
            );
        }
        let clip = std::fs::read_to_string(
            vault.join("inspiration/mending-workshop-2026-measures-the-cost-of-visible-repair.md"),
        )
        .unwrap();
        assert!(clip.contains("Seams as a method"));
        assert_eq!(
            std::fs::read_dir(vault.join("inspiration"))
                .unwrap()
                .filter(|e| e
                    .as_ref()
                    .unwrap()
                    .path()
                    .extension()
                    .is_some_and(|x| x == "md"))
                .count(),
            1
        );

        let other = page["items"][1]["id"].as_i64().unwrap();
        let hidden = post(
            "/v1/feed/act",
            serde_json::json!({ "id": other, "action": "notInterested" }),
        )
        .await
        .unwrap();
        assert_eq!(hidden.status(), 200);
        assert_eq!(get("/v1/feed").await["total"], 6);
        let impressions = post("/v1/feed/impressions", serde_json::json!({ "impressions": [{ "id": id, "position": 0, "surface": "picked" }] })).await.unwrap();
        assert_eq!(impressions.status(), 200);
        let unknown = post(
            "/v1/feed/act",
            serde_json::json!({ "id": 99_999, "action": "like" }),
        )
        .await
        .unwrap();
        assert_eq!(unknown.status(), 400);

        // Ideas: "Ask for more" runs the mock helper on the Mac.
        let asked: serde_json::Value = post("/v1/ideas/more", serde_json::json!({}))
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(asked["job"].is_object(), "{asked}");
        let mut view = serde_json::Value::Null;
        for _ in 0..240 {
            view = get("/v1/ideas").await;
            if view["job"]["status"] == "done" || view["job"]["status"] == "failed" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
        assert_eq!(view["job"]["status"], "done", "{view}");
        let ideas = view["ideas"].as_array().unwrap().clone();
        assert!(!ideas.is_empty(), "{view}");
        let idea = ideas[0]["id"].as_str().unwrap().to_string();
        let adopt = || post("/v1/ideas/adopt", serde_json::json!({ "id": idea }));
        let adopted: serde_json::Value = adopt().await.unwrap().json().await.unwrap();
        let path = adopted["path"].as_str().unwrap().to_string();
        assert!(path.starts_with("drafts/"), "{path}");
        let draft = std::fs::read_to_string(vault.join(&path)).unwrap();
        assert!(draft.contains(&format!("id: {idea}")));
        let again: serde_json::Value = adopt().await.unwrap().json().await.unwrap();
        assert_eq!(
            again["path"],
            path.as_str(),
            "a retried Adopt made a second draft"
        );
        if let Some(second) = ideas.get(1) {
            let id = second["id"].as_str().unwrap();
            let dismissed: serde_json::Value =
                post("/v1/ideas/dismiss", serde_json::json!({ "id": id }))
                    .await
                    .unwrap()
                    .json()
                    .await
                    .unwrap();
            let listed = dismissed["ideas"]
                .as_array()
                .unwrap()
                .iter()
                .find(|i| i["id"] == id)
                .unwrap()
                .clone();
            assert!(listed["dismissed"].is_object());
        }

        // Kin: one message, sent twice with the same id, lands once and is answered.
        let message = serde_json::json!({
            "id": "11111111-2222-4333-8444-555555555555",
            "text": "What does this say about repair?",
            "chips": [{ "kind": "feed", "path": id.to_string(), "label": "Mending Workshop 2026 measures the cost of visible repair" }]
        });
        let sent: serde_json::Value = post("/v1/kin", message.clone())
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(sent["duplicate"], false);
        let seq = sent["entry"]["seq"].as_u64().unwrap();
        let again: serde_json::Value = post("/v1/kin", message)
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(again, serde_json::json!({ "seq": seq, "duplicate": true }));
        let mut log = serde_json::Value::Null;
        for _ in 0..240 {
            log = get("/v1/kin").await;
            let answered = log["entries"].as_array().unwrap().iter().any(|e| {
                e["role"] == "kin"
                    && e["answers"]
                        .as_array()
                        .is_some_and(|a| a.contains(&seq.into()))
            });
            if answered && log["running"].is_null() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
        let owners = log["entries"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["role"] == "owner" && e["text"] == "What does this say about repair?")
            .count();
        assert_eq!(owners, 1, "{log}");
        assert!(
            log["entries"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["role"] == "kin"
                    && e["answers"]
                        .as_array()
                        .is_some_and(|a| a.contains(&seq.into()))),
            "{log}"
        );
        let jobs = get("/v1/kin/jobs").await;
        assert!(
            jobs.as_array()
                .unwrap()
                .iter()
                .any(|j| j["kind"] == "ideas")
        );
        let bad_chip = post("/v1/kin", serde_json::json!({ "id": "22222222-2222-4333-8444-555555555555", "text": "hi", "chips": [{ "kind": "paragraph", "path": "x.md" }] })).await.unwrap();
        assert_eq!(bad_chip.status(), 400);

        // The conversation is the open vault's, kept in it (KI-59): another
        // vault shows its own (empty) log, and switching back shows this one.
        assert!(vault.join(".kintsugi/kin/log.jsonl").is_file());
        let open = |path: &Path| {
            crate::vault::vault_open(handle.clone(), path.to_string_lossy().into()).unwrap();
        };
        open(&other_vault);
        let there = get("/v1/kin").await;
        assert_eq!(there["entries"], serde_json::json!([]), "{there}");
        open(&vault);
        let back = get("/v1/kin").await;
        assert!(
            back["entries"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["text"] == "What does this say about repair?"),
            "{back}"
        );
    });
    drop(app);
}
