// KI-85 against the real runtime with Kin's scripted model
// (`KINTSUGI_HEADLESS_KIN=mock`): the shortcuts list (⇧⌘/ and the keyboard
// button), the selection menu (right-click and ⇧F10), ⌘K's edits on their
// own keys, and the keys shown in ⌘K's and the / menu's rows. Screenshots go
// to .headless/<run>/shots/ (light, or dark with KINTSUGI_COLOR_SCHEME=dark).
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { openApp, startApp, type App } from "./headless-app.ts";

const TIMEOUT = Number(process.env.KINTSUGI_RUNTIME_TIMEOUT ?? 15 * 60_000);
const SCHEME = process.env.KINTSUGI_COLOR_SCHEME === "dark" ? "dark" : "light";
const DOC = "drafts/keys.md";

let app: App;
let browser: Browser;
let page: Page;

before(async () => {
  app = await startApp("ki85", { KINTSUGI_HEADLESS_KIN: "mock" }, (vault) => {
    writeFileSync(resolve(vault, DOC), `---\ntitle: "Keys"\nstatus: draft\n---\n\n# Keys\n\nThe repair is really very visible, and that is the point.\n\nKeep the seam where it broke.\n`);
  });
  browser = await chromium.launch({ headless: true }).catch((e) => {
    throw new Error(`${e}\nInstall it with: pnpm --filter @kintsugi/desktop exec playwright install chromium-headless-shell`);
  });
  page = await browser.newPage({ viewport: { width: 1280, height: 820 }, colorScheme: SCHEME });
  await openApp(page, app.url, app.output);
  await page.locator(`[title="${DOC}"]`).click();
  await page.locator(`[title="${DOC}"][data-active="true"]`).waitFor();
}, { timeout: TIMEOUT });

after(async () => {
  await browser?.close();
  await app?.stop();
});

// After the open animation.
const shot = async (name: string) => (await page.waitForTimeout(400), page.screenshot({ path: resolve(app.shots, `${SCHEME}-${name}.png`) }));
const disk = () => readFileSync(resolve(app.vault, DOC), "utf8");
async function onDisk(check: (text: string) => boolean, what: string) {
  for (let i = 0; i < 100; i++) {
    if (check(disk())) return;
    await page.waitForTimeout(100);
  }
  assert.fail(`${what}; the file is:\n${disk()}`);
}
const line = (text: string) => page.locator(".cm-line", { hasText: text });
const cheatsheet = () => page.getByRole("dialog", { name: "Keyboard shortcuts" });
const menu = () => page.getByRole("menu", { name: "Selection" });
const refine = () => page.locator("[data-slot=popover-content]");
/** Selects `word` in the editor by double-clicking it. */
async function select(word: string) {
  await line(word).getByText(word, { exact: false }).first().waitFor();
  const box = await page.evaluate((word) => {
    for (const el of document.querySelectorAll(".cm-line")) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node: Node | null = null;
      while (walker.nextNode()) if (walker.currentNode.textContent!.includes(word)) { node = walker.currentNode; break; }
      if (!node) continue;
      const range = document.createRange();
      const at = node.textContent!.indexOf(word);
      range.setStart(node, at);
      range.setEnd(node, at + word.length);
      const r = range.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    return null;
  }, word);
  assert.ok(box, word);
  await page.mouse.dblclick(box.x, box.y);
  return box;
}

test("⇧⌘/ and the keyboard button list every shortcut, filtered by typing", { timeout: 60_000 }, async () => {
  await line("Keep the seam").click();
  await page.keyboard.press("Meta+Shift+Slash");
  await cheatsheet().waitFor();
  for (const heading of ["App", "Document", "Kin", "Formatting", "Text", "Reviewing an edit", "Sidebar", "Settings"]) {
    await cheatsheet().getByRole("heading", { name: heading, exact: true }).waitFor();
  }
  await cheatsheet().getByText("⌥⌘T").waitFor();
  await cheatsheet().getByText("⌥⌘1–6").waitFor();
  await shot("01-cheatsheet");
  await page.keyboard.type("tight");
  await cheatsheet().getByText("Tighten").waitFor();
  assert.equal(await cheatsheet().getByText("Bold", { exact: true }).count(), 0, "filtered");
  await shot("02-cheatsheet-filtered");
  await page.keyboard.type("zzz");
  await cheatsheet().getByText("No shortcuts match.").waitFor();
  await page.keyboard.press("Escape");
  await cheatsheet().waitFor({ state: "detached" });

  await page.getByRole("button", { name: "Keyboard shortcuts" }).click();
  await cheatsheet().waitFor();
  assert.equal(await cheatsheet().getByRole("textbox").inputValue(), "", "opens unfiltered");
  await page.keyboard.press("Meta+Shift+Slash");
  await cheatsheet().waitFor({ state: "detached" });
});

