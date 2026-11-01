import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpError, Offline, remote } from '@kintsugi/core/remote';
import { randomUUID } from 'node:crypto';

import { captureBook, captureTarget, captureURL } from './capture-input.ts';
import { CaptureRetry } from './capture-retry.ts';
import { loadLegacyOutbox, OUTBOX_KEY } from './legacy-outbox.ts';
import { postClip } from './clip-capture.ts';
import { type CaptureQueue, drainCaptures, heldForMacUpdate, macAccepts } from './drain-captures.ts';

const payload = { id: '9ea47ca4-bc24-431c-bfca-6975af53c15d', url: 'https://example.com/', capturedAt: '2026-10-29T10:30', via: 'share' as const };

test('only a complete pasted web URL becomes a phone clip', () => {
  assert.equal(captureURL(' https://example.com/a?q=hi#part\n'), 'https://example.com/a?q=hi#part');
  assert.equal(captureURL('HTTP://example.com'), 'http://example.com/');
  for (const value of ['a passing thought', 'see https://example.com', 'file:///secret', 'javascript:alert(1)', 'https://', 'https://a b']) {
    assert.equal(captureURL(value), null);
  }
});

test('clip transport matches the spec and requires confirmation', async () => {
  const client = remote({ url: 'https://mac.example', token: 'test-token' });
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (input, init) => {
      assert.equal(input, 'https://mac.example/v1/clips');
      assert.equal(init?.method, 'POST');
      assert.deepEqual(init?.headers, { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' });
      assert.deepEqual(JSON.parse(init?.body as string), payload);
      return Response.json({ path: 'inspiration/example.md' });
    };
    assert.deepEqual(await postClip(client, payload), { path: 'inspiration/example.md' });
    for (const status of [401, 413, 500, 502, 504]) {
      globalThis.fetch = async () => Response.json({ error: 'failed' }, { status });
      await assert.rejects(postClip(client, payload));
    }
    globalThis.fetch = async () => Response.json({});
    await assert.rejects(postClip(client, payload), /confirm/);
    globalThis.fetch = async () => { throw new Error('offline'); };
    await assert.rejects(postClip(client, payload), /reachable/);
  } finally { globalThis.fetch = original; }
});

function queue(): { port: CaptureQueue; events: string[] } {
  const events: string[] = [];
  const rejected = new Set<string>();
  return {
    events,
    port: {
      pending: async () => JSON.stringify([{ id: 'uploading' }, { id: 'waiting', error: rejected.has('waiting') ? 'rejected' : undefined }]),
      claim: async (id) => { events.push(`claim:${id}`); return id !== 'uploading'; },
      read: async (id) => { events.push(`read:${id}`); return JSON.stringify(payload); },
      acknowledge: async (id) => { events.push(`ack:${id}`); },
      release: async (id) => { events.push(`release:${id}`); },
      reject: async (id) => { rejected.add(id); events.push(`reject:${id}`); },
    },
  };
}

test('shared outbox skips live extension claims; deletes only after delivery', async () => {
  const { port, events } = queue();
  await drainCaptures(port, async (capture) => { assert.deepEqual(capture, payload); events.push('deliver'); });
  assert.deepEqual(events, ['claim:uploading', 'claim:waiting', 'read:waiting', 'deliver', 'ack:waiting', 'release:waiting']);
});

test('offline/rejected delivery releases claim but never removes capture', async () => {
  const { port, events } = queue();
  await assert.rejects(drainCaptures(port, async () => { throw new Offline(); }), /reachable/);
  assert.deepEqual(events, ['claim:uploading', 'claim:waiting', 'read:waiting', 'release:waiting']);
});

test('one rejected payload does not strand later valid captures', async () => {
  const { port, events } = queue();
  port.pending = async () => JSON.stringify([{ id: 'rejected' }, { id: 'valid' }]);
  port.read = async (id) => JSON.stringify({ ...payload, text: id });
  let attempts = 0;
  await assert.rejects(drainCaptures(port, async (capture) => {
    attempts++;
    if (capture.text === 'rejected') throw new HttpError(413, 'too large');
  }), /too large/);
  assert.equal(attempts, 2);
  assert.equal(events.includes('ack:rejected'), false);
  assert.equal(events.includes('ack:valid'), true);
  assert.equal(events.includes('release:rejected'), true);
});

test('a rejected capture is kept without automatic retries', async () => {
  const { port, events } = queue();
  let attempts = 0;
  const reject = async () => { attempts++; throw new HttpError(422, 'rejected'); };
  await assert.rejects(drainCaptures(port, reject));
  await drainCaptures(port, reject);
  assert.equal(attempts, 1);
  assert.equal(events.includes('reject:waiting'), true);
  assert.equal(events.includes('ack:waiting'), false);
});

test('unreadable payload stays on disk for recovery, with its claim released', async () => {
  const { port, events } = queue();
  port.read = async () => 'broken';
  await assert.rejects(drainCaptures(port, async () => assert.fail('must not send')));
  assert.equal(events.at(-1), 'release:waiting');
  assert.equal(events.some((event) => event.startsWith('ack:')), false);
});

function memoryStorage(raw: string | null) {
  const data = new Map<string, string>(raw === null ? [] : [[OUTBOX_KEY, raw]]);
  return {
    data,
    getItemSync: (key: string) => data.get(key) ?? null,
    setItemSync: (key: string, value: string) => { data.set(key, value); },
  };
}

test('legacy URL migration persists one UUID before send; queue IDs, text notes and historical errors stay intact', () => {
  const { id: _id, ...legacyClip } = payload;
  const original = [
    { id: 'sortable-non-uuid', text: payload.url, capturedAt: payload.capturedAt, clip: legacyClip, error: 'historical generic failure' },
    { id: 'plain-note', text: 'An idea', capturedAt: payload.capturedAt },
    { id: 'already-migrated', text: payload.url, capturedAt: payload.capturedAt, clip: payload },
  ];
  const store = memoryStorage(JSON.stringify(original));
  let generated = 0;
  const uuid = () => { generated++; return randomUUID(); };
  const first = loadLegacyOutbox(store, uuid);
  assert.equal(first.blocked, null);
  assert.equal(generated, 1);
  assert.match(first.notes[0].clip!.id!, /^[a-f0-9-]{36}$/);
  assert.notEqual(first.notes[0].clip!.id, first.notes[0].id);
  assert.equal(first.notes[0].error, original[0].error);
  assert.deepEqual(first.notes[1], original[1]);
  assert.equal(first.notes[2].clip!.id, payload.id);
  const reopened = loadLegacyOutbox(store, uuid);
  assert.deepEqual(reopened.notes, first.notes);
  assert.equal(generated, 1);
  assert.deepEqual(JSON.parse(store.data.get(OUTBOX_KEY)!), first.notes);
});

test('a migration storage failure blocks sending without quarantining valid data or clearing rejection flags', () => {
  const { id: _id, ...legacyClip } = payload;
  const raw = JSON.stringify([{ id: 'old', text: payload.url, capturedAt: payload.capturedAt, clip: legacyClip }]);
  const store = memoryStorage(raw);
  store.setItemSync = () => { throw new Error('disk full'); };
  const result = loadLegacyOutbox(store, randomUUID);
  assert(result.blocked);
  assert.equal(store.data.get(OUTBOX_KEY), raw);
  assert.equal(store.data.size, 1);
});

for (const status of [400, 413, 422, 500, 503, 408, 429]) {
  test(`HTTP ${status}: only permanent capture statuses persist rejection`, async () => {
    const { port, events } = queue();
    let time = 0;
    const retry = new CaptureRetry(() => time);
    const permanent = [400, 413, 422].includes(status);
    await assert.rejects(drainCaptures(port, async () => { throw new HttpError(status); }, retry));
    assert.equal(events.includes('reject:waiting'), permanent);
    assert.equal(events.includes('ack:waiting'), false);
    assert.equal(events.includes('release:waiting'), true);
    let attempts = 0;
    await drainCaptures(port, async () => { attempts++; }, retry);
    assert.equal(attempts, 0, 'terminal capture stays paused; transient capture backs off');
    time = 30_000;
    await drainCaptures(port, async (capture) => { attempts++; assert.equal(capture.id, payload.id); }, retry);
    assert.equal(attempts, permanent ? 0 : 1);
  });
}

test('lost-response retry and retry after trash reuse the persisted ID, with one fixture clip/event', async () => {
  const original = globalThis.fetch;
  const client = remote({ url: 'https://mac.example', token: 'test-token' });
  const receipts = new Map<string, string>();
  const clips = new Set<string>();
  const seen: string[] = [];
  let events = 0, loseResponse = true, time = 0;
  const fixturePath = 'inspiration/example.md';
  try {
    globalThis.fetch = async (_input, init) => {
      const capture = JSON.parse(init!.body as string) as typeof payload;
      seen.push(capture.id);
      let path = receipts.get(capture.id);
      if (!path) {
        path = fixturePath;
        receipts.set(capture.id, path);
        clips.add(path);
        events++;
      }
      if (loseResponse) { loseResponse = false; throw new Error('response lost after commit'); }
      return Response.json({ path });
    };
    const { port, events: queueEvents } = queue();
    const retry = new CaptureRetry(() => time);
    await assert.rejects(drainCaptures(port, (capture) => postClip(client, capture), retry), Offline);
    assert.equal(queueEvents.includes('reject:waiting'), false);
    assert.equal(queueEvents.includes('ack:waiting'), false);
    assert.equal(clips.size, 1);
    assert.equal(events, 1);
    time = 30_000;
    // Reopened/native-to-JS handoff reads the same serialized payload, not a new id.
    port.read = async () => JSON.stringify(JSON.parse(JSON.stringify(payload)));
    await drainCaptures(port, (capture) => postClip(client, capture), retry);
    assert.equal(queueEvents.includes('ack:waiting'), true);
    clips.delete(fixturePath); // server receipts deliberately outlive trash
    assert.deepEqual(await postClip(client, payload), { path: fixturePath });
    assert.equal(clips.size, 0, 'retry must not resurrect trashed clip');
    assert.equal(events, 1);
    assert.deepEqual(seen, [payload.id, payload.id, payload.id]);
  } finally { globalThis.fetch = original; }
});

test('malformed 2xx acknowledgement stays retryable with the same persisted UUID', async () => {
  const original = globalThis.fetch;
  const client = remote({ url: 'https://mac.example', token: 'test-token' });
  const { port, events } = queue();
  let time = 0;
  const retry = new CaptureRetry(() => time);
  try {
    globalThis.fetch = async () => Response.json({});
    await assert.rejects(drainCaptures(port, (capture) => postClip(client, capture), retry), /confirm/);
    assert.equal(events.includes('reject:waiting'), false);
    assert.equal(events.includes('ack:waiting'), false);
    time = 30_000;
    globalThis.fetch = async (_input, init) => {
      assert.equal(JSON.parse(init!.body as string).id, payload.id);
      return Response.json({ path: 'inspiration/example.md' });
    };
    await drainCaptures(port, (capture) => postClip(client, capture), retry);
    assert.equal(events.includes('ack:waiting'), true);
  } finally { globalThis.fetch = original; }
});

test('a bare ISBN in the capture box becomes an Open Library book clip', () => {
  for (const [input, isbn] of [
    ['9780306406157', '9780306406157'],
    [' 978-0-306-40615-7\n', '9780306406157'],
    ['ISBN 0-8044-2957-X', '080442957X'],
    ['isbn: 0306406152', '0306406152'],
  ]) {
    assert.equal(captureBook(input), `https://openlibrary.org/isbn/${isbn}`);
    assert.deepEqual(captureTarget(input), { url: `https://openlibrary.org/isbn/${isbn}`, kind: 'book' });
  }
  // A wrong check digit, an ISBN inside prose, or a plain number stays a note.
  for (const value of ['9780306406158', 'read 9780306406157 tonight', '12345', '2026']) {
    assert.equal(captureTarget(value), null, value);
  }
  assert.deepEqual(captureTarget('https://example.com/'), { url: 'https://example.com/', kind: 'link' });
});

const document = {
  id: '3b241101-e2bb-4255-8caf-4136c566a962', file: 'JVBERi0xLjcK', fileType: 'application/pdf',
  fileName: 'Paper.pdf', note: 'chapter 3', capturedAt: '2026-10-29T10:31', via: 'share' as const,
};

function fileQueue(items: { id: string; file?: boolean; error?: string }[], payloads: Record<string, object>) {
  const events: string[] = [];
  const port: CaptureQueue = {
    pending: async () => JSON.stringify(items),
    claim: async (id) => { events.push(`claim:${id}`); return true; },
    read: async (id) => { events.push(`read:${id}`); return JSON.stringify(payloads[id]); },
    acknowledge: async (id) => { events.push(`ack:${id}`); },
    release: async (id) => { events.push(`release:${id}`); },
    reject: async (id) => { events.push(`reject:${id}`); },
  };
  return { port, events };
}

test('a PDF capture is delivered like an image capture once the Mac takes files', async () => {
  const original = globalThis.fetch;
  const client = remote({ url: 'https://mac.example', token: 'test-token' });
  const { port, events } = fileQueue([{ id: 'pdf', file: true }], { pdf: document });
  try {
    globalThis.fetch = async (input, init) => {
      assert.equal(input, 'https://mac.example/v1/clips');
      assert.deepEqual(JSON.parse(init?.body as string), document);
      return Response.json({ path: 'inspiration/paper.md' });
    };
    await drainCaptures(port, (capture) => postClip(client, capture), undefined, 4);
    assert.deepEqual(events, ['claim:pdf', 'read:pdf', 'ack:pdf', 'release:pdf']);
  } finally { globalThis.fetch = original; }
});

test('the same file capture rejected by the Mac (413) is kept, not deleted', async () => {
  const { port, events } = fileQueue([{ id: 'pdf', file: true }], { pdf: document });
  await assert.rejects(drainCaptures(port, async () => { throw new HttpError(413, 'too large'); }, undefined, 4));
  assert.deepEqual(events, ['claim:pdf', 'read:pdf', 'reject:pdf', 'release:pdf']);
});

for (const api of [0, 2, 3]) {
  test(`a Mac at API ${api} gets other captures; files stay queued, unrejected`, async () => {
    const { port, events } = fileQueue(
      [{ id: 'listed', file: true }, { id: 'unlisted' }, { id: 'link' }],
      { listed: document, unlisted: { ...document, id: randomUUID() }, link: payload },
    );
    const delivered: unknown[] = [];
    await drainCaptures(port, async (capture) => { delivered.push(capture); }, new CaptureRetry(), api);
    assert.deepEqual(delivered, [payload]);
    // A flagged file isn't even claimed or read (its payload can be 67 MB).
    assert.equal(events.some((event) => event.endsWith(':listed')), false);
    // One the listing didn't flag is checked after reading, then released as is.
    assert.deepEqual(events.filter((event) => event.endsWith(':unlisted')), ['claim:unlisted', 'read:unlisted', 'release:unlisted']);
    assert.equal(events.some((event) => event.startsWith('reject:') || event === 'ack:listed' || event === 'ack:unlisted'), false);
  });
}

test('the API gate: files need hello.api 4; the update note counts only held files', () => {
  assert.equal(macAccepts(document, 3), false);
  assert.equal(macAccepts(document, 4), true);
  assert.equal(macAccepts(payload, 2), true);
  const items = [{ id: 'a', file: true }, { id: 'b' }, { id: 'c', file: true, error: 'rejected' }];
  assert.deepEqual(heldForMacUpdate(items, 3).map((item) => item.id), ['a']);
  assert.deepEqual(heldForMacUpdate(items, 4), []);
  assert.deepEqual(heldForMacUpdate(items, 0), [], 'unknown until the Mac answers hello');
});
