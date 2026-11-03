import assert from "node:assert/strict";
import { test } from "node:test";
import { cite, uncited } from "./citations.ts";

test("inline citations split out; numbers with no quote and wikilinks stay text", () => {
  assert.deepEqual(cite("Two drafts say it [1] and a clip disagrees [2].", 2), [
    { text: "Two drafts say it" },
    { quote: 0 },
    { text: " and a clip disagrees" },
    { quote: 1 },
    { text: "." },
  ]);
  assert.deepEqual(cite("See [3] and [[notes/a]].", 2), [{ text: "See [3] and [[notes/a]]." }]);
  assert.deepEqual(cite("Both [1][2]", 2), [{ text: "Both" }, { quote: 0 }, { quote: 1 }]);
  assert.deepEqual(cite("", 2), []);
});

test("quotes nothing cites still show; older ideas cite none, so all show", () => {
  assert.deepEqual(uncited({ hunch: "h [2]", observed: ["o"], quotes: ["a", "b"] }), [0]);
  assert.deepEqual(uncited({ hunch: "h", observed: ["o [1]"], quotes: ["a", "b"] }), [1]);
  assert.deepEqual(uncited({ hunch: "h", observed: ["o"], quotes: ["a", "b"] }), [0, 1]);
});
