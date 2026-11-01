//! New books from a followed author: Google Books first (`inauthor:`,
//! newest first), Open Library when Google doesn't answer. Both are keyless
//! public APIs reached through the polite [`ApiClient`].
//!
//! A followed author is a [`Subscription`] whose URL is the author's Open
//! Library search page, `https://openlibrary.org/search?author=<name>&sort=new`
//! (see [`author_url`]), so the source links somewhere a person can read.
//!
//! Each poll asks for the author's newest volumes, keeps those actually by
//! the author (search results include books *about* them and their
//! co-authors), folds editions of one title together, and returns titles the
//! cursor hasn't seen, newest first. The first poll returns only the newest
//! [`FIRST_POLL`] and remembers the rest, so following an author shows their
//! latest books, not their whole back catalogue. Reissues of a title already
//! seen never come back as new.
//!
//! Books are followed, not captured: [`AuthorAdapter::matches`] is false, and
//! a saved book goes to Inspiration through its link like any feed item.

use crate::api::{ApiClient, ApiLimits};
use crate::{Adapter, BoxFuture, CaptureOptions, Error, Item, Media, MediaKind, Polled, Result, SourceInfo, SourceType, Subscription, Target, markdown, text};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Arc;

const USER_AGENT: &str = "Kintsugi/0.1 (personal reading app; +https://github.com/hussainph/kintsugi)";
/// Following an author shows this many of their latest books.
pub const FIRST_POLL: usize = 3;
/// Titles the cursor remembers, newest kept.
const SEEN: usize = 400;
const DESCRIPTION_CHARS: usize = 600;
const AUTHOR_PAGE: &str = "https://openlibrary.org/search";

#[derive(Debug, Clone)]
pub struct AuthorEndpoints {
    /// Google Books API root (`books/v1/volumes` is appended).
    pub google: Url,
    /// Open Library root (`search.json` is appended).
    pub openlibrary: Url,
}

impl Default for AuthorEndpoints {
    fn default() -> Self {
        Self { google: Url::parse("https://www.googleapis.com/").unwrap(), openlibrary: Url::parse("https://openlibrary.org/").unwrap() }
    }
}

impl AuthorEndpoints {
    /// Both APIs at one base URL (a local fixture server).
    pub fn at(base: Url) -> Self {
        Self { google: base.clone(), openlibrary: base }
    }
}

/// One book, as either API describes it. Text is plain and untrusted.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Book {
    pub title: String,
    pub subtitle: Option<String>,
    pub authors: Vec<String>,
    pub publisher: Option<String>,
    /// As the API wrote it: `2026`, `2026-03` or `2026-03-14`.
    pub published: Option<String>,
    pub description: Option<String>,
    pub isbn: Option<String>,
    pub pages: Option<u64>,
    pub cover: Option<String>,
    pub link: Option<String>,
    /// `google-books` or `openlibrary`.
    pub provider: &'static str,
}

/// What the cursor remembers: the titles already reported.
#[derive(Debug, Default, Serialize, Deserialize, PartialEq)]
struct Cursor {
    seen: Vec<String>,
}

pub struct AuthorAdapter {
    client: Arc<ApiClient>,
    endpoints: AuthorEndpoints,
}

impl AuthorAdapter {
    pub fn new() -> Result<Self> {
        Self::with_endpoints(AuthorEndpoints::default(), ApiLimits::default())
    }

    pub fn with_endpoints(endpoints: AuthorEndpoints, limits: ApiLimits) -> Result<Self> {
        Ok(Self { client: Arc::new(ApiClient::new(USER_AGENT, limits)?), endpoints })
    }

    /// The author's newest books, editions folded, newest first.
    pub async fn newest(&self, author: &str) -> Result<Vec<Book>> {
        let books = match self.google(author).await {
            Ok(books) => books,
            Err(google) => self.openlibrary(author).await.map_err(|open| if google == Error::RateLimited { google } else { open })?,
        };
        Ok(fold(books.into_iter().filter(|b| by(author, b)).collect()))
    }

    async fn google(&self, author: &str) -> Result<Vec<Book>> {
        let mut url = self.endpoints.google.join("books/v1/volumes").map_err(|_| Error::Setup)?;
        url.query_pairs_mut()
            .append_pair("q", &format!("inauthor:\"{author}\""))
            .append_pair("orderBy", "newest")
            .append_pair("printType", "books")
            .append_pair("maxResults", "40");
        google_books(&self.client.get(url).await?.bytes)
    }

