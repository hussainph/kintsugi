// KI-69 against the real runtime: shortcuts aren't printed in rows and
// buttons any more; holding ⌘ on its own shows them beside their controls and
// as a list, and letting go (or pressing a ⌘-combo) hides them. Every key
// chip is the same monospace chip. Screenshots go to .headless/<run>/shots/.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { startApp, type App } from "./headless-app.ts";

const TIMEOUT = Number(process.env.KINTSUGI_RUNTIME_TIMEOUT ?? 15 * 60_000);
const HOLD = 800;

let app: App;
let browser: Browser;
let page: Page;

before(async () => {
  app = await startApp("ki69", {});
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
const nav = () => page.locator("[data-sidebar=sidebar]").first();
const list = () => page.getByRole("dialog", { name: "Keyboard shortcuts" });
const feedHint = () => nav().getByRole("button", { name: "Feed" }).locator(".ki-shortcut-hint");

test("holding ⌘ shows the shortcuts; letting go or a ⌘-combo hides them", { timeout: 120_000 }, async () => {
  await nav().getByRole("button", { name: /^Kintsugi and gold/ }).click();
  await page.locator(".cm-line", { hasText: "# Kintsugi and gold" }).waitFor();
  await page.locator(".cm-content").click();

  // Nothing in the rows until ⌘ is held.
  assert.equal(await feedHint().isVisible(), false, "no hint in the Feed row");

  // A quick ⌘ press, or ⌘ held into a combo, shows nothing.
  await page.keyboard.press("Meta");
  await page.keyboard.down("Meta");
  await page.waitForTimeout(HOLD / 2);
  await page.keyboard.press("s");
  await page.waitForTimeout(HOLD);
  assert.equal(await list().count(), 0, "a ⌘-combo never shows the list");
  await page.keyboard.up("Meta");

  // Held on its own, the list and the chips show.
  await page.keyboard.down("Meta");
  await list().waitFor({ timeout: HOLD * 3 });
  assert.ok(await feedHint().isVisible(), "the Feed row's chip shows");
  assert.equal((await feedHint().textContent())?.trim(), "⇧⌘F");
  for (const label of ["New document", "Sidebar", "Edit with Kin", "Bold", "Heading"]) {
    await list().getByText(label, { exact: true }).waitFor();
  }
  await list().getByText("⌥⌘1–6").waitFor();
  await shot("01-held");

  // Every chip is the same chip: one font, one height.
  const chips = await page.locator(".ki-kbd:visible").evaluateAll((els) =>
    els.map((el) => {
      const style = getComputedStyle(el);
      return { font: style.fontFamily, height: el.getBoundingClientRect().height };
    }),
  );
  assert.ok(chips.length > 20, `${chips.length} chips`);
  assert.equal(new Set(chips.map((c) => c.font)).size, 1, "one font");
  assert.equal(new Set(chips.map((c) => Math.round(c.height))).size, 1, "one height");

  await page.keyboard.up("Meta");
  await list().waitFor({ state: "detached" });
  assert.equal(await feedHint().isVisible(), false, "hidden again");

  // A key pressed while they show hides them too.
  await page.keyboard.down("Meta");
  await list().waitFor({ timeout: HOLD * 3 });
  await page.keyboard.press("Shift");
  await list().waitFor({ state: "detached" });
  await page.keyboard.up("Meta");
});

test("Settings lists its own shortcuts", { timeout: 60_000 }, async () => {
  await page.keyboard.press("Meta+Comma");
  await page.getByRole("region", { name: "Settings" }).waitFor();
  await page.keyboard.down("Meta");
  await list().waitFor({ timeout: HOLD * 3 });
  await list().getByText("Back", { exact: true }).waitFor();
  assert.equal(await list().getByText("Bold", { exact: true }).count(), 0, "no editor keys in Settings");
  await shot("02-settings-held");
  await page.keyboard.up("Meta");
});
