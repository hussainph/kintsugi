import { Facet, StateEffect, StateField, type ChangeDesc, type EditorState, type Extension, type Transaction } from "@codemirror/state";
import { Decoration, EditorView, keymap, showPanel, showTooltip, ViewPlugin, WidgetType, type DecorationSet, type Panel, type Tooltip, type ViewUpdate } from "@codemirror/view";
import { anchorAt, paragraphs, resolveAnchor, type CommentAnchor, type Range } from "./anchors.ts";
import { element } from "./menu.ts";
import { paragraphNear, paragraphRange } from "./references.ts";

/**
 * Kin's comment threads on paragraphs (KI-38): margin markers, a thread
 * popover (reply, resolve, reopen) and a panel for detached and resolved
 * threads. The host stores threads outside the document and runs Kin; this
 * extension only places them, keeps them on their paragraph as it's edited,
 * and draws them. It never changes the document, except to insert a
 * [[link]] Kin found when he drags it in or taps Insert.
 *
 * Plain DOM, like the `/` and `@` menus, so the phone's shared editor can
 * adopt it unchanged.
 */

export type { CommentAnchor } from "./anchors.ts";

export type CommentMessage = {
  seq: number;
  role: "owner" | "kin" | "helper";
  text: string;
  at: string;
  interrupted?: boolean;
  error?: string;
};

export type CommentThread = {
  id: string;
  anchor: CommentAnchor;
  status: "open" | "resolved";
  /** "mention" (`@Kin`), "discuss" (⌘K) or "review". */
  origin: string;
  created: string;
  /** Its paragraph couldn't be found when last seen. */
  orphaned?: boolean;
  messages: CommentMessage[];
};

/** Where a paragraph is now, for the chips a message carries. */
export type CommentPlace = { fromLine: number; toLine: number; text: string };

export type CommentMove = { id: string; anchor: CommentAnchor; orphaned: boolean };

/** How a [[link]] or path in Kin's reply reads, and what dragging it in writes. */
export type CommentLink = { label: string; link: string };

export type Comments = {
  /** The document `threads` belong to. Threads for another document are ignored. */
  path: string;
  threads: CommentThread[];
  /** Threads Kin is replying in now, with what it has said so far. */
  live?: Record<string, string>;
  /** Kin is reviewing the whole document. */
  reviewing?: boolean;
  /** The editor supplies this. */
  currentPath?: string;
  /** A new thread with his first message; resolves to its id. */
  onCreate: (anchor: CommentAnchor, place: CommentPlace, text: string) => Promise<string>;
  /** His reply; an empty `text` asks Kin again. */
  onReply: (id: string, text: string, place: CommentPlace | null) => void;
  onStatus: (id: string, status: CommentThread["status"]) => void;
  /** Anchors that moved with their paragraph, or lost it. */
  onMoved: (moves: CommentMove[]) => void;
  /** Stops Kin replying (`null`: stops the review). */
  onStop?: (id: string | null) => void;
  /** "Kin, review this draft". */
  onReview?: () => void;
  link?: (target: string) => CommentLink | null;
  onOpenLink?: (target: string) => void;
  /** Kin's avatar; a placeholder mark otherwise. */
  kinMark?: () => HTMLElement;
};

/** The host's threads changed: place new ones, redraw. */
export const refreshComments = StateEffect.define<null>();
const openThread = StateEffect.define<string | null>();
const startDraft = StateEffect.define<Range | null>();
const placeThread = StateEffect.define<{ id: string; range: Range }>();
const toggleResolved = StateEffect.define<null>();

type Field = {
  /** Thread id → its paragraph now, or null when it lost it (an orphan). */
  placed: ReadonlyMap<string, Range | null>;
  open: string | null;
  /** A thread being started on this paragraph, not saved until he sends. */
  draft: Range | null;
  showResolved: boolean;
  /** Bumped on every refresh, so drawings follow the host's data. */
  version: number;
};

const referenceMime = "application/x-kintsugi-reference";

/** Opens a new thread's composer on the paragraph at `from` (or the one above a blank line). */
export function startComment(view: EditorView, from: number, to = from): boolean {
  const range = paragraphNear(view.state, from) ?? paragraphNear(view.state, to);
  if (!range || !read(view.state)) return false;
  view.dispatch({ effects: [startDraft.of(range), openThread.of(null)] });
  return true;
}

/** Opens a thread's popover (or its card in the panel, if detached). */
export function openComment(view: EditorView, id: string | null) {
  view.dispatch({ effects: openThread.of(id) });
}

