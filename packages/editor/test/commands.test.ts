import assert from "node:assert/strict";
import { test } from "node:test";
import { history, undo } from "@codemirror/commands";
import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import { EditorView, keymap, showTooltip } from "@codemirror/view";
import { commandExtensions, menuItems, type Commands, type CommandSkill } from "../src/commands.ts";
import { referenceExtensions, paragraphNear, paragraphRange, type KinAnchor, type References } from "../src/references.ts";

const document = { kind: "document", path: "posts/craft.mdx", title: "Craft", status: "draft" } as const;
const clip = { kind: "clip", path: "inspiration/craft.md", title: "Craft clipping", site: "Journal", text: "> Shared passage" } as const;
const steelman: CommandSkill = { name: "steelman", description: "Argue the strongest version of the passage." };

function editor(text = "", options: { references?: References; commands?: Commands } = {}) {
  let state = EditorState.create({
    doc: text,
    selection: EditorSelection.cursor(text.length),
    extensions: [history(), referenceExtensions(() => options.references), commandExtensions(() => options.commands)],
  });
  const view = {
    get state() { return state; },
    dispatch(...specs: TransactionSpec[]) { state = state.update(...specs).state; },
    focus() {},
    contentDOM: { setAttribute() {}, removeAttribute() {} },
  } as unknown as EditorView;
  return {
    view,
    type(text: string) {
      for (const char of text) {
        const head = state.selection.main.head;
        view.dispatch({ changes: { from: head, insert: char }, selection: EditorSelection.cursor(head + 1), userEvent: "input.type" });
      }
    },
    /** Like CodeMirror: bindings in precedence order until one handles it. */
    key(key: string) {
      return state.facet(keymap).flat().filter((binding) => binding.key === key).some((binding) => binding.run?.(view) ?? false);
    },
    menu() { return state.facet(showTooltip).some(Boolean); },
    text() { return state.doc.toString(); },
    head() { return state.selection.main.head; },
  };
}

test("/ opens blocks at a line start or after a space, never mid-word, in YAML or code", () => {
  for (const text of ["", "Some prose ", "- item "]) {
    const e = editor(text);
    e.type("/");
    assert.equal(e.menu(), true, JSON.stringify(text));
  }
  for (const [text, at] of [["and", 3], ["---\ntitle: \n---\n", 11], ["```\n", 4], ["see [[ ", 7]] as const) {
    const e = editor(text);
    e.view.dispatch({ selection: EditorSelection.cursor(at) });
    e.type("/");
    assert.equal(e.menu(), false, JSON.stringify(text));
  }
});

test("a block turns the line into Markdown, as one undoable step", () => {
  const e = editor("A thought ");
  e.type("/h2");
  assert.equal(e.key("Enter"), true);
  assert.equal(e.text(), "## A thought");
  assert.equal(e.menu(), false);
  undo(e.view);
  assert.equal(e.text(), "A thought /h2");
});

test("blocks replace an existing marker, keep indentation and place the cursor", () => {
  const e = editor("  - [ ] task ");
  e.type("/quote");
  e.key("Enter");
  assert.equal(e.text(), "  > task");

  const code = editor("");
  code.type("/code");
  code.key("Enter");
  assert.equal(code.text(), "```\n\n```");
  assert.equal(code.head(), 4);
});

test("a divider under prose stays a divider, not a setext heading", () => {
  const e = editor("Paragraph\n");
  e.type("/divider");
  e.key("Enter");
  assert.equal(e.text(), "Paragraph\n\n---\n");
});

test("a table or callout above prose is kept apart from it", () => {
  const e = editor("\nAfter");
  e.view.dispatch({ selection: EditorSelection.cursor(0) });
  e.type("/table");
  e.key("Enter");
  assert.equal(e.text(), "| Column | Column |\n| --- | --- |\n|  |  |\n\nAfter");
});

test("filtering ranks labels, then words, then keywords; nothing matching closes it", () => {
  assert.equal(menuItems("num", [])[0].kind === "block" && menuItems("num", [])[0].block.id, "numbers");
  assert.equal(menuItems("ul", [])[0].kind === "block" && menuItems("ul", [])[0].block.id, "bullets");
  const e = editor("");
  e.type("/zzzz");
  assert.equal(e.menu(), false);
  assert.equal(e.key("Enter"), false, "Enter falls through once the menu is closed");
});

