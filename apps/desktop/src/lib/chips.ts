/**
 * Context chips: what's on screen, attached to a message for Kin to read on
 * demand. Pure helpers, so the chat's rules are testable without a webview.
 */

/** Mirrors `prompt::Chip` in src-tauri/src/ai/prompt.rs. */
export type Chip = {
  /** "doc", "clip", "feed", "paragraph"… */
  kind: string;
  /** A vault path Kin can read (a feed item's id for "feed"). */
  path: string;
  label?: string;
  /** For a paragraph or selection: first and last line, from 1. */
  lines?: [number, number];
};

export const chipKey = (c: Chip) => `${c.kind}:${c.path}${c.lines ? `:${c.lines[0]}-${c.lines[1]}` : ""}`;

/**
 * The chips a message would carry: what was explicitly brought in (Discuss)
 * first, then what's on screen, without the ones he removed, each once.
 */
export function mergeChips(pinned: Chip[], screen: Chip[], removed: ReadonlySet<string>): Chip[] {
  const seen = new Set<string>();
  const out: Chip[] = [];
  for (const chip of [...pinned, ...screen]) {
    const key = chipKey(chip);
    if (removed.has(key) || seen.has(key) || !chip.path.trim()) continue;
    seen.add(key);
    out.push(chip);
  }
  return out;
}

const SNIPPET = 80;

/** A short, single-line label for a passage of text. */
export function snippet(text: string, max = SNIPPET) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** The selected passage of a document, as a chip. `null` for an empty selection. */
export function selectionChip(path: string, text: string, fromLine: number, toLine: number): Chip | null {
  if (!text.trim()) return null;
  return { kind: "paragraph", path, lines: [fromLine, Math.max(fromLine, toLine)], label: snippet(text) };
}

/** What a chip shows: its label, or the file's name. */
export function chipTitle(chip: Chip) {
  if (chip.label?.trim()) return chip.label.trim();
  return chip.path.replace(/^.*\//, "").replace(/\.mdx?$/, "");
}

/**
 * Typing pings, throttled: at most one per `every` ms while he types, so
 * Kin stops talking at the first keystroke without a call per key.
 */
export function throttle(ping: () => void, every: number, now: () => number = Date.now) {
  let last = -Infinity;
  return () => {
    const t = now();
    if (t - last < every) return;
    last = t;
    ping();
  };
}
