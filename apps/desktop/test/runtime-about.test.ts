// KI-70 against the real runtime: `pnpm desktop:headless` (the real Rust
// command registry on Tauri MockRuntime, and the real React app) driven by
// headless Chromium, in a fresh scratch vault and config.
//
// About you opens from the sidebar footer on what Kin believes about him,
// with the count bar. A line can be fixed in place (Escape cancels the edit,
// not the dialog) or forgotten; a line's origin opens History at its change,
// where it can be undone. Screenshots go to .headless/<run>/shots/ (light, or
// dark with KINTSUGI_COLOR_SCHEME=dark).
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { startApp, type App, openApp } from "./headless-app.ts";

const TIMEOUT = Number(process.env.KINTSUGI_RUNTIME_TIMEOUT ?? 15 * 60_000);
const SCHEME = process.env.KINTSUGI_COLOR_SCHEME === "dark" ? "dark" : "light";
const USER = ".kintsugi/agent/USER.md";

let app: App;
let browser: Browser;
let page: Page;

before(async () => {
  app = await startApp("ki70", {}, (vault) => {
    mkdirSync(resolve(vault, ".kintsugi/agent/skills/steelman"), { recursive: true });
    writeFileSync(resolve(vault, USER), "- Writes short essays about software\n- Dislikes hype words\n");
    writeFileSync(resolve(vault, ".kintsugi/agent/NOTES.md"), "- Drafts live in drafts/\n");
    writeFileSync(
      resolve(vault, ".kintsugi/agent/skills/steelman/SKILL.md"),
      "---\ndescription: Make the strongest case against a paragraph\ncommand: true\n---\nFind the best counterargument.\n",
    );
  });
  browser = await chromium.launch({ headless: true }).catch((e) => {
    throw new Error(`${e}\nInstall it with: pnpm --filter @kintsugi/desktop exec playwright install chromium-headless-shell`);
  });
  page = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: SCHEME });
  await openApp(page, app.url, app.output);
}, { timeout: TIMEOUT });

after(async () => {
  await browser?.close();
  await app?.stop();
});

const shot = (name: string) => page.getByRole("dialog").screenshot({ path: resolve(app.shots, `${SCHEME}-${name}.png`) });
const dialog = () => page.getByRole("dialog", { name: "About you" });
const lines = () => dialog().getByRole("list", { name: "You" });
const userFile = () => readFileSync(resolve(app.vault, USER), "utf8");

test("About you shows what Kin believes, fixes a line in place, and undoes from History", { timeout: 120_000 }, async () => {
  await page.locator("[data-sidebar=footer]").getByRole("button", { name: "About you" }).click();
  await dialog().getByRole("heading", { name: "About you", exact: true }).waitFor();

  // It opens on what Kin believes about him, with the count bar; file names stay out of it.
  assert.equal(await dialog().getByRole("tab", { name: "You" }).getAttribute("aria-selected"), "true");
  await lines().getByText("Writes short essays about software").waitFor();
  await dialog().getByRole("meter", { name: "Characters used" }).waitFor();
  await dialog().getByText(/\/ 1,500 characters/).waitFor();
  assert.equal(await dialog().getByText(/USER\.md|NOTES\.md|\.kintsugi/).count(), 0, "no file names");
  await page.mouse.move(1270, 10);
  await shot("01-you");

  // Fix a line in place. Escape cancels the edit and leaves the dialog open.
  const row = lines().getByRole("listitem").filter({ hasText: "Writes short essays" });
  await row.hover();
  await row.getByRole("button", { name: /^Edit “/ }).click();
  const field = dialog().getByRole("textbox", { name: "Edit line" });
  await field.waitFor();
  await page.keyboard.press("Escape");
  await field.waitFor({ state: "detached" });
  assert.ok(await dialog().isVisible(), "Escape cancelled the edit, not the dialog");

  await row.hover();
  await row.getByRole("button", { name: /^Edit “/ }).click();
  await field.fill("Writes short essays about software and tools");
  await shot("02-editing");
  await page.keyboard.press("Enter");
  await lines().getByText("Writes short essays about software and tools").waitFor();
  assert.match(userFile(), /^- Writes short essays about software and tools$/m);

  // Forget one.
  const hype = lines().getByRole("listitem").filter({ hasText: "Dislikes hype words" });
  await hype.hover();
  await hype.getByRole("button", { name: /^Forget “/ }).click();
  await hype.waitFor({ state: "detached" });
  assert.doesNotMatch(userFile(), /hype/);

  // Add one, behind its button.
  await dialog().getByRole("button", { name: "Add a line" }).click();
  await dialog().getByRole("textbox", { name: "New line" }).fill("Publishes on weekends");
  await page.keyboard.press("Enter");
  await lines().getByText("Publishes on weekends").waitFor();

  // The other tabs.
  await dialog().getByRole("tab", { name: "Vault" }).click();
  await dialog().getByRole("list", { name: "Vault" }).getByText("Drafts live in drafts/").waitFor();
  await dialog().getByRole("tab", { name: "Skills" }).click();
  await dialog().getByRole("list", { name: "Skills" }).getByText("/steelman").waitFor();
  await page.mouse.move(1270, 10);
  await shot("03-skills");

  // A line's origin opens History at its change; undo it there.
  await dialog().getByRole("tab", { name: "You" }).click();
  await lines().getByRole("listitem").filter({ hasText: "and tools" }).getByRole("button", { name: /^You · / }).click();
  assert.equal(await dialog().getByRole("tab", { name: "History" }).getAttribute("aria-selected"), "true");
  const change = dialog().getByRole("list", { name: "History" }).locator("li[data-focus]");
  await change.getByText("Writes short essays about software and tools").waitFor();
  await page.mouse.move(1270, 10);
  await shot("04-history");
  await change.getByRole("button", { name: "Undo" }).click();
  await change.getByText("Undone").waitFor();
  assert.match(userFile(), /^- Writes short essays about software$/m);

  // It opens on You again next time.
  // The footer button's tooltip may be up; Escape closes the top layer first.
  for (let i = 0; i < 3 && (await dialog().count()); i++) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  }
  await dialog().waitFor({ state: "detached" });
  await page.locator("[data-sidebar=footer]").getByRole("button", { name: "About you" }).click();
  assert.equal(await dialog().getByRole("tab", { name: "You" }).getAttribute("aria-selected"), "true");
});
