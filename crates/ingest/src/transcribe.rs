//! On-device speech-to-text for podcast episodes without a publisher
//! transcript.
//!
//! [`Transcriber`] is the seam: the podcast adapter hands it an audio file
//! and gets timed [`Segment`]s back. The engine shipped is Apple's
//! SpeechAnalyzer (macOS 26+), run through the small Swift helper in
//! `crates/ingest/swift/transcribe.swift` as a child process. See
//! `docs/ingest.md` › "Choosing a transcription engine" for why it beat
//! whisper.cpp and Parakeet.

use crate::transcript::Segment;
use crate::{BoxFuture, Error, Result};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;

pub trait Transcriber: Send + Sync {
    /// Recorded in the item's `extras.transcriber`.
    fn name(&self) -> &'static str;
    /// Transcribes one audio file. `language` is a BCP 47 hint from the feed
    /// (`en`, `en-GB`).
    fn transcribe<'a>(&'a self, audio: &'a Path, language: Option<&'a str>) -> BoxFuture<'a, Result<Vec<Segment>>>;
}

/// Apple's SpeechAnalyzer through the `kintsugi-transcribe` helper.
///
/// The speech model is a system asset: macOS downloads it once per locale
/// and keeps it updated, shared with other apps. The helper only asks for
/// that download when `allow_asset_download` is set, which the app sets once
/// the person agreed (the `apple-speech` entry in the tools catalog). Until
/// then a missing model fails with [`Error::ToolNeeded`].
pub struct SpeechAnalyzerTranscriber {
    program: PathBuf,
    allow_asset_download: bool,
    consent: Option<std::sync::Arc<crate::tools::Tools>>,
    timeout: Duration,
}

impl SpeechAnalyzerTranscriber {
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self { program: program.into(), allow_asset_download: false, consent: None, timeout: Duration::from_secs(60 * 60) }
    }

    /// Reads consent for the speech model from the tools manager on every
    /// run (the `apple-speech` catalog entry), so agreeing in Settings
    /// takes effect without a restart.
    pub fn with_consent(mut self, tools: std::sync::Arc<crate::tools::Tools>) -> Self {
        self.consent = Some(tools);
        self
    }

    pub fn allow_asset_download(mut self, allow: bool) -> Self {
        self.allow_asset_download = allow;
        self
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    async fn run(&self, audio: &Path, language: Option<&str>) -> Result<Vec<Segment>> {
        let mut command = tokio::process::Command::new(&self.program);
        command.arg(audio).arg("--locale").arg(locale(language));
        let consented = self.consent.as_ref().is_some_and(|t| t.consented(&crate::tools::catalog::APPLE_SPEECH));
        if self.allow_asset_download || consented {
            command.arg("--install-assets");
        }
        command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
        let mut child = command.spawn().map_err(|_| Error::Unavailable)?;
        let mut stdout = child.stdout.take().ok_or(Error::Unavailable)?;
        let work = async {
            let mut out = Vec::new();
            // A transcript of many hours is a few MB; refuse anything absurd.
            (&mut stdout).take(64 * 1024 * 1024).read_to_end(&mut out).await.map_err(|_| Error::Unavailable)?;
            let status = child.wait().await.map_err(|_| Error::Unavailable)?;
            Ok::<_, Error>((status, out))
        };
        let (status, out) = tokio::time::timeout(self.timeout, work).await.map_err(|_| Error::TimedOut)??;
        match status.code() {
            Some(0) => {}
            Some(3) => return Err(Error::Unsupported),
            Some(4) => return Err(Error::ToolNeeded),
            _ => return Err(Error::Unavailable),
        }
        #[derive(Deserialize)]
        struct Output {
            segments: Vec<Segment>,
        }
        let output: Output = serde_json::from_slice(&out).map_err(|_| Error::Unavailable)?;
        Ok(output
            .segments
            .into_iter()
            .filter(|s| s.start.is_finite() && s.end.is_finite() && !s.text.trim().is_empty())
            .collect())
    }
}

impl Transcriber for SpeechAnalyzerTranscriber {
    fn name(&self) -> &'static str {
        "apple-speech"
    }

    fn transcribe<'a>(&'a self, audio: &'a Path, language: Option<&'a str>) -> BoxFuture<'a, Result<Vec<Segment>>> {
        Box::pin(self.run(audio, language))
    }
}

