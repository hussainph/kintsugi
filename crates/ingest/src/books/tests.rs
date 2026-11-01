//! Open Library from saved responses (`fixtures/books/`, trimmed from real
//! ones) on a loopback server.

use super::*;
use crate::test_server::{route, run, serve, serve_with};

fn adapter(base: &str) -> BookAdapter {
    let base = Url::parse(base).unwrap();
    BookAdapter::with_endpoints(base.clone(), base, ApiLimits { min_interval: Duration::ZERO, ..ApiLimits::default() })
        .unwrap()
}

const EDITION: &str = include_str!("../../fixtures/books/edition.json");
const WORK: &str = include_str!("../../fixtures/books/work.json");
const AUTHOR: &str = include_str!("../../fixtures/books/author.json");

fn cover() -> Vec<u8> {
    let mut jpeg = b"\xff\xd8\xff\xe0".to_vec();
    jpeg.resize(4096, 0);
    jpeg
}

#[test]
fn isbns_are_validated() {
    assert_eq!(normalize_isbn("978-0-14-032872-1").as_deref(), Some("9780140328721"));
    assert_eq!(normalize_isbn("ISBN: 0 14 032872 6").as_deref(), Some("0140328726"));
    assert_eq!(normalize_isbn("080442957x").as_deref(), Some("080442957X"));
    assert_eq!(normalize_isbn("9780140328722"), None);
    assert_eq!(normalize_isbn("Fantastic Mr Fox"), None);
    assert_eq!(normalize_isbn("X804429570"), None);
}

#[test]
fn open_library_pages_are_recognized() {
    let book = BookAdapter::new().unwrap();
    for (url, page) in [
        ("https://openlibrary.org/works/OL45804W/Fantastic_Mr_Fox", Some(BookPage::Work("OL45804W".into()))),
        ("https://www.openlibrary.org/books/OL7353617M.json", Some(BookPage::Edition("OL7353617M".into()))),
        ("https://openlibrary.org/isbn/978-0140328721", Some(BookPage::Isbn("9780140328721".into()))),
        ("https://openlibrary.org/isbn/123", None),
        ("https://openlibrary.org/authors/OL34184A", None),
        ("https://example.org/works/OL45804W", None),
    ] {
        let parsed = Url::parse(url).unwrap();
        assert_eq!(book_page(&parsed), page, "{url}");
        assert_eq!(book.matches(&Target::Url(parsed)), page.is_some());
    }
}

#[test]
fn an_isbn_becomes_the_book_with_its_work_author_and_cover() {
    let server = serve_with(|base| {
        vec![
            route("/isbn/9780140328721.json", 302, "").header(&format!("Location: {base}books/OL7353617M.json")),
            route("/books/OL7353617M.json", 200, EDITION),
            route("/works/OL45804W.json", 200, WORK),
            route("/authors/OL34184A.json", 200, AUTHOR),
            route("/b/id/8739161-L.jpg", 200, cover()),
        ]
    });
    let book = adapter(&server.base);
    let target = Target::url("https://openlibrary.org/isbn/9780140328721").unwrap();
    let item = run(book.capture(&target, CaptureOptions { want_media: true })).unwrap();
    server.finish();
    assert_eq!(item.source, SourceType::Book);
    assert_eq!(item.id, "book:OL45804W");
    assert_eq!(item.url.as_deref(), Some("https://openlibrary.org/works/OL45804W"));
    assert_eq!(item.title.as_deref(), Some("Fantastic Mr Fox"));
    assert_eq!(item.author.as_deref(), Some("Roald Dahl"));
    assert_eq!(item.site.as_deref(), Some("Open Library"));
    assert_eq!(item.published.as_deref(), Some("1970"));
    assert!(item.description.as_deref().unwrap().starts_with("The main character"));
    assert_eq!(item.media[0].url.as_deref(), Some("https://covers.openlibrary.org/b/id/8739161-L.jpg"));
    assert_eq!(item.primary_image().unwrap().mime, "image/jpeg");
    assert_eq!(item.extras["isbn"], "9780140328721");
    assert_eq!(item.extras["pages"], 96);
    assert_eq!(item.extras["edition"], "OL7353617M");
    assert_eq!(
        item.body,
        "The main character of Fantastic Mr. Fox is an extremely clever anthropomorphized fox named Mr. Fox.\n\n\
         \\# He outwits \\<the farmers>.\n\n\
         - **By:** Roald Dahl\n- **First published:** 1970\n- **Publisher:** Puffin\n- **Pages:** 96\n\
         - **ISBN:** 9780140328721\n- **Subjects:** Animals, Foxes, Farmers"
    );
}

