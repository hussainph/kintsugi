import assert from "node:assert/strict";
import { test } from "node:test";
import { shownReasons } from "./ranking.ts";

test("the (?) card leaves out how the ranker works", () => {
  const reasons = [
    { key: "story", label: "3 sources you follow covered this", removable: false },
    { key: "source:1", label: "You often keep things from The Verge", removable: true },
    { key: "cold", label: "Still learning: mostly what’s recent and what’s in Inspiration", removable: false },
  ];
  assert.deepEqual(shownReasons(reasons).map((r) => r.key), ["story", "source:1"]);
});
