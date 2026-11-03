// PROTOTYPE (KI-96), throwaway: the scripted content the three candidates
// share. Nothing here is saved; everything lives in memory for one run.
import draftText from "./draft.md?raw";

export const DRAFT = draftText;
export const DRAFT_PATH = "prototype/kintsugi-and-gold.md";

export type Variant = "A" | "B" | "C";
export const VARIANTS: { key: Variant; name: string }[] = [
  { key: "A", name: "One margin" },
  { key: "B", name: "Two gutters" },
  { key: "C", name: "Kin at the text" },
];

/** Kin's suggestions when the toggle is on. Cuts are marks in the text;
 *  rewrites wait in the stash, pinned to the words they would replace. */
export type Suggestion = { id: string; kind: "cut" | "rewrite"; quote: string; replacement?: string };
export const SUGGESTIONS: Suggestion[] = [
  { id: "s-object", kind: "rewrite", quote: "part of the object now", replacement: "part of the bowl now" },
  { id: "s-unsure", kind: "cut", quote: " I am not sure yet which essay it is for." },
  { id: "s-think", kind: "cut", quote: "I think that " },
  { id: "s-polish", kind: "rewrite", quote: "I polish a sentence long before I know whether it can carry any weight.", replacement: "I polish a sentence before I know if it can carry weight." },
  { id: "s-sleep", kind: "cut", quote: " Why we sleep is not relevant, but it is the tab I keep leaving open." },
];

export type StashItem = { id: string; by: "owner" | "kin"; text: string; suggestion?: string; fresh?: boolean };
export const STASH: StashItem[] = [
  { id: "st-1", by: "owner", text: "Ask Mum what happened to the teapot lid." },
  { id: "st-2", by: "kin", text: "On craft and repair says sanding is where you learn the wood. That argues against paragraph five. Worth a line?" }, // copy-lint-allow: a scratch vault title
  { id: "st-3", by: "owner", text: "Strength before looks. Is that true for essays, or only for bowls?" },
  { id: "st-4", by: "kin", text: "Golden joinery: lacquer did the repair, gold was only the finish." }, // copy-lint-allow: his draft's words and the scratch vault's titles
];

/** A word or sentence with versions he kept (KI-86); Kin's are marked. */
export type Version = { text: string; by: "owner" | "kin"; fresh?: boolean };
export type VersionSet = { id: string; level: "word" | "sentence" | "paragraph"; quote: string; versions: Version[]; current: number; ask: Version[] };
export const VERSIONS: VersionSet[] = [
  {
    id: "v-decision", level: "word", quote: "decision", current: 0,
    versions: [{ text: "decision", by: "owner" }, { text: "choice", by: "owner" }, { text: "commitment", by: "owner" }],
    ask: [{ text: "verdict", by: "kin" }, { text: "stance", by: "kin" }],
  },
  {
    id: "v-drafts", level: "sentence", quote: "Not bowls at all, but drafts.", current: 0,
    versions: [{ text: "Not bowls at all, but drafts.", by: "owner" }, { text: "It was never about bowls. It is about drafts.", by: "owner" }],
    ask: [{ text: "The bowls were a way into drafts.", by: "kin" }],
  },
];

export type Message = { by: "owner" | "kin"; text: string; stashable?: boolean };
export type Chat = {
  id: string;
  title: string;
  group: "draft" | "else";
  kind: "draft" | "paragraph" | "feed" | "idea" | "clip" | "general" | "helper";
  /** A paragraph chat's paragraph, by its first words. */
  paragraph?: string;
  when: string;
  messages: Message[];
  /** Kin's own words are in the real (mock) chat, not scripted here. */
  real?: boolean;
};

