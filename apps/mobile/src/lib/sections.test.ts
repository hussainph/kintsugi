import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpError, Offline, Unpaired, version } from '@kintsugi/core/remote';
import type { FeedItem, IdeasView, KinPage, ListedIdea, Pick as FeedPick } from '@kintsugi/core/sections';

import { effectLine, Feed, type FeedClient } from './feed.ts';
import { groupIdeas, Ideas, type IdeasClient } from './ideas.ts';
import { activeJobs, Kin, type KinClient, kinStatus, shown } from './kin.ts';
import type { KV } from './library.ts';

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

function item(id: number, change: Partial<FeedItem> = {}): FeedItem {
  return {
    id,
    sourceId: 1,
    sourceTitle: 'The Slow Workshop',
    sourceKind: 'feed',
    url: `https://example.com/${id}`,
    title: `Item ${id}`,
    author: null,
    summary: 'A summary',
    image: null,
    media: 'article',
    publishedAt: 1_000,
    fetchedAt: 1_000,
    sortAt: 1_000,
    liked: false,
    note: null,
    savedPath: null,
    dismissed: false,
    hasContent: true,
    ...change,
  };
}

const pick = (i: FeedItem): FeedPick => ({ item: i, id: i.id, score: 0.5, explore: false, reasons: [] });

/** A Mac with a feed, that records what it was asked and can go away. */
function feedMac(items: FeedItem[]) {
  const state = { away: false, items, asked: [] as string[] };
  const reach = () => {
    if (state.away) throw new Offline();
  };
  const find = (id: number) => {
    const found = state.items.find((i) => i.id === id);
    if (!found) throw new HttpError(400, 'no feed item with that id');
    return found;
  };
  const set = (next: FeedItem) => (state.items = state.items.map((i) => (i.id === next.id ? next : i)));
  const client: FeedClient = {
    feed: async () => (reach(), { items: state.items.filter((i) => !i.dismissed), total: state.items.filter((i) => !i.dismissed).length }),
    picked: async () => (reach(), { picks: state.items.slice(0, 2).map(pick), examples: 0, learnedShare: 0 }),
    feedRead: async (id) => (reach(), state.asked.push(`read ${id}`), { item: find(id), text: `Whole text of ${id}` }),
    feedAct: async (id, action, place) => {
      reach();
      state.asked.push(`${action} ${id} ${place?.surface ?? ''}`.trim());
      const before = find(id);
      if (action === 'like' || action === 'unlike') set({ ...before, liked: action === 'like' });
      if (action === 'notInterested' || action === 'undoNotInterested') set({ ...before, dismissed: action === 'notInterested' });
      return find(id);
    },
    feedNote: async (id, note, base) => {
      reach();
      const before = find(id);
      if (version(before.note ?? '') !== base) {
        state.asked.push(`note conflict ${id}`);
        return { result: 'conflict', current: { text: before.note ?? '', version: version(before.note ?? '') }, item: before };
      }
      state.asked.push(`note ${id} ${note}`);
      set({ ...before, note: note || null });
      return { result: 'saved', version: version(note), item: find(id) };
    },
    feedSave: async (id) => (reach(), state.asked.push(`save ${id}`), set({ ...find(id), savedPath: `inspiration/item-${id}.md` }), find(id)),
    feedImpressions: async (list) => (reach(), state.asked.push(`impressions ${list.length}`), {}),
    feedEffect: async () => ({ changes: [{ key: 'source:1', label: 'The Slow Workshop', before: 0.25, after: 0.4 }], added: [], removed: [] }),
  };
  return { client, state };
}

