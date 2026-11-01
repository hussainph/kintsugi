import assert from "node:assert/strict";
import { test } from "node:test";
import { destination, DESTINATIONS, exportName, preparePiece, render, type ExportInput } from "./export.ts";
import { LINKEDIN_LIMIT } from "./export-text.ts";
import { str } from "./export-typst.ts";
import { parseMarkdown, smartQuotes } from "./markdown.ts";
import { HUMAN_STATEMENT, planPublish } from "./publish.ts";
import type { ReferenceSource } from "./references.ts";

const sources: ReferenceSource[] = [
  { kind: "document", path: "posts/on-craft.mdx", title: "On craft and repair", status: "complete" },
  { kind: "document", path: "notes/repair.md", title: "Repair is a kind of attention", status: "draft" },
  { kind: "document", path: "hussain.ph/essays/the-sixth-attempt.md", title: "The sixth attempt", status: "published" },
  { kind: "clip", path: "inspiration/golden-joinery.md", title: "Golden joinery" },
  { kind: "clip", path: "inspiration/bare-note.md", title: "A bare note" },
];

const essay = `---
title: "On craft and repair"
status: draft
tags: [craft, writing]
---

# On craft and repair

There is a moment, *mending* a bowl, when the seam becomes **the most interesting part**.
I wrote about it in [[notes/repair]] and [[the-sixth-attempt|my sixth attempt]];
the [[inspiration/golden-joinery]] clip says it plainly.
<!-- private: tighten this -->

import Demo from "../components/Demo.astro";

<Demo color="gold">
  a live thing
</Demo>

![A mended bowl](../media/bowl.png "The seam, in gold.")

> [!TIP]
> Look for the ==gold==.%%not for anyone%%

- one, with \`code\`
- two [[inspiration/bare-note]]

\`\`\`ts title="seam.ts"
const seam = "[[not-a-link]]" // <b>
\`\`\`

A "quoted" line with a \\* star, a # hash and a $ sign, and <https://example.com/x>.
`;

const input = (extra: Partial<ExportInput> = {}): ExportInput => ({
  path: "posts/on-craft.mdx",
  text: essay,
  today: "2026-11-02",
  sources,
  published: [{ path: "hussain.ph/essays/the-sixth-attempt.md", url: "https://hussain.ph/essays/the-sixth-attempt/" }],
  clips: [
    { path: "inspiration/golden-joinery.md", title: "Golden joinery", url: "https://example.com/kintsugi", site: "Example", author: "Ana Rivera" },
    { path: "inspiration/bare-note.md", title: "A bare note", url: null, site: null, author: null },
  ],
  appendix: false,
  statement: null,
  images: { "md:../media/bowl.png": "media/bowl.png" },
  ...extra,
});
const messages = (checks: { message: string }[]) => checks.map((c) => c.message).join("\n");

test("a piece is read once: title, links, images, MDX and private notes", () => {
  const first = preparePiece(input({ images: undefined }));
  assert.deepEqual(first.imageRefs.map((r) => r.key), ["md:../media/bowl.png"]);
  assert.equal(first.imageRefs[0].candidates[0], "media/bowl.png");
  assert.equal(first.assets.length, 0);

  const piece = preparePiece(input());
  assert.equal(piece.title, "On craft and repair");
  assert.equal(piece.date, "2026-11-02");
  assert.deepEqual(piece.tags, ["craft", "writing"]);
  assert.deepEqual(piece.assets, [{ name: "image-1.png", from: "media/bowl.png" }]);
  assert.equal(piece.blocks[0].t, "p", "the title heading isn't repeated");
  const json = JSON.stringify(piece.blocks);
  assert.ok(json.includes('"href":"https://hussain.ph/essays/the-sixth-attempt/"'), "published links are absolute");
  assert.ok(json.includes('"href":"https://example.com/kintsugi"'));
  assert.ok(json.includes("Repair is a kind of attention") && !json.includes("[[notes"), "unpublished links become words");
  assert.ok(json.includes("[[not-a-link]]"), "code is untouched");
  assert.ok(!/private|Demo|a live thing|not for anyone|==/.test(json), "comments, MDX and Obsidian marks are gone");
  assert.ok(json.includes('"src":"asset:image-1.png"'));
  const checks = messages(piece.checks);
  assert.match(checks, /<Demo> is an MDX component/);
  assert.match(checks, /\[\[Repair is a kind of attention\]\] becomes plain text: not published/);
  assert.match(checks, /\[\[A bare note\]\] becomes plain text: a clip without a link/);
});