/// A feed's `en`, `en-us` or `EN_GB` as a locale identifier; English when
/// the feed says nothing usable.
fn locale(language: Option<&str>) -> String {
    let raw = language.unwrap_or("").trim();
    if raw.len() > 20 || !raw.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return "en-US".into();
    }
    let cleaned = raw.replace('_', "-");
    let mut parts = cleaned.split('-').filter(|p| !p.is_empty());
    match (parts.next(), parts.next()) {
        (Some(lang), Some(region)) if (2..=3).contains(&lang.len()) && region.len() == 2 => {
            format!("{}-{}", lang.to_ascii_lowercase(), region.to_ascii_uppercase())
        }
        (Some(lang), _) if (2..=3).contains(&lang.len()) => {
            let lang = lang.to_ascii_lowercase();
            if lang == "en" { "en-US".into() } else { lang }
        }
        _ => "en-US".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_http::run;

    fn helper(dir: &Path, script: &str) -> PathBuf {
        let path = dir.join("kintsugi-transcribe");
        std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        path
    }

    #[test]
    fn the_helper_protocol() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("args");
        let ok = helper(
            dir.path(),
            &format!(
                "printf '%s\\n' \"$@\" > '{}'\necho '{{\"locale\":\"en_GB\",\"segments\":[{{\"start\":0,\"end\":1.5,\"text\":\"Hello.\"}},{{\"start\":2,\"end\":3,\"text\":\" \"}}]}}'",
                log.display()
            ),
        );
        let transcriber = SpeechAnalyzerTranscriber::new(&ok);
        let segments = run(transcriber.transcribe(Path::new("/tmp/a.mp3"), Some("en-gb"))).unwrap();
        assert_eq!(segments, vec![Segment { start: 0.0, end: 1.5, text: "Hello.".into(), speaker: None }]);
        assert_eq!(std::fs::read_to_string(&log).unwrap(), "/tmp/a.mp3\n--locale\nen-GB\n");
        run(SpeechAnalyzerTranscriber::new(&ok).allow_asset_download(true).transcribe(Path::new("/a.m4a"), None)).unwrap();
        assert_eq!(std::fs::read_to_string(&log).unwrap(), "/a.m4a\n--locale\nen-US\n--install-assets\n");
        let tools = std::sync::Arc::new(crate::tools::Tools::new(dir.path().join("tools")).unwrap());
        let consenting = SpeechAnalyzerTranscriber::new(&ok).with_consent(tools.clone());
        run(consenting.transcribe(Path::new("/b.m4a"), None)).unwrap();
        assert!(!std::fs::read_to_string(&log).unwrap().contains("--install-assets"));
        tools.grant(&crate::tools::catalog::APPLE_SPEECH).unwrap();
        run(consenting.transcribe(Path::new("/b.m4a"), None)).unwrap();
        assert!(std::fs::read_to_string(&log).unwrap().contains("--install-assets"));
    }

    #[test]
    fn exit_codes_become_fixed_errors() {
        let dir = tempfile::tempdir().unwrap();
        for (code, error) in [(3, Error::Unsupported), (4, Error::ToolNeeded), (5, Error::Unavailable)] {
            let path = helper(dir.path(), &format!("echo 'secret transcript' >&2\nexit {code}"));
            let result = run(SpeechAnalyzerTranscriber::new(&path).transcribe(Path::new("/a.mp3"), None));
            assert_eq!(result, Err(error));
        }
        let slow = helper(dir.path(), "sleep 5");
        let result = run(
            SpeechAnalyzerTranscriber::new(&slow).with_timeout(Duration::from_millis(100)).transcribe(Path::new("/a"), None),
        );
        assert_eq!(result, Err(Error::TimedOut));
        let missing = SpeechAnalyzerTranscriber::new(dir.path().join("missing"));
        assert_eq!(run(missing.transcribe(Path::new("/a"), None)), Err(Error::Unavailable));
    }

    #[test]
    fn feed_languages_become_locales() {
        assert_eq!(locale(Some("en")), "en-US");
        assert_eq!(locale(Some("EN_gb")), "en-GB");
        assert_eq!(locale(Some("de")), "de");
        assert_eq!(locale(Some("fr-CA")), "fr-CA");
        assert_eq!(locale(Some("--; rm -rf")), "en-US");
        assert_eq!(locale(None), "en-US");
    }

    /// Opt-in, macOS 26+: compiles the real helper and transcribes speech
    /// made with `say`. It never downloads a speech model; without one it
    /// stops at "not installed".
    /// `cargo test -p kintsugi-ingest -- --ignored live_speech_analyzer`
    #[test]
    #[ignore]
    fn live_speech_analyzer() {
        let dir = tempfile::tempdir().unwrap();
        let helper = dir.path().join("kintsugi-transcribe");
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("swift/transcribe.swift");
        let built = std::process::Command::new("xcrun")
            .args(["swiftc", "-O", "-parse-as-library"])
            .arg(&source)
            .arg("-o")
            .arg(&helper)
            .status()
            .unwrap();
        assert!(built.success());
        let audio = dir.path().join("speech.aiff");
        let said = std::process::Command::new("say")
            .arg("-o")
            .arg(&audio)
            .arg("Every crack becomes part of the story.")
            .status()
            .unwrap();
        assert!(said.success());
        match run(SpeechAnalyzerTranscriber::new(&helper).transcribe(&audio, Some("en"))) {
            Ok(segments) => {
                let text: String = segments.iter().map(|s| s.text.as_str()).collect();
                assert!(text.to_lowercase().contains("story"), "{text}");
            }
            Err(Error::ToolNeeded) => eprintln!("the en-US speech model is not installed; skipped"),
            Err(error) => panic!("{error}"),
        }
    }
}
