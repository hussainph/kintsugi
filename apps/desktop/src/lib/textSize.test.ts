import assert from "node:assert/strict";
import { test } from "node:test";
import { nearestSize, stepSize, textSizeForKey, TEXT_SIZES } from "./textSize.ts";

test("text size steps stop at the ends", () => {
  assert.equal(stepSize(1, 1), 1.1);
  assert.equal(stepSize(1, -1), 0.9);
  assert.equal(stepSize(TEXT_SIZES[0], -1), TEXT_SIZES[0]);
  assert.equal(stepSize(TEXT_SIZES[TEXT_SIZES.length - 1], 1), TEXT_SIZES[TEXT_SIZES.length - 1]);
});

test("a stored size snaps to the nearest step, and junk is 100%", () => {
  assert.equal(nearestSize(1.13), 1.1);
  assert.equal(nearestSize(9), 1.5);
  assert.equal(nearestSize(Number("junk")), 1);
});

test("⌘= and ⌘+ go larger, ⌘− smaller, ⌘0 resets, other keys pass", () => {
  assert.equal(textSizeForKey("=", 1), 1.1);
  assert.equal(textSizeForKey("+", 1), 1.1);
  assert.equal(textSizeForKey("-", 1), 0.9);
  assert.equal(textSizeForKey("0", 1.35), 1);
  assert.equal(textSizeForKey("b", 1), null);
});
