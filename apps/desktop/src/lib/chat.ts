import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import type { Chip } from "./chips";
import type { KinEvent } from "./kin";
import type { WebCall } from "./web";

/**
 * Kin's threads (KI-104): many small conversations, each about one thing
 * or nothing. The commands live in `src-tauri/src/ai/chat.rs`.
 */

/** Mirrors `threads::Entry`: one message in a thread. */
export type Entry = {
  /** Position in its thread, from 1. */
  seq: number;
  thread: string;
  at: string;
  role: "owner" | "kin" | "helper";
  text: string;
  chips?: Chip[];
  answers?: number[];
  interrupted?: boolean;
  error?: string;
  job?: string;
  usd?: number;
  /** "Kin, review this draft" and Kin's notes from it. */
  review?: boolean;
  /** Kin's reply: the web searches and pages it used (KI-78). */
  web?: WebCall[];
  /** Kin's reply: the tools it used on the way, in order (KI-79). */
  tools?: ToolUse[];
  /** Kin's reply: how long the turn took, in milliseconds. */
  ms?: number;
  /** Kin's reply: `provider/model`. */
  model?: string;
  /** Kin's reply ran with the month's cap already reached. */
  capReached?: boolean;
};

/** Mirrors `threads::ToolUse`: one tool call in a reply. */
export type ToolUse = { name: string; arguments: unknown; error?: boolean };

/** Mirrors `threads::Quote`: where in a document a paragraph thread sits. */
export type Quote = { exact: string; prefix: string; suffix: string; line: number };

/** Mirrors `threads::Anchor`: what a thread is about. */
export type Anchor = {
  kind: "doc" | "paragraph" | "feed" | "clip" | "idea";
  /** A vault path (a paragraph's document), a Feed item's id or an idea's id. */
  path: string;
  label?: string;
  quote?: Quote;
  /** A paragraph thread whose paragraph is gone. */
  orphaned?: boolean;
};

/** Mirrors `threads::Meta` (with `Listed`'s `hit`). */
export type Thread = {
  id: string;
  title: string;
  titled?: boolean;
  anchor?: Anchor;
  status: "open" | "resolved";
  /** "chat", "discuss", "mention", "ask", "review", "helper" or "earlier". */
  origin: string;
  created: string;
  updated: string;
  resolved?: string;
  entries: number;
  preview: string;
  /** A search's best match in it. */
  hit?: string;
};

export type RunningTurn = { turn: string; thread: string; answers: number[] };

/** Mirrors `chat::List`. */
export type ThreadList = { threads: Thread[]; running: string[]; reviewing: string[] };

/** Mirrors `chat::View`. */
export type ThreadView = { thread: Thread; entries: Entry[]; pending: number[]; running: RunningTurn | null };

export type Filter = { about?: string; query?: string; resolved?: boolean; limit?: number };

/** How a new thread starts: what it's about, and from where. */
export type Start = { anchor?: Anchor | null; origin?: "chat" | "discuss" | "mention" | "ask" };

/** Mirrors `jobs::Job`. */
export type Job = {
  id: string;
  kind: string;
  task: string;
  brief: string;
  about: string;
  thread?: string;
  status: "queued" | "running" | "waiting" | "done" | "failed" | "cancelled";
  created: string;
  started?: string;
  finished?: string;
  result?: string;
  error?: string;
  usd: number;
  attempts: number;
};

export type NewJob = { kind: string; brief: string; task?: "chat" | "ideas" | "triage"; about?: string; thread?: string };

/** Mirrors `chat::ChatEvent`, on the `kin:chat` app event. */
export type ChatEvent =
  | { type: "entry"; entry: Entry }
  | { type: "thread"; thread: Thread }
  | { type: "threads" }
  | { type: "turnStarted"; turn: string; thread: string; answers: number[] }
  | { type: "turn"; turn: string; thread: string; event: KinEvent }
  | { type: "turnEnded"; turn: string; thread: string }
  | { type: "reviewStarted"; turn: string; path: string }
  | { type: "reviewEnded"; turn: string; path: string }
  | { type: "job"; job: Job }
  /** Another vault was opened: its threads are the ones now. */
  | { type: "switched" };

export const threads = {
  list: (filter: Filter = {}) => invoke<ThreadList>("kin_threads", { filter }),
  get: (id: string) => invoke<ThreadView>("kin_thread", { id }),
  /** In `thread`, or (null) in a new thread about `start.anchor`. On disk at
   *  once; Kin answers once he pauses. */
  send: (thread: string | null, text: string, chips: Chip[], start: Start = {}) =>
    invoke<{ thread: Thread; entry: Entry }>("kin_thread_send", { thread, text, chips, start }),
  /** A keystroke in a thread: Kin stops talking there and waits. */
  typing: (thread: string) => invoke<void>("kin_thread_typing", { thread }),
  stop: (thread: string) => invoke<void>("kin_thread_stop", { thread }),
  /** Ask again after a failed, stopped or missing reply. */
  again: (thread: string) => invoke<Entry | null>("kin_thread_again", { thread }),
  update: (id: string, change: { title?: string; status?: Thread["status"] }) => invoke<Thread>("kin_thread_update", { id, ...change }),
  moved: (path: string, moves: { id: string; anchor: Quote; orphaned: boolean }[]) => invoke<void>("kin_thread_moved", { path, moves }),
  review: (path: string, paragraphs: { anchor: Quote; lines: [number, number] }[], chips: Chip[]) => invoke<Thread>("kin_review", { path, paragraphs, chips }),
  reviewStop: (path: string) => invoke<void>("kin_review_stop", { path }),
};

