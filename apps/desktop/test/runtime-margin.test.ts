// KI-103 against the real runtime: `pnpm desktop:headless` (the real Rust
// command registry on Tauri MockRuntime, and the real React app) driven by
// headless Chromium, in a fresh scratch vault and config.
//
// The draft keeps a fixed measure: opening or closing the right margin
// (Kin / References / Stash) never moves or re-wraps a line. Below about
// 1320 px opening it folds the sidebar to icons first; the column then slides
// as a whole and still never re-wraps. The tabs work by mouse and keyboard,
// every Kin entry point opens the margin's Kin tab, and the floating chat
// box and the old reference margin are gone. The window chrome follows
// macOS full screen. Screenshots, light and dark, go to .headless/<run>/shots/.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { openApp, startApp, type App } from "./headless-app.ts";

const TIMEOUT = Number(process.env.KINTSUGI_RUNTIME_TIMEOUT ?? 15 * 60_000);
const DRAFT = "drafts/kintsugi-and-gold.md";

let app: App;
let browser: Browser;
let page: Page;

before(async () => {
  app = await startApp("ki103", {});
  browser = await chromium.launch({ headless: true }).catch((e) => {
    throw new Error(`${e}\nInstall it with: pnpm --filter @kintsugi/desktop exec playwright install chromium-headless-shell`);
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
  await openApp(page, app.url, app.output);
}, { timeout: TIMEOUT });

after(async () => {
  await browser?.close();
  await app?.stop();
});

const shot = (name: string) => page.screenshot({ path: resolve(app.shots, `${name}.png`) });
const margin = () => page.getByRole("complementary", { name: "Margin" });
const marginButton = () => page.getByRole("button", { name: "Margin", exact: true });
const tab = (name: string) => margin().getByRole("tab", { name });
const sidebar = () => page.locator("[data-slot=sidebar]").first();
const kin = () => page.getByRole("region", { name: "Kin" });

/** Lets the margin's slide and the sidebar's fold finish: every CSS
 *  transition has ended (a slow machine takes longer than the 240 ms). */
async function settle() {
  // Two frames: React has committed, effects (the fold) have run, and the
  // browser has started any transition they cause.
  for (let i = 0; i < 2; i++) await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await page.waitForFunction(() => document.getAnimations().every((a) => !(a instanceof CSSTransition) || a.playState !== "running"));
  await page.waitForTimeout(50);
}

async function openDoc(path: string) {
  await page.locator(`[title="${path}"]`).click();
  await page.locator(`[title="${path}"][data-active="true"]`).waitFor();
  await page.locator(".cm-line").first().waitFor();
}

async function isOpen() {
  return (await page.locator("aside.ki-margin").getAttribute("data-open")) !== null;
}

/** Visible character boxes, independent of decoration-created DOM spans.
 * Opening versions can split one text node without moving any words. */
async function rects() {
  return page.evaluate(() => {
    const out: number[][] = [];
    for (const line of document.querySelectorAll(".cm-content .cm-line")) {
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.parentElement?.closest(".cm-alt-count, .cm-alt-gutter")) continue;
        for (let i = 0; i < (node.textContent?.length ?? 0); i++) {
          const range = document.createRange();
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          for (const r of range.getClientRects()) {
            if (r.bottom < 0 || r.top > window.innerHeight || r.width === 0) continue;
            out.push([r.left, r.top, r.width]);
          }
        }
      }
    }
    return out;
  });
}

const half = (n: number) => Math.round(n * 2) / 2;

/** Where every line box sits, to the half pixel. */
async function lineBoxes() {
  return (await rects()).map(([x, y, w]) => `${half(x)},${half(y)},${half(w)}`);
}

/** The same, relative to the column's left edge: where each line wraps. */
async function wraps() {
  const left = await page.evaluate(() => document.querySelector(".cm-content")!.getBoundingClientRect().left);
  return (await rects()).map(([x, y, w]) => `${Math.round(x - left)},${half(y)},${Math.round(w)}`);
}

async function textRight() {
  return page.evaluate(() => {
    const line = document.querySelector(".cm-content .cm-line") as HTMLElement;
    return line.getBoundingClientRect().right - parseFloat(getComputedStyle(line).paddingRight);
  });
}

