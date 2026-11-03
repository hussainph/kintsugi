import assert from 'node:assert/strict';
import { test } from 'node:test';

import { APPEARANCE_KEY, AppearancePreferences, appearanceDetents, nearestSize, resolveScheme, stepSize, TEXT_SIZES } from './appearance.ts';

function memory() {
  const values = new Map<string, string>();
  return { values, getItemSync: (key: string) => values.get(key) ?? null, setItemSync: (key: string, value: string) => { values.set(key, value); } };
}

test('appearance defaults to System and 100%, follows system changes only in System', () => {
  const prefs = new AppearancePreferences(memory());
  assert.deepEqual(prefs.getSnapshot(), { mode: 'system', textSize: 1 });
  assert.equal(resolveScheme('system', 'dark'), 'dark');
  assert.equal(resolveScheme('system', 'light'), 'light');
  assert.equal(resolveScheme('system', null), 'light');
  assert.equal(resolveScheme('light', 'dark'), 'light');
  assert.equal(resolveScheme('dark', 'light'), 'dark');
});

test('text sizes match KI-65 and stop at both endpoints', () => {
  assert.deepEqual(TEXT_SIZES, [0.8, 0.9, 1, 1.1, 1.2, 1.35, 1.5]);
  assert.equal(stepSize(0.8, -1), 0.8);
  assert.equal(stepSize(1.5, 1), 1.5);
  for (let i = 0; i < TEXT_SIZES.length - 1; i++) {
    assert.equal(stepSize(TEXT_SIZES[i], 1), TEXT_SIZES[i + 1]);
    assert.equal(stepSize(TEXT_SIZES[i + 1], -1), TEXT_SIZES[i]);
  }
  assert.equal(nearestSize(NaN), 1);
  assert.equal(nearestSize(Infinity), 1);
  assert.equal(nearestSize(0.1), 0.8);
  assert.equal(nearestSize(10), 1.5);
  assert.equal(nearestSize(1.33), 1.35);
});

test('changes apply immediately, survive relaunch, and stay on this device', () => {
  const disk = memory();
  const phone = new AppearancePreferences(disk);
  const otherPhone = new AppearancePreferences(memory());
  const events: unknown[] = [];
  const unsubscribe = phone.subscribe(() => events.push(phone.getSnapshot()));
  phone.setMode('dark');
  phone.setTextSize(1.33);
  phone.setTextSize(1.35);
  assert.equal(events.length, 2, 'unchanged values do not notify or rewrite');
  assert.deepEqual(new AppearancePreferences(disk).getSnapshot(), { mode: 'dark', textSize: 1.35 });
  assert.deepEqual(otherPhone.getSnapshot(), { mode: 'system', textSize: 1 });
  assert.deepEqual([...disk.values.keys()], [APPEARANCE_KEY]);
  unsubscribe();
  phone.setMode('system');
  assert.equal(events.length, 2);
});

test('malformed and unavailable storage cannot break the app', () => {
  for (const saved of ['bad json', 'null', '42', '[]', '{"mode":"sepia","textSize":"huge"}']) {
    const disk = memory();
    disk.values.set(APPEARANCE_KEY, saved);
    assert.deepEqual(new AppearancePreferences(disk).getSnapshot(), { mode: 'system', textSize: 1 });
  }
  const prefs = new AppearancePreferences({ getItemSync: () => { throw new Error('unavailable'); }, setItemSync: () => { throw new Error('full'); } });
  prefs.setMode('light');
  prefs.setTextSize(1.5);
  assert.deepEqual(prefs.getSnapshot(), { mode: 'light', textSize: 1.5 });
});

test('the sheet starts compact, expands for accessibility, and fits short windows', () => {
  assert.deepEqual(appearanceDetents(844, 1), { detents: [520 / 844, 1], initial: 0 });
  assert.deepEqual(appearanceDetents(844, 2), { detents: [520 / 844, 1], initial: 1 });
  assert.deepEqual(appearanceDetents(400, 2), { detents: [1], initial: 0 });
});
