/** Key specs in CodeMirror's notation ("Mod-Shift-f"), so the app's
 *  shortcuts and the editor's keymap are written the same way. Mod is ⌘. */

type Parsed = { mod: boolean; shift: boolean; alt: boolean; ctrl: boolean; key: string };

function parse(spec: string): Parsed {
  // The last part is the key; "Mod--" ends in an empty part and means "-".
  const parts = spec.split(/-(?!$)/);
  const key = parts.pop() ?? "";
  const has = (name: string) => parts.includes(name);
  return { mod: has("Mod") || has("Cmd") || has("Meta"), shift: has("Shift"), alt: has("Alt"), ctrl: has("Ctrl"), key };
}

const GLYPHS: Record<string, string> = {
  Backspace: "⌫",
  Delete: "⌦",
  Enter: "↩",
  Escape: "Esc",
  Tab: "⇥",
  Space: "Space",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  "-": "−",
};

/** How a spec reads on a Mac: modifiers in Apple's order, ⌃⌥⇧⌘, then the key. */
export function keysOf(spec: string): string {
  const { mod, shift, alt, ctrl, key } = parse(spec);
  const name = GLYPHS[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  return `${ctrl ? "⌃" : ""}${alt ? "⌥" : ""}${shift ? "⇧" : ""}${mod ? "⌘" : ""}${name}`;
}

type KeyLike = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "shiftKey" | "altKey" | "ctrlKey">;

/** Whether a keydown is exactly this spec: the same modifiers, no others.
 *  Letters and digits match by `key`, so other layouts get the letter they
 *  see; only when ⌥ or ⇧ turned it into something else (⌥⌘E gives "´",
 *  ⇧⌘7 gives "&") does the physical key count. */
export function matches(e: KeyLike, spec: string): boolean {
  const want = parse(spec);
  if (e.metaKey !== want.mod || e.shiftKey !== want.shift || e.altKey !== want.alt || e.ctrlKey !== want.ctrl) return false;
  const key = want.key;
  const plain = /^[a-z0-9]$/i.test(e.key);
  if (/^[a-z]$/i.test(key)) return plain ? e.key.toLowerCase() === key.toLowerCase() : e.code === `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return plain ? e.key === key : e.code === `Digit${key}`;
  return e.key === key;
}
