import type { EditorView } from "@codemirror/view";
import type { RefObject } from "react";

/** The open draft, for tabs that work on it; null away from the editor. */
export type MarginWriting = { viewRef: RefObject<EditorView | null>; path: string } | null;

/** The Stash tab. KI-89 fills it: the cursor's versions on top, the shared
 *  stash below. */
export function StashTab(_: { writing: MarginWriting }) {
  return <p className="ki-margin-empty">Nothing stashed yet.</p>;
}