test('the feed is kept to read offline, and actions wait for the Mac in order', async () => {
  const kv = memory();
  const mac = feedMac([item(1), item(2), item(3)]);
  const feed = new Feed(kv);
  await feed.sync(mac.client);
  assert.deepEqual(feed.getSnapshot().items.map((i) => i.id), [1, 2, 3]);
  assert.equal(await feed.read(mac.client, 1, { surface: 'newest', position: 0 }), 'Whole text of 1');

  mac.state.away = true;
  feed.act(1, 'like', { surface: 'picked', position: 0 });
  feed.act(2, 'notInterested', { surface: 'newest', position: 1 });
  feed.save(3);
  feed.save(3);
  feed.saw([{ id: 1, position: 0, surface: 'picked' }, { id: 1, position: 0, surface: 'picked' }]);
  await feed.sync(mac.client);
  let snap = feed.getSnapshot();
  assert.equal(snap.connection, 'offline');
  assert.equal(snap.waiting, 3, 'a second save of the same item queued twice');
  assert.deepEqual(snap.items.map((i) => i.id), [1, 3], 'Not interested hides the item at once');
  assert.equal(snap.items[0].liked, true);
  assert.equal(snap.items[0].waiting, true);
  assert.equal(snap.items[1].savedPath, '', 'a waiting save shows as saving');
  // Read again offline: what the phone kept.
  assert.equal(await feed.read(mac.client, 1), 'Whole text of 1');

  // A relaunch keeps both the copy and what waits.
  const again = new Feed(kv);
  assert.equal(again.getSnapshot().waiting, 3);
  assert.equal(again.text(1), 'Whole text of 1');

  mac.state.away = false;
  await again.sync(mac.client);
  assert.deepEqual(mac.state.asked, ['read 1', 'like 1 picked', 'notInterested 2 newest', 'save 3', 'impressions 1']);
  snap = again.getSnapshot();
  assert.equal(snap.waiting, 0);
  assert.equal(snap.connection, 'online');
  assert.deepEqual(snap.items.map((i) => [i.id, i.liked, i.savedPath]), [[1, true, null], [3, false, 'inspiration/item-3.md']]);
  assert.match(effectLine(snap.effect!.effect), /More like The Slow Workshop/);
});

test('a feed note is checked against the note it started from', async () => {
  const mac = feedMac([item(1, { note: 'From the Mac' })]);
  const feed = new Feed(memory());
  await feed.sync(mac.client);
  mac.state.away = true;
  feed.note(1, 'From the Mac\n\nOn a');
  feed.note(1, 'From the Mac\n\nOn a train');
  assert.equal(feed.getSnapshot().waiting, 1, 'typing keeps one waiting note');
  assert.equal(feed.getSnapshot().items[0].note, 'From the Mac\n\nOn a train');
  // Meanwhile on the Mac, an edit elsewhere in the note merges cleanly…
  mac.state.items = [item(1, { note: 'Edited first.\n\nFrom the Mac' })];
  mac.state.away = false;
  await feed.sync(mac.client);
  assert.equal(mac.state.items[0].note, 'Edited first.\n\nFrom the Mac\n\nOn a train');
  assert.deepEqual(feed.getSnapshot().conflicts, {});

  // …but the same words changed in both places ask which to keep.
  mac.state.away = true;
  feed.note(1, 'Phone words');
  mac.state.items = [item(1, { note: 'Mac words' })];
  mac.state.away = false;
  await feed.sync(mac.client);
  assert.deepEqual(feed.getSnapshot().conflicts, { 1: { mine: 'Phone words', theirs: 'Mac words', version: version('Mac words') } });
  assert.equal(mac.state.items[0].note, 'Mac words', 'a conflict overwrote the Mac');
  feed.resolve(1, 'mine');
  await feed.sync(mac.client);
  assert.equal(mac.state.items[0].note, 'Phone words');
  assert.deepEqual(feed.getSnapshot().conflicts, {});
});

test('an action the Mac refuses is dropped with a reason; others still go', async () => {
  const mac = feedMac([item(1)]);
  const feed = new Feed(memory());
  await feed.sync(mac.client);
  mac.state.away = true;
  feed.act(1, 'like');
  mac.state.items = [];
  mac.state.away = false;
  // The item expired on the Mac: the like can't land, and isn't retried forever.
  await feed.sync(mac.client);
  assert.equal(feed.getSnapshot().waiting, 0);
  assert.equal(feed.getSnapshot().items.length, 0);
});

function idea(id: string, change: Partial<ListedIdea> = {}): ListedIdea {
  return {
    id,
    created: '2026-11-01T09:00:00Z',
    job: 'job-1',
    kind: 'gap',
    title: `Idea ${id}`,
    draftTitle: `Draft ${id}`,
    snippet: 'A snippet',
    observed: ['You saved seven things about repair.'],
    hunch: 'The cost side of repair.',
    quotes: [
      { source: 'posts/on-craft.mdx', text: 'Repair is attention', title: 'On craft', origin: 'post', own: true },
      { source: 'posts/on-craft.mdx', text: 'Gold seams', title: 'On craft', origin: 'post', own: true },
      { source: 'inspiration/golden-joinery.md', text: 'Golden joinery', title: 'Golden joinery', origin: 'clip', own: false },
    ],
    steps: [],
    reasons: [],
    about: [],
    age: 0,
    stage: 'fresh',
    ...change,
  };
}

