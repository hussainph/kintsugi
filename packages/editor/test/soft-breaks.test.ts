import assert from "node:assert/strict";
import { test } from "node:test";
import { history, undo } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { languages } from "@codemirror/language-data";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import { flowingBreaks, machineWrapped, softBreaks } from "../src/soft-breaks.ts";

const start = (doc: string, anchor = 0) => EditorState.create({
  doc,
  selection: { anchor },
  extensions: [history(), yamlFrontmatter({ content: markdown({ base: markdownLanguage, codeLanguages: languages }) }), softBreaks],
});
const breaks = (state: EditorState) => {
  for (const pos of flowingBreaks(state)) assert.equal(state.sliceDoc(pos, pos + 1), "\n", "only the newline is replaced");
  return flowingBreaks(state);
};
const newlines = (text: string, offset = 0) => [...text.matchAll(/\n/g)].map((m) => m.index + offset);

/** Greedy hard wrap, the way editors and tools wrap at a fixed width. */
const wrap = (text: string, width: number) => {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && line.length + 1 + word.length > width) { lines.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  return [...lines, line].join("\n");
};
const PROSE = "The first time I saw a kintsugi bowl I thought the gold was decoration. It is not. The gold is a decision: this break is part of the object now, and we are not going to pretend otherwise. That is the whole point of the repair, and it is why I keep coming back to it.";
const NOTE = wrap(PROSE, 75);
const LONG = "A line long enough to look like it was wrapped by a tool at the width";

test("a note hard-wrapped at 75 characters flows, without changing the source or selection", () => {
  assert.ok(NOTE.split("\n").length > 3);
  const doc = `# Title\n\n${NOTE}\n\n${wrap(PROSE, 62)}\n\n${wrap(PROSE, 100)}`;
  const state = start(doc);
  assert.deepEqual(breaks(state), [...newlines(NOTE, 9), ...newlines(wrap(PROSE, 62), 11 + NOTE.length), ...newlines(wrap(PROSE, 100), 13 + NOTE.length + wrap(PROSE, 62).length)]);
  for (let anchor = 0; anchor <= doc.length; anchor += 7) {
    const selected = state.update({ selection: { anchor, head: doc.length } }).state;
    assert.equal(selected.doc.toString(), doc);
    assert.deepEqual(breaks(selected), breaks(state), "selection never changes the layout");
  }
});

test("short typed lines keep their line breaks", () => {
  for (const doc of [
    "Roses are red,\nViolets are blue,\nSugar is sweet,\nAnd so are you.",
    "Hussain Phalasiya\n12 Harbour Street\nAmman 11118\nJordan",
    "Things to fix in the second section of the draft today\nThe opening paragraph\nThe ending",
    "A poem whose lines are all\nabout the same length, so\nthe relative test alone\nwould call it wrapped.",
    "Dear Sam,\nI wanted to write to you about the thing that happened yesterday at the workshop.",
    "See:\nhttps://example.com/a/very/long/link/that/fills/the/whole/line/and/more/of/it",
    `${LONG}\nand then a short typed line\n${LONG}`,
    "Single line of text only, with nothing to flow at all in this paragraph.",
  ]) assert.deepEqual(breaks(start(doc)), [], JSON.stringify(doc));
});

test("the last line may be short, and a long link pushed to the next line still counts", () => {
  const last = `${LONG}\n${LONG}\nend.`;
  assert.deepEqual(breaks(start(last)), newlines(last));
  // Wrapped at 80: the first line stops short because the link won't fit.
  const pushed = wrap("Some prose that runs on until a long link comes up https://example.com/a/rather/long/path/to/read to read later, and then it simply carries on.", 80);
  const [first, second] = pushed.split("\n").map((line) => line.length);
  assert.ok(first < 60 && first < 0.85 * second, `the first line is short (${first} of ${second})`);
  assert.deepEqual(breaks(start(pushed)), newlines(pushed));
  assert.equal(machineWrapped(["short", "lines"]), false);
  assert.equal(machineWrapped([LONG]), false, "one line has nothing to flow");
});

test("hard breaks, code, frontmatter, HTML and structured blocks keep their line endings", () => {
  for (const doc of [
    `${LONG}  \n${LONG}`,
    `${LONG}\\\n${LONG}`,
    `\`${LONG}\n${LONG}\``,
    `<span\ntitle='${LONG}'>${LONG}</span>`,
    `---\ntitle: ${LONG}\ndescription: ${LONG}\n---`,
    `\`\`\`markdown\n${LONG}\n${LONG}\n\`\`\``,
    `    ${LONG}\n    ${LONG}`,
    `<div>\n${LONG}\n${LONG}\n</div>`,
    `> ${LONG}\n> ${LONG}`,
    `- ${LONG}\n  ${LONG}\n- Another`,
    `1. ${LONG}\n   ${LONG}`,
    `# Heading\n\n${LONG}\n===`,
    'import Widget from "./a-component-with-a-long-name-for-this-test-case.tsx";\nimport Aside from "./another-component-with-a-long-name-for-this-case.tsx";',
    `export const data = { title: "${LONG}",\n  description: "${LONG}" }`,
    `{items.map(item => <Widget item={item} label="${LONG}" />\n)}`,
    'import{a} from "./a-component-with-a-long-name-for-this-test-case.tsx";\nimport{b} from "./another-component-with-a-long-name-for-this-case.tsx";',
    `<>\n<Item label="${LONG}" />\n</>`,
    `/* ${LONG} */\nexport const data = {\n  title: '${LONG}'\n}`,
  ]) assert.deepEqual(breaks(start(doc)), [], JSON.stringify(doc));
  // Each run between hard breaks is judged on its own.
  const mixed = `short typed line  \n${LONG}\n${LONG}\\\nfourth\nfifth`;
  assert.deepEqual(breaks(start(mixed)), [mixed.indexOf(`\n${LONG}\\`)]);
  for (const doc of [
    `${LONG} \`code\`\nthen prose that carries on long enough to be another wrapped line.`,
    `${LONG} <u>text</u>\nthen prose that carries on long enough to be another wrapped line.`,
    `${LONG}\nimport from elsewhere, which is a phrase and not an MDX import line.`,
    `${LONG}\nexport the draft, which is a phrase and not an MDX export line here.`,
    `${LONG}\nimport data from the web, which is prose and not an import at all.`,
    `${LONG}\n<em>that</em> starts with a tag and goes on as ordinary prose text.`,
    `${LONG}\n{x} starts with an expression and goes on as ordinary prose text.`,
  ]) {
    assert.deepEqual(breaks(start(doc)), [doc.indexOf("\n")], JSON.stringify(doc));
  }
});

