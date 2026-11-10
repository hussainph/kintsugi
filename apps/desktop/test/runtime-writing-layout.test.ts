// KI-114 against the real runtime: `pnpm desktop:headless` (the real Rust
// command registry on Tauri MockRuntime, and the real React app) driven by
// headless Chromium, in a fresh scratch vault and config.
//
// Closing the sidebar frees room, and the writing column uses it. The fixed
// measure (KI-103) stays fixed and centres in the pane left over after the
// margin's 360 px are reserved, so half of what the sidebar releases lands
// on the text's left (references.css: `margin-left:
// max(0px, (100% - var(--ki-column) - var(--ki-margin-width)) / 2)`). The
// column never moves for the margin itself — opening it or changing tabs —
// and at 1280 the auto-fold slides the column without re-wrapping a line.
// Below the fold threshold the margin overlays the page and nothing
// reflows. The sidebar's own width transition carries the column; under
// reduced motion the sidebar keeps no transition while writing and the
// column jumps to its place. A drawn selection follows the text across a
// toggle (nothing translates the content under the selection layer).
// Screenshots go to .headless/<run>/shots/.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { openApp, startApp, type App } from "./headless-app.ts";

const TIMEOUT = Number(process.env.KINTSUGI_RUNTIME_TIMEOUT ?? 15 * 60_000);
const DRAFT = "drafts/kintsugi-and-gold.md";
const LINE = "The first time I saw a kintsugi bowl";

let app: App;
let browser: Browser;
let page: Page;

before(async () => {
  app = await startApp("ki114", {});
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

/** Lets the sidebar's fold and the margin's slide finish: every CSS
 *  transition has ended (a slow machine takes longer than the tokens). */
async function settle() {
  // Two frames: React has committed, effects have run, and the browser has
  // started any transition they cause.
  for (let i = 0; i < 2; i++) await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await page.waitForFunction(() => document.getAnimations().every((a) => !(a instanceof CSSTransition) || a.playState !== "running"));
  await page.waitForTimeout(50);
}

async function frames(n = 2) {
  for (let i = 0; i < n; i++) await page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));
}

const isOpen = async () => (await page.locator("aside.ki-margin").getAttribute("data-open")) !== null;
const sidebarState = () => page.locator("[data-slot=sidebar]").first().getAttribute("data-state");

async function openDoc(path: string) {
  await page.locator(`[title="${path}"]`).click();
  await page.locator(`[title="${path}"][data-active="true"]`).waitFor();
  await page.locator(".cm-line").first().waitFor();
}

async function toggleSidebar(state: "expanded" | "collapsed") {
  await page.keyboard.press("Meta+Backslash");
  await page.locator(`[data-slot=sidebar][data-state=${state}]`).first().waitFor();
  await settle();
}

/** The editor view at `width`, sidebar expanded, margin closed. */
async function ensureWriting(width: number) {
  await page.setViewportSize({ width, height: 900 });
  if (await isOpen()) {
    await page.keyboard.press("Meta+Alt+Backslash");
    await settle();
  }
  if ((await sidebarState()) !== "expanded") await toggleSidebar("expanded");
  else await settle();
  await page.locator(".cm-line").first().waitFor();
}

/** Where the writing column sits, and where the plan says it must:
 *  centred in the pane that remains after the margin's width is reserved,
 *  plus the line's own padding. Percent margins resolve against the
 *  scroller's content box, which is `clientWidth`. */
type Layout = {
  scrollerLeft: number; clientWidth: number;
  contentLeft: number; contentWidth: number;
  textLeft: number; textRight: number;
  expectedContentLeft: number; expectedTextLeft: number;
  pageOverflow: number; scrollerOverflow: number;
};

async function layout(): Promise<Layout> {
  return page.evaluate(() => {
    const scroller = document.querySelector(".cm-scroller") as HTMLElement;
    const content = document.querySelector(".cm-content") as HTMLElement;
    const line = content.querySelector(".cm-line") as HTMLElement;
    const s = scroller.getBoundingClientRect();
    const c = content.getBoundingClientRect();
    const l = line.getBoundingClientRect();
    const lineStyle = getComputedStyle(line);
    const padLeft = parseFloat(lineStyle.paddingLeft);
    const marginWidth = parseFloat(getComputedStyle(scroller).getPropertyValue("--ki-margin-width"));
    const reserved = Math.max(0, (scroller.clientWidth - c.width - marginWidth) / 2);
    return {
      scrollerLeft: s.left,
      clientWidth: scroller.clientWidth,
      contentLeft: c.left,
      contentWidth: c.width,
      textLeft: l.left + padLeft,
      textRight: l.right - parseFloat(lineStyle.paddingRight),
      expectedContentLeft: s.left + reserved,
      expectedTextLeft: s.left + reserved + padLeft,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      scrollerOverflow: scroller.scrollWidth - scroller.clientWidth,
    };
  });
}

