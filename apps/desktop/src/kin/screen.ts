import type { EditorView } from "@codemirror/view";
import { field } from "@kintsugi/core/frontmatter";
import { selectionChip, type Chip } from "@/lib/chips";

/** What the editor shows: the selected passage (if any), then the document. */
export function editorChips(view: EditorView | null, path: string): Chip[] {
  if (!view) return [docChip(null, path)];
  const { from, to, empty } = view.state.selection.main;
  return empty ? [docChip(view, path)] : passageChips(view, path, from, to);
}

/** A passage of the document (⌘K's range, `@Kin`'s paragraph), then the document. */
export function passageChips(view: EditorView, path: string, from: number, to: number): Chip[] {
  const { state } = view;
  const chip = selectionChip(path, state.sliceDoc(from, to), state.doc.lineAt(from).number, state.doc.lineAt(to).number);
  return chip ? [chip, docChip(view, path)] : [docChip(view, path)];
}

export function docChip(view: EditorView | null, path: string): Chip {
  const name = path.replace(/^.*\//, "").replace(/\.mdx?$/, "");
  const title = view && field(view.state.doc.toString(), "title");
  return { kind: "doc", path, label: typeof title === "string" && title.trim() ? title.trim() : name };
}
