// KI-13 against the real runtime: `pnpm desktop:headless` (the real Rust
// command registry on Tauri MockRuntime, and the real React app) driven by
// headless Chromium, in a fresh scratch vault and config.
//
// Renaming a document offers to rewrite the [[links]] that pointed at it
// ("Update N links in M notes?"). Update writes every other note
// version-checked (one changed on disk since the prompt is skipped and
// reported) and changes the open document through the editor, keeping what
// was typed meanwhile; Undo restores them all. The blog mirror is never
// touched, and "Not now" writes nothing. Screenshots go to .headless/<run>/shots/.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { startApp, type App } from "./headless-app.ts";

const TIMEOUT = Number(process.env.KINTSUGI_RUNTIME_TIMEOUT ?? 15 * 60_000);
const OPEN = "posts/on-craft.mdx";
const WELCOME = "welcome.mdx";
const STALE = "drafts/kintsugi-and-gold.md";
const MIRROR = "hussain.ph/a-post.md";
const MIRRORED = "---\ntitle: A post\nstatus: published\nmirror: hussain.ph\n---\n\nAbout [[repair]] and [[notes/repair]].\n";

let app: App;
let browser: Browser;
let page: Page;

before(async () => {
  app = await startApp("ki13", {}, (vault) => {
    mkdirSync(resolve(vault, "hussain.ph"));
    writeFileSync(resolve(vault, MIRROR), MIRRORED);
  });
  browser = await chromium.launch({ headless: true }).catch((e) => {
    throw new Error(`${e}\nInstall it with: pnpm --filter @kintsugi/desktop exec playwright install chromium-headless-shell`);
  });
  page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  await page.goto(app.url);
}, { timeout: TIMEOUT });

after(async () => {
  await browser?.close();
  app?.stop();
});

const shot = (name: string) => page.screenshot({ path: resolve(app.shots, `${name}.png`) });
const disk = (path: string) => readFileSync(resolve(app.vault, path), "utf8");
const toast = (text: string | RegExp) => page.locator("[data-sonner-toast]").filter({ hasText: text });
async function until(check: () => boolean, what: string, path: string) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await page.waitForTimeout(100);
  }
  assert.fail(`${what}; ${path} is:\n${disk(path)}`);
}

/** F2 on the focused row: a click would open the document and blur the field. */
async function rename(row: ReturnType<Page["locator"]>, name: string) {
  await row.focus();
  await row.press("F2");
  const input = page.locator("[data-sidebar=sidebar] input");
  await input.waitFor();
  await input.fill(name);
  await input.press("Enter");
  await input.waitFor({ state: "detached" });
}
const row = (path: string) => page.locator(`[title="${path}"]`);
const folder = (name: string) => page.locator("[data-sidebar=sidebar]").getByRole("button", { name, exact: true });

test("rename → prompt → update (skipping a stale note) → undo", { timeout: TIMEOUT }, async () => {
  await page.locator(`[title="${OPEN}"]`).click();
  await page.locator(`[title="${OPEN}"][data-active="true"]`).waitFor();
  const stale = disk(STALE);
  assert.ok(stale.includes("[[repair]]"));

  await rename(row("notes/repair.md"), "mending");
  await page.locator('[title="notes/mending.md"]').waitFor();
  const prompt = toast("Update 3 links in 3 notes?");
  await prompt.waitFor();
  await shot("01-prompt");
  // Nothing is rewritten before he says so.
  assert.ok(disk(WELCOME).includes("[[notes/repair]]"));

  // Meanwhile: another app edits one note, and he keeps typing in the open one.
  const edited = stale.replace("history; the note", "history (edited elsewhere); the note");
  writeFileSync(resolve(app.vault, STALE), edited);
  await page.locator(".cm-content").click();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type(" Typed meanwhile.");

  await prompt.getByRole("button", { name: "Update" }).click();
  const done = toast("Updated 2 links in 2 notes.");
  await done.waitFor();
  await done.getByText(`Skipped ${STALE} (changed since)`).waitFor();
  await prompt.waitFor({ state: "detached" });
  await shot("02-updated-with-a-skipped-note");

  assert.ok(disk(WELCOME).includes("Link with wikilinks: [[notes/mending]],"));
  // The open document changed through the editor, and saved with the typing.
  await until(() => disk(OPEN).includes("[[notes/mending]]") && disk(OPEN).includes("Typed meanwhile."), "the open document saved", OPEN);
  // Changed since it was read: never overwritten.
  assert.equal(disk(STALE), edited);
  assert.equal(disk(MIRROR), MIRRORED);

  await done.getByRole("button", { name: "Undo" }).click();
  await toast("Restored 2 links in 2 notes.").waitFor();
  await done.waitFor({ state: "detached" });
  await shot("03-undone");
  assert.ok(disk(WELCOME).includes("Link with wikilinks: [[notes/repair]],"));
  await until(() => disk(OPEN).includes("before in [[notes/repair]]") && disk(OPEN).includes("Typed meanwhile."), "the open document restored", OPEN);
  assert.equal(disk(STALE), edited);
  assert.equal(disk(MIRROR), MIRRORED);
});

test("a folder rename offers path links only, and Not now writes nothing", { timeout: TIMEOUT }, async () => {
  const welcome = disk(WELCOME);
  const drafts = disk(STALE);
  await rename(folder("posts"), "essays");
  await page.locator('[title="essays/on-craft.mdx"]').waitFor();
  // [[posts/on-craft]] in welcome and drafts, [[posts/the-quiet-web]] in
  // welcome; bare names like [[on-craft]] still resolve and are left alone.
  const prompt = toast(/Update \d+ links in \d+ notes\?/);
  await prompt.waitFor();
  await shot("04-folder-prompt");
  await prompt.getByRole("button", { name: "Not now" }).click();
  await prompt.waitFor({ state: "hidden" });
  await page.waitForTimeout(500);
  assert.equal(disk(WELCOME), welcome);
  assert.equal(disk(STALE), drafts);
  assert.equal(disk(MIRROR), MIRRORED);
});
