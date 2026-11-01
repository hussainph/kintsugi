import { invoke } from "@tauri-apps/api/core";

/** Times are Unix seconds. */
export type SourceKind = "feed" | "hn" | "youtube" | "podcast" | "x";

export type Source = {
  id: number;
  url: string;
  kind: SourceKind;
  title: string | null;
  siteUrl: string | null;
  image: string | null;
  muted: boolean;
  addedAt: number;
  lastFetchAt: number | null;
  lastSuccessAt: number | null;
  lastStatus: number | null;
  lastError: string | null;
  failures: number;
  nextFetchAt: number;
  /** Items from this source currently in the feed. */
  items: number;
};

export type FeedItem = {
  id: number;
  sourceId: number;
  sourceTitle: string | null;
  sourceKind: SourceKind;
  url: string | null;
  title: string | null;
  author: string | null;
  summary: string | null;
  image: string | null;
  media: "article" | "video" | "audio";
  publishedAt: number | null;
  fetchedAt: number;
  sortAt: number;
  liked: boolean;
  note: string | null;
  /** The clip in inspiration/ once saved. */
  savedPath: string | null;
  dismissed: boolean;
  hasContent: boolean;
};

export type Page = { items: FeedItem[]; total: number };
export type Reading = { item: FeedItem; text: string | null };
export type Polled = { sourceId: number; added: number; error: string | null };
export type Subscribed = { source: Source; added: number; error: string | null };
export type Podcast = { title: string; author: string | null; feedUrl: string; artwork: string | null; url: string | null };
export type Imported = { added: number; existing: number; invalid: number };

export type Subscribe =
  | { kind: "url"; url: string }
  | { kind: "hn"; list: HnList; points?: number }
  | { kind: "youtube"; channel: string }
  | { kind: "podcast"; feedUrl: string; title?: string }
  | { kind: "x"; account: string };

export const HN_LISTS = [
  ["frontpage", "Front page"],
  ["best", "Best"],
  ["newest", "Newest"],
  ["show", "Show HN"],
  ["ask", "Ask HN"],
] as const;
export type HnList = (typeof HN_LISTS)[number][0];

/** Which list an action happened in. "picked" belongs to KI-32's ranking. */
export type Surface = "newest" | "picked" | "source";
export type Place = { surface: Surface; position: number };
export type Action = "like" | "unlike" | "notInterested" | "undoNotInterested" | "openOriginal" | "discuss";
export type Impression = { id: number; position: number; surface: Surface };

/** One reason behind a pick. Removable ones are corrections (KI-32). */
export type Reason = { key: string; label: string; removable: boolean };
export type Pick = { item: FeedItem; id: number; score: number; explore: boolean; reasons: Reason[] };
export type Picked = { picks: Pick[]; examples: number; learnedShare: number };
/** An affinity a like moved, from 0 to 1 (0.25 is "no opinion yet"). */
export type Change = { key: string; label: string; before: number; after: number };
export type Effect = { changes: Change[]; added: { id: number; title: string }[]; removed: { id: number; title: string }[] };

export const feed = {
  sources: () => invoke<Source[]>("feed_sources"),
  subscribe: (input: Subscribe) => invoke<Subscribed>("feed_subscribe", { input }),
  unsubscribe: (id: number) => invoke<void>("feed_unsubscribe", { id }),
  mute: (id: number, muted: boolean) => invoke<Source>("feed_mute", { id, muted }),
  refresh: (id?: number) => invoke<Polled[]>("feed_refresh", { id }),
  podcasts: (term: string) => invoke<Podcast[]>("feed_podcast_search", { term }),
  importOpml: (opml: string) => invoke<Imported>("feed_opml_import", { opml }),
  exportOpml: (path: string) => invoke<number>("feed_opml_export", { path }),
  items: (query: { offset?: number; limit?: number; source?: number } = {}) => invoke<Page>("feed_items", query),
  read: (id: number, place?: Place) => invoke<Reading>("feed_read", { id, place }),
  act: (id: number, action: Action, place?: Place) => invoke<FeedItem>("feed_act", { id, action, place }),
  note: (id: number, note: string, place?: Place) => invoke<FeedItem>("feed_note", { id, note, place }),
  save: (id: number, place?: Place) => invoke<FeedItem>("feed_save", { id, place }),
  impressions: (impressions: Impression[]) => invoke<void>("feed_impressions", { impressions }),
  picked: (n?: number) => invoke<Picked>("feed_picked", { n }),
  correct: (reason: string, id?: number, undo = false) => invoke<void>("feed_correct", { reason, id, undo }),
  effect: (id: number) => invoke<Effect>("feed_effect", { id }),
};

/** Picked for you reloads on this window event (likes, saves, corrections). */
export const PICKED_REFRESH = "kintsugi:picked-refresh";
export const refreshPicked = () => window.dispatchEvent(new Event(PICKED_REFRESH));

export const FEED_CHANGED = "feed:changed";
