import { historyKeymap, invertedEffects, isolateHistory, redo, undo } from "@codemirror/commands";
import { EditorSelection, Facet, Prec, StateEffect, StateField, Transaction, type ChangeDesc, type EditorState, type Extension, type StateCommand } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, keymap, type ViewUpdate } from "@codemirror/view";
import { anchorAt, resolveAnchor, type CommentAnchor, type Range } from "./anchors.ts";
import { paragraphRange } from "./references.ts";

export type StashItem = {
  id: string;
  by: "owner" | "kin";
  kind: "text" | "idea" | "rewrite";
  text: string;
  created: string;
  anchor?: CommentAnchor;
};

export type Stash = {
  path: string;
  items: StashItem[];
  currentPath?: string;
  onSave: (path: string, items: StashItem[]) => void;
  /** After a stash from the draft (key, button, ⌘K or drag), with the new item's id. */
  onStashed?: (id: string) => void;
  onPicker?: () => void;
  /** Rejected operations leave the document and undo history unchanged. */
  onError?: (message: string) => void;
  /** Includes metadata-only edits, undo, and newly loaded items. */
  onUpdate?: (path: string, items: StashItem[]) => void;
  /** Current-document UI callback; unlike onSave it is not debounced. */
  onChange?: (items: StashItem[]) => void;
};

export const stashMime = "application/x-kintsugi-stash";
/** A selection dragged out of the draft (KI-110): its path, span and words. */
export const draftSelectionMime = "application/x-kintsugi-draft-selection";
export const stashShortcuts = [
  { key: "Mod-Alt-x", label: "Stash" },
  { key: "Mod-Alt-v", label: "Insert from stash" },
] as const;
export const refreshStash = StateEffect.define<null>();

// Keep these in sync with src-tauri/src/stash.rs::validate/save_unlocked.
const MAX_ITEMS = 500;
const MAX_TEXT_CHARS = 8_000;
const MAX_ID_CHARS = 128;
const MAX_CREATED_BYTES = 128;
const MAX_CONTEXT_CHARS = 64;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MARKER = "<!-- kintsugi-stash ";
const SEPARATOR = "\n\n---\n\n";
const utf8 = new TextEncoder();
const fullMessage = "The stash is full. Remove an item first.";
const invalidMessage = "Invalid stash item.";

/** Rust counts Unicode scalar values, not UTF-16 units or grapheme clusters.
 * Lone surrogates cannot be deserialized into a Rust String. */
function withinChars(text: string, limit: number): boolean {
  let count = 0;
  for (const char of text) {
    if (++count > limit || (char.length === 1 && /[\uD800-\uDFFF]/u.test(char))) return false;
  }
  return true;
}

/** anchors.ts uses UTF-16 offsets. Its short context slices can bisect a
 * surrogate pair; drop that partial context, never any selected prose. */
function stashAnchorAt(text: string, from: number, to: number): CommentAnchor {
  const anchor = anchorAt(text, from, to);
  if (/^[\uDC00-\uDFFF]/u.test(anchor.prefix)) anchor.prefix = anchor.prefix.slice(1);
  if (/[\uD800-\uDBFF]$/u.test(anchor.suffix)) anchor.suffix = anchor.suffix.slice(0, -1);
  return anchor;
}

type Live = { item: StashItem; range: Range | null };
type Field = {
  loaded: boolean;
  path: string | null;
  baseline: string;
  items: readonly Live[];
  removed: ReadonlySet<string>;
  focus: Range | null;
};
type Mutation = { put?: readonly Live[]; remove?: readonly string[]; order?: readonly string[] };

/** Keep a damaged span's position, but never treat its changed words as the
 * rewrite's target. Undo restores the precise old positions separately. */
function mapRange(range: Range, changes: ChangeDesc): Range {
  let replacement: Range | null = null;
  changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    if (fromA === range.from && toA === range.to && toA > fromA) replacement = { from: fromB, to: toB };
  });
  if (replacement) return replacement;
  const from = changes.mapPos(range.from, range.from === range.to ? -1 : 1);
  return { from, to: Math.max(from, changes.mapPos(range.to, range.from === range.to ? 1 : -1)) };
}

