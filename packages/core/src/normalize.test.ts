import assert from "node:assert/strict";
import { test } from "node:test";
import { preparePiece, render, DESTINATIONS, type ExportInput } from "./export.ts";
import { parseMarkdown, type Block } from "./markdown.ts";
import { normalizeMarkdown, phantomItem } from "./normalize.ts";
import { planPublish } from "./publish.ts";

/** Reads a list into [ordered, items…] recursively, for depth checks. */
function lists(blocks: readonly Block[]): string {
  return blocks.map((b) => {
    if (b.t === "list") return `${b.ordered ? "#" : "*"}[${b.items.map((i) => `{${lists(i.c)}}`).join("")}]`;
    if (b.t === "p") return b.c.map((i) => (i.t === "text" ? i.v : i.t)).join("");
    return b.t;
  }).join(" ");
}

const list = (block: Block) => {
  assert.equal(block.t, "list");
  return block as Extract<Block, { t: "list" }>;
};

test("well-nested source passes through byte for byte", () => {
  const src = "- a\n  - b\n    - c\n\n10. x\n    - y\n\n- [ ] task\n  - [x] done\n";
  assert.equal(normalizeMarkdown(src), src);
});

test("a first item Tab-indented twice gets two synthetic parents, not code", () => {
  const out = normalizeMarkdown("Intro\n\n    - a\n      - b\n");
  assert.equal(out, "Intro\n\n-\n  -\n    - a\n      - b\n");
  const blocks = parseMarkdown(out);
  assert.deepEqual(lists(blocks), "Intro *[{*[{*[{a *[{b}]}]}]}]");
  assert.equal((blocks[1] as { items: { task: boolean | null; c: Block[] }[] }).items[0].task, null);
});

test("a first item Tab-indented once gets one synthetic parent", () => {
  const out = normalizeMarkdown("Intro\n\n  - a\n    - b\n");
  assert.equal(out, "Intro\n\n-\n  - a\n    - b\n");
  assert.deepEqual(lists(parseMarkdown(out)), "Intro *[{*[{a *[{b}]}]}]");
});

test("a skip level under an existing parent fills the missing levels", () => {
  const out = normalizeMarkdown("- a\n        1. b\n");
  assert.equal(out, "- a\n\n  -\n    -\n      -\n        1. b\n");
  assert.deepEqual(lists(parseMarkdown(out)), "*[{a *[{*[{*[{#[{b}]}]}]}]}]");
});

test("a child at the parent's content column is untouched", () => {
  const src = "- a\n  1. b\n";
  assert.equal(normalizeMarkdown(src), src);
});

test("ordered padding follows the wider marker column", () => {
  const src = "10. x\n    - y\n";
  assert.equal(normalizeMarkdown(src), src);
  assert.equal(normalizeMarkdown("10. x\n      - y\n"), "10. x\n\n    -\n      - y\n");
});

test("a bare marker keeps its separating column before filling levels", () => {
  const out = normalizeMarkdown("- Parent\n      - Child\n");
  assert.equal(out, "- Parent\n\n  -\n    -\n      - Child\n");
  // Parent stays a paragraph, not a setext heading.
  assert.deepEqual(lists(parseMarkdown(out)), "*[{Parent *[{*[{*[{Child}]}]}]}]");
});

test("tabs advance the content column from the marker, not zero", () => {
  const src = "-\tParent\n    - Child\n";
  assert.equal(normalizeMarkdown(src), src);
  assert.equal(normalizeMarkdown("-\tParent\n      - Child\n"), "-\tParent\n\n    -\n      - Child\n");
});

test("a line with inline code still parents the next item", () => {
  const src = "- Parent `code`\n  - Child\n";
  assert.equal(normalizeMarkdown(src), src);
  assert.deepEqual(lists(parseMarkdown(src)), "*[{Parent code *[{Child}]}]");
});

