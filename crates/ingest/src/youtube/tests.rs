//! yt-dlp is replaced by a shell script that copies saved fixtures, so no
//! test touches YouTube or downloads the real tool.

use super::*;
use crate::test_http::{Server, run};
use crate::tools::{ToolState, catalog};
use sha2::{Digest, Sha256};

fn fixtures(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/youtube").join(name)
}

/// A fake yt-dlp: logs its arguments, then copies fixtures into `--paths`.
fn fake_yt_dlp(fixture: &str, log: &Path) -> Vec<u8> {
    fake_yt_dlp_from(&fixtures(fixture), log)
}

fn fake_yt_dlp_from(dir: &Path, log: &Path) -> Vec<u8> {
    format!(
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\nout=''\nwhile [ $# -gt 0 ]; do case \"$1\" in --paths) out=\"$2\"; shift;; esac; shift; done\ncp '{}'/* \"$out\"/\n",
        log.display(),
        dir.display()
    )
    .into_bytes()
}

const FAILING: &[u8] = b"#!/bin/sh\necho 'ERROR: Sign in to confirm you are not a bot' >&2\nexit 1\n";

fn setup() -> (tempfile::TempDir, Arc<Tools>) {
    let dir = tempfile::tempdir().unwrap();
    let tools = Arc::new(Tools::new(dir.path().join("tools")).unwrap().with_github_api("http://127.0.0.1:9"));
    (dir, tools)
}

fn capture(adapter: &YouTubeAdapter, url: &str) -> Result<Item> {
    run(adapter.capture(&Target::url(url).unwrap(), CaptureOptions::default()))
}

#[test]
fn video_urls_are_recognized_and_everything_else_is_left_to_the_web() {
    for url in [
        "https://www.youtube.com/watch?v=kintsugi123&list=PL1&t=10s",
        "https://youtube.com/watch?feature=share&v=kintsugi123",
        "https://m.youtube.com/watch?v=kintsugi123",
        "https://music.youtube.com/watch?v=kintsugi123",
        "https://youtu.be/kintsugi123?si=abc",
        "https://www.youtube.com/shorts/kintsugi123",
        "https://www.youtube.com/live/kintsugi123",
        "https://www.youtube-nocookie.com/embed/kintsugi123",
    ] {
        assert_eq!(video_id(&Url::parse(url).unwrap()).as_deref(), Some("kintsugi123"), "{url}");
    }
    for url in [
        "https://www.youtube.com/@craft",
        "https://www.youtube.com/playlist?list=PL1",
        "https://www.youtube.com/watch?v=short",
        "https://www.youtube.com/watch?v=kintsugi123%27",
        "https://notyoutube.com/watch?v=kintsugi123",
        "https://youtube.com.evil.example/watch?v=kintsugi123",
        "ftp://youtu.be/kintsugi123",
    ] {
        assert_eq!(video_id(&Url::parse(url).unwrap()), None, "{url}");
    }
}

#[test]
fn captions_become_a_timestamped_transcript_with_chapters() {
    let (dir, tools) = setup();
    let log = dir.path().join("args.txt");
    tools.install_local(&catalog::YT_DLP, "2026.10.26", &fake_yt_dlp("captioned", &log));
    let adapter = YouTubeAdapter::new(tools.clone()).unwrap();
    let item = capture(&adapter, "https://youtu.be/kintsugi123?si=tracking").unwrap();

    assert_eq!(item.source, SourceType::Youtube);
    assert_eq!(item.id, "youtube:kintsugi123");
    assert_eq!(item.url.as_deref(), Some("https://www.youtube.com/watch?v=kintsugi123"));
    assert_eq!(item.title.as_deref(), Some("Mending broken pottery with gold"));
    assert_eq!(item.author.as_deref(), Some("Craft Channel"));
    assert_eq!(item.site.as_deref(), Some("YouTube"));
    assert_eq!(item.published.as_deref(), Some("2026-10-15"));
    assert_eq!(item.media[0].url.as_deref(), Some("https://i.ytimg.com/vi/kintsugi123/maxresdefault.jpg"));
    assert_eq!(item.extras["extractor"], "yt-dlp");
    assert_eq!(item.extras["transcript"], "auto-captions");
    assert_eq!(item.extras["lang"], "en");
    assert_eq!(item.extras["duration"], 95);
    assert_eq!(item.extras["toolVersion"], "2026.10.26");
    let watch = "https://www.youtube.com/watch?v=kintsugi123";
    assert_eq!(
        item.body,
        format!(
            "## Intro\n\n[0:00](<{watch}&t=0s>) welcome back to the workshop today we mend a bowl\n\n\
             ## The lacquer\n\n[0:41](<{watch}&t=41s>) urushi lacquer takes weeks and gold & patience"
        )
    );
    assert!(!item.body.contains("bienvenue"), "the English original beats a translation");

    let args = std::fs::read_to_string(&log).unwrap();
    for expected in ["--skip-download", "--write-auto-subs", "--write-subs", "--ignore-config", "--no-playlist"] {
        assert!(args.lines().any(|l| l == expected), "{expected} in {args}");
    }
    assert!(args.contains("--sub-langs\nen,en-[A-Z]{2},.*-orig\n"));
    assert!(args.ends_with("--\nhttps://www.youtube.com/watch?v=kintsugi123\n"), "{args}");
    assert!(!args.contains("--js-runtimes"), "no Deno installed");
}

#[test]
fn an_installed_deno_is_passed_to_yt_dlp() {
    let (dir, tools) = setup();
    let log = dir.path().join("args.txt");
    tools.install_local(&catalog::YT_DLP, "2026.10.26", &fake_yt_dlp("captioned", &log));
    tools.install_local(&catalog::DENO, "v2.9.8", b"#!/bin/sh\n");
    let adapter = YouTubeAdapter::new(tools.clone()).unwrap();
    capture(&adapter, "https://www.youtube.com/watch?v=kintsugi123").unwrap();
    let args = std::fs::read_to_string(&log).unwrap();
    let deno = tools.path(&catalog::DENO).unwrap();
    assert!(args.contains(&format!("--js-runtimes\ndeno:{}\n", deno.display())), "{args}");
}

#[test]
fn a_video_without_captions_keeps_its_description() {
    let (dir, tools) = setup();
    tools.install_local(&catalog::YT_DLP, "1", &fake_yt_dlp("uncaptioned", &dir.path().join("log")));
    let adapter = YouTubeAdapter::new(tools).unwrap();
    let item = capture(&adapter, "https://www.youtube.com/watch?v=kintsugi123").unwrap();
    assert_eq!(item.title.as_deref(), Some("A silent film"));
    assert_eq!(item.author.as_deref(), Some("Archive"));
    assert_eq!(item.extras["transcript"], "unavailable");
    assert_eq!(item.extras["transcriptReason"], "no-captions");
    assert_eq!(item.body, r"No words, only \<music\>.");
    assert!(item.media.is_empty());
}

struct Metadata;

impl Adapter for Metadata {
    fn source(&self) -> SourceType {
        SourceType::Web
    }
    fn matches(&self, _: &Target) -> bool {
        true
    }
    fn capture<'a>(&'a self, target: &'a Target, _: CaptureOptions) -> BoxFuture<'a, Result<Item>> {
        Box::pin(async move {
            let Target::Url(url) = target else { unreachable!() };
            Ok(Item {
                source: SourceType::Web,
                id: format!("web:{url}"),
                url: Some(url.to_string()),
                title: Some("From oEmbed".into()),
                author: None,
                site: Some("YouTube".into()),
                description: None,
                published: None,
                captured: crate::now(),
                media: vec![],
                body: String::new(),
                extras: BTreeMap::new(),
            })
        })
    }
}

#[test]
fn without_consent_nothing_is_downloaded_and_the_fallback_or_an_error_answers() {
    let server = Server::start(vec![]);
    let dir = tempfile::tempdir().unwrap();
    let tools = Arc::new(Tools::new(dir.path().join("tools")).unwrap().with_github_api(&server.base));
    let adapter = YouTubeAdapter::new(tools.clone()).unwrap();
    assert_eq!(capture(&adapter, "https://youtu.be/kintsugi123"), Err(Error::ToolNeeded));
    assert_eq!(Error::ToolNeeded.to_string(), "this source needs an optional tool that is not installed");

    let adapter = YouTubeAdapter::new(tools.clone()).unwrap().with_fallback(Arc::new(Metadata));
    let item = capture(&adapter, "https://youtu.be/kintsugi123").unwrap();
    assert_eq!(item.title.as_deref(), Some("From oEmbed"));
    assert_eq!(item.url.as_deref(), Some("https://www.youtube.com/watch?v=kintsugi123"));
    assert_eq!(item.extras["transcriptReason"], "tool-not-installed");
    assert_eq!(server.hits("/repos/yt-dlp/yt-dlp/releases/latest"), 0);
}

#[test]
fn a_failing_yt_dlp_is_updated_and_retried_once() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("args.txt");
    let fixed = fake_yt_dlp("captioned", &log);
    let asset = catalog::YT_DLP.asset().expect("a yt-dlp build for this platform");
    let sums = format!("{}  {asset}\n", hex::encode(Sha256::digest(&fixed)));
    let leak = |s: String| -> &'static str { Box::leak(s.into_boxed_str()) };
    let server = Server::start(vec![
        (
            "/repos/yt-dlp/yt-dlp/releases/latest",
            200,
            "application/json",
            format!(
                r#"{{"tag_name":"2026.11.01","assets":[{{"name":"{asset}","browser_download_url":"{{base}}/dl/{asset}"}},{{"name":"SHA2-256SUMS","browser_download_url":"{{base}}/dl/SHA2-256SUMS"}}]}}"#
            )
            .into_bytes(),
        ),
        (leak(format!("/dl/{asset}")), 200, "application/octet-stream", fixed),
        ("/dl/SHA2-256SUMS", 200, "text/plain", sums.into_bytes()),
    ]);
    let tools = Arc::new(Tools::new(dir.path().join("tools")).unwrap().with_github_api(&server.base));
    tools.grant(&catalog::YT_DLP).unwrap();
    tools.install_local(&catalog::YT_DLP, "2026.01.01", FAILING);
    // Checked two hours ago: too recent for the daily check, old enough
    // for the after-failure one.
    let mut state: ToolState = tools.state(&catalog::YT_DLP);
    state.checked_at = Some((chrono::Utc::now() - chrono::Duration::hours(2)).to_rfc3339());
    std::fs::write(tools.root().join("yt-dlp/tool.json"), serde_json::to_vec(&state).unwrap()).unwrap();

    let adapter = YouTubeAdapter::new(tools.clone()).unwrap();
    let item = capture(&adapter, "https://www.youtube.com/watch?v=kintsugi123").unwrap();
    assert_eq!(item.extras["transcript"], "auto-captions");
    assert_eq!(tools.status(&catalog::YT_DLP).installed.unwrap().version, "2026.11.01");
    assert_eq!(server.hits("/repos/yt-dlp/yt-dlp/releases/latest"), 1);

    // A failure right after a check does not hammer GitHub.
    tools.install_local(&catalog::YT_DLP, "2026.11.01", FAILING);
    assert_eq!(capture(&adapter, "https://www.youtube.com/watch?v=kintsugi123"), Err(Error::Unavailable));
    assert_eq!(server.hits("/repos/yt-dlp/yt-dlp/releases/latest"), 1);
}

