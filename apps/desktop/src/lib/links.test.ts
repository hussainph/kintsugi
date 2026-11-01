import assert from "node:assert/strict";
import { test } from "node:test";
import { apply, invert, question, restored, skipped, updated } from "./links.ts";

test("the prompt counts links and notes", () => {
  assert.equal(question(1, 1), "Update 1 link in 1 note?");
  assert.equal(question(5, 3), "Update 5 links in 3 notes?");
  assert.equal(updated(2, 1), "Updated 2 links in 1 note.");
  assert.equal(restored(1, 2), "Restored 1 link in 2 notes.");
});

test("edits apply, and their inverse restores the original", () => {
  const before = "See [[repair]] and 😀 [[notes/repair#Gold|gold]].";
  const edits = [
    { from: 6, to: 12, insert: "mending" },
    { from: 24, to: 36, insert: "notes/mending" },
  ];
  const after = apply(before, edits);
  assert.equal(after, "See [[mending]] and 😀 [[notes/mending#Gold|gold]].");
  assert.equal(apply(after, invert(before, edits)), before);
});

test("skipped files say why", () => {
  assert.deepEqual(
    skipped([
      { path: "a.md", result: "saved" },
      { path: "b.md", result: "conflict" },
      { path: "c.md", result: "gone" },
      { path: "d.md", result: "failed", error: "read-only" },
    ]),
    ["b.md (changed since)", "c.md (moved or deleted)", "d.md (read-only)"],
  );
});
