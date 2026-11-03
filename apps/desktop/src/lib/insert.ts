import { screenChips } from "./chat";

/** The open document's "insert at the cursor", registered by the editor. */
type Target = { path: string; insert: (text: string) => void };
let target: Target | null = null;

/** The editor registers while a writable document is open; the returned
 *  function unregisters it. */
export function registerInsert(path: string, insert: (text: string) => void) {
  const mine: Target = { path, insert };
  target = mine;
  return () => {
    if (target === mine) target = null;
  };
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
