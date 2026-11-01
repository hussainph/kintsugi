import { isbnUrl, parseIsbn } from '@kintsugi/core/books';

/** A URL pasted into the phone's capture box is inspiration, not an inbox draft.
 * Only complete HTTP(S) URLs count; prose and other schemes stay ordinary notes. */
export function captureURL(text: string): string | null {
  const value = text.trim();
  if (!/^https?:\/\/\S+$/i.test(value)) return null;
  try {
    const url = new URL(value);
    return url.hostname ? url.toString() : null;
  } catch {
    return null;
  }
}

/** A bare ISBN in the capture box is a book: its Open Library URL, which the
 * Mac's enrichment turns into a book clip. Anything else around it is a note. */
export function captureBook(text: string): string | null {
  const isbn = parseIsbn(text);
  return isbn ? isbnUrl(isbn) : null;
}

/** What the capture box saves as an inspiration clip rather than an inbox note. */
export function captureTarget(text: string): { url: string; kind: 'link' | 'book' } | null {
  const url = captureURL(text);
  if (url) return { url, kind: 'link' };
  const book = captureBook(text);
  return book ? { url: book, kind: 'book' } : null;
}