/** Helper jobs: background work as its own agent, reporting back in a
 *  thread. The Feed's ranking and Ideas start them here. */
export const jobs = {
  create: (job: NewJob) => invoke<Job>("kin_job_create", { job }),
  list: () => invoke<Job[]>("kin_jobs"),
  cancel: (id: string) => invoke<Job | null>("kin_job_cancel", { id }),
};

/** The thread a chip is about: a paragraph or selection chip is about its document. */
export function anchorOf(chip: Chip | undefined): Anchor | null {
  if (!chip?.path.trim()) return null;
  if (chip.kind === "doc" || chip.kind === "paragraph" || chip.kind === "selection")
    return { kind: "doc", path: chip.path, label: chip.kind === "doc" ? chip.label : undefined };
  if (chip.kind === "clip" || chip.kind === "feed" || chip.kind === "idea") return { kind: chip.kind, path: chip.path, label: chip.label };
  return null;
}

// --- What's on screen -------------------------------------------------------

type Source = () => Chip[];
const sources = new Map<string, Source>();
const SCREEN = "kintsugi:screen";

/** Everything on screen now, in the order the screens registered. */
export function screenChips(): Chip[] {
  return [...sources.values()].flatMap((source) => {
    try {
      return source();
    } catch {
      return [];
    }
  });
}

/** Tells Kin that what's on screen changed. */
export const screenChanged = () => window.dispatchEvent(new CustomEvent(SCREEN));

export function onScreenChanged(listener: () => void) {
  window.addEventListener(SCREEN, listener);
  return () => window.removeEventListener(SCREEN, listener);
}

/**
 * A screen says what it shows. `source` is read when Kin needs it (so an
 * editor's selection is current); `deps` changing announces a new screen.
 */
export function useScreenContext(id: string, source: Source | null, deps: unknown[]) {
  const latest = useRef(source);
  latest.current = source;
  useEffect(() => {
    if (!latest.current) return;
    sources.set(id, () => latest.current?.() ?? []);
    screenChanged();
    return () => {
      sources.delete(id);
      screenChanged();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, !source, ...deps]);
}

// --- Opening Kin --------------------------------------------------------------

const DISCUSS = "kintsugi:discuss";
const OPEN = "kintsugi:open-kin";
const THREAD = "kintsugi:open-thread";
const ASKED = "kintsugi:kin-asked";

/**
 * A new thread, started from somewhere: `chips` go with its first message,
 * `anchor` is what it's about (else the first chip's subject). `send`
 * sends `text` at once: for a question he picked from a menu ("Who
 * disagrees?"), rather than one he's still to write.
 */
export type Discuss = { chips: Chip[]; text?: string; send?: boolean; anchor?: Anchor | null; origin?: Start["origin"] };

/**
 * Opens Kin on a new thread about these items. Anything with a Discuss
 * button calls this: clips, ideas, the editor's ⌘K and `@Kin`, and the Feed
 * (KI-25) with `{ kind: "feed", path: <item id>, label: <title> }`.
 */
export function discuss(chips: Chip | Chip[], text?: string, options: { send?: boolean; anchor?: Anchor | null; origin?: Start["origin"] } = {}) {
  window.dispatchEvent(
    new CustomEvent<Discuss>(DISCUSS, { detail: { chips: Array.isArray(chips) ? chips : [chips], text, send: options.send, anchor: options.anchor, origin: options.origin } }),
  );
}

export function onDiscuss(listener: (d: Discuss) => void) {
  const handler = (e: Event) => listener((e as CustomEvent<Discuss>).detail);
  window.addEventListener(DISCUSS, handler);
  return () => window.removeEventListener(DISCUSS, handler);
}

/** Opens Kin with whatever is on screen: where it was, or (`"list"`) on
 *  the screen's threads. */
export const openKin = (show?: "list") => window.dispatchEvent(new CustomEvent<"list" | undefined>(OPEN, { detail: show }));

export function onOpenKin(listener: (show?: "list") => void) {
  const handler = (e: Event) => listener((e as CustomEvent<"list" | undefined>).detail);
  window.addEventListener(OPEN, handler);
  return () => window.removeEventListener(OPEN, handler);
}

/** Opens one thread in Kin: a paragraph's gutter mark, a "Kin replied" chip. */
export const openThread = (id: string) => window.dispatchEvent(new CustomEvent<string>(THREAD, { detail: id }));

export function onOpenThread(listener: (id: string) => void) {
  const handler = (e: Event) => listener((e as CustomEvent<string>).detail);
  window.addEventListener(THREAD, handler);
  return () => window.removeEventListener(THREAD, handler);
}

/**
 * A quick ask: sends `text` in a new thread without opening Kin. The
 * editor shows a "Kin replied" chip under the passage, which opens it.
 */
export async function ask(text: string, chips: Chip[], anchor: Anchor | null) {
  const sent = await threads.send(null, text, chips, { anchor, origin: "ask" });
  window.dispatchEvent(new CustomEvent<Thread>(ASKED, { detail: sent.thread }));
  return sent.thread;
}

export function onAsked(listener: (thread: Thread) => void) {
  const handler = (e: Event) => listener((e as CustomEvent<Thread>).detail);
  window.addEventListener(ASKED, handler);
  return () => window.removeEventListener(ASKED, handler);
}