function ideasMac(ideas: ListedIdea[]) {
  const state = { away: false, view: { ideas, job: null, today: 'Sunday, 1 November', capReached: false } as IdeasView, asked: [] as string[], drafts: 0 };
  const reach = () => {
    if (state.away) throw new Offline();
  };
  const client: IdeasClient = {
    ideas: async () => (reach(), state.view),
    moreIdeas: async () => {
      reach();
      state.asked.push('more');
      state.view = { ...state.view, job: { id: 'job-2', kind: 'ideas', task: 'ideas', brief: '', topic: '', status: 'running', created: '' } };
      return state.view;
    },
    adoptIdea: async (id) => {
      reach();
      state.asked.push(`adopt ${id}`);
      const found = state.view.ideas.find((i) => i.id === id)!;
      const path = found.adopted?.path ?? `drafts/draft-${id}-${++state.drafts}.mdx`;
      state.view = { ...state.view, ideas: state.view.ideas.map((i) => (i.id === id ? { ...i, adopted: { path, at: '', new: true } } : i)) };
      return { path, view: state.view };
    },
    dismissIdea: async (id, undo) => {
      reach();
      state.asked.push(`${undo ? 'undismiss' : 'dismiss'} ${id}`);
      state.view = { ...state.view, ideas: state.view.ideas.map((i) => (i.id === id ? { ...i, dismissed: undo ? undefined : { at: '', reasons: [] } } : i)) };
      return state.view;
    },
    ideaDiscussed: async (id) => (reach(), state.asked.push(`discussed ${id}`), {}),
  };
  return { client, state };
}

test('ideas are kept offline; Adopt, Dismiss and Ask for more wait for the Mac', async () => {
  const kv = memory();
  const mac = ideasMac([idea('a'), idea('b'), idea('c', { age: 8, stage: 'faded' })]);
  const ideas = new Ideas(kv);
  await ideas.sync(mac.client);
  let groups = groupIdeas(ideas.getSnapshot().ideas);
  assert.deepEqual([groups.today.length, groups.earlier.length, groups.faded.length], [2, 0, 1]);

  mac.state.away = true;
  ideas.adopt('a');
  ideas.adopt('a');
  ideas.dismiss('b');
  ideas.more();
  ideas.more();
  assert.deepEqual(await ideas.sync(mac.client), []);
  const snap = ideas.getSnapshot();
  assert.equal(snap.connection, 'offline');
  assert.equal(snap.waiting, 3);
  assert.equal(snap.making, true, 'Ask for more shows as on its way');
  assert.equal(snap.ideas.find((i) => i.id === 'a')!.adopting, true);
  groups = groupIdeas(snap.ideas, new Set(['b']));
  assert.ok(groups.today.some((i) => i.id === 'b' && i.dismissed), 'a just-dismissed idea keeps its place for Undo');
  assert.ok(!groupIdeas(snap.ideas).today.some((i) => i.id === 'b'));

  mac.state.away = false;
  const drafts = await new Ideas(kv).sync(mac.client);
  assert.deepEqual(drafts, ['drafts/draft-a-1.mdx']);
  assert.deepEqual(mac.state.asked, ['adopt a', 'dismiss b', 'more']);
  // Adopted already: no second draft.
  const after = new Ideas(kv);
  after.adopt('a');
  assert.equal(after.getSnapshot().waiting, 0);
  assert.equal(after.getSnapshot().adopted.a, 'drafts/draft-a-1.mdx');
  assert.equal(after.getSnapshot().making, true);
});

