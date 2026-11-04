import assert from "node:assert/strict";
import { test } from "node:test";
import { history, redo, undo } from "@codemirror/commands";
import { EditorSelection, EditorState, Transaction, type TransactionSpec } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, type ViewUpdate } from "@codemirror/view";
import { anchorAt } from "../src/anchors.ts";
import * as stashModule from "../src/stash.ts";
import {
  addRequestedStashItems, addStashNote, flushStash, focusStashItem, insertStashItem,
  moveStashItem, refreshStash, removeStashItem, reorderStashItems, stashCommands, stashExtensions,
  stashItems, stashKinReply, stashMime, stashSelection, type Stash, type StashItem,
} from "../src/stash.ts";

const PATH = "drafts/test.md";
const CREATED = "2026-11-04T10:00:00Z";
const item = (id: string, text = id): StashItem => ({ id, by: "owner", kind: "text", text, created: CREATED });
const rewrite = (doc: string, from: number, to: number, text: string, id = "rewrite"): StashItem => ({ id, by: "kin", kind: "rewrite", text, created: CREATED, anchor: anchorAt(doc, from, to) });

type Controller = { update(update: ViewUpdate): void; destroy(): void; flush(): void };
type RuntimePlugin = ViewPlugin<Controller> & { create(view: EditorView): Controller; domEventHandlers?: Record<string, (event: any, view: EditorView) => boolean> };

function editor(doc: string, initial: StashItem[] = [], options: { controller?: boolean; path?: string; readOnly?: boolean; reduce?: boolean; offscreen?: boolean } = {}) {
  const saved: { path: string; items: StashItem[] }[] = [];
  const notified: StashItem[][] = [];
  const errors: string[] = [];
  let opened = 0, picked = 0, focused = 0;
  const host: Stash = {
    path: options.path ?? PATH, currentPath: PATH, items: initial,
    onSave: (path, items) => saved.push({ path, items }), onChange: (items) => notified.push(items),
    onOpen: () => opened++, onPicker: () => picked++, onError: (message) => errors.push(message),
  };
  const extensions = stashExtensions(() => host) as unknown[];
  let state = EditorState.create({ doc, extensions: [history(), EditorState.readOnly.of(!!options.readOnly), extensions as any] });
  let controller: Controller | undefined;
  let frameId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const win = {
    requestAnimationFrame(callback: FrameRequestCallback) { const id = ++frameId; frames.set(id, callback); return id; },
    cancelAnimationFrame(id: number) { frames.delete(id); },
    matchMedia: () => ({ matches: !!options.reduce }),
  };
  const scroller = { scrollTop: 0, scrollHeight: 1300, clientHeight: 300, getBoundingClientRect: () => ({ top: 0 }) };
  const view = {
    get state() { return state; },
    dom: { ownerDocument: { defaultView: win } }, scrollDOM: scroller,
    coordsAtPos: () => options.offscreen ? null : ({ top: 900 }),
    documentTop: 0,
    lineBlockAt: () => ({ top: 900 }),
    posAtCoords: ({ x }: { x: number }) => x < 0 ? null : x,
    requestMeasure(request: any) { request.write(request.read(view), view); },
    plugin: () => controller,
    dispatch(...specs: (TransactionSpec | Transaction)[]) {
      const startState = state;
      const tr = specs[0] instanceof Transaction ? specs[0] : state.update(...specs as TransactionSpec[]);
      state = tr.state;
      controller?.update({ startState, state, transactions: [tr], docChanged: tr.docChanged } as ViewUpdate);
    },
    focus() { focused++; },
  } as unknown as EditorView;
  if (options.controller) controller = (extensions.find((extension) => extension instanceof ViewPlugin && !(extension as RuntimePlugin).domEventHandlers) as RuntimePlugin).create(view);
  const handlers = (extensions.find((extension) => extension instanceof ViewPlugin && (extension as RuntimePlugin).domEventHandlers) as RuntimePlugin).domEventHandlers!;
  return {
    view, host, saved, notified, errors, scroller, handlers,
    get state() { return state; },
    get opened() { return opened; }, get picked() { return picked; }, get focused() { return focused; },
    text: () => state.doc.toString(), items: () => stashItems(state),
    select: (from: number, to = from) => view.dispatch({ selection: EditorSelection.range(from, to) }),
    edit: (from: number, to: number, insert: string) => view.dispatch({ changes: { from, to, insert }, userEvent: "input.type" }),
    key: (key: string) => state.facet(keymap).flat().find((binding) => binding.key === key)?.run?.(view) ?? false,
    refresh: () => view.dispatch({ effects: refreshStash.of(null) }),
    frame(time: number) { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((callback) => callback(time)); },
    destroy: () => controller?.destroy(),
  };
}

