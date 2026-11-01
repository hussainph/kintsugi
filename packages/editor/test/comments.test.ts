import assert from "node:assert/strict";
import { test } from "node:test";
import { history, undo } from "@codemirror/commands";
import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import { EditorView, showPanel, showTooltip } from "@codemirror/view";
import { anchorAt, paragraphs, resolveAnchor, similarity, type CommentAnchor } from "../src/anchors.ts";
import { anchorMoves, commentExtensions, commentPlace, refreshComments, reviewParagraphs, startComment, type Comments, type CommentThread } from "../src/comments.ts";

const DOC = "---\ntitle: Tools\n---\n\nA pencil is a tool for thinking.\n\nThe gold seam is the repair, and the repair is the point.\n\nKilns teach patience.\n";

const at = (text: string, passage: string) => {
  const from = text.indexOf(passage);
  assert.ok(from >= 0, passage);
  return anchorAt(text, from, from + passage.length);
};

test("an anchor resolves to its exact quote, using context and line to break ties", () => {
  const text = "Same words.\n\nOther.\n\nSame words.\n";
  const second = anchorAt(text, text.lastIndexOf("Same"), text.lastIndexOf("Same") + 11);
  assert.deepEqual(resolveAnchor(text, second), { from: 21, to: 32 });
  const first = anchorAt(text, 0, 11);
  assert.deepEqual(resolveAnchor(text, first), { from: 0, to: 11 });
  // Text inserted above shifts it, and the quote still finds it.
  assert.deepEqual(resolveAnchor("New opening.\n\n" + text, second), { from: 35, to: 46 });
});

test("an edited paragraph is found by similarity; a gone one is an orphan", () => {
  const anchor = at(DOC, "The gold seam is the repair, and the repair is the point.");
  const edited = DOC.replace("and the repair is the point.", "and the repair is the whole point.");
  const found = resolveAnchor(edited, anchor);
  assert.ok(found);
  assert.equal(edited.slice(found.from, found.to), "The gold seam is the repair, and the repair is the whole point.");
  assert.equal(resolveAnchor(edited, anchor, { exactOnly: true }), null, "exact-only finds nothing once it changed");
  const gone = DOC.replace("The gold seam is the repair, and the repair is the point.\n\n", "");
  assert.equal(resolveAnchor(gone, anchor), null);
  assert.equal(resolveAnchor(DOC, { exact: "  ", prefix: "", suffix: "", line: 1 }), null);
  assert.ok(similarity("a b c d", "a b c d") === 1 && similarity("a b", "x y") === 0);
});

test("paragraphs skip frontmatter and split on blank lines and fences", () => {
  const text = "---\na: 1\n---\n\nOne\ntwo\n\n```\ncode\n```\nThree\n";
  assert.deepEqual(paragraphs(text).map((p) => text.slice(p.from, p.to)), ["One\ntwo", "code", "Three"]);
});

type Host = Comments & { moved: unknown[]; created: unknown[]; replies: unknown[] };

function thread(id: string, anchor: CommentAnchor, extra: Partial<CommentThread> = {}): CommentThread {
  return { id, anchor, status: "open", origin: "mention", created: "2026-11-02T10:00:00Z", messages: [{ seq: 1, role: "owner", text: "Hm?", at: "2026-11-02T10:00:00Z" }], ...extra };
}

function editor(text: string, threads: CommentThread[] = [], path = "drafts/tools.mdx") {
  const host: Host = {
    path, threads, moved: [], created: [], replies: [],
    onCreate: async (anchor, place, message) => { host.created.push({ anchor, place, message }); return "c-new"; },
    onReply: (id, message, place) => host.replies.push({ id, message, place }),
    onStatus: () => {},
    onMoved: (moves) => host.moved.push(...moves),
  };
  let state = EditorState.create({
    doc: text,
    selection: EditorSelection.cursor(0),
    extensions: [history(), commentExtensions(() => ({ ...host, currentPath: "drafts/tools.mdx" }))],
  });
  const view = {
    get state() { return state; },
    dispatch(...specs: TransactionSpec[]) { state = state.update(...specs).state; },
    focus() {},
  } as unknown as EditorView;
  return {
    host, view,
    get state() { return state; },
    edit(from: number, to: number, insert: string) { view.dispatch({ changes: { from, to, insert }, userEvent: "input" }); },
    text: () => state.doc.toString(),
    placed: (id: string) => commentPlace(state, id)?.text ?? null,
    refresh() { view.dispatch({ effects: refreshComments.of(null) }); },
  };
}

