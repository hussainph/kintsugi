import assert from "node:assert/strict";
import { test } from "node:test";
import { EditorSelection, EditorState } from "@codemirror/state";
import { wordCount } from "@kintsugi/core/frontmatter";
import { dimExtensions } from "../src/dim.ts";
import { documentCounts } from "../src/counts.ts";

function start(doc: string) {
  return EditorState.create({ doc, extensions: [EditorState.allowMultipleSelections.of(true), dimExtensions("draft.md"), documentCounts] });
}
const counts = (state: EditorState) => state.field(documentCounts);
const select = (state: EditorState, from: number, to: number) => state.update({ selection: { anchor: from, head: to } }).state;

test("selection counts automatically, in either direction; a cursor restores the total", () => {
  const state = start("One two three.");
  assert.equal(counts(state).words, 3);
  assert.equal(counts(state).selection, null);
  for (const [from, to] of [[0, 7], [7, 0]]) {
    const selected = select(state, from, to);
    assert.deepEqual(counts(selected).selection, { words: 2, characters: 7 });
    assert.equal(counts(selected).snapshot, counts(state).snapshot, "selection reuses the document cache");
    assert.equal(counts(select(selected, 4, 4)).selection, null);
  }
});

test("multiple ranges sum independently, ignoring empty cursors", () => {
  const state = start("One two three.");
  const selected = state.update({ selection: EditorSelection.create([
    EditorSelection.range(0, 3), EditorSelection.cursor(5), EditorSelection.range(8, 13),
  ]) }).state;
  assert.deepEqual(counts(selected).selection, { words: 2, characters: 8 });
  assert.equal(counts(selected).words, 3);
});

test("frontmatter never counts, including CRLF and a selection crossing its boundary", () => {
  for (const doc of ["---\ntitle: Hidden words\n---\n\nBody words.", "---\r\ntitle: Hidden words\r\n---\r\nBody words.", "---\ntitle: Hidden\n---"]) {
    const state = start(doc);
    const bodyFrom = counts(state).snapshot.bodyFrom;
    assert.deepEqual(counts(select(state, 0, bodyFrom)).selection, { words: 0, characters: 0 });
    assert.equal(counts(select(state, 0, state.doc.length)).selection?.words, wordCount(doc));
  }
});

test("word rules match the draft: Unicode, apostrophes, hyphens, numbers, code and dimmed text", () => {
  const doc = "Élan don't re-enter 42 中文 😀.\nOne<!-- hidden -->two.\n{/* aside */}\n%%aside%%\n`<!-- literal -->`";
  const state = start(doc);
  assert.equal(counts(state).words, wordCount(doc));
  assert.equal(counts(select(state, 0, doc.length)).selection?.words, wordCount(doc));
  const hidden = doc.indexOf("hidden");
  assert.deepEqual(counts(select(state, hidden, hidden + 6)).selection, { words: 0, characters: 6 });
  const emoji = doc.indexOf("😀");
  assert.deepEqual(counts(select(state, emoji, emoji + 2)).selection, { words: 0, characters: 1 });
  assert.deepEqual(counts(select(state, 0, 2)).selection, { words: 1, characters: 2 }, "a partial word counts as one");
});

test("whitespace selection still shows its characters", () => {
  assert.deepEqual(counts(select(start("One \n two"), 3, 6)).selection, { words: 0, characters: 3 });
});

test("typing, deleting, multiple edits, frontmatter and comment changes agree with the full draft count", () => {
  let state = start("---\ntitle: Draft\n---\n\nOne two.\nThree four.\nFive six.");
  const check = () => assert.equal(counts(state).words, wordCount(state.doc.toString()), state.doc.toString());
  check();
  const changes = [
    { from: state.doc.length, insert: " seven" },
    { from: 25, to: 28, insert: "" },
    { from: 25, insert: "new\nlines\n" },
    [{ from: 25, insert: "first " }, { from: 37, insert: "second " }],
    { from: 0, to: 4, insert: "" },
    { from: 0, insert: "<!-- " },
    { from: 20, insert: " -->" },
  ];
  for (const change of changes) {
    state = state.update({ changes: change }).state;
    check();
  }
  state = state.update({ changes: { from: 0, to: state.doc.length, insert: "Replacement draft." }, selection: { anchor: 0, head: 11 } }).state;
  check();
  assert.deepEqual(counts(state).selection, { words: 1, characters: 11 });
});

test("incremental line windows agree with the full count across deterministic edits", () => {
  let state = start("---\ntitle: Draft\n---\n\n" + "One two three.\n".repeat(100));
  let seed = 113;
  const random = (max: number) => ((seed = (seed * 1664525 + 1013904223) >>> 0) % max);
  const inserts = ["", "word", " ", "\n", "don't", "中文", "---", "<!--", "-->", "%%", "`"];
  for (let i = 0; i < 300; i++) {
    const from = random(state.doc.length + 1);
    const to = Math.min(state.doc.length, from + random(8));
    state = state.update({ changes: { from, to, insert: inserts[random(inserts.length)] } }).state;
    assert.equal(counts(state).words, wordCount(state.doc.toString()), `edit ${i}`);
  }
});
