import assert from "node:assert/strict";
import { test } from "node:test";
import { discussNote, parseReview, relocate, reviewScope, reviewSentences } from "../refine/review.ts";

const DOC = [
  "---", "title: x", "---", "",
  "The bowl is old. I think it was broken once.", "",
  "# Gold", "",
  "We utilize gold because it shows the break.", "",
  "```", "# not a heading", "```", "",
  "## Seams", "",
  "A seam is a line.", "",
  "# Last", "",
  "Nobody was allowed to use it.", "",
].join("\n");
const at = (words: string) => DOC.indexOf(words);
const none = { from: at("We utilize"), to: at("We utilize") };

test("a section runs from its heading to the next of its level, past code and subheadings", () => {
  const draft = reviewScope(DOC, "draft", none);
  assert.equal(draft.scope, null);
  assert.equal(DOC.slice(draft.range.from).startsWith("The bowl"), true);
  const gold = reviewScope(DOC, "section", none);
  assert.equal(gold.scope, "the section “Gold”");
  assert.deepEqual(reviewSentences(DOC, gold.range).map((s) => s.text), ["We utilize gold because it shows the break.", "A seam is a line."]);
  const opening = reviewScope(DOC, "section", { from: at("old."), to: at("old.") });
  assert.deepEqual(reviewSentences(DOC, opening.range).map((s) => s.text), ["The bowl is old.", "I think it was broken once."]);
  const selected = reviewScope(DOC, "section", { from: at("A seam"), to: at("A seam") + 6 });
  assert.equal(selected.scope, "the selected passage");
});

test("a review's suggestions become marks only where the text has them", () => {
  const sentences = reviewSentences(DOC, reviewScope(DOC, "draft", none).range);
  const { marks, dropped } = parseReview([
    { sentence: 1, kind: "flag", reason: "Source?" },
    { sentence: 2, kind: "cut", quote: "I think", reason: "A hedge." },
    { sentence: 3, kind: "rewrite", quote: "utilize", text: " use ", reason: "Plainer." },
    { sentence: 3, kind: "rewrite", quote: "gold", text: "gold", reason: "Same words." },
    { sentence: 3, kind: "cut", quote: "tilize", reason: "Inside a word." },
    { sentence: 3, kind: "flag", quote: "utilize gold", reason: "Overlaps." },
    { sentence: 1, kind: "cut", quote: "words the draft never had", reason: "Made up." },
    { sentence: 99, kind: "flag", reason: "No such sentence." },
    { sentence: 4, kind: "flag", reason: "" },
  ], DOC, sentences, "b");
  assert.equal(dropped, 6);
  assert.deepEqual(marks.map((m) => [m.kind, DOC.slice(m.range.from, m.range.to), m.text]), [
    ["flag", "The bowl is old.", undefined],
    ["cut", "I think ", undefined],
    ["rewrite", "utilize", "use"],
  ]);
});

test("sentences are found again after an edit while Kin read", () => {
  const sentences = reviewSentences(DOC, reviewScope(DOC, "draft", none).range);
  const edited = DOC.replace("The bowl is old.", "The old bowl is old. Mended.");
  const moved = relocate(sentences, edited);
  assert.equal(moved.length, sentences.length - 1, "the edited one is gone");
  for (const s of moved) assert.equal(edited.slice(s.from, s.to), s.text);
});

test("Discuss opens with the suggestion as Kin saw it", () => {
  const mark = (kind: "cut" | "rewrite" | "flag", text?: string) => ({ id: "x", range: { from: 0, to: 1 }, kind, reason: "Why.", text });
  assert.equal(discussNote(mark("cut"), "I think "), "I’d cut “I think”. Why.");
  assert.equal(discussNote(mark("rewrite", "use"), "utilize"), "I’d change “utilize” to “use”. Why.");
  assert.equal(discussNote(mark("flag"), "The bowl\nis old."), "“The bowl is old.”: Why.");
});
