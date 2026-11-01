/**
 * Pure helpers behind every Ideas layout (Ledger today; Desk or Letter
 * could replace it without touching these): grouping, fading, filtering to
 * a document, and the labels the list shows.
 */
import type { Footprint, Idea, Listed, Quote } from "./api.ts";

/** Days before an unused idea fades out of the list (mirrors store.rs). */
export const FADE_DAYS = 7;
export const THIN_FROM = 3;

export type Groups = { today: Listed[]; earlier: Listed[]; faded: Listed[] };

/**
 * Today's batch, earlier ones, and "faded this week". Dismissed ideas leave
 * the list, except those dismissed just now, which keep their place so the
 * reasons and Undo stay in reach.
 */
export function group(list: Listed[], keep: ReadonlySet<string> = new Set()): Groups {
  const shown = list.filter((i) => !i.dismissed || keep.has(i.id));
  return {
    today: shown.filter((i) => i.age === 0 && i.stage !== "faded"),
    earlier: shown.filter((i) => i.age > 0 && i.stage !== "faded"),
    faded: shown.filter((i) => i.stage === "faded" && !i.dismissed),
  };
}

/** 1 when new, thinning from day three; adopted ideas never thin. */
export function opacity(idea: Listed): number {
  if (idea.adopted || idea.age < THIN_FROM) return 1;
  if (idea.age >= FADE_DAYS) return 0.45;
  return 1 - ((idea.age - (THIN_FROM - 1)) / (FADE_DAYS - (THIN_FROM - 1))) * 0.55;
}

export function ageLabel(age: number): string {
  if (age <= 0) return "Today";
  if (age === 1) return "Yesterday";
  if (age >= FADE_DAYS) return "Faded";
  const left = FADE_DAYS - age;
  return age >= 5 ? `Fades in ${left} day${left === 1 ? "" : "s"}` : `${age} days ago`;
}

const stem = (path: string) => path.replace(/\.(mdx?|txt)$/, "");

/** An idea bears on a document: it's about it, quotes it, or was adopted into it. */
export function concerns(idea: Idea, path: string): boolean {
  const p = stem(path);
  return (
    idea.about.some((a) => stem(a) === p) ||
    idea.quotes.some((q) => stem(q.source) === p) ||
    (idea.adopted ? stem(idea.adopted.path) === p : false)
  );
}

/** One per source, the order Kin gave them. */
export function uniqueSources(quotes: Quote[]): Quote[] {
  const seen = new Set<string>();
  return quotes.filter((q) => !seen.has(q.source) && seen.add(q.source));
}

const money = (usd: number) => (usd <= 0 ? "$0" : usd < 0.01 ? "under 1¢" : `$${usd.toFixed(2)}`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "2 searches · 5 files read · 31 s · $0.04", for the whole run. */
export function footprint(f: Footprint): string {
  const parts = [plural(f.searches, "search", "searches"), `${plural(f.files, "file")} read`, `${f.seconds} s`, money(f.usd)];
  return f.batch > 1 ? `${parts.join(" · ")} · for the batch of ${f.batch}` : parts.join(" · ");
}

/** The ids in a draft's `ideas:` frontmatter list. */
export function adoptedIds(text: string): string[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trimEnd() !== "---") return [];
  const out: string[] = [];
  let inside = false;
  for (const line of lines.slice(1)) {
    if (line.trimEnd() === "---") break;
    if (!/^\s/.test(line)) {
      inside = /^ideas:/.test(line);
      continue;
    }
    const id = inside && /^\s+-\s+id:\s*"?([^"\s]+)"?/.exec(line)?.[1];
    if (id) out.push(id);
  }
  return out;
}

export const count = (n: number) => ["No", "One", "Two", "Three", "Four", "Five", "Six"][n] ?? String(n);

export const KIND_LABEL: Record<Idea["kind"], string> = {
  gap: "Gap",
  tension: "Tension",
  stalled: "Stalled draft",
  connection: "Connection",
  other: "Idea",
};

/** Optional reasons for Dismiss, each with what it does. */
export const DISMISS_REASONS = [
  { text: "Not for me", effect: "Kin will offer fewer like it." },
  { text: "Already on it", effect: "Kin will leave this one to you." },
  { text: "Wrong about me", effect: "Fix what it believed in About you." },
] as const;
