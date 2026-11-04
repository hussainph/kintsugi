import { cutRange, onWordBoundaries, proseSentences, type Mark, type Sentence } from "@kintsugi/editor/marks";
import type { Ask } from "@/lib/ai";
import { WRITING_LISTS } from "./prompts.ts";

/**
 * ⌘K's checks and trims (KI-90). Kin points, it never writes: a check
 * answers with ranges of his sentences and a reason for each, drawn as gold
 * underlines; a trim answers with words to delete, drawn as gold
 * strike-throughs until he applies them. Both are asked for against the
 * passage's numbered sentences, as the review numbers paragraphs, and the
 * answer is checked against the text before anything shows.
 */

export type CheckId = "weakest" | "long" | "convoluted" | "tone" | "hedges";
export type Check = { id: CheckId; label: string; instruction: string; quotes: boolean };

export const CHECKS: Check[] = [
  {
    id: "weakest",
    label: "Weakest sentences",
    quotes: false,
    instruction: "Find the weakest sentences: the ones that say least, claim something without backing it, or that the piece would not miss. At most five.",
  },
  {
    id: "long",
    label: "Sentences that run long",
    quotes: false,
    instruction: "Find the sentences that run long: more words or ideas than one sentence carries well. Say where each could break.",
  },
  {
    id: "convoluted",
    label: "Convoluted sentences",
    quotes: false,
    instruction: "Find the convoluted sentences: ones a reader has to go back over, with nested clauses, a buried subject or a tangled order.",
  },
  {
    id: "tone",
    label: "Words off the tone",
    quotes: true,
    instruction: "Find words and short phrases that don't fit the tone of the rest of the draft: too formal or too casual for it, jargon, or stock phrases he wouldn't say. Quote only those words.",
  },
  {
    id: "hedges",
    label: "Hedges and filler",
    quotes: true,
    instruction: "Find hedges and filler: words that soften or pad without adding meaning (really, just, I think, sort of, it seems). Quote only those words.",
  },
];

export type TrimId = "trim-10" | "trim-20" | "trim-30" | "trim-50";
export type Trim = { id: TrimId; label: string; percent: number };

export const TRIMS: Trim[] = [
  { id: "trim-10", label: "Slight trim −10%", percent: 10 },
  { id: "trim-20", label: "Tighten more", percent: 20 },
  { id: "trim-30", label: "Even sharper", percent: 30 },
  { id: "trim-50", label: "Cut in half −50%", percent: 50 },
];

/** Marks the system prompts carry; the headless mock recognizes them too. */
export const CHECK_BRIEF = "You point at what to look at in a writer's own draft.";
export const TRIM_BRIEF = "You trim a writer's own draft by deleting words.";

/** KI-102's tells, for checks: never in Kin's reasons, worth flagging in his draft. */
const CHECK_SYSTEM = `${CHECK_BRIEF}
The writing is his. You never write, rewrite or suggest words: you only point at sentences or words and say why in one short line.
Each reason is plain, specific and under 12 words, with no praise and no suggested wording.
These are the tells that make prose read as generated. Never use them in your reasons; where his draft has them, they are worth pointing at.
${WRITING_LISTS}`;

const TRIM_SYSTEM = `${TRIM_BRIEF}
The writing is his. You only delete: never add, replace, reorder or respell a word, and never add punctuation.
Cut whole words: filler, hedges, repetition, and phrases, clauses or sentences that add nothing. Keep his voice, his claims and every idea that matters.
Each sentence must still read as a sentence once the words are gone. Never cut inside a link, code or Markdown syntax.
Never introduce any of these, and prefer cutting them where they appear:
${WRITING_LISTS}`;

const CONTEXT = 1500;

function numbered(sentences: Sentence[]): string {
  return sentences.map((s) => `[${s.n}] ${s.text.replace(/\s*\n\s*/g, " ")}`).join("\n");
}