/** Opens the margin on each tab in turn, then closes it with ⌥⌘\, checking
 *  the draft's lines against `same` each time. */
async function everyTab(label: string, same: () => Promise<void>, folds: boolean) {
  for (const name of ["References", "Kin", "Stash"]) {
    if (name === "References") await page.keyboard.press("Meta+Shift+r");
    else await tab(name).click();
    await settle();
    assert.ok(await isOpen(), `${label}: open on ${name}`);
    assert.equal(await tab(name).getAttribute("aria-selected"), "true");
    await same();
    // The margin sits beside the text, never over it.
    assert.ok((await margin().boundingBox())!.x >= (await textRight()), `${label}: the margin clears the text`);
    assert.equal(await sidebar().getAttribute("data-state"), folds ? "collapsed" : "expanded", `${label}: the sidebar`);
  }
  await shot(`01-${label}-open`);
  await page.keyboard.press("Meta+Alt+Backslash");
  await settle();
  assert.equal(await isOpen(), false);
  await same();
}

test("opening the margin never moves or re-wraps a line, at 1440, 1360 and 1280", { timeout: 180_000 }, async () => {
  await openDoc(DRAFT);
  await page.locator(".cm-line", { hasText: "The first time I saw a kintsugi bowl" }).click();

  // 1440: the margin fits beside the draft with the sidebar open. Every
  // line box stays exactly where it was.
  await page.setViewportSize({ width: 1440, height: 900 });
  await settle();
  assert.equal(await isOpen(), false, "closed to start");
  let before = await lineBoxes();
  assert.ok(before.length > 10, `enough lines to compare (${before.length})`);
  await everyTab("1440", async () => assert.deepEqual(await lineBoxes(), before, "1440: no line moved"), false);

  // KI-107: just above the folding threshold. Reading the content box
  // instead of the line's text area would fold the sidebar too early.
  await page.setViewportSize({ width: 1360, height: 900 });
  await settle();
  before = await lineBoxes();
  await everyTab("1360", async () => assert.deepEqual(await lineBoxes(), before, "1360: no line moved"), false);

  // 1280 with the sidebar as icons (⌘\): the margin fits; nothing moves.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.keyboard.press("Meta+Backslash");
  await page.locator("[data-slot=sidebar][data-state=collapsed]").waitFor();
  await settle();
  before = await lineBoxes();
  await everyTab("1280-rail", async () => assert.deepEqual(await lineBoxes(), before, "1280, rail: no line moved"), true);
  await page.keyboard.press("Meta+Backslash");
  await page.locator("[data-slot=sidebar][data-state=expanded]").waitFor();
  await settle();

  // 1280 with the sidebar open: the margin needs the sidebar's room, so it
  // folds the sidebar to icons and the column slides left as a whole. Every
  // line keeps its wrap, width and height; closing the margin brings the
  // sidebar and the column back exactly.
  before = await lineBoxes();
  const shape = await wraps();
  await page.keyboard.press("Meta+Shift+r");
  await settle();
  assert.equal(await sidebar().getAttribute("data-state"), "collapsed", "folded to icons");
  assert.deepEqual(await wraps(), shape, "1280: the column slid; no line re-wrapped");
  const shifts = new Set((await lineBoxes()).map((box, i) => Math.round(Number(box.split(",")[0]) - Number(before[i].split(",")[0]))));
  assert.equal(shifts.size, 1, `one shift for every line (${[...shifts]})`);
  assert.ok((await margin().boundingBox())!.x >= (await textRight()), "the margin clears the text");
  await shot("02-1280-folded");
  await page.keyboard.press("Meta+Shift+r");
  await settle();
  assert.equal(await sidebar().getAttribute("data-state"), "expanded", "closing it gives the sidebar back");
  assert.deepEqual(await lineBoxes(), before);

  // Narrower than the margin can ever fit beside: it covers the page's
  // right edge, and still no line re-wraps.
  await page.setViewportSize({ width: 800, height: 900 });
  await settle();
  const narrow = await wraps();
  await marginButton().click();
  await settle();
  assert.deepEqual(await wraps(), narrow, "overlaid, not re-wrapped");
  await shot("03-800-overlay");
  await marginButton().click();
  await settle();
  await page.setViewportSize({ width: 1440, height: 900 });
  await settle();
});