    async fn openlibrary(&self, author: &str) -> Result<Vec<Book>> {
        let mut url = self.endpoints.openlibrary.join("search.json").map_err(|_| Error::Setup)?;
        url.query_pairs_mut()
            .append_pair("author", author)
            .append_pair("sort", "new")
            .append_pair("limit", "40")
            .append_pair("fields", "key,title,subtitle,author_name,first_publish_year,publisher,isbn,cover_i,number_of_pages_median,first_sentence");
        open_library(&self.client.get(url).await?.bytes)
    }
}

impl Adapter for AuthorAdapter {
    fn source(&self) -> SourceType {
        SourceType::Author
    }

    fn matches(&self, _: &Target) -> bool {
        false
    }

    fn capture<'a>(&'a self, _: &'a Target, _: CaptureOptions) -> BoxFuture<'a, Result<Item>> {
        Box::pin(async { Err(Error::Unsupported) })
    }

    fn poll<'a>(&'a self, subscription: &'a Subscription) -> BoxFuture<'a, Result<Polled>> {
        Box::pin(async move {
            let author = author_name(&subscription.url).ok_or(Error::InvalidUrl)?;
            let books = tokio::time::timeout(self.client.limits.deadline, self.newest(&author)).await.map_err(|_| Error::TimedOut)??;
            let previous: Option<Cursor> = subscription.cursor.as_deref().and_then(|c| serde_json::from_str(c).ok());
            let first = previous.is_none();
            let mut seen = previous.map(|c| c.seen).unwrap_or_default();
            let captured = crate::now();
            let mut items = Vec::new();
            for book in &books {
                let key = title_key(&book.title);
                if seen.contains(&key) {
                    continue;
                }
                if !first || items.len() < FIRST_POLL {
                    items.push(item(&author, book, &captured));
                }
                seen.push(key);
            }
            if seen.len() > SEEN {
                seen.drain(..seen.len() - SEEN);
            }
            let source = SourceInfo { title: Some(author.clone()), url: Some(author_url(&author).unwrap_or_default()), image: None };
            Ok(Polled { items, cursor: serde_json::to_string(&Cursor { seen }).ok(), source: Some(source) })
        })
    }
}

/// The subscription URL for an author's name, or `None` for an empty name.
pub fn author_url(name: &str) -> Option<String> {
    let name = markdown::field(name, 200)?;
    let mut url = Url::parse(AUTHOR_PAGE).ok()?;
    url.query_pairs_mut().append_pair("author", &name).append_pair("sort", "new");
    Some(url.to_string())
}

/// The author a subscription URL follows.
pub fn author_name(url: &str) -> Option<String> {
    let url = Url::parse(url).ok()?;
    if url.host_str() != Some("openlibrary.org") || url.path() != "/search" {
        return None;
    }
    url.query_pairs().find(|(k, _)| k == "author").and_then(|(_, v)| markdown::field(&v, 200))
}

fn tokens(name: &str) -> Vec<String> {
    name.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|t| !t.is_empty()).map(str::to_string).collect()
}

/// Whether a book is by the author: every word of the followed name longer
/// than an initial appears in one of its authors' names.
pub fn by(author: &str, book: &Book) -> bool {
    let wanted: Vec<String> = tokens(author).into_iter().filter(|t| t.chars().count() > 1).collect();
    !wanted.is_empty()
        && book.authors.iter().any(|name| {
            let have = tokens(name);
            wanted.iter().all(|w| have.contains(w))
        })
}

/// A title as editions share it: no subtitle, no "(… Edition)", lowercase
/// words only.
pub fn title_key(title: &str) -> String {
    let main = title.split([':', '(', '[']).next().unwrap_or(title);
    tokens(main).join(" ")
}

/// One book per title, the newest edition's details first; the result is
/// newest first by date (undated books keep the API's order, last).
fn fold(books: Vec<Book>) -> Vec<Book> {
    let mut out: Vec<Book> = Vec::new();
    for book in books {
        let key = title_key(&book.title);
        if key.is_empty() {
            continue;
        }
        match out.iter_mut().find(|b| title_key(&b.title) == key) {
            Some(known) => {
                // The earliest edition stands for the book, so a reissue
                // doesn't pass for a new one; the others fill its gaps.
                let earlier = book.published.as_deref().is_some_and(|p| known.published.as_deref().is_none_or(|k| p < k));
                let (mut first, other) = if earlier { (book, known.clone()) } else { (known.clone(), book) };
                first.description = first.description.or(other.description);
                first.cover = first.cover.or(other.cover);
                first.link = first.link.or(other.link);
                first.pages = first.pages.or(other.pages);
                *known = first;
            }
            None => out.push(book),
        }
    }
    out.sort_by(|a, b| b.published.as_deref().unwrap_or("").cmp(a.published.as_deref().unwrap_or("")));
    out
}

