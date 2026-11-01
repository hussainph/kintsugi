import assert from "node:assert/strict";
import { test } from "node:test";

import { merge3 } from "./merge.ts";

const doc = (...paragraphs: string[]) => `---\ntitle: "A"\n---\n\n${paragraphs.join("\n\n")}\n`;

test("one side unchanged takes the other", () => {
  const base = doc("one", "two");
  const edited = doc("one!", "two");
  assert.deepEqual(merge3(base, edited, base), { clean: true, text: edited });
  assert.deepEqual(merge3(base, base, edited), { clean: true, text: edited });
});

test("edits to different paragraphs combine", () => {
  const base = doc("one", "two", "three");
  const mine = doc("one, from the phone", "two", "three");
  const theirs = doc("one", "two", "three, from the Mac");
  assert.deepEqual(merge3(base, mine, theirs), { clean: true, text: doc("one, from the phone", "two", "three, from the Mac") });
  assert.deepEqual(merge3(base, theirs, mine), { clean: true, text: doc("one, from the phone", "two", "three, from the Mac") });
});

test("additions at both ends and a frontmatter change combine", () => {
  const base = doc("middle");
  const mine = doc("middle", "added on the phone");
  const theirs = doc("added on the Mac", "middle").replace("title: \"A\"", "title: \"B\"");
  assert.deepEqual(merge3(base, mine, theirs), {
    clean: true,
    text: doc("added on the Mac", "middle", "added on the phone").replace("title: \"A\"", "title: \"B\""),
  });
});

test("the same change on both sides counts once", () => {
  const base = doc("one", "two", "three");
  const mine = doc("one", "TWO", "three, phone");
  const theirs = doc("one", "TWO", "three");
  assert.deepEqual(merge3(base, mine, theirs), { clean: true, text: mine });
});

test("different edits to the same paragraph collide", () => {
  const base = doc("one", "two");
  assert.deepEqual(merge3(base, doc("one", "two from the phone"), doc("one", "two from the Mac")), { clean: false });
});

test("edits to neighbouring lines collide rather than guess", () => {
  const base = "a\nb\nc\nd";
  assert.deepEqual(merge3(base, "a\nB\nc\nd", "a\nb\nC\nd"), { clean: false });
});

test("a deletion and an edit elsewhere combine; a deletion and an edit of the same line collide", () => {
  const base = doc("one", "two", "three");
  assert.deepEqual(merge3(base, doc("two", "three"), doc("one", "two", "three!")), { clean: true, text: doc("two", "three!") });
  assert.deepEqual(merge3(base, doc("two", "three"), doc("one!", "two", "three")), { clean: false });
});

test("both sides inserting at the same place collide unless identical", () => {
  const base = "a\nb";
  assert.deepEqual(merge3(base, "a\nx\nb", "a\ny\nb"), { clean: false });
  assert.deepEqual(merge3(base, "a\nx\nb", "a\nx\nb"), { clean: true, text: "a\nx\nb" });
});

test("empty base: two new texts collide, matching ones do not", () => {
  assert.deepEqual(merge3("", "phone", "mac"), { clean: false });
  assert.deepEqual(merge3("", "same", "same"), { clean: true, text: "same" });
});

test("the same paragraph added on both sides never lands twice", () => {
  const merged = merge3("a\n\nb", "a\n\nX\n\nb", "Z\n\nX\n\nb");
  assert.ok(!merged.clean || merged.text.split("X").length === 2, JSON.stringify(merged));
});

test("very long documents merge without a huge table", () => {
  const base = Array.from({ length: 6000 }, (_, i) => `line ${i}`);
  const join = (lines: string[]) => lines.join("\n");
  const first = ["first, edited", ...base.slice(1)];
  const last = [...base.slice(0, -1), "last, edited"];
  assert.deepEqual(merge3(join(base), join(first), join(last)), {
    clean: true,
    text: join(["first, edited", ...base.slice(1, -1), "last, edited"]),
  });
  // One side changed both ends: too big to diff finely, so it collides
  // with an edit in the middle rather than taking seconds and memory.
  const ends = ["first, edited", ...base.slice(1, -1), "last, edited"];
  const middle = [...base.slice(0, 3000), "middle, edited", ...base.slice(3001)];
  const started = Date.now();
  assert.equal(merge3(join(base), join(ends), join(middle)).clean, false);
  assert.ok(Date.now() - started < 500);
});

test("a paragraph added next to one edited on the other side merges", () => {
  assert.deepEqual(merge3("b\n", "b, edited\n", "b\n\nadded\n"), { clean: true, text: "b, edited\n\nadded\n" });
  assert.deepEqual(merge3("a\nb", "a\nx\nb", "a\nB"), { clean: true, text: "a\nx\nB" });
});
