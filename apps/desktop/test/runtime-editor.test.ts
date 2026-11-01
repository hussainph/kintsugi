// KI-37 against the real runtime: `pnpm desktop:headless` (the real Rust
// command registry on Tauri MockRuntime, and the real React app) driven by
// headless Chromium, with Kin and ⌘K edits on the scripted headless model
// (`KINTSUGI_HEADLESS_KIN=mock`): no credentials, no provider, no cost.
//
// Covers the / menu (blocks, and skills flagged `command` run as a reviewed
// edit), @ (the same [[link]] as [[, and @Kin opening the chat with the
// paragraph; KI-38 made that a comment thread), ⌘K's non-prose actions
// (supporting clips, who disagrees, discuss), and both pickers at phone width with touch. Everything lives in
// a fresh scratch vault and config; screenshots go to .headless/<run>/shots/.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { startApp, type App } from "./headless-app.ts";

const DOC = "drafts/gold-seams.md";
const MIRROR = "posts/mirrored.md";
const TIMEOUT = Number(process.env.KINTSUGI_RUNTIME_TIMEOUT ?? 15 * 60_000);

let app: App;
let browser: Browser;
let page: Page;

before(async () => {
  app = await startApp("ki37", { KINTSUGI_HEADLESS_KIN: "mock" }, (vault) => {
    writeFileSync(resolve(vault, DOC), `---\ntitle: "Gold seams"\nstatus: draft\n---\n\n# Gold seams\n\nThe repair is really very visible, and that is the point.\n`);
    writeFileSync(resolve(vault, MIRROR), `---\ntitle: "Mirrored post"\nmirror: hussain.ph/blog/mirrored\n---\n\nA published paragraph about repair.\n`);
    const skill = (name: string, description: string, command: boolean, body: string) => {
      mkdirSync(resolve(vault, `.kintsugi/agent/skills/${name}`), { recursive: true });
      writeFileSync(resolve(vault, `.kintsugi/agent/skills/${name}/SKILL.md`), `---\nname: ${name}\ndescription: ${description}\ncommand: ${command}\n---\n\n${body}\n`);
    };
    skill("plain-words", "Cut filler words and keep his voice.", true, "1. Remove filler words.\n2. Change nothing else.");
    skill("research-notes", "Where to look for sources.", false, "Search inspiration/ first.");
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

const shot = (name: string, on: Page = page) => on.screenshot({ path: resolve(app.shots, `${name}.png`) });
const disk = () => readFileSync(resolve(app.vault, DOC), "utf8");
async function onDisk(check: (text: string) => boolean, what: string) {
  for (let i = 0; i < 100; i++) {
    if (check(disk())) return;
    await page.waitForTimeout(100);
  }
  assert.fail(`${what}; the file is:\n${disk()}`);
}
const line = (text: string) => page.locator(".cm-line", { hasText: text });
/** The cursor at the end of the line holding `text`. */
async function endOf(text: string) {
  await line(text).first().click();
  await page.keyboard.press("End");
}
const slash = () => page.locator(".cm-command-menu");
const picker = () => page.locator(".cm-reference-picker");
const refine = () => page.locator("[data-slot=popover-content]");
const kin = () => page.getByRole("dialog", { name: "Kin" });
const closeKin = () => kin().getByRole("button", { name: "Close Kin" }).first().click();

test("/ offers Markdown blocks and the skills flagged for it", { timeout: 120_000 }, async () => {
  await page.locator(`[title="${DOC}"]`).click();
  await page.locator(`[title="${DOC}"][data-active="true"]`).waitFor();
  await endOf("and that is the point.");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/");
  await slash().waitFor();
  await slash().getByText("Heading 2").waitFor();
  await slash().getByText("Kin skills").waitFor();
  await slash().locator('[data-command="skill:plain-words"]').waitFor();
  assert.equal(await slash().locator('[data-command="skill:research-notes"]').count(), 0, "only skills flagged command");
  await shot("01-slash-menu");

  await page.keyboard.type("h2");
  assert.equal(await slash().locator('[aria-selected="true"]').getAttribute("data-command"), "h2");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Practice");
  await onDisk((t) => t.includes("point.\n\n## Practice"), "the heading is written as Markdown");

  // A click works as well as the keyboard (and is how the phone gets it).
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/call");
  await slash().locator('[data-command="callout"]').click();
  await page.keyboard.type("Keep the seam.");
  await onDisk((t) => t.includes("## Practice\n\n> [!NOTE]\n> Keep the seam."), "the callout is written as Markdown");
});

test("a / skill runs on the paragraph as a reviewed edit; nothing lands until accepted", { timeout: 60_000 }, async () => {
  await endOf("and that is the point.");
  await page.keyboard.type(" /plain");
  await slash().locator('[data-command="skill:plain-words"][aria-selected="true"]').waitFor();
  await page.keyboard.press("Enter");
  await refine().getByText("plain-words").waitFor();
  await refine().locator("del", { hasText: "really" }).waitFor({ timeout: 15_000 });
  await shot("02-skill-diff");
  assert.ok(disk().includes("really very visible"), "the edit waits for him");
  await page.keyboard.press("Enter");
  await onDisk((t) => t.includes("\nThe repair is visible, and that is the point."), "the accepted edit is written");
  assert.ok(!disk().includes("/plain"), "the command itself is gone");
});

test("@ opens the [[ picker and writes the same [[link]] to disk", { timeout: 60_000 }, async () => {
  // Its own paragraph between the heading and the callout.
  await endOf("Practice");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("See @golden");
  await picker().getByText("Golden joinery").waitFor();
  assert.equal(await picker().locator(".cm-reference-kin").count(), 0, "Kin only while the query could be Kin");
  await shot("03-at-picker");
  await page.keyboard.press("Enter");
  await onDisk((t) => /## Practice\n\nSee \[\[(inspiration\/)?golden-joinery\]\]\n\n> \[!NOTE\]/.test(t), "@ writes a [[link]]");
  assert.ok(!disk().includes("@golden"));
});

test("@Kin, first in the picker, opens a comment thread's composer on the paragraph (KI-38)", { timeout: 60_000 }, async () => {
  await page.keyboard.type(" and @");
  await picker().locator('.cm-reference-kin[aria-selected="true"]').waitFor();
  await shot("04-at-kin");
  await page.keyboard.press("Enter");
  const composer = page.getByRole("textbox", { name: "Ask Kin about this paragraph" });
  await composer.waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Ask Kin about this paragraph");
  await page.locator(".cm-comment-active", { hasText: "See" }).first().waitFor();
  await shot("05-at-kin-comment");
  await onDisk((t) => /See \[\[(inspiration\/)?golden-joinery\]\] and $/m.test(t), "@Kin takes itself out and writes nothing");
  // Escape before sending leaves no thread behind.
  await page.keyboard.press("Escape");
  await composer.waitFor({ state: "detached" });
  assert.equal(await page.locator(".cm-comment-marker").count(), 0);
});

test("⌘K keeps its edits and adds Kin's actions: supporting clips", { timeout: 60_000 }, async () => {
  await line("The repair is visible").click();
  await page.keyboard.press("Meta+k");
  for (const name of ["Tighten", "plain-words", "Find supporting clips", "Who disagrees?", "Discuss this paragraph"]) {
    await refine().getByRole("option", { name: new RegExp(name.replace("?", "\\?")) }).waitFor();
  }
  await shot("06-cmdk-actions");
  await refine().getByRole("option", { name: /Find supporting clips/ }).click();
  await refine().getByText("Supporting clips").waitFor();
  await refine().getByRole("option", { name: /Golden joinery/ }).waitFor({ timeout: 15_000 });
  await shot("07-supporting-clips");
  assert.match(disk(), /that is the point\. ?\n/, "finding writes nothing");
  await refine().getByRole("option", { name: /Golden joinery/ }).click();
  await onDisk((t) => /that is the point\. \[\[(inspiration\/)?golden-joinery\]\]/.test(t), "choosing a clip adds its link after the passage");
});

test("⌘K › Who disagrees? asks Kin in the chat, with the paragraph", { timeout: 60_000 }, async () => {
  await line("The repair is visible").click();
  await page.keyboard.press("Meta+k");
  await refine().getByRole("option", { name: /Who disagrees\?/ }).click();
  await kin().waitFor();
  await kin().locator('[data-role="owner"]').getByText(/Who disagrees with this\?/).waitFor();
  await kin().locator('[data-role="owner"]').last().locator(`[data-chip^="paragraph:${DOC}:"]`).waitFor();
  await kin().locator('[data-role="kin"]').last().getByText(`read {"limit":20,"path":"${DOC}"}`, { exact: false }).waitFor({ timeout: 30_000 });
  await shot("08-who-disagrees");
  await closeKin();
});

test("⌘K › Discuss this paragraph opens a comment thread's composer on it, unsent", { timeout: 60_000 }, async () => {
  await line("Keep the seam.").click();
  await page.keyboard.press("Meta+k");
  await refine().getByRole("option", { name: /Discuss this paragraph/ }).click();
  const composer = page.getByRole("textbox", { name: "Ask Kin about this paragraph" });
  await composer.waitFor();
  assert.equal(await composer.inputValue(), "");
  await page.locator(".cm-comment-active", { hasText: "Keep the seam." }).waitFor();
  await shot("09-discuss-paragraph");
  await page.keyboard.press("Escape");
  await composer.waitFor({ state: "detached" });
});

test("⌘K › Ideas for this draft opens Ideas filtered to it", { timeout: 60_000 }, async () => {
  await line("Keep the seam.").click();
  await page.keyboard.press("Meta+k");
  await refine().getByRole("option", { name: /Ideas for this draft/ }).click();
  await page.getByRole("region", { name: "Ideas" }).waitFor();
  await page.getByText("Gold seams", { exact: false }).first().waitFor();
  await shot("10-ideas-for-draft");
});

test("/ › Ideas for this draft opens the same view", { timeout: 60_000 }, async () => {
  await page.locator(`[title="${DOC}"]`).click();
  await page.locator(`[title="${DOC}"][data-active="true"]`).waitFor();
  await endOf("Keep the seam.");
  await page.keyboard.type(" /ideas");
  await slash().locator('[data-command="action:ideas"][aria-selected="true"]').waitFor();
  await page.keyboard.press("Enter");
  await page.getByRole("region", { name: "Ideas" }).waitFor();
  await onDisk((t) => t.includes("> Keep the seam. \n") || t.includes("> Keep the seam.\n") || t.endsWith("> Keep the seam. "), "the command itself is gone");
  assert.ok(!disk().includes("/ideas"));
});

test("in a read-only mirror, ⌘K offers only the actions that write nothing", { timeout: 60_000 }, async () => {
  await page.locator(`[title="${MIRROR}"]`).click();
  await page.locator(`[title="${MIRROR}"][data-active="true"]`).waitFor();
  const before = readFileSync(resolve(app.vault, MIRROR), "utf8");
  await line("A published paragraph").click();
  await page.keyboard.press("Meta+k");
  await refine().getByRole("option", { name: /Discuss this paragraph/ }).waitFor();
  assert.equal(await refine().getByRole("option", { name: /Tighten|plain-words/ }).count(), 0);
  await refine().getByRole("option", { name: /Find supporting clips/ }).click();
  await refine().getByRole("option", { name: /Golden joinery/ }).waitFor({ timeout: 15_000 });
  await page.keyboard.press("Escape");
  assert.equal(readFileSync(resolve(app.vault, MIRROR), "utf8"), before);
});

test("at phone width with touch, the pickers fit the screen and rows are tap targets", { timeout: 120_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const phone = await context.newPage();
  await phone.goto(app.url);
  const editor = phone.locator(".cm-content");
  await editor.waitFor();
  const fits = async (selector: string) => {
    const box = (await phone.locator(selector).boundingBox())!;
    assert.ok(box.x >= 0 && box.x + box.width <= 390, `${selector} fits: ${JSON.stringify(box)}`);
  };
  // Type at the far right of a line, where a picker would overflow.
  await phone.locator(".cm-line").last().tap();
  await phone.keyboard.press("Control+End");
  await phone.keyboard.type("\n\nA long line of prose that runs right to the edge [[");
  // The picker re-renders its rows and hint when the search answers (KI-47:
  // measuring a row before then caught it detached), so wait for the results.
  await phone.locator(".cm-reference-picker .cm-kintsugi-menu-touch", { hasText: /^Tap/, hasNotText: "Searching" }).waitFor();
  await fits(".cm-reference-picker");
  assert.ok(await phone.locator(".cm-reference-picker .cm-kintsugi-menu-touch").isVisible(), "touch hint, not key hints");
  assert.equal(await phone.locator(".cm-reference-picker .cm-kintsugi-menu-keys").isVisible(), false);
  // Measured in one step in the page, so a re-render can't detach it in between.
  const height = await phone.locator(".cm-reference-option").first().evaluate((row) => row.getBoundingClientRect().height);
  assert.ok(height >= 44, `tap target ${height}px`);
  await shot("11-phone-link-picker", phone);
  await phone.locator(".cm-reference-option").first().tap();
  await phone.locator(".cm-reference-chip").last().waitFor();

  await phone.keyboard.type(" and /");
  await phone.locator(".cm-command-menu").waitFor();
  await fits(".cm-command-menu");
  await shot("12-phone-slash-menu", phone);
  await phone.locator('.cm-command-menu [data-command="todo"]').tap();
  await phone.locator(".cm-line", { hasText: "- [ ] A long line of prose" }).waitFor();
  await context.close();
});
