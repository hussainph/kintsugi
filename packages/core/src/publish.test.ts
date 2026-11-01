import assert from "node:assert/strict";
import { test } from "node:test";
import { blogSlug, blogTags, documentTags, imageCandidates, planPublish, publishedFields, type BlogCheck, type PublishInput } from "./publish.ts";
import type { ReferenceSource } from "./references.ts";

const sources: ReferenceSource[] = [
  { kind: "document", path: "posts/on-craft.mdx", title: "On craft and repair", status: "complete" },
  { kind: "document", path: "notes/repair.md", title: "Repair is a kind of attention", status: "draft" },
  { kind: "document", path: "hussain.ph/essays/the-sixth-attempt.md", title: "The sixth attempt", status: "published" },
  { kind: "document", path: "posts/quiet-web.md", title: "The quiet web", status: "complete" },
  { kind: "clip", path: "inspiration/golden-joinery.md", title: "Golden joinery" },
  { kind: "clip", path: "inspiration/bare-note.md", title: "A bare note" },
];
const base = (text: string, extra: Partial<PublishInput> = {}): PublishInput => ({
  path: "posts/on-craft.mdx",
  text,
  today: "2026-11-02",
  site: "https://hussain.ph",
  sources,
  published: [
    { path: "hussain.ph/essays/the-sixth-attempt.md", url: "https://hussain.ph/essays/the-sixth-attempt/" },
    { path: "posts/quiet-web.md", url: "https://hussain.ph/notes/the-quiet-web/", post: "src/content/notes/2026-10-01-the-quiet-web.md" },
  ],
  clips: [
    { path: "inspiration/golden-joinery.md", title: "Golden joinery", url: "https://example.com/kintsugi", site: "Example", author: "Ana Rivera" },
    { path: "inspiration/bare-note.md", title: "A bare note", url: null, site: null, author: null },
  ],
  appendix: false,
  ...extra,
});
const checked = (extra: Partial<BlogCheck> = {}): BlogCheck => ({ exists: false, owned: false, changed: false, imports: {}, images: {}, ...extra });
const levels = (plan: ReturnType<typeof planPublish>, level: string) => plan.checks.filter((c) => c.level === level).map((c) => c.message);

const essay = `---
title: "On craft and repair"
status: complete
tags: [Craft, writing, "Field Notes"]
idea: ideas/123
---

# On craft and repair

I wrote about this in [[notes/repair]] and [[the-sixth-attempt|my sixth attempt]].
The [[inspiration/golden-joinery]] clip, the [[quiet-web]] note, and [[nowhere-yet]].
<!-- private: tighten this -->
Code stays: \`[[not-a-link]]\` and

\`\`\`md
[[also-not]] <!-- nor this -->
\`\`\`
`;

test("maps frontmatter to the blog's schema and drops Kintsugi's fields", () => {
  const plan = planPublish(base(essay, { check: checked() }));
  assert.equal(plan.file, "src/content/writing/2026-11-02-on-craft-and-repair.md");
  assert.equal(plan.url, "https://hussain.ph/essays/on-craft-and-repair/");
  assert.ok(plan.content.startsWith('---\ntitle: "On craft and repair"\ntags: [craft, writing, field-notes]\n---\n\nI wrote about'));
  assert.ok(!/status|idea/.test(plan.content.split("---")[1]));
  assert.ok(!plan.body.includes("# On craft"), "the repeated title heading is removed");
  assert.ok(levels(plan, "warning").some((m) => m.includes("Craft → craft") && m.includes("Field Notes → field-notes")));
  assert.equal(plan.ready, true);
});