test("stash selection and insert each undo both document and stash, with redo", () => {
  const e = editor("Keep these words here.");
  e.select(5, 16);
  assert.equal(e.key("Mod-Alt-x"), true);
  assert.equal(e.text(), "Keep  here.");
  const stashed = e.items()[0];
  assert.equal(stashed.text, "these words");
  assert.equal(stashed.by, "owner");
  assert.equal(stashed.kind, "text");
  assert.equal(e.opened, 1);
  assert.equal(undo(e.view), true);
  assert.equal(e.text(), "Keep these words here.");
  assert.deepEqual(e.items(), []);
  assert.equal(redo(e.view), true);
  assert.equal(e.items()[0].id, stashed.id);
  e.select(0);
  assert.equal(insertStashItem(e.view, stashed.id), true);
  assert.equal(e.text(), "these wordsKeep  here.");
  assert.deepEqual(e.items(), []);
  assert.equal(undo(e.view), true);
  assert.equal(e.text(), "Keep  here.");
  assert.equal(e.items()[0].id, stashed.id);
  assert.equal(redo(e.view), true);
  assert.equal(e.text(), "these wordsKeep  here.");
  assert.deepEqual(e.items(), []);
});

test("without a selection, stash takes the paragraph, not frontmatter, code or a blank line", () => {
  const doc = "---\ntitle: Draft\n---\n\nFirst line\nwrapped line\n\nSecond.\n\n```\ncode\n```";
  const e = editor(doc);
  e.select(doc.indexOf("wrapped") + 2);
  assert.equal(stashSelection(e.view), true);
  assert.equal(e.items()[0].text, "First line\nwrapped line");
  assert.equal(undo(e.view), true);
  assert.equal(e.text(), doc);
  for (const pos of [doc.indexOf("Draft"), doc.indexOf("\n\n") + 1, doc.indexOf("code")]) {
    e.select(pos);
    assert.equal(stashSelection(e.view), false);
  }
});

test("stash and insertion are isolated from surrounding typing", () => {
  const e = editor("Start.");
  e.edit(6, 6, " More.");
  e.select(7, 12);
  stashSelection(e.view);
  e.edit(0, 0, "A ");
  undo(e.view);
  assert.equal(e.text(), "Start. ");
  undo(e.view);
  assert.equal(e.text(), "Start. More.");
  assert.deepEqual(e.items(), []);
  undo(e.view);
  assert.equal(e.text(), "Start.");
});

test("owner notes and explicitly stashed replies need no background feature", () => {
  const e = editor("Draft");
  const note = addStashNote(e.view, "A note");
  const reply = stashKinReply(e.view, "Try [[notes/a]].");
  assert.ok(note && reply);
  assert.deepEqual(e.items().map(({ by, kind }) => ({ by, kind })), [{ by: "owner", kind: "text" }, { by: "kin", kind: "idea" }]);
  assert.equal(e.text(), "Draft");
  undo(e.view);
  assert.deepEqual(e.items().map((item) => item.id), [note]);
  redo(e.view);
  assert.deepEqual(e.items().map((item) => item.id), [note, reply]);
  assert.equal(addStashNote(e.view, " \n"), null);
  assert.equal(stashKinReply(e.view, ""), null);
});

test("there is no proactive entry point; only explicit requests can add Kin items", () => {
  assert.equal("addStashItems" in stashModule, false);
  const doc = "Original words.";
  const e = editor(doc);
  const suggestion = rewrite(doc, 0, 8, "New");
  const idea: StashItem = { ...item("idea"), by: "kin", kind: "idea" };
  assert.deepEqual(e.items(), []);
  assert.equal(addRequestedStashItems(e.view, [suggestion, idea]), true);
  assert.equal(e.text(), doc, "Kin never edits draft prose");
  assert.equal(insertStashItem(e.view, suggestion.id), true, "only the owner's insertion changes the draft");
});

