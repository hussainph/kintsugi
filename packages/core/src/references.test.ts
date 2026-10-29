import assert from "node:assert/strict";
import { test } from "node:test";
import { attributedQuote, isReferenceContext, linkFor, parseWikilinks, resolveReference, searchReferences, type ReferenceSource } from "./references.ts";

const document: ReferenceSource = { kind: "document", path: "posts/on-craft.mdx", title: "On craft", status: "complete", text: "Learning to repair a bowl" };
const clip: ReferenceSource = { kind: "clip", path: "inspiration/on-craft.md", title: "The art of craft", site: "A journal", text: "> A beautiful repair", summary: "Gold and clay" };
const note: ReferenceSource = { kind: "document", path: "notes/repair.md", title: "Repair", status: "draft" };
const sources = [clip, document, note];

test("short references prefer documents, while colliding clips use their exact vault path", () => {
  assert.equal(resolveReference("on-craft", sources), document);
  assert.equal(linkFor(document, sources), "[[on-craft]]");
  assert.equal(linkFor(clip, sources), "[[inspiration/on-craft]]");
  assert.equal(linkFor(note, sources), "[[repair]]");
  assert.equal(linkFor(clip, [clip]), "[[on-craft]]");
  assert.equal(linkFor(clip, []), "[[on-craft]]");
});

test("resolves aliases, headings, explicit paths and md/mdx extensions", () => {
  for (const target of ["on-craft#Practice", "[[on-craft|My earlier post]]", "posts/on-craft", "posts/on-craft.mdx#Practice|A post", "./posts/on-craft.mdx", "on-craft\\|table alias"]) {
    assert.equal(resolveReference(target, sources), document, target);
  }
  for (const target of ["inspiration/on-craft", "[[inspiration/on-craft.md#A passage|Craft]]"]) {
    assert.equal(resolveReference(target, sources), clip, target);
  }
  assert.equal(resolveReference("missing", sources), null);
  assert.equal(resolveReference("#Heading", sources), null);
  assert.equal(resolveReference("posts/on-craft.md", sources), document, "explicit stems tolerate md/mdx spellings like the backend");
  assert.equal(resolveReference("on-craft.mdx", sources), null, "extension-only targets are exact root paths, matching the backend");
  for (const target of ["../on-craft", "posts/../on-craft", "posts//on-craft", "posts/./on-craft", "/posts/on-craft", "on-craft\\"]) assert.equal(resolveReference(target, sources), null);
});

test("ambiguous same-kind basenames require paths instead of resolving to an arbitrary file", () => {
  const second = { ...document, path: "notes/on-craft.md" };
  assert.equal(resolveReference("on-craft", [...sources, second]), null);
  assert.equal(linkFor(document, [...sources, second]), "[[posts/on-craft]]");
  assert.equal(linkFor(second, [...sources, second]), "[[notes/on-craft]]");
  const root = { ...document, path: "on-craft.md" };
  assert.equal(resolveReference("on-craft", [...sources, root]), root);
  assert.equal(linkFor(root, [...sources, root]), "[[on-craft]]");
});

test("lexical matches require every token and keep documents first", () => {
  assert.deepEqual(searchReferences("craft", sources), [document, clip]);
  assert.deepEqual(searchReferences("complete repair", sources), [document]);
  assert.deepEqual(searchReferences("journal clay", sources), [clip]);
  assert.deepEqual(searchReferences("draft", sources), [note]);
  assert.equal(searchReferences("missing", sources).length, 0);
  assert.equal(searchReferences("", sources).length, 3);
});