/// A date the API wrote, as RFC 3339 when it names a day (a month means its
/// first day). A bare year is too vague to sort by.
pub fn published(date: &str) -> Option<String> {
    let date = date.trim();
    let day = match date.len() {
        10 => chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?,
        7 => chrono::NaiveDate::parse_from_str(&format!("{date}-01"), "%Y-%m-%d").ok()?,
        _ => return None,
    };
    Some(format!("{}T00:00:00Z", day.format("%Y-%m-%d")))
}

fn web(url: &str) -> Option<String> {
    let url = Url::parse(url).ok().filter(crate::web::allowed_url)?;
    let mut url = url;
    // Google serves covers over plain HTTP by default.
    if url.scheme() == "http" && url.host_str().is_some_and(|h| h.ends_with("books.google.com") || h.ends_with("googleusercontent.com")) {
        let _ = url.set_scheme("https");
    }
    Some(url.to_string())
}

fn slug(text: &str) -> String {
    tokens(text).join("-")
}

fn item(author: &str, book: &Book, captured: &str) -> Item {
    let title = match &book.subtitle {
        Some(subtitle) => format!("{}: {subtitle}", book.title),
        None => book.title.clone(),
    };
    let authors = if book.authors.is_empty() { author.to_string() } else { book.authors.join(", ") };
    let mut facts = Vec::new();
    if let Some(publisher) = &book.publisher {
        facts.push(publisher.clone());
    }
    if let Some(date) = &book.published {
        facts.push(date.clone());
    }
    if let Some(pages) = book.pages {
        facts.push(format!("{pages} pages"));
    }
    if let Some(isbn) = &book.isbn {
        facts.push(format!("ISBN {isbn}"));
    }
    let mut body = format!("**{}** by {}", text::label(&title, 300), text::label(&authors, 300));
    if !facts.is_empty() {
        body.push_str(&format!("\n\n{}", text::plain(&text::label(&facts.join(" · "), 400))));
    }
    if let Some(description) = &book.description {
        body.push_str(&format!("\n\n{}", text::plain(description)));
    }
    let source = if book.provider == "openlibrary" { "Open Library" } else { "Google Books" };
    if let Some(link) = &book.link {
        body.push_str(&format!("\n\n[{source}]({})", link.replace('(', "%28").replace(')', "%29")));
    }
    let mut extras = BTreeMap::new();
    extras.insert("extractor".into(), Value::from(book.provider));
    extras.insert("media".into(), Value::from("book"));
    if let Some(isbn) = &book.isbn {
        extras.insert("isbn".into(), Value::from(isbn.clone()));
    }
    if let Some(date) = &book.published {
        extras.insert("releaseDate".into(), Value::from(date.clone()));
    }
    Item {
        source: SourceType::Author,
        id: format!("author:{}/{}", slug(author), slug(&title_key(&book.title))),
        url: book.link.clone(),
        title: markdown::field(&title, 500),
        author: markdown::field(&authors, 200),
        site: Some(source.into()),
        description: book.description.as_deref().and_then(|d| bounded(d, DESCRIPTION_CHARS)),
        published: book.published.as_deref().and_then(published),
        captured: captured.into(),
        media: book.cover.clone().map(|u| Media { kind: MediaKind::Image, url: Some(u), data: None }).into_iter().collect(),
        body: markdown::body(&body, crate::BODY_CHARS),
        extras,
    }
}

fn bounded(text: &str, limit: usize) -> Option<String> {
    let flat = markdown::field(text, limit + 1)?;
    Some(if flat.chars().count() > limit { format!("{}…", flat.chars().take(limit).collect::<String>().trim_end()) } else { flat })
}

/// Google's descriptions may carry a little HTML (`<p>`, `<br>`, `<i>`).
fn strip_html(text: &str) -> String {
    if !text.contains('<') && !text.contains('&') {
        return text.to_string();
    }
    let doc = dom_query::Document::from(text.replace("<br>", "\n").replace("<br/>", "\n").replace("</p>", "</p>\n").as_str());
    doc.select("script, style").remove();
    doc.select("body").text().to_string()
}