test("batch validation rejects duplicate IDs and malformed rewrites without partial updates", () => {
  const e = editor("Draft", [item("existing")]);
  for (const items of [
    [item("new"), item("existing")], [item("same"), item("same")], [item("empty", "  ")],
    [{ ...item("bad"), kind: "rewrite", by: "kin" }],
    [{ ...item("bad"), anchor: { exact: "Draft", prefix: "", suffix: "", line: 0 } }],
    [{ ...item("bad"), by: "unknown" }], [{ ...item("bad"), created: "" }], [null],
  ]) assert.equal(addRequestedStashItems(e.view, items as StashItem[]), false);
  assert.deepEqual(e.items(), [item("existing")]);
  const input = item("copy");
  addRequestedStashItems(e.view, [input]);
  input.text = "Mutated outside the editor";
  assert.equal(e.items()[1].text, "copy");
  const returned = e.items(); returned[1].text = "Changed snapshot";
  assert.equal(e.items()[1].text, "copy");
});

test("a rewrite follows changes above it and restores its item and words on one undo", () => {
  const doc = "An opening.\n\nOriginal words.\n\nThe ending.";
  const from = doc.indexOf("Original");
  const e = editor(doc, [rewrite(doc, from, from + "Original words.".length, "New words.")]);
  e.edit(0, 0, "A new opening.\n\n");
  e.select(0);
  assert.equal(e.items()[0].anchor?.line, 5);
  assert.equal(focusStashItem(e.view, "rewrite"), true);
  assert.equal(insertStashItem(e.view, "rewrite"), true);
  assert.ok(e.text().includes("\n\nNew words.\n\n"));
  assert.deepEqual(e.items(), []);
  undo(e.view);
  assert.ok(e.text().includes("\n\nOriginal words.\n\n"));
  assert.equal(e.items()[0].id, "rewrite");
  redo(e.view);
  assert.ok(e.text().includes("\n\nNew words.\n\n"));
  assert.deepEqual(e.items(), []);
});

test("changed anchors never replace similar or identical words elsewhere; undo restores their exact target", () => {
  const doc = "Original words.\n\nOriginal words.";
  const e = editor(doc, [rewrite(doc, 0, "Original words.".length, "New words.")]);
  e.edit(0, 8, "Different");
  assert.equal(e.items()[0].anchor?.exact, "Original words.", "never adopts changed words");
  assert.equal(insertStashItem(e.view, "rewrite"), false);
  assert.equal(focusStashItem(e.view, "rewrite"), false);
  assert.equal(e.items().length, 1);
  undo(e.view);
  assert.equal(focusStashItem(e.view, "rewrite"), true);
  assert.equal(insertStashItem(e.view, "rewrite"), true);
  assert.equal(e.text(), "New words.\n\nOriginal words.");
});

test("initial anchors use exactOnly, not paragraph similarity", () => {
  const old = "The old bowl broke along a line.";
  const doc = "The old bowl broke along a new line.";
  const e = editor(doc, [rewrite(old, 0, old.length, "It broke.")]);
  assert.equal(focusStashItem(e.view, "rewrite"), false);
  assert.equal(insertStashItem(e.view, "rewrite"), false);
  assert.equal(e.text(), doc);
  assert.equal(e.items().length, 1);
});

test("deleting across an anchor refuses; undo restores the original inner range", () => {
  const doc = "Before Original words. After";
  const e = editor(doc, [rewrite(doc, 7, 7 + "Original words.".length, "New words.")]);
  e.edit(0, doc.length, "Gone");
  assert.equal(insertStashItem(e.view, "rewrite"), false);
  undo(e.view);
  assert.equal(insertStashItem(e.view, "rewrite"), true);
  assert.equal(e.text(), "Before New words. After");
});

test("text and ideas insert at the cursor or drop position, without deleting a selection", () => {
  const e = editor("abcd", [item("a", "X"), { ...item("b", "[[link]]"), by: "kin", kind: "idea" }]);
  e.select(1, 3);
  insertStashItem(e.view, "a");
  assert.equal(e.text(), "abcXd");
  assert.equal(e.focused, 1);
  insertStashItem(e.view, "b", 0);
  assert.equal(e.text(), "[[link]]abcXd");
  undo(e.view);
  assert.equal(e.text(), "abcXd");
  assert.equal(e.items()[0].id, "b");
  for (const pos of [-1, 100, 1.5, NaN]) assert.equal(insertStashItem(e.view, "b", pos), false);
});

