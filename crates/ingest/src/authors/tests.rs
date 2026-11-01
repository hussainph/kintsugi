//! Saved Google Books and Open Library responses and a loopback server only;
//! the live check is `#[ignore]`d.

use super::*;
use crate::test_server::{route, run, serve};

const GOOGLE: &str = include_str!("../../fixtures/authors/google-clarke.json");
const OPEN_LIBRARY: &str = include_str!("../../fixtures/authors/openlibrary-clarke.json");
const CLARKE: &str = "https://openlibrary.org/search?author=Susanna+Clarke&sort=new";

fn adapter(base: &str) -> AuthorAdapter {
    let limits = ApiLimits { min_interval: std::time::Duration::ZERO, ..ApiLimits::default() };
    AuthorAdapter::with_endpoints(AuthorEndpoints::at(Url::parse(base).unwrap()), limits).unwrap()
}

#[test]
fn author_urls_round_trip() {
    let url = author_url("  Susanna   Clarke ").unwrap();
    assert_eq!(url, CLARKE);
    assert_eq!(author_name(&url).as_deref(), Some("Susanna Clarke"));
    assert_eq!(author_name(&author_url("Ursula K. Le Guin").unwrap()).as_deref(), Some("Ursula K. Le Guin"));
    assert_eq!(author_url("   "), None);
    assert_eq!(author_name("https://example.org/search?author=x"), None);
    assert_eq!(author_name("https://openlibrary.org/search?q=x"), None);
}

#[test]
fn only_the_authors_own_books_count() {
    let book = |authors: &[&str]| Book { title: "T".into(), authors: authors.iter().map(|a| a.to_string()).collect(), ..Book::default() };
    assert!(by("Ursula K. Le Guin", &book(&["Ursula K. Le Guin"])));
    assert!(by("Ursula K. Le Guin", &book(&["Ursula Le Guin", "Someone Else"])));
    assert!(by("susanna clarke", &book(&["Clarke, Susanna"])));
    assert!(!by("Susanna Clarke", &book(&["Arthur C. Clarke"])));
    assert!(!by("Susanna Clarke", &book(&[])));
    assert_eq!(title_key("Piranesi (Anniversary Edition)"), "piranesi");
    assert_eq!(title_key("The Lost Garden: A Novel"), "the lost garden");
    assert_eq!(published("2026-10-14").as_deref(), Some("2026-10-14T00:00:00Z"));
    assert_eq!(published("2026-09").as_deref(), Some("2026-09-01T00:00:00Z"));
    assert_eq!(published("2026"), None);
    assert_eq!(published("soon"), None);
}

#[test]
fn google_books_volumes_are_normalized() {
    let books = google_books(GOOGLE.as_bytes()).unwrap();
    assert_eq!(books.len(), 6, "the untitled volume is dropped");
    let lost = &books[0];
    assert_eq!(lost.title, "The Lost Garden");
    assert_eq!(lost.subtitle.as_deref(), Some("A Novel"));
    assert_eq!(lost.isbn.as_deref(), Some("9781526600001"));
    assert_eq!(lost.pages, Some(288));
    assert!(lost.cover.as_deref().unwrap().starts_with("https://books.google.com/"), "covers are upgraded to https");
    assert_eq!(lost.link.as_deref(), Some("https://books.google.com/books/about/The_Lost_Garden.html?hl=&id=nEwB00k0001"));
    let description = lost.description.as_deref().unwrap();
    assert!(description.contains("never the same twice") && !description.contains('<'), "{description}");
}

#[test]
fn open_library_works_are_normalized() {
    let books = open_library(OPEN_LIBRARY.as_bytes()).unwrap();
    assert_eq!(books.len(), 3);
    assert_eq!(books[0].link.as_deref(), Some("https://openlibrary.org/works/OL40000001W"));
    assert_eq!(books[0].cover.as_deref(), Some("https://covers.openlibrary.org/b/id/14800001-M.jpg"));
    assert_eq!(books[0].isbn.as_deref(), Some("9781526600001"));
    assert_eq!(books[0].published.as_deref(), Some("2026"));
    assert_eq!(books[2].authors, ["Susanna Clarke", "Charles Vess"]);
}

