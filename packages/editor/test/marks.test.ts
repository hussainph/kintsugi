import assert from "node:assert/strict";
import { test } from "node:test";
import { history, undo } from "@codemirror/commands";
import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import {
  acceptMark, applyMarks, clearMarks, cutRange, dismissMark, focusMark, focusedMark, markExtensions, marksOf, onWordBoundaries,
  proseSentences, setMarks, textAfterCuts, type Mark, type MarkBatch,
} from "../src/marks.ts";

function editor(doc: string) {
  let state = EditorState.create({ doc, extensions: [history(), markExtensions(() => undefined)] });
  return {
    get state() { return state; },
    dispatch(spec: TransactionSpec) { state = state.update(spec).state; },
    set state(next: EditorState) { state = next; },
  };
}

const at = (doc: string, words: string, kind: Mark["kind"] = "flag", reason = "why"): Mark => {
  const from = doc.indexOf(words);
  assert.notEqual(from, -1, words);
  return { id: words, range: { from, to: from + words.length }, kind, reason };
};
const batch = (kind: MarkBatch["kind"], doc: string): MarkBatch => ({ id: "b", label: "Test", kind, scope: { from: 0, to: doc.length } });
const ids = (view: { state: EditorState }) => marksOf(view.state).marks.map((m) => m.id);

const DOC = "The bowl is really very old. It was just broken once. Gold fills the seam.";

test("a check marks ranges without changing a character", () => {
  const view = editor(DOC);
  assert.equal(setMarks(view, batch("check", DOC), [at(DOC, "It was just broken once."), at(DOC, "really")], { focus: "first" }), 2);
  assert.equal(view.state.doc.toString(), DOC);
  assert.deepEqual(ids(view), ["really", "It was just broken once."], "in document order");
  assert.equal(focusedMark(view.state)?.id, "really");
  assert.ok(clearMarks(view));
  assert.deepEqual(ids(view), []);
  assert.equal(marksOf(view.state).batch, null);
  assert.equal(view.state.doc.toString(), DOC);
});

test("an edit inside a mark takes it away; an edit elsewhere moves it", () => {
  const view = editor(DOC);
  setMarks(view, batch("check", DOC), [at(DOC, "really"), at(DOC, "Gold")]);
  view.dispatch({ changes: { from: 0, insert: "Yes. " } });
  assert.deepEqual(ids(view), ["really", "Gold"]);
  const gold = marksOf(view.state).marks[1].range;
  assert.equal(view.state.sliceDoc(gold.from, gold.to), "Gold");
  const really = marksOf(view.state).marks[0].range;
  view.dispatch({ changes: { from: really.from + 2, insert: "x" } });
  assert.deepEqual(ids(view), ["Gold"]);
  // Typing right after a mark isn't inside it.
  const g = marksOf(view.state).marks[0].range;
  view.dispatch({ changes: { from: g.to, insert: "en" } });
  assert.deepEqual(ids(view), ["Gold"]);
  // When the last one goes, the batch is done.
  view.dispatch({ changes: { from: g.from, to: g.to } });
  assert.equal(marksOf(view.state).batch, null);
});

test("stepping wraps, and accepting or dismissing moves to the next", () => {
  const view = editor(DOC);
  setMarks(view, batch("check", DOC), [at(DOC, "really"), at(DOC, "just"), at(DOC, "Gold")]);
  view.dispatch({ selection: EditorSelection.cursor(0) });
  assert.ok(focusMark(view, 1));
  assert.equal(focusedMark(view.state)?.id, "really");
  assert.equal(view.state.selection.main.head, DOC.indexOf("really"));
  focusMark(view, -1);
  assert.equal(focusedMark(view.state)?.id, "Gold", "previous wraps to the last");
  focusMark(view, 1);
  assert.equal(focusedMark(view.state)?.id, "really");
  assert.ok(acceptMark(view));
  assert.equal(view.state.doc.toString(), DOC, "accepting a flag changes nothing");
  assert.equal(focusedMark(view.state)?.id, "just");
  assert.ok(dismissMark(view));
  assert.equal(focusedMark(view.state)?.id, "Gold");
  assert.ok(acceptMark(view));
  assert.deepEqual(ids(view), [], "stepped through them all");
  assert.ok(!acceptMark(view));
});

