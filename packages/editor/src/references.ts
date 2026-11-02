import { isolateHistory } from "@codemirror/commands";
import { EditorSelection, EditorState, Prec, RangeSetBuilder, StateEffect, StateField, type Extension, type Text, type Transaction } from "@codemirror/state";
import { Decoration, EditorView, hoverTooltip, keymap, showTooltip, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { attributedQuote, ignoredSpans, isReferenceContext, linkFor, outside, resolveReference, searchReferences, wikilinksIn, yamlEnd, type ReferenceSource, type Span, type Wikilink } from "@kintsugi/core/references";
import { element, hint, menuTheme, reveal } from "./menu.ts";

/** Where Kin is asked in: the paragraph under the cursor once `@Kin` is gone
 *  (or the one above a blank line). KI-38 anchors a comment thread here. */
export type KinAnchor = { from: number; to: number; text: string; fromLine: number; toLine: number };

export type References = {
  sources: ReferenceSource[];
  /** The editor supplies this; a file need not suggest itself as a source. */
  currentPath?: string;
  /** May return additional full-source lexical matches. Stale results are ignored. */
  search?: (query: string) => Promise<ReferenceSource[]>;
  /** Search cards may carry a truncated preview. Quotes always read own text in full. */
  readClipText?: (source: ReferenceSource) => Promise<string>;
  onError?: (error: unknown) => void;
  onOpen: (source: ReferenceSource) => void;
  onParagraph?: (text: string) => void;
  /** `@Kin` at the top of the `@` picker. Without it, `@` lists only references. */
  onKin?: (anchor: KinAnchor) => void;
};

export const refreshReferences = StateEffect.define<null>();
const referenceMime = "application/x-kintsugi-reference";
/** `[[` and `@` open the same picker and write the same `[[link]]`; `@` also
 *  offers Kin first. */
type Picker = { trigger: "link" | "mention"; from: number; to: number; query: string; results: ReferenceSource[]; index: number; loading: boolean; kin: boolean };
type Option = ReferenceSource | "kin";
const options = (picker: Picker): Option[] => picker.kin ? ["kin", ...picker.results] : picker.results;
const optionKey = (option: Option | undefined) => option === "kin" ? "kin" : option?.path;
const indexOf = (picker: Picker, key: string | undefined) => Math.max(0, options(picker).findIndex((option) => optionKey(option) === key));
const setPicker = StateEffect.define<Picker | null>();
/** Escape remembers where it closed, so typing on doesn't reopen it there. */
const dismissPicker = StateEffect.define<number>();
const dismissedField = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    if (value !== null && tr.docChanged) value = tr.changes.mapPos(value, -1);
    for (const effect of tr.effects) if (effect.is(dismissPicker)) value = effect.value;
    // Leaving the line (or deleting the trigger) forgets it.
    if (value !== null && (value >= tr.state.doc.length || tr.state.doc.lineAt(value).number !== tr.state.doc.lineAt(tr.state.selection.main.head).number)) value = null;
    return value;
  },
});
const searchResults = StateEffect.define<{ from: number; query: string; sources: ReferenceSource[] }>();
// Keep clips within reach even in a large writing vault. Documents still
// lead, after anything whose title matches: "@golden" finds Golden joinery
// before a draft that only mentions it.
function pickerResults(sources: ReferenceSource[], query: string) {
  const documents = sources.filter((source) => source.kind === "document").slice(0, 24);
  const clips = sources.filter((source) => source.kind === "clip").slice(0, 16);
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return [...documents, ...clips];
  const titled = (source: ReferenceSource) => terms.every((term) => source.title.toLocaleLowerCase().includes(term));
  return [...documents.filter(titled), ...clips.filter(titled), ...documents.filter((s) => !titled(s)), ...clips.filter((s) => !titled(s))];
}

/** Where the document's links are, and which regions can't hold one
 *  (YAML, code, comments): what `parseWikilinks` and `isReferenceContext`
 *  would say about the whole text. Kept up to date per change without
 *  re-reading the document, so typing in a long one stays cheap. */
