import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorSelection, RangeSetBuilder, type ChangeSpec, type EditorState, type SelectionRange, type StateCommand } from "@codemirror/state";
import { MARKER } from "./markers.ts";
import { toggleDim } from "./dim.ts";
import { Decoration, type DecorationSet, type EditorView, type KeyBinding, ViewPlugin, type ViewUpdate } from "@codemirror/view";

/** Formatting shortcuts (KI-65): inline marks toggle on a selection or at
 *  the cursor, and block shapes toggle on every line the selection touches.
 *  Markdown has no underline, so it is written as `<u>…</u>`, which MDX and
 *  the blog's Markdown both render as HTML. */

export type Mark = "bold" | "italic" | "underline" | "code" | "strike";

type MarkSyntax = { open: string; close: string; node?: string; markNode?: string };

const MARKS: Record<Mark, MarkSyntax> = {
  bold: { open: "**", close: "**", node: "StrongEmphasis", markNode: "EmphasisMark" },
  italic: { open: "*", close: "*", node: "Emphasis", markNode: "EmphasisMark" },
  underline: { open: "<u>", close: "</u>" },
  code: { open: "`", close: "`", node: "InlineCode", markNode: "CodeMark" },
  strike: { open: "~~", close: "~~", node: "Strikethrough", markNode: "StrikethroughMark" },
};

/** A formatted run: `from`/`to` include its marks, `inner` is the text. */
type Span = { from: number; to: number; innerFrom: number; innerTo: number };

export { MARKER } from "./markers.ts";

function tree(state: EditorState, upTo: number) {
  return ensureSyntaxTree(state, upTo, 50) ?? syntaxTree(state);
}

/** Every `mark` run between `from` and `to` (one line). */
function spans(state: EditorState, mark: Mark, from: number, to: number): Span[] {
  const syntax = MARKS[mark];
  const out: Span[] = [];
  if (syntax.node) {
    tree(state, to).iterate({
      from, to,
      enter(node) {
        if (node.name !== syntax.node) return;
        const marks: { from: number; to: number }[] = [];
        for (let child = node.node.firstChild; child; child = child.nextSibling) if (child.name === syntax.markNode) marks.push(child);
        if (marks.length < 2) return;
        out.push({ from: node.from, to: node.to, innerFrom: marks[0].to, innerTo: marks[marks.length - 1].from });
      },
    });
    return out;
  }
  // <u> pairs on the line, outside code.
  const text = state.sliceDoc(from, to);
  const code = spans(state, "code", from, to);
  const open: number[] = [];
  for (const match of text.matchAll(/<(\/?)u\s*>/gi)) {
    const at = from + match.index;
    if (code.some((span) => span.from <= at && at < span.to)) continue;
    if (!match[1]) open.push(at);
    else if (open.length) {
      const start = open.pop()!;
      out.push({ from: start, to: at + match[0].length, innerFrom: start + text.slice(start - from).indexOf(">") + 1, innerTo: at });
    }
  }
  return out.sort((a, b) => a.from - b.from);
}

/** The parts of a selection to format, one per line: trimmed of spaces and
 *  of the line's block marker, blank parts left out. */
function segments(state: EditorState, range: SelectionRange) {
  const out: { from: number; to: number }[] = [];
  const first = state.doc.lineAt(range.from).number;
  const last = state.doc.lineAt(range.to).number;
  for (let n = first; n <= last; n++) {
    const line = state.doc.line(n);
    let from = Math.max(range.from, line.from);
    let to = Math.min(range.to, line.to);
    if (from === line.from) from += (MARKER.exec(line.text.replace(/^\s+/, ""))?.[0].length ?? 0) + (/^\s*/.exec(line.text)![0].length);
    while (from < to && /\s/.test(state.sliceDoc(from, from + 1))) from++;
    while (to > from && /\s/.test(state.sliceDoc(to - 1, to))) to--;
    if (from < to) out.push({ from, to });
  }
  return out;
}

