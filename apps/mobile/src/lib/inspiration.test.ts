import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ClipSummary } from '@kintsugi/core/clips';
import { HttpError, type NoteSaved, Offline, type PhoneClip, version } from '@kintsugi/core/remote';

import { type ClipClient, clipUnsent, Inspiration, searchClips } from './inspiration.ts';
import type { KV } from './library.ts';
import { imageFile, type ImageStore, NoImage, Thumbnails } from './thumbnails.ts';

function memory(): KV & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItemSync: (key) => map.get(key) ?? null,
    setItemSync: (key, value) => void map.set(key, value),
    removeItemSync: (key) => void map.delete(key),
    getAllKeysSync: () => [...map.keys()],
  };
}

function summary(path: string, change: Partial<ClipSummary> = {}): ClipSummary {
  return {
    path,
    kind: 'link',
    captured: '2026-10-29T10:00',
    tags: [],
    title: null,
    url: null,
    site: null,
    author: null,
    image: null,
    file: null,
    summary: null,
    enriched: null,
    enrichError: null,
    via: 'phone',
    ...change,
  };
}

/** A Mac with crates/vault's version-checked note edits (`clip_update_note`). */
function mac(clips: { summary: ClipSummary; text: string }[], api = 5) {
  const store = new Map(clips.map((c) => [c.summary.path, c]));
  const state = { down: false, writes: [] as { path: string; note: string; base: string }[] };
  const phone = (c: { summary: ClipSummary; text: string }): PhoneClip => ({ ...c.summary, text: c.text, hasSource: false, version: version(c.text) });
  const client: ClipClient = {
    async inspiration() {
      if (state.down) throw new Offline();
      if (api < 5) throw new HttpError(404);
      return [...store.values()].map(phone);
    },
    async clips() {
      if (state.down) throw new Offline();
      return [...store.values()].map((c) => c.summary);
    },
    async writeClipNote(path, note, base): Promise<NoteSaved> {
      if (state.down) throw new Offline();
      state.writes.push({ path, note, base });
      const current = store.get(path);
      if (!current) throw new HttpError(404);
      if (version(current.text) !== base) return { result: 'conflict', current: { text: current.text, version: version(current.text) } };
      // The Mac trims surrounding blank lines.
      const next = { ...current, text: note.replace(/^\n+|\n+$/g, '') };
      store.set(path, next);
      return { result: 'saved', version: version(next.text), clip: phone(next) };
    },
  };
  return { client, store, state };
}

const A = 'inspiration/a.md';
const B = 'inspiration/b.md';

test('the phone keeps every clip, newest first, and shows them offline', async () => {
  const kv = memory();
  const { client, state } = mac([
    { summary: summary(A, { title: 'Older', captured: '2026-10-28T10:00' }), text: 'My note' },
    { summary: summary(B, { title: 'Newer', captured: '2026-10-30T10:00', image: 'media/b.png' }), text: '' },
  ]);
  const library = new Inspiration(kv);
  await library.sync(client);
  assert.equal(library.getSnapshot().connection, 'online');
  assert.deepEqual(library.getSnapshot().clips.map((c) => c.clip.title), ['Newer', 'Older']);

  state.down = true;
  const again = new Inspiration(kv);
  assert.deepEqual(again.getSnapshot().clips.map((c) => c.clip.path), [B, A]);
  assert.equal(again.get(A)?.text, 'My note');
  await assert.rejects(again.sync(client), Offline);
  assert.equal(again.getSnapshot().connection, 'offline');
  assert.equal(again.getSnapshot().clips.length, 2, 'an unreachable Mac leaves the copy as it was');
});

