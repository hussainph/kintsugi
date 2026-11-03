// KI-86 against the real runtime: `pnpm desktop:headless` (the real Rust
// command registry on Tauri MockRuntime, and the real React app) driven by
// headless Chromium, with Kin on the scripted headless model.
//
// Alternatives: ⌥⌘A on a word, a sentence and a paragraph; adding versions
// swaps them in place; ⌥⌘] / ⌥⌘[ cycle; ⌘Z undoes one swap at a time; ⌫
// removes. The document on disk only ever holds the showing version; the
// rest is in `.kintsugi/alternatives/`, survives a reload, and moves with a
// rename. Light and dark screenshots go to .headless/<run>/shots/.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { openApp, startApp, type App } from "./headless-app.ts";

const DOC = "drafts/bowls.md";
const RENAMED = "drafts/mended.md";
const BODY = [
  "The bowl broke along an old line. I mended it with lacquer and patience.",
  "Kilns teach patience, and patience teaches repair.",
].join("\n\n");
const TIMEOUT = Number(process.env.KINTSUGI_RUNTIME_TIMEOUT ?? 15 * 60_000);

let app: App;
let browser: Browser;
let page: Page;

before(async () => {
  app = await startApp("ki86", { KINTSUGI_HEADLESS_KIN: "mock" }, (vault) => {
    writeFileSync(resolve(vault, DOC), `---\ntitle: "Bowls"\nstatus: draft\n---\n\n${BODY}\n`);
  });
  browser = await chromium.launch({ headless: true }).catch((e) => {
    throw new Error(`${e}\nInstall it with: pnpm --filter @kintsugi/desktop exec playwright install chromium-headless-shell`);
  });
  page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  await openApp(page, app.url, app.output);
  await open(DOC);
}, { timeout: TIMEOUT });

after(async () => {
  await browser?.close();
  await app?.stop();
});

const shot = (name: string) => page.screenshot({ path: resolve(app.shots, `${name}.png`) });
const disk = (path = DOC) => readFileSync(resolve(app.vault, path), "utf8");
const store = (path = DOC) => resolve(app.vault, `.kintsugi/alternatives/${path}.json`);
type Stored = { path: string; sets: { id: string; level: string; current: string; anchor: { exact: string }; entries: { id: string; text: string; by: string }[] }[] };
const stored = (path = DOC): Stored => JSON.parse(readFileSync(store(path), "utf8"));
const showing = (set: Stored["sets"][number]) => set.entries.find((e) => e.id === set.current)?.text;

async function until(check: () => boolean, what: string, tries = 150) {
  for (let i = 0; i < tries; i++) {
    try { if (check()) return; } catch { /* not there yet */ }
    await page.waitForTimeout(100);
  }
  assert.fail(what);
}

async function open(path: string) {
  await page.locator(`[title="${path}"]`).click();
  await page.locator(`[title="${path}"][data-active="true"]`).waitFor();
  await page.locator(".cm-line", { hasText: "Kilns teach patience" }).waitFor();
}

const line = (text: string) => page.locator(".cm-line", { hasText: text });
const panel = () => page.locator(".cm-alt-panel");
const field = () => panel().getByRole("textbox", { name: "Add an alternative" });
const options = () => panel().getByRole("option");
/** The editor's text without the alternatives' counts. */
const editorText = () => page.evaluate(() => {
  const copy = document.querySelector(".cm-content")!.cloneNode(true) as HTMLElement;
  copy.querySelectorAll(".cm-alt-count, .cm-alt-gutter").forEach((n) => n.remove());
  return copy.innerText;
});
/** Waits until the editor shows `text`. */
async function shows(text: string) {
  await page.waitForFunction((target) => {
    const copy = document.querySelector(".cm-content")?.cloneNode(true) as HTMLElement | undefined;
    copy?.querySelectorAll(".cm-alt-count, .cm-alt-gutter").forEach((n) => n.remove());
    return !!copy?.textContent?.includes(target);
  }, text, { timeout: 10_000 });
}