#[test]
fn tracks_yt_dlp_could_not_download_are_fetched_from_its_info_json() {
    let server = Server::start(vec![
        ("/timedtext?lang=en", 200, "text/vtt", b"WEBVTT\n\n00:00:01.200 --> 00:00:03.360\nAll right, so here we are\n".to_vec()),
        ("/timedtext?lang=de", 200, "text/vtt", b"WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nAlso\n".to_vec()),
    ]);
    let dir = tempfile::tempdir().unwrap();
    let listed = dir.path().join("listed");
    std::fs::create_dir(&listed).unwrap();
    let track = |lang: &str| serde_json::json!([{ "ext": "json3", "url": "https://www.youtube.com/x" }, { "ext": "vtt", "url": format!("{}/timedtext?lang={lang}", server.base) }]);
    let info = serde_json::json!({
        "title": "Me at the zoo",
        "language": "en",
        "subtitles": { "en": track("en"), "de": track("de") },
        "automatic_captions": { "fr": track("fr") }
    });
    std::fs::write(listed.join("kintsugi123.info.json"), info.to_string()).unwrap();
    let tools = Arc::new(Tools::new(dir.path().join("tools")).unwrap());
    tools.install_local(&catalog::YT_DLP, "1", &fake_yt_dlp_from(&listed, &dir.path().join("log")));
    let item = capture(&YouTubeAdapter::new(tools).unwrap(), "https://youtu.be/kintsugi123").unwrap();
    assert_eq!(item.extras["transcript"], "subtitles");
    assert_eq!(item.body, "[0:01](<https://www.youtube.com/watch?v=kintsugi123&t=1s>) All right, so here we are");
    assert_eq!(server.hits("/timedtext?lang=de"), 0);
    assert_eq!(server.hits("/timedtext?lang=fr"), 0);

    let elsewhere: Info = serde_json::from_value(serde_json::json!({
        "subtitles": { "en": [{ "ext": "vtt", "url": "https://evil.example/timedtext" }, ] }
    }))
    .unwrap();
    assert!(remote_tracks(&elsewhere).is_empty(), "only YouTube's caption host is fetched");
}

