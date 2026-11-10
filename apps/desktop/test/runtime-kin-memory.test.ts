// KI-115 on real headless commands and persisted threads, scripted model only.
// The benchmark also records per-turn reads, calls, synthetic tokens and latency.
import assert from "node:assert/strict";
import { test } from "node:test";
import { END, PARAGRAPH, measureMemory } from "./ki115-benchmark.ts";

test("Kin keeps whole paragraphs and reuses only current thread evidence", { timeout: 15 * 60_000 }, async () => {
  const { measurements } = await measureMemory("runtime");
  const [edit, paragraphFollowup, first, unchanged, changed] = measurements;
  assert.equal(edit.reads, 0, "the whole chipped paragraph is in current context");
  const search = edit.text.split("<<<<<<< SEARCH\n")[1]?.split("\n=======")[0];
  assert.equal(search, PARAGRAPH, "SEARCH matches the entire source, without numeric prefixes");
  assert.ok(search.endsWith(END), "the long physical line's final sentence survives");
  assert.equal(paragraphFollowup.reads, 0);
  assert.ok(paragraphFollowup.text.includes(END), "the follow-up still sees the paragraph ending");
  assert.equal(first.reads, 1, "a large unprovided document must be read");
  assert.equal(unchanged.reads, 0, "the retained actual result supports reuse");
  assert.equal(unchanged.toolCalls, 0);
  assert.equal(unchanged.modelCalls, 1);
  assert.ok(unchanged.text.includes("The original opening"));
  assert.equal(changed.reads, 1, "a changed revision invalidates the earlier read");
  assert.ok(changed.text.includes("The revised opening"));
  assert.ok(!changed.text.includes("The original opening"));
  assert.ok(!unchanged.text.includes("drafts/ki115-memory.md"), "ordinary follow-ups do not recite filenames");
  for (const measurement of measurements) {
    assert.equal(measurement.tokenKind, "synthetic mock-reported zeros");
    assert.deepEqual(measurement.tokens, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.ok(measurement.latencyMs > 0);
  }
});