test("remove, reorder and move commands preserve identity and have metadata-only undo/redo", () => {
  const e = editor("Draft", [item("a"), item("b"), item("c")]);
  const ids = () => e.items().map((item) => item.id);
  assert.equal(moveStashItem(e.view, "c", 0), true);
  assert.deepEqual(ids(), ["c", "a", "b"]);
  assert.equal(removeStashItem(e.view, "a"), true);
  assert.deepEqual(ids(), ["c", "b"]);
  undo(e.view); assert.deepEqual(ids(), ["c", "a", "b"]);
  undo(e.view); assert.deepEqual(ids(), ["a", "b", "c"]);
  redo(e.view); assert.deepEqual(ids(), ["c", "a", "b"]);
  redo(e.view); assert.deepEqual(ids(), ["c", "b"]);
  assert.equal(e.text(), "Draft");
  for (const order of [["b"], ["c", "c"], ["b", "unknown"], ["c", "b"]]) assert.equal(reorderStashItems(e.view, order), false);
  assert.equal(moveStashItem(e.view, "missing", 0), false);
  assert.equal(moveStashItem(e.view, "b", -1), false);
  assert.equal(removeStashItem(e.view, "missing"), false);
});

test("newly loaded items survive undo of an earlier stash mutation", () => {
  const e = editor("Draft", [item("a")]);
  removeStashItem(e.view, "a");
  e.host.items = [item("a"), item("new", "From Kin")];
  e.refresh();
  assert.deepEqual(e.items().map((item) => item.id), ["new"]);
  undo(e.view);
  assert.deepEqual(e.items().map((item) => item.id), ["a", "new"]);
  redo(e.view);
  assert.deepEqual(e.items().map((item) => item.id), ["new"]);
});

test("a late load ignores wrong paths; stale echoes preserve local notes and consumed items", () => {
  const e = editor("Draft", [item("wrong")], { path: "other.md" });
  assert.deepEqual(e.items(), []);
  assert.equal(addStashNote(e.view, "While loading"), null);
  assert.equal(stashSelection(e.view), false, "never cut into an unloaded stash");
  e.host.items = [item("stored")]; e.refresh();
  assert.deepEqual(e.items(), []);
  e.host.path = PATH; e.refresh();
  const local = addStashNote(e.view, "Local note");
  assert.deepEqual(e.items().map((item) => item.id), ["stored", local]);
  removeStashItem(e.view, "stored");
  e.refresh();
  assert.deepEqual(e.items().map((item) => item.id), [local]);
});

test("an absent or mismatched host cannot mutate the document or stash", () => {
  let state = EditorState.create({ doc: "Draft", extensions: [history(), stashExtensions(() => undefined)] });
  const view = { get state() { return state; }, dispatch(spec: TransactionSpec) { state = state.update(spec).state; } } as unknown as EditorView;
  assert.equal(stashSelection(view), false);
  assert.equal(addStashNote(view, "Note"), null);
  assert.equal(addRequestedStashItems(view, [item("a")]), false);
  assert.equal(state.doc.toString(), "Draft");
  const e = editor("Draft", [item("a")]);
  e.host.path = "next.md";
  assert.equal(stashSelection(e.view), false);
  assert.equal(insertStashItem(e.view, "a"), false);
  assert.equal(removeStashItem(e.view, "a"), false);
  assert.equal(addStashNote(e.view, "Note"), null);
  assert.equal(e.text(), "Draft");
  assert.deepEqual(e.items(), [item("a")]);
});

test("picker uses the current callback and does not affect history", () => {
  const e = editor("Draft");
  assert.equal(e.key("Mod-Alt-v"), true);
  assert.equal(e.picked, 1);
  let calls = 0;
  e.host.onPicker = () => calls++;
  e.key("Mod-Alt-v");
  assert.equal(calls, 1);
  assert.equal(undo(e.view), false);
  assert.equal(e.text(), "Draft");
});

