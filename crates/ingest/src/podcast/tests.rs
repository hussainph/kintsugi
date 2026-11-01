//! A saved feed and transcripts on a loopback server, and a fake
//! transcriber; nothing touches the internet or a real speech model.

use super::*;
use crate::test_http::{Server, run};
use crate::transcript::Segment;
use std::path::Path;
use std::sync::Mutex;

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/podcast").join(name)).unwrap()
}

fn server() -> Server {
    Server::start(vec![
        ("/feed.xml", 200, "application/rss+xml", fixture("feed.xml")),
        ("/t/12.json", 200, "application/json", fixture("12.json")),
        ("/t/12.vtt", 200, "text/vtt", fixture("12.vtt")),
        ("/t/11.srt", 200, "application/x-subrip", fixture("11.srt")),
        ("/audio/10.mp3", 200, "audio/mpeg", b"ID3 fake audio".to_vec()),
    ])
}

/// Audio bytes, file name and language hint of one call.
type Call = (Vec<u8>, String, Option<String>);

/// Records what it was asked to transcribe.
#[derive(Default)]
struct FakeTranscriber {
    calls: Mutex<Vec<Call>>,
    result: Option<Result<Vec<Segment>>>,
}

impl Transcriber for FakeTranscriber {
    fn name(&self) -> &'static str {
        "fake"
    }
    fn transcribe<'a>(
        &'a self,
        audio: &'a std::path::Path,
        language: Option<&'a str>,
    ) -> BoxFuture<'a, Result<Vec<transcript::Segment>>> {
        Box::pin(async move {
            let name = audio.file_name().unwrap().to_string_lossy().into_owned();
            self.calls.lock().unwrap().push((std::fs::read(audio).unwrap(), name, language.map(String::from)));
            self.result.clone().unwrap_or_else(|| {
                Ok(vec![
                    Segment { start: 0.0, end: 2.0, text: "Ten begins.".into(), speaker: None },
                    Segment { start: 3700.0, end: 3702.0, text: "An hour later.".into(), speaker: None },
                ])
            })
        })
    }
}

#[test]
fn feeds_yield_episodes_with_their_transcript_links() {
    let feed = Url::parse("http://127.0.0.1:1/shows/feed.xml").unwrap();
    let list = episodes(&String::from_utf8(fixture("feed.xml")).unwrap(), &feed);
    assert_eq!(list.len(), 3);
    let twelve = &list[0];
    assert_eq!(twelve.title.as_deref(), Some("Episode 12: Mending & gold"));
    assert_eq!(twelve.guid.as_deref(), Some("repair-12"));
    assert_eq!(twelve.show.as_deref(), Some("Repair Hour"));
    assert_eq!(twelve.author.as_deref(), Some("Mara Fix"));
    assert_eq!(twelve.language.as_deref(), Some("en-us"));
    assert_eq!(twelve.duration, Some(3723));
    assert_eq!(twelve.audio_url.as_ref().unwrap().as_str(), "http://127.0.0.1:1/audio/12.mp3");
    assert_eq!(twelve.image.as_ref().unwrap().as_str(), "https://pod.example/cover.jpg");
    assert!(twelve.notes.as_deref().unwrap().contains("<b>broken</b>"));
    assert_eq!(twelve.transcripts.len(), 4);
    assert_eq!(twelve.transcripts[1].rel.as_deref(), Some("captions"));
    assert_eq!(list[1].duration, Some(754));
    assert_eq!(list[2].image.as_ref().unwrap().as_str(), "http://127.0.0.1:1/art/10.png");
    assert!(episodes("<rss><channel>", &feed).is_empty());
    assert!(episodes("<!DOCTYPE x [<!ENTITY a 'b'>]><rss><channel/></rss>", &feed).is_empty(), "no DTDs");
}

