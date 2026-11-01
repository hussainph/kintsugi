//! Books from [Open Library](https://openlibrary.org/developers/api), the
//! Internet Archive's open catalog (data CC0, no key needed).
//!
//! - [`BookAdapter::search`] finds books by title (and author) or ISBN, for
//!   the "save a book" picker.
//! - As an [`Adapter`] it captures an Open Library page: a work
//!   (`/works/OL…W`), an edition (`/books/OL…M`) or an ISBN
//!   (`/isbn/<isbn>`, which Open Library redirects to its edition). A book
//!   saved from search or by ISBN is a clip with that URL, and enrichment
//!   turns it into the book's title, authors, cover and description.
//!
//! The item is the catalog record, never the book's text.

use crate::api::{ApiClient, ApiLimits};
use crate::{
    Adapter, BoxFuture, CaptureOptions, Error, Item, Media, MediaData, MediaKind, Result, SourceType, Target,
    markdown, media, text,
};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::time::Duration;

/// Open Library asks clients to identify themselves; identified clients get
/// three requests a second.
const USER_AGENT: &str = "Kintsugi/0.1 (personal reading app; +https://github.com/hussainph/kintsugi)";
const SEARCH_FIELDS: &str = "key,title,author_name,first_publish_year,cover_i,isbn,edition_count";

/// One search result, for the picker.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookHit {
    /// The work's key, `/works/OL45804W`.
    pub key: String,
    /// Its canonical page: save this as the clip's URL.
    pub url: String,
    pub title: String,
    pub authors: Vec<String>,
    pub year: Option<i64>,
    /// An ISBN of one of its editions (the searched one, for an ISBN search).
    pub isbn: Option<String>,
    pub cover_url: Option<String>,
    pub editions: Option<i64>,
}

pub struct BookAdapter {
    client: ApiClient,
    base: Url,
    covers: Url,
}

impl BookAdapter {
    pub fn new() -> Result<Self> {
        let base = Url::parse("https://openlibrary.org/").map_err(|_| Error::Setup)?;
        let covers = Url::parse("https://covers.openlibrary.org/").map_err(|_| Error::Setup)?;
        Self::with_endpoints(base, covers, ApiLimits { min_interval: Duration::from_millis(400), ..ApiLimits::default() })
    }

    /// Replaces the API and cover hosts (tests use a loopback server).
    pub fn with_endpoints(base: Url, covers: Url, limits: ApiLimits) -> Result<Self> {
        Ok(Self { client: ApiClient::new(USER_AGENT, limits)?, base, covers })
    }

    /// Up to `limit` (at most 20) books matching a title, "title author", or
    /// an ISBN (ISBNs search by ISBN).
    pub async fn search(&self, query: &str, limit: usize) -> Result<Vec<BookHit>> {
        let query = query.split_whitespace().collect::<Vec<_>>().join(" ");
        if query.is_empty() || query.chars().count() > 200 {
            return Ok(Vec::new());
        }
        let mut url = self.base.join("search.json").map_err(|_| Error::InvalidUrl)?;
        let isbn = normalize_isbn(&query);
        {
            let mut pairs = url.query_pairs_mut();
            match &isbn {
                Some(isbn) => pairs.append_pair("isbn", isbn),
                None => pairs.append_pair("q", &query),
            };
            pairs.append_pair("fields", SEARCH_FIELDS).append_pair("limit", &limit.clamp(1, 20).to_string());
        }
        let body = self.deadline(self.client.get(url)).await?;
        #[derive(Deserialize)]
        struct Results {
            #[serde(default)]
            docs: Vec<Doc>,
        }
        #[derive(Deserialize)]
        struct Doc {
            key: Option<String>,
            title: Option<String>,
            #[serde(default)]
            author_name: Vec<String>,
            first_publish_year: Option<i64>,
            cover_i: Option<i64>,
            #[serde(default)]
            isbn: Vec<String>,
            edition_count: Option<i64>,
        }
        let results: Results = serde_json::from_slice(&body.bytes).map_err(|_| Error::Unavailable)?;
        Ok(results
            .docs
            .into_iter()
            .filter_map(|doc| {
                let olid = work_key(doc.key.as_deref()?)?;
                Some(BookHit {
                    key: format!("/works/{olid}"),
                    url: format!("https://openlibrary.org/works/{olid}"),
                    title: markdown::field(doc.title.as_deref()?, 300)?,
                    authors: {
                        let mut authors: Vec<String> = Vec::new();
                        for name in doc.author_name.iter().filter_map(|a| markdown::field(a, 200)) {
                            if authors.len() < 5 && !authors.contains(&name) {
                                authors.push(name);
                            }
                        }
                        authors
                    },
                    year: doc.first_publish_year,
                    isbn: isbn.clone().or_else(|| {
                        let isbns: Vec<String> = doc.isbn.iter().filter_map(|i| normalize_isbn(i)).collect();
                        isbns.iter().find(|i| i.len() == 13).or(isbns.first()).cloned()
                    }),
                    cover_url: doc
                        .cover_i
                        .filter(|id| *id > 0)
                        .map(|id| format!("https://covers.openlibrary.org/b/id/{id}-M.jpg")),
                    editions: doc.edition_count,
                })
            })
            .collect())
    }