export const CHATS: Chat[] = [
  { id: "c-draft", title: "Kintsugi and gold", group: "draft", kind: "draft", when: "2m", messages: [], real: true }, // copy-lint-allow: his draft's words and the scratch vault's titles
  {
    id: "c-decision", title: "Is “decision” too strong here?", group: "draft", kind: "paragraph", when: "9m",
    paragraph: "The first time I saw a kintsugi bowl",
    messages: [
      { by: "owner", text: "Is “decision” too strong here?" },
      { by: "kin", text: "Keep it. The rest of the draft argues for it. On craft and repair leans the other way, so link it if you want the tension." }, // copy-lint-allow: his draft's words and the scratch vault's titles
    ],
  },
  {
    id: "c-teapot", title: "The teapot arrives fourth", group: "draft", kind: "paragraph", when: "1h",
    paragraph: "My grandmother kept a cracked teapot",
    messages: [
      { by: "kin", text: "The teapot is the strongest image here and it arrives fourth. What if the draft opened with it?", stashable: true },
    ],
  },
  { id: "c-general", title: "General", group: "else", kind: "general", when: "Yesterday", messages: [], real: true },
  { id: "c-quiet", title: "The quiet web, revisited", group: "else", kind: "feed", when: "Mon", messages: [{ by: "kin", text: "It's the third post this month on slow sites." }] }, // copy-lint-allow: his draft's words and the scratch vault's titles
  { id: "c-cost", title: "What repair costs", group: "else", kind: "idea", when: "Sun", messages: [{ by: "kin", text: "You've written about what repair is, never what it costs." }] },
  { id: "c-joinery", title: "Golden joinery", group: "else", kind: "clip", when: "Oct 28", messages: [{ by: "owner", text: "Is this the Britannica piece or the museum one?" }] }, // copy-lint-allow: his draft's words and the scratch vault's titles
  { id: "c-today", title: "Ideas for today", group: "else", kind: "helper", when: "6:00", messages: [{ by: "kin", text: "3 new ideas, 1 dropped for a bad quote." }] },
  { id: "c-rain", title: "Field notes on rain", group: "else", kind: "draft", when: "Oct 26", messages: [{ by: "kin", text: "The second paragraph repeats the first." }] },
  { id: "c-morning", title: "Morning pages", group: "else", kind: "draft", when: "Oct 25", messages: [{ by: "owner", text: "Is the kitchen light a metaphor?" }] },
  { id: "c-pg", title: "How Paul Graham ends essays", group: "else", kind: "general", when: "Oct 20", messages: [{ by: "kin", text: "He thanks the people who read drafts." }] },
];

export const ASKS = ["Who disagrees?", "Find a clip", "Have I said this before?"];

/** Kin's scripted answers: to an inline ask, and to "Why?" on a suggestion. */
export const ANSWERS: Record<string, string> = {
  "Who disagrees?": "Your own post does. On craft and repair says the second hour of sanding is where the work admits what it is. That's polish first, the opposite of this.", // copy-lint-allow: his draft's words and the scratch vault's titles
  "Find a clip": "Golden joinery has it: “The repair is not hidden. It is given a color of its own.”", // copy-lint-allow: his draft's words and the scratch vault's titles
  "Have I said this before?": "Once. In Attention has a cost you wrote that the drafts you keep are the ones that broke.",
  why: "You say “bowl” two sentences back. “Object” makes the reader switch pictures.",
  default: "Fair. I'd keep your version and see how it reads tomorrow.",
};

export const REFERENCES = {
  here: [
    { title: "Repair is a kind of attention", meta: "draft", summary: "We tend to think of repair as restoration: make it look as if nothing…" }, // copy-lint-allow: his draft's words and the scratch vault's titles
    { title: "On craft and repair", meta: "complete", summary: "There is a moment, somewhere in the second hour of sanding, when the…" }, // copy-lint-allow: his draft's words and the scratch vault's titles
    { title: "Golden joinery", meta: "Encyclopaedia Britannica", summary: "The history of kintsugi, and why a visible repair can make an object…" }, // copy-lint-allow: his draft's words and the scratch vault's titles
  ],
  along: [
    { title: "Attention has a cost", meta: "draft", summary: "Every unfinished thought keeps a tab open somewhere in my head…" },
    { title: "Reading list", meta: "draft", summary: "Finish the section on memory, then the one on repair…" },
  ],
};
