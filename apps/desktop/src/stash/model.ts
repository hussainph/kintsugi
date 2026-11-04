import type { StashItem } from "./api.ts";

/** Reorder targets are positions in the resulting list, not insertion edges. */
export function moveItem(items: StashItem[], id: string, toIndex: number): StashItem[] {
  const from = items.findIndex((item) => item.id === id);
  if (from < 0 || !Number.isFinite(toIndex)) return items;
  const to = Math.max(0, Math.min(items.length - 1, Math.trunc(toIndex)));
  if (from === to) return items;
  const next = [...items];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

/**
 * The editor sends a whole snapshot, but owns only the changes it made.
 * Rebase those onto the latest shared stash: a late anchor update must not
 * undo a row reorder, resurrect a dismissed item or erase a new Kin item.
 */
export function mergeEditorItems(base: StashItem[], edited: StashItem[], current: StashItem[]): StashItem[] {
  const before = new Map(base.map((item) => [item.id, item]));
  const after = new Map(edited.map((item) => [item.id, item]));
  const next = current.flatMap((item) => {
    const was = before.get(item.id);
    const now = after.get(item.id);
    if (!was) return [item];
    if (!now) return [];
    const patch: Partial<StashItem> = {};
    for (const key of ["text", "kind", "by", "created", "anchor"] as const) {
      if (JSON.stringify(was[key]) !== JSON.stringify(now[key])) Object.assign(patch, { [key]: now[key] });
    }
    return [{ ...item, ...patch }];
  });
  // A local addition (a new note, or an undo restoring an inserted or
  // dismissed row) keeps its editor position: directly after its nearest
  // surviving earlier neighbour, else before the nearest later one. Unseen
  // shared arrivals keep their disk positions around it.
  const known = new Set(current.map((item) => item.id));
  const indexOf = (id: string) => next.findIndex((entry) => entry.id === id);
  edited.forEach((item, index) => {
    if (before.has(item.id) || known.has(item.id)) return;
    let at = -1;
    for (let j = index - 1; j >= 0 && at < 0; j--) { const found = indexOf(edited[j].id); if (found >= 0) at = found + 1; }
    for (let j = index + 1; j < edited.length && at < 0; j++) at = indexOf(edited[j].id);
    next.splice(at < 0 ? next.length : at, 0, item);
    known.add(item.id);
  });
  const inBoth = (items: StashItem[]) => items.filter((item) => before.has(item.id) && after.has(item.id)).map((item) => item.id);
  if (JSON.stringify(inBoth(base)) !== JSON.stringify(inBoth(edited))) {
    const order = new Map(edited.map((item, index) => [item.id, index]));
    next.sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
  }
  return next;
}

export type WikiPart = string | { target: string; label: string };

/** Text stays text; only explicit [[links]] become navigation controls. */
export function splitWikiLinks(text: string): WikiPart[] {
  const parts: WikiPart[] = [];
  let last = 0;
  for (const match of text.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
    const at = match.index!;
    const [target, ...alias] = match[1].split("|");
    if (!target.trim()) continue;
    if (at > last) parts.push(text.slice(last, at));
    parts.push({ target: target.trim(), label: alias.join("|").trim() || target.trim() });
    last = at + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
