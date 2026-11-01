/** LinkedIn-ready text: no Markdown syntax at all. Paragraphs are separated
 *  by a blank line (LinkedIn keeps line breaks), links are spelled out after
 *  their words because LinkedIn only links bare URLs, lists use • and 1.,
 *  and images are left for the writer to attach. */

import type { Piece, RenderContext, Rendered } from "./export.ts";
import { plain, type Block, type Inline } from "./markdown.ts";
import type { Check } from "./publish.ts";

/** LinkedIn's limit for a post. */
export const LINKEDIN_LIMIT = 3000;
/** Roughly what LinkedIn shows before "…see more". */
export const LINKEDIN_FOLD = 210;

const bare = (href: string) => href.replace(/^mailto:/i, "");
const sameAsLabel = (label: string, href: string) => {
  const norm = (s: string) => s.trim().replace(/^(https?:\/\/)?(www\.)?/i, "").replace(/\/$/, "").toLowerCase();
  return norm(label) === norm(bare(href));
};

function inline(content: readonly Inline[], images: { count: number }): string {
  return content.map((i) => {
    switch (i.t) {
      case "text":
      case "code": return i.v;
      case "br": return "\n";
      case "em":
      case "strong":
      case "del": return inline(i.c, images);
      case "link": {
        const label = inline(i.c, images);
        if (!/^(https?:|mailto:)/i.test(i.href)) return label;
        return sameAsLabel(label, i.href) ? bare(i.href) : `${label} (${bare(i.href)})`;
      }
      case "image":
        images.count++;
        return i.alt;
    }
  }).join("");
}

function blocks(content: readonly Block[], images: { count: number }, depth = 0): string[] {
  const out: string[] = [];
  for (const b of content) {
    switch (b.t) {
      case "p": out.push(inline(b.c, images)); break;
      case "h": out.push(inline(b.c, images)); break;
      case "quote": {
        const inner = blocks(b.c, images, depth).join("\n\n");
        out.push(`“${inner}”`);
        break;
      }
      case "callout": {
        const label = b.kind[0].toUpperCase() + b.kind.slice(1);
        out.push(`${label}: ${blocks(b.c, images, depth).join("\n\n")}`);
        break;
      }
      case "list": {
        const pad = "   ".repeat(depth);
        const lines = b.items.map((item, n) => {
          const marker = item.task !== null ? (item.task ? "☑" : "☐") : b.ordered ? `${b.start + n}.` : depth ? "◦" : "•";
          const [first, ...rest] = item.c;
          const head = first?.t === "p" ? inline(first.c, images) : first ? blocks([first], images, depth + 1).join("\n") : "";
          const tail = (first?.t === "p" ? rest : []).flatMap((child) => child.t === "list" ? blocks([child], images, depth + 1) : blocks([child], images, depth + 1).map((t) => `${pad}   ${t}`));
          return [`${pad}${marker} ${head}`, ...tail].join("\n");
        });
        out.push(lines.join("\n"));
        break;
      }
      case "code": out.push(b.v); break;
      case "hr": out.push("—"); break;
      case "figure":
        images.count++;
        if (b.caption || b.alt) out.push(`[${b.caption ?? b.alt}]`);
        break;
      case "table": {
        const row = (cells: Inline[][]) => cells.map((c) => plain(c)).join(" · ");
        out.push([...(b.head.length ? [row(b.head)] : []), ...b.rows.map(row)].join("\n"));
        break;
      }
    }
  }
  return out.filter((t) => t.trim());
}

export function renderText(piece: Piece, _context: RenderContext): Rendered {
  const checks: Check[] = [];
  const images = { count: 0 };
  const parts: string[] = [];
  if (piece.title) parts.push(piece.title);
  parts.push(...blocks(piece.blocks, images));
  if (piece.appendix) {
    parts.push(["Sources", ...piece.appendix.map((s) => `• ${s.title}${s.by ? `, ${s.by}` : ""}${s.url ? ` (${s.url})` : ""}`)].join("\n"));
  }
  if (piece.statement) parts.push(piece.statement);
  const content = parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";

  const length = [...content.trim()].length;
  if (length > LINKEDIN_LIMIT) {
    checks.push({ level: "warning", message: `${length.toLocaleString("en")} characters: LinkedIn posts stop at ${LINKEDIN_LIMIT.toLocaleString("en")}. Trim it, or post it as an article.` });
  }
  if (images.count) checks.push({ level: "note", message: `${images.count === 1 ? "An image isn't" : `${images.count} images aren't`} in the text; attach ${images.count === 1 ? "it" : "them"} in LinkedIn.` });
  return { content, checks };
}
