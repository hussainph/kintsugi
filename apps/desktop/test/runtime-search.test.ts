// KI-52 against the real runtime: `pnpm desktop:headless` on a freshly
// seeded scratch vault and config (no index yet, embeddings off as in every
// headless run), driven by headless Chromium. The first searches after
// startup, the Library's and Kin's (on the scripted headless model), find
// by words at once. Screenshots go to .headless/<run>/shots/.
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { startApp, type App } from "./headless-app.ts";

const TIMEOUT = Number(process.env.KINTSUGI_RUNTIME_TIMEOUT ?? 15 * 60_000);

let app: App;
let browser: Browser;
let page: Page;

before(async () => {
  app = await startApp("ki52", { KINTSUGI_HEADLESS_KIN: "mock" });
  browser = await chromium.launch({ headless: true }).catch((e) => {
    throw new Error(`${e}\nInstall it with: pnpm --filter @kintsugi/desktop exec playwright install chromium-headless-shell`);
  });
  page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  await page.goto(app.url);
}, { timeout: TIMEOUT });

after(async () => {
  await browser?.close();
  app?.stop();
});

const shot = (name: string) => page.screenshot({ path: resolve(app.shots, `${name}.png`) });

test("the Library's first search finds clips by a word's stem", { timeout: 60_000 }, async () => {
  await page.keyboard.press("Meta+Shift+i");
  await page.getByRole("searchbox", { name: "Search inspiration" }).fill("repairs");
  // No clip contains "repairs", so the substring filter alone finds nothing:
  // these come from the index, which stems it to "repair".
  await page.locator('[data-clip-path="inspiration/golden-joinery.md"]').waitFor({ timeout: 15_000 });
  await page.locator('[data-clip-path="inspiration/a-post-that-vanished.md"]').waitFor();
  await shot("01-library-search");
});

test("Kin's first search finds the note by its words", { timeout: 60_000 }, async () => {
  await page.keyboard.press("Meta+j");
  const panel = page.getByRole("dialog", { name: "Kin" });
  const box = panel.getByRole("textbox", { name: "Message Kin" });
  await box.fill("repair");
  await box.press("Enter");
  const reply = panel.locator('[data-role="kin"]').first();
  await reply.getByText('I looked with search {"query":"repair"}', { exact: false }).waitFor({ timeout: 30_000 });
  await reply.getByText('"id":"notes/repair.md"', { exact: false }).waitFor();
  await shot("02-kin-search");
});
