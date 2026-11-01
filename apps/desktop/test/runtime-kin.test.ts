// KI-31 against the real runtime: `pnpm desktop:headless` (the real Rust
// command registry on Tauri MockRuntime, and the real React app) driven by
// headless Chromium, with Kin on the scripted headless model
// (`KINTSUGI_HEADLESS_KIN=mock`): no credentials, no provider, no cost.
//
// Covers the avatar on every screen, context chips (document, selection,
// clip via Discuss), bursts batched into one turn, typing interrupting Kin,
// threads that resume with an idle summary, and helper jobs that report
// back quietly. Everything lives in a fresh scratch vault and config under
// .headless/; screenshots go to .headless/<run>/shots/.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";

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
      KINTSUGI_HEADLESS_KIN_IDLE_MS: "2500",
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
  page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  await page.goto(url);
}, { timeout: TIMEOUT });

after(async () => {
  await browser?.close();
  if (runner?.pid) {
    try {
      process.kill(-runner.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
});

const panel = () => page.getByRole("dialog", { name: "Kin" });
const header = () => panel().locator("[data-thread]");
const box = () => panel().getByRole("textbox", { name: "Message Kin" });
const mine = (text: string) => panel().locator('[data-role="owner"]').getByText(text, { exact: true });
const kinReplies = () => panel().locator('[data-role="kin"]');
const shot = (name: string) => page.screenshot({ path: resolve(shots, `${name}.png`) });

async function openDoc(path: string) {
  await page.locator(`[title="${path}"]`).click();
  await page.locator(`[title="${path}"][data-active="true"]`).waitFor();
}

async function say(text: string) {
  await box().fill(text);
  await box().press("Enter");
}

test("the avatar opens one chat with what's on screen as removable chips", { timeout: 120_000 }, async () => {
  await openDoc(DRAFT);
  await page.getByRole("button", { name: "Ask Kin" }).waitFor();
  // Select a passage, then open Kin: the passage and the document come along.
  await page.locator(".cm-line", { hasText: "The first time I saw a kintsugi bowl" }).click({ clickCount: 3 });
  await page.keyboard.press("Meta+j");
  await panel().waitFor();
  const context = panel().getByLabel("Context");
  await context.locator('[data-chip^="paragraph:drafts/kintsugi-and-gold.md:"]').waitFor();
  await context.locator(`[data-chip="doc:${DRAFT}"]`).getByText("Kintsugi and gold").waitFor();
  await header().getByText("About Kintsugi and gold").waitFor();
  await shot("01-chips");

  // Remove the passage chip: only the document goes with the message.
  await context.locator('[data-chip^="paragraph:"]').getByRole("button").click();
  assert.equal(await context.locator('[data-chip^="paragraph:"]').count(), 0);
  await say("Is the gold metaphor overworked here?");
  await kinReplies().first().getByText(/You said: “Is the gold metaphor overworked here\?”/).waitFor({ timeout: 30_000 });
  // The scripted model read the chip, as a reference on demand.
  await kinReplies().first().getByText(`read {"limit":20,"path":"${DRAFT}"}`, { exact: false }).waitFor();
  await shot("02-answered");
});

test("a burst of messages is answered as one turn", { timeout: 60_000 }, async () => {
  const before = await kinReplies().count();
  await say("Also: the ending.");
  await say("And the title.");
  const reply = kinReplies().nth(before);
  await reply.getByText("You said: “Also: the ending. / And the title.”", { exact: false }).waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  assert.equal(await kinReplies().count(), before + 1, "one reply for the burst");
  // It's the same draft's thread, with the earlier exchange as history.
  await reply.getByText("This thread has 1 earlier exchange(s)", { exact: false }).waitFor();
});

test("typing interrupts Kin; the next turn answers what was waiting", { timeout: 60_000 }, async () => {
  const before = await kinReplies().count();
  await say("Tell me everything about kilns");
  await panel().locator("[data-live]").getByText("You said", { exact: false }).waitFor({ timeout: 30_000 });
  await box().pressSequentially("Only Japan", { delay: 30 });
  await panel().locator("[data-interrupted]").first().waitFor({ timeout: 10_000 });
  await shot("03-interrupted");
  await box().pressSequentially("ese ones");
  await box().press("Enter");
  await kinReplies().last().getByText("You said: “Tell me everything about kilns / Only Japanese ones”", { exact: false }).waitFor({ timeout: 30_000 });
  assert.equal(await kinReplies().count(), before + 2, "an interrupted reply and a full one");
});

test("Discuss on a clip opens the chat with the clip; returning to the draft resumes its thread", { timeout: 120_000 }, async () => {
  await panel().getByRole("button", { name: "Close Kin" }).first().click();
  await page.keyboard.press("Meta+Shift+i");
  await page.locator(`[data-clip-path="${CLIP}"]`).click();
  await page.getByRole("button", { name: "Discuss" }).click();
  await panel().waitFor();
  await panel().getByLabel("Context").locator(`[data-chip="clip:${CLIP}"]`).waitFor();
  await header().getByText("About Golden joinery").waitFor();
  await say("Why did I keep this?");
  await kinReplies().last().getByText(`read {"limit":20,"path":"${CLIP}"}`, { exact: false }).waitFor({ timeout: 30_000 });
  await kinReplies().last().getByText("This thread has 0 earlier exchange(s)", { exact: false }).waitFor();
  await shot("04-discuss-clip");

  // Back to the draft: the chat follows to the draft's thread, and once
  // he's idle Kin writes its running summary.
  await panel().getByRole("button", { name: "Close Kin" }).first().click();
  await openDoc(DRAFT);
  await page.getByRole("button", { name: "Ask Kin" }).click();
  await header().getByText("About Kintsugi and gold").waitFor();
  await mine("Is the gold metaphor overworked here?").waitFor();
  assert.equal(await mine("Why did I keep this?").count(), 0, "the clip's thread stays separate");
  await panel().getByLabel("Thread summary").getByText("Mock summary", { exact: false }).waitFor({ timeout: 30_000 });
  await shot("05-resumed-thread");

  // Everything: the one log, all threads.
  await panel().getByRole("button", { name: "Conversation", exact: true }).click();
  await page.getByRole("button", { name: /^Everything/ }).click();
  await mine("Why did I keep this?").waitFor();
  await mine("Is the gold metaphor overworked here?").waitFor();
});

test("helper jobs run in the background and report back quietly", { timeout: 60_000 }, async () => {
  await panel().getByRole("button", { name: "Close Kin" }).first().click();
  const job = await page.evaluate(() =>
    (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<{ id: string }> } })
      .__TAURI_INTERNALS__.invoke("kin_job_create", { job: { kind: "feed-ranking", task: "triage", brief: "Rank recent clips about repair." } }),
  );
  // Quietly: a dot on the avatar, no panel popping open.
  await page.locator("[data-kin-unread]").waitFor({ timeout: 30_000 });
  assert.equal(await panel().count(), 0);
  await shot("06-helper-unread");
  await page.getByRole("button", { name: "Ask Kin" }).click();
  await panel().getByRole("button", { name: "Conversation", exact: true }).click();
  await page.getByRole("button", { name: /^Everything/ }).click();
  await panel().locator('[data-role="helper"]').getByText("You said: “", { exact: false }).waitFor();
  await shot("07-helper-report");

  // Durable, in app data, never in the vault.
  const table = JSON.parse(readFileSync(resolve(config, "kin/jobs.json"), "utf8")) as { id: string; status: string }[];
  assert.equal(table.find((j) => j.id === job.id)?.status, "done");
  const log = readFileSync(resolve(config, "kin/conversation/log.jsonl"), "utf8");
  assert.ok(log.includes("Is the gold metaphor overworked here?") && log.includes(`"job":"${job.id}"`));
  assert.ok(existsSync(resolve(config, "kin/conversation/threads.json")));
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(resolve(dir, e.name)) : [resolve(dir, e.name)]));
  assert.ok(!walk(vault).some((f) => readFileSync(f).includes("Is the gold metaphor overworked")), "the vault holds no conversation");
});
