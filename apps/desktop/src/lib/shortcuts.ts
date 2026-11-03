import { formatShortcuts } from "@kintsugi/editor/format";
import { keysOf } from "@kintsugi/editor/keys";
import { SIDEBAR_KEYBOARD_SHORTCUT } from "@kintsugi/ui/lib/sidebar";

/** Every shortcut in one place. The handlers match against these specs, the
 *  hints (hold ⌘, tooltips, menus) and the shortcuts list (⇧⌘/) print them,
 *  and README's table is generated from them (`pnpm shortcuts:readme`), so
 *  none of them can drift. The editor's formatting keys live with its keymap
 *  (`formatShortcuts` in @kintsugi/editor) and are listed with these.
 *
 *  `where` is the screen the shortcut works on, for the list that shows
 *  while ⌘ is held; shortcuts without it only show beside their target.
 *  `group` puts it in the shortcuts list and README; leave it out to keep a
 *  key off both (the developer panel, the keys reserved below).
 *
 *  To add a key: add it here with its group, run the tests (they fail on a
 *  key that's already taken, CodeMirror's and the Mac's own keys included),
 *  then `pnpm shortcuts:readme`. */
export type Where = "anywhere" | "writing" | "settings";

/** Where a key is handled, for the conflict test: `app` is the app's
 *  capture-phase handler (anywhere), `writing` the same while a document is
 *  open, `editor` CodeMirror's keymap, `refine` ⌘K once it shows an edit,
 *  `system` the Mac and the app menu. */
export type Scope = "app" | "writing" | "editor" | "refine" | "sidebar" | "settings" | "system";

export const GROUPS = {
  app: { title: "App", scope: "app" },
  document: { title: "Document", scope: "writing" },
  kin: { title: "Kin", scope: "writing" },
  alternatives: { title: "Alternatives", scope: "editor" },
  formatting: { title: "Formatting", scope: "editor" },
  text: { title: "Text", scope: "editor" },
  review: { title: "Reviewing an edit", scope: "refine" },
  sidebar: { title: "Sidebar", scope: "sidebar" },
  settings: { title: "Settings", scope: "settings" },
} as const satisfies Record<string, { title: string; scope: Scope }>;

export type Group = keyof typeof GROUPS;

export type Shortcut = {
  key: string;
  label: string;
  where?: Where;
  group?: Group;
  /** Overrides the group's scope. */
  scope?: Scope;
  /** CodeMirror's own binding, listed so it's in the list: the test checks
   *  it's still in the editor's keymap rather than calling it a clash. */
  builtin?: true;
  /** Typed, not pressed (`/`, `[[`): shown as is and never a clash. */
  typed?: true;
  /** How the key reads when its spec can't say it ("1–6"). */
  shows?: string;
  /** Kept for the ticket that adds it: in the conflict test, nowhere else. */
  soon?: string;
};