test('notes edited offline are sent with the version they started from', async () => {
  const kv = memory();
  const { client, store, state } = mac([{ summary: summary(A), text: 'First thought' }]);
  const library = new Inspiration(kv);
  await library.sync(client);
  state.down = true;
  library.edit(A, 'First thought\n\nOn the train\n');
  await assert.rejects(library.sync(client), Offline);
  assert.equal(clipUnsent(new Inspiration(kv).get(A)!), true, 'the edit survives a restart');

  state.down = false;
  await new Inspiration(kv).sync(client);
  assert.deepEqual(state.writes, [{ path: A, note: 'First thought\n\nOn the train\n', base: version('First thought') }]);
  assert.equal(store.get(A)?.text, 'First thought\n\nOn the train');
  const local = new Inspiration(kv).get(A)!;
  assert.equal(local.text, 'First thought\n\nOn the train', 'the Mac’s tidied text is taken');
  assert.equal(clipUnsent(local), false);
});

test('note edits on both devices merge; a true collision asks', async () => {
  const { client, store } = mac([{ summary: summary(A), text: 'one\n\ntwo\n\nthree' }]);
  const library = new Inspiration(memory());
  await library.sync(client);
  library.edit(A, 'one, phone\n\ntwo\n\nthree');
  store.set(A, { summary: summary(A), text: 'one\n\ntwo\n\nthree, Mac' });
  await library.push(client, A);
  assert.equal(store.get(A)?.text, 'one, phone\n\ntwo\n\nthree, Mac');
  assert.equal(library.get(A)?.text, 'one, phone\n\ntwo\n\nthree, Mac');

  library.edit(A, 'one, phone\n\ntwo from the phone\n\nthree, Mac');
  store.set(A, { summary: summary(A), text: 'one, phone\n\ntwo from the Mac\n\nthree, Mac' });
  await library.sync(client);
  assert.equal(store.get(A)?.text, 'one, phone\n\ntwo from the Mac\n\nthree, Mac', 'nothing overwritten');
  assert.equal(library.get(A)?.conflict?.text, 'one, phone\n\ntwo from the Mac\n\nthree, Mac');
  library.keepMine(A);
  await library.sync(client);
  assert.equal(store.get(A)?.text, 'one, phone\n\ntwo from the phone\n\nthree, Mac');
  assert.equal(library.get(A)?.conflict, undefined);
});

test('a keystroke that races a sync is folded in, not lost', async () => {
  const { client, store } = mac([{ summary: summary(A), text: 'one\n\ntwo' }]);
  const library = new Inspiration(memory());
  await library.sync(client);
  const seen = library.get(A)!.text!;
  store.set(A, { summary: summary(A), text: 'one\n\ntwo, Mac' });
  await library.sync(client);
  library.edit(A, 'one, typed\n\ntwo', seen);
  assert.equal(library.get(A)?.text, 'one, typed\n\ntwo, Mac');
});

test('clips removed on the Mac go, unless an edit waits on them', async () => {
  const { client, store } = mac([
    { summary: summary(A), text: 'a' },
    { summary: summary(B), text: 'b' },
  ]);
  const library = new Inspiration(memory());
  await library.sync(client);
  library.edit(B, 'b, edited');
  store.clear();
  await library.sync(client);
  assert.equal(library.get(A), null);
  assert.equal(library.get(B)?.gone, true);
  assert.equal(library.get(B)?.text, 'b, edited', 'the words are kept for the owner');
  library.discard(B);
  assert.equal(library.get(B), null);
});

test('an older Mac lists cards without notes, which stay read-only', async () => {
  const { client, state } = mac([{ summary: summary(A, { title: 'Old Mac' }), text: 'hidden' }], 4);
  const library = new Inspiration(memory());
  await library.sync(client);
  assert.equal(library.get(A)?.clip.title, 'Old Mac');
  assert.equal(library.get(A)?.text, null);
  library.edit(A, 'typed');
  assert.equal(library.get(A)?.text, null);
  assert.deepEqual(state.writes, []);
});

test('search matches every word across title, tags, site and notes', () => {
  const clips = [
    { clip: summary(A, { title: 'Why we sleep', tags: ['science'], site: 'The New Yorker' }), text: 'Read before the essay', base: null, version: null },
    { clip: summary(B, { title: 'Golden seams', summary: 'On kintsugi and repair' }), text: '', base: null, version: null },
  ];
  assert.deepEqual(searchClips(clips, '').map((c) => c.clip.path), [A, B]);
  assert.deepEqual(searchClips(clips, 'SLEEP yorker').map((c) => c.clip.path), [A]);
  assert.deepEqual(searchClips(clips, '#science essay').map((c) => c.clip.path), [A]);
  assert.deepEqual(searchClips(clips, 'repair').map((c) => c.clip.path), [B]);
  assert.deepEqual(searchClips(clips, 'sleep repair'), []);
});

