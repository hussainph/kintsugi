import assert from "node:assert/strict";
import { test } from "node:test";
import { hasTags, normalTag, setTags, tagQuery, tags, vocabulary, withTags } from "./tags.ts";

test("reads inline lists with quotes, comments and hashes, as the vault crate does", () => {
  const text = "---\ntitle: \"tags: [fake]\"\ntags: [Writing, '#craft', \"two  words\", 'reader''s life', writing] # mine\n---\n\ntags: [body]\n";
  assert.deepEqual(tags(text), ["writing", "craft", "two words", "reader's life"]);
});

test("reads Obsidian block lists, indented or flush left", () => {
  assert.deepEqual(tags("---\ntags:\n  - Essay\n  - \"a, b\"\ntitle: x\n---\n"), ["essay", "a, b"]);
  assert.deepEqual(tags("---\r\ntags:\r\n- one\r\n- two\r\nstatus: draft\r\n---\r\n"), ["one", "two"]);
  assert.deepEqual(tags("---\ntags:\n  - a\n  k: v\n---\n"), ["a"]);
});

test("a lone scalar is one tag; nothing is invented", () => {
  assert.deepEqual(tags("---\ntags: solo\n---\n"), ["solo"]);
  assert.deepEqual(tags("---\ntags: # nothing\n---\n"), []);
  assert.deepEqual(tags("tags: [body]\n"), []);
  assert.deepEqual(tags("---\ntags: [unclosed\n---\n"), []);
  assert.deepEqual(tags("---\nc:\n  tags: [nested]\n---\n"), []);
  assert.deepEqual(tags("---\ntags: [a]\ntags: [b]\n---\n"), ["a"]);
});

test("normalizes a tag the way the vocabulary does", () => {
  assert.equal(normalTag("  #Craft  "), "craft");
  assert.equal(normalTag("Two   Words"), "two words");
  assert.equal(normalTag("#"), null);
  assert.equal(normalTag("x".repeat(80))?.length, 64);
});

const doc = '---\ntitle: "Repair"\nstatus: draft\n---\n\nThe bowl was mended with gold.\n';

test("adds a tags field without disturbing the rest", () => {
  const next = withTags(doc, ["Essay", "craft", "essay"]);
  assert.equal(next, '---\ntitle: "Repair"\nstatus: draft\ntags: [essay, craft]\n---\n\nThe bowl was mended with gold.\n');
  assert.deepEqual(tags(next), ["essay", "craft"]);
});

test("replaces an inline or block list in place, and quotes only where YAML needs it", () => {
  const block = "---\ntitle: x\ntags:\n  - one\n  - two\nstatus: draft\n---\n\nBody\n";
  assert.equal(withTags(block, ["one", "a, b", "reader's life"]), '---\ntitle: x\ntags: [one, "a, b", "reader\'s life"]\nstatus: draft\n---\n\nBody\n');
  const inline = "---\ntags: [one] # mine\n---\n";
  assert.equal(withTags(inline, ["one", "two"]), "---\ntags: [one, two]\n---\n");
  assert.deepEqual(tags(withTags(block, ["a: b", "[x]", "#y"])), ["a: b", "[x]", "y"]);
});

test("removing the last tag removes the field; untagged documents stay untouched", () => {
  const block = "---\ntitle: x\ntags:\n  - one\nstatus: draft\n---\n\nBody\n";
  assert.equal(withTags(block, []), "---\ntitle: x\nstatus: draft\n---\n\nBody\n");
  assert.equal(withTags("---\r\ntags: [a]\r\nstatus: draft\r\n---\r\n", []), "---\r\nstatus: draft\r\n---\r\n");
  assert.equal(setTags(doc, []), null);
  assert.equal(setTags(withTags(doc, ["a"]), ["A"]), null);
});

test("tags a document without frontmatter", () => {
  assert.equal(withTags("Just words.\n", ["idea"]), "---\ntags: [idea]\n---\n\nJust words.\n");
});

test("filters, vocabulary and jump-list queries", () => {
  assert.ok(hasTags(["essay", "craft"], ["craft"]));
  assert.ok(!hasTags(["essay"], ["essay", "craft"]));
  assert.ok(hasTags(undefined, []));
  assert.deepEqual(vocabulary([["b", "a"], ["b"], undefined, ["c"]]), ["b", "a", "c"]);
  assert.deepEqual(tagQuery("#Essay repair #craft "), { tags: ["essay", "craft"], text: "repair", partial: null });
  assert.deepEqual(tagQuery("repair #cr"), { tags: [], text: "repair", partial: "cr" });
  assert.deepEqual(tagQuery("#"), { tags: [], text: "", partial: "" });
});
