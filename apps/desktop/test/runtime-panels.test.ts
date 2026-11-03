// KI-56 and KI-67 against the real runtime: `pnpm desktop:headless` (the real
// Rust command registry on Tauri MockRuntime, and the real React app) driven
// by headless Chromium, in a fresh scratch vault and config.
//
// The reference margin is his choice: moving the cursor between paragraphs
// never opens or closes it, and it stays as he left it across documents and
// reloads. The left sidebar collapses to an icon rail (⌘\ or its trigger) and
// stays collapsed after a reload; its footer is one row. Screenshots go to
// .headless/<run>/shots/.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { startApp, type App } from "./headless-app.ts";

const TIMEOUT = Number(process.env.KINTSUGI_RUNTIME_TIMEOUT ?? 15 * 60_000);
const DRAFT = "drafts/friction.md";
// The first paragraph shares words with the seeded notes; the second shares none.
const TEXT = `---\ntitle: "Friction"\nstatus: draft\n---\n\n# Friction\n\nRepair is a kind of attention, and kintsugi makes the repair visible.\n\nZzq blorp vrenk.\n`;

let app: App;
let browser: Browser;
let page: Page;

before(async () => {
  app = await startApp("ki56", {}, (vault) => writeFileSync(resolve(vault, DRAFT), TEXT));
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
const sidebar = () => page.locator("[data-slot=sidebar]").first();
const nav = () => page.locator("[data-sidebar=sidebar]").first();
const margin = () => page.getByRole("complementary", { name: "Reference margin" });
const line = (text: string) => page.locator(".cm-line", { hasText: text });
const editorWidth = async () => (await page.locator(".cm-editor").boundingBox())!.width;

async function openDoc(title: string) {
  await nav().getByRole("button", { name: new RegExp(`^${title}`) }).click();
  await page.locator(".cm-line", { hasText: `# ${title}` }).waitFor();
}

/** Clicks into a paragraph and gives the margin's search time to settle. */
async function cursorIn(text: string) {
  await line(text).click();
  await page.waitForTimeout(600);
}

test("the margin stays open, then closed, as the cursor moves between paragraphs", { timeout: 120_000 }, async () => {
  await openDoc("Friction");
  await cursorIn("kintsugi makes the repair");
  await margin().getByRole("heading", { name: "Along this paragraph" }).waitFor();
  const width = await editorWidth();
  await shot("01-margin-related");

  // A paragraph with nothing related: the margin stays, with one line.
  await cursorIn("Zzq blorp");
  assert.ok(await margin().isVisible(), "the margin is still open");
  await margin().getByText("Nothing related to this paragraph").waitFor();
  assert.equal(await editorWidth(), width, "the editor keeps its width");
  // Typing in it doesn't move anything either.
  await page.keyboard.type(" qwv");
  await page.waitForTimeout(400);
  assert.ok(await margin().isVisible());
  assert.equal(await editorWidth(), width);
  await shot("02-margin-empty");

  await cursorIn("kintsugi makes the repair");
  assert.ok(await margin().isVisible());

  // Closed by him, it stays closed wherever the cursor goes.
  await page.getByRole("button", { name: "Hide reference margin" }).click();
  await margin().waitFor({ state: "detached" });
  const closed = await editorWidth();
  for (const text of ["Zzq blorp", "kintsugi makes the repair", "Zzq blorp"]) {
    await cursorIn(text);
    assert.equal(await margin().count(), 0, `closed in "${text}"`);
    assert.equal(await editorWidth(), closed);
  }

  // Across documents and a reload.
  await openDoc("Repair is a kind of attention");
  await page.waitForTimeout(400);
  assert.equal(await margin().count(), 0, "still closed in another document");
  await page.reload();
  await openDoc("Friction");
  await cursorIn("kintsugi makes the repair");
  assert.equal(await margin().count(), 0, "still closed after a reload");

  // And open again the same way.
  await page.getByRole("button", { name: "Show reference margin" }).click();
  await margin().waitFor();
  await page.reload();
  await openDoc("Friction");
  await cursorIn("Zzq blorp");
  await margin().waitFor();
});

test("the sidebar collapses to an icon rail and stays collapsed", { timeout: 120_000 }, async () => {
  assert.equal(await sidebar().getAttribute("data-state"), "expanded");
  // The footer is one row: Settings with its label, then phone and About you as icons.
  const footer = page.locator("[data-sidebar=footer]");
  const settingsRow = footer.getByRole("button", { name: "Settings" });
  const phoneButton = footer.getByRole("button", { name: /phone/i });
  const aboutButton = footer.getByRole("button", { name: "About you" });
  const middles = await Promise.all([settingsRow, phoneButton, aboutButton].map(async (b) => {
    const box = (await b.boundingBox())!;
    return box.y + box.height / 2;
  }));
  assert.ok(Math.max(...middles) - Math.min(...middles) < 2, `one row (${middles})`);
  assert.equal(await phoneButton.locator("[data-phone-on]").getAttribute("data-phone-on"), "false");
  await shot("03-sidebar-expanded");

  // ⌘\ collapses it to the rail; the editor's ⌘B is left alone.
  await line("Zzq blorp").click();
  await page.keyboard.press("Meta+Backslash");
  await page.locator("[data-slot=sidebar][data-collapsible=icon]").waitFor();
  await page.waitForTimeout(500);
  const rail = (await page.locator("[data-slot=sidebar-container]").first().boundingBox())!.width;
  assert.ok(rail < 64, `an icon rail (${rail}px)`);
  // Icons keep their names, shown in a tooltip.
  await nav().getByRole("button", { name: "Feed" }).hover();
  await page.getByRole("tooltip").filter({ hasText: "Feed" }).waitFor();
  // The footer stacks: one column.
  const centres = await Promise.all([settingsRow, phoneButton, aboutButton].map(async (b) => {
    const box = (await b.boundingBox())!;
    return box.x + box.width / 2;
  }));
  assert.ok(Math.max(...centres) - Math.min(...centres) < 2, `one column (${centres})`);
  await shot("04-sidebar-rail");

  // About you still opens from the rail.
  await aboutButton.click();
  await page.getByRole("dialog").getByRole("heading", { name: "About you", exact: true }).waitFor();
  // The button's tooltip may still be up; Escape closes the top layer first.
  for (let i = 0; i < 3 && (await page.getByRole("dialog").count()); i++) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  }
  await page.getByRole("dialog").waitFor({ state: "detached" });

  await page.reload();
  await page.locator("[data-slot=sidebar][data-collapsible=icon]").waitFor();
  assert.equal(await sidebar().getAttribute("data-state"), "collapsed", "still collapsed after a reload");

  // The trigger expands it again, and that is kept too.
  await page.getByRole("button", { name: "Expand sidebar" }).click();
  await page.locator("[data-slot=sidebar][data-state=expanded]").waitFor();
  await page.reload();
  await page.locator("[data-slot=sidebar][data-state=expanded]").waitFor();
  await nav().getByRole("button", { name: /^Friction/ }).waitFor();
});