#[test]
fn a_publisher_json_transcript_in_the_episodes_language_wins() {
    let server = server();
    let transcriber = Arc::new(FakeTranscriber::default());
    let adapter = PodcastAdapter::new().unwrap().with_transcriber(transcriber.clone());
    let feed = Url::parse(&server.url("/feed.xml")).unwrap();
    let item = run(adapter.capture_from_feed(&feed, Some("repair-12"), CaptureOptions::default())).unwrap();

    assert_eq!(item.source, SourceType::Podcast);
    assert_eq!(item.id, format!("podcast:{feed}#repair-12"));
    assert_eq!(item.url.as_deref(), Some("https://pod.example/12"));
    assert_eq!(item.title.as_deref(), Some("Episode 12: Mending & gold"));
    assert_eq!(item.site.as_deref(), Some("Repair Hour"));
    assert_eq!(item.author.as_deref(), Some("Mara Fix"));
    assert_eq!(item.description.as_deref(), Some("Why broken things are interesting."));
    assert_eq!(item.published.as_deref(), Some("Thu, 29 Oct 2026 06:00:00 GMT"));
    assert_eq!(item.extras["transcript"], "publisher");
    assert_eq!(item.extras["transcriptType"], "application/json");
    assert_eq!(item.extras["duration"], 3723);
    assert_eq!(item.media[0].url.as_deref(), Some("https://pod.example/cover.jpg"));
    let audio = server.url("/audio/12.mp3");
    assert_eq!(
        item.body,
        format!("[0:00](<{audio}#t=0>) **Mara:** Welcome to Repair Hour.\n\n[1:05](<{audio}#t=65>) **Ken:** Gold makes the crack visible.")
    );
    assert_eq!(server.hits("/t/12.es.json"), 0, "another language is a last resort");
    assert_eq!(server.hits("/t/12.vtt"), 0);
    assert!(transcriber.calls.lock().unwrap().is_empty(), "never transcribes when the publisher has a transcript");
}

#[test]
fn subrip_captions_link_to_the_audio_with_its_own_query() {
    let server = server();
    let adapter = PodcastAdapter::new().unwrap();
    let feed = Url::parse(&server.url("/feed.xml")).unwrap();
    let item = run(adapter.capture_from_feed(&feed, Some("repair-11"), CaptureOptions::default())).unwrap();
    assert_eq!(item.extras["transcriptType"], "application/x-subrip");
    assert_eq!(item.url.as_deref(), Some("https://cdn.pod.example/11.m4a?token=x"));
    assert_eq!(
        item.body,
        "[0:05](<https://cdn.pod.example/11.m4a?token=x#t=5>) Captions only.\n\n[12:34](<https://cdn.pod.example/11.m4a?token=x#t=754>) Later on."
    );
}

#[test]
fn without_a_publisher_transcript_the_audio_is_transcribed_on_device() {
    let server = server();
    let transcriber = Arc::new(FakeTranscriber::default());
    let adapter = PodcastAdapter::new().unwrap().with_transcriber(transcriber.clone());
    let feed = Url::parse(&server.url("/feed.xml")).unwrap();
    let item = run(adapter.capture_from_feed(&feed, Some("repair-10"), CaptureOptions::default())).unwrap();
    assert_eq!(item.extras["transcript"], "on-device");
    assert_eq!(item.extras["transcriber"], "fake");
    let audio = server.url("/audio/10.mp3");
    assert_eq!(item.body, format!("[0:00](<{audio}#t=0>) Ten begins.\n\n[1:01:40](<{audio}#t=3700>) An hour later."));
    let calls = transcriber.calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, b"ID3 fake audio");
    assert_eq!(calls[0].1, "episode.mp3");
    assert_eq!(calls[0].2.as_deref(), Some("en-us"));
}

#[test]
fn without_any_transcript_the_show_notes_remain() {
    let server = server();
    let feed = Url::parse(&server.url("/feed.xml")).unwrap();
    let item = run(PodcastAdapter::new().unwrap().capture_from_feed(&feed, Some("repair-10"), CaptureOptions::default())).unwrap();
    assert_eq!(item.extras["transcript"], "unavailable");
    assert_eq!(item.extras["transcriptReason"], "no-transcriber");
    assert_eq!(item.body, "Show notes for ten.");
    assert_eq!(server.hits("/audio/10.mp3"), 0, "no transcriber, no audio download");

    let missing_model = Arc::new(FakeTranscriber { result: Some(Err(Error::ToolNeeded)), ..Default::default() });
    let adapter = PodcastAdapter::new().unwrap().with_transcriber(missing_model);
    let item = run(adapter.capture_from_feed(&feed, Some("repair-10"), CaptureOptions::default())).unwrap();
    assert_eq!(item.extras["transcriptReason"], "model-not-installed");
    assert_eq!(run(adapter.capture_from_feed(&feed, Some("nope"), CaptureOptions::default())), Err(Error::Unavailable));
}