#[test]
fn a_work_page_needs_no_edition_and_skips_the_cover_unless_asked() {
    let server = serve(vec![route("/works/OL45804W.json", 200, WORK), route("/authors/OL34184A.json", 200, AUTHOR)]);
    let book = adapter(&server.base);
    let item = run(book.capture(&Target::url("https://openlibrary.org/works/OL45804W").unwrap(), CaptureOptions::default()))
        .unwrap();
    server.finish();
    assert_eq!(item.id, "book:OL45804W");
    assert!(item.primary_image().is_none());
    assert_eq!(item.media[0].url.as_deref(), Some("https://covers.openlibrary.org/b/id/6498519-L.jpg"));
    assert!(!item.extras.contains_key("isbn"));
}

#[test]
fn unknown_isbns_fail_without_echoing_anything() {
    let server = serve(vec![route("/isbn/9780140328721.json", 404, "{\"error\": \"notfound\"}")]);
    let book = adapter(&server.base);
    let error = run(book.capture(&Target::url("https://openlibrary.org/isbn/9780140328721").unwrap(), CaptureOptions::default()));
    server.finish();
    assert_eq!(error, Err(Error::Unavailable));
}

#[test]
fn search_by_title_or_isbn() {
    let results = include_str!("../../fixtures/books/search.json");
    let server = serve(vec![
        route("/search.json?q=fantastic+mr+fox&fields=", 200, results),
        route("/search.json?isbn=9780140328721&fields=", 200, results),
    ]);
    let book = adapter(&server.base);
    let hits = run(book.search("  fantastic  mr fox ", 10)).unwrap();
    assert_eq!(hits.len(), 2);
    assert_eq!(
        hits[0],
        BookHit {
            key: "/works/OL45804W".into(),
            url: "https://openlibrary.org/works/OL45804W".into(),
            title: "Fantastic Mr Fox".into(),
            authors: vec!["Roald Dahl".into()],
            year: Some(1970),
            isbn: Some("9780140328721".into()),
            cover_url: Some("https://covers.openlibrary.org/b/id/6498519-M.jpg".into()),
            editions: Some(112),
        }
    );
    assert_eq!(hits[1].cover_url, None);
    let by_isbn = run(book.search("978-0-14-032872-1", 10)).unwrap();
    assert_eq!(by_isbn[1].isbn.as_deref(), Some("9780140328721"));
    assert_eq!(serde_json::to_value(&hits[0]).unwrap()["coverUrl"], "https://covers.openlibrary.org/b/id/6498519-M.jpg");
    server.finish();
    assert!(run(book.search("   ", 10)).unwrap().is_empty());
}

#[test]
#[ignore = "touches the network"]
fn live_book_by_isbn_and_search() {
    let book = BookAdapter::new().unwrap();
    let item = run(book.capture(&Target::url("https://openlibrary.org/isbn/9780140328721").unwrap(), CaptureOptions { want_media: true }))
        .unwrap();
    println!("{item:#?}");
    assert_eq!(item.author.as_deref(), Some("Roald Dahl"));
    let hits = run(book.search("the overstory powers", 5)).unwrap();
    println!("{hits:#?}");
    assert!(!hits.is_empty());
}
