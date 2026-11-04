// KI-101: keep one draft/editor alive while other surfaces take focus.
// A fresh open before each shortcut would hide the reported failure.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, test, type TestContext } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { openApp, startApp, type App } from "./headless-app.ts";

const DOC = "drafts/transitions.md";
const TEXT = "The repair is really very visible, and that is the point.";
const SCHEME = process.env.KINTSUGI_COLOR_SCHEME === "dark" ? "dark" : "light";
let app: App;
let browser: Browser;
let page: Page;

before(async () => {
  app = await startApp("ki101", { KINTSUGI_HEADLESS_KIN: "mock" }, (vault) => {
    const rest = Array.from({ length: 80 }, (_, i) => `Paragraph ${i + 1} stays in the draft while another surface is open.`).join("\n\n");
    writeFileSync(resolve(vault, DOC), `---\ntitle: "Transitions"\nstatus: draft\n---\n\n${TEXT}\n\n${rest}\n`);
  });
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 820 }, colorScheme: SCHEME });
  page.setDefaultTimeout(10_000);
  await openApp(page, app.url, app.output);
  await page.locator(`[title="${DOC}"]`).click();
  await page.locator(".cm-line", { hasText: TEXT }).waitFor();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}, { timeout: Number(process.env.KINTSUGI_RUNTIME_TIMEOUT ?? 15 * 60_000) });

after(async () => {
  await browser?.close();
  await app?.stop();
});

/** Stop a matrix at its first failure instead of cascading through an open popup. */
async function step(t: TestContext, name: string, run: () => Promise<void>) {
  let failure: unknown;
  await t.test(name, async () => {
    try { await run(); }
    catch (error) { failure = error; throw error; }
  });
  if (failure) throw failure;
}

const refine = () => page.locator(".ki-refine-popup");
const selectionMenu = () => page.getByRole("menu", { name: "Selection", exact: true });
const shortcuts = () => page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true });
const settings = () => page.getByRole("region", { name: "Settings", exact: true });
const kin = () => page.getByRole("region", { name: "Kin", exact: true });

async function escape(surface: ReturnType<typeof refine>) {
  // Visibility isn't keyboard readiness. Menus and composers hand off focus
  // after mounting; an early Escape goes to the editor's simplifySelection.
  await surface.and(page.locator(":focus-within")).waitFor();
  await page.keyboard.press("Escape");
  await surface.waitFor({ state: "detached" });
}

async function closeSelectionMenu() {
  await escape(selectionMenu());
  assert.equal(await page.evaluate(() => getSelection()?.toString()), "visible", "the menu preserves the selection");
}

// A real mouse selection, not an app-state hook. Selecting one word also
// makes all direct edits (including Synonyms) applicable.
async function select(selected = true) {
  await page.locator(".cm-scroller").evaluate((el) => { el.scrollTop = 0; });
  const line = page.locator(".cm-line", { hasText: TEXT });
  await line.scrollIntoViewIfNeeded();
  const at = await line.evaluate((line) => {
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const at = node.textContent!.indexOf("visible");
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + "visible".length);
      const box = range.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2, left: box.left };
    }
    throw new Error("The test word is missing");
  });
  if (selected) {
    await page.mouse.dblclick(at.x, at.y);
    await page.waitForFunction(() => getSelection()?.toString() === "visible");
  } else {
    await page.mouse.click(at.x, at.y);
    await page.waitForFunction(() => getSelection()?.isCollapsed);
  }
  return at;
}