test("background parser advances also refresh the flowing paragraphs", () => {
  const paragraph = `${LONG}\n${LONG}.\n\n`;
  let state = EditorState.create({ doc: paragraph.repeat(300), extensions: [markdown(), softBreaks] });
  assert.ok(ensureSyntaxTree(state, state.doc.length, 1000));
  state = state.update({}).state; // the same refresh the parser's worker dispatches
  assert.equal(breaks(state).length, 300);
});

const apply = (state: EditorState, spec: TransactionSpec) => state.update(spec).state;
const enter = (state: EditorState, at: number) => apply(state, { changes: { from: at, insert: "\n" }, selection: { anchor: at + 1 }, userEvent: "input" });

test("Enter typed mid-paragraph shows a new line at once, and keeps showing", () => {
  const doc = `${NOTE}\n\nAnother paragraph.`;
  let state = start(doc);
  const before = breaks(state);
  const at = NOTE.indexOf("decision:") + "decision:".length;
  state = enter(state, at);
  assert.equal(state.doc.toString(), doc.slice(0, at) + "\n" + doc.slice(at));
  assert.ok(!breaks(state).includes(at), "the new line shows straight away");
  assert.deepEqual(breaks(state), before.map((pos) => (pos > at ? pos + 1 : pos)), "the rest of the paragraph holds still");
  // Typing on, and leaving the paragraph, never collapses the line he broke.
  state = apply(state, { changes: { from: at + 1, insert: "So " }, selection: { anchor: at + 4 }, userEvent: "input.type" });
  assert.ok(!breaks(state).includes(at));
  state = apply(state, { selection: { anchor: state.doc.length } });
  assert.ok(!breaks(state).includes(at), "still a new line once the cursor leaves");
  assert.equal(state.doc.toString().split("\n\n")[0].split("\n").length, NOTE.split("\n").length + 1);

  // Even where the rule would flow it: every line is long after his Enter.
  const long = `${LONG} ${LONG}\n${LONG}.\n\nNext.`;
  state = enter(start(long), LONG.length + 1);
  state = apply(state, { selection: { anchor: state.doc.length } });
  assert.equal(state.doc.toString(), `${LONG} \n${LONG}\n${LONG}.\n\nNext.`);
  assert.deepEqual(breaks(state), [2 * LONG.length + 2], "his line stays; the wrapped one flows");
  assert.deepEqual(breaks(start(state.doc.toString(), 0)), [LONG.length + 1, 2 * LONG.length + 2], "after a reload, the rule alone decides");
});

test("the paragraph being edited holds its layout until the cursor leaves", () => {
  const doc = `${NOTE}\n\nAnother paragraph.`;
  let state = start(doc, 3);
  const before = breaks(state);
  assert.ok(before.length > 0);
  // Cut the first line short: by the rule it no longer looks wrapped.
  const cut = NOTE.indexOf("\n") - 20;
  state = apply(state, { changes: { from: cut, to: NOTE.indexOf("\n") }, selection: { anchor: cut }, userEvent: "delete.backward" });
  assert.deepEqual(breaks(state), before.map((pos) => pos - 20), "nothing re-wraps while he edits");
  state = apply(state, { selection: { anchor: state.doc.length } });
  assert.deepEqual(breaks(state), [], "judged afresh once he moves on");
});

test("pasted hard-wrapped text flows; undoing a typed Enter restores the flow", () => {
  let state = start("Intro.\n\n", 8);
  state = apply(state, { changes: { from: 8, insert: NOTE }, selection: { anchor: 8 + NOTE.length }, userEvent: "input.paste" });
  assert.deepEqual(breaks(state), newlines(NOTE, 8), "flows straight away");
  state = apply(state, { selection: { anchor: 0 } });
  assert.deepEqual(breaks(state), newlines(NOTE, 8));
  assert.equal(state.doc.toString(), `Intro.\n\n${NOTE}`);

  const doc = `${LONG}\n${LONG}.`;
  state = start(doc);
  state = enter(state, 10);
  assert.ok(!breaks(state).includes(10));
  assert.ok(undo({ state, dispatch: (tr) => { state = tr.state; } }));
  assert.equal(state.doc.toString(), doc);
  state = apply(state, { selection: { anchor: doc.length } });
  assert.deepEqual(breaks(state), [LONG.length]);
  state = apply(state, { changes: { from: LONG.length, insert: "  " } });
  assert.deepEqual(breaks(state), [], "two trailing spaces make a hard break");
});