/** The body's paragraphs, each with an anchor, for "Kin, review this draft". */
export function reviewParagraphs(state: EditorState): { anchor: CommentAnchor; lines: [number, number] }[] {
  const text = state.doc.toString();
  return paragraphs(text)
    .filter((p) => {
      const body = text.slice(p.from, p.to);
      return !/^#{1,6}\s[^\n]*$/.test(body) && !/^(?:---|\*\*\*|___)$/.test(body) && !/^(?:import|export)\s/.test(body);
    })
    .map((p) => ({ anchor: anchorAt(text, p.from, p.to), lines: [state.doc.lineAt(p.from).number, state.doc.lineAt(p.to).number] }));
}

/** Where a thread's paragraph is now; null if it's detached or unknown. */
export function commentPlace(state: EditorState, id: string): CommentPlace | null {
  const range = read(state)?.placed.get(id);
  return range ? place(state, range) : null;
}

const place = (state: EditorState, range: Range): CommentPlace => ({
  fromLine: state.doc.lineAt(range.from).number,
  toLine: state.doc.lineAt(range.to).number,
  text: state.sliceDoc(range.from, range.to),
});

/** Moves a range with the edit, then onto the paragraph its start is in now.
 *  A range whose text was deleted outright collapses: the thread is orphaned. */
function mapRange(state: EditorState, range: Range, changes: ChangeDesc): Range | null {
  const from = changes.mapPos(range.from, 1);
  const to = changes.mapPos(range.to, -1);
  if (to <= from) return null;
  // Only edits on the paragraph's own lines can change its extent.
  const first = state.doc.lineAt(from).from;
  const last = state.doc.lineAt(to).to;
  let touched = false;
  changes.iterChangedRanges((_fromA, _toA, fromB, toB) => { touched ||= fromB <= last && toB >= first; });
  if (!touched) return { from, to };
  return paragraphRange(state, from) ?? paragraphRange(state, to) ?? { from, to };
}

const configFor = (getConfig: () => Comments | undefined) => {
  const config = getConfig();
  return config && config.path === config.currentPath ? config : undefined;
};

function reconcile(value: Field, state: EditorState, config: Comments | undefined): Field {
  if (!config) return value;
  const placed = new Map<string, Range | null>();
  let text: string | null = null;
  for (const thread of config.threads) {
    if (value.placed.has(thread.id)) placed.set(thread.id, value.placed.get(thread.id)!);
    else placed.set(thread.id, resolveAnchor(text ??= state.doc.toString(), thread.anchor));
  }
  return { ...value, placed, version: value.version + 1 };
}

/** Each document's state has its own field, reading that state's config. */
const fieldFacet = Facet.define<StateField<Field>, StateField<Field> | null>({ combine: (fields) => fields[0] ?? null });

function read(state: EditorState): Field | null {
  const field = state.facet(fieldFacet);
  return field ? state.field(field, false) ?? null : null;
}
const get = (state: EditorState): Field => read(state)!;

function makeField(getConfig: () => Comments | undefined) {
  return StateField.define<Field>({
    create: (state) => reconcile({ placed: new Map(), open: null, draft: null, showResolved: false, version: 0 }, state, configFor(getConfig)),
    update(value, tr: Transaction) {
      if (tr.docChanged) {
        const placed = new Map<string, Range | null>();
        let orphans = false;
        for (const [id, range] of value.placed) {
          const next = range && mapRange(tr.state, range, tr.changes);
          placed.set(id, next);
          if (!next) orphans = true;
        }
        // A detached thread whose text comes back (an undo) is found again.
        if (orphans) {
          const text = tr.state.doc.toString();
          for (const thread of configFor(getConfig)?.threads ?? []) {
            if (placed.get(thread.id) === null) placed.set(thread.id, resolveAnchor(text, thread.anchor, { exactOnly: true }));
          }
        }
        const draft = value.draft && mapRange(tr.state, value.draft, tr.changes);
        value = { ...value, placed, draft };
      }
      for (const effect of tr.effects) {
        if (effect.is(refreshComments)) value = reconcile(value, tr.state, configFor(getConfig));
        else if (effect.is(openThread)) value = { ...value, open: effect.value, draft: effect.value ? null : value.draft };
        else if (effect.is(startDraft)) value = { ...value, draft: effect.value };
        else if (effect.is(placeThread)) value = { ...value, placed: new Map(value.placed).set(effect.value.id, effect.value.range), open: effect.value.id, draft: null };
        else if (effect.is(toggleResolved)) value = { ...value, showResolved: !value.showResolved };
      }
      return value;
    },
    provide: (field) => fieldFacet.of(field),
  });
}

