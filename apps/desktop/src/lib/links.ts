// Updating [[links]] after a rename (KI-13). The backend plans and writes
// (`links_plan` / `links_write`); these are the pure pieces the app and its
// tests share.

/** One link's target replaced; UTF-16 offsets into the file's `before`. */
export type LinkEdit = { from: number; to: number; insert: string };

/** Mirrors `kintsugi_vault::Relink`. */
export type Relink = { path: string; version: string; before: string; after: string; edits: LinkEdit[] };

/** Mirrors `kintsugi_vault::RelinkPlan`. */
export type RelinkPlan = { from: string; to: string; files: Relink[]; links: number };

/** Mirrors `kintsugi_vault::RelinkWrite`: written only if the file is still at `base`. */
export type RelinkWrite = { path: string; text: string; base: string };

/** Mirrors `kintsugi_vault::RelinkOutcome`. Anything but `saved` wrote nothing. */
export type RelinkOutcome =
  | { path: string; result: "saved" }
  | { path: string; result: "conflict" }
  | { path: string; result: "gone" }
  | { path: string; result: "failed"; error: string };

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Update 3 links in 2 notes?" */
export const question = (links: number, notes: number) =>
  `Update ${count(links, "link", "links")} in ${count(notes, "note", "notes")}?`;

/** "Updated 3 links in 2 notes." */
export const updated = (links: number, notes: number) =>
  `Updated ${count(links, "link", "links")} in ${count(notes, "note", "notes")}.`;

/** "Restored 3 links in 2 notes." */
export const restored = (links: number, notes: number) =>
  `Restored ${count(links, "link", "links")} in ${count(notes, "note", "notes")}.`;

const why = (outcome: RelinkOutcome) =>
  outcome.result === "conflict"
    ? "changed since"
    : outcome.result === "gone"
      ? "moved or deleted"
      : outcome.result === "failed"
        ? outcome.error
        : "";

/** The files left alone, one line each: "notes/x.md (changed since)". */
export const skipped = (outcomes: RelinkOutcome[]) =>
  outcomes.filter((o) => o.result !== "saved").map((o) => `${o.path} (${why(o)})`);

/** The edits that turn `after` back into `before`, as offsets into `after`. */
export function invert(before: string, edits: LinkEdit[]): LinkEdit[] {
  let shift = 0;
  return edits.map(({ from, to, insert }) => {
    const start = from + shift;
    shift += insert.length - (to - from);
    return { from: start, to: start + insert.length, insert: before.slice(from, to) };
  });
}

/** Applies non-overlapping, ordered edits to `text`. */
export function apply(text: string, edits: LinkEdit[]) {
  let out = "";
  let last = 0;
  for (const { from, to, insert } of edits) {
    out += text.slice(last, from) + insert;
    last = to;
  }
  return out + text.slice(last);
}
