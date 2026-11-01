//! The JavaScript fallback: render a page in a hidden local webview and run
//! the vendored Defuddle there.
//!
//! The crate owns the contract (which scripts run, what comes back, how it
//! is bounded); the desktop app owns the webview. A renderer must:
//!
//! - load only [`allowed_navigation`] URLs, deny new windows and downloads,
//!   use a non-persistent (incognito) data store, and have no IPC access;
//! - inject [`QUIET_SCRIPT`] at document start (no sound, prompts or popups);
//! - once loaded, wait for the page to settle ([`SETTLE_SCRIPT`] returns the
//!   visible text length) and evaluate [`defuddle_script`];
//! - pass the evaluation result to [`Rendered::parse`] and destroy the webview.
//!
//! Nothing leaves the Mac except the page's own requests: Defuddle is bundled
//! and runs with `useAsync: false`. The result is as untrusted as the page.

use super::allowed_url;
use crate::{BoxFuture, FULL_CHARS, Result, markdown};
use reqwest::Url;
use serde::Deserialize;
use std::time::Duration;

const DEFUDDLE: &str = include_str!("../../vendor/defuddle/defuddle.full.js");

/// The largest evaluation result accepted, in bytes.
pub const MAX_RESULT_BYTES: usize = 4 * 1024 * 1024;

pub trait Renderer: Send + Sync {
    /// Renders `url` and returns what Defuddle found, within `timeout`.
    fn render<'a>(&'a self, url: &'a Url, timeout: Duration) -> BoxFuture<'a, Result<Rendered>>;
}

/// Defuddle's answer, as returned by [`defuddle_script`].
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct Rendered {
    pub title: Option<String>,
    pub author: Option<String>,
    pub site: Option<String>,
    pub description: Option<String>,
    pub published: Option<String>,
    pub image: Option<String>,
    pub language: Option<String>,
    /// The readable content as Markdown.
    pub content: Option<String>,
}

impl Rendered {
    /// Parses a webview evaluation result. Webviews hand back the script's
    /// value JSON-encoded, so the JSON string the script returns arrives
    /// encoded twice; both forms are accepted. Anything oversized, malformed
    /// or empty is `None`.
    pub fn parse(raw: &str) -> Option<Self> {
        if raw.len() > MAX_RESULT_BYTES {
            return None;
        }
        let value: serde_json::Value = serde_json::from_str(raw).ok()?;
        let value = match value {
            serde_json::Value::String(inner) => serde_json::from_str(&inner).ok()?,
            other => other,
        };
        serde_json::from_value::<Rendered>(value).ok()
    }

    /// Bounds every field like static extraction does.
    pub fn bounded(self) -> Self {
        let field = |s: Option<String>, n| s.and_then(|s| markdown::field(&s, n));
        Self {
            title: field(self.title, 500),
            author: field(self.author, 500),
            site: field(self.site, 500),
            description: field(self.description, 2000),
            published: field(self.published, 100),
            image: field(self.image, 2000),
            language: field(self.language, 40),
            content: self.content.map(|c| markdown::body(&c, FULL_CHARS)).filter(|c| !c.is_empty()),
        }
    }
}

/// Main-frame navigation policy for the hidden webview: the web URL policy,
/// minus anything on `localhost`, so a page can never navigate the webview to
/// an app-local origin (Tauri treats `*.localhost` as local).
pub fn allowed_navigation(url: &Url) -> bool {
    allowed_url(url)
        && url.host_str().is_some_and(|h| {
            let h = h.trim_end_matches('.').to_ascii_lowercase();
            h != "localhost" && !h.ends_with(".localhost")
        })
}

