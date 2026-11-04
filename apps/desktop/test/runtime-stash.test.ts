import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { openApp, startApp, type App } from "./headless-app.ts";

const DOC = "drafts/bowls.md";
const CUT = "The spare paragraph can wait until tomorrow.";
const ORIGINAL = "The bowl broke along an old line. I mended it with lacquer and patience.";
let app: App;
let browser: Browser;
let page: Page;
const stash = () => page.locator(".ki-stash");
const rows = () => stash().locator(".ki-stash-row");
const file = () => resolve(app.vault, `.kintsugi/stash/${DOC}.md`);
const draft = () => readFileSync(resolve(app.vault, DOC), "utf8");

before(async () => {
  app = await startApp("ki89", { KINTSUGI_HEADLESS_KIN: "mock", CARGO_BUILD_JOBS: "2" }, (vault) => {
    writeFileSync(resolve(vault, DOC), `---\ntitle: Bowls\nstatus: draft\n---\n\n${ORIGINAL}\n\n${CUT}\n`);
  });
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await openApp(page, app.url, app.output);
  await page.locator(`[title="${DOC}"]`).click();
  await page.locator(`[title="${DOC}"][data-active=true]`).waitFor();
  await page.waitForFunction(() => {
    const note = document.querySelector<HTMLInputElement>('.ki-stash input[aria-label="Add a note"]');
    return note && !note.disabled;
  });
}, { timeout: Number(process.env.KINTSUGI_RUNTIME_TIMEOUT ?? 15 * 60_000) });

after(async () => { await browser?.close(); await app?.stop(); });

async function until(check: () => boolean, message: string) {
  for (let i = 0; i < 150; i++) {
    try { if (check()) return; } catch { /* save is pending */ }
    await page.waitForTimeout(100);
  }
  assert.fail(message);
}
const line = (text: string) => page.locator(".cm-line", { hasText: text });
const shot = (name: string) => page.screenshot({ path: resolve(app.shots, `${name}.png`) });
async function openStash() {
  const tab = page.getByRole("tab", { name: "Stash", exact: true });
  if (!(await tab.isVisible())) await page.keyboard.press("Meta+Shift+s");
  else await tab.click();
  await stash().waitFor({ state: "visible" });
  await stash().getByRole("textbox", { name: "Add a note" }).waitFor();
}

test("stash and insert share undo with the draft, and notes stay outside it", { timeout: 90_000 }, async () => {
  await line(CUT).click();
  await page.keyboard.press("Meta+Alt+x");
  await stash().waitFor({ state: "visible" });
  await rows().filter({ hasText: CUT }).waitFor();
  await until(() => !draft().includes(CUT) && existsSync(file()) && readFileSync(file(), "utf8").includes(CUT), "stash saves outside draft");
  await page.locator(".cm-content").focus();
  await page.keyboard.press("Meta+z");
  await line(CUT).waitFor();
  assert.equal(await rows().filter({ hasText: CUT }).count(), 0);
  await page.keyboard.press("Meta+Shift+z");
  const row = rows().filter({ hasText: CUT });
  await row.waitFor();
  await row.focus();
  await row.press("Enter");
  await line(CUT).waitFor();
  assert.equal(await rows().filter({ hasText: CUT }).count(), 0);
  await page.keyboard.press("Meta+z");
  await rows().filter({ hasText: CUT }).waitFor();

  const note = stash().getByRole("textbox", { name: "Add a note" });
  await note.fill("Check the kiln dates.");
  await note.press("Enter");
  await rows().filter({ hasText: "Check the kiln dates." }).waitFor();
  await until(() => readFileSync(file(), "utf8").includes("Check the kiln dates."), "note saved");
  assert.ok(!draft().includes("Check the kiln dates."));
});

