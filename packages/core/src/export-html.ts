/** HTML: one self-contained file. Styles are inline, images are embedded as
 *  data URLs, and there is no script. It reads like the blog (a serif
 *  measure, numbered figures, callouts) in light and dark mode. */

import { ASSET, longDate, type Piece, type RenderContext, type Rendered } from "./export.ts";
import { plain, smartQuotes, type Block, type Inline } from "./markdown.ts";
import type { Check } from "./publish.ts";

export const escapeHtml = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const safeHref = (href: string) => /^(https?:|mailto:|#)/i.test(href);

const STYLE = `
:root { color-scheme: light dark; --ink: #1f1d1a; --muted: #6b665e; --rule: #e4dfd6; --wash: #f6f3ee; --gold: #8a6420; --gold-line: #d4b36c; }
@media (prefers-color-scheme: dark) { :root { --ink: #ebe7df; --muted: #a39d92; --rule: #3a3631; --wash: #26231f; --gold: #e0b866; --gold-line: #8a6a2c; } body { background: #1a1816; } }
* { box-sizing: border-box; }
body { margin: 0; color: var(--ink); font: 18px/1.65 ui-serif, "New York", Charter, "Iowan Old Style", Georgia, serif; -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
article { max-width: 36rem; margin: 0 auto; padding: 4.5rem 1.4rem 5rem; hyphens: auto; overflow-wrap: break-word; }
header { margin-bottom: 2.6rem; }
h1 { font-size: 2.1rem; line-height: 1.15; margin: 0 0 .7rem; font-weight: 600; letter-spacing: -.01em; hyphens: manual; }
.meta { font: 13px/1.5 ui-sans-serif, -apple-system, system-ui, sans-serif; color: var(--muted); margin: 0; display: flex; flex-wrap: wrap; gap: .4rem 1rem; }
h2, h3, h4, h5, h6 { line-height: 1.3; font-weight: 600; margin: 2.2em 0 .6em; hyphens: manual; }
h2 { font-size: 1.35rem; } h3 { font-size: 1.12rem; } h4, h5, h6 { font-size: 1rem; }
p, ul, ol, blockquote, figure, pre, table, aside { margin: 0 0 1.15em; }
ul, ol { padding-left: 1.4em; } li + li { margin-top: .25em; } li > ul, li > ol { margin: .25em 0 0; }
li.task { list-style: none; } li.task::marker { content: none; }
a { color: var(--gold); text-decoration: underline; text-decoration-color: var(--gold-line); text-decoration-thickness: 1px; text-underline-offset: 3px; }
code, pre { font: .84em/1.55 ui-monospace, "SF Mono", Menlo, monospace; }
:not(pre) > code { background: var(--wash); border-radius: 4px; padding: .1em .3em; }
pre { background: var(--wash); border-radius: 8px; padding: .9em 1.1em; overflow-x: auto; hyphens: none; }
.code-label { font: 12px ui-sans-serif, -apple-system, system-ui, sans-serif; color: var(--muted); margin-bottom: .4em; }
blockquote { margin-left: 0; padding-left: 1.1em; border-left: 1px solid var(--rule); color: var(--muted); }
aside.callout { border: 1px solid var(--rule); border-radius: 8px; padding: .9em 1.1em; }
aside.callout > :last-child, blockquote > :last-child, li > :last-child { margin-bottom: 0; }
.callout-label { font: 600 11px ui-sans-serif, -apple-system, system-ui, sans-serif; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); margin-bottom: .3em; }
figure { margin-left: 0; margin-right: 0; }
figure img { display: block; max-width: 100%; height: auto; margin: 0 auto; border-radius: 4px; }
img { max-width: 100%; }
figcaption { font: 14px/1.5 ui-sans-serif, -apple-system, system-ui, sans-serif; color: var(--muted); margin-top: .6em; text-align: center; }
figcaption strong { color: var(--ink); font-weight: 500; margin-right: .25em; }
.missing { display: block; padding: 1.4em; text-align: center; background: var(--wash); border-radius: 6px; color: var(--muted); font-size: .9em; }
hr { border: 0; text-align: center; margin: 2em 0; } hr::after { content: "⁂"; color: var(--muted); }
table { border-collapse: collapse; width: 100%; font-size: .9em; } th, td { border-bottom: 1px solid var(--rule); padding: .4em .6em; text-align: left; vertical-align: top; } th { font-weight: 600; }
.sources { margin-top: 3rem; }
.statement { margin-top: 3rem; padding-top: 1.2rem; border-top: 1px solid var(--rule); font-style: italic; color: var(--muted); }
@media print { body { font-size: 11.5pt; } article { padding: 0; max-width: none; } a { color: inherit; } pre, figure, aside { break-inside: avoid; } }
`;

export function renderHtml(piece: Piece, context: RenderContext): Rendered {
  const checks: Check[] = [];
  let figures = 0;
  let remote = 0;
  const src = (value: string) => {
    if (value.startsWith(ASSET)) return context.dataUrls[value.slice(ASSET.length)] ?? null;
    if (/^https?:\/\//i.test(value)) {
      remote++;
      return value;
    }
    return null;
  };

  const inline = (content: readonly Inline[]): string => content.map((i) => {
    switch (i.t) {
      case "text": return escapeHtml(smartQuotes(i.v));
      case "em": return `<em>${inline(i.c)}</em>`;
      case "strong": return `<strong>${inline(i.c)}</strong>`;
      case "del": return `<del>${inline(i.c)}</del>`;
      case "code": return `<code>${escapeHtml(i.v)}</code>`;
      case "br": return "<br>";
      case "link": return safeHref(i.href) ? `<a href="${escapeHtml(i.href)}">${inline(i.c)}</a>` : inline(i.c);
      case "image": {
        const url = src(i.src);
        return url ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(i.alt)}"${i.title ? ` title="${escapeHtml(i.title)}"` : ""}>` : escapeHtml(i.alt);
      }
    }
  }).join("");

  const blocks = (content: readonly Block[]): string => content.map(block).join("\n");
  const block = (b: Block): string => {
    switch (b.t) {
      case "p": return `<p>${inline(b.c)}</p>`;
      case "h": {
        // The title is the only h1; the body's headings sit under it.
        const level = Math.min(6, b.level + 1);
        return `<h${level}>${inline(b.c)}</h${level}>`;
      }
      case "quote": return `<blockquote>\n${blocks(b.c)}\n</blockquote>`;
      case "callout": return `<aside class="callout callout-${b.kind}">\n<div class="callout-label">${b.kind}</div>\n${blocks(b.c)}\n</aside>`;
      case "list": {
        const tag = b.ordered ? "ol" : "ul";
        const start = b.ordered && b.start !== 1 ? ` start="${b.start}"` : "";
        const items = b.items.map((item) => {
          const tight = item.c.length === 1 && item.c[0].t === "p" ? inline(item.c[0].c) : blocks(item.c);
          return item.task === null
            ? `<li>${tight}</li>`
            : `<li class="task"><input type="checkbox" disabled${item.task ? " checked" : ""}> ${tight}</li>`;
        });
        return `<${tag}${start}>\n${items.join("\n")}\n</${tag}>`;
      }
      case "code": {
        const label = b.title ?? b.lang;
        return `${label ? `<div class="code-label">${escapeHtml(label)}</div>\n` : ""}<pre><code${b.lang ? ` class="language-${escapeHtml(b.lang)}"` : ""}>${escapeHtml(b.v)}</code></pre>`;
      }
      case "hr": return "<hr>";
      case "figure": {
        const url = src(b.src);
        figures++;
        const image = url ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(b.alt)}">` : `<span class="missing">${escapeHtml(b.alt || "Image")}</span>`;
        return `<figure>\n${image}${b.caption ? `\n<figcaption><strong>Fig. ${figures}</strong> ${escapeHtml(b.caption)}</figcaption>` : ""}\n</figure>`;
      }
      case "table": {
        const align = (n: number) => (b.align[n] ? ` style="text-align: ${b.align[n]}"` : "");
        const head = b.head.length ? `<thead><tr>${b.head.map((c, n) => `<th${align(n)}>${inline(c)}</th>`).join("")}</tr></thead>\n` : "";
        const rows = b.rows.map((r) => `<tr>${r.map((c, n) => `<td${align(n)}>${inline(c)}</td>`).join("")}</tr>`).join("\n");
        return `<table>\n${head}<tbody>\n${rows}\n</tbody>\n</table>`;
      }
    }
  };

  const title = piece.title ?? piece.path.split("/").pop()!.replace(/\.mdx?$/, "");
  const meta = [
    `<time datetime="${piece.date}">${longDate(piece.date)}</time>`,
    ...(piece.url ? [`<a href="${escapeHtml(piece.url)}">${escapeHtml(piece.url.replace(/^https?:\/\//, "").replace(/\/$/, ""))}</a>`] : []),
  ];
  const body = blocks(piece.blocks);
  const sources = piece.appendix
    ? `\n<section class="sources">\n<h2>Sources</h2>\n<ul>\n${piece.appendix.map((s) => {
      const name = s.url ? `<a href="${escapeHtml(s.url)}">${escapeHtml(s.title)}</a>` : escapeHtml(s.title);
      return `<li>${name}${s.by ? `, ${escapeHtml(s.by)}` : ""}</li>`;
    }).join("\n")}\n</ul>\n</section>`
    : "";
  const statement = piece.statement ? `\n<p class="statement">${escapeHtml(piece.statement)}</p>` : "";
  const description = plain(piece.blocks.find((b) => b.t === "p")?.c ?? []).slice(0, 200);

  const content = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${description ? `<meta name="description" content="${escapeHtml(description)}">\n` : ""}<meta name="generator" content="Kintsugi">
<style>${STYLE}</style>
</head>
<body>
<article>
<header>
${piece.title ? `<h1>${escapeHtml(piece.title)}</h1>\n` : ""}<p class="meta">${meta.join("")}</p>
</header>
${body}${sources}${statement}
</article>
</body>
</html>
`;
  if (remote) checks.push({ level: "warning", message: `${remote === 1 ? "An image loads" : `${remote} images load`} from another site, so the file needs the internet to show ${remote === 1 ? "it" : "them"}.` });
  return { content, checks };
}
