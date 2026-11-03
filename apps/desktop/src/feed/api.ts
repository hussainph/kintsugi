import { invoke } from "@tauri-apps/api/core";

/** Times are Unix seconds. */
export type SourceKind = "feed" | "hn" | "youtube" | "podcast" | "x" | "page" | "author";

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
  catalogueEnabled: boolean;
  catalogueState: string;
  catalogueCount: number;
  catalogueError: string | null;
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
  /** A watched page's change is an "article"; a followed author's release is a "book". */
  media: "article" | "video" | "audio" | "book";
  publishedAt: number | null;
  fetchedAt: number;
  sortAt: number;
  liked: boolean;
  note: string | null;
  /** The clip in inspiration/ once saved. */
  savedPath: string | null;
  dismissed: boolean;
  hasContent: boolean;
  /** Discovered older writing; its original date is never replaced by discovery time. */
  backCatalogue?: boolean;
  suggestion?: { reason: string; sourceUrl: string } | null;
  /** The source's site (or feed) URL, for its icon. */
  sourceSite: string | null;
  /** A Hacker News item's discussion page; `url` is the page it links to. */
  discussion: string | null;
};

export type Page = { items: FeedItem[]; total: number };

/** One sentence of Kin's story summary, and the items it came from. */
export type Sentence = { text: string; cites: number[] };
export type StorySummary = { paragraphs: Sentence[][] };
/** pending, ready, failed, capped (the month's AI limit) or unavailable (no AI provider). */
export type SummaryState = "pending" | "ready" | "failed" | "capped" | "unavailable";
export type StorySource = { id: number; title: string | null; kind: SourceKind; site: string | null; items: number };
/** Items about the same thing from two or more sources (KI-94). */
export type Story = {
  id: number;
  /** Kin's title once summarised, else the lead article's. */
  title: string;
  summary: StorySummary | null;
  summaryState: SummaryState;
  /** The first article to cover it; the summary falls back to its text. */
  lead: FeedItem;
  image: string | null;
  /** The lead first, then newest first. */
  items: FeedItem[];
  /** Most items first. */
  sources: StorySource[];
  sortAt: number;
  updatedAt: number;
};
/** One entry of the Newest list: an item, or a story folded in at its newest item. */
export type Entry = { kind: "item"; item: FeedItem } | { kind: "story"; story: Story };
export type Entries = { entries: Entry[]; total: number };
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
  | { kind: "x"; account: string }
  /** A page without a feed, watched for changes. */
  | { kind: "page"; url: string }
  /** An author whose new books arrive in the feed. */
  | { kind: "author"; name: string };

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
/** For a story, `item` is its best item and `story` the story. */
export type Pick = { item: FeedItem; id: number; score: number; explore: boolean; reasons: Reason[]; storyId?: number; story?: Story };
export type Picked = { picks: Pick[]; examples: number; learnedShare: number };
/** An affinity a like moved, from 0 to 1 (0.25 is "no opinion yet"). */
export type Change = { key: string; label: string; before: number; after: number };
export type Effect = { changes: Change[]; added: { id: number; title: string }[]; removed: { id: number; title: string }[] };

const reads = new Map<number, { at: number; reading: Promise<Reading> }>();

export const feed = {
  sources: () => invoke<Source[]>("feed_sources"),
  subscribe: (input: Subscribe) => invoke<Subscribed>("feed_subscribe", { input }),
  unsubscribe: (id: number) => invoke<void>("feed_unsubscribe", { id }),
  mute: (id: number, muted: boolean) => invoke<Source>("feed_mute", { id, muted }),
  refresh: (id?: number) => invoke<Polled[]>("feed_refresh", { id }),
  catalogue: (id: number, enabled?: boolean, retry = false) => invoke<Source>("feed_catalogue", { id, enabled, retry }),
  followSuggestion: (id: number) => invoke<Source>("feed_follow_suggestion", { id }),
  podcasts: (term: string) => invoke<Podcast[]>("feed_podcast_search", { term }),
  importOpml: (opml: string) => invoke<Imported>("feed_opml_import", { opml }),
  exportOpml: (path: string) => invoke<number>("feed_opml_export", { path }),
  items: (query: { offset?: number; limit?: number; source?: number } = {}) => invoke<Page>("feed_items", query),
  /** Opening to read, logged as an `open`. A second ask within a second
   *  (React's development double mount) shares the first. */
  read: (id: number, place?: Place) => {
    const recent = reads.get(id);
    if (recent && Date.now() - recent.at < 1000) return recent.reading;
    const reading = invoke<Reading>("feed_read", { id, place });
    reads.set(id, { at: Date.now(), reading });
    return reading;
  },
  act: (id: number, action: Action, place?: Place) => invoke<FeedItem>("feed_act", { id, action, place }),
  note: (id: number, note: string, place?: Place) => invoke<FeedItem>("feed_note", { id, note, place }),
  save: (id: number, place?: Place) => invoke<FeedItem>("feed_save", { id, place }),
  impressions: (impressions: Impression[]) => invoke<void>("feed_impressions", { impressions }),
  picked: (n?: number) => invoke<Picked>("feed_picked", { n }),
  correct: (reason: string, id?: number, undo = false) => invoke<void>("feed_correct", { reason, id, undo }),
  effect: (id: number) => invoke<Effect>("feed_effect", { id }),
  entries: (query: { offset?: number; limit?: number } = {}) => invoke<Entries>("feed_entries", query),
  story: (id: number) => invoke<Story>("feed_story", { id }),
  why: (id: number) => invoke<Reason[]>("feed_why", { id }),
  /** Not interested (or its undo) for several items: a whole story. */
  dismissMany: (ids: number[], undo = false, place?: Place) => invoke<FeedItem[]>("feed_dismiss_many", { ids, undo, place }),
};

/** Picked for you reloads on this window event (likes, saves, corrections). */
export const PICKED_REFRESH = "kintsugi:picked-refresh";
export const refreshPicked = () => window.dispatchEvent(new Event(PICKED_REFRESH));

export const FEED_CHANGED = "feed:changed";
