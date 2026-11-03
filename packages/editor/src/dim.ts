import { EditorSelection, EditorState, Facet, Prec, RangeSet, RangeSetBuilder, StateField, Transaction, type ChangeSpec, type Extension, type StateCommand, type TransactionSpec } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { dimSyntax, scanSpans, type Dimmed, type Span } from "@kintsugi/core/dim";
import { splitFrontmatter } from "@kintsugi/core/frontmatter";
import { MARKER } from "./markers.ts";

/** Dimmed text (KI-88). A passage set aside in place is a comment in the
 *  file: `<!-- … -->` in `.md`, `{/* … *\/}` in `.mdx` (core's dim.ts, which
 *  also reads `%%…%%`). The editor hides the markers and shows the text
 *  faded, still selectable and editable. ⌘/ dims the selection, or the line
 *  the cursor is on, and undims a passage the cursor is in or beside. */

/** The open document's path, which picks the comment syntax. */
export const dimPath = Facet.define<string, string>({ combine: (values) => values[0] ?? "" });

type Scan = { comments: Dimmed[]; code: Span[]; body: number };

function scan(state: EditorState): Scan {
  const text = state.doc.toString();
  const body = splitFrontmatter(text).head.length;
  const found = scanSpans(text.slice(body));
  const comments = found.comments.map((s) => ({ ...s, from: s.from + body, to: s.to + body, inner: s.inner + body, innerTo: s.innerTo + body }));
  const code = found.code.map((s) => ({ from: s.from + body, to: s.to + body }));
  return { comments, code, body };
}

const dimField = StateField.define<Scan>({
  create: scan,
  update: (value, tr) => (tr.docChanged ? scan(tr.state) : value),
});

/** The comments in a state's document, positions in the whole document. */
export function dimmedRanges(state: EditorState): readonly Dimmed[] {
  return (state.field(dimField, false) ?? scan(state)).comments;
}

const dimmedMark = Decoration.mark({ class: "cm-dimmed" });
const hidden = Decoration.replace({});

/** A finished comment's markers are hidden; an `<!--` still being typed
 *  keeps its marker so it's clear why the rest went faint. */
function decorations(value: Scan): { marks: DecorationSet; markers: RangeSet<Decoration> } {
  const marks = new RangeSetBuilder<Decoration>();
  const markers = new RangeSetBuilder<Decoration>();
  for (const span of value.comments) {
    if (span.closed) {
      marks.add(span.from, span.inner, hidden);
      markers.add(span.from, span.inner, hidden);
    }
    const from = span.closed ? span.inner : span.from;
    if (span.innerTo > from) marks.add(from, span.innerTo, dimmedMark);
    if (span.closed) {
      marks.add(span.innerTo, span.to, hidden);
      markers.add(span.innerTo, span.to, hidden);
    }
  }
  return { marks: marks.finish(), markers: markers.finish() };
}

const decorationField = StateField.define<{ marks: DecorationSet; markers: RangeSet<Decoration> }>({
  create: (state) => decorations(state.field(dimField)),
  update: (value, tr) => (tr.docChanged ? decorations(tr.state.field(dimField)) : value),
  provide: (field) => [
    // Outside the syntax highlighting, so every comment form fades the same.
    Prec.high(EditorView.decorations.from(field, (value) => value.marks)),
    // The cursor steps over a hidden marker in one move.
    EditorView.atomicRanges.of((view) => view.state.field(field).markers),
  ],
});

/** Deleting one marker of a dimmed passage, such as ⌫ at its start, takes
 *  the other with it: the passage comes back. A deletion that cuts into the
 *  passage from outside keeps what's left of it dimmed. */
const keepPairs = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || tr.annotation(Transaction.remote) || tr.isUserEvent("input.dim") || tr.isUserEvent("input.undim") || !(tr.isUserEvent("input") || tr.isUserEvent("delete"))) return tr;
  const comments = tr.startState.field(dimField).comments;
  const removed: { from: number; to: number }[] = [];
  tr.changes.iterChangedRanges((from, to) => {
    if (to > from) removed.push({ from, to });
  });
  if (!removed.length) return tr;
  const extra: ChangeSpec[] = [];
  for (const span of comments) {
    if (!span.closed || span.from >= removed[removed.length - 1].to || span.to <= removed[0].from) continue;
    const cut = removed.filter((r) => r.from < span.to && r.to > span.from);
    if (!cut.length) continue;
    const open = cut.find((r) => r.from < span.inner && r.to > span.from);
    const close = cut.find((r) => r.from < span.to && r.to > span.innerTo);
    if (open && close) continue; // the whole passage, or both markers
    if (open) {
      if (open.to <= span.inner) extra.push({ from: span.innerTo, to: span.to });
      else extra.push({ from: open.to, insert: tr.startState.sliceDoc(span.from, span.inner) });
    } else if (close) {
      if (close.from >= span.innerTo) extra.push({ from: span.from, to: span.inner });
      else extra.push({ from: close.from, insert: tr.startState.sliceDoc(span.innerTo, span.to) });
    }
  }
  return extra.length ? [tr, { changes: extra }] : tr;
});

