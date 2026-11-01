// KI-29 against the real runtime: `pnpm desktop:headless` (the real Rust
// command registry on Tauri MockRuntime, and the real React app) driven by
// headless Chromium, in a fresh scratch vault and config.
//
// Tags on a document: add (typed and suggested), remove, and what lands in
// the frontmatter (an Obsidian block list is rewritten inline); the sidebar's
// tag filter; and `#tag` in the ⌘P jump list. Screenshots go to
// .headless/<run>/shots/.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { startApp, type App } from "./headless-app.ts";

const DOC = "drafts/kiln-notes.md";
const TIMEOUT = Number(process.env.KINTSUGI_RUNTIME_TIMEOUT ?? 15 * 60_000);

let app: App;
let browser: Browser;
let page: Page;

before(async () => {
  app = await startApp("ki29", {}, (vault) => {
    // Obsidian's block list, which the tree and the editor both read.
    writeFileSync(
      resolve(vault, DOC),
      `---\ntitle: "Kiln notes"\nstatus: draft\ntags:\n  - Craft\n  - fire\n---\n\n# Kiln notes\n\nThe glaze only shows its colour after the fire.\n`,
    );
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
const disk = () => readFileSync(resolve(app.vault, DOC), "utf8");
async function onDisk(check: (text: string) => boolean, what: string) {
  for (let i = 0; i < 100; i++) {
    if (check(disk())) return;
    await page.waitForTimeout(100);
  }
  assert.fail(`${what}; the file is:\n${disk()}`);
}
const sidebar = () => page.locator("[data-sidebar=sidebar]");
const tags = () => page.getByLabel("Tags", { exact: true });
const palette = () => page.getByRole("dialog");

async function jump(query: string) {
  await page.keyboard.press("Meta+p");
  await palette().getByRole("combobox").fill(query);
}

test("adds and removes tags on the open document", { timeout: TIMEOUT }, async () => {
  await sidebar().getByRole("button", { name: "Kiln notes" }).click();
  await page.locator(".cm-content").waitFor();
  await tags().getByText("#craft").waitFor();
  await tags().getByText("#fire").waitFor();

  await tags().getByRole("button", { name: "Add a tag" }).click();
  const input = page.getByPlaceholder("Add a tag…");
  // Typed, normalized: "#Glaze " is the tag "glaze".
  await input.fill("#Glaze ");
  await page.keyboard.press("Enter");
  await onDisk((t) => t.includes("tags: [craft, fire, glaze]\n"), "the typed tag is saved inline");
  assert.ok(!disk().includes("  - Craft"), "the block list was replaced");
  // Suggested from tags in use elsewhere in the vault.
  await input.fill("atten");
  await page.getByRole("option", { name: "#attention", exact: true }).click();
  await onDisk((t) => t.includes("tags: [craft, fire, glaze, attention]\n"), "the suggested tag is saved");
  await shot("01-adding-a-tag");
  await page.keyboard.press("Escape");

  await tags().getByRole("button", { name: "Remove tag fire" }).click();
  await onDisk((t) => t.includes("tags: [craft, glaze, attention]\n"), "the removed tag is gone");
  assert.match(disk(), /^---\ntitle: "Kiln notes"\nstatus: draft\ntags: \[craft, glaze, attention\]\n---\n\n# Kiln notes\n/);
  await shot("02-document-tags");
});

test("the sidebar filters the tree by tag", { timeout: TIMEOUT }, async () => {
  await sidebar().getByRole("button", { name: "Filter by tag" }).click();
  // The tree reloads with the new tags once the save lands.
  await page.getByRole("option", { name: /#glaze/ }).waitFor();
  await page.getByRole("option", { name: /#attention/ }).click();
  await page.keyboard.press("Escape");
  const tree = sidebar();
  await tree.getByRole("button", { name: "Stop filtering by attention" }).waitFor();
  for (const title of ["Kiln notes", "Repair is a kind of attention", "Attention has a cost", "The quiet web"]) {
    await tree.getByRole("button", { name: new RegExp(`^${title}`) }).waitFor();
  }
  assert.equal(await tree.getByRole("button", { name: "On craft and repair" }).count(), 0);
  assert.equal(await tree.getByRole("button", { name: "Start here" }).count(), 0);
  await shot("03-sidebar-filter");

  // Several tags narrow further (AND).
  await tree.getByRole("button", { name: "Filter by tag" }).click();
  await page.getByRole("option", { name: /#repair/ }).click();
  await page.keyboard.press("Escape");
  await tree.getByRole("button", { name: "Repair is a kind of attention" }).waitFor();
  assert.equal(await tree.getByRole("button", { name: "Kiln notes" }).count(), 0);

  await tree.getByRole("button", { name: "Stop filtering by attention" }).click();
  await tree.getByRole("button", { name: "Stop filtering by repair" }).click();
  await tree.getByRole("button", { name: "On craft and repair" }).waitFor();
});

test("⌘P filters by #tag and suggests tags", { timeout: TIMEOUT }, async () => {
  await jump("#cr");
  await palette().getByRole("option", { name: "#craft", exact: true }).waitFor();
  await shot("04-jump-tag-suggestions");
  await palette().getByRole("option", { name: "#craft", exact: true }).click();
  assert.equal(await palette().getByRole("combobox").inputValue(), "#craft ");
  const options = palette().getByRole("option");
  await palette().getByRole("option", { name: /Kiln notes/ }).waitFor();
  await palette().getByRole("option", { name: /On craft and repair/ }).waitFor();
  const names = await options.allInnerTexts();
  assert.equal(names.length, 2, names.join(" | "));
  assert.ok(names.some((n) => n.includes("On craft and repair")));

  // Words after the tag still match titles.
  await palette().getByRole("combobox").fill("#craft kiln");
  // Kiln notes was already listed: wait for the other one to go, or the
  // count can read the list from before the filter (KI-47).
  await palette().getByRole("option", { name: /On craft and repair/ }).waitFor({ state: "detached" });
  await palette().getByRole("option", { name: /Kiln notes/ }).waitFor();
  assert.equal(await options.count(), 1);
  await shot("05-jump-tag-filter");
  await page.keyboard.press("Enter");
  await palette().waitFor({ state: "hidden" });
  await tags().getByText("#glaze").waitFor();
});
