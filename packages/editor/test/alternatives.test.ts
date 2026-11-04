import assert from "node:assert/strict";
import { test } from "node:test";
import { history, redo, undo } from "@codemirror/commands";
import { EditorSelection, EditorState, Transaction, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { anchorAt } from "../src/anchors.ts";
import {
  addAlternatives, applyAlternative, askForAlternatives, alternativeExtensions, alternativePanelCommands, alternativesAt, alternativesPanelModel, alternativesToSave,
  closeAlternatives, cycleAlternative, openAlternatives, refreshAlternatives, type Alternatives, type AlternativeSet,
} from "../src/alternatives.ts";
import { resolveSpan, sentencesIn, wordAt } from "../src/spans.ts";

const DOC = "---\ntitle: Bowls\n---\n\nThe bowl broke along an old line. I mended it with lacquer.\n\nKilns teach patience.\n";
const PATH = "drafts/bowls.md";

const slices = (text: string, ranges: { from: number; to: number }[]) => ranges.map((r) => text.slice(r.from, r.to));

test("words and sentences are spans of the text", () => {
  const text = "A well-known pencil's tip, “sharp.” Next one! - item one\n- item two";
  assert.deepEqual(slices(text, [wordAt(text, 4)!]), ["well-known"]);
  assert.deepEqual(slices(text, [wordAt(text, 15)!]), ["pencil's"]);
  assert.deepEqual(slices(text, [wordAt(text, 12)!]), ["well-known"], "touching a word from its end");
  assert.equal(wordAt("a  b", 2), null, "between spaces is no word");
  assert.deepEqual(slices(text, sentencesIn(text)), ["A well-known pencil's tip, “sharp.”", "Next one!", "- item one", "item two"]);
  const listed = "- First item.\n- Second item";
  assert.deepEqual(slices(listed, sentencesIn(listed, 0)), ["First item.", "Second item"], "list markers aren't part of the sentence");
});

test("a span is found by any of its versions, by context when a word repeats, else by similarity", () => {
  const text = "The cat sat. The dog ran. The cat slept on the mat.\n";
  const second = text.lastIndexOf("cat");
  const anchor = anchorAt(text, second, second + 3);
  assert.deepEqual(resolveSpan(text, { level: "word", anchor, texts: ["cat", "kitten"] }), { from: second, to: second + 3 });
  // Swapped elsewhere (Obsidian, the phone) to another version: still found.
  const swapped = text.slice(0, second) + "kitten" + text.slice(second + 3);
  assert.deepEqual(resolveSpan(swapped, { level: "word", anchor, texts: ["cat", "kitten"] }), { from: second, to: second + 6 });
  // A repeated word with none of its context isn't pinned on a guess.
  const far = { ...anchor, prefix: "zzzz ", suffix: " qqqq" };
  assert.equal(resolveSpan(text, { level: "word", anchor: far, texts: ["cat"] }), null);
  // Not part of a longer word.
  assert.equal(resolveSpan("concatenate", { level: "word", anchor: { exact: "cat", prefix: "", suffix: "", line: 1 }, texts: ["cat"] }), null);
  // An edited sentence is found by similarity; a word isn't.
  const sentence = anchorAt(text, text.indexOf("The cat slept"), text.indexOf("mat.") + 4);
  const edited = text.replace("The cat slept on the mat.", "The cat slept on the warm mat.");
  assert.equal(slices(edited, [resolveSpan(edited, { level: "sentence", anchor: sentence, texts: [sentence.exact] })!])[0], "The cat slept on the warm mat.");
  assert.equal(resolveSpan(edited, { level: "sentence", anchor: sentence, texts: [sentence.exact] }, { minContext: 0.5 }), null, "re-attaching needs the exact text");
});

type Host = Alternatives & { saved: AlternativeSet[][] };

function editor(text: string, sets: AlternativeSet[] = [], options: { path?: string; externalPanel?: boolean; ask?: Alternatives["ask"] } = {}) {
  const host: Host = { path: options.path ?? PATH, externalPanel: options.externalPanel, sets, saved: [], ask: options.ask, onSave: (_path, list) => host.saved.push(list) };
  let state = EditorState.create({
    doc: text,
    selection: EditorSelection.cursor(0),
    extensions: [history(), alternativeExtensions(() => ({ ...host, currentPath: PATH }))],
  });
  const view = {
    get state() { return state; },
    dispatch(...specs: (TransactionSpec | Transaction)[]) { state = (specs[0] instanceof Transaction ? specs[0] : state.update(...(specs as TransactionSpec[]))).state; },
    focus() {},
  } as unknown as EditorView;
  const e = {
    host, view,
    get state() { return state; },
    text: () => state.doc.toString(),
    cursor(pos: number) { view.dispatch({ selection: EditorSelection.cursor(pos) }); },
    select(from: number, to: number) { view.dispatch({ selection: EditorSelection.range(from, to) }); },
    edit(from: number, to: number, insert: string) { view.dispatch({ changes: { from, to, insert }, userEvent: "input.type" }); },
    panel: () => alternativesPanelModel(state),
    commands: () => alternativePanelCommands(view),
    shown: () => e.panel()?.entries.map((x) => `${x.current ? "*" : ""}${x.text}`),
    sets: () => alternativesToSave(state),
  };
  return e;
}

test("the cursor's word: add versions, cycle them in place, each swap one undo step", () => {
  const e = editor(DOC);
  const at = e.text().indexOf("old") + 1;
  e.cursor(at);
  assert.ok(openAlternatives(e.view));
  assert.equal(e.panel()?.level, "word");
  assert.deepEqual(e.panel()?.levels, ["word", "sentence", "paragraph"]);
  assert.deepEqual(e.shown(), ["*old"]);

  e.commands().add("ancient");
  assert.ok(e.text().includes("along an ancient line."), "adding shows it in place");
  e.commands().add("faint");
  assert.deepEqual(e.shown(), ["old", "ancient", "*faint"]);
  assert.equal(e.sets().length, 1);
  assert.equal(e.sets()[0].level, "word");
  assert.deepEqual(e.sets()[0].entries.map((x) => x.by), ["owner", "owner", "owner"]);

  // Arrow keys move; Enter picks.
  e.commands().move(1);
  assert.equal(e.panel()?.highlight, 0, "wraps around");
  e.commands().pick(0);
  assert.ok(e.text().includes("along an old line."));
  closeAlternatives(e.view);
  assert.equal(e.panel(), null);

  // ⌥⌘] / ⌥⌘[ from the editor, with the cursor in the word.
  assert.ok(cycleAlternative(e.view, 1));
  assert.ok(e.text().includes("along an ancient line."));
  assert.ok(cycleAlternative(e.view, 1));
  assert.ok(e.text().includes("along an faint line."));
  assert.ok(cycleAlternative(e.view, 1));
  assert.ok(e.text().includes("along an old line."), "cycles around");
  assert.ok(cycleAlternative(e.view, -1));
  assert.ok(e.text().includes("along an faint line."));

  // Each swap undoes on its own.
  undo(e.view);
  assert.ok(e.text().includes("along an old line."));
  undo(e.view);
  assert.ok(e.text().includes("along an faint line."));
  redo(e.view);
  assert.ok(e.text().includes("along an old line."));
  assert.equal(alternativesAt(e.state, at)[0].entries.find((x) => x.id === alternativesAt(e.state, at)[0].current)?.text, "old", "the showing one follows the text");
  // The document only ever holds the showing version.
  assert.equal(e.text(), DOC);
});

test("external versions follow the cursor and preserve the span on a swap", () => {
  const e = editor(DOC, [], { externalPanel: true });
  e.cursor(DOC.indexOf("old") + 1);
  openAlternatives(e.view);
  e.commands().add("ancient");
  assert.equal(e.panel()?.entries.at(-1)?.text, "ancient");
  assert.equal(e.panel()?.entries.at(-1)?.current, true);
  e.cursor(e.text().indexOf("Kilns") + 1);
  assert.deepEqual(e.shown(), ["*Kilns"]);
  e.cursor(e.text().indexOf("ancient") + 1);
  assert.equal(e.panel()?.highlight, 1, "returning to a span highlights its showing version");
  e.commands().pick(e.panel()!.highlight);
  assert.ok(e.text().includes("an ancient line"));
  closeAlternatives(e.view);
  e.cursor(e.text().indexOf("ancient") + 1);
  assert.ok(cycleAlternative(e.view, 1), "cycling needs no open margin");
  assert.ok(e.text().includes("an old line"));
  assert.equal(e.panel(), null);
});

test("removing versions, and the set goes when only one is left", () => {
  const e = editor(DOC);
  e.cursor(e.text().indexOf("Kilns") + 2);
  openAlternatives(e.view);
  e.commands().add("Ovens");
  e.commands().add("Furnaces");
  assert.deepEqual(e.shown(), ["Kilns", "Ovens", "*Furnaces"]);
  // ⌫ on the showing one shows its neighbour.
  e.commands().remove(2);
  assert.deepEqual(e.shown(), ["Kilns", "*Ovens"]);
  assert.ok(e.text().includes("Ovens teach"));
  e.commands().remove(0);
  assert.deepEqual(e.shown(), ["*Ovens"], "one version is no alternatives");
  assert.deepEqual(e.sets(), []);
  // Undo brings back the earlier texts; they're ordinary text again.
  undo(e.view);
  assert.ok(e.text().includes("Furnaces teach"));
  undo(e.view);
  undo(e.view);
  assert.ok(e.text().includes("Kilns teach"));
  assert.deepEqual(e.sets(), []);
});

test("typing in a span edits the showing version; replacing it keeps both", () => {
  const e = editor(DOC);
  e.cursor(e.text().indexOf("line") + 1);
  openAlternatives(e.view);
  e.commands().add("seam");
  closeAlternatives(e.view);
  // Typing at its end joins the word.
  const end = e.text().indexOf("seam") + 4;
  e.edit(end, end, "s");
  assert.deepEqual(e.sets()[0].entries.map((x) => x.text), ["line", "seams"]);
  // Typing next to it doesn't.
  e.edit(end + 1, end + 1, " here");
  assert.deepEqual(e.sets()[0].entries.map((x) => x.text), ["line", "seams"]);
  // Replacing the whole word keeps what was there.
  const from = e.text().indexOf("seams");
  e.select(from, from + 5);
  e.view.dispatch({ changes: { from, to: from + 5, insert: "crack" }, userEvent: "input.paste" });
  assert.deepEqual(e.sets()[0].entries.map((x) => x.text), ["line", "seams", "crack"]);
});

test("sentence and paragraph levels, and switching between them", () => {
  const e = editor(DOC);
  const sentence = "I mended it with lacquer.";
  e.cursor(e.text().indexOf("mended"));
  openAlternatives(e.view);
  e.commands().level("sentence");
  assert.deepEqual(e.shown(), [`*${sentence}`]);
  e.commands().add("I fixed it with glue.");
  assert.ok(e.text().includes("old line. I fixed it with glue.\n"));
  e.commands().level("paragraph");
  assert.deepEqual(e.shown(), ["*The bowl broke along an old line. I fixed it with glue."]);
  e.commands().add("It broke.");
  assert.ok(e.text().includes("\n\nIt broke.\n\nKilns"));
  // The sentence inside it is detached, not lost; picking the paragraph back brings it home.
  assert.equal(e.sets().find((s) => s.level === "sentence")?.orphaned, true);
  e.commands().pick(0);
  assert.ok(e.text().includes("old line. I fixed it with glue.\n"));
  const sentenceSet = () => e.sets().find((s) => s.level === "sentence");
  assert.equal(sentenceSet()?.orphaned, undefined);
  undo(e.view);
  assert.equal(sentenceSet()?.orphaned, true);
  redo(e.view);
  assert.equal(sentenceSet()?.orphaned, undefined, "redo re-attaches it");
  assert.equal(sentenceSet()?.entries.find((x) => x.id === sentenceSet()?.current)?.text, "I fixed it with glue.");
  // Back to the sentence from the paragraph: ←/→ in the panel.
  e.commands().level("sentence");
  assert.deepEqual(e.shown(), [sentence, "*I fixed it with glue."]);
});

test("a sentence or paragraph takes in typing at its end, not a new line before it", () => {
  const e = editor(DOC);
  e.cursor(e.text().indexOf("mended"));
  openAlternatives(e.view);
  e.commands().level("paragraph");
  e.commands().add("It broke.");
  e.commands().pick(0);
  e.commands().level("sentence");
  e.commands().add("I glued it.");
  closeAlternatives(e.view);
  const paragraph = () => e.sets().find((s) => s.level === "paragraph")!.anchor.exact;
  const sentence = () => e.sets().find((s) => s.level === "sentence")!.anchor.exact;
  assert.equal(paragraph(), "The bowl broke along an old line. I glued it.");
  // Typing at the end of the paragraph.
  const end = e.text().indexOf("I glued it.") + "I glued it.".length;
  e.edit(end, end, " Twice.");
  assert.equal(paragraph(), "The bowl broke along an old line. I glued it. Twice.");
  assert.equal(sentence(), "I glued it.", "a new sentence after it is outside it");
  e.edit(end - 1, end - 1, " again");
  assert.equal(sentence(), "I glued it again.");
  // A new paragraph typed at its start.
  const start = e.text().indexOf("The bowl");
  [..."A new opening."].forEach((char, i) => e.edit(start + i, start + i, char));
  e.edit(start + 14, start + 14, "\n\n");
  assert.equal(paragraph(), "The bowl broke along an old line. I glued it again. Twice.");
  assert.ok(e.text().includes("A new opening.\n\nThe bowl"));
});

test("a selection is its own span", () => {
  const e = editor(DOC);
  const from = e.text().indexOf("along an old line");
  e.select(from, from + "along an old line".length);
  openAlternatives(e.view);
  assert.equal(e.panel()?.level, "phrase");
  e.commands().add("down an old crack");
  assert.ok(e.text().includes("broke down an old crack."));
  assert.equal(e.sets()[0].level, "phrase");
  e.cursor(from + 3);
  assert.ok(cycleAlternative(e.view, 1));
  assert.ok(e.text().includes("broke along an old line."));
});

test("stored sets are placed on open, follow edits, and are saved only when they change", () => {
  const first = editor(DOC);
  first.cursor(first.text().indexOf("patience"));
  openAlternatives(first.view);
  first.commands().add("care");
  const stored = first.sets();
  assert.equal(stored[0].anchor.exact, "care");

  // Reopened on the text as saved: placed, nothing rewritten.
  const saved = first.text();
  const e = editor(saved, stored);
  assert.equal(alternativesAt(e.state, saved.indexOf("care"))[0]?.id, stored[0].id);
  assert.equal(JSON.stringify(e.sets()), JSON.stringify(stored), "opening doesn't change what's stored");

  // Edited above while closed (the phone): still found.
  const elsewhere = saved.replace("The bowl", "Last spring the bowl");
  const moved = editor(elsewhere, stored);
  assert.equal(alternativesAt(moved.state, elsewhere.indexOf("care") + 1)[0]?.id, stored[0].id);
  // Swapped to another version elsewhere: that one shows.
  const other = editor(saved.replace("teach care", "teach patience"), stored);
  const set = alternativesAt(other.state, other.text().indexOf("patience") + 1)[0];
  assert.equal(set?.entries.find((x) => x.id === set.current)?.text, "patience");

  // Text gone while closed: kept, detached.
  const gone = editor(saved.replace("Kilns teach care.\n", ""), stored);
  assert.equal(gone.sets()[0].orphaned, true);
  assert.equal(gone.sets()[0].entries.length, 2);
});

test("sets arrive after the document opens; sets for another document are ignored", () => {
  const e = editor(DOC, [], { path: "other.md" });
  e.cursor(e.text().indexOf("Kilns") + 1);
  openAlternatives(e.view);
  e.commands().add("Ovens");
  e.host.sets = [{ id: "a-x", level: "word", anchor: anchorAt(DOC, DOC.indexOf("bowl"), DOC.indexOf("bowl") + 4), current: "e1", entries: [{ id: "e1", text: "bowl", by: "owner", created: "" }, { id: "e2", text: "cup", by: "kin", created: "" }], created: "" }];
  e.view.dispatch({ effects: refreshAlternatives.of(null) });
  assert.equal(e.sets().length, 1, "another document's sets aren't placed");
  e.host.path = PATH;
  e.view.dispatch({ effects: refreshAlternatives.of(null) });
  assert.deepEqual(e.sets().map((s) => s.id).sort(), ["a-x", e.sets().find((s) => s.id !== "a-x")!.id].sort());
});

test("the host can add versions without showing them (Kin, KI-87)", () => {
  const e = editor(DOC);
  const from = e.text().indexOf("lacquer");
  const id = addAlternatives(e.view, { from, to: from + 7, texts: ["gold", "glue", "lacquer"], by: "kin" });
  assert.ok(id);
  assert.equal(e.text(), DOC, "nothing changes in the text");
  const set = e.sets()[0];
  assert.equal(set.level, "word");
  assert.deepEqual(set.entries.map((x) => [x.text, x.by]), [["lacquer", "owner"], ["gold", "kin"], ["glue", "kin"]]);
  assert.equal(addAlternatives(e.view, { from, to: from + 7, texts: ["gold"], by: "kin" }), null, "nothing new");
  assert.equal(addAlternatives(e.view, { from, to: from + 7, texts: ["tape"], by: "kin" }), id, "the same set");
});

test("read-only documents can be looked at but not swapped", () => {
  let state = EditorState.create({ doc: DOC, extensions: [EditorState.readOnly.of(true), alternativeExtensions(() => undefined)] });
  const view = { get state() { return state; }, dispatch(spec: TransactionSpec) { state = state.update(spec).state; }, focus() {} } as unknown as EditorView;
  assert.equal(cycleAlternative(view, 1), false);
});

test("accepting an edit keeps its author and the prior text one previous-cycle away", () => {
  const e = editor(DOC);
  const from = DOC.indexOf("lacquer");
  assert.ok(applyAlternative(e.view, { from, to: from + 7, text: "glue", by: "kin" }));
  assert.ok(e.text().includes("with glue."));
  assert.deepEqual(e.sets()[0].entries.map((x) => [x.text, x.by]), [["lacquer", "owner"], ["glue", "kin"]]);
  e.cursor(from + 4);
  cycleAlternative(e.view, -1);
  assert.equal(e.text(), DOC);
  // Other kept options don't stand between an accepted version and its original.
  addAlternatives(e.view, { from, to: from + 7, texts: ["gold"], by: "kin" });
  assert.ok(applyAlternative(e.view, { from, to: from + 7, text: "resin", by: "kin" }));
  e.cursor(from + 5);
  cycleAlternative(e.view, -1);
  assert.equal(e.text(), DOC);
  undo(e.view);
  assert.ok(e.text().includes("with resin."));
  undo(e.view);
  assert.equal(e.text(), DOC, "accepting is one undo step");
});

test("kept edits preserve passage whitespace and panel authors", () => {
  const e = editor(DOC);
  const from = DOC.indexOf("old");
  addAlternatives(e.view, { from, to: from + 4, texts: ["ancient "], by: "kin" });
  assert.equal(e.text(), DOC);
  e.select(from, from + 4);
  openAlternatives(e.view);
  assert.deepEqual(e.panel()?.entries, [
    { text: "old ", by: "owner", current: true },
    { text: "ancient ", by: "kin", current: false },
  ]);
  e.commands().pick(1);
  assert.ok(e.text().includes("an ancient line."));
});

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("explicit Kin asks use the panel's level, only once, without changing the draft", async () => {
  let finish!: (texts: string[]) => void;
  const requests: Parameters<NonNullable<Alternatives["ask"]>>[0][] = [];
  const e = editor(DOC, [], { ask: (spec) => { requests.push(spec); return new Promise((done) => { finish = done; }); } });
  e.cursor(DOC.indexOf("old") + 1);
  assert.ok(askForAlternatives(e.view));
  assert.equal(e.panel()?.asking, true);
  assert.ok(e.panel()?.canAsk);
  askForAlternatives(e.view);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].level, "word");
  assert.equal(DOC.slice(requests[0].from, requests[0].to), "old");
  finish(["ancient", "aged"]);
  await settle();
  assert.equal(e.text(), DOC);
  assert.equal(e.panel()?.asking, false);
  assert.deepEqual(e.panel()?.entries.map((x) => x.by), ["owner", "kin", "kin"]);
  e.commands().level("sentence");
  e.commands().askKin();
  assert.equal(requests[1].level, "sentence");
  finish(["The bowl split along an old line."]);
  await settle();
  e.commands().level("paragraph");
  e.commands().askKin();
  assert.equal(requests[2].level, "paragraph");
  finish(["The bowl split. I mended it with lacquer."]);
  await settle();
  assert.equal(e.text(), DOC);
  assert.deepEqual(e.sets().map((s) => s.level), ["word", "sentence", "paragraph"]);
});

