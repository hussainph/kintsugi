/** PDF: a piece as Typst source, which the backend typesets with the fonts
 *  bundled in the app (Libertinus Serif, DejaVu Sans Mono) and writes as a
 *  PDF. Every piece of the writer's text enters Typst as a string literal
 *  (`#"…"`), never as markup, so nothing he wrote can be read as Typst. */

import { ASSET, longDate, type Piece, type RenderContext, type Rendered } from "./export.ts";
import { smartQuotes, type Block, type Inline } from "./markdown.ts";
import type { Check } from "./publish.ts";

/** A Typst string literal. */
export const str = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "").replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`;
const safeHref = (href: string) => /^(https?:|mailto:)/i.test(href);
const assetPath = (src: string) => `/assets/${src.slice(ASSET.length)}`;

const PREAMBLE = `#set page(paper: "a4", margin: (x: 2.6cm, top: 2.6cm, bottom: 2.8cm), numbering: "1", number-align: center)
#set text(font: "Libertinus Serif", size: 11.5pt, lang: "en", hyphenate: true)
#set par(justify: true, leading: 0.72em, spacing: 1.25em)
#show raw: set text(font: "DejaVu Sans Mono", size: 0.84em)
#show heading: set text(weight: "semibold")
#show heading.where(level: 1): set text(size: 1.45em)
#show heading.where(level: 2): set text(size: 1.25em)
#show heading.where(level: 3): set text(size: 1.08em)
#show heading: set block(above: 1.8em, below: 0.9em)
#show link: set text(fill: rgb("#7a5418"))
#show link: underline.with(stroke: 0.4pt + rgb("#c9a45c"), offset: 2pt)
#show quote.where(block: true): set block(inset: (left: 1.2em), stroke: (left: 0.6pt + luma(190)))
#show quote.where(block: true): set text(fill: luma(70))
#set quote(block: true)
#set figure(supplement: "Fig.", gap: 0.8em)
#show figure.caption: set text(size: 0.88em, fill: luma(80))
#set table(stroke: 0.4pt + luma(200), inset: 6pt)
#let callout(label, body) = block(width: 100%, inset: 10pt, radius: 4pt, stroke: 0.5pt + luma(190), fill: luma(248))[#text(size: 0.8em, weight: "semibold", tracking: 0.04em, fill: luma(90), upper(label)) #v(0.2em, weak: true) #body]
#let codeblock(label, code) = block(width: 100%, inset: 9pt, radius: 4pt, fill: luma(246), breakable: true)[#if label != "" { text(size: 0.75em, fill: luma(110), font: "DejaVu Sans Mono", label); v(0.1em) } #code]
#let fig(path, alt, caption) = figure(layout(size => { let natural = measure(image(path)).width; image(path, alt: alt, width: calc.min(natural, size.width)) }), caption: caption)
`;

export function renderTypst(piece: Piece, _context: RenderContext): Rendered {
  const checks: Check[] = [];
  let remote = 0;

  const inline = (content: readonly Inline[]): string => content.map((i) => {
    switch (i.t) {
      case "text": return `#${str(smartQuotes(i.v))}`;
      case "em": return `#emph[${inline(i.c)}]`;
      case "strong": return `#strong[${inline(i.c)}]`;
      case "del": return `#strike[${inline(i.c)}]`;
      case "code": return `#raw(${str(i.v)})`;
      case "br": return "#linebreak()";
      case "link": return safeHref(i.href) ? `#link(${str(i.href)})[${inline(i.c)}]` : inline(i.c);
      case "image":
        if (i.src.startsWith(ASSET)) return `#box(height: 1.1em, image(${str(assetPath(i.src))}, alt: ${str(i.alt)}))`;
        remote++;
        return i.alt ? `#emph[#${str(i.alt)}]` : "";
    }
  }).join("");

  const blocks = (content: readonly Block[]): string => content.map(block).join("\n\n");
  const block = (b: Block): string => {
    switch (b.t) {
      case "p": return inline(b.c);
      case "h": return `#heading(level: ${Math.min(b.level, 6)})[${inline(b.c)}]`;
      case "quote": return `#quote[${blocks(b.c)}]`;
      case "callout": return `#callout(${str(b.kind)})[${blocks(b.c)}]`;
      case "list": {
        const tight = b.items.every((item) => item.c.length <= 1);
        const items = b.items.map((item) => {
          const box = item.task === null ? "" : `#${str(item.task ? "☑ " : "☐ ")}`;
          return `[${box}${blocks(item.c)}]`;
        });
        return b.ordered
          ? `#enum(tight: ${tight}, start: ${b.start}, ${items.join(", ")})`
          : `#list(tight: ${tight}, ${items.join(", ")})`;
      }
      case "code": return `#codeblock(${str(b.title ?? b.lang)}, raw(block: true, lang: ${b.lang ? str(b.lang) : "none"}, ${str(b.v)}))`;
      case "hr": return `#align(center, line(length: 30%, stroke: 0.5pt + luma(170)))`;
      case "figure":
        if (b.src.startsWith(ASSET)) return `#fig(${str(assetPath(b.src))}, ${str(b.alt)}, ${b.caption ? `[#${str(b.caption)}]` : "none"})`;
        remote++;
        return b.alt ? `#align(center, emph[#${str(`[${b.alt}]`)}])` : "";
      case "table": {
        const columns = Math.max(b.head.length, ...b.rows.map((r) => r.length));
        const align = Array.from({ length: columns }, (_, n) => b.align[n] ?? "left").join(", ");
        const cell = (c: Inline[] | undefined) => `[${c ? inline(c) : ""}]`;
        const head = b.head.length ? `table.header(${Array.from({ length: columns }, (_, n) => `[#strong[${b.head[n] ? inline(b.head[n]) : ""}]]`).join(", ")}), ` : "";
        const body = b.rows.flatMap((r) => Array.from({ length: columns }, (_, n) => cell(r[n]))).join(", ");
        return `#table(columns: ${columns}, align: (${align}${columns === 1 ? "," : ""}), ${head}${body})`;
      }
    }
  };

  const meta = [longDate(piece.date), piece.url?.replace(/^https?:\/\//, "").replace(/\/$/, "")].filter(Boolean).join("  ·  ");
  const out: string[] = [
    `#set document(title: ${str(piece.title ?? "")})`,
    PREAMBLE,
  ];
  if (piece.title) out.push(`#block(below: 0.6em, text(size: 2em, weight: "semibold", hyphenate: false, [#${str(piece.title)}]))`);
  out.push(`#block(below: 2.2em, text(size: 0.85em, fill: luma(100), [#${str(meta)}]))`);
  out.push(blocks(piece.blocks));
  if (piece.appendix) {
    out.push(`#heading(level: 2)[#${str("Sources")}]`);
    out.push(`#list(tight: true, ${piece.appendix.map((s) => {
      const title = s.url ? `#link(${str(s.url)})[#${str(s.title)}]` : `#${str(s.title)}`;
      return `[${title}${s.by ? `#${str(`, ${s.by}`)}` : ""}]`;
    }).join(", ")})`);
  }
  if (piece.statement) {
    out.push(`#v(1.6em)\n#line(length: 100%, stroke: 0.4pt + luma(200))\n#text(style: "italic", fill: luma(80), [#${str(piece.statement)}])`);
  }
  if (remote) checks.push({ level: "warning", message: `The PDF leaves out ${remote === 1 ? "an image" : `${remote} images`} from other sites (it shows the description instead).` });
  return { content: out.join("\n\n") + "\n", checks };
}
