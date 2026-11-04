import assert from "node:assert/strict";
import { test } from "node:test";
import { history, undo } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { languages } from "@codemirror/language-data";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { softBreaks } from "../src/soft-breaks.ts";

const start = (doc: string) => EditorState.create({
  doc,
  extensions: [history(), yamlFrontmatter({ content: markdown({ base: markdownLanguage, codeLanguages: languages }) }), softBreaks],
});
const breaks = (state: EditorState) => {
  const out: number[] = [];
  state.field(softBreaks).between(0, state.doc.length, (from, to) => {
    assert.equal(state.sliceDoc(from, to), "\n", "only the newline is replaced");
    out.push(from);
  });
  return out;
};

test("soft-wrapped paragraphs flow without changing the source or selection", () => {
  const doc = "First source line\nsecond with *emphasis\nacross lines*.\n\nAnother paragraph\ncontinues here.";
  const state = start(doc);
  assert.deepEqual(breaks(state), [...doc.matchAll(/(?<!\n)\n(?!\n)/g)].map((m) => m.index));
  for (let anchor = 0; anchor <= doc.length; anchor++) {
    const selected = state.update({ selection: { anchor, head: doc.length } }).state;
    assert.equal(selected.doc.toString(), doc);
    assert.equal(selected.selection.main.anchor, anchor);
    assert.equal(selected.selection.main.head, doc.length);
    assert.equal(selected.field(softBreaks), state.field(softBreaks), "selection never changes the layout");
  }
});

test("hard breaks, code, frontmatter, HTML and structured blocks keep their line endings", () => {
  for (const doc of [
    "First  \nsecond.",
    "First\\\nsecond.",
    "`inline\ncode`",
    "<span\ntitle='a'>text</span>",
    "---\ntitle: First\ndescription: Second\n---",
    "```markdown\nFirst\nsecond\n```",
    "    First\n    second",
    "<div>\nFirst\nsecond\n</div>",
    "> First\n> second",
    "- First\n  second\n- Another",
    "1. First\n   second",
    "# Heading\n\nAnother\n===",
    "First\n\nSecond",
    'import Widget from "./x";\nimport Aside from "./y";',
    'export const data = {\n  title: "Hello"\n}',
    "{items.map(item =>\n  <Widget item={item} />\n)}",
    'import{a} from "./x";\nimport{b} from "./y";',
    "export{foo}\nexport{bar}",
    "<>\n<Item />\n</>",
    "/* comment */\nexport const data = {\n  title: 'Hello'\n}",
  ]) assert.deepEqual(breaks(start(doc)), [], JSON.stringify(doc));
  const mixed = "First  \nsecond\nthird\\\nfourth\nfifth";
  assert.deepEqual(breaks(start(mixed)), [mixed.indexOf("\nthird"), mixed.indexOf("\nfifth")]);
  for (const doc of ["Some `code`\nthen prose.", "Some <u>text</u>\nthen prose."]) {
    assert.deepEqual(breaks(start(doc)), [doc.indexOf("\n")], "a newline after a literal span is still soft");
  }
});

test("background parser advances also refresh the flowing paragraphs", () => {
  const paragraph = "First source line\nsecond line.\n\n";
  let state = EditorState.create({ doc: paragraph.repeat(300), extensions: [markdown(), softBreaks] });
  assert.ok(ensureSyntaxTree(state, state.doc.length, 1000));
  state = state.update({}).state; // the same refresh the parser's worker dispatches
  assert.equal(breaks(state).length, 300);
});

test("typing, splitting a paragraph, and undo update only the live view", () => {
  const doc = "First\nsecond.";
  let state = start(doc);
  state = state.update({ changes: { from: 5, insert: "\n" } }).state;
  assert.deepEqual(breaks(state), []);
  assert.equal(state.doc.toString(), "First\n\nsecond.");
  assert.ok(undo({ state, dispatch: (tr) => { state = tr.state; } }));
  assert.equal(state.doc.toString(), doc);
  assert.deepEqual(breaks(state), [5]);
  state = state.update({ changes: { from: 5, insert: "  " } }).state;
  assert.deepEqual(breaks(state), [], "two trailing spaces make a hard break");
});
