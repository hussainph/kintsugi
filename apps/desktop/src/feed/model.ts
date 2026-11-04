// Pure helpers for the Feed view, kept free of React and Tauri so they run
// under plain `node --test`.
import { parseMarkdown, plain, type Block, type Inline } from "@kintsugi/core/markdown";
import type { FeedItem, Impression, Source } from "./api.ts";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A short length of time: "5m", "3h", "2d". */
export function span(delta: number): string {
  if (delta < HOUR) return `${Math.max(1, Math.floor(delta / MINUTE))}m`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h`;
  return `${Math.floor(delta / DAY)}d`;
}

/** "just now", "5m", "3h", "2d", then a short date. */
export function ago(seconds: number, now = Date.now() / 1000): string {
  const delta = Math.max(0, now - seconds);
  if (delta < MINUTE) return "just now";
  if (delta < 7 * DAY) return span(delta);
  const date = new Date(seconds * 1000);
  const sameYear = date.getFullYear() === new Date(now * 1000).getFullYear();
  return date.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" });
}

export type Health = { tone: "ok" | "waiting" | "error" | "muted"; label: string };

/** One quiet line about a source: when it last worked, or why it didn't. */
export function health(source: Source, now = Date.now() / 1000): Health {
  if (source.muted) return { tone: "muted", label: "Muted" };
  if (source.lastError) {
    const retry = source.nextFetchAt > now ? ` · retrying in ${span(source.nextFetchAt - now)}` : "";
    return { tone: "error", label: `${source.lastError}${retry}` };
  }
  if (source.lastSuccessAt == null) return { tone: "waiting", label: "Not fetched yet" };
  const when = ago(source.lastSuccessAt, now);
  return { tone: "ok", label: `Updated ${/^\d/.test(when) ? `${when} ago` : when}` };
}

/** The source row reports discovery separately from ordinary feed refresh. */
export function catalogueStatus(source: Source): string {
  if (!source.catalogueEnabled) return "Off";
  if (source.catalogueState === "discovering") return "Finding older writing…";
  if (source.catalogueState === "queued") return "Waiting to fetch";
  if (source.catalogueError) return source.catalogueError;
  if (source.catalogueCount > 0) return `${source.catalogueCount} found`;
  return "Nothing found";
}

export function itemDate(item: Pick<FeedItem, "publishedAt" | "fetchedAt" | "backCatalogue">): string {
  if (item.backCatalogue && item.publishedAt == null) return "Date unknown";
  return ago(item.publishedAt ?? item.fetchedAt);
}

export const sourceName = (source: Pick<Source, "title" | "url">) => source.title || hostname(source.url) || source.url;

export function hostname(url: string | null): string | null {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, "") : null;
  } catch {
    return null;
  }
}

export const itemTitle = (item: Pick<FeedItem, "title" | "url" | "summary">) =>
  item.title || item.summary?.split("\n")[0] || hostname(item.url) || "Untitled";

/**
 * Pictures that can stand for a source in the Following list, best first:
 * a podcast's artwork, then the site's favicon, then a feed's own image
 * (a watched page's image is a social card, too wide for a logo).
 * Sources with a brand (HN, YouTube, X) and authors use their type icon,
 * so they get none. The caller falls back to that icon when all fail.
 */
export function sourceLogos(source: Pick<Source, "kind" | "url" | "siteUrl" | "image">): string[] {
  const image = webUrl(source.image);
  if (source.kind === "podcast") return image ? [image] : [];
  if (source.kind !== "feed" && source.kind !== "page") return [];
  const site = webUrl(source.siteUrl) ?? webUrl(source.url);
  const favicon = site ? `${new URL(site).origin}/favicon.ico` : null;
  return [favicon, source.kind === "feed" ? image : null].filter((url): url is string => !!url);
}

/** Only web links ever reach the opener. */
export function webUrl(value: string | null): string | null {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Markdown from the ingest engine as plain paragraphs for the reader: no
 * images, link text without URLs, no emphasis or heading markers. The text
 * is untrusted, so it is only ever rendered as text, never as HTML.
 */
export function paragraphs(markdown: string): string[] {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[ \t]*[-*+][ \t]+/gm, "• ")
    .replace(/^>\s?/gm, "")
    .replace(/(\*\*|__|\*|`)/g, "")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Collects impressions and sends them in batches: each item at most once
 * per surface per visit, with the position it was shown at.
 */
