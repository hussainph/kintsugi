/** A folder's colour and icon (KI-75). Kept in the vault at
 *  `.kintsugi/folders.json` so every device shows the same ones; mirrors
 *  `crates/vault/src/folders.rs`. Colours and icons are stable keys: each app
 *  maps them to its own palette and icon pack. */

export const FOLDER_COLORS = ["red", "amber", "green", "sage", "sand", "lavender"] as const;
export type FolderColor = (typeof FOLDER_COLORS)[number];

export const FOLDER_ICONS = [
  "folder", "inbox", "pen", "note", "book", "bulb", "star", "heart",
  "quote", "image", "code", "globe", "music", "camera", "briefcase", "archive",
] as const;
export type FolderIcon = (typeof FOLDER_ICONS)[number];

export type FolderStyle = { color?: string; icon?: string };
/** By vault-relative folder path. */
export type FolderStyles = Record<string, FolderStyle>;

export const isFolderColor = (value: unknown): value is FolderColor =>
  (FOLDER_COLORS as readonly unknown[]).includes(value);
export const isFolderIcon = (value: unknown): value is FolderIcon =>
  (FOLDER_ICONS as readonly unknown[]).includes(value);

/** Where `path` can be dropped: into a folder other than its own, and never
 *  a folder into itself or one of its own subfolders. */
export function canMove(path: string, dir: string): boolean {
  if (!path || path === dir || dir.startsWith(path + "/")) return false;
  const parent = path.slice(0, Math.max(0, path.lastIndexOf("/")));
  return parent !== dir;
}