const mutate = StateEffect.define<Mutation>({
  map: (value, changes) => ({ ...value, put: value.put?.map((live) => ({ ...live, range: live.range && mapRange(live.range, changes) })) }),
});
const restoreRanges = StateEffect.define<readonly { id: string; range: Range | null }[]>({
  map: (value, changes) => value.map((entry) => ({ ...entry, range: entry.range && mapRange(entry.range, changes) })),
});
const setFocus = StateEffect.define<Range | null>({ map: (range, changes) => range && mapRange(range, changes) });
const fieldFacet = Facet.define<StateField<Field>, StateField<Field> | null>({ combine: (fields) => fields[0] ?? null });
const configFacet = Facet.define<() => Stash | undefined, (() => Stash | undefined) | null>({ combine: (values) => values[0] ?? null });
const controllerFacet = Facet.define<ViewPlugin<Controller>, ViewPlugin<Controller> | null>({ combine: (values) => values[0] ?? null });

function read(state: EditorState): Field | null {
  const field = state.facet(fieldFacet);
  return field ? state.field(field, false) ?? null : null;
}

function configFor(getConfig: () => Stash | undefined): Stash | undefined {
  const config = getConfig();
  return config && (config.currentPath === undefined || config.path === config.currentPath) ? config : undefined;
}
const configAt = (state: EditorState) => {
  const getConfig = state.facet(configFacet);
  return getConfig ? configFor(getConfig) : undefined;
};

function writable(state: EditorState): Field | null {
  const field = read(state);
  const config = configAt(state);
  // An editor without a stash host (including the phone), a failed load,
  // or next-document props must never cut prose into an unsaved sidecar.
  return !state.readOnly && field?.loaded && config?.path === field.path ? field : null;
}

function validAnchor(value: unknown): value is CommentAnchor {
  if (!value || typeof value !== "object") return false;
  const anchor = value as CommentAnchor;
  return typeof anchor.exact === "string" && !!anchor.exact.trim() && withinChars(anchor.exact, MAX_TEXT_CHARS) &&
    typeof anchor.prefix === "string" && withinChars(anchor.prefix, MAX_CONTEXT_CHARS) &&
    typeof anchor.suffix === "string" && withinChars(anchor.suffix, MAX_CONTEXT_CHARS) &&
    Number.isInteger(anchor.line) && anchor.line > 0 && anchor.line <= 0xffffffff;
}

export function isStashItem(value: unknown): value is StashItem {
  if (!value || typeof value !== "object") return false;
  const item = value as StashItem;
  return typeof item.id === "string" && !!item.id.trim() && withinChars(item.id, MAX_ID_CHARS) && !/\p{Cc}/u.test(item.id) &&
    (item.by === "owner" || item.by === "kin") && (item.kind === "text" || item.kind === "idea" || item.kind === "rewrite") &&
    typeof item.text === "string" && !!item.text.trim() && withinChars(item.text, MAX_TEXT_CHARS) &&
    typeof item.created === "string" && withinChars(item.created, MAX_CREATED_BYTES) && utf8.encode(item.created).length <= MAX_CREATED_BYTES &&
    (item.anchor === undefined || validAnchor(item.anchor)) && (item.kind !== "rewrite" || validAnchor(item.anchor));
}

/** Includes the Markdown file cap: otherwise individually valid Unicode
 * items can exceed 4 MiB and make an already-cut passage impossible to save. */
function boundsError(items: readonly StashItem[]): string | null {
  if (items.length > MAX_ITEMS) return fullMessage;
  const ids = new Set<string>();
  let bytes = 1; // The file's trailing newline.
  for (const item of items) {
    if (!isStashItem(item) || ids.has(item.id)) {
      if (item && typeof item.text === "string" && !withinChars(item.text, MAX_TEXT_CHARS)) return "Stash text exceeds 8,000 characters.";
      return invalidMessage;
    }
    ids.add(item.id);
    const { text, ...metadata } = copyItem(item);
    const escaped = text.includes(MARKER);
    const json = JSON.stringify(escaped ? { ...metadata, markerEscaped: true } : metadata)
      .replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
    const body = escaped ? text.replaceAll("&", "&amp;").replaceAll(MARKER, "&lt;!-- kintsugi-stash ") : text;
    bytes += utf8.encode(json).length + utf8.encode(body).length + MARKER.length + " -->\n\n".length;
    if (ids.size > 1) bytes += SEPARATOR.length;
    if (bytes > MAX_FILE_BYTES) return "The stash is too large. Remove an item first.";
  }
  return null;
}

