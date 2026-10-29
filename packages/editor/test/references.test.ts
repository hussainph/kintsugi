import assert from "node:assert/strict";
import { test } from "node:test";
import { history, undo, redo } from "@codemirror/commands";
import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import { EditorView, keymap, showTooltip } from "@codemirror/view";
import { currentParagraph, referenceExtensions, refreshReferences, type References } from "../src/references.ts";

const document = { kind: "document", path: "posts/craft.mdx", title: "Craft", status: "draft" } as const;
const clip = { kind: "clip", path: "inspiration/craft.md", title: "Craft clipping", site: "Journal", text: "> Shared passage" } as const;
const config: References = { sources: [clip, document], onOpen: () => {} };

function editor(text = "", references: References = config) {
  let state = EditorState.create({ doc: text, selection: EditorSelection.cursor(text.length), extensions: [history(), referenceExtensions(() => references)] });
  const view = {
    get state() { return state; },
    dispatch(spec: TransactionSpec) { state = state.update(spec).state; },
    focus() {},
  } as unknown as EditorView;
  return {
    view,
    type(text: string) { const head = state.selection.main.head; view.dispatch({ changes: { from: head, insert: text }, selection: EditorSelection.cursor(head + text.length), userEvent: "input.type" }); },
    key(key: string) {
      const binding = state.facet(keymap).flat().find((binding) => binding.key === key);
      return binding?.run?.(view) ?? false;
    },
    picker() { return state.facet(showTooltip).some(Boolean); },
    text() { return state.doc.toString(); },
  };
}

test("typing [[ opens a keyboard picker with documents before clips", () => {
  const e = editor();
  e.type("[[");
  assert.equal(e.picker(), true);
  assert.equal(e.key("Enter"), true);
  assert.equal(e.text(), "[[craft]]");
  assert.equal(e.picker(), false);
});

test("keyboard navigation can choose/quote a colliding clip, with one-step undo/redo", () => {
  const e = editor("A thought. ");
  e.type("[[");
  e.key("ArrowDown");
  e.key("Shift-Enter");
  assert.equal(e.text(), "A thought. \n\n> Shared passage\n>\n> [[inspiration/craft]]");
  assert.equal(undo(e.view), true);
  assert.equal(e.text(), "A thought. [[");
  assert.equal(redo(e.view), true);
  assert.ok(e.text().includes("> Shared passage"));
});

test("Escape dismisses without inserting, and picker does not steal normal Enter", () => {
  const e = editor();
  assert.equal(e.key("Enter"), false);
  e.type("[[");
  assert.equal(e.key("Escape"), true);
  assert.equal(e.picker(), false);
  assert.equal(e.text(), "[[");
});

test("completion avoids YAML, fenced/inline code and escaped brackets", () => {
  for (const text of ["---\ntitle: \n---\n", "```md\n", "\\", "`code ` "]) {
    const e = editor(text);
    if (text.startsWith("---")) e.view.dispatch({ selection: EditorSelection.cursor(11) });
    if (text.startsWith("`code")) { e.view.dispatch({ selection: EditorSelection.cursor(3) }); }
    e.type("[[");
    assert.equal(e.picker(), false, text);
  }
});

test("editing an existing target replaces the complete link, not its suffix", () => {
  const e = editor("Read [[crazy-old-target]] next.");
  e.view.dispatch({ selection: EditorSelection.cursor(10) });
  assert.equal(e.picker(), true);
  e.key("Enter");
  assert.equal(e.text(), "Read [[craft]] next.");
});

test("source refresh updates completion but does not throw away document history", () => {
  const local: References = { ...config, sources: [] };
  const e = editor("", local);
  e.type("[[");
  local.sources = config.sources;
  e.view.dispatch({ effects: refreshReferences.of(null) });
  e.key("Enter");
  assert.equal(e.text(), "[[craft]]");
  undo(e.view);
  assert.equal(e.text(), "[[");
});

test("paragraph reporting excludes frontmatter and follows the primary cursor", () => {
  const text = "---\ntitle: Craft\n---\n\nFirst line\nwrapped line\n\nNext paragraph";
  const e = editor(text);
  assert.equal(currentParagraph(e.view.state), "Next paragraph");
  e.view.dispatch({ selection: EditorSelection.cursor(text.indexOf("wrapped")) });
  assert.equal(currentParagraph(e.view.state), "First line\nwrapped line");
  e.view.dispatch({ selection: EditorSelection.cursor(8) });
  assert.equal(currentParagraph(e.view.state), "");
});

test("link generation still sees collisions beyond the first forty picker rows", () => {
  const many: References = { ...config, sources: Array.from({ length: 50 }, (_, index) => ({ kind: "document", path: `a${index}.md`, title: `A ${index}` })) };
  many.sources.push(document, clip);
  const e = editor("", many);
  e.type("[[clipping");
  e.key("Enter");
  assert.equal(e.text(), "[[inspiration/craft]]");
});
