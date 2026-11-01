/** A small, destination-neutral reading of Markdown (CommonMark + GFM, via
 *  @lezer/markdown, the parser the editor already uses). Exporters render
 *  these blocks; none of them ever re-reads Markdown syntax. */

import { GFM, parser } from "@lezer/markdown";

export type Inline =
  | { t: "text"; v: string }
  | { t: "em"; c: Inline[] }
  | { t: "strong"; c: Inline[] }
  | { t: "del"; c: Inline[] }
  | { t: "code"; v: string }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "image"; src: string; alt: string; title: string | null }
  | { t: "br" };

export type CalloutKind = "note" | "tip" | "info" | "important" | "warning" | "caution";

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "h"; level: number; c: Inline[] }
  | { t: "quote"; c: Block[] }
  | { t: "callout"; kind: CalloutKind; c: Block[] }
  | { t: "list"; ordered: boolean; start: number; items: { task: boolean | null; c: Block[] }[] }
  | { t: "code"; lang: string; title: string | null; v: string }
  | { t: "hr" }
  /** An image alone in its paragraph: a numbered figure; the title is its caption. */
  | { t: "figure"; src: string; alt: string; caption: string | null }
  | { t: "table"; align: ("left" | "center" | "right" | null)[]; head: Inline[][]; rows: Inline[][][] };

const markdown = parser.configure([GFM]);
type SyntaxNode = ReturnType<typeof markdown.parse>["topNode"];

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", mdash: "—", ndash: "–", hellip: "…", copy: "©", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
function entity(raw: string): string {
  const named = /^&([a-z]+);$/i.exec(raw)?.[1];
  if (named) return ENTITIES[named.toLowerCase()] ?? raw;
  const code = /^&#(x?)([0-9a-f]+);$/i.exec(raw);
  if (!code) return raw;
  const n = parseInt(code[2], code[1] ? 16 : 10);
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : raw;
}

const children = (node: SyntaxNode): SyntaxNode[] => {
  const out: SyntaxNode[] = [];
  for (let c = node.firstChild; c; c = c.nextSibling) out.push(c);
  return out;
};

/** Plain text between syntax nodes: soft line breaks (and the indentation or
 *  `>` that continues a line) become one space. */
const soft = (text: string) => text.replace(/[ \t]*\n[ \t>]*/g, " ");

