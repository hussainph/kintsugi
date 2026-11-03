import { useSyncExternalStore } from "react";

/** The editor's text size (KI-65), as a scale on its type: Settings ›
 *  Appearance, or ⌘− ⌘= ⌘0 while writing. Kept in this Mac's localStorage and
 *  applied as `--editor-text-scale`, which only the editor reads, so the rest
 *  of the app and the webview's own zoom stay as they are. */

export const TEXT_SIZES = [0.8, 0.9, 1, 1.1, 1.2, 1.35, 1.5] as const;
const KEY = "kintsugi:text-size";
const listeners = new Set<() => void>();

/** The nearest step to a stored value; 1 when there is none. */
export function nearestSize(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return TEXT_SIZES.reduce((best, size) => (Math.abs(size - value) < Math.abs(best - value) ? size : best), 1);
}

/** One step smaller (-1) or larger (+1), stopping at the ends. */
export function stepSize(current: number, direction: -1 | 1): number {
  const index = TEXT_SIZES.indexOf(nearestSize(current) as (typeof TEXT_SIZES)[number]);
  return TEXT_SIZES[Math.max(0, Math.min(TEXT_SIZES.length - 1, index + direction))];
}

function read(): number {
  try {
    const saved = localStorage.getItem(KEY);
    return saved === null ? 1 : nearestSize(Number(saved));
  } catch {
    return 1;
  }
}

let current = typeof window === "undefined" ? 1 : read();

function apply(size: number) {
  if (typeof document !== "undefined") document.documentElement.style.setProperty("--editor-text-scale", String(size));
}
apply(current);

export function textSize(): number {
  return current;
}

export function setTextSize(size: number) {
  const next = nearestSize(size);
  if (next === current) return;
  current = next;
  apply(next);
  try { localStorage.setItem(KEY, String(next)); } catch { /* A preference only. */ }
  for (const listener of listeners) listener();
}

/** ⌘= / ⌘+ larger, ⌘− smaller, ⌘0 back to 100%. Null for any other key. */
export function textSizeForKey(key: string, size = current): number | null {
  if (key === "=" || key === "+") return stepSize(size, 1);
  if (key === "-" || key === "_") return stepSize(size, -1);
  if (key === "0") return 1;
  return null;
}

export function useTextSize(): number {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, textSize, () => 1);
}