test("read-only documents refuse every stash mutation and insertion", () => {
  const doc = "Draft";
  const e = editor(doc, [item("a"), rewrite(doc, 0, 5, "Other")], { readOnly: true });
  assert.equal(stashSelection(e.view), false);
  assert.equal(addStashNote(e.view, "Note"), null);
  assert.equal(stashKinReply(e.view, "Reply"), null);
  assert.equal(addRequestedStashItems(e.view, [item("b")]), false);
  assert.equal(insertStashItem(e.view, "a"), false);
  assert.equal(removeStashItem(e.view, "a"), false);
  assert.equal(moveStashItem(e.view, "a", 1), false);
  assert.equal(e.key("Mod-Alt-v"), false);
  assert.equal(focusStashItem(e.view, "rewrite"), true, "reading a rewrite is safe");
  assert.equal(e.text(), doc);
});

function dropEvent(payload: string, position = 2, pathMime = stashMime) {
  let prevented = false;
  const event = {
    clientX: position, clientY: 0,
    dataTransfer: { types: [pathMime], dropEffect: "", getData: (type: string) => type === stashMime ? payload : "Unsafe fallback" },
    preventDefault() { prevented = true; },
  };
  return { event, prevented: () => prevented };
}

test("custom stash drops use reference-style editor coordinates, consume the item and undo together", () => {
  const e = editor("abcd", [item("a", "X")]);
  const { event, prevented } = dropEvent(JSON.stringify({ id: "a", path: PATH }));
  assert.equal(e.handlers.dragover(event, e.view), true);
  assert.equal(event.dataTransfer.dropEffect, "move");
  assert.equal(e.handlers.drop(event, e.view), true);
  assert.equal(prevented(), true);
  assert.equal(e.text(), "abXcd");
  assert.deepEqual(e.items(), []);
  undo(e.view);
  assert.equal(e.text(), "abcd");
  assert.equal(e.items()[0].id, "a");
  redo(e.view);
  assert.equal(e.text(), "abXcd");
  assert.deepEqual(e.items(), []);
});

test("malformed, stale and cross-document stash drops never fall through to plain text", () => {
  const e = editor("abcd", [item("a", "X")]);
  for (const payload of ["bad JSON", "null", JSON.stringify({ text: "unsafe" }), JSON.stringify({ id: "missing" }), JSON.stringify({ id: "a", path: "other.md" })]) {
    const { event, prevented } = dropEvent(payload);
    assert.equal(e.handlers.drop(event, e.view), true);
    assert.equal(prevented(), true);
    assert.equal(e.text(), "abcd");
    assert.equal(e.items().length, 1);
  }
  const outside = dropEvent(JSON.stringify({ id: "a" }), -1);
  assert.equal(e.handlers.drop(outside.event, e.view), true);
  assert.equal(e.text(), "abcd");
  const plain = dropEvent("text", 0, "text/plain");
  assert.equal(e.handlers.drop(plain.event, e.view), false);
  assert.equal(plain.prevented(), false);
});

test("persistence debounces, metadata changes notify immediately, and undo notifies too", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const e = editor("Draft", [item("a")], { controller: true });
  assert.deepEqual(e.notified, [[item("a")]]);
  t.mock.timers.tick(700);
  assert.deepEqual(e.saved, [], "opening stored items does not rewrite them");
  addStashNote(e.view, "Note");
  assert.equal(e.notified.at(-1)?.length, 2);
  t.mock.timers.tick(699); assert.deepEqual(e.saved, []);
  t.mock.timers.tick(1); assert.equal(e.saved.length, 1);
  assert.equal(e.saved[0].path, PATH);
  undo(e.view);
  assert.deepEqual(e.notified.at(-1), [item("a")]);
  flushStash(e.view);
  assert.equal(e.saved.length, 2);
  assert.deepEqual(e.saved[1].items, [item("a")]);
  e.destroy();
});

test("onUpdate takes precedence over its onChange alias and refreshed callbacks receive the current items", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const e = editor("Draft", [item("a")], { controller: true });
  let updates = 0;
  e.host.onUpdate = (path, items) => { assert.equal(path, PATH); assert.equal(items[0].id, "a"); updates++; };
  e.refresh();
  assert.equal(updates, 1);
  assert.equal(e.notified.length, 1, "the fallback alias is not called twice");
  e.select(1);
  assert.equal(updates, 1, "cursor changes do not resend unchanged items");
  e.destroy();
});

test("destroy flushes the old document to its captured path, never the next loaded path", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const e = editor("Draft", [], { controller: true });
  addStashNote(e.view, "Unsaved note");
  e.host.path = "next.md";
  e.host.onSave = () => assert.fail("must not use next document's callback");
  e.destroy();
  assert.equal(e.saved.length, 1);
  assert.equal(e.saved[0].path, PATH);
  assert.equal(e.saved[0].items[0].text, "Unsaved note");
});

