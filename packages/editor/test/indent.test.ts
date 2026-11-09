import assert from "node:assert/strict";
import { test } from "node:test";
import { history, undo, redo } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { EditorSelection, EditorState, type StateCommand } from "@codemirror/state";
import { indentLines, outdentLines } from "../src/indent.ts";

function start(marked: string, readOnly = false) {
  const at = marked.indexOf("|");
  return EditorState.create({
    doc: marked.replace("|", ""), selection: EditorSelection.cursor(at),
    extensions: [EditorState.allowMultipleSelections.of(true), history(), yamlFrontmatter({ content: markdown({ base: markdownLanguage }) }), EditorState.readOnly.of(readOnly)],
  });
}
function run(state: EditorState, command: StateCommand) {
  command({ state, dispatch: (tr) => { state = tr.state; } });
  return state;
}
function marked(state: EditorState) {
  const at = state.selection.main.head, text = state.doc.toString();
  return text.slice(0, at) + "|" + text.slice(at);
}

for (const [before, after] of [
  ["A li|ne", "  A li|ne"],
  ["|", "  |"],
  ["- Parent\n- Ch|ild\n- Last", "- Parent\n  - Ch|ild\n- Last"],
  ["- [ ] Parent\n- [x] Ch|ild", "- [ ] Parent\n  - [x] Ch|ild"],
  ["1. Parent\n2. Ch|ild\n3. Last", "1. Parent\n   1. Ch|ild\n2. Last"],
  ["9. Parent\n10. Ch|ild\n11. Last", "9. Parent\n   1. Ch|ild\n10. Last"],
  ["10. Parent\n11. Ch|ild\n12. Last", "10. Parent\n    1. Ch|ild\n11. Last"],
  ["- Parent\n- Ch|ild\n  continuation\n  - Grandchild\n- Last", "- Parent\n  - Ch|ild\n    continuation\n    - Grandchild\n- Last"],
  ["1. Parent\n   1. Existing\n2. Ch|ild\n3. Last", "1. Parent\n   1. Existing\n   2. Ch|ild\n2. Last"],
  ["---\nkey:| value\n---\n\nBody", "---\n  key:| value\n---\n\nBody"],
  ["```\n- not a li|st\n```", "```\n  - not a li|st\n```"],
]) test(`Tab: ${JSON.stringify(before)}`, () => {
  const state = run(start(before), indentLines);
  assert.equal(marked(state), after);
  assert.equal(marked(run(state, undo)), before, "one undo restores everything");
  assert.equal(marked(run(run(state, undo), redo)), after);
});

for (const [before, after] of [
  ["  A li|ne", "A li|ne"],
  [" A li|ne", "A li|ne"],
  ["\tA li|ne", "  A li|ne"],
  ["- Parent\n  - Ch|ild\n    - Grandchild\n- Last", "- Parent\n- Ch|ild\n  - Grandchild\n- Last"],
  ["1. Parent\n   1. Ch|ild\n2. Last", "1. Parent\n2. Ch|ild\n3. Last"],
  ["10. Parent\n    1. Ch|ild\n11. Last", "10. Parent\n11. Ch|ild\n12. Last"],
]) test(`Shift-Tab: ${JSON.stringify(before)}`, () => assert.equal(marked(run(start(before), outdentLines)), after));

test("top-level outdent and first-item indent consume Tab without changing text", () => {
  for (const command of [indentLines, outdentLines]) assert.equal(marked(run(start("- Fi|rst\n- Second"), command)), "- Fi|rst\n- Second");
  assert.equal(marked(run(start("Te|xt"), outdentLines)), "Te|xt");
});

test("selected lines exclude an end at the next line start, and retain selection", () => {
  let state = start("|one\ntwo\nthree");
  state = state.update({ selection: EditorSelection.range(0, 8) }).state;
  state = run(state, indentLines);
  assert.equal(state.doc.toString(), "  one\n  two\nthree");
  assert.equal(state.sliceDoc(state.selection.main.from, state.selection.main.to), "one\n  two\n");
  assert.equal(run(state, outdentLines).doc.toString(), "one\ntwo\nthree");
});

test("selected siblings nest together and renumber once", () => {
  let state = start("1. Parent\n2. One\n3. Two\n4. Last|");
  state = state.update({ selection: EditorSelection.range(10, 22) }).state;
  state = run(state, indentLines);
  assert.equal(state.doc.toString(), "1. Parent\n   1. One\n   2. Two\n2. Last");
  assert.equal(run(state, outdentLines).doc.toString(), "1. Parent\n2. One\n3. Two\n4. Last");
});

