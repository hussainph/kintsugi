import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClipPreview } from "./api.ts";
import { capturedAt, imageCapture, MAX_IMAGE_BYTES, parseTags, textCapture } from "./capture.ts";
import { masonry } from "./layout.ts";

const preview = (path: string, image: string | null = null): ClipPreview => ({
  path, kind: image ? "image" : "note", captured: "2026-10-29T12:00", tags: [], title: null, url: null,
  site: null, author: null, image, summary: null, enriched: null, enrichError: null, via: "mac", text: "A thought to keep.",
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
