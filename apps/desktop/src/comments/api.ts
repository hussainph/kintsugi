import type { EditorView } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { reviewParagraphs, startComment, type CommentAnchor, type CommentMove } from "@kintsugi/editor/Editor";
import { toast } from "sonner";
import type { Chip } from "@/lib/chips";
import type { Entry } from "@/lib/chat";
import { docChip } from "@/kin/screen";

/**
 * Kin's comment threads on paragraphs (KI-38). Threads are stored beside
 * the document in `.kintsugi/comments/` and their messages are entries in
 * Kin's one conversation log; the commands live in
 * `src-tauri/src/ai/chat/comments.rs`.
 */

/** Mirrors `comments::Thread` plus its log entries (`chat::comments::View`). */
export type StoredThread = {
  id: string;
  anchor: CommentAnchor;
  status: "open" | "resolved";
  origin: string;
  created: string;
  resolved?: string;
  orphaned?: boolean;
  entries: Entry[];
};

export type CommentsPage = { path: string; threads: StoredThread[]; running: { turn: string; comment: string | null }[] };

export const comments = {
  list: (path: string) => invoke<CommentsPage>("kin_comments", { path }),
  create: (path: string, anchor: CommentAnchor, origin: string, text: string, chips: Chip[]) =>
    invoke<StoredThread>("kin_comment_create", { path, anchor, origin, text, chips }),
  reply: (path: string, id: string, text: string, chips: Chip[]) => invoke<Entry | null>("kin_comment_reply", { path, id, text, chips }),
  status: (path: string, id: string, status: "open" | "resolved") => invoke("kin_comment_status", { path, id, status }),
  moved: (path: string, moves: CommentMove[]) => invoke<void>("kin_comment_moved", { path, moves }),
  stop: (path: string, id: string | null) => invoke<void>("kin_comment_stop", { path, id }),
  review: (path: string, paragraphs: ReturnType<typeof reviewParagraphs>, chips: Chip[]) => invoke<Entry>("kin_comment_review", { path, paragraphs, chips }),
};

let origin = "mention";

/** How the next thread started; the composer's send reads it once. */
export function takeOrigin() {
  const value = origin;
  origin = "mention";
  return value;
}

/** Opens Kin's composer on the paragraph at `from`: `@Kin` and ⌘K's
 *  "Discuss this paragraph". */
export function beginComment(view: EditorView, from: number, to: number, how: "mention" | "discuss") {
  origin = how;
  if (!startComment(view, from, to)) {
    origin = "mention";
    toast("Put the cursor in a paragraph to ask Kin about it.");
  }
}

/** "Kin, review this draft": Kin reads it and leaves comment threads. */
export function reviewDraft(view: EditorView, path: string) {
  const paragraphs = reviewParagraphs(view.state);
  if (!paragraphs.length) {
    toast("Write a paragraph or two first, then ask for a review.");
    return;
  }
  comments.review(path, paragraphs, [docChip(view, path)]).catch((error) => toast.error(String(error)));
}
