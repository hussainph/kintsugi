// KI-37 against the real runtime: `pnpm desktop:headless` (the real Rust
// command registry on Tauri MockRuntime, and the real React app) driven by
// headless Chromium, with Kin and ⌘K edits on the scripted headless model
// (`KINTSUGI_HEADLESS_KIN=mock`): no credentials, no provider, no cost.
//
// Covers the / menu (blocks, and skills flagged `command` run as a reviewed
// edit), @ (the same [[link]] as [[, and @Kin opening the chat with the
// paragraph; KI-38 made that a comment thread), ⌘K's non-prose actions
// (supporting clips, who disagrees, discuss), KI-87's kept/asked alternatives,
// and both pickers at phone width with touch. Everything lives in
// a fresh scratch vault and config; screenshots go to .headless/<run>/shots/.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Locator, type Page, type Request, type Route } from "playwright";
import { startApp, type App, openApp } from "./headless-app.ts";

const DOC = "drafts/gold-seams.md";
const MIRROR = "posts/mirrored.md";
// After DOC in the tree, so a new window still opens DOC first.
const DRIFT = "posts/drift.md";
// Its own document: KI-87 never changes the passages the KI-37/80 tests use.
const ALTERNATIVES = "posts/kin-alternatives.md";
const ACCEPT = "The first draft is really very clear.";
const KEEP = "The next draft is really very useful.";
const ASK = "A good editor keeps the sentence clear. A quick review is useful.";
const ALTERNATIVES_TEXT = `# Alternatives\n\n${ACCEPT}\n\n${KEEP}\n\nA small change keeps the argument simple.\n\n${ASK}\n\nI read in order to keep the argument clear.\n\nA quiet editor reads a difficult draft.\n`;
const SAME = "Same words really matter.";
/** As long as SAME, so cutting it slides the next SAME under the old offsets. */
const OTHER = "Another thought, cut out.";
const TIMEOUT = Number(process.env.KINTSUGI_RUNTIME_TIMEOUT ?? 15 * 60_000);

let app: App;
let browser: Browser;
let page: Page;

