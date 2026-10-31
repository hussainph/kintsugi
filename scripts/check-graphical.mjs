#!/usr/bin/env node
// KI-20: real headless interactions against an already-running loopback Lab.
// No app/native windows are opened. Artifacts stay inside the worktree.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const require = createRequire(new URL('../packages/lab/package.json', import.meta.url));
const { chromium } = require('playwright');
const root = path.resolve(new URL('..', import.meta.url).pathname);
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const base = new URL(option('--url', 'http://127.0.0.1:4415'));
assert(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Loopback URL required');
const out = path.resolve(root, option('--out', '.headless/graphical'));
assert(out.startsWith(root + '/.headless/graphical') || out.startsWith(root + '/.lab-artifacts/ki-20'), 'Artifact output must be owned');
assert(Number.isInteger(Number(process.env.VOLLI_CONCURRENCY_HINT ?? 1)) && Number(process.env.VOLLI_CONCURRENCY_HINT ?? 1) > 0);
// One browser/page, serial checks: never exceed the machine concurrency hint.
await mkdir(out, { recursive: true });
const specs = {};
for (const file of await readdir(path.join(root, 'gui/components/kintsugi'))) {
  const text = await readFile(path.join(root, 'gui/components/kintsugi', file), 'utf8');
  const data = JSON.parse(text.match(/```json\n([\s\S]*?)\n```/)[1]);
  specs[data.component] = data;
}
let executable = option('--executable', process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH);
for (const candidate of [executable, chromium.executablePath(), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']) {
  if (!candidate) continue;
  try { await access(candidate); executable = candidate; break; } catch { /* next known executable */ }
}
const browser = await chromium.launch({ headless: true, executablePath: executable, args: ['--no-first-run', '--no-default-browser-check'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light' });
const page = await context.newPage();
page.setDefaultTimeout(7000);
page.setDefaultNavigationTimeout(20000);
const report = { startedAt: new Date().toISOString(), url: base.href, headless: true, concurrency: 1, executable, rows: [], checks: [], screenshots: [], errors: [], warnings: [], specSamples: [] };
let current = 'setup';
page.on('pageerror', error => report.errors.push({ test: current, type: 'pageerror', text: error.stack ?? error.message }));
page.on('console', message => {
  if (['error', 'warning'].includes(message.type())) report[message.type() === 'error' ? 'errors' : 'warnings'].push({ test: current, type: message.type(), text: message.text() });
});
page.on('response', response => {
  if (response.status() >= 400) report.errors.push({ test: current, type: 'http', text: `${response.status()} ${response.url()}` });
});
const section = name => page.locator(`[data-catalog-component="${name}"]`);
const part = (name, p) => page.locator(`[data-ui-component="${name}"][data-ui-part="${p}"]`).first();
async function eventually(fn) {
  let error;
  for (let i = 0; i < 80; i++) {
    try { return await fn(); } catch (e) { error = e; await new Promise(resolve => setTimeout(resolve, 25)); }
  }
  throw error;
}
const attr = (locator, name, expected) => eventually(async () => assert.equal(await locator.getAttribute(name), expected, name));
const value = (locator, expected) => eventually(async () => assert.equal(await locator.inputValue(), expected));
const text = (locator, expected) => eventually(async () => assert((await locator.innerText()).includes(expected), `${JSON.stringify(await locator.innerText())} should include ${expected}`));
const visible = locator => locator.waitFor({ state: 'visible' });
const hidden = locator => eventually(async () => { for (const item of await locator.all()) assert.equal(await item.isVisible(), false, 'All exiting surfaces hidden'); });
async function scenario(theme, reducedMotion = false, disabled = false, width = 1440) {
  await page.emulateMedia({ colorScheme: theme, reducedMotion: reducedMotion ? 'reduce' : 'no-preference' });
  await page.evaluate(({ theme, reducedMotion, disabled, width }) => window.postMessage({ type: 'lab:scenario', scenario: { theme, density: 'comfortable', reducedMotion, textScale: 1, width }, values: { disabled } }, location.origin), { theme, reducedMotion, disabled, width });
  await page.waitForFunction(({ theme, reducedMotion }) => document.documentElement.classList.contains('dark') === (theme === 'dark') && document.documentElement.dataset.labReducedMotion === String(reducedMotion), { theme, reducedMotion });
  await page.locator(`.graphical-theme[data-color-mode="${theme}"]`).first().waitFor({ state: 'attached' });
  await page.waitForTimeout(250);
}
async function keyboardFocus(locator) {
  await locator.evaluate(el => el.blur());
  await page.keyboard.press('Tab');
  await locator.focus();
}
async function open(story, mode = 'light', reduced = false, disabled = false) {
  const url = new URL(base); url.search = new URLSearchParams({ preview: 'component/graphical-catalog', story }).toString();
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__LAB_READY__ === true || window.__LAB_ERROR__);
  assert.equal(await page.evaluate(() => window.__LAB_ERROR__), undefined, 'Lab boundary');
  await scenario(mode, reduced, disabled);
  await page.evaluate(() => document.fonts.ready);
  // Font loading can outlast the initial provider effect. Sample only once the
  // host class, provider mode and resolved palette agree with the scenario.
  await page.waitForFunction(mode => {
    const scope = document.querySelector('.graphical-theme');
    return document.documentElement.classList.contains('dark') === (mode === 'dark') &&
      scope?.dataset.colorMode === mode && getComputedStyle(scope).getPropertyValue('--neutral-1').trim() === (mode === 'dark' ? '#191919' : '#ffffff');
  }, mode);
}
async function shot(name, fullPage = false) {
  const filename = `${name}.png`;
  // Expose the entire preview's inner scroller only for full-page capture.
  // Interactive runs retain the real viewport/scroll geometry.
  await page.screenshot({ path: path.join(out, filename), fullPage, animations: 'disabled', ...(fullPage ? { style: 'html, body.is-lab-preview, body.is-lab-preview #root, .lab-preview-root { height: auto !important; overflow: visible !important; }' } : {}) });
  report.screenshots.push(filename);
}
async function check(name, run) {
  current = name;
  const result = { name, ok: false };
  try { await run(result); result.ok = true; } catch (error) {
    result.error = error.stack ?? error.message;
    try { await shot(`failure-${name.replace(/[^a-zA-Z0-9-]/g, '-')}`); } catch { /* preserve original failure */ }
  }
  report.checks.push(result);
  console.log(`${result.ok ? 'PASS' : 'FAIL'} ${name}${result.error ? ': ' + result.error.split('\n')[0] : ''}`);
  return result;
}
async function portal(name, mode, role) {
  const popup = name === 'select' ? page.locator('.themed-select-popup').first() : part(name, 'popover');
  await visible(popup);
  if (role) assert.equal(await popup.getAttribute('role'), role);
  const evidence = await popup.evaluate(el => ({ external: !el.closest('[data-catalog-component]'), background: getComputedStyle(el).backgroundColor, fontFamily: getComputedStyle(el).fontFamily, neutral: getComputedStyle(el).getPropertyValue('--neutral-1').trim(), border: getComputedStyle(el).borderTopWidth }));
  assert(evidence.external, 'Popup must actually use portal');
  assert(evidence.fontFamily.includes('Timeless Sans'), 'Portalled font role');
  assert.equal(evidence.border, '0px', 'Native border width');
  assert.equal(evidence.neutral.toLowerCase(), mode === 'dark' ? '#191919' : '#ffffff', 'Portal active mode');
  return evidence;
}
const tasks = [
  ['Button', 'controls', async s => {
    for (const variant of ['primary', 'secondary', 'outline', 'ghost', 'danger']) {
      await s.getByRole('button', { name: variant, exact: true }).click(); await text(s.getByRole('status'), `${variant} pressed`);
    }
    const b = s.getByRole('button', { name: 'primary', exact: true }); await b.focus(); await page.keyboard.press('Enter'); await text(s.getByRole('status'), 'primary pressed');
    const loading = s.locator('button[disabled]'); assert((await loading.getAttribute('aria-label')) || (await loading.innerText()).trim(), 'Loading button needs accessible name');
  }],
  ['Input', 'controls', async s => { const i = s.getByRole('textbox', { name: 'Title' }); await i.fill('A repaired draft'); await value(i, 'A repaired draft'); await i.focus(); assert.equal(await i.evaluate(el => document.activeElement === el), true); }],
  ['Checkbox', 'controls', async s => { const c = s.getByRole('checkbox', { name: 'Keep in the library' }); await attr(c, 'aria-checked', 'true'); await c.focus(); await page.keyboard.press('Space'); await attr(c, 'aria-checked', 'false'); await attr(s.getByRole('checkbox', { name: 'Partially selected clips' }), 'aria-checked', 'mixed'); }],
  ['CheckboxGroup', 'controls', async s => { const all = s.getByRole('checkbox', { name: 'All sources' }); await attr(all, 'aria-checked', 'mixed'); await all.click(); for (const c of ['All sources', 'notes', 'clips']) await attr(s.getByRole('checkbox', { name: c, exact: true }), 'aria-checked', 'true'); await all.click(); for (const c of ['All sources', 'notes', 'clips']) await attr(s.getByRole('checkbox', { name: c, exact: true }), 'aria-checked', 'false'); }],
  ['Radio', 'controls', async s => { await s.getByRole('radio', { name: 'private', exact: true }).focus(); await page.keyboard.press('ArrowDown'); await attr(s.getByRole('radio', { name: 'public', exact: true }), 'aria-checked', 'true'); }],
  ['RadioGroup', 'controls', async s => { const review = s.getByRole('radio', { name: 'In review' }); await review.click(); await attr(review, 'aria-checked', 'true'); assert(await s.getByRole('radio', { name: 'Published' }).isDisabled()); await review.focus(); await page.keyboard.press('ArrowDown'); await attr(s.getByRole('radio', { name: 'Draft', exact: true }), 'aria-checked', 'true'); }],
  ['Switch', 'controls', async s => { const sw = s.getByRole('switch'); await attr(sw, 'aria-checked', 'true'); await sw.focus(); await page.keyboard.press('Space'); await attr(sw, 'aria-checked', 'false'); }],
  ['Toggle', 'controls', async s => { const b = s.getByRole('button'); await attr(b, 'aria-pressed', 'false'); await b.focus(); await page.keyboard.press('Space'); await attr(b, 'aria-pressed', 'true'); }],
  ['ToggleGroup', 'controls', async s => { const b = s.getByRole('button', { name: 'bold', exact: true }); await b.click(); await attr(b, 'aria-pressed', 'true'); await attr(s.getByRole('button', { name: 'italic', exact: true }), 'aria-pressed', 'true'); await b.focus(); await page.keyboard.press('ArrowRight'); assert.equal(await s.getByRole('button', { name: 'italic' }).evaluate(el => el === document.activeElement), true); }],
  ['Field', 'forms', async s => { const input = s.getByRole('textbox', { name: 'Caption', exact: true }); await input.focus(); await page.keyboard.press('Tab'); assert.notEqual(await input.getAttribute('aria-invalid'), 'true', 'Installed Base UI intentionally suppresses untouched required-field errors'); await input.fill('Temporary caption'); await input.fill(''); await page.keyboard.press('Tab'); await attr(input, 'aria-invalid', 'true'); assert((await input.getAttribute('aria-describedby')), 'Description/error associations'); await input.fill('A repaired vessel'); await input.blur(); await eventually(async () => assert.notEqual(await input.getAttribute('aria-invalid'), 'true')); assert.equal(await s.getByRole('textbox', { name: 'Read-only path' }).getAttribute('readonly'), ''); await attr(s.getByRole('textbox', { name: 'Invalid title' }), 'aria-invalid', 'true'); }],
  ['Fieldset', 'forms', async s => { assert.equal(await s.locator('fieldset').count(), 1); await visible(s.getByRole('group', { name: 'Author' })); const i = s.getByRole('textbox', { name: 'Name', exact: true }); await i.fill('Hussain'); await value(i, 'Hussain'); }],
  ['Form', 'forms', async s => { const i = s.getByRole('textbox', { name: 'Email' }); await s.getByRole('button', { name: 'Submit' }).click(); await attr(i, 'aria-invalid', 'true'); await i.fill('writer@example.com'); await s.getByRole('button', { name: 'Submit' }).click(); await text(s.getByRole('status'), 'Submitted: writer@example.com'); assert.equal(await s.locator('form').evaluate(el => new FormData(el).get('email')), 'writer@example.com'); }],
  ['NumberField', 'forms', async s => { const i = s.getByRole('textbox', { name: 'Word goal' }); await value(i, '500'); await s.getByRole('button', { name: 'Increase word goal' }).click(); await value(i, '600'); await s.getByRole('button', { name: 'Decrease word goal' }).click(); await value(i, '500'); await i.focus(); await page.keyboard.press('ArrowUp'); await value(i, '600'); }],
  ['OTPField', 'forms', async s => { const inputs = s.getByRole('textbox'); await inputs.first().focus(); await page.keyboard.type('123456'); await text(s.getByRole('status'), 'Complete: 123456'); assert.equal((await inputs.evaluateAll(els => els.map(el => el.value))).join(''), '123456'); const native = await s.locator('input[name="code"]').evaluateAll(els => els.map(el => el.value)); assert(native.includes('123456'), 'Combined named form value'); }],
  ['Select', 'forms', async (s, mode, result) => { const trigger = s.getByRole('combobox', { name: 'Status', exact: true }); await text(trigger, 'Draft'); await trigger.focus(); await page.keyboard.press('Space'); result.portal = await portal('select', mode); await page.getByRole('option', { name: 'In review', exact: true }).click(); await text(trigger, 'In review'); assert.equal(await s.locator('input[name="status"]').inputValue(), 'review'); await trigger.click(); assert(await page.getByRole('option', { name: 'Published', exact: true }).getAttribute('aria-disabled') === 'true'); await page.keyboard.press('Escape'); }],
  ['Combobox', 'forms', async (s, mode, result) => { const i = s.getByRole('combobox', { name: 'Topic', exact: true }); await i.fill('Rep'); await visible(page.getByRole('option', { name: 'Repair', exact: true })); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); await value(i, 'Repair'); await i.fill('no-such-topic'); await visible(page.getByText('No topics found.', { exact: true })); await page.keyboard.press('Escape'); }],
  ['Autocomplete', 'forms', async (s, mode, result) => { const i = s.getByRole('combobox', { name: 'Search topics' }); await i.fill('Ess'); await visible(page.getByRole('option', { name: 'Essays', exact: true })); result.portal = await portal('autocomplete', mode); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); await value(i, 'Essays'); }],
  ['Accordion', 'disclosure', async s => { const b = s.getByRole('button', { name: 'backlinks' }); await b.focus(); await page.keyboard.press('Enter'); await attr(b, 'aria-expanded', 'true'); await visible(s.getByRole('region', { name: 'backlinks' })); await page.keyboard.press('Enter'); await attr(b, 'aria-expanded', 'false'); await hidden(s.getByRole('region', { name: 'backlinks' })); }],
  ['Collapsible', 'disclosure', async s => { const b = s.getByRole('button'); await b.click(); await attr(b, 'aria-expanded', 'true'); await visible(s.getByText('Last edited today. Status: draft.')); await b.focus(); await page.keyboard.press('Space'); await attr(b, 'aria-expanded', 'false'); await hidden(s.getByText('Last edited today. Status: draft.')); }],
  ['Tabs', 'disclosure', async s => { await s.getByRole('tab', { name: 'Writing', exact: true }).focus(); await page.keyboard.press('ArrowRight'); assert(await s.getByRole('tab', { name: 'References', exact: true }).evaluate(el => el === document.activeElement)); await page.keyboard.press('Space'); await attr(s.getByRole('tab', { name: 'References', exact: true }), 'aria-selected', 'true'); await visible(s.getByRole('tabpanel', { name: 'References', exact: true })); assert(await s.getByRole('tab', { name: 'History' }).isDisabled()); await page.keyboard.press('ArrowRight'); if (await s.getByRole('tab', { name: 'History' }).evaluate(el => el === document.activeElement)) await page.keyboard.press('ArrowRight'); await page.keyboard.press('Space'); await attr(s.getByRole('tab', { name: 'Writing', exact: true }), 'aria-selected', 'true'); }],
  ['Dialog', 'overlays', async (s, mode, result) => { const b = s.getByRole('button'); await b.click(); const d = page.getByRole('dialog', { name: 'Edit clip' }); await visible(d); result.portal = await portal('dialog', mode, 'dialog'); const input = d.getByRole('textbox', { name: 'Clip title' }); await input.fill('Repair'); for (let i = 0; i < 6; i++) { await page.keyboard.press('Tab'); await eventually(async () => assert(await d.evaluate(el => el.contains(document.activeElement)), 'Modal focus containment')); } await shot(`dialog-${mode}`); await page.keyboard.press('Escape'); await hidden(d); await eventually(async () => assert(await b.evaluate(el => el === document.activeElement), 'Restored trigger focus')); }],
  ['AlertDialog', 'overlays', async (s, mode, result) => { await s.getByRole('button').click(); const d = page.getByRole('alertdialog'); await visible(d); result.portal = await portal('alert-dialog', mode, 'alertdialog'); await d.getByRole('button', { name: 'Keep it' }).click(); await hidden(d); await s.getByRole('button').click(); await d.getByRole('button', { name: 'Move to Trash', exact: true }).click(); await text(s.getByRole('status'), 'Moved the fixture clip to Trash.'); await hidden(d); }],
  ['Drawer', 'overlays', async (s, mode, result) => { await s.getByRole('button').click(); const d = page.getByRole('dialog', { name: 'References', exact: true }); await visible(d); result.portal = await portal('drawer', mode, 'dialog'); await shot(`drawer-${mode}`); await d.getByRole('button', { name: 'Done', exact: true }).click(); await hidden(d); }],
  ['Popover', 'overlays', async (s, mode, result) => { await s.getByRole('button').click(); const d = page.getByRole('dialog', { name: 'Draft details' }); await visible(d); result.portal = await portal('popover', mode); await d.getByRole('button', { name: 'Done' }).click(); await hidden(d); }],
  ['PreviewCard', 'overlays', async (s, mode, result) => { const link = s.getByRole('link'); await link.hover(); await visible(part('preview-card', 'popover')); result.portal = await portal('preview-card', mode); await page.keyboard.press('Escape'); await hidden(part('preview-card', 'popover')); assert.equal(await link.getAttribute('href'), '#catalog-navigation'); await page.mouse.move(0, 0); await keyboardFocus(link); await visible(part('preview-card', 'popover')); }],
  ['Tooltip', 'overlays', async (s, mode, result) => { const b = s.getByRole('button'); await keyboardFocus(b); await visible(part('tooltip', 'popover')); result.portal = await portal('tooltip', mode); await page.keyboard.press('Escape'); await hidden(part('tooltip', 'popover')); }],
  ['Menu', 'menus', async (s, mode, result) => { const trigger = s.getByRole('button', { name: 'Clip actions', exact: true }); await trigger.click(); result.portal = await portal('menu', mode, 'menu'); assert(await page.getByRole('menuitem', { name: 'Publish', exact: true }).isDisabled()); const c = page.getByRole('menuitemcheckbox', { name: 'Show references' }); await c.click(); await attr(c, 'aria-checked', 'false'); await page.getByRole('menuitemradio', { name: 'Oldest first' }).click(); await page.keyboard.press('Escape'); await hidden(page.getByRole('menu')); await trigger.click(); await page.getByRole('menuitem', { name: 'Move to', exact: true }).focus(); await page.keyboard.press('ArrowRight'); await page.getByRole('menuitem', { name: 'Essays', exact: true }).click(); await text(s.getByRole('status'), 'Moved to essays'); await hidden(page.getByRole('menu')); await trigger.focus(); await page.keyboard.press('ArrowDown'); await visible(page.getByRole('menu')); await page.keyboard.press('Home'); await eventually(async () => assert(await page.getByRole('menuitem', { name: 'Open', exact: true }).evaluate(el => el === document.activeElement))); await page.keyboard.press('Enter'); await text(s.getByRole('status'), 'Opened clip'); }],
  ['ContextMenu', 'menus', async (s, mode, result) => { const trigger = part('context-menu', 'trigger'); await trigger.click({ button: 'right' }); await visible(page.getByRole('menu')); result.portal = await portal('context-menu', mode, 'menu'); await page.getByRole('menuitem', { name: 'Open clip' }).click(); await text(section('Menu').getByRole('status'), 'Context: opened'); await hidden(page.getByRole('menu')); result.pointer = 'PASS right-click, action, dismissal'; await section('Menu').getByRole('button', { name: 'Clip actions', exact: true }).click(); await page.getByRole('menuitem', { name: 'Open', exact: true }).click(); await text(section('Menu').getByRole('status'), 'Opened clip'); await hidden(page.getByRole('menu')); await trigger.focus(); await page.keyboard.press('Shift+F10'); await visible(page.getByRole('menu')); await eventually(async () => assert(await page.getByRole('menu').evaluate(el => el.contains(document.activeElement)), 'Keyboard opening transfers focus into menu')); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Home'); await eventually(async () => assert(await page.getByRole('menuitem', { name: 'Open clip' }).evaluate(el => el === document.activeElement), 'Keyboard focuses first action')); await page.keyboard.press('Enter'); await text(section('Menu').getByRole('status'), 'Context: opened'); await hidden(page.getByRole('menu')); await trigger.focus(); await page.keyboard.press('ContextMenu'); await visible(page.getByRole('menu')); result.keyboard = 'PASS Shift+F10, menu focus, ArrowDown/Home/Enter action; ContextMenu key; Escape'; await page.keyboard.press('Escape'); await hidden(page.getByRole('menu')); }],
  ['Menubar', 'menus', async (s, mode, result) => { const file = s.getByRole('menuitem', { name: 'File', exact: true }); await file.focus(); await page.keyboard.press('ArrowRight'); assert(await s.getByRole('menuitem', { name: 'Edit', exact: true }).evaluate(el => el === document.activeElement)); await page.keyboard.press('ArrowDown'); await visible(page.getByRole('menu')); await page.getByRole('menuitem', { name: 'First action', exact: true }).click(); await text(section('Menu').getByRole('status'), 'Edit: first action'); }],
  ['NavigationMenu', 'menus', async (s, mode, result) => { const b = s.getByRole('button', { name: 'Library' }); await b.click(); result.portal = await portal('navigation-menu', mode); await visible(page.getByRole('link', { name: 'Notes', exact: true })); await page.getByRole('link', { name: 'Notes', exact: true }).click(); assert.equal(new URL(page.url()).hash, '#catalog-navigation'); }],
  ['Toolbar', 'menus', async s => { const b = s.getByRole('button', { name: 'Bold', exact: true }); await b.focus(); await page.keyboard.press('Space'); await attr(b, 'aria-pressed', 'true'); await page.keyboard.press('ArrowRight'); assert(await s.getByRole('button', { name: 'Italic' }).evaluate(el => el === document.activeElement)); assert.equal(await s.locator('button button, a button').count(), 0); assert.equal(await s.getByRole('link').getAttribute('href'), '#catalog-navigation'); }],
  ['Avatar', 'feedback', async s => { await visible(s.getByText('HP', { exact: true })); const image = s.getByRole('img', { name: 'Stone artwork' }); await visible(image); assert(await image.evaluate(el => el.complete && el.naturalWidth > 0), 'Fixture artwork loaded'); const size = await part('avatar', 'control').evaluate(el => ({ w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height })); assert.equal(size.w, size.h); }],
  ['Slider', 'feedback', async s => { const slider = s.getByRole('slider'); await attr(slider, 'aria-valuenow', '40'); await slider.focus(); await page.keyboard.press('ArrowRight'); await attr(slider, 'aria-valuenow', '41'); await page.keyboard.press('End'); await attr(slider, 'aria-valuenow', '100'); assert.equal(await s.locator('input[name="progress"]').inputValue(), '100'); }],
  ['Meter', 'feedback', async s => { const m = s.getByRole('meter'); await attr(m, 'aria-valuenow', '40'); await attr(m, 'aria-valuemin', '0'); await attr(m, 'aria-valuemax', '100'); await text(part('meter', 'value'), '40'); assert.equal(await s.getByRole('slider').count(), 0); }],
  ['Progress', 'feedback', async s => { const p = s.getByRole('progressbar'); await attr(p, 'aria-valuenow', '40'); await text(part('progress', 'value'), '40'); await s.getByRole('button', { name: 'Show indeterminate' }).click(); assert.equal(await p.getAttribute('aria-valuenow'), null); await attr(p, 'aria-label', null); await visible(s.getByText('Loading references', { exact: true })); }],
  ['Toast', 'feedback', async (s, mode, result) => { await s.getByRole('button').click(); const title = page.getByText('Preview notification', { exact: true }); await visible(title); result.portal = await portal('toast', mode); await shot(`toast-${mode}`); await page.getByRole('button', { name: 'Acknowledge' }).click(); await hidden(title); }],
  ['ScrollArea', 'feedback', async s => { const vp = s.locator('.ui-scroll-viewport'); assert.equal(await vp.getAttribute('tabindex'), '0'); await vp.focus(); await page.keyboard.press('PageDown'); await eventually(async () => assert((await vp.evaluate(el => el.scrollTop)) > 0, 'Keyboard scroll')); await vp.evaluate(el => { el.scrollTop = el.scrollHeight; }); assert(await vp.evaluate(el => el.scrollTop + el.clientHeight >= el.scrollHeight - 1)); }],
  ['Separator', 'feedback', async s => { const separators = s.getByRole('separator'); assert.equal(await separators.count(), 2); await attr(separators.nth(0), 'aria-orientation', 'horizontal'); await attr(separators.nth(1), 'aria-orientation', 'vertical'); for (const loc of [separators.nth(0), separators.nth(1)]) assert.equal(await loc.evaluate(el => getComputedStyle(el).borderTopWidth), '0px'); }],
];
assert.equal(tasks.length, 38);
const actions = {
  Button: 'Click all five variants and assert status; Enter activates primary; loading action has an accessible name.',
  Input: 'Fill title; assert native value and focus.',
  Checkbox: 'Assert checked/mixed; Space unchecks the standalone choice.',
  CheckboxGroup: 'Mixed parent → click selects all → click clears all children.',
  Radio: 'ArrowDown moves exclusivity private → public.',
  RadioGroup: 'Click In review; Published disabled; ArrowDown wraps to Draft.',
  Switch: 'Checked initial state; Space toggles off.',
  Toggle: 'Space changes persistent aria-pressed false → true.',
  ToggleGroup: 'Select bold alongside italic; ArrowRight moves roving focus.',
  Field: 'Untouched blur intentionally suppresses required errors (Base UI1.9); type→clear→blur produces invalid; fill clears it; explicit invalid and readonly semantics.',
  Fieldset: 'Real fieldset/legend group named Author; fill labeled Name.',
  Form: 'Empty submit invalid; valid email submit/status and FormData preserve named value.',
  NumberField: '500 → increment 600 → decrement 500 → ArrowUp 600.',
  OTPField: 'Type 123456 across six inputs; completion callback and combined named form value.',
  Select: 'Initial Draft label; Space opens portal; select In review; native review value; Published disabled; Escape.',
  Combobox: 'Filter Rep; ArrowDown/Enter selects Repair; unmatched query displays empty state.',
  Autocomplete: 'Filter Ess; keyboard selects Essays; verify actual themed portal.',
  Accordion: 'Enter expands backlinks and associated region; Enter collapses and hides it.',
  Collapsible: 'Click expands details; Space collapses and removes visible content.',
  Tabs: 'ArrowRight roving focus, Space activation; References panel association; History disabled; wrap and select Writing.',
  Dialog: 'Open named modal portal; edit field; six Tab steps remain trapped; Escape dismisses and restores trigger focus.',
  AlertDialog: 'Open alertdialog; cancel preserves; confirm changes fixture status and closes.',
  Drawer: 'Open named References dialog portal; Done closes.',
  Popover: 'Open named dialog portal; Done closes.',
  PreviewCard: 'Hover opens actual portal; Escape; real href preserved; keyboard focus reopens.',
  Tooltip: 'Keyboard focus opens real popup; Escape dismisses.',
  Menu: 'Disabled Publish; toggle checkbox; choose radio; keyboard submenu chooses Essays; keyboard Open action.',
  ContextMenu: 'Right-click portal/action/dismissal; Shift+F10 transfers menu focus; ArrowDown/Home focuses Open, Enter changes status; ContextMenu key opens; Escape dismisses.',
  Menubar: 'ArrowRight File → Edit; ArrowDown opens; First action updates status.',
  NavigationMenu: 'Library opens portal; Notes is a real link and navigates to expected hash.',
  Toolbar: 'Space toggles Bold; ArrowRight focuses Italic; no nested interactive elements; real link.',
  Avatar: 'Loaded artwork has accessible name/natural size; separate HP fallback; root is square.',
  Slider: '40 initial → ArrowRight 41 → End 100; named hidden value = 100.',
  Meter: 'Read-only role and 0/40/100 value bounds; visible numeric value, no slider role.',
  Progress: 'Determinate aria-value/visible 40; toggle indeterminate removes value and exposes loading label.',
  Toast: 'Trigger creates real themed portal notification; Acknowledge dismisses.',
  ScrollArea: 'Keyboard-focusable viewport; PageDown scrolls; bottom range reachable.',
  Separator: 'Two semantic separators with horizontal/vertical orientation and zero native borders.',
};
// Main specimen part sampled against the downloaded JSON in each mode. Only
// authored properties are compared, not structural widths or primitive geometry.
const samples = {
  Button: ['button', '.themed-button', 'control', 'rest', 'primary'],
  Input: ['input', 'input', 'control'],
  Checkbox: ['checkbox', '[data-ui-part="label"]', 'label'],
  CheckboxGroup: ['checkbox-group', '[data-ui-part="group"]', 'group'],
  Radio: ['radio', '[data-ui-component="radio"][data-ui-part="label"]', 'label'],
  RadioGroup: ['radio-group', '[data-ui-part="group"]', 'group'],
  Switch: ['switch', '[data-ui-part="label"]', 'label'],
  Toggle: ['toggle', '[data-ui-part="control"]', 'control'],
  ToggleGroup: ['toggle-group', '[data-ui-part="group"]', 'group'],
  Field: ['field', '[data-ui-part="group"]', 'group'],
  Fieldset: ['fieldset', '[data-ui-component="fieldset"][data-ui-part="group"]', 'group'],
  Form: ['form', '[data-ui-component="form"][data-ui-part="group"]', 'group'],
  NumberField: ['number-field', '[data-ui-part="label"]', 'label'],
  OTPField: ['otp-field', '[data-ui-part="label"]', 'label'],
  Select: ['select', '.themed-select', 'control'],
  Combobox: ['combobox', '.combobox-field', 'input'],
  Autocomplete: ['autocomplete', '[data-ui-part="input"]', 'input'],
  Accordion: ['accordion', '[data-ui-part="trigger"]', 'trigger', 'open'],
  Collapsible: ['collapsible', '[data-ui-part="trigger"]', 'trigger'],
  Tabs: ['tabs', '[data-ui-part="list"]', 'list'],
  Dialog: ['dialog', '[data-ui-part="trigger"]', 'trigger'],
  AlertDialog: ['alert-dialog', '[data-ui-part="trigger"]', 'trigger'],
  Drawer: ['drawer', '[data-ui-part="trigger"]', 'trigger'],
  Popover: ['popover', '[data-ui-part="trigger"]', 'trigger'],
  PreviewCard: ['preview-card', '[data-ui-part="trigger"]', 'trigger'],
  Tooltip: ['tooltip', '[data-ui-part="trigger"]', 'trigger'],
  Menu: ['menu', '[data-ui-part="trigger"]', 'trigger'],
  ContextMenu: ['context-menu', '[data-ui-part="trigger"]', 'trigger'],
  Menubar: ['menubar', '[data-ui-part="group"]', 'group'],
  NavigationMenu: ['navigation-menu', '[data-ui-part="list"]', 'list'],
  Toolbar: ['toolbar', '[data-ui-part="group"]', 'group'],
  Avatar: ['avatar', '[data-ui-part="control"]', 'control'],
  Slider: ['slider', '[data-ui-part="track"]', 'track'],
  Meter: ['meter', '[data-ui-part="track"]', 'track'],
  Progress: ['progress', '[data-ui-part="track"]', 'track'],
  Toast: ['toast', '[data-ui-part="trigger"]', 'trigger'],
  ScrollArea: ['scroll-area', '[data-ui-part="viewport"]', 'viewport'],
  Separator: ['separator', '[data-ui-part="separator"]', 'separator'],
};
async function sampleSpec(name, mode, overrideVariant) {
  const [component, selector, p, requestedState = 'rest', defaultVariant = 'default'] = samples[name];
  const variant = overrideVariant ?? defaultVariant;
  const data = specs[component]; const states = data.variants[variant][mode][p]; const state = states[requestedState] ? requestedState : 'rest'; const expected = states[state];
  const supported = data.parts.find(part => part.id === p).properties;
  const expectedCss = { ...expected.css };
  // Owner-approved dark deviation: this main-part sample is the only sampled
  // rest foreground that selects Color 1. Keep all other captured properties,
  // and every light-mode expectation, literal and independent of the resolver.
  const approvedOverrides = {};
  if (mode === 'dark' && component === 'preview-card' && p === 'trigger' && expected.tokens.foreground === 'color-1') {
    expectedCss.color = 'var(--neutral-9)';
    approvedOverrides.color = 'neutral-9 (owner-approved dark contrast)';
  }
  const props = ['backgroundColor', 'color', 'borderRadius', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing'];
  const mapping = { backgroundColor: 'background', color: 'foreground', borderRadius: 'radius', fontFamily: 'font', fontSize: 'textSize', fontWeight: 'weight', lineHeight: 'lineHeight', letterSpacing: 'letterSpacing' };
  const keys = props.filter(key => supported.includes(mapping[key]) && expected.css[key] !== undefined);
  const target = component === 'button' ? section(name).getByRole('button', { name: variant, exact: true }) : section(name).locator(selector).first();
  const observed = await target.evaluate((el, { css, keys }) => {
    const cs = getComputedStyle(el); const probe = document.createElement('div'); Object.assign(probe.style, css); document.querySelector('.graphical-theme').append(probe); const reference = getComputedStyle(probe);
    const pairs = Object.fromEntries(keys.map(key => [key, { actual: cs[key], expected: reference[key] }])); probe.remove(); return { pairs, borderWidth: cs.borderTopWidth };
  }, { css: Object.fromEntries(keys.map(key => [key, typeof expectedCss[key] === 'number' && !['fontWeight'].includes(key) ? `${expectedCss[key]}px` : expectedCss[key]])), keys });
  const mismatches = Object.entries(observed.pairs).filter(([, pair]) => pair.actual !== pair.expected);
  const result = { name, mode, component, part: p, state, variant, approvedOverrides, ...observed, mismatches };
  report.specSamples.push(result);
  assert.equal(mismatches.length, 0, JSON.stringify(mismatches));
  assert.equal(observed.borderWidth, '0px', 'Zero native border');
}
try {
  const only = option('--only', '');
  const modes = option('--modes', 'light,dark').split(',');
  for (const mode of modes) {
    await check(`catalog ${mode} baseline and assets`, async result => {
      await open('default', mode);
      assert.equal(await page.locator('[data-catalog-component]').count(), 38);
      await page.waitForTimeout(500);
      await page.waitForFunction(() => !document.querySelector('[data-icon-loading]'));
      assert.equal(await page.locator('[data-icon-fallback], [data-icon-unavailable]').count(), 0, 'No fallback or unavailable glyphs');
      assert.equal(await page.locator('[data-icon-family="Lucide"]').count(), 0, 'No Lucide substitution');
      const fonts = await page.evaluate(async () => {
        await document.fonts.load('400 14px "Sidebar Geist Mono"'); await document.fonts.load('500 14px "Sidebar Geist Mono"'); await document.fonts.load('600 14px "Sidebar Geist Mono"');
        return { faces: [...document.fonts].map(f => ({ family: f.family, weight: f.weight, status: f.status })), loaded: [400, 500, 600].map(w => document.fonts.check(`${w} 14px "Sidebar Geist Mono"`)) };
      });
      assert(fonts.faces.some(f => f.family.includes('Sidebar Geist Mono') && f.status === 'loaded'));
      assert(fonts.loaded.every(Boolean)); result.fonts = fonts;
      result.icons = await page.locator('[data-icon-family="Hugeicons"]').count(); assert(result.icons > 0);
      await shot(`catalog-${mode}`, true);
    });
    if (!args.includes('--behavior-only')) for (const [name, story] of tasks.filter(([name]) => !only || name === only)) await check(`spec ${name} ${mode}`, async () => { await open(story, mode); await page.mouse.move(0, 0); await sampleSpec(name, mode); });
    if (!args.includes('--behavior-only') && (!only || only === 'Button')) for (const variant of ['secondary', 'outline', 'ghost', 'danger']) await check(`spec Button ${variant} ${mode}`, async () => { await open('controls', mode); await page.mouse.move(0, 0); await sampleSpec('Button', mode, variant); });
    for (const [name, story, run] of tasks.filter(([name]) => !only || name === only)) {
      const result = await check(`${name} ${mode}`, async result => { await open(story, mode); await run(section(name), mode, result); await page.waitForFunction(() => !document.querySelector('[data-icon-loading]')); assert.equal(await page.locator('[data-icon-fallback], [data-icon-unavailable]').count(), 0); });
      let row = report.rows.find(r => r.component === name);
      if (!row) { row = { component: name, import: `@kintsugi/ui/graphical: ${name}`, modes: {} }; report.rows.push(row); }
      row.modes[mode] = { ok: result.ok, ...(result.error ? { error: result.error.split('\n')[0] } : {}), ...(result.portal ? { portal: result.portal } : {}), ...(result.pointer ? { pointer: result.pointer } : {}), ...(result.keyboard ? { keyboard: result.keyboard } : {}) };
    }
    for (const story of ['controls', 'forms', 'disclosure', 'overlays', 'menus', 'feedback']) await check(`screenshot ${story} ${mode}`, async () => { await open(story, mode); await shot(`${story}-${mode}`, true); });
  }
  for (const mode of ['light', 'dark']) await check(`bundled Input Field invalid and readonly ${mode}`, async result => {
    await open('forms', mode);
    await page.evaluate(async ({ root, mode }) => {
      const React = (await import('/node_modules/.vite-lab/deps/react.js')).default;
      const { createRoot } = (await import('/node_modules/.vite-lab/deps/react-dom_client.js')).default;
      const { KintsugiProvider } = await import(`/@fs${root}/packages/ui/src/provider.tsx`);
      const { Field, Input } = await import(`/@fs${root}/packages/ui/components/graphical/index.ts`);
      const host = document.createElement('section'); host.id = 'direct-input-fixture'; document.body.append(host);
      host.style.cssText = 'position:fixed;left:20px;top:20px;width:400px;z-index:10000';
      const h = React.createElement;
      createRoot(host).render(h(KintsugiProvider, { colorMode: mode },
        h(Field.Root, { invalid: true }, h(Field.Label, null, 'Direct invalid input'), h(Input, { 'data-verify-input': 'invalid', defaultValue: 'Needs repair' })),
        h(Field.Root, null, h(Field.Label, null, 'Direct readonly input'), h(Input, { 'data-verify-input': 'readonly', readOnly: true, defaultValue: 'notes/craft.md' }))));
    }, { root, mode });
    const invalid = page.locator('[data-verify-input="invalid"]'); const readonly = page.locator('[data-verify-input="readonly"]');
    await visible(invalid); await attr(invalid, 'aria-invalid', 'true'); assert(await readonly.evaluate(el => el.readOnly));
    result.states = {};
    for (const [state, input] of [['invalid', invalid], ['readonly', readonly]]) {
      const css = specs.input.variants.default[mode].control[state].css;
      result.states[state] = await input.evaluate((el, css) => {
        const cs = getComputedStyle(el); const p = document.createElement('div'); p.style.boxShadow = css.boxShadow; p.style.backgroundColor = css.backgroundColor; document.body.append(p);
        const expected = getComputedStyle(p); const result = { shadow: cs.boxShadow, expectedShadow: expected.boxShadow, background: cs.backgroundColor, expectedBackground: expected.backgroundColor, border: cs.borderTopWidth }; p.remove(); return result;
      }, css);
      assert.equal(result.states[state].shadow, result.states[state].expectedShadow, `${state} exact spec edge/elevation`);
      assert.equal(result.states[state].background, result.states[state].expectedBackground, `${state} exact spec fill`);
      assert.equal(result.states[state].border, '0px');
    }
    await keyboardFocus(invalid); await eventually(async () => assert.equal(await invalid.evaluate(el => getComputedStyle(el).outlineStyle), 'solid', 'Separate keyboard focus outline'));
    assert.equal(await invalid.evaluate(el => getComputedStyle(el).boxShadow), result.states.invalid.shadow, 'Focus preserves invalid edge');
    await shot(`direct-input-states-${mode}`);
  });
  await check('open portal live mode propagation', async result => {
    await open('overlays', 'light'); await section('Dialog').getByRole('button').click(); result.light = await portal('dialog', 'light');
    await scenario('dark'); result.dark = await portal('dialog', 'dark'); assert.notEqual(result.light.background, result.dark.background, 'Mounted popup follows actual html.dark');
    await scenario('light'); await portal('dialog', 'light'); await page.keyboard.press('Escape'); await hidden(page.getByRole('dialog'));
  });
  await check('disabled variant semantics', async result => {
    await open('default', 'light', false, true);
    const controls = page.locator('[data-catalog-component] button, [data-catalog-component] input:not([type="hidden"])');
    result.controls = await controls.evaluateAll(els => els.map(el => ({ tag: el.tagName, name: el.getAttribute('aria-label') ?? el.textContent, disabled: el.disabled, readonly: el.readOnly, specimen: el.closest('[data-catalog-component]').dataset.catalogComponent })));
    for (const name of ['Button', 'Input', 'Checkbox', 'CheckboxGroup', 'Radio', 'RadioGroup', 'Switch', 'Toggle', 'ToggleGroup', 'Select', 'Combobox', 'Autocomplete', 'NumberField', 'OTPField']) {
      const targets = section(name).locator('button, input:not([type="hidden"])');
      for (const el of await targets.all()) assert(await el.isDisabled(), `${name} disabled control`);
    }
    await shot('catalog-disabled', true);
  });
  await check('reduced motion loops and portals', async result => {
    await open('feedback', 'dark', true); await section('Progress').getByRole('button', { name: 'Show indeterminate' }).click();
    await page.waitForTimeout(450);
    result.animations = await page.evaluate(() => document.getAnimations().filter(a => a.playState === 'running').map(a => ({ duration: a.effect?.getTiming().duration, iterations: a.effect?.getTiming().iterations, target: a.effect?.target?.outerHTML.slice(0,200) })));
    assert.equal(result.animations.filter(a => a.iterations === Infinity).length, 0, 'No decorative infinite loops under reduced motion');
    await shot('feedback-dark-reduced-motion', true);
    await open('overlays', 'dark', true); await section('Dialog').getByRole('button').click(); await portal('dialog', 'dark'); await shot('dialog-dark-reduced-motion'); await page.keyboard.press('Escape'); await hidden(page.getByRole('dialog'));
  });
  await check('responsive catalog at 390px', async result => {
    await page.setViewportSize({ width: 390, height: 844 }); await open('default', 'light');
    result.geometry = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    assert(result.geometry.scrollWidth <= result.geometry.width + 1, 'No horizontal document overflow');
    await shot('catalog-light-390-top');
    await section('Separator').scrollIntoViewIfNeeded(); await shot('catalog-light-390-bottom');
    await section('Dialog').getByRole('button').click(); await visible(page.getByRole('dialog')); const rect = await page.getByRole('dialog').boundingBox(); assert(rect.x >= 0 && rect.x + rect.width <= 391); await shot('dialog-light-390');
  });
} finally {
  report.finishedAt = new Date().toISOString();
  report.ok = report.checks.every(c => c.ok) && report.errors.length === 0;
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  const failed = report.checks.filter(c => !c.ok);
  const md = [
    '# KI-20 Graphical headless verification', '',
    `Run: ${report.startedAt} → ${report.finishedAt}. Headless Chrome, one serial worker (hint ${process.env.VOLLI_CONCURRENCY_HINT ?? 1}).`,
    `URL: ${base.href}. ${report.checks.filter(c => c.ok).length}/${report.checks.length} checks passed; ${report.errors.length} console/page/HTTP errors.`, '',
    '## 38 bundled primitive coverage', '',
    '| Component / import from `@kintsugi/ui/graphical` | Exact action/assertion coverage | Light | Dark |', '| --- | --- | --- | --- |',
    ...report.rows.map(r => `| ${r.component} | ${actions[r.component]} | ${r.modes.light?.ok ? 'PASS' : 'FAIL: ' + r.modes.light?.error} | ${r.modes.dark?.ok ? 'PASS' : 'FAIL: ' + r.modes.dark?.error} |`), '',
    '## Downloaded specification samples', '',
    `${report.specSamples.length} rendered main-part samples against exact JSON specifications; ${report.specSamples.filter(s => s.mismatches.length === 0).length} match. Samples include both modes, complete authored font/size/weight/line-height/tracking where applicable, fill, radius and zero native borders; all five Button variants.`, '',
    '## Failures', '', ...failed.map(c => `- **${c.name}**: ${c.error?.split('\n')[0]}`), '',
    '## Errors', '', ...report.errors.map(e => `- ${e.test}: ${e.type}: ${e.text}`), '',
    '## Check details and screenshots', '',
    'Exact actions and assertions are in `scripts/check-graphical.mjs`; full results, normalized spec samples, portal/style/font evidence and runtime warnings are in `report.json`. Full-page screenshots temporarily expose the preview inner scroller (height/overflow only) during capture; viewport screenshots and all interaction checks use real geometry.',
    ...report.screenshots.map(s => `- ${s}`), '',
    'Coverage limitation: each primitive has live DOM/behavior coverage in both modes and one authored main-part style sample; this does not establish every part/state/variant pixel parity. Font roles still need the external vendor assets recorded on KI-20. Existing Lab boot is a separate check.', '',
  ].join('\n');
  await writeFile(path.join(out, 'report.md'), md);
  await browser.close();
  console.log(`${report.checks.filter(c => c.ok).length}/${report.checks.length} checks; ${report.errors.length} runtime errors; report ${path.join(out, 'report.md')}`);
  if (!report.ok) process.exitCode = 1;
}