test("quotes strip existing nested quote markers and attribute only the clip's own text", () => {
  assert.equal(attributedQuote("> A beautiful repair\n> > A second line\n>\n> My note", "[[inspiration/on-craft]]"), "> A beautiful repair\n> A second line\n>\n> My note\n>\n> [[inspiration/on-craft]]");
  assert.equal(attributedQuote("  \n> \n", "[[x]]"), "");
  assert.equal(attributedQuote("Passage", "x"), "> Passage\n>\n> [[x]]");
  assert.equal(attributedQuote("---\ntitle: X\n---\n\n> Passage\n\n<!-- kintsugi:source -->\n## Source\nEXTRACTED", "[[x]]"), "> Passage\n>\n> [[x]]");
  assert.equal(attributedQuote("---\ntitle: Legacy\n---\nNote\n\n## Source\nEXTRACTED", "[[x]]"), "> Note\n>\n> [[x]]");
  assert.ok(attributedQuote("---\ntitle: Legacy\n---\n```md\n## Source\n```\nMy note\n## Source\nEXTRACTED", "[[x]]").includes("> ## Source"));
  assert.ok(!attributedQuote("---\ntitle: Legacy\n---\n```md\n## Source\n```\nMy note\n## Source\nEXTRACTED", "[[x]]").includes("EXTRACTED"));
});

test("quoting own text preserves legitimate Source headings, including in modern complete files", () => {
  const own = "Note\n\n## Source\nMy own source notes";
  const quoted = "> Note\n>\n> ## Source\n> My own source notes\n>\n> [[x]]";
  assert.equal(attributedQuote(own, "[[x]]"), quoted);
  assert.equal(attributedQuote(`---\nkind: note\n---\n${own}\n\n<!-- kintsugi:source -->\n## Source\nEXTRACTED`, "[[x]]"), quoted);
  assert.equal(attributedQuote(`${own}\n<!-- kintsugi:source -->\nEXTRACTED`, "[[x]]"), quoted);
});

test("parses prose wikilinks, preserving offsets, targets and aliases", () => {
  const text = "A [[on-craft#Practice|Earlier writing]] and [[inspiration/on-craft.md]].";
  const links = parseWikilinks(text);
  assert.deepEqual(links.map(({ target, alias }) => ({ target, alias })), [
    { target: "on-craft#Practice", alias: "Earlier writing" },
    { target: "inspiration/on-craft.md", alias: undefined },
  ]);
  for (const link of links) assert.ok(text.slice(link.from, link.to).startsWith("[["));
});

test("ignores frontmatter, fenced and inline code, comments and escaped links", () => {
  const text = [
    "---", 'title: "[[yaml]]"', "---", "",
    "[[real]] and `[[inline]]` and ``code ` [[long-inline]]``.",
    "```md", "[[fenced]]", "````", "~~~", "[[tilde]]", "~~~",
    "> ```", "> [[quoted-code]]", "> ```",
    "<!-- [[comment]] -->", "\\[[escaped]] and \\\\[[not-escaped]]",
    "`multi", "[[multiline-code]]`", "[[end]]", "```", "[[unclosed-fence]]",
  ].join("\n");
  assert.deepEqual(parseWikilinks(text).map((link) => link.target), ["real", "not-escaped", "end"]);
  assert.equal(isReferenceContext(text, text.indexOf("yaml")), false);
  assert.equal(isReferenceContext(text, text.indexOf("real")), true);
  assert.equal(isReferenceContext(text, text.indexOf("unclosed-fence")), false);
});

test("unmatched inline backticks do not hide prose, empty or multiline links are not references", () => {
  assert.deepEqual(parseWikilinks("` unmatched [[real]] [[]] [[\nno]]").map((link) => link.target), ["real"]);
  assert.equal(parseWikilinks("[[one]] [[two]]").length, 2);
});

test("matches backend edge cases: BOM and unfinished YAML, list fences, table aliases and intersecting code", () => {
  const text = "\uFEFF---\r\ntitle: [[yaml]]\r\n...\r\n- ```md\n  [[list-code]]\n  ```\n[[on-craft\\|table alias]] [[intersecting `code`]] [[intersecting <!--comment-->]] [[#Local]] [[#]]";
  const links = parseWikilinks(text);
  assert.deepEqual(links.map((link) => link.target), ["on-craft", "#Local"]);
  assert.equal(links[0].alias, "table alias");
  assert.equal(resolveReference(links[0].target, sources), document);
  assert.equal(text.slice(links[0].from, links[0].to), "[[on-craft\\|table alias]]");
  assert.deepEqual(parseWikilinks("---\ntitle: [[unfinished-yaml]]"), []);
  assert.deepEqual(parseWikilinks("[[escaped-close\\]]"), []);
});