// --- Drawing ---------------------------------------------------------------

function kinMark(config: Comments | undefined): HTMLElement {
  const custom = config?.kinMark?.();
  if (custom) return custom;
  // Placeholder until KI-41's avatar: a dark bowl with a gold seam.
  const mark = element("span", "cm-comment-kin-mark");
  mark.setAttribute("aria-hidden", "true");
  return mark;
}

const visible = (thread: CommentThread, field: Field) => thread.status === "open" || field.showResolved || field.open === thread.id;

class Marker extends WidgetType {
  readonly ids: string[];
  readonly active: boolean;
  readonly resolved: boolean;
  readonly busy: boolean;
  constructor(ids: string[], active: boolean, resolved: boolean, busy: boolean) {
    super();
    this.ids = ids;
    this.active = active;
    this.resolved = resolved;
    this.busy = busy;
  }
  eq(other: Marker) {
    return other.ids.join() === this.ids.join() && other.active === this.active && other.resolved === this.resolved && other.busy === this.busy;
  }
  toDOM(view: EditorView) {
    const button = element("button", `cm-comment-marker${this.active ? " cm-comment-marker-active" : ""}${this.resolved ? " cm-comment-marker-resolved" : ""}${this.busy ? " cm-comment-marker-busy" : ""}`);
    button.type = "button";
    button.dataset.commentMarker = this.ids.join(" ");
    button.setAttribute("aria-label", `${this.ids.length === 1 ? "Comment thread" : `${this.ids.length} comment threads`}${this.resolved ? ", resolved" : ""}. Open`);
    button.setAttribute("aria-expanded", String(this.active));
    button.append(element("span", "cm-comment-marker-count", String(this.ids.length)));
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", (event) => {
      event.preventDefault();
      openComment(view, this.active ? null : this.ids[0]);
    });
    return button;
  }
  ignoreEvent() { return true; }
}

function decorations(state: EditorState, config: Comments | undefined): DecorationSet {
  const field = get(state);
  if (!config) return Decoration.none;
  const groups = new Map<number, { ids: string[]; range: Range; resolved: boolean; busy: boolean }>();
  for (const thread of config.threads) {
    const range = field.placed.get(thread.id);
    if (!range || !visible(thread, field)) continue;
    const group = groups.get(range.from) ?? { ids: [], range, resolved: true, busy: false };
    group.ids.push(thread.id);
    group.resolved &&= thread.status === "resolved";
    group.busy ||= config.live?.[thread.id] !== undefined;
    groups.set(range.from, group);
  }
  const active = field.open ? field.placed.get(field.open) : field.draft;
  const ranges = [];
  for (const group of [...groups.values()].sort((a, b) => a.range.from - b.range.from)) {
    const line = state.doc.lineAt(group.range.from);
    ranges.push(Decoration.line({ class: "cm-comment-line" }).range(line.from));
    const isActive = !!active && active.from === group.range.from;
    ranges.push(Decoration.widget({ widget: new Marker(group.ids, isActive, group.resolved, group.busy), side: -1 }).range(group.range.from));
  }
  if (active && active.to > active.from) ranges.push(Decoration.mark({ class: "cm-comment-active" }).range(active.from, active.to));
  return Decoration.set(ranges, true);
}

const pattern = /\[\[([^\[\]\n]+?)\]\]|((?:[\w.-]+\/)+[\w.-]+\.mdx?)\b/g;