test("the tabs work by keyboard, and the choice is kept across a reload", { timeout: 120_000 }, async () => {
  await page.locator(".cm-line", { hasText: "The first time I saw a kintsugi bowl" }).click();
  await page.keyboard.press("Meta+Shift+r");
  await tab("References").waitFor();
  await margin().getByRole("heading", { name: "Referenced here" }).waitFor();
  // ⇧⌘S shows the stash; pressing it again closes the margin.
  await page.keyboard.press("Meta+Shift+s");
  await margin().getByText("Nothing stashed yet.").waitFor();
  await page.keyboard.press("Meta+Shift+s");
  await settle();
  assert.equal(await isOpen(), false);
  // ⌥⌘\ brings back the last tab; arrows move between the tabs, Enter picks.
  await page.keyboard.press("Meta+Alt+Backslash");
  await settle();
  assert.equal(await tab("Stash").getAttribute("aria-selected"), "true");
  await tab("Stash").focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Enter");
  assert.equal(await tab("References").getAttribute("aria-selected"), "true");
  await page.reload();
  await page.locator(".cm-line").first().waitFor();
  await settle();
  assert.ok(await isOpen(), "still open after a reload");
  assert.equal(await tab("References").getAttribute("aria-selected"), "true");
  // Reduced motion: no slide, a short fade only.
  const motion = () => page.evaluate(() => {
    const style = getComputedStyle(document.querySelector("aside.ki-margin")!);
    return { transform: style.transform, transition: style.transitionProperty };
  });
  assert.match((await motion()).transition, /transform/, "it slides");
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal((await motion()).transform, "none");
  assert.doesNotMatch((await motion()).transition, /transform/, "no slide under reduced motion");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  // Escape inside the margin closes it and puts focus back in the draft.
  await tab("References").focus();
  await page.keyboard.press("Escape");
  await settle();
  assert.equal(await isOpen(), false);
  assert.ok(await page.evaluate(() => document.activeElement?.classList.contains("cm-content")), "focus is back in the draft");
});

test("every Kin entry point opens the margin's Kin tab; the floating box and the old margin are gone", { timeout: 180_000 }, async () => {
  assert.equal(await page.getByRole("dialog", { name: "Kin" }).count(), 0, "no floating chat box");
  assert.equal(await page.getByRole("complementary", { name: "Reference margin" }).count(), 0, "no old reference margin");

  // The avatar.
  await page.getByRole("button", { name: "Ask Kin" }).click();
  await kin().waitFor();
  assert.equal(await tab("Kin").getAttribute("aria-selected"), "true");
  await page.getByRole("button", { name: "Hide Kin" }).click();
  await kin().waitFor({ state: "detached" });

  // ⌘J, with the selection coming along as a chip.
  await page.locator(".cm-line", { hasText: "The first time I saw a kintsugi bowl" }).click({ clickCount: 3 });
  await page.keyboard.press("Meta+j");
  await kin().getByLabel("Context").locator('[data-chip^="paragraph:"]').waitFor();
  await settle();
  await shot("04-kin-tab-light");
  await page.emulateMedia({ colorScheme: "dark" });
  await settle();
  await shot("04-kin-tab-dark");
  await page.keyboard.press("Meta+Shift+r");
  await settle();
  await shot("05-references-dark");
  await page.emulateMedia({ colorScheme: "light" });
  await shot("05-references-light");
  await page.keyboard.press("Meta+j");
  await kin().waitFor();
  await page.keyboard.press("Meta+j");
  await settle();
  assert.equal(await isOpen(), false);

  // The selection menu's Ask Kin (discuss()).
  await page.locator(".cm-line", { hasText: "The first time I saw a kintsugi bowl" }).click({ clickCount: 3 });
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: /Ask Kin/ }).click();
  await kin().getByLabel("Context").locator('[data-chip^="paragraph:"]').waitFor();
  await page.keyboard.press("Meta+j");
  await settle();

  // Away from the editor: Feed, Inspiration, Ideas and Settings have the
  // same margin with only the Kin tab, opened by ⌘J and the avatar.
  for (const [name, key] of [["Feed", "Meta+Shift+f"], ["Inspiration", "Meta+Shift+i"], ["Ideas", "Meta+Shift+e"], ["Settings", "Meta+,"]] as const) {
    await page.keyboard.press(key);
    await settle();
    assert.equal(await isOpen(), false, `${name}: closed`);
    if (name === "Settings") await page.keyboard.press("Meta+j");
    else await page.getByRole("button", { name: "Ask Kin" }).click();
    await kin().waitFor();
    assert.equal(await margin().getByRole("tab").count(), 1, `${name}: one tab`);
    await tab("Kin").waitFor();
    await settle();
    // The avatar steps aside for the composer.
    assert.equal(await page.getByRole("button", { name: /^(Ask|Hide) Kin$/ }).count(), 0, `${name}: no avatar over the margin`);
    await shot(`06-${name.toLowerCase()}-light`);
    await page.emulateMedia({ colorScheme: "dark" });
    await settle();
    await shot(`06-${name.toLowerCase()}-dark`);
    await page.emulateMedia({ colorScheme: "light" });
    await page.keyboard.press("Meta+j");
    await settle();
    assert.equal(await isOpen(), false);
    if (name === "Settings") await page.keyboard.press("Escape");
  }
  await openDoc(DRAFT);
});

