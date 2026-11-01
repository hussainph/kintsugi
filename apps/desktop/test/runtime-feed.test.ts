// KI-25 end to end against the real runtime: `pnpm desktop:headless` (the real
// Rust command registry on Tauri MockRuntime, and the real React app) driven
// by headless Chromium. Feeds come from a loopback fixture server, never the
// live network; the vault and config are fresh scratch folders under .headless/.
//
// Subscribe, poll, read, act (like / note / save / Not interested / mute),
// save into Inspiration (via: feed, note and source travel), OPML round-trip,
// and the event log. KI-32: Picked for you (cold start from the seeded clips,
// Why this? corrections with undo, what a like changed), and Kin reading a
// feed item and calling the ranking tools through the headless mock model.
// KI-43: watched pages and followed authors (Google Books is the fixture
// server, through KINTSUGI_HEADLESS_BOOKS). Screenshots land in
// .headless/feed-shots/.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { BLOG_TITLES, WORKSHOP, startFeedFixtures, type Fixtures } from "./feed-fixtures.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const TIMEOUT = Number(process.env.KINTSUGI_RUNTIME_TIMEOUT ?? 15 * 60_000);
const shots = resolve(root, ".headless/feed-shots");

let runner: ChildProcess;
let browser: Browser;
let page: Page;
let fixtures: Fixtures;
let url = "";
let vault = "";
let config = "";
let output = "";

const freePort = () =>
  new Promise<number>((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });

const shot = (name: string) => page.screenshot({ path: resolve(shots, `${name}.png`) });

