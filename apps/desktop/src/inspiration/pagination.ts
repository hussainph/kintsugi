import type { ClipSearch, ClipSearchQuery } from "./api";

/** Refresh the whole loaded window without collapsing a scrolled library to page one. */
export async function searchWindow(
  search: (query: ClipSearchQuery) => Promise<ClipSearch>,
  query: Pick<ClipSearchQuery, "query" | "tags">,
  count: number,
  current = () => true,
): Promise<ClipSearch | undefined> {
  const items: ClipSearch["clips"] = [];
  const seen = new Set<string>();
  let fetched = 0;
  let page: ClipSearch;
  do {
    page = await search({ ...query, offset: fetched, limit: Math.min(120, count - fetched) });
    if (!current()) return;
    fetched += page.clips.length;
    for (const clip of page.clips) {
      if (!seen.has(clip.path)) { items.push(clip); seen.add(clip.path); }
    }
    if (!page.clips.length) break;
  } while (fetched < Math.min(count, page.total));
  return { ...page, clips: items };
}