/** Kin's text with each [[link]] or vault path as a chip he can drag in. */
function richText(text: string, config: Comments | undefined, insert: ((link: string) => void) | null): HTMLElement {
  const dom = element("div", "cm-comment-text");
  let at = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > at) dom.append(text.slice(at, match.index));
    const raw = match[1] ?? match[2];
    const [target, alias] = raw.split("|");
    const found = config?.link?.(target.trim()) ?? null;
    const link = found?.link ?? `[[${target.trim().replace(/\.mdx?$/, "")}]]`;
    const chip = element("span", "cm-comment-ref");
    chip.draggable = true;
    chip.dataset.commentLink = link;
    chip.title = "Drag into the draft to reference it; click to open";
    chip.append(element("span", "cm-comment-ref-label", alias?.trim() || found?.label || target.trim()));
    chip.addEventListener("dragstart", (event) => {
      if (!event.dataTransfer) return;
      event.dataTransfer.effectAllowed = "copy";
      event.dataTransfer.setData(referenceMime, JSON.stringify({ text: link }));
      event.dataTransfer.setData("text/plain", link);
    });
    chip.addEventListener("click", () => config?.onOpenLink?.(target.trim()));
    dom.append(chip);
    if (insert) {
      const add = element("button", "cm-comment-ref-insert", "+");
      add.type = "button";
      add.title = "Insert this reference after the paragraph's last word";
      add.setAttribute("aria-label", `Insert ${link} after the paragraph`);
      add.addEventListener("click", () => insert(link));
      dom.append(add);
    }
    at = match.index + match[0].length;
  }
  if (at < text.length) dom.append(text.slice(at));
  return dom;
}

const time = (at: string) => {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

function quote(text: string, max = 120) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** One thread: its messages, Kin's live reply, then actions. */
function renderMessages(view: EditorView, thread: CommentThread, config: Comments | undefined, range: Range | null): HTMLElement {
  const list = element("div", "cm-comment-messages");
  const insert = range && !view.state.readOnly
    ? (link: string) => {
        const now = get(view.state).placed.get(thread.id);
        if (!now) return;
        const at = now.to;
        view.dispatch({ changes: { from: at, insert: ` ${link}` }, userEvent: "input.reference" });
      }
    : null;
  for (const message of thread.messages) {
    const kin = message.role !== "owner";
    const row = element("div", `cm-comment-message${kin ? " cm-comment-message-kin" : ""}`);
    row.dataset.role = message.role;
    row.dataset.seq = String(message.seq);
    const author = element("div", "cm-comment-author");
    if (kin) author.append(kinMark(config), element("span", "cm-comment-name cm-comment-name-kin", "Kin"));
    else author.append(element("span", "cm-comment-name", "You"));
    author.append(element("span", "cm-comment-time", time(message.at)));
    row.append(author);
    if (message.error) row.append(element("div", "cm-comment-error", `Kin couldn’t answer: ${message.error}`));
    else row.append(kin ? richText(message.text, config, insert) : element("div", "cm-comment-text", message.text));
    if (message.interrupted) row.append(element("div", "cm-comment-note", "Interrupted"));
    list.append(row);
  }
  const live = config?.live?.[thread.id];
  if (live !== undefined) {
    const row = element("div", "cm-comment-message cm-comment-message-kin");
    row.dataset.live = "true";
    const author = element("div", "cm-comment-author");
    author.append(kinMark(config), element("span", "cm-comment-name cm-comment-name-kin", "Kin"), element("span", "cm-comment-time", "replying…"));
    const stop = element("button", "cm-comment-action", "Stop");
    stop.type = "button";
    stop.addEventListener("click", () => config?.onStop?.(thread.id));
    author.append(stop);
    row.append(author, element("div", "cm-comment-text", live || "Thinking…"));
    list.append(row);
  } else {
    const last = thread.messages[thread.messages.length - 1];
    if (last && (last.role === "owner" || last.error || last.interrupted)) {
      const row = element("div", "cm-comment-note");
      row.append(last.role === "owner" ? "No reply yet. " : "");
      const again = element("button", "cm-comment-action", "Ask again");
      again.type = "button";
      again.addEventListener("click", () => config?.onReply(thread.id, "", range && place(view.state, range)));
      row.append(again);
      list.append(row);
    }
  }
  return list;
}

/** A thread with its header, messages and a composer that survives re-renders. */
function threadCard(view: EditorView, getConfig: () => Comments | undefined, id: string, inPanel: boolean) {
  const dom = element("section", "cm-comment-thread");
  dom.dataset.commentThread = id;
  const header = element("header", "cm-comment-header");
  const body = element("div", "cm-comment-body");
  const composer = element("textarea", "cm-comment-input");
  composer.rows = 1;
  composer.placeholder = "Reply to Kin…";
  composer.setAttribute("aria-label", "Reply to Kin");
  const form = element("div", "cm-comment-compose");
  form.append(composer);
  dom.append(header, body, form);
  let signature = "";
  const send = () => {
    const text = composer.value.trim();
    const config = getConfig();
    if (!text || !config) return;
    composer.value = "";
    config.onReply(id, text, commentPlace(view.state, id));
  };
  composer.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(); }
    if (event.key === "Escape" && !inPanel) { event.preventDefault(); openComment(view, null); view.focus(); }
  });
  const render = () => {
    const config = configFor(getConfig);
    const thread = config?.threads.find((t) => t.id === id);
    if (!thread || !config) return;
    const range = get(view.state).placed.get(id) ?? null;
    const next = JSON.stringify([thread.status, thread.messages.length, thread.messages.at(-1)?.seq, config.live?.[id], !!range, thread.anchor.exact.length, Object.keys(config.live ?? {}).length]);
    if (next === signature) return;
    signature = next;
    header.replaceChildren();
    const title = element("span", "cm-comment-title", thread.status === "resolved" ? "Resolved" : range ? "Comment" : "Detached");
    header.append(title);
    const status = element("button", "cm-comment-action", thread.status === "resolved" ? "Reopen" : "Resolve");
    status.type = "button";
    status.addEventListener("click", () => {
      const resolving = thread.status === "open";
      config.onStatus(id, resolving ? "resolved" : "open");
      // Resolving puts it away, as in any comments UI.
      if (resolving && !inPanel) { openComment(view, null); view.focus(); }
      // Reopened: carry on the conversation (the button is redrawn away).
      else if (!resolving) requestAnimationFrame(() => composer.focus());
    });
    header.append(status);
    if (!inPanel) {
      const close = element("button", "cm-comment-close", "×");
      close.type = "button";
      close.setAttribute("aria-label", "Close comment");
      close.addEventListener("click", () => { openComment(view, null); view.focus(); });
      header.append(close);
    }
    body.replaceChildren();
    if (!range) body.append(element("blockquote", "cm-comment-was", `Was on: “${quote(thread.anchor.exact)}”`));
    body.append(renderMessages(view, thread, config, range));
    form.hidden = thread.status === "resolved";
  };
  render();
  return { dom, render, focus: () => composer.focus() };
}