/** The words in `text`, as the editor's word count counts them. */
export function words(text: string): string[] {
  return text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
}

/** The sentences a check or trim covers: the selection, or the draft's body. */
export function sentencesFor(doc: string, scope: { from: number; to: number } | null): Sentence[] {
  return proseSentences(doc, scope ?? undefined).slice(0, 600);
}

function surroundings(doc: string, sentences: Sentence[], whole: boolean): string {
  if (whole || !sentences.length) return "";
  const from = sentences[0].from;
  const to = sentences[sentences.length - 1].to;
  return `<context_before>${doc.slice(Math.max(0, from - CONTEXT), from)}</context_before>\n<context_after>${doc.slice(to, to + CONTEXT / 3)}</context_after>\n\n`;
}

export function askCheck(check: Check, doc: string, sentences: Sentence[], whole: boolean): Ask {
  const shape = check.quotes
    ? `<marks>[{"sentence": 2, "quote": "the exact words", "reason": "…"}]</marks>. "quote" is copied character for character from that sentence.`
    : `<marks>[{"sentence": 2, "reason": "…"}]</marks>.`;
  return {
    system: CHECK_SYSTEM,
    messages: [{
      role: "user",
      content: `${surroundings(doc, sentences, whole)}<check kind="${check.id}">\n${numbered(sentences)}\n</check>\n\n${check.instruction} Point at nothing if nothing qualifies; at most twelve.\nAnswer with only a JSON array between <marks> tags, one object per mark: ${shape} "sentence" is a number from the list.`,
    }],
    maxTokens: 2000,
  };
}

export function askTrim(trim: Trim, doc: string, sentences: Sentence[], whole: boolean): Ask {
  const total = words(sentences.map((s) => s.text).join(" ")).length;
  const target = Math.max(1, Math.round((total * trim.percent) / 100));
  return {
    system: TRIM_SYSTEM,
    messages: [{
      role: "user",
      content: `${surroundings(doc, sentences, whole)}<trim percent="${trim.percent}">\n${numbered(sentences)}\n</trim>\n\nCut about ${trim.percent}% of these words: about ${target} of ${total}.\nAnswer with only a JSON array between <cuts> tags, one object per run of words to delete: <cuts>[{"sentence": 2, "cut": "the exact words"}]</cuts>. "cut" is copied character for character from that sentence; to cut a whole sentence, quote all of it. "sentence" is a number from the list.`,
    }],
    maxTokens: Math.min(8000, 400 + Math.round(sentences.reduce((n, s) => n + s.text.length, 0) / 2)),
  };
}