test("right-click on a selection shows what applies to it, each with its key", { timeout: 60_000 }, async () => {
  // Nothing selected: the Mac's own menu, not ours.
  await line("Keep the seam").click({ button: "right" });
  await page.waitForTimeout(200);
  assert.equal(await menu().count(), 0);

  const at = await select("visible");
  await page.mouse.click(at.x, at.y, { button: "right" });
  await menu().waitFor();
  const rows = await menu().getByRole("menuitem").evaluateAll((items) => items.map((item) => item.textContent?.trim()));
  assert.deepEqual(rows, [
    "Tighten⌥⌘T", "Rephrase⌥⌘R", "Simplify⌥⌘P", "Fix grammar and spelling⌥⌘F", "Synonyms⌥⌘S",
    "Dim⌘/", "Alternatives…⌥⌘A", "Edit with Kin…⌘K", "Ask Kin⌘J", "Cut⌘X", "Copy⌘C",
  ]);
  await shot("03-selection-menu");
  await page.keyboard.press("Escape");
  await menu().waitFor({ state: "detached" });
  // The selection and focus are back in the editor.
  assert.equal(await page.evaluate(() => getSelection()?.toString()), "visible");
  assert.ok(await page.evaluate(() => document.activeElement?.classList.contains("cm-content")));
});

test("Dim in the menu dims the selection, and the menu then offers Undim", { timeout: 60_000 }, async () => {
  const at = await select("seam");
  await page.mouse.click(at.x, at.y, { button: "right" });
  await menu().getByRole("menuitem", { name: /^Dim/ }).click();
  await onDisk((t) => t.includes("Keep the <!-- seam --> where"), "the selection is dimmed");
  const again = await select("seam");
  await page.mouse.click(again.x, again.y, { button: "right" });
  await menu().getByRole("menuitem", { name: /^Undim/ }).waitFor();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+z");
  await onDisk((t) => t.includes("Keep the seam where"), "undo takes the dim back out");
});

test("⇧F10 opens it from the keyboard; a row runs its edit", { timeout: 60_000 }, async () => {
  await select("repair");
  await page.keyboard.press("Shift+F10");
  await menu().waitFor();
  // The first row has focus; ↓ and ↑ move, ↩ runs it.
  await menu().getByRole("menuitem", { name: /Tighten/ }).and(page.locator(":focus")).waitFor();
  await page.keyboard.press("ArrowDown");
  await menu().getByRole("menuitem", { name: /Rephrase/ }).and(page.locator(":focus")).waitFor();
  await page.keyboard.press("ArrowUp");
  await menu().getByRole("menuitem", { name: /Tighten/ }).and(page.locator(":focus")).waitFor();
  await page.keyboard.press("Enter");
  await menu().waitFor({ state: "detached" });
  await refine().getByText("Tighten").first().waitFor();
  await refine().getByText("Thinking…").waitFor({ state: "detached", timeout: 15_000 });
  await page.keyboard.press("Escape");
  await refine().waitFor({ state: "detached" });
});

test("⌥⌘T tightens the paragraph without ⌘K's list; ↩ accepts", { timeout: 60_000 }, async () => {
  await line("The repair is").click();
  await page.keyboard.press("Meta+Alt+t");
  await refine().getByText("Tighten").first().waitFor();
  await refine().locator(".ki-diff-removed").first().waitFor({ timeout: 15_000 });
  await shot("04-direct-tighten");
  await page.keyboard.press("Enter");
  await onDisk((t) => !/really very/.test(t) && /The repair is visible/.test(t), "the tightened paragraph is saved");

  // Synonyms want a word or a phrase.
  await line("The repair is").click();
  await page.keyboard.press("Meta+Alt+s");
  await page.getByText("Select 4 words or fewer for synonyms.").waitFor();
  assert.equal(await refine().count(), 0);
});

test("⌘K's and the / menu's rows show their keys", { timeout: 60_000 }, async () => {
  await line("Keep the seam").click();
  await page.keyboard.press("Meta+k");
  const tighten = refine().getByRole("option", { name: /Tighten/ });
  await tighten.waitFor();
  assert.equal((await tighten.locator("[data-slot=command-shortcut]").textContent())?.trim(), "⌥⌘T");
  await shot("05-cmdk-keys");
  await page.keyboard.press("Escape");
  await refine().waitFor({ state: "detached" });

  await line("Keep the seam").click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/");
  const slash = page.locator(".cm-command-menu");
  await slash.waitFor();
  assert.equal((await slash.locator('[data-command="h2"] .cm-kintsugi-menu-key').textContent())?.trim(), "⌥⌘2");
  assert.equal((await slash.locator('[data-command="bullets"] .cm-kintsugi-menu-key').textContent())?.trim(), "⇧⌘8");
  await shot("06-slash-keys");
  await page.keyboard.press("Escape");
});