/** The composer for a thread not yet saved: his first message creates it. */
function draftCard(view: EditorView, getConfig: () => Comments | undefined) {
  const dom = element("section", "cm-comment-thread cm-comment-draft");
  dom.dataset.commentDraft = "true";
  const header = element("header", "cm-comment-header");
  header.append(kinMark(getConfig()), element("span", "cm-comment-title", "Ask Kin about this paragraph"));
  const composer = element("textarea", "cm-comment-input");
  composer.rows = 2;
  composer.placeholder = "What do you want Kin to look at? Enter sends; empty asks for a general read.";
  composer.setAttribute("aria-label", "Ask Kin about this paragraph");
  const status = element("div", "cm-comment-note");
  const form = element("div", "cm-comment-compose");
  form.append(composer);
  dom.append(header, form, status);
  let sending = false;
  const cancel = () => { view.dispatch({ effects: startDraft.of(null) }); view.focus(); };
  composer.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); cancel(); }
    if (event.key !== "Enter" || event.shiftKey || event.isComposing || sending) return;
    event.preventDefault();
    const config = configFor(getConfig);
    const range = get(view.state).draft;
    if (!config || !range) return;
    sending = true;
    composer.disabled = true;
    status.textContent = "Sending…";
    const text = composer.value.trim() || "What do you think of this paragraph?";
    const doc = view.state.doc.toString();
    config.onCreate(anchorAt(doc, range.from, range.to), place(view.state, range), text).then((id) => {
      const now = get(view.state).draft ?? range;
      view.dispatch({ effects: [placeThread.of({ id, range: now }), refreshComments.of(null)] });
    }).catch((error) => {
      sending = false;
      composer.disabled = false;
      status.textContent = String(error instanceof Error ? error.message : error);
    });
  });
  return { dom, focus: () => composer.focus() };
}

