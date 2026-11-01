import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_CLIP_FILE_BYTES } from "@kintsugi/core/clips";
import { clipFileLabel, clipLabel, clipSite, type ClipPreview } from "./api.ts";
import { anyFileCapture, bookByline, bookCapture, bytesToBase64, capturedAt, fileCapture, fileFields, imageCapture, MAX_IMAGE_BYTES, parseTags, textCapture } from "./capture.ts";
import { masonry } from "./layout.ts";
import { searchWindow } from "./pagination.ts";

const preview = (path: string, image: string | null = null): ClipPreview => ({
  path, kind: image ? "image" : "note", captured: "2026-10-29T12:00", tags: [], title: null, url: null,
  site: null, author: null, image, file: null, summary: null, enriched: null, enrichError: null, via: "mac", text: "A thought to keep.",
});

test("a whole HTTP URL is a link; ordinary text and non-web schemes stay notes", () => {
  assert.equal(textCapture(" https://example.com/a?q=1 ")?.url, "https://example.com/a?q=1");
  assert.equal(textCapture("http://example.com")?.via, "mac");
  for (const text of ["A thought with https://example.com in it", "file:///private/secret", "javascript:alert(1)", "https://example.com a passage"]) {
    assert.equal(textCapture(text)?.text, text);
    assert.equal(textCapture(text)?.url, undefined);
  }
  assert.equal(textCapture(" \n "), null);
});

test("capture time is local, minute-precision and padded", () => {
  assert.equal(capturedAt(new Date(2026, 0, 2, 3, 4, 59)), "2026-01-02T03:04");
});

test("tag edits normalize, deduplicate and allow clearing", () => {
  assert.deepEqual(parseTags(" #Craft, attention, CRAFT, ,  writing life "), ["craft", "attention", "writing life"]);
  assert.deepEqual(parseTags(" , "), []);
});

test("image capture passes bytes, rejects SVG, empty and oversized images", async () => {
  const capture = await imageCapture(new File([new Uint8Array([1, 2, 3])], "photo.png", { type: "image/png" }));
  assert.deepEqual(capture.image, [1, 2, 3]);
  assert.equal(capture.imageType, "image/png");
  assert.equal((await imageCapture(new File(["bytes"], "photo.HEIC"))).imageType, "image/heic");
  await assert.rejects(imageCapture(new File(["<svg/>"], "x.svg", { type: "image/svg+xml" })), /Choose/);
  await assert.rejects(imageCapture(new File([], "x.png", { type: "image/png" })), /empty/);
  await assert.rejects(imageCapture(new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], "x.png", { type: "image/png" })), /15 MiB/);
});

test("masonry is stable, retains newest-first DOM order, and never overlaps", () => {
  const items = Array.from({ length: 5000 }, (_, i) => preview(`inspiration/${i}.md`, i % 3 ? "media/a.png" : null));
  for (const width of [280, 500, 920, 1440]) {
    const result = masonry(items, width);
    assert.equal(result.tiles.length, 5000);
    assert.deepEqual(result.tiles.map((tile) => tile.clip.path), items.map((clip) => clip.path));
    const previous = new Map<number, number>();
    for (const tile of result.tiles) {
      assert.ok(tile.width > 0 && tile.x + tile.width <= width + 0.01);
      assert.ok(tile.y >= (previous.get(tile.x) ?? 0));
      previous.set(tile.x, tile.y + tile.height);
      assert.ok(tile.y + tile.height <= result.height);
    }
    assert.deepEqual(masonry(items, width), result);
  }
  assert.equal(masonry([], 900).height, 0);
});

test("live refresh retains the loaded window within server pagination limits", async () => {
  const items = Array.from({ length: 301 }, (_, i) => preview(`inspiration/${i}.md`));
  const calls: { offset: number; limit: number }[] = [];
  const search = async ({ offset = 0, limit = 60 }) => {
    calls.push({ offset, limit });
    return { clips: items.slice(offset, offset + limit), total: items.length, tags: ["craft"] };
  };
  const result = await searchWindow(search, {}, 240);
  assert.equal(result?.clips.length, 240);
  assert.equal(result?.total, 301);
  assert.deepEqual(calls, [{ offset: 0, limit: 120 }, { offset: 120, limit: 120 }]);
  assert.deepEqual((await searchWindow(search, {}, 400))?.clips, items);
  assert.equal(await searchWindow(search, {}, 240, () => false), undefined);
});

