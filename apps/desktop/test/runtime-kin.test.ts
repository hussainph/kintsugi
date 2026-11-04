// KI-31 and KI-104 against the real runtime: `pnpm desktop:headless` (the
// real Rust command registry on Tauri MockRuntime, and the real React app)
// driven by headless Chromium, with Kin on the scripted headless model
// (`KINTSUGI_HEADLESS_KIN=mock`): no credentials, no provider, no cost.
//
// Covers the avatar on every screen and Kin's tab of small threads: a new
// thread with what's on screen as removable chips, bursts batched into one
// turn, typing interrupting Kin, web sources, Discuss starting its own
// thread, the draft's list, All threads and its search, resolving, helper
// jobs that report in a thread of their own, and switching vaults.
// Everything lives in a fresh scratch vault and config under .headless/;
// screenshots go to .headless/<run>/shots/.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { stopRunner, openApp } from "./headless-app.ts";
import { waitForFrontend } from "../../../scripts/frontend-ready.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DRAFT = "drafts/kintsugi-and-gold.md";
const CLIP = "inspiration/golden-joinery.md";
const TIMEOUT = Number(process.env.KINTSUGI_RUNTIME_TIMEOUT ?? 15 * 60_000);

let runner: ChildProcess;
let browser: Browser;
let page: Page;
let url = "";
let scratch = "";
let vault = "";
let config = "";
let shots = "";
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

before(async () => {
  mkdirSync(resolve(root, ".headless"), { recursive: true });
  scratch = mkdtempSync(resolve(root, ".headless/ki31-"));
  vault = resolve(scratch, "vault");
  config = resolve(scratch, "config");
  shots = resolve(scratch, "shots");
  mkdirSync(shots);
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
      KINTSUGI_HEADLESS_KIN: "mock",
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
  page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  await openApp(page, url, () => output);
}, { timeout: TIMEOUT });

after(async () => {
  await browser?.close();
  await stopRunner(runner, () => output);
});

