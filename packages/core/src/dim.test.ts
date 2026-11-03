import assert from "node:assert/strict";
import { test } from "node:test";
import { cutRange, dimmedSpans, dimSyntax, scanSpans, withoutDimmed } from "./dim.ts";
import { wordCount } from "./frontmatter.ts";

const texts = (body: string) => dimmedSpans(body).map((s) => body.slice(s.inner, s.innerTo));

test("every comment form is dimmed: HTML, MDX and Obsidian", () => {
  const body = "One <!-- html --> two {/* mdx */} three %%obsidian%% four { /* spaced */ } five <!--tight-->.";
  assert.deepEqual(texts(body), ["html", "mdx", "obsidian", "spaced", "tight"]);
  const [html] = dimmedSpans(body);
  assert.equal(body.slice(html.from, html.to), "<!-- html -->");
  assert.equal(html.closed, true);
});

test("code is never dimmed, and unfinished markers are prose except <!--", () => {
  const body = "`<!-- no -->` and\n\n```md\n{/* no */} %%no%%\n```\n\n100%% sure, a { brace /* and\n\n<!-- open to the end";
  const spans = dimmedSpans(body);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].closed, false);
  assert.equal(body.slice(spans[0].inner), "open to the end");
  assert.equal(scanSpans(body).code.length, 2);
});

test("a comment can span lines and paragraphs", () => {
  assert.deepEqual(texts("<!-- one\n\ntwo -->\n{/* a\nb */}"), ["one\n\ntwo", "a\nb"]);
});

test("an empty comment doesn't share its padding", () => {
  const [span] = dimmedSpans("<!-- -->");
  assert.ok(span.inner <= span.innerTo);
});

test("dimming writes <!-- --> in .md and {/* */} in .mdx", () => {
  assert.deepEqual(dimSyntax("notes/a.md"), { open: "<!-- ", close: " -->" });
  assert.deepEqual(dimSyntax("posts/a.MDX"), { open: "{/* ", close: " */}" });
});

test("cutting a comment alone on its line takes the line", () => {
  const body = "- one\n  <!-- - two -->\n- three {/* aside */} here\n";
  assert.equal(withoutDimmed(body), "- one\n- three  here\n");
  const span = dimmedSpans(body)[0];
  assert.deepEqual(cutRange(body, span), { from: 6, to: 23 });
});

test("dimmed text doesn't count as words", () => {
  const doc = "---\ntitle: A\n---\n\nThree words here. <!-- not these four words -->\n\n{/* nor\nthese */}\n%%or this%%\n";
  assert.equal(wordCount(doc), 3);
});