const theme = EditorView.theme({
  ".cm-dimmed": { opacity: "0.45" },
  ".cm-dimmed *": { color: "inherit" },
});

/** Dimmed text for a document at `path`. */
export function dimExtensions(path: string): Extension {
  return [dimPath.of(path), dimField, decorationField, keepPairs, theme];
}

/** Whether a range touches dimmed text (⌘/ would undim it). */
export function isDimmed(state: EditorState, from: number, to: number): boolean {
  return dimmedRanges(state).some((span) => span.from <= to && from <= span.to);
}

/** The parts of a line to dim for a range on it: the whole line (marker and
 *  all, so no empty item or heading is left behind) when the range is empty
 *  or covers its text, else the selected part. Blank parts are left out. */
function lineSegment(state: EditorState, lineNumber: number, range: { from: number; to: number }): Span | null {
  const line = state.doc.line(lineNumber);
  const indent = /^[ \t]*(?:>[ \t]?)*/.exec(line.text)![0].length;
  const start = line.from + indent;
  const markerEnd = start + (MARKER.exec(line.text.slice(indent))?.[0].length ?? 0);
  let end = line.to;
  while (end > start && /\s/.test(state.sliceDoc(end - 1, end))) end--;
  if (end <= markerEnd) return null;
  if (range.from === range.to || (range.from <= markerEnd && range.to >= end)) return { from: start, to: end };
  let from = Math.max(range.from, markerEnd);
  let to = Math.min(range.to, end);
  while (from < to && /\s/.test(state.sliceDoc(from, from + 1))) from++;
  while (to > from && /\s/.test(state.sliceDoc(to - 1, to))) to--;
  return from < to ? { from, to } : null;
}

/** The change that dims `ranges`, or undims the passages they touch. Null
 *  when there's nothing to do (a blank line, code, the frontmatter). */
export function dimChange(state: EditorState, ranges: readonly { from: number; to: number }[]): { changes: ChangeSpec[]; dim: boolean; starts: Set<number> } | null {
  const value = state.field(dimField, false) ?? scan(state);
  const touched = value.comments.filter((span) => ranges.some((r) => span.from <= r.to && r.from <= span.to));
  if (touched.length) {
    const changes = touched.flatMap((span) => [{ from: span.from, to: span.inner }, ...(span.closed ? [{ from: span.innerTo, to: span.to }] : [])]);
    return { changes, dim: false, starts: new Set() };
  }
  const syntax = dimSyntax(state.facet(dimPath));
  const segments: Span[] = [];
  for (const range of ranges) {
    const first = state.doc.lineAt(range.from).number;
    let last = state.doc.lineAt(range.to).number;
    if (last > first && range.to === state.doc.line(last).from) last--;
    for (let n = first; n <= last; n++) {
      const segment = lineSegment(state, n, range);
      if (!segment || segment.from < value.body) continue;
      if (value.code.some((c) => c.from < segment.to && segment.from < c.to)) continue;
      if (state.sliceDoc(segment.from, segment.to).includes(syntax.close.trim())) continue;
      if (segments.some((s) => s.from < segment.to && segment.from < s.to)) continue;
      segments.push(segment);
    }
  }
  if (!segments.length) return null;
  segments.sort((a, b) => a.from - b.from);
  const changes = segments.flatMap((s) => [{ from: s.from, insert: syntax.open }, { from: s.to, insert: syntax.close }]);
  return { changes, dim: true, starts: new Set(segments.map((s) => s.from)) };
}

/** The transaction for `dimChange`, keeping the selection on the same text. */
export function dimTransaction(state: EditorState, ranges: readonly { from: number; to: number }[]): TransactionSpec | null {
  const change = dimChange(state, ranges);
  if (!change) return null;
  const set = state.changes(change.changes);
  const map = (pos: number) => set.mapPos(pos, change.starts.has(pos) ? 1 : -1);
  const selection = change.dim
    ? EditorSelection.create(state.selection.ranges.map((r) => EditorSelection.range(map(r.anchor), map(r.head))), state.selection.mainIndex)
    : state.selection.map(set);
  return { changes: set, selection, userEvent: change.dim ? "input.dim" : "input.undim", scrollIntoView: true };
}

/** ⌘/: dims the selection, or the cursor's line; undims dimmed text the
 *  selection or cursor touches. One undo step either way. */
export const toggleDim: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  const spec = dimTransaction(state, state.selection.ranges);
  if (!spec) return false;
  dispatch(state.update(spec));
  return true;
};

/** Dims or undims `from`–`to` in a view, as ⌘K does for its passage. */
export function toggleDimRange(view: EditorView, from: number, to: number): boolean {
  if (view.state.readOnly) return false;
  const spec = dimTransaction(view.state, [{ from, to }]);
  if (!spec) return false;
  view.dispatch({ ...spec, selection: undefined });
  return true;
}