#[test]
fn manual_subtitles_in_the_videos_language_win() {
    let dir = tempfile::tempdir().unwrap();
    let cue = |text: &str| format!("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n{text}\n");
    for (lang, text) in [("de", "manuell"), ("de-orig", "automatisch"), ("en", "translated"), ("live_chat", "chat")] {
        std::fs::write(dir.path().join(format!("abcdefghijk.{lang}.vtt")), cue(text)).unwrap();
    }
    let info: Info = serde_json::from_value(serde_json::json!({
        "language": "de",
        "subtitles": { "de": [], "live_chat": [] },
        "automatic_captions": { "de-orig": [], "en": [] }
    }))
    .unwrap();
    let captions = pick_captions(&info, "abcdefghijk", dir.path()).unwrap();
    assert_eq!((captions.lang.as_str(), captions.manual), ("de", true));
    std::fs::remove_file(dir.path().join("abcdefghijk.de.vtt")).unwrap();
    let captions = pick_captions(&info, "abcdefghijk", dir.path()).unwrap();
    assert_eq!((captions.lang.as_str(), captions.manual), ("de-orig", false));
}

/// Opt-in: downloads the real yt-dlp (and Deno) into a temporary folder and
/// fetches a real video's captions. `cargo test -p kintsugi-ingest -- --ignored live_youtube`
#[test]
#[ignore]
fn live_youtube_transcript() {
    // Kept in target/ so reruns reuse the downloads.
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/live-tools");
    let tools = Arc::new(Tools::new(root).unwrap());
    tools.grant(&catalog::YT_DLP).unwrap();
    tools.grant(&catalog::DENO).unwrap();
    run(tools.ensure(&catalog::DENO)).unwrap();
    let adapter = YouTubeAdapter::new(tools).unwrap();
    // "Me at the zoo", the first YouTube video.
    let item = capture(&adapter, "https://www.youtube.com/watch?v=jNQXAC9IVRw").unwrap();
    println!("{}\n{:#?}", item.body, item.extras);
    assert!(item.body.contains("elephants"), "{}", item.body);
}