/** Where macOS puts the traffic lights in a window with an overlay title
 *  bar, generously: nothing he clicks may sit there. */
const LIGHTS = { x: 0, y: 0, width: 84, height: 34 };

async function controlsUnderLights() {
  return page.evaluate((lights) => {
    const hit: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("button, a, input, textarea, [role=tab]")) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || getComputedStyle(el).visibility === "hidden") continue;
      if (r.left < lights.x + lights.width && r.top < lights.y + lights.height && r.right > lights.x && r.bottom > lights.y) hit.push(el.getAttribute("aria-label") ?? el.textContent ?? el.tagName);
    }
    return hit;
  }, LIGHTS);
}

async function fullscreen(on: boolean) {
  await page.evaluate((on) => {
    document.documentElement.dataset.headlessFullscreen = String(on);
    window.dispatchEvent(new Event("resize"));
  }, on);
  await page.waitForFunction((on) => document.documentElement.dataset.fullscreen === String(on), on);
  await settle();
}

test("windowed, nothing sits under the traffic lights; in full screen their strip closes", { timeout: 180_000 }, async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openDoc(DRAFT);
  const geometry = () => page.evaluate(() => ({
    header: document.querySelector("[data-sidebar=header]")!.getBoundingClientRect().height,
    trigger: document.querySelector("[data-sidebar=trigger]")!.getBoundingClientRect().top,
    title: document.querySelector(".cm-content .cm-line:not(.cm-frontmatter)")!.getBoundingClientRect().top,
    toggle: document.querySelector(".ki-margin-toggle")!.getBoundingClientRect().top,
    tabs: document.querySelector(".ki-margin-list")!.getBoundingClientRect().top,
  }));

  for (const collapsed of [false, true]) {
    if (collapsed) {
      await page.keyboard.press("Meta+Backslash");
      await page.locator("[data-slot=sidebar][data-state=collapsed]").waitFor();
    }
    for (const open of [false, true]) {
      if (open) await page.keyboard.press("Meta+Shift+r");
      await settle();
      await fullscreen(false);
      assert.deepEqual(await controlsUnderLights(), [], `windowed, sidebar ${collapsed ? "rail" : "open"}, margin ${open ? "open" : "closed"}`);
      const windowed = await geometry();
      await shot(`07-windowed-${collapsed ? "rail" : "sidebar"}-${open ? "margin" : "plain"}`);

      // Full screen: no traffic lights, so the strip kept for them closes.
      // The sidebar's trigger, the margin's tabs and the draft move up;
      // nothing re-wraps.
      const before = await wraps();
      await fullscreen(true);
      const full = await geometry();
      assert.ok(full.trigger < windowed.trigger || collapsed === false, "the rail's trigger moves up");
      assert.ok(full.toggle < windowed.toggle, "the margin button moves up");
      assert.ok(full.tabs < windowed.tabs, "the margin's tabs move up");
      assert.ok(full.title < windowed.title, "the draft starts higher");
      assert.ok(full.toggle <= 16, `no dead strip over the margin button (${full.toggle})`);
      if (!collapsed) assert.ok(full.header < windowed.header, "the sidebar header is shorter");
      const across = (list: string[]) => list.map((w) => w.split(",").filter((_, i) => i !== 1).join(","));
      const after = across(await wraps());
      const n = Math.min(after.length, before.length);
      assert.deepEqual(after.slice(0, n), across(before).slice(0, n), "full screen re-wraps nothing");
      await shot(`08-fullscreen-${collapsed ? "rail" : "sidebar"}-${open ? "margin" : "plain"}-light`);
      await page.emulateMedia({ colorScheme: "dark" });
      await settle();
      await shot(`08-fullscreen-${collapsed ? "rail" : "sidebar"}-${open ? "margin" : "plain"}-dark`);
      await page.emulateMedia({ colorScheme: "light" });
      await fullscreen(false);
      assert.deepEqual(await geometry(), windowed, "back to windowed, everything is where it was");
      if (open) {
        await page.keyboard.press("Meta+Shift+r");
        await settle();
      }
    }
  }
  await page.keyboard.press("Meta+Backslash");
  await page.locator("[data-slot=sidebar][data-state=expanded]").waitFor();
});

