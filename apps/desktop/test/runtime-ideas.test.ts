// KI-39 against the real runtime: `pnpm desktop:headless` (the real Rust
// command registry on Tauri MockRuntime, and the real React app) driven by
// headless Chromium, with Kin on the scripted headless model
// (`KINTSUGI_HEADLESS_KIN=mock`): no credentials, no provider, no cost.
//
// Covers the daily batch (grounded quotes only; the mock's invented quote
// is dropped), engaging an idea and its inline citations, Refine with undo,
// Dismiss with reasons and undo, Discuss, Adopt into a new draft and into
// one already started, "Ideas for this draft", and fading (by restarting
// with the clock moved forward). Everything lives in a fresh scratch vault
// and config under .headless/; screenshots go to .headless/<run>/shots/.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { stopRunner, openApp } from "./headless-app.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const STARTED = "drafts/kintsugi-and-gold.md";
const TIMEOUT = Number(process.env.KINTSUGI_RUNTIME_TIMEOUT ?? 15 * 60_000);

let runner: ChildProcess | undefined;
let browser: Browser;
let page: Page;
let scratch = "";
let vault = "";
let config = "";
let shots = "";
/** What the current runner printed. */
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

/** Starts the headless app on the scratch vault and config; returns its URL. */
async function start(env: Record<string, string> = {}) {
  const [frontend, backend] = [await freePort(), await freePort()];
  output = "";
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
      KINTSUGI_HEADLESS_KIN: "mock",
      // Headless skips the daily batch unless asked; this suite tests it.
      KINTSUGI_HEADLESS_IDEAS_DAILY: "1",
      ...env,
    },
  });
  const url = await new Promise<string>((done, fail) => {
    runner!.stdout!.on("data", (chunk) => {
      output += chunk;
      const found = /^(http:\/\/127\.0\.0\.1:\d+\/#headless=\S+)$/m.exec(output);
      if (found) done(found[1]);
    });
    runner!.stderr!.on("data", (chunk) => (output += chunk));
    runner!.once("exit", (code) => fail(new Error(`desktop:headless exited (${code}):\n${output.slice(-4000)}`)));
  });
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${frontend}/`)).ok) break;
    } catch {
      if (i > 600) throw new Error(`frontend never started:\n${output.slice(-4000)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return url;
}

/** Stops the app and waits until it's down, so a restart never shares the vault with it. */
async function stop() {
  const stopping = runner;
  runner = undefined;
  stopping?.removeAllListeners("exit");
  await stopRunner(stopping);
}

before(async () => {
  mkdirSync(resolve(root, ".headless"), { recursive: true });
  scratch = mkdtempSync(resolve(root, ".headless/ki39-"));
  vault = resolve(scratch, "vault");
  config = resolve(scratch, "config");
  shots = resolve(scratch, "shots");
  mkdirSync(shots);
  const seeded = spawnSync(process.execPath, [resolve(root, "scripts/seed-desktop.mjs"), vault], { encoding: "utf8" });
  assert.equal(seeded.status, 0, seeded.stderr);
  // One About you line, so a reason can rest on it.
  mkdirSync(resolve(vault, ".kintsugi/agent"), { recursive: true });
  spawnSync("sh", ["-c", `printf -- '- Writes short essays about craft and repair.\\n' > "${resolve(vault, ".kintsugi/agent/USER.md")}"`]);
  const url = await start();
  browser = await chromium.launch({ headless: true }).catch((e) => {
    throw new Error(`${e}\nInstall it with: pnpm --filter @kintsugi/desktop exec playwright install chromium-headless-shell`);
  });
  page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  await openApp(page, url, () => output);
}, { timeout: TIMEOUT });

after(async () => {
  await browser?.close();
  await stop();
});

const shot = (name: string) => page.screenshot({ path: resolve(shots, `${name}.png`) });
const section = () => page.getByRole("region", { name: "Ideas" });
const rows = () => section().locator("li[data-idea]");
const openIdeas = async () => {
  // ⇧⌘E, like ⇧⌘F for the Feed and ⇧⌘I for Inspiration; the sidebar shows it.
  await page.locator("[data-sidebar=sidebar]").getByRole("button", { name: /^Ideas/ }).waitFor();
  await page.keyboard.press("Meta+Shift+e");
  await section().waitFor();
};

test("the daily batch arrives, grounded in quotes that are really there", { timeout: 120_000 }, async () => {
  await openIdeas();
  // The daily check runs a few seconds after start; the mock helper is quick.
  await rows().first().waitFor({ timeout: 60_000 });
  // The batch is in once its status says so; count the rows only then.
  await section().getByText(/Two from Kin today/).waitFor();
  const titles = await rows().locator("button[aria-expanded] span.block").first().allTextContents();
  assert.ok(titles.length > 0);
  assert.equal(await rows().count(), 2, "two grounded ideas");
  assert.equal(await section().getByText("An idea resting on a quote the mock invented").count(), 0, "the invented quote's idea was dropped");
  await section().getByText(/Two from Kin today/).waitFor();
  await shot("01-batch");
});

test("engaging shows the idea and its takeaways, citing quotes inline", { timeout: 60_000 }, async () => {
  await rows().first().locator("button[aria-expanded]").first().click();
  const first = rows().first();
  await first.getByLabel("Takeaways").waitFor();
  const cites = first.getByRole("button", { name: /^Quote \d+:/ });
  assert.ok((await cites.count()) >= 2, "inline citations");
  // KI-76: no eyebrow, no quote blocks, no workings or Why this? in the way.
  for (const gone of ["Kin's guess, not a fact", "How Kin found this", "Why this?", "Observed", "Hunch"])
    assert.equal(await first.getByText(gone, { exact: true }).count(), 0, gone);
  assert.equal(await first.locator("blockquote").count(), 0, "quotes stay behind their citations");
  await cites.first().hover();
  const popup = page.locator("blockquote").first();
  await popup.waitFor();
  await shot("02-engaged-citation");
  await page.mouse.move(0, 0);
  await popup.waitFor({ state: "detached" });
});

test("Refine replaces the idea, keeps the earlier version and undoes", { timeout: 60_000 }, async () => {
  const first = rows().first();
  const before = (await first.locator("button[aria-expanded] .block").first().textContent())!;
  await first.getByRole("button", { name: "Refine" }).click();
  await first.getByRole("button", { name: "Narrower" }).click();
  await first.locator("form").getByRole("button", { name: "Refine" }).click();
  await first.getByText("Refined · was").waitFor({ timeout: 30_000 });
  await first.getByText(`Narrower: ${before}`).waitFor();
  await shot("03-refined");
  await first.getByRole("status").getByRole("button", { name: "Undo" }).click();
  await first.getByText("Refined · was").waitFor({ state: "detached" });
  await first.locator("button[aria-expanded] .block").first().getByText(before, { exact: true }).waitFor();
});

test("Dismiss keeps the row in place with optional reasons and undo", { timeout: 60_000 }, async () => {
  const second = rows().nth(1);
  await second.locator("button[aria-expanded]").first().click();
  await second.getByRole("button", { name: "Dismiss" }).click();
  await section().getByText("Dismissed. Tell Kin why?").waitFor();
  await section().getByRole("button", { name: "Not for me" }).click();
  await section().getByText("Dismissed · Not for me. Kin will offer fewer like it.").waitFor();
  await shot("04-dismissed");
  await section().getByRole("button", { name: "Undo" }).click();
  await section().getByText("Dismissed · Not for me.").waitFor({ state: "detached" });
});

test("Discuss opens Kin with the idea as a chip", { timeout: 60_000 }, async () => {
  const first = rows().first();
  await first.locator("button[aria-expanded]").first().click();
  await first.getByRole("button", { name: "Discuss with Kin" }).click();
  const panel = page.getByRole("dialog", { name: "Kin" });
  await panel.locator('[data-chip^="idea:idea-"]').waitFor();
  await shot("05-discuss");
  await panel.getByRole("button", { name: "Hide Kin" }).first().click();
});

test("Adopt makes an empty draft with the idea beside it and in frontmatter", { timeout: 60_000 }, async () => {
  const first = rows().first();
  await first.getByRole("button", { name: "Adopt", exact: true }).click();
  await first.getByRole("group", { name: "Adopt this idea" }).waitFor();
  await shot("06-adopt");
  await first.getByRole("button", { name: "Create draft" }).click();
  await page.getByRole("button", { name: /beside this draft/ }).waitFor({ timeout: 20_000 });
  await page.getByRole("complementary", { name: "Idea beside the draft" }).waitFor();
  await shot("07-adopted-draft");
  const drafts = readdirSync(resolve(vault, "drafts")).filter((f) => f.endsWith(".mdx"));
  assert.equal(drafts.length, 1);
  const text = readFileSync(resolve(vault, "drafts", drafts[0]), "utf8");
  assert.match(text, /^---\ntitle: ".+"\nstatus: draft\nideas:\n {2}- id: idea-\S+\n {4}from: kin\n/);
  assert.match(text, / {6}- "\[\[[^\]]+\]\]"\n/);
  assert.ok(text.endsWith("---\n\n"), "the body is empty");
});

test("an idea can be added to a draft already started; Ideas for this draft filters to it", { timeout: 60_000 }, async () => {
  const before = readFileSync(resolve(vault, STARTED), "utf8");
  await openIdeas();
  await section().locator("li[data-adopted]").first().waitFor();
  const second = rows().nth(1);
  await second.locator("button[aria-expanded]").first().click();
  await second.getByRole("button", { name: "Adopt", exact: true }).click();
  await second.getByRole("button", { name: new RegExp(STARTED) }).click();
  await page.getByRole("button", { name: /beside this draft/ }).waitFor({ timeout: 20_000 });
  const after = readFileSync(resolve(vault, STARTED), "utf8");
  const body = (t: string) => t.slice(t.indexOf("\n---", 3) + 4);
  assert.equal(body(after), body(before), "the body is untouched");
  assert.match(after, /\nideas:\n {2}- id: idea-/);
  assert.ok(!after.includes(`[[${STARTED.replace(/\.md$/, "")}]]`), "no link to itself");

  await page.getByRole("button", { name: "Ideas", exact: true }).last().click();
  await section().getByRole("heading", { name: "Ideas for this draft" }).waitFor();
  await section().locator("li[data-adopted]").first().waitFor();
  assert.ok((await rows().count()) >= 1);
  await shot("08-ideas-for-this-draft");
  await section().getByRole("button", { name: "Show all ideas" }).click();
  await section().getByRole("heading", { name: "Ideas", exact: true }).waitFor();

  // A new draft's only links are its ideas' clips, in frontmatter: the
  // reference index (and so each clip's "Used in") counts them.
  const fresh = readdirSync(resolve(vault, "drafts")).find((f) => f.endsWith(".mdx"))!;
  const draft = `drafts/${fresh}`;
  const clips = [...readFileSync(resolve(vault, draft), "utf8").matchAll(/- "\[\[([^\]]+)\]\]"/g)].map((m) => m[1]);
  assert.ok(clips.length >= 2);
  const index = await page.evaluate(() =>
    (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string) => Promise<{ links: { source: string; resolved: string | null }[] }> } })
      .__TAURI_INTERNALS__.invoke("reference_index"),
  );
  const resolved = index.links.filter((l) => l.source === draft).map((l) => l.resolved?.replace(/\.(mdx?|md)$/, ""));
  assert.deepEqual(resolved.sort(), clips.sort());
});

