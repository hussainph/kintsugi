/** Books saved to Inspiration by title or ISBN. Open Library is the catalog
 *  (see docs/ingest.md › Books); this module only recognizes ISBNs and builds
 *  the Open Library URL a capture carries, so phone and Mac agree. */

/** The digits of a valid ISBN-10 or ISBN-13 (hyphens and spaces allowed,
 *  an optional `ISBN` prefix), or null. ISBN-10s keep a final `X`. */
export function parseIsbn(value: string): string | null {
  const raw = value.trim().replace(/^isbn(?:-1[03])?:?\s*/i, "");
  if (!/^[0-9Xx\- ]+$/.test(raw)) return null;
  const digits = raw.replace(/[- ]/g, "").toUpperCase();
  if (/^\d{13}$/.test(digits)) {
    const sum = [...digits].reduce((total, d, i) => total + Number(d) * (i % 2 ? 3 : 1), 0);
    return sum % 10 === 0 ? digits : null;
  }
  if (/^\d{9}[\dX]$/.test(digits)) {
    const sum = [...digits].reduce((total, d, i) => total + (d === "X" ? 10 : Number(d)) * (10 - i), 0);
    return sum % 11 === 0 ? digits : null;
  }
  return null;
}

/** The canonical Open Library page for an ISBN. Enrichment resolves it to
 *  the book's work, author, cover and description. */
export function isbnUrl(isbn: string): string {
  return `https://openlibrary.org/isbn/${isbn}`;
}
