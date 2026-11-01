/**
 * Hand-written fixture ideas. Every quote below is copied verbatim from the
 * seed vault (`scripts/seed-desktop.mjs`), except the three clips marked
 * `extra`, which are invented for this study so the tools theme hussain.ph
 * writes about has something to stand on. Nothing here is generated.
 */

export type ClipRef = {
  /** Vault path without extension, as a wikilink would write it. */
  path: string;
  /** Where the quote came from: a clip's site, or "Your writing". */
  source: string;
  title: string;
  quote: string;
  /** Own writing is a first-class source; it is labelled as such. */
  own?: boolean;
  /** Invented for this study; not in the seed vault. */
  extra?: boolean;
};

export type Step = { did: string; found?: string };

export type Reason = {
  id: string;
  text: string;
  /** A reason that comes from a line in About you (USER.md) can be fixed there. */
  profileLine?: string;
};

export type Idea = {
  id: string;
  /** "gap" | "tension" | "stalled" | "connection" — what kind of noticing it is. */
  kind: "Gap" | "Tension" | "Stalled draft" | "Connection";
  title: string;
  /** A working title Adopt gives the new draft; the owner can change it. */
  draftTitle: string;
  snippet: string;
  /** Days since Kin offered it. Ideas fade after about a week. */
  age: number;
  observed: string[];
  hunch: string;
  clips: ClipRef[];
  steps: Step[];
  footprint: string;
  reasons: Reason[];
  /** A fixture for what Refine returns, when one exists. */
  refined?: { title: string; draftTitle: string; snippet: string; hunch: string; asked: string };
};

const clip = {
  goldenJoinery: {
    path: "inspiration/golden-joinery",
    source: "Encyclopaedia Britannica",
    title: "Golden joinery",
    quote: "The repair is not hidden. It is given a color of its own.",
  },
  goldenJoinerySource: {
    path: "inspiration/golden-joinery",
    source: "Encyclopaedia Britannica",
    title: "Golden joinery",
    quote:
      "the value comes from the care of the repair, not from the break itself.",
  },
  onCraft: {
    path: "posts/on-craft",
    source: "Your writing",
    title: "On craft and repair",
    quote: "a repair is not a cover-up. It is a record of care.",
    own: true,
  },
  repair: {
    path: "notes/repair",
    source: "Your writing",
    title: "Repair is a kind of attention",
    quote:
      "the more interesting repair makes the history legible. The patch is not hidden.",
    own: true,
  },
  kintsugiDraft: {
    path: "drafts/kintsugi-and-gold",
    source: "Your writing",
    title: "Kintsugi and gold",
    quote:
      "That sentence belongs in [[repair]], or maybe in [[posts/on-craft]]. I am not sure yet which essay it is for.",
    own: true,
  },
  quietWebClip: {
    path: "inspiration/the-quiet-web",
    source: "Are.na Editorial",
    title: "The quiet web",
    quote: "A quiet website is not an empty one.",
  },
  quietWebDraft: {
    path: "posts/the-quiet-web",
    source: "Your writing",
    title: "The quiet web",
    quote:
      "They are trying to deserve the attention I already have.",
    own: true,
  },
  attention: {
    path: "notes/attention",
    source: "Your writing",
    title: "Attention has a cost",
    quote: "The cost is not the time itself. It is the residue.",
    own: true,
  },
  sleep: {
    path: "inspiration/why-we-sleep",
    source: "The New Yorker",
    title: "Why we sleep",
    quote: "Sleep is not a luxury; it is the substrate attention is built on.",
  },
  openLoops: {
    path: "inspiration/reader-note-on-attention",
    source: "Your note, from the phone",
    title: "Note on attention",
    quote: "I do not need more time; I need fewer open loops.",
    own: true,
  },
  windowLight: {
    path: "inspiration/window-light",
    source: "Your photo",
    title: "Window light",
    quote: "The light on the kitchen wall at 7:40. Not a metaphor yet.",
    own: true,
  },
  morningPages: {
    path: "inbox/morning-pages",
    source: "Your writing",
    title: "Morning pages",
    quote:
      "The camera was pointed at the wall before I had a sentence.",
    own: true,
  },
  rain: {
    path: "inspiration/a-short-film-about-rain",
    source: "YouTube · Studio Umbrella",
    title: "A short film about rain",
    quote: "The sound of rain on a window is not one sound.",
  },
  workbench: {
    path: "inspiration/notes-from-the-workbench",
    source: "Workbench Journal",
    title: "Notes from the workbench",
    quote:
      "A good tool disappears into the hand. A better one changes what the hand reaches for.",
    extra: true,
  },
  outliner: {
    path: "inspiration/the-outline-is-the-argument",
    source: "X · @marginalia",
    title: "The outline is the argument",
    quote:
      "Switched from an outliner back to a blank page and my essays got shorter and stranger. The tool was writing the structure for me.",
    extra: true,
  },
  vanished: {
    path: "inspiration/a-post-that-vanished",
    source: "Your note on an X post",
    title: "A post that vanished",
    quote:
      "a capture is not a promise that the source will stay put.",
    own: true,
  },
  fieldNotes: {
    path: "posts/series/field-notes",
    source: "Your writing",
    title: "Field notes: the long way home",
    quote:
      "The rule is simple: no destination, no headphones, one sentence before the door opens.",
    own: true,
  },
} satisfies Record<string, ClipRef>;

