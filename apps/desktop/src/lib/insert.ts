import { screenChips } from "./chat";

/** What an edit Kin proposed (KI-79) finds in the open document. */
export type Found = "once" | "missing" | "ambiguous";

/** The open document's "insert at the cursor" and "replace a passage", registered by the editor. */
type Target = {
  path: string;
  insert: (text: string) => void;
  /** Where `passage` is in the document now. */
  find?: (passage: string) => Found;
  /** Replaces `passage` (found once) with `text`, as one undoable change. */
  replace?: (passage: string, text: string) => boolean;
};
let target: Target | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());

/** The editor registers while a writable document is open; the returned
 *  function unregisters it. */
export function registerInsert(path: string, insert: (text: string) => void, edit?: Pick<Target, "find" | "replace">) {
  const mine: Target = { path, insert, ...edit };
  target = mine;
  changed();
  return () => {
    if (target === mine) {
      target = null;
      changed();
    }
  };
}

/** Called when another document registers or the open one goes. */
export function onInsertTarget(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The document an insert would land in, while it's on screen. */
export function insertTarget(): string | null {
  if (!target) return null;
  const path = target.path;
  return screenChips().some((chip) => chip.path === path) ? path : null;
}

/** Inserts `text` at the open document's cursor. False when no document is on screen. */
export function insertIntoDocument(text: string): boolean {
  if (!target || !insertTarget()) return false;
  target.insert(text);
  return true;
}

/** Where `passage` is in `path`, while that document is open; null when it isn't. */
export function findInDocument(path: string, passage: string): Found | null {
  if (!target?.find || insertTarget() !== path) return null;
  return target.find(passage);
}

/** Replaces `passage` with `text` in `path`, while it's open and the passage is there once. */
export function replaceInDocument(path: string, passage: string, text: string): boolean {
  if (!target?.replace || insertTarget() !== path) return false;
  return target.replace(passage, text);
}
