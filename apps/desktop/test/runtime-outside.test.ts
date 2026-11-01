// KI-49 against the real runtime: `pnpm desktop:headless` (the real Rust
// command registry and vault watcher on Tauri MockRuntime, and the real React
// app) driven by headless Chromium, in a fresh scratch vault and config.
//
// Another app edits a document on disk while it is open here: a clean buffer
// reloads, unsaved edits merge with an edit to other lines, edits to the same
// line ask ("Use the file on disk" / "Keep mine"), and a document deleted or
// moved outside is never written back by a later save. Documents that aren't
// open show up in the tree. Screenshots go to .headless/<run>/shots/.
import assert from "node:assert/strict";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { startApp, type App } from "./headless-app.ts";

const DOC = "notes/outside.md";
const TIMEOUT = Number(process.env.KINTSUGI_RUNTIME_TIMEOUT ?? 15 * 60_000);
const ORIGINAL = `---\ntitle: "Outside"\nstatus: draft\n---\n\n# Outside\n\nThe first line of the body.\n\nA middle paragraph.\n\nThe last line.`;

let app: App;
let browser: Browser;
let page: Page;
// While set, the app's saves wait here: its buffer stays dirty on purpose.
let gate: Promise<void> | null = null;
let release = () => {};

before(async () => {
  app = await startApp("ki49", {}, (vault) => writeFileSync(resolve(vault, DOC), ORIGINAL));
  browser = await chromium.launch({ headless: true }).catch((e) => {
    throw new Error(`${e}\nInstall it with: pnpm --filter @kintsugi/desktop exec playwright install chromium-headless-shell`);
  });
  page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  await page.route("**/invoke", async (route) => {
    const call = route.request().postDataJSON() as { cmd?: string } | null;
    if (call?.cmd === "doc_write" && gate) await gate;
    await route.continue();
  });
  await page.goto(app.url);
}, { timeout: TIMEOUT });

after(async () => {
  release();
  await browser?.close();
  app?.stop();
});

const shot = (name: string) => page.screenshot({ path: resolve(app.shots, `${name}.png`) });
const file = (path = DOC) => resolve(app.vault, path);
const disk = (path = DOC) => readFileSync(file(path), "utf8");
const editor = () => page.locator(".cm-content").innerText();
const hold = () => {
  gate = new Promise<void>((r) => (release = () => { gate = null; r(); }));
};
async function until(check: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await page.waitForTimeout(100);
  }
  assert.fail(`${what}\neditor:\n${await editor().catch(() => "(none)")}\ndisk:\n${existsSync(file()) ? disk() : "(missing)"}`);
}
const asked = () => page.getByRole("dialog", { name: /in another app/ });

async function open(path = DOC) {
  await page.locator(`[title="${path}"]`).click();
  await page.locator(`[title="${path}"][data-active="true"]`).waitFor();
}

/** Types at the end of the document (the last line). */
async function typeAtEnd(text: string) {
  await page.locator(".cm-content").click();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type(text);
}

async function reset() {
  release();
  await open();
  writeFileSync(file(), ORIGINAL);
  await until(async () => (await editor()).includes("The last line.") && !(await editor()).includes("last line. "), "back to the original");
  await until(() => page.getByText("Saved", { exact: true }).isVisible(), "saved");
}

test("a clean buffer reloads another app's edit quietly", { timeout: 60_000 }, async () => {
  await open();
  writeFileSync(file(), ORIGINAL.replace("A middle paragraph.", "A middle paragraph, edited in Obsidian."));
  await until(async () => (await editor()).includes("edited in Obsidian"), "the editor shows the outside edit");
  assert.equal(await asked().count(), 0, "nothing to ask");
  // Nothing was written back over it.
  await page.waitForTimeout(800);
  assert.equal(disk(), ORIGINAL.replace("A middle paragraph.", "A middle paragraph, edited in Obsidian."));
  await shot("clean-reload");
});

test("unsaved edits merge with another app's edit to other lines", { timeout: 60_000 }, async () => {
  await reset();
  hold();
  await typeAtEnd(" Typed in Kintsugi.");
  await page.getByText("Editing", { exact: true }).waitFor();
  writeFileSync(file(), ORIGINAL.replace("The first line of the body.", "The first line, from git."));
  await until(async () => {
    const text = await editor();
    return text.includes("from git") && text.includes("Typed in Kintsugi.");
  }, "the editor merges both edits");
  assert.equal(await asked().count(), 0, "a clean merge doesn't ask");
  release();
  const merged = ORIGINAL.replace("The first line of the body.", "The first line, from git.").replace("The last line.", "The last line. Typed in Kintsugi.");
  await until(() => disk() === merged, "the merge is saved");
  await shot("dirty-merge");
});