test("a trim's cuts apply as one undoable change; a kept word stays", () => {
  const view = editor(DOC);
  const cuts = ["really ", "very ", "just "].map((w) => at(DOC, w, "cut", ""));
  setMarks(view, batch("trim", DOC), cuts);
  assert.equal(textAfterCuts(view.state, { from: 0, to: DOC.length }), "The bowl is old. It was broken once. Gold fills the seam.");
  assert.ok(dismissMark(view, "very "));
  assert.equal(textAfterCuts(view.state, { from: 0, to: DOC.length }), "The bowl is very old. It was broken once. Gold fills the seam.");
  assert.ok(applyMarks(view));
  assert.equal(view.state.doc.toString(), "The bowl is very old. It was broken once. Gold fills the seam.");
  assert.deepEqual(ids(view), []);
  view.state = undoOnce(view.state);
  assert.equal(view.state.doc.toString(), DOC, "one undo brings every cut back");
});

function undoOnce(state: EditorState): EditorState {
  let next = state;
  undo({ state, dispatch: (tr) => { next = tr.state; } });
  return next;
}

test("accepting one cut deletes just its words", () => {
  const view = editor(DOC);
  setMarks(view, batch("trim", DOC), [at(DOC, "really ", "cut", ""), at(DOC, "just ", "cut", "")]);
  assert.ok(acceptMark(view, "just "));
  assert.equal(view.state.doc.toString(), "The bowl is really very old. It was broken once. Gold fills the seam.");
  assert.deepEqual(ids(view), ["really "]);
});

test("a read-only document can be checked but not cut", () => {
  let state = EditorState.create({ doc: DOC, extensions: [markExtensions(() => undefined), EditorState.readOnly.of(true)] });
  const view = { get state() { return state; }, dispatch(spec: TransactionSpec) { state = state.update(spec).state; } };
  setMarks(view, batch("trim", DOC), [at(DOC, "really ", "cut", "")]);
  assert.ok(!acceptMark(view, "really "));
  assert.ok(!applyMarks(view));
  assert.equal(view.state.doc.toString(), DOC);
});

test("prose sentences leave out the frontmatter, headings and code", () => {
  const text = "---\ntitle: x\n---\n\n# Heading\n\nFirst one. Second one!\n\n```\ncode. here.\n```\n\n- A list item.\n";
  const found = proseSentences(text);
  assert.deepEqual(found.map((s) => [s.n, s.text]), [[1, "First one."], [2, "Second one!"], [3, "A list item."]]);
  for (const s of found) assert.equal(text.slice(s.from, s.to), s.text);
  const from = text.indexOf("Second");
  assert.deepEqual(proseSentences(text, { from, to: from + 6 }).map((s) => s.text), ["Second"], "clipped to a selection");
});

test("a cut closes up the words around it", () => {
  const cut = (text: string, words: string) => {
    const from = text.indexOf(words);
    const range = cutRange(text, { from, to: from + words.length });
    return text.slice(0, range.from) + text.slice(range.to);
  };
  assert.equal(cut("a very good day", "very"), "a good day");
  assert.equal(cut("it was good really.", "really"), "it was good.");
  assert.equal(cut("First. Second one. Third.", "Second one."), "First. Third.");
  assert.equal(cut("First. Last one.", "Last one."), "First.");
  assert.equal(cut("Basically it works.", "Basically"), "it works.");
  assert.equal(cut("It was, really, fine.", "really,"), "It was, fine.");
  assert.ok(onWordBoundaries("unhappy days", { from: 0, to: 7 }));
  assert.ok(!onWordBoundaries("unhappy days", { from: 0, to: 2 }), "a cut inside a word makes a new word");
});
