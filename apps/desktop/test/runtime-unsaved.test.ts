// KI-14 regression checks against the real runtime: `pnpm desktop:headless`
// (the real Rust command registry on Tauri MockRuntime, and the real React app)
// driven by headless Chromium. A save fails because its folder is read-only;
// switching documents, switching vaults and closing the window must all wait
// until a retry succeeds or the writer discards the change.
//
// Everything lives in a fresh scratch vault under .headless/. No native
// window, Dock icon or owner vault/config is involved.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DOC = "posts/the-quiet-web.mdx";
const OTHER = "notes/repair.md";
const TIMEOUT = Number(process.env.KINTSUGI_RUNTIME_TIMEOUT ?? 15 * 60_000);

let runner: ChildProcess;
let browser: Browser;
let url = "";
let vault = "";
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

const readOnly = (on: boolean) => chmodSync(resolve(vault, dirname(DOC)), on ? 0o500 : 0o755);
const onDisk = (path: string) => readFileSync(resolve(vault, path), "utf8");

before(async () => {
  mkdirSync(resolve(root, ".headless"), { recursive: true });
  const scratch = mkdtempSync(resolve(root, ".headless/ki14-"));
  vault = resolve(scratch, "vault");
  const seeded = spawnSync(process.execPath, [resolve(root, "scripts/seed-desktop.mjs"), vault], { encoding: "utf8" });
  assert.equal(seeded.status, 0, seeded.stderr);
  // A second vault inside the scratch vault: the only kind the prompt opens.
  mkdirSync(resolve(vault, "elsewhere"));
  writeFileSync(resolve(vault, "elsewhere/other-vault.md"), "---\ntitle: Other vault\n---\n\nA different vault.\n");

  const [frontend, backend] = [await freePort(), await freePort()];
  runner = spawn(process.execPath, [resolve(root, "scripts/desktop-headless.mjs")], {
    cwd: root,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      KINTSUGI_VAULT: vault,
      KINTSUGI_CONFIG_DIR: resolve(scratch, "config"),
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
  // Headless shell only: never a visible browser window.
  browser = await chromium.launch({ headless: true }).catch((e) => {
    throw new Error(`${e}\nInstall it with: pnpm --filter @kintsugi/desktop exec playwright install chromium-headless-shell`);
  });
}, { timeout: TIMEOUT });

after(async () => {
  if (vault) readOnly(false);
  await browser?.close();
  if (runner?.pid) {
    try {
      process.kill(-runner.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
});

/** Opens the app with the scratch document showing and a failed save of `marker` in it. */
async function failedSave(marker: string) {
  const page = await browser.newPage();
  const destroyed: string[] = [];
  // Record the window teardown a close would do, without doing it: the mock
  // webview is this tab's identity.
  await page.route("**/invoke", async (route) => {
    const call = route.request().postDataJSON() as { cmd?: string } | null;
    if (call?.cmd !== "plugin:window|destroy") return route.continue();
    destroyed.push(call.cmd);
    await route.fulfill({
      contentType: "application/json",
      headers: { "access-control-allow-origin": new URL(page.url()).origin },
      body: JSON.stringify({ ok: true, value: null }),
    });
  });
  await page.goto(url);
  await page.locator(`[title="${DOC}"]`).click();
  await page.locator(`[title="${DOC}"][data-active="true"]`).waitFor();
  readOnly(true);
  await page.locator(".cm-content").click();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type(`\n${marker}`);
  await page.getByText("Not saved", { exact: true }).waitFor();
  assert.ok(!onDisk(DOC).includes(marker));
  return { page, destroyed };
}

const unsaved = (page: Page) => page.getByRole("dialog", { name: "“the-quiet-web.mdx” isn’t saved" });
const choose = (page: Page, button: "Try again" | "Discard changes" | "Keep editing") =>
  unsaved(page).getByRole("button", { name: button }).click();
const stillOnDoc = async (page: Page, marker: string) => {
  await page.locator(`[title="${DOC}"][data-active="true"]`).waitFor();
  assert.ok((await page.locator(".cm-content").innerText()).includes(marker), "the unsaved text is still in the editor");
};

test("switching documents waits for the failed save; discarding is explicit", { timeout: 60_000 }, async () => {
  const marker = "KI-14 document switch marker";
  const { page } = await failedSave(marker);
  try {
    await page.locator(`[title="${OTHER}"]`).click();
    await unsaved(page).waitFor();
    await choose(page, "Keep editing");
    await stillOnDoc(page, marker);

    // Still failing on another attempt: still blocked, still pending.
    await page.locator(`[title="${OTHER}"]`).click();
    await choose(page, "Try again");
    await unsaved(page).waitFor();
    await choose(page, "Discard changes");
    await page.locator(`[title="${OTHER}"][data-active="true"]`).waitFor();
    readOnly(false);
    // Discarded means gone: a later save never resurrects it.
    await page.keyboard.press("Meta+s");
    await page.getByText("Saved", { exact: true }).waitFor();
    assert.ok(!onDisk(DOC).includes(marker));
  } finally {
    readOnly(false);
    await page.close();
  }
});

test("closing the window waits for the failed save and closes once a retry lands", { timeout: 60_000 }, async () => {
  const marker = "KI-14 close marker";
  const { page, destroyed } = await failedSave(marker);
  const close = () =>
    page.evaluate(() =>
      (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> } })
        .__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "tauri://close-requested", payload: null }),
    );
  try {
    await close();
    await unsaved(page).waitFor();
    await choose(page, "Keep editing");
    await stillOnDoc(page, marker);
    await page.waitForTimeout(300);
    assert.deepEqual(destroyed, [], "the window stayed open");

    await close();
    await unsaved(page).waitFor();
    readOnly(false);
    await choose(page, "Try again");
    for (let i = 0; i < 50 && !destroyed.length; i++) await page.waitForTimeout(100);
    assert.deepEqual(destroyed, ["plugin:window|destroy"], "closed after the save");
    assert.ok(onDisk(DOC).includes(marker), "the retried save is on disk");
  } finally {
    readOnly(false);
    await page.close();
  }
});

// Last: it changes the backend's current vault.
test("switching vaults waits for the failed save and switches once a retry lands", { timeout: 60_000 }, async () => {
  const marker = "KI-14 vault switch marker";
  const { page } = await failedSave(marker);
  const switchVault = async () => {
    await page.keyboard.press("Meta+Shift+O");
    const prompt = page.locator("dialog[data-headless-dialog]");
    await prompt.locator("input").fill(resolve(vault, "elsewhere"));
    await prompt.getByRole("button", { name: "OK" }).click();
  };
  try {
    await switchVault();
    await unsaved(page).waitFor();
    await choose(page, "Keep editing");
    await stillOnDoc(page, marker);
    assert.equal(await page.locator('[title="other-vault.md"]').count(), 0, "still in the first vault");

    await page.locator(".cm-content").click();
    await switchVault();
    await unsaved(page).waitFor();
    readOnly(false);
    await choose(page, "Try again");
    await page.locator('[title="other-vault.md"]').waitFor();
    assert.ok(onDisk(DOC).includes(marker), "the retried save is on disk");
  } finally {
    readOnly(false);
    await page.close();
  }
});