function reject(state: EditorState, message: string): false {
  configAt(state)?.onError?.(message);
  return false;
}

/** CodeMirror history bypasses transaction filters. Check its proposed
 * transaction before dispatch: undo must not delete draft prose when a shared
 * arrival has filled the room needed to restore the consumed stash item. */
function boundedHistory(command: StateCommand) {
  return (view: EditorView): boolean => command({ state: view.state, dispatch: (tr) => {
    const error = tr.effects.some((effect) => effect.is(mutate)) && boundsError(stashItems(tr.state));
    if (error) reject(tr.startState, error);
    else view.dispatch(tr);
  } });
}
const boundedUndo = boundedHistory(undo);
const boundedRedo = boundedHistory(redo);

const copyItem = ({ id, by, kind, text, created, anchor }: StashItem): StashItem => ({ id, by, kind, text, created, ...(anchor ? { anchor: { ...anchor } } : {}) });
const place = (text: string, item: StashItem): Live => ({ item: copyItem(item), range: item.anchor ? resolveAnchor(text, item.anchor, { exactOnly: true }) : null });

function reconcile(value: Field, state: EditorState, config: Stash | undefined): Field {
  if (!config || (value.path !== null && value.path !== config.path) || boundsError(config.items)) return value;
  const items = [...value.items];
  const known = new Set(items.map((live) => live.item.id));
  const valid = config.items.filter(isStashItem);
  let text: string | null = null;
  for (const item of valid) {
    // A delayed load or a stale save echo must not resurrect consumed items
    // or overwrite local edits and ordering.
    if (known.has(item.id) || value.removed.has(item.id)) continue;
    items.push(place(text ??= state.doc.toString(), item));
    known.add(item.id);
  }
  return {
    ...value, loaded: true, path: config.path, items,
    baseline: value.loaded ? value.baseline : JSON.stringify(valid.map(copyItem)),
  };
}

function applyMutation(value: Field, change: Mutation): Field {
  const removed = new Set(value.removed);
  let items = value.items.filter((live) => !change.remove?.includes(live.item.id));
  for (const id of change.remove ?? []) removed.add(id);
  for (const live of change.put ?? []) {
    removed.delete(live.item.id);
    const at = items.findIndex((entry) => entry.item.id === live.item.id);
    if (at < 0) items = [...items, live];
    else items = items.map((entry, index) => index === at ? live : entry);
  }
  if (change.order) {
    const positions = new Map(change.order.map((id, index) => [id, index]));
    items = [...items].sort((a, b) => (positions.get(a.item.id) ?? Infinity) - (positions.get(b.item.id) ?? Infinity));
  }
  return { ...value, items, removed };
}

function makeField(getConfig: () => Stash | undefined) {
  return StateField.define<Field>({
    create: (state) => reconcile({ loaded: false, path: null, baseline: "[]", items: [], removed: new Set(), focus: null }, state, configFor(getConfig)),
    update(value, tr) {
      if (tr.docChanged) value = {
        ...value,
        items: value.items.map((live) => live.range ? { ...live, range: mapRange(live.range, tr.changes) } : live),
        focus: null,
      };
      for (const effect of tr.effects) {
        if (effect.is(refreshStash)) value = reconcile(value, tr.state, configFor(getConfig));
        else if (effect.is(mutate)) value = applyMutation(value, effect.value);
        else if (effect.is(restoreRanges)) {
          const ranges = new Map(effect.value.map((entry) => [entry.id, entry.range]));
          value = { ...value, items: value.items.map((live) => ranges.has(live.item.id) ? { ...live, range: ranges.get(live.item.id)! } : live) };
        } else if (effect.is(setFocus)) value = { ...value, focus: effect.value };
      }
      return value;
    },
    provide: (field) => [
      fieldFacet.of(field),
      EditorView.decorations.from(field, (value) => value.focus && value.focus.to > value.focus.from
        ? Decoration.set([Decoration.mark({ class: "cm-stash-focus" }).range(value.focus.from, value.focus.to)]) : Decoration.none),
    ],
  });
}

