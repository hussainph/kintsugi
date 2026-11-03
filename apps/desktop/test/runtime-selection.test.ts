// KI-83: selection on the real Mac app and the phone's shared theme, both
// painted and native. All files and screenshots stay in the scratch run.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { startApp, openApp, type App } from "./headless-app.ts";

const DOC = "drafts/selection.md";
const TEXT = "A selection should be easy to see, with every word still readable. It should remain clear across wrapped lines and when focus moves to another control.";
const colours = { light: "rgb(169, 206, 247)", dark: "rgb(38, 75, 115)" };
let app: App;
let browser: Browser;

before(async () => {
  app = await startApp("ki83", {}, (vault) => {
    writeFileSync(resolve(vault, DOC), `# Selection\n\n${TEXT}\n\nA second paragraph.\n`);
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

for (const mode of ["light", "dark"] as const) {
  test(`Mac selection: ${mode}, wrapped range, focused and unfocused`, { timeout: 60_000 }, async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, colorScheme: mode });
    try {
      await openApp(page, app.url, app.output);
      await page.locator(`[title="${DOC}"]`).click();
      const line = page.locator(".cm-line", { hasText: TEXT });
      await line.click();
      // Select all, including the wrapped paragraph. CodeMirror uses Cmd on
      // macOS and Ctrl elsewhere; Ctrl+Home/End aren't document keys on Mac.
      await page.keyboard.press("ControlOrMeta+a");
      await page.locator(".cm-selectionBackground").first().waitFor();
      assert.ok(await page.locator(".cm-selectionBackground").count() >= 2, "a multiline range is painted");
      await check(page, mode);
      // Native selection must stay transparent under CodeMirror's painted fill.
      assert.equal(await line.evaluate((el) => getComputedStyle(el, "::selection").backgroundColor), "rgba(0, 0, 0, 0)");
      await page.screenshot({ path: resolve(app.shots, `mac-${mode}-focused.png`) });
      await page.locator(".cm-content").evaluate((content) => (content as HTMLElement).blur());
      // CodeMirror updates its focus class after the DOM blur event.
      await page.locator(".cm-editor.cm-focused").waitFor({ state: "detached" });
      await check(page, mode);
      await page.screenshot({ path: resolve(app.shots, `mac-${mode}-unfocused.png`) });
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
        if (!native) await page.locator(".cm-selectionBackground").first().waitFor();
        await check(page, mode, native, true);
        await page.screenshot({ path: resolve(app.shots, `phone-${mode}-${native ? "native" : "drawn"}.png`) });
        await page.locator(".cm-content").evaluate((content) => (content as HTMLElement).blur());
        await page.locator(".cm-editor.cm-focused").waitFor({ state: "detached" });
        await check(page, mode, native, true);
        // The phone toggles .dark without rebuilding its editor.
        await page.locator("html").evaluate((html) => html.classList.toggle("dark"));
        await check(page, mode === "light" ? "dark" : "light", native, true);
      } finally { await page.close(); }
    });
  }
}
