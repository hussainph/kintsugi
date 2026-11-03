import { StateEffect, StateField, type EditorState } from "@codemirror/state";

/**
 * Passages held while something works on them (KI-80): ⌘K's Refine keeps its
 * selection here while the model thinks. Each one moves with every change to
 * the document, as comment anchors do, so text added or removed above it (an
 * undo, phone sync, an outside edit) doesn't leave it pointing at other words.
 */
export type Passage = { from: number; to: number };

let next = 0;

const hold = StateEffect.define<{ id: number; from: number; to: number }>();
const release = StateEffect.define<number>();

export const heldPassages = StateField.define<ReadonlyMap<number, Passage>>({
  create: () => new Map(),
  update(value, tr) {
    let out = value;
    if (tr.docChanged && value.size) {
      const mapped = new Map<number, Passage>();
      for (const [id, range] of value) {
        // Text typed right at either edge stays outside the passage.
        const from = tr.changes.mapPos(range.from, 1);
        const to = Math.max(from, tr.changes.mapPos(range.to, -1));
        mapped.set(id, { from, to });
      }
      out = mapped;
    }
    for (const effect of tr.effects) {
      if (effect.is(hold)) out = new Map(out).set(effect.value.id, { from: effect.value.from, to: effect.value.to });
      else if (effect.is(release) && out.has(effect.value)) {
        const rest = new Map(out);
        rest.delete(effect.value);
        out = rest;
      }
    }
    return out;
  },
});

/** Starts holding `from`–`to`: dispatch `effect`, then read it back with `heldPassage(state, id)`. */
export function holdPassage(from: number, to: number) {
  const id = ++next;
  return { id, effect: hold.of({ id, from, to }) };
}

export const releasePassage = (id: number) => release.of(id);

/** Where a held passage is now, if it still reads `text`. Null when it was
 *  edited, deleted, or this state (another document) never held it. */
export function heldPassage(state: EditorState, id: number, text: string): Passage | null {
  const range = state.field(heldPassages, false)?.get(id);
  if (!range || state.sliceDoc(range.from, range.to) !== text) return null;
  return range;
}
