import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Document, HttpError, Offline, type Saved, version } from '@kintsugi/core/remote';

import { captureTitle, type Client, docTitle, type KV, Library, slugify } from './library.ts';

/** expo-sqlite's kv-store, as a Map. */
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

/** A Mac with crates/vault's versioned writes. `down` makes it unreachable. */
function mac(files: Record<string, string>) {
  const docs = new Map(Object.entries(files));
  const state = { down: false, writes: [] as { path: string; text: string; base: string }[], loseReply: false };
  const client: Client = {
    async library(): Promise<Document[]> {
      if (state.down) throw new Offline();
      return [...docs].map(([path, text]) => ({ path, text, version: version(text) }));
    },
    async read(path) {
      if (state.down) throw new Offline();
      const text = docs.get(path);
      if (text === undefined) throw new HttpError(404);
      return { text, version: version(text) };
    },
    async write(path, text, base): Promise<Saved> {
      if (state.down) throw new Offline();
      state.writes.push({ path, text, base });
      const current = docs.get(path);
      if (current !== undefined && current !== text && version(current) !== base) {
        return { result: 'conflict', current: { text: current, version: version(current) } };
      }
      docs.set(path, text);
      if (state.loseReply) {
        state.loseReply = false;
        throw new Offline();
      }
      return { result: 'saved', version: version(text) };
    },
  };
  return { client, docs, state };
}

const doc = (title: string, ...paragraphs: string[]) => `---\ntitle: "${title}"\nstatus: draft\n---\n\n${paragraphs.join('\n\n')}\n`;
const NOW = () => new Date(2026, 9, 31, 23, 41);

test('the phone keeps a copy of every document and works on it offline', async () => {
  const kv = memory();
  const { client, state } = mac({ 'essays/repair.mdx': doc('Repair', 'one'), 'inbox/idea.mdx': doc('Idea', 'two') });
  const library = new Library(kv, NOW);
  await library.sync(client);
  assert.equal(library.getSnapshot().connection, 'online');
  assert.deepEqual(library.getSnapshot().docs.map((d) => d.path).sort(), ['essays/repair.mdx', 'inbox/idea.mdx']);

  // The Mac goes away; the app is closed and opened again.
  state.down = true;
  const again = new Library(kv, NOW);
  assert.equal(again.get('essays/repair.mdx')?.text, doc('Repair', 'one'));
  again.edit('essays/repair.mdx', doc('Repair', 'one, on the train'));
  const note = again.create('An idea on the train\nwith a second line');
  await assert.rejects(again.sync(client), Offline);
  assert.equal(again.getSnapshot().connection, 'offline');
  assert.equal(new Library(kv, NOW).get('essays/repair.mdx')?.text, doc('Repair', 'one, on the train'));
  assert.equal(new Library(kv, NOW).get(note)?.fresh, true);
});

test('edits made offline are sent with the version they started from', async () => {
  const kv = memory();
  const { client, docs, state } = mac({ 'a.mdx': doc('A', 'one') });
  const library = new Library(kv, NOW);
  await library.sync(client);
  library.edit('a.mdx', doc('A', 'one, edited'));
  await library.sync(client);
  assert.equal(docs.get('a.mdx'), doc('A', 'one, edited'));
  assert.deepEqual(state.writes, [{ path: 'a.mdx', text: doc('A', 'one, edited'), base: version(doc('A', 'one')) }]);
  const local = library.get('a.mdx')!;
  assert.equal(local.base, local.text);
  assert.equal(local.version, version(doc('A', 'one, edited')));
});

test('edits on both devices to different paragraphs merge without asking', async () => {
  const kv = memory();
  const { client, docs } = mac({ 'a.mdx': doc('A', 'one', 'two', 'three') });
  const library = new Library(kv, NOW);
  await library.sync(client);
  library.edit('a.mdx', doc('A', 'one, from the phone', 'two', 'three'));
  docs.set('a.mdx', doc('A', 'one', 'two', 'three, from the Mac'));
  await library.sync(client);
  const merged = doc('A', 'one, from the phone', 'two', 'three, from the Mac');
  assert.equal(docs.get('a.mdx'), merged);
  assert.equal(library.get('a.mdx')?.text, merged);
  assert.equal(library.get('a.mdx')?.conflict, undefined);

  // The same through a single push, where the Mac answers with a conflict.
  library.edit('a.mdx', merged.replace('two', 'two, phone'));
  docs.set('a.mdx', merged.replace('three, from the Mac', 'three, Mac again'));
  await library.push(client, 'a.mdx');
  assert.equal(docs.get('a.mdx'), doc('A', 'one, from the phone', 'two, phone', 'three, Mac again'));
});

