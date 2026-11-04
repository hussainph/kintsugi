import type { EditorView } from "@codemirror/view";
import { paragraphAnchor, reviewParagraphs, startComment } from "@kintsugi/editor/Editor";
import { toast } from "sonner";
import { type Anchor, openKin, threads } from "@/lib/chat";
import { docChip } from "@/kin/screen";

/**
 * Kin's threads on paragraphs (KI-38, threads since KI-104). A thread
 * anchored to a paragraph shows as a gutter mark in the editor and opens in
 * the Kin tab; the commands live in `src-tauri/src/ai/chat.rs`.
 */

let origin: "mention" | "discuss" = "mention";

/** How the next paragraph thread started; read once by the composer. */
export function takeOrigin() {
  const value = origin;
  origin = "mention";
  return value;
}

/** Opens Kin on a new thread about the paragraph at `from`: `@Kin` and ⌘K's
 *  "Discuss this paragraph". */
export function beginComment(view: EditorView, from: number, to: number, how: "mention" | "discuss") {
  origin = how;
  if (!startComment(view, from, to)) {
    origin = "mention";
    toast("Put the cursor in a paragraph to ask Kin about it.");
  }
}

/** The paragraph a thread started from `from`–`to` is about (a selected
 *  passage goes with the message as a chip). */
export function passageAnchor(view: EditorView, path: string, from: number, to: number): Anchor | null {
  const found = paragraphAnchor(view.state, from, to);
  return found ? { kind: "paragraph", path, quote: found.anchor } : null;
}

/** "Kin, review this draft": Kin reads it and starts threads on the
 *  paragraphs that need a note. The Kin tab shows it working. */
export function reviewDraft(view: EditorView, path: string) {
  const paragraphs = reviewParagraphs(view.state);
  if (!paragraphs.length) {
    toast("Write a paragraph or two first, then ask for a review.");
    return;
  }
  openKin("list");
  threads.review(path, paragraphs, [docChip(view, path)]).catch((error) => toast.error(String(error)));
}
