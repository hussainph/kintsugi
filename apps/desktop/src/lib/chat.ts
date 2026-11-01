import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import type { Chip } from "./chips";
import type { KinEvent } from "./kin";

/** Mirrors `history::Entry` in src-tauri/src/ai/history.rs. */
export type Entry = {
  seq: number;
  at: string;
  role: "owner" | "kin" | "helper";
  text: string;
  chips?: Chip[];
  /** The inferred thread; "" when about nothing in particular. */
  topic: string;
  answers?: number[];
  interrupted?: boolean;
  error?: string;
  job?: string;
  usd?: number;
};

/** Mirrors `history::Thread`: a view of the one log, with a running summary. */
export type Thread = {
  key: string;
  kind: string;
  label: string;
  summary: string;
  summarizedThrough: number;
  entries: number;
  lastSeq: number;
  lastAt: string;
};

export type Topic = { key: string; kind: string; label: string };

export type RunningTurn = { turn: string; answers: number[]; topic: string };

/** Mirrors `chat::Page`. */
export type Page = { entries: Entry[]; threads: Thread[]; pending: number[]; running: RunningTurn | null };

/** Mirrors `jobs::Job`. */
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
  usd: number;
  attempts: number;
};

export type NewJob = { kind: string; brief: string; task?: "chat" | "ideas" | "triage"; topic?: string };

export type Hit = { seq: number; at: string; role: Entry["role"]; topic: string; snippet: string };

/** Mirrors `chat::ChatEvent`, on the `kin:chat` app event. */
export type ChatEvent =
  | { type: "entry"; entry: Entry }
  | { type: "turnStarted"; turn: string; answers: number[]; topic: string }
  | { type: "turn"; turn: string; event: KinEvent }
  | { type: "turnEnded"; turn: string }
  | { type: "thread"; thread: Thread }
  | { type: "job"; job: Job };

export const chat = {
  /** Lands in the log at once; Kin answers once he pauses. */
  send: (text: string, chips: Chip[]) => invoke<Entry>("kin_chat_send", { text, chips }),
  /** A keystroke: Kin stops talking and waits. */
  typing: () => invoke<void>("kin_chat_typing"),
  stop: () => invoke<void>("kin_chat_stop"),
  log: (topic: string | null, before?: number, limit = 200) => invoke<Page>("kin_chat_log", { topic, before, limit }),
  topic: (chips: Chip[]) => invoke<Topic>("kin_chat_topic", { chips }),
  search: (query: string, topic?: string) => invoke<Hit[]>("kin_chat_search", { query, topic }),
};

/** Helper jobs: background work as its own agent, reporting back quietly
 *  into the conversation. The Feed's ranking and Ideas start them here. */
export const jobs = {
  create: (job: NewJob) => invoke<Job>("kin_job_create", { job }),
  list: () => invoke<Job[]>("kin_jobs"),
  cancel: (id: string) => invoke<Job | null>("kin_job_cancel", { id }),
};

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

/** Tells the chat that what's on screen changed. */
export const screenChanged = () => window.dispatchEvent(new CustomEvent(SCREEN));

export function onScreenChanged(listener: () => void) {
  window.addEventListener(SCREEN, listener);
  return () => window.removeEventListener(SCREEN, listener);
}

/**
 * A screen says what it shows. `source` is read when the chat needs it (so
 * an editor's selection is current); `deps` changing announces a new screen.
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

// --- Discuss ----------------------------------------------------------------

const DISCUSS = "kintsugi:discuss";
const OPEN = "kintsugi:open-kin";

export type Discuss = { chips: Chip[]; text?: string };

/**
 * Opens the chat with these items attached, first among the chips. Anything
 * with a Discuss button calls this: clips here, and the Feed (KI-25) with
 * `{ kind: "feed", path: <item id>, label: <title> }`.
 */
export function discuss(chips: Chip | Chip[], text?: string) {
  window.dispatchEvent(new CustomEvent<Discuss>(DISCUSS, { detail: { chips: Array.isArray(chips) ? chips : [chips], text } }));
}

export function onDiscuss(listener: (d: Discuss) => void) {
  const handler = (e: Event) => listener((e as CustomEvent<Discuss>).detail);
  window.addEventListener(DISCUSS, handler);
  return () => window.removeEventListener(DISCUSS, handler);
}

/** Opens the chat with whatever is on screen. */
export const openKin = () => window.dispatchEvent(new CustomEvent(OPEN));

export function onOpenKin(listener: () => void) {
  window.addEventListener(OPEN, listener);
  return () => window.removeEventListener(OPEN, listener);
}
