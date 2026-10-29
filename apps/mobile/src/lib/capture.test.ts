import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Offline, remote } from '@kintsugi/core/remote';

import { captureURL } from './capture-input.ts';
import { postClip } from './clip-capture.ts';
import { type CaptureQueue, drainCaptures } from './drain-captures.ts';

const payload = { url: 'https://example.com/', capturedAt: '2026-10-29T10:30', via: 'share' as const };

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
    if (capture.text === 'rejected') throw new Error('too large');
  }), /too large/);
  assert.equal(attempts, 2);
  assert.equal(events.includes('ack:rejected'), false);
  assert.equal(events.includes('ack:valid'), true);
  assert.equal(events.includes('release:rejected'), true);
});

test('a rejected capture is kept without automatic retries', async () => {
  const { port, events } = queue();
  let attempts = 0;
  const reject = async () => { attempts++; throw new Error('rejected'); };
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