function checkCentred(got: Layout, label: string) {
  assert.ok(Math.abs(got.contentLeft - got.expectedContentLeft) < 0.5,
    `${label}: content left ${got.contentLeft} is not centred (${got.expectedContentLeft})`);
  assert.ok(Math.abs(got.textLeft - got.expectedTextLeft) < 0.5,
    `${label}: text left ${got.textLeft} is not centred (${got.expectedTextLeft})`);
  assert.ok(got.pageOverflow <= 0, `${label}: the page overflows horizontally (${got.pageOverflow}px)`);
  assert.ok(got.scrollerOverflow <= 0, `${label}: the editor overflows horizontally (${got.scrollerOverflow}px)`);
}

async function textRight() {
  return page.evaluate(() => {
    const line = document.querySelector(".cm-content .cm-line") as HTMLElement;
    return line.getBoundingClientRect().right - parseFloat(getComputedStyle(line).paddingRight);
  });
}

/** Character boxes as row + width, independent of decoration-created spans:
 *  where each line wraps. x is left out on purpose — re-centring moves it. */
async function shapes() {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const line of document.querySelectorAll(".cm-content .cm-line")) {
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.parentElement?.closest(".cm-alt-count, .cm-alt-gutter")) continue;
        for (let i = 0; i < (node.textContent?.length ?? 0); i++) {
          const range = document.createRange();
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          for (const r of range.getClientRects()) {
            if (r.width === 0) continue;
            out.push(`${Math.round(r.top * 8)},${Math.round(r.width * 8)}`);
          }
        }
      }
    }
    return out;
  });
}

function sameShapes(got: string[], want: string[], message: string) {
  assert.deepEqual(got, want, message);
}

/** Computed transition durations, in seconds, of a sidebar part. */
async function transitionSeconds(slot: string): Promise<number[]> {
  return page.evaluate((slot) => {
    const el = document.querySelector(`[data-slot="${slot}"]`) as HTMLElement | null;
    if (!el) return [-1];
    return getComputedStyle(el).transitionDuration.split(",").map((s) => parseFloat(s) || 0);
  }, slot);
}

/** The content's left edge, sampled every animation frame for `ms`. */
async function sampleContentLeft(ms: number): Promise<number[]> {
  return page.evaluate((ms) => new Promise((done) => {
    const content = document.querySelector(".cm-content") as HTMLElement;
    const samples: number[] = [];
    const start = performance.now();
    const step = () => {
      samples.push(content.getBoundingClientRect().left);
      if (performance.now() - start < ms) requestAnimationFrame(step);
      else done(samples);
    };
    requestAnimationFrame(step);
  }), ms);
}

async function selectParagraph() {
  await page.locator(".cm-line", { hasText: LINE }).click({ clickCount: 3 });
  // The selection layer paints on the next animation frame.
  await frames();
}

/** Every painted selection rectangle stays inside the text column: nothing
 *  may translate the content under the layer that draws against it. */
async function selectionHugsText(label: string) {
  const box = await layout();
  const rects = await page.evaluate(() =>
    [...document.querySelectorAll(".cm-selectionBackground")].map((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right };
    }));
  assert.ok(rects.length > 0, `${label}: a selection is painted`);
  for (const r of rects) {
    assert.ok(r.left >= box.textLeft - 1, `${label}: selection bleeds left (${r.left} < ${box.textLeft})`);
    assert.ok(r.right <= box.textRight + 1, `${label}: selection bleeds right (${r.right} > ${box.textRight})`);
  }
}