export const TODAY = "Sunday, 1 November";

export const ideas: Idea[] = [
  {
    id: "what-repair-costs",
    draftTitle: "What repair costs",
    kind: "Gap",
    title: "You've written about what repair is, never what it costs",
    snippet:
      "Four pieces call repair care. None says what the care takes from you.",
    age: 0,
    observed: [
      "Repair is the subject of 4 documents: one published post and three drafts.",
      "Each one defines repair as care or visibility. None mentions time, money or giving up.",
      "You saved Golden joinery on 27 October and linked it twice in On craft and repair.",
    ],
    hunch:
      "The essay you haven't written is the cost side: a visible repair means admitting you chose to spend an afternoon on this bowl instead of buying another one.",
    clips: [clip.onCraft, clip.repair, clip.goldenJoinerySource],
    steps: [
      { did: "Searched your writing for “repair”", found: "4 documents" },
      { did: "Read On craft and repair (published) and both repair drafts" },
      {
        did: "Looked for cost, time, price or effort near “repair”",
        found: "0 passages",
      },
      {
        did: "Checked your clips on repair",
        found: "Golden joinery mentions care, not cost",
      },
      { did: "Skipped A post that vanished: it couldn't be fetched" },
    ],
    footprint: "6 searches · 4 files read · 12 s · about 1¢",
    reasons: [
      { id: "theme", text: "Repair is one of your most frequent themes" },
      {
        id: "profile",
        text: "You like essays that turn a familiar idea over",
        profileLine: "Prefers essays that argue against the obvious reading.",
      },
      { id: "recent", text: "You linked Golden joinery twice in October" },
    ],
    refined: {
      asked: "Narrower: one object, one afternoon",
      title: "Write the repair of one thing, with the clock running",
      draftTitle: "One repair, timed",
      snippet:
        "Pick a single repair you made and account for every hour it took.",
      hunch:
        "Instead of an argument about cost, a record of it: one repair, the hours written in the margin. The cost becomes the essay's evidence rather than its thesis.",
    },
  },
  {
    id: "kintsugi-draft-home",
    draftTitle: "Kintsugi and gold",
    kind: "Stalled draft",
    title: "“Kintsugi and gold” already told you where it belongs",
    snippet: "The draft says it isn't sure which essay it's for. It may be the ending of one.",
    age: 0,
    observed: [
      "Kintsugi and gold hasn't changed since 12 October and ends at its second section.",
      "It says outright that its key sentence belongs in Repair is a kind of attention or On craft and repair.",
      "Repair is a kind of attention has no ending; it stops at a list of links.",
    ],
    hunch:
      "It isn't a third essay. The bowl paragraph is the missing ending of Repair is a kind of attention, which is currently a draft without a last turn.",
    clips: [clip.kintsugiDraft, clip.repair],
    steps: [
      { did: "Listed drafts untouched for 2 weeks", found: "3 drafts" },
      { did: "Read Kintsugi and gold", found: "names two possible homes" },
      { did: "Compared the endings of both candidates" },
    ],
    footprint: "3 searches · 3 files read · 7 s · under 1¢",
    reasons: [
      { id: "stalled", text: "Drafts unchanged for 2+ weeks" },
      { id: "self", text: "The draft asks the question itself" },
    ],
  },
  {
    id: "quiet-web-residue",
    draftTitle: "A website that leaves no residue",
    kind: "Connection",
    title: "The quiet web is your attention note, wearing a website",
    snippet: "A quiet site might be one that leaves no residue.",
    age: 0,
    observed: [
      "The quiet web (draft) and Attention has a cost (published) both lean on Why we sleep.",
      "You saved 3 clips tagged attention between 26 and 28 October.",
      "The draft argues sites should deserve attention; the note says attention's cost is residue.",
    ],
    hunch:
      "Put the two together and the draft gets its definition: a quiet website is one you leave without residue. That's a test a reader can apply, not just a mood.",
    clips: [clip.quietWebDraft, clip.attention, clip.quietWebClip],
    steps: [
      { did: "Found clips linked from more than one document", found: "4 clips" },
      { did: "Read The quiet web and Attention has a cost" },
      { did: "Checked whether either uses the other's key word", found: "neither does" },
    ],
    footprint: "4 searches · 3 files read · 9 s · about 1¢",
    reasons: [
      { id: "shared", text: "Two pieces lean on the same clip" },
      {
        id: "profile",
        text: "You write about attention",
        profileLine: "Writes about tools, craft and attention.",
      },
    ],
  },
  {
    id: "rest-or-closure",
    draftTitle: "Rest, or fewer open loops",
    kind: "Tension",
    title: "Two of your saves disagree about what rest is for",
    snippet: "One says sleep. Your own note says fewer open loops.",
    age: 0,
    observed: [
      "Why we sleep (saved 26 October) treats rest as the base attention is built on.",
      "Your phone note two days later says the problem isn't time but unfinished thoughts.",
      "Attention has a cost cites the first and not the second.",
    ],
    hunch:
      "Your note is the more interesting position, and your published piece sides with the article. There's a short post in choosing between them.",
    clips: [clip.sleep, clip.openLoops, clip.attention],
    steps: [
      { did: "Compared clips saved within a week on the same tag", found: "2 pairs" },
      { did: "Read both, and the note that cites one of them" },
    ],
    footprint: "2 searches · 3 files read · 5 s · under 1¢",
    reasons: [
      { id: "tension", text: "Two clips on one tag point different ways" },
      { id: "own", text: "One side is your own note" },
    ],
  },
  {
    id: "noticing-before-naming",
    draftTitle: "Before the sentence",
    kind: "Gap",
    title: "Three things you kept before you had a sentence for them",
    snippet: "A kitchen wall, rain on glass, and your rule of one sentence before the door.",
    age: 0,
    observed: [
      "Window light has no title, only “Not a metaphor yet.”",
      "Morning pages says the photo came before the sentence.",
      "Field notes sets a rule of one sentence per walk.",
    ],
    hunch:
      "These share a method more than a subject: you keep the thing first and wait for the sentence. That method might be the post.",
    clips: [clip.windowLight, clip.morningPages, clip.rain, clip.fieldNotes],
    steps: [
      { did: "Looked for clips with no title or note", found: "1" },
      { did: "Searched your writing for the clip's name", found: "Morning pages" },
      { did: "Searched for similar language", found: "Field notes, rain film" },
    ],
    footprint: "5 searches · 4 files read · 10 s · about 1¢",
    reasons: [
      { id: "untitled", text: "A recent clip has no words yet" },
      {
        id: "profile",
        text: "You like short, observed posts",
        profileLine: "Enjoys short field-note posts more than long essays.",
      },
    ],
  },
  {
    id: "keep-the-words",
    draftTitle: "Keep the words, not the link",
    kind: "Connection",
    title: "A deleted post made your case for keeping the words",
    snippet: "Your note on it is one sentence from an argument about links.",
    age: 3,
    observed: [
      "A post that vanished couldn't be fetched; only your note survives.",
      "Your note says a capture isn't a promise the source will stay put.",
    ],
    hunch:
      "There's a short post in this: why you keep the quoted words and not only the link. You already have the example.",
    clips: [clip.vanished, clip.quietWebClip],
    steps: [
      { did: "Listed clips whose source failed", found: "1" },
      { did: "Read your note on it" },
    ],
    footprint: "1 search · 2 files read · 4 s · under 1¢",
    reasons: [{ id: "own", text: "Your own note states the argument" }],
  },
  {
    id: "tools-that-shape",
    draftTitle: "The workbench and the editor",
    kind: "Gap",
    title: "Six saves on tools that shape thinking, and no post yet",
    snippet: "Your craft post is about sanding. Your saves are about editors.",
    age: 6,
    observed: [
      "You've saved 6 clips tagged tools since March.",
      "On craft and repair talks about boards and joints, never software.",
      "Two of the saves are about writing tools changing what gets written.",
    ],
    hunch:
      "The workbench and the editor are the same argument. You've already written half of it, about the workbench.",
    clips: [clip.workbench, clip.outliner, clip.onCraft],
    steps: [
      { did: "Counted clips by tag since March", found: "tools: 6" },
      { did: "Searched published posts for tools", found: "0 posts" },
    ],
    footprint: "3 searches · 4 files read · 8 s · about 1¢",
    reasons: [
      { id: "count", text: "A tag with many saves and no writing" },
    ],
  },
  {
    id: "field-notes-quiet",
    draftTitle: "A looser rule for field notes",
    kind: "Stalled draft",
    title: "Field notes stopped on a Tuesday",
    snippet: "Two entries, then nothing. The rule may be the reason.",
    age: 8,
    observed: ["Field notes has entries for Monday and Tuesday only."],
    hunch:
      "One sentence before the door is a hard rule on a rainy day. A looser rule might restart the series.",
    clips: [clip.fieldNotes, clip.rain],
    steps: [{ did: "Listed series with gaps", found: "1" }],
    footprint: "1 search · 2 files read · 3 s · under 1¢",
    reasons: [{ id: "stalled", text: "Drafts unchanged for 2+ weeks" }],
  },
];