test('a true collision asks, and the owner can keep either version', async () => {
  const { client, docs } = mac({ 'a.mdx': doc('A', 'one', 'two') });
  const library = new Library(memory(), NOW);
  await library.sync(client);
  library.edit('a.mdx', doc('A', 'one', 'two from the phone'));
  docs.set('a.mdx', doc('A', 'one', 'two from the Mac'));
  await library.sync(client);
  // Nothing was overwritten on either side.
  assert.equal(docs.get('a.mdx'), doc('A', 'one', 'two from the Mac'));
  assert.equal(library.get('a.mdx')?.text, doc('A', 'one', 'two from the phone'));
  assert.deepEqual(library.get('a.mdx')?.conflict, { text: doc('A', 'one', 'two from the Mac'), version: version(doc('A', 'one', 'two from the Mac')) });
  // Waiting for an answer, nothing is sent.
  await library.sync(client);
  assert.equal(docs.get('a.mdx'), doc('A', 'one', 'two from the Mac'));

  library.keepMine('a.mdx');
  await library.push(client, 'a.mdx');
  assert.equal(docs.get('a.mdx'), doc('A', 'one', 'two from the phone'));
  assert.equal(library.get('a.mdx')?.conflict, undefined);

  library.edit('a.mdx', doc('A', 'one', 'phone again'));
  docs.set('a.mdx', doc('A', 'one', 'Mac again'));
  await library.push(client, 'a.mdx');
  assert.ok(library.get('a.mdx')?.conflict);
  library.useTheirs('a.mdx');
  assert.equal(library.get('a.mdx')?.text, doc('A', 'one', 'Mac again'));
  await library.sync(client);
  assert.equal(docs.get('a.mdx'), doc('A', 'one', 'Mac again'));
});

test('a collision that the Mac later resolves itself clears', async () => {
  const { client, docs } = mac({ 'a.mdx': 'x\n' });
  const library = new Library(memory(), NOW);
  await library.sync(client);
  library.edit('a.mdx', 'phone\n');
  docs.set('a.mdx', 'mac\n');
  await library.sync(client);
  assert.ok(library.get('a.mdx')?.conflict);
  docs.set('a.mdx', 'phone\n');
  await library.sync(client);
  assert.equal(library.get('a.mdx')?.conflict, undefined);
  assert.equal(library.get('a.mdx')?.version, version('phone\n'));
});

test('notes started offline land in inbox/, named by their first line', async () => {
  const { client, docs, state } = mac({ 'inbox/gold-seams.mdx': doc('Gold seams', 'someone else’s') });
  const library = new Library(memory(), NOW);
  state.down = true;
  const path = library.create('# Gold seams\nwhere the AI touched a draft');
  assert.equal(path, 'inbox/note-2026-10-31-23-41.mdx');
  assert.equal(docTitle(library.get(path)!), 'Gold seams');
  await assert.rejects(library.sync(client), Offline);

  state.down = false;
  await library.sync(client);
  const text = '---\nstatus: draft\ncaptured: "2026-10-31T23:41"\ntitle: "Gold seams"\n---\n\n# Gold seams\nwhere the AI touched a draft\n';
  // The Mac already had a note at that name, so it took the next one.
  assert.equal(docs.get('inbox/gold-seams-2.mdx'), text);
  assert.equal(docs.get('inbox/gold-seams.mdx'), doc('Gold seams', 'someone else’s'));
  assert.equal(library.get(path), null);
  assert.equal(library.movedTo(path), 'inbox/gold-seams-2.mdx');
  const sent = library.get('inbox/gold-seams-2.mdx')!;
  assert.equal(sent.fresh, undefined);
  assert.equal(sent.text, text);
  assert.equal(library.get('inbox/gold-seams.mdx')?.text, doc('Gold seams', 'someone else’s'));
});

test('a note whose reply was lost is not sent twice', async () => {
  const { client, docs, state } = mac({});
  const library = new Library(memory(), NOW);
  library.create('Plane thoughts');
  state.loseReply = true;
  await assert.rejects(library.sync(client), Offline);
  await library.sync(client);
  assert.deepEqual([...docs.keys()], ['inbox/plane-thoughts.mdx']);
  assert.equal(library.getSnapshot().docs.length, 1);
});

test('a new note waits while its first line is being typed, and an empty one is dropped', async () => {
  const { client, docs } = mac({});
  const library = new Library(memory(), NOW);
  const path = library.create();
  library.open = path;
  library.edit(path, library.get(path)!.text + 'Gol');
  await library.push(client, path);
  assert.equal(docs.size, 0);
  library.edit(path, library.get(path)!.text.replace('Gol', 'Gold seams\n'));
  await library.push(client, path);
  assert.deepEqual([...docs.keys()], ['inbox/gold-seams.mdx']);
  assert.equal(library.open, 'inbox/gold-seams.mdx');

  const empty = library.create();
  library.discardIfEmpty(empty);
  assert.equal(library.get(empty), null);
  await library.sync(client);
  assert.equal(docs.size, 1);
});

