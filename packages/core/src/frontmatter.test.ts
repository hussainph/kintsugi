import assert from "node:assert/strict";
import { test } from "node:test";
import { field, joinFrontmatter, setField, splitFrontmatter } from "./frontmatter.ts";

const doc = '---\ntitle: "Repair"\nstatus: draft\n---\n\nThe bowl was mended with gold.\n';

test("splits the frontmatter from the writing", () => {
  const { head, body } = splitFrontmatter(doc);
  assert.equal(head, '---\ntitle: "Repair"\nstatus: draft\n---\n\n');
  assert.equal(body, "The bowl was mended with gold.\n");
  assert.equal(joinFrontmatter(head, body), doc);
});

test("handles documents without frontmatter or without a body", () => {
  assert.deepEqual(splitFrontmatter("Just words."), { head: "", body: "Just words." });
  assert.deepEqual(splitFrontmatter("---\ntitle: x\n---"), { head: "---\ntitle: x\n---", body: "" });
  assert.equal(joinFrontmatter("---\ntitle: x\n---", "Words"), "---\ntitle: x\n---\n\nWords");
  assert.equal(joinFrontmatter("---\ntitle: x\n---\n", "Words"), "---\ntitle: x\n---\n\nWords");
});

test("sets a field in place", () => {
  const change = setField(doc, "status", "complete");
  const next = doc.slice(0, change.from) + change.insert + doc.slice(change.to);
  assert.equal(field(next, "status"), "complete");
  assert.equal(field(next, "title"), "Repair");
});
