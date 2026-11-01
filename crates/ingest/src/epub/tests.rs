//! EPUBs from a small fixture (`fixtures/epub/repair.epub`, made by
//! `fixtures/epub/make.py`) and archives built in the test.

use super::*;
use crate::test_http::{Server, run};
use std::io::Write;

const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/epub/repair.epub");

#[test]
fn a_book_becomes_metadata_a_cover_and_its_chapters_as_markdown() {
    let adapter = EpubAdapter::new().unwrap();
    let target = Target::File(FIXTURE.into());
    assert!(adapter.matches(&target));
    assert!(!adapter.matches(&Target::File("/tmp/a.pdf".into())));
    let item = run(adapter.capture(&target, CaptureOptions { want_media: true })).unwrap();
    assert_eq!(item.source, SourceType::Epub);
    assert_eq!(item.id, "epub:isbn:9780306406157");
    assert_eq!(item.title.as_deref(), Some("The Golden Seam"));
    assert_eq!(item.author.as_deref(), Some("Ada Example, Ben Sample"));
    assert_eq!(item.site.as_deref(), Some("Lacquer Press"));
    assert_eq!(item.published.as_deref(), Some("2023-03-01"));
    assert_eq!(item.description.as_deref(), Some("A short book about repair and patience."));
    assert_eq!(item.primary_image().unwrap().mime, "image/png");
    assert_eq!(item.extras["lang"], "en");
    assert_eq!(item.extras["chapters"], 5);
    assert_eq!(item.extras["extractor"], "epub");
    // Cover, contents and copyright pages are skipped; links into the book
    // become text, outside links stay, images and scripts go.
    assert!(item.body.starts_with("# One: The crack"), "{}", item.body);
    assert!(item.body.contains("See the mend or [a guide](https://example.org/kintsugi)."), "{}", item.body);
    assert!(item.body.contains("Gold follows the line."));
    assert!(item.body.contains("# Two: The mend\n\nLacquer, then gold, then waiting."));
    for absent in ["Copyright", "alert", "cover.png", "chapter2.xhtml", "Contents"] {
        assert!(!item.body.contains(absent), "{absent} in {}", item.body);
    }

    let plain = run(adapter.capture(&target, CaptureOptions::default())).unwrap();
    assert!(plain.media.is_empty());
}

fn epub(files: &[(&str, &[u8])]) -> tempfile::NamedTempFile {
    let file = tempfile::Builder::new().suffix(".epub").tempfile().unwrap();
    let mut zip = zip::ZipWriter::new(file.reopen().unwrap());
    for (name, bytes) in files {
        zip.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap();
    file
}

const CONTAINER: &[u8] = br#"<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>"#;

#[test]
fn hostile_archives_are_refused() {
    let adapter = EpubAdapter::new().unwrap();
    let capture = |file: &tempfile::NamedTempFile| run(adapter.capture(&Target::File(file.path().into()), CaptureOptions::default()));

    let not_zip = tempfile::Builder::new().suffix(".epub").tempfile().unwrap();
    std::fs::write(not_zip.path(), "plain text").unwrap();
    assert_eq!(capture(&not_zip), Err(Error::Unsupported));

    // A DTD could expand entities; it is refused outright.
    let dtd = epub(&[
        ("META-INF/container.xml", CONTAINER),
        ("book.opf", br#"<!DOCTYPE p [<!ENTITY a "aaaa">]><package><metadata><title>&a;</title></metadata></package>"#),
    ]);
    assert_eq!(capture(&dtd), Err(Error::Unavailable));

    // A chapter that inflates past its cap is skipped; with no title and no
    // readable chapter there's nothing to keep.
    let huge = vec![b'a'; (MAX_CHAPTER_BYTES + 10) as usize];
    let bomb = epub(&[
        ("META-INF/container.xml", CONTAINER),
        (
            "book.opf",
            br#"<package><manifest><item id="c" href="../../c.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>"#,
        ),
        ("c.xhtml", &huge),
    ]);
    assert_eq!(capture(&bomb), Err(Error::Unavailable));
}

#[test]
fn hrefs_resolve_inside_the_archive() {
    assert_eq!(resolve("OEBPS", "text/chapter%201.xhtml#x"), "OEBPS/text/chapter 1.xhtml");
    assert_eq!(resolve("OEBPS/text", "../images/a.png"), "OEBPS/images/a.png");
    assert_eq!(resolve("", "../../../etc/passwd"), "etc/passwd");
    assert_eq!(percent_decode("a%2"), "a%2");
}

#[test]
fn links_to_epubs_are_downloaded() {
    let server = Server::start(vec![("/books/repair.epub", 200, "application/epub+zip", std::fs::read(FIXTURE).unwrap())]);
    let adapter = EpubAdapter::new().unwrap();
    let target = Target::url(&server.url("/books/repair.epub")).unwrap();
    assert!(adapter.matches(&target));
    let item = run(adapter.capture(&target, CaptureOptions::default())).unwrap();
    assert_eq!(item.url.as_deref(), Some(server.url("/books/repair.epub").as_str()));
    assert_eq!(item.title.as_deref(), Some("The Golden Seam"));
}