test("turns wikilinks into blog links and unpublished targets into plain text", () => {
  const plan = planPublish(base(essay, { check: checked() }));
  assert.match(plan.body, /I wrote about this in Repair is a kind of attention and \[my sixth attempt\]\(\/essays\/the-sixth-attempt\/\)\./);
  assert.match(plan.body, /The \[Golden joinery\]\(https:\/\/example\.com\/kintsugi\) clip, the \[The quiet web\]\(\/notes\/the-quiet-web\/\) note, and nowhere yet\./);
  assert.ok(plan.body.includes("`[[not-a-link]]`") && plan.body.includes("[[also-not]] <!-- nor this -->"), "code is untouched");
  assert.ok(!plan.body.includes("private: tighten"), "comments are left out");
  const warnings = levels(plan, "warning");
  assert.ok(warnings.some((m) => m.startsWith("[[Repair is a kind of attention]]") && m.includes("not published")));
  assert.ok(warnings.some((m) => m.startsWith("[[nowhere-yet]]") && m.includes("not found")));
  assert.ok(levels(plan, "note").some((m) => m.includes("HTML comment")));
});

test("a draft, a mirror and an untitled essay can't be written", () => {
  const draft = planPublish(base(essay.replace("status: complete", "status: draft"), { check: checked() }));
  assert.equal(draft.ready, false);
  assert.ok(levels(draft, "error")[0].includes("Only a complete document"));
  const mirror = planPublish(base("---\ntitle: X\nstatus: published\nmirror: hussain.ph\n---\n\nWords.\n", { check: checked() }));
  assert.ok(levels(mirror, "error").some((m) => m.includes("mirror")));
  const untitled = planPublish(base("---\nstatus: complete\n---\n\nJust words.\n", { check: checked() }));
  assert.ok(levels(untitled, "error").some((m) => m.includes("needs a title")));
  assert.equal(planPublish(base(essay)).ready, false, "not ready before the backend has checked it");
});

test("a note has no title, uses the notes collection and a 52-character slug", () => {
  const plan = planPublish(base("---\ntitle: A thought about friction between thinking and publishing things\nstatus: complete\n---\n\nOne command and a text file.\n", { kind: "note", check: checked() }));
  assert.equal(plan.file, "src/content/notes/2026-11-02-a-thought-about-friction-between-thinking-and.md");
  assert.equal(plan.url, "https://hussain.ph/notes/a-thought-about-friction-between-thinking-and/");
  assert.equal(plan.content, "One command and a text file.\n");
});

test("images are copied to public/posts/<id>/ and links rewritten", () => {
  const text = `---\ntitle: Pictures\nstatus: complete\n---\n\n![A bowl](<../media/Bowl Photo.PNG> "The mended bowl")\n\n![[inspiration/media/gold.jpeg|Gold seam]]\n\n![Remote](https://example.com/x.png)\n\n![Gone](./missing.png)\n`;
  const first = planPublish(base(text));
  assert.deepEqual(first.imageRefs.map((r) => [r.key, r.embed, r.candidates]), [
    ["md:../media/Bowl Photo.PNG", false, ["media/Bowl Photo.PNG"]],
    ["md:./missing.png", false, ["posts/missing.png", "missing.png"]],
    ["embed:inspiration/media/gold.jpeg", true, ["posts/inspiration/media/gold.jpeg", "inspiration/media/gold.jpeg"]],
  ]);
  const plan = planPublish(base(text, { check: checked({ images: { "md:../media/Bowl Photo.PNG": "media/Bowl Photo.PNG", "embed:inspiration/media/gold.jpeg": "inspiration/media/gold.jpeg", "md:./missing.png": null } }) }));
  assert.deepEqual(plan.images, [
    { from: "media/Bowl Photo.PNG", to: "public/posts/2026-11-02-pictures/bowl-photo.png", url: "/posts/2026-11-02-pictures/bowl-photo.png" },
    { from: "inspiration/media/gold.jpeg", to: "public/posts/2026-11-02-pictures/gold.jpg", url: "/posts/2026-11-02-pictures/gold.jpg" },
  ]);
  assert.ok(plan.body.includes('![A bowl](/posts/2026-11-02-pictures/bowl-photo.png "The mended bowl")'));
  assert.ok(plan.body.includes("![Gold seam](/posts/2026-11-02-pictures/gold.jpg)"));
  assert.ok(plan.body.includes("![Remote](https://example.com/x.png)"));
  assert.ok(levels(plan, "error").some((m) => m.includes("./missing.png")));
  assert.ok(levels(plan, "warning").some((m) => m.includes("another site")));
  assert.equal(plan.ready, false);
});