test("Ask Kin explicitly adds ideas and anchored rewrites without writing the draft", { timeout: 120_000 }, async () => {
  const before = draft();
  await stash().locator(".ki-stash-shared").getByRole("button", { name: "Ask Kin", exact: true }).click();
  const rewrite = stash().locator('.ki-stash-row[data-kind="rewrite"]').first();
  await rewrite.waitFor({ timeout: 60_000 });
  assert.equal(draft(), before, "Kin's tool never writes the draft");
  assert.ok(await stash().locator('.ki-stash-row[data-by="kin"]').count() <= 5);
  const original = await rewrite.locator(".ki-stash-original").innerText();
  const replacement = await rewrite.locator(".ki-stash-text").innerText();
  await rewrite.focus();
  assert.equal(await rewrite.getAttribute("data-focused"), "");
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForFunction(() => !document.documentElement.classList.contains("dark"));
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.waitForTimeout(250);
  await shot("01-stash-light");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
  await shot("02-stash-dark");
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForFunction(() => !document.documentElement.classList.contains("dark"));
  await rewrite.press("Enter");
  await until(() => draft().includes(replacement) && !draft().includes(original), "rewrite replaces only its anchored words");
  await page.keyboard.press("Meta+z");
  await until(() => draft().includes(original), "undo restores anchored words");
  await stash().locator('.ki-stash-row[data-kind="rewrite"]').first().waitFor();
});

test("picker and drag consume an item, and undo puts it back", { timeout: 60_000 }, async () => {
  await line(ORIGINAL).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Meta+Alt+v");
  const picker = page.getByRole("dialog", { name: "Insert from stash" });
  await picker.waitFor();
  await picker.getByRole("button", { name: "Check the kiln dates." }).click();
  await until(() => draft().includes("Check the kiln dates."), "picker inserts at cursor");
  await page.keyboard.press("Meta+z");
  await rows().filter({ hasText: "Check the kiln dates." }).waitFor();
  await rows().filter({ hasText: "Check the kiln dates." }).dragTo(line(ORIGINAL));
  await until(() => draft().includes("Check the kiln dates."), "drag inserts at drop");
  await page.keyboard.press("Meta+z");
  await until(() => !draft().includes("Check the kiln dates."), "undo restores dragged item");
  await rows().filter({ hasText: "Check the kiln dates." }).waitFor();
});

test("hover never expands, keyboard reorders, dismiss and discuss work", { timeout: 60_000 }, async () => {
  await openStash();
  const first = rows().first();
  const second = rows().nth(1);
  await stash().getByRole("textbox", { name: "Add a note" }).focus();
  await first.hover();
  assert.equal(await first.getAttribute("data-focused"), null);
  const id = await first.getAttribute("data-stash-id");
  await first.focus();
  await first.press("Alt+ArrowDown");
  assert.equal(await second.getAttribute("data-stash-id"), id);
  const kin = stash().locator('.ki-stash-row[data-by="kin"]').last();
  await kin.focus();
  await kin.getByRole("button", { name: /Discuss/ }).click();
  await page.getByRole("tab", { name: "Kin", exact: true }).waitFor();
  await openStash();
  const dismiss = stash().locator('.ki-stash-row[data-by="kin"]').last();
  const dismissed = await dismiss.getAttribute("data-stash-id");
  await dismiss.focus();
  await dismiss.getByRole("button", { name: /Dismiss/ }).click();
  await until(() => !readFileSync(file(), "utf8").includes(dismissed!), "dismiss removes item");
  assert.ok(!draft().includes("Check the kiln dates."));
});

test("Stash on a Kin reply saves an explicitly requested item, never draft text", { timeout: 120_000 }, async () => {
  const before = draft();
  await page.getByRole("tab", { name: "Kin", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Message Kin" });
  await input.fill("What did I set aside?");
  await input.press("Enter");
  const reply = page.locator('[data-role="kin"]').last();
  const save = reply.getByRole("button", { name: "Stash", exact: true });
  await save.waitFor({ timeout: 60_000 });
  const text = await reply.locator(".ki-kin-reply").innerText();
  assert.ok(text.trim());
  await save.click();
  await openStash();
  await rows().filter({ hasText: text.slice(0, 80) }).waitFor();
  await until(() => readFileSync(file(), "utf8").includes(text.slice(0, 80)), "reply saved to sidecar");
  assert.equal(draft(), before);
});
