import assert from "node:assert/strict";
import { test } from "node:test";
import { editPath, parseEdit } from "./edits.ts";
import { resolveTarget, splitPaths } from "./links.ts";

test("an edit block names its document and holds search/replace pairs", () => {
  assert.equal(editPath("edit drafts/a.md"), "drafts/a.md");
  assert.equal(editPath("ts"), null);
  const code = "<<<<<<< SEARCH\nIt was really good.\n=======\nIt was good.\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nTwo\nlines\n=======\nOne\n>>>>>>> REPLACE";
  assert.deepEqual(parseEdit("edit drafts/a.md", code), {
    path: "drafts/a.md",
    pairs: [
      { before: "It was really good.", after: "It was good." },
      { before: "Two\nlines", after: "One" },
    ],
  });
  // Half-written (still streaming), or with nothing to find: not an edit yet.
  assert.equal(parseEdit("edit drafts/a.md", "<<<<<<< SEARCH\nIt was\n======="), null);
  assert.equal(parseEdit("edit drafts/a.md", "<<<<<<< SEARCH\n\n=======\nnew\n>>>>>>> REPLACE"), null);
});

test("vault paths in Kin's words are found, and nothing else", () => {
  assert.deepEqual(splitPaths("I looked in notes/repair.md and posts/series/field-notes.md."), [
    "I looked in ",
    { path: "notes/repair.md" },
    " and ",
    { path: "posts/series/field-notes.md" },
    ".",
  ]);
  assert.deepEqual(splitPaths("see https://a.org/x.md or a/b"), ["see https://a.org/x.md or a/b"]);
});

test("a [[link]] or path resolves to a document or a clip", () => {
  const docs = [{ path: "posts/on-craft.mdx", title: "On craft and repair" }, { path: "notes/repair.md", title: "Repair" }];
  assert.deepEqual(resolveTarget("posts/on-craft", docs), { doc: "posts/on-craft.mdx" });
  assert.deepEqual(resolveTarget("repair", docs), { doc: "notes/repair.md" });
  assert.deepEqual(resolveTarget("On craft and repair", docs), { doc: "posts/on-craft.mdx" });
  assert.deepEqual(resolveTarget("inspiration/golden-joinery.md", docs), { clip: "inspiration/golden-joinery.md" });
  assert.deepEqual(resolveTarget("golden-joinery", docs), { clip: "inspiration/golden-joinery.md" });
  assert.equal(resolveTarget("drafts/missing", docs), null);
});
