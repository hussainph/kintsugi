import { isolateHistory } from "@codemirror/commands";
import { EditorSelection, Prec, StateEffect, StateField, type ChangeSpec, type EditorState, type Extension, type Transaction } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, keymap, showTooltip, type DecorationSet, type Tooltip, type ViewUpdate } from "@codemirror/view";
import { splitFrontmatter } from "@kintsugi/core/frontmatter";
import { paragraphs, type Range } from "./anchors.ts";
import { isWordChar, sentencesIn } from "./spans.ts";

/**
 * Kin's marks (KI-90): ranges of the draft Kin points at when he asks, drawn
 * in gold. A flag is a gold underline (a check's answer), a cut a gold
 * strike-through (a trim's), a rewrite a span with replacement words
 * (KI-109's review). They are decorations on the open document's state and
 * never part of the text: nothing is saved, and they don't move a line.
 *
 * The model is a list of `{ id, range, kind, reason }` with one focused mark,
 * and four operations a host or KI-109's card drives: `focusMark`,
 * `acceptMark`, `dismissMark` and `applyMarks`. A mark goes on Escape (all of
 * them), on the first edit inside it, or once it's accepted or dismissed;
 * when the last one goes, the batch is done.
 */

export type MarkKind = "cut" | "flag" | "rewrite";

export type Mark = {
  id: string;
  /** Where it is now, in the current document. */
  range: Range;
  kind: MarkKind;
  /** One line on why. A trim's cuts may have none. */
  reason: string;
  /** A rewrite's replacement words. */
  text?: string;
};

/** What asked for a set of marks: a check, a trim, or KI-109's review. */
export type MarkBatch = {
  id: string;
  /** What he chose, as he chose it ("Weakest sentences"). */
  label: string;
  kind: "check" | "trim" | "review";
  /** The passage it covers (the selection, or the draft's body). */
  scope: Range;
};

export type MarksState = {
  batch: MarkBatch | null;
  /** In document order. */
  marks: readonly Mark[];
  focused: string | null;
};

export type Marks = {
  /** Every change to the marks, and the open document's marks when it opens. */
  onChange?: (marks: MarksState, state: EditorState) => void;
  /** "Discuss" on a focused flag: a paragraph thread about it (KI-104). */
  onDiscuss?: (mark: Mark) => void;
};

/** The key specs, for the host's shortcut list. KI-109's card keeps them. */
export const markShortcuts = [
  { key: "Mod-'", label: "Next mark" },
  { key: "Mod-Shift-'", label: "Previous mark" },
  { key: "Alt-Enter", label: "Accept a mark" },
  { key: "Mod-Alt-Backspace", label: "Dismiss a mark" },
  { key: "Mod-Alt-Enter", label: "Apply the cuts" },
] as const;

const EMPTY: MarksState = { batch: null, marks: [], focused: null };

/** Positions are in the document before the transaction's changes. */
const putMarks = StateEffect.define<{ batch: MarkBatch; marks: readonly Mark[]; focused: string | null }>();
const focusEffect = StateEffect.define<string | null>();
const removeEffect = StateEffect.define<readonly string[]>();
const clearEffect = StateEffect.define<null>();

const byPosition = (a: Mark, b: Mark) => a.range.from - b.range.from || a.range.to - b.range.to;

/** Moves marks with an edit; one the edit touches inside is gone. */
function mapMarks(value: MarksState, tr: Transaction): MarksState {
  if (!tr.docChanged || !value.marks.length) return value;
  const touched = new Set<string>();
  tr.changes.iterChangedRanges((fromA, toA) => {
    for (const mark of value.marks) if (fromA < mark.range.to && toA > mark.range.from) touched.add(mark.id);
  });
  const marks: Mark[] = [];
  for (const mark of value.marks) {
    if (touched.has(mark.id)) continue;
    const from = tr.changes.mapPos(mark.range.from, 1);
    const to = tr.changes.mapPos(mark.range.to, -1);
    if (to > from) marks.push({ ...mark, range: { from, to } });
  }
  if (!marks.length) return EMPTY;
  const batch = value.batch && {
    ...value.batch,
    scope: { from: tr.changes.mapPos(value.batch.scope.from, -1), to: tr.changes.mapPos(value.batch.scope.to, 1) },
  };
  const focused = marks.some((m) => m.id === value.focused) ? value.focused : null;
  return { batch, marks, focused };
}