before(async () => {
  app = await startApp("ki37", { KINTSUGI_HEADLESS_KIN: "mock" }, (vault) => {
    writeFileSync(resolve(vault, DOC), `---\ntitle: "Gold seams"\nstatus: draft\n---\n\n# Gold seams\n\nThe repair is really very visible, and that is the point.\n`);
    writeFileSync(resolve(vault, DRIFT), `# Drift\n\n${OTHER}\n\n${SAME}\n\n${SAME}\n`);
    writeFileSync(resolve(vault, ALTERNATIVES), ALTERNATIVES_TEXT);
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
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await openApp(page, app.url, app.output);
}, { timeout: TIMEOUT });

after(async () => {
  await browser?.close();
  await app?.stop();
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
const kin = () => page.getByRole("region", { name: "Kin" });
const closeKin = () => page.getByRole("button", { name: "Margin", pressed: true }).click();

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

test("@Kin, first in the picker, opens a new thread about the paragraph in Kin (KI-38, KI-104)", { timeout: 60_000 }, async () => {
  await page.keyboard.type(" and @");
  await picker().locator('.cm-reference-kin[aria-selected="true"]').waitFor();
  await shot("04-at-kin");
  await page.keyboard.press("Enter");
  const composer = kin().getByRole("textbox", { name: "Message Kin" });
  await kin().locator("[data-new]").waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Message Kin");
  await kin().locator(".ki-kin-about-passage").getByText("See", { exact: false }).waitFor();
  await page.locator(".cm-comment-active", { hasText: "See" }).first().waitFor();
  await shot("05-at-kin-thread");
  await onDisk((t) => /See \[\[(inspiration\/)?golden-joinery\]\] and $/m.test(t), "@Kin takes itself out and writes nothing");
  // Escape before sending puts Kin away and leaves no thread behind.
  await composer.press("Escape");
  await kin().waitFor({ state: "detached" });
  await page.locator(".cm-comment-active").waitFor({ state: "detached" });
  assert.equal(await page.locator(".cm-comment-marker").count(), 0);
});

test("⌘K keeps its edits and adds Kin's actions: supporting clips", { timeout: 60_000 }, async () => {
  await line("The repair is visible").click();
  await page.keyboard.press("Meta+k");
  for (const name of ["Tighten", "plain-words", "Find supporting clips", "Who disagrees?", "Discuss this paragraph"]) {
    await refine().getByRole("option", { name: new RegExp(`^${name.replace("?", "\\?")}(?! more)`) }).waitFor();
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

test("⌘K › Who disagrees? is a quick ask: a Kin replied chip opens its thread", { timeout: 60_000 }, async () => {
  await line("The repair is visible").click();
  await page.keyboard.press("Meta+k");
  await refine().getByRole("option", { name: /Who disagrees\?/ }).click();
  const chip = page.locator('.cm-comment-ask[data-state="replied"]');
  await chip.waitFor({ timeout: 30_000 });
  assert.equal(await kin().count(), 0, "Kin stays out of the way");
  await shot("08-kin-replied");
  await chip.click();
  await kin().locator('[data-role="owner"]').getByText(/Who disagrees with this\?/).waitFor();
  await kin().locator('[data-role="owner"]').last().locator(`[data-chip^="paragraph:${DOC}:"]`).waitFor();
  // A thread about a paragraph is answered like a margin note.
  await kin().locator('[data-role="kin"]').last().getByText("Mock note: you asked “Who disagrees with this?", { exact: false }).waitFor({ timeout: 30_000 });
  await shot("08b-who-disagrees");
  await closeKin();
});

test("⌘K › Discuss this paragraph opens a new thread about it, unsent", { timeout: 60_000 }, async () => {
  await line("Keep the seam.").click();
  await page.keyboard.press("Meta+k");
  await refine().getByRole("option", { name: /Discuss this paragraph/ }).click();
  const composer = kin().getByRole("textbox", { name: "Message Kin" });
  await kin().locator("[data-new]").waitFor();
  assert.equal(await composer.inputValue(), "");
  await page.locator(".cm-comment-active", { hasText: "Keep the seam." }).waitFor();
  await shot("09-discuss-paragraph");
  await composer.press("Escape");
  await kin().waitFor({ state: "detached" });
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

test("an outside edit above the passage while ⌘K is open doesn't move the rewrite (KI-80)", { timeout: 60_000 }, async () => {
  const file = resolve(app.vault, DRIFT);
  await page.locator(`[title="${DRIFT}"]`).click();
  await page.locator(`[title="${DRIFT}"][data-active="true"]`).waitFor();
  assert.equal(OTHER.length, SAME.length);
  await line(SAME).first().click();
  await page.keyboard.press("Meta+k");
  await refine().getByRole("option", { name: /^Tighten(?! more)/ }).click();
  await refine().locator("del", { hasText: "really" }).waitFor({ timeout: 15_000 });
  // The paragraph above is cut elsewhere while the diff is open, so the old
  // offsets now hold the same words one paragraph too low.
  writeFileSync(file, `# Drift\n\n${SAME}\n\n${SAME}\n`);
  await line(OTHER).waitFor({ state: "detached" });
  await refine().locator("del", { hasText: "really" }).waitFor();
  await page.keyboard.press("Enter");
  const want = `# Drift\n\nSame words matter.\n\n${SAME}\n`;
  for (let i = 0; i < 100 && readFileSync(file, "utf8") !== want; i++) await page.waitForTimeout(100);
  assert.equal(readFileSync(file, "utf8"), want, "the passage he chose is rewritten, not the one now at its old offsets");
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
  // The picker rebuilds its rows on every refresh, and one can land any time
  // (a vault change from an earlier test refreshes the sources and re-runs the
  // search). A locator's evaluate finds the row and measures it in two round
  // trips, so it can measure a detached row as 0px; one in-page read can't.
  const height = await phone.evaluate(() => document.querySelector(".cm-reference-picker .cm-reference-option")?.getBoundingClientRect().height ?? 0);
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

// KI-87 uses the same real runtime, with a separate document and sidecar.
type AlternativeEntry = { id: string; text: string; by: "owner" | "kin" };
type AlternativeSet = { id: string; level: string; current: string; anchor: { exact: string }; entries: AlternativeEntry[] };
type AlternativesFile = { version: number; path: string; sets: AlternativeSet[] };
const alternativeDisk = () => readFileSync(resolve(app.vault, ALTERNATIVES), "utf8");
const alternativeStore = (path = ALTERNATIVES) => resolve(app.vault, `.kintsugi/alternatives/${path}.json`);
const savedAlternatives = (): AlternativesFile => JSON.parse(readFileSync(alternativeStore(), "utf8"));
const alternativeSet = (original: string) => savedAlternatives().sets.find((s) => s.entries.some((e) => e.by === "owner" && e.text === original));
const currentAlternative = (set: AlternativeSet) => set.entries.find((e) => e.id === set.current);
const altPanel = () => page.locator(".cm-alt-panel");
/** A span tab's label without its count of versions (KI-111). */
const withoutCount = (text: string) => text.replace(/\d+$/, "");
const tabLabel = async (tab: Locator) => withoutCount((await tab.textContent()) ?? "");
const kinOptions = () => altPanel().locator('.cm-alt-option[data-by="kin"]');
const altText = () => page.locator(".cm-content").evaluate((el) => {
  const copy = el.cloneNode(true) as HTMLElement;
  copy.querySelectorAll(".cm-alt-count, .cm-alt-gutter, .cm-step-card").forEach((node) => node.remove());
  return copy.innerText;
});

async function alternativeUntil(check: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) {
    try { if (check()) return; } catch { /* The sidecar may not exist yet. */ }
    await page.waitForTimeout(100);
  }
  assert.fail(`${what}; the document is:\n${alternativeDisk()}`);
}

async function closeAltPanel() {
  // Focus the actual control before Escape, not its scheduled mount focus.
  const input = altPanel().getByRole("textbox", { name: "Add a version" });
  const target = await input.isDisabled() ? page.locator(".cm-content") : input;
  await target.press("Escape");
  await altPanel().waitFor({ state: "detached" });
}

async function openAlternativeDoc(keepMargin = false) {
  // Most tests start with versions closed before invoking its toggle key.
  // The pending-request test instead preserves the margin across documents.
  if (!keepMargin && await altPanel().count()) await closeAltPanel();
  await page.locator(`[title="${ALTERNATIVES}"]`).click();
  await page.locator(`[title="${ALTERNATIVES}"][data-active="true"]`).waitFor();
  // Counts can split the first sentence's text after alternatives are added.
  await line("A quick review is useful.").waitFor();
}

/** Real pointer/keyboard selection; no editor module or state injected. */
async function alternativeCursor(text: string, select = false) {
  await line(text).first().scrollIntoViewIfNeeded();
  const at = await page.locator(".cm-content").evaluate((content, target) => {
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement?.closest(".cm-alt-count, .cm-alt-gutter, .cm-step-card")) continue;
      const i = node.textContent!.indexOf(target);
      if (i === -1) continue;
      const range = document.createRange();
      range.setStart(node, i + 1);
      range.setEnd(node, i + 2);
      const box = range.getBoundingClientRect();
      return { x: box.left + 1, y: box.top + box.height / 2 };
    }
    return null;
  }, text);
  assert.ok(at, `${text} is in the editor`);
  if (select) {
    await page.mouse.dblclick(at.x, at.y);
    // Double-click selects the first word; extend it for a phrase.
    for (let i = text.split(" ")[0].length; i < text.length; i++) await page.keyboard.press("Shift+ArrowRight");
    assert.equal(await page.evaluate(() => window.getSelection()?.toString()), text);
  } else {
    await page.mouse.click(at.x, at.y);
  }
  await page.waitForTimeout(50);
}

async function completedRewrite() {
  await refine().locator(".ki-refine-result del").first().waitFor({ timeout: 15_000 });
  return refine().locator(".ki-refine-result").evaluate((el) => {
    const copy = el.cloneNode(true) as HTMLElement;
    copy.querySelectorAll("del").forEach((node) => node.remove());
    return copy.textContent!.trim();
  });
}

async function completedAlternatives() {
  await kinOptions().first().waitFor({ timeout: 15_000 });
  await altPanel().getByRole("button", { name: "Ask Kin", exact: true }).waitFor();
  assert.equal(await altPanel().getByRole("button", { name: "Ask Kin", exact: true }).isEnabled(), true);
  assert.equal(await altPanel().getByRole("listbox").getAttribute("aria-busy"), "false");
  assert.equal(await kinOptions().locator('svg[data-kin-avatar="placeholder"]').count(), await kinOptions().count(), "each Kin version has its mark");
}

/** Observe real bridge requests, without replacing the model or the transport. */
function watchAlternativeRequests() {
  const levels: string[] = [];
  const watch = (request: Request) => {
    if (request.method() !== "POST" || !request.url().endsWith("/invoke")) return;
    const body = request.postDataJSON();
    if (body?.cmd !== "ai_stream") return;
    const user = body.args?.request?.messages?.find((m: { role: string }) => m.role === "user");
    const level = /<alternatives level="([^"]+)">/.exec(user?.content ?? "")?.[1];
    if (level) levels.push(level);
  };
  page.on("request", watch);
  return { levels, stop: () => page.off("request", watch) };
}

async function alternativeShot(name: string, colorScheme: "light" | "dark") {
  await page.emulateMedia({ colorScheme });
  await page.waitForFunction((dark) => document.documentElement.classList.contains("dark") === dark, colorScheme === "dark");
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  // The root class changes before the shared theme's colour transitions finish.
  await page.waitForTimeout(400);
  await shot(`${name}-${colorScheme}`);
}

function assertKept(set: AlternativeSet, original: string, replacement: string) {
  assert.deepEqual(set.entries.map(({ text, by }) => ({ text, by })), [
    { text: original, by: "owner" }, { text: replacement, by: "kin" },
  ]);
  assert.equal(currentAlternative(set)?.text, original);
  assert.equal(set.anchor.exact, original);
}

test("⌘K acceptance keeps the owner and Kin versions; ⌥⌘[ swaps back (KI-87)", { timeout: 60_000 }, async () => {
  await openAlternativeDoc();
  const before = alternativeDisk();
  await alternativeCursor(ACCEPT);
  await page.keyboard.press("Meta+k");
  await refine().getByRole("option", { name: /^Tighten(?! more)/ }).click();
  const replacement = await completedRewrite();
  assert.notEqual(replacement, ACCEPT);
  assert.equal(alternativeDisk(), before, "the completed rewrite still waits for acceptance");
  await page.keyboard.press("Enter");
  await refine().waitFor({ state: "detached" });
  await alternativeUntil(() => alternativeDisk() === before.replace(ACCEPT, replacement), "only the accepted version reaches Markdown");
  await alternativeUntil(() => currentAlternative(alternativeSet(ACCEPT)!)?.text === replacement, "the replacement and its author are saved");
  const file = savedAlternatives();
  assert.equal(file.version, 1);
  assert.equal(file.path, ALTERNATIVES);
  const set = alternativeSet(ACCEPT)!;
  assert.deepEqual(set.entries.map(({ text, by }) => ({ text, by })), [
    { text: ACCEPT, by: "owner" }, { text: replacement, by: "kin" },
  ]);
  assert.equal(set.anchor.exact, replacement);

  await alternativeCursor(replacement);
  await page.keyboard.press("Meta+Alt+BracketLeft");
  await alternativeUntil(() => alternativeDisk() === before && currentAlternative(alternativeSet(ACCEPT)!)?.text === ACCEPT, "previous swaps back to the owner's original");
  await page.keyboard.press("Meta+Alt+KeyA");
  await altPanel().waitFor();
  assert.equal(await altPanel().locator('.cm-alt-option[aria-current="true"]').textContent(), ACCEPT);
  assert.equal(await kinOptions().locator('svg[data-kin-avatar="placeholder"]').count(), 1);
  await closeAltPanel();
});

test("⇧Enter keeps only the selected completed rewrite without applying it (KI-87)", { timeout: 60_000 }, async () => {
  await openAlternativeDoc();
  const before = alternativeDisk();
  const editorBefore = await altText();
  await alternativeCursor(KEEP);
  await page.keyboard.press("Meta+k");
  await refine().getByRole("option", { name: /^Tighten(?! more)/ }).click();
  const first = await completedRewrite();
  await page.keyboard.press("Meta+r");
  await refine().getByText("2 / 2", { exact: true }).waitFor();
  const selected = await completedRewrite();
  assert.notEqual(selected, first, "the retry is a different version");
  await page.keyboard.press("Shift+Enter");
  await refine().waitFor({ state: "detached" });
  await alternativeUntil(() => alternativeSet(KEEP)?.entries.length === 2, "only the selected rewrite is kept");
  assertKept(alternativeSet(KEEP)!, KEEP, selected);
  assert.equal(alternativeDisk(), before);
  assert.equal(await altText(), editorBefore, "keeping changes neither the editor nor Markdown");
  await page.keyboard.press("Meta+Alt+KeyA");
  await kinOptions().first().waitFor();
  assert.deepEqual(await kinOptions().locator(".cm-alt-option-text").allTextContents(), [selected]);
  await closeAltPanel();
});

test("⇧Enter keeps only the highlighted synonym, leaving the word alone (KI-87)", { timeout: 60_000 }, async () => {
  await openAlternativeDoc();
  const before = alternativeDisk();
  const editorBefore = await altText();
  await alternativeCursor("small", true);
  await page.keyboard.press("Meta+k");
  await refine().getByRole("option", { name: /Synonyms/ }).click();
  await refine().locator(".ki-refine-choice:enabled").first().waitFor({ timeout: 15_000 });
  assert.ok(await refine().locator(".ki-refine-choice").count() > 1);
  await page.keyboard.press("ArrowDown");
  const selected = await refine().locator('.ki-refine-choice[data-selected="true"]').evaluate((el) => {
    const copy = el.cloneNode(true) as HTMLElement;
    copy.querySelector("kbd")?.remove();
    return copy.textContent!.trim();
  });
  await page.keyboard.press("Shift+Enter");
  await refine().waitFor({ state: "detached" });
  await alternativeUntil(() => alternativeSet("small")?.entries.length === 2, "one highlighted synonym, not the whole list");
  const set = alternativeSet("small")!;
  assert.equal(set.level, "word");
  assertKept(set, "small", selected);
  assert.equal(alternativeDisk(), before);
  assert.equal(await altText(), editorBefore);
  await page.keyboard.press("Meta+Alt+KeyA");
  await kinOptions().first().waitFor();
  assert.deepEqual(await kinOptions().locator(".cm-alt-option-text").allTextContents(), [selected]);
  assert.equal(await kinOptions().locator('svg[data-kin-avatar="placeholder"]').count(), 1);
  await closeAltPanel();
});

test("explicit word, sentence and paragraph asks work with automatic suggestions off; nothing auto-applies (KI-87)", { timeout: 90_000 }, async () => {
  await openAlternativeDoc();
  const before = alternativeDisk();
  const editorBefore = await altText();
  const requests = watchAlternativeRequests();
  try {
    await alternativeCursor("good");
    await page.keyboard.press("Meta+Alt+KeyA");
    await altPanel().getByRole("button", { name: "Ask Kin", exact: true }).waitFor();
    assert.deepEqual((await altPanel().getByRole("tab").allTextContents()).map(withoutCount), ["Word", "Sentence", "Paragraph"]);
    assert.equal(await tabLabel(altPanel().getByRole("tab", { selected: true })), "Word");
    assert.equal(await kinOptions().count(), 0);
    // The fresh app's automatic suggestions stay off. Merely opening the
    // panel doesn't ask; the explicit shortcut and button still do.
    await page.waitForTimeout(200);
    assert.deepEqual(requests.levels, []);
    await page.keyboard.press("Meta+Shift+Alt+KeyA");
    await completedAlternatives();
    assert.equal(alternativeDisk(), before);
    assert.equal(await altText(), editorBefore);
    await alternativeShot("13-kin-word-alternatives", "light");
    await alternativeShot("13-kin-word-alternatives", "dark");

    const originals = { word: "good", sentence: ASK.split(". ")[0] + ".", paragraph: ASK };
    for (const [level, tab] of [["sentence", "Sentence"], ["paragraph", "Paragraph"]] as const) {
      await altPanel().getByRole("tab", { name: tab, exact: true }).click();
      assert.equal(await tabLabel(altPanel().getByRole("tab", { selected: true })), tab);
      assert.equal(await altPanel().locator('.cm-alt-option[aria-current="true"] .cm-alt-option-text').textContent(), originals[level]);
      await altPanel().getByRole("button", { name: "Ask Kin", exact: true }).click();
      const thinking = altPanel().getByRole("button", { name: "Thinking…", exact: true });
      await thinking.waitFor();
      assert.equal(await thinking.isDisabled(), true);
      assert.equal(await altPanel().getByRole("listbox").getAttribute("aria-busy"), "true");
      // Repeated explicit asks while one is running must not start another.
      await page.keyboard.press("Meta+Shift+Alt+KeyA");
      await page.keyboard.press("Meta+Shift+Alt+KeyA");
      assert.equal(alternativeDisk(), before, "pending work changes no prose");
      await completedAlternatives();
      assert.equal(alternativeDisk(), before, "completed work changes no prose");
      assert.equal(await altText(), editorBefore);
    }
    assert.deepEqual(requests.levels, ["word", "sentence", "paragraph"], "one request per explicit ask, at the panel's level");
    for (const [level, original] of Object.entries(originals)) {
      await alternativeUntil(() => (alternativeSet(original)?.entries.filter((e) => e.by === "kin").length ?? 0) > 0, `${level} options are saved beside Markdown`);
      const set = alternativeSet(original)!;
      assert.equal(set.level, level);
      assert.equal(currentAlternative(set)?.text, original);
      assert.equal(currentAlternative(set)?.by, "owner");
      assert.equal(set.anchor.exact, original);
      assert.ok(set.entries.slice(1).every((e) => e.by === "kin"));
    }
    await alternativeShot("14-kin-paragraph-alternatives", "light");
    await alternativeShot("14-kin-paragraph-alternatives", "dark");

    const chosen = alternativeSet(ASK)!.entries.find((e) => e.by === "kin")!.text;
    await kinOptions().first().click();
    await alternativeUntil(() => alternativeDisk() === before.replace(ASK, chosen) && currentAlternative(alternativeSet(ASK)!)?.text === chosen, "only picking a version applies it");
    // Cycle with the panel open so its paragraph, not the nested word or
    // sentence set, is the target.
    await altPanel().getByRole("textbox", { name: "Add a version" }).press("Meta+Alt+BracketLeft");
    await alternativeUntil(() => alternativeDisk() === before && currentAlternative(alternativeSet(ASK)!)?.text === ASK, "the owner's paragraph is still one previous-cycle away");
    await closeAltPanel();
  } finally {
    requests.stop();
    await page.emulateMedia({ colorScheme: "light" });
  }
});

test("⇧⌥⌘A on a selected phrase asks for that selection without applying (KI-87)", { timeout: 60_000 }, async () => {
  await openAlternativeDoc();
  const before = alternativeDisk();
  const editorBefore = await altText();
  await alternativeCursor("in order to", true);
  await page.keyboard.press("Meta+Shift+Alt+KeyA");
  await completedAlternatives();
  assert.equal(await tabLabel(altPanel().getByRole("tab", { selected: true })), "Selection");
  assert.equal(await altPanel().locator('.cm-alt-option[aria-current="true"] .cm-alt-option-text').textContent(), "in order to");
  await alternativeUntil(() => (alternativeSet("in order to")?.entries.length ?? 0) > 1, "the selection's alternatives are persisted");
  const set = alternativeSet("in order to")!;
  assert.equal(set.level, "phrase");
  assert.equal(currentAlternative(set)?.text, "in order to");
  assert.ok(set.entries.slice(1).every((e) => e.by === "kin"));
  assert.equal(alternativeDisk(), before);
  assert.equal(await altText(), editorBefore);
  await closeAltPanel();
});

test("saved Kin attribution and unapplied alternatives survive a reload (KI-87)", { timeout: 60_000 }, async () => {
  const before = alternativeDisk();
  await alternativeUntil(() => savedAlternatives().sets.length === 7, "all seven spans are saved before reload");
  const entries = alternativeSet("good")!.entries;
  await page.reload();
  await openAlternativeDoc();
  await alternativeCursor("good");
  await page.keyboard.press("Meta+Alt+KeyA");
  await kinOptions().first().waitFor();
  assert.deepEqual(await altPanel().locator(".cm-alt-option-text").allTextContents(), entries.map((e) => e.text));
  assert.equal(await kinOptions().locator('svg[data-kin-avatar="placeholder"]').count(), entries.filter((e) => e.by === "kin").length);
  assert.equal(await altPanel().locator('.cm-alt-option[aria-current="true"]').getAttribute("data-by"), "owner");
  assert.equal(alternativeDisk(), before);
  await closeAltPanel();
});

test("switching documents drops a pending answer and permits a new ask on return (KI-87)", { timeout: 60_000 }, async () => {
  await openAlternativeDoc();
  const before = alternativeDisk();
  const otherBefore = disk();
  const requests = watchAlternativeRequests();
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  let first = true;
  const holdFirstAsk = async (route: Route) => {
    const body = route.request().postDataJSON();
    if (first && body?.cmd === "ai_stream") {
      first = false;
      // Delay forwarding this one real model request, not its answer or
      // the editor API. Other commands still reach the real registry.
      await gate;
    }
    await route.continue();
  };
  await page.route("**/invoke", holdFirstAsk);
  try {
    await alternativeCursor("quiet");
    const pending = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/invoke") && r.postDataJSON()?.cmd === "ai_stream");
    await page.keyboard.press("Meta+Shift+Alt+KeyA");
    const request = await pending;
    await altPanel().getByRole("button", { name: "Thinking…", exact: true }).waitFor();
    await page.locator(`[title="${DOC}"]`).click();
    await page.locator(`[title="${DOC}"][data-active="true"]`).waitFor();
    await line("The repair is").waitFor();
    await page.getByRole("tabpanel", { name: "Stash", exact: true }).waitFor();
    assert.equal(await kinOptions().count(), 0, "the margin follows the new draft, not the pending span");
    await openAlternativeDoc(true);
    // Restoring the cached EditorState clears its abandoned pending flag.
    await altPanel().getByRole("button", { name: "Ask Kin", exact: true }).waitFor();
    assert.equal(await altPanel().getByRole("button", { name: "Ask Kin", exact: true }).isEnabled(), true);
    assert.equal(await kinOptions().count(), 0);
    const replied = page.waitForResponse((response) => response.request() === request);
    release();
    await (await replied).finished();
    // This word's scripted answer streams in one 40 ms chunk. Give the
    // real SSE channel time to deliver it after the document was restored.
    await page.waitForTimeout(500);
    assert.equal(await kinOptions().count(), 0, "the abandoned answer cannot land in the restored state");
    assert.equal(alternativeSet("quiet"), undefined);
    assert.equal(alternativeDisk(), before);
    assert.equal(disk(), otherBefore);

    await altPanel().getByRole("button", { name: "Ask Kin", exact: true }).click();
    await completedAlternatives();
    assert.deepEqual(requests.levels, ["word", "word"], "a fresh request is allowed after returning");
    await alternativeUntil(() => (alternativeSet("quiet")?.entries.length ?? 0) > 1, "only the new ask is kept");
    assert.equal(currentAlternative(alternativeSet("quiet")!)?.text, "quiet");
    assert.equal(alternativeDisk(), before);
    await closeAltPanel();
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
    requests.stop();
  }
});

test("a smaller word selected inside a word's phrase version gets its own alternatives (KI-87)", { timeout: 60_000 }, async () => {
  await openAlternativeDoc();
  await alternativeCursor("good");
  await page.keyboard.press("Meta+Alt+KeyA");
  const input = altPanel().getByRole("textbox", { name: "Add a version" });
  await input.fill("very good");
  await input.press("Enter");
  await alternativeUntil(() => alternativeDisk().includes(ASK.replace("good", "very good")), "the existing word set can show a phrase");
  await closeAltPanel();
  const before = alternativeDisk();
  await alternativeUntil(() => savedAlternatives().sets.some((s) => s.level === "word" && s.anchor.exact === "very good"), "the containing set is saved before selecting inside it");
  const outer = savedAlternatives().sets.find((s) => s.level === "word" && s.anchor.exact === "very good")!;
  await alternativeCursor("good", true);
  await page.keyboard.press("Meta+Shift+Alt+KeyA");
  await completedAlternatives();
  assert.equal(await tabLabel(altPanel().getByRole("tab", { selected: true })), "Word");
  assert.equal(await altPanel().locator('.cm-alt-option[aria-current="true"] .cm-alt-option-text').textContent(), "good", "the selected word, not the containing phrase");
  await alternativeUntil(() => savedAlternatives().sets.some((s) => s.id !== outer.id && s.anchor.exact === "good"), "the smaller exact range gets its own set");
  const smaller = savedAlternatives().sets.find((s) => s.id !== outer.id && s.anchor.exact === "good")!;
  assert.equal(alternativeDisk(), before, "asking about the smaller selection applies nothing");
  await closeAltPanel();

  await alternativeCursor("good", true);
  await page.keyboard.press("Meta+k");
  await refine().getByRole("option", { name: /Synonyms/ }).click();
  await refine().locator(".ki-refine-choice:enabled").first().waitFor({ timeout: 15_000 });
  const chosen = await refine().locator('.ki-refine-choice[data-selected="true"]').evaluate((el) => {
    const copy = el.cloneNode(true) as HTMLElement;
    copy.querySelector("kbd")?.remove();
    return copy.textContent!.trim();
  });
  assert.equal(alternativeDisk(), before);
  await page.keyboard.press("Enter");
  await refine().waitFor({ state: "detached" });
  await alternativeUntil(() => alternativeDisk() === before.replace("very good", `very ${chosen}`), "accepting replaces only the smaller word");
  await alternativeUntil(() => savedAlternatives().sets.some((s) => s.id !== outer.id && s.anchor.exact === chosen), "the smaller exact range is stored separately");
  const inner = savedAlternatives().sets.find((s) => s.id !== outer.id && s.anchor.exact === chosen)!;
  assert.equal(inner.level, "word");
  assert.equal(inner.id, smaller.id, "Refine reuses the exact smaller set, not its enclosing phrase");
  assert.equal(inner.entries.filter((e) => e.by === "owner").length, 1);
  assert.equal(inner.entries.find((e) => e.by === "owner")?.text, "good");
  assert.ok(smaller.entries.every((e) => inner.entries.some((saved) => saved.id === e.id)), "the earlier asked versions are retained");
  assert.equal(currentAlternative(inner)?.text, chosen);
  assert.equal(currentAlternative(inner)?.by, "kin");
  await page.keyboard.press("Meta+Alt+BracketLeft");
  await alternativeUntil(() => alternativeDisk() === before && currentAlternative(savedAlternatives().sets.find((s) => s.id === inner.id)!)?.text === "good", "the smaller word swaps back without losing the rest of the phrase");
});

test("a read-only mirror refuses Kin alternatives and swaps (KI-87)", { timeout: 60_000 }, async () => {
  await page.locator(`[title="${MIRROR}"]`).click();
  await page.locator(`[title="${MIRROR}"][data-active="true"]`).waitFor();
  const before = readFileSync(resolve(app.vault, MIRROR), "utf8");
  const sidecar = existsSync(alternativeStore(MIRROR)) ? readFileSync(alternativeStore(MIRROR), "utf8") : null;
  const editorBefore = await altText();
  const requests = watchAlternativeRequests();
  try {
    await alternativeCursor("repair");
    await page.keyboard.press("Meta+Shift+Alt+KeyA");
    await page.waitForTimeout(250);
    assert.equal(await altPanel().count(), 0, "a direct ask is refused");
    await page.keyboard.press("Meta+Alt+KeyA");
    await altPanel().waitFor();
    assert.equal(await altPanel().getByRole("textbox", { name: "Add a version" }).isDisabled(), true);
    assert.equal(await altPanel().getByRole("button", { name: "Ask Kin", exact: true }).isDisabled(), true);
    await page.keyboard.press("Meta+Shift+Alt+KeyA");
    await page.keyboard.press("Meta+Alt+BracketRight");
    await page.waitForTimeout(250);
    assert.deepEqual(requests.levels, [], "no model request for a read-only passage");
    assert.equal(await kinOptions().count(), 0);
    assert.equal(readFileSync(resolve(app.vault, MIRROR), "utf8"), before);
    assert.equal(await altText(), editorBefore);
    assert.equal(existsSync(alternativeStore(MIRROR)) ? readFileSync(alternativeStore(MIRROR), "utf8") : null, sidecar);
    await closeAltPanel();
  } finally {
    requests.stop();
  }
});