#[test]
fn following_shows_the_latest_then_only_new_titles() {
    let newer = GOOGLE.replacen(
        r#""items": ["#,
        r#""items": [{ "id": "n2", "volumeInfo": { "title": "Winter Hours", "authors": ["Susanna Clarke"], "publishedDate": "2027-02-02" } },
                     { "id": "n3", "volumeInfo": { "title": "Piranesi: Illustrated Edition", "authors": ["Susanna Clarke"], "publishedDate": "2027-01-01" } },"#,
        1,
    );
    let server = serve(vec![
        route("/books/v1/volumes?q=inauthor%3A%22Susanna+Clarke%22&orderBy=newest", 200, GOOGLE),
        route("/books/v1/volumes?", 200, GOOGLE),
        route("/books/v1/volumes?", 200, newer),
    ]);
    let books = adapter(&server.base);
    run(async {
        let first = books.poll(&Subscription { url: CLARKE.into(), cursor: None }).await.unwrap();
        let titles: Vec<_> = first.items.iter().map(|i| i.title.clone().unwrap()).collect();
        // Newest first, editions folded (Piranesi is dated by its first
        // edition), the book about her left out, and only the latest three.
        assert_eq!(titles, ["The Lost Garden: A Novel", "The Wood at Midwinter", "Piranesi"]);
        let lost = &first.items[0];
        assert_eq!(lost.source, SourceType::Author);
        assert_eq!(lost.id, "author:susanna-clarke/the-lost-garden");
        assert_eq!(lost.author.as_deref(), Some("Susanna Clarke"));
        assert_eq!(lost.site.as_deref(), Some("Google Books"));
        assert_eq!(lost.published.as_deref(), Some("2026-10-14T00:00:00Z"));
        assert_eq!(lost.extras["media"], "book");
        assert!(lost.body.starts_with("**The Lost Garden: A Novel** by Susanna Clarke\n\nBloomsbury Publishing · 2026-10-14 · 288 pages · ISBN 9781526600001"), "{}", lost.body);
        assert!(lost.body.ends_with("[Google Books](https://books.google.com/books/about/The_Lost_Garden.html?hl=&id=nEwB00k0001)"), "{}", lost.body);
        assert_eq!(first.items[2].published.as_deref(), Some("2020-09-15T00:00:00Z"));
        assert_eq!(first.source.as_ref().unwrap().title.as_deref(), Some("Susanna Clarke"));

        let again = books.poll(&Subscription { url: CLARKE.into(), cursor: first.cursor.clone() }).await.unwrap();
        assert!(again.items.is_empty(), "older books seen on the first poll never come back");

        let later = books.poll(&Subscription { url: CLARKE.into(), cursor: again.cursor.clone() }).await.unwrap();
        let titles: Vec<_> = later.items.iter().map(|i| i.title.clone().unwrap()).collect();
        assert_eq!(titles, ["Winter Hours"], "a reissue of a known title isn't new");
    });
    server.finish();
}

/// Rate limits are per host, so Google and Open Library get a host each.
fn split(google: &str, openlibrary: &str) -> AuthorAdapter {
    let openlibrary = openlibrary.replace("127.0.0.1", "localhost");
    let endpoints = AuthorEndpoints { google: Url::parse(google).unwrap(), openlibrary: Url::parse(&openlibrary).unwrap() };
    let limits = ApiLimits { min_interval: std::time::Duration::ZERO, ..ApiLimits::default() };
    AuthorAdapter::with_endpoints(endpoints, limits).unwrap()
}

#[test]
fn open_library_answers_when_google_does_not() {
    let google = serve(vec![route("/books/v1/volumes?", 429, "{}")]);
    let openlibrary = serve(vec![route("/search.json?author=Susanna+Clarke&sort=new", 200, OPEN_LIBRARY)]);
    let books = split(&google.base, &openlibrary.base);
    let polled = run(books.poll(&Subscription { url: CLARKE.into(), cursor: None })).unwrap();
    let titles: Vec<_> = polled.items.iter().map(|i| i.title.clone().unwrap()).collect();
    assert_eq!(titles, ["The Lost Garden", "Piranesi", "The Ladies of Grace Adieu: and Other Stories"]);
    assert_eq!(polled.items[0].site.as_deref(), Some("Open Library"));
    assert_eq!(polled.items[0].published, None, "a bare year is too vague to date the item");
    assert_eq!(polled.items[0].extras["extractor"], "openlibrary");
    google.finish();
    openlibrary.finish();
}

#[test]
fn both_failing_is_an_error_and_a_rate_limit_says_so() {
    let google = serve(vec![route("/books/v1/volumes?", 429, "{}")]);
    let openlibrary = serve(vec![route("/search.json?", 503, "")]);
    let books = split(&google.base, &openlibrary.base);
    let polled = run(books.poll(&Subscription { url: CLARKE.into(), cursor: None }));
    assert_eq!(polled, Err(Error::RateLimited));
    google.finish();
    openlibrary.finish();
    let invalid = run(books.poll(&Subscription { url: "https://example.org/".into(), cursor: None }));
    assert_eq!(invalid, Err(Error::InvalidUrl));
}

#[test]
#[ignore = "touches the live network"]
fn live_new_books_from_an_author() {
    let books = AuthorAdapter::new().unwrap();
    let polled = run(books.poll(&Subscription { url: author_url("Ursula K. Le Guin").unwrap(), cursor: None })).unwrap();
    assert!(!polled.items.is_empty());
    assert!(polled.items.iter().all(|i| i.author.as_deref().is_some_and(|a| a.contains("Le Guin"))));
}