/** The JSON array between `<tag>` tags, or null. */
function listIn(reply: string, tag: string): unknown[] | null {
  const body = reply.split(`<${tag}>`)[1]?.split(`</${tag}>`)[0];
  if (body === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(body.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, "$1"));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** The quote's first place in the sentence that an earlier, identical
 *  quote hasn't taken ("very, very"), in document positions. */
function locate(doc: string, sentence: Sentence, quote: string, taken: { from: number; to: number }[]) {
  const exact = quote.trim();
  if (!exact) return null;
  const text = doc.slice(sentence.from, sentence.to);
  for (let at = text.indexOf(exact); at !== -1; at = text.indexOf(exact, at + 1)) {
    const range = { from: sentence.from + at, to: sentence.from + at + exact.length };
    if (!taken.some((t) => t.from === range.from && t.to === range.to)) return range;
  }
  return null;
}

const MAX_MARKS = 12;
const MAX_REASON = 160;

export type Parsed<T> = { ok: true; marks: T[]; dropped: number } | { ok: false; error: string };

/** A check's answer as flags on the draft. Entries naming a sentence that
 *  isn't there, or quoting words it doesn't have, are dropped. */
export function parseCheck(reply: string, doc: string, sentences: Sentence[], batch: string): Parsed<Mark> {
  const list = listIn(reply, "marks");
  if (!list) return { ok: false, error: "Kin’s answer wasn’t a list of marks. Try again." };
  const marks: Mark[] = [];
  let dropped = 0;
  for (const entry of list) {
    const sentence = record(entry) && typeof entry.sentence === "number" ? sentences.find((s) => s.n === entry.sentence) : undefined;
    const reason = record(entry) && typeof entry.reason === "string" ? entry.reason.trim().split("\n")[0].trim() : "";
    const quote = record(entry) && typeof entry.quote === "string" ? entry.quote : null;
    const range = sentence && (quote ? locate(doc, sentence, quote, []) : { from: sentence.from, to: sentence.to });
    if (!sentence || !range || !reason || marks.some((m) => m.range.from === range.from && m.range.to === range.to)) {
      dropped++;
      continue;
    }
    const short = reason.length > MAX_REASON ? `${reason.slice(0, MAX_REASON - 1).trimEnd()}…` : reason;
    marks.push({ id: `${batch}:${marks.length}`, range, kind: "flag", reason: short });
    if (marks.length === MAX_MARKS) break;
  }
  return { ok: true, marks, dropped };
}

const CUT_KEYS = new Set(["sentence", "cut", "reason"]);
const ADDS = "Kin’s trim would have added words, so it wasn’t applied. Try again.";

/** Whether `after`'s words are `before`'s with some taken out. */
export function onlyRemoves(before: string, after: string): boolean {
  const kept = words(after);
  const all = words(before);
  let i = 0;
  for (const word of all) if (i < kept.length && kept[i] === word) i++;
  return i === kept.length && kept.length <= all.length;
}

/**
 * A trim's answer as cuts, checked against the text. Any entry that would
 * put words in (a replacement, a cut through the middle of a word) refuses
 * the whole answer; a quote the sentence doesn't have is dropped, as it
 * removes nothing.
 */
export function parseTrim(reply: string, doc: string, sentences: Sentence[], batch: string): Parsed<Mark> {
  const list = listIn(reply, "cuts");
  if (!list) return { ok: false, error: "Kin’s answer wasn’t a list of cuts. Try again." };
  const ranges: { from: number; to: number }[] = [];
  let dropped = 0;
  for (const entry of list) {
    if (!record(entry) || Object.keys(entry).some((key) => !CUT_KEYS.has(key)) || typeof entry.cut !== "string") return { ok: false, error: ADDS };
    const sentence = typeof entry.sentence === "number" ? sentences.find((s) => s.n === entry.sentence) : undefined;
    const found = sentence && locate(doc, sentence, entry.cut, ranges);
    if (!found) {
      dropped++;
      continue;
    }
    if (!onWordBoundaries(doc, found)) return { ok: false, error: ADDS };
    ranges.push(found);
  }
  // Close up the words around each cut, then merge cuts that overlap. Cuts
  // that only touch stay apart, so he can keep either word.
  const cuts = ranges.map((r) => cutRange(doc, r)).filter((r) => r.to > r.from).sort((a, b) => a.from - b.from);
  const merged: { from: number; to: number }[] = [];
  for (const cut of cuts) {
    const last = merged[merged.length - 1];
    if (last && cut.from < last.to) last.to = Math.max(last.to, cut.to);
    else merged.push({ ...cut });
  }
  if (merged.length) {
    const from = Math.min(sentences[0]?.from ?? 0, merged[0].from);
    const to = Math.max(sentences[sentences.length - 1]?.to ?? doc.length, merged[merged.length - 1].to);
    let after = "";
    let at = from;
    for (const cut of merged) { after += doc.slice(at, cut.from); at = cut.to; }
    after += doc.slice(at, to);
    if (!onlyRemoves(doc.slice(from, to), after)) return { ok: false, error: ADDS };
  }
  return {
    ok: true,
    marks: merged.map((range, i) => ({ id: `${batch}:${i}`, range, kind: "cut" as const, reason: "" })),
    dropped,
  };
}