test("Escape closes the menu and typing on doesn't reopen it", () => {
  const e = editor("");
  e.type("/he");
  assert.equal(e.key("Escape"), true);
  e.type("a");
  assert.equal(e.menu(), false);
  assert.equal(e.text(), "/hea");
});

test("skills follow blocks and run on the paragraph, writing nothing themselves", () => {
  const runs: { skill: CommandSkill; range: { from: number; to: number } | null }[] = [];
  const commands: Commands = { skills: [steelman], onSkill: (skill, range) => runs.push({ skill, range }) };
  const e = editor("Craft takes time. ", { commands });
  e.type("/steel");
  assert.equal(e.key("Enter"), true);
  assert.equal(e.text(), "Craft takes time. ");
  assert.deepEqual(runs, [{ skill: steelman, range: { from: 0, to: 17 } }]);

  const blank = editor("First paragraph.\n\n", { commands });
  blank.type("/steelman");
  blank.key("Enter");
  assert.deepEqual(runs[1].range, { from: 0, to: 16 }, "a blank line runs on the paragraph above");
  assert.equal(menuItems("", [steelman]).at(-1)?.kind, "skill");
});

test("paragraph ranges are trimmed, and empty in YAML or on a blank document", () => {
  const state = EditorState.create({ doc: "---\ntitle: x\n---\n\n  One\ntwo  \n\n" });
  assert.deepEqual(paragraphRange(state, 20), { from: 20, to: 27 });
  assert.equal(paragraphRange(state, 5), null);
  assert.deepEqual(paragraphNear(state, state.doc.length), { from: 20, to: 27 });
});

// --- @ ----------------------------------------------------------------------

const refs = (onKin?: (anchor: KinAnchor) => void): References => ({ sources: [clip, document], onOpen: () => {}, onKin });

test("@ opens the [[ picker and writes the same [[link]]", () => {
  const e = editor("See ", { references: refs() });
  e.type("@cra");
  assert.equal(e.menu(), true);
  e.key("Enter");
  assert.equal(e.text(), "See [[craft]]");
});

test("@Kin comes first, takes itself out and hands Kin the paragraph", () => {
  const asked: KinAnchor[] = [];
  const e = editor("Gold seams show the repair. ", { references: refs((anchor) => asked.push(anchor)) });
  e.type("@");
  assert.equal(e.key("Enter"), true);
  assert.equal(e.text(), "Gold seams show the repair. ");
  assert.deepEqual(asked, [{ from: 0, to: 27, text: "Gold seams show the repair.", fromLine: 1, toLine: 1 }]);

  const typed = editor("Line\n", { references: refs((anchor) => asked.push(anchor)) });
  typed.type("@Kin");
  typed.key("Enter");
  assert.equal(typed.text(), "Line\n");
  assert.equal(asked[1].text, "Line");
});

test("@ stays prose mid-word, after a non-matching space, and without matches", () => {
  const mail = editor("me", { references: refs(() => {}) });
  mail.type("@craft");
  assert.equal(mail.menu(), false);

  const handle = editor("", { references: refs(() => {}) });
  handle.type("@karpathy said");
  assert.equal(handle.menu(), false);
  assert.equal(handle.key("Enter"), false);

  const title = editor("", { references: refs() });
  title.type("@craft clip");
  assert.equal(title.menu(), true, "a space inside a matching title keeps it open");
  title.key("Enter");
  assert.equal(title.text(), "[[inspiration/craft]]");
});

test("Kin is offered only when the host can open it, and Escape sticks", () => {
  const e = editor("", { references: refs() });
  e.type("@");
  e.key("Enter");
  assert.equal(e.text(), "[[craft]]", "without onKin the first row is a reference");

  const dismissed = editor("", { references: refs(() => {}) });
  dismissed.type("@cr");
  dismissed.key("Escape");
  dismissed.type("a");
  assert.equal(dismissed.menu(), false);
});

test("host actions (Ideas for this draft) run without writing, after blocks", () => {
  const ran: string[] = [];
  const ideas = { id: "ideas", label: "Ideas for this draft", description: "Open Ideas filtered to this document" };
  const e = editor("Prose ", { commands: { actions: [ideas], onAction: (action) => ran.push(action.id) } });
  e.type("/ideas");
  assert.equal(e.key("Enter"), true);
  assert.deepEqual(ran, ["ideas"]);
  assert.equal(e.text(), "Prose ");
  assert.equal(menuItems("", [], [ideas]).at(-1)?.kind, "action");
});