/** Existing drafts an idea can attach to instead of starting a new one. */
export const drafts = [
  {
    path: "notes/repair",
    title: "Repair is a kind of attention",
    edited: "18 Oct",
    tags: "[repair, attention]",
    excerpt:
      "We tend to think of repair as restoration: make it look as if nothing happened. But the more interesting repair makes the history legible. The patch is not hidden. The seam is not sanded away. The object becomes more itself, not less.",
  },
  {
    path: "drafts/kintsugi-and-gold",
    title: "Kintsugi and gold",
    edited: "12 Oct",
    tags: "[kintsugi, repair]",
    excerpt:
      "The first time I saw a kintsugi bowl I thought the gold was decoration. It is not. The gold is a decision: this break is part of the object now, and we are not going to pretend otherwise.",
  },
  {
    path: "posts/the-quiet-web",
    title: "The quiet web",
    edited: "28 Oct",
    tags: "[web, attention]",
    excerpt:
      "Most of the web is designed to keep you moving. The quiet web does the opposite: it gives you a place to stop.",
  },
];

/** Days before an unused idea fades out of the list. */
export const FADE_DAYS = 7;

/** 1 when new; thinning over the last few days of the week. */
export function freshness(age: number): number {
  if (age < 3) return 1;
  if (age >= FADE_DAYS) return 0;
  return 1 - ((age - 2) / (FADE_DAYS - 2)) * 0.55;
}

