import assert from "node:assert/strict";
import { test } from "node:test";
import type { Impression, Source } from "./api.ts";
import { ago, health, Impressions, itemTitle, paragraphs, sourceName, webUrl } from "./model.ts";

const NOW = 1_800_000_000;
const source = (patch: Partial<Source> = {}): Source => ({
  id: 1, url: "https://www.quiet.example/feed.xml", kind: "feed", title: null, siteUrl: null, image: null, muted: false,
  addedAt: NOW, lastFetchAt: null, lastSuccessAt: null, lastStatus: null, lastError: null, failures: 0, nextFetchAt: 0, items: 0,
  ...patch,
});

test("times read as short ages", () => {
  assert.equal(ago(NOW - 10, NOW), "just now");
  assert.equal(ago(NOW - 5 * 60, NOW), "5m");
  assert.equal(ago(NOW - 3 * 3600, NOW), "3h");
  assert.equal(ago(NOW - 2 * 86400, NOW), "2d");
  assert.match(ago(NOW - 40 * 86400, NOW), /\w+ \d+/);
});

test("source health says when it worked, or why not and when it retries", () => {
  assert.deepEqual(health(source(), NOW), { tone: "waiting", label: "Not fetched yet" });
  assert.deepEqual(health(source({ lastSuccessAt: NOW - 600 }), NOW), { tone: "ok", label: "Updated 10m ago" });
  assert.deepEqual(health(source({ lastSuccessAt: NOW - 5 }), NOW), { tone: "ok", label: "Updated just now" });
  assert.deepEqual(health(source({ lastError: "HTTP 503", nextFetchAt: NOW + 300 }), NOW), { tone: "error", label: "HTTP 503 · retrying in 5m" });
  assert.equal(health(source({ muted: true, lastError: "x" }), NOW).tone, "muted");
  assert.equal(sourceName(source()), "quiet.example");
});

test("titles and links are safe to show and open", () => {
  assert.equal(itemTitle({ title: null, url: null, summary: "First line\nsecond" }), "First line");
  assert.equal(webUrl("javascript:alert(1)"), null);
  assert.equal(webUrl("https://quiet.example/a"), "https://quiet.example/a");
});

test("impressions are sent once per item per surface, in batches", async () => {
  const sent: Impression[][] = [];
  const impressions = new Impressions(async (batch) => void sent.push(batch), 10_000);
  impressions.add({ id: 1, position: 0, surface: "newest" });
  impressions.add({ id: 2, position: 1, surface: "newest" });
  impressions.add({ id: 1, position: 0, surface: "newest" });
  impressions.add({ id: 1, position: 3, surface: "picked" });
  await impressions.flush();
  await impressions.flush();
  assert.deepEqual(sent, [[
    { id: 1, position: 0, surface: "newest" },
    { id: 2, position: 1, surface: "newest" },
    { id: 1, position: 3, surface: "picked" },
  ]]);
  const failing = new Impressions(async () => { throw new Error("offline"); }, 10_000);
  failing.add({ id: 1, position: 0, surface: "newest" });
  await failing.flush();
});

test("reader paragraphs drop Markdown syntax but keep the words", () => {
  assert.deepEqual(paragraphs("# Title\n\nEvery *tool* is an [argument](https://x.example).\n\n![](https://x.example/a.png)\n\n- one\n- **two**"), [
    "Title",
    "Every tool is an argument.",
    "• one\n• two",
  ]);
});
