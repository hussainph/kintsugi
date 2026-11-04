import { parseMarkdown, plain, type Block, type Inline } from '@kintsugi/core/markdown';
import type { FeedItem, Story } from '@kintsugi/core/sections';

/** Web destinations only, never app schemes or local resources. */
export function readerUrl(value: string, base?: string | null): string | null {
  if (!value || value.startsWith('#') || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = base ? new URL(value, base) : new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/** Ignore filename-like alt text; a real caption always takes precedence. */
export function figureCaption(caption: string | null, alt: string): string | null {
  if (caption?.trim()) return caption.trim();
  const text = alt.trim();
  if (!text || /^(image|photo|picture|figure|img|dsc)[\s_-]*\d*$/i.test(text)) return null;
  if (/^(https?:|data:|\/)|\.(png|jpe?g|gif|webp|avif|svg)(\?.*)?$/i.test(text)) return null;
  return text;
}

export type ReaderDocument = { blocks: Block[]; notes: { id: string; content: Inline[] }[] };

const NOTE = /^\[\^([^\]\s]+)\]:[ \t]*(.*(?:\n(?: {2,}|\t).*)*)/gm;

/** Match the Mac reader's treatment of ingested figures and raw footnotes. */
export function readerDocument(markdown: string, title?: string | null): ReaderDocument {
  const notes: ReaderDocument['notes'] = [];
  const body = markdown.replace(NOTE, (_, id: string, text: string) => {
    const first = parseMarkdown(text.replace(/\n\s+/g, ' '))[0];
    notes.push({ id, content: first && 'c' in first && first.t !== 'quote' && first.t !== 'callout' ? first.c as Inline[] : [{ t: 'text', v: text.trim() }] });
    return '';
  });
  const blocks: Block[] = [];
  for (let block of parseMarkdown(body)) {
    if (block.t === 'p' && block.c[0]?.t === 'image' && block.c.length > 1 && block.c.slice(1).every((i) => i.t !== 'image')) {
      const caption = plain(block.c.slice(1)).trim();
      if (caption && caption.length <= 280) block = { t: 'figure', src: block.c[0].src, alt: block.c[0].alt, caption: block.c[0].title ?? caption };
    }
    const last = blocks.at(-1);
    const italic = block.t === 'p' && block.c.length === 1 && block.c[0].t === 'em' ? plain(block.c[0].c) : null;
    if (last?.t === 'figure' && !last.caption && italic && italic.length <= 280) {
      last.caption = italic;
      continue;
    }
    blocks.push(block);
  }
  const first = blocks[0];
  if (first?.t === 'h' && title && plain(first.c).trim().toLowerCase() === title.trim().toLowerCase()) blocks.shift();
  return { blocks, notes };
}

/** Ingested footnote numbers stay superscript; return arrows are omitted. */
export function footnoteLink(href: string, text: string): 'ref' | 'back' | null {
  if (!href.startsWith('#')) return null;
  if (/^\d{1,3}$/.test(text.trim())) return 'ref';
  if (/^[↩↑⏎]\uFE0E?$/.test(text.trim())) return 'back';
  return null;
}

/** Unicode superscripts keep their baseline inside native Text spans. */
export const superscript = (text: string): string => text.replace(/\d/g, (digit) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(digit)]);

export const itemExcerpt = (item: Pick<FeedItem, 'excerpt' | 'summary'>): string | null => item.excerpt ?? item.summary;

/** Presence, rather than job state, identifies text written by Kin. */
export function summaryLabel(story?: Pick<Story, 'summary' | 'sources'>): string | undefined {
  if (story?.summary == null) return undefined;
  const count = story.sources.length;
  return `Kin's summary of ${count} ${count === 1 ? 'source' : 'sources'}`;
}
