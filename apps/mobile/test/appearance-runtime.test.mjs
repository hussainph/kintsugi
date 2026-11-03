// KI-100: production RN controls through RN-web + the production DOM editor.
// Native presentation, keyboard dismissal, VoiceOver and swipe detents still
// require a headless Simulator/device pass; this does not claim to test them.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { startAppearanceServer } from './appearance-runtime/server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = createRequire(resolve(here, '../../desktop/package.json'));
const { chromium } = desktop('playwright');
const shots = resolve(here, '../../../docs/review/ki-100');
let server;
let url;
let browser;
before(async () => {
  ({ server, url } = await startAppearanceServer());
  browser = await chromium.launch({ headless: true });
  mkdirSync(shots, { recursive: true });
});
after(async () => { await browser?.close(); await server?.close(); });

const radio = (page, name) => page.getByRole('radio', { name, exact: true });
async function open(context, suffix = '') {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url + suffix);
  await page.getByRole('heading', { name: 'Appearance' }).waitFor();
  await page.locator('.cm-content').waitFor({ state: 'attached' });
  assert.deepEqual(errors, []);
  return page;
}
async function mode(page, dark) {
  await page.waitForFunction((dark) => {
    const panel = document.querySelector('[data-testid="appearance-panel"]');
    const editor = document.querySelector('.cm-content');
    return document.documentElement.classList.contains('dark') === dark
      && getComputedStyle(panel).backgroundColor === (dark ? 'rgb(23, 23, 23)' : 'rgb(245, 245, 245)')
      && getComputedStyle(editor).color === (dark ? 'rgb(250, 250, 250)' : 'rgb(10, 10, 10)');
  }, dark);
}
async function checkHits(page) {
  for (const locator of [radio(page, 'Light'), radio(page, 'Dark'), radio(page, 'System'), page.getByRole('button', { name: 'Smaller text', exact: true }), page.getByRole('button', { name: 'Larger text', exact: true }), page.getByRole('button', { name: 'Done', exact: true })]) {
    const bounds = await locator.boundingBox();
    assert.ok(bounds.width >= 44 && bounds.height >= 44, JSON.stringify(bounds));
  }
}

test('phone mode overrides, live System changes, 44pt controls and compact light/dark layout', { timeout: 90_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'light' });
  try {
    const page = await open(context);
    assert.equal(await radio(page, 'System').getAttribute('aria-checked'), 'true');
    await mode(page, false);
    await checkHits(page);
    assert.equal(await page.getByTestId('appearance-preview').count(), 1);
    assert.equal(await page.getByText('Editor font', { exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: 'New York' }).count(), 0, 'font is read-only');
    await page.screenshot({ path: resolve(shots, 'phone-web-light.png') });
    await radio(page, 'Dark').click();
    await mode(page, true);
    await page.screenshot({ path: resolve(shots, 'phone-web-dark.png') });
    await page.emulateMedia({ colorScheme: 'dark' });
    await radio(page, 'Light').click();
    await mode(page, false);
    await radio(page, 'System').click();
    await mode(page, true);
    await page.emulateMedia({ colorScheme: 'light' });
    await mode(page, false);
    assert.ok((await page.locator('.runtime-sheet').boundingBox()).height >= 520);
  } finally { await context.close(); }
});

test('all seven sizes scale the sample and real editor, preserve text/history and persist across reload', { timeout: 90_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'light' });
  try {
    const page = await open(context);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    const editor = page.locator('.cm-content');
    await editor.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Kept text.');
    await page.waitForFunction(() => document.querySelector('[data-testid="runtime-history"]').textContent === 'true');
    const text = await editor.textContent();
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    for (const percent of [110, 120, 135, 150]) {
      await page.getByRole('button', { name: 'Larger text', exact: true }).click();
      await page.getByText(`${percent}%`, { exact: true }).waitFor();
    }
    assert.equal(await page.getByRole('button', { name: 'Larger text', exact: true }).isDisabled(), true);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.cm-content')).fontSize === '28.5px');
    const sample = await page.getByTestId('appearance-preview').locator('div').last().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    assert.equal(sample, 28.5);
    assert.equal(await editor.textContent(), text);
    assert.equal(await page.getByTestId('runtime-history').textContent(), 'true');
    for (const percent of [135, 120, 110, 100, 90, 80]) {
      await page.getByRole('button', { name: 'Smaller text', exact: true }).click();
      await page.getByText(`${percent}%`, { exact: true }).waitFor();
    }
    assert.equal(await page.getByRole('button', { name: 'Smaller text', exact: true }).isDisabled(), true);
    await radio(page, 'Dark').click();
    await page.reload();
    await page.getByText('80%', { exact: true }).waitFor();
    assert.equal(await radio(page, 'Dark').getAttribute('aria-checked'), 'true');
    await mode(page, true);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.cm-content')).fontSize === '15.2px');
  } finally { await context.close(); }
});

test('200% Dynamic Type model and narrow width keep Done and both size controls reachable', { timeout: 90_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 320, height: 844 }, colorScheme: 'dark' });
  try {
    const page = await open(context, '?fontScale=2');
    await mode(page, true);
    await checkHits(page);
    const modes = await Promise.all(['Light', 'Dark', 'System'].map((name) => radio(page, name).boundingBox()));
    assert.ok(modes[0].y + modes[0].height <= modes[1].y && modes[1].y + modes[1].height <= modes[2].y, 'large mode labels must not overlap');
    await page.screenshot({ path: resolve(shots, 'phone-web-accessibility.png') });
    await page.getByRole('button', { name: 'Larger text', exact: true }).click();
    await page.getByText('110%', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Smaller text', exact: true }).click();
    await page.getByText('100%', { exact: true }).waitFor();
    await page.getByText('New York', { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(shots, 'phone-web-accessibility-controls.png') });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    assert.equal(await page.getByTestId('appearance-panel').count(), 0);
  } finally { await context.close(); }
});