const unwrap = (span: Span): ChangeSpec[] => [{ from: span.from, to: span.innerFrom }, { from: span.innerTo, to: span.to }];

/** `` ` `` around text that has its own backticks needs a longer fence. */
function marksFor(mark: Mark, text: string) {
  const { open, close } = MARKS[mark];
  if (mark !== "code" || !text.includes("`")) return { open, close };
  const fence = "`".repeat(Math.max(...(text.match(/`+/g) ?? [""]).map((run) => run.length)) + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return { open: fence + pad, close: pad + fence };
}

function toggleRange(state: EditorState, mark: Mark, range: SelectionRange): { changes?: ChangeSpec[]; range: SelectionRange } {
  const { open, close } = MARKS[mark];
  if (range.empty) {
    const head = range.head;
    const line = state.doc.lineAt(head);
    const inside = spans(state, mark, line.from, line.to).filter((span) => span.innerFrom <= head && head <= span.innerTo).pop();
    if (inside) {
      // At the end of the run: step out, so what comes next is plain.
      if (head === inside.innerTo && inside.innerTo > inside.innerFrom) return { range: EditorSelection.cursor(inside.to) };
      return { changes: unwrap(inside), range: EditorSelection.cursor(head - (inside.innerFrom - inside.from)) };
    }
    // Between an empty pair: take it back out.
    if (state.sliceDoc(head - open.length, head) === open && state.sliceDoc(head, head + close.length) === close)
      return { changes: [{ from: head - open.length, to: head + close.length }], range: EditorSelection.cursor(head - open.length) };
    // Inside a word: the whole word.
    const word = state.wordAt(head);
    if (word && word.from < head && head < word.to)
      return { changes: [{ from: word.from, insert: open }, { from: word.to, insert: close }], range: EditorSelection.cursor(head + open.length) };
    return { changes: [{ from: head, insert: open + close }], range: EditorSelection.cursor(head + open.length) };
  }

  const parts = segments(state, range);
  if (!parts.length) return { range };
  const containing = parts.map((part) => {
    const line = state.doc.lineAt(part.from);
    return spans(state, mark, line.from, line.to).filter((span) => span.from <= part.from && part.to <= span.to).pop();
  });
  let changes: ChangeSpec[] = [];
  if (containing.every(Boolean)) {
    const seen = new Set<number>();
    for (const span of containing as Span[]) if (!seen.has(span.from)) { seen.add(span.from); changes.push(...unwrap(span)); }
    const set = state.changes(changes);
    return { changes, range: EditorSelection.range(set.mapPos(range.anchor, 1), set.mapPos(range.head, 1)) };
  }
  parts.forEach((part, i) => {
    if (containing[i]) return;
    const line = state.doc.lineAt(part.from);
    // Runs of the same mark inside the part merge into the new one.
    if (mark !== "code") for (const span of spans(state, mark, line.from, line.to)) if (part.from <= span.from && span.to <= part.to) changes.push(...unwrap(span));
    const text = state.sliceDoc(part.from, part.to);
    const marks = marksFor(mark, text);
    changes.push({ from: part.from, insert: marks.open }, { from: part.to, insert: marks.close });
  });
  changes = changes.sort((a, b) => (a as { from: number }).from - (b as { from: number }).from);
  const set = state.changes(changes);
  const from = parts[0].from, to = parts[parts.length - 1].to;
  const forward = range.head >= range.anchor;
  const start = set.mapPos(from, 1), end = set.mapPos(to, -1);
  return { changes, range: forward ? EditorSelection.range(start, end) : EditorSelection.range(end, start) };
}

/** Toggles `mark` on each selection: wraps the selected text, or removes the
 *  mark from a run the selection is inside. At an empty cursor it formats
 *  the word under it, steps out at a run's end, or opens an empty pair. */
export function toggleMark(mark: Mark): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false;
    dispatch(state.update(state.changeByRange((range) => toggleRange(state, mark, range)), { scrollIntoView: true, userEvent: "input.format" }));
    return true;
  };
}

/** The lines a command acts on: every line the selections touch, without
 *  blank ones when there is more than one. */
function selectedLines(state: EditorState) {
  const numbers = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    let last = state.doc.lineAt(range.to).number;
    if (last > first && range.to === state.doc.line(last).from) last--;
    for (let n = first; n <= last; n++) numbers.add(n);
  }
  const lines = [...numbers].sort((a, b) => a - b).map((n) => state.doc.line(n));
  return lines.length > 1 ? lines.filter((line) => line.text.trim()) : lines;
}

function rewriteLines(state: EditorState, dispatch: Parameters<StateCommand>[0]["dispatch"], rewrite: (text: string, index: number) => string, userEvent: string) {
  if (state.readOnly) return false;
  const lines = selectedLines(state);
  if (!lines.length) return false;
  const changes: ChangeSpec[] = [];
  lines.forEach((line, i) => {
    const next = rewrite(line.text, i);
    // Only the line's start changes, so the cursor and selection map cleanly.
    let same = 0;
    while (same < line.text.length && same < next.length && line.text[line.text.length - 1 - same] === next[next.length - 1 - same]) same++;
    changes.push({ from: line.from, to: line.to - same, insert: next.slice(0, next.length - same) });
  });
  const set = state.changes(changes);
  dispatch(state.update({ changes: set, selection: state.selection.map(set, 1), scrollIntoView: true, userEvent }));
  return true;
}

const HEADING = /^(\s*)(#{1,6})\s+/;

/** Makes the selected lines headings of `level`, or plain text when they
 *  already are (or for level 0). Any list or quote marker goes. */
export function setHeading(level: number): StateCommand {
  return ({ state, dispatch }) => {
    const lines = selectedLines(state);
    const already = level > 0 && lines.every((line) => HEADING.exec(line.text)?.[2].length === level);
    return rewriteLines(state, dispatch, (text) => {
      const indent = /^\s*/.exec(text)![0];
      const content = text.slice(indent.length).replace(MARKER, "");
      return already || level === 0 ? indent + content : `${indent}${"#".repeat(level)} ${content}`;
    }, "input.format");
  };
}

export type ListKind = "bullets" | "numbers" | "todo" | "quote";

const LIST: Record<ListKind, RegExp> = {
  bullets: /^\s*[-*+]\s+(?!\[[ xX]\]\s)/,
  todo: /^\s*[-*+]\s+\[[ xX]\]\s+/,
  numbers: /^\s*\d{1,9}[.)]\s+/,
  quote: /^\s*>\s?/,
};

/** Turns the selected lines into a list (or quote), or back into plain
 *  lines when they already are one. A quote keeps what is inside it. */
export function toggleList(kind: ListKind): StateCommand {
  return ({ state, dispatch }) => {
    const lines = selectedLines(state);
    const already = lines.every((line) => LIST[kind].test(line.text));
    return rewriteLines(state, dispatch, (text, i) => {
      const indent = /^\s*/.exec(text)![0];
      const body = text.slice(indent.length);
      if (kind === "quote") return already ? indent + body.replace(/^>\s?/, "") : `${indent}> ${body}`;
      const content = body.replace(MARKER, "");
      if (already) return indent + content;
      const marker = kind === "bullets" ? "- " : kind === "todo" ? "- [ ] " : `${i + 1}. `;
      return indent + marker + content;
    }, "input.format");
  };
}

const URLISH = /^(?:https?:\/\/|mailto:|www\.)\S+$/i;

/** A Markdown link: around the selection with the cursor in `()` for the
 *  address, or around a selected address with the cursor in `[]`. Inside an
 *  existing link it goes back to its text. */
export const toggleLink: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  dispatch(state.update(state.changeByRange((range) => {
    let node = tree(state, range.to).resolveInner(range.from, 1);
    while (node.parent && node.name !== "Link") node = node.parent;
    if (node.name === "Link" && node.from <= range.from && range.to <= node.to) {
      const close = state.sliceDoc(node.from, node.to).indexOf("](");
      if (close > 0) {
        const label = state.sliceDoc(node.from + 1, node.from + close);
        return { changes: { from: node.from, to: node.to, insert: label }, range: EditorSelection.range(node.from, node.from + label.length) };
      }
    }
    let { from, to } = range;
    if (range.empty) {
      const word = state.wordAt(range.head);
      if (word && word.from < range.head && range.head < word.to) ({ from, to } = word);
    }
    const text = state.sliceDoc(from, to);
    if (URLISH.test(text)) return { changes: { from, to, insert: `[](${text})` }, range: EditorSelection.cursor(from + 1) };
    const insert = `[${text}]()`;
    return { changes: { from, to, insert }, range: text ? EditorSelection.cursor(from + insert.length - 1) : EditorSelection.cursor(from + 1) };
  }), { scrollIntoView: true, userEvent: "input.format" }));
  return true;
};

/** Mac shortcuts (Mod is ⌘ there, Ctrl elsewhere). ⌘K and ⌘P belong to the
 *  app, so the link is ⌘L. Goes before CodeMirror's own keymaps, which use
 *  ⌘I (select parent syntax) and ⌘U (undo selection). The app lists these
 *  (hold ⌘, the shortcuts list) from `formatShortcuts`, so the labels live
 *  here with the keys. `block` is the `/` menu block that does the same,
 *  whose row shows the key. */
const FORMATS: { key: string; label: string; run: StateCommand; block?: string }[] = [
  { key: "Mod-b", label: "Bold", run: toggleMark("bold") },
  { key: "Mod-i", label: "Italic", run: toggleMark("italic") },
  { key: "Mod-u", label: "Underline", run: toggleMark("underline") },
  { key: "Mod-e", label: "Code", run: toggleMark("code") },
  { key: "Mod-Shift-x", label: "Strikethrough", run: toggleMark("strike") },
  { key: "Mod-l", label: "Link", run: toggleLink },
  ...[1, 2, 3, 4, 5, 6].map((level) => ({ key: `Mod-Alt-${level}`, label: "Heading", run: setHeading(level), block: `h${level}` })),
  { key: "Mod-Alt-0", label: "Plain text", run: setHeading(0), block: "text" },
  { key: "Mod-Shift-7", label: "Numbered list", run: toggleList("numbers"), block: "numbers" },
  { key: "Mod-Shift-8", label: "Bulleted list", run: toggleList("bullets"), block: "bullets" },
  { key: "Mod-Shift-9", label: "To-do list", run: toggleList("todo"), block: "todo" },
  { key: "Mod-Shift-.", label: "Quote", run: toggleList("quote"), block: "quote" },
  { key: "Mod-/", label: "Dim", run: toggleDim },
];

export const formatKeymap: KeyBinding[] = FORMATS.map(({ key, run }) => ({ key, run, preventDefault: true }));

/** The formatting keys and their names, in CodeMirror's key notation. */
export const formatShortcuts: { key: string; label: string; block?: string }[] = FORMATS.map(({ key, label, block }) => ({ key, label, block }));

const underlined = Decoration.mark({ class: "cm-underline" });

function underlineDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to;) {
      const line = view.state.doc.lineAt(pos);
      if (line.text.includes("<")) for (const span of spans(view.state, "underline", line.from, line.to)) if (span.innerTo > span.innerFrom) builder.add(span.innerFrom, span.innerTo, underlined);
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

/** Shows `<u>…</u>` text underlined, as the blog will. */
export const underlines = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = underlineDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) this.decorations = underlineDecorations(update.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);
