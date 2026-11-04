import type { SpanLevel } from "@kintsugi/editor/alternatives";
import type { Ask } from "@/lib/ai";
import writing from "../../src-tauri/src/ai/writing/rules.json" with { type: "json" };

export type Action = {
  id: string;
  label: string;
  /** One suggestion to diff against the selection, or a list to pick from. */
  shape: "rewrite" | "choices";
  instruction: string;
};

export const ACTIONS: Action[] = [
  {
    id: "tighten",
    label: "Tighten",
    shape: "rewrite",
    instruction: "Tighten this passage: cut filler, hedging and repetition, and keep every idea. It should come out noticeably shorter.",
  },
  {
    id: "rephrase",
    label: "Rephrase",
    shape: "rewrite",
    instruction: "Rephrase this passage so it reads more naturally. Keep the meaning and roughly the length.",
  },
  {
    id: "simplify",
    label: "Simplify",
    shape: "rewrite",
    instruction: "Make this passage plainer and easier to read. Prefer short, common words and shorter sentences.",
  },
  {
    id: "fix",
    label: "Fix grammar and spelling",
    shape: "rewrite",
    instruction: "Fix grammar, spelling and punctuation only. Change nothing else.",
  },
  {
    id: "synonyms",
    label: "Synonyms",
    shape: "choices",
    instruction: "Suggest alternatives for the selected word or phrase.",
  },
];

/** The tells that make prose read as generated (KI-102). One copy, shared
 *  with Kin's Rust prompts (`ai/writing.rs`), which render the same lists. */
const bullets = (lines: string[]) => lines.map((line) => `- ${line}`).join("\n");
export const WRITING_LISTS = `Never, whatever the tone:\n${bullets(writing.never)}\n\nAvoid unless the source says it:\n${bullets(writing.avoid)}`;

/** An edit keeps what his passage already has and adds none of the tells. */
const NEVER = `Never introduce any of these into the passage; what the passage already uses, keep.\n${WRITING_LISTS}`;

/** The writer's voice comes first. */
const EDITOR = `You are a careful editor helping a writer revise their own prose.
The writing is theirs. Keep their voice, vocabulary, tone and point of view, and change only what the instruction asks for.
Never add new ideas, claims, examples or flourishes.
${NEVER}
Keep any Markdown or MDX syntax in the passage exactly as it is, and match its punctuation style (straight or curly quotes and apostrophes).`;

const REWRITE = `${EDITOR}
Reply with only the revised passage: no quotes, no preamble, no explanation.`;

const CHOICES = `${EDITOR}
Reply with up to six alternatives for the selected text that fit this exact sentence, one per line, best first. No numbering, no explanations.`;

const ALTERNATIVES = `${EDITOR}
Reply only with a JSON array of up to 3 distinct strings, best first.
Each string must replace the whole passage. Do not include the original passage, labels, explanations or code fences.
Encode line breaks within a string as \\n.`;

const SYNONYMS = "Suggest synonyms for the selected word or phrase that fit the surrounding sentence. Match its grammatical form.";
const ALTERNATIVE_INSTRUCTIONS: Record<SpanLevel, string> = {
  word: SYNONYMS,
  phrase: SYNONYMS,
  sentence: "Reword the selected sentence in different ways. Keep its meaning and roughly its length.",
  paragraph: "Give different versions of the selected paragraph. Keep every idea, its order and roughly its length. An alternative may contain line breaks.",
};

const CONTEXT_BEFORE = 1500;
const CONTEXT_AFTER = 500;

function context(doc: string, from: number, to: number): string {
  const before = doc.slice(Math.max(0, from - CONTEXT_BEFORE), from);
  const after = doc.slice(to, to + CONTEXT_AFTER);
  return `<context_before>${before}</context_before>
<passage>${doc.slice(from, to)}</passage>
<context_after>${after}</context_after>`;
}

export function ask(action: Pick<Action, "shape" | "instruction">, doc: string, from: number, to: number): Ask {
  return {
    system: action.shape === "choices" ? CHOICES : REWRITE,
    messages: [{ role: "user", content: `${context(doc, from, to)}\n\n${action.instruction}` }],
    maxTokens: Math.min(4000, 400 + doc.slice(from, to).length),
  };
}

/** One request offers replacements for this span, without changing the draft. */
export function askAlternatives(level: SpanLevel, doc: string, from: number, to: number): Ask {
  return {
    system: ALTERNATIVES,
    messages: [{
      role: "user",
      content: `<alternatives level="${level}">\n${context(doc, from, to)}\n\n${ALTERNATIVE_INSTRUCTIONS[level]}\n</alternatives>`,
    }],
    maxTokens: Math.min(4000, 400 + 3 * doc.slice(from, to).length),
  };
}

/** Models sometimes wrap the answer anyway; take it back off. */
export function clean(text: string, original: string): string {
  let out = text.replace(/^<passage>|<\/passage>$/g, "").trim();
  if (/^["“].*["”]$/s.test(out) && !/^["“]/.test(original.trim())) out = out.slice(1, -1);
  // Keep the selection's own leading/trailing whitespace.
  const lead = /^\s*/.exec(original)![0];
  const trail = /\s*$/.exec(original)![0];
  return lead + out + trail;
}

export function choices(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 6);
}

/** JSON keeps each passage intact, including its internal line breaks. */
export function alternativeChoices(text: string, original: string): string[] {
  let parsed: unknown;
  try {
    // Tolerate a model adding a single code fence, but never guess at prose or lists.
    const json = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1");
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) return [];

  const seen = new Set([original.trim()]);
  const lead = /^\s*/.exec(original)![0];
  const trail = /\s*$/.exec(original)![0];
  const out: string[] = [];
  for (const entry of parsed as string[]) {
    const value = clean(entry.trim(), original).trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(lead + value + trail);
    if (out.length === 3) break;
  }
  return out;
}
