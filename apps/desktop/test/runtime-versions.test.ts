// KI-111 against the real runtime: `pnpm desktop:headless` (the real Rust
// command registry on Tauri MockRuntime, and the real React app) driven by
// headless Chromium. No model is involved.
//
// Versions you can find: the cursor, not an exact selection, finds a span's
// versions. Clicking in a span shows the `‹ 1 of N ›` card under its end
// once clicks settle; arrowing into one shows it once the cursor rests; typing hides it.
// ‹ › and ⌥⌘[ / ⌥⌘] swap in place; the count opens the list in the Stash
// tab, and so does ⌘K's "Versions (3)". Nested spans: the innermost wins and
// the others are tabs. A partial selection finds the set it overlaps. Light
// and dark screenshots and a video go to .headless/<run>/shots/.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { anchorAt } from "../../../packages/editor/src/anchors.ts";
import { openApp, startApp, type App } from "./headless-app.ts";

const DOC = "drafts/bowls.md";
const BODY = [
  "The bowl broke along an old line. I mended it with lacquer and patience.",
  "Kilns teach patience, and patience teaches repair.",
  // Hard-wrapped by a tool: it flows as one paragraph (KI-108).
  "Gold fills the crack, and the crack becomes the most looked-at part\nof the bowl. Nobody hides the mend here; the seam is the point of it.\nThat is why it lasts.",
].join("\n\n");
const FLOWED = "Gold fills the crack, and the crack becomes the most looked-at part\nof the bowl.";
const FILE = `---\ntitle: "Bowls"\nstatus: draft\n---\n\n${BODY}\n`;
const TIMEOUT = Number(process.env.KINTSUGI_RUNTIME_TIMEOUT ?? 15 * 60_000);
const created = "2026-11-01T10:00:00.000Z";

/** A stored set on the first `text` in FILE: its versions, the first showing. */
function set(id: string, level: string, text: string, others: [string, "owner" | "kin"][]) {
  const at = FILE.indexOf(text);
  const entries = [[text, "owner"] as const, ...others].map(([t, by], i) => ({ id: `${id}-${i}`, text: t, by, created }));
  return { id, level, anchor: anchorAt(FILE, at, at + text.length), current: entries[0].id, entries, created };
}
const SETS = [
  set("phrase", "phrase", "along an old line", [["down an old seam", "owner"]]),
  set("word", "word", "old", [["ancient", "owner"], ["faint", "kin"]]),
  set("paragraph", "paragraph", "Kilns teach patience, and patience teaches repair.", [["Kilns teach patience.", "kin"]]),
  set("ending", "phrase", "patience teaches repair.", [["repair teaches patience.", "owner"]]),
  set("flowed", "sentence", FLOWED, [["Gold makes the crack the part you look at.", "owner"]]),
  set("seam", "word", "seam", [["join", "kin"]]),
];

let app: App;
let browser: Browser;
let page: Page;