export function ageLabel(age: number): string {
  if (age === 0) return "Today";
  if (age === 1) return "Yesterday";
  if (age >= FADE_DAYS) return `Faded`;
  const left = FADE_DAYS - age;
  return age >= 5 ? `Fades in ${left} day${left === 1 ? "" : "s"}` : `${age} days ago`;
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[“”"'’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48)
    .replace(/-$/, "");
}

/** What Adopt writes: the idea lives in frontmatter, never in the body.
 *  `ideas` is a list so a draft can carry more than one adopted idea. */
export function frontmatter(idea: Idea, title: string, attachTo?: string): string {
  const q = (s: string) => JSON.stringify(s);
  const existing = drafts.find((d) => d.path === attachTo);
  return [
    "---",
    `title: ${q(title)}`,
    "status: draft",
    ...(existing ? [`tags: ${existing.tags}`] : []),
    "ideas:",
    `  - id: ${idea.id}`,
    "    from: kin",
    "    offered: 2026-11-01",
    `    hunch: ${q(idea.hunch)}`,
    "    clips:",
    ...clipsFor(idea, attachTo).map((c) => `      - "[[${c.path}]]"`),
    "---",
  ].join("\n");
}

/** Clips beside a draft: one per source, and never the draft itself. */
export function clipsFor(idea: Idea, attachTo?: string): ClipRef[] {
  return unique(idea.clips).filter((c) => c.path !== attachTo);
}

export function unique(clips: ClipRef[]): ClipRef[] {
  const seen = new Set<string>();
  return clips.filter((c) => !seen.has(c.path) && seen.add(c.path));
}