/// Injected at document start: a hidden page must not play sound, open
/// windows, print, show prompts or ask for devices.
pub const QUIET_SCRIPT: &str = r#"(function () {
  try {
    var no = function () { return Promise.reject(new Error("unavailable")); };
    var silence = function (m) { try { m.muted = true; m.pause(); } catch (e) {} };
    HTMLMediaElement.prototype.play = function () { silence(this); return no(); };
    document.addEventListener("play", function (e) { silence(e.target); }, true);
    window.open = function () { return null; };
    window.alert = function () {};
    window.confirm = function () { return false; };
    window.prompt = function () { return null; };
    window.print = function () {};
    if (navigator.mediaDevices) { navigator.mediaDevices.getUserMedia = no; navigator.mediaDevices.getDisplayMedia = no; }
    if (navigator.geolocation) { navigator.geolocation.getCurrentPosition = function (_, err) { if (err) err({ code: 1 }); }; navigator.geolocation.watchPosition = function () { return 0; }; }
    if (window.Notification) { window.Notification.requestPermission = function () { return Promise.resolve("denied"); }; }
  } catch (e) {}
})();"#;

/// Evaluates to the page's visible text length; renderers poll it until it
/// stops changing.
pub const SETTLE_SCRIPT: &str =
    "(function () { try { return document.body ? document.body.innerText.length : 0; } catch (e) { return 0; } })()";

/// The Defuddle bundle plus a wrapper that evaluates to a JSON string of
/// [`Rendered`] (or `null`). The bundle's UMD header sees local `module` and
/// `exports`, so it never touches the page's own module loader or globals.
pub fn defuddle_script() -> String {
    let mut script = String::with_capacity(DEFUDDLE.len() + 1024);
    script.push_str("(function () {\n  try {\n    var module = { exports: {} }; var exports = module.exports; var define = undefined;\n");
    script.push_str(DEFUDDLE);
    script.push_str(&format!(
        r#"
;
    var Defuddle = module.exports && (module.exports["default"] || module.exports);
    var r = new Defuddle(document, {{ url: location.href, markdown: true, useAsync: false }}).parse();
    var s = function (v, n) {{ return typeof v === "string" && v ? v.slice(0, n) : null; }};
    return JSON.stringify({{
      title: s(r.title, 2000), author: s(r.author, 2000), site: s(r.site, 2000),
      description: s(r.description, 4000), published: s(r.published, 200),
      image: s(r.image, 4000), language: s(r.language, 100), content: s(r.content, {content})
    }});
  }} catch (e) {{ return null; }}
}})()"#,
        // Markdown is longer than its text; leave room before the body cap.
        content = FULL_CHARS * 2
    ));
    script
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn webview_results_parse_once_or_twice_encoded() {
        let inner = r#"{"title":"Rendered","content":"\n\nHello **world**\n\n\n","author":null}"#;
        let twice = serde_json::to_string(inner).unwrap();
        for raw in [inner, twice.as_str()] {
            let rendered = Rendered::parse(raw).unwrap().bounded();
            assert_eq!(rendered.title.as_deref(), Some("Rendered"));
            assert_eq!(rendered.content.as_deref(), Some("Hello **world**"));
            assert_eq!(rendered.author, None);
        }
        assert_eq!(Rendered::parse("null"), None);
        assert_eq!(Rendered::parse("not json"), None);
        assert_eq!(Rendered::parse(&"x".repeat(MAX_RESULT_BYTES + 1)), None);
    }

    #[test]
    fn the_webview_never_navigates_to_app_or_local_origins() {
        for ok in ["https://example.org/", "http://example.org/a?b"] {
            assert!(allowed_navigation(&Url::parse(ok).unwrap()), "{ok}");
        }
        for bad in [
            "tauri://localhost/",
            "http://tauri.localhost/",
            "https://LOCALHOST./",
            "ipc://localhost/x",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,hi",
            "https://user:pass@example.org/",
        ] {
            assert!(!allowed_navigation(&Url::parse(bad).unwrap()), "{bad}");
        }
    }

    #[test]
    fn the_script_wraps_the_vendored_bundle_without_globals() {
        let script = defuddle_script();
        assert!(script.starts_with("(function () {"));
        assert!(script.ends_with("})()"));
        assert!(script.contains("useAsync: false"));
        assert!(script.contains("var module = { exports: {} }"));
        assert!(script.len() > DEFUDDLE.len());
    }
}