test('documents removed on the Mac go, unless the phone has unsent edits', async () => {
  const { client, docs } = mac({ 'a.mdx': 'a\n', 'b.mdx': 'b\n' });
  const library = new Library(memory(), NOW);
  await library.sync(client);
  library.edit('b.mdx', 'b, edited on the phone\n');
  docs.delete('a.mdx');
  docs.delete('b.mdx');
  docs.set('c.mdx', 'c\n');
  await library.sync(client);
  assert.equal(library.get('a.mdx'), null);
  assert.equal(docs.get('b.mdx'), 'b, edited on the phone\n');
  assert.equal(library.get('c.mdx')?.text, 'c\n');
});

test('typing during a send stays unsent', async () => {
  const { client, docs } = mac({ 'a.mdx': 'one\n' });
  const library = new Library(memory(), NOW);
  await library.sync(client);
  library.edit('a.mdx', 'one two\n');
  const write = client.write;
  client.write = async (...args) => {
    library.edit('a.mdx', 'one two three\n');
    return write(...args);
  };
  await library.push(client, 'a.mdx');
  client.write = write;
  assert.equal(docs.get('a.mdx'), 'one two\n');
  assert.equal(library.get('a.mdx')?.text, 'one two three\n');
  await library.push(client, 'a.mdx');
  assert.equal(docs.get('a.mdx'), 'one two three\n');
});

test('edits saved per document before the full copy are carried over', async () => {
  const kv = memory();
  kv.setItemSync('draft:a.mdx', JSON.stringify({ text: 'mine\n', base: version('old\n') }));
  kv.setItemSync('draft:b.mdx', JSON.stringify({ text: 'mine\n', base: version('old\n') }));
  const { client, docs } = mac({ 'a.mdx': 'old\n', 'b.mdx': 'changed on the Mac\n' });
  const library = new Library(kv, NOW);
  assert.equal(kv.getItemSync('draft:a.mdx'), null);
  await library.sync(client);
  assert.equal(docs.get('a.mdx'), 'mine\n');
  // Without the old text there is nothing to merge against: ask.
  assert.equal(docs.get('b.mdx'), 'changed on the Mac\n');
  assert.ok(library.get('b.mdx')?.conflict);
});

test('names follow the Mac’s rules', () => {
  assert.equal(slugify('  Gold seams, for AI edits! '), 'gold-seams-for-ai-edits');
  assert.equal(slugify('Café'), 'café');
  assert.equal(slugify('!!!'), 'untitled');
  assert.equal(captureTitle('\n## Gold seams\nmore'), 'Gold seams');
  assert.equal(
    captureTitle('A rather long first line that keeps going well past the sixty character limit'),
    'A rather long first line that keeps going well past the…',
  );
});

test('an editor still holding a note’s first name keeps editing it', async () => {
  const { client, docs } = mac({});
  const library = new Library(memory(), NOW);
  const path = library.create('Gold seams');
  await library.sync(client);
  library.edit(path, library.get('inbox/gold-seams.mdx')!.text + 'more\n');
  await library.push(client, path);
  assert.match(docs.get('inbox/gold-seams.mdx')!, /Gold seams\nmore\n$/);
});

test('typing into one document while a sync sends another is kept', async () => {
  const { client, docs } = mac({ 'a.mdx': 'a\n', 'b.mdx': 'b\n' });
  const library = new Library(memory(), NOW);
  await library.sync(client);
  library.edit('a.mdx', 'a, phone\n');
  docs.set('b.mdx', 'b\n\nfrom the Mac\n');
  const write = client.write;
  client.write = async (...args) => {
    client.write = write;
    library.edit('b.mdx', 'b, typed during the sync\n');
    return write(...args);
  };
  await library.sync(client);
  client.write = write;
  // Merged with the Mac's change, not replaced by it.
  assert.equal(library.get('b.mdx')?.text, 'b, typed during the sync\n\nfrom the Mac\n');
  await library.sync(client);
  assert.equal(docs.get('b.mdx'), 'b, typed during the sync\n\nfrom the Mac\n');
});

