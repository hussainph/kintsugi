//! Subscriptions in and out as OPML 2.0, the format every feed reader speaks.
//! Kintsugi's own details (preset kind, muted) ride in extra outline
//! attributes, which OPML allows and other readers ignore.

use super::presets::{checked_url, kind_for_url};
use super::store::{Source, SourceKind};
use quick_xml::escape::escape;
use quick_xml::events::Event;
use quick_xml::reader::Reader;

#[derive(Clone, Debug, PartialEq)]
pub struct Outline {
    pub url: String,
    pub title: Option<String>,
    pub kind: SourceKind,
    pub muted: bool,
}

pub fn export(sources: &[Source], created: &str) -> String {
    let mut out = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<opml version=\"2.0\">\n  <head>\n    <title>Kintsugi subscriptions</title>\n");
    out.push_str(&format!("    <dateCreated>{}</dateCreated>\n  </head>\n  <body>\n", escape(created)));
    for source in sources {
        let title = source.title.as_deref().unwrap_or(&source.url);
        out.push_str(&format!(
            "    <outline type=\"rss\" text=\"{t}\" title=\"{t}\" xmlUrl=\"{u}\"",
            t = escape(title),
            u = escape(source.url.as_str())
        ));
        if let Some(site) = &source.site_url {
            out.push_str(&format!(" htmlUrl=\"{}\"", escape(site.as_str())));
        }
        out.push_str(&format!(" kintsugiKind=\"{}\"", source.kind.as_str()));
        if source.muted {
            out.push_str(" kintsugiMuted=\"true\"");
        }
        out.push_str("/>\n");
    }
    out.push_str("  </body>\n</opml>\n");
    out
}

/// Every outline with an `xmlUrl`, at any depth (folders are flattened).
/// Outlines with an unusable URL are counted, not fatal.
pub fn import(text: &str) -> Result<(Vec<Outline>, usize), String> {
    let mut reader = Reader::from_str(text);
    let mut found: Vec<Outline> = Vec::new();
    let mut invalid = 0;
    let mut saw_opml = false;
    loop {
        match reader.read_event().map_err(|e| format!("not valid OPML ({e})"))? {
            Event::Eof => break,
            Event::Start(e) | Event::Empty(e) => {
                let name = e.local_name();
                if name.as_ref() == "opml" {
                    saw_opml = true;
                }
                if name.as_ref() != "outline" {
                    continue;
                }
                let (mut url, mut title, mut text, mut kind, mut muted): (Option<String>, Option<String>, Option<String>, Option<SourceKind>, bool) = (None, None, None, None, false);
                for attribute in e.attributes().flatten() {
                    let value = attribute.normalized_value(quick_xml::XmlVersion::Implicit1_0).map(|v| v.trim().to_string()).unwrap_or_default();
                    match attribute.key.local_name().as_ref() {
                        "xmlUrl" => url = Some(value),
                        "title" => title = Some(value),
                        "text" => text = Some(value),
                        "kintsugiKind" => kind = SourceKind::parse(&value),
                        "kintsugiMuted" => muted = value == "true",
                        _ => {}
                    }
                }
                let Some(url) = url else { continue };
                match checked_url(&url) {
                    Ok(url) => {
                        let url = url.to_string();
                        if found.iter().any(|o| o.url == url) {
                            continue;
                        }
                        found.push(Outline {
                            kind: kind.unwrap_or_else(|| kind_for_url(&url)),
                            title: title.or(text).filter(|t| !t.is_empty() && *t != url),
                            url,
                            muted,
                        });
                    }
                    Err(_) => invalid += 1,
                }
            }
            _ => {}
        }
    }
    if !saw_opml {
        return Err("that file isn't OPML".into());
    }
    Ok((found, invalid))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(id: i64, url: &str, title: Option<&str>, kind: SourceKind, muted: bool) -> Source {
        Source {
            id,
            url: url.into(),
            kind,
            title: title.map(Into::into),
            site_url: Some("https://quiet.example/".into()),
            image: None,
            muted,
            added_at: 0,
            last_fetch_at: None,
            last_success_at: None,
            last_status: None,
            last_error: None,
            failures: 0,
            next_fetch_at: 0,
            items: 0,
        }
    }

    #[test]
    fn round_trip() {
        let sources = [
            source(1, "https://quiet.example/feed.xml", Some("Quiet & \"Loud\" <Blog>"), SourceKind::Feed, false),
            source(2, "https://hnrss.org/best?points=200&comments=10", None, SourceKind::Hn, true),
            source(3, "https://www.youtube.com/feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv", Some("Slow Craft"), SourceKind::Youtube, false),
        ];
        let text = export(&sources, "Sun, 01 Nov 2026 00:00:00 GMT");
        let (outlines, invalid) = import(&text).unwrap();
        assert_eq!(invalid, 0);
        assert_eq!(outlines.len(), 3);
        assert_eq!(outlines[0].title.as_deref(), Some("Quiet & \"Loud\" <Blog>"));
        assert_eq!(outlines[1].url, "https://hnrss.org/best?points=200&comments=10");
        assert_eq!(outlines[1].title, None, "a URL-only title isn't kept as a title");
        assert!(outlines[1].muted);
        assert_eq!(outlines[1].kind, SourceKind::Hn);
        assert_eq!(outlines[2].kind, SourceKind::Youtube);
    }

    #[test]
    fn other_readers_nested_folders() {
        let text = r#"<?xml version="1.0"?>
<opml version="1.0"><head><title>Feedly</title></head><body>
  <outline text="Tech" title="Tech">
    <outline type="rss" text="Hacker News" xmlUrl="https://hnrss.org/frontpage" htmlUrl="https://news.ycombinator.com"/>
    <outline type="rss" text="Bad" xmlUrl="javascript:alert(1)"/>
  </outline>
  <outline type="rss" text="Dupe" xmlUrl="https://hnrss.org/frontpage"/>
  <outline text="Blog" xmlUrl="quiet.example/feed.xml"/>
</body></opml>"#;
        let (outlines, invalid) = import(text).unwrap();
        assert_eq!(invalid, 1);
        assert_eq!(outlines.len(), 2);
        assert_eq!(outlines[0].kind, SourceKind::Hn);
        assert_eq!(outlines[0].title.as_deref(), Some("Hacker News"));
        assert_eq!(outlines[1].url, "https://quiet.example/feed.xml");
    }

    #[test]
    fn not_opml() {
        assert!(import("<rss><channel/></rss>").is_err());
        assert!(import("not xml <<<").is_err());
    }
}