test("the column keeps its measure and sits centred beside the reserved margin, sidebar open or closed", { timeout: 240_000 }, async () => {
  await openDoc(DRAFT);
  // The measure is 58ch: wait for the editorial face before any baseline.
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  assert.equal(await isOpen(), false, "the margin starts closed");
  assert.equal(await sidebarState(), "expanded", "the sidebar starts expanded");

  for (const width of [2000, 1600, 1440, 1280]) {
    await ensureWriting(width);
    const open = await layout();
    assert.ok(open.clientWidth > open.contentWidth + 1, `${width}: the measure fits beside the sidebar`);
    checkCentred(open, `${width}, sidebar open`);
    await toggleSidebar("collapsed");
    const closed = await layout();
    assert.ok(Math.abs(closed.contentWidth - open.contentWidth) < 1 / 16, `${width}: the column keeps its width`);
    checkCentred(closed, `${width}, sidebar closed`);
    assert.ok(closed.textLeft < open.textLeft - 1, `${width}: closing the sidebar moves the text left`);
    await toggleSidebar("expanded");
    const back = await layout();
    checkCentred(back, `${width}, sidebar reopened`);
    assert.ok(Math.abs(back.textLeft - open.textLeft) < 0.5, `${width}: reopening puts the text back`);
    assert.ok(Math.abs(back.contentWidth - open.contentWidth) < 1 / 16, `${width}: reopening restores the width`);
  }

  // Dark reads the same geometry.
  await page.emulateMedia({ colorScheme: "dark" });
  await ensureWriting(1440);
  checkCentred(await layout(), "dark, sidebar open");
  await toggleSidebar("collapsed");
  checkCentred(await layout(), "dark, sidebar closed");
  await shot("ki114-dark-1440");
  await toggleSidebar("expanded");
  await page.emulateMedia({ colorScheme: "light" });

  // A selection is drawn against the text, so it must follow it across a
  // toggle; the plan deliberately avoids a content transform that could
  // desync the selection layer from the glyphs.
  await selectParagraph();
  await selectionHugsText("sidebar open");
  await toggleSidebar("collapsed");
  await selectionHugsText("sidebar closed");
  await toggleSidebar("expanded");
  await selectionHugsText("sidebar reopened");
  await page.locator(".cm-line", { hasText: LINE }).click();
});

test("the reserved margin never moves the text, and the 1280 auto-fold recentres without re-wrapping", { timeout: 240_000 }, async () => {
  await ensureWriting(1440);
  const plain = await layout();
  const shape = await shapes();
  assert.ok(shape.length > 10, `enough lines to compare (${shape.length})`);

  await page.keyboard.press("Meta+Shift+r");
  await settle();
  assert.ok(await isOpen(), "the margin opened");
  assert.equal(await tab("References").getAttribute("aria-selected"), "true");
  const open = await layout();
  assert.ok(Math.abs(open.textLeft - plain.textLeft) < 0.5, "opening the margin leaves the text put");
  checkCentred(open, "1440, margin open");
  sameShapes(await shapes(), shape, "opening the margin re-wraps nothing");
  await tab("Kin").click();
  await settle();
  const kin = await layout();
  assert.ok(Math.abs(kin.textLeft - plain.textLeft) < 0.5, "switching tabs leaves the text put");
  checkCentred(kin, "1440, Kin tab");
  sameShapes(await shapes(), shape, "switching tabs re-wraps nothing");
  await page.keyboard.press("Meta+Alt+Backslash");
  await settle();
  assert.equal(await isOpen(), false);
  sameShapes(await shapes(), shape, "closing the margin re-wraps nothing");

  // The auto-fold: the margin needs the sidebar's room, the sidebar folds to
  // icons, and the column recentres into the freed room without re-wrapping.
  await ensureWriting(1280);
  const base = await layout();
  const baseShape = await shapes();
  await page.keyboard.press("Meta+Shift+r");
  await settle();
  assert.equal(await sidebarState(), "collapsed", "opening the margin folds the sidebar");
  const folded = await layout();
  checkCentred(folded, "1280, folded");
  assert.ok(Math.abs(folded.contentWidth - base.contentWidth) < 1 / 16, "the fold keeps the column's width");
  assert.ok(folded.textLeft < base.textLeft - 1, "the fold moves the text into the freed room");
  sameShapes(await shapes(), baseShape, "the fold re-wraps nothing");
  assert.ok((await margin().boundingBox())!.x >= (await textRight()), "the margin clears the text");
  await shot("ki114-1280-fold");
  await page.keyboard.press("Meta+Alt+Backslash");
  await settle();
  assert.equal(await sidebarState(), "expanded", "closing the margin gives the sidebar back");
  const restored = await layout();
  assert.ok(Math.abs(restored.textLeft - base.textLeft) < 0.5, "everything is back where it was");
  sameShapes(await shapes(), baseShape, "the restore re-wraps nothing");
});

