import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, removes } from "./outside.ts";

const doc = (...lines: string[]) => lines.join("\n");
const base = doc("---", "title: Repair", "---", "", "one", "two", "three");

test("Kintsugi's own save, or no change, is nothing to do", () => {
  assert.deepEqual(decide(base, base, base), { kind: "none" });
  assert.deepEqual(decide(base, doc(base, "typing"), base), { kind: "none" });
});

test("a clean buffer reloads quietly", () => {
  const disk = doc(base, "four from obsidian");
  assert.deepEqual(decide(base, base, disk), { kind: "reload", text: disk });
  // The same edit made in both places is not a conflict.
  assert.deepEqual(decide(base, disk, disk), { kind: "reload", text: disk });
});

test("unsaved edits merge with another app's edit to other lines", () => {
  const mine = base.replace("one", "one, typed here");
  const disk = base.replace("three", "three, from git");
  assert.deepEqual(decide(base, mine, disk), { kind: "merged", text: base.replace("one", "one, typed here").replace("three", "three, from git") });
});

test("edits to the same line collide, and only then is the writer asked", () => {
  const disk = base.replace("two", "two from obsidian");
  assert.deepEqual(decide(base, base.replace("two", "two typed here"), disk), { kind: "collision", disk });
  // Without a base nothing can be merged.
  assert.deepEqual(decide(undefined, "mine", "theirs"), { kind: "collision", disk: "theirs" });
});

test("a removed document closes when clean and asks when it has unsaved edits", () => {
  assert.deepEqual(decide(base, base, null), { kind: "gone" });
  assert.deepEqual(decide(base, doc(base, "unsaved"), null), { kind: "collision", disk: null });
});

test("removing a folder removes what is inside it", () => {
  assert.ok(removes("posts", "posts/a.md"));
  assert.ok(removes("posts/a.md", "posts/a.md"));
  assert.ok(!removes("posts", "posts-old/a.md"));
});
