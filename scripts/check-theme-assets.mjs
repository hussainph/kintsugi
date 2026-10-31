#!/usr/bin/env node
// Verify actual font faces and approved contrast in a running loopback Lab.
// Missing Timeless is a reported licensing gate, never a successful font load.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const require = createRequire(new URL('../packages/lab/package.json', import.meta.url));
const { chromium } = require('playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const base = new URL(option('--url', 'http://127.0.0.1:4415'));
assert.equal(base.protocol, 'http:');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Loopback only');
const out = path.join(root, '.headless/theme-assets');
await mkdir(out, { recursive: true });
const report = { checkedAt: new Date().toISOString(), fonts: [], contrast: [], errors: [], screenshots: [], blocked: [] };
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on('pageerror', error => report.errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
async function open(story, mode) {
  const url = new URL(base);
  url.search = new URLSearchParams({ preview: 'component/graphical-catalog', story });
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__LAB_READY__);
  await page.evaluate(mode => window.postMessage({
    type: 'lab:scenario',
    scenario: { theme: mode, density: 'comfortable', width: 1440, textScale: 1, reducedMotion: true },
    values: { disabled: false },
  }, location.origin), mode);
  await page.waitForFunction(mode => document.querySelector('.graphical-theme')?.dataset.colorMode === mode, mode);
}
async function paint(locator, pseudo = null) {
  return locator.evaluate((element, pseudo) => {
    const style = getComputedStyle(element, pseudo);
    return { background: style.backgroundColor, color: style.color, outline: style.outlineColor,
      outlineStyle: style.outlineStyle, shadow: style.boxShadow,
      family: style.fontFamily, size: style.fontSize };
  }, pseudo);
}
function contrastRatio(a, b) {
  function luminance(value) {
    const channels = value.match(/^rgb\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)\s*\)$/);
    assert(channels, `Expected opaque computed RGB, got ${value}`);
    const rgb = channels.slice(1).map(channel => Number(channel) / 255)
      .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
  }
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}
function checkContrast(name, foreground, background, minimum = 3) {
  const ratio = contrastRatio(foreground, background);
  report.contrast.push({ name, foreground, background, ratio, minimum, passed: ratio >= minimum });
  assert(ratio >= minimum, `${name}: ${ratio.toFixed(2)}:1 must reach ${minimum}:1`);
}
try {
  await open('controls', 'light');
  for (const [family, weights] of [
    ['LT Superior Serif', [400, 500, 700]],
    ['Sidebar Geist Mono', [400, 500, 600]],
    ['Timeless Sans', [400, 500, 600]],
  ]) {
    const results = await page.evaluate(async ({ family, weights }) => {
      const results = [];
      for (const weight of weights) {
        const faces = await document.fonts.load(`${weight} 16px "${family}"`, 'Kintsugi');
        results.push({ weight, check: document.fonts.check(`${weight} 16px "${family}"`, 'Kintsugi'),
          faces: faces.map(face => ({ family: face.family, weight: face.weight, style: face.style, status: face.status })) });
      }
      return results;
    }, { family, weights });
    const loaded = results.every(result => result.check && result.faces.some(face =>
      face.family.replaceAll('"', '').replaceAll("'", '') === family && face.status === 'loaded'));
    if (!loaded && family === 'Timeless Sans' && args.includes('--allow-blocked-timeless')) {
      assert(results.every(result => result.faces.length === 0), 'Do not mix unlicensed Timeless faces into the page');
      report.blocked.push('Timeless Sans: supplied v1.2 license repository-bundling gate; no face shipped');
    } else assert(loaded, `${family}: real faces must load, not fallback-only document.fonts.check`);
    report.fonts.push({ family, loaded, results });
  }
  for (const mode of ['light', 'dark']) {
    await open('controls', mode);
    await page.evaluate(() => document.fonts.ready);
    const filename = `controls-${mode}.png`;
    await page.screenshot({ path: path.join(out, filename), fullPage: true, animations: 'disabled' });
    report.screenshots.push(filename);
  }
  await open('controls', 'dark');
  const scope = page.locator('.graphical-theme');
  const identity = await scope.evaluate(element => {
    const style = getComputedStyle(element);
    return { name: element.dataset.graphicalTheme, resolver: style.getPropertyValue('--theme-name').trim(),
      palette1: style.getPropertyValue('--color-1').trim(), canvas: style.backgroundColor,
      neutral9: style.getPropertyValue('--neutral-9').trim(), neutral10: style.getPropertyValue('--neutral-10').trim() };
  });
  report.identity = identity;
  assert.equal(identity.name, 'Charter'); assert.equal(identity.resolver, 'Paper');
  assert.equal(identity.palette1, '#0a0a0a', 'Palette is not recolored');
  const specimen = name => page.locator(`[data-catalog-component="${name}"]`);
  const checkbox = specimen('Checkbox').getByRole('checkbox', { name: 'Keep in the library' });
  const fill = await paint(checkbox, '::before');
  const mark = await paint(checkbox.locator('[data-slot="checkbox-indicator"] svg'));
  checkContrast('checked checkbox fill / canvas', fill.background, identity.canvas);
  checkContrast('checkbox mark / fill', mark.color, fill.background, 4.5);
  const group = specimen('CheckboxGroup').getByRole('checkbox', { name: 'All sources' });
  checkContrast('mixed group checkbox / canvas', (await paint(group)).background, identity.canvas);
  const radio = specimen('Radio').getByRole('radio', { name: 'private', exact: true });
  checkContrast('radio dot / canvas', (await paint(radio.locator('.ui-radio-dot'))).background, identity.canvas);
  const sw = specimen('Switch').getByRole('switch', { name: 'Show references' });
  const checkedTrack = await paint(sw);
  checkContrast('checked switch track / canvas', checkedTrack.background, identity.canvas);
  checkContrast('checked switch thumb / track', (await paint(sw.locator('.themed-switch-thumb'))).background, checkedTrack.background);
  await sw.focus(); await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('[data-catalog-component="Switch"] [role="switch"]')?.getAttribute('aria-checked') === 'false');
  checkContrast('unchecked switch thumb / track', (await paint(sw.locator('.themed-switch-thumb'))).background, (await paint(sw)).background);
  const title = specimen('Input').getByRole('textbox', { name: 'Title' });
  await title.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
  const focused = await paint(title);
  assert.equal(focused.outlineStyle, 'solid');
  checkContrast('keyboard focus outline / canvas', focused.outline, identity.canvas);
  await page.screenshot({ path: path.join(out, 'dark-input-focus.png'), animations: 'disabled' });
  report.screenshots.push('dark-input-focus.png');
  await open('overlays', 'dark');
  const preview = specimen('PreviewCard').getByRole('link', { name: 'On craft', exact: true });
  checkContrast('PreviewCard link / canvas', (await paint(preview)).color, identity.canvas, 4.5);
  await preview.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
  assert(await preview.evaluate(element => element === document.activeElement), 'Keyboard focus returns to PreviewCard trigger');
  const previewFocus = await paint(preview);
  assert.equal(previewFocus.outlineStyle, 'solid');
  checkContrast('PreviewCard focus / canvas', previewFocus.outline, identity.canvas);
  await page.locator('[data-ui-component="preview-card"][data-ui-part="popover"]').waitFor({ state: 'visible' });
  await page.screenshot({ path: path.join(out, 'dark-preview-card.png'), animations: 'disabled' });
  report.screenshots.push('dark-preview-card.png');
  await open('feedback', 'dark');
  for (const name of ['Slider', 'Meter', 'Progress']) {
    const s = specimen(name);
    checkContrast(`${name} fill / track`, (await paint(s.locator('[data-ui-part="indicator"]').first())).background,
      (await paint(s.locator('[data-ui-part="track"]').first())).background);
  }
  assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
  console.log(`Font checks: ${report.fonts.filter(font => font.loaded).length} families loaded; ${report.blocked.length} licensing gate(s)`);
  console.log(`Approved dark contrast: ${report.contrast.length}/${report.contrast.length} checks passed; identity and palette unchanged`);
} finally {
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await browser.close();
}
