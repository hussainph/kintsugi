// Pure helpers for Picked for you, free of React and Tauri so they run under
// plain `node --test`.
import type { Reason } from "./api.ts";

/**
 * The (?) card's reasons, strongest first. "Still learning…" is about the
 * ranker, not the item (KI-91: the mechanics stay in the background).
 */
export function shownReasons(reasons: Reason[]): Reason[] {
  return reasons.filter((r) => r.key !== "cold");
}
