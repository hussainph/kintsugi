// Recorded PG and Jason Cohen indexes against the real headless app. No live
// network, provider credentials or owner's data. Discovery must stay lazy.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { DatabaseSync } from "node:sqlite";
import { startApp, openApp, root, type App } from "./headless-app.ts";
import type { FeedItem, Source } from "../src/feed/api.ts";

const TIMEOUT = 15 * 60_000;
let app: App;
let browser: Browser;
let page: Page;
const fixtures: { base: string; requests: string[]; close: () => Promise<void> }[] = [];
const fixture = (name: string) => readFileSync(resolve(root, "crates/ingest/fixtures/catalogue", name), "utf8");

async function serve(kind: "pg" | "cohen") {
  let base = "";
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url!, "http://fixture").pathname;
    requests.push(path);
    const send = (body: string, type: string) => { response.setHeader("Content-Type", type); response.end(body); };
    if (path === "/robots.txt") return send("User-agent: *\nAllow: /\n", "text/plain");
    if (kind === "pg" && ["/", "/articles.html"].includes(path)) return send(fixture("pg-articles.html").replace("<html>", "<html><head><title>Paul Graham</title></head>"), "text/html");
    if (kind === "cohen" && path === "/index.xml") return send(fixture("cohen-longform-feed.xml").replaceAll("https://longform.asmartbear.com", base), "application/rss+xml");
    if (kind === "cohen" && path === "/") return send(`<html><head><title>A Smart Bear</title><link rel="alternate" type="application/rss+xml" href="${base}/index.xml"></head><body><a href="/sitemap.xml">Sitemap</a></body></html>`, "text/html");
    if (["/greatwork.html", "/kids.html", "/selfindulgence.html", "/value-time/", "/confidence/"].includes(path)) return send(`<html><head><title>Original article</title><meta property="article:published_time" content="2006-01-01T00:00:00Z"></head><body><article><h1>Original article</h1><p>${"The original article text is fetched only when reading. ".repeat(25)}</p></article></body></html>`, "text/html");
    response.statusCode = 404;
    response.end("Not found");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const result = { base, requests, close: () => new Promise<void>((done) => server.close(() => done())) };
  fixtures.push(result);
  return result;
}

async function invoke<T>(cmd: string, args: object = {}): Promise<T> {
  return page.evaluate(({ cmd, args }) => (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: object) => Promise<T> } }).__TAURI_INTERNALS__.invoke(cmd, args), { cmd, args });
}
async function until<T>(read: () => Promise<T>, check: (value: T) => boolean): Promise<T> {
  let last: T;
  const end = Date.now() + 120_000;
  do {
    last = await read();
    if (check(last)) return last;
    await new Promise((done) => setTimeout(done, 100));
  } while (Date.now() < end);
  assert.fail(`Catalogue state did not settle: ${JSON.stringify(last!)}`);
}

before(async () => {
  app = await startApp("ki95", {});
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: "light" });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
  await openApp(page, app.url, app.output);
}, { timeout: TIMEOUT });
after(async () => { await browser?.close(); await app?.stop(); for (const f of fixtures) await f.close(); });

test("older writing is discovered once, admitted slowly, dated, lazy and optional", { timeout: TIMEOUT }, async () => {
  const cohen = await serve("cohen");
  const pg = await serve("pg");
  const first = await invoke<{ source: Source }>("feed_subscribe", { input: { kind: "url", url: `${cohen.base}/index.xml` } });
  await until(() => invoke<Source[]>("feed_sources"), (sources) => sources.some((s) => s.id === first.source.id && s.catalogueState === "ready"));
  const second = await invoke<{ source: Source }>("feed_subscribe", { input: { kind: "page", url: `${pg.base}/articles.html` } });
  const sources = await until(() => invoke<Source[]>("feed_sources"), (sources) => sources.some((s) => s.id === second.source.id && s.catalogueState === "ready"));
  assert.ok(sources.find((s) => s.id === second.source.id)!.catalogueCount >= 3);
  const listed = await invoke<{ items: FeedItem[] }>("feed_items");
  const old = listed.items.filter((item) => item.backCatalogue);
  assert.equal(old.length, 2);
  assert.ok(old.every((item) => item.publishedAt != null && item.publishedAt < item.fetchedAt - 30 * 86400));
  assert.equal(cohen.requests.includes("/value-time/"), false, "metadata discovery never fetches a full article");
  assert.equal(pg.requests.includes("/greatwork.html"), false);
  const scans = pg.requests.filter((path) => path === "/articles.html").length;
  await invoke("feed_refresh", { id: second.source.id });
  assert.equal(pg.requests.filter((path) => path === "/articles.html").length, scans + 1, "refresh polls the watched page, but does not scan its archive again");
  const db = new DatabaseSync(resolve(app.config, "feed.sqlite"), { readOnly: true });
  try { assert.equal((db.prepare("SELECT COUNT(*) AS n FROM catalogue_releases").get() as { n: number }).n, 2); } finally { db.close(); }

  await page.getByRole("button", { name: "Feed", exact: true }).first().click();
  await page.getByRole("button", { name: "Following", exact: true }).click();
  await page.getByRole("switch", { name: "Older writing from A Smart Bear" }).waitFor();
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.locator(`[data-graphical-theme][data-color-mode="${colorScheme}"]`).first().waitFor();
    await page.screenshot({ path: resolve(app.shots, `catalogue-sources-${colorScheme}.png`), animations: "disabled" });
  }
  await page.keyboard.press("Escape");
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.locator(`[data-graphical-theme][data-color-mode="${colorScheme}"]`).first().waitFor();
    await page.screenshot({ path: resolve(app.shots, `catalogue-feed-${colorScheme}.png`), animations: "disabled" });
  }
  await invoke("feed_catalogue", { id: first.source.id, enabled: false });
  const off = await invoke<{ items: FeedItem[] }>("feed_items");
  assert.ok(off.items.every((item) => !item.backCatalogue));
  assert.ok(off.items.some((item) => item.sourceId === first.source.id), "new posts are not muted");
  await invoke("feed_catalogue", { id: first.source.id, enabled: true });
  const read = await invoke<{ item: FeedItem; text: string }>("feed_read", { id: old.find((item) => item.url?.includes("/value-time/"))?.id ?? old[0].id });
  assert.match(read.text, /original article text/i);
  assert.equal(read.item.publishedAt, old.find((item) => item.id === read.item.id)!.publishedAt, "lazy reads preserve the known original date");
  assert.equal(read.item.title, old.find((item) => item.id === read.item.id)!.title, "lazy reads preserve the feed's actual title");
});