function kinMac() {
  const state = {
    away: false,
    refuse: false,
    page: { entries: [], threads: [], pending: [], running: null } as KinPage,
    sent: new Map<string, number>(),
    seq: 0,
  };
  const reach = () => {
    if (state.away) throw new Offline();
  };
  const client: KinClient = {
    kin: async () => (reach(), state.page),
    kinJobs: async () => (reach(), [{ id: 'job-1', kind: 'ideas', task: 'ideas', brief: '', topic: '', status: 'running', created: '2026-11-01' }]),
    kinStop: async () => (reach(), {}),
    kinSend: async (id, text, chips = []) => {
      reach();
      if (text.length > 50) throw new HttpError(400, 'That message is too long.');
      if (state.sent.has(id)) return { seq: state.sent.get(id)!, duplicate: true };
      const seq = ++state.seq;
      state.sent.set(id, seq);
      const entry = { seq, at: `2026-11-01T10:0${seq}:00Z`, role: 'owner' as const, text, chips, topic: chips[0] ? `feed:${chips[0].path}` : '' };
      state.page = { ...state.page, entries: [...state.page.entries, entry], pending: [...state.page.pending, seq] };
      return { entry, duplicate: false };
    },
  };
  return { client, state };
}

test('Kin says it needs the Mac, keeps messages in order, and sends each once', async () => {
  const kv = memory();
  const mac = kinMac();
  let n = 0;
  const kin = new Kin(kv, () => `00000000-0000-4000-8000-00000000000${++n}`, () => new Date('2026-11-01T09:00:00Z'));
  mac.state.away = true;
  kin.write('  What does this say about repair?  ', [{ kind: 'feed', path: '7', label: 'Gold in the cracks' }]);
  kin.write('And the cost?');
  await kin.sync(mac.client);
  let snap = kin.getSnapshot();
  assert.equal(snap.connection, 'offline');
  assert.match(kinStatus(snap)!, /Kin runs on your Mac, which isn’t reachable\. 2 messages wait here/);
  assert.deepEqual(shown(snap).map((s) => s.kind), ['outgoing', 'outgoing']);
  assert.equal(kin.busy, false, 'offline, there is nothing to poll for');

  // Relaunched while away: still waiting, in order.
  const later = new Kin(kv, () => 'unused-id-0000');
  assert.deepEqual(later.getSnapshot().outgoing.map((m) => m.text), ['What does this say about repair?', 'And the cost?']);
  mac.state.away = false;
  await later.sync(mac.client);
  snap = later.getSnapshot();
  assert.deepEqual(snap.outgoing, []);
  assert.deepEqual(snap.entries.map((e) => e.text), ['What does this say about repair?', 'And the cost?']);
  assert.equal(snap.entries[0].chips![0].label, 'Gold in the cracks');
  assert.equal(kinStatus(snap), 'Kin will answer in a moment.');
  assert.equal(later.busy, true);
  assert.equal(activeJobs(snap.jobs)[0].status, 'running');

  // A resend of a message the Mac already has (the reply was lost) lands once.
  kv.setItemSync('kin:waiting', JSON.stringify([{ id: '00000000-0000-4000-8000-000000000001', text: 'What does this say about repair?', chips: [], written: '' }]));
  await new Kin(kv, () => 'x').sync(mac.client);
  assert.equal(mac.state.seq, 2);
});

test('a message the Mac refuses stays, marked, out of the way of the rest', async () => {
  const kv = memory();
  const mac = kinMac();
  let n = 0;
  const kin = new Kin(kv, () => `id-${++n}-0000-0000`);
  kin.write('x'.repeat(60));
  kin.write('Short');
  await kin.sync(mac.client);
  const snap = kin.getSnapshot();
  assert.equal(snap.outgoing.length, 1);
  assert.equal(snap.outgoing[0].error, 'That message is too long.');
  assert.deepEqual(snap.entries.map((e) => e.text), ['Short']);
  kin.discard(snap.outgoing[0].id);
  assert.deepEqual(kin.getSnapshot().outgoing, []);
});

test('an unpaired phone is told so, and keeps its messages', async () => {
  const kv = memory();
  const kin = new Kin(kv, () => 'id-1-0000-0000');
  kin.write('Hello');
  const client: KinClient = {
    kin: async () => ({ entries: [], threads: [], pending: [], running: null }),
    kinJobs: async () => [],
    kinStop: async () => ({}),
    kinSend: async () => {
      throw new Unpaired();
    },
  };
  await assert.rejects(kin.sync(client), Unpaired);
  assert.equal(kin.getSnapshot().outgoing.length, 1);
});
