// Pure helpers for the Feed view, kept free of React and Tauri so they run
// under plain `node --test`.
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