export const SHORTCUTS = {
  newDoc: { key: "Mod-n", label: "New document", where: "anywhere", group: "app" },
  newFolder: { key: "Mod-Shift-n", label: "New folder", where: "anywhere", group: "app" },
  find: { key: "Mod-p", label: "Open a document", where: "anywhere", group: "app" },
  feed: { key: "Mod-Shift-f", label: "Feed", where: "anywhere", group: "app" },
  inspiration: { key: "Mod-Shift-i", label: "Inspiration", where: "anywhere", group: "app" },
  ideas: { key: "Mod-Shift-e", label: "Ideas", where: "anywhere", group: "app" },
  kin: { key: "Mod-j", label: "Kin", where: "anywhere", group: "app" },
  sidebar: { key: `Mod-${SIDEBAR_KEYBOARD_SHORTCUT}`, label: "Sidebar", where: "anywhere", group: "app" },
  settings: { key: "Mod-,", label: "Settings", where: "anywhere", group: "app" },
  openVault: { key: "Mod-Shift-o", label: "Open another vault", where: "anywhere", group: "app" },
  // The Mac's Help shortcut.
  shortcuts: { key: "Mod-Shift-/", label: "Keyboard shortcuts", where: "anywhere", group: "app" },

  save: { key: "Mod-s", label: "Save", where: "writing", group: "document" },
  status: { key: "Mod-Shift-d", label: "Toggle status", where: "writing", group: "document" },
  publish: { key: "Mod-Shift-p", label: "Publish", where: "writing", group: "document" },
  export: { key: "Mod-Alt-e", label: "Export", where: "writing", group: "document" },
  textLarger: { key: "Mod-=", label: "Larger text", where: "writing", group: "document" },
  textSmaller: { key: "Mod--", label: "Smaller text", where: "writing", group: "document" },
  textReset: { key: "Mod-0", label: "Actual size", where: "writing", group: "document" },

  // ⌘K's edits run straight away on the selection (else the paragraph).
  refine: { key: "Mod-k", label: "Edit with Kin", where: "writing", group: "kin" },
  tighten: { key: "Mod-Alt-t", label: "Tighten", where: "writing", group: "kin" },
  rephrase: { key: "Mod-Alt-r", label: "Rephrase", where: "writing", group: "kin" },
  simplify: { key: "Mod-Alt-p", label: "Simplify", where: "writing", group: "kin" },
  fix: { key: "Mod-Alt-f", label: "Fix grammar and spelling", where: "writing", group: "kin" },
  synonyms: { key: "Mod-Alt-s", label: "Synonyms", where: "writing", group: "kin" },
  selectionMenu: { key: "Shift-F10", label: "Selection menu", where: "writing", group: "kin", scope: "editor" },

  slash: { key: "/", label: "Insert a block", group: "formatting", typed: true },
  mention: { key: "@", label: "Link a document or clip", group: "formatting", typed: true },
  wikilink: { key: "[[", label: "Link a document or clip", group: "formatting", typed: true },

  cut: { key: "Mod-x", label: "Cut", group: "text", scope: "system" },
  copy: { key: "Mod-c", label: "Copy", group: "text", scope: "system" },
  paste: { key: "Mod-v", label: "Paste", group: "text", scope: "system" },
  undo: { key: "Mod-z", label: "Undo", group: "text", builtin: true },
  redo: { key: "Mod-Shift-z", label: "Redo", group: "text", builtin: true },
  findText: { key: "Mod-f", label: "Find", group: "text", builtin: true },
  findNext: { key: "Mod-g", label: "Find next", group: "text", builtin: true },
  findPrevious: { key: "Mod-Shift-g", label: "Find previous", group: "text", builtin: true },
  selectNext: { key: "Mod-d", label: "Select next match", group: "text", builtin: true },
  selectMatches: { key: "Mod-Shift-l", label: "Select all matches", group: "text", builtin: true },
  moveLineUp: { key: "Alt-ArrowUp", label: "Move line up", group: "text", builtin: true },
  moveLineDown: { key: "Alt-ArrowDown", label: "Move line down", group: "text", builtin: true },
  gotoLine: { key: "Mod-Alt-g", label: "Go to line", group: "text", builtin: true },

  accept: { key: "Enter", label: "Accept", group: "review" },
  another: { key: "Mod-r", label: "Another version", group: "review" },
  previousVersion: { key: "ArrowLeft", label: "Previous version", group: "review" },
  nextVersion: { key: "ArrowRight", label: "Next version", group: "review" },
  pick: { key: "1", label: "Pick a synonym", group: "review", shows: "1–6" },
  backToList: { key: "Backspace", label: "Back to the list", group: "review" },
  discard: { key: "Escape", label: "Discard", group: "review" },

  rename: { key: "F2", label: "Rename", group: "sidebar" },
  trash: { key: "Mod-Backspace", label: "Move to Trash", group: "sidebar" },

  back: { key: "Escape", label: "Back", where: "settings", group: "settings" },
  // Listed with `back`.
  backAlt: { key: "Mod-[", label: "Back", group: "settings" },

  kinDev: { key: "Mod-Shift-k", label: "Developer panel", scope: "app" },

  // The editor's alternatives keymap (`alternativeShortcuts` in
  // @kintsugi/editor/alternatives); a test keeps the two the same.
  alternatives: { key: "Mod-Alt-a", label: "Alternatives", group: "alternatives" },
  nextAlternative: { key: "Mod-Alt-]", label: "Next alternative", group: "alternatives" },
  previousAlternative: { key: "Mod-Alt-[", label: "Previous alternative", group: "alternatives" },

  // Reserved for the tickets that add them (Write_On's alternative control).
  kinAlternatives: { key: "Mod-Shift-Alt-a", label: "Kin's alternatives", scope: "editor", soon: "KI-87" },
  refineAlternatives: { key: "Shift-Enter", label: "Keep as alternatives", scope: "refine", soon: "KI-87" },
  stash: { key: "Mod-Alt-x", label: "Stash", scope: "editor", soon: "KI-89" },
  unstash: { key: "Mod-Alt-v", label: "Put back from stash", scope: "editor", soon: "KI-89" },
} as const satisfies Record<string, Shortcut>;

export type ShortcutId = keyof typeof SHORTCUTS;

/** ⌘K's edits that have a key of their own, by their action id in
 *  `refine/prompts.ts`. */
export const EDIT_KEYS = {
  tighten: "tighten",
  rephrase: "rephrase",
  simplify: "simplify",
  fix: "fix",
  synonyms: "synonyms",
} as const satisfies Record<string, ShortcutId>;

/** Keys the Mac or the app menu already answer, so nothing here may use
 *  them. Never listed. */