const panel = () => page.getByRole("region", { name: "Kin" });
const box = () => panel().getByRole("textbox", { name: "Message Kin" });
const mine = (text: string) => panel().locator('[data-role="owner"]').getByText(text, { exact: true });
const kinReplies = () => panel().locator('[data-role="kin"]');
const rows = () => panel().locator("[data-thread]");
const row = (title: string) => panel().locator("[data-thread]", { has: page.locator(".ki-kin-row-title", { hasText: title }) });
const shot = (name: string) => page.screenshot({ path: resolve(shots, `${name}.png`) });
const threadsDir = () => resolve(vault, ".kintsugi/kin/threads");
type Meta = { id: string; title: string; status: string; origin: string; anchor?: { kind: string; path: string } };
const index = (): Meta[] => JSON.parse(readFileSync(resolve(threadsDir(), "index.json"), "utf8")).threads;
const lines = (id: string) => readFileSync(resolve(threadsDir(), `${id}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));

async function openDoc(path: string) {
  await page.locator(`[title="${path}"]`).click();
  await page.locator(`[title="${path}"][data-active="true"]`).waitFor();
}

async function say(text: string) {
  await box().fill(text);
  await box().press("Enter");
}

async function back() {
  await panel().getByRole("button", { name: "Back" }).click();
  await panel().locator("[data-new-thread], [data-all-threads]").first().waitFor();
}

test("the avatar opens Kin on the draft's threads; a new thread takes what's on screen", { timeout: 120_000 }, async () => {
  await openDoc(DRAFT);
  await page.getByRole("button", { name: "Ask Kin" }).waitFor();
  await page.keyboard.press("Meta+j");
  await panel().waitFor();
  await panel().getByText("No threads on this draft yet.").waitFor();
  await shot("01-empty-draft");
  await page.keyboard.press("Meta+j");
  await panel().waitFor({ state: "detached" });

  // Select a passage, then open Kin and start a thread: the passage and the document come along.
  await page.locator(".cm-line", { hasText: "The first time I saw a kintsugi bowl" }).click({ clickCount: 3 });
  await page.keyboard.press("Meta+j");
  await panel().getByRole("button", { name: "New thread" }).click();
  const context = panel().getByLabel("Context");
  await context.locator('[data-chip^="paragraph:drafts/kintsugi-and-gold.md:"]').waitFor();
  await context.locator(`[data-chip="doc:${DRAFT}"]`).getByText("Kintsugi and gold").waitFor();
  await shot("02-new-thread");

  // Remove the passage chip: only the document goes with the message.
  await context.locator('[data-chip^="paragraph:"]').getByRole("button").click();
  assert.equal(await context.locator('[data-chip^="paragraph:"]').count(), 0);
  await say("Is the gold metaphor overworked here?");
  await kinReplies().first().getByText(/You said: “Is the gold metaphor overworked here\?”/).waitFor({ timeout: 30_000 });
  // The scripted model read the chip, as a reference on demand, and knows what the thread is about.
  await kinReplies().first().getByText(`read {"limit":20,"path":"${DRAFT}"}`, { exact: false }).waitFor();
  await kinReplies().first().getByText("knows what it's about", { exact: false }).waitFor();
  // Titled from his first message, about the draft.
  await panel().locator("[data-thread-title]").getByText("Is the gold metaphor overworked here?").waitFor();
  const [meta] = index();
  assert.equal(meta.anchor?.path, DRAFT);
  assert.equal(lines(meta.id).length, 2);
  await shot("03-answered");
});

test("a burst of messages in a thread is answered as one turn", { timeout: 60_000 }, async () => {
  const before = await kinReplies().count();
  await say("Also: the ending.");
  await say("And the title.");
  const reply = kinReplies().nth(before);
  await reply.getByText("You said: “Also: the ending. / And the title.”", { exact: false }).waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  assert.equal(await kinReplies().count(), before + 1, "one reply for the burst");
  // The thread's earlier exchange is its history.
  await reply.getByText("This thread has 1 earlier exchange(s)", { exact: false }).waitFor();
});

test("typing interrupts Kin; the next turn answers what was waiting", { timeout: 60_000 }, async () => {
  const before = await kinReplies().count();
  await say("Tell me everything about kilns");
  await panel().locator("[data-live]").getByText("You said", { exact: false }).waitFor({ timeout: 30_000 });
  await box().pressSequentially("Only Japan", { delay: 30 });
  await panel().locator("[data-interrupted]").first().waitFor({ timeout: 10_000 });
  await shot("04-interrupted");
  await box().pressSequentially("ese ones");
  await box().press("Enter");
  await kinReplies().last().getByText("You said: “Tell me everything about kilns / Only Japanese ones”", { exact: false }).waitFor({ timeout: 30_000 });
  assert.equal(await kinReplies().count(), before + 2, "an interrupted reply and a full one");
});

test("Kin searches the web (scripted) and shows its sources with their actions", { timeout: 90_000 }, async () => {
  const before = await kinReplies().count();
  await say("Search the web for golden joinery");
  await panel().locator("[data-live]").getByText("Searched the web for “golden joinery”").waitFor({ timeout: 30_000 });
  const reply = kinReplies().nth(before);
  await reply.getByText("It returned: # Mock page at en.wikipedia.org", { exact: false }).waitFor({ timeout: 30_000 });
  const sources = reply.locator("[data-web-sources]");
  await sources.getByRole("button", { name: "3 web sources" }).click();
  await sources.getByText("Searched “golden joinery” · read 1 page").waitFor();
  const first = sources.locator('[data-web-source="https://en.wikipedia.org/wiki/golden-joinery"]');
  await first.getByText("Mock page at en.wikipedia.org").waitFor();
  await first.hover();
  await first.getByRole("button", { name: "Save to Inspiration" }).waitFor();
  await first.getByRole("button", { name: "Turn into an idea" }).waitFor();
  await shot("05-web-sources");
  // The draft is on screen: the link goes in after the cursor.
  await first.getByRole("button", { name: "Add link to the document" }).click();
  await page.locator(".cm-content").getByText("(https://en.wikipedia.org/wiki/golden-joinery)", { exact: false }).waitFor();
  // The sources are kept with the reply, in the thread's own file.
  const thread = readFileSync(resolve(threadsDir(), `${index()[0].id}.jsonl`), "utf8");
  assert.ok(thread.includes('"web":[{"tool":"search","query":"golden joinery","provider":"mock"'), "the reply keeps its web calls");
});

test("Discuss on a clip starts its own thread; the draft lists its own; All threads finds both", { timeout: 120_000 }, async () => {
  await page.keyboard.press("Meta+j");
  await panel().waitFor({ state: "detached" });
  await page.keyboard.press("Meta+Shift+i");
  await page.locator(`[data-clip-path="${CLIP}"]`).click();
  await page.getByRole("button", { name: "Discuss" }).click();
  await panel().waitFor();
  await panel().locator("[data-new]").waitFor();
  await panel().getByLabel("Context").locator(`[data-chip="clip:${CLIP}"]`).waitFor();
  await say("Why did I keep this?");
  await kinReplies().last().getByText(`read {"limit":20,"path":"${CLIP}"}`, { exact: false }).waitFor({ timeout: 30_000 });
  await kinReplies().last().getByText("This thread has 0 earlier exchange(s)", { exact: false }).waitFor();
  assert.equal(await mine("Is the gold metaphor overworked here?").count(), 0, "a new thread starts with nothing");
  await shot("06-discuss-clip");
  // Away from the editor, the clip's threads come first.
  await back();
  await row("Why did I keep this?").waitFor();

  // Back on the draft: its thread, and not the clip's.
  await page.keyboard.press("Meta+j");
  await openDoc(DRAFT);
  await page.getByRole("button", { name: "Ask Kin" }).click();
  await row("Is the gold metaphor overworked here?").waitFor();
  assert.equal(await row("Why did I keep this?").count(), 0, "the clip's thread isn't the draft's");
  await shot("07-draft-list");
  await row("Is the gold metaphor overworked here?").click();
  await mine("Is the gold metaphor overworked here?").waitFor();
  await back();

  // All threads: every thread, searchable.
  await panel().getByRole("button", { name: "All threads" }).click();
  await row("Why did I keep this?").waitFor();
  await row("Is the gold metaphor overworked here?").waitFor();
  await panel().getByRole("textbox", { name: "Search threads" }).fill("japanese");
  await row("Is the gold metaphor overworked here?").locator(".ki-kin-row-preview").getByText("Japanese", { exact: false }).waitFor();
  await page.waitForTimeout(400);
  assert.equal(await rows().count(), 1, "only the thread that mentions it");
  await shot("08-all-threads-search");
});

test("resolving puts a thread away; it stays findable and reopens", { timeout: 60_000 }, async () => {
  await row("Is the gold metaphor overworked here?").click();
  await panel().getByRole("button", { name: "Resolve" }).click();
  await panel().locator("[data-new-thread]").waitFor();
  await panel().getByText("No threads on this draft yet.").waitFor();
  assert.equal(index().find((t) => t.title.startsWith("Is the gold"))?.status, "resolved");
  await panel().getByRole("button", { name: "All threads" }).click();
  await row("Is the gold metaphor overworked here?").getByText("Resolved").waitFor();
  await row("Is the gold metaphor overworked here?").click();
  await panel().getByRole("button", { name: "Reopen" }).click();
  await panel().getByRole("button", { name: "Resolve" }).waitFor();
  // Renamed in place.
  await panel().locator("[data-thread-title]").click();
  await panel().getByRole("textbox", { name: "Thread title" }).fill("The gold metaphor");
  await panel().getByRole("textbox", { name: "Thread title" }).press("Enter");
  await panel().locator("[data-thread-title]").getByText("The gold metaphor").waitFor();
  for (const end = Date.now() + 5_000; !index().some((t) => t.title === "The gold metaphor") && Date.now() < end; ) await page.waitForTimeout(100);
  assert.ok(index().some((t) => t.title === "The gold metaphor" && t.status === "open"));
});

test("helper jobs run in the background and report in a thread of their own", { timeout: 60_000 }, async () => {
  await page.keyboard.press("Meta+j");
  await panel().waitFor({ state: "detached" });
  const job = await page.evaluate(() =>
    (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<{ id: string }> } })
      .__TAURI_INTERNALS__.invoke("kin_job_create", { job: { kind: "feed-ranking", task: "triage", brief: "Rank recent clips about repair." } }),
  );
  // Quietly: a dot on the avatar, no pane popping open.
  await page.locator("[data-kin-unread]").waitFor({ timeout: 30_000 });
  assert.equal(await panel().count(), 0);
  await shot("09-helper-unread");
  await page.getByRole("button", { name: "Ask Kin" }).click();
  // Kin opens where he left it, in the thread; Back is the list.
  await back();
  await panel().getByRole("button", { name: "All threads" }).click();
  const report = index().find((t) => t.origin === "helper");
  assert.ok(report, "the report is its own thread");
  await panel().locator(`[data-thread="${report.id}"]`).click();
  await panel().locator('[data-role="helper"]').getByText("You said: “", { exact: false }).waitFor();
  await shot("10-helper-report");

  const status = () => (JSON.parse(readFileSync(resolve(config, "kin/jobs.json"), "utf8")) as { id: string; status: string }[]).find((j) => j.id === job.id)?.status;
  for (const end = Date.now() + 30_000; status() !== "done" && Date.now() < end; ) await page.waitForTimeout(100);
  assert.equal(status(), "done");
  assert.ok(lines(report.id).some((e) => e.job === job.id));
  // The threads are the vault's own, in .kintsugi/kin/, and nowhere else.
  const kinDir = resolve(vault, ".kintsugi/kin");
  assert.ok(!existsSync(resolve(kinDir, "log.jsonl")), "no single log any more");
  assert.ok(!existsSync(resolve(config, "kin/conversation")), "no global log in app data");
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(resolve(dir, e.name)) : [resolve(dir, e.name)]));
  const elsewhere = [...walk(vault).filter((f) => !f.startsWith(kinDir + "/")), ...walk(config)];
  assert.ok(!elsewhere.some((f) => readFileSync(f).includes("Is the gold metaphor overworked")), "threads are only in .kintsugi/kin/");
});

test("opening another vault switches the threads", { timeout: 60_000 }, async () => {
  // Headless opens folders inside its scratch vault only: the second vault is nested.
  const second = resolve(vault, "second-vault");
  mkdirSync(second, { recursive: true });
  const open = (path: string) =>
    page.evaluate(
      (path) =>
        (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<string> } })
          .__TAURI_INTERNALS__.invoke("vault_open", { path }),
      path,
    );
  await back();
  await panel().getByRole("button", { name: "All threads" }).click();
  await row("The gold metaphor").waitFor();

  await open(second);
  await panel().locator("[data-new-thread]").waitFor();
  await panel().getByRole("button", { name: "All threads" }).click();
  await panel().getByText("No threads yet.").waitFor({ timeout: 10_000 });
  assert.equal(await rows().count(), 0, "the other vault starts with none");
  await shot("11-other-vault");
  assert.ok(!existsSync(resolve(second, ".kintsugi/kin/threads")));

  await open(vault);
  await panel().getByRole("button", { name: "All threads" }).click();
  await row("The gold metaphor").waitFor({ timeout: 10_000 });
  await shot("12-back");
});
