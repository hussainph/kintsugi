import assert from "node:assert/strict";
import { test } from "node:test";
import { isbnUrl, parseIsbn } from "./books.ts";
import { clipFileType } from "./clips.ts";

test("ISBN-13 and ISBN-10 are recognized with their check digits", () => {
  assert.equal(parseIsbn("978-0-306-40615-7"), "9780306406157");
  assert.equal(parseIsbn("ISBN: 0-306-40615-2"), "0306406152");
  assert.equal(parseIsbn("080442957X"), "080442957X");
  assert.equal(parseIsbn("9780306406158"), null);
  assert.equal(parseIsbn("The Overstory"), null);
  assert.equal(parseIsbn("12345"), null);
  assert.equal(isbnUrl("9780143039433"), "https://openlibrary.org/isbn/9780143039433");
});

test("PDFs and EPUBs are recognized by type or extension", () => {
  assert.equal(clipFileType("paper.pdf", "application/pdf"), "application/pdf");
  assert.equal(clipFileType("Book.EPUB", ""), "application/epub+zip");
  assert.equal(clipFileType("book.epub", "application/octet-stream"), "application/epub+zip");
  assert.equal(clipFileType("notes.txt", "text/plain"), null);
  assert.equal(clipFileType("trick.pdf", "text/html"), null);
});