    async fn deadline<T>(&self, work: impl Future<Output = Result<T>>) -> Result<T> {
        tokio::time::timeout(self.client.limits.deadline, work).await.map_err(|_| Error::TimedOut)?
    }

    async fn json(&self, path: &str) -> Result<Value> {
        let url = self.base.join(path.trim_start_matches('/')).map_err(|_| Error::InvalidUrl)?;
        let body = self.client.get(url).await?;
        serde_json::from_slice(&body.bytes).map_err(|_| Error::Unavailable)
    }

    async fn capture_book(&self, page: BookPage, options: CaptureOptions) -> Result<Item> {
        let (edition, work_id) = match &page {
            BookPage::Isbn(isbn) => {
                let edition = self.json(&format!("isbn/{isbn}.json")).await?;
                let work = edition["works"][0]["key"].as_str().and_then(work_key);
                (Some(edition), work)
            }
            BookPage::Edition(olid) => {
                let edition = self.json(&format!("books/{olid}.json")).await?;
                let work = edition["works"][0]["key"].as_str().and_then(work_key);
                (Some(edition), work)
            }
            BookPage::Work(olid) => (None, Some(olid.clone())),
        };
        let work = match &work_id {
            Some(olid) => Some(self.json(&format!("works/{olid}.json")).await?),
            None => None,
        };
        let empty = Value::Null;
        let edition_ref = edition.as_ref().unwrap_or(&empty);
        let work_ref = work.as_ref().unwrap_or(&empty);

        let author_keys: Vec<String> = work_ref["authors"]
            .as_array()
            .map(|list| list.iter().filter_map(|a| a["author"]["key"].as_str().map(str::to_string)).collect())
            .filter(|keys: &Vec<String>| !keys.is_empty())
            .or_else(|| {
                edition_ref["authors"].as_array().map(|list| list.iter().filter_map(|a| a["key"].as_str().map(str::to_string)).collect())
            })
            .unwrap_or_default();
        let mut authors = Vec::new();
        for key in author_keys.iter().filter(|k| author_key(k)).take(3) {
            if let Ok(author) = self.json(&format!("{key}.json")).await
                && let Some(name) = author["name"].as_str().and_then(|n| markdown::field(n, 200))
            {
                authors.push(name);
            }
        }

        let title = string(work_ref, "title").or_else(|| string(edition_ref, "title")).and_then(|t| markdown::field(&t, 300));
        let subtitle = string(work_ref, "subtitle").or_else(|| string(edition_ref, "subtitle"));
        let description = described(&work_ref["description"]).or_else(|| described(&edition_ref["description"]));
        let published = string(work_ref, "first_publish_date").or_else(|| string(edition_ref, "publish_date"));
        let publisher = edition_ref["publishers"][0].as_str().and_then(|p| markdown::field(p, 200));
        let pages = edition_ref["number_of_pages"].as_i64();
        let isbn = match &page {
            BookPage::Isbn(isbn) => Some(isbn.clone()),
            _ => ["isbn_13", "isbn_10"]
                .iter()
                .find_map(|key| edition_ref[*key].as_array().and_then(|l| l.iter().find_map(|i| i.as_str().and_then(normalize_isbn)))),
        };
        let subjects: Vec<String> = work_ref["subjects"]
            .as_array()
            .map(|list| list.iter().filter_map(|s| s.as_str().and_then(|s| markdown::field(s, 80))).take(10).collect())
            .unwrap_or_default();
        let cover = edition_ref["covers"]
            .as_array()
            .or_else(|| work_ref["covers"].as_array())
            .and_then(|covers| covers.iter().filter_map(Value::as_i64).find(|id| *id > 0));

        let mut body = Vec::new();
        if let Some(subtitle) = subtitle.as_deref().and_then(|s| markdown::field(s, 300)) {
            body.push(format!("_{}_", text::label(&subtitle, 300)));
        }
        if let Some(description) = &description {
            body.push(text::plain(description));
        }
        let mut details = Vec::new();
        if !authors.is_empty() {
            details.push(format!("- **By:** {}", text::plain(&authors.join(", "))));
        }
        if let Some(published) = &published {
            details.push(format!("- **First published:** {}", text::plain(published)));
        }
        if let Some(publisher) = &publisher {
            details.push(format!("- **Publisher:** {}", text::plain(publisher)));
        }
        if let Some(pages) = pages {
            details.push(format!("- **Pages:** {pages}"));
        }
        if let Some(isbn) = &isbn {
            details.push(format!("- **ISBN:** {isbn}"));
        }
        if !subjects.is_empty() {
            details.push(format!("- **Subjects:** {}", text::plain(&subjects.join(", "))));
        }
        if !details.is_empty() {
            body.push(details.join("\n"));
        }

        let mut media = Vec::new();
        if let Some(cover) = cover
            && let Ok(url) = self.covers.join(&format!("b/id/{cover}-L.jpg"))
        {
            let data = if options.want_media {
                // Open Library answers a 1×1 GIF for a missing cover; a real
                // cover is never that small.
                self.client.media(url.clone()).await.ok().filter(|b| b.len() > 1024).and_then(|bytes| {
                    media::image_mime(&bytes).map(|mime| MediaData { bytes, mime: mime.into() })
                })
            } else {
                None
            };
            let public = format!("https://covers.openlibrary.org/b/id/{cover}-L.jpg");
            media.push(Media { kind: MediaKind::Image, url: Some(public), data });
        }

        let mut extras: BTreeMap<String, Value> = BTreeMap::new();
        extras.insert("extractor".into(), json!("openlibrary"));
        if let Some(isbn) = &isbn {
            extras.insert("isbn".into(), json!(isbn));
        }
        if let Some(pages) = pages {
            extras.insert("pages".into(), json!(pages));
        }
        if !subjects.is_empty() {
            extras.insert("subjects".into(), json!(subjects));
        }
        let edition_id = edition_ref["key"].as_str().and_then(edition_key);
        if let Some(edition) = &edition_id {
            extras.insert("edition".into(), json!(edition));
        }
        let (id, url) = match (&work_id, &edition_id, &page) {
            (Some(work), _, _) => (format!("book:{work}"), format!("https://openlibrary.org/works/{work}")),
            (None, Some(edition), _) => (format!("book:{edition}"), format!("https://openlibrary.org/books/{edition}")),
            (None, None, BookPage::Isbn(isbn)) => (format!("book:isbn:{isbn}"), format!("https://openlibrary.org/isbn/{isbn}")),
            _ => return Err(Error::Unavailable),
        };
        if title.is_none() {
            return Err(Error::Unavailable);
        }
        Ok(Item {
            source: SourceType::Book,
            id,
            url: Some(url),
            title,
            author: (!authors.is_empty()).then(|| authors.join(", ")),
            site: Some("Open Library".into()),
            description: description.as_deref().and_then(|d| markdown::field(d, 600)),
            published,
            captured: crate::now(),
            media,
            body: markdown::body(&body.join("\n\n"), crate::BODY_CHARS),
            extras,
        })
    }
}

