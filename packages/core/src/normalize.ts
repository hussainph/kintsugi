/** List indentation, normalized for reading (KI-112).
 *
 *  Tab can indent a list's first item even where nothing precedes it to nest
 *  under (KI-112's follow-up): the saved source then holds leading spaces
 *  that CommonMark reads as an indented code block, or folds into a
 *  shallower list. The file keeps those spaces; every reader normalizes
 *  first, so depth survives as typed.
 *
 *  A marker that no open item's content column can reach gets synthetic
 *  empty parents — `-` lines that carry the depth — so the item nests where
 *  it was typed and nothing becomes code. Under an existing parent, every
 *  two columns past its content column is one missing level. Well-nested
 *  source passes through unchanged.
 *
 *  Fences, frontmatter, HTML, module lines and dimmed comments are never
 *  rewritten; a marker only counts when it sits outside inline code and
 *  comments. Inside a blockquote the prefix is kept; continuation lines keep
 *  their columns; thematic breaks never read as markers. An indented line
 *  that looks like a list reads as a list even where CommonMark would see
 *  code: fence a literal list to keep it code. */

import { scanSpans, type Span } from "./dim.ts";

const TAB = 4;

/** Column of `end` within `text` from `base`, tabs advancing to the next
 *  multiple of 4. */
function column(text: string, end: number, base = 0): number {
  let col = base;
  for (let i = 0; i < end; i++) col = text[i] === "\t" ? col - (col % TAB) + TAB : col + 1;
  return col;
}

/** An open list item: where its marker sits and where its content starts,
 *  both counted from the end of the blockquote prefix. */
type Open = { markerCol: number; contentCol: number };