before(async () => {
  mkdirSync(shots, { recursive: true });
  fixtures = await startFeedFixtures();
  const scratch = mkdtempSync(resolve(root, ".headless/ki25-"));
  vault = resolve(scratch, "vault");
  config = resolve(scratch, "config");
  const seeded = spawnSync(process.execPath, [resolve(root, "scripts/seed-desktop.mjs"), vault], { encoding: "utf8" });
  assert.equal(seeded.status, 0, seeded.stderr);

  const [frontend, backend] = [await freePort(), await freePort()];
  runner = spawn(process.execPath, [resolve(root, "scripts/desktop-headless.mjs")], {
    cwd: root,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      KINTSUGI_VAULT: vault,
      KINTSUGI_CONFIG_DIR: config,
      KINTSUGI_FRONTEND_PORT: String(frontend),
      KINTSUGI_BACKEND_PORT: String(backend),
      // Kin's scripted local model: no provider, no credentials, no cost.
      KINTSUGI_HEADLESS_KIN: "mock",
      KINTSUGI_HEADLESS_BOOKS: `${fixtures.base}/`,
    },
  });
  url = await new Promise<string>((done, fail) => {
    const seen = (chunk: Buffer) => {
      output += chunk;
      const found = /^(http:\/\/127\.0\.0\.1:\d+\/#headless=\S+)$/m.exec(output);
      if (found) done(found[1]);
    };
    runner.stdout!.on("data", seen);
    runner.stderr!.on("data", (chunk) => (output += chunk));
    runner.once("exit", (code) => fail(new Error(`desktop:headless exited (${code}):\n${output.slice(-4000)}`)));
  });
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${frontend}/`)).ok) break;
    } catch {
      if (i > 600) throw new Error(`frontend never started:\n${output.slice(-4000)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  browser = await chromium.launch({ headless: true }).catch((e) => {
    throw new Error(`${e}\nInstall it with: pnpm --filter @kintsugi/desktop exec playwright install chromium-headless-shell`);
  });
  page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  // Only loopback: the app and the fixture feeds. Anything else would be the
  // live network (a YouTube link, say), which a test must never reach.
  await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
  await page.goto(url);
}, { timeout: TIMEOUT });

after(async () => {
  await browser?.close();
  await fixtures?.close();
  if (runner?.pid) {
    try {
      process.kill(-runner.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
});

// The newest-first list; Picked for you (KI-32) shows some of the same items above it.
const newest = () => page.getByRole("feed", { name: "Newest first" });
const picked = () => page.getByRole("region", { name: "Picked for you" });
const feedItems = () => newest().locator("[data-feed-item]");
const item = (title: string) => newest().locator("article[data-feed-item]", { has: page.getByRole("button", { name: title, exact: true }) });
const pick = (title: string) => picked().locator("article[data-feed-item]", { has: page.getByRole("button", { name: title, exact: true }) });
const db = () => new DatabaseSync(resolve(config, "feed.sqlite"), { readOnly: true });
const events = (kind: string) => db().prepare("SELECT * FROM events WHERE kind = ? ORDER BY id").all(kind) as Record<string, unknown>[];
/** Waits for state the app writes in the background (the event log), never a fixed time. */
async function until(check: () => boolean, what: () => string, ms = 30_000) {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    try {
      if (check()) return;
    } catch {
      // Not there yet.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(what());
}
const titles = async () => (await feedItems().locator("h2").allInnerTexts()).map((t) => t.trim());

async function follow(tab: string, value: string, expect: RegExp) {
  await page.getByRole("tab", { name: tab }).click();
  const field = page.getByRole("form", { name: "Follow something" }).getByRole("textbox").first();
  await field.fill(value);
  await page.getByRole("form", { name: "Follow something" }).getByRole("button", { name: "Follow" }).click();
  await page.getByText(expect).first().waitFor();
}

test("follow sources and read them newest first", { timeout: TIMEOUT }, async () => {
  await page.getByRole("button", { name: "Feed" }).first().click();
  await page.getByText("Follow a few good sources.").waitFor();
  await shot("01-empty");

  await page.getByRole("button", { name: "Follow something" }).click();
  // A page URL: the feed is discovered from its <link rel="alternate">.
  await follow("Link", `${fixtures.base}/quiet/`, /Following The Quiet Blog/);
  await follow("Link", `${fixtures.base}/craft.atom`, /Following Slow Craft/);
  await follow("Link", `${fixtures.base}/pod.xml`, /Following Repair Hour/);
  await follow("Link", `${fixtures.base}/broken.xml`, /didn’t load/);
  const sources = page.getByRole("list", { name: "Sources" });
  await sources.getByRole("listitem", { name: "Slow Craft" }).locator('[data-health="ok"]').waitFor();
  const broken = sources.getByRole("listitem").filter({ hasText: "127.0.0.1" });
  assert.match(await broken.locator('[data-health="error"]').innerText(), /HTTP 503 · retrying in \d+m/);
  await shot("02-following");
  await page.keyboard.press("Escape");

  await feedItems().first().waitFor();
  assert.deepEqual(await titles(), [BLOG_TITLES[0], "Hand-cut dovetails, slowly", BLOG_TITLES[1], "Episode 12: Mending", BLOG_TITLES[2]]);
  assert.match(await page.getByRole("status").first().innerText(), /5 items/);
  assert.match(await page.getByText(/need(s)? attention/).innerText(), /1 needs attention/);

  // Read in the app: full text from the feed, scripts dropped.
  await newest().getByRole("button", { name: BLOG_TITLES[0], exact: true }).click();
  const reading = newest().getByRole("region", { name: `Reading ${BLOG_TITLES[0]}` });
  await reading.getByText(/the essay is what survives the argument/).waitFor();
  // The feed carried an excerpt; the full article came through the ingest engine.
  await reading.getByText(/only on the page, never in the feed/).waitFor();
  assert.doesNotMatch(await reading.innerText(), /alert/);
  await shot("03-feed-reading");

  // Impressions were logged with their positions (sent in batches, 1.5 s after the first).
  const newestSeen = () => events("impression").filter((e) => e.surface === "newest");
  await until(() => newestSeen().length >= 3, () => `impressions: ${JSON.stringify(newestSeen())}`);
  const seen = newestSeen();
  assert.deepEqual(seen.slice(0, 3).map((e) => [e.position, e.surface]), [[0, "newest"], [1, "newest"], [2, "newest"]]);
  await until(() => events("open").length >= 1, () => "the open is logged");
  assert.equal(events("open").length, 1);
});

test("like, note, save into Inspiration, not interested", { timeout: TIMEOUT }, async () => {
  const tools = item(BLOG_TITLES[0]);
  await tools.getByRole("button", { name: "Like" }).click();
  await tools.getByRole("button", { name: "Liked" }).waitFor();
  assert.equal(await tools.getByRole("button", { name: "Liked" }).getAttribute("aria-pressed"), "true");
  await page.getByRole("button", { name: "Undo" }).first().click();
  await tools.getByRole("button", { name: "Like", exact: true }).waitFor();
  await tools.getByRole("button", { name: "Like", exact: true }).click();
  await tools.getByRole("button", { name: "Liked" }).waitFor();

  const mending = item(BLOG_TITLES[1]);
  await mending.getByRole("button", { name: "Note" }).click();
  await mending.getByRole("textbox", { name: `Note on ${BLOG_TITLES[1]}` }).fill("Pair this with the bowl essay. Repair as argument.");
  await shot("04-note");
  // Saving flushes the note first, and the note travels with the clip.
  await mending.getByRole("button", { name: "Save" }).click();
  await mending.getByRole("button", { name: "Saved · Open" }).waitFor();
  await page.getByText("Saved to Inspiration").first().waitFor();

  const clips = readdirSync(resolve(vault, "inspiration")).filter((f) => f.endsWith(".md"));
  const saved = clips.find((f) => readFileSync(resolve(vault, "inspiration", f), "utf8").includes("/quiet/posts/mending"));
  assert.ok(saved, `no clip for the saved item in ${clips.join(", ")}`);
  const clip = readFileSync(resolve(vault, "inspiration", saved), "utf8");
  assert.match(clip, /^via: "?feed"?$/m);
  assert.match(clip, /^title: "?On mending"?$/m);
  assert.match(clip, /^site: "?The Quiet Blog"?$/m);
  assert.match(clip, /Pair this with the bowl essay\. Repair as argument\./);
  assert.match(clip, /<!-- kintsugi:source -->[\s\S]*Kintsugi makes the break the most beautiful part/);
  // Saving again is idempotent: no second clip.
  await mending.getByRole("button", { name: "Saved · Open" }).click();
  await page.getByRole("region", { name: "Inspiration library" }).or(page.getByRole("button", { name: "Back" })).first().waitFor();
  await page.getByText(/Pair this with the bowl essay/).first().waitFor();
  await shot("05-saved-clip-in-inspiration");
  assert.equal(readdirSync(resolve(vault, "inspiration")).filter((f) => f.endsWith(".md")).length, clips.length);

  await page.getByRole("button", { name: "Feed" }).first().click();
  const small = item(BLOG_TITLES[2]);
  await small.getByRole("button", { name: "Not interested" }).click();
  await small.waitFor({ state: "detached" });
  assert.equal((await titles()).includes(BLOG_TITLES[2]), false);
  assert.match(await page.getByRole("status").first().innerText(), /4 items/);

  // Discuss opens Kin's chat with the item attached as a context chip.
  await item("Episode 12: Mending").getByRole("button", { name: "Discuss" }).click();
  await page.getByRole("dialog", { name: "Kin" }).getByText("Episode 12: Mending").first().waitFor();
  await shot("06b-discuss");
  await page.keyboard.press("Escape");

  const kinds = (db().prepare("SELECT kind FROM events WHERE kind <> 'impression' ORDER BY id").all() as { kind: string }[]).map((e) => e.kind);
  for (const kind of ["subscribe", "open", "like", "unlike", "note", "save", "not_interested", "discuss"]) assert.ok(kinds.includes(kind), `${kind} in ${kinds}`);
  const save = events("save")[0];
  assert.equal(save.surface, "newest");
  assert.equal(save.position, 2);
  await shot("06-acted");
});

test("mute a source, and round-trip subscriptions as OPML", { timeout: TIMEOUT }, async () => {
  await page.getByRole("button", { name: "Following" }).click();
  const sources = page.getByRole("list", { name: "Sources" });
  await sources.getByRole("switch", { name: "Mute Slow Craft" }).click();
  await sources.getByRole("switch", { name: "Unmute Slow Craft" }).waitFor();
  await page.keyboard.press("Escape");
  await item("Hand-cut dovetails, slowly").waitFor({ state: "detached" });

  // Export through the save dialog (an in-page prompt in headless mode).
  const exported = resolve(config, "subscriptions.opml");
  await page.getByRole("button", { name: "Following" }).click();
  await page.getByRole("button", { name: "Export OPML" }).click();
  const prompt = page.locator("dialog[data-headless-dialog]");
  await prompt.locator("input").fill(exported);
  await prompt.locator("input").press("Enter");
  await page.getByText(/Exported 4 subscriptions/).waitFor();
  const opml = readFileSync(exported, "utf8");
  assert.equal(opml.match(/<outline /g)?.length, 4);
  assert.match(opml, /title="Slow Craft"[^>]*kintsugiMuted="true"/);

  // Importing it back changes nothing; another reader's export adds a source.
  await page.locator('input[type="file"]').setInputFiles(exported);
  await page.getByText(/0 new, 4 already followed/).waitFor();
  const other = resolve(config, "other-reader.opml");
  writeFileSync(other, `<?xml version="1.0"?><opml version="1.0"><head><title>Elsewhere</title></head><body>
<outline text="Reading"><outline type="rss" text="Field Notes" xmlUrl="${fixtures.base}/notes.json"/></outline>
<outline type="rss" text="Bad" xmlUrl="javascript:alert(1)"/></body></opml>`);
  await page.locator('input[type="file"]').setInputFiles(other);
  await page.getByText(/1 new, 1 skipped/).waitFor();
  await sources.getByRole("listitem", { name: "Field Notes" }).locator('[data-health="ok"]').waitFor({ timeout: 30_000 });
  await shot("07-opml-imported");
  await page.keyboard.press("Escape");
  // The imported source was fetched in the background and is newest.
  await newest().getByRole("button", { name: "Attention is a garden", exact: true }).waitFor({ timeout: 30_000 });
  assert.equal((await titles())[0], "Attention is a garden");

  // Unmuting brings its items back.
  await page.getByRole("button", { name: "Following" }).click();
  await sources.getByRole("switch", { name: "Unmute Slow Craft" }).click();
  await page.keyboard.press("Escape");
  await item("Hand-cut dovetails, slowly").waitFor();
  await shot("08-feed");
  assert.ok(existsSync(resolve(config, "feed.sqlite")), "the feed lives in app data");
  assert.equal(existsSync(resolve(vault, "feed.sqlite")) || readdirSync(vault).some((f) => f.includes("sqlite")), false, "never in the vault");
});

test("Picked for you: ranked locally, with Why this? and corrections", { timeout: TIMEOUT }, async () => {
  await page.getByRole("button", { name: "Following" }).click();
  await follow("Link", `${fixtures.base}/workshop.xml`, /Following Workshop Letters/);
  await page.keyboard.press("Escape");
  await item(WORKSHOP[0].title).waitFor({ timeout: 30_000 });
  await picked().waitFor();
  const shownTitles = async () => (await picked().locator("article h2").allInnerTexts()).map((t) => t.trim());
  await picked().getByRole("button", { name: /Show \d+ more/ }).click();
  const picks = await shownTitles();
  assert.ok(picks.length >= 6, `picks: ${picks}`);
  // Cold start from the seeded clips (kintsugi, golden joinery, sleep, the
  // quiet web): the repair pieces rank above the fresher football and markets.
  const at = (title: string) => (picks.includes(title) ? picks.indexOf(title) : 99);
  assert.ok(at(WORKSHOP[0].title) < at(WORKSHOP[2].title) && at(WORKSHOP[0].title) < at(WORKSHOP[3].title), `order: ${picks}`);
  // One pick in eight explores.
  assert.equal(await picked().getByText("Exploring", { exact: true }).count(), 1);

  // Why this? names the clip it's close to; that reason can be removed.
  const gold = pick(WORKSHOP[0].title);
  await gold.getByRole("button", { name: "Why this?" }).click();
  const why = gold.getByRole("list", { name: `Why ${WORKSHOP[0].title}` });
  await why.getByRole("listitem").first().waitFor();
  const reasons = await why.getByRole("listitem").allInnerTexts();
  assert.ok(reasons.some((r) => /Close to “.+”, in Inspiration|You often keep|topic you keep/.test(r)), `reasons: ${reasons}`);
  await shot("09-picked-why-this");
  const removable = why.getByRole("button", { name: /^Don’t use this:/ }).first();
  const removed = (await removable.getAttribute("aria-label"))!.replace("Don’t use this: ", "");
  await removable.click();
  await page.getByText("Picked for you won’t use that").waitFor();
  await shot("10-correction");
  let corrections = events("correction");
  assert.equal(corrections.length, 1);
  assert.equal(corrections[0].surface, "picked");
  const reason = JSON.parse(String(corrections[0].data)).reason as string;
  assert.match(reason, /^(anchor:|source:|author:|topic:)/);
  // Undo puts it back, as its own event in the append-only log.
  await page.getByRole("button", { name: "Undo" }).first().click();
  await until(() => events("undo_correction").length >= 1, () => "the undo is logged");
  assert.equal(events("undo_correction").length, 1);
  corrections = events("undo_correction");
  assert.equal(JSON.parse(String(corrections[0].data)).reason, reason);
  await gold.getByRole("button", { name: "Why this?" }).click();
  await gold.getByRole("button", { name: "Why this?" }).click();
  await gold.getByText(removed).first().waitFor();

  // A like says what it changed, and Undo reverses it. (Earlier toasts first
  // clear, so the screenshot shows this one.)
  await page.waitForFunction(() => !document.querySelector("[data-sonner-toast]"), null, { timeout: 30_000 });
  const glaze = pick(WORKSHOP[5].title).or(item(WORKSHOP[5].title)).first();
  await glaze.getByRole("button", { name: "Like", exact: true }).click();
  const toastText = page.locator("[data-sonner-toast]").filter({ hasText: "Liked" }).last();
  await toastText.waitFor();
  assert.match(await toastText.innerText(), /More weight on .+ \d+% → \d+%|New in Picked for you|made room/);
  await page.waitForTimeout(800); // the toast's entrance animation
  await shot("11-like-effect");
  await toastText.getByRole("button", { name: "Undo" }).click();
  await until(() => events("unlike").length >= 2, () => `unlikes: ${events("unlike").length}`);
  assert.equal(events("unlike").length, 2, "the KI-25 undo and this one");

  // Picked impressions are logged with their own surface and positions.
  const pickedSeen = () => events("impression").filter((e) => e.surface === "picked");
  await until(() => pickedSeen().length >= 4, () => `picked impressions: ${pickedSeen().length}`);
  const seen = pickedSeen();
  assert.ok(seen.some((e) => e.position === 0));
  await picked().scrollIntoViewIfNeeded();
  await shot("12-picked-for-you");
});

test("Kin reads a feed item and uses the ranking tools; its picks are logged apart", { timeout: TIMEOUT }, async () => {
  const kin = page.getByRole("dialog", { name: "Kin" });
  const replies = kin.locator('[data-role="kin"]');
  const target = item(WORKSHOP[4].title);
  const id = await target.getAttribute("data-feed-item");
  await target.getByRole("button", { name: "Discuss" }).click();
  await kin.waitFor();
  const box = kin.getByRole("textbox", { name: "Message Kin" });
  await box.fill("What is this one about?");
  await box.press("Enter");
  // KI-25's Discuss only gave Kin the title; now it reads the item itself.
  const read = replies.last().getByText(`read {"limit":20,"path":"feed:${id}"}`, { exact: false });
  await read.waitFor({ timeout: 30_000 });
  await replies.last().getByText(/It returned: feed:\d+ title: The quiet web is still here source: Workshop Letters author: Mira Kane/).waitFor({ timeout: 30_000 });
  await shot("13-kin-reads-feed-item");

  await box.fill("Give me a shortlist of the feed");
  await box.press("Enter");
  await replies.last().getByText(`tool {"args":{"n":5},"name":"shortlist"}`, { exact: false }).waitFor({ timeout: 30_000 });
  await replies.last().getByText(/It returned: \[ \{"age":"\d+[hd]","id":"feed:\d+"/).waitFor({ timeout: 30_000 });
  await shot("14-kin-shortlist");
  const kinPicks = events("kin_pick");
  assert.equal(kinPicks.length, 5);
  assert.ok(kinPicks.every((e) => e.surface === "kin" && JSON.parse(String(e.data)).tool === "shortlist"));
  // Kin's picks are never his impressions.
  assert.equal(events("impression").filter((e) => e.surface === "kin").length, 0);
  await page.keyboard.press("Escape");
});

test("watch a page without a feed, and follow an author's new books", { timeout: TIMEOUT }, async () => {
  await page.getByRole("button", { name: "Following" }).click();
  // Following a page records a baseline: nothing in the feed yet.
  await follow("Page", `${fixtures.base}/now`, /Following What I’m doing now/);
  await page.getByText("Nothing new right now.").first().waitFor();
  const sources = page.getByRole("list", { name: "Sources" });
  const watched = sources.getByRole("listitem", { name: "What I’m doing now" });
  await watched.locator('[data-health="ok"]').waitFor();

  const fetchNow = async (expect: { full: number; notModified: number }) => {
    await watched.getByRole("button", { name: "Fetch What I’m doing now now" }).click();
    for (let i = 0; (fixtures.hits.get("/now") ?? 0) + (fixtures.hits.get("/now:304") ?? 0) < expect.full + expect.notModified; i++) {
      if (i > 300) throw new Error(`the page was never fetched: ${JSON.stringify([...fixtures.hits])}`);
      await page.waitForTimeout(100);
    }
    await watched.locator('[data-health="ok"]').waitFor();
  };
  assert.equal(fixtures.hits.get("/now"), 1);
  // New dates and visitor counts are not a change.
  fixtures.setNow(2);
  await fetchNow({ full: 2, notModified: 0 });
  // The same version again answers 304 to the ETag Kintsugi sent.
  await fetchNow({ full: 2, notModified: 1 });
  assert.equal(fixtures.hits.get("/now:304"), 1, "the second fetch was conditional");
  await page.waitForTimeout(500);
  assert.equal(await feedItems().filter({ hasText: "What I’m doing now" }).count(), 0, "no item for noise");
  // A real edit posts one item describing the change.
  fixtures.setNow(3);
  await fetchNow({ full: 3, notModified: 1 });
  await page.keyboard.press("Escape");
  const change = item("The Left Hand of Darkness");
  await change.waitFor();
  assert.match(await change.innerText(), /2 lines added and 1 removed on What I’m doing now/);
  assert.equal(await change.getByLabel("Page changed").count(), 1);
  const hits = fixtures.hits.get("/now");
  await change.getByRole("button", { name: "The Left Hand of Darkness", exact: true }).click();
  const reading = change.getByRole("region", { name: "Reading The Left Hand of Darkness" });
  await reading.getByText("Learning to bind books by hand.").first().waitFor();
  await reading.getByText("Removed", { exact: true }).first().waitFor();
  await reading.getByText(/The Dispossessed, for the second time/).first().waitFor();
  assert.equal(fixtures.hits.get("/now"), hits, "reading a change never fetches the page as an article");
  await shot("20-page-changed");

  // An author: their latest three books on following, never the book about them.
  await page.getByRole("button", { name: "Following" }).click();
  await follow("Author", "Susanna Clarke", /Following Susanna Clarke/);
  await page.getByText("3 new items in your feed.").first().waitFor();
  await sources.getByRole("listitem", { name: "Susanna Clarke" }).locator('[data-health="ok"]').waitFor();
  await shot("21-following-page-and-author");
  await page.keyboard.press("Escape");
  const book = item("The Lost Garden: A Novel");
  await book.waitFor();
  assert.equal(await book.getByLabel("New book").count(), 1);
  await item("The Wood at Midwinter").waitFor();
  await item("Piranesi").waitFor();
  assert.equal(await item("Reading Susanna Clarke").count(), 0);
  assert.equal(await item("Jonathan Strange & Mr Norrell").count(), 0);

  // A book saved from the Feed becomes a clip, like any item.
  await book.getByRole("button", { name: "Save" }).click();
  await book.getByRole("button", { name: "Saved · Open" }).waitFor();
  const clips = readdirSync(resolve(vault, "inspiration")).filter((f) => f.endsWith(".md"));
  const saved = clips.map((f) => readFileSync(resolve(vault, "inspiration", f), "utf8")).find((c) => c.includes("/books/lost-garden"));
  assert.ok(saved, "no clip for the saved book");
  assert.match(saved, /^via: "?feed"?$/m);
  assert.match(saved, /^title: "?The Lost Garden: A Novel"?$/m);
  assert.match(saved, /^author: "?Susanna Clarke"?$/m);
  assert.match(saved, /<!-- kintsugi:source -->[\s\S]*never the same twice/);
  await shot("22-book-in-feed");

  // Both kinds round-trip through OPML as Kintsugi link outlines.
  const exported = resolve(config, "with-pages.opml");
  await page.getByRole("button", { name: "Following" }).click();
  await page.getByRole("button", { name: "Export OPML" }).click();
  const prompt = page.locator("dialog[data-headless-dialog]");
  await prompt.locator("input").fill(exported);
  await prompt.locator("input").press("Enter");
  await page.getByText(/Exported 8 subscriptions/).waitFor();
  const opml = readFileSync(exported, "utf8");
  assert.match(opml, /type="link"[^>]*url="http:\/\/127\.0\.0\.1:\d+\/now" kintsugiKind="page"/);
  assert.match(opml, /type="link"[^>]*url="https:\/\/openlibrary\.org\/search\?author=Susanna\+Clarke&amp;sort=new" kintsugiKind="author"/);
  await page.locator('input[type="file"]').setInputFiles(exported);
  await page.getByText(/0 new, 8 already followed/).waitFor();
  await page.keyboard.press("Escape");
  const kinds = (db().prepare("SELECT kind FROM sources ORDER BY id").all() as { kind: string }[]).map((r) => r.kind);
  assert.ok(kinds.includes("page") && kinds.includes("author"), kinds.join(","));
});
