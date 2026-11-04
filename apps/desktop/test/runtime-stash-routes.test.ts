// KI-110: every way to stash from the draft. The key, the Stash tab's
// button, ⌘K's row and a drag onto the tab or its header all move the words
// out in one undo step, and the stash shows where it went without a toast.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { openApp, startApp, type App } from "./headless-app.ts";

const DOC = "drafts/routes.md";
const KEY = "Delta goes with the key and the margin closed.";
const BUTTON = "Alpha goes with the button in the Stash tab.";
const WORDS = "Bravo keeps most of its words here.";
const MENU = "Charlie goes from the command menu.";
const DRAG = "Echo sends one word by drag to the list.";
const HEADER = "Foxtrot sends one word to the tab header.";
let app: App;
let browser: Browser;
let page: Page;
const stash = () => page.locator(".ki-stash");
const rows = () => stash().locator(".ki-stash-row");
const take = () => stash().locator(".ki-stash-take");
const file = () => resolve(app.vault, `.kintsugi/stash/${DOC}.md`);
const draft = () => readFileSync(resolve(app.vault, DOC), "utf8");
const sidecar = () => existsSync(file()) ? readFileSync(file(), "utf8") : "";
const line = (text: string) => page.locator(".cm-line", { hasText: text });
const shot = (name: string) => page.screenshot({ path: resolve(app.shots, `${name}.png`) });
const toasts = () => page.locator("[data-sonner-toast]");

before(async () => {
  app = await startApp("ki110", { KINTSUGI_HEADLESS_KIN: "mock", CARGO_BUILD_JOBS: "2" }, (vault) => {
    writeFileSync(resolve(vault, DOC), `---\ntitle: Routes\nstatus: draft\n---\n\n${[BUTTON, WORDS, MENU, KEY, DRAG, HEADER].join("\n\n")}\n`);
  });
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.emulateMedia({ colorScheme: "light" });
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
const saved = (text: string, where: string) => until(() => !draft().includes(text) && sidecar().includes(text), `${where}: the words leave the draft for the stash file`);
const restored = (text: string, where: string) => until(() => draft().includes(text) && !sidecar().includes(text), `${where}: one undo puts the words back`);
async function undo(text: string, where: string) {
  await page.locator(".cm-content").focus();
  await page.keyboard.press("Meta+z");
  await line(text).waitFor();
  await restored(text, where);
}
async function openStash() {
  if (await page.getByRole("tab", { name: "Stash", exact: true }).isVisible()) await page.getByRole("tab", { name: "Stash", exact: true }).click();
  else await page.keyboard.press("Meta+Shift+s");
  await stash().waitFor({ state: "visible" });
}
/** The centre of `word` in the draft's line holding `text`. */
async function wordAt(text: string, word: string) {
  const point = await page.evaluate(({ text, word }) => {
    const target = [...document.querySelectorAll(".cm-line")].find((element) => element.textContent?.includes(text));
    if (!target) return null;
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent!.indexOf(word);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + word.length);
      const box = range.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }
    return null;
  }, { text, word });
  assert.ok(point, `${word} is on screen`);
  return point;
}
/**
 * Double-clicks a word to select it, then drags the selection onto `target`.
 * Playwright's Chromium never starts a native drag from selected text, so
 * the drag's events are dispatched with one shared DataTransfer: the
 * editor's own dragstart handlers fill it, and the target's handlers read it.
 * Returns the drag's types and whether the target accepted it.
 */
