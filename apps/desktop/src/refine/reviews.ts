import type { EditorView } from "@codemirror/view";
import { setMarks } from "@kintsugi/editor/Editor";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { useSyncExternalStore } from "react";
import { threads, type ChatEvent, type Suggestion } from "@/lib/chat";
import { docChip } from "@/kin/screen";
import { parseReview, relocate, reviewScope, reviewSentences, type ReviewKind } from "./review";
import type { Sentence } from "@kintsugi/editor/marks";

/**
 * Reviews under way and their answers (KI-109), for the session. A review
 * belongs to its document: switching tabs, margins or documents while Kin
 * reads doesn't lose it, and its marks land when that document is showing.
 * Nothing here is written anywhere.
 */

type Pending = { path: string; turn: string | null; doc: string; sentences: Sentence[]; label: string };

const pending = new Map<string, Pending>();
const ready = new Map<string, { asked: Pending; suggestions: Suggestion[] }>();
const listeners = new Set<() => void>();
let version = 0;

function changed() {
  version++;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Whether Kin is reviewing `path` now. */
export function useReviewing(path: string | null): boolean {
  useSyncExternalStore(subscribe, () => version);
  return !!path && pending.has(path);
}

let listening = false;
function listenOnce() {
  if (listening) return;
  listening = true;
  void listen<ChatEvent>("kin:chat", ({ payload: event }) => {
    if (event.type === "switched") {
      pending.clear();
      ready.clear();
      changed();
      return;
    }
    if (event.type !== "reviewEnded") return;
    const asked = pending.get(event.path);
    if (!asked || (asked.turn && asked.turn !== event.turn)) return;
    pending.delete(event.path);
    if (event.error) toast.error(event.error);
    else if (!event.stopped) ready.set(event.path, { asked, suggestions: event.suggestions ?? [] });
    changed();
  });
}

/** Asks Kin to review `path`'s draft, or the section the cursor is in. */
export async function startReview(view: EditorView, path: string, kind: ReviewKind) {
  listenOnce();
  if (pending.has(path)) {
    toast("Kin is already reviewing this draft.");
    return;
  }
  const doc = view.state.doc.toString();
  const { from, to } = view.state.selection.main;
  const { range, scope, label } = reviewScope(doc, kind, { from, to });
  const sentences = reviewSentences(doc, range);
  if (!sentences.length) {
    toast("Write a paragraph or two first, then ask for a review.");
    return;
  }
  const asked: Pending = { path, turn: null, doc, sentences, label };
  pending.set(path, asked);
  changed();
  try {
    asked.turn = await threads.review(path, sentences.map(({ n, text }) => ({ n, text })), scope, [docChip(view, path)]);
  } catch (error) {
    if (pending.get(path) === asked) pending.delete(path);
    changed();
    toast.error(String(error));
  }
}

export function stopReview(path: string) {
  void threads.reviewStop(path).catch((error) => toast.error(String(error)));
}

/** Shows `path`'s finished review on `view` (its document, showing now),
 *  if one is waiting. The sentences are found again if he edited meanwhile. */
export function showReview(view: EditorView, path: string): boolean {
  const done = ready.get(path);
  if (!done) return false;
  ready.delete(path);
  const text = view.state.doc.toString();
  const sentences = text === done.asked.doc ? done.asked.sentences : relocate(done.asked.sentences, text);
  const batch = `review-${Date.now().toString(36)}`;
  const { marks } = parseReview(done.suggestions, text, sentences, batch);
  if (!marks.length) {
    toast("Kin found nothing to suggest.");
    return false;
  }
  const scope = { from: Math.min(...marks.map((m) => m.range.from)), to: Math.max(...marks.map((m) => m.range.to)) };
  setMarks(view, { id: batch, label: done.asked.label, kind: "review", scope }, marks, { focus: "first" });
  return true;
}

/** Re-renders when a review finishes, so the editor can show it. */
export function useReviewVersion(): number {
  listenOnce();
  return useSyncExternalStore(subscribe, () => version);
}

// The Kin tab asks through the open editor, which knows the cursor.
type Asker = (kind: ReviewKind) => void;
const askers = new Map<string, Asker>();

export function registerReviewer(path: string, ask: Asker) {
  askers.set(path, ask);
  return () => {
    if (askers.get(path) === ask) askers.delete(path);
  };
}

/** "Review this draft" from the Kin tab: false when the draft isn't open. */
export function requestReview(path: string, kind: ReviewKind): boolean {
  const ask = askers.get(path);
  if (!ask) return false;
  ask(kind);
  return true;
}