test("a save that started before another app's edit is refused, then merged", { timeout: 60_000 }, async () => {
  await reset();
  hold();
  await typeAtEnd(" Saved late.");
  // The save is already on its way with the old version when the file changes.
  await page.waitForTimeout(600);
  const outside = ORIGINAL.replace("# Outside", "# Outside, retitled in iCloud");
  writeFileSync(file(), outside);
  release();
  const merged = outside.replace("The last line.", "The last line. Saved late.");
  await until(() => disk() === merged, "both edits are on disk");
  await until(async () => (await editor()).includes("retitled in iCloud"), "the editor has the outside edit");
});

test("edits to the same line ask, and either answer is honoured", { timeout: 60_000 }, async () => {
  await reset();
  hold();
  await typeAtEnd(" Mine.");
  const theirs = ORIGINAL.replace("The last line.", "The last line. Theirs.");
  writeFileSync(file(), theirs);
  await asked().waitFor();
  await shot("collision");
  release();
  await page.waitForTimeout(800);
  assert.equal(disk(), theirs, "nothing is saved over their edit while asking");
  await asked().getByRole("button", { name: "Keep mine" }).click();
  await until(() => disk() === ORIGINAL.replace("The last line.", "The last line. Mine."), "mine is saved");

  hold();
  await typeAtEnd(" Again.");
  const again = ORIGINAL.replace("The last line.", "The last line. Theirs again.");
  writeFileSync(file(), again);
  await asked().waitFor();
  await asked().getByRole("button", { name: "Use the file on disk" }).click();
  release();
  await until(async () => (await editor()).includes("Theirs again.") && !(await editor()).includes("Again."), "the editor shows the disk");
  await page.waitForTimeout(800);
  assert.equal(disk(), again, "the disk's version stays");
});

test("a document deleted outside is never written back", { timeout: 60_000 }, async () => {
  await reset();
  // Clean: it closes.
  rmSync(file());
  await until(async () => (await page.locator(`[title="${DOC}"]`).count()) === 0, "it leaves the tree");
  await page.getByText("was moved or deleted in another app").waitFor();
  await page.keyboard.press("Meta+s");
  await page.waitForTimeout(800);
  assert.ok(!existsSync(file()), "not resurrected");

  // Dirty: asks, and closing it lets it go.
  writeFileSync(file(), ORIGINAL);
  await page.locator(`[title="${DOC}"]`).waitFor();
  await open();
  hold();
  await typeAtEnd(" Unsaved.");
  rmSync(file());
  await asked().waitFor();
  await shot("deleted-dirty");
  release();
  await page.waitForTimeout(800);
  assert.ok(!existsSync(file()), "the pending save didn't recreate it");
  await asked().getByRole("button", { name: "Close it" }).click();
  await page.waitForTimeout(800);
  assert.ok(!existsSync(file()), "still gone");

  // Dirty again, but this time keep it: saved where it was, on purpose.
  writeFileSync(file(), ORIGINAL);
  await page.locator(`[title="${DOC}"]`).waitFor();
  await open();
  hold();
  await typeAtEnd(" Kept.");
  rmSync(file());
  await asked().waitFor();
  release();
  await asked().getByRole("button", { name: "Keep mine" }).click();
  await until(() => existsSync(file()) && disk() === ORIGINAL.replace("The last line.", "The last line. Kept."), "kept on request");
});

test("a rename outside follows the open document; other documents show up in the tree", { timeout: 60_000 }, async () => {
  await reset();
  renameSync(file(), file("notes/renamed-outside.md"));
  await page.locator(`[title="notes/renamed-outside.md"][data-active="true"]`).waitFor();
  await typeAtEnd(" After the rename.");
  await until(() => existsSync(file("notes/renamed-outside.md")) && disk("notes/renamed-outside.md").endsWith("After the rename."), "saved to the new name");
  assert.ok(!existsSync(file()), "the old name stays gone");

  writeFileSync(file("notes/written-elsewhere.md"), "---\ntitle: Written elsewhere\n---\n\nFrom another editor.\n");
  await page.locator('[title="notes/written-elsewhere.md"]').waitFor();
  await shot("tree");
});