type ReferenceIndex = { yaml: number; ignored: Span[]; links: Wikilink[] };

function indexText(text: string): ReferenceIndex {
  const ignored = ignoredSpans(text);
  return { yaml: yamlEnd(text), ignored, links: wikilinksIn(text, 0, ignored) };
}

// Characters that can open or close an ignored region (fences, inline code,
// comments, escapes, block quotes around a fence) or change line endings.
const structural = /[`~\\<>\r\uFEFF]/;

/** The index after `tr`, or null when the change could move an ignored
 *  region and the document has to be read again. A change elsewhere moves
 *  the regions without changing them, and only the lines it touched can
 *  gain or lose links. */
export function updateIndex(index: ReferenceIndex, tr: Pick<Transaction, "changes" | "startState" | "newDoc">): ReferenceIndex | null {
  const before = tr.startState.doc;
  const after = tr.newDoc;
  const touched: Span[] = [];
  let local = true;
  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    if (!local) return;
    const first = before.lineAt(fromA);
    // The first line can start YAML, and the YAML's lines can end it.
    if (first.number === 1 || fromA <= index.yaml) return void (local = false);
    if (structural.test(before.sliceString(first.from, before.lineAt(toA).to)) || structural.test(inserted.toString())) return void (local = false);
    const from = after.lineAt(fromB).from;
    const to = after.lineAt(toB).to;
    const last = touched[touched.length - 1];
    if (last && from <= last.to) last.to = Math.max(last.to, to);
    else touched.push({ from, to });
  });
  if (!local) return null;
  // An unclosed fence or comment runs on to the end, and keeps doing so.
  const ignored = index.ignored.map((span) => ({ from: tr.changes.mapPos(span.from, 1), to: tr.changes.mapPos(span.to, span.to === before.length ? 1 : -1) }));
  const links: Wikilink[] = [];
  let next = 0;
  const kept = index.links.map((link) => ({ ...link, from: tr.changes.mapPos(link.from, 1), to: tr.changes.mapPos(link.to, -1) }));
  for (const range of touched) {
    while (next < kept.length && kept[next].from < range.from) links.push(kept[next++]);
    while (next < kept.length && kept[next].from <= range.to) next++;
    links.push(...wikilinksIn(after.sliceString(range.from, range.to), range.from, ignored));
  }
  while (next < kept.length) links.push(kept[next++]);
  return { yaml: index.yaml, ignored, links };
}

export const referenceIndex = StateField.define<ReferenceIndex>({
  create: (state) => indexText(state.doc.toString()),
  update: (index, tr) => (tr.docChanged ? updateIndex(index, tr) ?? indexText(tr.newDoc.toString()) : index),
});

/** The link at `pos`, if any. */
function linkAt(links: readonly Wikilink[], pos: number): Wikilink | undefined {
  const link = links[firstLinkFrom(links, pos)];
  return link && link.from <= pos ? link : undefined;
}

/** Index of the first link ending at or after `pos`. Links are sorted and
 *  don't overlap. */
function firstLinkFrom(links: readonly Wikilink[], pos: number): number {
  let lo = 0;
  let hi = links.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (links[mid].to < pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function pickerAt(state: EditorState, config: References | undefined): Picker | null {
  if (!config || !state.selection.main.empty) return null;
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  const before = state.sliceDoc(line.from, head);
  const match = /\[\[([^\[\]\n|#]*)$/.exec(before);
  if (!match) return mentionAt(state, config, line.from, before);
  const from = line.from + match.index;
  const prefix = before.slice(0, match.index);
  if ((prefix.match(/\\+$/)?.[0].length ?? 0) % 2 || !inReferenceContext(state, from)) return null;
  // Editing a complete link replaces the entire target, not just its prefix.
  const tail = state.sliceDoc(head, line.to);
  const closing = /^[^\[\]]*\]\]/.exec(tail);
  const to = closing ? head + closing[0].length : head;
  if (state.field(dismissedField, false) === from) return null;
  return { trigger: "link", from, to, query: match[1], results: localResults(match[1], config), index: 0, loading: !!config.search, kin: false };
}

const localResults = (query: string, config: References) => pickerResults(searchReferences(query, config.sources.filter((source) => source.path !== config.currentPath)), query);

/** `@` after a space, an opening bracket or a line start (never mid-word, as
 *  in an email address). A space ends it unless a title still matches, so
 *  "@karpathy said" stays prose. */
function mentionAt(state: EditorState, config: References, lineFrom: number, before: string): Picker | null {
  const match = /(?:^|[\s([{"'“‘])@([^\s@\[\]|#][^@\[\]\n|#]{0,39})?$/u.exec(before);
  if (!match) return null;
  const from = lineFrom + match.index + match[0].indexOf("@");
  if (!inReferenceContext(state, from) || state.field(dismissedField, false) === from) return null;
  const query = match[1] ?? "";
  const results = localResults(query, config);
  const kin = !!config.onKin && "kin".startsWith(query.toLocaleLowerCase());
  const needle = query.trim().toLocaleLowerCase();
  if (/\s/.test(query) && !results.some((source) => source.title.toLocaleLowerCase().includes(needle))) return null;
  return { trigger: "mention", from, to: from + 1 + query.length, query, results, index: 0, loading: !!config.search, kin };
}

function merged(local: readonly ReferenceSource[], remote: readonly ReferenceSource[]): ReferenceSource[] {
  const unique = new Map(local.map((source) => [source.path, source]));
  for (const source of remote) unique.set(source.path, source);
  return [...unique.values()].sort((a, b) => Number(a.kind === "clip") - Number(b.kind === "clip") || a.title.localeCompare(b.title));
}

/** A single normal transaction: link/quote/drop are undoable without resetting
 *  document state or grouping the insertion with the next typed paragraph. */
function insert(view: EditorView, from: number, to: number, text: string, quote = false) {
  if (quote) {
    const before = view.state.sliceDoc(0, from);
    const after = view.state.sliceDoc(to);
    if (before.trim() && !/\n[\t ]*\n[\t ]*$/.test(before)) text = (before.endsWith("\n") ? "\n" : "\n\n") + text;
    // The next line can otherwise become Markdown's lazy continuation of the
    // attribution blockquote, even when the current line has no remainder.
    if (after.trim() && !/^\n[\t ]*\n/.test(after)) text += after.startsWith("\n") ? "\n" : "\n\n";
  }
  view.dispatch({
    changes: { from, to, insert: text },
    selection: EditorSelection.cursor(from + text.length),
    effects: setPicker.of(null),
    annotations: isolateHistory.of("full"),
    userEvent: "input.complete",
    scrollIntoView: true,
  });
  view.focus();
}

function thumbnail(source: ReferenceSource, className: string): HTMLImageElement | null {
  if (!source.image) return null;
  const image = element("img", className);
  image.src = source.image; // Only the desktop supplies display URLs; never HTML from a clip.
  image.alt = "";
  image.loading = "lazy";
  image.addEventListener("error", () => { image.hidden = true; }, { once: true });
  return image;
}

class ReferenceChip extends WidgetType {
  readonly link: Wikilink;
  readonly source: ReferenceSource | null;
  constructor(link: Wikilink, source: ReferenceSource | null) { super(); this.link = link; this.source = source; }
  eq(other: ReferenceChip) {
    return this.link.from === other.link.from && this.link.to === other.link.to && this.link.target === other.link.target
      && this.link.alias === other.link.alias && this.source?.title === other.source?.title && this.source?.site === other.source?.site
      && this.source?.path === other.source?.path;
  }
  toDOM() {
    const chip = element("span", `cm-reference-chip${this.source ? "" : " cm-reference-unresolved"}`);
    chip.dataset.referenceFrom = String(this.link.from);
    chip.dataset.referenceTo = String(this.link.to);
    chip.append(element("span", "cm-reference-label", this.link.alias || this.source?.title || this.link.target));
    if (this.source?.kind === "clip" && this.source.site) chip.append(element("span", "cm-reference-site", this.source.site));
    chip.setAttribute("aria-label", this.source ? `${this.source.title}. Command or Control click to open; click to edit reference.` : `Unresolved reference: ${this.link.target}`);
    return chip;
  }
  ignoreEvent() { return false; }
}

/** One extension per cached EditorState. Callbacks read the current React
 *  props rather than capturing the sources from when a document was opened. */
export function referenceExtensions(getConfig: () => References | undefined): Extension {
  const pickerField = StateField.define<Picker | null>({
    create: () => null,
    update(value, tr) {
      if (tr.docChanged || tr.selection || tr.effects.some((effect) => effect.is(refreshReferences))) {
        const previous = value;
        value = pickerAt(tr.state, getConfig());
        if (value && previous && value.from === previous.from && value.query === previous.query) {
          value = { ...value, index: indexOf(value, optionKey(options(previous)[previous.index])) };
        }
      }
      for (const effect of tr.effects) {
        if (effect.is(setPicker)) value = effect.value;
        if (effect.is(searchResults) && value && effect.value.from === value.from && effect.value.query === value.query) {
          const selected = optionKey(options(value)[value.index]);
          const results = pickerResults(merged(value.results, effect.value.sources).filter((source) => source.path !== getConfig()?.currentPath), value.query);
          value = { ...value, results, loading: false };
          value = { ...value, index: indexOf(value, selected) };
        }
      }
      return value;
    },
    provide: (field) => showTooltip.from(field, (picker) => picker ? { pos: picker.from, above: false, create: createPicker } : null),
  });

  function choose(view: EditorView, option?: Option, quote = false): boolean {
    const picker = view.state.field(pickerField);
    const config = getConfig();
    if (!picker || !config) return false;
    option ??= options(picker)[picker.index];
    // A mention with nothing to choose is just prose: let Enter through.
    if (!option) return picker.trigger === "link";
    if (option === "kin") return askKin(view, picker, config);
    const source = option;
    const link = linkFor(source, merged(config.sources, picker.results));
    if (quote && source.kind === "clip") {
      insertQuote(view, source, picker.from, picker.to, link);
    } else insert(view, picker.from, picker.to, link);
    return true;
  }

  /** Takes `@Kin` back out and hands Kin the paragraph. Nothing is written. */
  function askKin(view: EditorView, picker: Picker, config: References): boolean {
    view.dispatch({ changes: { from: picker.from, to: picker.to }, selection: EditorSelection.cursor(picker.from), effects: setPicker.of(null), userEvent: "delete.mention" });
    const range = paragraphNear(view.state, picker.from);
    const doc = view.state.doc;
    const anchor: KinAnchor = range
      ? { ...range, text: view.state.sliceDoc(range.from, range.to), fromLine: doc.lineAt(range.from).number, toLine: doc.lineAt(range.to).number }
      : { from: picker.from, to: picker.from, text: "", fromLine: doc.lineAt(picker.from).number, toLine: doc.lineAt(picker.from).number };
    config.onKin?.(anchor);
    return true;
  }

  function insertQuote(view: EditorView, source: ReferenceSource, from: number, to: number, link: string) {
    const config = getConfig();
    const doc = view.state.doc;
    const selection = view.state.selection;
    const apply = (passage: string) => {
      if (view.dom?.isConnected === false || view.state.doc !== doc || !view.state.selection.eq(selection)) return;
      const quote = attributedQuote(passage, link, source);
      if (quote) insert(view, from, to, quote, true);
    };
    if (config?.readClipText) void config.readClipText(source).then(apply).catch((error) => config.onError?.(error));
    else apply(source.text ?? "");
  }

  function createPicker(view: EditorView) {
    const dom = element("div", "cm-reference-picker cm-kintsugi-menu");
    dom.setAttribute("aria-label", "Insert a reference");
    dom.setAttribute("role", "dialog");
    const list = element("div", "cm-reference-options cm-kintsugi-menu-options");
    list.id = `kintsugi-references-${Math.random().toString(36).slice(2)}`;
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Documents and clips");
    const hintRow = element("div", "cm-reference-hint cm-kintsugi-menu-hint");
    hintRow.setAttribute("aria-live", "polite");
    dom.append(list, hintRow);
    dom.addEventListener("mousedown", (event) => event.preventDefault());
    function render() {
      const picker = view.state.field(pickerField);
      if (!picker) return;
      list.replaceChildren();
      options(picker).forEach((source, index) => {
        const row = element("div", "cm-reference-option cm-kintsugi-menu-option");
        row.id = `${list.id}-${index}`;
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", String(index === picker.index));
        if (source === "kin") {
          row.classList.add("cm-reference-kin");
          const labels = element("div", "cm-kintsugi-menu-labels");
          labels.append(element("div", "cm-kintsugi-menu-title", "Kin"), element("div", "cm-kintsugi-menu-meta", "Ask Kin about this paragraph"));
          row.append(element("span", "cm-kintsugi-menu-icon", "@"), labels);
          row.addEventListener("click", () => choose(view, "kin"));
          list.append(row);
          return;
        }
        const image = source.kind === "clip" ? thumbnail(source, "cm-reference-thumbnail") : null;
        if (image) row.append(image);
        const labels = element("div", "cm-reference-option-labels cm-kintsugi-menu-labels");
        labels.append(element("div", "cm-reference-option-title cm-kintsugi-menu-title", source.title));
        labels.append(element("div", "cm-reference-option-meta cm-kintsugi-menu-meta", source.kind === "document" ? source.status || "Document" : source.site || "Clip"));
        row.append(labels);
        row.addEventListener("click", (event) => choose(view, source, event.shiftKey));
        list.append(row);
      });
      const all = options(picker);
      const selected = all[picker.index];
      const canQuote = selected !== "kin" && selected?.kind === "clip" && !!attributedQuote(selected.text ?? "", "[[reference]]");
      const searching = picker.loading ? " · Searching…" : "";
      if (!all.length) hint(hintRow, picker.loading ? "Searching… · Esc Close" : "No references found · Esc Close", picker.loading ? "Searching…" : "No references found");
      else if (selected === "kin") hint(hintRow, `↑↓ Choose · Enter Ask Kin · Esc Close${searching}`, `Tap Kin to ask about this paragraph, or a reference to link it${searching}`);
      else hint(hintRow, `↑↓ Choose · Enter Insert link${canQuote ? " · Shift+Enter Quote clip" : ""} · Esc Close${searching}`, `Tap to insert a link${searching}`);
      view.contentDOM.setAttribute("aria-controls", list.id);
      view.contentDOM.setAttribute("aria-expanded", "true");
      view.contentDOM.setAttribute("aria-autocomplete", "list");
      if (selected) view.contentDOM.setAttribute("aria-activedescendant", `${list.id}-${picker.index}`);
      else view.contentDOM.removeAttribute("aria-activedescendant");
      reveal(list, list.children[picker.index] as HTMLElement | undefined);
    }
    render();
    return {
      dom,
      update: render,
      destroy() {
        view.contentDOM.removeAttribute("aria-controls");
        view.contentDOM.removeAttribute("aria-expanded");
        view.contentDOM.removeAttribute("aria-autocomplete");
        view.contentDOM.removeAttribute("aria-activedescendant");
      },
    };
  }

  const asyncSearch = ViewPlugin.fromClass(class {
    timer: ReturnType<typeof setTimeout> | undefined;
    sequence = 0;
    readonly view: EditorView;
    constructor(view: EditorView) { this.view = view; this.request(); }
    update(update: ViewUpdate) {
      const old = update.startState.field(pickerField);
      const current = update.state.field(pickerField);
      if (old?.query !== current?.query || old?.from !== current?.from || update.transactions.some((tr) => tr.effects.some((effect) => effect.is(refreshReferences)))) this.request();
    }
    request() {
      clearTimeout(this.timer);
      const sequence = ++this.sequence;
      const picker = this.view.state.field(pickerField);
      const search = getConfig()?.search;
      if (!picker || !search) return;
      this.timer = setTimeout(() => {
        Promise.resolve().then(() => search(picker.query)).catch(() => []).then((sources) => {
          if (sequence !== this.sequence) return;
          this.view.dispatch({ effects: searchResults.of({ from: picker.from, query: picker.query, sources }) });
        });
      }, 120);
    }
    destroy() { clearTimeout(this.timer); this.sequence++; }
  });

  // Chips only for the lines on screen, so the work per keystroke doesn't
  // grow with the document. Resolving a target is cached until the sources change.
  const chips = ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    sources: readonly ReferenceSource[] | null = null;
    resolved = new Map<string, ReferenceSource | null>();
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    resolve(target: string, sources: readonly ReferenceSource[]) {
      if (sources !== this.sources) {
        this.sources = sources;
        this.resolved.clear();
      }
      let source = this.resolved.get(target);
      if (source === undefined) this.resolved.set(target, (source = resolveReference(target, sources)));
      return source;
    }
    build(view: EditorView): DecorationSet {
      const config = getConfig();
      if (!config) return Decoration.none;
      const { links } = view.state.field(referenceIndex);
      const ranges = view.state.selection.ranges;
      const builder = new RangeSetBuilder<Decoration>();
      let i = 0;
      for (const visible of view.visibleRanges) {
        i = Math.max(i, firstLinkFrom(links, visible.from));
        for (; i < links.length && links[i].from <= visible.to; i++) {
          const link = links[i];
          if (ranges.some((range) => range.from <= link.to && range.to >= link.from)) continue;
          builder.add(link.from, link.to, Decoration.replace({ widget: new ReferenceChip(link, this.resolve(link.target, config.sources)) }));
        }
      }
      return builder.finish();
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged || update.transactions.some((tr) => tr.effects.some((effect) => effect.is(refreshReferences)))) this.decorations = this.build(update.view);
    }
  }, { decorations: (plugin) => plugin.decorations });

  const hover = hoverTooltip((view, pos) => {
    const config = getConfig();
    if (!config || view.state.field(pickerField)) return null;
    const link = linkAt(view.state.field(referenceIndex).links, pos);
    if (!link) return null;
    const source = resolveReference(link.target, config.sources);
    return {
      pos: link.from,
      end: link.to,
      above: true,
      create() {
        const dom = element("div", "cm-reference-card");
        if (!source) {
          dom.append(element("div", "cm-reference-card-title", link.alias || link.target), element("p", "cm-reference-card-meta", "Reference not found in this vault"));
          return { dom };
        }
        const image = thumbnail(source, "cm-reference-card-image");
        if (image) dom.append(image);
        dom.append(element("div", "cm-reference-card-title", source.title));
        dom.append(element("div", "cm-reference-card-meta", source.kind === "document" ? source.status || "Document" : source.site || "Clip"));
        const summary = source.summary || (source.kind === "clip" ? source.text : null);
        if (summary) dom.append(element("p", "cm-reference-card-summary", summary.slice(0, 420)));
        const actions = element("div", "cm-reference-card-actions");
        const open = element("button", "cm-reference-card-action", source.kind === "document" ? "Open document" : "Open clip");
        open.type = "button";
        open.addEventListener("click", () => getConfig()?.onOpen(source));
        actions.append(open);
        const quote = source.kind === "clip" ? attributedQuote(source.text ?? "", linkFor(source, config.sources), source) : "";
        if (quote) {
          const button = element("button", "cm-reference-card-action", "Quote clip");
          button.type = "button";
          button.addEventListener("click", () => {
            // Do not replace a stale range if the document changed while hovering.
            if (view.state.sliceDoc(link.from, link.to).startsWith("[[")) insertQuote(view, source, link.from, link.to, linkFor(source, config.sources));
          });
          actions.append(button);
        }
        dom.append(actions);
        return { dom };
      },
    };
  }, { hoverTime: 350, hideOnChange: true });

  function move(view: EditorView, direction: number) {
    const picker = view.state.field(pickerField);
    if (!picker) return false;
    const length = options(picker).length;
    view.dispatch({ effects: setPicker.of({ ...picker, index: length ? (picker.index + direction + length) % length : 0 }) });
    return true;
  }

  return [
    referenceIndex, dismissedField, pickerField, asyncSearch, chips, hover,
    Prec.highest(keymap.of([
      { key: "ArrowDown", run: (view) => move(view, 1) },
      { key: "ArrowUp", run: (view) => move(view, -1) },
      { key: "Enter", run: (view) => choose(view) },
      { key: "Shift-Enter", run: (view) => choose(view, undefined, true) },
      { key: "Tab", run: (view) => choose(view) },
      { key: "Escape", run: (view) => { const picker = view.state.field(pickerField); if (!picker) return false; view.dispatch({ effects: [setPicker.of(null), dismissPicker.of(picker.from)] }); return true; } },
    ])),
    EditorView.domEventHandlers({
      mousedown(event, view) {
        const chip = (event.target as HTMLElement).closest<HTMLElement>("[data-reference-from]");
        const position = chip ? Number(chip.dataset.referenceFrom) : view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (position == null || !getConfig()) return false;
        const link = linkAt(view.state.field(referenceIndex).links, position);
        if (!link) return false;
        if (event.metaKey || event.ctrlKey) {
          const source = resolveReference(link.target, getConfig()!.sources);
          if (!source) return false;
          event.preventDefault();
          getConfig()!.onOpen(source);
          return true;
        }
        if (!chip) return false;
        event.preventDefault();
        view.dispatch({ selection: EditorSelection.range(link.from, link.to) });
        view.focus();
        return true;
      },
      dragover(event) {
        if (!event.dataTransfer?.types.includes(referenceMime)) return false;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        return true;
      },
      drop(event, view) {
        if (!event.dataTransfer?.types.includes(referenceMime)) return false; // CM handles normal text (including internal moves).
        let text = "";
        try {
          const data: unknown = JSON.parse(event.dataTransfer.getData(referenceMime));
          if (data && typeof data === "object" && "text" in data && typeof data.text === "string") text = data.text;
        } catch { /* A malformed custom payload can still have a plain-text fallback. */ }
        text ||= event.dataTransfer.getData("text/plain");
        const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (!text || position == null) return false;
        event.preventDefault();
        insert(view, position, position, text, /^>/.test(text));
        return true;
      },
    }),
    menuTheme, referenceTheme,
  ];
}

/** Blank-line-delimited paragraph under the primary cursor, without YAML. */
export function currentParagraph(state: EditorState): string {
  const range = paragraphRange(state);
  return range ? state.sliceDoc(range.from, range.to) : "";
}

/** The paragraph's extent at `pos` (the cursor by default), trimmed of
 *  surrounding whitespace; null on a blank line, in YAML or code. */
export function paragraphRange(state: EditorState, pos = state.selection.main.head): { from: number; to: number } | null {
  const line = state.doc.lineAt(pos);
  if (!inReferenceContext(state, pos) || !line.text.trim()) return null;
  const bodyStart = headLength(state.doc);
  const boundary = (text: string) => !text.trim() || /^ {0,3}(?:>\s*)*(`{3,}|~{3,})/.test(text);
  let first = line.number;
  let last = line.number;
  while (first > 1 && state.doc.line(first - 1).from >= bodyStart && !boundary(state.doc.line(first - 1).text)) first--;
  while (last < state.doc.lines && !boundary(state.doc.line(last + 1).text)) last++;
  let from = state.doc.line(first).from;
  let to = state.doc.line(last).to;
  while (from < to && /\s/.test(state.sliceDoc(from, from + 1))) from++;
  while (to > from && /\s/.test(state.sliceDoc(to - 1, to))) to--;
  return from < to ? { from, to } : null;
}