impl Adapter for BookAdapter {
    fn source(&self) -> SourceType {
        SourceType::Book
    }

    fn matches(&self, target: &Target) -> bool {
        matches!(target, Target::Url(url) if book_page(url).is_some())
    }

    fn capture<'a>(&'a self, target: &'a Target, options: CaptureOptions) -> BoxFuture<'a, Result<Item>> {
        Box::pin(async move {
            let Target::Url(url) = target else { return Err(Error::Unsupported) };
            let page = book_page(url).ok_or(Error::Unsupported)?;
            self.deadline(self.capture_book(page, options)).await
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
enum BookPage {
    Work(String),
    Edition(String),
    Isbn(String),
}

/// An Open Library work, edition or ISBN page (with or without `.json`,
/// a trailing title slug, `www.`).
fn book_page(url: &Url) -> Option<BookPage> {
    if !crate::web::allowed_url(url) || !matches!(url.host_str(), Some("openlibrary.org" | "www.openlibrary.org")) {
        return None;
    }
    let mut parts = url.path_segments()?.filter(|s| !s.is_empty());
    let kind = parts.next()?;
    let id = parts.next()?.trim_end_matches(".json");
    match kind {
        "works" => work_key(&format!("/works/{id}")).map(BookPage::Work),
        "books" => edition_key(&format!("/books/{id}")).map(BookPage::Edition),
        "isbn" => normalize_isbn(id).map(BookPage::Isbn),
        _ => None,
    }
}

fn olid(key: &str, prefix: &str, suffix: char) -> Option<String> {
    let id = key.strip_prefix(prefix)?;
    let digits = id.strip_prefix("OL")?.strip_suffix(suffix)?;
    (!digits.is_empty() && digits.len() <= 12 && digits.bytes().all(|b| b.is_ascii_digit())).then(|| id.to_string())
}

fn work_key(key: &str) -> Option<String> {
    olid(key, "/works/", 'W')
}

fn edition_key(key: &str) -> Option<String> {
    olid(key, "/books/", 'M')
}

fn author_key(key: &str) -> bool {
    olid(key, "/authors/", 'A').is_some()
}

fn string(value: &Value, key: &str) -> Option<String> {
    value[key].as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

/// Descriptions are a string or `{ "type": "/type/text", "value": … }`.
fn described(value: &Value) -> Option<String> {
    let text = value.as_str().or_else(|| value["value"].as_str())?.trim();
    (!text.is_empty()).then(|| text.chars().take(4000).collect())
}

/// The digits of a valid ISBN-10 or ISBN-13 (hyphens and spaces allowed,
/// a final `X` kept upper-case), or `None`. Mirrors `parseIsbn` in
/// `packages/core/src/books.ts`.
pub fn normalize_isbn(text: &str) -> Option<String> {
    let lower = text.trim().to_ascii_lowercase();
    let raw = ["isbn-13:", "isbn-10:", "isbn:", "isbn-13", "isbn-10", "isbn"]
        .iter()
        .find_map(|p| lower.strip_prefix(p))
        .unwrap_or(&lower)
        .trim();
    if raw.is_empty() || !raw.chars().all(|c| c.is_ascii_digit() || matches!(c, 'x' | '-' | ' ')) {
        return None;
    }
    let digits: String = raw.chars().filter(|c| !matches!(c, '-' | ' ')).collect::<String>().to_ascii_uppercase();
    let value = |c: char| if c == 'X' { 10 } else { c.to_digit(10).unwrap_or(0) };
    match digits.len() {
        13 if digits.chars().all(|c| c.is_ascii_digit()) => {
            let sum: u32 = digits.chars().enumerate().map(|(i, c)| value(c) * if i % 2 == 1 { 3 } else { 1 }).sum();
            sum.is_multiple_of(10).then_some(digits)
        }
        10 if digits[..9].chars().all(|c| c.is_ascii_digit()) => {
            let sum: u32 = digits.chars().enumerate().map(|(i, c)| value(c) * (10 - i as u32)).sum();
            sum.is_multiple_of(11).then_some(digits)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests;