/** Clicks just inside the first `text` in the editor, putting the cursor there. */
async function cursorIn(text: string) {
  await shows(text);
  const at = await page.evaluate((target) => {
    const content = document.querySelector(".cm-content")!;
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const i = node.textContent!.indexOf(target);
      if (i === -1) continue;
      const range = document.createRange();
      range.setStart(node, i + 1);
      range.setEnd(node, i + 2);
      const box = range.getBoundingClientRect();
      return { x: box.left + 1, y: box.top + box.height / 2 };
    }
    return null;
  }, text);
  assert.ok(at, `${text} isn't in the editor`);
  await page.mouse.click(at.x, at.y);
  await page.waitForTimeout(50);
}

test("⌥⌘A on a word: typing adds a version and shows it in place; only the shown one is on disk", { timeout: 90_000 }, async () => {
  await cursorIn("old");
  await page.keyboard.press("Meta+Alt+KeyA");
  await field().waitFor();
  assert.equal(await panel().getByRole("tab", { selected: true }).textContent(), "Word");
  assert.deepEqual(await options().allTextContents(), ["old"]);
  await field().fill("ancient");
  await field().press("Enter");
  await shows("along an ancient line");
  await field().fill("faint");
  await field().press("Enter");
  await shows("along an faint line");
  assert.deepEqual(await options().allTextContents(), ["old", "ancient", "faint"]);
  assert.equal(await panel().locator('[aria-current="true"]').textContent(), "faint");
  await shot("01-word-panel-light");

  await until(() => disk().includes("along an faint line."), "the shown version is saved");
  await until(() => existsSync(store()) && stored().sets[0]?.entries.length === 3, "the versions are kept beside the document");
  const [set] = stored().sets;
  assert.equal(set.level, "word");
  assert.equal(showing(set), "faint");
  assert.deepEqual(set.entries.map((e) => e.by), ["owner", "owner", "owner"]);
  assert.ok(!disk().includes("ancient") && !disk().includes(" old line"), "the other versions aren't in the document");

  // ↑ and Enter picks.
  await field().press("ArrowUp");
  await field().press("ArrowUp");
  await field().press("Enter");
  await shows("along an old line");
  await field().press("Escape");
  await panel().waitFor({ state: "detached" });
  await line("The bowl broke").locator(".cm-alt-span").waitFor();
  assert.equal(await line("The bowl broke").locator(".cm-alt-count").textContent(), "3");
});

test("⌥⌘] and ⌥⌘[ cycle in place; ⌘Z undoes one swap at a time", { timeout: 60_000 }, async () => {
  await cursorIn("old");
  await page.keyboard.press("Meta+Alt+BracketRight");
  await shows("along an ancient line");
  await page.keyboard.press("Meta+Alt+BracketRight");
  await shows("along an faint line");
  await page.keyboard.press("Meta+Alt+BracketLeft");
  await shows("along an ancient line");
  await page.keyboard.press("Meta+z");
  await shows("along an faint line");
  await page.keyboard.press("Meta+z");
  await shows("along an ancient line");
  await page.keyboard.press("Meta+Shift+z");
  await shows("along an faint line");
  await page.keyboard.press("Meta+Alt+BracketRight");
  await shows("along an old line");
  await until(() => disk().includes("along an old line.") && showing(stored().sets[0]) === "old", "the cycled version is saved");
});

