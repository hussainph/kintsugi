import assert from "node:assert/strict";
import { test } from "node:test";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState, type StateCommand } from "@codemirror/state";
import { formatKeymap, setHeading, toggleLink, toggleList, toggleMark, type Mark } from "../src/format.ts";

/** A document with `|` for the cursor, or `[` and `]` around the selection. */
function start(marked: string) {
  const cursor = marked.indexOf("|");
  let doc = marked;
  let selection;
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
  return EditorState.create({ doc, selection, extensions: [markdown({ base: markdownLanguage })] });
}

/** The document after `command`, marked up like `start`'s input. */
function run(command: StateCommand, marked: string, times = 1) {
  let state = start(marked);
  for (let i = 0; i < times; i++) {
    let handled = false;
    command({ state, dispatch: (tr) => { state = tr.state; handled = true; } });
    assert.ok(handled, "the command handled the key");
  }
  const { from, to } = state.selection.main;
  const doc = state.doc.toString();
  return from === to ? doc.slice(0, from) + "|" + doc.slice(from) : doc.slice(0, from) + "[[" + doc.slice(from, to) + "]]" + doc.slice(to);
}

const cases: { mark: Mark; open: string; close: string }[] = [
  { mark: "bold", open: "**", close: "**" },
  { mark: "italic", open: "*", close: "*" },
  { mark: "underline", open: "<u>", close: "</u>" },
  { mark: "code", open: "`", close: "`" },
  { mark: "strike", open: "~~", close: "~~" },
];

for (const { mark, open, close } of cases) {
  const toggle = toggleMark(mark);

  test(`${mark}: wraps a selection and keeps the text selected`, () => {
    assert.equal(run(toggle, "Some [[plain words]] here"), `Some ${open}[[plain words]]${close} here`);
  });

  test(`${mark}: toggling twice gives the text back`, () => {
    assert.equal(run(toggle, "Some [[plain words]] here", 2), "Some [[plain words]] here");
  });

  test(`${mark}: a selection that includes the marks is unwrapped`, () => {
    assert.equal(run(toggle, `Some [[${open}plain words${close}]] here`), "Some [[plain words]] here");
  });

  test(`${mark}: the cursor inside a run removes it`, () => {
    assert.equal(run(toggle, `Some ${open}pla|in${close} here`), "Some pla|in here");
  });

  test(`${mark}: an empty cursor opens a pair, and a second press takes it back`, () => {
    assert.equal(run(toggle, "Some | here"), `Some ${open}|${close} here`);
    assert.equal(run(toggle, "Some | here", 2), "Some | here");
  });

  test(`${mark}: at the end of a run the cursor steps out of it`, () => {
    assert.equal(run(toggle, `Some ${open}word|${close} here`), `Some ${open}word${close}| here`);
  });

  test(`${mark}: the cursor in a word formats the word`, () => {
    assert.equal(run(toggle, "Some wo|rd here"), `Some ${open}wo|rd${close} here`);
  });

  test(`${mark}: spaces at the selection's ends stay outside the marks`, () => {
    assert.equal(run(toggle, "Some[[ plain ]]here"), `Some ${open}[[plain]]${close} here`);
  });

  test(`${mark}: across lines each line is wrapped, past its list marker`, () => {
    assert.equal(run(toggle, "- [[one\n\n- two]]"), `- ${open}[[one${close}\n\n- ${open}two]]${close}`);
    assert.equal(run(toggle, `- [[${open}one${close}\n- ${open}two${close}]]`), "- [[one\n- two]]");
  });
}

test("bold and italic nest", () => {
  assert.equal(run(toggleMark("italic"), "**[[bold]]**"), "***[[bold]]***");
  assert.equal(run(toggleMark("bold"), "***[[both]]***"), "*[[both]]*");
  assert.equal(run(toggleMark("italic"), "***[[both]]***"), "**[[both]]**");
});

test("a run of the same mark inside the selection merges into one", () => {
  assert.equal(run(toggleMark("bold"), "[[one **two** three]]"), "**[[one two three]]**");
});

test("inline code around backticks uses a longer fence", () => {
  assert.equal(run(toggleMark("code"), "[[a `b` c]]"), "``[[a `b` c]]``");
});

test("underline isn't found inside inline code", () => {
  assert.equal(run(toggleMark("underline"), "`<u>a|b</u>`"), "`<u><u>a|b</u></u>`");
});

test("headings set, change and toggle off", () => {
  assert.equal(run(setHeading(2), "A tit|le"), "## A tit|le");
  assert.equal(run(setHeading(1), "## A tit|le"), "# A tit|le");
  assert.equal(run(setHeading(2), "## A tit|le"), "A tit|le");
  assert.equal(run(setHeading(0), "### A tit|le"), "A tit|le");
  assert.equal(run(setHeading(3), "- A tit|le"), "### A tit|le");
});

test("lists toggle on every selected line and replace another list", () => {
  assert.equal(run(toggleList("bullets"), "[[one\n\ntwo]]"), "- [[one\n\n- two]]");
  assert.equal(run(toggleList("bullets"), "- [[one\n- two]]"), "[[one\ntwo]]");
  assert.equal(run(toggleList("numbers"), "- [[one\n- two]]"), "1. [[one\n2. two]]");
  assert.equal(run(toggleList("todo"), "1. [[one\n2. two]]"), "- [ ] [[one\n- [ ] two]]");
  assert.equal(run(toggleList("bullets"), "- [ ] on|e"), "- on|e");
  assert.equal(run(toggleList("todo"), "- [ ] on|e"), "on|e");
  assert.equal(run(toggleList("bullets"), "|"), "- |");
});

test("quotes keep what is inside them", () => {
  assert.equal(run(toggleList("quote"), "- on|e"), "> - on|e");
  assert.equal(run(toggleList("quote"), "> - on|e"), "- on|e");
});

test("a link wraps text with the cursor in the address, or an address with the cursor in the text", () => {
  assert.equal(run(toggleLink, "See [[the post]] now"), "See [the post](|) now");
  assert.equal(run(toggleLink, "See [[https://hussain.ph]] now"), "See [|](https://hussain.ph) now");
  assert.equal(run(toggleLink, "See | now"), "See [|]() now");
  assert.equal(run(toggleLink, "See po|st now"), "See [post](|) now");
  assert.equal(run(toggleLink, "See [the po|st](https://hussain.ph) now"), "See [[the post]] now");
});

test("read-only documents aren't formatted", () => {
  const state = EditorState.create({ doc: "text", extensions: [EditorState.readOnly.of(true)] });
  assert.equal(toggleMark("bold")({ state, dispatch: () => assert.fail() }), false);
});

test("the keymap binds the standard keys and leaves ⌘K and ⌘P to the app", () => {
  const keys = formatKeymap.map((binding) => binding.key);
  for (const key of ["Mod-b", "Mod-i", "Mod-u", "Mod-e", "Mod-Shift-x", "Mod-l", "Mod-Alt-1", "Mod-Alt-0", "Mod-Shift-7", "Mod-Shift-8"]) assert.ok(keys.includes(key), key);
  for (const key of ["Mod-k", "Mod-p", "Mod-Shift-k", "Mod-Shift-p", "Mod-Shift-e", "Mod-=", "Mod--", "Mod-0"]) assert.ok(!keys.includes(key), key);
});
