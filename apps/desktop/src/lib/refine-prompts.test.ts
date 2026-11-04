import assert from "node:assert/strict";
import { test } from "node:test";
import type { SpanLevel } from "@kintsugi/editor/alternatives";
import { ACTIONS, alternativeChoices, ask, askAlternatives, choices, clean } from "../refine/prompts.ts";

const LEVELS: SpanLevel[] = ["word", "phrase", "sentence", "paragraph"];

for (const level of LEVELS) {
  test(`${level} alternatives request one JSON array with the writer's voice intact`, () => {
    const passage = "The repair is visible.\nKeep **every** mark.";
    const request = askAlternatives(level, `Before. ${passage} After.`, 8, 8 + passage.length);
    assert.match(request.system, /The writing is theirs/);
    assert.match(request.system, /Never add new ideas, claims, examples or flourishes/);
    assert.match(request.system, /Never introduce any of these into the passage/);
    assert.match(request.system, /- Em dashes\. Use a comma/);
    assert.match(request.system, /Keep any Markdown or MDX syntax/);
    assert.match(request.system, /JSON array of up to 3 distinct strings/);
    assert.match(request.system, /Do not include the original passage/);
    assert.match(request.system, /Encode line breaks within a string as \\n/);
    assert.equal(request.messages.length, 1);
    assert.equal(request.messages[0].role, "user");
    assert.match(request.messages[0].content, new RegExp(`<alternatives level="${level}">`));
    assert.ok(request.messages[0].content.includes(`<passage>${passage}</passage>`));
    assert.ok(request.messages[0].content.includes("<context_before>Before. </context_before>"));
    assert.ok(request.messages[0].content.includes("<context_after> After.</context_after>"));
    assert.equal(request.maxTokens, 400 + 3 * passage.length);
  });
}

test("words and phrases ask for synonyms; sentences and paragraphs ask for versions", () => {
  const word = askAlternatives("word", "good", 0, 4);
  const phrase = askAlternatives("phrase", "good", 0, 4);
  assert.equal(word.system, phrase.system);
  assert.equal(word.messages[0].content.replace('level="word"', 'level="phrase"'), phrase.messages[0].content);
  assert.match(word.messages[0].content, /Suggest synonyms.*surrounding sentence/);
  assert.match(askAlternatives("sentence", "Good.", 0, 5).messages[0].content, /Reword the selected sentence/);
  assert.match(askAlternatives("paragraph", "Good.", 0, 5).messages[0].content, /Keep every idea, its order/);
  assert.match(askAlternatives("paragraph", "Good.", 0, 5).messages[0].content, /may contain line breaks/);
});

test("alternatives bound context and the output budget for three full passages", () => {
  const passage = "word ".repeat(1000);
  const request = askAlternatives("paragraph", "b".repeat(2000) + passage + "a".repeat(1000), 2000, 2000 + passage.length);
  assert.equal(request.maxTokens, 4000);
  assert.ok(request.messages[0].content.includes(`<context_before>${"b".repeat(1500)}</context_before>`));
  assert.ok(request.messages[0].content.includes(`<context_after>${"a".repeat(500)}</context_after>`));
  assert.equal(askAlternatives("word", "hi", 0, 2).maxTokens, 406);
});

test("alternatives reject malformed, partial and non-string-array answers", () => {
  for (const reply of ["", "good\nbetter", "[\"good\"", '"good"', "null", "{}", '["good", 2]', '["good", null]', '[[]]', 'Here: ["good"]']) {
    assert.deepEqual(alternativeChoices(reply, "fine"), [], reply);
  }
  assert.deepEqual(alternativeChoices("[]", "fine"), []);
});

test("alternatives trim entries, remove empty entries and the original, and deduplicate before limiting", () => {
  const reply = JSON.stringify(["", "  ", "good", " good ", "fine", '"fine"', "<passage>fine</passage>", "better", "best", "great"]);
  assert.deepEqual(alternativeChoices(reply, "  good \n"), ["  fine \n", "  better \n", "  best \n"]);
});

test("alternatives preserve passage whitespace and internal Markdown and line breaks", () => {
  const original = "\t Original.\nAnother line. \n\n";
  const version = "A **different** opening.\n  Another line.\n\nA final thought.";
  assert.deepEqual(alternativeChoices(JSON.stringify([`\n ${version}  \n`]), original), [`\t ${version} \n\n`]);
});

test("alternatives clean accidental passage wrappers and quotes without removing the writer's quotes", () => {
  assert.deepEqual(alternativeChoices(JSON.stringify(['  <passage>clear</passage>  ', '" plain "', "“direct”"]), "good"), ["clear", "plain", "direct"]);
  assert.deepEqual(alternativeChoices(JSON.stringify(['"clear"', '"good"']), '"good"'), ['"clear"']);
});

test("alternatives tolerate one JSON code fence, not arbitrary text around the array", () => {
  assert.deepEqual(alternativeChoices('```json\n["clear", "plain"]\n```', "good"), ["clear", "plain"]);
  assert.deepEqual(alternativeChoices('```\n["clear"]\n```', "good"), ["clear"]);
  assert.deepEqual(alternativeChoices('Choices:\n```json\n["clear"]\n```', "good"), []);
});

test("the existing rewrite and line-list APIs keep their shape", () => {
  const tighten = ACTIONS.find((action) => action.id === "tighten")!;
  const synonyms = ACTIONS.find((action) => action.id === "synonyms")!;
  assert.match(ask(tighten, "really good", 0, 11).system, /Reply with only the revised passage/);
  assert.match(ask(synonyms, "good", 0, 4).system, /up to six alternatives/);
  assert.deepEqual(choices("- fine\n2. great"), ["fine", "great"]);
  assert.equal(clean('"fine"', " good "), " fine ");
});