/** The paragraph at `pos`, or on a blank line the nearest one above it. */
export function paragraphNear(state: EditorState, pos = state.selection.main.head): { from: number; to: number } | null {
  const here = paragraphRange(state, pos);
  if (here) return here;
  for (let number = state.doc.lineAt(pos).number - 1; number >= 1; number--) {
    const line = state.doc.line(number);
    if (line.text.trim()) return paragraphRange(state, line.from);
  }
  return null;
}

/** `isReferenceContext` from the index, without reading the document. */
function inReferenceContext(state: EditorState, pos: number): boolean {
  const index = state.field(referenceIndex, false);
  return index ? outside(index.ignored, pos) : isReferenceContext(state.doc.toString(), pos);
}

/** `splitFrontmatter(text).head.length`, reading only the frontmatter's lines. */
function headLength(doc: Text): number {
  if (doc.line(1).text.replace(/\r$/, "").trimEnd() !== "---") return 0;
  for (let n = 2; n <= doc.lines; n++) {
    const line = doc.line(n);
    if (line.text.replace(/\r$/, "").trimEnd() !== "---") continue;
    if (n === doc.lines) return doc.length;
    return doc.sliceString(line.to + 1, line.to + 2) === "\n" ? line.to + 2 : line.to + 1;
  }
  return 0;
}

