// KI-108: real Rust runtime, scratch vault, no provider or owner data.
// Source-wrapped prose must lay out exactly like a flowing paragraph,
// preserve source bytes through reading/copying/editing, and keep KI-103's
// fixed wrap with the margin open. Light/dark evidence goes to shots/.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { openApp, startApp, type App } from "./headless-app.ts";

const DRAFT = "drafts/kintsugi-and-gold.md";
const FLOW = "drafts/flow-reference.md";
const NOTE = "notes/soft-breaks.md";
const TEXT = "First source line\nsecond line.\n\nA hard break  \nstays here.\n\n```\ncode first\ncode second\n```\n";
let app: App;
let browser: Browser;
let page: Page;
let original: string;
let paragraph: string;

before(async () => {
  app = await startApp("ki108", {}, (vault) => {
    original = readFileSync(resolve(vault, DRAFT), "utf8");
    paragraph = original.split("\n\n").find((p) => p.startsWith("The first time"))!;
    writeFileSync(resolve(vault, FLOW), original.replace('title: "Kintsugi and gold"', 'title: "Flow reference"').replace(paragraph, paragraph.replaceAll("\n", " ")));
    writeFileSync(resolve(vault, NOTE), TEXT);
  });
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
  await openApp(page, app.url, app.output);
}, { timeout: Number(process.env.KINTSUGI_RUNTIME_TIMEOUT ?? 15 * 60_000) });

after(async () => {
  await browser?.close();
  await app?.stop();
});

async function settle() {
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await page.waitForFunction(() => document.getAnimations().every((a) => !(a instanceof CSSTransition) || a.playState !== "running"));
}
async function openDoc(path: string) {
  await page.locator(`[title="${path}"]`).click();
  await page.locator(`[title="${path}"][data-active=true]`).waitFor();
  await page.locator(".cm-line").first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  await settle();
}
const prose = () => page.locator(".cm-line", { hasText: "The first time I saw a kintsugi bowl" });
const shot = (name: string) => page.screenshot({ path: resolve(app.shots, `${name}.png`) });
const disk = (path: string) => readFileSync(resolve(app.vault, path), "utf8");

/** Character positions, including widget spaces, relative to the column.
 *  Independent of DOM splits from syntax highlighting or decorations. */
async function boxes() {
  return prose().evaluate((el) => {
    const left = el.closest(".cm-content")!.getBoundingClientRect().left;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const out: string[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (let i = 0; i < (node.textContent?.length ?? 0); i++) {
        const r = document.createRange();
        r.setStart(node, i);
        r.setEnd(node, i + 1);
        const box = r.getBoundingClientRect();
        out.push(`${Math.round((box.left - left) * 2) / 2},${Math.round(box.top * 2) / 2},${Math.round(box.width * 2) / 2}`);
      }
    }
    return out;
  });
}

test("source wraps read like flowing prose, unchanged by margin or theme", { timeout: 120_000 }, async () => {
  await openDoc(FLOW);
  const flowing = await boxes();
  await openDoc(DRAFT);
  assert.equal(await prose().textContent(), paragraph.replaceAll("\n", " "));
  assert.equal(await prose().locator(".cm-soft-break").count(), 2);
  const joined = await boxes();
  assert.equal(joined.length, flowing.length);
  for (let i = 0; i < joined.length; i++) {
    const [x, y, w] = joined[i].split(",").map(Number);
    const [fx, fy, fw] = flowing[i].split(",").map(Number);
    assert.equal(y, fy, `character ${i}: same row as flowing source`);
    // The inline widget splits font shaping runs; subpixel glyph rounding
    // can differ, but every character must stay in the same place and row.
    assert.ok(Math.abs(x - fx) <= 1 && Math.abs(w - fw) <= 1, `character ${i}: ${joined[i]} vs ${flowing[i]}`);
  }

  for (const width of [1440, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await settle();
    const before = await boxes();
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const name of ["References", "Kin", "Stash"]) {
        if (name === "References") await page.keyboard.press("Meta+Shift+r");
        else await page.getByRole("complementary", { name: "Margin" }).getByRole("tab", { name }).click();
        await settle();
        assert.deepEqual(await boxes(), before, `${width}, ${scheme}, ${name}: no rewrap`);
        if (name === "References") await shot(`${width}-${scheme}-margin`);
      }
      await page.keyboard.press("Meta+Alt+Backslash");
      await settle();
      assert.deepEqual(await boxes(), before, "closing the margin preserves every wrap");
      await shot(`${width}-${scheme}-closed`);
    }
  }
  const linked = page.locator(".cm-line", { hasText: "That sentence belongs" });
  assert.equal(await linked.locator(".cm-soft-break").count(), 2);
  await linked.locator(".cm-reference-chip", { hasText: "Golden joinery" }).click();
  assert.equal(await copiedSelection(), "[[inspiration/golden-joinery]]", "a chip on the second source line still selects the right reference");
  await page.reload();
  await prose().waitFor();
  assert.equal(await prose().textContent(), paragraph.replaceAll("\n", " "));
  assert.equal(disk(DRAFT), original, "reading and toggling UI never rewrites the file");
});

test("cursor, copy, editing and undo retain source line endings", { timeout: 60_000 }, async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openDoc(NOTE);
  const first = page.locator(".cm-line", { hasText: "First source line" });
  assert.equal(await first.textContent(), "First source line second line.");
  assert.equal(await page.locator(".cm-line", { hasText: "A hard break" }).textContent(), "A hard break  ");
  assert.equal(await page.locator(".cm-line", { hasText: "code first" }).textContent(), "code first");
  assert.equal(await page.locator(".cm-line", { hasText: "code second" }).textContent(), "code second");
  await first.click();
  await page.keyboard.press("Meta+a");
  assert.equal(await copiedSelection(), TEXT, "copy keeps the underlying Markdown, including soft newlines");
  await page.keyboard.press("ArrowLeft"); // start of the selected document
  for (let i = 0; i < "First source line\n".length; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.type("Changed ");
  await page.waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("Changed second"));
  await untilSaved(TEXT.replace("\nsecond", "\nChanged second"));
  await page.keyboard.press("Meta+z");
  await untilSaved(TEXT);
  await page.keyboard.press("Enter"); // a second source newline splits the paragraph
  await untilSaved(TEXT.replace("\nsecond", "\n\nsecond"));
  assert.equal(await first.textContent(), "First source line");
  await page.keyboard.press("Meta+z");
  await untilSaved(TEXT);
  assert.equal(await first.textContent(), "First source line second line.");
});

async function copiedSelection() {
  return page.locator(".cm-content").evaluate((el) => {
    const clipboardData = new DataTransfer();
    el.dispatchEvent(new ClipboardEvent("copy", { clipboardData, bubbles: true, cancelable: true }));
    return clipboardData.getData("text/plain");
  });
}

async function untilSaved(text: string) {
  // Saving is debounced; a disk read in node is the actual assertion.
  for (let i = 0; i < 100; i++) {
    if (disk(NOTE) === text) return;
    await page.waitForTimeout(50);
  }
  assert.equal(disk(NOTE), text);
}