test("sentence and paragraph: ←/→ switch, ⌫ removes, a mark in the gutter", { timeout: 90_000 }, async () => {
  await cursorIn("mended");
  await page.keyboard.press("Meta+Alt+KeyA");
  await field().waitFor();
  await field().press("ArrowRight");
  assert.equal(await panel().getByRole("tab", { selected: true }).textContent(), "Sentence");
  assert.deepEqual(await options().allTextContents(), ["I mended it with lacquer and patience."]);
  await field().fill("I fixed it with glue.");
  await field().press("Enter");
  await shows("I fixed it with glue.");
  await shot("02-sentence-light");

  await field().press("ArrowRight");
  assert.equal(await panel().getByRole("tab", { selected: true }).textContent(), "Paragraph");
  await field().fill("It broke, and I fixed it.");
  await field().press("Enter");
  await shows("It broke, and I fixed it.");
  await field().fill("A bowl, broken.");
  await field().press("Enter");
  await shows("A bowl, broken.");
  assert.equal(await options().count(), 3);
  // ⌫ on the shown one removes it and shows its neighbour.
  await field().press("Backspace");
  await shows("It broke, and I fixed it.");
  assert.equal(await options().count(), 2);
  await field().press("ArrowUp");
  await field().press("Enter");
  await shows("I fixed it with glue.");
  await field().press("Escape");
  await line("The bowl broke").locator(".cm-alt-gutter").waitFor();
  assert.equal(await line("The bowl broke").locator(".cm-alt-gutter").textContent(), "2");
  await shot("03-markers-light");

  await until(() => stored().sets.length === 3, "a word, a sentence and a paragraph");
  assert.deepEqual(stored().sets.map((s) => s.level).sort(), ["paragraph", "sentence", "word"]);
  assert.ok(disk().includes("The bowl broke along an old line. I fixed it with glue.\n"), disk());
});

test("alternatives survive edits around them and a reload", { timeout: 90_000 }, async () => {
  await line("Kilns teach").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Every time.");
  await line("The bowl broke").click({ position: { x: 5, y: 8 } });
  await page.keyboard.press("Home");
  await page.keyboard.type("A new opening.\n\n");
  await until(() => disk().includes("A new opening.\n\nThe bowl broke"), "the edits are saved");
  await page.waitForTimeout(1200);

  await page.reload();
  await open(DOC);
  await shows("along an old line");
  await line("The bowl broke").locator(".cm-alt-span").first().waitFor();
  await line("The bowl broke").locator(".cm-alt-gutter").waitFor();
  await cursorIn("old");
  await page.keyboard.press("Meta+Alt+BracketRight");
  await shows("along an ancient line");
  assert.ok(!(await editorText()).includes("along an old line"));
});

test("dark mode", { timeout: 60_000 }, async () => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(300);
  await shot("04-markers-dark");
  await cursorIn("ancient");
  await page.keyboard.press("Meta+Alt+KeyA");
  await field().waitFor();
  await shot("05-word-panel-dark");
  await field().press("Escape");
  await page.emulateMedia({ colorScheme: "light" });
});

test("the selection menu opens alternatives for the selection", { timeout: 60_000 }, async () => {
  await cursorIn("Kilns");
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await page.keyboard.press("Shift+F10");
  const item = page.locator('.ki-selection-menu [data-action="alternatives"]');
  await item.waitFor();
  assert.match(await item.textContent() ?? "", /Alternatives…\s*⌥⌘A/);
  await item.click();
  await field().waitFor();
  assert.equal(await panel().getByRole("tab", { selected: true }).textContent(), "Paragraph");
  await field().press("Escape");
});

test("a renamed document takes its alternatives", { timeout: 90_000 }, async () => {
  await until(() => disk().includes("along an ancient line."), "saved before the rename");
  await page.waitForTimeout(1200);
  const row = page.locator(`[title="${DOC}"]`);
  await row.focus();
  await row.press("F2");
  const input = page.locator("[data-sidebar=sidebar] input");
  await input.waitFor();
  await input.fill("mended");
  await input.press("Enter");
  await input.waitFor({ state: "detached" });
  await page.locator(`[title="${RENAMED}"]`).waitFor();
  await until(() => existsSync(store(RENAMED)) && !existsSync(store()), "the file moved with the document");
  assert.equal(stored(RENAMED).path, RENAMED);

  await page.reload();
  await open(RENAMED);
  await shows("along an ancient line");
  await line("The bowl broke").locator(".cm-alt-span").first().waitFor();
  await cursorIn("ancient");
  await page.keyboard.press("Meta+Alt+BracketLeft");
  await shows("along an old line");
  await until(() => disk(RENAMED).includes("along an old line."), "saved under the new name");
  await until(() => showing(stored(RENAMED).sets.find((s) => s.level === "word")!) === "old", "and its alternatives too");
  assert.ok(!existsSync(store()), "nothing left under the old name");
});