const invert = invertedEffects.of((tr) => {
  const before = read(tr.startState);
  if (!before) return [];
  const effects: StateEffect<unknown>[] = [];
  const changes = tr.effects.filter((effect) => effect.is(mutate));
  if (changes.length) {
    const ids = new Set(changes.flatMap((effect) => [...(effect.value.put?.map((live) => live.item.id) ?? []), ...(effect.value.remove ?? [])]));
    effects.push(mutate.of({
      put: before.items.filter((live) => ids.has(live.item.id)),
      remove: [...ids].filter((id) => !before.items.some((live) => live.item.id === id)),
      order: before.items.map((live) => live.item.id),
    }));
  }
  // Unlike a fresh quote search, undo cannot jump a stale rewrite onto an
  // identical phrase elsewhere. Restore the original tracked span exactly.
  if (tr.docChanged || tr.effects.some((effect) => effect.is(restoreRanges))) effects.push(restoreRanges.of(before.items.filter((live) => live.item.anchor).map((live) => ({ id: live.item.id, range: live.range }))));
  return effects;
});

function exactRange(state: EditorState, live: Live): Range | null {
  const range = live.range;
  return range && live.item.anchor && range.to <= state.doc.length && state.sliceDoc(range.from, range.to) === live.item.anchor.exact ? range : null;
}

/** Items as stored now. An anchor's quote stays fixed; only matching spans
 * get fresh context and line numbers. A stale rewrite never adopts new words. */
export function stashItems(state: EditorState): StashItem[] {
  let text: string | null = null;
  return (read(state)?.items ?? []).map((live) => {
    const item = copyItem(live.item);
    const range = exactRange(state, live);
    if (range) item.anchor = stashAnchorAt(text ??= state.doc.toString(), range.from, range.to);
    return item;
  });
}
export const stashToSave = stashItems;

let counter = 0;
const newId = () => `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${counter++}`;

/** What ⌥⌘X would stash now: the selection, else the cursor's paragraph.
 * Null in a read-only or unloaded stash, or on a blank paragraph. */
export function stashTargetAt(state: EditorState): { from: number; to: number; selection: boolean } | null {
  if (!writable(state)) return null;
  const selection = state.selection.main;
  const range = selection.empty ? paragraphRange(state) : selection;
  if (!range || !state.sliceDoc(range.from, range.to).trim()) return null;
  return { from: range.from, to: range.to, selection: !selection.empty };
}

/** Moves the selection, else its paragraph, out of the draft. Both halves
 * belong to one isolated undo step. Blank paragraphs and read-only views refuse. */
export function stashSelection(view: EditorView): boolean {
  const selection = view.state.selection.main;
  const range = selection.empty ? paragraphRange(view.state) : selection;
  return !!range && stashRange(view, range.from, range.to);
}

/** Moves one span out of the draft, as stashSelection does: ⌘K's passage
 * and a dragged selection name theirs. */
export function stashRange(view: EditorView, from: number, to: number): boolean {
  const state = view.state;
  const field = writable(state);
  if (!field) return false;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > state.doc.length || from >= to) return false;
  if (field.items.length >= MAX_ITEMS) return reject(state, fullMessage);
  const text = state.sliceDoc(from, to);
  if (!text.trim()) return false;
  const item: StashItem = { id: newId(), by: "owner", kind: "text", text, created: new Date().toISOString(), anchor: stashAnchorAt(state.doc.toString(), from, to) };
  const error = boundsError([...stashItems(state), item]);
  if (error) return reject(state, error);
  view.dispatch({
    changes: { from, to },
    selection: EditorSelection.cursor(from),
    effects: mutate.of({ put: [{ item, range: null }] }),
    annotations: isolateHistory.of("full"), userEvent: "delete.stash", scrollIntoView: true,
  });
  configAt(view.state)?.onStashed?.(item.id);
  return true;
}

/** The drag payload a draft selection carries, or null when it can't be stashed. */
export function draftSelectionData(state: EditorState): string | null {
  const field = writable(state);
  const { from, to, empty } = state.selection.main;
  if (!field || empty) return null;
  return JSON.stringify({ path: field.path, from, to, text: state.sliceDoc(from, to) });
}

/** Stashes a selection dropped on the Stash tab, if it still reads as it did
 * when the drag began. Another document's drag, or changed words, do nothing. */
export function stashDropped(view: EditorView, data: string): boolean {
  try {
    const payload: unknown = JSON.parse(data);
    if (!payload || typeof payload !== "object") return false;
    const { path, from, to, text } = payload as Record<string, unknown>;
    if (path !== read(view.state)?.path || typeof from !== "number" || typeof to !== "number" || typeof text !== "string") return false;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > view.state.doc.length || view.state.sliceDoc(from, to) !== text) return false;
    return stashRange(view, from, to);
  } catch {
    return false;
  }
}

