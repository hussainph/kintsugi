import assert from "node:assert/strict";
import { test } from "node:test";
import { describeEffect, learning } from "./ranking.ts";

test("a like's effect reads as what moved", () => {
  const effect = {
    changes: [
      { key: "source:1", label: "The Quiet Blog", before: 0.25, after: 0.5 },
      { key: "topic:tool", label: "tool", before: 0.4, after: 0.55 },
      { key: "author:ada", label: "Ada", before: 0.25, after: 0.3 },
    ],
    added: [{ id: 3, title: "Small software" }],
    removed: [{ id: 4, title: "Old" }],
  };
  assert.equal(describeEffect(effect), "More weight on The Quiet Blog 25% → 50%, the topic “tool” 40% → 55%. New in Picked for you: “Small software”.");
  assert.equal(describeEffect({ changes: [], added: [], removed: [{ id: 1, title: "x" }] }), "1 pick made room.");
  assert.match(describeEffect({ changes: [], added: [], removed: [] }), /nothing visible moved/);
});

test("the status line says how much it has learned", () => {
  assert.match(learning(0, 0), /Inspiration/);
  assert.match(learning(3, 0.1), /Learning from 3 things/);
  assert.match(learning(40, 1), /Ranked from 40/);
});