test("nothing saves before the matching stash loads; edits after loading save the merged list", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const e = editor("Draft", [item("wrong")], { controller: true, path: "other.md" });
  assert.equal(addStashNote(e.view, "Too early"), null);
  t.mock.timers.tick(1000);
  assert.deepEqual(e.saved, []);
  e.host.path = PATH; e.host.items = [item("stored")]; e.refresh();
  t.mock.timers.tick(700);
  assert.deepEqual(e.saved, []);
  addStashNote(e.view, "Local note");
  t.mock.timers.tick(700);
  assert.equal(e.saved.length, 1);
  assert.deepEqual(e.saved[0].items.map((item) => item.text), ["stored", "Local note"]);
  e.destroy();
});

test("focusing uses the specified 280ms eased glide; reduced motion jumps and still highlights", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const doc = "Original words.";
  for (const reduce of [false, true]) {
    const e = editor(doc, [rewrite(doc, 0, doc.length, "New words.")], { controller: true, reduce });
    assert.equal(focusStashItem(e.view, "rewrite"), true);
    const marked = () => e.state.facet(EditorView.decorations).some((decoration) => typeof decoration !== "function" && decoration.size > 0);
    assert.equal(marked(), true);
    if (reduce) assert.equal(e.scroller.scrollTop, 800);
    else {
      e.frame(0); assert.equal(e.scroller.scrollTop < 1, true);
      e.frame(140); assert.equal(e.scroller.scrollTop > 650 && e.scroller.scrollTop < 800, true, "strong ease-out, not linear");
      e.frame(280); assert.equal(e.scroller.scrollTop, 800);
    }
    assert.equal(e.text(), doc);
    assert.equal(e.items().length, 1);
    t.mock.timers.tick(1200);
    assert.equal(marked(), false);
    assert.equal(undo(e.view), false, "focus never creates an undo step");
    e.destroy();
  }
});

test("offscreen anchors use CodeMirror geometry; user scrolling interrupts the glide but not highlight cleanup", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const doc = "Original words.";
  const e = editor(doc, [rewrite(doc, 0, doc.length, "New words.")], { controller: true, offscreen: true });
  assert.equal(focusStashItem(e.view, "rewrite"), true);
  e.frame(0); e.frame(50);
  const stopped = e.scroller.scrollTop;
  assert.ok(stopped > 0);
  e.handlers.wheel({}, e.view);
  e.frame(280);
  assert.equal(e.scroller.scrollTop, stopped);
  t.mock.timers.tick(1200);
  assert.equal(e.state.facet(EditorView.decorations).some((decoration) => typeof decoration !== "function" && decoration.size > 0), false);
  e.destroy();
});

test("command wrapper reads the current view state", () => {
  const e = editor("Draft");
  const commands = stashCommands(e.view);
  const id = commands.addStashNote("Note");
  assert.ok(id);
  assert.equal(commands.stashItems()[0].id, id);
  assert.equal(commands.insertStashItem(id), true);
  assert.equal(e.text(), "NoteDraft");
  assert.deepEqual(commands.stashItems(), []);
});

test("an oversized selection or paragraph is rejected before touching draft, stash or undo history", () => {
  const text = "x".repeat(8001);
  for (const selected of [false, true]) {
    const e = editor(text);
    if (selected) e.select(0, text.length);
    const before = e.state;
    assert.equal(stashSelection(e.view), false);
    assert.equal(e.state, before, "not even an empty transaction is dispatched");
    assert.equal(e.text(), text);
    assert.deepEqual(e.items(), []);
    assert.equal(e.opened, 0);
    assert.equal(undo(e.view), false);
    assert.deepEqual(e.errors, ["Stash text exceeds 8,000 characters."]);
  }
});

test("a full stash refuses a cut, note or reply before changing the document", () => {
  const initial = Array.from({ length: 500 }, (_, index) => item(`item-${index}`));
  const e = editor("Keep this paragraph.", initial);
  const before = e.state;
  assert.equal(stashSelection(e.view), false);
  assert.equal(addStashNote(e.view, "Note"), null);
  assert.equal(stashKinReply(e.view, "Reply"), null);
  assert.equal(e.state, before);
  assert.equal(e.text(), "Keep this paragraph.");
  assert.deepEqual(e.items(), initial);
  assert.equal(undo(e.view), false);
  assert.ok(e.errors.every((message) => message === "The stash is full. Remove an item first."));
});

