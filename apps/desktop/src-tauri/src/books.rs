//! Saving a book by title or ISBN: the picker searches Open Library
//! (`kintsugi_ingest::books`), and the chosen book is captured as a clip with
//! its Open Library URL, which enrichment turns into the full record.

use kintsugi_ingest::books::{BookAdapter, BookHit};
use std::sync::OnceLock;

/// One client for the app's life, so Open Library's pacing holds across
/// searches.
static BOOKS: OnceLock<BookAdapter> = OnceLock::new();

#[tauri::command]
pub async fn book_search(query: String) -> Result<Vec<BookHit>, String> {
    if BOOKS.get().is_none() {
        let adapter = BookAdapter::new().map_err(|e| e.to_string())?;
        let _ = BOOKS.set(adapter);
    }
    let books = BOOKS.get().ok_or("could not start book search")?;
    books.search(&query, 12).await.map_err(|e| match e {
        kintsugi_ingest::Error::RateLimited => "Open Library is busy; try again in a minute.".into(),
        kintsugi_ingest::Error::TimedOut | kintsugi_ingest::Error::Unavailable => {
            "Couldn't reach Open Library. Check the connection and try again.".into()
        }
        other => other.to_string(),
    })
}