async function dragWord(text: string, word: string, target: string) {
  const from = await wordAt(text, word);
  await page.mouse.dblclick(from.x, from.y);
  await page.waitForFunction((word) => getSelection()?.toString() === word, word);
  return page.evaluate((selector) => {
    const data = new DataTransfer();
    const content = document.querySelector(".cm-content")!;
    const element = document.querySelector(selector)!;
    const box = element.getBoundingClientRect();
    const init = { bubbles: true, cancelable: true, composed: true, dataTransfer: data, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
    content.dispatchEvent(new DragEvent("dragstart", init));
    const types = [...data.types];
    element.dispatchEvent(new DragEvent("dragenter", init));
    const over = new DragEvent("dragover", init);
    element.dispatchEvent(over);
    element.dispatchEvent(new DragEvent("drop", init));
    content.dispatchEvent(new DragEvent("dragend", init));
    return { types, accepted: over.defaultPrevented };
  }, target);
}
async function centre(locator: ReturnType<Page["locator"]>) {
  const box = await locator.boundingBox();
  assert.ok(box);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test("⌥⌘X stashes with the margin closed: the margin stays shut and its button's dot pulses once", { timeout: 60_000 }, async () => {
  assert.equal(await page.locator("aside.ki-margin[data-open]").count(), 0);
  await line(KEY).click();
  await page.keyboard.press("Meta+Alt+x");
  await page.locator(".ki-margin-toggle .ki-margin-pulse").waitFor({ state: "attached" });
  await page.waitForTimeout(250);
  await page.screenshot({ path: resolve(app.shots, "06-margin-pulse-light.png"), clip: { x: 1240, y: 0, width: 200, height: 110 } });
  await saved(KEY, "key");
  assert.equal(await page.locator("aside.ki-margin[data-open]").count(), 0, "stashing doesn't open the margin");
  await page.locator(".ki-margin-toggle .ki-margin-pulse").waitFor({ state: "detached", timeout: 3_000 });
  assert.equal(await toasts().count(), 0, "no toast");
  await undo(KEY, "key");
});

test("the Stash tab's button stashes the paragraph, or the selection, and lights the new row", { timeout: 90_000 }, async () => {
  await openStash();
  await line(BUTTON).click();
  await page.locator(".cm-content").press("End");
  await page.locator(".cm-content").press("ArrowDown");
  assert.equal(await take().innerText(), "Stash paragraph");
  assert.equal(await take().isDisabled(), true, "a blank line has nothing to stash");

  await line(BUTTON).click();
  const button = stash().getByRole("button", { name: "Stash paragraph", exact: true });
  assert.equal(await button.isEnabled(), true);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await shot("01-stash-button-light");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
  await page.waitForTimeout(400);
  await shot("02-stash-button-dark");
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForFunction(() => !document.documentElement.classList.contains("dark"));
  await button.hover();
  const tip = page.getByRole("tooltip");
  await tip.waitFor();
  assert.equal((await tip.innerText()).trim(), "⌥⌘X");
  await button.click();
  await saved(BUTTON, "button");
  const fresh = rows().filter({ hasText: BUTTON });
  await fresh.waitFor();
  assert.equal(await fresh.getAttribute("data-fresh"), "", "the stashed row lights up");
  assert.equal(await page.locator(".cm-content").evaluate((element) => element.contains(document.activeElement)), true, "focus stays in the draft");
  await page.mouse.move(0, 0);
  await shot("03-stashed-row-light");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
  await page.waitForTimeout(200);
  await shot("04-stashed-row-dark");
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForFunction(() => !document.documentElement.classList.contains("dark"));
  await page.waitForFunction((text) => !document.querySelector(`.ki-stash-row[data-fresh]`)?.textContent?.includes(text), BUTTON, { timeout: 3_000 });
  await undo(BUTTON, "button");

  const word = await wordAt(WORDS, "Bravo");
  await page.mouse.dblclick(word.x, word.y);
  await stash().getByRole("button", { name: "Stash selection", exact: true }).click();
  await until(() => draft().includes(WORDS.replace("Bravo", "")) && sidecar().includes("Bravo"), "the button stashes only the selection");
  await rows().filter({ hasText: /^Bravo$/ }).waitFor();
  await undo(WORDS, "selection");
});

test("⌘K lists Stash with its key, and it stashes the passage", { timeout: 60_000 }, async () => {
  await line(MENU).click();
  await page.keyboard.press("Meta+k");
  const option = page.getByRole("option", { name: /^Stash/ });
  await option.waitFor();
  assert.match(await option.innerText(), /Stash\s*⌥⌘X/);
  await shot("05-command-menu-light");
  await option.click();
  await saved(MENU, "⌘K");
  await rows().filter({ hasText: MENU }).waitFor();
  assert.equal(await rows().filter({ hasText: MENU }).getAttribute("data-fresh"), "");
  await undo(MENU, "⌘K");
});

test("dragging a selection onto the Stash tab, or its header, stashes it as one undo step", { timeout: 90_000 }, async () => {
  await openStash();
  const list = await dragWord(DRAG, "word", ".ki-stash-list");
  assert.ok(list.types.includes("application/x-kintsugi-draft-selection"), "the draft's drag carries its span");
  assert.equal(list.accepted, true, "the Stash tab accepts it");
  await until(() => draft().includes(DRAG.replace("word ", " ")) && sidecar().includes("word"), "drop on the list stashes the word");
  await rows().filter({ hasText: /^word$/ }).waitFor();
  assert.equal(await stash().getAttribute("data-drop-target"), null, "the drop zone clears");
  await page.locator(".cm-content").focus();
  await page.keyboard.press("Meta+z");
  await until(() => draft().includes(DRAG) && !sidecar().includes("by drag"), "one undo restores the dragged word");
  assert.equal(await rows().filter({ hasText: /^word$/ }).count(), 0);

  // On the header while Kin's tab shows: the Stash tab's dot pulses.
  await page.getByRole("tab", { name: "Kin", exact: true }).click();
  const header = await dragWord(HEADER, "tab", ".ki-margin-tab[data-tab=stash]");
  assert.equal(header.accepted, true, "the Stash tab's header accepts it");
  await page.locator(".ki-margin-tab .ki-margin-pulse").waitFor({ state: "attached" });
  await until(() => draft().includes(HEADER.replace("tab ", " ")), "drop on the header stashes the word");
  await rows().filter({ hasText: /^tab$/ }).waitFor({ state: "attached" });
  assert.equal(await page.getByRole("tab", { name: "Kin", exact: true }).getAttribute("aria-selected"), "true", "Kin's tab stays showing");
  await page.locator(".cm-content").focus();
  await page.keyboard.press("Meta+z");
  await until(() => draft().includes(HEADER), "one undo restores the header drop");
  assert.equal(await toasts().count(), 0, "no toast");
});

test("holding ⌘ while writing lists Stash and Insert from stash, and shows the button's key", { timeout: 30_000 }, async () => {
  await openStash();
  await line(MENU).click();
  await page.keyboard.down("Meta");
  try {
    const list = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await list.waitFor();
    const group = list.locator("section", { has: page.getByRole("heading", { name: "Stash", exact: true }) });
    assert.match(await group.innerText(), /Stash\s*⌥⌘X[\s\S]*Insert from stash\s*⌥⌘V/);
    assert.equal(await take().locator(".ki-shortcut-hint").innerText(), "⌥⌘X");
    await shot("07-held-command-light");
  } finally {
    await page.keyboard.up("Meta");
  }
});