test("batches respect remaining capacity atomically, including the 500-item boundary", () => {
  const initial = Array.from({ length: 499 }, (_, index) => item(`item-${index}`));
  const e = editor("Draft", initial);
  const before = e.state;
  assert.equal(addRequestedStashItems(e.view, [item("first"), item("overflow")]), false);
  assert.equal(e.state, before);
  assert.equal(undo(e.view), false);
  assert.equal(addRequestedStashItems(e.view, [item("last")]), true);
  assert.equal(e.items().length, 500);
  undo(e.view);
  assert.deepEqual(e.items(), initial);
  redo(e.view);
  assert.equal(e.items().length, 500);
});

test("oversized notes, replies and requested batches reject without partial items or undo entries", () => {
  const e = editor("Draft");
  const before = e.state;
  assert.equal(addStashNote(e.view, "x".repeat(8001)), null);
  assert.equal(stashKinReply(e.view, "😀".repeat(8001)), null);
  assert.equal(addRequestedStashItems(e.view, [item("valid"), item("long", "x".repeat(8001))]), false);
  assert.equal(e.state, before);
  assert.deepEqual(e.items(), []);
  assert.equal(undo(e.view), false);
  assert.equal(e.errors.length, 3);
});

test("text limits count Unicode scalar values like Rust chars, not UTF-16 units or graphemes", () => {
  const text = "😀".repeat(8000);
  assert.equal(text.length, 16000);
  const e = editor(text);
  e.select(0, text.length);
  assert.equal(stashSelection(e.view), true);
  assert.equal(e.text(), "");
  assert.equal(e.items()[0].text, text);
  assert.equal(e.items()[0].anchor?.exact, text);
  undo(e.view);
  assert.equal(e.text(), text);
  assert.deepEqual(e.items(), []);
  const note = editor("Draft");
  assert.ok(addStashNote(note.view, text));
  assert.ok(stashKinReply(note.view, text));
  assert.equal(addStashNote(note.view, "e\u0301".repeat(4001)), null, "combining marks count separately");
});

test("ids, created bytes, anchor fields and line numbers match backend metadata bounds", () => {
  const anchor = { exact: "Original", prefix: "", suffix: "", line: 1 };
  const e = editor("Original");
  const invalid: StashItem[] = [
    { ...item("a"), id: "a".repeat(129) },
    { ...item("a"), id: "😀".repeat(129) },
    { ...item("a"), id: "control\u0000" },
    { ...item("a"), id: "control\u0085" },
    { ...item("a"), created: "a".repeat(129) },
    { ...item("a"), created: "😀".repeat(33) },
    { ...item("a"), anchor: { ...anchor, exact: "😀".repeat(8001) } },
    { ...item("a"), anchor: { ...anchor, prefix: "😀".repeat(65) } },
    { ...item("a"), anchor: { ...anchor, suffix: "a".repeat(65) } },
    { ...item("a"), anchor: { ...anchor, line: 0x100000000 } },
  ];
  const before = e.state;
  for (const bad of invalid) {
    assert.equal(stashModule.isStashItem(bad), false);
    assert.equal(addRequestedStashItems(e.view, [item("valid"), bad]), false);
    assert.equal(e.state, before);
  }
  assert.equal(undo(e.view), false);
  const valid: StashItem = {
    ...item("😀".repeat(128)), created: "😀".repeat(32),
    anchor: { exact: "😀".repeat(8000), prefix: "😀".repeat(64), suffix: "😀".repeat(64), line: 0xffffffff },
  };
  assert.equal(stashModule.isStashItem(valid), true);
  assert.equal(addRequestedStashItems(e.view, [valid]), true);
  assert.deepEqual(e.items(), [valid]);
});

