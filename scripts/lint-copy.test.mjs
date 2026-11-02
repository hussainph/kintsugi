// Tests for pnpm lint:copy, against fixtures that must fail and must pass.
// A fixture line carrying `expect: rule-a rule-b` must report exactly those
// rules on that line; `expect@N: …` names line N (for multi-line strings).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { checkText } from './copy-lint/rules.mjs';
import { inScope, lintSource, screenOf, inventory } from './copy-lint/index.mjs';
import { looksLikeProse } from './copy-lint/extract-ts.mjs';

const dir = new URL('./copy-lint/fixtures/', import.meta.url);
const read = (path) => readFileSync(new URL(path, dir), 'utf8');

function expected(source) {
  const out = [];
  source.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/expect(?:@(\d+))?:\s*([a-z][a-z-]*(?:\s+[a-z][a-z-]*)*)/g)) {
      for (const rule of m[2].trim().split(/\s+/)) out.push(`${m[1] ? Number(m[1]) : i + 1} ${rule}`);
    }
  });
  return out.sort();
}

for (const name of readdirSync(new URL('fail/', dir))) {
  test(`fail/${name} reports exactly what it expects`, () => {
    const source = read(`fail/${name}`);
    const want = expected(source);
    assert.ok(want.length > 0, 'a failing fixture must declare what it expects');
    const got = lintSource(`fixtures/fail/${name}`, source).map((f) => `${f.line} ${f.rule}`).sort();
    assert.deepEqual(got, want);
  });
}

for (const name of readdirSync(new URL('pass/', dir))) {
  test(`pass/${name} is clean`, () => {
    const findings = lintSource(`fixtures/pass/${name}`, read(`pass/${name}`));
    assert.deepEqual(findings.map((f) => `${f.line} ${f.rule} ${f.detail}`), []);
  });
}

test('every finding carries a fix hint', () => {
  for (const f of lintSource('fixtures/fail/copy.tsx', read('fail/copy.tsx'))) assert.ok(f.hint, f.rule);
});

test('text rules: banned words, contrasts and caps', () => {
  const rules = (text) => checkText(text).map((f) => f.rule);
  assert.deepEqual(rules('Save'), []);
  assert.deepEqual(rules('3 new posts'), []);
  assert.deepEqual(rules('Export to PDF or HTML via the API URL'), []);
  assert.deepEqual(rules('HELPER REPORT'), ['all-caps']);
  assert.deepEqual(rules('A quiet place'), ['tone-word']);
  assert.deepEqual(rules('The seamless way'), ['slop-word']);
  assert.deepEqual(rules('Transcribed by Whisper'), []);
  assert.deepEqual(rules('a whisper of an idea'), ['tone-word']);
  assert.deepEqual(rules('It isn’t a feed, it’s a library'), ['binary-contrast']);
  assert.deepEqual(rules('Golden hour'), ['tone-word']);
  assert.deepEqual(rules('Goldman'), []);
});

test('prose detection skips class lists, paths, SQL and keys', () => {
  for (const s of ['flex items-center gap-2', 'text-sm text-muted-foreground mt-2 block', 'inspiration/sources/a.md', 'SELECT id FROM x', 'https://example.com', 'feed', 'a.md']) {
    assert.equal(looksLikeProse(s), false, s);
  }
  for (const s of ['Save', 'Saving…', 'Nothing new.', 'Try again', 'Couldn’t save the clip']) assert.equal(looksLikeProse(s), true, s);
});

test('scope covers the apps, packages, Rust and docs, but not tests or the voice rules', () => {
  for (const path of ['apps/desktop/src/kin/Chat.tsx', 'apps/mobile/src/app/kin.tsx', 'packages/editor/src/menu.ts', 'packages/core/src/export-html.ts', 'packages/ui/src/components/command.tsx', 'apps/desktop/src/publish/publish.css', 'apps/desktop/src-tauri/src/ai/prompt.rs', 'docs/kin.md', 'docs/architecture.html', 'README.md']) {
    assert.ok(inScope(path), path);
  }
  for (const path of ['apps/desktop/src/feed/feed.test.ts', 'apps/desktop/src-tauri/src/feed/tests.rs', 'docs/voice.md', 'docs/spikes/x.md', 'scripts/lint-copy.mjs', 'packages/lab/src/a.tsx']) {
    assert.ok(!inScope(path), path);
  }
});

test('inventory groups strings by screen', () => {
  assert.equal(screenOf('apps/desktop/src/feed/Feed.tsx'), 'Mac: Feed');
  assert.equal(screenOf('apps/mobile/src/app/kin.tsx'), 'Phone: kin');
  assert.equal(screenOf('apps/desktop/src-tauri/src/ai/prompt.rs'), 'Backend: Kin');
  const groups = inventory(['fixtures/pass/clean.tsx'], () => read('pass/clean.tsx'));
  const texts = groups.flatMap(([, items]) => items.map((i) => i.text));
  assert.ok(texts.includes('3 new posts'));
  assert.ok(!texts.some((t) => t.includes('tracking')));
});

test('the CLI exits 1 with file:line and a hint on a failing file, 0 on a clean one', () => {
  const cli = new URL('./lint-copy.mjs', import.meta.url).pathname;
  const fail = new URL('fail/copy.tsx', dir).pathname;
  const pass = new URL('pass/clean.tsx', dir).pathname;
  assert.throws(() => execFileSync('node', [cli, fail], { encoding: 'utf8' }), (error) => {
    assert.equal(error.status, 1);
    assert.match(error.stdout, /fixtures\/fail\/copy\.tsx:3: tone-word "sanctuary"/);
    assert.match(error.stdout, /fix: /);
    return true;
  });
  assert.match(execFileSync('node', [cli, pass], { encoding: 'utf8' }), /clean/);
});