test("a marker inside inline code or a comment is not an item", () => {
  assert.equal(normalizeMarkdown("%% - a %%\n"), "%% - a %%\n");
  assert.deepEqual(lists(parseMarkdown("%% - a %%\n")), "%% - a %%");
});

test("thematic breaks never read as markers", () => {
  assert.equal(normalizeMarkdown("- - -\n"), "- - -\n");
  assert.equal(normalizeMarkdown("***\n"), "***\n");
  assert.equal(normalizeMarkdown("    - - -\n"), "    - - -\n");
});

test("fenced code is never rewritten", () => {
  const src = "Before\n\n```text\n    - looks like a list\n      - also\n```\n\nAfter\n";
  assert.equal(normalizeMarkdown(src), src);
  const blocks = parseMarkdown(src);
  assert.equal(blocks[1].t, "code");
  assert.equal((blocks[1] as { v: string }).v, "    - looks like a list\n      - also");
});

test("frontmatter is never rewritten", () => {
  const out = normalizeMarkdown("---\ntags: [a]\n---\n\n    - a\n      - b\n");
  assert.equal(out, "---\ntags: [a]\n---\n\n-\n  -\n    - a\n      - b\n");
});

test("an MDX island and its list-looking lines are never rewritten", () => {
  const src = "<Demo>\n  - x\n</Demo>\n";
  assert.equal(normalizeMarkdown(src), src);
});

test("a module line is never rewritten", () => {
  const src = 'import X from "../x.ts"\n\n    - a\n';
  assert.equal(normalizeMarkdown(src), 'import X from "../x.ts"\n\n-\n  -\n    - a\n');
});

test("a quote's depth is kept while its items nest", () => {
  const out = normalizeMarkdown("> Intro\n>     - a\n>       - b\n");
  assert.equal(out, "> Intro\n>\n> -\n>   -\n>     - a\n>       - b\n");
  const quote = parseMarkdown(out)[0];
  assert.equal(quote.t, "quote");
  assert.deepEqual(lists((quote as { c: Block[] }).c), "Intro *[{*[{*[{a *[{b}]}]}]}]");
});

test("continuation lines keep their columns", () => {
  const out = normalizeMarkdown("- a\n  continued\n      - deep\n");
  assert.equal(out, "- a\n  continued\n\n  -\n    -\n      - deep\n");
});

test("a marker straight after a paragraph is separated before nesting", () => {
  const out = normalizeMarkdown("Intro\n    - x\n");
  assert.equal(out, "Intro\n\n-\n  -\n    - x\n");
  assert.deepEqual(lists(parseMarkdown(out)), "Intro *[{*[{*[{x}]}]}]");
});

test("a top-level held block closes the open items before an orphan", () => {
  assert.equal(
    normalizeMarkdown("- Parent\n\n```\nliteral\n```\n\n    - Orphan\n      - Deeper\n"),
    "- Parent\n\n```\nliteral\n```\n\n-\n  -\n    - Orphan\n      - Deeper\n",
  );
  assert.equal(
    normalizeMarkdown("- Parent\n\n<div>text</div>\n\n    - Orphan\n"),
    "- Parent\n\n<div>text</div>\n\n-\n  -\n    - Orphan\n",
  );
});

test("a fence inside an item keeps that item open", () => {
  const src = "- x\n  - y\n    ```js\n    c\n    ```\n    z\n";
  assert.equal(normalizeMarkdown(src), src);
});

test("a numbered line that continues plain prose stays prose", () => {
  const src = "Some intro\n  2024. The year\n";
  assert.equal(normalizeMarkdown(src), src);
  assert.deepEqual(lists(parseMarkdown(src)), "Some intro 2024. The year");
});

test("a blank-separated numbered line is a true list without wrappers", () => {
  const src = "Intro\n\n7. The year\n";
  assert.equal(normalizeMarkdown(src), src);
  assert.deepEqual(lists(parseMarkdown(src)), "Intro #[{The year}]");
});