test("file capture detects PDFs and EPUBs by type or extension and round-trips base64", async () => {
  const bytes = new Uint8Array(100_000).map((_, i) => (i * 7919) % 256);
  const pdf = await fileCapture(new File([bytes], "My Paper.pdf", { type: "application/pdf" }));
  assert.equal(pdf.fileType, "application/pdf");
  assert.equal(pdf.fileName, "My Paper.pdf");
  assert.equal(pdf.via, "mac");
  assert.equal(pdf.image, undefined);
  assert.deepEqual(new Uint8Array(Buffer.from(pdf.file!, "base64")), bytes);
  assert.equal((await fileCapture(new File(["x"], "novel.EPUB"))).fileType, "application/epub+zip");
  assert.equal((await fileCapture(new File(["x"], "novel.epub", { type: "application/zip" }))).fileType, "application/epub+zip");
  assert.equal((await fileCapture(new File(["x"], "scan.pdf", { type: "application/octet-stream" }))).fileType, "application/pdf");
});

test("file capture rejects other types, empty files and files over 50 MiB", async () => {
  await assert.rejects(fileCapture(new File(["x"], "notes.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })), /PDF or an EPUB/);
  await assert.rejects(fileCapture(new File(["x"], "fake.pdf", { type: "text/html" })), /PDF or an EPUB/);
  await assert.rejects(fileCapture(new File([], "empty.pdf")), /empty/);
  await assert.rejects(fileCapture(new File([new Uint8Array(MAX_CLIP_FILE_BYTES + 1)], "big.pdf")), /50 MiB/);
});

test("base64 matches Node's encoder across chunk boundaries", () => {
  for (const length of [0, 1, 2, 3, 0x8000 - 1, 0x8000, 0x8000 + 1, 3 * 0x8000 + 5]) {
    const bytes = new Uint8Array(length).map((_, i) => (i * 31 + 7) % 256);
    assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString("base64"));
  }
});

test("dropped files route to file or image capture, and merge over a link", async () => {
  assert.equal((await anyFileCapture(new File(["x"], "a.pdf"))).fileType, "application/pdf");
  assert.equal((await anyFileCapture(new File(["x"], "a.png"))).imageType, "image/png");
  await assert.rejects(anyFileCapture(new File(["x"], "a.zip", { type: "application/zip" })), /image, a PDF or an EPUB/);
  const pdf = await fileCapture(new File(["x"], "a.pdf"));
  assert.deepEqual(Object.keys(fileFields(pdf)).sort(), ["file", "fileName", "fileType"]);
  assert.deepEqual(Object.keys(fileFields(await imageCapture(new File(["x"], "a.png")))).sort(), ["image", "imageType"]);
});

test("books save their Open Library URL and title; bylines stay short", () => {
  const book = bookCapture({ url: "https://openlibrary.org/works/OL59800W", title: "The Left Hand of Darkness" });
  assert.equal(book.url, "https://openlibrary.org/works/OL59800W");
  assert.equal(book.title, "The Left Hand of Darkness");
  assert.equal(book.via, "mac");
  assert.equal("title" in bookCapture({ url: "https://openlibrary.org/isbn/0441478123" }), false);
  assert.equal(bookByline({ authors: ["Ursula K. Le Guin"], year: 1969 }), "Ursula K. Le Guin · 1969");
  assert.equal(bookByline({ authors: [], year: null }), "");
  assert.equal(bookByline({ authors: ["A", "B", "C", "D"], year: 2001 }), "A, B, C and others · 2001");
});

test("documents and books have labels and an open-file action only with a file", () => {
  assert.equal(clipLabel({ title: null, url: null, kind: "document" }), "A PDF");
  assert.equal(clipLabel({ title: null, url: null, kind: "book" }), "A book");
  assert.equal(clipSite({ site: null, url: null, kind: "document" }), "PDF");
  assert.equal(clipSite({ site: null, url: null, kind: "book" }), "Book");
  assert.equal(clipSite({ site: null, url: "https://openlibrary.org/works/OL1W", kind: "book" }), "openlibrary.org");
  assert.equal(clipFileLabel({ file: "files/paper.pdf", kind: "document" }), "PDF");
  assert.equal(clipFileLabel({ file: "files/novel.epub", kind: "book" }), "book");
  assert.equal(clipFileLabel({ file: null, kind: "book" }), null);
});
