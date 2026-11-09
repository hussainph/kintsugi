// KI-113: real CodeMirror selections through the headless desktop runtime.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { startApp, openApp, type App } from "./headless-app.ts";

const PATH = "drafts/selection-counts.md";
const OTHER = "drafts/other-counts.md";
const BODY = "Writing starts with a sentence.\n\nWriting continues in sections.\n\nKeep <!-- an aside --> this paragraph.\n";
let app: App;
let browser: Browser;
let context: BrowserContext;
let page: Page;
const review = process.env.KINTSUGI_REVIEW_DIR;
const words = () => page.locator(".ki-document-bar-words");

before(async () => {
  app = await startApp("ki113", {}, (vault) => {
    writeFileSync(resolve(vault, PATH), `---\ntitle: Selection counts\nstatus: draft\n---\n\n${BODY}`);
    writeFileSync(resolve(vault, OTHER), "---\ntitle: Other counts\n---\n\nAnother document.");
  });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...(review ? { recordVideo: { dir: resolve(review, "video"), size: { width: 1440, height: 900 } } } : {}) });
  page = await context.newPage();
  await openApp(page, app.url, app.output);
}, { timeout: Number(process.env.KINTSUGI_RUNTIME_TIMEOUT ?? 15 * 60_000) });

after(async () => {
  await context?.close();
  await browser?.close();
  await app?.stop();
});

async function open(path: string) {
  await page.locator(`[title="${path}"]`).click();
  await page.locator(`[title="${path}"][data-active="true"]`).waitFor();
}
async function shows(text: string) {
  await page.waitForFunction((text) => document.querySelector(".ki-document-bar-words")?.textContent === text, text);
}
async function firstWord() {
  await page.locator(".cm-line", { hasText: "Writing starts" }).dblclick({ position: { x: 25, y: 10 } });
  await shows("1 of 12 words · 7 characters");
}

test("selection updates the footer, sums multiple ranges, and preserves layout in both modes", { timeout: 60_000 }, async () => {
  await open(PATH);
  await shows("12 words");
  const initialBar = await page.locator(".ki-document-bar").boundingBox();
  const editorBox = await page.locator(".cm-editor").boundingBox();
  await firstWord();
  await page.keyboard.press("Meta+d");
  await shows("2 of 12 words · 14 characters");
  assert.equal((await page.locator(".ki-document-bar").boundingBox())?.height, initialBar?.height);
  assert.deepEqual(await page.locator(".cm-editor").boundingBox(), editorBox, "counts do not move the writing");

  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.waitForTimeout(300);
    const directory = review ? resolve(review) : app.shots;
    mkdirSync(directory, { recursive: true });
    await page.screenshot({ path: resolve(directory, `${colorScheme}-selection.png`) });
  }
  await page.keyboard.press("ArrowRight");
  await shows("12 words");
  await page.emulateMedia({ colorScheme: "light" });
  await page.keyboard.press("Meta+a");
  await shows(`12 of 12 words · ${Array.from(BODY).length + 1} characters`); // blank line after frontmatter
  await page.keyboard.press("ArrowRight");
  await shows("12 words");
  await page.keyboard.type("Another word.");
  await shows("14 words");
  await page.keyboard.press("Meta+z");
  await shows("12 words");
});

test("switching documents restores their own selection; keyboard extension and clearing stay current", { timeout: 60_000 }, async () => {
  await firstWord();
  await open(OTHER);
  await shows("2 words");
  await open(PATH);
  await shows("1 of 12 words · 7 characters");
  await page.keyboard.press("Shift+ArrowRight");
  await shows("1 of 12 words · 8 characters");
  await page.keyboard.press("ArrowLeft");
  await shows("12 words");
  // A narrower pane must not change the footer's height when selecting.
  await page.setViewportSize({ width: 1000, height: 760 });
  const before = await page.locator(".ki-document-bar").boundingBox();
  await firstWord();
  assert.equal((await page.locator(".ki-document-bar").boundingBox())?.height, before?.height);
  assert.ok((await words().boundingBox())!.x >= 0);
});