#[test]
fn oversized_audio_is_not_transcribed() {
    let server = server();
    let transcriber = Arc::new(FakeTranscriber::default());
    let adapter = PodcastAdapter::new()
        .unwrap()
        .with_transcriber(transcriber.clone())
        .with_limits(Limits { audio_bytes: 4, ..Limits::default() });
    let feed = Url::parse(&server.url("/feed.xml")).unwrap();
    let item = run(adapter.capture_from_feed(&feed, Some("repair-10"), CaptureOptions::default())).unwrap();
    assert_eq!(item.extras["transcriptReason"], "transcription-failed");
    assert!(transcriber.calls.lock().unwrap().is_empty());
}

#[test]
fn pasted_audio_links_are_episodes() {
    let server = server();
    let transcriber = Arc::new(FakeTranscriber::default());
    let adapter = PodcastAdapter::new().unwrap().with_transcriber(transcriber.clone());
    let engine = crate::Engine::new().with(adapter);
    let target = Target::url(&server.url("/audio/10.mp3")).unwrap();
    assert!(engine.adapter_for(&target).is_some());
    assert!(engine.adapter_for(&Target::url("https://pod.example/12").unwrap()).is_none());
    assert!(engine.adapter_for(&Target::url("https://pod.example/a.mp3.html").unwrap()).is_none());
    let item = run(engine.capture(&target, CaptureOptions::default())).unwrap();
    assert_eq!(item.id, format!("podcast:{}", server.url("/audio/10.mp3")));
    assert_eq!(item.title.as_deref(), Some("10"));
    assert_eq!(item.extras["transcript"], "on-device");
}

#[test]
fn tracking_redirects_are_unwrapped() {
    let clean = |raw: &str| untrack(&Url::parse(raw).unwrap()).to_string();
    let target = "https://www.buzzsprout.com/231452/episodes/20042854-idea.mp3";
    // The Buzzcast clip from KI-21: OP3 in front of Podtrac in front of the file.
    assert_eq!(
        clean("https://op3.dev/e/https://dts.podtrac.com/redirect.mp3/www.buzzsprout.com/231452/episodes/20042854-idea.mp3"),
        target
    );
    assert_eq!(clean("https://op3.dev/e,pg=abc/www.buzzsprout.com/231452/episodes/20042854-idea.mp3"), target);
    assert_eq!(clean("https://www.podtrac.com/pts/redirect.mp3/www.buzzsprout.com/231452/episodes/20042854-idea.mp3"), target);
    assert_eq!(
        clean("https://chrt.fm/track/ABC123/pdst.fm/e/prfx.byspotify.com/e/traffic.megaphone.fm/XYZ.mp3?updated=1"),
        "https://traffic.megaphone.fm/XYZ.mp3?updated=1"
    );
    assert_eq!(clean("https://mgln.ai/e/123/claritaspod.com/measure/media.example.com/a.m4a"), "https://media.example.com/a.m4a");
    // Not a tracker, or nothing usable behind one: left alone.
    for raw in ["https://media.example.com/a.mp3", "https://op3.dev/e/", "https://op3.dev/about", "https://chrt.fm/track/ABC/localhost/a.mp3"] {
        assert_eq!(clean(raw), raw, "{raw}");
    }
    assert!(is_tracked(&Url::parse("https://dts.podtrac.com/redirect.mp3/a.example/b.mp3").unwrap()));
    assert!(!is_tracked(&Url::parse(target).unwrap()));
}

#[test]
fn a_tracked_enclosure_is_written_without_its_redirects() {
    // Show notes only, so nothing is downloaded through the tracker.
    let episode = Episode {
        title: Some("Idea".into()),
        audio_url: Some(Url::parse("https://op3.dev/e/dts.podtrac.com/redirect.mp3/media.example.com/idea.mp3").unwrap()),
        notes: Some("Notes.".into()),
        ..Episode::default()
    };
    let item = run(PodcastAdapter::new().unwrap().capture_episode(&episode, CaptureOptions::default())).unwrap();
    assert_eq!(item.url.as_deref(), Some("https://media.example.com/idea.mp3"));
    assert_eq!(item.id, "podcast:https://media.example.com/idea.mp3");
    assert_eq!(item.extras["audioUrl"], "https://media.example.com/idea.mp3");
    // An episode page wins over the audio file.
    let with_page = Episode { link: Some(Url::parse("https://show.example/episodes/idea?utm_source=rss").unwrap()), ..episode };
    let item = run(PodcastAdapter::new().unwrap().capture_episode(&with_page, CaptureOptions::default())).unwrap();
    assert_eq!(item.url.as_deref(), Some("https://show.example/episodes/idea"));
}
