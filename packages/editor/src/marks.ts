import { isolateHistory } from "@codemirror/commands";
import { Annotation, EditorSelection, Prec, StateEffect, StateField, type ChangeSpec, type EditorState, type Extension, type Transaction } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, keymap, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { splitFrontmatter } from "@kintsugi/core/frontmatter";
import { paragraphs, type Range } from "./anchors.ts";
import { isWordChar, sentencesIn } from "./spans.ts";
import { inlineCard, revealRange } from "./card.ts";

export { paragraphEnd } from "./card.ts";

/**
 * Kin's marks (KI-90): ranges of the draft Kin points at when he asks, drawn
 * in gold. A flag is a gold underline (a check's answer), a cut a gold
 * strike-through (a trim's), a rewrite a span with replacement words
 * (KI-109's review). They are decorations on the open document's state and
 * never part of the text: nothing is saved, and they don't move a line.
 *
 * The model is a list of `{ id, range, kind, reason }` with one focused mark,
 * and four operations the card drives: `focusMark`, `acceptMark`,
 * `dismissMark` and `applyMarks`. A mark goes on Escape (all of them), on the
 * first edit inside it, or once it's accepted or dismissed; when the last one
 * goes, the batch is done.
 *
 * The focused mark has a card (KI-109): a block under its paragraph, so it
 * never covers a line, with the reason, a rewrite's words, ‹ 1 of N › and
 * what can be done with it. A host may draw it (`renderCard`); without one
 * the editor draws a plain one.
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

/** What the focused mark's card shows. */
export type MarkCard = {
  mark: Mark;
  /** From 1, among the marks left. */
  index: number;
  total: number;
  batch: MarkBatch | null;
  readOnly: boolean;
  /** What the card offers: discuss and stash only when the host handles them. */
  can: { accept: boolean; discuss: boolean; stash: boolean };
};

/** The card's buttons. Each acts on the mark the card was drawn for. */
export type MarkCardActions = {
  accept: () => void;
  dismiss: () => void;
  discuss: () => void;
  stash: () => void;
  step: (by: 1 | -1) => void;
};

export type Marks = {
  /** Every change to the marks, and the open document's marks when it opens. */
  onChange?: (marks: MarksState, state: EditorState) => void;
  /** "Discuss" on the focused mark: a paragraph thread about it (KI-104). */
  onDiscuss?: (mark: Mark) => void;
  /** "Stash" on a focused rewrite: keeps its words for later. True when it
   *  was stashed; the mark then goes. */
  onStash?: (mark: Mark) => boolean;
  /** Draws the focused mark's card into `dom` and returns a cleanup (the
   *  desktop's React card). Without it the editor draws a plain one. */
  renderCard?: (dom: HTMLElement, card: MarkCard, actions: MarkCardActions) => () => void;
};

/** The key specs, for the host's shortcut list (KI-90, KI-109). */
export const markShortcuts = [
  { key: "Mod-'", label: "Next mark" },
  { key: "Mod-Shift-'", label: "Previous mark" },
  { key: "Alt-Enter", label: "Accept a mark" },
  { key: "Mod-Alt-Backspace", label: "Dismiss a mark" },
  { key: "Mod-Shift-j", label: "Discuss a mark" },
  { key: "Mod-Alt-Enter", label: "Apply the cuts" },
  { key: "Escape", label: "Close all marks" },
] as const;

const EMPTY: MarksState = { batch: null, marks: [], focused: null };

/** Positions are in the document before the transaction's changes. */
const putMarks = StateEffect.define<{ batch: MarkBatch; marks: readonly Mark[]; focused: string | null }>();
const focusEffect = StateEffect.define<string | null>();
const removeEffect = StateEffect.define<readonly string[]>();
const clearEffect = StateEffect.define<null>();
/** A capital a cut gave the next word: not an edit inside another mark. */
const casing = Annotation.define<{ from: number; to: number }>();
/** Scrolls a mark into view on the card's eased curve. */
const revealEffect = StateEffect.define<string>();

const byPosition = (a: Mark, b: Mark) => a.range.from - b.range.from || a.range.to - b.range.to;