// ---- thumbnails -----------------------------------------------------------

function images(missing: string[] = []) {
  const files = new Map<string, string>();
  const state = { down: false, downloads: [] as string[] };
  const store: ImageStore = {
    uri: (name) => `file:///images/${name}`,
    exists: (name) => files.has(name),
    remove: (name) => void files.delete(name),
    list: () => [...files.keys()],
    async download(url, headers, name) {
      assert.equal(headers.Authorization, 'Bearer T');
      if (state.down) throw new Error('offline');
      state.downloads.push(url);
      if (missing.some((path) => url.endsWith(encodeURIComponent(path)))) throw new NoImage();
      files.set(name, url);
    },
  };
  const source = (path: string) => ({ url: `http://mac/v1/clip/image?path=${encodeURIComponent(path)}`, headers: { Authorization: 'Bearer T' } });
  return { files, state, store, source };
}

test('card images are fetched once and kept for offline browsing', async () => {
  const kv = memory();
  const { files, state, store, source } = images();
  const clips = [summary(A, { image: 'media/a.png' }), summary(B)];
  const thumbs = new Thumbnails(kv, store);
  assert.equal(thumbs.uri(clips[0]), null);
  await thumbs.update(clips, source);
  assert.equal(thumbs.uri(clips[0]), `file:///images/${imageFile(A, 'media/a.png')}`);
  assert.equal(thumbs.uri(clips[1]), null, 'a clip without an image asks for none');
  assert.equal(state.downloads.length, 1);

  // Next launch, and next sync: nothing is fetched again.
  const again = new Thumbnails(kv, store);
  assert.ok(again.uri(clips[0]));
  await again.update(clips, source);
  assert.equal(state.downloads.length, 1);
  assert.equal(files.size, 1);
});

test('a new image is fetched; images of removed clips are deleted', async () => {
  const kv = memory();
  const { files, state, store, source } = images();
  const thumbs = new Thumbnails(kv, store);
  await thumbs.update([summary(A, { image: 'media/a.png' }), summary(B, { image: 'media/b.jpg' })], source);
  assert.equal(files.size, 2);
  // Enrichment found a better image for A; B was trashed on the Mac.
  const changed = summary(A, { image: 'media/a.jpg' });
  await thumbs.update([changed], source);
  assert.deepEqual([...files.keys()], [imageFile(A, 'media/a.jpg')]);
  assert.equal(state.downloads.length, 3);
  assert.ok(thumbs.uri(changed));
  assert.equal(thumbs.uri(summary(A, { image: 'media/a.png' })), null);
});

test('"no image" is remembered; a Mac that went away is tried again', async () => {
  const kv = memory();
  const { state, store, source } = images([A]);
  const thumbs = new Thumbnails(kv, store);
  const clips = [summary(A, { image: 'media/a.png' }), summary(B, { image: 'media/b.png' })];
  state.down = true;
  await assert.rejects(thumbs.update(clips, source));
  state.down = false;
  await thumbs.update(clips, source);
  assert.equal(thumbs.uri(clips[0]), null);
  assert.ok(thumbs.uri(clips[1]));
  const before = state.downloads.length;
  await thumbs.update(clips, source);
  assert.equal(state.downloads.length, before, 'A’s missing image isn’t asked for on every sync');
});

test('a cached file deleted by the system is fetched again', async () => {
  const { files, state, store, source } = images();
  const thumbs = new Thumbnails(memory(), store);
  const clips = [summary(A, { image: 'media/a.png' })];
  await thumbs.update(clips, source);
  files.clear();
  assert.equal(thumbs.uri(clips[0]), null);
  await thumbs.update(clips, source);
  assert.ok(thumbs.uri(clips[0]));
  assert.equal(state.downloads.length, 2);
});