function inlines(src: string, node: SyntaxNode, from = node.from, to = node.to): Inline[] {
  const out: Inline[] = [];
  const text = (v: string) => {
    if (!v) return;
    const last = out[out.length - 1];
    if (last?.t === "text") last.v = (last.v + v).replace(/[ \t]{2,}/g, " ");
    else out.push({ t: "text", v: v.replace(/[ \t]{2,}/g, " ") });
  };
  let at = from;
  for (const child of children(node)) {
    if (child.to <= from || child.from >= to) continue;
    text(soft(src.slice(at, child.from)));
    at = child.to;
    const inner = (open: string) => {
      const marks = children(child).filter((c) => c.name === open);
      const start = marks[0]?.to ?? child.from;
      const end = marks.length > 1 ? marks[marks.length - 1].from : child.to;
      return inlines(src, child, start, end);
    };
    switch (child.name) {
      case "Emphasis": out.push({ t: "em", c: inner("EmphasisMark") }); break;
      case "StrongEmphasis": out.push({ t: "strong", c: inner("EmphasisMark") }); break;
      case "Strikethrough": out.push({ t: "del", c: inner("StrikethroughMark") }); break;
      case "InlineCode": {
        const marks = children(child).filter((c) => c.name === "CodeMark");
        const v = src.slice(marks[0]?.to ?? child.from, marks[1]?.from ?? child.to).replace(/\n/g, " ");
        out.push({ t: "code", v: /^ .*[^ ].* $/.test(v) ? v.slice(1, -1) : v });
        break;
      }
      case "Link":
      case "Image": {
        const parts = children(child);
        const marks = parts.filter((c) => c.name === "LinkMark");
        const url = parts.find((c) => c.name === "URL");
        const title = parts.find((c) => c.name === "LinkTitle");
        const close = marks.find((m) => src.slice(m.from, m.to) === "]");
        const labelFrom = marks[0]?.to ?? child.from;
        const labelTo = close?.from ?? child.to;
        const href = url ? src.slice(url.from, url.to).replace(/^<|>$/g, "") : "";
        if (child.name === "Image") {
          out.push({ t: "image", src: href, alt: plain(inlines(src, child, labelFrom, labelTo)), title: title ? src.slice(title.from + 1, title.to - 1) : null });
        } else if (url) {
          out.push({ t: "link", href, c: inlines(src, child, labelFrom, labelTo) });
        } else {
          // A reference-style link or a bare [bracket]: its text, as typed.
          text(src.slice(child.from, child.to));
        }
        break;
      }
      case "Autolink": {
        const url = children(child).find((c) => c.name === "URL");
        const href = url ? src.slice(url.from, url.to) : src.slice(child.from + 1, child.to - 1);
        out.push({ t: "link", href: /^[^:]+@/.test(href) && !href.includes(":") ? `mailto:${href}` : href, c: [{ t: "text", v: href }] });
        break;
      }
      case "URL": {
        // GFM's bare autolinks.
        const v = src.slice(child.from, child.to);
        out.push({ t: "link", href: /^www\./i.test(v) ? `https://${v}` : v, c: [{ t: "text", v }] });
        break;
      }
      case "HardBreak": out.push({ t: "br" }); break;
      case "Escape": text(src.slice(child.from + 1, child.to)); break;
      case "Entity": text(entity(src.slice(child.from, child.to))); break;
      case "HTMLTag":
      case "Comment":
      case "QuoteMark":
      case "ProcessingInstruction":
        break;
      default:
        text(soft(src.slice(child.from, child.to)));
    }
  }
  text(soft(src.slice(at, to)));
  // Trim the paragraph's ends.
  const first = out[0];
  if (first?.t === "text") first.v = first.v.replace(/^\s+/, "");
  const last = out[out.length - 1];
  if (last?.t === "text") last.v = last.v.replace(/\s+$/, "");
  return out.filter((i) => i.t !== "text" || i.v);
}

/** The words of some inline content, without any markup. */
export function plain(content: readonly Inline[]): string {
  return content.map((i) => {
    switch (i.t) {
      case "text":
      case "code": return i.v;
      case "image": return i.alt;
      case "br": return " ";
      default: return plain(i.c);
    }
  }).join("");
}

const CALLOUT = /^\s*\[!(note|tip|info|important|warning|caution)\][ \t]*\n?/i;

