import type { ClipCapture } from '@kintsugi/core/clips';
import { HttpError, isPermanentCaptureStatus, localStamp, Offline, type Remote, Unpaired } from '@kintsugi/core/remote';
import { randomUUID } from 'expo-crypto';
import Storage from 'expo-sqlite/kv-store';
import { useSyncExternalStore } from 'react';

import { KintsugiCapture as Capture } from '../../modules/capture';
import { captureURL } from './capture-input';
import { CaptureRetry } from './capture-retry';
import { postClip } from './clip-capture';
import { drainCaptures } from './drain-captures';
import { loadLegacyOutbox, type Note, OUTBOX_KEY } from './legacy-outbox';

export type { Note } from './legacy-outbox';
type Waiting = { id: string; capturedAt: string; error?: string };
const loaded = loadLegacyOutbox(Storage, randomUUID);
export const outboxWarning = loaded.warning;
const storageBlocked = loaded.blocked;
let notes = loaded.notes;
let shared: Waiting[] = [];
let waiting: Waiting[] = notes;
const listeners = new Set<() => void>();
function notify() {
  waiting = [...notes, ...shared];
  listeners.forEach((listener) => listener());
}
function save(next: Note[]) {
  if (storageBlocked) throw storageBlocked;
  Storage.setItemSync(OUTBOX_KEY, JSON.stringify(next));
  notes = next;
  notify();
}

/** Refresh when the app is foregrounded: the extension runs in another process. */
export async function refreshOutbox() {
  if (Capture) shared = JSON.parse(await Capture.pending()) as Waiting[];
  notify();
}

export async function capture(text: string, captureID?: string): Promise<void> {
  const capturedAt = localStamp();
  const url = captureURL(text);
  const clip: ClipCapture | undefined = url ? { id: captureID ?? randomUUID(), url, capturedAt, via: 'phone' } : undefined;
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

const retry = new CaptureRetry();
let sending: Promise<void> | null = null;
/** Sends disk-backed captures oldest first. Failed requests never remove an item.
 * Claims exclude the extension's background uploads and expire after process death. */
export function send(client: Remote, api = 2): Promise<void> {
  sending ??= (async () => {
    try {
      await refreshOutbox();
      const failures: unknown[] = [];
      if (storageBlocked) throw storageBlocked;
      for (const note of notes) {
        if (note.error || !retry.ready(note.id)) continue;
        try {
          if (note.clip && api < 2) continue;
          if (note.clip) await postClip(client, note.clip);
          else await client.capture(note.text, note.capturedAt);
          save(notes.filter((n) => n.id !== note.id));
          retry.clear(note.id);
        } catch (error) {
          if (error instanceof Unpaired) throw error;
          if (note.clip && error instanceof HttpError && isPermanentCaptureStatus(error.status)) {
            save(notes.map((item) => item.id === note.id ? { ...item, error: String(error) } : item));
            retry.clear(note.id);
          } else {
            retry.failed(note.id);
          }
          if (error instanceof Offline) throw error;
          failures.push(error);
        }
      }
      if (Capture && api >= 2) {
        try {
          await drainCaptures(Capture, (payload) => postClip(client, payload), retry);
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
