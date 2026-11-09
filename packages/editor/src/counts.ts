import { StateField, type EditorState, type Transaction } from "@codemirror/state";
import { body, countWords } from "@kintsugi/core/frontmatter";
import { cutRange, type Span } from "@kintsugi/core/dim";
import { dimmedRanges } from "./dim.ts";

export type DocumentCount = {
  words: number;
  selection: { words: number; characters: number } | null;
};

type Snapshot = { bodyFrom: number; excluded: Span[]; words: number };
type Counts = DocumentCount & { snapshot: Snapshot };

/** Read only the selected pieces, even when a selection starts inside a comment. */
function visible(state: EditorState, from: number, to: number, excluded: readonly Span[]): string {
  let text = "";
  for (const span of excluded) {
    if (span.to <= from) continue;
    if (span.from >= to) break;
    text += state.sliceDoc(from, Math.max(from, span.from));
    from = Math.min(to, span.to);
  }
  return text + state.sliceDoc(from, to);
}

function snapshot(state: EditorState, previous?: Snapshot, tr?: Transaction): Snapshot {
  const text = state.doc.toString();
  const bodyFrom = text.length - body(text).length;
  // Reuse the editor's comment scan. Selection changes never enter here.
  const excluded = dimmedRanges(state).map((span) => cutRange(text, span));
  let words: number;
  if (tr && previous && !excluded.length && !previous.excluded.length && bodyFrom === previous.bodyFrom) {
    // Normal typing only recounts the touched lines. Syntax/frontmatter changes
    // use the full path, since they can change what counts far from the edit.
    const windows: { a: Span; b: Span }[] = [];
    tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
      const a = { from: tr.startState.doc.lineAt(fromA).from, to: tr.startState.doc.lineAt(toA).to };
      const b = { from: state.doc.lineAt(fromB).from, to: state.doc.lineAt(toB).to };
      const last = windows.at(-1);
      if (last && (a.from <= last.a.to || b.from <= last.b.to)) {
        last.a.to = a.to;
        last.b.to = b.to;
      } else windows.push({ a, b });
    });
    words = previous.words;
    for (const { a, b } of windows) {
      words -= countWords(tr.startState.sliceDoc(Math.max(bodyFrom, a.from), Math.max(bodyFrom, a.to)));
      words += countWords(state.sliceDoc(Math.max(bodyFrom, b.from), Math.max(bodyFrom, b.to)));
    }
  } else words = countWords(visible(state, bodyFrom, state.doc.length, excluded));
  return { bodyFrom, excluded, words };
}

function count(state: EditorState, snapshot: Snapshot): Counts {
  let selected = false;
  let words = 0;
  let characters = 0;
  for (const range of state.selection.ranges) {
    if (range.empty) continue;
    selected = true;
    const from = Math.max(snapshot.bodyFrom, range.from);
    const to = Math.max(from, range.to);
    words += countWords(visible(state, from, to, snapshot.excluded));
    // Source characters, including whitespace and dimmed text. Count Unicode
    // code points so a surrogate pair (e.g. an emoji) is not counted twice.
    for (const _ of state.sliceDoc(from, to)) characters++;
  }
  return { snapshot, words: snapshot.words, selection: selected ? { words, characters } : null };
}

/** One cache per document, retained with its editor state when switching files. */
export const documentCounts = StateField.define<Counts>({
  create: (state) => count(state, snapshot(state)),
  update: (value, tr) => {
    if (!tr.docChanged && !tr.selection) return value;
    const next = tr.docChanged ? snapshot(tr.state, value.snapshot, tr) : value.snapshot;
    return count(tr.state, next);
  },
});
