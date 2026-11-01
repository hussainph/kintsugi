// KI-21 fixtures: real clip files written by the vault crate from real ingest
// captures (see capture/), plus what a writer adds by hand: a highlighted
// passage, a thread of short dated notes, tags. Pure: no Vite, no DOM, so the
// node tests read the same files from disk.

export type ContentType =
  | "article"
  | "x-thread"
  | "youtube"
  | "podcast"
  | "paper"
  | "hn-thread"
  | "reddit"
  | "screenshot"
  | "note";

export const contentTypes: ContentType[] = [
  "article",
  "x-thread",
  "youtube",
  "podcast",
  "paper",
  "hn-thread",
  "reddit",
  "screenshot",
  "note",
];

export interface Note {
  /** Local time, `YYYY-MM-DDTHH:MM`, like `captured`. */
  at: string;
  text: string;
}

/** What a clip file on disk says, parsed the way the vault crate reads it. */
export interface ClipFile {
  path: string;
  fields: Record<string, string>;
  /** Own text: above the source boundary. */
  own: string;
  /** Extracted source Markdown, without the `## Source` heading. */
  source: string;
}

export interface Annotation {
  type: ContentType;
  label: string;
  /** Vault-relative clip path, as captured. */
  path: string;
  /**
   * Stand-in for enrichment's one sentence. Headless captures read no AI
   * credentials, so these were written by hand for the study. Still shown as
   * machine-made, because in the product they would be.
   */
  summary: string | null;
  tags: string[];
  /** Verbatim passages from the source (tested), the first is the card's. */
  highlights: string[];
  /** The writer's notes, oldest first. */
  thread: Note[];
  /** What the real pipeline did with this source: a Lab-only aside. */
  capture: { pipeline: string; kept: string; lost: string[] };
}

export interface Passage {
  text: string;
  /** Where the passage lives at the source: a timestamp, text fragment or post. */
  href: string | null;
  /** "14:48", "passage", "post", … */
  anchor: string;
  /** False when no deeper link than the page itself exists. */
  deep: boolean;
  /** Who said it, when that isn't the clip's author (a Reddit commenter). */
  who?: string;
}

export interface Clip extends Annotation {
  file: ClipFile;
  kind: string;
  title: string | null;
  url: string | null;
  site: string | null;
  author: string | null;
  captured: string;
  image: string | null;
  passages: Passage[];
  sourceChars: number;
}

const MARKER = "<!-- kintsugi:source -->";