function mapThrough(tr: Transaction, mark: Mark): Mark | null {
  const length = tr.startState.doc.length;
  const from = Math.max(0, Math.min(length, mark.range.from));
  const to = Math.max(from, Math.min(length, mark.range.to));
  const range = { from: tr.changes.mapPos(from, 1), to: tr.changes.mapPos(to, -1) };
  return range.to > range.from ? { ...mark, range } : null;
}

const marksField = StateField.define<MarksState>({
  create: () => EMPTY,
  update(value, tr) {
    let next = mapMarks(value, tr);
    for (const effect of tr.effects) {
      if (effect.is(putMarks)) {
        const marks = effect.value.marks.map((m) => mapThrough(tr, m)).filter((m): m is Mark => !!m).sort(byPosition);
        if (!marks.length) next = EMPTY;
        else {
          const scope = { from: tr.changes.mapPos(effect.value.batch.scope.from, -1), to: tr.changes.mapPos(effect.value.batch.scope.to, 1) };
          next = { batch: { ...effect.value.batch, scope }, marks, focused: marks.some((m) => m.id === effect.value.focused) ? effect.value.focused : null };
        }
      } else if (effect.is(focusEffect)) {
        if (next.focused !== effect.value && (effect.value === null || next.marks.some((m) => m.id === effect.value))) next = { ...next, focused: effect.value };
      } else if (effect.is(removeEffect)) {
        const gone = new Set(effect.value);
        const marks = next.marks.filter((m) => !gone.has(m.id));
        next = marks.length ? { ...next, marks, focused: gone.has(next.focused ?? "") ? null : next.focused } : EMPTY;
      } else if (effect.is(clearEffect)) {
        next = EMPTY;
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field, decorations),
});

/** The marks on a state; empty when the extension isn't installed. */
export function marksOf(state: EditorState): MarksState {
  return state.field(marksField, false) ?? EMPTY;
}

/** The focused mark, if any. */
export function focusedMark(state: EditorState): Mark | null {
  const value = marksOf(state);
  return value.marks.find((m) => m.id === value.focused) ?? null;
}

type Target = Pick<EditorView, "state" | "dispatch">;

/** Shows a batch of marks, replacing any others. Ranges are in the current
 *  document; empty or out-of-range ones are dropped. `focus: "first"`
 *  focuses the first mark and brings it into view. Returns how many show. */
export function setMarks(view: Target, batch: MarkBatch, marks: readonly Mark[], options: { focus?: "first" | null } = {}): number {
  const length = view.state.doc.length;
  const kept = marks.filter((m) => m.range.from >= 0 && m.range.to <= length && m.range.to > m.range.from).slice().sort(byPosition);
  if (!kept.length) {
    view.dispatch({ effects: clearEffect.of(null) });
    return 0;
  }
  const first = options.focus === "first" ? kept[0] : null;
  view.dispatch({
    effects: [putMarks.of({ batch, marks: kept, focused: first?.id ?? null }), ...(first ? [EditorView.scrollIntoView(first.range.from, { y: "center" })] : [])],
  });
  return kept.length;
}

/** Takes every mark away, as Escape does. */
export function clearMarks(view: Target): boolean {
  if (!marksOf(view.state).marks.length) return false;
  view.dispatch({ effects: clearEffect.of(null) });
  return true;
}

/** Focuses a mark by id, or the next (1) or previous (-1) one: after the
 *  focused mark, else after the cursor. Wraps around. */
export function focusMark(view: Target, which: string | 1 | -1): boolean {
  const { marks, focused } = marksOf(view.state);
  if (!marks.length) return false;
  let mark: Mark | undefined;
  if (typeof which === "string") mark = marks.find((m) => m.id === which);
  else {
    const at = marks.findIndex((m) => m.id === focused);
    if (at !== -1) mark = marks[(at + which + marks.length) % marks.length];
    else {
      const head = view.state.selection.main.head;
      mark = which === 1 ? marks.find((m) => m.range.from > head) ?? marks[0] : [...marks].reverse().find((m) => m.range.to < head) ?? marks[marks.length - 1];
    }
  }
  if (!mark) return false;
  view.dispatch({
    effects: [focusEffect.of(mark.id), EditorView.scrollIntoView(mark.range.from, { y: "nearest", yMargin: 80 })],
    selection: EditorSelection.cursor(mark.range.from),
  });
  return true;
}

/** The mark to focus once `id` goes: the next one in the document, else the one before. */
function after(marks: readonly Mark[], ids: ReadonlySet<string>): string | null {
  const at = marks.findIndex((m) => ids.has(m.id));
  const rest = marks.filter((m) => !ids.has(m.id));
  if (!rest.length || at === -1) return null;
  return (rest.find((m) => m.range.from >= marks[at].range.from) ?? rest[rest.length - 1]).id;
}

/** A mark's change: a cut deletes its range, a rewrite replaces it, a flag changes nothing. */
function changeOf(mark: Mark): ChangeSpec | null {
  if (mark.kind === "cut") return { from: mark.range.from, to: mark.range.to };
  if (mark.kind === "rewrite" && mark.text !== undefined) return { from: mark.range.from, to: mark.range.to, insert: mark.text };
  return null;
}

/** Accepts a mark (the focused one by default): a cut goes, a rewrite goes
 *  in, a flag is done. One undo step. The next mark is focused. */
export function acceptMark(view: Target, id?: string): boolean {
  const value = marksOf(view.state);
  const mark = value.marks.find((m) => m.id === (id ?? value.focused));
  if (!mark) return false;
  const change = changeOf(mark);
  if (change && view.state.readOnly) return false;
  const next = value.focused === mark.id ? after(value.marks, new Set([mark.id])) : value.focused;
  view.dispatch({
    ...(change ? { changes: change, annotations: isolateHistory.of("full"), userEvent: mark.kind === "cut" ? "delete.mark" : "input.mark" } : {}),
    effects: [removeEffect.of([mark.id]), ...(next ? [focusEffect.of(next)] : [])],
  });
  return true;
}

/** Dismisses a mark (the focused one by default): it goes and the text
 *  stays as it is; for a cut, its words are kept. The next mark is focused. */
export function dismissMark(view: Target, id?: string): boolean {
  const value = marksOf(view.state);
  const mark = value.marks.find((m) => m.id === (id ?? value.focused));
  if (!mark) return false;
  const next = value.focused === mark.id ? after(value.marks, new Set([mark.id])) : value.focused;
  view.dispatch({ effects: [removeEffect.of([mark.id]), ...(next ? [focusEffect.of(next)] : [])] });
  return true;
}

/** Applies every cut and rewrite as one undoable change (a trim's Apply),
 *  and ends the batch. A mark overlapping an earlier one is skipped. */
export function applyMarks(view: Target, kinds: readonly MarkKind[] = ["cut", "rewrite"]): boolean {
  const { marks } = marksOf(view.state);
  if (!marks.length || view.state.readOnly) return false;
  const changes: ChangeSpec[] = [];
  let end = -1;
  for (const mark of marks) {
    if (!kinds.includes(mark.kind) || mark.range.from < end) continue;
    const change = changeOf(mark);
    if (!change) continue;
    changes.push(change);
    end = mark.range.to;
  }
  view.dispatch({
    ...(changes.length ? { changes, annotations: isolateHistory.of("full"), userEvent: "delete.marks" } : {}),
    effects: clearEffect.of(null),
  });
  return true;
}

/** Text in `range` with the cuts in it taken out: a trim's "after". */
export function textAfterCuts(state: EditorState, range: Range): string {
  let out = "";
  let at = range.from;
  for (const mark of marksOf(state).marks) {
    if (mark.kind !== "cut" || mark.range.to <= range.from || mark.range.from >= range.to || mark.range.from < at) continue;
    out += state.sliceDoc(at, mark.range.from);
    at = Math.min(mark.range.to, range.to);
  }
  return out + state.sliceDoc(at, range.to);
}

// --- Sentences ---------------------------------------------------------------

/** A sentence offered to a check or trim, numbered from 1. */
export type Sentence = Range & { n: number; text: string };

const fence = /^\s*(```|~~~)/;
const skipped = (body: string) =>
  /^#{1,6}\s/.test(body) || /^(?:---|\*\*\*|___)$/.test(body.trim()) || /^(?:import|export)\s/.test(body) || /^\s*</.test(body) || /^\s*\|/.test(body) || /^!\[/.test(body.trim());

/**
 * The prose sentences in `range` of `text` (the frontmatter, headings, code,
 * tables, MDX components and dimmed comments left out), numbered for a
 * prompt the way the review numbers paragraphs. A sentence the range only
 * partly covers is clipped to it.
 */
export function proseSentences(text: string, range?: Range): Sentence[] {
  const scope = range ?? { from: splitFrontmatter(text).head.length, to: text.length };
  const out: Sentence[] = [];
  // Lines inside a code fence never count.
  const code: Range[] = [];
  let open = -1;
  let pos = 0;
  for (const line of text.split("\n")) {
    if (fence.test(line)) {
      if (open === -1) open = pos;
      else { code.push({ from: open, to: pos + line.length }); open = -1; }
    }
    pos += line.length + 1;
  }
  if (open !== -1) code.push({ from: open, to: text.length });
  for (const p of paragraphs(text)) {
    if (p.to <= scope.from || p.from >= scope.to) continue;
    if (code.some((c) => c.from <= p.from && p.to <= c.to)) continue;
    const body = text.slice(p.from, p.to);
    if (skipped(body) || /^<!--|^\{\/\*|^%%/.test(body.trim())) continue;
    for (const s of sentencesIn(body, p.from)) {
      const from = Math.max(s.from, scope.from);
      const to = Math.min(s.to, scope.to);
      const piece = text.slice(from, to);
      if (!/[\p{L}\p{N}]/u.test(piece)) continue;
      out.push({ n: out.length + 1, from, to, text: piece });
    }
  }
  return out;
}

/** Whether `range` starts and ends on word boundaries in `text`. */
export const onWordBoundaries = (text: string, range: Range) =>
  !(isWordChar(text[range.from - 1]) && isWordChar(text[range.from])) && !(isWordChar(text[range.to - 1]) && isWordChar(text[range.to]));

/**
 * What a cut of `range` takes out, so the words around it close up: the
 * space after it, or before it when punctuation or the line's end follows.
 */
export function cutRange(text: string, range: Range): Range {
  let { from, to } = range;
  while (from < to && /\s/.test(text[from])) from++;
  while (to > from && /\s/.test(text[to - 1])) to--;
  if (from === to) return { from, to };
  const before = text[from - 1];
  const next = text[to];
  if (next === " " || next === "\t") {
    if (before === undefined || /\s|[(“"‘'[]/.test(before) || /[.!?…:;,]$/.test(text.slice(from, to))) {
      while (to < text.length && (text[to] === " " || text[to] === "\t")) to++;
      return { from, to };
    }
  }
  if ((before === " " || before === "\t") && (next === undefined || /[\s.,;:!?…)\]”’"']/.test(next))) {
    while (from > 0 && (text[from - 1] === " " || text[from - 1] === "\t")) from--;
  }
  return { from, to };
}

// --- Drawing -----------------------------------------------------------------

function decorations(value: MarksState): DecorationSet {
  if (!value.marks.length) return Decoration.none;
  return Decoration.set(value.marks.map((mark) => Decoration.mark({
    class: `cm-kin-mark cm-kin-${mark.kind}${mark.id === value.focused ? " cm-kin-focused" : ""}`,
    attributes: { "data-kin-mark": mark.id, ...(mark.reason ? { title: mark.reason } : {}) },
  }).range(mark.range.from, mark.range.to)), true);
}

function button(label: string, run: () => void, primary = false): HTMLButtonElement {
  const dom = document.createElement("button");
  dom.type = "button";
  dom.className = primary ? "cm-kin-card-button cm-kin-card-primary" : "cm-kin-card-button";
  dom.textContent = label;
  // Keep the editor's focus and selection.
  dom.addEventListener("mousedown", (event) => event.preventDefault());
  dom.addEventListener("click", run);
  return dom;
}

/** The focused mark's reason and what can be done with it. KI-109's
 *  `‹ 1 of N ›` card replaces this. */
function card(getConfig: () => Marks | undefined): Extension {
  let cached: (Tooltip & { id: string }) | null = null;
  return showTooltip.compute([marksField], (state) => {
    const mark = focusedMark(state);
    if (!mark) return (cached = null);
    if (cached?.id === mark.id && cached.pos === mark.range.from) return cached;
    cached = {
      id: mark.id,
      pos: mark.range.from,
      above: false,
      create: (view) => {
        const dom = document.createElement("div");
        dom.className = "cm-kin-card";
        dom.dataset.kinMark = mark.id;
        if (mark.kind === "rewrite" && mark.text !== undefined) {
          const text = document.createElement("p");
          text.className = "cm-kin-card-text";
          text.textContent = mark.text;
          dom.append(text);
        }
        if (mark.reason) {
          const reason = document.createElement("p");
          reason.className = "cm-kin-card-reason";
          reason.textContent = mark.reason;
          dom.append(reason);
        }
        const row = document.createElement("div");
        row.className = "cm-kin-card-actions";
        const discuss = getConfig()?.onDiscuss;
        if (mark.kind === "flag" && discuss) row.append(button("Discuss", () => { const now = focusedMark(view.state); if (now) discuss(now); }));
        if (mark.kind === "cut") {
          row.append(button("Keep", () => dismissMark(view, mark.id)));
          if (!view.state.readOnly) row.append(button("Cut", () => acceptMark(view, mark.id), true));
        } else if (mark.kind === "rewrite") {
          row.append(button("Dismiss", () => dismissMark(view, mark.id)));
          if (!view.state.readOnly) row.append(button("Accept", () => acceptMark(view, mark.id), true));
        } else {
          row.append(button("Dismiss", () => dismissMark(view, mark.id)));
        }
        dom.append(row);
        return { dom };
      },
    };
    return cached;
  });
}

const theme = EditorView.theme({
  // Text decorations and a background only: a mark never moves a line (KI-103).
  ".cm-kin-flag": {
    textDecorationLine: "underline", textDecorationColor: "var(--kin, #c8963e)", textDecorationThickness: "1.5px",
    textUnderlineOffset: "0.22em", textDecorationSkipInk: "none",
  },
  ".cm-kin-cut": {
    textDecorationLine: "line-through", textDecorationColor: "var(--kin, #c8963e)", textDecorationThickness: "1.5px",
    color: "var(--neutral-7, inherit)", cursor: "pointer",
  },
  ".cm-kin-cut *": { color: "inherit" },
  ".cm-kin-rewrite": {
    textDecorationLine: "underline", textDecorationStyle: "dotted", textDecorationColor: "var(--kin, #c8963e)",
    textDecorationThickness: "1.5px", textUnderlineOffset: "0.22em",
  },
  ".cm-kin-focused": { backgroundColor: "color-mix(in oklab, var(--kin, #c8963e) 18%, transparent)", borderRadius: "2px" },
  "@media (hover: hover) and (pointer: fine)": {
    ".cm-kin-cut:hover": { backgroundColor: "color-mix(in oklab, var(--kin, #c8963e) 12%, transparent)" },
  },
  ".cm-tooltip.cm-kin-card": {
    maxWidth: "min(26rem, calc(100vw - 32px))", padding: "var(--space-xs, 6px) var(--space-s, 10px)",
    border: "none", borderRadius: "var(--radius-m, 8px)", background: "var(--popover, var(--background))", color: "var(--popover-foreground, inherit)",
    boxShadow: "inset 0 0 0 1px var(--neutral-4, rgba(0,0,0,.1)), 0 6px 24px -8px rgba(0,0,0,.25)",
    fontFamily: "var(--font-ui, var(--font-sans))", fontSize: "var(--size-xs, 13px)", lineHeight: "var(--line-xs, 18px)",
    marginTop: "6px",
  },
  ".cm-kin-card-reason, .cm-kin-card-text": { margin: "0 0 var(--space-xs, 6px)", textWrap: "pretty", boxShadow: "inset 2px 0 0 var(--kin, #c8963e)", paddingLeft: "var(--space-xs, 8px)" },
  ".cm-kin-card-text": { fontFamily: "var(--font-editorial, inherit)" },
  ".cm-kin-card-actions": { display: "flex", justifyContent: "flex-end", gap: "var(--space-xxs, 4px)" },
  ".cm-kin-card-button": {
    border: "none", borderRadius: "var(--radius-s, 6px)", padding: "2px var(--space-xs, 8px)", minHeight: "24px",
    background: "transparent", color: "var(--neutral-9, inherit)", font: "inherit", cursor: "pointer",
  },
  ".cm-kin-card-button:hover": { background: "var(--neutral-3, rgba(0,0,0,.06))" },
  ".cm-kin-card-button:focus-visible": { outline: "2px solid var(--neutral-10, currentColor)", outlineOffset: "1px" },
  ".cm-kin-card-primary": { color: "var(--kin-ink, inherit)", fontWeight: "var(--weight-ui-medium, 500)" },
  "@media (pointer: coarse)": { ".cm-kin-card-button": { minHeight: "44px", padding: "0 var(--space-s, 12px)" } },
});

/** One extension per cached document; callbacks read the current props. */
export function markExtensions(getConfig: () => Marks | undefined): Extension {
  const notify = ViewPlugin.fromClass(class {
    constructor(view: EditorView) {
      queueMicrotask(() => getConfig()?.onChange?.(marksOf(view.state), view.state));
    }
    update(update: ViewUpdate) {
      const before = marksOf(update.startState);
      const now = marksOf(update.state);
      if (before !== now) getConfig()?.onChange?.(now, update.state);
    }
  });
  const keys = keymap.of([
    { key: markShortcuts[0].key, run: (view) => focusMark(view, 1) },
    { key: markShortcuts[1].key, run: (view) => focusMark(view, -1) },
    { key: markShortcuts[2].key, run: (view) => acceptMark(view) },
    { key: markShortcuts[3].key, run: (view) => dismissMark(view) },
    { key: markShortcuts[4].key, run: (view) => marksOf(view.state).batch?.kind === "trim" && applyMarks(view) },
  ]);
  // Escape takes the marks away before it collapses a selection; with no
  // marks it falls through.
  const escape = Prec.high(keymap.of([{ key: "Escape", run: clearMarks }]));
  const clicks = EditorView.domEventHandlers({
    mousedown(event, view) {
      if (event.button !== 0 || event.metaKey || event.shiftKey || event.altKey || event.ctrlKey) return false;
      const element = (event.target as HTMLElement | null)?.closest?.("[data-kin-mark]");
      const id = element?.getAttribute("data-kin-mark");
      if (!id || element?.closest(".cm-tooltip")) return false;
      const mark = marksOf(view.state).marks.find((m) => m.id === id);
      if (!mark) return false;
      // Clicking a struck word keeps it.
      if (mark.kind === "cut") {
        event.preventDefault();
        dismissMark(view, id);
        return true;
      }
      queueMicrotask(() => { if (marksOf(view.state).marks.some((m) => m.id === id)) view.dispatch({ effects: focusEffect.of(id) }); });
      return false;
    },
  });
  return [marksField, notify, keys, escape, clicks, card(getConfig), theme];
}

/** Used by React hosts and KI-109's card; every method reads the view's current state. */
export function markCommands(view: EditorView) {
  return {
    state: () => marksOf(view.state),
    set: (batch: MarkBatch, marks: readonly Mark[], options?: { focus?: "first" | null }) => setMarks(view, batch, marks, options),
    focus: (which: string | 1 | -1) => focusMark(view, which),
    accept: (id?: string) => acceptMark(view, id),
    dismiss: (id?: string) => dismissMark(view, id),
    apply: (kinds?: readonly MarkKind[]) => applyMarks(view, kinds),
    clear: () => clearMarks(view),
  };
}