before(async () => {
  app = await startApp("ki111", {}, (vault) => {
    writeFileSync(resolve(vault, DOC), FILE);
    const store = resolve(vault, `.kintsugi/alternatives/${DOC}.json`);
    mkdirSync(dirname(store), { recursive: true });
    writeFileSync(store, JSON.stringify({ version: 1, path: DOC, sets: SETS }));
  });
  browser = await chromium.launch({ headless: true }).catch((e) => {
    throw new Error(`${e}\nInstall it with: pnpm --filter @kintsugi/desktop exec playwright install chromium-headless-shell`);
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await openApp(page, app.url, app.output);
  await open();
}, { timeout: TIMEOUT });

after(async () => {
  await browser?.close();
  await app?.stop();
});

async function open(on = page) {
  await on.locator(`[title="${DOC}"]`).click();
  await on.locator(`[title="${DOC}"][data-active="true"]`).waitFor();
  await on.locator(".cm-line", { hasText: "Kilns teach patience" }).waitFor();
  await on.locator(".cm-alt-span").first().waitFor();
}

const shot = (name: string) => page.screenshot({ path: resolve(app.shots, `${name}.png`) });
const disk = () => readFileSync(resolve(app.vault, DOC), "utf8");
const card = (on = page) => on.locator(".cm-alt-card .ki-step-card");
const count = () => card().locator("[data-card-count]");
/** The card of one stored set. */
const cardOf = (id: string) => page.locator(`.cm-alt-card[data-versions="${id}"] .ki-step-card`);
const versions = () => page.locator(".ki-versions");
const field = () => versions().getByRole("textbox", { name: "Add a version" });
const options = () => versions().getByRole("option");
const selectedTab = () => versions().getByRole("tab", { selected: true });
/** The editor's text without the switcher and the position dots. */
const editorText = () => page.evaluate(() => {
  const copy = document.querySelector(".cm-content")!.cloneNode(true) as HTMLElement;
  copy.querySelectorAll(".cm-alt-count, .cm-alt-gutter, .cm-step-card").forEach((n) => n.remove());
  return copy.textContent ?? "";
});

async function until(check: () => boolean | Promise<boolean>, what: string, tries = 150) {
  for (let i = 0; i < tries; i++) {
    try { if (await check()) return; } catch { /* not there yet */ }
    await page.waitForTimeout(100);
  }
  assert.fail(what);
}
const shows = (text: string) => until(async () => (await editorText()).includes(text), `the editor shows ${text}`);

/** Where the first `text` in the editor is, `offset` characters in. */
async function at(text: string, offset: number, on = page) {
  const point = await on.evaluate(([target, i]) => {
    const content = document.querySelector(".cm-content")!;
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if ((node.parentElement as HTMLElement).closest(".cm-step-card")) continue;
      const found = node.textContent!.indexOf(target as string);
      if (found === -1) continue;
      const range = document.createRange();
      range.setStart(node, found + (i as number));
      range.setEnd(node, found + (i as number));
      const box = range.getBoundingClientRect();
      return { x: box.left, y: box.top + box.height / 2 };
    }
    return null;
  }, [text, offset] as const);
  assert.ok(point, `${text} isn't in the editor`);
  return point;
}
/** Clicks just inside `text`, putting the cursor there. */
async function click(text: string, offset = 1, on = page) {
  const point = await at(text, offset, on);
  await on.mouse.click(point.x + 1, point.y);
}

test("clicking in a span shows ‹ 1 of 3 › after clicks settle, under the span's end; Escape hides it", { timeout: 60_000 }, async () => {
  await click("old");
  // A click shows it once no second click follows.
  await card().waitFor({ timeout: 1000 });
  assert.equal(await count().textContent(), "1 of 3");
  assert.equal(await card().getAttribute("data-kind"), "versions");
  // It starts below the span's end.
  const end = await at("old", 3);
  const box = (await card().boundingBox())!;
  assert.ok(Math.abs(box.x - end.x) <= 2, `card at ${box.x}, the span ends at ${end.x}`);
  assert.ok(box.y > end.y, "under the line, not over it");
  await shot("01-card-light");
  await page.keyboard.press("Escape");
  await card().waitFor({ state: "detached" });
});

test("Escape cancels a card before it appears, after either a click or a key", { timeout: 60_000 }, async () => {
  await click("old");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  assert.equal(await card().count(), 0, "a pending click must not bring the card back");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  assert.equal(await card().count(), 0, "a pending keyboard rest must not bring it back");
  await click("along", 1);
  for (let i = 0; i < 10; i++) await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  assert.equal(await card().count(), 0, "collapsing a selection with Escape must not restart the rest");
});

test("a pending rest does not show a card after focus leaves the editor", { timeout: 60_000 }, async () => {
  await click("old");
  await page.locator("[data-sidebar=sidebar]").getByRole("button", { name: /^Feed/ }).focus();
  await page.waitForTimeout(500);
  assert.equal(await card().count(), 0);
  await click("old");
  await card().waitFor();
  await page.keyboard.press("Escape");
});

test("‹ › and ⌥⌘] / ⌥⌘[ swap in place; only the showing version is in the file", { timeout: 60_000 }, async () => {
  await click("old");
  await card().waitFor();
  await card().locator('[data-card-action="next"]').click();
  await shows("along an ancient line");
  assert.equal(await count().textContent(), "2 of 3");
  await page.keyboard.press("Meta+Alt+BracketRight");
  await shows("along an faint line");
  assert.equal(await count().textContent(), "3 of 3");
  await page.keyboard.press("Meta+Alt+BracketLeft");
  await shows("along an ancient line");
  await card().locator('[data-card-action="previous"]').click();
  await shows("along an old line");
  assert.equal(await count().textContent(), "1 of 3");
  // The editor kept its focus: the keys still reach it.
  await page.keyboard.press("Meta+Alt+BracketRight");
  await shows("along an ancient line");
  await until(() => disk().includes("along an ancient line."), "the showing version is saved");
  assert.ok(!disk().includes("faint") && !disk().includes("old line"), "the others stay beside the file");
  await page.keyboard.press("Meta+Alt+BracketLeft");
  await shows("along an old line");
  await until(() => disk() === FILE, "back as it was");
});

test("arrowing into a span shows it once the cursor rests; typing hides it until it rests again", { timeout: 60_000 }, async () => {
  await click("broke");
  await page.waitForTimeout(500);
  assert.equal(await card().count(), 0, "no versions on this word");
  // b|roke → |along: five steps, the last one into the selection's span.
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(150);
  assert.equal(await card().count(), 0, "not while he's moving");
  await card().waitFor({ timeout: 1000 });
  assert.equal(await count().textContent(), "1 of 2", "the selection around the cursor");
  // Typing inside it edits the showing version and hides the card.
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.type("l");
  assert.equal(await card().count(), 0, "hidden while he types");
  await page.keyboard.type("l");
  await page.waitForTimeout(150);
  assert.equal(await card().count(), 0);
  await card().waitFor({ timeout: 1000 });
  assert.equal(await count().textContent(), "1 of 2", "the edit is still the showing version");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await shows("broke along an old line.");
  await until(() => disk() === FILE, "the typing undone");
  // Moving off the span hides it.
  await page.keyboard.press("Home");
  await card().waitFor({ state: "detached" });
});

test("a partial selection finds the set it overlaps, spaces and all", { timeout: 60_000 }, async () => {
  // "long an ol": part of the selection's span, cutting through its words.
  await click("along", 1);
  for (let i = 0; i < 10; i++) await page.keyboard.press("Shift+ArrowRight");
  await card().waitFor({ timeout: 1000 });
  assert.equal(await count().textContent(), "1 of 2");
  await page.keyboard.press("Meta+Alt+KeyA");
  await field().waitFor();
  assert.equal(await selectedTab().getAttribute("aria-label"), "Selection, 2 versions");
  assert.deepEqual(await options().allTextContents(), ["along an old line", "down an old seam"]);
  await options().last().click();
  await shows("broke down an old seam.");
  await field().press("Escape");
  // ⌥⌘[ swaps the same span back, no exact selection needed.
  await page.keyboard.press("Meta+Alt+BracketLeft");
  await shows("broke along an old line.");
  await until(() => disk() === FILE, "back as it was");
});

test("nested spans: the innermost wins, the others are tabs with their counts", { timeout: 60_000 }, async () => {
  await click("old");
  await page.keyboard.press("Meta+Alt+KeyA");
  await field().waitFor();
  assert.equal(await selectedTab().getAttribute("aria-label"), "Word, 3 versions");
  assert.deepEqual(await versions().getByRole("tab").allTextContents(), ["Selection2", "Word3", "Sentence", "Paragraph"]);
  assert.deepEqual(await options().allTextContents(), ["old", "ancient", "faint"]);
  await versions().getByRole("tab", { name: "Selection, 2 versions" }).click();
  assert.deepEqual(await options().allTextContents(), ["along an old line", "down an old seam"]);
  await shot("02-tabs-light");
  await versions().getByRole("tab", { name: "Word, 3 versions" }).click();
  assert.deepEqual(await options().allTextContents(), ["old", "ancient", "faint"]);
  await field().press("Escape");
});

test("the count opens the list in the Stash tab", { timeout: 60_000 }, async () => {
  await click("old");
  await cardOf("word").waitFor();
  await count().click();
  await field().waitFor();
  assert.equal(await selectedTab().getAttribute("aria-label"), "Word, 3 versions");
  assert.equal(await versions().locator('[aria-current="true"]').textContent(), "old");
  await field().press("Escape");
});

test("⌘K has Versions (3) in a span with versions, and it opens the list", { timeout: 60_000 }, async () => {
  const refine = () => page.locator("[data-slot=popover-content]");
  await click("bowl");
  await page.keyboard.press("Meta+k");
  await refine().getByRole("option").first().waitFor();
  assert.equal(await refine().getByRole("option", { name: /^Versions/ }).count(), 0, "none on a word without versions");
  await page.keyboard.press("Escape");
  await refine().waitFor({ state: "detached" });

  await click("old");
  await page.keyboard.press("Meta+k");
  const row = refine().getByRole("option", { name: /^Versions \(3\)/ });
  await row.waitFor();
  await row.click();
  await field().waitFor();
  assert.equal(await selectedTab().getAttribute("aria-label"), "Word, 3 versions");
  await until(async () => (await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))) === "Add a version", "the list has focus");
  await field().press("Escape");
});

