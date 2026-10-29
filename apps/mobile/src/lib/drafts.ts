import Storage from 'expo-sqlite/kv-store';

/** Edits the Mac hasn't confirmed yet, kept on the phone until it does.
 *  `base` is the version the edit started from. */
export type Draft = { text: string; base: string };

const key = (path: string) => `draft:${path}`;

export const drafts = {
  get(path: string): Draft | null {
    try {
      const raw = Storage.getItemSync(key(path));
      return raw ? (JSON.parse(raw) as Draft) : null;
    } catch {
      return null;
    }
  },
  set(path: string, draft: Draft) {
    Storage.setItemSync(key(path), JSON.stringify(draft));
  },
  clear(path: string) {
    Storage.removeItemSync(key(path));
  },
};
