import assert from "node:assert/strict";
import { test } from "node:test";
import { history, undo, redo, deleteCharBackward } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState, type StateCommand, type Transaction } from "@codemirror/state";
import { dimExtensions, dimmedRanges, isDimmed, toggleDim } from "../src/dim.ts";
import { formatKeymap, formatShortcuts } from "../src/format.ts";

/** A document with `|` for the cursor, or `[[` and `]]` around the selection. */
function start(marked: string, path = "notes/a.md") {
  let doc = marked;
  let selection;
  const cursor = marked.indexOf("|");
  if (cursor >= 0) {
    doc = marked.replace("|", "");
    selection = EditorSelection.cursor(cursor);
  } else {
    const from = marked.indexOf("[[");
    doc = marked.replace("[[", "");
    const to = doc.indexOf("]]");
    doc = doc.replace("]]", "");
    selection = EditorSelection.range(from, to);
  }
  return EditorState.create({ doc, selection, extensions: [history(), markdown({ base: markdownLanguage }), dimExtensions(path)] });
}

function show(state: EditorState) {
  const { from, to } = state.selection.main;
  const doc = state.doc.toString();
  return from === to ? doc.slice(0, from) + "|" + doc.slice(from) : doc.slice(0, from) + "[[" + doc.slice(from, to) + "]]" + doc.slice(to);
}

function apply(state: EditorState, command: StateCommand) {
  let next: EditorState | null = null;
  command({ state, dispatch: (tr: Transaction) => { next = tr.state; } });
  return next as EditorState | null;
}

const dim = (marked: string, path?: string) => show(apply(start(marked, path), toggleDim)!);

test("⌘/ dims the selection, in the file's own comment syntax", () => {
  assert.equal(dim("Keep [[this part]] here."), "Keep <!-- [[this part]] --> here.");
  assert.equal(dim("Keep [[this part]] here.", "posts/a.mdx"), "Keep {/* [[this part]] */} here.");
});

test("with no selection it dims the cursor's line, marker and all", () => {
  assert.equal(dim("One.\n\nTwo |words.\n\nThree."), "One.\n\n<!-- Two |words. -->\n\nThree.");
  assert.equal(dim("- one\n- tw|o\n- three"), "- one\n<!-- - tw|o -->\n- three");
  assert.equal(dim("## Head|ing", "a.mdx"), "{/* ## Head|ing */}");
  assert.equal(dim("> quoted |line"), "> <!-- quoted |line -->");
  assert.equal(dim("End of line.|"), "<!-- End of line.| -->");
  assert.equal(dim("|Start of line."), "<!-- |Start of line. -->");
});

test("a selection over several lines dims each line", () => {
  assert.equal(dim("[[- one\n- two]]\n- three"), "<!-- [[- one -->\n<!-- - two]] -->\n- three");
  assert.equal(dim("Fir[[st.\n\nSec]]ond."), "Fir<!-- [[st. -->\n\n<!-- Sec]] -->ond.");
});

test("blank lines, code and frontmatter aren't dimmed", () => {
  assert.equal(apply(start("One.\n|\nTwo."), toggleDim), null);
  assert.equal(apply(start("```\nco|de\n```"), toggleDim), null);
  assert.equal(apply(start("---\ntitle: |A\n---\n\nBody."), toggleDim), null);
  assert.equal(apply(start("Use `co[[de` and]] this."), toggleDim), null, "a part that cuts into code");
});

test("⌘/ inside or beside dimmed text undims it", () => {
  assert.equal(dim("Keep <!-- this| part --> here."), "Keep this| part here.");
  assert.equal(dim("Keep {/* this part */}| here."), "Keep this part| here.");
  assert.equal(dim("%%aside%% and |<!-- more -->"), "%%aside%% and |more");
  assert.equal(dim("Keep <!--tight|--> here."), "Keep tight| here.");
  assert.equal(dim("[[a <!-- b --> c {/* d */}]]"), "[[a b c d]]");
});

test("dim, then undim, round-trips, and undo works both ways", () => {
  const original = start("Keep [[this part]] here.");
  const dimmed = apply(original, toggleDim)!;
  assert.ok(isDimmed(dimmed, dimmed.selection.main.from, dimmed.selection.main.to));
  const undimmed = apply(dimmed, toggleDim)!;
  assert.equal(show(undimmed), "Keep [[this part]] here.");
  const back = apply(undimmed, undo)!;
  assert.equal(back.doc.toString(), "Keep <!-- this part --> here.");
  const before = apply(back, undo)!;
  assert.equal(before.doc.toString(), "Keep this part here.");
  assert.equal(apply(before, redo)!.doc.toString(), "Keep <!-- this part --> here.");
});

test("finds every comment form and its text", () => {
  const state = start("|A <!-- b --> c {/* d */} e %%f%%");
  const text = state.doc.toString();
  assert.deepEqual(dimmedRanges(state).map((s) => text.slice(s.inner, s.innerTo)), ["b", "d", "f"]);
});

test("⌫ on a hidden opening marker undims; a cut from outside keeps the rest dimmed", () => {
  // The atomic marker means ⌫ at the passage's start deletes all of `<!-- `.
  const state = start("Keep <!-- this --> here.");
  const at = state.doc.toString().indexOf("this");
  const s1 = state.update({ changes: { from: at - 5, to: at }, userEvent: "delete.backward" }).state;
  assert.equal(s1.doc.toString(), "Keep this here.");
  const s2 = state.update({ changes: { from: 2, to: at + 2 }, userEvent: "delete.selection" }).state;
  assert.equal(s2.doc.toString(), "Ke<!-- is --> here.");
  const end = state.doc.toString().indexOf(" here");
  const s3 = state.update({ changes: { from: at + 2, to: end }, userEvent: "delete.selection" }).state;
  assert.equal(s3.doc.toString(), "Keep <!-- th --> here.");
  // Plain char deletion with the stock command still works outside.
  const plain = start("Ab|c <!-- d -->");
  assert.equal(apply(plain, deleteCharBackward)!.doc.toString(), "Ac <!-- d -->");
});

test("⌘/ is the dim key, listed with the formatting keys", () => {
  assert.ok(formatKeymap.some((b) => b.key === "Mod-/" && b.run === toggleDim));
  assert.ok(formatShortcuts.some((s) => s.key === "Mod-/" && s.label === "Dim"));
});