test("a paragraph's dots in the gutter put the cursor there and show its card", { timeout: 60_000 }, async () => {
  await click("bowl");
  await page.locator(".cm-line", { hasText: "Kilns teach" }).locator(".cm-alt-gutter").click();
  await card().waitFor({ timeout: 1000 });
  assert.equal(await count().textContent(), "1 of 2");
  // The nested selection ends at the same position. The keys must step the
  // paragraph shown by the card, not the innermost set touching the cursor.
  await page.keyboard.press("Meta+Alt+BracketRight");
  await until(async () => !(await editorText()).includes("and patience teaches") && (await editorText()).includes("Kilns teach patience."), "the keys swap the paragraph, not its nested selection");
  await page.keyboard.press("Meta+Alt+BracketLeft");
  await shows("Kilns teach patience, and patience teaches repair.");
  await card().locator('[data-card-action="next"]').click();
  await until(async () => !(await editorText()).includes("and patience teaches") && (await editorText()).includes("Kilns teach patience."), "Kin's shorter paragraph shows");
  await card().locator('[data-card-action="previous"]').click();
  await shows("Kilns teach patience, and patience teaches repair.");
  await until(() => disk() === FILE, "back as it was");
});

test("a card never moves the text between the clicks of a double-click", { timeout: 60_000 }, async () => {
  await click("old");
  await card().waitFor();
  // Under the card: the second paragraph. Double-click a word there.
  const before = await at("teach", 2);
  await page.mouse.move(before.x, before.y);
  await page.mouse.down();
  await page.mouse.up();
  const between = await at("teach", 2);
  assert.equal(between.y, before.y, "nothing moved after the first click");
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.up({ clickCount: 2 });
  assert.equal(await page.evaluate(() => window.getSelection()?.toString()), "teach");
  // Once clicks settle, the card moves to the paragraph, not its nested ending.
  await cardOf("paragraph").waitFor();
  assert.equal(await count().textContent(), "1 of 2");
});