export class Impressions {
  private seen = new Set<string>();
  private pending: Impression[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private send: (batch: Impression[]) => Promise<unknown>;
  private delay: number;

  constructor(send: (batch: Impression[]) => Promise<unknown>, delay = 1500) {
    this.send = send;
    this.delay = delay;
  }

  add(impression: Impression) {
    const key = `${impression.surface}:${impression.id}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.pending.push(impression);
    this.timer ??= setTimeout(() => void this.flush(), this.delay);
  }

  async flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    const batch = this.pending.splice(0);
    if (!batch.length) return;
    try {
      await this.send(batch);
    } catch {
      // Impressions are best effort; never interrupt reading for them.
    }
  }
}

// ── Stories and layout (KI-94) ───────────────────────────────────────────

/**
 * Below this many pixels of Feed width, the magazine's two columns (picks
 * on the left, newest down the right) become For you / Newest tabs.
 */
export const MAGAZINE_MIN_WIDTH = 960;
export type Layout = "magazine" | "tabs";
export const layoutFor = (width: number): Layout => (width >= MAGAZINE_MIN_WIDTH ? "magazine" : "tabs");

type SourceRef = { title: string | null; kind: string; site: string | null };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Who covered a story, for a card or row: one or two sources by name, more
 * as a count of articles and sources (counts are articles; names are
 * sources).
 */
export function sourcesLine(sources: { title: string | null; items?: number }[]): string {
  const names = sources.map((s) => s.title || "Feed");
  if (names.length <= 2) return names.join(", ");
  return storyCount(sources);
}

/** "7 articles from 3 sources": the story page's count, which its tiles add up to. */
export function storyCount(sources: { items?: number }[]): string {
  const articles = sources.reduce((n, s) => n + (s.items ?? 1), 0);
  return `${plural(articles, "article")} from ${plural(sources.length, "source")}`;
}

/** A story's articles with each source's together, most covered first. */
export function bySource<T extends { sourceId: number }>(items: T[], sources: { id: number }[]): T[] {
  const order = new Map(sources.map((s, i) => [s.id, i]));
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => (order.get(a.item.sourceId) ?? 99) - (order.get(b.item.sourceId) ?? 99) || a.i - b.i)
    .map(({ item }) => item);
}

/**
 * Where an item comes from, as its row says it. A Hacker News item names the
 * site it links to; HN is the secondary link.
 */
export function itemSource(item: Pick<FeedItem, "sourceTitle" | "sourceKind" | "url">): { name: string; via: string | null } {
  if (item.sourceKind === "hn") return { name: hostname(item.url) ?? "Hacker News", via: "Hacker News" };
  return { name: item.sourceTitle || hostname(item.url) || "Feed", via: null };
}

/** A source's icon: its site's favicon (none for HN, YouTube, X or authors). */
export function sourceIcon(source: SourceRef): string | null {
  if (source.kind !== "feed" && source.kind !== "page" && source.kind !== "podcast") return null;
  const site = webUrl(source.site);
  return site ? `${new URL(site).origin}/favicon.ico` : null;
}

/** The letter a source's icon falls back to. */
export const sourceLetter = (title: string | null) => (title?.trim()[0] ?? "·").toUpperCase();

/** A citation chip's label: the first cited article's source, "+N" for more. */
export function citeLabel(cites: number[], items: Pick<FeedItem, "id" | "sourceTitle" | "sourceKind" | "url">[]): string | null {
  const first = items.find((i) => i.id === cites[0]);
  if (!first) return null;
  const name = itemSource(first).name.toLowerCase().replace(/^the /, "");
  return cites.length > 1 ? `${name} +${cites.length - 1}` : name;
}

/** The one line a story without Kin's summary shows under its text. */
export function summaryNote(state: string): string | null {
  switch (state) {
    case "pending":
      return "Kin is writing a summary.";
    case "failed":
      return "Couldn't write a summary, so this is the first article's text.";
    case "capped":
      return "This month's AI limit is reached, so there's no summary yet.";
    case "unavailable":
      return "Set up an AI provider in Settings for summaries.";
    default:
      return null;
  }
}

/** Sources whose items could be news: watched pages and authors' books never group. */
export const groupable = (kind: Source["kind"]) => kind !== "page" && kind !== "author";

/** An item's text for a card or row: the author's own opening, else the feed's summary. Never Kin's words. */
export function itemBlurb(item: Pick<FeedItem, "excerpt" | "summary" | "title">): string | null {
  const text = item.excerpt || item.summary;
  return text && text !== item.title ? text : null;
}

/** Kin's summary is showing (KI-105): the summary mark goes on exactly these. */
export const summarised = (story: { summary: { paragraphs: unknown[] } | null }) => !!story.summary?.paragraphs.length;

/** The summary mark's accessible name. */
export const summaryLabel = (sources: unknown[]) => `Kin’s summary of ${plural(sources.length, "source")}`;

/** A story's text for a card: Kin's first sentences, else the lead's summary. */
export function storyBlurb(story: { summary: { paragraphs: { text: string }[][] } | null; lead: Pick<FeedItem, "summary" | "excerpt"> }): string | null {
  const first = story.summary?.paragraphs[0];
  if (first?.length) return first.map((s) => s.text).join(" ");
  return story.lead.excerpt || story.lead.summary;
}

// ── The reader (KI-105) ──────────────────────────────────────────────────

/** An item's Markdown as the reader shows it: blocks, and footnotes kept apart. */
export type ReaderDocument = { blocks: Block[]; notes: { id: string; content: Inline[] }[] };

const NOTE = /^\[\^([^\]\s]+)\]:[ \t]*(.*(?:\n(?: {2,}|\t).*)*)/gm;

/**
 * Reads an item's Markdown for the reader: footnote definitions (`[^1]: …`)
 * become notes; an opening heading that repeats the title is dropped (the
 * page shows the title); a short all-italic line straight after a picture
 * is its caption. Raw HTML never survives `parseMarkdown`.
 */
export function readerDocument(markdown: string, title?: string | null): ReaderDocument {
  const notes: ReaderDocument["notes"] = [];
  const body = markdown.replace(NOTE, (_, id: string, text: string) => {
    const first = parseMarkdown(text.replace(/\n\s+/g, " "))[0];
    notes.push({ id, content: first && "c" in first && first.t !== "quote" && first.t !== "callout" ? (first.c as Inline[]) : [{ t: "text", v: text.trim() }] });
    return "";
  });
  const blocks: Block[] = [];
  for (let block of parseMarkdown(body)) {
    // The ingest writes a <figure>'s caption straight after its picture: `![alt](src)Caption`.
    if (block.t === "p" && block.c[0]?.t === "image" && block.c.length > 1 && block.c.slice(1).every((i) => i.t !== "image")) {
      const caption = plain(block.c.slice(1)).trim();
      if (caption && caption.length <= 280) block = { t: "figure", src: block.c[0].src, alt: block.c[0].alt, caption: block.c[0].title ?? caption };
    }
    const last = blocks[blocks.length - 1];
    const italic = block.t === "p" && block.c.length === 1 && block.c[0].t === "em" ? plain(block.c[0].c) : null;
    if (last?.t === "figure" && !last.caption && italic && italic.length <= 280) {
      last.caption = italic;
      continue;
    }
    blocks.push(block);
  }
  const first = blocks[0];
  if (first?.t === "h" && title && plain(first.c).trim().toLowerCase() === title.trim().toLowerCase()) blocks.shift();
  return { blocks, notes };
}

/** A footnote's marks as the ingest keeps them: `[1](#fn:1)` in the text, `[↩](#fnref:1)` after the note. */
export function footnoteLink(href: string, text: string): "ref" | "back" | null {
  if (!href.startsWith("#")) return null;
  if (/^\d{1,3}$/.test(text.trim())) return "ref";
  if (/^[↩↑⏎]\uFE0E?$/.test(text.trim())) return "back";
  return null;
}

/** A link or picture the reader may use: web URLs only, relative ones against the article's own address. */
export function readerHref(href: string, base: string | null): string | null {
  if (!href || href.startsWith("#")) return null;
  try {
    const url = base ? new URL(href, base) : new URL(href);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}
