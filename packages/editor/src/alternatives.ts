import { isolateHistory } from "@codemirror/commands";
import { EditorSelection, Facet, StateEffect, StateField, Transaction, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, keymap, showTooltip, ViewPlugin, WidgetType, type DecorationSet, type Tooltip, type ViewUpdate } from "@codemirror/view";
import { anchorAt, type CommentAnchor, type Range } from "./anchors.ts";
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
  onPanelChange?: (model: PanelModel | null) => void;
};

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
  /** Keep cycling the span just swapped until the writer moves or edits. */
  cycleId: string | null;
  request: number | null;
  askError: string | null;
};

/** The host's sets changed (a document loaded): place new ones. */
export const refreshAlternatives = StateEffect.define<null>();
const putSet = StateEffect.define<Live>();
const dropSet = StateEffect.define<string>();
/** Its positions are in the document before the transaction's changes. */
const setPanel = StateEffect.define<Panel | null>();
const cycleSet = StateEffect.define<string>();
const askStatus = StateEffect.define<{ request: number | null; error: string | null }>();
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
    create: (state) => reconcile({ loaded: false, baseline: "[]", sets: new Map(), removed: new Set(), panel: null, cycleId: null, request: null, askError: null }, state, configFor(getConfig)),
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
        } else if (effect.is(setPanel)) value = { ...value, panel: effect.value && mapPanel(tr, effect.value) };
        else if (effect.is(askStatus)) value = { ...value, request: effect.value.request, askError: effect.value.error };
        else if (effect.is(cycleSet)) value = { ...value, cycleId: effect.value };
      }
      // In the margin, versions follow the writer's cursor. Panel commands
      // carry their own target and must not be retargeted by a swap.
      const followsCursor = !!value.panel && !!tr.selection && getConfig()?.externalPanel && !tr.effects.some((effect) => effect.is(setPanel));
      if (value.panel && followsCursor) {
        const selection = tr.state.selection.main;
        const phrase = selection.empty ? null : { from: selection.from, to: selection.to };
        const level = phrase ? levelOf(tr.state, phrase) : value.panel.level === "phrase" ? "word" : value.panel.level;
        value = { ...value, panel: { ...value.panel, pos: phrase ? phrase.from : selection.head, phrase: level === "phrase" ? phrase : null, exact: !!phrase, want: undefined, level, setId: null, homes: {}, highlight: 0 } };
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

function setFor(state: EditorState, level: SpanLevel, range: Range | null, pos: number, field = read(state)): Live | null {
  if (!field) return null;
  return (range && exactSet(state, range, field)) ?? setsAt(state, pos, field).find((s) => s.level === level && level !== "phrase") ?? null;
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

function levelsAt(state: EditorState, panel: Panel): SpanLevel[] {
  const out: SpanLevel[] = [];
  if (panel.phrase) out.push("phrase");
  else if (spanAt(state, "word", panel.pos, null)) out.push("word");
  if (paragraphRange(state, panel.pos)) out.push("sentence", "paragraph");
  return out;
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

/** Opens the panel on the selection, or on the cursor's word (the smallest
 *  span with alternatives there, if any). */
export function openAlternatives(view: ViewLike): boolean {
  const field = read(view.state);
  if (!field) return false;
  const selection = view.state.selection.main;
  const phrase = selection.empty ? null : { from: selection.from, to: selection.to };
  let level: SpanLevel;
  if (phrase) level = levelOf(view.state, phrase);
  else level = setsAt(view.state, selection.head)[0]?.level ?? "word";
  if (level === "word" && !phrase && !spanAt(view.state, "word", selection.head, null)) level = "sentence";
  const pos = phrase ? phrase.from : selection.head;
  const range = spanAt(view.state, level, pos, phrase);
  if (!range) return false;
  const live = phrase ? exactSet(view.state, range) : setFor(view.state, level, range, pos);
  const highlight = live ? live.entries.findIndex((e) => e.id === live.current) : 0;
  view.dispatch({ effects: setPanel.of({ key: ++openings, pos, phrase: level === "phrase" ? phrase : null, exact: !!phrase, level, setId: live?.id ?? null, homes: {}, highlight }) });
  return true;
}

export function closeAlternatives(view: ViewLike): boolean {
  if (!read(view.state)?.panel) return false;
  view.dispatch({ effects: setPanel.of(null) });
  return true;
}

/** Shows the next (1) or previous (-1) version of the panel's set, or of the
 *  smallest set at the cursor. */
export function cycleAlternative(view: ViewLike, direction: 1 | -1): boolean {
  const field = read(view.state);
  if (!field || view.state.readOnly) return false;
  const panel = field.panel;
  const recent = field.cycleId ? field.sets.get(field.cycleId) : null;
  const live = panel ? target(view.state, field, panel).live : recent?.range ? recent : setsAt(view.state, view.state.selection.main.head)[0];
  if (!live?.range) return false;
  const at = live.entries.findIndex((e) => e.id === live.current);
  const next = live.entries[(at + direction + live.entries.length) % live.entries.length];
  const effects = panel ? [setPanel.of({ ...panel, setId: live.id, highlight: live.entries.indexOf(next) })] : [];
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

/** Ask on the panel's span, or open it on the selection/cursor first.
 *  A held passage prevents an answer from landing on text edited while waiting. */
export function askForAlternatives(view: ViewLike): boolean {
  const config = configFor(view.state.facet(askFacet));
  let field = read(view.state);
  if (!field || !config?.ask || view.state.readOnly) return false;
  if (field.request !== null) return true;
  if (!field.panel && !openAlternatives(view)) return false;
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
    askKin: () => { askForAlternatives(view); },
    cycle: (direction: 1 | -1) => { cycleAlternative(view, direction); },
    close: () => { closeAlternatives(view); refocus(); },
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
  return {
    level: panel.level, levels: levelsAt(state, panel), entries, highlight: panel.highlight, readOnly: state.readOnly,
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
    dom.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const live = read(view.state)?.sets.get(this.id);
      if (!live?.range) return;
      view.dispatch({ selection: EditorSelection.cursor(live.range.from) });
      const highlight = live.entries.findIndex((e) => e.id === live.current);
      view.dispatch({ effects: setPanel.of({ key: ++openings, pos: live.range.from, phrase: live.level === "phrase" ? live.range : null, level: live.level, setId: live.id, homes: {}, highlight }) });
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
  const external = ViewPlugin.fromClass(class {
    update(update: ViewUpdate) {
      const config = getConfig();
      if (!config?.externalPanel || read(update.startState) === read(update.state)) return;
      const before = read(update.startState)?.panel;
      const after = read(update.state)?.panel;
      config.onPanelChange?.(alternativesPanelModel(update.state));
      if (after && before?.key !== after.key) config.onPanelOpen?.();
    }
  });
  return [heldPassages, askFacet.of(getConfig), field, draw, keys, popover(field, getConfig), external, persistence(getConfig), alternativesTheme, panelTheme];
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
    position: "absolute", left: "-22px", top: "0.3em", minWidth: "14px", minHeight: "18px", boxSizing: "border-box", padding: "2px 4px",
    display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "3px", lineHeight: "1",
  },
  "@media (hover: hover) and (pointer: fine)": { ".cm-alt-count:hover, .cm-alt-gutter:hover": { color: "var(--neutral-10, var(--foreground))" } },
  ".cm-alt-open": { backgroundColor: "color-mix(in oklch, var(--neutral-10, currentColor) 8%, transparent)", borderRadius: "2px" },
  "@media (pointer: coarse)": { ".cm-alt-gutter": { left: "-30px", minWidth: "24px", height: "24px" } },
});