test('a note renamed while offline is only renamed once the Mac has it', async () => {
  const { client, docs, state } = mac({});
  const library = new Library(memory(), NOW);
  const path = library.create('Alpha\nbody');
  state.down = true;
  for (const first of ['Alph', 'Alpha']) {
    library.edit(path, library.get(path)!.text.replace(/Alpha?\n/, `${first}\n`));
    await assert.rejects(library.push(client, path), Offline);
  }
  assert.equal(library.movedTo(path), null);
  assert.ok(library.get(path));
  state.down = false;
  await library.push(client, path);
  assert.deepEqual([...docs.keys()], ['inbox/alpha.mdx']);
  assert.equal(library.movedTo(path), 'inbox/alpha.mdx');

  // A reply lost after the Mac saved it, then the first line changed: the
  // note stays where it landed rather than appearing twice.
  const other = library.create('Beta\nbody');
  state.loseReply = true;
  await assert.rejects(library.push(client, other), Offline);
  library.edit(other, library.get(other)!.text.replace('Beta', 'Gamma'));
  await library.push(client, other);
  assert.deepEqual([...docs.keys()].sort(), ['inbox/alpha.mdx', 'inbox/beta.mdx']);
  assert.match(docs.get('inbox/beta.mdx')!, /title: "Gamma"/);
});

test('a lost reply followed by more typing neither duplicates a note nor asks', async () => {
  const { client, docs, state } = mac({ 'a.mdx': 'one\n' });
  const library = new Library(memory(), NOW);
  await library.sync(client);
  const note = library.create('Plane thoughts\nfirst');
  state.loseReply = true;
  await assert.rejects(library.push(client, note), Offline);
  library.edit(note, library.get(note)!.text + 'second\n');
  await library.sync(client);
  assert.deepEqual([...docs.keys()].sort(), ['a.mdx', 'inbox/plane-thoughts.mdx']);
  assert.match(docs.get('inbox/plane-thoughts.mdx')!, /first\nsecond\n$/);
  assert.equal(library.getSnapshot().docs.length, 2);

  library.edit('a.mdx', 'one two\n');
  state.loseReply = true;
  await assert.rejects(library.push(client, 'a.mdx'), Offline);
  library.edit('a.mdx', 'one two three\n');
  await library.push(client, 'a.mdx');
  assert.equal(library.get('a.mdx')?.conflict, undefined);
  assert.equal(docs.get('a.mdx'), 'one two three\n');
});

test('a keystroke made against text that has since changed is folded in', async () => {
  const library = new Library(memory(), NOW);
  const { client, docs } = mac({ 'a.mdx': 'one\n\ntwo\n' });
  await library.sync(client);
  const seen = library.get('a.mdx')!.text;
  docs.set('a.mdx', 'one\n\ntwo, Mac\n');
  await library.sync(client);
  library.edit('a.mdx', 'one!\n\ntwo\n', seen);
  assert.equal(library.get('a.mdx')?.text, 'one!\n\ntwo, Mac\n');
  // Colliding with what landed: the keystroke is kept, and the Mac's copy
  // waits beside it until the owner picks one.
  library.edit('a.mdx', 'one!\n\ntwo?\n', seen);
  assert.equal(library.get('a.mdx')?.text, 'one!\n\ntwo?\n');
  assert.deepEqual(library.get('a.mdx')?.conflict, { text: 'one\n\ntwo, Mac\n', version: version('one\n\ntwo, Mac\n') });
});

test('a colliding keystroke survives a sync and is sent once the owner keeps it', async () => {
  const library = new Library(memory(), NOW);
  const { client, docs } = mac({ 'a.mdx': 'one\n\ntwo\n' });
  await library.sync(client);
  const seen = library.get('a.mdx')!.text;
  docs.set('a.mdx', 'one\n\ntwo, Mac\n');
  await library.sync(client);
  library.edit('a.mdx', 'one\n\ntwo, phone\n', seen);
  // Nothing is sent or overwritten while the conflict waits.
  await library.sync(client);
  assert.equal(docs.get('a.mdx'), 'one\n\ntwo, Mac\n');
  assert.equal(library.get('a.mdx')?.text, 'one\n\ntwo, phone\n');
  assert.ok(library.get('a.mdx')?.conflict);
  library.keepMine('a.mdx');
  await library.sync(client);
  assert.equal(docs.get('a.mdx'), 'one\n\ntwo, phone\n');
  assert.equal(library.get('a.mdx')?.conflict, undefined);

  // Choosing the Mac's copy instead drops the keystroke, as the owner asked.
  const shown = library.get('a.mdx')!.text;
  docs.set('a.mdx', 'one\n\ntwo, Mac again\n');
  await library.sync(client);
  library.edit('a.mdx', 'one\n\ntwo, phone again\n', shown);
  library.useTheirs('a.mdx');
  assert.equal(library.get('a.mdx')?.text, 'one\n\ntwo, Mac again\n');
  assert.equal(library.get('a.mdx')?.conflict, undefined);
});
