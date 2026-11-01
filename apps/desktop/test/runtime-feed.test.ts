// KI-25 end to end against the real runtime: `pnpm desktop:headless` (the real
// Rust command registry on Tauri MockRuntime, and the real React app) driven
// by headless Chromium. Feeds come from a loopback fixture server, never the
// live network; the vault and config are fresh scratch folders under .headless/.
//
// Subscribe, poll, read, act (like / note / save / Not interested / mute),
// save into Inspiration (via: feed, note and source travel), OPML round-trip,
// and the event log. Screenshots land in .headless/feed-shots/.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { BLOG_TITLES, startFeedFixtures, type Fixtures } from "./feed-fixtures.ts";

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

const feedItems = () => page.locator("[data-feed-item]");
const item = (title: string) => page.locator("article[data-feed-item]", { has: page.getByRole("button", { name: title, exact: true }) });
const db = () => new DatabaseSync(resolve(config, "feed.sqlite"), { readOnly: true });
const events = (kind: string) => db().prepare("SELECT * FROM events WHERE kind = ? ORDER BY id").all(kind) as Record<string, unknown>[];
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
  await page.getByRole("button", { name: BLOG_TITLES[0], exact: true }).click();
  const reading = page.getByRole("region", { name: `Reading ${BLOG_TITLES[0]}` });
  await reading.getByText(/the essay is what survives the argument/).waitFor();
  // The feed carried an excerpt; the full article came through the ingest engine.
  await reading.getByText(/only on the page, never in the feed/).waitFor();
  assert.doesNotMatch(await reading.innerText(), /alert/);
  await shot("03-feed-reading");

  // Impressions were logged with their positions.
  await page.waitForTimeout(2000);
  const seen = events("impression");
  assert.ok(seen.length >= 3, `impressions: ${JSON.stringify(seen)}`);
  assert.deepEqual(seen.slice(0, 3).map((e) => [e.position, e.surface]), [[0, "newest"], [1, "newest"], [2, "newest"]]);
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
  await page.getByText("Episode 12: Mending").nth(1).waitFor();
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
  await page.getByRole("button", { name: "Attention is a garden", exact: true }).waitFor({ timeout: 30_000 });
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