const transitions: { name: string; run: () => Promise<void> }[] = [
  { name: "About you", run: async () => {
    await page.locator("[data-sidebar=footer]").getByRole("button", { name: "About you", exact: true }).click();
    const about = page.getByRole("dialog", { name: "About you", exact: true });
    await about.getByRole("tab", { name: "History", exact: true }).click();
    await escape(about);
  } },
  { name: "Settings Appearance", run: async () => {
    await page.keyboard.press("Meta+Comma");
    await settings().getByRole("button", { name: "Appearance", exact: true }).click();
    await settings().getByRole("heading", { name: "Appearance", level: 1 }).waitFor();
    await settings().getByRole("radio", { name: SCHEME === "dark" ? "Light" : "Dark", exact: true }).click();
    await settings().getByRole("button", { name: "Larger text", exact: true }).click();
    await settings().getByRole("button", { name: "Smaller text", exact: true }).click();
    await settings().getByRole("radio", { name: "System", exact: true }).click();
    await escape(settings());
  } },
  { name: "shortcuts list", run: async () => {
    await page.keyboard.press("Meta+Shift+Slash");
    await shortcuts().getByRole("textbox").fill("tight");
    await escape(shortcuts());
  } },
  { name: "selection menu", run: async () => {
    await page.keyboard.press("Shift+F10");
    await closeSelectionMenu();
  } },
  { name: "right-click selection menu", run: async () => {
    const at = await select();
    await page.mouse.click(at.x, at.y, { button: "right" });
    await closeSelectionMenu();
  } },
  { name: "alternatives", run: async () => {
    await page.keyboard.press("Meta+Alt+KeyA");
    await page.getByRole("textbox", { name: "Add an alternative" }).and(page.locator(":focus")).waitFor();
    await escape(page.locator(".cm-alt-panel"));
  } },
  { name: "dim and undo", run: async () => {
    await page.keyboard.press("Meta+Slash");
    await page.locator(".cm-dimmed").waitFor();
    await page.keyboard.press("Meta+z");
    await page.locator(".cm-dimmed").waitFor({ state: "detached" });
  } },
  { name: "held Command", run: async () => {
    await page.keyboard.down("Meta");
    await shortcuts().waitFor();
    await page.keyboard.up("Meta");
    await shortcuts().waitFor({ state: "detached" });
  } },
  { name: "Kin chat", run: async () => {
    await page.keyboard.press("Meta+j");
    await kin().getByRole("textbox", { name: "Message Kin" }).waitFor();
    await page.keyboard.press("Meta+j");
    await kin().waitFor({ state: "detached" });
  } },
  { name: "comment composer", run: async () => {
    await page.keyboard.press("Meta+k");
    await refine().getByRole("option", { name: /Discuss this paragraph/ }).click();
    await page.getByRole("textbox", { name: "Ask Kin about this paragraph" }).waitFor();
    await escape(page.locator(".cm-comment-popover"));
  } },
  { name: "palette", run: async () => {
    await page.keyboard.press("Meta+p");
    const palette = page.getByRole("dialog", { name: "Jump to a document", exact: true });
    await palette.waitFor();
    await escape(palette);
  } },
  ...["Feed", "Ideas", "Inspiration"].map((name) => ({ name: `${name} and back`, run: async () => {
    await page.locator("[data-sidebar=sidebar]").getByRole("button", { name, exact: true }).click();
    await page.locator(".cm-content").waitFor({ state: "hidden" });
    await page.locator(`[title="${DOC}"]`).click();
    await page.locator(".cm-content").waitFor({ state: "visible" });
  } })),
  { name: "cancelled Refine", run: async () => {
    await page.keyboard.press("Meta+k");
    await refine().getByRole("option", { name: /Tighten/ }).waitFor();
    await escape(refine());
  } },
  { name: "cancelled direct edit", run: async () => {
    await page.keyboard.press("Meta+Alt+KeyT");
    await refine().getByText("Tighten", { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector(".ki-refine-popup")?.contains(document.activeElement));
    await escape(refine());
  } },
];

test("⌘K still opens on the same selection after another surface closes", { timeout: 180_000 }, async (t) => {
  const editor = await page.locator(".cm-content").elementHandle();
  assert.ok(editor);
  await select();
  await page.keyboard.press("Meta+k");
  await refine().getByRole("option", { name: /Tighten/ }).waitFor();
  await escape(refine());
  for (const selected of [true, false]) {
    for (const transition of transitions) {
      await step(t, `${transition.name} (${selected ? "selection" : "cursor"})`, async () => {
        await select(selected);
        // Selection-only surfaces still start on a selected word.
        if (!selected && transition.name.includes("selection menu")) await select();
        await transition.run();
        assert.ok(await editor.evaluate((el) => el.isConnected), "the draft was not reopened");
        // Deliberately no click/focus/openDoc here: test the state left behind.
        await page.keyboard.press("Meta+k");
        await refine().getByRole("option", { name: /Tighten/ }).waitFor();
        await escape(refine());
      });
    }
  }
  await page.screenshot({ path: resolve(app.shots, `${SCHEME}-after-transitions.png`) });
});

test("⌘K and direct edits remain on screen after scrolling away and closing the palette", { timeout: 60_000 }, async () => {
  for (const [key, label] of [["Meta+k", null], ...edits.map(([key, label]) => [`Meta+Alt+${key}`, label])] as const) {
    const word = await select();
    await page.locator(".cm-scroller").evaluate((el) => { el.scrollTop = 700; });
    await page.keyboard.press("Meta+p");
    const palette = page.getByRole("dialog", { name: "Jump to a document", exact: true });
    await palette.waitFor();
    await escape(palette);
    await page.keyboard.press(key);
    if (label) await refine().getByText(label, { exact: true }).waitFor();
    else await refine().getByRole("option", { name: /Tighten/ }).waitFor();
    // Visibility alone passes for a popup wholly outside the viewport.
    await page.screenshot({ path: resolve(app.shots, `${SCHEME}-scrolled-${label ?? "refine"}.png`), animations: "disabled" });
    const bounds = await refine().boundingBox();
    assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= page.viewportSize()!.height + 1, `${key} is on screen: ${JSON.stringify(bounds)}`);
    assert.ok(Math.abs(bounds.x - word.left) < 4, `${key} stays anchored to the passage, not (0, 0)`);
    await escape(refine());
    assert.equal(await page.evaluate(() => getSelection()?.toString()), "visible", "the selected text is unchanged");
  }
});