function popover(field: StateField<Field>, getConfig: () => Comments | undefined): Extension {
  // One Tooltip object per open thread, so typing in its composer survives
  // updates; its position is moved in place.
  let cached: { key: string; tooltip: Tooltip & { pos: number } } | null = null;
  const tooltipFor = (state: EditorState): Tooltip | null => {
    const field = get(state);
    const config = configFor(getConfig);
    const id = field.open;
    const range = id ? field.placed.get(id) : field.draft;
    if (!range || !config || (id && !config.threads.some((t) => t.id === id))) return (cached = null);
    const key = id ?? "draft";
    if (cached?.key !== key) {
      cached = {
        key,
        tooltip: {
          pos: range.to,
          above: false,
          create: (view) => {
            const sameParagraph = id
              ? config.threads.filter((t) => t.id === id || (field.placed.get(t.id)?.from === range.from && visible(t, field))).map((t) => t.id)
              : [];
            const dom = element("div", "cm-comment-popover");
            dom.setAttribute("role", "dialog");
            dom.setAttribute("aria-label", id ? "Comment thread" : "New comment");
            // Escape anywhere in it (a button, the composer) puts it away.
            dom.addEventListener("keydown", (event) => {
              if (event.key !== "Escape" || event.defaultPrevented) return;
              event.preventDefault();
              view.dispatch({ effects: [openThread.of(null), startDraft.of(null)] });
              view.focus();
            });
            const cards = id ? sameParagraph.map((thread) => threadCard(view, getConfig, thread, false)) : [];
            const draft = id ? null : draftCard(view, getConfig);
            if (draft) dom.append(draft.dom);
            for (const card of cards) dom.append(card.dom);
            return {
              dom,
              mount: () => requestAnimationFrame(() => (draft ?? cards.find((c) => c.dom.dataset.commentThread === id))?.focus()),
              update: () => { for (const card of cards) card.render(); },
            };
          },
        },
      };
    } else cached.tooltip.pos = range.to;
    return cached.tooltip;
  };
  return showTooltip.compute([field], tooltipFor);
}

function panel(field: StateField<Field>, getConfig: () => Comments | undefined): Extension {
  const create = (view: EditorView): Panel => {
    const dom = element("div", "cm-comment-panel");
    dom.setAttribute("aria-label", "Comments");
    const bar = element("div", "cm-comment-panel-bar");
    const list = element("div", "cm-comment-panel-list");
    dom.append(bar, list);
    const cards = new Map<string, ReturnType<typeof threadCard>>();
    let signature = "";
    const render = () => {
      const config = configFor(getConfig);
      const field = get(view.state);
      const threads = config?.threads ?? [];
      const detached = threads.filter((t) => !field.placed.get(t.id) && (t.status === "open" || field.showResolved));
      const resolved = threads.filter((t) => t.status === "resolved");
      const open = threads.filter((t) => t.status === "open");
      const next = JSON.stringify([open.length, resolved.length, detached.map((t) => t.id), field.showResolved, config?.reviewing]);
      if (next !== signature) {
        signature = next;
        bar.replaceChildren();
        const counts = [`${open.length} open`, resolved.length ? `${resolved.length} resolved` : "", detached.length ? `${detached.length} detached` : ""].filter(Boolean).join(" · ");
        bar.append(element("span", "cm-comment-panel-title", "Comments"), element("span", "cm-comment-panel-counts", counts));
        if (config?.reviewing) {
          bar.append(element("span", "cm-comment-panel-status", "Kin is reviewing this draft…"));
          const stop = element("button", "cm-comment-action", "Stop");
          stop.type = "button";
          stop.addEventListener("click", () => config.onStop?.(null));
          bar.append(stop);
        } else if (config?.onReview) {
          const review = element("button", "cm-comment-action", "Kin, review this draft");
          review.type = "button";
          review.addEventListener("click", () => config.onReview?.());
          bar.append(review);
        }
        if (resolved.length) {
          const toggle = element("button", "cm-comment-action", field.showResolved ? "Hide resolved" : "Show resolved");
          toggle.type = "button";
          toggle.setAttribute("aria-pressed", String(field.showResolved));
          toggle.addEventListener("click", () => view.dispatch({ effects: toggleResolved.of(null) }));
          bar.append(toggle);
        }
        for (const [id, card] of cards) if (!detached.some((t) => t.id === id)) { card.dom.remove(); cards.delete(id); }
        for (const thread of detached) {
          if (!cards.has(thread.id)) {
            const card = threadCard(view, getConfig, thread.id, true);
            cards.set(thread.id, card);
            list.append(card.dom);
          }
        }
        list.hidden = !detached.length;
      }
      for (const card of cards.values()) card.render();
    };
    render();
    return { dom, update: render };
  };
  return showPanel.compute([field], (state) => {
    const config = configFor(getConfig);
    void state.field(field).version;
    return config && (config.threads.length || config.reviewing) ? create : null;
  });
}

/** The anchors that differ from what's stored (or was last sent, in `sent`):
 *  the paragraph's text now, or orphaned with the last text it was on. */
