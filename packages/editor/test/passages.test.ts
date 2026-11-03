import assert from "node:assert/strict";
import { test } from "node:test";
import { history, undo } from "@codemirror/commands";
import { EditorState, Transaction } from "@codemirror/state";
import { heldPassage, heldPassages, holdPassage, releasePassage } from "../src/passages.ts";

const DOC = "A pencil is a tool.\n\nThe repair is the point.\n\nKilns teach patience.\n";
const PASSAGE = "The repair is the point.";

const held = (doc = DOC) => {
  let state = EditorState.create({ doc, extensions: [history(), heldPassages] });
  const from = doc.indexOf(PASSAGE);
  const { id, effect } = holdPassage(from, from + PASSAGE.length);
  state = state.update({ effects: effect }).state;
  return { state, id, from };
};

test("a held passage follows text added or removed above it", () => {
  let { state, id, from } = held();
  // Phone sync or an outside edit lands above the passage while Kin thinks.
  state = state.update({ changes: { from: 0, insert: "New opening.\n\n" }, annotations: Transaction.remote.of(true) }).state;
  const moved = heldPassage(state, id, PASSAGE);
  assert.deepEqual(moved, { from: from + 14, to: from + 14 + PASSAGE.length });
  // The frozen range now reads other words; the held one still reads the passage.
  assert.notEqual(state.sliceDoc(from, from + PASSAGE.length), PASSAGE);

  // Accepting replaces the passage, not whatever now sits at the old offsets.
  state = state.update({ changes: { ...moved!, insert: "The repair matters." } }).state;
  assert.equal(state.doc.toString(), "New opening.\n\nA pencil is a tool.\n\nThe repair matters.\n\nKilns teach patience.\n");

  ({ state, id, from } = held());
  state = state.update({ changes: { from: 0, to: "A pencil is a tool.\n\n".length } }).state;
  assert.deepEqual(heldPassage(state, id, PASSAGE), { from: 0, to: PASSAGE.length });
});

test("the old offsets landing on the same words don't fool it", () => {
  // A repeated line pasted above slides an identical copy under the old range.
  const doc = `${PASSAGE}\n\n${PASSAGE}\n`;
  let state = EditorState.create({ doc, extensions: [heldPassages] });
  const from = doc.lastIndexOf(PASSAGE);
  const { id, effect } = holdPassage(from, from + PASSAGE.length);
  state = state.update({ effects: effect }).state;
  const shift = `${PASSAGE}\n\n`.length;
  state = state.update({ changes: { from: 0, insert: `${PASSAGE}\n\n` } }).state;
  assert.equal(state.sliceDoc(from, from + PASSAGE.length), PASSAGE);
  assert.deepEqual(heldPassage(state, id, PASSAGE), { from: from + shift, to: from + shift + PASSAGE.length });
});

test("an undo above the passage moves it back", () => {
  // An edit made before ⌘K, undone while the popover is open.
  let state = EditorState.create({ doc: DOC, extensions: [history(), heldPassages] });
  state = state.update({ changes: { from: 0, insert: "Draft: " } }).state;
  const from = state.doc.toString().indexOf(PASSAGE);
  const { id, effect } = holdPassage(from, from + PASSAGE.length);
  state = state.update({ effects: effect }).state;
  let after = state;
  assert.ok(undo({ state, dispatch: (tr) => (after = tr.state) }));
  assert.equal(after.doc.toString(), DOC);
  assert.deepEqual(heldPassage(after, id, PASSAGE), { from: from - 7, to: from - 7 + PASSAGE.length });
});

test("a passage edited, deleted or released is refused", () => {
  const { state, id, from } = held();
  const edited = state.update({ changes: { from: from + 4, to: from + 10, insert: "seam" } }).state;
  assert.equal(heldPassage(edited, id, PASSAGE), null);
  const gone = state.update({ changes: { from: from - 1, to: from + PASSAGE.length + 1 } }).state;
  assert.equal(heldPassage(gone, id, PASSAGE), null);
  assert.equal(heldPassage(state.update({ effects: releasePassage(id) }).state, id, PASSAGE), null);
  // Another document's state never held it.
  assert.equal(heldPassage(EditorState.create({ doc: DOC, extensions: [heldPassages] }), id, PASSAGE), null);
  // Typing right at its edges stays outside it.
  const typed = state.update({ changes: [{ from, insert: "So. " }, { from: from + PASSAGE.length, insert: " Yes." }] }).state;
  assert.deepEqual(heldPassage(typed, id, PASSAGE), { from: from + 4, to: from + 4 + PASSAGE.length });
});