test("below the fold threshold the margin overlays the page: no reflow, no overflow, no fold", { timeout: 120_000 }, async () => {
  await ensureWriting(1440);
  await page.setViewportSize({ width: 800, height: 900 });
  await settle();
  const before = await layout();
  const shape = await shapes();
  // The measure no longer fits: the column takes the pane's whole width.
  assert.ok(Math.abs(before.contentWidth - before.clientWidth) < 0.5, "the squeezed column fills the pane");
  checkCentred(before, "800, margin closed");

  await marginButton().click();
  await settle();
  assert.ok(await isOpen(), "the margin opened");
  assert.equal(await sidebarState(), "expanded", "no fold where the measure is squeezed");
  const open = await layout();
  assert.ok(Math.abs(open.textLeft - before.textLeft) < 0.5, "the overlay moves no text");
  assert.ok(Math.abs(open.contentWidth - before.contentWidth) < 0.5, "the overlay changes no width");
  checkCentred(open, "800, overlay");
  sameShapes(await shapes(), shape, "the overlay re-wraps nothing");
  assert.ok((await margin().boundingBox())!.x < (await textRight()), "the margin covers the page's right edge");
  await shot("ki114-800-overlay");
  await marginButton().click();
  await settle();
  assert.equal(await isOpen(), false);
  sameShapes(await shapes(), shape, "closing it re-wraps nothing");
});

test("the sidebar's travel carries the column, an interrupted toggle still lands, and reduced motion jumps", { timeout: 240_000 }, async () => {
  await ensureWriting(1440);
  const [gapSeconds] = await transitionSeconds("sidebar-gap");
  assert.ok(gapSeconds > 0, `the sidebar's gap animates its width (${gapSeconds}s)`);
  const expanded = await layout();

  await page.keyboard.press("Meta+Backslash");
  const travel = await sampleContentLeft(gapSeconds * 2000 + 300);
  await settle();
  const collapsed = await layout();
  const low = Math.min(expanded.contentLeft, collapsed.contentLeft);
  const high = Math.max(expanded.contentLeft, collapsed.contentLeft);
  const between = travel.filter((x) => x > low + 1 && x < high - 1);
  assert.ok(new Set(between.map((x) => Math.round(x * 4))).size >= 2,
    `the column travels with the sidebar (${between.length} samples between)`);
  assert.ok(Math.abs(travel[travel.length - 1] - collapsed.contentLeft) < 1, "the travel ends at the folded place");

  // Interrupted mid-flight, it still lands exactly.
  await toggleSidebar("expanded");
  await page.keyboard.press("Meta+Backslash");
  await page.waitForTimeout((gapSeconds * 1000) / 3);
  await page.keyboard.press("Meta+Backslash");
  await settle();
  assert.equal(await sidebarState(), "expanded");
  const landed = await layout();
  assert.ok(Math.abs(landed.textLeft - expanded.textLeft) < 0.5, "an interrupted toggle lands where it started");

  // Reduced motion: the sidebar keeps no transition while writing, so the
  // column sits at its new place on the first frame.
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const slot of ["sidebar-gap", "sidebar-container"]) {
    const seconds = await transitionSeconds(slot);
    assert.ok(seconds.every((s) => s === 0), `${slot}: no transition under reduced motion (${seconds})`);
  }
  await page.keyboard.press("Meta+Backslash");
  await page.locator("[data-slot=sidebar][data-state=collapsed]").first().waitFor();
  const jump = await sampleContentLeft(300);
  await settle();
  const target = await layout();
  assert.ok(Math.max(...jump) - Math.min(...jump) <= 1, "no travel under reduced motion");
  assert.ok(Math.abs(jump[jump.length - 1] - target.contentLeft) < 1, "the jump lands at the folded place");
  await toggleSidebar("expanded");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await settle();
  const home = await layout();
  assert.ok(Math.abs(home.textLeft - expanded.textLeft) < 0.5, "back where it started");
});
