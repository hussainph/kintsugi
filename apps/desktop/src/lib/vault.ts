import { invoke } from "@tauri-apps/api/core";
import type { Versioned } from "@kintsugi/core/remote";
import type { Entry } from "@kintsugi/core/vault";

export * from "@kintsugi/core/vault";

/** Mirrors `kintsugi_vault::Write`: `conflict` and `gone` wrote nothing. */
export type Written = { result: "saved"; version: string } | { result: "conflict"; current: Versioned } | { result: "gone" };

/** Mirrors `watch::Outside`: documents changed by another app, with their
 *  text on disk, and paths (documents or folders) it removed. */
export type Outside = { docs: { path: string; text: string }[]; gone: string[] };

export const vault = {
  current: () => invoke<string>("vault_current"),
  open: (path: string) => invoke<string>("vault_open", { path }),
  tree: () => invoke<Entry[]>("vault_tree"),
  read: (path: string) => invoke<string>("doc_read", { path }),
  /** `base` is the version the editor last had from disk; null writes regardless. */
  write: (path: string, contents: string, base: string | null) => invoke<Written>("doc_write", { path, contents, base }),
  createDoc: (dir: string, title: string) => invoke<string>("doc_create", { dir, title }),
  createFolder: (dir: string, name: string) => invoke<string>("folder_create", { dir, name }),
  rename: (path: string, name: string) => invoke<string>("entry_rename", { path, name }),
  trash: (path: string) => invoke<void>("entry_trash", { path }),
};
