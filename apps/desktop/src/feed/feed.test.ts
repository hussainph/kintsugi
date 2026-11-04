import assert from "node:assert/strict";
import { test } from "node:test";
import type { Impression, Source } from "./api.ts";
import { footnoteLink, groupable, itemBlurb, readerDocument, readerHref, summarised, summaryLabel } from "./model.ts";
import { ago, catalogueStatus, citeLabel, health, Impressions, itemDate, itemSource, itemTitle, layoutFor, MAGAZINE_MIN_WIDTH, paragraphs, sourceIcon, sourceLogos, sourceName, sourcesLine, storyBlurb, storyCount, bySource, summaryNote, webUrl } from "./model.ts";

const NOW = 1_800_000_000;
const source = (patch: Partial<Source> = {}): Source => ({
  id: 1, url: "https://www.quiet.example/feed.xml", kind: "feed", title: null, siteUrl: null, image: null, muted: false,
  catalogueEnabled: true, catalogueState: "queued", catalogueCount: 0, catalogueError: null,
  addedAt: NOW, lastFetchAt: null, lastSuccessAt: null, lastStatus: null, lastError: null, failures: 0, nextFetchAt: 0, items: 0,
  grouping: false, groupingDefault: false,
  ...patch,
});

test("times read as short ages", () => {
  assert.equal(ago(NOW - 10, NOW), "just now");
  assert.equal(ago(NOW - 5 * 60, NOW), "5m");
  assert.equal(ago(NOW - 3 * 3600, NOW), "3h");
  assert.equal(ago(NOW - 2 * 86400, NOW), "2d");
  assert.match(ago(NOW - 40 * 86400, NOW), /\w+ \d+/);
});

