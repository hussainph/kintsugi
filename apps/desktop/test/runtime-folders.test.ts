// KI-75 against the real runtime: `pnpm desktop:headless` (the real Rust
// command registry on Tauri MockRuntime, and the real React app) driven by
// headless Chromium, in a fresh scratch vault and config.
//
// The vault tree after Dia's sidebar: an open folder's first row sits right
// under it (no gap), each level of nesting steps in, folders are created from
// the sidebar, take a colour and an icon kept in `.kintsugi/folders.json`
// (which follow a rename), documents move by drag and drop or Move to, and a
// closed folder stays closed after a reload. Screenshots go to .headless/<run>/shots/.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { startApp, type App } from "./headless-app.ts";

const TIMEOUT = Number(process.env.KINTSUGI_RUNTIME_TIMEOUT ?? 15 * 60_000);
const DEEP = "notes/research/sources/2026";

let app: App;
let browser: Browser;
let page: Page;

before(async () => {
  app = await startApp("ki75", {}, (vault) => {
    mkdirSync(resolve(vault, DEEP), { recursive: true });
    writeFileSync(resolve(vault, `${DEEP}/january.mdx`), "---\ntitle: January\nstatus: draft\n---\n\nJan.\n");
  });
  browser = await chromium.launch({ headless: true }).catch((e) => {
    throw new Error(`${e}\nInstall it with: pnpm --filter @kintsugi/desktop exec playwright install chromium-headless-shell`);
  });
  page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  await page.goto(app.url);
}, { timeout: TIMEOUT });

after(async () => {
  await browser?.close();
  await app?.stop();
});

const shot = (name: string) => page.screenshot({ path: resolve(app.shots, `${name}.png`) });
const nav = () => page.locator("[data-sidebar=sidebar]");
const folder = (name: string) => nav().getByRole("button", { name, exact: true });
const row = (path: string) => nav().locator(`[title="${path}"]`);
const styles = () => {
  const file = resolve(app.vault, ".kintsugi/folders.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).folders : {};
};
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await page.waitForTimeout(100);
  }
  assert.fail(what);
}
async function menu(target: ReturnType<Page["locator"]>, ...path: string[]) {
  await target.click({ button: "right" });
  for (const name of path.slice(0, -1)) await page.getByRole("menuitem", { name, exact: true }).hover();
  const name = path.at(-1)!;
  await page.getByRole("menuitemradio", { name, exact: true }).or(page.getByRole("menuitem", { name, exact: true })).click();
}

test("open folders hug their contents, and nesting steps in", { timeout: TIMEOUT }, async () => {
  await folder("inbox").waitFor();
  const inbox = (await folder("inbox").boundingBox())!;
  const first = (await row("inbox/morning-pages.mdx").boundingBox())!;
  const gap = first.y - (inbox.y + inbox.height);
  assert.ok(gap >= 0 && gap < 6, `the first row sits under its folder (gap ${gap}px)`);
  // Each level indents further than the one around it.
  const xs = [];
  for (const name of ["notes", "research", "sources", "2026"]) xs.push((await folder(name).boundingBox())!.x);
  xs.push((await row(`${DEEP}/january.mdx`).boundingBox())!.x);
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] > xs[i - 1] + 4, `level ${i} steps in (${xs})`);
  // Still readable four levels down: the deepest title has room.
  assert.ok((await row(`${DEEP}/january.mdx`).boundingBox())!.width > 150);
  await shot("01-tree");
});

test("a folder is created from the sidebar", { timeout: TIMEOUT }, async () => {
  await folder("posts").click(); // New items go to the selected folder.
  await nav().getByRole("button", { name: "New folder", exact: true }).click();
  const input = page.getByRole("dialog").getByRole("combobox");
  await input.fill("Essays");
  await page.getByRole("dialog").getByRole("option", { name: /Create/ }).click();
  await folder("essays").waitFor();
  assert.ok(existsSync(resolve(app.vault, "posts/essays")));
});

test("a colour and an icon are kept in the vault and follow a rename", { timeout: TIMEOUT }, async () => {
  await menu(folder("drafts"), "Colour", "Amber");
  await until(() => styles().drafts?.color === "amber", "the colour is saved");
  await menu(folder("drafts"), "Icon", "Pen");
  await until(() => styles().drafts?.icon === "pen", "the icon is saved");
  assert.equal(await folder("drafts").locator(".ki-folder-glyph").getAttribute("data-color"), "amber");
  await shot("02-coloured");

  await folder("drafts").focus();
  await folder("drafts").press("F2");
  const input = nav().locator("input");
  await input.fill("working");
  await input.press("Enter");
  await folder("working").waitFor();
  await until(() => styles().working?.color === "amber" && !styles().drafts, "the style follows the rename");
});

test("documents move by Move to and by drag and drop", { timeout: TIMEOUT }, async () => {
  await menu(row("inbox/morning-pages.mdx"), "Move to", "notes");
  await row("notes/morning-pages.mdx").waitFor();
  assert.ok(existsSync(resolve(app.vault, "notes/morning-pages.mdx")));

  await row("notes/morning-pages.mdx").dragTo(folder("2026"));
  await row(`${DEEP}/morning-pages.mdx`).waitFor();
  assert.ok(existsSync(resolve(app.vault, `${DEEP}/morning-pages.mdx`)));
  assert.ok(!existsSync(resolve(app.vault, "notes/morning-pages.mdx")));
});

test("a closed folder stays closed after a reload", { timeout: TIMEOUT }, async () => {
  await folder("posts").click();
  await row("posts/on-craft.mdx").waitFor({ state: "hidden" });
  await page.reload();
  await folder("posts").waitFor();
  assert.equal(await folder("posts").getAttribute("aria-expanded"), "false");
  assert.equal(await row("posts/on-craft.mdx").count(), 0);
});
