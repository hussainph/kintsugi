// KI-112: real editor, real Rust save/reopen, scratch vault only.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { openApp, startApp, type App } from "./headless-app.ts";

const DOC = "drafts/indentation.md";
const TEXT = "---\ntitle: Indentation\nstatus: draft\n---\n\n# Indentation\n\n1. Parent\n2. Child\n3. Last\n\n- [ ] Task parent\n- [x] Task child\n\nPlain line\nSecond line\n\n";
const baseline = process.env.KINTSUGI_INDENT_BEFORE === "1";
let app: App, browser: Browser, page: Page;

before(async () => {
  app = await startApp("ki112", {}, (vault) => writeFileSync(resolve(vault, DOC), TEXT));
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: app.shots, size: { width: 1440, height: 900 } } });
  await openApp(page, app.url, app.output);
  await page.locator(`[title="${DOC}"]`).click();
  await line("2. Child").waitFor();
}, { timeout: Number(process.env.KINTSUGI_RUNTIME_TIMEOUT ?? 15 * 60_000) });

after(async () => {
  await browser?.close();
  await app?.stop();
});
const line = (text: string) => page.locator(".cm-line", { hasText: text });
const disk = () => readFileSync(resolve(app.vault, DOC), "utf8");
async function endOf(text: string) {
  await line(text).click();
  await page.keyboard.press("End");
}
async function saved(text: string) {
  for (let i = 0; i < 100 && disk() !== text; i++) await page.waitForTimeout(50);
  assert.equal(disk(), text);
}
async function shots(name: string) {
  await page.evaluate(() => document.fonts.ready);
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(250);
    await page.screenshot({ path: resolve(app.shots, `${name}-${scheme}.png`) });
  }
}
async function focused() { return page.locator(".cm-content").evaluate((el) => el === document.activeElement); }

test("before: Tab leaves the editor instead of nesting", { skip: !baseline }, async () => {
  await endOf("2. Child");
  await page.keyboard.press("Tab");
  assert.equal(await focused(), false);
  assert.equal(disk(), TEXT);
  await shots("before-tab");
});

test("Tab nests ordered items; Shift-Tab unnests; save, reopen and undo preserve Markdown", { skip: baseline, timeout: 60_000 }, async () => {
  await endOf("2. Child");
  await page.keyboard.press("Tab");
  assert.equal(await focused(), true);
  const nested = TEXT.replace("2. Child\n3. Last", "   1. Child\n2. Last");
  await saved(nested);
  assert.equal(await line("1. Child").textContent(), "   1. Child");
  await shots("after-tab");
  await page.reload();
  await line("1. Child").waitFor();
  assert.equal(await line("1. Child").textContent(), "   1. Child");
  await endOf("1. Child");
  await page.keyboard.press("Shift+Tab");
  await saved(TEXT);
  await page.keyboard.press("Meta+z");
  await saved(nested);
  await page.keyboard.press("Meta+Shift+z");
  await saved(TEXT);
});

test("tasks, plain lines and selected lines indent without losing focus", { skip: baseline, timeout: 60_000 }, async () => {
  await endOf("Task child");
  await page.keyboard.press("Tab");
  await saved(TEXT.replace("- [x] Task child", "  - [x] Task child"));
  assert.equal(await focused(), true);
  await page.keyboard.press("Shift+Tab");
  await saved(TEXT);
  await endOf("Plain line");
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+End");
  await page.keyboard.press("Tab");
  await saved(TEXT.replace("Plain line\nSecond line", "  Plain line\n  Second line"));
  await page.keyboard.press("Shift+Tab");
  await saved(TEXT);
  await shots("after-outdent");
});

test("Esc then Tab or Shift-Tab escapes; normal typing restores indentation", { skip: baseline, timeout: 30_000 }, async () => {
  for (const key of ["Tab", "Shift+Tab"]) {
    await endOf("Plain line");
    await page.keyboard.press("Escape");
    await page.keyboard.press(key);
    assert.equal(await focused(), false, key);
    await saved(TEXT);
  }
  await endOf("Plain line");
  await page.keyboard.press("ArrowLeft"); // clears the temporary escape mode
  await page.keyboard.press("Tab");
  await saved(TEXT.replace("Plain line", "  Plain line"));
  await page.keyboard.press("Shift+Tab");
  await saved(TEXT);
});

test("frontmatter and focused popups keep their own keyboard behavior", { skip: baseline, timeout: 30_000 }, async () => {
  await endOf("status: draft");
  await page.keyboard.press("Tab");
  await saved(TEXT.replace("status: draft", "  status: draft"));
  await page.keyboard.press("Shift+Tab");
  await saved(TEXT);
  await endOf("Plain line");
  await page.keyboard.press("Meta+k");
  const refine = page.locator("[data-slot=popover-content]");
  await refine.waitFor();
  const before = await page.locator(".cm-line").allTextContents();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  assert.deepEqual(await page.locator(".cm-line").allTextContents(), before);
  await page.keyboard.press("Escape");
  await refine.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Ask Kin", exact: true }).click();
  await page.getByRole("textbox", { name: "Message Kin" }).waitFor();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  assert.deepEqual(await page.locator(".cm-line").allTextContents(), before);
  await saved(TEXT);
  await endOf("Plain line");
});

test("slash and reference popups get Tab before indentation, including no matches", { skip: baseline, timeout: 60_000 }, async () => {
  await endOf("Second line");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/h2");
  await page.locator(".cm-command-menu").waitFor();
  await page.keyboard.press("Shift+Tab");
  assert.equal(await focused(), true);
  await page.keyboard.press("Tab");
  await page.locator(".cm-command-menu").waitFor({ state: "detached" });
  assert.equal((await line("##").textContent())?.startsWith("## "), true);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("@golden");
  await page.locator(".cm-reference-picker").getByText("Golden joinery", { exact: true }).waitFor();
  await page.keyboard.press("Tab");
  await page.locator(".cm-reference-picker").waitFor({ state: "detached" });
  for (let i = 0; i < 100 && !disk().includes("golden-joinery]]"); i++) await page.waitForTimeout(50);
  assert.match(disk(), /\[\[(inspiration\/)?golden-joinery\]\]/);
  await page.keyboard.press("End");
  await page.keyboard.type(" @no-match-ki112");
  await page.locator(".cm-reference-picker").waitFor();
  await page.waitForTimeout(300);
  const before = await page.locator(".cm-content").textContent();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  assert.equal(await page.locator(".cm-content").textContent(), before);
  assert.equal(await focused(), true);
  await page.keyboard.press("Escape");
});
