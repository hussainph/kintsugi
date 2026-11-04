import assert from "node:assert/strict";
import { test } from "node:test";
import writing from "../../src-tauri/src/ai/writing/rules.json" with { type: "json" };
import { ACTIONS, ask, WRITING_LISTS } from "../refine/prompts.ts";

// ⌘K's edits carry Kin's writing rules from the one shared file (KI-102),
// rendered the way `ai/writing.rs` renders them for Kin's own prompts.
test("every edit prompt carries the shared never-do list", () => {
  assert.ok(WRITING_LISTS.startsWith("Never, whatever the tone:\n- "));
  for (const action of ACTIONS) {
    const { system } = ask(action, "One. Two three.", 5, 15);
    for (const line of [...writing.never, ...writing.avoid]) assert.ok(system.includes(`- ${line}`), line);
    assert.ok(system.includes("Keep their voice"), "the writer's voice still comes first");
    assert.ok(system.includes("what the passage already uses, keep"));
  }
});

test("the old editor rules survive the merge", () => {
  const text = [...writing.never, ...writing.avoid].join("\n");
  for (const kept of ["Em dashes", "it's not X, it's Y", "Lists of three", "Rhetorical questions", "delve", "tapestry", "testament", "crucial", "seamless", "elevate", "unlock", "landscape"]) {
    assert.ok(text.includes(kept), kept);
  }
});