#[derive(Deserialize)]
struct GoogleVolumes {
    #[serde(default)]
    items: Vec<GoogleVolume>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleVolume {
    #[serde(default)]
    volume_info: GoogleInfo,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleInfo {
    title: Option<String>,
    subtitle: Option<String>,
    #[serde(default)]
    authors: Vec<String>,
    publisher: Option<String>,
    published_date: Option<String>,
    description: Option<String>,
    #[serde(default)]
    industry_identifiers: Vec<GoogleIdentifier>,
    page_count: Option<u64>,
    image_links: Option<BTreeMap<String, String>>,
    canonical_volume_link: Option<String>,
    info_link: Option<String>,
}

#[derive(Deserialize)]
struct GoogleIdentifier {
    #[serde(rename = "type")]
    kind: String,
    identifier: String,
}

/// A Google Books `volumes` response.
pub fn google_books(bytes: &[u8]) -> Result<Vec<Book>> {
    let volumes: GoogleVolumes = serde_json::from_slice(bytes).map_err(|_| Error::Unavailable)?;
    Ok(volumes
        .items
        .into_iter()
        .filter_map(|v| {
            let info = v.volume_info;
            let isbn = ["ISBN_13", "ISBN_10"]
                .iter()
                .find_map(|kind| info.industry_identifiers.iter().find(|i| i.kind == *kind))
                .map(|i| i.identifier.clone())
                .filter(|i| i.chars().all(|c| c.is_ascii_alphanumeric()));
            let cover = info.image_links.as_ref().and_then(|l| l.get("thumbnail").or(l.get("smallThumbnail"))).and_then(|u| web(u));
            Some(Book {
                title: markdown::field(&info.title?, 300)?,
                subtitle: info.subtitle.and_then(|s| markdown::field(&s, 300)),
                authors: info.authors.iter().filter_map(|a| markdown::field(a, 200)).collect(),
                publisher: info.publisher.and_then(|p| markdown::field(&p, 200)),
                published: info.published_date.and_then(|p| markdown::field(&p, 20)),
                description: info.description.map(|d| strip_html(&d)).and_then(|d| Some(markdown::body(&d, 4_000)).filter(|d| !d.is_empty())),
                isbn,
                pages: info.page_count.filter(|p| *p > 0),
                cover,
                link: info.canonical_volume_link.or(info.info_link).and_then(|u| web(&u)),
                provider: "google-books",
            })
        })
        .collect())
}

#[derive(Deserialize)]
struct OpenLibrarySearch {
    #[serde(default)]
    docs: Vec<OpenLibraryDoc>,
}

#[derive(Deserialize)]
struct OpenLibraryDoc {
    key: Option<String>,
    title: Option<String>,
    subtitle: Option<String>,
    #[serde(default)]
    author_name: Vec<String>,
    first_publish_year: Option<i64>,
    #[serde(default)]
    publisher: Vec<String>,
    #[serde(default)]
    isbn: Vec<String>,
    cover_i: Option<i64>,
    number_of_pages_median: Option<u64>,
    #[serde(default)]
    first_sentence: Vec<String>,
}

/// An Open Library `search.json` response.
pub fn open_library(bytes: &[u8]) -> Result<Vec<Book>> {
    let search: OpenLibrarySearch = serde_json::from_slice(bytes).map_err(|_| Error::Unavailable)?;
    Ok(search
        .docs
        .into_iter()
        .filter_map(|d| {
            let key = d.key.filter(|k| k.starts_with("/works/") && k[7..].chars().all(|c| c.is_ascii_alphanumeric()));
            Some(Book {
                title: markdown::field(&d.title?, 300)?,
                subtitle: d.subtitle.and_then(|s| markdown::field(&s, 300)),
                authors: d.author_name.iter().filter_map(|a| markdown::field(a, 200)).collect(),
                publisher: d.publisher.first().and_then(|p| markdown::field(p, 200)),
                published: d.first_publish_year.filter(|y| (1000..=9999).contains(y)).map(|y| y.to_string()),
                description: d.first_sentence.first().and_then(|s| markdown::field(s, 2_000)),
                isbn: d.isbn.iter().find(|i| i.len() == 13).or(d.isbn.first()).filter(|i| i.chars().all(|c| c.is_ascii_alphanumeric())).cloned(),
                pages: d.number_of_pages_median.filter(|p| *p > 0),
                cover: d.cover_i.filter(|c| *c > 0).map(|c| format!("https://covers.openlibrary.org/b/id/{c}-M.jpg")),
                link: key.map(|k| format!("https://openlibrary.org{k}")),
                provider: "openlibrary",
            })
        })
        .collect())
}

#[cfg(test)]
mod tests;