const referenceTheme = EditorView.theme({
  ".cm-reference-chip": { display: "inline", padding: "2px 6px", borderRadius: "5px", backgroundColor: "color-mix(in srgb, var(--muted-foreground) 8%, transparent)", color: "var(--foreground)", fontSize: ".85em", boxDecorationBreak: "clone", cursor: "text" },
  ".cm-reference-site": { color: "var(--muted-foreground)", fontSize: ".85em", marginLeft: "6px" },
  ".cm-reference-unresolved": { color: "var(--muted-foreground)", backgroundColor: "transparent", textDecoration: "underline dotted", textUnderlineOffset: "4px" },
  ".cm-tooltip.cm-reference-card": { border: "1px solid var(--border)", borderRadius: "8px", backgroundColor: "var(--popover)", color: "var(--foreground)", boxShadow: "0 8px 24px #0002", overflow: "hidden", fontFamily: "var(--font-sans)", fontSize: "13px", fontWeight: "400", fontStyle: "normal", lineHeight: "1.45", letterSpacing: "normal" },
  ".cm-reference-thumbnail": { width: "38px", height: "38px", objectFit: "cover", borderRadius: "4px", flexShrink: "0" },
  ".cm-reference-card-meta": { color: "var(--muted-foreground)", fontSize: "11px", marginTop: "2px" },
  ".cm-reference-card": { padding: "12px", width: "min(300px, calc(100vw - 16px))", boxSizing: "border-box", lineHeight: "1.5" },
  ".cm-reference-card-image": { width: "100%", maxHeight: "150px", objectFit: "cover", borderRadius: "4px", marginBottom: "8px" },
  ".cm-reference-card-title": { fontWeight: "600", overflowWrap: "anywhere" },
  ".cm-reference-card-summary": { color: "var(--muted-foreground)", whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: "10px 0" },
  ".cm-reference-card-actions": { display: "flex", gap: "14px", marginTop: "10px" },
  ".cm-reference-card-action": { font: "inherit", fontSize: "12px", color: "var(--primary)", background: "none", border: "none", padding: "2px 0", cursor: "pointer" },
  ".cm-reference-card-action:focus-visible": { outline: "2px solid var(--primary)", outlineOffset: "3px" },
});