test("a Kin answer follows edits above its held span, not a changed passage", async () => {
  let finish!: (texts: string[]) => void;
  const e = editor(DOC, [], { ask: () => new Promise((done) => { finish = done; }) });
  e.cursor(DOC.indexOf("old") + 1);
  askForAlternatives(e.view);
  e.edit(0, 0, "An opening.\n\n");
  finish(["ancient"]);
  await settle();
  assert.equal(e.sets()[0].anchor.exact, "old");
  assert.ok(e.sets()[0].anchor.line > 5);
  e.commands().askKin();
  const from = e.text().indexOf("old");
  e.edit(from, from + 3, "new");
  finish(["aged"]);
  await settle();
  assert.equal(e.panel()?.askError, "The text changed. Try again.");
  assert.ok(!e.sets()[0].entries.some((x) => x.text === "aged"));
});

test("failed asks leave versions alone and can be retried; closing is not consent to apply", async () => {
  let fail = true;
  const e = editor(DOC, [], { ask: async () => { if (fail) throw new Error("Cost cap reached."); return ["ancient"]; } });
  e.cursor(DOC.indexOf("old") + 1);
  askForAlternatives(e.view);
  await settle();
  assert.equal(e.panel()?.askError, "Cost cap reached.");
  assert.equal(e.panel()?.asking, false);
  assert.deepEqual(e.sets(), []);
  fail = false;
  e.commands().askKin();
  closeAlternatives(e.view);
  await settle();
  assert.equal(e.text(), DOC);
  assert.deepEqual(e.sets()[0].entries.map((x) => x.text), ["old", "ancient"]);
});

