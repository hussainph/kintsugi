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
// server, through KINTSUGI_HEADLESS_BOOKS). KI-94: stories across three news
// feeds (clustering, Kin's mock summaries, the cap, a failed summary), the
// story page and its source strip, the (?) card, and the magazine becoming
// tabs below 960 px. Screenshots land in .headless/feed-shots/.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { stopRunner, openApp } from "./headless-app.ts";
import { waitForFrontend } from "../../../scripts/frontend-ready.mjs";
import { BLOG_TITLES, NEWS, WORKSHOP, WRITING, startFeedFixtures, type Fixtures } from "./feed-fixtures.ts";

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
  await waitForFrontend(frontend, () => output);
  browser = await chromium.launch({ headless: true }).catch((e) => {
    throw new Error(`${e}\nInstall it with: pnpm --filter @kintsugi/desktop exec playwright install chromium-headless-shell`);
  });
  page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  // Only loopback: the app and the fixture feeds. Anything else would be the
  // live network (a YouTube link, say), which a test must never reach.
  await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
  await openApp(page, url, () => output);
}, { timeout: TIMEOUT });

after(async () => {
  await browser?.close();
  await fixtures?.close();
  await stopRunner(runner, () => output);
});

// The newest-first list (rows), Picked for you (cards), and the page an
// item or story opens in place of both.
const feedRegion = () => page.getByRole("region", { name: "Feed" });
const newest = () => page.getByRole("feed", { name: "Newest first" });
const picked = () => page.getByRole("region", { name: "Picked for you" });
const feedItems = () => newest().locator("article[data-feed-item]");
const byTitle = (title: string) => `article[aria-label="${title.replace(/"/g, '\\"')}"]`;
const item = (title: string) => newest().locator(byTitle(title));
const pick = (title: string) => picked().locator(byTitle(title));
/** The opened article or story page. */
const opened = (title: string) => feedRegion().locator(byTitle(title)).filter({ has: page.getByRole("heading", { level: 1 }) });
const back = () => feedRegion().getByRole("button", { name: /^(Feed|Story|Back)$/ }).first();
const db = () => new DatabaseSync(resolve(config, "feed.sqlite"), { readOnly: true });
const events = (kind: string) => db().prepare("SELECT * FROM events WHERE kind = ? ORDER BY id").all(kind) as Record<string, unknown>[];
const invoke = <T,>(cmd: string, args: unknown = {}) =>
  page.evaluate(
    ([c, a]) => (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__.invoke(c as string, a),
    [cmd, args] as const,
  ) as Promise<T>;
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
const titles = async () => feedItems().evaluateAll((rows) => rows.map((r) => r.getAttribute("aria-label")));

/** Opens a row's article (or story) and waits for its page. */
async function open(title: string) {
  await item(title).getByRole("button").first().click();
  await opened(title).waitFor();
}

async function follow(tab: string, value: string, expect: RegExp) {
  await page.getByRole("tab", { name: tab }).click();
  const field = page.getByRole("form", { name: "Follow something" }).getByRole("textbox").first();
  await field.fill(value);
  await page.getByRole("form", { name: "Follow something" }).getByRole("button", { name: "Follow" }).click();
  await page.getByText(expect).first().waitFor();
}

/** No toast reports what a like moved in ranking (KI-91). */
async function noRankingReport() {
  await page.waitForTimeout(400);
  assert.equal(await page.locator("[data-sonner-toast]").filter({ hasText: /%|weight|Picked for you:|made room/ }).count(), 0);
}

test("follow sources and read them newest first", { timeout: TIMEOUT }, async () => {
  await page.getByRole("button", { name: "Feed" }).first().click();
  await page.getByText("You’re not following anything yet.").waitFor();
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
  for (let i = 0; i < 100 && (await titles()).length < 5; i++) await page.waitForTimeout(100);
  assert.deepEqual(await titles(), [BLOG_TITLES[0], "Hand-cut dovetails, slowly", BLOG_TITLES[1], "Episode 12: Mending", BLOG_TITLES[2]]);
  assert.match(await newest().getByRole("status").innerText(), /5 items/);
  assert.match(await page.getByText(/need(s)? attention/).innerText(), /1 source needs attention/);
  assert.equal(await item("Hand-cut dovetails, slowly").getByLabel("Video").count(), 1);

  // Read in the app: full text from the feed, scripts dropped.
  await open(BLOG_TITLES[0]);
  const reading = page.getByRole("region", { name: `Reading ${BLOG_TITLES[0]}` });
  await reading.getByText(/the essay is what survives the argument/).waitFor();
  // The feed carried an excerpt; the full article came through the ingest engine.
  await reading.getByText(/only on the page, never in the feed/).waitFor();
  assert.doesNotMatch(await reading.innerText(), /alert/);
  await shot("03-feed-reading");
  await back().click();
  await item(BLOG_TITLES[0]).waitFor();

  // Impressions were logged with their positions (sent in batches, 1.5 s after the first).
  for (const position of [1, 2]) await feedItems().nth(position).scrollIntoViewIfNeeded();
  const newestSeen = () => events("impression").filter((e) => e.surface === "newest");
  await until(() => newestSeen().length >= 3, () => `impressions: ${JSON.stringify(newestSeen())}`);
  const positions = newestSeen().map((e) => e.position);
  for (const position of [0, 1, 2]) assert.ok(positions.includes(position), `position ${position} in ${positions}`);
  await until(() => events("open").length >= 1, () => "the open is logged");
  assert.equal(events("open").length, 1);
});

test("like, note, save into Inspiration, not interested", { timeout: TIMEOUT }, async () => {
  await open(BLOG_TITLES[0]);
  const tools = opened(BLOG_TITLES[0]);
  await tools.getByRole("button", { name: "Like", exact: true }).click();
  await tools.getByRole("button", { name: "Liked" }).waitFor();
  assert.equal(await tools.getByRole("button", { name: "Liked" }).getAttribute("aria-pressed"), "true");
  await noRankingReport();
  // The heart is the undo.
  await tools.getByRole("button", { name: "Liked" }).click();
  await tools.getByRole("button", { name: "Like", exact: true }).waitFor();
  await tools.getByRole("button", { name: "Like", exact: true }).click();
  await tools.getByRole("button", { name: "Liked" }).waitFor();
  await back().click();

  await open(BLOG_TITLES[1]);
  const mending = opened(BLOG_TITLES[1]);
  await mending.getByRole("button", { name: "Note" }).click();
  await mending.getByRole("textbox", { name: `Note on ${BLOG_TITLES[1]}` }).fill("Pair this with the bowl essay. Repair as argument.");
  await shot("04-note");
  // Saving flushes the note first, and the note travels with the clip.
  await mending.getByRole("button", { name: "Save", exact: true }).click();
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
  // Opening it read the full article (the feed had an excerpt), so that's the source.
  assert.match(clip, /<!-- kintsugi:source -->[\s\S]*only on the page, never in the feed/);
  // Saving again is idempotent: no second clip.
  await mending.getByRole("button", { name: "Saved · Open" }).click();
  await page.getByRole("region", { name: "Inspiration library" }).or(page.getByRole("button", { name: "Back" })).first().waitFor();
  await page.getByText(/Pair this with the bowl essay/).first().waitFor();
  await shot("05-saved-clip-in-inspiration");
  assert.equal(readdirSync(resolve(vault, "inspiration")).filter((f) => f.endsWith(".md")).length, clips.length);

  await page.getByRole("button", { name: "Feed" }).first().click();
  await open(BLOG_TITLES[2]);
  await opened(BLOG_TITLES[2]).getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Not interested" }).click();
  await newest().waitFor();
  for (let i = 0; i < 100 && (await titles()).includes(BLOG_TITLES[2]); i++) await page.waitForTimeout(100);
  assert.equal((await titles()).includes(BLOG_TITLES[2]), false);
  for (let i = 0; i < 50 && !/4 items/.test(await newest().getByRole("status").innerText()); i++) await page.waitForTimeout(100);
  assert.match(await newest().getByRole("status").innerText(), /4 items/);

  // Discuss opens Kin's chat with the item attached as a context chip.
  await open("Episode 12: Mending");
  await opened("Episode 12: Mending").getByRole("button", { name: "Discuss" }).click();
  await page.getByRole("region", { name: "Kin" }).getByText("Episode 12: Mending").first().waitFor();
  await shot("06b-discuss");
  await page.keyboard.press("Escape");
  await back().click();

  const kinds = (db().prepare("SELECT kind FROM events WHERE kind <> 'impression' ORDER BY id").all() as { kind: string }[]).map((e) => e.kind);
  for (const kind of ["subscribe", "open", "like", "unlike", "note", "save", "not_interested", "discuss"]) assert.ok(kinds.includes(kind), `${kind} in ${kinds}`);
  // The save happened on the page opened from row 2 of Newest.
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
  await item("Attention is a garden").waitFor({ timeout: 30_000 });
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

test("Picked for you: ranked locally, with the (?) card and corrections", { timeout: TIMEOUT }, async () => {
  await page.getByRole("button", { name: "Following" }).click();
  await follow("Link", `${fixtures.base}/workshop.xml`, /Following Workshop Letters/);
  await page.keyboard.press("Escape");
  await item(WORKSHOP[0].title).waitFor({ timeout: 30_000 });
  await picked().waitFor();
  await picked().getByRole("button", { name: /Show \d+ more/ }).click();
  const picks = (await picked().locator("article[data-feed-item]").evaluateAll((cards) => cards.map((c) => c.getAttribute("aria-label")))) as string[];
  assert.ok(picks.length >= 6, `picks: ${picks}`);
  // Cold start from the seeded clips (kintsugi, golden joinery, sleep, the
  // quiet web): the repair pieces rank above the fresher football and markets.
  const at = (title: string) => (picks.includes(title) ? picks.indexOf(title) : 99);
  assert.ok(at(WORKSHOP[0].title) < at(WORKSHOP[2].title) && at(WORKSHOP[0].title) < at(WORKSHOP[3].title), `order: ${picks}`);
  // One pick in eight explores.
  const ranked = await invoke<{ picks: { explore: boolean }[] }>("feed_picked");
  assert.equal(ranked.picks.filter((p) => p.explore).length, 1);

  // (?) names the clip it's close to; that reason can be removed.
  const gold = pick(WORKSHOP[0].title);
  await gold.getByRole("button", { name: "Why this?" }).click();
  const why = page.getByRole("list", { name: `Why ${WORKSHOP[0].title}` });
  await why.getByRole("listitem").first().waitFor();
  const reasons = await why.getByRole("listitem").allInnerTexts();
  assert.ok(reasons.some((r) => /Close to “.+”, in Inspiration|You often keep|topic you keep/.test(r)), `reasons: ${reasons}`);
  assert.ok(!reasons.some((r) => /Still learning/.test(r)), "the (?) card leaves out the ranker's mechanics");
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
  if (!(await why.count())) await gold.getByRole("button", { name: "Why this?" }).click();
  await why.getByText(removed).first().waitFor();
  await page.keyboard.press("Escape");

  // A like changes the heart, and nothing else talks about ranking (KI-91).
  await page.waitForFunction(() => !document.querySelector("[data-sonner-toast]"), null, { timeout: 30_000 });
  const liking = (await pick(WORKSHOP[5].title).count()) ? WORKSHOP[5].title : picks.find((t) => t !== WORKSHOP[0].title)!;
  const likes = events("like").length;
  await pick(liking).getByRole("button", { name: "Like", exact: true }).click();
  await until(() => events("like").length > likes, () => "the like is logged");
  await page.waitForTimeout(400);
  assert.equal(await page.locator("[data-sonner-toast]").count(), 0);
  await shot("11-like");
  // A liked pick makes room in Picked for you; its page has the heart to undo it.
  await open(liking);
  await opened(liking).getByRole("button", { name: "Liked" }).click();
  await opened(liking).getByRole("button", { name: "Like", exact: true }).waitFor();
  await back().click();
  await until(() => events("unlike").length >= 2, () => `unlikes: ${events("unlike").length}`);
  assert.equal(events("unlike").length, 2, "the KI-25 undo and this one");

  // Picked impressions are logged with their own surface and positions.
  const pickedSeen = () => events("impression").filter((e) => e.surface === "picked");
  await until(() => pickedSeen().length >= 4, () => `picked impressions: ${pickedSeen().length}`);
  assert.ok(pickedSeen().some((e) => e.position === 0));
  await picked().scrollIntoViewIfNeeded();
  await shot("12-picked-for-you");
});

test("Kin reads a feed item and uses the ranking tools; its picks are logged apart", { timeout: TIMEOUT }, async () => {
  const kin = page.getByRole("region", { name: "Kin" });
  const replies = kin.locator('[data-role="kin"]');
  const id = await item(WORKSHOP[4].title).getAttribute("data-feed-item");
  await open(WORKSHOP[4].title);
  await opened(WORKSHOP[4].title).getByRole("button", { name: "Discuss" }).click();
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
  await back().click();
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
  assert.equal(await change.getByLabel("Page changed").count(), 1);
  const hits = fixtures.hits.get("/now");
  await open("The Left Hand of Darkness");
  const page_ = opened("The Left Hand of Darkness");
  await page_.getByText(/2 lines added and 1 removed on What I’m doing now/).waitFor();
  const reading = page.getByRole("region", { name: "Reading The Left Hand of Darkness" });
  await reading.getByText("Learning to bind books by hand.").first().waitFor();
  await reading.getByText("Removed", { exact: true }).first().waitFor();
  await reading.getByText(/The Dispossessed, for the second time/).first().waitFor();
  assert.equal(fixtures.hits.get("/now"), hits, "reading a change never fetches the page as an article");
  await shot("20-page-changed");
  await back().click();

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
  await open("The Lost Garden: A Novel");
  await opened("The Lost Garden: A Novel").getByRole("button", { name: "Save", exact: true }).click();
  await opened("The Lost Garden: A Novel").getByRole("button", { name: "Saved · Open" }).waitFor();
  const clips = readdirSync(resolve(vault, "inspiration")).filter((f) => f.endsWith(".md"));
  const saved = clips.map((f) => readFileSync(resolve(vault, "inspiration", f), "utf8")).find((c) => c.includes("/books/lost-garden"));
  assert.ok(saved, "no clip for the saved book");
  assert.match(saved, /^via: "?feed"?$/m);
  assert.match(saved, /^title: "?The Lost Garden: A Novel"?$/m);
  assert.match(saved, /^author: "?Susanna Clarke"?$/m);
  assert.match(saved, /<!-- kintsugi:source -->[\s\S]*never the same twice/);
  await shot("22-book-in-feed");
  await back().click();

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

/** Light and dark screenshots of what's on screen now. */
async function both(name: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(250);
    await shot(`${name}-${scheme}`);
  }
  await page.emulateMedia({ colorScheme: null });
}

test("stories: grouped across sources, summarised with citations, the cap and a failure, and the source strip", { timeout: TIMEOUT }, async () => {
  const stories = () => db().prepare("SELECT id, summary_state AS state, summary_attempts AS attempts FROM stories ORDER BY id").all() as { id: number; state: string; attempts: number }[];
  // At the cap, nothing is sent: stories wait and show their lead article.
  await invoke("kin_set_cap", { capUsd: 0 });
  await page.getByRole("button", { name: "Following" }).click();
  for (const [feed, name] of [["orchard", "Orchard Daily"], ["ledger", "The Ledger"], ["bench", "Bench Notes"]]) await follow("Link", `${fixtures.base}/${feed}.xml`, new RegExp(`Following ${name}`));
  await page.keyboard.press("Escape");

  // Lumen's quarter, from three feeds, is one entry in Newest.
  const quarter = item(NEWS.quarter);
  try {
    await quarter.getByText(/^\d articles from 3 sources$/).waitFor({ timeout: 30_000 });
  } catch (e) {
    await shot("30-story-missing");
    const entries = await Promise.race([invoke("feed_entries", { limit: 5 }), new Promise((r) => setTimeout(() => r("feed_entries never answered"), 10_000))]);
    writeFileSync(resolve(shots, "30-story-missing.txt"), `${e}\nNewest: ${JSON.stringify(await titles())}\nEntries: ${JSON.stringify(entries).slice(0, 2000)}\nRunner: ${output.slice(-6000)}`);
    throw e;
  }
  assert.ok(await quarter.getAttribute("data-story"));
  for (const loner of NEWS.alone) await item(loner).waitFor();
  assert.equal(await item("Lumen set a phone sales record in Q4 even without a new standard phone").count(), 0, "folded into the story");
  await until(() => stories().length >= 3 && stories().every((s) => s.state === "capped"), () => `stories: ${JSON.stringify(stories())}`);
  await open(NEWS.quarter);
  const story = opened(NEWS.quarter);
  await story.getByText("This month's AI limit is reached, so there's no summary yet.").waitFor();
  await story.getByText(/Lumen today reported fourth quarter revenue/).waitFor();
  assert.equal(await story.locator(".ki-cite").count(), 0);
  await shot("30-story-capped");

  // With room under the cap again, Kin's mock writes a long summary: every
  // sentence cites its article, and the uncited ones are gone.
  await invoke("kin_set_cap", { capUsd: null });
  await back().click();
  await open(NEWS.quarter);
  await until(() => stories().some((s) => s.state === "ready"), () => `stories: ${JSON.stringify(stories())}`);
  await story.locator(".ki-cite").first().waitFor({ timeout: 30_000 });
  const summary = story.getByRole("region", { name: "Summary" });
  assert.ok((await summary.locator("p").count()) >= 3, "a long summary keeps its paragraphs");
  assert.ok((await story.locator(".ki-cite").count()) >= 6);
  assert.doesNotMatch(await summary.innerText(), /cites nothing|isn't there/);
  assert.equal(await story.getByText(/AI limit is reached/).count(), 0);

  // The (?) card: how many sources covered it.
  await story.getByRole("button", { name: "Why this?" }).click();
  await page.getByRole("list", { name: `Why ${NEWS.quarter}` }).getByText(/\d sources you follow covered this/).waitFor();
  await shot("31-story-why");
  await page.keyboard.press("Escape");

  // The articles: one strip of compact tiles, quiet until hovered.
  const strip = story.getByRole("list", { name: "Articles" });
  const tiles = strip.locator("[data-feed-item]");
  // The count under the title is what the tiles (and "+N more") add up to,
  // and each source's tiles sit together.
  const counted = Number(/(\d+) articles from 3 sources/.exec(await story.innerText())![1]);
  const more = strip.getByRole("button", { name: /^\+\d+ more$/ });
  const hidden = (await more.count()) ? Number(/\d+/.exec(await more.innerText())![0]) : 0;
  assert.equal((await tiles.count()) + hidden, counted);
  if (hidden) await more.click();
  const tileSources = await tiles.evaluateAll((all) => all.map((t) => t.querySelector(".truncate")?.textContent ?? ""));
  assert.deepEqual(tileSources, [...tileSources].sort((a, b) => tileSources.indexOf(a) - tileSources.indexOf(b)), `grouped: ${tileSources}`);
  assert.ok((await tiles.count()) >= 4, `tiles: ${await tiles.count()}`);
  const tile = tiles.nth(1);
  const toolbar = tile.getByRole("toolbar");
  assert.equal(await toolbar.evaluate((t) => getComputedStyle(t).opacity), "0", "no permanent action icons");
  await tile.hover();
  await page.waitForFunction((t) => getComputedStyle(t!).opacity === "1", await toolbar.elementHandle());
  await both("32-story-page");
  const tileId = Number(await tile.getAttribute("data-feed-item"));
  await toolbar.getByRole("button", { name: "Like", exact: true }).click();
  await toolbar.getByRole("button", { name: "Liked" }).waitFor();
  const liked = events("like").find((e) => e.item_id === tileId);
  assert.ok(liked && JSON.parse(String(liked.data)).story, `a like on a story's article carries data.story: ${JSON.stringify(liked)}`);
  // Save keeps one clip per article saved from the strip.
  const before = readdirSync(resolve(vault, "inspiration")).filter((f) => f.endsWith(".md")).length;
  await toolbar.getByRole("button", { name: "Save", exact: true }).click();
  await toolbar.getByRole("button", { name: "Saved · Open" }).waitFor();
  assert.equal(readdirSync(resolve(vault, "inspiration")).filter((f) => f.endsWith(".md")).length, before + 1);
  assert.equal(await tile.getByLabel("Saved", { exact: true }).count(), 1, "a quiet mark at rest");
  // A citation opens its article; Back returns to the story.
  await summary.locator(".ki-cite").first().click();
  await page.getByRole("region", { name: /^Reading / }).waitFor();
  assert.equal(await back().innerText(), "Story");
  await back().click();
  await story.waitFor();
  await back().click();

  // A story the model couldn't summarise shows its lead article, and says so.
  await until(() => stories().some((s) => s.state === "failed"), () => `stories: ${JSON.stringify(stories())}`);
  await open(NEWS.failing);
  await opened(NEWS.failing).getByText("Couldn't write a summary, so this is the first article's text.").waitFor();
  await shot("33-story-failed");
  await back().click();

  // Not interested on a story hides all of its articles, with Undo.
  const rule = item(NEWS.rule);
  await rule.waitFor();
  await open(NEWS.rule);
  await opened(NEWS.rule).getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Not interested" }).click();
  await item(NEWS.rule).waitFor({ state: "detached" });
  await until(() => events("not_interested").filter((e) => JSON.parse(String(e.data ?? "{}")).story).length >= 2, () => "both articles hidden");
  await page.getByRole("button", { name: "Undo" }).first().click();
  await item(NEWS.rule).waitFor();
});

test("writing stays whole: a personal essay stands alone in one rich reader, and only Kin's summaries carry the mark", { timeout: TIMEOUT }, async () => {
  await page.getByRole("button", { name: "Following" }).click();
  await follow("Link", `${fixtures.base}/ada.atom`, new RegExp(`Following ${WRITING.blog}`));
  await follow("Link", `${fixtures.base}/hn.xml`, new RegExp(`Following ${WRITING.hn}`));
  // The switch: on for the news sites, off for the personal blog.
  const sources = page.getByRole("list", { name: "Sources" });
  const grouping = (name: string) => sources.getByRole("switch", { name: `Group ${name} with other coverage` });
  await grouping(WRITING.blog).waitFor();
  assert.equal(await grouping(WRITING.blog).getAttribute("aria-checked"), "false");
  assert.equal(await grouping("Orchard Daily").getAttribute("aria-checked"), "true");
  assert.equal(await grouping(WRITING.hn).getAttribute("aria-checked"), "true");
  await sources.getByRole("listitem", { name: WRITING.blog }).scrollIntoViewIfNeeded();
  await both("50-following-grouping");
  await page.keyboard.press("Escape");

  // The essay shares Lumen's quarter with the news, and still stands alone.
  // Its HN link is the same article, so it's the one item.
  const essay = item(WRITING.essay);
  await essay.first().waitFor();
  assert.equal(await essay.count(), 1);
  assert.equal(await essay.getAttribute("data-story"), null);
  const sql = db().prepare("SELECT i.writing, i.story_id FROM items i WHERE i.title = ? AND i.source_id = (SELECT id FROM sources WHERE title = ?)").get(WRITING.essay, WRITING.blog) as { writing: number; story_id: number | null };
  assert.deepEqual({ ...sql }, { writing: 1, story_id: null });

  // The summary mark: on the summarised story, never on an author's item.
  const quarter = item(NEWS.quarter);
  await quarter.locator("[data-summary-mark]").waitFor({ timeout: 30_000 });
  assert.match(String(await quarter.locator("[data-summary-mark]").getAttribute("aria-label")), /^Kin’s summary of 3 sources$/);
  assert.equal(await essay.locator("[data-summary-mark]").count(), 0);
  assert.equal(await item(NEWS.alone[0]).locator("[data-summary-mark]").count(), 0);
  // A story still showing its lead's own text (the failed one) has no mark.
  assert.equal(await item(NEWS.failing).locator("[data-summary-mark]").count(), 0);
  await both("51-summary-mark");

  // One reader: headings, the quote, the list, the figure and its caption, code, a link, the footnote; no script.
  await essay.getByRole("button").first().click();
  const reading = page.getByRole("region", { name: `Reading ${WRITING.essay}` });
  await reading.getByRole("heading", { name: WRITING.heading }).waitFor();
  await reading.locator("blockquote").getByText(/Margin is the one you tell about next year/).waitFor();
  assert.equal(await reading.locator("ul > li").count(), 3);
  assert.equal(await reading.locator("figure figcaption").innerText(), WRITING.caption);
  await reading.locator("pre code").getByText("=SUM(materials) + hours * rate").waitFor();
  assert.equal(await reading.getByRole("link", { name: "my older post on pricing" }).count(), 1);
  assert.doesNotMatch(await reading.innerText(), /alert/);
  // "Also covered by": the HN link and the news, as links; the news opens as the story.
  const covered = feedRegion().locator("[data-coverage]");
  await covered.waitFor({ timeout: 30_000 });
  assert.match(await covered.innerText(), /^Also covered by /);
  await page.locator("[data-sonner-toast]").first().waitFor({ state: "detached", timeout: 15_000 }).catch(() => undefined);
  await both("52-writing-reader");
  await reading.getByRole("heading", { name: WRITING.heading }).evaluate((h) => h.scrollIntoView({ block: "start" }));
  await both("53-writing-reader-body");
  await covered.evaluate((c) => c.scrollIntoView({ block: "end" }));
  await both("54-writing-also-covered");
  // The news is a story: its link opens the story page, and Back returns.
  await covered.getByRole("button").first().click();
  await opened(NEWS.quarter).waitFor();
  await back().click();
  await reading.waitFor();
  await back().click();
  await item(NEWS.quarter).waitFor();

  // Switching a news site off takes its articles out of the story.
  await page.getByRole("button", { name: "Following" }).click();
  await grouping("Bench Notes").click();
  await sources.locator('[aria-label="Group Bench Notes with other coverage"][aria-checked="false"]').waitFor();
  await page.keyboard.press("Escape");
  await quarter.getByText("Orchard Daily, The Ledger").waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "Following" }).click();
  await grouping("Bench Notes").click();
  await page.keyboard.press("Escape");
  await quarter.getByText(/^\d articles from 3 sources$/).waitFor({ timeout: 30_000 });
});

test("the magazine below 960 px becomes For you / Newest tabs", { timeout: TIMEOUT }, async () => {
  const layout = () => feedRegion().getAttribute("data-layout");
  await page.setViewportSize({ width: 1440, height: 900 });
  for (let i = 0; i < 50 && (await layout()) !== "magazine"; i++) await page.waitForTimeout(100);
  assert.equal(await layout(), "magazine");
  assert.equal(await page.getByRole("tab", { name: "For you" }).count(), 0);
  await picked().waitFor();
  await newest().waitFor();
  await both("40-magazine");

  // Same app, a narrower window: the Feed pane is under 960 px.
  await page.setViewportSize({ width: 1000, height: 860 });
  for (let i = 0; i < 50 && (await layout()) !== "tabs"; i++) await page.waitForTimeout(100);
  assert.equal(await layout(), "tabs");
  await page.getByRole("tab", { name: "For you" }).waitFor();
  await picked().waitFor();
  assert.equal(await newest().count(), 0, "one tab at a time");
  await both("41-tabs-for-you");
  await page.getByRole("tab", { name: "Newest" }).click();
  await newest().waitFor();
  assert.equal(await picked().count(), 0);
  await item(NEWS.quarter).waitFor();
  await both("42-tabs-newest");
  // Opening from the tabs works the same.
  await open(NEWS.quarter);
  await both("43-story-narrow");
  await back().click();
  await page.setViewportSize({ width: 1280, height: 860 });
});
