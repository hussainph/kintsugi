import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { scratchPath } from './desktop-headless.mjs';

test('scratch guard rejects owner paths, ancestors and symlink aliases before mkdir', () => {
  mkdirSync('.headless', { recursive: true });
  const root = mkdtempSync(resolve('.headless/guard-'));
  try {
    const home = resolve(root, 'home');
    mkdirSync(resolve(home, 'Documents/Kintsugi'), { recursive: true });
    mkdirSync(resolve(home, 'Library/Application Support/dev.phalasiya.kintsugi'), { recursive: true });
    for (const path of [home, resolve(home, 'Documents'), resolve(home, 'Documents/Kintsugi'), resolve(home, 'Documents/Kintsugi/sub'), resolve(home, 'Library/Application Support/dev.phalasiya.kintsugi')]) {
      assert.throws(() => scratchPath(path, home), /Refusing/);
    }
    symlinkSync(resolve(home, 'Documents/Kintsugi'), resolve(root, 'alias'));
    assert.throws(() => scratchPath(resolve(root, 'alias/new'), home), /Refusing/);
    assert.equal(scratchPath(resolve(root, 'scratch'), home), resolve(root, 'scratch'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