test("read-only and unavailable hosts cannot ask or add Kin versions", () => {
  const e = editor(DOC);
  assert.equal(askForAlternatives(e.view), false);
  let called = false;
  let state = EditorState.create({ doc: DOC, extensions: [EditorState.readOnly.of(true), alternativeExtensions(() => ({
    path: PATH, currentPath: PATH, sets: [], onSave() {}, ask: async () => { called = true; return ["new"]; },
  }))] });
  const view = { get state() { return state; }, dispatch(spec: TransactionSpec) { state = state.update(spec).state; } } as unknown as EditorView;
  assert.equal(askForAlternatives(view), false);
  assert.equal(addAlternatives(view, { from: 0, to: 3, texts: ["new"], by: "kin" }), null);
  assert.equal(applyAlternative(view, { from: 0, to: 3, text: "new", by: "kin" }), false);
  assert.equal(called, false);
});

test("exact-range Kin edits and kept versions never replace a containing set", () => {
  const e = editor("It is visible.");
  applyAlternative(e.view, { from: 6, to: 13, text: "in view", by: "kin" });
  assert.equal(e.text(), "It is in view.");
  addAlternatives(e.view, { from: 9, to: 13, texts: ["sight"], by: "kin" });
  assert.equal(e.text(), "It is in view.");
  assert.equal(e.sets().length, 2);
  assert.ok(applyAlternative(e.view, { from: 9, to: 13, text: "sight", by: "kin" }));
  assert.equal(e.text(), "It is in sight.");
  e.cursor(11);
  cycleAlternative(e.view, -1);
  assert.equal(e.text(), "It is in view.");
});

