import assert from "node:assert/strict";
import test from "node:test";
import {
  initialState,
  reduceEvent,
  validateAction,
  type Action,
  type LabEvent,
} from "../src/state.ts";
const event = (id: string, action: Action): LabEvent => ({
  version: 1,
  id,
  at: "2026-01-01T00:00:00.000Z",
  action,
});

test("critique note resolution appends history without rewriting or deleting the original critique", () => {
  const before = reduceEvent(
    initialState(),
    event("critique", {
      type: "note",
      kind: "critique",
      text: "Try a shorter label",
    }),
  );
  const action = validateAction({
    type: "resolve-critique",
    noteId: "critique",
  });
  const after = reduceEvent(before, event("resolution", action));
  assert.equal(before.notes[0].resolved, undefined);
  assert.equal(after.notes[0].resolved, true);
  assert.equal(after.events.length, 2);
  assert.equal(after.events[0], before.events[0]);
  assert.equal(after.notes[0].text, before.notes[0].text);
  assert.throws(
    () =>
      reduceEvent(
        before,
        event("bad", { type: "resolve-critique", noteId: "missing" }),
      ),
    /Unknown critique/,
  );
  const note = reduceEvent(
    initialState(),
    event("note", { type: "note", kind: "note", text: "A note" }),
  );
  assert.throws(
    () =>
      reduceEvent(
        note,
        event("bad", { type: "resolve-critique", noteId: "note" }),
      ),
    /Unknown critique/,
  );
  assert.throws(
    () => validateAction({ type: "resolve-critique", noteId: "../other" }),
    /invalid characters/,
  );
});
