// KI-90 against the real runtime: `pnpm desktop:headless` (the real Rust
// command registry on Tauri MockRuntime, and the real React app) driven by
// headless Chromium, with ⌘K's checks and trims answered by the scripted
// headless model (`KINTSUGI_HEADLESS_KIN=mock`): no credentials, no cost.
//
// Nothing shows unasked. A check underlines ranges in gold and changes no
// character; ⌘' / ⇧⌘' step, ⌥↵ and ⌥⌘⌫ accept and dismiss, an edit inside a
// mark and Escape take marks away. A trim strikes words in gold with the
// word count before and after; clicking a struck word keeps it; Apply cuts
// is one undo step and only ever removes words (a cut that starts a
// sentence capitalises the next word). Light and dark screenshots
// go to .headless/<run>/shots/.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { openApp, startApp, type App } from "./headless-app.ts";

const DOC = "drafts/marks.md";
const BODY = [
  "The bowl is really very old. I think it was just broken once (maybe twice), and then, years later, mended with gold.",
  "We utilize gold because it shows the break. Repair is a kind of attention.",
  "Nobody was allowed to use it.",
].join("\n\n");
const FILE = `---\ntitle: "Marks"\nstatus: draft\n---\n\n${BODY}\n`;
const TIMEOUT = Number(process.env.KINTSUGI_RUNTIME_TIMEOUT ?? 15 * 60_000);

let app: App;
let browser: Browser;
let page: Page;

