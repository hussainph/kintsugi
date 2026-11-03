#!/usr/bin/env node
// PROTOTYPE (KI-96), throwaway: records each candidate's key motions with
// Playwright from a running prototype (`pnpm prototype:kin-surface`).
//   node apps/desktop/src/prototype-kin-surface/record.mjs '<url printed>' [outDir]
// Headless Chromium only; writes webm (and mp4 when ffmpeg is on PATH).
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const [url, out = resolve(".headless/ki96-recordings")] = process.argv.slice(2);
if (!url) throw new Error("Pass the prototype URL");
const only = process.env.ONLY?.split(",");
mkdirSync(out, { recursive: true });

const wait = (page, ms) => page.waitForTimeout(ms);
const press = async (page, keys, after = 900) => { await page.keyboard.press(keys); await wait(page, after); };
const click = async (page, selector, after = 900) => { await page.locator(selector).first().click(); await wait(page, after); };
const select = (page, quote) => page.evaluate((q) => window.__kp.select(q), quote);
const cursorAfter = (page, quote) => page.evaluate((q) => window.__kp.cursorAfter(q), quote);

/** Panels open and close without re-wrapping, then Kin's suggestions. */
async function panelsAndSuggestions(page, v) {
  await cursorAfter(page, "The first time");
  await wait(page, 1200);
  if (v === "A") {
    await click(page, ".kp-right-toggle", 1300);
    await click(page, '.kp-tabs [role="tab"]:nth-child(2)', 1100);
    await click(page, '.kp-tabs [role="tab"]:nth-child(3)', 1400);
    await click(page, ".kp-right-toggle", 1000);
  } else if (v === "B") {
    await press(page, "Meta+Alt+KeyA", 1600);
    await click(page, ".kp-right-toggle", 1600);
    await click(page, ".kp-left-toggle", 1300);
    await click(page, ".kp-right-toggle", 1100);
  } else {
    await click(page, ".kp-launcher", 1300);
    await click(page, '.kp-kin-head [aria-label="Hide (⌘J)"]', 900);
    await click(page, ".kp-stash-button", 1400);
    await click(page, ".kp-stash-button", 900);
    await cursorAfter(page, "The gold is a deci");
    await press(page, "Meta+Alt+KeyA", 1400);
    await press(page, "Escape", 700);
  }
  await cursorAfter(page, "The first time");
  await press(page, "Meta+Alt+KeyK", 1600);
  await press(page, "Meta+Quote", 1200);
  await press(page, "Meta+Quote", 1200);
  await press(page, "Alt+Enter", 1500);
  await press(page, "Meta+Quote", 1200);
  await press(page, "Meta+Alt+Backspace", 1500);
  await press(page, "Meta+Shift+Quote", 1200);
  await press(page, "Meta+Shift+Quote", 1200);
  await press(page, "Meta+Shift+KeyJ", 1400);
  await click(page, '.kp-ask-chips button:has-text("Why?")', 2800);
  if (v !== "A") await click(page, '.kp-pane [aria-label="Fold"]', 900);
  await press(page, "Meta+Alt+KeyK", 1500);
}

/** Cycle in place, versions with Kin working, an inline ask while he keeps
 *  writing, stashing, a paragraph's chat, and Kin off the editor. */
async function asksVersionsThreads(page, v) {
  await cursorAfter(page, "The gold is a deci");
  await wait(page, 900);
  await press(page, "Meta+Alt+BracketRight", 1000);
  await press(page, "Meta+Alt+BracketRight", 1000);
  await press(page, "Meta+Alt+BracketLeft", 1200);
  await press(page, "Meta+Alt+KeyA", 1100);
  await click(page, ".kp-kin-link", 2600);
  await click(page, '.kp-versions li[data-by="kin"] button', 1300);
  if (v === "A") await click(page, ".kp-right-toggle", 800);
  else await press(page, "Escape", 800);
  await select(page, "I polish a sentence long before I know whether it can carry any weight.");
  await press(page, "Meta+KeyJ", 1100);
  await click(page, '.kp-ask-chips button:has-text("Who disagrees?")', 300);
  await cursorAfter(page, "the parts people quote back to me.");
  await page.keyboard.type(" I should test that on the next draft.", { delay: 55 });
  await wait(page, 3600);
  if (v === "C") {
    await click(page, '.kp-pill-actions button:has-text("Stash")', 1500);
    await click(page, '.kp-pill-actions button:has-text("Close")', 800);
  } else {
    await click(page, ".kp-reply", 1500);
    await click(page, '.kp-message .kp-link:has-text("Stash")', 1500);
    if (v === "B") await click(page, '.kp-pane [aria-label="Fold"]', 900);
  }
  await select(page, "I used to think that was sentimental.");
  await press(page, "Meta+Alt+KeyX", 1600);
  await click(page, '.kp-thread[data-chat="c-teapot"]', 2000);
  if (v !== "A") await click(page, '.kp-pane [aria-label="Fold"]', 900);
  await press(page, "Meta+Shift+KeyI", 1600);
  if (await page.locator(".kp-launcher.kp-fixed:visible").count()) await click(page, ".kp-launcher.kp-fixed:visible", 1600);
  const surface = ".kp-else-margin, .kp-else-box, .kp-else-sheet";
  if (await page.locator(`:is(${surface}) .kp-chat-title`).count()) await click(page, `:is(${surface}) .kp-chat-title`, 1100);
  await page.locator(`:is(${surface}) .kp-search input`).first().fill("rain");
  await wait(page, 1400);
  await page.locator(`:is(${surface}) .kp-search input`).first().fill("");
  await click(page, `:is(${surface}) .kp-chat-row:has-text("General")`, 900);
  const box = page.locator(`:is(${surface}) textarea[aria-label="Message Kin"]`).first();
  await box.fill("What have I saved about repair?");
  await press(page, "Enter", 6500);
}

const browser = await chromium.launch();
try {
  for (const v of ["A", "B", "C"]) {
    for (const theme of ["light", "dark"]) {
      for (const [name, run] of [["1-panels-and-suggestions", panelsAndSuggestions], ["2-asks-versions-threads", asksVersionsThreads]]) {
        const label = `ki96-${v}-${theme}-${name}`;
        if (only && !only.some((o) => label.includes(o))) continue;
        const dir = resolve(out, `tmp-${label}`);
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme, recordVideo: { dir, size: { width: 1440, height: 900 } } });
        const page = await context.newPage();
        const target = url.replace(/\/(\?[^#]*)?#/, `/?proto=kin-surface&variant=${v}#`);
        await page.goto(target);
        await page.locator(".kp-writing .cm-content").waitFor();
        await wait(page, 1500);
        try { await run(page, v); } catch (error) { console.error(label, error.message); await page.screenshot({ path: resolve(out, `${label}-failed.png`) }); }
        await context.close();
        const file = readdirSync(dir).find((f) => f.endsWith(".webm"));
        renameSync(resolve(dir, file), resolve(out, `${label}.webm`));
        rmSync(dir, { recursive: true, force: true });
        const mp4 = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", resolve(out, `${label}.webm`), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "26", "-preset", "veryfast", resolve(out, `${label}.mp4`)]);
        console.log(label, mp4.status === 0 ? "webm + mp4" : "webm");
      }
    }
  }
} finally {
  await browser.close();
}