/** Moves marks with an edit; one the edit touches inside is gone. */
function mapMarks(value: MarksState, tr: Transaction): MarksState {
  if (!tr.docChanged || !value.marks.length) return value;
  const touched = new Set<string>();
  const capital = tr.annotation(casing);
  const touch = (fromA: number, toA: number) => {
    for (const mark of value.marks) if (fromA < mark.range.to && toA > mark.range.from) touched.add(mark.id);
  };
  tr.changes.iterChangedRanges((fromA, toA) => {
    // Adjacent changes come merged: leave the capital out of them.
    if (capital && fromA <= capital.from && capital.to <= toA) {
      if (fromA < capital.from) touch(fromA, capital.from);
      if (capital.to < toA) touch(capital.to, toA);
    } else touch(fromA, toA);
  });
  const marks: Mark[] = [];
  for (const mark of value.marks) {
    if (touched.has(mark.id)) continue;
    const from = tr.changes.mapPos(mark.range.from, capital?.from === mark.range.from ? -1 : 1);
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
    effects: [putMarks.of({ batch, marks: kept, focused: first?.id ?? null }), ...(first ? [revealEffect.of(first.id)] : [])],
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
    effects: [focusEffect.of(mark.id), revealEffect.of(mark.id)],
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

/** Where a sentence starts: the line's start (past a list, quote or
 *  heading marker), or after a sentence's closing punctuation. */
function sentenceStarts(text: string, pos: number): boolean {
  // An opening quote or bracket before the words belongs to the sentence.
  const line = text.slice(text.lastIndexOf("\n", pos - 1) + 1, pos).replace(/[“"‘'(\[]+$/u, "").replace(/[ \t]+$/, "");
  if (!line.trim() || /^\s*(?:[-*+]|\d+[.)]|>|#{1,6})(?:\s+(?:>|\[[ xX]\]))*$/.test(line)) return true;
  return /[.!?…]["”’')\]]*$/.test(line);
}

/**
 * A cut that takes a sentence's first words leaves the next word starting
 * it: that word gets a capital ("old. I think it was" → "old. It was").
 * Only when the cut began with one and the word is plain lowercase, so
 * "iPhone" and a lowercase opening stay as he wrote them. `to` is where the
 * text after the cut starts.
 */
export function recapitalise(text: string, from: number, to: number): { from: number; to: number; insert: string } | null {
  const first = /\p{L}/u.exec(text.slice(from, to))?.[0];
  if (!first || first === first.toLowerCase() || !sentenceStarts(text, from)) return null;
  const word = /^[\p{L}\p{N}'’-]+/u.exec(text.slice(to))?.[0];
  if (!word || word[0] === word[0].toUpperCase() || word !== word.toLowerCase()) return null;
  const head = String.fromCodePoint(word.codePointAt(0)!);
  return { from: to, to: to + head.length, insert: head.toUpperCase() };
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
  const capital = mark.kind === "cut" ? recapitalise(view.state.doc.toString(), mark.range.from, mark.range.to) : null;
  const changes = change ? (capital ? [change, capital] : change) : null;
  view.dispatch({
    ...(changes ? { changes, annotations: [isolateHistory.of("full"), ...(capital ? [casing.of(capital)] : [])], userEvent: mark.kind === "cut" ? "delete.mark" : "input.mark" } : {}),
    effects: [removeEffect.of([mark.id]), ...(next ? [focusEffect.of(next), ...(next !== value.focused ? [revealEffect.of(next)] : [])] : [])],
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
  view.dispatch({ effects: [removeEffect.of([mark.id]), ...(next ? [focusEffect.of(next), ...(next !== value.focused ? [revealEffect.of(next)] : [])] : [])] });
  return true;
}

/** Applies every cut and rewrite as one undoable change (a trim's Apply),
 *  and ends the batch. A mark overlapping an earlier one is skipped. */
export function applyMarks(view: Target, kinds: readonly MarkKind[] = ["cut", "rewrite"]): boolean {
  const { marks } = marksOf(view.state);
  if (!marks.length || view.state.readOnly) return false;
  const changes: { from: number; to: number; insert?: string }[] = [];
  const applied: Mark[] = [];
  let end = -1;
  for (const mark of marks) {
    if (!kinds.includes(mark.kind) || mark.range.from < end) continue;
    const change = changeOf(mark) as { from: number; to: number; insert?: string } | null;
    if (!change) continue;
    changes.push(change);
    applied.push(mark);
    end = mark.range.to;
  }
  // A run of cuts that touch ("I think " then "just ") closes up as one: the
  // word after the run takes the capital, unless a rewrite starts there.
  const text = view.state.doc.toString();
  for (let i = 0; i < applied.length; i++) {
    if (applied[i].kind !== "cut") continue;
    let j = i;
    while (applied[j + 1]?.kind === "cut" && applied[j + 1].range.from <= applied[j].range.to) j++;
    const to = applied[j].range.to;
    const capital = applied[j + 1] && applied[j + 1].range.from <= to ? null : recapitalise(text, applied[i].range.from, to);
    if (capital) changes.push(capital);
    i = j;
  }
  changes.sort((a, b) => a.from - b.from || a.to - b.to);
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
    attributes: { "data-kin-mark": mark.id, ...(mark.reason && mark.id !== value.focused ? { title: mark.reason } : {}) },
  }).range(mark.range.from, mark.range.to)), true);
}

/** The card for the focused mark, or null. */
export function markCard(state: EditorState, config?: Marks): MarkCard | null {
  const value = marksOf(state);
  const at = value.marks.findIndex((m) => m.id === value.focused);
  if (at === -1) return null;
  const mark = value.marks[at];
  const writes = mark.kind !== "flag";
  return {
    mark, index: at + 1, total: value.marks.length, batch: value.batch, readOnly: state.readOnly,
    can: {
      accept: !writes || !state.readOnly,
      discuss: !!config?.onDiscuss,
      stash: mark.kind === "rewrite" && mark.text !== undefined && !!config?.onStash && !state.readOnly,
    },
  };
}

function discussMark(view: Target, id: string | null, config: Marks | undefined): boolean {
  const mark = marksOf(view.state).marks.find((m) => m.id === (id ?? marksOf(view.state).focused));
  if (!mark || !config?.onDiscuss) return false;
  config.onDiscuss(mark);
  return true;
}

function stashMark(view: Target, id: string, config: Marks | undefined): boolean {
  const mark = marksOf(view.state).marks.find((m) => m.id === id);
  if (!mark || mark.kind !== "rewrite" || mark.text === undefined || view.state.readOnly || !config?.onStash?.(mark)) return false;
  return dismissMark(view, id);
}

function button(label: string, run: () => void, className = "cm-kin-card-button"): HTMLButtonElement {
  const dom = document.createElement("button");
  dom.type = "button";
  dom.className = className;
  dom.textContent = label;
  dom.addEventListener("click", run);
  return dom;
}

/** The card without a host renderer (the phone's editor): words for buttons. */
function plainCard(dom: HTMLElement, card: MarkCard, actions: MarkCardActions): () => void {
  const body = document.createElement("div");
  body.className = "cm-kin-card-body";
  const { mark } = card;
  if (mark.kind === "rewrite" && mark.text !== undefined) {
    const text = document.createElement("p");
    text.className = "cm-kin-card-text";
    text.textContent = mark.text;
    body.append(text);
  }
  if (mark.reason) {
    const reason = document.createElement("p");
    reason.className = "cm-kin-card-reason";
    reason.textContent = mark.reason;
    body.append(reason);
  }
  const row = document.createElement("div");
  row.className = "cm-kin-card-actions";
  if (card.total > 1) {
    const count = document.createElement("span");
    count.className = "cm-kin-card-count";
    count.append(button("‹", () => actions.step(-1)), `${card.index} of ${card.total}`, button("›", () => actions.step(1)));
    row.append(count);
  }
  if (card.can.discuss) row.append(button("Discuss", actions.discuss));
  if (card.can.stash) row.append(button("Stash", actions.stash));
  row.append(button(mark.kind === "cut" ? "Keep" : "Dismiss", actions.dismiss));
  if (card.can.accept) row.append(button(mark.kind === "cut" ? "Cut" : mark.kind === "rewrite" ? "Accept" : "Done", actions.accept, "cm-kin-card-button cm-kin-card-primary"));
  body.append(row);
  dom.append(body);
  return () => body.remove();
}

/** Identity for the card: it redraws only when one of these changes. */
const cardKey = (c: MarkCard) =>
  JSON.stringify([c.mark.id, c.index, c.total, c.readOnly, c.mark.kind, c.mark.reason, c.mark.text, c.can, c.batch?.id]);

function cards(getConfig: () => Marks | undefined): Extension {
  return inlineCard((state) => {
    const card = markCard(state, getConfig());
    if (!card) return null;
    const id = card.mark.id;
    return {
      key: cardKey(card),
      anchor: card.mark.range,
      className: "cm-kin-card",
      data: { kinMark: id, kind: card.mark.kind },
      render: (dom, view) => {
        const actions: MarkCardActions = {
          accept: () => { acceptMark(view, id); },
          dismiss: () => { dismissMark(view, id); },
          discuss: () => { discussMark(view, id, getConfig()); },
          stash: () => { stashMark(view, id, getConfig()); },
          step: (by) => { focusMark(view, by); },
        };
        const render = getConfig()?.renderCard;
        return render ? render(dom, card, actions) : plainCard(dom, card, actions);
      },
    };
  }, [marksField, "doc"]);
}

const revealer = ViewPlugin.fromClass(class {
  update(update: ViewUpdate) {
    for (const tr of update.transactions) for (const effect of tr.effects) {
      if (!effect.is(revealEffect)) continue;
      const mark = marksOf(update.state).marks.find((m) => m.id === effect.value);
      if (mark) revealRange(update.view, mark.range);
    }
  }
});

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
    textDecorationLine: "underline", textDecorationColor: "var(--kin, #c8963e)", textDecorationThickness: "1.5px",
    textUnderlineOffset: "0.22em", textDecorationSkipInk: "none",
  },
  // The words flash once as the card steps to them: a gold wash fading over 450 ms.
  ".cm-kin-focused": {
    backgroundColor: "color-mix(in oklab, var(--kin, #c8963e) 18%, transparent)", borderRadius: "2px",
    animation: "cm-kin-flash 450ms ease-out",
  },
  "@keyframes cm-kin-flash": { from: { backgroundColor: "color-mix(in oklab, var(--kin, #c8963e) 48%, transparent)" } },
  "@media (hover: hover) and (pointer: fine)": {
    ".cm-kin-cut:hover": { backgroundColor: "color-mix(in oklab, var(--kin, #c8963e) 12%, transparent)" },
  },
  ".cm-kin-card-body": {
    width: "fit-content", maxWidth: "min(30rem, 100%)", padding: "var(--space-xs, 6px) var(--space-xs, 6px) var(--space-xxs, 4px) var(--space-s, 10px)",
    borderRadius: "var(--radius-m, 8px)", background: "var(--popover, var(--background))", color: "var(--popover-foreground, inherit)",
    boxShadow: "inset 0 0 0 1px var(--neutral-4, rgba(0,0,0,.1)), 0 6px 24px -12px rgba(0,0,0,.25)",
  },
  ".cm-kin-card-reason, .cm-kin-card-text": { margin: "0 0 var(--space-xxs, 4px)", textWrap: "pretty" },
  ".cm-kin-card-reason": { color: "var(--neutral-8, inherit)" },
  ".cm-kin-card-text": { fontFamily: "var(--font-editorial, inherit)", boxShadow: "inset 2px 0 0 var(--kin, #c8963e)", paddingLeft: "var(--space-xs, 8px)" },
  ".cm-kin-card-actions, .cm-kin-card-count": { display: "flex", alignItems: "center", gap: "var(--space-xxs, 4px)" },
  ".cm-kin-card-count": { marginRight: "auto", color: "var(--neutral-8, inherit)", fontVariantNumeric: "tabular-nums" },
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
  const [next, previous, accept, dismiss, discuss, apply, escape] = markShortcuts;
  const keys = keymap.of([
    { key: next.key, run: (view) => focusMark(view, 1) },
    { key: previous.key, run: (view) => focusMark(view, -1) },
    { key: accept.key, run: (view) => acceptMark(view) },
    { key: dismiss.key, run: (view) => dismissMark(view) },
    { key: discuss.key, run: (view) => discussMark(view, null, getConfig()) },
    { key: apply.key, run: (view) => marksOf(view.state).batch?.kind === "trim" && applyMarks(view) },
  ]);
  // Escape takes the marks away before it collapses a selection; with no
  // marks it falls through.
  const close = Prec.high(keymap.of([{ key: escape.key, run: clearMarks }]));
  const clicks = EditorView.domEventHandlers({
    mousedown(event, view) {
      if (event.button !== 0 || event.metaKey || event.shiftKey || event.altKey || event.ctrlKey) return false;
      const element = (event.target as HTMLElement | null)?.closest?.("[data-kin-mark]");
      const id = element?.getAttribute("data-kin-mark");
      if (!id || element?.closest(".cm-kin-card, .cm-tooltip")) return false;
      const value = marksOf(view.state);
      const mark = value.marks.find((m) => m.id === id);
      if (!mark) return false;
      // Clicking a trim's struck word keeps it.
      if (mark.kind === "cut" && value.batch?.kind === "trim") {
        event.preventDefault();
        dismissMark(view, id);
        return true;
      }
      queueMicrotask(() => { if (marksOf(view.state).marks.some((m) => m.id === id)) view.dispatch({ effects: focusEffect.of(id) }); });
      return false;
    },
  });
  return [marksField, notify, keys, close, clicks, cards(getConfig), revealer, theme];
}

/** Used by React hosts and the card; every method reads the view's current state. */
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
