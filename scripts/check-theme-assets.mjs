#!/usr/bin/env node
// Verify real font loads/rendering and approved contrast in a running loopback Lab.
// Start no servers here; all three selected families are mandatory in both modes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const require = createRequire(new URL('../packages/lab/package.json', import.meta.url));
const { chromium } = require('playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
assert(args.every((arg, index) => arg === '--url' || args[index - 1] === '--url'), 'Only --url is supported; no font-loading bypasses');
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const base = new URL(option('--url', 'http://127.0.0.1:4415'));
assert.equal(base.protocol, 'http:');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Loopback only');
assert(!base.username && !base.password && !base.search && !base.hash, 'Use a plain Lab URL, never a capability');
const out = path.join(root, '.headless/theme-assets');
await mkdir(out, { recursive: true });
const safe = value => String(value).replaceAll(root, '[workspace]/').replace(/https?:\/\/[^\s"'<>]+/g, '[URL]')
  .replace(/\/(?:Users|home)\/[^\s"'<>:)]+/g, '[local path]');
const report = { checkedAt: new Date().toISOString(), fonts: [], typography: [], renderedFonts: [], axes: [], contrast: [], errors: [], screenshots: [] };
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const cdp = await page.context().newCDPSession(page);
await cdp.send('DOM.enable');
await cdp.send('CSS.enable');
page.on('pageerror', error => report.errors.push(safe(error.message)));
page.on('console', message => { if (message.type() === 'error') report.errors.push(safe(message.text())); });
const specimen = name => page.locator(`[data-catalog-component="${name}"]`);
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
async function shot(filename, locator = page) {
  const bytes = await locator.screenshot({ path: path.join(out, filename), animations: 'disabled', ...(locator === page ? { fullPage: true } : { scale: 'css' }) });
  report.screenshots.push(path.relative(root, path.join(out, filename)));
  return bytes;
}
async function typography(locator) {
  return locator.evaluate(element => {
    const style = getComputedStyle(element);
    return { family: style.fontFamily, weight: style.fontWeight, style: style.fontStyle,
      variationSettings: style.fontVariationSettings, inRootTheme: !!element.closest('.graphical-theme') };
  });
}
function assertSans(style, label) {
  assert.match(style.family, /Timeless Sans/, `${label}: selected UI family`);
  assert.equal(style.style, 'normal', `${label}: real upright face`);
  const axes = [...style.variationSettings.matchAll(/["'](\w{4})["']\s+(-?[\d.]+)/g)];
  assert.deepEqual(Object.fromEntries(axes.map(([, axis, value]) => [axis, Number(value)])), { STYL: 100, ital: 0 }, `${label}: Sans, not Grotesk, axes reach the actual consumer`);
}
async function loadFonts(mode) {
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
          faces: faces.map(face => ({ family: face.family, weight: face.weight, style: face.style,
            status: face.status, variationSettings: face.variationSettings ?? null })) });
      }
      return results;
    }, { family, weights });
    const loaded = results.every(result => result.check && result.faces.some(face =>
      face.family.replaceAll('"', '').replaceAll("'", '') === family && face.status === 'loaded' && face.style === 'normal'));
    report.fonts.push({ mode, family, loaded, results });
    assert(loaded, `${mode} ${family}: real faces must load, not fallback-only document.fonts.check`);
    if (family === 'Timeless Sans') for (const result of results) {
      assert(result.faces.every(face => face.weight === '300 800'), 'Timeless must use the truthful variable range');
    }
  }
}
async function platformFonts(selector, details) {
  const { root: document } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: document.nodeId, selector });
  assert(nodeId, `Rendered probe exists: ${selector}`);
  const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
  const used = fonts.filter(font => font.glyphCount > 0);
  report.renderedFonts.push({ ...details, fonts: used });
  assert(used.length > 0, 'CDP must identify actual rendered ASCII glyphs');
  assert(used.every(font => font.isCustomFont && /Timeless/i.test(font.familyName)), 'No system-font fallback is allowed in the Timeless ASCII probes');
}
async function renderedSans(mode) {
  await page.locator('.graphical-theme').evaluate(scope => {
    const probes = document.createElement('div');
    probes.id = 'timeless-font-probes';
    probes.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;background:white;color:black;padding:8px;pointer-events:none';
    for (const weight of [400, 500, 600]) {
      const probe = document.createElement('div');
      probe.id = `timeless-font-probe-${weight}`;
      probe.textContent = 'Kintsugi Sans Hamburgefonts minimum 0123456789';
      // Inherit the real UI family/axes; only the requested weight and test geometry differ.
      probe.style.cssText = `font-weight:${weight};font-size:32px;line-height:48px;letter-spacing:0;width:1100px;height:48px;white-space:nowrap`;
      probes.append(probe);
    }
    scope.append(probes);
  });
  try {
    await page.evaluate(() => document.fonts.ready);
    for (const weight of [400, 500, 600]) {
      const selector = `#timeless-font-probe-${weight}`;
      const computed = await typography(page.locator(selector));
      assertSans(computed, `${mode} rendered ${weight}`);
      assert.equal(computed.weight, String(weight));
      await platformFonts(selector, { mode, weight, computed });
    }
    const probe = page.locator('#timeless-font-probe-400');
    const inherited = await probe.screenshot({ animations: 'disabled', scale: 'css' });
    await probe.evaluate(element => { element.style.fontVariationSettings = '"STYL" 100, "ital" 0'; });
    const sans = await shot(`timeless-${mode}-styl100.png`, probe);
    await probe.evaluate(element => { element.style.fontVariationSettings = '"STYL" 0, "ital" 0'; });
    const grotesk = await shot(`timeless-${mode}-styl0.png`, probe);
    const evidence = { mode, weight: 400, inheritedMatchesSans: inherited.equals(sans), sansDiffersFromGrotesk: !sans.equals(grotesk),
      sansSha256: createHash('sha256').update(sans).digest('hex'), groteskSha256: createHash('sha256').update(grotesk).digest('hex') };
    report.axes.push(evidence);
    assert(evidence.inheritedMatchesSans, 'Inherited UI axes must render exactly like explicit STYL=100/ital=0');
    assert(evidence.sansDiffersFromGrotesk, 'STYL=100 and STYL=0 must produce different glyph rendering');
  } finally {
    await page.locator('#timeless-font-probes').evaluate(element => element.remove());
  }
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
  for (const mode of ['light', 'dark']) {
    await open('controls', mode);
    await loadFonts(mode);
    const control = await typography(specimen('Button').getByRole('button', { name: 'primary', exact: true }));
    const input = await typography(specimen('Input').getByRole('textbox', { name: 'Title' }));
    report.typography.push({ mode, control, input });
    assertSans(control, `${mode} button`); assertSans(input, `${mode} input`);
    assert.equal(input.weight, '400');
    await shot(`controls-${mode}.png`);
    await renderedSans(mode);
    await open('overlays', mode);
    await specimen('Popover').getByRole('button', { name: 'Draft details', exact: true }).click();
    const popup = page.getByRole('dialog', { name: 'Draft details', exact: true });
    await popup.waitFor({ state: 'visible' });
    const portal = await typography(popup);
    const portalAction = await typography(popup.getByRole('button', { name: 'Done', exact: true }));
    report.typography.push({ mode, portal, portalAction });
    assertSans(portal, `${mode} portalled popup`); assertSans(portalAction, `${mode} portalled action`);
    assert.equal(portal.inRootTheme, false, 'Exercise a real body portal, not an in-root stand-in');
    await shot(`popover-${mode}.png`);
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
  await shot('dark-input-focus.png');
  await open('overlays', 'dark');
  const preview = specimen('PreviewCard').getByRole('link', { name: 'On craft', exact: true });
  checkContrast('PreviewCard link / canvas', (await paint(preview)).color, identity.canvas, 4.5);
  await preview.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
  assert(await preview.evaluate(element => element === document.activeElement), 'Keyboard focus returns to PreviewCard trigger');
  const previewFocus = await paint(preview);
  assert.equal(previewFocus.outlineStyle, 'solid');
  checkContrast('PreviewCard focus / canvas', previewFocus.outline, identity.canvas);
  await page.locator('[data-ui-component="preview-card"][data-ui-part="popover"]').waitFor({ state: 'visible' });
  await shot('dark-preview-card.png');
  await open('feedback', 'dark');
  for (const name of ['Slider', 'Meter', 'Progress']) {
    const s = specimen(name);
    checkContrast(`${name} fill / track`, (await paint(s.locator('[data-ui-part="indicator"]').first())).background,
      (await paint(s.locator('[data-ui-part="track"]').first())).background);
  }
  assert.equal(report.contrast.length, 13, 'Preserve all approved contrast assertions');
  assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
  report.passed = true;
  console.log('Font checks: all 3 families loaded in light/dark; Timeless 400/500/600 rendered via CDP; Sans/Grotesk axis probes differ');
  console.log(`Approved dark contrast: ${report.contrast.length}/${report.contrast.length} checks passed; identity and palette unchanged`);
} catch (error) {
  report.passed = false;
  report.errors.push(safe(error.message || error));
  throw error;
} finally {
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await browser.close();
}
