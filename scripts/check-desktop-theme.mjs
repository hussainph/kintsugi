#!/usr/bin/env node
/**
 * Checks the Graphical theme in a running headless Mac app, in light and dark,
 * and saves a screenshot of each main screen. Start `pnpm desktop:headless`
 * first, then pass the URL it prints:
 *
 *   KINTSUGI_THEME_URL='<printed URL>' node scripts/check-desktop-theme.mjs [outDir]
 *
 * Screenshots go to .headless/ki-20/desktop (or outDir). The URL and token are
 * never written to disk. Uses the system Google Chrome, headless.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const { chromium } = require('playwright');

const capability = process.env.KINTSUGI_THEME_URL;
if (!capability) throw new Error('Set KINTSUGI_THEME_URL to the URL printed by pnpm desktop:headless.');
const url = new URL(capability);
const backend = new URL(new URLSearchParams(url.hash.slice(1)).get('headless') || 'http://invalid.invalid');
for (const target of [url, backend]) {
  assert.equal(target.protocol, 'http:', 'Only a local HTTP headless server is allowed.');
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname), 'Only loopback is allowed.');
}
const root = fileURLToPath(new URL('..', import.meta.url));
const out = resolve(root, process.argv[2] ?? '.headless/ki-20/desktop');
await mkdir(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const failures = [];
const problems = [];

async function check(mode, name, fn) {
  try { await fn(); console.log(`PASS ${mode}: ${name}`); } catch (error) {
    failures.push(`${mode}: ${name}`);
    console.log(`FAIL ${mode}: ${name}: ${String(error.message).split('\n')[0]}`);
  }
}

/** Icons on screen: all Hugeicons, none missing, no Lucide markup. */
async function assertIcons(page) {
  const icons = await page.evaluate(() => ({
    lucide: document.querySelectorAll('svg.lucide, [data-icon-family="Lucide"]').length,
    unavailable: document.querySelectorAll('[data-icon-unavailable], [data-icon-loading]').length,
    huge: document.querySelectorAll('[data-icon-family="Hugeicons"]').length,
  }));
  assert.equal(icons.lucide, 0, 'no Lucide icons');
  assert.equal(icons.unavailable, 0, 'no missing icons');
  assert.ok(icons.huge > 0, 'Hugeicons render');
}

async function shot(page, mode, name) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(out, `${mode}-${name}.png`), animations: 'disabled' });
}

for (const mode of ['light', 'dark']) {
  const context = await browser.newContext({ colorScheme: mode, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.on('pageerror', (e) => problems.push(`${mode} page error: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`${mode} console: ${m.text()}`); });
  await page.goto(capability);
  // The seeded scratch vault always has this draft.
  await page.getByRole('button', { name: /^Kintsugi and gold/ }).click();
  await page.locator('.cm-content').waitFor();

  await check(mode, 'theme scope, color mode and fonts', async () => {
    const s = await page.evaluate(async () => {
      await document.fonts.ready;
      const scope = document.querySelector('.graphical-theme');
      const cs = getComputedStyle(scope);
      const loaded = [...document.fonts].filter((f) => f.status === 'loaded').map((f) => `${f.family.replaceAll('"', '')} ${f.weight}`);
      return {
        dark: document.documentElement.classList.contains('dark'),
        mode: scope?.getAttribute('data-color-mode'),
        ui: cs.fontFamily, neutral1: cs.getPropertyValue('--neutral-1').trim(), loaded,
        editor: getComputedStyle(document.querySelector('.cm-content')).fontFamily,
      };
    });
    assert.equal(s.dark, mode === 'dark');
    assert.equal(s.mode, mode);
    assert.match(s.ui, /Timeless Sans/);
    assert.match(s.editor, /LT Superior Serif/);
    assert.ok(s.neutral1, 'theme tokens resolve');
    for (const face of ['Timeless Sans', 'LT Superior Serif']) assert.ok(s.loaded.some((f) => f.startsWith(face)), `${face} loaded`);
  });

  await check(mode, 'writing', async () => { await assertIcons(page); await shot(page, mode, 'writing'); });

  await check(mode, 'command palette', async () => {
    await page.keyboard.press('Meta+p');
    await page.getByRole('dialog').waitFor();
    await shot(page, mode, 'palette');
    await page.keyboard.press('Escape');
  });

  for (const [button, heading, name] of [['Feed', 'Feed', 'feed'], ['Inspiration', 'Inspiration', 'inspiration'], ['Ideas', 'Ideas', 'ideas']]) {
    await check(mode, name, async () => {
      await page.getByRole('button', { name: new RegExp(`^${button}`) }).first().click();
      await page.getByRole('heading', { name: heading, level: 1 }).waitFor();
      await assertIcons(page);
      const title = await page.getByRole('heading', { name: heading, level: 1 }).evaluate((el) => getComputedStyle(el).fontSize);
      const size = await page.evaluate(() => getComputedStyle(document.querySelector('.graphical-theme')).getPropertyValue('--size-xl').trim());
      assert.equal(title, size, 'page title on the theme scale');
      await shot(page, mode, name);
    });
  }

  await check(mode, 'capture dialog', async () => {
    await page.getByRole('button', { name: /^Inspiration/ }).first().click();
    await page.getByRole('button', { name: 'Add a clip' }).first().click();
    await page.getByRole('dialog').waitFor();
    await shot(page, mode, 'capture');
    await page.keyboard.press('Escape');
  });

  await check(mode, 'Kin chat', async () => {
    await page.getByRole('button', { name: 'Ask Kin' }).click();
    await page.waitForTimeout(500);
    await assertIcons(page);
    await shot(page, mode, 'kin');
    await page.keyboard.press('Escape');
  });

  await check(mode, 'settings', async () => {
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('dialog').waitFor();
    await shot(page, mode, 'settings');
    await page.keyboard.press('Escape');
  });

  await context.close();
}
await browser.close();
for (const p of problems) console.log(`NOTE ${p.replaceAll(url.hash, '#…')}`);
console.log(JSON.stringify({ failed: failures.length, problems: problems.length, out }));
process.exit(failures.length ? 1 : 0);
