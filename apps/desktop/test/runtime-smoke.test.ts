// KI-55's smoke hook against the real runtime: with KINTSUGI_SMOKE=1 the app
// calls `app_ready` once the vault has loaded and rendered, and the backend
// prints KINTSUGI_SMOKE_READY. CI's packaged-app job (scripts/smoke-app.mjs)
// waits for the same marker from a real window; this checks the frontend half
// headlessly. The headless backend keeps running after the marker.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { startApp, type App } from "./headless-app.ts";

const TIMEOUT = Number(process.env.KINTSUGI_RUNTIME_TIMEOUT ?? 15 * 60_000);

let app: App;
let browser: Browser;

before(async () => {
  app = await startApp("ki55", { KINTSUGI_SMOKE: "1" }, (vault) => {
    writeFileSync(resolve(vault, "drafts/dim-me.md"), "# Picked by the user\n");
    writeFileSync(resolve(vault, "drafts/dim-me-too.mdx"), "# Default draft\n");
  });
  browser = await chromium.launch({ headless: true }).catch((e) => {
    throw new Error(`${e}\nInstall it with: pnpm --filter @kintsugi/desktop exec playwright install chromium-headless-shell`);
  });
}, { timeout: TIMEOUT });

after(async () => {
  await browser?.close();
  await app?.stop();
});

test("the app reports ready once its vault has rendered", { timeout: 60_000 }, async () => {
  assert.doesNotMatch(app.output(), /KINTSUGI_SMOKE_READY/);
  const page = await browser.newPage();
  await page.goto(app.url);
  let found: RegExpExecArray | null = null;
  for (let i = 0; i < 300 && !found; i++) {
    found = /^KINTSUGI_SMOKE_READY rendered=(\d+)$/m.exec(app.output());
    if (!found) await page.waitForTimeout(100);
  }
  assert.ok(found, `no KINTSUGI_SMOKE_READY; the runner printed:\n${app.output().slice(-4000)}`);
  assert.ok(Number(found[1]) > 0, "the page rendered no text");
});

test("a late second startup cannot replace a document the user is opening", { timeout: 60_000 }, async () => {
  const page = await browser.newPage();
  let releaseStartup!: () => void, releaseRead!: () => void;
  const startupGate = new Promise<void>((done) => releaseStartup = done);
  const readGate = new Promise<void>((done) => releaseRead = done);
  let reading!: () => void, ready!: () => void;
  const pickedRead = new Promise<void>((done) => reading = done);
  const bothReady = new Promise<void>((done) => ready = done);
  let vaultCalls = 0, readyCalls = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/invoke") && request.postDataJSON().cmd === "app_ready" && ++readyCalls === 2) ready();
  });
  await page.route("**/invoke", async (route) => {
    const { cmd, args } = route.request().postDataJSON();
    if (cmd === "vault_current" && ++vaultCalls === 2) await startupGate;
    if (cmd === "doc_read" && args.path === "drafts/dim-me.md") {
      reading();
      await readGate;
    }
    await route.continue();
  });
  try {
    await page.goto(app.url);
    await page.locator('[title="drafts/dim-me-too.mdx"][data-active="true"]').waitFor();
    await page.locator('[title="drafts/dim-me.md"]').click();
    await pickedRead;
    // The second StrictMode startup begins only after the user's read is in
    // flight. Its old default choice must not supersede that pending read.
    releaseStartup();
    await bothReady;
    const response = page.waitForResponse((res) => {
      const body = res.request().postDataJSON();
      return body?.cmd === "doc_read" && body.args?.path === "drafts/dim-me.md";
    });
    releaseRead();
    await response;
    await page.locator('[title="drafts/dim-me.md"][data-active="true"]').waitFor();
    await page.locator(".cm-line", { hasText: "Picked by the user" }).waitFor();
    assert.equal(vaultCalls, 2, "both StrictMode loads ran");
  } finally {
    releaseStartup();
    releaseRead();
    await page.unrouteAll({ behavior: "wait" });
    await page.close();
  }
});
