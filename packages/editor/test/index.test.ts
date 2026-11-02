import assert from "node:assert/strict";
import { test } from "node:test";
import { EditorSelection, EditorState } from "@codemirror/state";
import { ignoredSpans, parseWikilinks } from "@kintsugi/core/references";
import { currentParagraph, referenceExtensions, referenceIndex, updateIndex } from "../src/references.ts";

const config = { sources: [], onOpen: () => {} };
const start = (doc: string) => EditorState.create({ doc, extensions: [referenceExtensions(() => config)] });

// Small deterministic PRNG so a failure reproduces.
function random(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

const seeds = [
  "---\ntitle: A\n---\n\nPlain [[one]] and [[two|Two]].\n\n```js\nconst a = '[[no]]';\n```\n\nInline `[[no]]` then [[three]].\n\n<!-- [[hidden]] -->\n> quote [[four]]\n",
  "No yaml here.\nA line [[link]]\n\n~~~\n[[fenced]]\n~~~\nTail \\[[escaped]] and [[ok]]",
  "```\nunclosed [[fence]]\n",
  "Text with a long paragraph about [[craft]] that keeps going and going.\n\nSecond [[x]] paragraph.",
];
// Mostly prose, with every character that can open or close a region.
const alphabet = "abcdef  \n\n[[]]]|#`~\\<>!--";

test("the reference index stays equal to a full parse through random edits", () => {
  const next = random(7);
  for (const seed of seeds) {
    let state = start(seed);
    let local = 0;
    for (let step = 0; step < 400; step++) {
      const length = state.doc.length;
      const from = Math.floor(next() * (length + 1));
      const to = next() < 0.3 ? Math.min(length, from + Math.floor(next() * 4)) : from;
      let insert = "";
      const n = next() < 0.25 ? 0 : 1 + Math.floor(next() * 3);
      for (let i = 0; i < n; i++) insert += alphabet[Math.floor(next() * alphabet.length)];
      const tr = state.update({ changes: { from, to, insert }, selection: EditorSelection.cursor(from + insert.length) });
      if (updateIndex(state.field(referenceIndex), tr)) local++;
      state = tr.state;
      const text = state.doc.toString();
      const index = state.field(referenceIndex);
      assert.deepEqual(index.links, parseWikilinks(text), `links after step ${step} of ${JSON.stringify(seed.slice(0, 20))}: ${JSON.stringify(text)}`);
      assert.deepEqual(index.ignored, ignoredSpans(text), `spans after step ${step}: ${JSON.stringify(text)}`);
    }
    assert.ok(local > 50, `most random edits take the incremental path (${local})`);
  }
});

test("typing plain prose in a long document takes the incremental path", () => {
  const doc = "---\ntitle: Long\n---\n\n" + "A paragraph that links to [[craft]] and runs on.\n\n".repeat(2000);
  let state = start(doc);
  for (const at of [doc.length, doc.length / 2, 400]) {
    const tr = state.update({ changes: { from: Math.floor(at), insert: "word [[new]] \n" } });
    assert.ok(updateIndex(state.field(referenceIndex), tr), `at ${at}`);
    state = tr.state;
  }
  assert.deepEqual(state.field(referenceIndex).links, parseWikilinks(state.doc.toString()));
});

test("currentParagraph reads the same with the index as without it", () => {
  const doc = "---\ntitle: A\n---\n\nFirst para\nstill first.\n\n```\ncode\n```\n\nLast [[x]] para.";
  const indexed = start(doc);
  const plain = EditorState.create({ doc });
  for (let pos = 0; pos <= doc.length; pos++) {
    const a = currentParagraph(indexed.update({ selection: EditorSelection.cursor(pos) }).state);
    const b = currentParagraph(plain.update({ selection: EditorSelection.cursor(pos) }).state);
    assert.equal(a, b, `at ${pos}`);
  }
});
