// KI-55's smoke hook against the real runtime: with KINTSUGI_SMOKE=1 the app
// calls `app_ready` once the vault has loaded and rendered, and the backend
// prints KINTSUGI_SMOKE_READY. CI's packaged-app job (scripts/smoke-app.mjs)
// waits for the same marker from a real window; this checks the frontend half
// headlessly. The headless backend keeps running after the marker.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { startApp, type App } from "./headless-app.ts";

const TIMEOUT = Number(process.env.KINTSUGI_RUNTIME_TIMEOUT ?? 15 * 60_000);

let app: App;
let browser: Browser;

before(async () => {
  app = await startApp("ki55", { KINTSUGI_SMOKE: "1" });
  browser = await chromium.launch({ headless: true }).catch((e) => {
    throw new Error(`${e}\nInstall it with: pnpm --filter @kintsugi/desktop exec playwright install chromium-headless-shell`);
  });
}, { timeout: TIMEOUT });

after(async () => {
  await browser?.close();
  app?.stop();
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
