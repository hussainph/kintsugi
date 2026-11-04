// KI-109 against the real runtime: `pnpm desktop:headless` (the real Rust
// command registry on Tauri MockRuntime, and the real React app) driven by
// headless Chromium, with the review answered by the scripted headless model
// (`KINTSUGI_HEADLESS_KIN=mock`): no credentials, no cost.
//
// Nothing shows unasked. "Review this draft" (⌘K, or the Kin tab) marks the
// draft in gold: a flag, cuts and rewrites, with the card under the focused
// one's paragraph. ‹ 1 of N › steps by mouse and by ⌘' / ⇧⌘'; ⌥↵ accepts
// (one undo each; a cut that starts a sentence capitalises the next word),
// ⌥⌘⌫ dismisses, ⇧⌘J discusses in a paragraph thread, Stash keeps a
// rewrite, and Escape closes them all. Marks and the card never re-wrap a
// line, survive switching documents and margins, and never reach the file.
// "Review this section" covers the heading the cursor is under. Light and
// dark screenshots and a video of stepping go to .headless/<run>/shots/.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { openApp, startApp, type App } from "./headless-app.ts";

const DOC = "drafts/review.md";
const OTHER = "drafts/kintsugi-and-gold.md";
const BODY = [
  "The bowl is old. I think it was just broken once, and then mended with gold.",
  "## Gold",
  "We utilize gold because it shows the break. Repair is a kind of attention.",
  "Nobody was allowed to use it. We leverage the seam.",
].join("\n\n");
const FILE = `---\ntitle: "Review"\nstatus: draft\n---\n\n${BODY}\n`;
const TIMEOUT = Number(process.env.KINTSUGI_RUNTIME_TIMEOUT ?? 15 * 60_000);

let app: App;
let browser: Browser;
let page: Page;

