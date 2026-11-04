import assert from "node:assert/strict";
import { test } from "node:test";
import { askCheck, askTrim, CHECK_BRIEF, CHECKS, onlyRemoves, parseCheck, parseTrim, sentencesFor, TRIM_BRIEF, TRIMS } from "../refine/marks.ts";

const DOC = "---\ntitle: x\n---\n\nThe bowl is really very old. It was just broken once.\n\nGold fills the seam, and the seam is the point.\n";
const sentences = sentencesFor(DOC, null);
const slice = (r: { from: number; to: number }) => DOC.slice(r.from, r.to);

test("checks and trims number the draft's sentences and carry the writing rules", () => {
  assert.deepEqual(sentences.map((s) => s.text), ["The bowl is really very old.", "It was just broken once.", "Gold fills the seam, and the seam is the point."]);
  const check = askCheck(CHECKS[0], DOC, sentences, true);
  assert.ok(check.system.startsWith(CHECK_BRIEF));
  assert.match(check.system, /Never, whatever the tone/);
  assert.match(check.messages[0].content, /<check kind="weakest">\n\[1\] The bowl is really very old\.\n\[2\]/);
  assert.doesNotMatch(check.messages[0].content, /context_before/, "the whole draft needs no context");
  const trim = askTrim(TRIMS[3], DOC, sentences, false);
  assert.ok(trim.system.startsWith(TRIM_BRIEF));
  assert.match(trim.system, /never add, replace, reorder or respell a word/);
  assert.match(trim.messages[0].content, /<trim percent="50">/);
  assert.match(trim.messages[0].content, /about 11 of 21/);
  assert.match(trim.messages[0].content, /<context_before>/, "a selection keeps its surroundings");
});

test("a check's answer becomes flags on the sentences and words it names", () => {
  const reply = `<marks>[
    {"sentence": 2, "reason": "Says little."},
    {"sentence": 1, "quote": "really very", "reason": "Two hedges in a row.\\nmore"},
    {"sentence": 3, "quote": "not in it", "reason": "Dropped."},
    {"sentence": 9, "reason": "No such sentence."},
    {"sentence": 1, "quote": "old"}
  ]</marks>`;
  const parsed = parseCheck(reply, DOC, sentences, "b");
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.marks.map((m) => [slice(m.range), m.kind, m.reason]), [
    ["It was just broken once.", "flag", "Says little."],
    ["really very", "flag", "Two hedges in a row."],
  ]);
  assert.equal(parsed.dropped, 3);
  assert.deepEqual(parseCheck("Sentence 2 is weak.", DOC, sentences, "b"), { ok: false, error: "Kin’s answer wasn’t a list of marks. Try again." });
});

test("a trim's answer becomes cuts of whole words that close up the text", () => {
  const reply = `<cuts>[{"sentence": 1, "cut": "really very"}, {"sentence": 2, "cut": "just"}, {"sentence": 3, "cut": "and the seam is the point"}, {"sentence": 3, "cut": "absent"}]</cuts>`;
  const parsed = parseTrim(reply, DOC, sentences, "t");
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.marks.map((m) => [slice(m.range), m.kind]), [["really very ", "cut"], ["just ", "cut"], [" and the seam is the point", "cut"]]);
  assert.equal(parsed.dropped, 1);
  let after = DOC;
  for (const m of [...parsed.marks].reverse()) after = after.slice(0, m.range.from) + after.slice(m.range.to);
  assert.ok(after.includes("The bowl is old. It was broken once.\n\nGold fills the seam,."));
});

test("a trim that would add words is refused, not applied", () => {
  const adds = (reply: string) => {
    const parsed = parseTrim(reply, DOC, sentences, "t");
    assert.ok(!parsed.ok, reply);
    assert.match(parsed.error, /would have added words/);
  };
  adds(`<cuts>[{"sentence": 1, "cut": "really very", "with": "quite"}]</cuts>`);
  adds(`<cuts>[{"sentence": 1, "cut": "eally"}]</cuts>`);
  adds(`<cuts>[{"sentence": 1, "cut": "The bowl is really very old.", "replace": "It's old."}]</cuts>`);
  adds(`<cuts>["really"]</cuts>`);
  const garbled = parseTrim("The bowl is old.", DOC, sentences, "t");
  assert.ok(!garbled.ok);
  assert.ok(onlyRemoves("a b c d", "a c"));
  assert.ok(!onlyRemoves("a b c d", "a x c"));
  assert.ok(!onlyRemoves("a b c", "c a"));
});

test("the trim levels and checks are the ticket's", () => {
  assert.deepEqual(TRIMS.map((t) => [t.label, t.percent]), [["Slight trim −10%", 10], ["Tighten more", 20], ["Even sharper", 30], ["Cut in half −50%", 50]]);
  assert.equal(CHECKS.length, 5);
});