/** Explicit Ask Kin / Stash-on-reply entry point. No autonomous producer or
 * proactive add API exists. Invalid batches and duplicate IDs reject atomically. */
export function addRequestedStashItems(view: EditorView, items: readonly StashItem[]): boolean {
  const field = writable(view.state);
  if (!field || !Array.isArray(items) || !items.length) return false;
  const error = boundsError([...stashItems(view.state), ...items]);
  if (error) return reject(view.state, error);
  const text = view.state.doc.toString();
  view.dispatch({ effects: mutate.of({ put: items.map((item) => place(text, item)) }), annotations: isolateHistory.of("full"), userEvent: "input.stash" });
  return true;
}

/** Stash on a reply is an explicit request, so it can keep an idea. */
export function stashKinReply(view: EditorView, text: string): string | null {
  if (typeof text !== "string" || !text.trim()) return null;
  const item: StashItem = { id: newId(), by: "kin", kind: "idea", text, created: new Date().toISOString() };
  return addRequestedStashItems(view, [item]) ? item.id : null;
}

/** Stash on one of Kin's asked rewrites (KI-109): its words, kept for
 *  later against the span they'd replace. */
export function stashRewrite(view: EditorView, range: Range, text: string): string | null {
  if (typeof text !== "string" || !text.trim() || range.from < 0 || range.to > view.state.doc.length || range.to <= range.from) return null;
  const anchor = stashAnchorAt(view.state.doc.toString(), range.from, range.to);
  const item: StashItem = { id: newId(), by: "kin", kind: "rewrite", text, created: new Date().toISOString(), anchor };
  return addRequestedStashItems(view, [item]) ? item.id : null;
}

export function addStashNote(view: EditorView, text: string): string | null {
  if (typeof text !== "string" || !text.trim()) return null;
  const item: StashItem = { id: newId(), by: "owner", kind: "text", text, created: new Date().toISOString() };
  return addRequestedStashItems(view, [item]) ? item.id : null;
}

/** Text and ideas insert at the cursor (a drop supplies its position). A
 * rewrite replaces only its still-exact tracked span, regardless of the cursor.
 * Consuming the item and changing the draft undo and redo together. */
export function insertStashItem(view: EditorView, id: string, position?: number): boolean {
  const state = view.state;
  const field = writable(state);
  const live = field?.items.find((entry) => entry.item.id === id);
  if (!live) return false;
  const at = position ?? state.selection.main.head;
  if (!Number.isInteger(at) || at < 0 || at > state.doc.length) return false;
  const range = live.item.kind === "rewrite" ? exactRange(state, live) : { from: at, to: at };
  if (!range) return false;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: live.item.text },
    selection: EditorSelection.cursor(range.from + live.item.text.length),
    effects: mutate.of({ remove: [id] }),
    annotations: isolateHistory.of("full"), userEvent: "input.stash", scrollIntoView: true,
  });
  view.focus();
  return true;
}

export function removeStashItem(view: EditorView, id: string): boolean {
  if (!writable(view.state)?.items.some((live) => live.item.id === id)) return false;
  view.dispatch({ effects: mutate.of({ remove: [id] }), annotations: isolateHistory.of("full"), userEvent: "delete.stash" });
  return true;
}

/** A complete permutation prevents accidentally dropping items during a drag. */
export function reorderStashItems(view: EditorView, ids: readonly string[]): boolean {
  const field = writable(view.state);
  if (!field || !Array.isArray(ids) || ids.length !== field.items.length || new Set(ids).size !== ids.length || ids.some((id) => !field.items.some((live) => live.item.id === id))) return false;
  if (ids.every((id, index) => field.items[index].item.id === id)) return false;
  view.dispatch({ effects: mutate.of({ order: [...ids] }), annotations: isolateHistory.of("full"), userEvent: "input.stash" });
  return true;
}

export function moveStashItem(view: EditorView, id: string, toIndex: number): boolean {
  const ids = read(view.state)?.items.map((live) => live.item.id);
  const from = ids?.indexOf(id) ?? -1;
  if (!ids || from < 0 || !Number.isInteger(toIndex) || toIndex < 0 || toIndex >= ids.length) return false;
  ids.splice(from, 1);
  ids.splice(toIndex, 0, id);
  return reorderStashItems(view, ids);
}

