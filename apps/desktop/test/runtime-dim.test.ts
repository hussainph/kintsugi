// KI-88 against the real runtime: `pnpm desktop:headless` (the real Rust
// command registry on Tauri MockRuntime, and the real React app) driven by
// headless Chromium, on a fresh scratch vault and config.
//
// ⌘/ dims the cursor's line as a comment in the file's own syntax (`<!-- -->`
// in .md, `{/* */}` in .mdx) and undims it; undo goes both ways; the markers
// are hidden and the text stays; dimmed text leaves the word count; ⌘K
// offers Dim too. Screenshots, light and dark, go to .headless/<run>/shots/.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { startApp, type App, openApp } from "./headless-app.ts";

const MD = "drafts/dim-me.md";
const MDX = "drafts/dim-me-too.mdx";
const TIMEOUT = Number(process.env.KINTSUGI_RUNTIME_TIMEOUT ?? 15 * 60_000);

let app: App;
let browser: Browser;
let page: Page;

before(async () => {
  app = await startApp("ki88", { KINTSUGI_HEADLESS_KIN: "mock" }, (vault) => {
    writeFileSync(resolve(vault, MD), `---\ntitle: "Dim me"\nstatus: draft\n---\n\nThe first paragraph stays as it is.\n\nThe second paragraph is the one to set aside for now.\n\nThe third paragraph has %%an Obsidian aside%% in it.\n`);
    writeFileSync(resolve(vault, MDX), `---\ntitle: "Dim me too"\nstatus: draft\n---\n\nAn MDX paragraph to dim.\n\nAnother one that stays.\n`);
  });
  browser = await chromium.launch({ headless: true }).catch((e) => {
    throw new Error(`${e}\nInstall it with: pnpm --filter @kintsugi/desktop exec playwright install chromium-headless-shell`);
  });
  page = await browser.newPage({ viewport: { width: 1180, height: 760 } });
  await openApp(page, app.url, app.output);
}, { timeout: TIMEOUT });

after(async () => {
  await browser?.close();
  await app?.stop();
});

const shot = (name: string) => page.screenshot({ path: resolve(app.shots, `${name}.png`) });
const read = (path: string) => readFileSync(resolve(app.vault, path), "utf8");
async function onDisk(path: string, check: (text: string) => boolean, what: string) {
  for (let i = 0; i < 100; i++) {
    if (check(read(path))) return;
    await page.waitForTimeout(100);
  }
  assert.fail(`${what}; the file is:\n${read(path)}`);
}
const line = (text: string) => page.locator(".cm-line", { hasText: text }).first();
const words = () => page.locator(".ki-document-bar-words").innerText();
async function open(path: string) {
  await page.locator(`[title="${path}"]`).click();
  await page.locator(`[title="${path}"][data-active="true"]`).waitFor();
}

test("⌘/ dims the cursor's line as an HTML comment in .md, hides the markers and drops it from the word count", { timeout: 120_000 }, async () => {
  await open(MD);
  // Obsidian's comment is dimmed too, without its markers.
  await line("The third paragraph").locator(".cm-dimmed", { hasText: "an Obsidian aside" }).waitFor();
  assert.ok(!(await line("The third paragraph").innerText()).includes("%%"));
  const before = Number((await words()).split(" ")[0]);

  await line("The second paragraph").click();
  await page.keyboard.press("Meta+/");
  await onDisk(MD, (t) => t.includes("\n<!-- The second paragraph is the one to set aside for now. -->\n"), "the line is written as an HTML comment");
  await line("The second paragraph").locator(".cm-dimmed").waitFor();
  const shown = await line("The second paragraph").innerText();
  assert.ok(!shown.includes("<!--") && !shown.includes("-->"), `markers are hidden: ${shown}`);
  assert.equal(Number((await words()).split(" ")[0]), before - 11, "dimmed words don't count");
  const opacity = await line("The second paragraph").locator(".cm-dimmed").first().evaluate((el) => getComputedStyle(el).opacity);
  assert.ok(Number(opacity) < 1 && Number(opacity) > 0.3, `faded, still legible: ${opacity}`);

  // Light and dark, with a selection over part of it.
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(300);
    await shot(`${scheme}-dimmed-selected`);
  }
  await page.emulateMedia({ colorScheme: "light" });
  await line("The first paragraph").click();
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(300);
    await shot(`${scheme}-dimmed`);
  }
  await page.emulateMedia({ colorScheme: "light" });
});

test("⌘/ inside dimmed text undims it; undo and redo go both ways", { timeout: 60_000 }, async () => {
  await line("The second paragraph").click();
  await page.keyboard.press("Meta+/");
  await onDisk(MD, (t) => t.includes("\nThe second paragraph is the one to set aside for now.\n") && !t.includes("<!--"), "undimmed");
  assert.equal(await line("The second paragraph").locator(".cm-dimmed").count(), 0);
  await page.keyboard.press("Meta+z");
  await onDisk(MD, (t) => t.includes("<!-- The second paragraph is the one to set aside for now. -->"), "undo dims it again");
  await page.keyboard.press("Meta+z");
  await onDisk(MD, (t) => !t.includes("<!--"), "undo again undims it");
  await page.keyboard.press("Meta+Shift+z");
  await onDisk(MD, (t) => t.includes("<!-- The second paragraph is the one to set aside for now. -->"), "redo dims it");
});

test("in .mdx, ⌘/ writes {/* */}; ⌘K offers Dim and Undim", { timeout: 60_000 }, async () => {
  await open(MDX);
  await line("An MDX paragraph").click();
  await page.keyboard.press("Meta+/");
  await onDisk(MDX, (t) => t.includes("\n{/* An MDX paragraph to dim. */}\n"), "the line is written as an MDX comment");
  await line("An MDX paragraph").locator(".cm-dimmed").waitFor();
  assert.ok(!(await line("An MDX paragraph").innerText()).includes("{/*"));

  await line("An MDX paragraph").click();
  await page.keyboard.press("Meta+k");
  const popup = page.locator("[data-slot=popover-content]");
  await popup.getByRole("option", { name: /^Undim/ }).click();
  await onDisk(MDX, (t) => t.includes("\nAn MDX paragraph to dim.\n") && !t.includes("{/*"), "⌘K undims");

  await line("Another one that stays").click();
  await page.keyboard.press("Meta+k");
  await popup.getByRole("option", { name: /^Dim/ }).waitFor();
  await shot("light-cmdk-dim");
  await popup.getByRole("option", { name: /^Dim/ }).click();
  await onDisk(MDX, (t) => t.includes("\n{/* Another one that stays. */}\n"), "⌘K dims");
});
