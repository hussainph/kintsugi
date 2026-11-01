import { merge3 } from "@kintsugi/core/merge";

/**
 * What to do when another app (Obsidian, git, iCloud, another editor)
 * changed or removed a document open here, the way the phone resolves the
 * Mac's edits (apps/mobile/src/lib/library.ts):
 *
 * - `none`: the disk has what the editor last had; nothing happened.
 * - `reload`: nothing unsaved here, so show the disk's text quietly.
 * - `merged`: both changed, on different lines; show and save `text`.
 * - `gone`: removed with nothing unsaved here; close it.
 * - `collision`: both changed the same lines, or it was removed while
 *   changed here. Only then is the writer asked.
 *
 * `base` is the text the editor last had from disk, `mine` the editor's text
 * now and `disk` the file's text (null when it no longer exists).
 */
export type Decision =
  | { kind: "none" }
  | { kind: "reload"; text: string }
  | { kind: "merged"; text: string }
  | { kind: "gone" }
  | { kind: "collision"; disk: string | null };

export function decide(base: string | undefined, mine: string, disk: string | null): Decision {
  if (disk === null) return mine === base ? { kind: "gone" } : { kind: "collision", disk };
  if (disk === base) return { kind: "none" };
  if (mine === disk || mine === base) return { kind: "reload", text: disk };
  if (base === undefined) return { kind: "collision", disk };
  const merged = merge3(base, mine, disk);
  if (!merged.clean) return { kind: "collision", disk };
  return merged.text === disk ? { kind: "reload", text: disk } : { kind: "merged", text: merged.text };
}

/** Whether removing `gone` (a document or a folder) removed `path`. */
export const removes = (gone: string, path: string) => path === gone || path.startsWith(`${gone}/`);