const MARKER = /^([-+*]|\d{1,9}[.)])([ \t]+|$)/;
const INDENT = /^[ \t]*/;
const BREAK = /^(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const FENCE = /^[ \t]*(`{3,}|~{3,})(.*)$/;

/** Fences may be indented arbitrarily inside nested/orphan list items. */
function fences(src: string): Span[] {
  const out: Span[] = [];
  let fence: { marker: string; from: number } | null = null;
  let pos = 0;
  for (const line of src.split("\n")) {
    const end = pos + line.length + 1;
    const match = FENCE.exec(line.replace(/^(\s*>\s?)+/, ""));
    const marker = match?.[1];
    if (fence) {
      if (marker && marker[0] === fence.marker[0] && marker.length >= fence.marker.length && !match![2].trim()) {
        out.push({ from: fence.from, to: Math.min(end, src.length) });
        fence = null;
      }
    } else if (marker) fence = { marker, from: pos };
    pos = end;
  }
  if (fence) out.push({ from: fence.from, to: src.length });
  return out;
}

/** Rewrites list indentation so it reads nested everywhere, as typed. */
export function normalizeMarkdown(src: string): string {
  const lines = src.split("\n");
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const held = new Array<boolean>(lines.length).fill(false);
  const firstLine = (offset: number) => {
    let first = 0;
    while (first + 1 < lines.length && starts[first + 1] <= offset) first++;
    return first;
  };

  // Frontmatter is never rewritten.
  if (/^---[ \t]*$/.test(lines[0] ?? "")) {
    held[0] = true;
    for (let i = 1; i < lines.length; i++) {
      held[i] = true;
      if (/^---[ \t]*$/.test(lines[i])) break;
    }
  }

  // Fences hold their lines whole. A dimmed comment holds the lines it
  // continues across; on its first line a marker before `%%` still reads.
  const spans = scanSpans(src);
  for (const span of fences(src)) {
    for (let i = firstLine(span.from); i < lines.length && starts[i] < span.to; i++) held[i] = true;
  }
  for (const span of spans.comments) {
    for (let i = firstLine(span.from) + 1; i < lines.length && starts[i] < span.to; i++) held[i] = true;
  }

  // A marker counts only outside these offsets (inline code, comments).
  const guarded = [...spans.code, ...spans.comments];

  // HTML and MDX islands, and module lines: no list reading inside them.
  let island = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/^(?:[ \t]*>[ \t]?)+/, "");
    if (held[i]) continue;
    if (island) {
      held[i] = true;
      if (!line.trim() || /\/>[ \t]*$/.test(line) || /^<\/[A-Za-z]/.test(line.trim())) island = false;
      continue;
    }
    if (/^(import|export)[ \t]/.test(line)) {
      held[i] = true;
      continue;
    }
    if (/^[ \t]*<[A-Za-z!]/.test(line)) {
      held[i] = true;
      island = !!line.trim() && !/\/>[ \t]*$/.test(line) && !/^<\/[A-Za-z]/.test(line.trim());
    }
  }

  const out: string[] = [];
  let stack: Open[] = [];
  let quote = "";
  let prevBlank = true;
  let prevItem = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (held[i]) {
      // A held block still bounds the structure: a fence or island outside
      // every open item's content closes them, while one inside an item (a
      // code sample in a list step, say) keeps the item open.
      const prefixH = /^((?:[ \t]*>[ \t]?)+)/.exec(line)?.[1] ?? "";
      const depthH = (prefixH.match(/>/g) ?? []).length;
      if (depthH !== (quote.match(/>/g) ?? []).length) {
        stack = [];
        quote = prefixH;
      } else {
        const restH = line.slice(prefixH.length);
        const colH = column(restH, INDENT.exec(restH)![0].length);
        while (stack.length && stack[stack.length - 1].contentCol > colH) stack.pop();
      }
      out.push(line);
      prevBlank = !line.trim();
      prevItem = false;
      continue;
    }
    const prefix = /^((?:[ \t]*>[ \t]?)+)/.exec(line)?.[1] ?? "";
    const rest = line.slice(prefix.length);
    // One nesting context per quote depth: blank `>` lines and spacing
    // variants stay inside it; a lazy line outside the quote starts fresh.
    const depth = (prefix.match(/>/g) ?? []).length;
    if (depth !== (quote.match(/>/g) ?? []).length) {
      stack = [];
      quote = prefix;
    }
    if (!rest.trim()) {
      out.push(line);
      prevBlank = true;
      prevItem = false;
      continue;
    }
    const indent = INDENT.exec(rest)![0];
    const col = column(rest, indent.length);
    const afterIndent = rest.slice(indent.length);
    const marker = MARKER.exec(afterIndent);
    const markAt = starts[i] + prefix.length + indent.length;
    const inGuarded = (offset: number) => guarded.some((s) => offset >= s.from && offset < s.to);
    if (!marker || BREAK.test(afterIndent) || inGuarded(markAt)) {
      while (stack.length && stack[stack.length - 1].contentCol > col) stack.pop();
      out.push(line);
      prevBlank = false;
      prevItem = false;
      continue;
    }
    const mark = marker[1];
    const afterMark = afterIndent.slice(mark.length);
    const padEnd = marker[2] ? INDENT.exec(afterMark)![0].length : 0;
    // The content column from the marker's own column: tabs advance from
    // where the marker ends, not from zero.
    const padTo = marker[2] ? column(afterMark, padEnd, col + mark.length) : 0;
    // CommonMark: a bare marker keeps one separating column, and five or
    // more padding columns start indented code, not the item's content.
    const contentCol = marker[2] ? (padTo - (col + mark.length) > 4 ? col + mark.length + 1 : padTo) : col + mark.length + 1;
    while (stack.length && stack[stack.length - 1].markerCol > col) stack.pop();
    const top = stack[stack.length - 1];
    // A numbered line straight after prose continues it: only `1.` can
    // interrupt a paragraph in CommonMark, so `2024. The year` stays prose
    // with no synthetic wrappers.
    if (!top && !prevBlank && !prevItem && /^\d/.test(mark) && parseInt(mark, 10) !== 1) {
      out.push(line);
      prevBlank = false;
      continue;
    }
    const levels = !top ? Math.floor(col / 2) : col >= top.contentCol ? Math.floor((col - top.contentCol) / 2) : 0;
    if (levels > 0) {
      // A bare `-` on the line after anything — prose or a list item — reads
      // as a setext underline (CommonMark turns `- Parent` + a following `-`
      // into an h2), so a blank line — quoted, inside a quote — always
      // separates the synthetic chain from what came before.
      if (!prevBlank) out.push(quote.replace(/[ \t]+$/, ""));
      const base = top ? top.contentCol : 0;
      for (let n = 0; n < levels; n++) {
        const at2 = base + 2 * n;
        out.push(`${quote}${" ".repeat(at2)}-`);
        stack.push({ markerCol: at2, contentCol: at2 + 2 });
      }
    }
    stack.push({ markerCol: col, contentCol });
    out.push(line);
    prevBlank = false;
    prevItem = true;
  }
  return out.join("\n");
}

/** A list item whose content is only nested lists (no prose of its own): a
 *  synthetic parent, or one written by hand. Readers may hide its marker;
 *  the children keep their indentation. */
export function phantomItem(item: { task: boolean | null; c: readonly { t: string }[] }): boolean {
  return item.task === null && item.c.length > 0 && item.c.every((child) => child.t === "list");
}
