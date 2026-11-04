import { invoke } from "@tauri-apps/api/core";

/** Mirrors the shared stash sidecar. Kept structural for the editor adapter. */
export type StashAnchor = { exact: string; prefix: string; suffix: string; line: number };
export type StashItem = {
  id: string;
  by: "owner" | "kin";
  kind: "text" | "idea" | "rewrite";
  text: string;
  created: string;
  anchor?: StashAnchor;
};
export type StashFile = { path: string; items: StashItem[] };
export const STASH_CHANGED = "stash:changed";

export type StashApi = {
  load: (path: string) => Promise<StashFile>;
  /** Compare-and-save against the exact list read before this mutation. */
  save: (path: string, items: StashItem[], base?: StashItem[]) => Promise<unknown>;
  dismiss: (path: string, id: string) => Promise<unknown>;
  ask: (path: string, text?: string) => Promise<unknown>;
};

/** Every queued command carries its vault identity. Even an unmounted
 * editor cannot send an old document's save into a newly opened vault. */
export function stashForRoot(expectedRoot: string): StashApi {
  return {
    load: (path) => invoke<StashFile>("stash_load", { path, expectedRoot }),
    save: (path, items, base) => invoke("stash_save", { path, items, base, expectedRoot }),
    dismiss: (path, id) => invoke("stash_dismiss", { path, id, expectedRoot }),
    ask: (path, text) => invoke("stash_ask", { path, text, expectedRoot }),
  };
}
