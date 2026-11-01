import { invoke } from "@tauri-apps/api/core";

/** What a search result is (see docs/search.md). */
export type SearchKind = "writing" | "note" | "clip" | "feed";

/** One hybrid search result: compact, never the full text. */
export type SearchHit = {
  /** A vault-relative path, or a Feed item's id. */
  id: string;
  kind: SearchKind;
  title?: string;
  /** A clip's site, a feed item's source. */
  source?: string;
  snippet: string;
  /** Relative: 1 is first by both words and meaning. */
  score: number;
};

export type SearchQuery = { query: string; k?: number; kinds?: SearchKind[]; within?: string };

/** Words and meaning over the open vault's writing and clips, and the Feed. */
export const search = (query: SearchQuery) => invoke<SearchHit[]>("search", query);