test("normalizing is idempotent", () => {
  const kitchen = "Intro\n\n    - a\n      - b\n\n- c\n        1. d\n\n> e\n>     - f\n\n```text\n    - g\n```\n";
  const once = normalizeMarkdown(kitchen);
  assert.equal(normalizeMarkdown(once), once);
});

test("parseMarkdown reads the normalized nesting end to end", () => {
  const blocks = parseMarkdown("Intro\n\n    - a\n      - b\n");
  assert.equal(blocks[0].t, "p");
  const outer = list(blocks[1]);
  assert.equal(phantomItem(outer.items[0]), true);
  const middle = list(outer.items[0].c[0]);
  assert.equal(phantomItem(middle.items[0]), true);
  const inner = list(middle.items[0].c[0]);
  assert.equal(inner.items.length, 1);
  assert.equal(inner.items[0].c[0].t, "p");
});

const input = (text: string, extra: Partial<ExportInput> = {}): ExportInput => ({
  path: "posts/on-craft.md",
  text,
  today: "2026-11-02",
  sources: [],
  published: [],
  clips: [],
  appendix: false,
  statement: null,
  ...extra,
});

const doc = "---\ntitle: T\nstatus: complete\n---\n\nIntro\n\n    - a\n      - b\n";

test("export reads indented first items as nested lists, not code", () => {
  const piece = preparePiece(input(doc));
  assert.deepEqual(lists(piece.blocks), "Intro *[{*[{*[{a *[{b}]}]}]}]");
  assert.equal(piece.words, 3);
});

test("the HTML destination hides synthetic parents, children keep their indent", () => {
  const piece = preparePiece(input(doc));
  const html = render(DESTINATIONS.find((d) => d.id === "html")!, piece, { dataUrls: {} }).content;
  assert.ok(html.includes(`<li class="phantom">`));
  assert.ok(html.includes("<li><p>a</p>"));
  assert.ok(html.includes("<li>b</li>"));
});

test("the text destination gives synthetic parents no bullet", () => {
  const piece = preparePiece(input(doc));
  const text = render(DESTINATIONS.find((d) => d.id === "linkedin")!, piece).content;
  assert.ok(text.includes("      ◦ a"));
  assert.ok(!text.includes("•"));
});

test("the published body is CommonMark-valid nested Markdown", () => {
  const plan = planPublish({
    path: "posts/on-craft.md",
    text: doc,
    today: "2026-11-02",
    site: "https://hussain.ph",
    sources: [],
    published: [],
    clips: [],
    appendix: false,
  });
  assert.equal(plan.body, "Intro\n\n-\n  -\n    - a\n      - b\n");
  assert.ok(plan.checks.every((check) => check.level !== "error"));
});

test("deeply nested fenced list examples remain literal", () => {
  const src = "- Parent\n  - Child\n    ```md\n      - literal\n    ```\n";
  assert.equal(normalizeMarkdown(src), src);
  assert.equal(normalizeMarkdown(src.split("\n").map((line) => "> " + line).join("\n")), src.split("\n").map((line) => "> " + line).join("\n"));
  const root = list(parseMarkdown(src)[0]);
  const nested = root.items[0].c.find((block) => block.t === "list");
  assert.ok(nested?.t === "list");
  const code = nested.items[0].c.find((block) => block.t === "code");
  assert.ok(code?.t === "code");
  assert.equal(code.v.trim(), "- literal");
});

test("mixed marker text is a list item, not a thematic break", () => {
  for (const marker of ["- * *", "* - -"]) {
    const src = `${marker}\n  - Child\n`;
    assert.equal(normalizeMarkdown(src), src);
  }
});

test("quoted HTML islands keep list-shaped content literal", () => {
  const src = "> <div>\n>     - literal\n> </div>\n";
  assert.equal(normalizeMarkdown(src), src);
});