test("multiple selections touching one line indent it once", () => {
  let state = start("a|bc\ndef");
  state = state.update({ selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(2), EditorSelection.cursor(5)]) }).state;
  state = run(state, indentLines);
  assert.equal(state.doc.toString(), "  abc\n  def");
});

test("read-only documents are unchanged", () => {
  const state = start("1. Parent\n2. Ch|ild", true);
  assert.equal(run(state, indentLines), state);
  assert.equal(run(state, outdentLines), state);
});

test("quoted lists nest inside the quote and move their children", () => {
  const before = "> 1. Parent\n> 2. Ch|ild\n>    - Grandchild\n> 3. Last";
  const nested = run(start(before), indentLines);
  assert.equal(marked(nested), "> 1. Parent\n>    1. Ch|ild\n>       - Grandchild\n> 2. Last");
  assert.equal(marked(run(nested, outdentLines)), before);
});

test("nested ordered lists start at one when nesting another level", () => {
  const state = start("- Parent\n  1. One\n  2. Ch|ild\n  3. Last");
  assert.equal(marked(run(state, indentLines)), "- Parent\n  1. One\n     1. Ch|ild\n  2. Last");
});

test("Tab works beyond the initial parse viewport", () => {
  const state = start("A paragraph.\n\n".repeat(1500) + "1. Parent\n2. Ch|ild\n3. Last");
  assert.ok(marked(run(state, indentLines)).endsWith("1. Parent\n   1. Ch|ild\n2. Last"));
});

test("renumbering across a digit boundary retains child lists and continuation lines", () => {
  const before = "9. A\n   1. Ch|ild\n      continuation\n      - Grandchild\n10. B";
  const after = "9. A\n10. Ch|ild\n    continuation\n    - Grandchild\n11. B";
  const state = run(start(before), outdentLines);
  assert.equal(marked(state), after);
  assert.equal(marked(run(state, undo)), before);
});

test("a no-op selected parent does not suppress an independently selected child", () => {
  let state = start("- Pa|rent\n  - Child");
  state = state.update({ selection: EditorSelection.create([EditorSelection.cursor(4), EditorSelection.cursor(state.doc.length)]) }).state;
  assert.equal(run(state, outdentLines).doc.toString(), "- Parent\n- Child");
});

for (const [parent, spaces] of [["-\tParent", 4], ["-     Parent", 2]] as const) test(`Markdown padding: ${JSON.stringify(parent)}`, () => {
  assert.equal(marked(run(start(`${parent}\n- Ch|ild`), indentLines)), `${parent}\n${" ".repeat(spaces)}- Ch|ild`);
});

test("a cold large document parses the tail list before changing it", () => {
  const state = start("Paragraph *emphasis* [link](https://example.com) and **bold** with `code`.\n\n".repeat(10_000) + "1. Parent\n2. Ch|ild\n3. Last");
  assert.ok(marked(run(state, indentLines)).endsWith("1. Parent\n   1. Ch|ild\n2. Last"));
});

for (const content of ["  > Quote", "  ```\n  > literal\n  ```"]) test(`moving a subtree keeps descendant quote/fence content: ${JSON.stringify(content)}`, () => {
  const before = `- Parent\n- Ch|ild\n${content}\n- Last`;
  const nested = run(start(before), indentLines);
  assert.equal(marked(nested), `- Parent\n  - Ch|ild\n${content.split("\n").map((l) => "  " + l).join("\n")}\n- Last`);
  assert.equal(marked(run(nested, outdentLines)), before);
});

for (const [before, after] of [
  ["1. Parent\n  2. Ch|ild\n3. Last", "1. Parent\n   1. Ch|ild\n2. Last"],
  ["> 1. Parent\n>   2. Ch|ild\n> 3. Last", "> 1. Parent\n>    1. Ch|ild\n> 2. Last"],
  ["1. Parent\n2.|\n   - Grandchild\n3. Last", "1. Parent\n   1.|\n      - Grandchild\n2. Last"],
]) test(`optional spaces and empty markers: ${JSON.stringify(before)}`, () => assert.equal(marked(run(start(before), indentLines)), after));

test("selected siblings with optional indentation share a destination column", () => {
  let state = start("1. Parent\n  2. One\n3. Two\n4. Last|");
  state = state.update({ selection: EditorSelection.range(10, 24) }).state;
  assert.equal(run(state, indentLines).doc.toString(), "1. Parent\n   1. One\n   2. Two\n2. Last");
});