test("in a flowed paragraph: the cursor finds a sentence across a soft break, and a word on its next source line", { timeout: 60_000 }, async () => {
  const flowed = page.locator(".cm-line", { hasText: "Gold fills the crack" });
  assert.ok(await flowed.locator(".cm-soft-break").count() > 0, "the paragraph flows");
  // The sentence crosses the first soft break; click its second source line.
  await click("of the bowl", 2);
  await cardOf("flowed").waitFor();
  assert.equal(await count().textContent(), "1 of 2");
  const box = (await card().boundingBox())!;
  const end = await at("of the bowl.", 12);
  assert.ok(Math.abs(box.x - end.x) <= 2, `card at ${box.x}, the sentence ends at ${end.x}`);
  assert.ok(box.y > (await at("That is why", 0)).y, "under the whole flowed paragraph");
  await card().locator('[data-card-action="next"]').click();
  await shows("Gold makes the crack the part you look at. Nobody hides");
  await page.keyboard.press("Meta+Alt+BracketLeft");
  await shows("most looked-at part");
  // A word on the next source line, reached with the keyboard.
  await click("seam", 0);
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(500);
  assert.equal(await cardOf("seam").count(), 0, "off the word");
  await page.keyboard.press("ArrowRight");
  await cardOf("seam").waitFor({ timeout: 1000 });
  assert.equal(await count().textContent(), "1 of 2");
  await page.keyboard.press("Meta+Alt+BracketRight");
  await shows("the join is the point");
  await page.keyboard.press("Meta+Alt+BracketLeft");
  await shows("the seam is the point");
  await until(() => disk() === FILE, "back as it was, its source lines kept");
});

test("dark mode", { timeout: 60_000 }, async () => {
  await page.emulateMedia({ colorScheme: "dark" });
  await click("old");
  await cardOf("word").waitFor();
  await page.waitForTimeout(300);
  await shot("03-card-dark");
  await page.keyboard.press("Meta+Alt+KeyA");
  await field().waitFor();
  await page.waitForTimeout(300);
  await shot("04-tabs-dark");
  await field().press("Escape");
  await page.emulateMedia({ colorScheme: "light" });
});

test("a video of finding and swapping versions", { timeout: 90_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: app.shots, size: { width: 1280, height: 800 } } });
  const tab = await context.newPage();
  await openApp(tab, app.url, app.output);
  await open(tab);
  await click("broke", 1, tab);
  await tab.waitForTimeout(700);
  for (let i = 0; i < 5; i++) { await tab.keyboard.press("ArrowRight"); await tab.waitForTimeout(120); }
  await tab.waitForTimeout(1200);
  await tab.keyboard.press("Meta+Alt+BracketRight");
  await tab.waitForTimeout(1000);
  await tab.keyboard.press("Meta+Alt+BracketLeft");
  await tab.waitForTimeout(800);
  await click("old", 1, tab);
  await tab.waitForTimeout(900);
  for (const step of ["next", "next", "next"]) {
    await card(tab).locator(`[data-card-action="${step}"]`).click();
    await tab.waitForTimeout(900);
  }
  await card(tab).locator("[data-card-count]").click();
  await tab.waitForTimeout(1500);
  await tab.keyboard.press("Escape");
  await tab.waitForTimeout(600);
  const video = tab.video();
  await context.close();
  const path = await video!.path();
  assert.ok(existsSync(path));
  writeFileSync(resolve(app.shots, "video-path.txt"), path);
  await until(() => disk() === FILE, "the video leaves the file as it was");
});
