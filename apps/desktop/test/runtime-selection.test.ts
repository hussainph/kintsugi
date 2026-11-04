// KI-83/KI-107: selection contrast and geometry on the real Mac app and
// the phone's shared theme. All files and screenshots stay in the scratch run.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { startApp, openApp, type App } from "./headless-app.ts";

const DOC = "drafts/selection.md";
const TEXT = "A selection should be easy to see, with every word still readable. It should remain clear across wrapped lines and when focus moves to another control.";
const DOC_TEXT = `# Selection\n\n${TEXT}\n\nA second paragraph.\n`;
const colours = { light: "rgb(169, 206, 247)", dark: "rgb(38, 75, 115)" };
let app: App;
let browser: Browser;

before(async () => {
  app = await startApp("ki107", {}, (vault) => {
    writeFileSync(resolve(vault, DOC), DOC_TEXT);
  });
  browser = await chromium.launch({ headless: true });
}, { timeout: Number(process.env.KINTSUGI_RUNTIME_TIMEOUT ?? 15 * 60_000) });

after(async () => {
  await browser?.close();
  await app?.stop();
});

function contrast(a: string, b: string) {
  const luminance = (rgb: string) => {
    const channels = rgb.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((v) => {
      v /= 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

async function check(page: Page, mode: "light" | "dark", native = false, phone = false) {
  const fill = native
    ? await page.locator(".cm-line").first().evaluate((line) => getComputedStyle(line, "::selection").backgroundColor)
    : await page.locator(".cm-selectionBackground").first().evaluate((range) => getComputedStyle(range).backgroundColor);
  assert.equal(fill, colours[mode], `${mode} ${native ? "native" : "drawn"} selection`);
  const text = await page.locator(".cm-line").last().evaluate((line) => getComputedStyle(line).color);
  const canvas = phone
    ? await page.locator("body").evaluate((body) => getComputedStyle(body).backgroundColor)
    : await page.locator(".graphical-theme").first().evaluate((root) => getComputedStyle(root).backgroundColor);
  assert.ok(contrast(text, fill) >= 7, `${mode}: text/selection ${contrast(text, fill).toFixed(2)}:1`);
  assert.ok(contrast(canvas, fill) >= 1.5, `${mode}: canvas/selection ${contrast(canvas, fill).toFixed(2)}:1`);
}

/** Check the painted rectangles, not just the layer's enclosing box. The
 * column is the line's text area, excluding both content and line padding. */
async function checkGeometry(page: Page, lastLine: number) {
  const geometry = await page.locator(".cm-content").evaluate((content, lastLine) => {
    const lines = content.querySelectorAll(".cm-line");
    const line = lines[0];
    const box = line.getBoundingClientRect();
    const style = getComputedStyle(line);
    return {
      left: box.left + parseFloat(style.paddingLeft),
      right: box.right - parseFloat(style.paddingRight),
      bottom: lines[lastLine].getBoundingClientRect().bottom,
      rects: Array.from(content.parentElement!.querySelectorAll(".cm-selectionBackground"), (el) => {
        const { left, right, top, width } = el.getBoundingClientRect();
        return { left, right, top, width };
      }),
    };
  }, lastLine);
  assert.ok(geometry.rects.some((rect) => rect.width > 1), "a visible range is painted");
  for (const rect of geometry.rects) {
    assert.ok(rect.left >= geometry.left - 1, `selection bleeds left: ${JSON.stringify(geometry)}`);
    assert.ok(rect.right <= geometry.right + 1, `selection bleeds right: ${JSON.stringify(geometry)}`);
    // Selecting the final newline can produce a zero-width marker on the
    // empty last line. No visible rectangle may start below the prose;
    // the preceding fill can bridge the leading up to that empty line.
    if (rect.top >= geometry.bottom - 1) assert.ok(rect.width <= 1, `selection stub: ${JSON.stringify(geometry)}`);
  }
}

/** Use real editor keys, including the platform's select-all binding. */
async function select(page: Page, from: number, to: number) {
  await page.locator(".cm-content").focus();
  await page.keyboard.press("ControlOrMeta+a");
  if (from !== 0 || to !== DOC_TEXT.length) {
    await page.keyboard.press("ArrowLeft");
    for (let n = 0; n < from; n++) await page.keyboard.press("ArrowRight");
    await page.keyboard.down("Shift");
    for (let n = from; n < to; n++) await page.keyboard.press("ArrowRight");
    await page.keyboard.up("Shift");
  }
  assert.equal(await page.evaluate(() => window.getSelection()?.toString()), DOC_TEXT.slice(from, to));
  // Selection layers are measured on the next animation frame.
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}

for (const mode of ["light", "dark"] as const) {
  test(`Mac selection: ${mode}, heading, blank line and final newline, focused and unfocused`, { timeout: 60_000 }, async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, colorScheme: mode });
    try {
      await openApp(page, app.url, app.output);
      await page.locator(`[title="${DOC}"]`).click();
      const line = page.locator(".cm-line", { hasText: TEXT });
      // Opening a file reads it asynchronously; wait for this draft, not the
      // editor still showing the startup document, before sending keys.
      await line.waitFor();
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      const scenarios = [
        { name: "heading", from: 0, to: DOC_TEXT.indexOf(TEXT) + TEXT.length, lastLine: 2 },
        { name: "blank-line", from: DOC_TEXT.indexOf("It should"), to: DOC_TEXT.length - 1, lastLine: 4 },
        { name: "all", from: 0, to: DOC_TEXT.length, lastLine: 4 },
      ];
      for (const scenario of scenarios) {
        await select(page, scenario.from, scenario.to);
        assert.ok(await page.locator(".cm-selectionBackground").count() >= 2, "a multiline range is painted");
        await check(page, mode);
        await checkGeometry(page, scenario.lastLine);
        // Native selection must stay transparent under CodeMirror's painted fill.
        assert.equal(await line.evaluate((el) => getComputedStyle(el, "::selection").backgroundColor), "rgba(0, 0, 0, 0)");
        await page.screenshot({ path: resolve(app.shots, `mac-${mode}-${scenario.name}-focused.png`) });
        await page.locator(".cm-content").evaluate((content) => (content as HTMLElement).blur());
        // CodeMirror updates its focus class after the DOM blur event.
        await page.locator(".cm-editor.cm-focused").waitFor({ state: "detached" });
        await check(page, mode);
        await checkGeometry(page, scenario.lastLine);
        await page.screenshot({ path: resolve(app.shots, `mac-${mode}-${scenario.name}-unfocused.png`) });
      }
    } finally { await page.close(); }
  });

  for (const native of [false, true]) {
    test(`phone shared selection: ${mode}, ${native ? "native" : "drawn"}`, { timeout: 30_000 }, async () => {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
      try {
        // Vite serves the actual shared theme and phone CSS. No Expo bridge or
        // device APIs: this proves the CSS paths, not iOS selection handles.
        await page.route("**/selection-fixture.html*", (route) => route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html class="${mode === "dark" ? "dark" : ""}"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/test/selection-fixture.ts"></script></html>`,
        }));
        await page.goto(`${new URL(app.url).origin}/selection-fixture.html${native ? "?native" : ""}`);
        await page.locator(".cm-content").waitFor();
        if (!native) {
          await page.locator(".cm-selectionBackground").first().waitFor();
          await checkGeometry(page, 0);
        }
        await check(page, mode, native, true);
        await page.screenshot({ path: resolve(app.shots, `phone-${mode}-${native ? "native" : "drawn"}.png`) });
        await page.locator(".cm-content").evaluate((content) => (content as HTMLElement).blur());
        await page.locator(".cm-editor.cm-focused").waitFor({ state: "detached" });
        await check(page, mode, native, true);
        if (!native) await checkGeometry(page, 0);
        // The phone toggles .dark without rebuilding its editor.
        await page.locator("html").evaluate((html) => html.classList.toggle("dark"));
        await check(page, mode === "light" ? "dark" : "light", native, true);
      } finally { await page.close(); }
    });
  }
}
