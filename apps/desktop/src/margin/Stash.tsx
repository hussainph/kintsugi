import type { EditorView } from "@codemirror/view";
import type { RefObject } from "react";

/** The open draft, for tabs that work on it; null away from the editor. */
export type MarginWriting = { viewRef: RefObject<EditorView | null>; path: string } | null;