test("catalogue progress is separate from polling and never invents an old date", () => {
  assert.equal(catalogueStatus(source()), "Waiting to fetch");
  assert.equal(catalogueStatus(source({ catalogueState: "discovering" })), "Finding older writing…");
  assert.equal(catalogueStatus(source({ catalogueState: "ready", catalogueCount: 240 })), "240 found");
  assert.equal(catalogueStatus(source({ catalogueState: "ready" })), "Nothing found");
  assert.equal(catalogueStatus(source({ catalogueState: "error", catalogueError: "HTTP 503" })), "HTTP 503");
  assert.equal(catalogueStatus(source({ catalogueEnabled: false })), "Off");
  assert.equal(itemDate({ backCatalogue: true, publishedAt: null, fetchedAt: NOW }), "Date unknown");
  assert.match(itemDate({ backCatalogue: true, publishedAt: 1136073600, fetchedAt: NOW }), /2006/);
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

test("sources show a podcast's artwork, a site's favicon, or their type icon", () => {
  assert.deepEqual(sourceLogos(source({ kind: "podcast", image: "https://cdn.example/art.jpg" })), ["https://cdn.example/art.jpg"]);
  assert.deepEqual(sourceLogos(source({ kind: "podcast" })), []);
  assert.deepEqual(sourceLogos(source()), ["https://www.quiet.example/favicon.ico"]);
  assert.deepEqual(
    sourceLogos(source({ siteUrl: "https://blog.example/posts/", image: "https://blog.example/logo.png" })),
    ["https://blog.example/favicon.ico", "https://blog.example/logo.png"],
  );
  assert.deepEqual(sourceLogos(source({ kind: "page", url: "https://site.example/changelog", image: "https://site.example/og.png" })), ["https://site.example/favicon.ico"]);
  assert.deepEqual(sourceLogos(source({ url: "file:///etc/passwd", image: "javascript:alert(1)" })), []);
  for (const kind of ["hn", "youtube", "x", "author"] as const) assert.deepEqual(sourceLogos(source({ kind, image: "https://img.example/a.png" })), []);
});

test("the magazine needs room; narrower, the Feed becomes tabs", () => {
  assert.equal(MAGAZINE_MIN_WIDTH, 960);
  assert.equal(layoutFor(1180), "magazine");
  assert.equal(layoutFor(960), "magazine");
  assert.equal(layoutFor(959), "tabs");
});

test("stories count sources, name two, and HN items name the site they link to", () => {
  assert.equal(sourcesLine([{ title: "The Verge" }]), "The Verge");
  assert.equal(sourcesLine([{ title: "The Verge" }, { title: "Ars Technica" }]), "The Verge, Ars Technica");
  assert.equal(sourcesLine([{ title: "A", items: 5 }, { title: "B", items: 1 }, { title: "C", items: 1 }]), "7 articles from 3 sources");
  assert.equal(storyCount([{ items: 1 }, { items: 1 }]), "2 articles from 2 sources");
  // Tiles keep each source's articles together, the most-covered source first.
  const items = [{ id: 1, sourceId: 9 }, { id: 2, sourceId: 5 }, { id: 3, sourceId: 9 }, { id: 4, sourceId: 7 }, { id: 5, sourceId: 5 }];
  assert.deepEqual(bySource(items, [{ id: 5 }, { id: 9 }, { id: 7 }]).map((i) => i.id), [2, 5, 1, 3, 4]);
  assert.deepEqual(itemSource({ sourceTitle: "Hacker News", sourceKind: "hn", url: "https://www.apple.com/newsroom/x" }), { name: "apple.com", via: "Hacker News" });
  assert.deepEqual(itemSource({ sourceTitle: "The Verge", sourceKind: "feed", url: null }), { name: "The Verge", via: null });
  assert.equal(sourceIcon({ title: "The Verge", kind: "feed", site: "https://www.theverge.com/rss" }), "https://www.theverge.com/favicon.ico");
  assert.equal(sourceIcon({ title: "HN", kind: "hn", site: "https://hnrss.org/frontpage" }), null);
  assert.equal(sourceIcon({ title: "Bad", kind: "feed", site: "javascript:alert(1)" }), null);
});

test("citations name their source, and a story without a summary says why", () => {
  const items = [
    { id: 1, sourceTitle: "9to5Mac", sourceKind: "feed" as const, url: null },
    { id: 2, sourceTitle: "The Verge", sourceKind: "feed" as const, url: null },
  ];
  assert.equal(citeLabel([1], items), "9to5mac");
  assert.equal(citeLabel([2, 1], items), "verge +1");
  assert.equal(citeLabel([9], items), null);
  assert.equal(summaryNote("ready"), null);
  assert.match(summaryNote("capped")!, /AI limit/);
  assert.match(summaryNote("failed")!, /first article/);
  const lead = { summary: "The lead's own words.", excerpt: null };
  assert.equal(storyBlurb({ summary: null, lead }), "The lead's own words.");
  assert.equal(storyBlurb({ summary: { paragraphs: [[{ text: "One." }, { text: "Two." }]] }, lead }), "One. Two.");
});

test("cards show the author's own opening, and only Kin's summary carries the mark", () => {
  assert.equal(itemBlurb({ title: "A bowl", excerpt: "I mended a bowl.", summary: "Feed summary" }), "I mended a bowl.");
  assert.equal(itemBlurb({ title: "A bowl", excerpt: null, summary: "Feed summary" }), "Feed summary");
  assert.equal(itemBlurb({ title: "Same", excerpt: null, summary: "Same" }), null);
  assert.equal(storyBlurb({ summary: null, lead: { summary: "Feed", excerpt: "Opening." } }), "Opening.");
  assert.equal(summarised({ summary: null }), false);
  assert.equal(summarised({ summary: { paragraphs: [] } }), false);
  assert.equal(summarised({ summary: { paragraphs: [[]] } }), true);
  assert.equal(summaryLabel([1, 2, 3]), "Kin’s summary of 3 sources");
  assert.equal(groupable("feed"), true);
  assert.equal(groupable("page"), false);
  assert.equal(groupable("author"), false);
});

test("the reader keeps an article's structure and only web links", () => {
  const doc = readerDocument(
    [
      "# Mending a bowl",
      "I spent the weekend on it.[^1]",
      "## The lacquer",
      "> Patience is the material.",
      "- Sand\n- Coat\n  1. Wait",
      "![A cracked bowl](https://x.example/bowl.png)",
      "*The bowl after the third coat.*",
      "```js\nmend(bowl)\n```",
      "<script>alert(1)</script>",
      "[^1]: Three days, between coats.",
    ].join("\n\n"),
    "Mending a bowl",
  );
  assert.deepEqual(
    doc.blocks.map((b) => b.t),
    ["p", "h", "quote", "list", "figure", "code"],
  );
  const figure = doc.blocks.find((b) => b.t === "figure");
  assert.equal(figure?.t === "figure" && figure.caption, "The bowl after the third coat.");
  assert.equal(doc.notes.length, 1);
  assert.equal(doc.notes[0].id, "1");
  assert.equal(JSON.stringify(doc).includes("script"), false, "no raw HTML");
  // As the ingest writes a <figure>, and a footnote's marks.
  const ingested = readerDocument("![A ledger](https://x.example/l.jpg)My ledger, the analogue version.\n\nText.[1](#fn:1)");
  assert.deepEqual(ingested.blocks[0], { t: "figure", src: "https://x.example/l.jpg", alt: "A ledger", caption: "My ledger, the analogue version." });
  assert.equal(footnoteLink("#fn:1", "1"), "ref");
  assert.equal(footnoteLink("#fnref:1", "↩"), "back");
  assert.equal(footnoteLink("https://x.example/#1", "1"), null);
  assert.equal(readerHref("/b.png", "https://x.example/post/"), "https://x.example/b.png");
  assert.equal(readerHref("#fn1", "https://x.example/post/"), null);
  assert.equal(readerHref("javascript:alert(1)", null), null);
  assert.equal(readerHref("https://x.example/", null), "https://x.example/");
});