export function parseClipFile(path: string, raw: string): ClipFile {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (!match) throw new Error(`${path}: no frontmatter`);
  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const pair = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (!pair) continue;
    const value = pair[2].trim();
    fields[pair[1]] = value.startsWith('"') ? JSON.parse(value) : value;
  }
  const body = raw.slice(match[0].length);
  const at = body.indexOf(MARKER);
  const own = (at < 0 ? body : body.slice(0, at)).trim();
  const source = (at < 0 ? "" : body.slice(at + MARKER.length))
    .replace(/^\s*## Source\s*\n/, "")
    .trim();
  return { path, fields, own, source };
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/** Paragraphs of the source, as a reader (or a passage search) sees them. */
export function paragraphs(source: string): string[] {
  return source.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
}

const TIMESTAMP = /^\[(\d+(?::\d\d)+)\]\(<([^>]+)>\)\s*/;

/**
 * A passage's deepest honest link. Transcripts link each paragraph to its
 * moment; web text gets a text fragment; posts link to the post. PDFs, HN
 * and Reddit lose their anchors in extraction, so they link to the page.
 */
export function locate(clip: Pick<Clip, "type" | "url" | "file">, text: string): Passage {
  const wanted = squash(text);
  const all = paragraphs(clip.file.source);
  const at = all.findIndex((p) => squash(unescape(p)).includes(wanted));
  if (at < 0) throw new Error(`${clip.file.path}: passage not in source: ${text.slice(0, 60)}`);
  const paragraph = all[at];
  if (clip.type === "reddit") {
    // Comments are headed "**u/name** · N points"; HN's extraction has no such heading.
    const head = all.slice(0, at).reverse().find((p) => /^(> )*\*\*u\/[^*]+\*\*/.test(p));
    const who = head && /\*\*(u\/[^*]+)\*\*/.exec(head)?.[1];
    return { text, href: clip.url, anchor: "page", deep: false, ...(who ? { who } : {}) };
  }
  const stamp = TIMESTAMP.exec(paragraph);
  if (stamp) return { text, href: stamp[2], anchor: stamp[1], deep: true };
  if (!clip.url) return { text, href: null, anchor: "own words", deep: false };
  if (clip.type === "x-thread") return { text, href: clip.url, anchor: "post", deep: true };
  if (clip.type === "article") {
    const words = wanted.split(" ");
    const start = words.slice(0, 4).join(" ");
    const end = words.slice(-3).join(" ");
    // Text fragments reserve "-", "," and "&" as syntax.
    const encode = (part: string) => encodeURIComponent(part).replace(/-/g, "%2D");
    const fragment = `#:~:text=${encode(start)},${encode(end)}`;
    return { text, href: clip.url + fragment, anchor: "passage", deep: true };
  }
  return { text, href: clip.url, anchor: "page", deep: false };
}

/** Markdown escapes the ingest engine adds (`\[`, `\*`, …) don't count as text. */
export function unescape(markdown: string): string {
  return markdown
    .replace(TIMESTAMP, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/<br>/g, " ")
    .replace(/\\([[\]<>*`|\\])/g, "$1");
}

export function assemble(file: ClipFile, note: Annotation, image: string | null): Clip {
  const f = file.fields;
  const base = {
    ...note,
    file,
    kind: f.kind,
    title: f.title ?? null,
    url: f.url ?? null,
    site: f.site ?? null,
    author: f.author ?? null,
    captured: f.captured,
    image,
    sourceChars: [...file.source].length,
  };
  return {
    ...base,
    passages: note.highlights.map((text) => locate({ ...base, type: note.type }, text)),
  };
}

/** "2026-10-30T08:12" → "30 Oct", or "30 Oct 2025" outside the current year. */
export function shortDate(at: string, year = "2026"): string {
  const [date] = at.split("T");
  const [y, m, d] = date.split("-");
  const month = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ")[Number(m) - 1];
  return `${Number(d)} ${month}${y === year ? "" : ` ${y}`}`;
}

export function displayTitle(clip: Clip): string {
  if (clip.title) return clip.title.replace(/ \| Hacker News$/, "");
  const line = clip.file.own.split("\n")[0];
  if (!line) return clip.label;
  return line.length > 60 ? `${line.slice(0, 60).replace(/\s+\S*$/, "")}…` : line;
}

export function byline(clip: Clip): string {
  const host = clip.url ? new URL(clip.url).hostname.replace(/^www\./, "") : null;
  // Papers list every author; a card names the first.
  const author = clip.author?.replace(/(,| and ).*$/, " et al.");
  return [author, clip.site ?? host].filter(Boolean).join(" · ") || clip.label;
}

export const annotations: Annotation[] = [
  {
    type: "article",
    label: "Article",
    path: "inspiration/paulgraham-com-words-html.md",
    summary:
      "Writing an idea down is the test that shows it was incomplete, so someone who never writes has no fully formed ideas about anything nontrivial.",
    tags: ["writing", "thinking", "essays"],
    highlights: [
      "Half the ideas that end up in an essay will be ones you thought of while you were writing it.",
      "You have to pretend to be a neutral reader who knows nothing of what's in your head, only what you wrote.",
      "If you're lazy, of course, writing and talking are equally useless. But if you want to push yourself to get things right, writing is the steeper hill.",
    ],
    thread: [
      { at: "2026-10-30T08:20", text: "The stranger is the useful part, not the provocation." },
      {
        at: "2026-10-30T21:05",
        text: "He's describing what the margin should do: read the draft as someone who only knows what's on the page.",
      },
      { at: "2026-10-31T21:40", text: "Pairs with McEnerney: both say the writing is the thinking. PG stops at clarity, Larry goes on to value." },
    ],
    capture: {
      pipeline: "web · Readability (dom_smoothie)",
      kept: "The whole essay, 6,623 characters.",
      lost: [
        "The title GIF arrives as an image link in the first line.",
        "Footnote markers split across lines (“[” and “1]” on separate lines), and one paragraph breaks mid-sentence where the page has a <br>.",
        "No author: the page declares none.",
      ],
    },
  },
  {
    type: "x-thread",
    label: "X post",
    path: "inspiration/x-com-karpathy-status-2039805659525644595.md",
    summary:
      "Karpathy describes compiling raw sources into an LLM-maintained Markdown wiki in Obsidian that he queries, lints and rarely edits himself.",
    tags: ["llm", "knowledge-bases", "obsidian"],
    highlights: [
      "Important to note that the LLM writes and maintains all of the data of the wiki, I rarely touch it directly.",
      "So my own explorations and queries always \"add up\" in the knowledge base.",
      "You rarely ever write or edit the wiki manually, it's the domain of the LLM.",
    ],
    thread: [
      { at: "2026-10-30T22:45", text: "This is exactly what Kin is not. Saving it as the thing to argue with." },
      {
        at: "2026-10-31T08:10",
        text: "But \"add up\" is right. Queries should leave something behind. For me that's a draft, not a wiki page.",
      },
    ],
    capture: {
      pipeline: "x · FxTwitter thread API",
      kept: "The whole long post, 3,446 characters, plus likes, reposts and views.",
      lost: ["Nothing material. X long posts arrive as one post; the title is its first line."],
    },
  },
  {
    type: "youtube",
    label: "YouTube",
    path: "inspiration/www-youtube-com-watch.md",
    summary:
      "McEnerney argues academic writing fails not for lack of clarity but for lack of value, and value lives in a specific community of readers.",
    tags: ["writing", "readers", "talks"],
    highlights: [
      "If it's clear and useless, it's useless.",
      "Value lies in readers, right, not in the thing.",
      "you are using your writing to help yourself think. If you don't do this, for most people, you cannot think at the level you need to think.",
    ],
    thread: [
      { at: "2026-10-28T19:40", text: "14:48. The whole talk in one line." },
      {
        at: "2026-10-28T19:52",
        text: "Who is the community for the blog? I keep writing for \"readers\" in general, which is his standardized-test reader.",
      },
      {
        at: "2026-10-29T07:15",
        text: "The bit about the code words is around 30 minutes in. Worth the rewatch before the next post.",
      },
    ],
    capture: {
      pipeline: "youtube · yt-dlp manual subtitles, chapters as headings",
      kept: "18:56 of an 81:51 talk: the clip stores 20,000 of the 80,100 transcript characters.",
      lost: [
        "Everything after 19 minutes, including the part the 29 Oct note points to.",
        "The cut lands mid-sentence (\"It laid out why their work was\").",
      ],
    },
  },
  {
    type: "podcast",
    label: "Podcast",
    path: "inspiration/op3-dev-e-https-dts-podtrac-com-redirect-mp3-www-buzzsprout-com-231452-e.md",
    summary:
      "Buzzsprout's hosts launch a podcast starter kit and argue it's better to start a few shows and drop the ones that don't stick than to plan a perfect one.",
    tags: ["starting", "publishing", "podcasts"],
    highlights: [
      "a lot of people start podcasts and don't ever upload an episode because they get hung up on the title and the description needs to be perfect",
      "And you just don't know until you start seeing things and feeling what it's going to be like",
    ],
    thread: [
      { at: "2026-10-31T07:42", text: "Mostly an ad. But 10:17 is the blog problem exactly: I polish the idea instead of publishing the post." },
    ],
    capture: {
      pipeline: "podcast · publisher transcript (Podcasting 2.0 JSON), speakers in bold",
      kept: "The whole 12:31 episode, every paragraph linked to its moment in the audio.",
      lost: [
        "The clip's URL is the OP3/Podtrac tracking redirect: the episode has no page in the feed.",
        "Saved by audio URL, so the clip's kind is \"link\" rather than a podcast.",
      ],
    },
  },
  {
    type: "paper",
    label: "Paper (PDF)",
    path: "inspiration/www-inkandswitch-com-local-first-static-local-first-pdf.md",
    summary:
      "Ink & Switch propose seven ideals for local-first software, where the device holds the primary copy, and argue CRDTs can deliver them.",
    tags: ["local-first", "software", "ownership"],
    highlights: [
      "In local-first applications we swap these roles: we treat the copy of the data on your local device — your laptop, tablet, or phone — as the primary copy.",
      "“Old-fashioned” apps work fine without an Internet connection, but cloud apps typically don’t work while offline.",
    ],
    thread: [
      { at: "2026-10-25T16:30", text: "The founding document for how Kintsugi stores things. Plain files on the Mac are the primary copy." },
      { at: "2026-10-26T10:02", text: "Ideal 5, the long now, is the one I'd write about. Files outlive apps." },
    ],
    capture: {
      pipeline: "pdf · PDFKit helper (page text with fonts) → Markdown layout",
      kept: "Pages 1 to about 5 of 25: 19,962 characters, through ideal 2.5.",
      lost: [
        "Ideals 2.6 and 2.7, and everything after them.",
        "The two-column author block interleaves with the abstract; numbered sections fold into paragraphs (\\2.1 No Spinners…).",
        "Page numbers: a quote can't link deeper than the PDF.",
        "Saved as a link to a PDF, so its kind is \"link\", not \"document\".",
      ],
    },
  },
  {
    type: "hn-thread",
    label: "Hacker News",
    path: "inspiration/news-ycombinator-com-item.md",
    summary:
      "Hacker News discusses the local-first essay: protocols for syncing data (Dat, SOLID, CalDAV), and whether any business would want interoperability.",
    tags: ["local-first", "discussion"],
    highlights: [
      "We need a standard protocol for \"data that changes over time\".",
      "As with so many other things, a shiny new technical solution won’t change the reality that big companies are not incentivized to support interoperability.",
    ],
    thread: [
      {
        at: "2026-10-25T16:52",
        text: "josephg's comment at the top is the one. Wave/ShareJS person on what the protocol should be.",
      },
      { at: "2026-10-25T17:10", text: "The business-model replies are the counterargument to quote, if I write the local-first post." },
    ],
    capture: {
      pipeline: "web · Readability on news.ycombinator.com (no HN adapter)",
      kept: "The first ~19,600 characters of comments, in page order.",
      lost: [
        "Who wrote each comment, and who replied to whom: every comment is a three-cell table row with a spacer GIF.",
        "Comment links, so a quote links to the whole thread.",
        "The story's own link (inkandswitch.com) and the comment count.",
      ],
    },
  },
  {
    type: "reddit",
    label: "Reddit",
    path: "inspiration/www-reddit-com-r-pkms-comments-1rqzo93-does-it-seem-to-anyone-that-their.md",
    summary:
      "A r/PKMS post asks why notes scatter across tools the moment long-form writing starts; replies split between keeping stages separate and pitching apps.",
    tags: ["writing", "notes", "workflow"],
    highlights: [
      "when I first sit down to write something long (paper, thesis, article), all my ideas are scattered all over the tools.",
      "Yes. PKM and writing are very different tasks. It’s normal for there to be different stages in the production of a thing you’re making.",
    ],
    thread: [
      { at: "2026-10-29T12:05", text: "The problem statement for Kintsugi, from a stranger." },
      {
        at: "2026-10-29T12:30",
        text: "Two of the replies are thinly veiled ads for writing apps. Don't quote those as people agreeing.",
      },
    ],
    capture: {
      pipeline: "reddit · Reddit JSON adapter (listing hand-assembled from the Arctic Shift archive: Reddit 403s this network)",
      kept: "Post and all 5 visible comments, with authors, points and the one nested reply.",
      lost: ["Comment permalinks: quotes link to the post.", "The two comments moderators removed (absent from the listing, as on Reddit)."],
    },
  },
  {
    type: "screenshot",
    label: "Image",
    path: "inspiration/image.md",
    summary: null,
    tags: ["kintsugi", "craft"],
    highlights: [],
    thread: [
      { at: "2026-10-31T10:16", text: "The seam drawn as the subject, not the bowl." },
      { at: "2026-10-31T10:20", text: "For the about page? Martin Howard, CC BY-SA 2.0 (Wikimedia Commons)." },
    ],
    capture: {
      pipeline: "web · direct image URL, shared without a link (like a screenshot)",
      kept: "The picture, 960×960 (480 in the Lab).",
      lost: [
        "Everything else: no title, no text, no source. Enrichment would have only the notes to go on.",
        "Attribution survives only because it was typed into a note.",
      ],
    },
  },
  {
    type: "note",
    label: "Note",
    path: "inspiration/kintsugi-isn-t-about-the-gold-it-s-that-someone-decided.md",
    summary: null,
    tags: ["kintsugi", "curation"],
    highlights: [],
    thread: [{ at: "2026-11-01T00:04", text: "Maybe the opening line for the post about why Inspiration is small." }],
    capture: {
      pipeline: "none · typed on the phone",
      kept: "The thought itself, as the clip's own text.",
      lost: ["Nothing to lose: the thought is the clip, and its own text."],
    },
  },
];