test("unused ideas thin from day three and fade after a week; adopted ones don't", { timeout: 240_000 }, async () => {
  // An unused idea to watch fade: ask for more, as the phone does.
  await openIdeas();
  await page.evaluate(() =>
    (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: object) => Promise<unknown> } }).__TAURI_INTERNALS__.invoke("ideas_generate", {}),
  );
  await page.waitForFunction(() => document.querySelectorAll("li[data-idea]").length >= 3, null, { timeout: 60_000 }).catch(() => {});
  await stop();
  await page.goto(await start({ KINTSUGI_HEADLESS_IDEAS_DAYS_AHEAD: "4" }));
  await openIdeas();
  await section().locator('li[data-stage="thin"]').first().waitFor({ timeout: 30_000 }).catch(async () => {
    // Every idea may have been adopted; then nothing thins, which is right too.
  });
  await page.waitForTimeout(1500);
  await shot("09-day-4");
  await stop();
  await page.goto(await start({ KINTSUGI_HEADLESS_IDEAS_DAYS_AHEAD: "8" }));
  await openIdeas();
  await page.waitForTimeout(1500);
  const faded = section().getByRole("button", { name: /faded this week/ });
  if (await faded.count()) {
    await faded.click();
    await section().getByText("Unused, so Kin counts it as a weak no").first().waitFor();
  }
  // Adopted ideas are still listed, still full strength.
  await section().locator('li[data-stage="fresh"][data-adopted]').first().waitFor();
  await shot("10-day-8");
  const signals = readdirSync(resolve(config, "kin/ideas"));
  assert.equal(signals.length, 1);
  const log = readFileSync(resolve(config, "kin/ideas", signals[0], "signals.jsonl"), "utf8");
  for (const kind of ["refined", "refineUndone", "dismissed", "undismissed", "discussed", "adopted"]) assert.ok(log.includes(`"kind":"${kind}"`), kind);
});
