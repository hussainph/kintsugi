import { isolateHistory } from "@codemirror/commands";
import { EditorSelection, Facet, Prec, StateEffect, StateField, Transaction, type EditorState, type Extension, type SelectionRange } from "@codemirror/state";
import { Decoration, EditorView, keymap, showTooltip, ViewPlugin, WidgetType, type DecorationSet, type Tooltip, type ViewUpdate } from "@codemirror/view";
import { anchorAt, type CommentAnchor, type Range } from "./anchors.ts";
import { inlineCard } from "./card.ts";
import { alternativesPanel, panelTheme, type PanelActions, type PanelModel } from "./alternatives-panel.ts";
import { element } from "./menu.ts";
import { paragraphRange } from "./references.ts";
import { heldPassage, heldPassages, holdPassage, releasePassage } from "./passages.ts";
import { isWordChar, resolveSpan, sentenceAt, sentencesIn, wordAt, type SpanLevel } from "./spans.ts";

/**
 * Alternatives (KI-86): more than one version of a word, a selection, a
 * sentence or a paragraph, swapped in place. The document only ever holds
 * the version that's showing; the others live with the host (a sidecar
 * beside the document on the Mac), anchored like comment threads. While the
 * document is open this extension owns them: it places each set on its span,
 * keeps it there through edits, swaps versions as one undoable change and
 * hands the host the whole list to store once edits pause.
 *
 * - The showing version is always one of the set: typing inside the span
 *   edits it, and a span replaced outright by new text (an undo after a
 *   removal, a paste) keeps that text as another version.
 * - Deleting the span's text detaches the set; it is kept, and comes back
 *   if the text does (an undo).
 * - The cursor finds a set (KI-111): the innermost set it's in, or the set a
 *   selection overlaps most. When the cursor rests there, a `‹ 2 of 3 ›`
 *   card shows under the span's paragraph, starting below the span's end.
 *
 * Plain DOM like the comments, so the phone's shared editor can adopt it.
 */

export type { SpanLevel } from "./spans.ts";
export type AlternativeAuthor = "owner" | "kin";
export type AlternativeEntry = { id: string; text: string; by: AlternativeAuthor; created: string };
export type AlternativeSet = {
  id: string;
  level: SpanLevel;
  /** Where the span was when last seen; `exact` is the showing version's text. */
  anchor: CommentAnchor;
  /** The showing entry's id. */
  current: string;
  entries: AlternativeEntry[];
  created: string;
  /** Its text couldn't be found when last seen. */
  orphaned?: boolean;
};

export type Alternatives = {
  /** The document `sets` belong to. Sets for another document are ignored. */
  path: string;
  sets: AlternativeSet[];
  /** The editor supplies this. */
  currentPath?: string;
  /** The document's whole list, once edits pause. */
  onSave: (path: string, sets: AlternativeSet[]) => void;
  /** Explicit asks only. The host chooses the edit model and enforces its cost cap. */
  ask?: (passage: { doc: string; from: number; to: number; level: SpanLevel }) => Promise<string[]>;
  /** The desktop draws the versions in its Stash tab instead of a tooltip. */
  externalPanel?: boolean;
  onPanelOpen?: () => void;
  onPanelClose?: () => void;
  onPanelChange?: (model: PanelModel | null) => void;
  /** Draws the version switcher into `dom` and returns a cleanup (the
   *  desktop's StepCard). Without it the editor draws a plain one. */
  renderCard?: (dom: HTMLElement, card: VersionCard, actions: VersionCardActions) => () => void;
};

/** What the version switcher shows: the showing version's place in its set. */
export type VersionCard = {
  setId: string;
  level: SpanLevel;
  /** From 1. */
  index: number;
  total: number;
  /** Who wrote the showing version. */
  by: AlternativeAuthor;
  range: Range;
};

/** The switcher's controls. Each acts on the set it was drawn for. */
export type VersionCardActions = {
  step: (by: 1 | -1) => void;
  /** The full list: the Stash tab's versions on the desktop. */
  open: () => void;
};

/** How long the cursor rests before the switcher shows, in ms. */
export const SWITCHER_REST = 400;
/** After a click, how long to wait for a second one before the switcher
 *  moves: lines mustn't shift between the clicks of a double-click. */
export const SWITCHER_CLICK = 300;

/** The key specs, for the host's shortcut list (the Mac's registry mirrors them). */
export const alternativeShortcuts = [
  { key: "Mod-Alt-a", label: "Versions" },
  { key: "Mod-Alt-]", label: "Next version" },
  { key: "Mod-Alt-[", label: "Previous version" },
  { key: "Mod-Shift-Alt-a", label: "Kin's versions" },
] as const;

type Live = Omit<AlternativeSet, "orphaned"> & { range: Range | null };

type Panel = {
  /** Which opening this is; the popover is rebuilt only for a new one. */
  key: number;
  /** The cursor when it opened, mapped through edits. */
  pos: number;
  /** Its offset into text swapped around it, kept while swaps clamp `pos`. */
  want?: number;
  /** The selection it opened on, if any. */
  phrase: Range | null;
  /** An explicit selection must not fall back to a larger containing set. */
  exact?: boolean;
  level: SpanLevel;
  setId: string | null;
  /** The set it was on at each level, to go back to. */
  homes: Partial<Record<SpanLevel, string>>;
  highlight: number;
};

type Field = {
  loaded: boolean;
  /** What the host gave, so opening a document doesn't rewrite its file. */
  baseline: string;
  sets: ReadonlyMap<string, Live>;
  /** Removed here; the host's copy is stale until it saves. */
  removed: ReadonlySet<string>;
  panel: Panel | null;
  /** Keep cycling the span just swapped or clicked by its dots, until the writer moves or edits. */
  cycleId: string | null;
  request: number | null;
  askError: string | null;
  /** The set whose switcher is showing: the cursor rested in it. */
  switcher: string | null;
};

/** The host's sets changed (a document loaded): place new ones. */
export const refreshAlternatives = StateEffect.define<null>();
const putSet = StateEffect.define<Live>();
const dropSet = StateEffect.define<string>();
/** Its positions are in the document before the transaction's changes. */
const setPanel = StateEffect.define<Panel | null>();
const cycleSet = StateEffect.define<string>();
const askStatus = StateEffect.define<{ request: number | null; error: string | null }>();
const showSwitcher = StateEffect.define<string | null>();
const askFacet = Facet.define<() => Alternatives | undefined, () => Alternatives | undefined>({ combine: (values) => values[0] ?? (() => undefined) });
const viewLifetimes = new WeakMap<object, object>();

const fieldFacet = Facet.define<StateField<Field>, StateField<Field> | null>({ combine: (fields) => fields[0] ?? null });
function read(state: EditorState): Field | null {
  const field = state.facet(fieldFacet);
  return field ? state.field(field, false) ?? null : null;
}

