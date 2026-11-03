import { SIDEBAR_KEYBOARD_SHORTCUT } from "@kintsugi/ui/lib/sidebar";

/** Every app shortcut in one place. The handlers match against these specs
 *  and the hints (hold ⌘, tooltips, menus) print them, so the two can't
 *  drift. The editor's formatting keys live with its keymap
 *  (`formatShortcuts` in @kintsugi/editor) and are listed beside these.
 *
 *  `where` is the screen the shortcut works on, for the list that shows
 *  while ⌘ is held; shortcuts without it only show beside their target. */
export type Where = "anywhere" | "writing" | "settings";
export type Shortcut = { key: string; label: string; where?: Where };

export const SHORTCUTS = {
  newDoc: { key: "Mod-n", label: "New document", where: "anywhere" },
  newFolder: { key: "Mod-Shift-n", label: "New folder", where: "anywhere" },
  find: { key: "Mod-p", label: "Open a document", where: "anywhere" },
  feed: { key: "Mod-Shift-f", label: "Feed", where: "anywhere" },
  inspiration: { key: "Mod-Shift-i", label: "Inspiration", where: "anywhere" },
  ideas: { key: "Mod-Shift-e", label: "Ideas", where: "anywhere" },
  kin: { key: "Mod-j", label: "Kin", where: "anywhere" },
  sidebar: { key: `Mod-${SIDEBAR_KEYBOARD_SHORTCUT}`, label: "Sidebar", where: "anywhere" },
  settings: { key: "Mod-,", label: "Settings", where: "anywhere" },
  openVault: { key: "Mod-Shift-o", label: "Open another vault", where: "anywhere" },

  refine: { key: "Mod-k", label: "Edit with Kin", where: "writing" },
  save: { key: "Mod-s", label: "Save", where: "writing" },
  status: { key: "Mod-Shift-d", label: "Toggle status", where: "writing" },
  publish: { key: "Mod-Shift-p", label: "Publish", where: "writing" },
  export: { key: "Mod-Alt-e", label: "Export", where: "writing" },
  textLarger: { key: "Mod-=", label: "Larger text", where: "writing" },
  textSmaller: { key: "Mod--", label: "Smaller text", where: "writing" },
  textReset: { key: "Mod-0", label: "Actual size", where: "writing" },

  back: { key: "Escape", label: "Back", where: "settings" },
  // Listed with `back`.
  backAlt: { key: "Mod-[", label: "Back" },

  trash: { key: "Mod-Backspace", label: "Move to Trash" },
  kinDev: { key: "Mod-Shift-k", label: "Developer panel" },
} as const satisfies Record<string, Shortcut>;

export type ShortcutId = keyof typeof SHORTCUTS;