export const SYSTEM: Shortcut[] = [
  { key: "Mod-q", label: "Quit" },
  { key: "Mod-h", label: "Hide" },
  { key: "Mod-Alt-h", label: "Hide others" },
  { key: "Mod-m", label: "Minimize" },
  { key: "Mod-Alt-m", label: "Minimize all" },
  { key: "Mod-w", label: "Close window" },
  { key: "Mod-Alt-w", label: "Close all windows" },
  { key: "Ctrl-Mod-f", label: "Full screen" },
  { key: "Mod-a", label: "Select all" },
  { key: "Mod-Tab", label: "Switch apps" },
  { key: "Mod-`", label: "Switch windows" },
  { key: "Mod-Space", label: "Spotlight" },
  { key: "Mod-Alt-Space", label: "Finder search" },
  { key: "Mod-Alt-d", label: "Show or hide the Dock" },
  { key: "Mod-Alt-Escape", label: "Force quit" },
  { key: "Ctrl-Mod-q", label: "Lock screen" },
  { key: "Mod-Shift-3", label: "Screenshot" },
  { key: "Mod-Shift-4", label: "Screenshot of part" },
  { key: "Mod-Shift-5", label: "Screenshot tools" },
  { key: "Mod-Alt-i", label: "Web inspector" },
].map((s) => ({ ...s, scope: "system" as const }));

/** Keys deliberately taken from CodeMirror or another scope, by their
 *  canonical spec. The conflict test fails on any other shared key, and on
 *  an entry here that no longer clashes. */
export const OVERRIDES: Record<string, string> = {
  "Mod-i": "Italic replaces CodeMirror's select parent syntax",
  "Mod-u": "Underline replaces CodeMirror's undo selection",
  "Shift-Mod-k": "The developer panel replaces CodeMirror's delete line",
  "Mod-a": "The app menu's Select all and CodeMirror's are the same",
};

export type Entry = Shortcut & { id?: string };

/** Every entry, in list order: the app's, the editor's formatting keys
 *  (after the typed `/` and `[[`), then the rest of the groups. */
export function entries(): Entry[] {
  const own: Entry[] = Object.entries(SHORTCUTS).map(([id, s]) => ({ id, ...(s as Shortcut) }));
  const formatting: Entry[] = formatShortcuts.map(({ key, label }) => ({ key, label, group: "formatting" }));
  const at = own.findIndex((s) => s.group === "text");
  return [...own.slice(0, at), ...formatting, ...own.slice(at), ...SYSTEM];
}

/** A row in the list: one name, its keys. */
export type Row = { label: string; keys: string[] };

const shows = (s: Shortcut) => s.shows ?? (s.typed ? s.key : keysOf(s.key));

/** Shortcuts with one name in a row share it: a run of digits as a range
 *  ("Heading" ⌥⌘1–6), others side by side ("Back" Esc ⌘[). */
export function rowsOf(list: Shortcut[]): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < list.length;) {
    let j = i;
    while (j + 1 < list.length && list[j + 1].label === list[i].label) j++;
    const run = list.slice(i, j + 1);
    const digits = run.length > 2 && run.every((s, n) => s.key.slice(0, -1) === run[0].key.slice(0, -1) && /\d$/.test(s.key) && Number(s.key.slice(-1)) === Number(run[0].key.slice(-1)) + n);
    const keys = digits ? [`${shows(run[0])}–${run[run.length - 1].key.slice(-1)}`] : run.map(shows);
    out.push({ label: list[i].label, keys });
    i = j + 1;
  }
  return out;
}

export type Section = { group: Group; title: string; rows: Row[] };

/** The shortcuts list and README: every group with what's in it. */
export function sections(groups: Group[] = Object.keys(GROUPS) as Group[]): Section[] {
  const all = entries().filter((s) => !s.soon);
  return groups.map((group) => ({ group, title: GROUPS[group].title, rows: rowsOf(all.filter((s) => s.group === group)) }));
}

/** What a typed filter matches: the name, the group and the keys, with
 *  the modifiers spelled out so "opt t" finds ⌥⌘T. */
export function searchText(row: Row, title: string): string {
  const spelled = row.keys.join(" ").replace(/⌘/g, " cmd command ").replace(/⇧/g, " shift ").replace(/⌥/g, " opt option alt ").replace(/⌃/g, " ctrl control ");
  return `${row.label} ${title} ${row.keys.join(" ")} ${spelled}`.toLocaleLowerCase();
}

export function filterSections(list: Section[], query: string): Section[] {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return list;
  return list
    .map((section) => ({ ...section, rows: section.rows.filter((row) => { const text = searchText(row, section.title); return words.every((word) => text.includes(word)); }) }))
    .filter((section) => section.rows.length > 0);
}

export const README_START = "<!-- shortcuts:start (generated from apps/desktop/src/lib/shortcuts.ts; run pnpm shortcuts:readme) -->";
export const README_END = "<!-- shortcuts:end -->";

/** README's shortcut tables, between the markers. */
export function readmeTables(): string {
  const cell = (text: string) => text.replace(/\|/g, "\\|");
  const code = (keys: string) => (/[`[\]\\|/@]/.test(keys) ? `\`${keys.replace(/\|/g, "\\|")}\`` : cell(keys));
  return sections()
    .map((section) => [`### ${section.title}`, "", "| Keys | Action |", "| --- | --- |", ...section.rows.map((row) => `| ${row.keys.map(code).join(" ")} | ${cell(row.label)} |`)].join("\n"))
    .join("\n\n");
}