export function anchorMoves(state: EditorState, threads: CommentThread[], sent = new Map<string, string>()): CommentMove[] {
  const field = read(state);
  if (!field) return [];
  const text = state.doc.toString();
  const moves: CommentMove[] = [];
  for (const thread of threads) {
    if (!field.placed.has(thread.id)) continue;
    const range = field.placed.get(thread.id);
    const move = { id: thread.id, anchor: range ? anchorAt(text, range.from, range.to) : thread.anchor, orphaned: !range };
    const key = JSON.stringify(move);
    if (key === (sent.get(thread.id) ?? JSON.stringify({ id: thread.id, anchor: thread.anchor, orphaned: !!thread.orphaned }))) continue;
    sent.set(thread.id, key);
    moves.push(move);
  }
  return moves;
}

/** Tells the host about anchors that moved, once edits pause. */
function persistence(getConfig: () => Comments | undefined) {
  return ViewPlugin.fromClass(class {
    timer: ReturnType<typeof setTimeout> | undefined;
    sent = new Map<string, string>();
    readonly view: EditorView;
    constructor(view: EditorView) { this.view = view; this.schedule(); }
    update(update: ViewUpdate) {
      if (get(update.startState).placed !== get(update.state).placed) this.schedule();
    }
    schedule() {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.flush(), 700);
    }
    flush() {
      const config = configFor(getConfig);
      if (!config) return;
      const moves = anchorMoves(this.view.state, config.threads, this.sent);
      if (moves.length) config.onMoved(moves);
    }
    destroy() { clearTimeout(this.timer); this.flush(); }
  });
}

/** One extension per cached EditorState; callbacks read the current props. */
export function commentExtensions(getConfig: () => Comments | undefined): Extension {
  const field = makeField(getConfig);
  const configured = () => configFor(getConfig);
  const draw = ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = decorations(view.state, configured()); }
    update(update: ViewUpdate) {
      if (update.docChanged || get(update.startState) !== get(update.state)) this.decorations = decorations(update.state, configured());
    }
  }, { decorations: (plugin) => plugin.decorations });
  const close = keymap.of([{
    key: "Escape",
    run: (view) => {
      const value = view.state.field(field);
      if (!value.open && !value.draft) return false;
      view.dispatch({ effects: [openThread.of(null), startDraft.of(null)] });
      return true;
    },
  }]);
  return [field, draw, close, popover(field, getConfig), panel(field, getConfig), persistence(getConfig), commentTheme];
}

const kin = "var(--kin, oklch(0.66 0.125 76))";
const kinInk = "var(--kin-ink, oklch(0.5 0.1 68))";

