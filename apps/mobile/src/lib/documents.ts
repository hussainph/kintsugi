import Storage from 'expo-sqlite/kv-store';
import { useSyncExternalStore } from 'react';

import { FilterStore } from './browse';
import { Library, type LocalDoc } from './library';

/** The phone's copy of the writing, kept in the app's SQLite key-value store. */
export const library = new Library(Storage);

export function useLibrary() {
  return useSyncExternalStore(library.subscribe, library.getSnapshot);
}

/** Read from the snapshot, not `library.get`: the React Compiler memoizes
 *  calls on a module-level object by their arguments alone. */
export function useDoc(path: string): LocalDoc | null {
  return useLibrary().docs.find((doc) => doc.path === path) ?? null;
}

/** The status and tag filter, shared by the vault list and every folder. */
export const filters = new FilterStore();

export function useFilter() {
  return useSyncExternalStore(filters.subscribe, filters.get);
}
