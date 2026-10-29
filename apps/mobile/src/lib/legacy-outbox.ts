import type { ClipCapture } from '@kintsugi/core/clips';

export type Note = { id: string; text: string; capturedAt: string; clip?: ClipCapture; error?: string };
type Storage = { getItemSync(key: string): string | null; setItemSync(key: string, value: string): void };
export const OUTBOX_KEY = 'outbox';

/** One SQLite value write commits the entire legacy migration before any sender
 * sees it. This port also makes recovery/migration testable without a native DB. */
export function loadLegacyOutbox(storage: Storage, uuid: () => string, now = Date.now): {
  notes: Note[]; warning: string | null; blocked: unknown;
} {
  let raw: string | null = null;
  let notes: Note[];
  try {
    raw = storage.getItemSync(OUTBOX_KEY);
    const value: unknown = JSON.parse(raw ?? '[]');
    if (!Array.isArray(value) || value.some((note) => !note || typeof note.id !== 'string' ||
      typeof note.text !== 'string' || typeof note.capturedAt !== 'string' ||
      (note.clip != null && (typeof note.clip !== 'object' || Array.isArray(note.clip))))) {
      throw new Error('The capture outbox could not be read.');
    }
    notes = value as Note[];
  } catch (error) {
    if (raw !== null) {
      try {
        const backup = `${OUTBOX_KEY}.recovery.${now()}`;
        storage.setItemSync(backup, raw);
        storage.setItemSync(OUTBOX_KEY, '[]');
        return { notes: [], blocked: null, warning: `An older outbox could not be read. Its contents are preserved on this phone (${backup}).` };
      } catch { /* Do not overwrite the original if recovery storage fails. */ }
    }
    return { notes: [], blocked: error, warning: 'The phone’s outbox is unavailable. Existing captures are preserved; restart the app to retry.' };
  }

  try {
    let changed = false;
    const migrated = notes.map((note) => {
      if (!note.clip || note.clip.id != null) return note;
      changed = true;
      // Deliberately retain historical error flags: their HTTP status was lost.
      return { ...note, clip: { ...note.clip, id: uuid() } };
    });
    if (changed) storage.setItemSync(OUTBOX_KEY, JSON.stringify(migrated));
    return { notes: migrated, blocked: null, warning: null };
  } catch (error) {
    // A failed migration write is not corrupt capture data. Leave it untouched,
    // and block sending until the UUID can be durably committed.
    return { notes, blocked: error, warning: 'The outbox upgrade couldn’t be saved. Captures are preserved; restart the app to retry.' };
  }
}
