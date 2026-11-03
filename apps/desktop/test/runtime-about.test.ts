// KI-70 / KI-93 against the real runtime: `pnpm desktop:headless` (the real
// Rust command registry on Tauri MockRuntime, and the real React app) driven
// by headless Chromium, in a fresh scratch vault and config.
//
// About you is an overlay with a vertical section sidebar and serif detail.
// A line can be fixed in place (Escape cancels the edit, not the dialog),
// forgotten, or added; its origin opens History at its change, with undo
// and redo. Both launch points preserve the page underneath. Screenshots
// cover all four sections, editing, and a small window in .headless/<run>/shots/
// (light, or dark with KINTSUGI_COLOR_SCHEME=dark).
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, afterEach, before, test } from "node:test";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { startApp, type App, openApp } from "./headless-app.ts";

const TIMEOUT = Number(process.env.KINTSUGI_RUNTIME_TIMEOUT ?? 15 * 60_000);
const SCHEME = process.env.KINTSUGI_COLOR_SCHEME === "dark" ? "dark" : "light";
const USER = ".kintsugi/agent/USER.md";
const DOC = "drafts/kintsugi-and-gold.md";
const INITIAL_YOU = ["Writes short essays about software", "Dislikes hype words"];
const INITIAL_VAULT = ["Drafts live in drafts/"];
const SECTIONS = ["You", "This vault", "Skills", "History"] as const;
type Section = typeof SECTIONS[number];

let app: App;
let browser: Browser;
let page: Page;

