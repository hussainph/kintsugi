import assert from "node:assert/strict";
import { test } from "node:test";
import { documentCountLabel } from "./documentCount.ts";

test("the footer shows the total or the selected words and characters", () => {
  assert.equal(documentCountLabel({ words: 480, selection: null }), "480 words");
  assert.equal(documentCountLabel({ words: 480, selection: { words: 12, characters: 64 } }), "12 of 480 words · 64 characters");
  assert.equal(documentCountLabel({ words: 1, selection: { words: 1, characters: 1 } }), "1 of 1 word · 1 character");
  assert.equal(documentCountLabel({ words: 0, selection: { words: 0, characters: 0 } }), "0 of 0 words · 0 characters");
});
