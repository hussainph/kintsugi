import { cutRange, onWordBoundaries, proseSentences, type Mark, type Sentence } from "@kintsugi/editor/marks";
import { splitFrontmatter } from "@kintsugi/core/frontmatter";
import type { Suggestion } from "@/lib/chat";
import { locate } from "./marks.ts";

/**
 * "Review this draft" and "Review this section" (KI-109). Kin reads the
 * draft (`ai/chat/review.rs`) and answers with suggestions on its numbered
 * sentences: a cut, a rewrite with new words, or a flag with only a reason.
 * Here they're checked against the text and become Kin's marks, which the
 * card steps through. Nothing is saved.
 */

export type ReviewKind = "draft" | "section";
type Range = { from: number; to: number };

export const REVIEWS: { id: ReviewKind; label: string }[] = [
  { id: "draft", label: "Review this draft" },
  { id: "section", label: "Review this section" },
];

const fence = /^\s*(```|~~~)/;

/** The headings outside code, in order. */
function headings(text: string): { from: number; level: number; title: string }[] {
  const out: { from: number; level: number; title: string }[] = [];
  let pos = splitFrontmatter(text).head.length;
  let code = false;
  for (const line of text.slice(pos).split("\n")) {
    if (fence.test(line)) code = !code;
    else if (!code) {
      const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (heading) out.push({ from: pos, level: heading[1].length, title: heading[2] });
    }
    pos += line.length + 1;
  }
  return out;
}

/**
 * What a review covers. The draft: its body. A section: the selection if
 * there is one, else the heading the cursor is under down to the next
 * heading of its level or above (with no heading above, the start of the
 * body down to the first heading). `scope` says so in Kin's brief.
 */
export function reviewScope(text: string, kind: ReviewKind, selection: Range): { range: Range; scope: string | null; label: string } {
  const body = { from: splitFrontmatter(text).head.length, to: text.length };
  if (kind === "draft") return { range: body, scope: null, label: "Review this draft" };
  if (selection.to > selection.from) return { range: selection, scope: "the selected passage", label: "Review this section" };
  const all = headings(text);
  const at = all.filter((h) => h.from <= selection.from).pop();
  if (!at) {
    const first = all[0];
    return { range: { from: body.from, to: first ? first.from : body.to }, scope: first ? "the opening, before the first heading" : null, label: "Review this section" };
  }
  const next = all.find((h) => h.from > at.from && h.level <= at.level);
  return { range: { from: at.from, to: next ? next.from : body.to }, scope: `the section “${at.title}”`, label: "Review this section" };
}

/** The sentences a review covers, numbered for Kin's brief. */
export const reviewSentences = (text: string, range: Range) => proseSentences(text, range).slice(0, 600);

/** The sentences again in `text` after it changed while Kin read: each where
 *  its words now are (the nearest copy to where it was), else gone. */
export function relocate(sentences: readonly Sentence[], text: string): Sentence[] {
  const out: Sentence[] = [];
  for (const s of sentences) {
    if (text.slice(s.from, s.to) === s.text) {
      out.push(s);
      continue;
    }
    let best = -1;
    for (let at = text.indexOf(s.text); at !== -1; at = text.indexOf(s.text, at + 1)) {
      if (best === -1 || Math.abs(at - s.from) < Math.abs(best - s.from)) best = at;
    }
    if (best !== -1) out.push({ ...s, from: best, to: best + s.text.length });
  }
  return out;
}

const MAX_MARKS = 12;
const MAX_REASON = 160;

/**
 * A review's suggestions as marks. One naming a sentence that isn't there,
 * quoting words it doesn't have, cutting through a word, rewriting words
 * to themselves, or overlapping one already kept is dropped.
 */
export function parseReview(list: readonly Suggestion[], text: string, sentences: readonly Sentence[], batch: string): { marks: Mark[]; dropped: number } {
  const marks: Mark[] = [];
  let dropped = 0;
  for (const s of list) {
    const sentence = sentences.find((x) => x.n === s.sentence);
    const found = sentence && (s.quote?.trim() ? locate(text, sentence, s.quote, []) : { from: sentence.from, to: sentence.to });
    let range = found ?? null;
    const reason = (s.reason ?? "").trim();
    const replacement = s.kind === "rewrite" ? (s.text ?? "").trim() : undefined;
    if (range && s.kind === "cut") range = onWordBoundaries(text, range) ? cutRange(text, range) : null;
    const ok = !!range && range.to > range.from &&
      (s.kind === "cut" || (s.kind === "flag" && !!reason) || (s.kind === "rewrite" && !!replacement && replacement !== text.slice(range.from, range.to)));
    if (!ok || marks.some((m) => m.range.from < range!.to && range!.from < m.range.to)) {
      dropped++;
      continue;
    }
    const short = reason.length > MAX_REASON ? `${reason.slice(0, MAX_REASON - 1).trimEnd()}…` : reason;
    marks.push({ id: `${batch}:${marks.length}`, range: range!, kind: s.kind, reason: short, ...(replacement ? { text: replacement } : {}) });
    if (marks.length === MAX_MARKS) break;
  }
  return { marks, dropped };
}

/** Kin's first message in the thread Discuss starts: the suggestion as he saw it. */
export function discussNote(mark: Mark, words: string): string {
  const flat = words.replace(/\s+/g, " ").trim();
  const quoted = `“${flat.length > 200 ? `${flat.slice(0, 199).trimEnd()}…` : flat}”`;
  const why = mark.reason ? ` ${mark.reason}` : "";
  if (mark.kind === "cut") return `I’d cut ${quoted}.${why}`;
  if (mark.kind === "rewrite") return `I’d change ${quoted} to “${mark.text ?? ""}”.${why}`;
  return `${quoted}: ${mark.reason}`;
}
