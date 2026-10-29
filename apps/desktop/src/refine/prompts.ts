import type { Ask } from "@/lib/ai";

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

/** The writer's voice comes first; these are the tells that make prose read
 *  as generated, so the editor must never introduce them. */
const EDITOR = `You are a careful editor helping a writer revise their own prose.
The writing is theirs. Keep their voice, vocabulary, tone and point of view, and change only what the instruction asks for.
Never add new ideas, claims, examples or flourishes.
Never introduce: em dashes, "not X, but Y" or "it's not just X, it's Y" constructions, lists of three for rhythm, rhetorical questions, or words like delve, tapestry, testament, crucial, seamless, elevate, unlock, landscape.
Keep any Markdown or MDX syntax in the passage exactly as it is, and match its punctuation style (straight or curly quotes and apostrophes).`;

const REWRITE = `${EDITOR}
Reply with only the revised passage: no quotes, no preamble, no explanation.`;

const CHOICES = `${EDITOR}
Reply with up to six alternatives for the selected text that fit this exact sentence, one per line, best first. No numbering, no explanations.`;

const CONTEXT_BEFORE = 1500;
const CONTEXT_AFTER = 500;

export function ask(action: Pick<Action, "shape" | "instruction">, doc: string, from: number, to: number): Ask {
  const before = doc.slice(Math.max(0, from - CONTEXT_BEFORE), from);
  const after = doc.slice(to, to + CONTEXT_AFTER);
  const passage = doc.slice(from, to);
  return {
    system: action.shape === "choices" ? CHOICES : REWRITE,
    messages: [
      {
        role: "user",
        content: `<context_before>${before}</context_before>
<passage>${passage}</passage>
<context_after>${after}</context_after>

${action.instruction}`,
      },
    ],
    maxTokens: Math.min(4000, 400 + passage.length),
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
