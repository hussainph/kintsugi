import assert from "node:assert/strict";
import { test } from "node:test";
import { chipKey, chipTitle, mergeChips, selectionChip, snippet, throttle, type Chip } from "./chips.ts";

const doc: Chip = { kind: "doc", path: "drafts/x.md", label: "Draft X" };
const clip: Chip = { kind: "clip", path: "inspiration/kiln.md" };

test("discussed items come first, screen chips follow, each once", () => {
  const chips = mergeChips([clip], [doc, clip], new Set());
  assert.deepEqual(chips, [clip, doc]);
});

test("a removed chip stays removed; a different passage is a new chip", () => {
  const a = selectionChip("drafts/x.md", "First paragraph.", 3, 3)!;
  const b = selectionChip("drafts/x.md", "Second.", 5, 6)!;
  const removed = new Set([chipKey(a)]);
  assert.deepEqual(mergeChips([], [a, doc], removed), [doc]);
  assert.deepEqual(mergeChips([], [b, doc], removed), [b, doc]);
  assert.equal(chipKey(b), "paragraph:drafts/x.md:5-6");
});

test("selections become paragraph chips with a one-line label", () => {
  assert.equal(selectionChip("a.md", "   \n ", 1, 1), null);
  const chip = selectionChip("a.md", "A  pencil\nis a tool " + "for thinking ".repeat(10), 4, 2)!;
  assert.deepEqual(chip.lines, [4, 4]);
  assert.ok(chip.label!.length <= 80 && chip.label!.endsWith("…") && !chip.label!.includes("\n"));
  assert.equal(snippet("short"), "short");
  assert.equal(chipTitle(clip), "kiln");
  assert.equal(chipTitle(doc), "Draft X");
});

test("typing pings are throttled", () => {
  let t = 0;
  let pings = 0;
  const ping = throttle(() => pings++, 300, () => t);
  for (t = 0; t < 1000; t += 50) ping();
  assert.equal(pings, 4);
});
