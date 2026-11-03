import { contextScore, lineAt, paragraphs, similarity, SIMILAR, type CommentAnchor, type Range } from "./anchors.ts";

/**
 * Words, sentences and paragraphs as spans of text, and how a span with
 * alternatives (KI-86) is found again in a document that changed while it
 * was closed. Pure, like `anchors.ts`, so the phone and tests share it.
 */

/** A span's kind: the cursor's word, a selection, its sentence, its paragraph. */
export type SpanLevel = "word" | "phrase" | "sentence" | "paragraph";

const wordChar = /[\p{L}\p{M}\p{N}_'’-]/u;
const edgeChar = /['’_-]/;

export const isWordChar = (char: string | undefined) => !!char && wordChar.test(char);

/** The word at `pos` (touching it on either side), without edge apostrophes or hyphens. */
export function wordAt(text: string, pos: number): Range | null {
  let from = pos;
  let to = pos;
  while (from > 0 && isWordChar(text[from - 1])) from--;
  while (to < text.length && isWordChar(text[to])) to++;
  while (from < to && edgeChar.test(text[from])) from++;
  while (to > from && edgeChar.test(text[to - 1])) to--;
  return from < to ? { from, to } : null;
}

/** Whether `range` is a whole word: no word characters run on past either end. */
export const wholeWord = (text: string, range: Range) => !isWordChar(text[range.from - 1]) && !isWordChar(text[range.to]);

// A sentence ends at terminal punctuation (with closing quotes, brackets or
// emphasis marks) before a space, or at a line that starts a new block.
const sentenceEnd = /[.!?…]+["'”’)\]*_]*(?=\s|$)|\n(?=[ \t]*(?:[-*+][ \t]|\d+[.)][ \t]|>|#{1,6}[ \t]))/g;
const blockPrefix = /^(?:[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d+[.)][ \t]+))+/;

/** The sentences of a paragraph's text `body`, which starts at `offset`. */
export function sentencesIn(body: string, offset = 0): Range[] {
  const out: Range[] = [];
  const push = (from: number, to: number) => {
    const lineStart = /^\s*$/.test(body.slice(from > 0 ? body.lastIndexOf("\n", from - 1) + 1 : 0, from));
    while (from < to && /\s/.test(body[from])) from++;
    if (lineStart) {
      const prefix = blockPrefix.exec(body.slice(from, to));
      if (prefix) from += prefix[0].length;
    }
    while (to > from && /\s/.test(body[to - 1])) to--;
    if (from < to) out.push({ from: offset + from, to: offset + to });
  };
  let start = 0;
  for (const match of body.matchAll(sentenceEnd)) {
    const end = match.index + match[0].length;
    push(start, end);
    start = end;
  }
  push(start, body.length);
  return out;
}

/** The sentence of `sentences` at `pos`: the one it's in, else the next one, else the last. */
export function sentenceAt(sentences: Range[], pos: number): Range | null {
  return sentences.find((s) => pos >= s.from && pos <= s.to) ?? sentences.find((s) => s.from > pos) ?? sentences.at(-1) ?? null;
}

/** What to look for: the span's anchor (its text when last seen) and all of
 *  its alternatives' texts, the one that was showing first. */
export type SpanQuery = { level: SpanLevel; anchor: CommentAnchor; texts: string[] };

/**
 * Finds a span in `text`: an occurrence of any of its alternatives (the one
 * whose context and line fit best), else, for a sentence or paragraph, the
 * most similar one if it is similar enough, else null (detached). A word or
 * selection that occurs more than once needs some of its context to match,
 * so a common word isn't pinned to the wrong place. `minContext` (used to
 * re-attach while the document is open) also asks for context, and skips the
 * similarity step.
 */
export function resolveSpan(text: string, query: SpanQuery, options: { minContext?: number } = {}): Range | null {
  const minContext = options.minContext ?? 0;
  const short = query.level === "word" || query.level === "phrase";
  const distance = (range: Range) => Math.abs(lineAt(text, range.from) - query.anchor.line) / 1000;
  let best: Range | null = null;
  let bestScore = -Infinity;
  query.texts.forEach((exact, i) => {
    if (!exact.trim()) return;
    const hits: Range[] = [];
    for (let at = text.indexOf(exact); at !== -1 && hits.length < 200; at = text.indexOf(exact, at + 1)) {
      const range = { from: at, to: at + exact.length };
      if (query.level !== "word" || wholeWord(text, range)) hits.push(range);
    }
    for (const range of hits) {
      const context = contextScore(text, range, query.anchor);
      if (context < minContext || (short && hits.length > 1 && context < 0.25)) continue;
      const score = context - distance(range) + (i === 0 ? 0.01 : 0);
      if (score > bestScore) { best = range; bestScore = score; }
    }
  });
  if (best || short || minContext > 0) return best;
  const candidates = query.level === "paragraph"
    ? paragraphs(text)
    : paragraphs(text).flatMap((p) => sentencesIn(text.slice(p.from, p.to), p.from));
  let top: Range | null = null;
  let topScore = -Infinity;
  for (const range of candidates) {
    const passage = text.slice(range.from, range.to);
    const alike = Math.max(...query.texts.map((t) => similarity(t, passage)));
    if (alike < SIMILAR) continue;
    const score = alike + contextScore(text, range, query.anchor) * 0.1 - distance(range);
    if (score > topScore) { top = range; topScore = score; }
  }
  return top;
}