test("accept closes a panel on another level and cycles the accepted span, not a nested set", () => {
  const e = editor("Good writing takes time.");
  e.cursor(1);
  openAlternatives(e.view);
  applyAlternative(e.view, { from: 0, to: 24, text: "Writing needs time.", by: "kin" });
  assert.equal(e.panel(), null);
  assert.ok(cycleAlternative(e.view, -1));
  assert.equal(e.text(), "Good writing takes time.");

  const nested = editor("It is good.");
  addAlternatives(nested.view, { from: 6, to: 10, texts: ["fine"], by: "kin" });
  applyAlternative(nested.view, { from: 0, to: 10, text: "It seems good", by: "kin" });
  assert.ok(cycleAlternative(nested.view, -1));
  assert.equal(nested.text(), "It is good.", "the accepted span, even with a smaller set at its end");
});

test("asking on a selection inside an existing word's phrase targets only that selection", async () => {
  const requests: { from: number; to: number }[] = [];
  const e = editor("It is visible.", [], { ask: async (at) => { requests.push(at); return ["sight"]; } });
  applyAlternative(e.view, { from: 6, to: 13, text: "in view", by: "kin" });
  e.select(9, 13);
  askForAlternatives(e.view);
  await settle();
  assert.deepEqual(requests.map(({ from, to }) => ({ from, to })), [{ from: 9, to: 13 }]);
  assert.deepEqual(e.shown(), ["*view", "sight"]);
  e.commands().pick(1);
  assert.equal(e.text(), "It is in sight.");
});
