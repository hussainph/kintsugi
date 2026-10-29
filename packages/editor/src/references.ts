import { isolateHistory } from "@codemirror/commands";
import { EditorSelection, EditorState, Prec, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, hoverTooltip, keymap, showTooltip, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { attributedQuote, isReferenceContext, linkFor, parseWikilinks, resolveReference, searchReferences, type ReferenceSource, type Wikilink } from "@kintsugi/core/references";
import { splitFrontmatter } from "@kintsugi/core/frontmatter";

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
};

export const refreshReferences = StateEffect.define<null>();
const referenceMime = "application/x-kintsugi-reference";
type Picker = { from: number; to: number; query: string; results: ReferenceSource[]; index: number; loading: boolean };
const setPicker = StateEffect.define<Picker | null>();
const searchResults = StateEffect.define<{ from: number; query: string; sources: ReferenceSource[] }>();
// Keep clips within reach even in a large writing vault. Documents still lead.
const pickerResults = (sources: ReferenceSource[]) => [
  ...sources.filter((source) => source.kind === "document").slice(0, 24),
  ...sources.filter((source) => source.kind === "clip").slice(0, 16),
];

function pickerAt(state: EditorState, config: References | undefined): Picker | null {
  if (!config || !state.selection.main.empty) return null;
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  const before = state.sliceDoc(line.from, head);
  const match = /\[\[([^\[\]\n|#]*)$/.exec(before);
  if (!match) return null;
  const from = line.from + match.index;
  const prefix = before.slice(0, match.index);
  if ((prefix.match(/\\+$/)?.[0].length ?? 0) % 2 || !isReferenceContext(state.doc.toString(), from)) return null;
  // Editing a complete link replaces the entire target, not just its prefix.
  const tail = state.sliceDoc(head, line.to);
  const closing = /^[^\[\]]*\]\]/.exec(tail);
  const to = closing ? head + closing[0].length : head;
  return { from, to, query: match[1], results: pickerResults(searchReferences(match[1], config.sources.filter((source) => source.path !== config.currentPath))), index: 0, loading: !!config.search };
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

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const dom = document.createElement(tag);
  dom.className = className;
  if (text !== undefined) dom.textContent = text;
  return dom;
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
          const selected = previous.results[previous.index]?.path;
          value = { ...value, index: Math.max(0, value.results.findIndex((source) => source.path === selected)) };
        }
      }
      for (const effect of tr.effects) {
        if (effect.is(setPicker)) value = effect.value;
        if (effect.is(searchResults) && value && effect.value.from === value.from && effect.value.query === value.query) {
          const selected = value.results[value.index]?.path;
          const results = pickerResults(merged(value.results, effect.value.sources).filter((source) => source.path !== getConfig()?.currentPath));
          value = { ...value, results, index: Math.max(0, results.findIndex((source) => source.path === selected)), loading: false };
        }
      }
      return value;
    },
    provide: (field) => showTooltip.from(field, (picker) => picker ? { pos: picker.from, above: false, create: createPicker } : null),
  });

  function choose(view: EditorView, source?: ReferenceSource, quote = false): boolean {
    const picker = view.state.field(pickerField);
    const config = getConfig();
    if (!picker || !config) return false;
    source ??= picker.results[picker.index];
    if (!source) return true;
    const link = linkFor(source, merged(config.sources, picker.results));
    if (quote && source.kind === "clip") {
      insertQuote(view, source, picker.from, picker.to, link);
    } else insert(view, picker.from, picker.to, link);
    return true;
  }

  function insertQuote(view: EditorView, source: ReferenceSource, from: number, to: number, link: string) {
    const config = getConfig();
    const doc = view.state.doc;
    const selection = view.state.selection;
    const apply = (passage: string) => {
      if (view.dom?.isConnected === false || view.state.doc !== doc || !view.state.selection.eq(selection)) return;
      const quote = attributedQuote(passage, link);
      if (quote) insert(view, from, to, quote, true);
    };
    if (config?.readClipText) void config.readClipText(source).then(apply).catch((error) => config.onError?.(error));
    else apply(source.text ?? "");
  }

  function createPicker(view: EditorView) {
    const dom = element("div", "cm-reference-picker");
    dom.setAttribute("aria-label", "Insert a reference");
    dom.setAttribute("role", "dialog");
    const list = element("div", "cm-reference-options");
    list.id = `kintsugi-references-${Math.random().toString(36).slice(2)}`;
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Documents and clips");
    const hint = element("div", "cm-reference-hint");
    hint.setAttribute("aria-live", "polite");
    dom.append(list, hint);
    dom.addEventListener("mousedown", (event) => event.preventDefault());
    function render() {
      const picker = view.state.field(pickerField);
      if (!picker) return;
      list.replaceChildren();
      picker.results.forEach((source, index) => {
        const row = element("div", "cm-reference-option");
        row.id = `${list.id}-${index}`;
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", String(index === picker.index));
        const image = source.kind === "clip" ? thumbnail(source, "cm-reference-thumbnail") : null;
        if (image) row.append(image);
        const labels = element("div", "cm-reference-option-labels");
        labels.append(element("div", "cm-reference-option-title", source.title));
        labels.append(element("div", "cm-reference-option-meta", source.kind === "document" ? source.status || "Document" : source.site || "Clip"));
        row.append(labels);
        row.addEventListener("click", (event) => choose(view, source, event.shiftKey));
        list.append(row);
      });
      const selected = picker.results[picker.index];
      const canQuote = selected?.kind === "clip" && !!attributedQuote(selected.text ?? "", "[[reference]]");
      hint.textContent = picker.results.length
        ? `↑↓ Choose · Enter Insert link${canQuote ? " · Shift+Enter Quote clip" : ""} · Esc Close${picker.loading ? " · Searching…" : ""}`
        : picker.loading ? "Searching… · Esc Close" : "No references found · Esc Close";
      view.contentDOM.setAttribute("aria-controls", list.id);
      view.contentDOM.setAttribute("aria-expanded", "true");
      view.contentDOM.setAttribute("aria-autocomplete", "list");
      if (selected) view.contentDOM.setAttribute("aria-activedescendant", `${list.id}-${picker.index}`);
      else view.contentDOM.removeAttribute("aria-activedescendant");
      const row = list.children[picker.index] as HTMLElement | undefined;
      if (row && row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
      else if (row && row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
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

  const chips = ViewPlugin.fromClass(class {
    links: Wikilink[];
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.links = parseWikilinks(view.state.doc.toString());
      this.decorations = this.build(view);
    }
    build(view: EditorView): DecorationSet {
      const config = getConfig();
      if (!config) return Decoration.none;
      return Decoration.set(this.links.flatMap((link) => {
        if (view.state.selection.ranges.some((range) => range.from <= link.to && range.to >= link.from)) return [];
        const source = resolveReference(link.target, config.sources);
        return [Decoration.replace({ widget: new ReferenceChip(link, source) }).range(link.from, link.to)];
      }));
    }
    update(update: ViewUpdate) {
      if (update.docChanged) this.links = parseWikilinks(update.state.doc.toString());
      if (update.docChanged || update.selectionSet || update.transactions.some((tr) => tr.effects.some((effect) => effect.is(refreshReferences)))) this.decorations = this.build(update.view);
    }
  }, { decorations: (plugin) => plugin.decorations });

  const hover = hoverTooltip((view, pos) => {
    const config = getConfig();
    if (!config || view.state.field(pickerField)) return null;
    const link = view.plugin(chips)?.links.find((link) => pos >= link.from && pos <= link.to);
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
        const quote = source.kind === "clip" ? attributedQuote(source.text ?? "", linkFor(source, config.sources)) : "";
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
    const length = picker.results.length;
    view.dispatch({ effects: setPicker.of({ ...picker, index: length ? (picker.index + direction + length) % length : 0 }) });
    return true;
  }

  return [
    pickerField, asyncSearch, chips, hover,
    Prec.highest(keymap.of([
      { key: "ArrowDown", run: (view) => move(view, 1) },
      { key: "ArrowUp", run: (view) => move(view, -1) },
      { key: "Enter", run: (view) => choose(view) },
      { key: "Shift-Enter", run: (view) => choose(view, undefined, true) },
      { key: "Tab", run: (view) => choose(view) },
      { key: "Escape", run: (view) => { if (!view.state.field(pickerField)) return false; view.dispatch({ effects: setPicker.of(null) }); return true; } },
    ])),
    EditorView.domEventHandlers({
      mousedown(event, view) {
        const chip = (event.target as HTMLElement).closest<HTMLElement>("[data-reference-from]");
        const position = chip ? Number(chip.dataset.referenceFrom) : view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (position == null || !getConfig()) return false;
        const link = view.plugin(chips)?.links.find((link) => position >= link.from && position <= link.to);
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
    referenceTheme,
  ];
}

/** Blank-line-delimited paragraph under the primary cursor, without YAML. */
export function currentParagraph(state: EditorState): string {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  const text = state.doc.toString();
  if (!isReferenceContext(text, head)) return "";
  const bodyStart = splitFrontmatter(text).head.length;
  const boundary = (text: string) => !text.trim() || /^ {0,3}(?:>\s*)*(`{3,}|~{3,})/.test(text);
  let first = line.number;
  let last = line.number;
  if (!line.text.trim()) return "";
  while (first > 1 && state.doc.line(first - 1).from >= bodyStart && !boundary(state.doc.line(first - 1).text)) first--;
  while (last < state.doc.lines && !boundary(state.doc.line(last + 1).text)) last++;
  return state.sliceDoc(state.doc.line(first).from, state.doc.line(last).to).trim();
}

const referenceTheme = EditorView.theme({
  ".cm-reference-chip": { display: "inline", padding: "2px 6px", borderRadius: "5px", backgroundColor: "color-mix(in srgb, var(--muted-foreground) 8%, transparent)", color: "var(--foreground)", fontSize: ".85em", boxDecorationBreak: "clone", cursor: "text" },
  ".cm-reference-site": { color: "var(--muted-foreground)", fontSize: ".85em", marginLeft: "6px" },
  ".cm-reference-unresolved": { color: "var(--muted-foreground)", backgroundColor: "transparent", textDecoration: "underline dotted", textUnderlineOffset: "4px" },
  ".cm-tooltip.cm-reference-picker, .cm-tooltip.cm-reference-card": { border: "1px solid var(--border)", borderRadius: "8px", backgroundColor: "var(--popover)", color: "var(--foreground)", boxShadow: "0 8px 24px #0002", overflow: "hidden", fontFamily: "var(--font-sans)", fontSize: "13px", fontWeight: "400", fontStyle: "normal", lineHeight: "1.45", letterSpacing: "normal" },
  ".cm-reference-picker": { width: "min(380px, 85vw)" },
  ".cm-reference-options": { maxHeight: "280px", overflowY: "auto", padding: "4px", position: "relative", scrollbarWidth: "thin", scrollbarColor: "var(--border) transparent" },
  ".cm-reference-option": { display: "flex", alignItems: "center", gap: "10px", padding: "8px", borderRadius: "4px", cursor: "pointer" },
  '.cm-reference-option[aria-selected="true"], .cm-reference-option:hover': { backgroundColor: "var(--muted)" },
  ".cm-reference-thumbnail": { width: "38px", height: "38px", objectFit: "cover", borderRadius: "4px", flexShrink: "0" },
  ".cm-reference-option-labels": { minWidth: "0" },
  ".cm-reference-option-title": { fontWeight: "500", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  ".cm-reference-option-meta, .cm-reference-card-meta": { color: "var(--muted-foreground)", fontSize: "11px", marginTop: "2px" },
  ".cm-reference-hint": { padding: "8px 10px", borderTop: "1px solid var(--border)", fontSize: "10px", color: "var(--muted-foreground)", lineHeight: "1.5" },
  ".cm-reference-card": { padding: "12px", width: "min(300px, 85vw)", lineHeight: "1.5" },
  ".cm-reference-card-image": { width: "100%", maxHeight: "150px", objectFit: "cover", borderRadius: "4px", marginBottom: "8px" },
  ".cm-reference-card-title": { fontWeight: "600", overflowWrap: "anywhere" },
  ".cm-reference-card-summary": { color: "var(--muted-foreground)", whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: "10px 0" },
  ".cm-reference-card-actions": { display: "flex", gap: "14px", marginTop: "10px" },
  ".cm-reference-card-action": { font: "inherit", fontSize: "12px", color: "var(--primary)", background: "none", border: "none", padding: "2px 0", cursor: "pointer" },
  ".cm-reference-card-action:focus-visible": { outline: "2px solid var(--primary)", outlineOffset: "3px" },
});