test("away from the editor, nothing sits under the traffic lights either", { timeout: 120_000 }, async () => {
  await fullscreen(false);
  for (const collapsed of [false, true]) {
    if (collapsed) {
      await page.keyboard.press("Meta+Backslash");
      await page.locator("[data-slot=sidebar][data-state=collapsed]").waitFor();
    }
    for (const [name, key] of [["Feed", "Meta+Shift+f"], ["Inspiration", "Meta+Shift+i"], ["Ideas", "Meta+Shift+e"], ["Settings", "Meta+,"]] as const) {
      await page.keyboard.press(key);
      await settle();
      assert.deepEqual(await controlsUnderLights(), [], `${name}, sidebar ${collapsed ? "rail" : "open"}`);
      if (name === "Settings") await page.keyboard.press("Escape");
    }
  }
  await page.keyboard.press("Meta+Backslash");
  await page.locator("[data-slot=sidebar][data-state=expanded]").waitFor();
  await openDoc(DRAFT);
});

test("with scroll bars always shown, the margin still moves no line", { timeout: 120_000 }, async () => {
  // macOS's "Show scroll bars: Always": a classic scroll bar takes room.
  const classic = await chromium.launch({ headless: true, ignoreDefaultArgs: ["--hide-scrollbars"] });
  const other = await classic.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await openApp(other, app.url, app.output);
    await other.locator(`[title="${DRAFT}"]`).click();
    await other.locator(".cm-line").first().waitFor();
    const bar = await other.evaluate(() => { const s = document.querySelector(".cm-scroller") as HTMLElement; return s.offsetWidth - s.clientWidth; });
    assert.ok(bar > 0, `a scroll bar that takes room (${bar}px)`);
    const boxes = () => other.evaluate(() => [...document.querySelectorAll(".cm-content .cm-line")].flatMap((line) => {
      const range = document.createRange();
      range.selectNodeContents(line);
      return [...range.getClientRects()].map((r) => `${Math.round(r.left * 2) / 2},${Math.round(r.top * 2) / 2},${Math.round(r.width * 2) / 2}`);
    }));
    const before = await boxes();
    await other.keyboard.press("Meta+Shift+r");
    await other.waitForFunction(() => document.getAnimations().every((a) => !(a instanceof CSSTransition) || a.playState !== "running"));
    assert.ok((await other.locator("aside.ki-margin").getAttribute("data-open")) !== null);
    assert.deepEqual(await boxes(), before, "no line moved");
    await other.screenshot({ path: resolve(app.shots, "09-scrollbars-always.png") });
    await other.keyboard.press("Meta+Shift+r");
  } finally {
    await classic.close();
  }
});
