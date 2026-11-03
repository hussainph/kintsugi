/** The Feed, Ideas and Kin as the phone API sends them (API 6). Mirrors the
 *  desktop's own types (apps/desktop/src/feed/api.ts, src/ideas/api.ts,
 *  src/lib/chat.ts) and the Rust structs behind them; the phone reads only
 *  what it shows, so fields it doesn't use may be missing from older Macs. */

// ── Feed ─────────────────────────────────────────────────────────────────

/** Times are Unix seconds. */
export type FeedItem = {
  id: number;
  sourceId: number;
  sourceTitle: string | null;
  sourceKind: string;
  url: string | null;
  title: string | null;
  author: string | null;
  summary: string | null;
  image: string | null;
  media: "article" | "video" | "audio" | "book" | string;
  publishedAt: number | null;
  fetchedAt: number;
  sortAt: number;
  liked: boolean;
  note: string | null;
  /** The clip in inspiration/ once saved. */
  savedPath: string | null;
  dismissed: boolean;
  hasContent: boolean;
  backCatalogue?: boolean;
  suggestion?: { reason: string; sourceUrl: string } | null;
};

export type FeedPage = { items: FeedItem[]; total: number };
export type Reading = { item: FeedItem; text: string | null };
/** Which list an action happened in, for ranking. */
export type Surface = "newest" | "picked";
export type Place = { surface: Surface; position: number };
export type FeedAction = "like" | "unlike" | "notInterested" | "undoNotInterested" | "openOriginal" | "discuss";
export type Impression = { id: number; position: number; surface: Surface };
export type Reason = { key: string; label: string; removable: boolean };
export type Pick = { item: FeedItem; id: number; score: number; explore: boolean; reasons: Reason[] };
export type Picked = { picks: Pick[]; examples: number; learnedShare: number };
export type Change = { key: string; label: string; before: number; after: number };
export type Effect = { changes: Change[]; added: { id: number; title: string }[]; removed: { id: number; title: string }[] };
export type FeedNoteSaved =
  | { result: "saved"; version: string; item: FeedItem }
  | { result: "conflict"; current: { text: string; version: string }; item: FeedItem };

// ── Ideas ────────────────────────────────────────────────────────────────

export type Quote = { source: string; text: string; title: string; origin: string; own: boolean; link?: string };
export type Step = { did: string; found?: string };
export type IdeaReason = { id: string; text: string; profileLine?: string; removed: boolean };
export type Idea = {
  id: string;
  created: string;
  job: string;
  kind: "gap" | "tension" | "stalled" | "connection" | "other" | string;
  title: string;
  draftTitle: string;
  snippet: string;
  observed: string[];
  hunch: string;
  quotes: Quote[];
  steps: Step[];
  reasons: IdeaReason[];
  about: string[];
  dismissed?: { at: string; reasons: string[] };
  adopted?: { path: string; at: string; new: boolean };
  refining?: string;
};
export type ListedIdea = Idea & { age: number; stage: "fresh" | "thin" | "faded" };
export type IdeasView = { ideas: ListedIdea[]; job: Job | null; today: string; capReached: boolean };
export type Adopted = { path: string; view: IdeasView };

// ── Kin ──────────────────────────────────────────────────────────────────

/** What was on screen when he wrote: a document, clip, feed item or idea. */
export type Chip = { kind: "doc" | "clip" | "feed" | "idea"; path: string; label?: string };
export type Entry = {
  seq: number;
  at: string;
  role: "owner" | "kin" | "helper";
  text: string;
  chips?: { kind: string; path: string; label?: string }[];
  topic: string;
  answers?: number[];
  interrupted?: boolean;
  error?: string;
  job?: string;
  comment?: string;
  review?: boolean;
};
export type Thread = { key: string; kind: string; label: string; lastSeq: number; lastAt: string };
export type RunningTurn = { turn: string; answers: number[]; topic: string };
export type KinPage = { entries: Entry[]; threads: Thread[]; pending: number[]; running: RunningTurn | null };
export type Job = {
  id: string;
  kind: string;
  task: string;
  brief: string;
  topic: string;
  status: "queued" | "running" | "waiting" | "done" | "failed" | "cancelled";
  created: string;
  started?: string;
  finished?: string;
  result?: string;
  error?: string;
};
/** A message reached the log; a resend of the same id answers `duplicate`. */
export type KinSent = { entry: Entry; duplicate: false } | { seq: number; duplicate: true };