const commentTheme = EditorView.theme({
  ".cm-comment-line": { position: "relative" },
  ".cm-comment-marker": {
    position: "absolute", right: "-30px", top: "0.25em", width: "24px", height: "22px", padding: "0", border: "1px solid var(--border)",
    borderRadius: "11px 11px 11px 3px", backgroundColor: "var(--background)", color: "var(--muted-foreground)", cursor: "pointer",
    display: "grid", placeItems: "center", fontFamily: "var(--font-sans)", fontSize: "11px", fontStyle: "normal", fontWeight: "500", lineHeight: "1",
  },
  ".cm-comment-marker:hover, .cm-comment-marker-active": { borderColor: kin, color: kinInk },
  ".cm-comment-marker-active": { backgroundColor: `color-mix(in oklch, ${kin} 14%, var(--background))` },
  ".cm-comment-marker-resolved": { opacity: ".55" },
  ".cm-comment-marker-busy": { borderColor: kin },
  ".cm-comment-marker:focus-visible": { outline: `2px solid ${kin}`, outlineOffset: "2px" },
  ".cm-comment-active": { backgroundColor: `color-mix(in oklch, ${kin} 12%, transparent)`, borderRadius: "2px" },
  ".cm-tooltip.cm-comment-popover": {
    width: "min(360px, calc(100vw - 16px))", maxHeight: "min(440px, 60vh)", overflowY: "auto", boxSizing: "border-box",
    border: "1px solid var(--border)", borderRadius: "10px", backgroundColor: "var(--popover)", color: "var(--foreground)",
    boxShadow: "0 10px 28px #0003", fontFamily: "var(--font-sans)", fontSize: "13px", fontWeight: "400", fontStyle: "normal", lineHeight: "1.5", letterSpacing: "normal",
  },
  ".cm-comment-thread": { padding: "10px 12px", display: "flex", flexDirection: "column", gap: "8px" },
  ".cm-comment-thread + .cm-comment-thread": { borderTop: "1px solid var(--border)" },
  ".cm-comment-header": { display: "flex", alignItems: "center", gap: "8px" },
  ".cm-comment-title": { flex: "1", fontSize: "11px", fontWeight: "500", letterSpacing: ".04em", textTransform: "uppercase", color: "var(--muted-foreground)" },
  ".cm-comment-close": { border: "none", background: "none", color: "var(--muted-foreground)", fontSize: "16px", lineHeight: "1", cursor: "pointer", padding: "2px 4px" },
  ".cm-comment-action": { font: "inherit", fontSize: "12px", color: "var(--primary)", background: "none", border: "none", padding: "2px 0", cursor: "pointer" },
  ".cm-comment-action:focus-visible, .cm-comment-close:focus-visible": { outline: "2px solid var(--primary)", outlineOffset: "2px" },
  ".cm-comment-messages": { display: "flex", flexDirection: "column", gap: "10px" },
  ".cm-comment-message": { display: "flex", flexDirection: "column", gap: "2px" },
  ".cm-comment-message-kin": { borderLeft: `2px solid ${kin}`, paddingLeft: "8px" },
  ".cm-comment-author": { display: "flex", alignItems: "center", gap: "6px", fontSize: "12px" },
  ".cm-comment-name": { fontWeight: "600" },
  ".cm-comment-name-kin": { color: kinInk },
  ".cm-comment-time": { color: "var(--muted-foreground)", fontSize: "11px" },
  ".cm-comment-kin-mark": {
    width: "14px", height: "14px", borderRadius: "50%", flexShrink: "0", display: "inline-block",
    background: `linear-gradient(135deg, transparent 46%, ${kin} 46%, ${kin} 56%, transparent 56%), var(--foreground)`,
  },
  ".cm-comment-text": { whiteSpace: "pre-wrap", overflowWrap: "anywhere", userSelect: "text" },
  ".cm-comment-error": { color: "var(--destructive)" },
  ".cm-comment-note": { color: "var(--muted-foreground)", fontSize: "12px" },
  ".cm-comment-was": { margin: "0", padding: "4px 8px", borderLeft: "2px solid var(--border)", color: "var(--muted-foreground)", fontStyle: "italic", fontSize: "12px" },
  ".cm-comment-ref": {
    display: "inline", padding: "1px 6px", borderRadius: "5px", cursor: "grab", boxDecorationBreak: "clone",
    backgroundColor: `color-mix(in oklch, ${kin} 14%, transparent)`, color: "var(--foreground)",
  },
  ".cm-comment-ref-insert": { font: "inherit", fontSize: "11px", marginLeft: "2px", padding: "0 4px", border: "none", background: "none", color: kinInk, cursor: "pointer" },
  ".cm-comment-compose": { display: "flex" },
  ".cm-comment-input": {
    flex: "1", font: "inherit", resize: "vertical", minHeight: "32px", padding: "6px 8px", borderRadius: "6px", border: "1px solid var(--border)",
    backgroundColor: "var(--background)", color: "var(--foreground)", boxSizing: "border-box",
  },
  ".cm-comment-input:focus": { outline: "none", borderColor: kin },
  // Below the app's own popovers (⌘K), which CodeMirror's 300 would cover.
  ".cm-panels.cm-panels-bottom": { zIndex: "20" },
  ".cm-panels-bottom .cm-comment-panel": { fontFamily: "var(--font-sans)", fontSize: "12px", borderTop: "1px solid var(--border)", maxHeight: "40vh", overflowY: "auto" },
  ".cm-comment-panel-bar": { display: "flex", alignItems: "center", gap: "12px", padding: "6px 16px", flexWrap: "wrap" },
  ".cm-comment-panel-title": { fontWeight: "600" },
  ".cm-comment-panel-counts, .cm-comment-panel-status": { color: "var(--muted-foreground)", flex: "1" },
  ".cm-comment-panel-list": { display: "grid", gap: "8px", padding: "0 16px 10px", gridTemplateColumns: "repeat(auto-fill, minmax(min(320px, 100%), 1fr))" },
  ".cm-comment-panel-list .cm-comment-thread": { border: "1px solid var(--border)", borderRadius: "8px" },
  "@media (pointer: coarse)": {
    ".cm-comment-marker": { width: "32px", height: "30px", right: "-34px" },
    ".cm-comment-action": { minHeight: "32px" },
  },
});