test("Refine reveals the end of a selection taller than the editor", { timeout: 30_000 }, async () => {
  await select();
  await page.keyboard.press("Home");
  for (let i = 0; i < 36; i++) await page.keyboard.press("Shift+ArrowDown");
  await page.locator(".cm-scroller").evaluate((el) => { el.scrollTop = 0; });
  await page.keyboard.press("Meta+p");
  const palette = page.getByRole("dialog", { name: "Jump to a document", exact: true });
  await palette.waitFor();
  await escape(palette);
  await page.keyboard.press("Meta+k");
  await refine().getByRole("option", { name: /Tighten/ }).waitFor();
  await page.screenshot({ path: resolve(app.shots, `${SCHEME}-long-selection.png`), animations: "disabled" });
  const bounds = await refine().boundingBox();
  assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= page.viewportSize()!.height + 1, `Refine is on screen: ${JSON.stringify(bounds)}`);
  await escape(refine());
});

const edits = [
  ["KeyT", "Tighten"],
  ["KeyR", "Rephrase"],
  ["KeyP", "Simplify"],
  ["KeyF", "Fix grammar and spelling"],
  ["KeyS", "Synonyms"],
] as const;

test("the direct edits and editor shortcuts still work through the same transitions", { timeout: 240_000 }, async (t) => {
  for (const transition of transitions) {
    await step(t, transition.name, async () => {
      for (const [key, label] of edits) {
        await select();
        await transition.run();
        await page.keyboard.press(`Meta+Alt+${key}`);
        await refine().getByText(label, { exact: true }).waitFor();
        await page.waitForFunction(() => document.querySelector(".ki-refine-popup")?.contains(document.activeElement));
        await escape(refine());
      }
      // These keys belong to the editor, unlike the app-wide direct edits.
      // Refine's dismissal returns focus there; no fresh document is opened.
      await page.keyboard.press("Meta+Slash");
      await page.locator(".cm-dimmed").waitFor();
      await page.keyboard.press("Meta+z");
      await page.locator(".cm-dimmed").waitFor({ state: "detached" });
      await page.keyboard.press("Meta+Alt+KeyA");
      await page.getByRole("textbox", { name: "Add an alternative" }).and(page.locator(":focus")).waitFor();
      await escape(page.locator(".cm-alt-panel"));
      await page.keyboard.press("Meta+j");
      await kin().getByRole("textbox", { name: "Message Kin" }).waitFor();
      await page.keyboard.press("Meta+j");
      await kin().waitFor({ state: "detached" });
      await select();
      await page.keyboard.press("Shift+F10");
      await closeSelectionMenu();
      assert.equal(await page.locator(".cm-line", { hasText: TEXT }).textContent(), TEXT, "cancelled edits leave the passage unchanged");
    });
  }
});
