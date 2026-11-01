import { splitFrontmatter } from "@kintsugi/core/frontmatter";

/**
 * Where a comment thread sits (KI-38): a text quote of its paragraph, with a
 * little context either side and its first line as a tie-breaker. Stored
 * outside the document (`.kintsugi/comments/`), so it is re-resolved against
 * the text whenever the document is opened. While it is open, CodeMirror's
 * change mapping moves it (see `comments.ts`); this module is pure, so the
 * phone and tests use the same rules.
 */
export type CommentAnchor = { exact: string; prefix: string; suffix: string; line: number };

export type Range = { from: number; to: number };

const CONTEXT = 48;
/** How alike a paragraph must be to the quote to take it over after edits. */
export const SIMILAR = 0.5;

/** The anchor for `from`–`to` in `text`. */
export function anchorAt(text: string, from: number, to: number): CommentAnchor {
  return {
    exact: text.slice(from, to),
    prefix: text.slice(Math.max(0, from - CONTEXT), from),
    suffix: text.slice(to, to + CONTEXT),
    line: lineAt(text, from),
  };
}

export function lineAt(text: string, pos: number): number {
  let line = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < pos; i = text.indexOf("\n", i + 1)) line++;
  return line;
}

const fence = /^ {0,3}(?:>\s*)*(`{3,}|~{3,})/;

/** Blank-line-delimited paragraphs of the body (not the frontmatter), trimmed. */
export function paragraphs(text: string): Range[] {
  const out: Range[] = [];
  let pos = splitFrontmatter(text).head.length;
  let start = -1;
  let end = -1;
  const flush = () => {
    if (start === -1) return;
    let from = start;
    let to = end;
    while (from < to && /\s/.test(text[from])) from++;
    while (to > from && /\s/.test(text[to - 1])) to--;
    if (from < to) out.push({ from, to });
    start = -1;
  };
  while (pos <= text.length) {
    const next = text.indexOf("\n", pos);
    const lineEnd = next === -1 ? text.length : next;
    const line = text.slice(pos, lineEnd);
    if (!line.trim() || fence.test(line)) flush();
    else {
      if (start === -1) start = pos;
      end = lineEnd;
    }
    if (next === -1) break;
    pos = next + 1;
  }
  flush();
  return out;
}

/** The paragraph that contains `pos`, if any. */
export function paragraphAt(text: string, pos: number): Range | null {
  return paragraphs(text).find((p) => pos >= p.from && pos <= p.to) ?? null;
}

const words = (text: string) => text.toLocaleLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];

/** Dice similarity of two passages' words (as multisets), 0–1. */
export function similarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (!x.length || !y.length) return 0;
  const counts = new Map<string, number>();
  for (const w of x) counts.set(w, (counts.get(w) ?? 0) + 1);
  let shared = 0;
  for (const w of y) {
    const n = counts.get(w) ?? 0;
    if (n > 0) { shared++; counts.set(w, n - 1); }
  }
  return (2 * shared) / (x.length + y.length);
}

function sharedSuffix(a: string, b: string) {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}
function sharedPrefix(a: string, b: string) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/** How well the text around `range` matches the anchor's context, 0–1. */
function contextScore(text: string, range: Range, anchor: CommentAnchor) {
  const before = sharedSuffix(text.slice(Math.max(0, range.from - CONTEXT), range.from), anchor.prefix);
  const after = sharedPrefix(text.slice(range.to, range.to + CONTEXT), anchor.suffix);
  const most = Math.max(1, anchor.prefix.length + anchor.suffix.length);
  return (before + after) / most;
}

/**
 * Finds an anchor's paragraph in `text`: the exact quote (the occurrence
 * whose context and line match best), else the most similar paragraph if
 * it is similar enough, else null, which makes the thread an orphan. An
 * orphan is never deleted; it is shown apart and may be found again.
 */
export function resolveAnchor(text: string, anchor: CommentAnchor, options: { exactOnly?: boolean } = {}): Range | null {
  const exact = anchor.exact;
  if (!exact.trim()) return null;
  const hits: Range[] = [];
  for (let at = text.indexOf(exact); at !== -1 && hits.length < 50; at = text.indexOf(exact, at + 1)) hits.push({ from: at, to: at + exact.length });
  const distance = (range: Range) => Math.abs(lineAt(text, range.from) - anchor.line) / 1000;
  const best = (candidates: Range[], score: (range: Range) => number) => {
    let top: Range | null = null;
    let topScore = -Infinity;
    for (const range of candidates) {
      const s = score(range);
      if (s > topScore) { top = range; topScore = s; }
    }
    return { top, topScore };
  };
  if (hits.length) return best(hits, (r) => contextScore(text, r, anchor) - distance(r)).top;
  if (options.exactOnly) return null;
  const { top, topScore } = best(paragraphs(text), (r) => similarity(exact, text.slice(r.from, r.to)) + contextScore(text, r, anchor) * 0.1 - distance(r));
  return top && similarity(exact, text.slice(top.from, top.to)) >= SIMILAR && topScore > 0 ? top : null;
}
