import Storage from 'expo-sqlite/kv-store';
import { useSyncExternalStore } from 'react';

const NEW_EDITOR = 'settings:new-editor';

const listeners = new Set<() => void>();
let newEditor = Storage.getItemSync(NEW_EDITOR) === '1';

/** KI-36: write in the Mac's CodeMirror editor instead of the plain text
 *  field. Off by default until it has been tried on a real iPhone (see
 *  docs/spikes/ki-28-phone-editor.md, "Device checklist"). */
export function useNewEditor(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => newEditor,
  );
}

export function setNewEditor(on: boolean) {
  newEditor = on;
  Storage.setItemSync(NEW_EDITOR, on ? '1' : '0');
  listeners.forEach((listener) => listener());
}