before(async () => {
  app = await startApp("ki109", { KINTSUGI_HEADLESS_KIN: "mock" }, (vault) => writeFileSync(resolve(vault, DOC), FILE));
  browser = await chromium.launch({ headless: true }).catch((e) => {
    throw new Error(`${e}\nInstall it with: pnpm --filter @kintsugi/desktop exec playwright install chromium-headless-shell`);
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await openApp(page, app.url, app.output);
  await openDoc(DOC, "We leverage the seam.");
}, { timeout: TIMEOUT });

after(async () => {
  await browser?.close();
  await app?.stop();
});

async function openDoc(path: string, text: string, on = page) {
  await on.locator(`[title="${path}"]`).click();
  await on.locator(`[title="${path}"][data-active="true"]`).waitFor();
  await on.locator(".cm-line", { hasText: text }).first().waitFor();
}

const shot = (name: string) => page.screenshot({ path: resolve(app.shots, `${name}.png`) });
const disk = () => readFileSync(resolve(app.vault, DOC), "utf8");
const line = (text: string) => page.locator(".cm-line", { hasText: text });
const refine = () => page.locator("[data-slot=popover-content]");
const card = () => page.locator(".ki-step-card");
const count = () => card().locator("[data-card-count]");
const action = (name: string) => card().locator(`[data-card-action="${name}"]`);
const focused = () => page.locator(".cm-kin-focused");
const pane = () => page.getByRole("region", { name: "Kin" });
const marked = () => page.evaluate(() => [...document.querySelectorAll(".cm-kin-mark")].map((n) => [n.className.match(/cm-kin-(cut|flag|rewrite)/)![1], n.textContent]));
const editorText = () => page.evaluate(() => document.querySelector(".cm-content")!.textContent ?? "");

async function until(check: () => boolean | Promise<boolean>, what: string, tries = 150) {
  for (let i = 0; i < tries; i++) {
    try { if (await check()) return; } catch { /* not there yet */ }
    await page.waitForTimeout(100);
  }
  assert.fail(what);
}

/** Every text line's left edge (from the column's), width and height: where it wraps. */
const wraps = () => page.evaluate(() => {
  const left = document.querySelector(".cm-content")!.getBoundingClientRect().left;
  return [...document.querySelectorAll(".cm-content .cm-line")].map((n) => {
    const r = n.getBoundingClientRect();
    return `${Math.round(r.left - left)},${Math.round(r.width)},${Math.round(r.height)}`;
  });
});

const EXPECTED = [
  ["flag", "The bowl is old."],
  ["cut", "I think "],
  ["cut", "just "],
  ["rewrite", "utilize"],
  ["cut", "kind of "],
  ["rewrite", "leverage"],
];

async function review(how: "draft" | "section" = "draft") {
  await page.keyboard.press("Meta+k");
  await refine().getByRole("option", { name: how === "draft" ? "Review this draft" : "Review this section" }).click();
  await card().waitFor({ timeout: 20_000 });
}

const focusEditor = () => line("Nobody was allowed").click({ position: { x: 4, y: 4 } });

test("nothing is marked unasked; ⌘K offers the reviews", { timeout: 60_000 }, async () => {
  await focusEditor();
  await page.waitForTimeout(1500);
  assert.equal(await page.locator(".cm-kin-mark").count(), 0);
  assert.equal(await card().count(), 0);
  await page.keyboard.press("Meta+k");
  for (const name of ["Review this draft", "Review this section"]) await refine().getByRole("option", { name }).waitFor();
  await page.keyboard.press("Escape");
});

test("a review marks the draft in gold with a card under the paragraph, re-wrapping nothing", { timeout: 90_000 }, async () => {
  await focusEditor();
  const shape = await wraps();
  await page.keyboard.press("Meta+k");
  await refine().getByRole("option", { name: "Review this draft" }).click();
  await page.locator(".ki-review-bar").getByText("Kin is reviewing this draft").waitFor();
  await card().waitFor({ timeout: 20_000 });
  await page.locator(".ki-review-bar").waitFor({ state: "detached" });
  assert.deepEqual(await marked(), EXPECTED, "the made-up quote is dropped");
  assert.equal(disk(), FILE, "nothing is written");
  assert.ok(!(await editorText()).includes("use gold"), "a rewrite's words are only on the card");
  await card().getByText("Mock: what is this claim resting on?").waitFor();
  assert.equal(await count().textContent(), "1 of 6");
  await focused().filter({ hasText: "The bowl is old." }).waitFor();
  const style = await page.locator(".cm-kin-flag").first().evaluate((n) => { const s = getComputedStyle(n); return { line: s.textDecorationLine, color: s.textDecorationColor }; });
  assert.equal(style.line, "underline");
  assert.notEqual(style.color, "rgba(0, 0, 0, 0)");
  assert.equal(await page.locator(".cm-kin-cut").first().evaluate((n) => getComputedStyle(n).textDecorationLine), "line-through");

  // The card sits under the paragraph: below the focused words' line, in the text column.
  const words = (await focused().boundingBox())!;
  const box = (await card().boundingBox())!;
  const paragraph = (await line("The bowl is old.").last().boundingBox())!;
  assert.ok(box.y >= paragraph.y + paragraph.height - 1, "the card never covers the paragraph");
  assert.ok(box.y >= words.y + words.height, "or the line it explains");
  assert.ok(Math.abs(box.x - paragraph.x - (await line("The bowl").first().evaluate((n) => parseFloat(getComputedStyle(n).paddingLeft)))) < 2, "it starts at the text's edge");
  assert.deepEqual(await wraps(), shape, "marks and the card re-wrap no line");

  await page.mouse.move(1, 1);
  await page.waitForTimeout(500);
  await shot("01-review-light");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(300);
  await shot("02-review-dark");
  await page.emulateMedia({ colorScheme: "light" });
});

test("‹ 1 of N › steps by keyboard and mouse", { timeout: 60_000 }, async () => {
  await page.keyboard.press("Meta+Quote");
  await focused().filter({ hasText: "I think" }).waitFor();
  assert.equal(await count().textContent(), "2 of 6");
  await page.keyboard.press("Meta+Shift+Quote");
  await focused().filter({ hasText: "The bowl is old." }).waitFor();
  await page.keyboard.press("Meta+Shift+Quote");
  await focused().filter({ hasText: "leverage" }).waitFor();
  assert.equal(await count().textContent(), "6 of 6", "previous wraps to the last");
  await action("next").click();
  await focused().filter({ hasText: "The bowl is old." }).waitFor();
  await action("next").click();
  await focused().filter({ hasText: "I think" }).waitFor();
  // A rewrite's card shows its words.
  await action("next").click();
  await action("next").click();
  await focused().filter({ hasText: "utilize" }).waitFor();
  await card().locator(".ki-step-card-text", { hasText: /^use$/ }).waitFor();
  await page.mouse.move(1, 1);
  await shot("03-rewrite-light");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(300);
  await shot("04-rewrite-dark");
  await page.emulateMedia({ colorScheme: "light" });
  await action("previous").click();
  await action("previous").click();
  await focused().filter({ hasText: "I think" }).waitFor();
});

test("accepting a cut or rewrite is one undo step; dismissing changes nothing", { timeout: 60_000 }, async () => {
  // A cut that starts a sentence: the next word takes the capital.
  await page.keyboard.press("Alt+Enter");
  await until(() => disk().includes("The bowl is old. It was just broken once"), `the cut lands; the file is:\n${disk()}`);
  await focused().filter({ hasText: "just" }).waitFor();
  assert.equal(await count().textContent(), "2 of 5");
  await page.keyboard.press("Meta+z");
  await until(() => disk() === FILE, `one undo brings it back; the file is:\n${disk()}`);
  await page.keyboard.press("Meta+Alt+Backspace");
  await focused().filter({ hasText: "utilize" }).waitFor();
  assert.equal(await count().textContent(), "2 of 4");
  assert.equal(disk(), FILE, "dismissing keeps the words");
  await action("accept").click();
  await until(() => disk().includes("We use gold because"), `the rewrite lands; the file is:\n${disk()}`);
  await focused().filter({ hasText: "kind of" }).waitFor();
  assert.equal(await count().textContent(), "2 of 3");
  await page.keyboard.press("Meta+z");
  await until(() => disk() === FILE, `one undo for the rewrite; the file is:\n${disk()}`);
  assert.deepEqual((await marked()).map(([, text]) => text), ["The bowl is old.", "kind of ", "leverage"]);
});

test("Discuss opens a paragraph thread that starts with Kin's suggestion", { timeout: 60_000 }, async () => {
  await page.keyboard.press("Meta+Shift+j");
  await pane().waitFor();
  await pane().locator('[data-role="kin"]').getByText("I’d cut “kind of”. A hedge; it's firmer without it.").waitFor();
  await pane().locator(".ki-kin-about-passage", { hasText: "We utilize gold" }).waitFor();
  await page.mouse.move(1, 1);
  await shot("05-discuss-light");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(300);
  await shot("05-discuss-dark");
  await page.emulateMedia({ colorScheme: "light" });
  assert.equal(await card().count(), 1, "the suggestion stays to decide on");
  await page.keyboard.press("Meta+j");
  await pane().waitFor({ state: "detached" });
});

test("Stash keeps a rewrite for later; Escape closes the rest", { timeout: 60_000 }, async () => {
  await line("Nobody was allowed").locator(".cm-kin-rewrite").click();
  await focused().filter({ hasText: "leverage" }).waitFor();
  await action("stash").click();
  // Like every stash (KI-110): a lit row or a pulsing dot, never a toast.
  await page.locator(".ki-margin-toggle .ki-margin-pulse").waitFor({ state: "attached" });
  assert.equal(await page.locator("[data-sonner-toast]").count(), 0, "a review rewrite uses the same quiet feedback, without a toast");
  assert.equal(await page.locator("aside.ki-margin[data-open]").count(), 0, "stashing keeps the margin closed");
  await until(async () => (await marked()).length === 2, "the stashed one goes");
  const sidecar = resolve(app.vault, `.kintsugi/stash/${DOC}.md`);
  await until(() => existsSync(sidecar) && /\buse\b/.test(readFileSync(sidecar, "utf8")), "the rewrite is in the stash");
  assert.equal(disk(), FILE, "stashing writes nothing to the draft");
  await focusEditor();
  await page.keyboard.press("Escape");
  await until(async () => (await page.locator(".cm-kin-mark").count()) === 0, "Escape takes every mark away");
  assert.equal(await card().count(), 0);
  assert.equal(disk(), FILE);
});

test("a review survives switching documents and margins, and never reaches the file", { timeout: 90_000 }, async () => {
  await focusEditor();
  await review();
  await page.keyboard.press("Meta+Quote");
  await openDoc(OTHER, "Kintsugi and gold");
  assert.equal(await page.locator(".cm-kin-mark").count(), 0, "the other draft has none");
  await openDoc(DOC, "We leverage the seam.");
  assert.deepEqual(await marked(), EXPECTED);
  await focused().filter({ hasText: "I think" }).waitFor();
  await page.keyboard.press("Meta+Shift+r");
  await page.waitForTimeout(400);
  await page.keyboard.press("Meta+Alt+Backslash");
  await page.waitForTimeout(400);
  assert.deepEqual(await marked(), EXPECTED, "the margin changes nothing");
  assert.equal(disk(), FILE);
  // Reopened, the draft has no marks: nothing was saved.
  await page.reload();
  await openDoc(DOC, "We leverage the seam.");
  await page.waitForTimeout(800);
  assert.equal(await page.locator(".cm-kin-mark").count(), 0);
});

test("Review this section covers the heading the cursor is under", { timeout: 60_000 }, async () => {
  await line("We utilize gold").click({ position: { x: 4, y: 4 } });
  await review("section");
  assert.deepEqual(await marked(), [
    ["rewrite", "utilize"],
    ["cut", "kind of "],
    ["flag", "Nobody was allowed to use it."],
    ["rewrite", "leverage"],
  ]);
  await page.keyboard.press("Escape");
  await until(async () => (await page.locator(".cm-kin-mark").count()) === 0, "closed");
});

test("the Kin tab asks for a review too", { timeout: 60_000 }, async () => {
  await page.keyboard.press("Meta+j");
  await pane().waitFor();
  await pane().locator('[data-review="draft"]').click();
  await card().waitFor({ timeout: 20_000 });
  assert.deepEqual(await marked(), EXPECTED);
  await pane().locator("[data-reviewing]").waitFor({ state: "detached" });
  await pane().locator('[data-review="section"]').waitFor();
  await page.mouse.move(1, 1);
  await shot("06-kin-tab-light");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(300);
  await shot("06-kin-tab-dark");
  await page.emulateMedia({ colorScheme: "light" });
  await page.keyboard.press("Meta+j");
  await pane().waitFor({ state: "detached" });
  await focusEditor();
  await page.keyboard.press("Escape");
  await until(async () => (await page.locator(".cm-kin-mark").count()) === 0, "closed");
  assert.equal(disk(), FILE);
});

test("a video of stepping through a review", { timeout: 90_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: app.shots, size: { width: 1280, height: 800 } } });
  const tab = await context.newPage();
  await openApp(tab, app.url, app.output);
  await openDoc(DOC, "We leverage the seam.", tab);
  await tab.locator(".cm-line", { hasText: "Nobody was allowed" }).click({ position: { x: 4, y: 4 } });
  await tab.waitForTimeout(600);
  await tab.keyboard.press("Meta+k");
  await tab.waitForTimeout(500);
  await tab.locator("[data-slot=popover-content]").getByRole("option", { name: "Review this draft" }).click();
  await tab.locator(".ki-step-card").waitFor({ timeout: 20_000 });
  for (let i = 0; i < 5; i++) {
    await tab.waitForTimeout(900);
    await tab.keyboard.press("Meta+Quote");
  }
  await tab.waitForTimeout(900);
  await tab.keyboard.press("Alt+Enter");
  await tab.waitForTimeout(1200);
  await tab.keyboard.press("Escape");
  await tab.waitForTimeout(600);
  await tab.keyboard.press("Meta+z");
  await tab.waitForTimeout(400);
  const video = tab.video();
  await context.close();
  const path = await video!.path();
  assert.ok(existsSync(path));
  writeFileSync(resolve(app.shots, "video-path.txt"), path);
  await until(() => disk() === FILE, "the video's edit is undone");
});
