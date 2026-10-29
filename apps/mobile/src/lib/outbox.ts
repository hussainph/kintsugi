import { localStamp, type Remote } from '@kintsugi/core/remote';
import Storage from 'expo-sqlite/kv-store';
import { useSyncExternalStore } from 'react';

/** Captures wait here until the Mac is reachable, so an idea is never lost
 *  to a closed laptop. Written to disk before anything is sent. */
export type Note = { id: string; text: string; capturedAt: string };

const KEY = 'outbox';

function read(): Note[] {
  try {
    return JSON.parse(Storage.getItemSync(KEY) ?? '[]') as Note[];
  } catch {
    return [];
  }
}

let notes = read();
const listeners = new Set<() => void>();

function save(next: Note[]) {
  Storage.setItemSync(KEY, JSON.stringify(next));
  notes = next;
  listeners.forEach((listener) => listener());
}

export function capture(text: string): Note {
  const note = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text, capturedAt: localStamp() };
  save([...notes, note]);
  return note;
}

let sending: Promise<void> | null = null;

/** Sends waiting captures oldest first; stops at the first failure and throws it. */
export function send(client: Remote): Promise<void> {
  sending ??= (async () => {
    try {
      for (const note of notes) {
        await client.capture(note.text, note.capturedAt);
        save(notes.filter((n) => n.id !== note.id));
      }
    } finally {
      sending = null;
    }
  })();
  return sending;
}

export function useOutbox(): Note[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => notes,
  );
}
