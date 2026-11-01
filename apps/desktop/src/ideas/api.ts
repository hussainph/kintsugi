import { invoke } from "@tauri-apps/api/core";
import type { Job } from "../lib/chat.ts";

/** Mirrors `ideas::store::Quote` in src-tauri/src/ai/ideas/store.rs. */
export type Quote = {
  /** A vault path with its extension, or `feed:<id>`. */
  source: string;
  /** Verbatim, checked against the source when Kin offered the idea. */
  text: string;
  title: string;
  origin: string;
  own: boolean;
  /** Wikilink target (vault path without extension) or a URL. */
  link?: string;
};

export type Step = { did: string; found?: string };
export type Reason = { id: string; text: string; profileLine?: string; removed: boolean };
export type Footprint = { searches: number; files: number; seconds: number; usd: number; model: string; batch: number };

export type Content = {
  kind: "gap" | "tension" | "stalled" | "connection" | "other";
  title: string;
  draftTitle: string;
  snippet: string;
  observed: string[];
  hunch: string;
  quotes: Quote[];
  steps: Step[];
  reasons: Reason[];
  about: string[];
  footprint: Footprint;
};

export type Idea = Content & {
  id: string;
  created: string;
  job: string;
  versions: { content: Content; asked: string; at: string }[];
  dismissed?: { at: string; reasons: string[] };
  adopted?: { path: string; at: string; new: boolean };
  refining?: string;
  refineError?: string;
};

/** Mirrors `ideas::store::Listed`. */
export type Listed = Idea & { age: number; stage: "fresh" | "thin" | "faded" };

/** Mirrors `ideas::View`. */
export type View = { ideas: Listed[]; job: Job | null; today: string; capReached: boolean };

export const IDEAS_CHANGED = "ideas:changed";

export const ideas = {
  list: () => invoke<View>("ideas_list"),
  /** Ideas on demand, optionally about something or for one document. */
  generate: (focus?: string, about?: string) => invoke<View>("ideas_generate", { focus, about }),
  dismiss: (id: string, reasons: string[] = []) => invoke<View>("ideas_dismiss", { id, reasons }),
  undismiss: (id: string) => invoke<View>("ideas_undismiss", { id }),
  reason: (id: string, reason: string, removed: boolean) => invoke<View>("ideas_reason", { id, reason, removed }),
  refine: (id: string, ask: string) => invoke<View>("ideas_refine", { id, ask }),
  undoRefine: (id: string) => invoke<View>("ideas_refine_undo", { id }),
  discussed: (id: string) => invoke<void>("ideas_discussed", { id }),
  get: (ids: string[]) => invoke<Idea[]>("ideas_get", { ids }),
  /** A new draft (no `into`), or the idea added to the draft at `into`. */
  adopt: (id: string, opts: { title?: string; into?: string }) =>
    invoke<{ path: string; view: View }>("ideas_adopt", { id, title: opts.title, into: opts.into }),
};

// --- Opening Ideas from anywhere ---------------------------------------------

const OPEN = "kintsugi:open-ideas";

/**
 * Opens Ideas; with a path, filtered to that document ("Ideas for this
 * draft"). The editor's commands (KI-37's / menu and ⌘K) call this.
 */
export function openIdeas(path?: string) {
  window.dispatchEvent(new CustomEvent<{ path?: string }>(OPEN, { detail: { path } }));
}

/** "Ideas for this draft". */
export const ideasForDraft = (path: string) => openIdeas(path);

export function onOpenIdeas(listener: (path?: string) => void) {
  const handler = (e: Event) => listener((e as CustomEvent<{ path?: string }>).detail?.path);
  window.addEventListener(OPEN, handler);
  return () => window.removeEventListener(OPEN, handler);
}
