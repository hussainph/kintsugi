import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClipSummary } from "@kintsugi/core/clips";
import { ClipImages } from "../src/references/useReferenceSearch.ts";

const clip: ClipSummary = { path: "inspiration/craft.md", kind: "image", captured: "2026-10-29T14:05", tags: [], title: "Craft", site: null, url: null, author: null, image: "media/craft.png", summary: null, enriched: null, enrichError: null, via: "mac" };
const bytes = () => new Uint8Array([1, 2, 3]).buffer;

test("thumbnail metadata changes invalidate a reused path", async () => {
  let reads = 0;
  const cache = new ClipImages(() => {}, async () => { reads++; return bytes(); });
  const first = await cache.load(clip);
  assert.equal(await cache.load(clip), first);
  const second = await cache.load({ ...clip, image: "media/craft-2.png" });
  assert.notEqual(first, second);
  assert.equal(reads, 2);
  cache.dispose();
});

test("clip mutation invalidation handles trash/recreate even with identical minute metadata", async () => {
  let reads = 0;
  const cache = new ClipImages(() => {}, async () => { reads++; return bytes(); });
  const first = await cache.load(clip);
  cache.invalidate(clip.path);
  const second = await cache.load(clip);
  assert.notEqual(first, second);
  assert.equal(reads, 2);
  cache.prune([]);
  assert.equal(cache.get(clip.path), null);
  cache.dispose();
});

test("an old image request cannot resurrect an invalidated or unmounted thumbnail", async () => {
  let resolve!: (bytes: ArrayBuffer) => void;
  const cache = new ClipImages(() => {}, () => new Promise<ArrayBuffer>((done) => { resolve = done; }));
  const request = cache.load(clip);
  cache.dispose();
  resolve(bytes());
  assert.equal(await request, null);
  assert.equal(cache.get(clip.path), null);
});
