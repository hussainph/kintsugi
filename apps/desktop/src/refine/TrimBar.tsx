import type { EditorView } from "@codemirror/view";
import { applyMarks, clearMarks } from "@kintsugi/editor/Editor";
import { Button } from "@kintsugi/ui/components/button";
import { Kbd } from "@kintsugi/ui/components/kbd";
import { keysOf } from "@/lib/keys";
import { SHORTCUTS } from "@/lib/shortcuts";

export type TrimCount = { before: number; after: number };

/** A trim's preview (KI-90): the word count before and after the cuts
 *  struck through in gold, with Apply and Cancel. Clicking a struck word
 *  keeps it, and the count follows. */
export function TrimBar({ view, count }: { view: EditorView; count: TrimCount }) {
  const done = () => requestAnimationFrame(() => view.focus());
  return (
    <div className="ki-trim-bar" role="group" aria-label="Trim">
      <span className="ki-data ki-text-xs" aria-live="polite">
        {count.before} → {count.after} words
      </span>
      <Button variant="ghost" size="sm" onClick={() => { clearMarks(view); done(); }}>
        Cancel <Kbd>Esc</Kbd>
      </Button>
      <Button size="sm" disabled={view.state.readOnly} onClick={() => { applyMarks(view); done(); }}>
        Apply cuts <Kbd>{keysOf(SHORTCUTS.applyCuts.key)}</Kbd>
      </Button>
    </div>
  );
}