let counter = 0;
let openings = 0;
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}${(counter++ % 1296).toString(36)}`;
const now = () => new Date().toISOString();

const configFor = (getConfig: () => Alternatives | undefined) => {
  const config = getConfig();
  return config && config.path === config.currentPath ? config : undefined;
};

const current = (live: Live) => live.entries.find((e) => e.id === live.current) ?? live.entries[0];

/** A stored set, placed in `text`. */
function place(text: string, set: AlternativeSet): Live | null {
  const entries = set.entries.filter((e) => e.text.trim());
  if (entries.length < 2) return null;
  const showing = entries.find((e) => e.id === set.current) ?? entries.find((e) => e.text === set.anchor.exact) ?? entries[0];
  const texts = [showing.text, ...entries.filter((e) => e !== showing).map((e) => e.text)];
  const range = resolveSpan(text, { level: set.level, anchor: set.anchor, texts });
  const live: Live = { id: set.id, level: set.level, anchor: set.anchor, current: showing.id, entries, created: set.created, range };
  return range ? follow(live, text.slice(range.from, range.to), false) : live;
}

/** The set after its span's text became `text`: the matching version shows,
 *  else new text over the whole span is kept as a version, else the showing
 *  version takes the edit. */
function follow(live: Live, text: string, replaced: boolean): Live {
  const match = live.entries.find((e) => e.text === text);
  if (match) return match.id === live.current ? live : { ...live, current: match.id };
  if (replaced) {
    const entry: AlternativeEntry = { id: newId("e"), text, by: "owner", created: now() };
    return { ...live, entries: [...live.entries, entry], current: entry.id };
  }
  return { ...live, entries: live.entries.map((e) => (e.id === live.current ? { ...e, text } : e)) };
}

/** Where a span is after an edit: a word takes in letters typed against it;
 *  a sentence or paragraph takes in what's typed at its end. */
function mapSpan(tr: Transaction, live: Live): { range: Range | null; replaced: boolean } {
  const range = live.range!;
  let replaced: Range | null = null;
  let touched = false;
  tr.changes.iterChanges((fromA, toA, fromB, toB) => {
    if (fromA === range.from && toA === range.to) replaced = { from: fromB, to: toB };
    touched ||= fromA <= range.to && toA >= range.from;
  });
  if (replaced) return { range: (replaced as Range).to > (replaced as Range).from ? replaced : null, replaced: true };
  let from = tr.changes.mapPos(range.from, 1);
  let to = tr.changes.mapPos(range.to, -1);
  if (to <= from) return { range: null, replaced: false };
  if (!touched) return { range: { from, to }, replaced: false };
  const state = tr.state;
  if (live.level === "word") {
    while (from > 0 && isWordChar(state.sliceDoc(from - 1, from))) from--;
    while (to < state.doc.length && isWordChar(state.sliceDoc(to, to + 1))) to++;
  } else if (live.level === "sentence" || live.level === "paragraph") {
    // Text typed just before it stays outside it (a new opening line is its
    // own text); its end follows typing to the end of its sentence or
    // paragraph, and a paragraph split keeps the first part.
    const paragraph = paragraphRange(state, from);
    if (paragraph && live.level === "paragraph") to = paragraph.to;
    else if (paragraph) {
      const sentences = sentencesIn(state.sliceDoc(paragraph.from, paragraph.to), paragraph.from);
      const last = sentenceAt(sentences, Math.max(from, to - 1));
      if (last) to = Math.min(paragraph.to, Math.max(to, last.to));
    }
  }
  const text = state.sliceDoc(from, to);
  return { range: text.trim() ? { from, to } : null, replaced: false };
}

const serialize = (state: EditorState, live: Live): AlternativeSet => {
  const anchor = live.range ? anchorAt(state.doc.toString(), live.range.from, live.range.to) : live.anchor;
  return {
    id: live.id, level: live.level, anchor, current: live.current,
    entries: live.entries.map(({ id, text, by, created }) => ({ id, text, by, created })),
    created: live.created,
    ...(live.range ? {} : { orphaned: true }),
  };
};
const normalize = (set: AlternativeSet): AlternativeSet => ({
  id: set.id, level: set.level, anchor: set.anchor, current: set.current,
  entries: set.entries.map(({ id, text, by, created }) => ({ id, text, by, created })),
  created: set.created,
  ...(set.orphaned ? { orphaned: true } : {}),
});

function reconcile(value: Field, state: EditorState, config: Alternatives | undefined): Field {
  if (!config) return value;
  let text: string | null = null;
  const sets = new Map(value.sets);
  for (const set of config.sets) {
    if (sets.has(set.id) || value.removed.has(set.id)) continue;
    const live = place(text ??= state.doc.toString(), set);
    if (live) sets.set(set.id, live);
  }
  return { ...value, sets, loaded: true, baseline: value.loaded ? value.baseline : JSON.stringify(config.sets.map(normalize)) };
}

function makeField(getConfig: () => Alternatives | undefined) {
  return StateField.define<Field>({
    create: (state) => reconcile({ loaded: false, baseline: "[]", sets: new Map(), removed: new Set(), panel: null, cycleId: null, request: null, askError: null, switcher: null }, state, configFor(getConfig)),
    update(value, tr) {
      if (tr.selection || tr.docChanged) value = { ...value, cycleId: null };
      if (tr.docChanged) {
        const sets = new Map<string, Live>();
        let text: string | null = null;
        // Re-attaching is for text that comes back: an undo or redo, a swap, a paste, an edit from elsewhere.
        const returning = tr.isUserEvent("undo") || tr.isUserEvent("redo") || tr.isUserEvent("input.alternative") || tr.isUserEvent("input.paste") || !!tr.annotation(Transaction.remote);
        for (const [id, live] of value.sets) {
          if (!live.range && !returning) { sets.set(id, live); continue; }
          if (!live.range) {
            // A detached set whose text comes back, with its context, is found again.
            const range = resolveSpan(text ??= tr.state.doc.toString(), { level: live.level, anchor: live.anchor, texts: [current(live).text, ...live.entries.map((e) => e.text)] }, { minContext: 0.5 });
            sets.set(id, range ? follow({ ...live, range }, tr.state.sliceDoc(range.from, range.to), false) : live);
            continue;
          }
          const { range, replaced } = mapSpan(tr, live);
          if (!range) {
            // Detached: remember the text it was on, to find it again.
            sets.set(id, { ...live, range: null, anchor: anchorAt(tr.startState.doc.toString(), live.range.from, live.range.to) });
            continue;
          }
          sets.set(id, follow({ ...live, range }, tr.state.sliceDoc(range.from, range.to), replaced));
        }
        value = { ...value, sets, panel: value.panel && mapPanel(tr, value.panel) };
      }
      for (const effect of tr.effects) {
        if (effect.is(refreshAlternatives)) value = reconcile(value, tr.state, configFor(getConfig));
        else if (effect.is(putSet)) value = { ...value, sets: new Map(value.sets).set(effect.value.id, effect.value) };
        else if (effect.is(dropSet)) {
          const sets = new Map(value.sets);
          sets.delete(effect.value);
          value = { ...value, sets, removed: new Set(value.removed).add(effect.value) };
        } else if (effect.is(setPanel)) value = { ...value, panel: effect.value && mapPanel(tr, effect.value), askError: null };
        else if (effect.is(askStatus)) value = { ...value, request: effect.value.request, askError: effect.value.error };
        else if (effect.is(cycleSet)) value = { ...value, cycleId: effect.value };
        else if (effect.is(showSwitcher)) value = { ...value, switcher: effect.value };
      }
      // In the margin, versions follow the writer's cursor. Panel commands
      // carry their own target and must not be retargeted by a swap.
      const followsCursor = !!value.panel && !!tr.selection && getConfig()?.externalPanel && !tr.effects.some((effect) => effect.is(setPanel));
      if (value.panel && followsCursor) {
        const keep = value.panel.level === "phrase" ? "word" : value.panel.level;
        value = { ...value, askError: null, panel: { ...panelFor(tr.state, value, tr.state.selection.main, keep), key: value.panel.key } };
      }
      // Typing hides the switcher, and so does moving off its set; the
      // cursor resting brings it back (the view plugin below). A click
      // leaves it until clicks settle, so nothing moves under the pointer.
      if (value.switcher && !tr.effects.some((effect) => effect.is(showSwitcher))) {
        const typed = tr.docChanged && !tr.isUserEvent("input.alternative");
        const live = value.sets.get(value.switcher);
        const stepped = tr.isUserEvent("input.alternative") && tr.effects.some((effect) => effect.is(cycleSet) && effect.value === value.switcher);
        const moved = !stepped && (tr.selection || tr.docChanged) && !tr.isUserEvent("select.pointer") && activeSet(tr.state, tr.state.selection.main, value)?.id !== value.switcher;
        if (typed || !live?.range || tr.state.readOnly || moved) value = { ...value, switcher: null };
      }
      if (value.panel) {
        let panel = clampPanel(tr.state, value, value.panel);
        const live = followsCursor && panel.setId ? value.sets.get(panel.setId) : null;
        if (live) panel = { ...panel, highlight: Math.max(0, live.entries.findIndex((entry) => entry.id === live.current)) };
        value = { ...value, panel };
      }
      return value;
    },
    provide: (field) => fieldFacet.of(field),
  });
}

/** `setPanel` positions are in the document before the transaction's changes. */
function mapPanel(tr: Transaction, panel: Panel): Panel {
  if (!tr.docChanged) return panel;
  // Text swapped around it keeps its offset, so going back lands where it was.
  let pos: number | null = null;
  let want: number | undefined;
  tr.changes.iterChanges((fromA, toA, fromB, toB) => {
    if (pos !== null || toA <= fromA || panel.pos < fromA || panel.pos > toA) return;
    want = panel.want ?? panel.pos - fromA;
    pos = fromB + Math.min(want, toB - fromB);
  });
  return { ...panel, pos: pos ?? tr.changes.mapPos(panel.pos, -1), want, phrase: panel.phrase && mapPhrase(tr, panel.phrase) };
}

function mapPhrase(tr: Transaction, range: Range): Range | null {
  let replaced: Range | null = null;
  tr.changes.iterChanges((fromA, toA, fromB, toB) => { if (fromA === range.from && toA === range.to) replaced = { from: fromB, to: toB }; });
  if (replaced) return replaced;
  const from = tr.changes.mapPos(range.from, 1);
  const to = tr.changes.mapPos(range.to, -1);
  return to > from ? { from, to } : null;
}

// --- Spans and targets -------------------------------------------------------

/** The span of `level` at `pos` in the document as it is now. */
function spanAt(state: EditorState, level: SpanLevel, pos: number, phrase: Range | null): Range | null {
  if (level === "phrase") return phrase;
  if (level === "word") {
    const line = state.doc.lineAt(pos);
    const range = wordAt(line.text, pos - line.from);
    return range && { from: line.from + range.from, to: line.from + range.to };
  }
  const paragraph = paragraphRange(state, pos);
  if (!paragraph || level === "paragraph") return paragraph;
  return sentenceAt(sentencesIn(state.sliceDoc(paragraph.from, paragraph.to), paragraph.from), pos);
}

const contains = (range: Range, pos: number) => pos >= range.from && pos <= range.to;
const size = (range: Range) => range.to - range.from;

/** The sets whose span holds `pos`, smallest first. */
export function alternativesAt(state: EditorState, pos: number): AlternativeSet[] {
  return setsAt(state, pos).map((live) => serialize(state, live));
}

function setsAt(state: EditorState, pos: number, field = read(state)): Live[] {
  if (!field) return [];
  return [...field.sets.values()].filter((s) => s.range && contains(s.range, pos)).sort((a, b) => size(a.range!) - size(b.range!));
}

function exactSet(state: EditorState, range: Range, field = read(state)): Live | null {
  if (field) for (const live of field.sets.values()) if (live.range?.from === range.from && live.range.to === range.to) return live;
  return null;
}

/**
 * The set the cursor or selection is on (KI-111), with no exact match
 * needed: at a cursor, the innermost set holding it; with a selection, the
 * set it overlaps most (shared length over combined length), the smaller
 * on a tie. Null when there's none.
 */
function activeSet(state: EditorState, selection: Pick<SelectionRange, "from" | "to" | "head" | "empty">, field = read(state)): Live | null {
  if (!field) return null;
  if (selection.empty) return setsAt(state, selection.head, field)[0] ?? null;
  let best: Live | null = null;
  let score = 0;
  for (const live of field.sets.values()) {
    const range = live.range;
    if (!range || range.from >= selection.to || range.to <= selection.from) continue;
    const shared = Math.min(range.to, selection.to) - Math.max(range.from, selection.from);
    const fit = shared / (Math.max(range.to, selection.to) - Math.min(range.from, selection.from));
    if (fit > score || (fit === score && best && size(range) < size(best.range!))) { best = live; score = fit; }
  }
  return best;
}

/** The set at the selection or cursor, as stored: what the switcher and ⌘K show. */
export function activeAlternative(state: EditorState): AlternativeSet | null {
  const live = activeSet(state, state.selection.main);
  return live ? serialize(state, live) : null;
}

/** The set a level shows at `pos`: the one exactly on its span, else the
 *  innermost of that level there. A selection's own span is only ever its
 *  exact set; without one, Selection is the innermost stored selection. */
function setFor(state: EditorState, level: SpanLevel, range: Range | null, pos: number, field = read(state)): Live | null {
  if (!field) return null;
  return (range && exactSet(state, range, field)) ?? (level === "phrase" && range ? null : setsAt(state, pos, field).find((s) => s.level === level)) ?? null;
}

/** A panel on the selection or cursor: its active set if it has one, else
 *  the span of `level` there (a selection's own level when it has one). */
function panelFor(state: EditorState, field: Field, selection: SelectionRange, level: SpanLevel = "word"): Omit<Panel, "key"> {
  const selected = selection.empty ? null : { from: selection.from, to: selection.to };
  // A selection that's exactly a word, sentence or paragraph is that level, not Selection.
  const phrase = selected && levelOf(state, selected) === "phrase" ? selected : null;
  const live = activeSet(state, selection, field);
  if (live?.range) {
    const pos = Math.max(live.range.from, Math.min(live.range.to, selected ? selected.from : selection.head));
    return { pos, phrase, level: live.level, setId: live.id, homes: {}, highlight: Math.max(0, live.entries.findIndex((e) => e.id === live.current)) };
  }
  const pos = selected ? selected.from : selection.head;
  if (selected) level = levelOf(state, selected);
  else if (level === "word" && !spanAt(state, "word", pos, null)) level = "sentence";
  return { pos, phrase, level, setId: null, homes: {}, highlight: 0 };
}

/** What the panel is on: its set if it has one, else the span of its level. */
function target(state: EditorState, field: Field, panel: Panel): { range: Range | null; live: Live | null } {
  const live = panel.setId ? field.sets.get(panel.setId) ?? null : null;
  if (live?.range) return { range: live.range, live };
  return { range: spanAt(state, panel.level, panel.pos, panel.phrase), live: null };
}

function clampPanel(state: EditorState, field: Field, panel: Panel): Panel {
  let next = panel;
  if (next.setId && !field.sets.get(next.setId)?.range) next = { ...next, setId: null };
  if (!next.setId) {
    const range = spanAt(state, next.level, next.pos, next.phrase);
    const live = next.exact ? range && exactSet(state, range, field) : setFor(state, next.level, range, next.pos, field);
    if (live) next = { ...next, setId: live.id };
  }
  if (next.setId && next.homes[next.level] !== next.setId) next = { ...next, homes: { ...next.homes, [next.level]: next.setId } };
  const count = next.setId ? field.sets.get(next.setId)!.entries.length : 1;
  if (next.highlight >= count) next = { ...next, highlight: count - 1 };
  return next;
}

/** The levels the panel offers here: Selection (when he made one, or the
 *  cursor is in a stored one), Word, Sentence and Paragraph. */
function levelsAt(state: EditorState, field: Field, panel: Panel): SpanLevel[] {
  const out: SpanLevel[] = [];
  if (panel.phrase || panel.level === "phrase" || setsAt(state, panel.pos, field).some((s) => s.level === "phrase")) out.push("phrase");
  if (panel.level === "word" || spanAt(state, "word", panel.pos, null)) out.push("word");
  if (paragraphRange(state, panel.pos)) out.push("sentence", "paragraph");
  return out;
}

/** The set each level would show, for the panel's tabs. */
function setAtLevel(state: EditorState, field: Field, panel: Panel, level: SpanLevel): Live | null {
  if (level === panel.level) return target(state, field, panel).live;
  const home = panel.homes[level] ? field.sets.get(panel.homes[level]!) : undefined;
  return home?.range ? home : setFor(state, level, spanAt(state, level, panel.pos, panel.phrase), panel.pos, field);
}

/** The level a selection is: a whole word, sentence or paragraph, else a phrase. */
function levelOf(state: EditorState, range: Range): SpanLevel {
  const same = (other: Range | null) => !!other && other.from === range.from && other.to === range.to;
  if (same(spanAt(state, "word", range.from, null))) return "word";
  if (same(spanAt(state, "sentence", range.from, null))) return "sentence";
  if (same(spanAt(state, "paragraph", range.from, null))) return "paragraph";
  return "phrase";
}

// --- Commands -----------------------------------------------------------------

type ViewLike = Pick<EditorView, "state" | "dispatch">;

/** Shows `entry` in place of the span: one change, its own undo step. */
function swap(view: ViewLike, live: Live, entryId: string, effects: StateEffect<unknown>[] = [], cursorAtEnd = false) {
  const range = live.range!;
  const entry = live.entries.find((e) => e.id === entryId)!;
  const head = view.state.selection.main.head;
  const offset = contains(range, head) ? head - range.from : null;
  const to = range.from + entry.text.length;
  const showing = view.state.sliceDoc(range.from, range.to);
  view.dispatch({
    changes: showing === entry.text ? undefined : { from: range.from, to: range.to, insert: entry.text },
    selection: cursorAtEnd ? EditorSelection.cursor(to) : offset === null ? undefined : EditorSelection.cursor(range.from + Math.min(offset, entry.text.length)),
    effects: [putSet.of({ ...live, current: entryId, range: { from: range.from, to } }), cycleSet.of(live.id), ...effects],
    annotations: isolateHistory.of("full"),
    userEvent: "input.alternative",
    scrollIntoView: true,
  });
}

/** Opens the panel on the set at the selection or cursor (KI-111: the
 *  innermost, or the one a selection overlaps most), else on the
 *  selection or the cursor's word. */
export function openAlternatives(view: ViewLike): boolean {
  const field = read(view.state);
  if (!field) return false;
  const panel = { ...panelFor(view.state, field, view.state.selection.main), key: ++openings };
  if (!panel.setId && !spanAt(view.state, panel.level, panel.pos, panel.phrase)) return false;
  view.dispatch({ effects: setPanel.of(panel) });
  return true;
}

/** Opens the panel on one set: the switcher's count. */
export function openAlternativesOn(view: ViewLike, setId: string): boolean {
  const field = read(view.state);
  const live = field?.sets.get(setId);
  if (!field || !live?.range) return false;
  const selection = view.state.selection.main;
  const pos = Math.max(live.range.from, Math.min(live.range.to, selection.head));
  const phrase = !selection.empty && levelOf(view.state, selection) === "phrase" ? { from: selection.from, to: selection.to } : null;
  const highlight = Math.max(0, live.entries.findIndex((e) => e.id === live.current));
  view.dispatch({ effects: setPanel.of({ key: ++openings, pos, phrase, level: live.level, setId, homes: {}, highlight }) });
  return true;
}

export function closeAlternatives(view: ViewLike): boolean {
  if (!read(view.state)?.panel) return false;
  view.dispatch({ effects: setPanel.of(null) });
  return true;
}

/** Shows the next (1) or previous (-1) version of the panel's set, else the
 *  last explicitly chosen set, else the set at the selection or cursor. */
export function cycleAlternative(view: ViewLike, direction: 1 | -1): boolean {
  const field = read(view.state);
  if (!field || view.state.readOnly) return false;
  const panel = field.panel;
  const recent = field.cycleId ? field.sets.get(field.cycleId) : null;
  // A new cursor position clears cycleId, so even while a pointer click
  // holds the old card still, the keys immediately follow the new cursor.
  const live = panel ? target(view.state, field, panel).live : recent?.range ? recent : activeSet(view.state, view.state.selection.main, field);
  return !!live && stepAlternative(view, live.id, direction);
}

/** Shows the next (1) or previous (-1) version of one set, in place. */
export function stepAlternative(view: ViewLike, setId: string, direction: 1 | -1): boolean {
  const field = read(view.state);
  const live = field?.sets.get(setId);
  if (!field || !live?.range || view.state.readOnly) return false;
  const at = live.entries.findIndex((e) => e.id === live.current);
  const next = live.entries[(at + direction + live.entries.length) % live.entries.length];
  const panel = field.panel;
  const onIt = panel && (panel.setId === live.id || target(view.state, field, panel).live?.id === live.id);
  const effects = panel && onIt ? [setPanel.of({ ...panel, setId: live.id, highlight: live.entries.indexOf(next) })] : [];
  swap(view, live, next.id, effects);
  return true;
}

/** A new set on `range` with its text as the first version. */
function fresh(state: EditorState, level: SpanLevel, range: Range): Live {
  const text = state.sliceDoc(range.from, range.to);
  const entry: AlternativeEntry = { id: newId("e"), text, by: "owner", created: now() };
  return { id: newId("a"), level, anchor: anchorAt(state.doc.toString(), range.from, range.to), current: entry.id, entries: [entry], created: now(), range };
}

/**
 * Adds versions to the span `from`–`to` without showing them, for the host
 * (KI-87: Kin's suggestions arrive with `by: "kin"`). Uses the span's set if
 * it has one, else starts one with its text as the first version. Returns
 * the set's id, or null if the span is empty or nothing was new.
 */
export function addAlternatives(view: ViewLike, spec: { from: number; to: number; texts: string[]; by: AlternativeAuthor; level?: SpanLevel }): string | null {
  if (!read(view.state) || view.state.readOnly || spec.from < 0 || spec.to > view.state.doc.length || spec.to <= spec.from) return null;
  const range = { from: spec.from, to: spec.to };
  const level = spec.level ?? levelOf(view.state, range);
  const base = exactSet(view.state, range) ?? fresh(view.state, level, range);
  const entries = [...base.entries];
  for (const raw of spec.texts) {
    const text = raw;
    if (text.trim() && !entries.some((e) => e.text === text)) entries.push({ id: newId("e"), text, by: spec.by, created: now() });
  }
  if (entries.length === base.entries.length || entries.length < 2) return null;
  view.dispatch({ effects: putSet.of({ ...base, entries }) });
  return base.id;
}

/** Accept an explicit edit, retaining both versions and the replacement's author.
 *  Put it just after the showing version so one previous-cycle swaps back. */
export function applyAlternative(view: ViewLike, spec: { from: number; to: number; text: string; by: AlternativeAuthor }): boolean {
  if (!read(view.state) || view.state.readOnly || spec.from < 0 || spec.to > view.state.doc.length || spec.to <= spec.from || !spec.text.trim()) return false;
  addAlternatives(view, { ...spec, texts: [spec.text] });
  const live = exactSet(view.state, spec);
  const entry = live?.entries.find((e) => e.text === spec.text);
  if (!live?.range || !entry) return false;
  const entries = live.entries.filter((e) => e.id !== entry.id);
  entries.splice(entries.findIndex((e) => e.id === live.current) + 1, 0, entry);
  swap(view, { ...live, entries }, entry.id, [setPanel.of(null)], true);
  return true;
}

/** The ask shortcut: an explicit selection takes priority over an open
 *  panel; otherwise ask on the panel or the cursor's span. A held passage
 *  prevents an answer from landing on text edited while waiting. */
export function askForAlternatives(view: ViewLike): boolean {
  return askAlternatives(view, "shortcut");
}

function askAlternatives(view: ViewLike, source: "shortcut" | "panel"): boolean {
  const config = configFor(view.state.facet(askFacet));
  let field = read(view.state);
  if (!field || !config?.ask || view.state.readOnly) return false;
  if (field.request !== null) return true;
  // Asked with a selection, Kin answers for what's selected, not a set it overlaps.
  const selection = view.state.selection.main;
  if (source === "shortcut" && !selection.empty && !onSelection(view.state, field)) {
    const level = levelOf(view.state, selection);
    const range = { from: selection.from, to: selection.to };
    const live = exactSet(view.state, range, field);
    const highlight = live ? Math.max(0, live.entries.findIndex((e) => e.id === live.current)) : 0;
    const key = field.panel?.key ?? ++openings;
    view.dispatch({ effects: setPanel.of({ key, pos: selection.from, phrase: level === "phrase" ? range : null, exact: true, level, setId: live?.id ?? null, homes: {}, highlight }) });
  } else if (!field.panel && !openAlternatives(view)) return false;
  field = read(view.state)!;
  const panel = field.panel!;
  const { range } = target(view.state, field, panel);
  if (!range || !view.state.sliceDoc(range.from, range.to).trim()) return false;
  const text = view.state.sliceDoc(range.from, range.to);
  const doc = view.state.doc.toString();
  const held = holdPassage(range.from, range.to);
  view.dispatch({ effects: [held.effect, askStatus.of({ request: held.id, error: null })] });
  const lifetime = viewLifetimes.get(view);
  const active = () => viewLifetimes.get(view) === lifetime && read(view.state)?.request === held.id;
  void (async () => {
    let error: string | null = null;
    try {
      const texts = await config.ask!({ doc, ...range, level: panel.level });
      if (!active()) return;
      const at = heldPassage(view.state, held.id, text);
      if (!at) throw new Error("The text changed. Try again.");
      const id = addAlternatives(view, { ...at, texts, by: "kin", level: panel.level });
      if (!id) error = "No new alternatives. Try again.";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      if (active()) view.dispatch({ effects: [releasePassage(held.id), askStatus.of({ request: null, error })] });
    }
  })();
  return true;
}

/** The panel is on exactly the selection. */
function onSelection(state: EditorState, field: Field): boolean {
  const selection = state.selection.main;
  const range = field.panel && target(state, field, field.panel).range;
  return !!range && range.from === selection.from && range.to === selection.to;
}

/** What the panel does, for whichever panel draws it. */
export function alternativePanelCommands(view: ViewLike & { focus: () => void }): PanelActions {
  const state = () => {
    const field = read(view.state);
    const panel = field?.panel;
    return field && panel ? { field, panel, ...target(view.state, field, panel) } : { field: null, panel: null, range: null, live: null };
  };
  const refocus = () => view.focus();
  return {
    pick: (index: number) => {
      const { panel, live } = state();
      if (!panel || !live?.range || view.state.readOnly) return;
      const entry = live.entries[index];
      if (entry) swap(view, live, entry.id, [setPanel.of({ ...panel, setId: live.id, highlight: index })]);
    },
    add: (text: string) => {
      const { panel, range, live } = state();
      if (!panel || !range || view.state.readOnly) return;
      const base = live ?? fresh(view.state, panel.level, range);
      const existing = base.entries.find((e) => e.text === text);
      const entry = existing ?? { id: newId("e"), text, by: "owner" as const, created: now() };
      const next = existing ? base : { ...base, entries: [...base.entries, entry] };
      swap(view, next, entry.id, [setPanel.of({ ...panel, setId: next.id, highlight: next.entries.indexOf(entry) })]);
    },
    remove: (index: number) => {
      const { panel, live } = state();
      if (!panel || !live || view.state.readOnly) return;
      const entry = live.entries[index];
      if (!entry) return;
      const rest = live.entries.filter((e) => e !== entry);
      const showing = entry.id === live.current ? rest[Math.min(index, rest.length - 1)] : current(live);
      const highlight = Math.min(index, rest.length - 1);
      if (rest.length < 2) {
        // One version left: no alternatives, so no set.
        const effects = [dropSet.of(live.id), setPanel.of({ ...panel, setId: null, highlight: 0 })];
        if (live.range && showing.id !== live.current) swap(view, { ...live, entries: rest }, showing.id, effects);
        else view.dispatch({ effects });
      } else if (live.range && showing.id !== live.current) {
        swap(view, { ...live, entries: rest }, showing.id, [setPanel.of({ ...panel, highlight })]);
      } else {
        view.dispatch({ effects: [putSet.of({ ...live, entries: rest }), setPanel.of({ ...panel, highlight })] });
      }
    },
    move: (delta: number) => {
      const { panel, live } = state();
      if (!panel) return;
      const count = live?.entries.length ?? 1;
      view.dispatch({ effects: setPanel.of({ ...panel, highlight: (panel.highlight + delta + count) % count }) });
    },
    level: (level: SpanLevel) => {
      const { panel } = state();
      if (!panel) return;
      const home = panel.homes[level] ? read(view.state)?.sets.get(panel.homes[level]!) : undefined;
      const range = spanAt(view.state, level, panel.pos, panel.phrase);
      const live = home?.range ? home : setFor(view.state, level, range, panel.pos);
      const highlight = live ? live.entries.findIndex((e) => e.id === live.current) : 0;
      view.dispatch({ effects: setPanel.of({ ...panel, exact: false, level, setId: live?.id ?? null, highlight }) });
    },
    askKin: () => { askAlternatives(view, "panel"); },
    cycle: (direction: 1 | -1) => { cycleAlternative(view, direction); },
    close: () => {
      closeAlternatives(view);
      refocus();
      // The external panel's Escape never reaches the editor's observer.
      // Dispatch after focusing, cancelling that focus change's rest too.
      view.dispatch({ effects: showSwitcher.of(null) });
    },
  };
}

/** What the open panel shows; null when it's closed. */
export function alternativesPanelModel(state: EditorState): PanelModel | null {
  const field = read(state);
  return field?.panel ? panelModel(state, field, field.panel) : null;
}

function panelModel(state: EditorState, field: Field, panel: Panel): PanelModel {
  const { range, live } = target(state, field, panel);
  const entries = live
    ? live.entries.map((e) => ({ text: e.text, by: e.by, current: e.id === live.current }))
    : [{ text: range ? state.sliceDoc(range.from, range.to) : "", by: "owner" as const, current: true }];
  const config = configFor(state.facet(askFacet));
  const levels = levelsAt(state, field, panel);
  const counts: Partial<Record<SpanLevel, number>> = {};
  for (const level of levels) {
    const set = setAtLevel(state, field, panel, level);
    if (set && set.entries.length > 1) counts[level] = set.entries.length;
  }
  return {
    level: panel.level, levels, counts, entries, highlight: panel.highlight, readOnly: state.readOnly,
    canAsk: !!config?.ask && !!range, asking: field.request !== null, askError: field.askError,
  };
}

function popover(field: StateField<Field>, getConfig: () => Alternatives | undefined): Extension {
  // One Tooltip per opening, so his typing in it survives updates.
  let cached: (Tooltip & { pos: number }) | null = null;
  let opened: Panel | null = null;
  return showTooltip.compute([field], (state) => {
    const value = state.field(field);
    const panel = value.panel;
    if (!panel || getConfig()?.externalPanel) return (cached = opened = null);
    const { range } = target(state, value, panel);
    if (!range) return (cached = opened = null);
    const same = opened?.key === panel.key;
    opened = panel;
    // Under a word; under the end of a sentence or paragraph, so it stays readable.
    const pos = panel.level === "word" || panel.level === "phrase" ? range.from : range.to;
    if (cached && same) { cached.pos = pos; return cached; }
    cached = {
      pos,
      above: false,
      create: (view) => {
        const component = alternativesPanel(alternativePanelCommands(view));
        const draw = () => {
          const now = read(view.state);
          if (now?.panel) component.update(panelModel(view.state, now, now.panel));
        };
        draw();
        return { dom: component.dom, mount: () => requestAnimationFrame(() => component.focus()), update: draw };
      },
    };
    return cached;
  });
}

// --- Drawing ------------------------------------------------------------------

class Count extends WidgetType {
  readonly id: string;
  readonly count: number;
  readonly paragraph: boolean;
  readonly current: number;
  constructor(id: string, count: number, paragraph: boolean, current: number) {
    super();
    this.id = id;
    this.count = count;
    this.paragraph = paragraph;
    this.current = current;
  }
  eq(other: Count) { return other.id === this.id && other.count === this.count && other.paragraph === this.paragraph && other.current === this.current; }
  toDOM(view: EditorView) {
    const dom = element("span", this.paragraph ? "cm-alt-gutter" : "cm-alt-count");
    for (let i = 0; i < this.count; i++) {
      const dot = element("span", "cm-alt-dot");
      if (i === this.current) dot.dataset.current = "true";
      dot.setAttribute("aria-hidden", "true");
      dom.append(dot);
    }
    dom.dataset.alternatives = this.id;
    dom.setAttribute("aria-label", `Version ${this.current + 1} of ${this.count}`);
    // Like clicking the span: the cursor goes to its end, and the switcher shows.
    dom.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const live = read(view.state)?.sets.get(this.id);
      if (!live?.range) return;
      view.dispatch({ selection: EditorSelection.cursor(live.range.to) });
      const panel = read(view.state)?.panel;
      view.dispatch({ effects: [
        showSwitcher.of(view.state.readOnly ? null : live.id),
        cycleSet.of(live.id),
        ...(panel ? [setPanel.of({ ...panel, pos: live.range.to, phrase: null, homes: {}, exact: false, level: live.level, setId: live.id, highlight: Math.max(0, live.entries.findIndex((entry) => entry.id === live.current)) })] : []),
      ] });
      view.focus();
    });
    return dom;
  }
  ignoreEvent() { return true; }
}

function decorations(state: EditorState): DecorationSet {
  const field = read(state);
  if (!field) return Decoration.none;
  const ranges = [];
  const open = field.panel ? target(state, field, field.panel).range : null;
  for (const live of field.sets.values()) {
    const range = live.range;
    if (!range || live.entries.length < 2) continue;
    if (live.level === "paragraph") {
      ranges.push(Decoration.line({ class: "cm-alt-paragraph" }).range(state.doc.lineAt(range.from).from));
      ranges.push(Decoration.widget({ widget: new Count(live.id, live.entries.length, true, live.entries.findIndex((entry) => entry.id === live.current)), side: -1 }).range(range.from));
    } else {
      ranges.push(Decoration.mark({ class: "cm-alt-span", attributes: { "data-alternatives": live.id } }).range(range.from, range.to));
      ranges.push(Decoration.widget({ widget: new Count(live.id, live.entries.length, false, live.entries.findIndex((entry) => entry.id === live.current)), side: 1 }).range(range.to));
    }
  }
  if (open && open.to > open.from) ranges.push(Decoration.mark({ class: "cm-alt-open" }).range(open.from, open.to));
  return Decoration.set(ranges, true);
}

// --- The switcher (KI-111) -----------------------------------------------------

/** The switcher's card, or null while it's hidden. */
export function versionCard(state: EditorState): VersionCard | null {
  const field = read(state);
  const live = field?.switcher ? field.sets.get(field.switcher) : null;
  if (!live?.range || state.readOnly || live.entries.length < 2) return null;
  const at = Math.max(0, live.entries.findIndex((e) => e.id === live.current));
  return { setId: live.id, level: live.level, index: at + 1, total: live.entries.length, by: live.entries[at].by, range: live.range };
}

/** Shows the switcher on the set at the cursor now, without waiting for it
 *  to rest. False when the cursor isn't in a set. */
export function showVersionSwitcher(view: ViewLike): boolean {
  const live = view.state.readOnly ? null : activeSet(view.state, view.state.selection.main);
  if (!live || read(view.state)?.switcher === live.id) return !!live;
  view.dispatch({ effects: showSwitcher.of(live.id) });
  return true;
}

/** The switcher on the set at the cursor, or hidden off one. */
function settleSwitcher(view: ViewLike) {
  const live = view.state.readOnly ? null : activeSet(view.state, view.state.selection.main);
  const want = live && live.entries.length > 1 ? live.id : null;
  if ((read(view.state)?.switcher ?? null) !== want) view.dispatch({ effects: showSwitcher.of(want) });
}

function hideVersionSwitcher(view: ViewLike): boolean {
  if (!read(view.state)?.switcher) return false;
  view.dispatch({ effects: showSwitcher.of(null) });
  return true;
}

function button(label: string, run: () => void, name?: string): HTMLButtonElement {
  const dom = element("button", "cm-alt-card-button", label);
  dom.type = "button";
  if (name) dom.setAttribute("aria-label", name);
  dom.addEventListener("click", run);
  return dom;
}

/** The switcher without a host renderer: ‹, the count (it opens the list), ›. */
function plainCard(dom: HTMLElement, card: VersionCard, actions: VersionCardActions): () => void {
  const body = element("div", "cm-alt-card-body");
  body.setAttribute("role", "group");
  body.setAttribute("aria-label", "Versions");
  body.append(
    button("‹", () => actions.step(-1), "Previous version"),
    button(`${card.index} of ${card.total}`, actions.open, "All versions"),
    button("›", () => actions.step(1), "Next version"),
  );
  dom.append(body);
  return () => body.remove();
}

/** The `‹ 2 of 3 ›` card under the span's paragraph, starting below its end. */
function switcherCard(field: StateField<Field>, getConfig: () => Alternatives | undefined): Extension {
  return inlineCard((state) => {
    const card = versionCard(state);
    if (!card) return null;
    const id = card.setId;
    return {
      key: JSON.stringify([id, card.index, card.total, card.by]),
      slot: "versions",
      anchor: card.range,
      align: card.range.to,
      className: "cm-alt-card",
      data: { versions: id },
      estimatedHeight: 36,
      render: (dom, view) => {
        const actions: VersionCardActions = {
          step: (by) => { stepAlternative(view, id, by); },
          open: () => { openAlternativesOn(view, id); },
        };
        const render = getConfig()?.renderCard;
        return render ? render(dom, card, actions) : plainCard(dom, card, actions);
      },
    };
  }, [field]);
}

/** Shows the switcher once the cursor rests in a set: about 300 ms after a
 *  click (once no second click follows), 400 ms after keys or typing. */
const rest = ViewPlugin.fromClass(class {
  timer: ReturnType<typeof setTimeout> | undefined;
  pointer = false;
  alive = true;
  readonly view: EditorView;
  readonly up = () => {
    if (!this.pointer) return;
    this.pointer = false;
    clearTimeout(this.timer);
    if (this.view.hasFocus) this.timer = setTimeout(() => { if (this.view.hasFocus) settleSwitcher(this.view); }, SWITCHER_CLICK);
  };
  readonly blur = () => {
    this.pointer = false;
    clearTimeout(this.timer);
  };
  constructor(view: EditorView) {
    this.view = view;
    view.dom.ownerDocument.addEventListener("mouseup", this.up, true);
    view.dom.ownerDocument.defaultView?.addEventListener("blur", this.blur);
  }
  down(event: MouseEvent) {
    if (event.button !== 0 || (event.target as Element | null)?.closest?.(".cm-step-card, .cm-alt-count, .cm-alt-gutter")) return;
    this.pointer = true;
    clearTimeout(this.timer);
  }
  update(update: ViewUpdate) {
    // Shown or hidden on purpose (Escape, a click on the dots): no pending rest brings it back.
    if (update.transactions.some((tr) => tr.effects.some((effect) => effect.is(showSwitcher)))) { clearTimeout(this.timer); return; }
    if (!this.view.hasFocus) { clearTimeout(this.timer); return; }
    if (!update.docChanged && !update.selectionSet && !update.focusChanged) return;
    clearTimeout(this.timer);
    const live = update.state.readOnly ? null : activeSet(update.state, update.state.selection.main);
    if (!live || read(update.state)?.switcher === live.id || this.pointer) return;
    this.timer = setTimeout(() => { if (!this.pointer && this.view.hasFocus) showVersionSwitcher(this.view); }, SWITCHER_REST);
  }
  destroy() {
    this.alive = false;
    clearTimeout(this.timer);
    this.view.dom.ownerDocument.removeEventListener("mouseup", this.up, true);
    this.view.dom.ownerDocument.defaultView?.removeEventListener("blur", this.blur);
  }
}, {
  eventHandlers: { mousedown(event) { this.down(event); } },
  // Observe Escape even if another keymap consumes it. A pending rest isn't
  // visible state yet, and must not bring the card back after dismissal.
  eventObservers: { keydown(event) {
    if (event.key !== "Escape") return;
    clearTimeout(this.timer);
    // Other Escape handlers can collapse a selection or return focus from
    // the list, scheduling another rest. Cancel after those have finished.
    queueMicrotask(() => {
      clearTimeout(this.timer);
      if (this.alive) hideVersionSwitcher(this.view);
    });
  } },
});

/** The document's sets as they'd be stored now. */
export function alternativesToSave(state: EditorState): AlternativeSet[] {
  const field = read(state);
  return field ? [...field.sets.values()].map((live) => serialize(state, live)) : [];
}

/** Hands the host the whole list once edits pause, if it changed. */
function persistence(getConfig: () => Alternatives | undefined) {
  return ViewPlugin.fromClass(class {
    timer: ReturnType<typeof setTimeout> | undefined;
    sent: string | null = null;
    state: EditorState;
    constructor(view: EditorView) { this.state = view.state; }
    update(update: ViewUpdate) {
      this.state = update.state;
      if (read(update.startState)?.sets !== read(update.state)?.sets || (!read(update.startState)?.loaded && read(update.state)?.loaded)) this.schedule();
    }
    schedule() {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.flush(), 700);
    }
    flush() {
      clearTimeout(this.timer);
      const field = read(this.state);
      const config = getConfig();
      if (!field?.loaded || !config?.currentPath) return;
      const sets = alternativesToSave(this.state);
      const json = JSON.stringify(sets);
      if (json === (this.sent ?? field.baseline)) return;
      this.sent = json;
      config.onSave(config.currentPath, sets);
    }
    destroy() { this.flush(); }
  });
}

/** One extension per cached EditorState; callbacks read the current props. */
export function alternativeExtensions(getConfig: () => Alternatives | undefined): Extension {
  const field = makeField(getConfig);
  const draw = ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    readonly lifetime = {};
    readonly view: EditorView;
    constructor(view: EditorView) {
      this.view = view;
      viewLifetimes.set(view, this.lifetime);
      this.decorations = decorations(view.state);
      // A cached state can return after its request was abandoned on a document
      // switch. Clear the stale hold once setState has finished mounting plugins.
      const request = read(view.state)?.request;
      if (request != null) queueMicrotask(() => {
        if (viewLifetimes.get(view) === this.lifetime && read(view.state)?.request === request) {
          view.dispatch({ effects: [releasePassage(request), askStatus.of({ request: null, error: null })] });
        }
      });
    }
    destroy() { if (viewLifetimes.get(this.view) === this.lifetime) viewLifetimes.delete(this.view); }
    update(update: ViewUpdate) {
      if (update.docChanged || read(update.startState) !== read(update.state)) this.decorations = decorations(update.state);
    }
  }, { decorations: (plugin) => plugin.decorations });
  const keys = keymap.of([
    { key: alternativeShortcuts[0].key, run: (view) => (read(view.state)?.panel ? closeAlternatives(view) : openAlternatives(view)) },
    { key: alternativeShortcuts[1].key, run: (view) => cycleAlternative(view, 1) },
    { key: alternativeShortcuts[2].key, run: (view) => cycleAlternative(view, -1) },
    { key: alternativeShortcuts[3].key, run: askForAlternatives },
    { key: "Escape", run: closeAlternatives },
  ]);
  // Escape hides the switcher only when nothing else wants it (Kin's marks).
  const hideKey = Prec.low(keymap.of([{ key: "Escape", run: hideVersionSwitcher }]));
  const external = ViewPlugin.fromClass(class {
    update(update: ViewUpdate) {
      const config = getConfig();
      if (!config?.externalPanel || read(update.startState) === read(update.state)) return;
      const before = read(update.startState)?.panel;
      const after = read(update.state)?.panel;
      config.onPanelChange?.(alternativesPanelModel(update.state));
      if (after && before?.key !== after.key) config.onPanelOpen?.();
      else if (before && !after) config.onPanelClose?.();
    }
  });
  return [heldPassages, askFacet.of(getConfig), field, draw, keys, hideKey, popover(field, getConfig), external, persistence(getConfig), switcherCard(field, getConfig), rest, alternativesTheme, panelTheme];
}

const alternativesTheme = EditorView.theme({
  ".cm-alt-span": {
    textDecorationLine: "underline", textDecorationStyle: "dotted", textDecorationThickness: "1.5px",
    textDecorationColor: "color-mix(in oklch, var(--neutral-10, currentColor) 40%, transparent)", textUnderlineOffset: "0.22em",
  },
  ".cm-alt-count, .cm-alt-gutter": {
    fontFamily: "var(--font-ui, var(--font-sans))", fontStyle: "normal", fontWeight: "500", letterSpacing: "0",
    color: "var(--neutral-7, var(--muted-foreground))", cursor: "pointer", userSelect: "none",
  },
  ".cm-alt-count": { display: "inline-flex", position: "relative", verticalAlign: "baseline", top: "0.5em", width: "0", justifyContent: "flex-end", gap: "2px", lineHeight: "0", pointerEvents: "auto" },
  ".cm-alt-dot": { display: "inline-block", flexShrink: "0", width: "3px", height: "3px", borderRadius: "50%", boxShadow: "inset 0 0 0 0.75px currentColor" },
  ".cm-alt-dot[data-current=true]": { background: "currentColor" },
  ".cm-alt-paragraph": { position: "relative" },
  ".cm-alt-gutter": {
    position: "absolute", left: "calc(var(--editor-gutter, 0px) - 22px)", top: "0.3em", minWidth: "14px", minHeight: "18px", boxSizing: "border-box", padding: "2px 4px",
    display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "3px", lineHeight: "1",
  },
  "@media (hover: hover) and (pointer: fine)": { ".cm-alt-count:hover, .cm-alt-gutter:hover": { color: "var(--neutral-10, var(--foreground))" } },
  ".cm-alt-open": { backgroundColor: "color-mix(in oklch, var(--neutral-10, currentColor) 8%, transparent)", borderRadius: "2px" },
  "@media (pointer: coarse)": { ".cm-alt-gutter": { left: "calc(var(--editor-gutter, 0px) - 30px)", minWidth: "24px", height: "24px" } },
  ".cm-alt-card-body": {
    display: "flex", alignItems: "center", gap: "var(--space-xxs, 4px)", width: "fit-content", padding: "var(--space-xxs, 4px)",
    borderRadius: "var(--radius-m, 8px)", background: "var(--popover, var(--background))", color: "var(--neutral-8, inherit)",
    boxShadow: "inset 0 0 0 1px var(--neutral-4, rgba(0,0,0,.1)), 0 6px 24px -12px rgba(0,0,0,.25)", fontVariantNumeric: "tabular-nums",
  },
  ".cm-alt-card-button": {
    border: "none", borderRadius: "var(--radius-s, 6px)", padding: "2px var(--space-xs, 8px)", minHeight: "24px",
    background: "transparent", color: "inherit", font: "inherit", cursor: "pointer",
  },
  ".cm-alt-card-button:hover": { background: "var(--neutral-3, rgba(0,0,0,.06))" },
  ".cm-alt-card-button:focus-visible": { outline: "2px solid var(--neutral-10, currentColor)", outlineOffset: "1px" },
});
