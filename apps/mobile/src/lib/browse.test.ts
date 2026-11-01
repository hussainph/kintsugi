import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FilterStore, folderView, linkedFilter, matches, matchingSections, NO_FILTER, row, tagsUnder } from './browse.ts';
import type { LocalDoc } from './library.ts';

const local = (path: string, text: string): LocalDoc => ({ path, text, base: text, version: 'v' });
const rows = [
  local('essays/kilns.mdx', '---\ntitle: "On kilns"\nstatus: complete\ntags:\n  - Craft\n  - fire\n---\n\nHeat.\n'),
  local('essays/repair.mdx', '---\ntitle: "Repair"\nstatus: draft\ntags: [craft]\n---\n\nGold.\n'),
  local('essays/old/first.mdx', '---\nstatus: draft\ntags: [archive]\n---\n\nFirst essay\n'),
  local('inbox/idea.mdx', '---\nstatus: draft\n---\n\nA passing idea\n'),
  local('readme.md', 'No frontmatter at all.\n'),
].map(row);

test('a row reads its status and tags from frontmatter, block lists included', () => {
  assert.deepEqual(rows[0].tags, ['craft', 'fire']);
  assert.equal(rows[0].status, 'complete');
  assert.deepEqual(rows[4].tags, []);
  assert.equal(rows[4].status, null);
});

test('a folder lists its subfolders with counts, then its own documents', () => {
  const root = folderView(rows, '');
  assert.deepEqual(root.folders, [
    { path: 'essays', name: 'essays', count: 3 },
    { path: 'inbox', name: 'inbox', count: 1 },
  ]);
  assert.deepEqual(root.docs.map((d) => d.path), ['readme.md']);
  const essays = folderView(rows, 'essays');
  assert.deepEqual(essays.folders, [{ path: 'essays/old', name: 'old', count: 1 }]);
  assert.deepEqual(essays.docs.map((d) => d.path), ['essays/kilns.mdx', 'essays/repair.mdx']);
  // `essays-2` isn't inside `essays`.
  assert.deepEqual(folderView([row(local('essays-2/x.md', 'x'))], 'essays'), { folders: [], docs: [] });
});

test('filters by status, by every chosen tag, and by title words', () => {
  const pick = (filter = NO_FILTER, query = '') => rows.filter((d) => matches(d, filter, query)).map((d) => d.path);
  assert.deepEqual(pick({ status: 'draft', tags: [] }), ['essays/repair.mdx', 'essays/old/first.mdx', 'inbox/idea.mdx']);
  assert.deepEqual(pick({ status: null, tags: ['craft'] }), ['essays/kilns.mdx', 'essays/repair.mdx']);
  assert.deepEqual(pick({ status: null, tags: ['craft', 'fire'] }), ['essays/kilns.mdx']);
  assert.deepEqual(pick({ status: 'draft', tags: ['craft'] }), ['essays/repair.mdx']);
  assert.deepEqual(pick(NO_FILTER, 'kilns on'), ['essays/kilns.mdx']);
  assert.equal(pick().length, rows.length);
});

test('matches are grouped by folder, the current folder first', () => {
  const sections = matchingSections(rows, 'essays', { status: 'draft', tags: [] }, '', 'Vault');
  assert.deepEqual(
    sections.map((s) => [s.title, s.data.map((d) => d.path)]),
    [
      ['essays', ['essays/repair.mdx']],
      ['essays/old', ['essays/old/first.mdx']],
    ],
  );
  assert.equal(matchingSections(rows, '', NO_FILTER, 'no frontmatter', 'Vault')[0].title, 'Vault');
});

test('tags in use under a folder, keeping chosen ones listed', () => {
  assert.deepEqual(tagsUnder(rows, ''), ['craft', 'archive', 'fire']);
  assert.deepEqual(tagsUnder(rows, 'inbox', ['craft']), ['craft']);
});

test('the filter store toggles and clears', () => {
  const store = new FilterStore();
  let calls = 0;
  store.subscribe(() => calls++);
  store.toggleStatus('draft');
  store.toggleTag('craft');
  assert.deepEqual(store.get(), { status: 'draft', tags: ['craft'] });
  store.toggleStatus('draft');
  store.toggleTag('craft');
  assert.deepEqual(store.get(), { status: null, tags: [] });
  store.toggleTag('fire');
  store.clear();
  assert.deepEqual(store.get(), NO_FILTER);
  assert.equal(calls, 6);
});

test('a link can choose the filter', () => {
  assert.deepEqual(linkedFilter({ status: 'draft', tag: ['Craft', 'fire,craft'] }), { status: 'draft', tags: ['craft', 'fire'] });
  assert.deepEqual(linkedFilter({ status: 'nonsense', tag: '#essay' }), { status: null, tags: ['essay'] });
  assert.equal(linkedFilter({}), null);
});
