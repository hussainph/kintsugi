#!/usr/bin/env node
// PROTOTYPE (KI-96), throwaway: the still frames for the Paper page.
//   node apps/desktop/src/prototype-kin-surface/shots.mjs '<url printed>' [outDir]
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const [url, out = resolve(".headless/ki96-shots")] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const wait = (page, ms) => page.waitForTimeout(ms);
const press = async (page, keys, after = 500) => { await page.keyboard.press(keys); await wait(page, after); };
const click = async (page, selector, after = 500) => { await page.locator(selector).first().click(); await wait(page, after); };
const select = (page, q) => page.evaluate((x) => window.__kp.select(x), q);
const cursorAfter = (page, q) => page.evaluate((x) => window.__kp.cursorAfter(x), q);
const hideBar = (page) => page.addStyleTag({ content: ".kp-switcher { display: none !important; }" });

const states = {
  async suggestions(page, v) {
    await cursorAfter(page, "The gold is a deci");
    await press(page, "Meta+Alt+KeyK", 600);
    await press(page, "Meta+Quote", 900);
    if (v === "B") { await click(page, ".kp-right-toggle", 700); await press(page, "Meta+Alt+KeyA", 700); }
    else await click(page, ".kp-stash-button", 700);
  },
  async threads(page, v) {
    await select(page, "I polish a sentence long before I know whether it can carry any weight.");
    await press(page, "Meta+KeyJ", 500);
    await click(page, '.kp-ask-chips button:has-text("Who disagrees?")', 300);
    await cursorAfter(page, "the parts people quote back to me.");
    await page.keyboard.type(" I should test that", { delay: 20 });
    await wait(page, 4200);
    await click(page, '.kp-thread[data-chat="c-teapot"]', 1200);
  },
  async working(page, v) {
    await select(page, "I polish a sentence long before I know whether it can carry any weight.");
    await press(page, "Meta+KeyJ", 500);
    await click(page, '.kp-ask-chips button:has-text("Who disagrees?")', 300);
    await cursorAfter(page, "the parts people quote back to me.");
    await page.keyboard.type(" I should test that", { delay: 20 });
    await wait(page, 600);
  },
  async elsewhere(page) {
    await press(page, "Meta+Shift+KeyI", 1200);
    if (await page.locator(".kp-launcher.kp-fixed:visible").count()) await click(page, ".kp-launcher.kp-fixed:visible", 900);
    const surface = ".kp-else-margin, .kp-else-box, .kp-else-sheet";
    if (await page.locator(`:is(${surface}) .kp-chat-title`).count()) await click(page, `:is(${surface}) .kp-chat-title`, 700);
  },
};

const browser = await chromium.launch();
try {
  for (const v of ["A", "B", "C"]) for (const theme of ["light", "dark"]) for (const [name, run] of Object.entries(states)) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await page.goto(url.replace(/\/(\?[^#]*)?#/, `/?proto=kin-surface&variant=${v}#`));
    await page.locator(".kp-writing .cm-content").waitFor();
    await wait(page, 1200);
    await hideBar(page);
    try { await run(page, v); } catch (e) { console.error(v, theme, name, e.message.split("\n")[0]); }
    await page.screenshot({ path: resolve(out, `ki96-${v}-${theme}-${name}.png`) });
    console.log(v, theme, name);
    await context.close();
  }
} finally { await browser.close(); }