before(async () => {
  app = await startApp("ki93", {}, (vault) => {
    mkdirSync(resolve(vault, ".kintsugi/agent/skills/steelman"), { recursive: true });
    writeFileSync(resolve(vault, USER), INITIAL_YOU.map((line) => `- ${line}\n`).join(""));
    writeFileSync(resolve(vault, ".kintsugi/agent/NOTES.md"), INITIAL_VAULT.map((line) => `- ${line}\n`).join(""));
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

// A failed assertion must not leave an overlay intercepting the next test.
afterEach(async () => {
  if (await dialog().count()) await close();
});

after(async () => {
  await browser?.close();
  await app?.stop();
});

const shot = (name: string) => dialog().screenshot({ path: resolve(app.shots, `${SCHEME}-${name}.png`) });
const dialog = () => page.getByRole("dialog", { name: "About you", exact: true });
const sections = () => dialog().getByRole("tablist", { name: "About you sections", exact: true });
const tab = (name: Section) => sections().getByRole("tab", { name, exact: true });
const panel = (name: Section) => dialog().getByRole("tabpanel", { name, exact: true });
const lines = () => panel("You").getByRole("list", { name: "You", exact: true });
const settings = () => page.getByRole("region", { name: "Settings", exact: true });
const userFile = () => readFileSync(resolve(app.vault, USER), "utf8");
const footerAbout = () => page.locator("[data-sidebar=footer]").getByRole("button", { name: "About you", exact: true });

async function selected(name: Section) {
  assert.equal(await tab(name).getAttribute("aria-selected"), "true");
  await panel(name).waitFor();
  await dialog().getByRole("heading", { name, exact: true, level: 3 }).waitFor();
}

/** Compare computed families to the live tokens, not a hardcoded font name. */
async function font(element: Locator, token: "--font-editorial" | "--font-ui") {
  const { actual, expected } = await element.evaluate((el, token) => {
    const probe = document.createElement("span");
    probe.style.fontFamily = `var(${token})`;
    probe.style.display = "none";
    el.append(probe);
    const expected = getComputedStyle(probe).fontFamily;
    probe.remove();
    return { actual: getComputedStyle(el).fontFamily, expected };
  }, token);
  assert.equal(actual, expected, `${await element.textContent()} uses ${token}`);
}

async function usage(name: "You" | "This vault", entries: string[], cap: number) {
  const used = [...entries.join("\n")].length;
  const count = `${used.toLocaleString()} / ${cap.toLocaleString()}`;
  const meter = sections().getByRole("meter", { name: `${name} characters used`, exact: true });
  await meter.waitFor();
  assert.equal(await meter.getAttribute("aria-valuenow"), String(used));
  assert.equal(await meter.getAttribute("aria-valuemax"), String(cap));
  assert.equal(await meter.getAttribute("aria-valuetext"), `${count} characters`);
  const visibleCount = tab(name).locator(".ki-about-count");
  await visibleCount.waitFor();
  assert.equal(await visibleCount.evaluate((el) => [...el.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join("").trim()), count);
}

async function close() {
  await dialog().getByRole("button", { name: "Close", exact: true }).click();
  await dialog().waitFor({ state: "detached" });
}

test("About you shows what Kin believes, fixes a line in place, and undoes and redoes from History", { timeout: 120_000 }, async () => {
  await footerAbout().click();
  await dialog().getByRole("heading", { name: "About you", exact: true }).waitFor();

  // The section names remain exact accessible names, without their counts.
  assert.equal(await sections().getAttribute("aria-orientation"), "vertical");
  assert.equal(await sections().getByRole("tab").count(), 4);
  for (const name of SECTIONS) assert.equal(await tab(name).getAttribute("aria-label"), name);
  await selected("You");
  await lines().getByText(INITIAL_YOU[0], { exact: true }).waitFor();
  await usage("You", INITIAL_YOU, 1_500);
  await usage("This vault", INITIAL_VAULT, 2_000);
  assert.equal(await dialog().getByText(/USER\.md|NOTES\.md|\.kintsugi/).count(), 0, "no file names");

  // The screenshot waits for the opening animation before measuring geometry.
  await page.mouse.move(1270, 10);
  await shot("01-you");
  await page.screenshot({ path: resolve(app.shots, `${SCHEME}-00-overlay.png`) });
  const bounds = await dialog().boundingBox();
  const sidebar = await dialog().locator(".ki-about-nav").boundingBox();
  const title = await dialog().getByRole("heading", { name: "About you", exact: true }).boundingBox();
  assert.ok(bounds && sidebar && title);
  assert.ok(Math.abs(bounds.width - 820) <= 1, `default width: ${bounds.width}`);
  assert.ok(Math.abs(bounds.height - 560) <= 1, `default height: ${bounds.height}`);
  assert.ok(Math.abs(sidebar.width - 220) <= 1, `sidebar width: ${sidebar.width}`);
  assert.ok(title.x >= sidebar.x && title.x + title.width <= sidebar.x + sidebar.width + 1, "dialog title is in the sidebar");
  await font(lines().getByText(INITIAL_YOU[0], { exact: true }), "--font-editorial");
  await font(lines().getByRole("listitem").first().getByText(/Not used yet/), "--font-ui");
  await font(dialog().getByRole("heading", { name: "You", exact: true, level: 3 }), "--font-editorial");
  await font(tab("You"), "--font-ui");
  await font(dialog().getByRole("heading", { name: "About you", exact: true }), "--font-ui");

  // Vertical arrows move focus and select; Tab leaves the list for the panel.
  await tab("You").focus();
  await page.keyboard.press("ArrowDown");
  await selected("This vault");
  assert.ok(await tab("This vault").evaluate((el) => el === document.activeElement));
  await page.keyboard.press("ArrowDown");
  await selected("Skills");
  await page.keyboard.press("ArrowUp");
  await selected("This vault");
  assert.ok(await tab("This vault").evaluate((el) => el === document.activeElement));
  await page.keyboard.press("Tab");
  assert.ok(await panel("This vault").evaluate((el) => el.contains(document.activeElement)), "Tab enters the selected panel");
  await tab("You").click();

  // Fix a line in place. Escape cancels the edit and leaves the dialog open.
  const row = lines().getByRole("listitem").filter({ hasText: "Writes short essays" });
  await row.hover();
  await row.getByRole("button", { name: /^Edit “/ }).click();
  const field = dialog().getByRole("textbox", { name: "Edit line" });
  await field.waitFor();
  await font(field, "--font-editorial");
  await field.fill("This edit should be cancelled");
  await page.keyboard.press("Escape");
  await field.waitFor({ state: "detached" });
  assert.ok(await dialog().isVisible(), "Escape cancelled the edit, not the dialog");
  assert.match(userFile(), /^- Writes short essays about software$/m);
  assert.doesNotMatch(userFile(), /cancelled/);

  await row.hover();
  await row.getByRole("button", { name: /^Edit “/ }).click();
  await field.fill("Writes short essays about software and tools");
  await shot("02-editing");
  await page.keyboard.press("Enter");
  await lines().getByText("Writes short essays about software and tools", { exact: true }).waitFor();
  assert.match(userFile(), /^- Writes short essays about software and tools$/m);

  // Forget one.
  const hype = lines().getByRole("listitem").filter({ hasText: "Dislikes hype words" });
  await hype.hover();
  await hype.getByRole("button", { name: /^Forget “/ }).click();
  await hype.waitFor({ state: "detached" });
  assert.doesNotMatch(userFile(), /hype/);

  // Add one, behind its button; cancelling an addition also keeps the overlay.
  await dialog().getByRole("button", { name: "Add a line" }).click();
  const newLine = dialog().getByRole("textbox", { name: "New line" });
  await font(newLine, "--font-editorial");
  await newLine.fill("This addition should be cancelled");
  await page.keyboard.press("Escape");
  await newLine.waitFor({ state: "detached" });
  assert.ok(await dialog().isVisible());
  assert.doesNotMatch(userFile(), /cancelled/);
  await dialog().getByRole("button", { name: "Add a line" }).click();
  await newLine.fill("Publishes on weekends");
  await page.keyboard.press("Enter");
  await lines().getByText("Publishes on weekends", { exact: true }).waitFor();
  await usage("You", ["Writes short essays about software and tools", "Publishes on weekends"], 1_500);

  // Capture every section, including the vault detail.
  await tab("This vault").click();
  await selected("This vault");
  const vaultLine = panel("This vault").getByRole("list", { name: "This vault", exact: true }).getByText(INITIAL_VAULT[0], { exact: true });
  await vaultLine.waitFor();
  await font(vaultLine, "--font-editorial");
  await page.mouse.move(1270, 10);
  await shot("03-this-vault");
  await tab("Skills").click();
  await selected("Skills");
  await panel("Skills").getByRole("list", { name: "Skills", exact: true }).getByText("/steelman", { exact: true }).waitFor();
  await tab("Skills").getByText("1", { exact: true }).waitFor();
  await font(panel("Skills").getByText("Make the strongest case against a paragraph", { exact: true }), "--font-editorial");
  await page.mouse.move(1270, 10);
  await shot("04-skills");

  // A line's origin opens History at its change; undo and redo it there.
  await tab("You").click();
  const origin = lines().getByRole("listitem").filter({ hasText: "and tools" }).getByRole("button", { name: /^You · / });
  await font(origin, "--font-ui");
  await origin.click();
  await selected("History");
  const history = panel("History").getByRole("list", { name: "History", exact: true });
  const change = history.locator(":scope > li[data-focus]");
  await change.getByText("Writes short essays about software and tools").waitFor();
  await font(change.locator("ul").first(), "--font-editorial");
  await font(change.getByRole("button", { name: "Undo", exact: true }), "--font-ui");
  await tab("History").getByText((await history.locator(":scope > li").count()).toLocaleString(), { exact: true }).waitFor();
  await page.mouse.move(1270, 10);
  await shot("05-history");
  await change.getByRole("button", { name: "Undo", exact: true }).click();
  await change.getByText("Undone", { exact: true }).waitFor();
  assert.match(userFile(), /^- Writes short essays about software$/m);

  const undo = history.locator(":scope > li").filter({ has: page.getByRole("button", { name: "Redo", exact: true }) }).first();
  const undoId = await undo.getAttribute("id");
  assert.ok(undoId);
  await undo.getByRole("button", { name: "Redo", exact: true }).click();
  await history.locator(`[id="${undoId}"]`).getByText("Undone", { exact: true }).waitFor();
  assert.match(userFile(), /^- Writes short essays about software and tools$/m);

  // It opens on You again next time, even after leaving it on History.
  await close();
  await footerAbout().click();
  await selected("You");
  await lines().getByText("Writes short essays about software and tools", { exact: true }).waitFor();
  await close();
});

test("the overlay preserves the document and the Settings section that launched it", { timeout: 120_000 }, async () => {
  await page.locator(`[title="${DOC}"]`).click();
  const activeDoc = page.locator(`[title="${DOC}"][data-active="true"]`);
  await activeDoc.waitFor();
  const editor = page.locator(".cm-content");
  await editor.waitFor();
  const content = await editor.textContent();
  const disk = readFileSync(resolve(app.vault, DOC), "utf8");

  await footerAbout().click();
  await selected("You");
  await tab("History").click();
  await selected("History");
  // Escape closes the overlay when no line is being edited.
  await page.keyboard.press("Escape");
  await dialog().waitFor({ state: "detached" });
  await activeDoc.waitFor();
  assert.equal(await editor.textContent(), content);

  await page.keyboard.press("Meta+,");
  await settings().getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Kin and models", exact: true }).click();
  await settings().getByRole("heading", { name: "Kin and models", exact: true, level: 1 }).waitFor();
  const settingsPage = await settings().elementHandle();
  assert.ok(settingsPage);
  await settings().getByRole("button", { name: "About you", exact: true }).click();
  await selected("You");
  assert.ok(await settingsPage.evaluate((el) => el.isConnected), "Settings stays mounted under About you");
  await tab("This vault").click();
  await selected("This vault");
  await close();
  await settings().getByRole("heading", { name: "Kin and models", exact: true, level: 1 }).waitFor();
  assert.ok(await settings().evaluate((el, original) => el === original, settingsPage), "closing returns to the same Settings page");
  assert.equal(await settings().getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Kin and models", exact: true }).getAttribute("aria-current"), "page");
  await settings().getByRole("button", { name: /^Back/ }).click();
  await settings().waitFor({ state: "detached" });
  await activeDoc.waitFor();
  assert.equal(await editor.textContent(), content);
  assert.equal(readFileSync(resolve(app.vault, DOC), "utf8"), disk, "About you did not change the document");
});

test("a small window keeps the sidebar and Close visible while detail scrolls", { timeout: 120_000 }, async () => {
  await footerAbout().click();
  await selected("You");
  await page.setViewportSize({ width: 640, height: 420 });
  try {
    await tab("History").click();
    await selected("History");
    const bounds = await dialog().boundingBox();
    assert.ok(bounds);
    assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 641 && bounds.y + bounds.height <= 421, "overlay fits the viewport");
    assert.ok(await dialog().evaluate((el) => el.scrollWidth <= el.clientWidth + 1), "no horizontal dialog overflow");
    assert.ok(await panel("History").evaluate((el) => el.scrollWidth <= el.clientWidth + 1), "detail wraps at the smaller width");
    const scrolled = await panel("History").evaluate((el) => {
      for (let node: HTMLElement | null = el as HTMLElement; node && node.getAttribute("role") !== "dialog"; node = node.parentElement) {
        if (/auto|scroll/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight) {
          node.scrollTop = node.scrollHeight;
          return node.scrollTop > 0;
        }
      }
      return false;
    });
    assert.ok(scrolled, "History scrolls inside the detail");
    for (const name of SECTIONS) assert.ok(await tab(name).isVisible());
    const closeBounds = await dialog().getByRole("button", { name: "Close", exact: true }).boundingBox();
    assert.ok(closeBounds && closeBounds.y >= 0 && closeBounds.y + closeBounds.height <= 420, "Close remains in view after scrolling");
    await page.mouse.move(630, 10);
    await shot("06-small-window-history");
    await page.setViewportSize({ width: 420, height: 640 });
    await tab("This vault").click();
    await selected("This vault");
    assert.ok(await dialog().evaluate((el) => el.scrollWidth <= el.clientWidth + 1), "narrow overlay has no horizontal overflow");
    assert.ok(await panel("This vault").evaluate((el) => el.scrollWidth <= el.clientWidth + 1), "narrow detail wraps");
    await shot("07-narrow-window-vault");
    await close();
  } finally {
    await page.setViewportSize({ width: 1280, height: 860 });
  }
});