/** Focus does not consume the item or edit the draft. */
export function focusStashItem(view: EditorView, id: string): boolean {
  const live = read(view.state)?.items.find((entry) => entry.item.id === id);
  const range = live && exactRange(view.state, live);
  if (!range) return false;
  view.dispatch({ effects: setFocus.of(range), annotations: Transaction.addToHistory.of(false) });
  return true;
}

export function openStashPicker(view: EditorView): boolean {
  const config = configAt(view.state);
  if (!writable(view.state) || !config?.onPicker) return false;
  config.onPicker();
  return true;
}

/** cubic-bezier(.25, 1, .5, 1), evaluated against elapsed time, not its parameter. */
function eased(time: number): number {
  let low = 0, high = 1;
  for (let i = 0; i < 16; i++) {
    const t = (low + high) / 2;
    const x = 0.75 * (1 - t) ** 2 * t + 1.5 * (1 - t) * t ** 2 + t ** 3;
    if (x < time) low = t; else high = t;
  }
  return 1 - (1 - (low + high) / 2) ** 3;
}

class Controller {
  state: EditorState;
  config: Stash | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  highlightTimer: ReturnType<typeof setTimeout> | undefined;
  frame: number | undefined;
  sent: string | null = null;
  notified: string | null = null;
  notifiedItems: readonly Live[] | null = null;
  alive = true;
  readonly view: EditorView;
  constructor(view: EditorView) {
    this.view = view;
    this.state = view.state;
    this.capture();
    this.notify();
    this.schedule();
  }
  capture() {
    const config = configAt(this.state);
    if (config && config.path === read(this.state)?.path) {
      if (config.onUpdate !== this.config?.onUpdate || config.onChange !== this.config?.onChange) this.notified = null;
      this.config = { ...config };
    }
  }
  update(update: ViewUpdate) {
    this.state = update.state;
    this.capture();
    this.notify();
    if (read(update.startState)?.items !== read(update.state)?.items || read(update.startState)?.loaded !== read(update.state)?.loaded) {
      this.schedule();
    }
    const focused = update.transactions.some((tr) => tr.effects.some((effect) => effect.is(setFocus) && effect.value));
    if (focused) this.reveal();
    else if (update.docChanged || !read(update.state)?.focus) this.cancelMotion();
  }
  notify() {
    const field = read(this.state);
    if (!field?.loaded || (!this.config?.onUpdate && !this.config?.onChange)) return;
    if (field.items === this.notifiedItems && this.notified !== null) return;
    this.notifiedItems = field.items;
    const items = stashItems(this.state);
    const json = JSON.stringify(items);
    if (json === this.notified) return;
    this.notified = json;
    if (this.config.onUpdate) this.config.onUpdate(field.path!, items);
    else this.config.onChange?.(items);
  }
  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 700);
  }
  flush() {
    clearTimeout(this.timer);
    const field = read(this.state);
    // Keep the last matching callback and path, not the next document's
    // props: setState destroys this plugin after React has changed those.
    if (!field?.loaded || !this.config || this.config.path !== field.path) return;
    const items = stashItems(this.state);
    const json = JSON.stringify(items);
    if (json === (this.sent ?? field.baseline)) return;
    this.config.onSave(field.path!, items);
    this.sent = json;
  }
  cancelMotion() {
    if (this.frame !== undefined) this.view.dom.ownerDocument.defaultView!.cancelAnimationFrame(this.frame);
    this.frame = undefined;
  }
  reveal() {
    this.cancelMotion();
    clearTimeout(this.highlightTimer);
    const range = read(this.state)?.focus;
    if (!range) return;
    const state = this.state;
    this.view.requestMeasure({
      key: this,
      read: (view) => {
        const coords = view.coordsAtPos(range.from);
        // Distant paragraphs may not have DOM yet. CodeMirror's block
        // geometry still gives a scroll target outside its rendered viewport.
        const top = coords?.top ?? view.documentTop + view.lineBlockAt(range.from).top;
        const rect = view.scrollDOM.getBoundingClientRect();
        return Math.max(0, Math.min(view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight, view.scrollDOM.scrollTop + top - rect.top - view.scrollDOM.clientHeight / 3));
      },
      write: (target, view) => {
        if (!this.alive || this.state !== state || target === null) return;
        const scroller = view.scrollDOM;
        const win = view.dom.ownerDocument.defaultView!;
        const start = scroller.scrollTop;
        if (win.matchMedia("(prefers-reduced-motion: reduce)").matches) scroller.scrollTop = target;
        else {
          let began: number | null = null;
          const step = (time: number) => {
            if (!this.alive || this.state !== state) return;
            began ??= time;
            const progress = Math.min(1, (time - began) / 280);
            scroller.scrollTop = start + (target - start) * (progress === 1 ? 1 : eased(progress));
            this.frame = progress < 1 ? win.requestAnimationFrame(step) : undefined;
          };
          this.frame = win.requestAnimationFrame(step);
        }
        this.highlightTimer = setTimeout(() => {
          if (this.alive && read(view.state)?.focus === range) view.dispatch({ effects: setFocus.of(null), annotations: Transaction.addToHistory.of(false) });
        }, 1200);
      },
    });
  }
  destroy() {
    this.alive = false;
    this.cancelMotion();
    clearTimeout(this.highlightTimer);
    this.flush();
  }
}

