import { keysOf } from "@/lib/keys";
import { EDIT_KEYS, SHORTCUTS, type ShortcutId } from "@/lib/shortcuts";
import type { Action } from "./prompts";

/** Synonyms are for a word or a short phrase, as in ⌘K's list. */
export const SYNONYM_WORDS = 4;

/** Why an edit can't run on this passage straight from its key (⌥⌘T…),
 *  or null when it can. */
export function fits(action: Action, passage: string, readOnly: boolean): string | null {
  if (readOnly) return "This document is read-only.";
  if (action.shape === "choices" && passage.trim().split(/\s+/).length > SYNONYM_WORDS) return `Select ${SYNONYM_WORDS} words or fewer for synonyms.`;
  return null;
}

/** An edit's own key as it reads (⌥⌘T), for the rows that offer it. */
export function editKey(id: string): string | undefined {
  const shortcut = (EDIT_KEYS as Record<string, ShortcutId>)[id];
  return shortcut && keysOf(SHORTCUTS[shortcut].key);
}
