#!/usr/bin/env node
/** KI-20 bounded desktop UI verification against a real, already-running scratch
 * headless vault. Never starts a native window or reads provider credentials.
 *
 * KINTSUGI_THEME_URL=<local capability URL> node scripts/check-desktop-theme.mjs
 * Artifacts: .lab-artifacts/ki-20/desktop (never stores the URL/session/token).
 * This deliberately creates one scratch document and one text clip per mode.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const require = createRequire(new URL('../packages/lab/package.json', import.meta.url));
const { chromium } = require('playwright');
const capability = process.env.KINTSUGI_THEME_URL;
if (!capability) throw new Error('Set KINTSUGI_THEME_URL to the already-running local scratch headless URL.');
const url = new URL(capability);
const fragment = new URLSearchParams(url.hash.slice(1));
const backend = new URL(fragment.get('headless') || 'http://invalid.invalid');
for (const target of [url, backend]) {
  assert.equal(target.protocol, 'http:', 'Only a local HTTP headless server is allowed.');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname), 'Only loopback is allowed.');
}
assert.ok(fragment.get('token'), 'A scratch headless capability is required.');
const secret = fragment.get('token');
const safe = value => String(value).replaceAll(capability, '[local capability]')
  .replaceAll(secret, '[redacted]').replace(/(?:#|&|\b)token=[^\s"'<>]+/g, 'token=[redacted]');
const root = fileURLToPath(new URL('..', import.meta.url));
const out = resolve(root, '.lab-artifacts/ki-20/desktop');
await mkdir(out, { recursive: true });
const report = {
  run: new Date().toISOString(), browser: 'existing Google Chrome, headless:true',
  viewport: { width: 1440, height: 1000 }, results: [], screenshots: [],
  modes: {}, console: [], pageErrors: [], requestFailures: [], httpErrors: [], observations: [],
  limitations: [
    'Scratch-vault UI only; no native Tauri window, OS phone settings, provider credentials, or owner vault.',
    'LT Superior Serif 400/500/700 and Geist Mono are loaded. Timeless Sans remains absent pending the supplied v1.2 license redistribution gate; no font-complete parity claim.',
    'AI disabled: verify unauthenticated Refine error only; no generated revision or accept/retry network success.',
  ],
};
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const stamp = Date.now().toString(36);

async function visible(locator) { await locator.waitFor({ state: 'visible' }); return locator; }
async function shot(page, mode, name) {
  const filename = `${mode}-${name}.png`;
  await page.screenshot({ path: resolve(out, filename), fullPage: true, animations: 'disabled' });
  report.screenshots.push(filename);
  return filename;
}
async function style(locator) {
  return locator.evaluate(el => {
    const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return {
      component: el.getAttribute('data-ui-component'), part: el.getAttribute('data-ui-part'),
      themeAttribute: el.getAttribute('data-graphical-theme'), modeAttribute: el.getAttribute('data-color-mode'),
      inRootTheme: !!el.closest('.graphical-theme'),
      themeName: s.getPropertyValue('--theme-name').trim(), neutral1: s.getPropertyValue('--neutral-1').trim(),
      uiFont: s.getPropertyValue('--font-ui').trim(), editorialFont: s.getPropertyValue('--font-editorial').trim(),
      font: s.fontFamily, weight: s.fontWeight, size: s.fontSize, line: s.lineHeight, tracking: s.letterSpacing,
      background: s.backgroundColor, color: s.color, borderWidth: s.borderWidth, shadow: s.boxShadow,
      padding: s.padding, radius: s.borderRadius, textWrap: s.textWrapStyle, colorScheme: s.colorScheme,
      tokenSpaceL: s.getPropertyValue('--space-l').trim(), tokenSizeL: s.getPropertyValue('--size-l').trim(),
      tokenLineL: s.getPropertyValue('--line-l').trim(), tokenTrackingL: s.getPropertyValue('--letter-spacing-l').trim(),
      box: { x: r.x, y: r.y, width: r.width, height: r.height },
    };
  });
}
async function check(mode, name, action, page) {
  try {
    const details = await action();
    report.results.push({ mode, name, status: 'passed', ...(details === undefined ? {} : { details }) });
    console.log(`PASS ${mode}: ${name}`);
  } catch (error) {
    const message = safe(error.stack || error);
    report.results.push({ mode, name, status: 'failed', error: message });
    console.log(`FAIL ${mode}: ${name}: ${safe(error.message || error).split('\n')[0]}`);
    try { await shot(page, mode, `failure-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`); } catch {}
    // Keep independent states running, including while another agent fixes shared CSS.
    try { await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); } catch {}
  }
}
async function verifyPortal(locator, mode, component, { padding } = {}) {
  const s = await style(locator);
  assert.equal(s.component, component);
  assert.equal(s.part, 'popover');
  assert.match(s.font, /Timeless Sans/);
  assert.equal(s.neutral1.toLowerCase(), mode === 'dark' ? '#191919' : '#ffffff');
  assert.equal(s.borderWidth, '0px');
  if (padding) assert.equal(s.padding, padding);
  return s;
}
async function openCraft(page) {
  await page.keyboard.press('Meta+p');
  const input = await visible(page.getByPlaceholder('Jump to a document…'));
  await input.fill('On craft and repair');
  await page.locator('[cmdk-item]').filter({ hasText: 'On craft and repair' }).waitFor();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.getByPlaceholder('Jump to a document…').waitFor({ state: 'hidden' });
  await visible(page.locator('.cm-content'));
  await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent.includes('There is a moment'));
}
async function openLibrary(page) {
  await page.keyboard.press('Meta+Shift+i');
  const library = await visible(page.getByRole('region', { name: 'Inspiration library' }));
  await page.waitForFunction(() => document.querySelector('[aria-label="Inspiration library"]')?.getAttribute('aria-busy') === 'false');
  return library;
}
async function countIcons(page) {
  const result = await page.evaluate(() => ({
    hugeicons: document.querySelectorAll('svg[data-icon-family="Hugeicons"]').length,
    lucide: document.querySelectorAll('svg[data-icon-family="Lucide"], svg.lucide').length,
    fallback: [...document.querySelectorAll('[data-icon-fallback]')].map(n => n.getAttribute('data-icon-fallback')),
    unavailable: document.querySelectorAll('[data-icon-unavailable="true"]').length,
    loading: document.querySelectorAll('[data-icon-loading="true"]').length,
    weights: [...new Set([...document.querySelectorAll('svg[data-icon-family="Hugeicons"]')].map(n => getComputedStyle(n).strokeWidth))],
  }));
  assert.ok(result.hugeicons > 0);
  assert.equal(result.lucide, 0); assert.deepEqual(result.fallback, []); assert.equal(result.unavailable, 0); assert.equal(result.loading, 0);
  return result;
}

try {
 for (const mode of ['light', 'dark']) {
  const context = await browser.newContext({ viewport: report.viewport, colorScheme: mode === 'light' ? 'dark' : 'light' });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) report.console.push({mode, type: message.type(), text: safe(message.text()), location: safe(JSON.stringify(message.location()))}); });
  page.on('response', response => { if (response.status() >= 400) report.httpErrors.push({mode, status:response.status(), url:safe(response.url().split('#')[0])}); });
  page.on('pageerror', error => report.pageErrors.push({mode, text: safe(error.stack || error)}));
  page.on('requestfailed', request => report.requestFailures.push({mode, url: safe(request.url().split('#')[0]), failure: safe(request.failure()?.errorText)}));
  report.modes[mode] = {};
  await check(mode, 'system mode and theme typography', async () => {
    await page.goto(capability);
    await visible(page.locator('.cm-content'));
    // Exercise the real live matchMedia listener rather than toggling .dark.
    await page.emulateMedia({ colorScheme: mode });
    await page.locator(`.graphical-theme[data-color-mode="${mode}"]`).waitFor();
    const state = await page.evaluate(async () => {
      const serif = [];
      for (const weight of [400, 500, 700]) {
        const faces = await document.fonts.load(`${weight} 16px "LT Superior Serif"`, 'Kintsugi');
        serif.push({ weight, loaded: faces.some(face => face.family.replaceAll('"', '') === 'LT Superior Serif' && face.status === 'loaded') });
      }
      return {
        hashCleared: location.hash === '', darkMedia: matchMedia('(prefers-color-scheme: dark)').matches,
        darkClass: document.documentElement.classList.contains('dark'),
        theme: document.querySelector('.graphical-theme')?.getAttribute('data-graphical-theme'),
        colorMode: document.querySelector('.graphical-theme')?.getAttribute('data-color-mode'),
        fonts: [...document.fonts].map(f => ({family:f.family, status:f.status, weight:f.weight})),
        serif,
      };
    });
    assert(state.serif.every(face => face.loaded), 'Actual LT Superior Serif faces load at all requested weights');
    assert.ok(state.hashCleared); assert.equal(state.darkMedia, mode === 'dark'); assert.equal(state.darkClass, mode === 'dark');
    assert.equal(state.colorMode, mode); assert.ok(state.theme);
    await openCraft(page);
    const editor = await style(page.locator('.cm-scroller'));
    const sidebar = await style(page.locator('[data-sidebar="menu-button"]').filter({hasText:'Inspiration'}));
    const data = await style(page.locator('.ki-document-status .ki-data'));
    assert.match(editor.font, /LT Superior Serif/); assert.equal(editor.weight, '400');
    assert.equal(editor.size, '23px'); assert.equal(editor.line, '31px'); assert.equal(editor.tracking, '-1.035px');
    assert.match(sidebar.font, /Timeless Sans/); assert.match(data.font, /Sidebar Geist Mono/);
    assert.equal(editor.neutral1.toLowerCase(), mode === 'dark' ? '#191919' : '#ffffff');
    report.modes[mode].root = state;
    report.modes[mode].typography = { editor, sidebar, data };
    return { ...state, icons: await countIcons(page) };
  }, page);
  await check(mode, 'writing editor reference margin sidebar', async () => {
    await openCraft(page);
    const showMargin = page.getByRole('button', {name:'Show reference margin', exact:true});
    if (await showMargin.isVisible()) await showMargin.click();
    const margin = await visible(page.getByRole('complementary', {name:'Reference margin'}));
    await visible(margin.getByRole('heading', {name:'Referenced here'}));
    await visible(margin.getByRole('button', {name:'Golden joinery Encyclopaedia Britannica'}));
    await visible(page.locator('.ki-document-status [role="status"]').filter({hasText:'Saved'}));
    await shot(page, mode, 'writing');
    const panels = await page.locator('[data-slot="collapsible-content"]').evaluateAll(nodes => nodes.map(el => ({
      padding:getComputedStyle(el).padding,
      background:getComputedStyle(el).backgroundColor,
      childPadding:el.firstElementChild && getComputedStyle(el.firstElementChild).padding,
      height:el.getBoundingClientRect().height,
    })));
    assert.ok(panels.length > 0, 'The sidebar must expose its collapsible panels.');
    for (const panel of panels) {
      assert.equal(panel.padding, '0px', 'Collapsible outer panel padding must not duplicate its inner authored spacing.');
      assert.equal(panel.childPadding, '11px', 'Collapsible inner content must preserve the authored 11px padding.');
    }
    return { margin: await style(margin), references: await margin.locator('.reference-card').count(), panels, icons: await countIcons(page) };
  }, page);
  await check(mode, 'command palette keyboard search and select', async () => {
    await page.keyboard.press('Meta+p');
    const input = await visible(page.getByPlaceholder('Jump to a document…'));
    await input.fill('quiet web');
    const option = await visible(page.getByRole('option').filter({hasText:'The quiet web'}));
    const portal = await verifyPortal(page.getByRole('dialog', {name:'Jump to a document'}), mode, 'dialog', {padding:'0px'});
    await page.keyboard.press('ArrowDown');
    const selected = await option.getAttribute('data-selected'); assert.equal(selected, 'true');
    await shot(page, mode, 'command-palette');
    await page.keyboard.press('Enter');
    await input.waitFor({state:'hidden'});
    await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent.includes('Most of the web'));
    return { selected, portal, icons: await countIcons(page) };
  }, page);
  await check(mode, 'new document keyboard form and save', async () => {
    const title = `KI20 desktop ${mode} ${stamp}`;
    await page.keyboard.press('Meta+n');
    const input = await visible(page.getByPlaceholder(/Title of a new document/));
    await input.fill(title);
    await visible(page.getByRole('option', {name:`Create “${title}”`}));
    await shot(page, mode, 'new-document-form');
    await page.keyboard.press('Enter');
    await input.waitFor({state:'hidden'});
    await page.waitForFunction(title => document.querySelector('.cm-content')?.textContent.includes(title), title);
    await visible(page.locator('[data-sidebar="menu-button"]').filter({hasText:title}));
    // Keyboard-only text edit, then app save shortcut, against the scratch vault.
    await page.locator('.cm-content').focus();
    await page.keyboard.press('Meta+End');
    await page.keyboard.type(`\n\nScratch verification ${mode} ${stamp}.`);
    await page.keyboard.press('Meta+s');
    await visible(page.locator('.ki-document-status [role="status"]').filter({hasText:'Saved'}));
    await shot(page, mode, 'new-document-created');
    // Navigate away/back through the public palette to prove backend persistence.
    await openCraft(page);
    await page.keyboard.press('Meta+p');
    await page.getByPlaceholder('Jump to a document…').fill(title);
    await page.keyboard.press('Enter');
    await page.waitForFunction(text => document.querySelector('.cm-content')?.textContent.includes(text), `Scratch verification ${mode} ${stamp}.`);
    return { title, savedAndReopened:true };
  }, page);
  await check(mode, 'sidebar context menu keyboard', async () => {
    const row = page.locator('[data-sidebar="menu-button"]').filter({hasText:'On craft and repair'});
    // Chrome on macOS supports ContextMenu; Shift+F10 is not its menu key.
    await row.focus(); await page.keyboard.press('ContextMenu');
    const menu = await visible(page.getByRole('menu'));
    const portal = await verifyPortal(menu, mode, 'context-menu');
    await page.keyboard.press('ArrowDown');
    const focus = await page.evaluate(() => ({role:document.activeElement?.getAttribute('role'),text:document.activeElement?.textContent}));
    assert.equal(focus.role, 'menuitem');
    await shot(page, mode, 'sidebar-context-menu');
    await page.keyboard.press('Home');
    // Radix roving focus applies Home asynchronously; Enter must reach that
    // focused first item rather than racing the preceding item.
    await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'menuitem' && document.activeElement?.textContent === 'New document⌘N');
    await page.keyboard.press('Enter');
    await visible(page.getByPlaceholder(/Title of a new document/));
    await page.keyboard.press('Escape');
    return { portal, focus, firstActionOpensCreate:true };
  }, page);
  await check(mode, 'status tooltip portal', async () => {
    await openCraft(page);
    await page.getByRole('button', {name:/Status: .*Toggle status/}).hover();
    const tooltip = await visible(page.getByRole('tooltip', {name:'Toggle status (⇧⌘D)'}));
    // Radix exposes the accessible tooltip in a nested hidden-from-layout copy;
    // the outer themed popover owns the rendered styles.
    const popover = page.locator('[data-ui-component="tooltip"][data-ui-part="popover"]').filter({hasText:'Toggle status (⇧⌘D)'}).first();
    const portal = await verifyPortal(popover, mode, 'tooltip');
    await shot(page, mode, 'tooltip');
    // Radix's pointer grace-area subscribes on pointerleave; use real motion
    // rather than a one-event jump with no following pointermove.
    await page.mouse.move(700, 500, {steps:10});
    await page.mouse.move(690, 490);
    await tooltip.waitFor({state:'hidden'});
    return { portal };
  }, page);
  await check(mode, 'inspiration cards search and tag filters', async () => {
    const library = await openLibrary(page);
    await visible(page.locator('[data-clip-path]').first());
    const cardCount = await page.locator('[data-clip-path]').count();
    assert.ok(cardCount > 0);
    await page.waitForFunction(() => [...document.querySelectorAll('[data-clip-path] img')].every(img => img.complete && img.naturalWidth > 0));
    await shot(page, mode, 'library');
    const search = page.getByRole('searchbox', {name:'Search inspiration'});
    await search.fill('golden');
    await visible(page.getByRole('button', {name:'Open Golden joinery', exact:true}));
    await page.waitForFunction(() => document.querySelector('[aria-label="Inspiration library"]')?.getAttribute('aria-busy') === 'false');
    assert.equal(await page.locator('[data-clip-path]').count(), 1);
    await shot(page, mode, 'library-search');
    await search.fill('');
    await page.waitForFunction(() => document.querySelector('[aria-label="Inspiration library"]')?.getAttribute('aria-busy') === 'false');
    const craft = library.getByRole('button', {name:'craft', exact:true});
    await craft.click(); assert.equal(await craft.getAttribute('aria-pressed'), 'true');
    await page.waitForFunction(() => document.querySelector('[aria-label="Inspiration library"]')?.getAttribute('aria-busy') === 'false');
    await visible(page.getByRole('button', {name:'Open Golden joinery', exact:true}));
    await shot(page, mode, 'library-tag-filter');
    await library.getByRole('button', {name:'Clear', exact:true}).click();
    return { initialVisibleCards:cardCount, searchResults:1, tag:'craft', tagPressed:true, icons:await countIcons(page) };
  }, page);
  await check(mode, 'all tags filter popover', async () => {
    await openLibrary(page);
    await page.getByRole('button', {name:'All tags', exact:true}).click();
    const popover = await visible(page.locator('[data-ui-component="popover"][data-ui-part="popover"]'));
    const portal = await verifyPortal(popover, mode, 'popover');
    await visible(popover.getByText('Filter by tags', {exact:true}));
    const tags = await popover.getByRole('button').allTextContents(); assert.ok(tags.length > 8);
    await shot(page, mode, 'all-tags-popover');
    await page.keyboard.press('Escape');
    return { portal, tags };
  }, page);
  await check(mode, 'clip detail and Used in backlinks', async () => {
    await openLibrary(page);
    await page.getByRole('searchbox', {name:'Search inspiration'}).fill('golden');
    const card = await visible(page.getByRole('button', {name:'Open Golden joinery', exact:true}));
    await card.focus(); await page.keyboard.press('Enter');
    const title = await visible(page.getByRole('textbox', {name:'Clip title', exact:true}));
    assert.equal(await title.inputValue(), 'Golden joinery');
    const usedIn = await visible(page.getByRole('region', {name:'Used in', exact:true}));
    const backlink = await visible(usedIn.getByRole('button', {name:'On craft and repair', exact:true}));
    const backlinks = await usedIn.getByRole('button').allTextContents();
    await shot(page, mode, 'clip-detail');
    await usedIn.scrollIntoViewIfNeeded(); await shot(page, mode, 'clip-used-in');
    const typography = {title:await style(title), note:await style(page.getByRole('textbox', {name:'Your words'}))};
    assert.match(typography.title.font, /LT Superior Serif/); assert.match(typography.note.font, /LT Superior Serif/);
    await backlink.click();
    await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent.includes('There is a moment'));
    return { backlinks, backlinkOpensWriting:true, typography };
  }, page);
  await check(mode, 'capture dialog keyboard submit success toast', async () => {
    await openLibrary(page);
    await page.getByRole('button', {name:'Keep something', exact:true}).click();
    const dialog = await visible(page.getByRole('dialog', {name:'Keep a little inspiration'}));
    const portal = await verifyPortal(dialog, mode, 'dialog', {padding:'22px'});
    const text = `KI20 desktop capture ${mode} ${stamp}: a small scratch thought about care and repair.`;
    const textarea = page.getByRole('textbox', {name:'URL or text to capture'});
    await textarea.fill(text);
    assert.equal(await page.getByRole('button', {name:'Keep it', exact:true}).isEnabled(), true);
    await shot(page, mode, 'capture-form');
    await page.keyboard.press('Meta+Enter');
    await dialog.waitFor({state:'hidden'});
    const toast = await visible(page.locator('[data-sonner-toast]').filter({hasText:'Saved to inspiration'}));
    const toastStyle = await style(toast);
    assert.equal(toastStyle.neutral1.toLowerCase(), mode === 'dark' ? '#191919' : '#ffffff');
    await shot(page, mode, 'capture-success');
    await page.getByRole('searchbox', {name:'Search inspiration'}).fill(`KI20 desktop capture ${mode} ${stamp}`);
    // Untitled note clips intentionally expose the accessible label “A thought”,
    // while their card body/caption contains the text. Do not assume a title.
    await visible(page.locator('[data-clip-path]').filter({hasText:text}));
    return { portal, toast:toastStyle, persistedClipVisible:true, icons:await countIcons(page) };
  }, page);
  await check(mode, 'phone unavailable error dialog and switch geometry', async () => {
    await page.locator('[data-sidebar="menu-button"]').filter({hasText:'Connect your phone'}).click();
    const dialog = await visible(page.getByRole('dialog', {name:'Connect your phone', exact:true}));
    const portal = await verifyPortal(dialog, mode, 'dialog', {padding:'22px'});
    const toggle = dialog.getByRole('switch');
    const switchGeometry = await toggle.evaluate(el => {
      const css = getComputedStyle(el);
      const thumb = getComputedStyle(el.firstElementChild);
      return { width:css.width, height:css.height, padding:css.padding, uiControl:css.getPropertyValue('--ui-control').trim(), thumb:{width:thumb.width, height:thumb.height} };
    });
    assert.equal(switchGeometry.width, '38.5px', 'Switch track must remain 1.75 times the 22px control height.');
    assert.equal(switchGeometry.height, '22px');
    assert.equal(switchGeometry.thumb.width, '16.5px');
    assert.equal(switchGeometry.thumb.height, '16.5px');
    const initiallyDisabled = await toggle.isDisabled();
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    // In this backend, phone_status is readable and the switch is not disabled.
    // phone_enable has a cfg!(feature="headless") early return before any OS or
    // config mutation (phone/mod.rs). Exercise only that blocked error path.
    if (!initiallyDisabled) await toggle.click();
    const error = await visible(page.locator('[data-sonner-toast]').filter({hasText:/[Pp]hone.*unavailable|unavailable.*[Pp]hone/}));
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    await shot(page, mode, 'phone-unavailable');
    const message = await error.textContent();
    await page.keyboard.press('Escape');
    // Let the real toast lifecycle finish so later Refine/responsive evidence
    // does not carry an unrelated phone-unavailable notification.
    await error.waitFor({state:'hidden'});
    return { portal, switchGeometry, initiallyDisabled, remainsOff:true, blockedBeforeOsMutation:true, message:safe(message) };
  }, page);
  await check(mode, 'Refine selection keyboard and unauthenticated error', async () => {
    await openCraft(page);
    const line = page.locator('.cm-line').filter({hasText:/^There is a moment/}).first();
    await line.click();
    await page.keyboard.press('Meta+ArrowLeft'); await page.keyboard.press('Meta+Shift+ArrowRight');
    const selected = await page.evaluate(() => getSelection()?.toString() || '');
    assert.ok(selected.length > 4, 'The editor must contain a real text selection.');
    await page.keyboard.press('Meta+k');
    const input = await visible(page.getByPlaceholder('Edit the selection, or describe a change…'));
    const popup = page.locator('.ki-refine-popup');
    const portal = await verifyPortal(popup, mode, 'popover', {padding:'0px'});
    await visible(page.getByRole('option', {name:'Tighten', exact:true}));
    await shot(page, mode, 'refine-selection');
    await input.fill('Tighten'); await page.keyboard.press('Enter');
    const alert = await visible(popup.getByRole('alert'));
    assert.match(await alert.textContent(), /No AI provider is set up/);
    await shot(page, mode, 'refine-unauthenticated');
    const message = await alert.textContent();
    await page.keyboard.press('Escape');
    return { selectionCharacters:selected.length, portal, message };
  }, page);
  await check(mode, 'responsive sidebar sheet keyboard toggle', async () => {
    await openCraft(page);
    await page.setViewportSize({width:620,height:900});
    await page.waitForTimeout(150);
    await page.keyboard.press('Meta+Backslash');
    const sheet = await visible(page.getByRole('dialog', {name:'Sidebar', exact:true}));
    const s = await style(sheet);
    assert.equal(s.component, 'drawer'); assert.equal(s.part, 'popover');
    assert.equal(await sheet.getAttribute('data-mobile'), 'true');
    assert.equal(s.neutral1.toLowerCase(), mode === 'dark' ? '#191919' : '#ffffff');
    assert.match(s.font, /Timeless Sans/); assert.equal(s.padding, '0px');
    const widthContract = await sheet.evaluate(el => ({
      declared:getComputedStyle(el).getPropertyValue('--sidebar-width').trim(),
      expected:18 * parseFloat(getComputedStyle(document.documentElement).fontSize),
      actual:el.getBoundingClientRect().width,
    }));
    assert.equal(widthContract.declared, '18rem');
    assert.equal(widthContract.expected, 288);
    assert.equal(widthContract.actual, 288, 'Narrow Sidebar must retain its 18rem width rather than Sheet’s 75vw variant.');
    await visible(sheet.getByRole('button', {name:'Inspiration ⇧⌘I'}));
    await shot(page, mode, 'responsive-sidebar-sheet');
    // Reuse the requested sidebar shortcut. Auto-focused navigation can open a
    // tooltip, which legitimately consumes the first Escape before the sheet.
    await page.keyboard.press('Meta+Backslash'); await sheet.waitFor({state:'hidden'});
    await shot(page, mode, 'responsive-writing');
    const width = await page.evaluate(() => ({viewport:innerWidth, document:document.documentElement.scrollWidth}));
    assert.equal(width.document, width.viewport);
    await page.setViewportSize(report.viewport);
    return { sheet:s, widthContract, noDocumentOverflow:true, icons:await countIcons(page) };
  }, page);
  await context.close();
 }
} finally {
 await browser.close();
 report.summary = { passed:report.results.filter(r=>r.status==='passed').length, failed:report.results.filter(r=>r.status==='failed').length, pageErrors:report.pageErrors.length, consoleWarnings:report.console.filter(r=>r.type==='warning').length, consoleErrors:report.console.filter(r=>r.type==='error').length, requestFailures:report.requestFailures.length };
 await writeFile(resolve(out, 'results.json'), JSON.stringify(report, null, 2)+'\n');
 console.log(JSON.stringify(report.summary));
}
process.exitCode = report.results.some(r=>r.status==='failed') || report.pageErrors.length || report.console.some(r=>r.type==='error') ? 1 : 0;
