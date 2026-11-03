// KI-100: real React settings + Rust registry on a fresh scratch vault.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { startApp, openApp, type App } from "./headless-app.ts";

let app: App;
let browser: Browser;
before(async () => {
  app = await startApp("ki100", {});
  browser = await chromium.launch({ headless: true });
}, { timeout: 15 * 60_000 });
after(async () => { await browser?.close(); await app?.stop(); });

async function appearance(page: Page) {
  await page.keyboard.press("Meta+,");
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByRole("heading", { name: "Appearance", level: 1 }).waitFor();
}
const sample = (page: Page) => page.getByLabel("Text sample");
const radio = (page: Page, name: string) => page.getByRole("radio", { name, exact: true });
async function mode(page: Page, dark: boolean) {
  await page.waitForFunction((dark) => {
    const root = document.documentElement;
    const provider = document.querySelector<HTMLElement>(".graphical-theme")!;
    const expected = dark ? "dark" : "light";
    return root.classList.contains("dark") === dark && root.style.colorScheme === expected && provider.dataset.colorMode === expected;
  }, dark);
}
async function shot(page: Page, name: string) {
  // Base UI keeps the outgoing indicator mounted for its exit transition.
  // Capture the settled selection, not the overlap between two radio dots.
  await page.waitForFunction(() => document.querySelectorAll(".ki-appearance-gallery .ui-radio-dot").length === 1);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.mouse.move(1400, 10);
  await page.screenshot({ path: resolve(app.shots, `${name}.png`) });
}

test("gallery overrides the system immediately, follows live System changes, and supports keyboard selection", { timeout: 90_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
  try {
    const page = await context.newPage();
    await openApp(page, app.url, app.output);
    await appearance(page);
    await page.evaluate(() => {
      const win = window as unknown as { __ki100Themes: unknown[]; __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } };
      win.__ki100Themes = [];
      const invoke = win.__TAURI_INTERNALS__.invoke.bind(win.__TAURI_INTERNALS__);
      win.__TAURI_INTERNALS__.invoke = (cmd, args) => {
        if (cmd === "plugin:window|set_theme") win.__ki100Themes.push(args?.value);
        return invoke(cmd, args);
      };
    });
    assert.equal(await radio(page, "System").getAttribute("aria-checked"), "true");
    await mode(page, false);
    const width = await page.locator(".ki-settings-page").evaluate((el) => el.getBoundingClientRect().width);
    assert.equal(width, 640);
    assert.equal(await page.locator(".ki-appearance-thumbnail").count(), 3);
    assert.equal(await page.locator(".ki-appearance-split").count(), 1);
    const tiles = await page.locator(".ki-appearance-thumbnail").evaluateAll((elements) => elements.map((el) => el.getBoundingClientRect().y));
    assert.equal(new Set(tiles).size, 1, "the three previews share a gallery row");
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>(".ki-appearance-thumbnail img")].every((image) => image.complete && image.naturalWidth > 0));
    await shot(page, "desktop-light-system");
    await page.locator(".ki-appearance-option").filter({ has: radio(page, "Dark") }).locator(".ki-appearance-thumbnail").click();
    await mode(page, true);
    assert.equal(await radio(page, "Dark").getAttribute("aria-checked"), "true", "the entire thumbnail is a target");
    await shot(page, "desktop-dark");
    await page.emulateMedia({ colorScheme: "dark" });
    await radio(page, "Light").click();
    await mode(page, false);
    await shot(page, "desktop-light");
    // Base UI owns roving focus and arrow selection.
    await radio(page, "Light").focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await radio(page, "Dark").getAttribute("aria-checked"), "true");
    await mode(page, true);
    await radio(page, "System").click();
    await page.emulateMedia({ colorScheme: "light" });
    await mode(page, false);
    await page.emulateMedia({ colorScheme: "dark" });
    await mode(page, true);
    assert.equal(await page.locator(".ki-settings-note").count(), 0);
    assert.deepEqual(await page.evaluate(() => (window as unknown as { __ki100Themes: unknown[] }).__ki100Themes), ["dark", "light", "dark", null], "System clears the native override; OS changes do not set one");
  } finally { await context.close(); }
});

test("text size stays on the Mac, scales the sample and editor, and survives a browser restart with the mode", { timeout: 90_000 }, async () => {
  let context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
  try {
    let page = await context.newPage();
    await openApp(page, app.url, app.output);
    await page.locator('[title="drafts/kintsugi-and-gold.md"]').click();
    await page.locator(".cm-content").waitFor();
    await appearance(page);
    const base = await sample(page).locator("p").last().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    for (const size of [110, 120, 135, 150]) {
      await page.getByRole("button", { name: "Larger text", exact: true }).click();
      assert.equal(await page.locator(".ki-settings-size").textContent(), `${size}%`);
    }
    assert.equal(await page.getByRole("button", { name: "Larger text", exact: true }).isDisabled(), true);
    const larger = await sample(page).locator("p").last().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    assert.ok(Math.abs(larger / base - 1.5) < 0.001);
    await shot(page, "desktop-size-150");
    for (const size of [135, 120, 110, 100, 90, 80]) {
      await page.getByRole("button", { name: "Smaller text", exact: true }).click();
      assert.equal(await page.locator(".ki-settings-size").textContent(), `${size}%`);
    }
    assert.equal(await page.getByRole("button", { name: "Smaller text", exact: true }).isDisabled(), true);
    await page.getByRole("button", { name: "Larger text", exact: true }).click();
    await radio(page, "Dark").click();
    // A fresh context restores only persisted browser storage, not JS state.
    const stored = await context.storageState();
    await context.close();
    context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light", storageState: stored });
    page = await context.newPage();
    await openApp(page, app.url, app.output);
    await mode(page, true);
    await appearance(page);
    assert.equal(await radio(page, "Dark").getAttribute("aria-checked"), "true");
    assert.equal(await page.locator(".ki-settings-size").textContent(), "90%");
    assert.match(await page.getByText("LT Superior Serif", { exact: true }).evaluate((el) => el.tagName), /SPAN/);
    assert.equal(await page.getByRole("combobox").count(), 0, "font is read-only");
    const sampleSize = await sample(page).locator("p").last().evaluate((el) => getComputedStyle(el).fontSize);
    await page.keyboard.press("Escape");
    await page.locator(".cm-content").waitFor();
    assert.equal(await page.locator(".cm-scroller").evaluate((el) => getComputedStyle(el).fontSize), sampleSize);
    await page.locator(".cm-content").click();
    await page.keyboard.press("Meta+0");
    await appearance(page);
    assert.equal(await page.locator(".ki-settings-size").textContent(), "100%", "KI-65 shortcuts still apply");
    await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "General", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "Larger text", exact: true }).count(), 0, "size moved out of General");
  } finally { await context.close(); }
});

test("invalid saved preferences fall back safely to System and 100%", { timeout: 60_000 }, async () => {
  const context = await browser.newContext({ colorScheme: "dark" });
  try {
    await context.addInitScript(() => {
      localStorage.setItem("kintsugi:appearance", "unknown");
      localStorage.setItem("kintsugi:text-size", "junk");
    });
    const page = await context.newPage();
    await openApp(page, app.url, app.output);
    await mode(page, true);
    await appearance(page);
    assert.equal(await radio(page, "System").getAttribute("aria-checked"), "true");
    assert.equal(await page.locator(".ki-settings-size").textContent(), "100%");
  } finally { await context.close(); }
});