test("unpaired surrogates cannot enter sidecar fields, but clipped context preserves valid Unicode", () => {
  const e = editor("Draft");
  for (const bad of [
    item("a", "\uD800"), { ...item("a"), id: "\uDC00" }, { ...item("a"), created: "\uD800" },
    { ...item("a"), anchor: { exact: "Original", prefix: "\uD800", suffix: "", line: 1 } },
  ]) assert.equal(addRequestedStashItems(e.view, [bad]), false);
  assert.deepEqual(e.items(), []);
  const doc = "😀" + "a".repeat(47) + "keep" + "b".repeat(47) + "😀";
  const context = editor(doc);
  context.select(49, 53);
  assert.equal(stashSelection(context.view), true);
  const saved = context.items()[0];
  assert.equal(saved.text, "keep");
  assert.equal(saved.anchor?.prefix, "a".repeat(47));
  assert.equal(saved.anchor?.suffix, "b".repeat(47));
  assert.equal(stashModule.isStashItem(saved), true);
  undo(context.view);
  assert.equal(context.text(), doc);
});

test("the Markdown byte cap rejects a cut even when item and Unicode text counts would fit", () => {
  const text = "😀".repeat(8000);
  const initial = Array.from({ length: 130 }, (_, index) => item(`large-${index}`, text));
  const e = editor(text, initial);
  assert.equal(e.items().length, 130, "the initial list fits under 4 MiB");
  e.select(0, text.length);
  const before = e.state;
  assert.equal(stashSelection(e.view), false);
  assert.equal(e.state, before);
  assert.equal(e.text(), text);
  assert.deepEqual(e.items(), initial);
  assert.equal(undo(e.view), false);
  assert.deepEqual(e.errors, ["The stash is too large. Remove an item first."]);
});

test("Markdown byte accounting includes literal marker escaping and metadata", () => {
  const marker = "<!-- kintsugi-stash ";
  const text = marker + "&".repeat(8000 - marker.length);
  const initial = Array.from({ length: 104 }, (_, index) => item(`escaped-${index}`, text));
  const e = editor(text, initial);
  assert.equal(e.items().length, 104);
  e.select(0, text.length);
  const before = e.state;
  assert.equal(stashSelection(e.view), false);
  assert.equal(e.state, before);
  assert.equal(e.text(), text);
  assert.deepEqual(e.errors, ["The stash is too large. Remove an item first."]);
});

test("undo cannot remove draft prose if restoring its stash item would exceed capacity", () => {
  const initial = [item("restored", "Kept prose"), ...Array.from({ length: 499 }, (_, index) => item(`item-${index}`))];
  const e = editor("Draft", initial);
  assert.equal(insertStashItem(e.view, "restored"), true);
  assert.equal(e.items().length, 499);
  e.host.items = [...initial.filter((item) => item.id !== "restored"), item("shared-arrival")];
  e.refresh();
  assert.equal(e.items().length, 500);
  const text = e.text();
  const items = e.items();
  e.key("Mod-z");
  assert.equal(e.text(), text, "prose is not removed without somewhere to restore it");
  assert.deepEqual(e.items(), items);
  assert.deepEqual(e.errors, ["The stash is full. Remove an item first."]);
});

test("invalid or over-capacity initial loads never enable destructive stash commands", () => {
  for (const initial of [[item("long", "x".repeat(8001))], Array.from({ length: 501 }, (_, index) => item(`item-${index}`))]) {
    const e = editor("Keep this.", initial);
    assert.equal(stashSelection(e.view), false);
    assert.equal(addStashNote(e.view, "Note"), null);
    assert.equal(e.text(), "Keep this.");
    assert.equal(undo(e.view), false);
  }
});

test("keyboard redo cannot cut prose when shared arrivals have filled the stash", () => {
  const e = editor("Keep this.");
  assert.equal(stashSelection(e.view), true);
  e.key("Mod-z");
  assert.equal(e.text(), "Keep this.");
  assert.deepEqual(e.items(), []);
  e.host.items = Array.from({ length: 500 }, (_, index) => item(`shared-${index}`));
  e.refresh();
  e.key("Mod-y");
  assert.equal(e.text(), "Keep this.");
  assert.deepEqual(e.items(), e.host.items);
  assert.deepEqual(e.errors, ["The stash is full. Remove an item first."]);
});

test("bounded keyboard history keeps ordinary stash undo and redo together", () => {
  const e = editor("Keep this.");
  e.key("Mod-Alt-x");
  assert.equal(e.text(), "");
  const stashed = e.items();
  e.key("Mod-z");
  assert.equal(e.text(), "Keep this.");
  assert.deepEqual(e.items(), []);
  e.key("Mod-y");
  assert.equal(e.text(), "");
  assert.deepEqual(e.items(), stashed);
});
