import { invoke } from "@tauri-apps/api/core";
import type { Entry } from "@kintsugi/core/vault";

export * from "@kintsugi/core/vault";

export const vault = {
  current: () => invoke<string>("vault_current"),
  open: (path: string) => invoke<string>("vault_open", { path }),
  tree: () => invoke<Entry[]>("vault_tree"),
  read: (path: string) => invoke<string>("doc_read", { path }),
  write: (path: string, contents: string) => invoke<void>("doc_write", { path, contents }),
  createDoc: (dir: string, title: string) => invoke<string>("doc_create", { dir, title }),
  createFolder: (dir: string, name: string) => invoke<string>("folder_create", { dir, name }),
  rename: (path: string, name: string) => invoke<string>("entry_rename", { path, name }),
  trash: (path: string) => invoke<void>("entry_trash", { path }),
};
