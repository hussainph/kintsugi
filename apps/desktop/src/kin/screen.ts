import type { EditorView } from "@codemirror/view";
import { field } from "@kintsugi/core/frontmatter";
import { selectionChip, type Chip } from "@/lib/chips";

/** What the editor shows: the selected passage (if any), then the document. */
export function editorChips(view: EditorView | null, path: string): Chip[] {
  const name = path.replace(/^.*\//, "").replace(/\.mdx?$/, "");
  if (!view) return [{ kind: "doc", path, label: name }];
  const { state } = view;
  const title = field(state.doc.toString(), "title");
  const chips: Chip[] = [];
  const { from, to, empty } = state.selection.main;
  if (!empty) {
    const chip = selectionChip(path, state.sliceDoc(from, to), state.doc.lineAt(from).number, state.doc.lineAt(to).number);
    if (chip) chips.push(chip);
  }
  chips.push({ kind: "doc", path, label: typeof title === "string" && title.trim() ? title.trim() : name });
  return chips;
}