test("a conservative neighbour explains its link and follows the discovered feed", { timeout: TIMEOUT }, async () => {
  const neighbour = await serve("cohen");
  const sources = await invoke<Source[]>("feed_sources");
  const anchorSource = sources.find((source) => source.title === "A Smart Bear")!;
  // Isolate this fixture's next-day admission from the earlier archive pool.
  for (const source of sources) await invoke("feed_catalogue", { id: source.id, enabled: false });
  const title = "What is the value of one hour of a startup founder's time?";
  const db = new DatabaseSync(resolve(app.config, "feed.sqlite"));
  let anchor = 0;
  try {
    db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
    // Clock fixture only: real UTC-day and restart quotas are covered in Rust.
    db.exec("UPDATE catalogue_releases SET day = day - 1");
    const now = Math.floor(Date.now() / 1000);
    const insert = db.prepare("INSERT INTO items (source_id, guid, url, url_key, title, content, media, published_at, fetched_at, sort_at, liked_at) VALUES (?, ?, ?, ?, ?, ?, 'article', ?, ?, ?, ?)");
    for (const n of [1, 2]) {
      const url = `${anchorSource.url}/neighbour-anchor-${n}`;
      const result = insert.run(anchorSource.id, `neighbour-anchor-${n}`, url, url, n === 1 ? title : `${title} Notes`, `${title}\n\n[${title}](${neighbour.base}/value-time/)`, now, now, now, now);
      const id = Number(result.lastInsertRowid);
      if (n === 1) anchor = id;
      db.prepare("INSERT INTO events (at, kind, item_id, source_id, surface) VALUES (?, 'like', ?, ?, 'newest')").run(Date.now(), id, anchorSource.id);
    }
    db.exec("COMMIT");
  } finally { db.close(); }
  await invoke("feed_note", { id: anchor, note: "Worth reading" });
  const suggestion = await until(async () => {
    const db = new DatabaseSync(resolve(app.config, "feed.sqlite"), { readOnly: true });
    try { return db.prepare("SELECT id FROM items WHERE url = ? AND catalogue_released_at IS NOT NULL").get(`${neighbour.base}/value-time/`) as { id: number } | undefined; }
    finally { db.close(); }
  }, (item) => !!item);
  assert.equal(neighbour.requests.length, 0, "neighbour discovery uses stored links, without a crawl");
  const row = page.getByRole("feed", { name: "Newest first" }).locator(`article[data-feed-item="${suggestion!.id}"]`);
  await row.getByRole("button", { name: "Follow", exact: true }).waitFor();
  await row.getByRole("button", { name: "About this suggestion" }).click();
  await page.getByText(/^Linked from /).first().waitFor();
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.locator(`[data-graphical-theme][data-color-mode="${colorScheme}"]`).first().waitFor();
    await page.screenshot({ path: resolve(app.shots, `catalogue-neighbour-${colorScheme}.png`), animations: "disabled" });
  }
  await page.keyboard.press("Escape");
  await row.getByRole("button", { name: "Follow", exact: true }).click();
  const followed = await until(() => invoke<Source[]>("feed_sources"), (sources) => sources.some((source) => source.url === `${neighbour.base}/index.xml`));
  const source = followed.find((source) => source.url === `${neighbour.base}/index.xml`)!;
  const reading = await invoke<{ item: FeedItem }>("feed_read", { id: suggestion!.id });
  assert.equal(reading.item.sourceId, source.id);
  assert.equal(reading.item.suggestion, null);
  assert.ok(neighbour.requests.includes("/index.xml"), "Follow resolves the site's real feed");
});