before(async () => {
  app = await startApp("ki90", { KINTSUGI_HEADLESS_KIN: "mock" }, (vault) => writeFileSync(resolve(vault, DOC), FILE));
  browser = await chromium.launch({ headless: true }).catch((e) => {
    throw new Error(`${e}\nInstall it with: pnpm --filter @kintsugi/desktop exec playwright install chromium-headless-shell`);
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await openApp(page, app.url, app.output);
  await page.locator(`[title="${DOC}"]`).click();
  await page.locator(`[title="${DOC}"][data-active="true"]`).waitFor();
  await line("Nobody was allowed").waitFor();
}, { timeout: TIMEOUT });

after(async () => {
  await browser?.close();
  await app?.stop();
});

const shot = (name: string) => page.screenshot({ path: resolve(app.shots, `${name}.png`) });
const disk = () => readFileSync(resolve(app.vault, DOC), "utf8");
const line = (text: string) => page.locator(".cm-line", { hasText: text });
const refine = () => page.locator("[data-slot=popover-content]");
const flags = () => page.locator(".cm-kin-flag");
const cuts = () => page.locator(".cm-kin-cut");
const card = () => page.locator(".cm-kin-card");
const bar = () => page.locator(".ki-trim-bar");
const editorText = () => page.evaluate(() => document.querySelector(".cm-content")!.textContent ?? "");
const marked = () => page.evaluate(() => [...document.querySelectorAll(".cm-kin-mark")].map((n) => n.textContent));
const focusEditor = () => line("Nobody was allowed").click();

async function until(check: () => boolean | Promise<boolean>, what: string, tries = 100) {
  for (let i = 0; i < tries; i++) {
    if (await check()) return;
    await page.waitForTimeout(100);
  }
  assert.fail(what);
}

/** The point just before (or after) the first `text` in the editor. */
function pointAt(text: string, end: boolean) {
  return page.evaluate(({ text, end }) => {
    const walker = document.createTreeWalker(document.querySelector(".cm-content")!, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const i = node.textContent!.indexOf(text);
      if (i === -1) continue;
      const range = document.createRange();
      const at = end ? i + text.length - 1 : i;
      range.setStart(node, at);
      range.setEnd(node, at + 1);
      const box = range.getBoundingClientRect();
      return { x: end ? box.right : box.left + 0.5, y: box.top + box.height / 2 };
    }
    throw new Error(`not found: ${text}`);
  }, { text, end });
}

/** Selects from the start of `from` to the end of `to`. */
async function select(from: string, to: string) {
  const a = await pointAt(from, false);
  const b = await pointAt(to, true);
  await page.mouse.click(a.x, a.y);
  await page.keyboard.down("Shift");
  await page.mouse.click(b.x, b.y);
  await page.keyboard.up("Shift");
}

async function run(label: string) {
  await page.keyboard.press("Meta+k");
  await refine().getByRole("option", { name: label }).click();
}

test("nothing is marked unasked", { timeout: 60_000 }, async () => {
  await focusEditor();
  await page.keyboard.press("End");
  await page.keyboard.type(" Really.");
  await page.waitForTimeout(1500);
  assert.equal(await page.locator(".cm-kin-mark").count(), 0);
  assert.equal(await bar().count(), 0);
  for (let i = 0; i < " Really.".length; i++) await page.keyboard.press("Backspace");
  await until(() => disk() === FILE, "the file is back as it was");
});

test("⌘K lists the checks and trims", { timeout: 60_000 }, async () => {
  await focusEditor();
  await page.keyboard.press("Meta+k");
  for (const name of ["Weakest sentences", "Sentences that run long", "Convoluted sentences", "Words off the tone", "Hedges and filler", "Slight trim −10%", "Tighten more", "Even sharper", "Cut in half −50%"]) {
    await refine().getByRole("option", { name }).waitFor();
  }
  await shot("01-refine-checks-and-trims");
  await page.keyboard.press("Escape");
});

test("a check underlines in gold and changes no character", { timeout: 60_000 }, async () => {
  await focusEditor();
  await run("Weakest sentences");
  await flags().first().waitFor({ timeout: 20_000 });
  assert.deepEqual(await marked(), ["The bowl is really very old.", "Repair is a kind of attention."]);
  assert.equal(disk(), FILE, "nothing is written");
  // The first one is focused and its reason shows.
  await card().getByText("Says little the piece would miss.").waitFor();
  const style = await flags().first().evaluate((n) => { const s = getComputedStyle(n); return { line: s.textDecorationLine, color: s.textDecorationColor }; });
  assert.equal(style.line, "underline");
  assert.notEqual(style.color, "rgba(0, 0, 0, 0)");
  await shot("02-check-light");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(300);
  await shot("03-check-dark");
  await page.emulateMedia({ colorScheme: "light" });

  // ⌘' and ⇧⌘' step and wrap; ⌥⌘⌫ dismisses; ⌥↵ accepts the last.
  await page.locator(".cm-kin-focused", { hasText: "The bowl is really" }).waitFor();
  await page.keyboard.press("Meta+Quote");
  await page.locator(".cm-kin-focused", { hasText: "Repair is a kind" }).waitFor();
  await page.keyboard.press("Meta+Quote");
  await page.locator(".cm-kin-focused", { hasText: "The bowl is really" }).waitFor();
  await page.keyboard.press("Meta+Shift+Quote");
  await page.locator(".cm-kin-focused", { hasText: "Repair is a kind" }).waitFor();
  await page.keyboard.press("Meta+Shift+Quote");
  await page.locator(".cm-kin-focused", { hasText: "The bowl is really" }).waitFor();
  await page.keyboard.press("Meta+Alt+Backspace");
  await until(async () => (await flags().count()) === 1, "one dismissed");
  await page.locator(".cm-kin-focused", { hasText: "Repair is a kind" }).waitFor();
  await page.keyboard.press("Alt+Enter");
  await until(async () => (await page.locator(".cm-kin-mark").count()) === 0, "stepped through them all");
  assert.equal(disk(), FILE, "accepting a flag writes nothing");
  assert.equal(await card().count(), 0);
});

test("a check on a selection marks words in it; a made-up quote is dropped", { timeout: 60_000 }, async () => {
  await select("The bowl", "with gold.");
  await run("Hedges and filler");
  await flags().first().waitFor({ timeout: 20_000 });
  assert.deepEqual(await marked(), ["really", "very", "I think", "just", "maybe"]);
  assert.ok(!(await editorText()).includes("never had"));
  // Typing inside a mark takes it away; the others stay.
  await page.keyboard.press("Escape");
  await flags().first().waitFor({ state: "detached" });
  assert.equal(disk(), FILE);
  await run2Hedges();
  const before = await flags().count();
  const box = (await flags().filter({ hasText: "maybe" }).boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.type("x");
  await until(async () => (await flags().count()) === before - 1, "the edited mark goes");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Escape");
  await until(async () => (await page.locator(".cm-kin-mark").count()) === 0, "Escape takes every mark away");
  await until(() => disk() === FILE, "the file is unchanged");
});

async function run2Hedges() {
  await select("The bowl", "with gold.");
  await run("Hedges and filler");
  await flags().first().waitFor({ timeout: 20_000 });
}

test("a trim strikes words in gold, keeps a clicked word, and applies as one undo step", { timeout: 90_000 }, async () => {
  await focusEditor();
  await page.keyboard.press("Meta+ArrowUp");
  await run("Even sharper");
  await cuts().first().waitFor({ timeout: 20_000 });
  assert.equal(disk(), FILE, "nothing is cut until he applies");
  const struck = await page.evaluate(() => [...document.querySelectorAll(".cm-kin-cut")].map((n) => n.textContent!.trim()));
  assert.deepEqual(struck, ["really", "very", "I think", "just", "(maybe twice)", "kind of"]);
  const style = await cuts().first().evaluate((n) => getComputedStyle(n).textDecorationLine);
  assert.equal(style, "line-through");
  await bar().getByText(/^\d+ → \d+ words$/).waitFor();
  const counts = async () => (await bar().locator(".ki-data").textContent())!.match(/(\d+) → (\d+)/)!.slice(1).map(Number);
  const [total, first] = await counts();
  assert.equal(total, 42);
  assert.equal(first, total - 9);
  await page.mouse.move(1, 1);
  await shot("04-trim-light");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(300);
  await shot("05-trim-dark");
  await page.emulateMedia({ colorScheme: "light" });

  // Clicking a struck word keeps it.
  await cuts().filter({ hasText: "very" }).click();
  await until(async () => (await counts())[1] === first + 1, "the kept word counts again");
  assert.ok(!(await page.evaluate(() => [...document.querySelectorAll(".cm-kin-cut")].some((n) => n.textContent!.trim() === "very"))));

  await bar().getByRole("button", { name: /Apply cuts/ }).click();
  await bar().waitFor({ state: "detached" });
  const applied = "The bowl is very old. It was broken once, and then, years later, mended with gold.\n\nWe utilize gold because it shows the break. Repair is a attention.";
  await until(() => disk().includes(applied), `the cuts land; the file is:\n${disk()}`);
  assert.equal(await page.locator(".cm-kin-mark").count(), 0);
  await focusEditor();
  await page.keyboard.press("Meta+z");
  await until(() => disk() === FILE, `one undo brings every cut back; the file is:\n${disk()}`);
});

test("cancelling a trim leaves the text alone", { timeout: 60_000 }, async () => {
  await focusEditor();
  await run("Cut in half −50%");
  await cuts().first().waitFor({ timeout: 20_000 });
  assert.ok(await cuts().filter({ hasText: "Repair is a kind of attention." }).count(), "a whole sentence can go");
  await page.keyboard.press("Escape");
  await bar().waitFor({ state: "detached" });
  assert.equal(await page.locator(".cm-kin-mark").count(), 0);
  assert.equal(disk(), FILE);
});

test("⌥⌘↩ applies a trim from the keyboard", { timeout: 60_000 }, async () => {
  await focusEditor();
  await run("Slight trim −10%");
  await cuts().first().waitFor({ timeout: 20_000 });
  await focusEditor();
  await page.keyboard.press("Meta+Alt+Enter");
  await bar().waitFor({ state: "detached" });
  await until(() => disk().includes("The bowl is old. I think it was broken once"), `filler goes; the file is:\n${disk()}`);
  await page.keyboard.press("Meta+z");
  await until(() => disk() === FILE, "and comes back in one undo");
});