test("MDX: components need imports, and imports must exist in the repo", () => {
  const text = `---\ntitle: Springs\nstatus: complete\n---\n\nimport SpringDemo from "../../components/SpringDemo.jsx";\n\nA spring.\n\n<SpringDemo client:visible />\n\n<Missing />\n\nBraces {like this}.\n`;
  const plan = planPublish(base(text, { check: checked({ imports: { "src/components/SpringDemo.jsx": false } }) }));
  assert.equal(plan.file, "src/content/writing/2026-11-02-springs.mdx");
  assert.deepEqual(plan.imports, ["src/components/SpringDemo.jsx"]);
  const errors = levels(plan, "error");
  assert.ok(errors.some((m) => m.includes("<Missing>")));
  assert.ok(errors.some((m) => m.includes("no src/components/SpringDemo.jsx")));
  assert.ok(!errors.some((m) => m.includes("<SpringDemo>")));
  assert.ok(levels(plan, "warning").some((m) => m.includes("{ or }")));
  assert.equal(planPublish(base("---\ntitle: Plain\nstatus: complete\n---\n\nBraces {fine} in Markdown.\n", { check: checked() })).file.endsWith(".md"), true);
});

test("a sources appendix lists referenced clips, only when asked", () => {
  assert.ok(!planPublish(base(essay, { check: checked() })).body.includes("## Sources"));
  const text = `---\ntitle: Sources\nstatus: complete\n---\n\n> A quote.\n>\n> [[golden-joinery]]\n\nAnd [[bare-note]], and again [[inspiration/golden-joinery|gold]].\n`;
  const plan = planPublish(base(text, { appendix: true, check: checked() }));
  assert.ok(plan.body.endsWith("## Sources\n\n- [Golden joinery](https://example.com/kintsugi), Ana Rivera, Example\n- A bare note\n"));
  assert.ok(plan.body.includes("> [Golden joinery](https://example.com/kintsugi)"));
});

test("republishing keeps the recorded file; someone else's file is an error", () => {
  const text = essay.replace("idea: ideas/123", "post: src/content/writing/2026-10-20-on-craft.md\nurl: https://hussain.ph/essays/on-craft/");
  const plan = planPublish(base(text, { check: checked({ exists: true, owned: true, changed: true }) }));
  assert.equal(plan.file, "src/content/writing/2026-10-20-on-craft.md");
  assert.equal(plan.republish, true);
  assert.equal(plan.ready, true);
  assert.ok(levels(plan, "note").some((m) => m.includes("keeps its address")));
  assert.ok(levels(plan, "warning").some((m) => m.includes("edited in the blog repository")));
  assert.deepEqual(publishedFields(plan), [["post", plan.file], ["url", "https://hussain.ph/essays/on-craft/"], ["published", "2026-10-20"]]);

  const clash = planPublish(base(essay, { check: checked({ exists: true }) }));
  assert.ok(levels(clash, "error").some((m) => m.includes("already exists")));

  const mdx = planPublish(base(text.replace("\n# On craft", '\nimport X from "../../components/X.astro";\n\n<X />\n\n# On craft'), { check: checked({ owned: true }) }));
  assert.equal(mdx.file, "src/content/writing/2026-10-20-on-craft.mdx");
  assert.equal(mdx.replaces, "src/content/writing/2026-10-20-on-craft.md");
});

test("helpers: slugs, tags and image candidates", () => {
  assert.equal(blogSlug("Café — the “sixth” attempt!"), "cafe-the-sixth-attempt");
  assert.deepEqual(documentTags("---\ntags:\n  - one\n  - 'Two'\n---\n"), ["one", "Two"]);
  assert.deepEqual(documentTags("---\ntags: a, b\n---\n"), ["a", "b"]);
  assert.deepEqual(blogTags(["#Design", "design", "!!"]), { tags: ["design"], changed: ["#Design → design", "!! (dropped)"] });
  assert.deepEqual(imageCandidates("/media/a%20b.png", "posts/x.md"), ["media/a b.png"]);
  assert.deepEqual(imageCandidates("../../../escape.png", "posts/x.md"), []);
});