export function flushStash(view: EditorView): void {
  const plugin = view.state.facet(controllerFacet);
  if (plugin) view.plugin(plugin)?.flush();
}

/** One extension per cached document. Its callbacks always read current props. */
export function stashExtensions(getConfig: () => Stash | undefined): Extension {
  const controller = ViewPlugin.fromClass(Controller);
  return [
    configFacet.of(getConfig), makeField(getConfig), invert, controller, controllerFacet.of(controller),
    Prec.high(keymap.of(historyKeymap.map((binding) => ({
      ...binding, run: binding.run === undo ? boundedUndo : binding.run === redo ? boundedRedo : binding.run,
    })))),
    keymap.of([{ key: stashShortcuts[0].key, run: stashSelection }, { key: stashShortcuts[1].key, run: openStashPicker }]),
    EditorView.domEventHandlers({
      dragstart(event, view) {
        // Leaves CodeMirror's own text drag alone; the Stash tab reads this.
        const data = event.dataTransfer && draftSelectionData(view.state);
        if (data) event.dataTransfer!.setData(draftSelectionMime, data);
        return false;
      },
      dragover(event) {
        if (!event.dataTransfer?.types.includes(stashMime)) return false;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        return true;
      },
      drop(event, view) {
        if (!event.dataTransfer?.types.includes(stashMime)) return false;
        // Always consume our MIME, including invalid/stale payloads. Otherwise
        // CodeMirror could insert its text/plain fallback without consuming it.
        event.preventDefault();
        try {
          const payload: unknown = JSON.parse(event.dataTransfer.getData(stashMime));
          if (!payload || typeof payload !== "object" || !("id" in payload) || typeof payload.id !== "string") return true;
          if ("path" in payload && payload.path !== (read(view.state)?.path ?? configAt(view.state)?.path)) return true;
          const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (position !== null) insertStashItem(view, payload.id, position);
        } catch { /* Malformed custom data does not become draft text. */ }
        return true;
      },
      wheel(_event, view) { const plugin = view.state.facet(controllerFacet); if (plugin) view.plugin(plugin)?.cancelMotion(); return false; },
      touchstart(_event, view) { const plugin = view.state.facet(controllerFacet); if (plugin) view.plugin(plugin)?.cancelMotion(); return false; },
    }),
    EditorView.theme({ ".cm-stash-focus": { backgroundColor: "var(--neutral-5-transparent)" } }),
  ];
}

/** Used by React hosts; every method reads the view's current document. */
export function stashCommands(view: EditorView) {
  return {
    stashSelection: () => stashSelection(view),
    stashRange: (from: number, to: number) => stashRange(view, from, to),
    stashItems: () => stashItems(view.state),
    addRequestedStashItems: (items: readonly StashItem[]) => addRequestedStashItems(view, items),
    addStashNote: (text: string) => addStashNote(view, text),
    stashKinReply: (text: string) => stashKinReply(view, text),
    insertStashItem: (id: string, position?: number) => insertStashItem(view, id, position),
    removeStashItem: (id: string) => removeStashItem(view, id),
    reorderStashItems: (ids: readonly string[]) => reorderStashItems(view, ids),
    moveStashItem: (id: string, toIndex: number) => moveStashItem(view, id, toIndex),
    focusStashItem: (id: string) => focusStashItem(view, id),
    openStashPicker: () => openStashPicker(view),
    flushStash: () => flushStash(view),
  };
}