test("a missing image is a warning, not a stop; a published date and url carry over", () => {
  const text = essay.replace("status: draft", "status: complete\nurl: https://hussain.ph/essays/on-craft-and-repair/\npublished: 2026-10-30");
  const piece = preparePiece(input({ text, images: { "md:../media/bowl.png": null } }));
  assert.equal(piece.date, "2026-10-30");
  assert.equal(piece.url, "https://hussain.ph/essays/on-craft-and-repair/");
  assert.match(messages(piece.checks), /Image not found in the vault, so it's left out: \.\.\/media\/bowl\.png/);
  assert.equal(piece.assets.length, 0);
});

test("provenance: the sources appendix and the statement are shared with Publish", () => {
  const piece = preparePiece(input({ appendix: true, statement: `  ${HUMAN_STATEMENT}  ` }));
  assert.deepEqual(piece.appendix, [
    { title: "Golden joinery", url: "https://example.com/kintsugi", by: "Ana Rivera, Example" },
    { title: "A bare note", url: null, by: null },
  ]);
  assert.equal(piece.statement, HUMAN_STATEMENT);

  const plan = planPublish({ ...input({ text: essay.replace("status: draft", "status: complete") }), site: "https://hussain.ph", appendix: true, statement: "Written by a *human*." });
  assert.ok(plan.body.endsWith("## Sources\n\n- [Golden joinery](https://example.com/kintsugi), Ana Rivera, Example\n- A bare note\n\n---\n\n*Written by a \\*human\\*.*\n"));
  const none = planPublish({ ...input(), site: "https://hussain.ph", appendix: false, statement: null });
  assert.ok(!none.body.includes("---"));
});

test("LinkedIn text has no Markdown, spells out links and keeps paragraphs", () => {
  const piece = preparePiece(input({ appendix: true, statement: HUMAN_STATEMENT }));
  const { content, checks } = render(destination("linkedin")!, piece);
  assert.ok(content.startsWith("On craft and repair\n\nThere is a moment, mending a bowl, when the seam becomes the most interesting part. I wrote about it in Repair is a kind of attention and my sixth attempt (https://hussain.ph/essays/the-sixth-attempt/); the Golden joinery (https://example.com/kintsugi) clip says it plainly.\n\n"));
  assert.ok(content.includes("\n\nTip: Look for the gold.\n\n"));
  assert.ok(content.includes("\n• one, with code\n• two A bare note\n") || content.includes("• one, with code\n• two A bare note"));
  assert.ok(content.includes('const seam = "[[not-a-link]]" // <b>'));
  assert.ok(content.includes('A "quoted" line with a * star, a # hash and a $ sign, and https://example.com/x.'));
  assert.ok(content.includes("[The seam, in gold.]"));
  assert.ok(content.includes("Sources\n• Golden joinery, Ana Rivera, Example (https://example.com/kintsugi)\n• A bare note"));
  assert.ok(content.trimEnd().endsWith(HUMAN_STATEMENT));
  assert.ok(!/[*_`#]{2}|\]\(|^#+ |^> /m.test(content), "no Markdown syntax");
  assert.match(messages(checks), /An image isn't in the text; attach it in LinkedIn/);

  const long = preparePiece(input({ text: `---\ntitle: Long\n---\n\n${"word ".repeat(700)}` }));
  assert.match(messages(render(destination("linkedin")!, long).checks), new RegExp(`LinkedIn posts stop at ${LINKEDIN_LIMIT.toLocaleString("en")}`));
});

test("HTML is one file: styles inline, images embedded, no script, text escaped", () => {
  const piece = preparePiece(input({ appendix: true, statement: HUMAN_STATEMENT }));
  const { content } = render(destination("html")!, piece, { dataUrls: { "image-1.png": "data:image/png;base64,AAAA" } });
  assert.match(content, /^<!doctype html>\n<html lang="en">/);
  assert.ok(content.includes("<title>On craft and repair</title>"));
  assert.ok(content.includes("<h1>On craft and repair</h1>"));
  assert.ok(content.includes('<time datetime="2026-11-02">2 November 2026</time>'));
  assert.ok(content.includes('<a href="https://hussain.ph/essays/the-sixth-attempt/">my sixth attempt</a>'));
  assert.ok(content.includes('<img src="data:image/png;base64,AAAA" alt="A mended bowl">\n<figcaption><strong>Fig. 1</strong> The seam, in gold.</figcaption>'));
  assert.ok(content.includes('<aside class="callout callout-tip">'));
  assert.ok(content.includes('<div class="code-label">seam.ts</div>\n<pre><code class="language-ts">const seam = &quot;[[not-a-link]]&quot; // &lt;b&gt;</code></pre>'));
  assert.ok(content.includes('<section class="sources">\n<h2>Sources</h2>'));
  assert.ok(content.includes(`<p class="statement">${HUMAN_STATEMENT}</p>`));
  assert.ok(!/<script|src="(?!data:)/i.test(content), "no scripts and nothing loaded from elsewhere");
});

test("HTML never links a javascript: URL", () => {
  const piece = preparePiece(input({ text: "Click [me](javascript:alert(1)) <script>alert(1)</script>\n" }));
  const { content } = render(destination("html")!, piece);
  assert.ok(content.includes("<p>Click me alert(1)</p>"));
  assert.ok(!content.includes("javascript:"));
});

test("PDF source keeps every word in Typst string literals", () => {
  const piece = preparePiece(input({ appendix: true, statement: HUMAN_STATEMENT }));
  const { content, checks } = render(destination("pdf")!, piece);
  assert.ok(content.startsWith('#set document(title: "On craft and repair")'));
  assert.ok(content.includes('#link("https://example.com/kintsugi")[#"Golden joinery"]'));
  assert.ok(content.includes('#fig("/assets/image-1.png", "A mended bowl", [#"The seam, in gold."])'));
  assert.ok(content.includes('#callout("tip")[#"Look for the gold."]'));
  assert.ok(content.includes('#codeblock("seam.ts", raw(block: true, lang: "ts", "const seam = \\"[[not-a-link]]\\" // <b>"))'));
  assert.ok(content.includes('#"A “quoted” line with a * star, a # hash and a $ sign, and "#link("https://example.com/x")'));
  assert.ok(content.includes(`#text(style: "italic", fill: luma(80), [#"${HUMAN_STATEMENT}"])`));
  assert.equal(checks.filter((c) => /PDF leaves out/.test(c.message)).length, 0);
  assert.equal(smartQuotes(`"It's" a 'test' (“ok”) "x"`), "“It’s” a ‘test’ (“ok”) “x”");
  assert.equal(str('a\\b"c\nd'), '"a\\\\b\\"c\\nd"');

  const remote = preparePiece(input({ text: "![far](https://example.com/far.png)\n" }));
  assert.match(messages(render(destination("pdf")!, remote).checks), /The PDF leaves out an image from other sites/);
});

test("the registry: v1 destinations and file names", () => {
  assert.deepEqual(DESTINATIONS.map((d) => d.id), ["blog", "pdf", "linkedin", "html"]);
  assert.equal(destination("blog")!.render, undefined);
  const piece = preparePiece(input());
  assert.equal(exportName(piece, "pdf"), "on-craft-and-repair.pdf");
  assert.equal(exportName(preparePiece(input({ text: "Just words.\n", path: "inbox/Café notes.md" })), "html"), "cafe-notes.html");
});

test("markdown: lists, tasks, tables and nested structure", () => {
  const blocks = parseMarkdown("1. a\n2. b\n   - [x] c\n\n| x | y |\n|:-|-:|\n| 1 | 2 |\n");
  assert.equal(blocks[0].t, "list");
  assert.deepEqual(blocks[1], { t: "table", align: ["left", "right"], head: [[{ t: "text", v: "x" }], [{ t: "text", v: "y" }]], rows: [[[{ t: "text", v: "1" }], [{ t: "text", v: "2" }]]] });
});