test("threads move with their paragraph while it is edited, and orphans come back on undo", () => {
  const seam = "The gold seam is the repair, and the repair is the point.";
  const e = editor(DOC, [thread("a", at(DOC, seam)), thread("b", at(DOC, "Kilns teach patience."))]);
  assert.equal(e.placed("a"), seam);

  // Typing inside it keeps it, whole.
  const word = e.text().indexOf("the point");
  e.edit(word, word, "very ");
  assert.equal(e.placed("a"), "The gold seam is the repair, and the repair is very the point.");
  // Typing after trailing whitespace at its end still extends it.
  const end = e.text().indexOf("very the point.") + "very the point.".length;
  e.edit(end, end, " ");
  e.edit(end + 1, end + 1, "Yes.");
  assert.equal(e.placed("a"), "The gold seam is the repair, and the repair is very the point. Yes.");
  e.edit(end, end + 5, "");
  // A new paragraph above moves it down.
  e.edit(e.text().indexOf("A pencil"), e.text().indexOf("A pencil"), "Opening line.\n\n");
  assert.equal(e.placed("a"), "The gold seam is the repair, and the repair is very the point.");
  assert.equal(commentPlace(e.state, "a")?.fromLine, 9);
  // Typing at its start joins it.
  const start = e.text().indexOf("The gold");
  e.edit(start, start, "Yes. ");
  assert.equal(e.placed("a"), "Yes. The gold seam is the repair, and the repair is very the point.");
  // Splitting it keeps the thread on the first part.
  const comma = e.text().indexOf(", and");
  e.edit(comma, comma + 2, ".\n\nAnd");
  assert.equal(e.placed("a"), "Yes. The gold seam is the repair.");

  // Deleting the paragraph outright orphans the thread; it's kept.
  const kilns = e.text().indexOf("Kilns");
  e.edit(kilns, kilns + "Kilns teach patience.".length, "");
  assert.equal(e.placed("b"), null);
  const moves = anchorMoves(e.state, e.host.threads);
  const b = moves.find((m) => m.id === "b")!;
  assert.equal(b.orphaned, true);
  assert.equal(b.anchor.exact, "Kilns teach patience.", "an orphan keeps the text it was on");
  assert.equal(moves.find((m) => m.id === "a")!.anchor.exact, "Yes. The gold seam is the repair.");
  assert.deepEqual(anchorMoves(e.state, e.host.threads, new Map(moves.map((m) => [m.id, JSON.stringify(m)]))), [], "nothing new to send");

  // Undo brings the text back, and the thread finds it again.
  undo(e.view);
  assert.equal(e.placed("b"), "Kilns teach patience.");
});

test("threads resolve on open from stored anchors, and an orphan stays an orphan", () => {
  const stored = at(DOC, "A pencil is a tool for thinking.");
  const changed = DOC.replace("A pencil is a tool for thinking.", "A pencil is a tool for slow thinking.");
  const e = editor(changed, [thread("a", stored), thread("gone", { exact: "Nothing like this is here at all.", prefix: "", suffix: "", line: 30 }, { orphaned: true })]);
  assert.equal(e.placed("a"), "A pencil is a tool for slow thinking.");
  assert.equal(e.placed("gone"), null);
  const moves = anchorMoves(e.state, e.host.threads);
  assert.deepEqual(moves.map((m) => [m.id, m.orphaned, m.anchor.exact]), [["a", false, "A pencil is a tool for slow thinking."]], "the orphan was already stored as one");
});

test("@Kin's composer opens on the paragraph; sending creates the thread, nothing is written", async () => {
  const e = editor(DOC);
  const pencil = e.text().indexOf("pencil");
  assert.equal(startComment(e.view, pencil), true);
  assert.equal(e.state.facet(showTooltip).filter(Boolean).length, 1, "the composer is open");
  // Threads for another document are ignored.
  e.host.path = "drafts/other.mdx";
  e.host.threads = [thread("x", at(DOC, "Kilns teach patience."))];
  e.refresh();
  assert.equal(e.placed("x"), null);
  assert.equal(e.state.facet(showPanel).filter(Boolean).length, 0);
  e.host.path = "drafts/tools.mdx";
  e.refresh();
  assert.equal(e.placed("x"), "Kilns teach patience.");
  assert.equal(e.state.facet(showPanel).filter(Boolean).length, 1, "the comments bar shows once there are threads");
  assert.equal(e.text(), DOC, "the document is untouched");
});

test("a review offers the body's prose paragraphs with anchors and lines", () => {
  const text = "---\ntitle: x\n---\n\n# Heading\n\nFirst para\nwraps.\n\n---\n\nSecond.\n";
  const e = editor(text);
  const list = reviewParagraphs(e.state);
  assert.deepEqual(list.map((p) => [p.anchor.exact, p.lines]), [["First para\nwraps.", [7, 8]], ["Second.", [12, 12]]]);
  assert.equal(list[0].anchor.prefix.endsWith("# Heading\n\n"), true);
});
