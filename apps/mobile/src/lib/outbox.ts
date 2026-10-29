import { localStamp, Offline, type Pairing, type Remote, Unpaired } from '@kintsugi/core/remote';
import Storage from 'expo-sqlite/kv-store';
import { useSyncExternalStore } from 'react';

import { KintsugiCapture as Capture } from '../../modules/capture';
import { captureURL } from './capture-input';
import { type ClipCapture, postClip } from './clip-capture';
import { type CaptureRetries, drainCaptures } from './drain-captures';

/** Legacy inbox notes remain valid. Only URLs go to the inspiration API. */
export type Note = { id: string; text: string; capturedAt: string; clip?: ClipCapture };
type Waiting = { id: string; capturedAt: string };
const KEY = 'outbox';

export let outboxWarning: string | null = null;
let storageBlocked: unknown = null;
function read(): Note[] {
  let raw: string | null = null;
  try {
    raw = Storage.getItemSync(KEY);
    const value: unknown = JSON.parse(raw ?? '[]');
    if (!Array.isArray(value) || value.some((note) => !note || typeof note.id !== 'string' ||
      typeof note.text !== 'string' || typeof note.capturedAt !== 'string')) {
      throw new Error('The capture outbox could not be read.');
    }
    return value as Note[];
  } catch (error) {
    if (raw !== null) {
      try {
        // Quarantine before resetting: keep the exact bytes for recovery.
        const backup = `${KEY}.recovery.${Date.now()}`;
        Storage.setItemSync(backup, raw);
        Storage.setItemSync(KEY, '[]');
        outboxWarning = `An older outbox could not be read. Its contents are preserved on this phone (${backup}).`;
        return [];
      } catch { /* Storage itself failed: never overwrite the original queue. */ }
    }
    storageBlocked = error;
    outboxWarning = 'The phone’s outbox is unavailable. Existing captures are preserved; restart the app to retry.';
    return [];
  }
}

let notes = read();
let shared: Waiting[] = [];
let waiting: Waiting[] = notes;
const listeners = new Set<() => void>();
function notify() {
  waiting = [...notes, ...shared];
  listeners.forEach((listener) => listener());
}
function save(next: Note[]) {
  if (storageBlocked) throw storageBlocked;
  Storage.setItemSync(KEY, JSON.stringify(next));
  notes = next;
  notify();
}

/** Refresh when the app is foregrounded: the extension runs in another process. */
export async function refreshOutbox() {
  if (Capture) shared = JSON.parse(await Capture.pending()) as Waiting[];
  notify();
}

export async function capture(text: string): Promise<void> {
  const capturedAt = localStamp();
  const url = captureURL(text);
  const clip: ClipCapture | undefined = url ? { url, capturedAt, via: 'phone' } : undefined;
  if (clip && Capture) {
    const id = await Capture.enqueue(JSON.stringify(clip));
    // The write has succeeded. A later listing failure must not make Save
    // look like it failed and invite the writer to enqueue the same URL twice.
    shared = [...shared, { id, capturedAt }];
    notify();
  } else {
    save([...notes, { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text, capturedAt, clip }]);
  }
}

const clipRetries: CaptureRetries = new Map();
let retryPairing: Pairing | null = null;
let sending: Promise<void> | null = null;
/** Sends disk-backed captures oldest first. Failed requests never remove an item.
 * Claims exclude the extension's background uploads and expire after process death. */
export function send(client: Remote, pairing: Pairing, api = 2): Promise<void> {
  if (retryPairing !== pairing) {
    clipRetries.clear();
    retryPairing = pairing;
  }
  sending ??= (async () => {
    try {
      await refreshOutbox();
      const failures: unknown[] = [];
      for (const note of notes) {
        try {
          if (note.clip && api < 2) continue;
          if (note.clip) await postClip(pairing, note.clip);
          else await client.capture(note.text, note.capturedAt);
          save(notes.filter((n) => n.id !== note.id));
        } catch (error) {
          if (error instanceof Offline || error instanceof Unpaired) throw error;
          failures.push(error);
        }
      }
      if (Capture && api >= 2) {
        try {
          await drainCaptures(Capture, (payload) => postClip(pairing, payload), clipRetries);
        } catch (error) {
          if (error instanceof Offline || error instanceof Unpaired) throw error;
          failures.push(error);
        }
      }
      if (failures.length) throw new AggregateError(failures, `Some captures are still waiting. ${String(failures[0])}`);
    } finally {
      sending = null;
      // A listing failure must not replace the original Offline/Unpaired error.
      refreshOutbox().catch(() => {});
    }
  })();
  return sending;
}

export function useOutbox(): Waiting[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => waiting,
  );
}