function blocks(src: string, node: SyntaxNode): Block[] {
  const out: Block[] = [];
  for (const child of children(node)) {
    const name = child.name;
    const heading = /^(ATX|Setext)Heading(\d)$/.exec(name);
    if (heading) {
      const marks = children(child).filter((c) => c.name === "HeaderMark");
      const from = heading[1] === "ATX" ? marks[0]?.to ?? child.from : child.from;
      const to = heading[1] === "ATX" ? (marks.length > 1 ? marks[marks.length - 1].from : child.to) : marks[0]?.from ?? child.to;
      out.push({ t: "h", level: Number(heading[2]), c: inlines(src, child, from, to) });
    } else if (name === "Paragraph") {
      const c = inlines(src, child);
      if (c.length === 1 && c[0].t === "image") out.push({ t: "figure", src: c[0].src, alt: c[0].alt, caption: c[0].title });
      else if (c.length) out.push({ t: "p", c });
    } else if (name === "Blockquote") {
      const inner = blocks(src, child);
      const first = inner[0];
      const lead = first?.t === "p" && first.c[0]?.t === "text" ? CALLOUT.exec(first.c[0].v) : null;
      if (lead && first.t === "p" && first.c[0].t === "text") {
        first.c[0].v = first.c[0].v.slice(lead[0].length).replace(/^\s+/, "");
        if (!first.c[0].v) first.c.shift();
        out.push({ t: "callout", kind: lead[1].toLowerCase() as CalloutKind, c: inner.filter((b) => b.t !== "p" || b.c.length) });
      } else out.push({ t: "quote", c: inner });
    } else if (name === "BulletList" || name === "OrderedList") {
      const items = children(child).filter((c) => c.name === "ListItem").map((item) => {
        const task = children(item).find((c) => c.name === "Task");
        if (task) {
          const marker = children(task).find((c) => c.name === "TaskMarker");
          const done = marker ? /x/i.test(src.slice(marker.from, marker.to)) : false;
          return { task: done, c: [{ t: "p" as const, c: inlines(src, task, marker?.to ?? task.from) }, ...blocks(src, item)] };
        }
        return { task: null, c: blocks(src, item) };
      });
      const mark = children(children(child)[0] ?? child).find((c) => c.name === "ListMark");
      const start = name === "OrderedList" && mark ? parseInt(src.slice(mark.from, mark.to), 10) || 1 : 1;
      out.push({ t: "list", ordered: name === "OrderedList", start, items });
    } else if (name === "FencedCode" || name === "CodeBlock") {
      const info = children(child).find((c) => c.name === "CodeInfo");
      const text = children(child).filter((c) => c.name === "CodeText");
      const raw = text.length ? src.slice(text[0].from, text[text.length - 1].to) : "";
      const lines = raw.split("\n");
      // Indented code and code inside lists or quotes: strip the shared indent.
      const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length), Infinity);
      const v = (Number.isFinite(indent) && name === "CodeBlock" ? lines.map((l) => l.slice(indent)) : lines).join("\n").replace(/\n+$/, "");
      const infoText = info ? src.slice(info.from, info.to) : "";
      out.push({ t: "code", lang: infoText.split(/\s/)[0], title: /title="([^"]*)"/.exec(infoText)?.[1] ?? null, v });
    } else if (name === "HorizontalRule") {
      out.push({ t: "hr" });
    } else if (name === "Table") {
      const row = (r: SyntaxNode) => children(r).filter((c) => c.name === "TableCell").map((cell) => inlines(src, cell));
      const header = children(child).find((c) => c.name === "TableHeader");
      const delimiter = children(child).find((c) => c.name === "TableDelimiter" && c.from > (header?.to ?? 0));
      const align = delimiter
        ? src.slice(delimiter.from, delimiter.to).replace(/^\||\|$/g, "").split("|").map((spec) => {
          const s = spec.trim();
          return s.startsWith(":") && s.endsWith(":") ? "center" as const : s.endsWith(":") ? "right" as const : s.startsWith(":") ? "left" as const : null;
        })
        : [];
      out.push({ t: "table", align, head: header ? row(header) : [], rows: children(child).filter((c) => c.name === "TableRow").map(row) });
    }
    // HTML blocks, comments and link reference definitions are not content.
  }
  return out;
}

/** Reads Markdown into blocks. */
export function parseMarkdown(src: string): Block[] {
  return blocks(src, markdown.parse(src).topNode);
}

/** Every inline image (figures included) in reading order. */
export function walkImages(content: readonly Block[], visit: (image: { src: string; alt: string }) => void) {
  const inline = (c: readonly Inline[]) => {
    for (const i of c) {
      if (i.t === "image") visit(i);
      else if ("c" in i) inline(i.c);
    }
  };
  for (const b of content) {
    switch (b.t) {
      case "p": case "h": inline(b.c); break;
      case "figure": visit(b); break;
      case "quote": case "callout": walkImages(b.c, visit); break;
      case "list": for (const item of b.items) walkImages(item.c, visit); break;
      case "table": for (const r of [b.head, ...b.rows]) for (const cell of r) inline(cell); break;
    }
  }
}

/** Typographic quotes for typeset output: "a" → “a”, it's → it’s. Straight
 *  quotes are what a keyboard types; print and the web expect curly ones. */
export function smartQuotes(text: string): string {
  return text.replace(/["']/g, (q, at: number) => {
    const before = at === 0 ? "" : text[at - 1];
    const after = text[at + 1] ?? "";
    const opens = (before === "" || /[\s([{\u2014\u2013-]/.test(before)) && !/\s/.test(after);
    if (q === '"') return opens ? "“" : "”";
    return opens ? "‘" : "’";
  });
}
