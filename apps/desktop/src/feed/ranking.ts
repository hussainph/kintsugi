// Pure helpers for Picked for you, free of React and Tauri so they run under
// plain `node --test`.
import type { Change, Effect } from "./api.ts";

const percent = (x: number) => `${Math.round(x * 100)}%`;

/** "Studio Notes", "the topic glaze", "Ada Writer". */
export function changeName(change: Pick<Change, "key" | "label">): string {
  if (change.key.startsWith("topic:")) return `the topic “${change.label}”`;
  return change.label;
}

/**
 * What a like changed, as one or two short lines for its toast: the
 * affinities it moved most, then picks that came in or went out.
 */
export function describeEffect(effect: Effect): string {
  const lines: string[] = [];
  const moved = effect.changes.slice(0, 2).map((c) => `${changeName(c)} ${percent(c.before)} → ${percent(c.after)}`);
  if (moved.length) lines.push(`More weight on ${moved.join(", ")}.`);
  const added = effect.added.map((a) => `“${a.title}”`);
  if (added.length) lines.push(`New in Picked for you: ${added.slice(0, 2).join(", ")}${added.length > 2 ? ` and ${added.length - 2} more` : ""}.`);
  else if (effect.removed.length) lines.push(`${effect.removed.length} ${effect.removed.length === 1 ? "pick" : "picks"} made room.`);
  return lines.join(" ") || "A signal for Picked for you; nothing visible moved yet.";
}

/** Picked for you's quiet status line. */
export function learning(examples: number, learnedShare: number): string {
  if (examples === 0) return "Starting from what’s recent and what’s in Inspiration.";
  if (learnedShare < 1) return `Learning from ${examples} ${examples === 1 ? "thing" : "things"} you’ve done here.`;
  return `Ranked from ${examples} things you’ve kept, liked and passed on.`;
}
