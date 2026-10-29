import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultScenario,
  defineEntry,
  validateControls,
  validateMeta,
  validateRegistry,
  validateScenario,
  validateValues,
  type Entry,
  type EntryMeta,
} from "../src/schema.ts";
import {
  initialState,
  migrateEvent,
  reduceEvent,
  reduceEvents,
  validateAction,
  type Action,
  type LabEvent,
} from "../src/state.ts";
import { fixtureControls, fixtureMeta } from "./helpers.ts";

function event(action: Action, id = "event-1"): LabEvent {
  return { version: 1, id, at: "2026-01-01T00:00:00.000Z", action };
}
test("metadata is strict, required, path-shaped, and experiments have questions", () => {
  assert.deepEqual(validateMeta(fixtureMeta), fixtureMeta);
  for (const field of [
    "id",
    "title",
    "kind",
    "group",
    "status",
    "sources",
    "tickets",
    "related",
    "summary",
  ]) {
    const input = { ...fixtureMeta } as Record<string, unknown>;
    delete input[field];
    assert.throws(
      () => validateMeta(input),
      { name: "ValidationError" },
      field,
    );
  }
  assert.throws(
    () => validateMeta({ ...fixtureMeta, surprise: true }),
    /unknown field/,
  );
  assert.throws(
    () => validateMeta({ ...fixtureMeta, sources: ["../secret"] }),
    /workspace-relative/,
  );
  assert.throws(
    () => validateMeta({ ...fixtureMeta, group: "Not kebab" }),
    /kebab-case/,
  );
  const experiment = {
    ...fixtureMeta,
    id: "experiment/test",
    kind: "experiment",
  };
  assert.throws(() => validateMeta(experiment), /question/);
  assert.equal(
    validateMeta({ ...experiment, question: "Can this be simpler?" }).question,
    "Can this be simpler?",
  );
});
test("controls and scalar values reject invalid types, ranges, unknown names and options", () => {
  assert.deepEqual(validateControls(fixtureControls), fixtureControls);
  assert.deepEqual(
    validateValues({ size: 24, enabled: false }, fixtureControls),
    { size: 24, enabled: false },
  );
  for (const values of [
    { size: 99 },
    { enabled: "yes" },
    { tone: "missing" },
    { nope: 1 },
  ]) {
    assert.throws(() => validateValues(values, fixtureControls));
  }
  assert.throws(
    () => validateControls({ size: { ...fixtureControls.size, step: 0 } }),
    /positive/,
  );
  assert.throws(
    () => validateControls({ size: { ...fixtureControls.size, default: NaN } }),
    /bounds/,
  );
  assert.throws(
    () =>
      validateControls({
        tone: { ...fixtureControls.tone, options: ["same", "same"] },
      }),
    /duplicates/,
  );
  assert.throws(
    () => validateControls({ label: { ...fixtureControls.label, min: 1 } }),
    /number control/,
  );
  assert.throws(
    () => validateValues(JSON.parse('{"__proto__":true}')),
    /Invalid value name/,
  );
});
test("runtime entry and registry validate story/variant uniqueness and related IDs", () => {
  const entry: Entry = {
    meta: fixtureMeta,
    controls: fixtureControls,
    stories: [{ id: "default", title: "Default", render: () => null }],
  };
  assert.equal(defineEntry(entry), entry);
  assert.throws(
    () =>
      defineEntry({ ...entry, stories: [...entry.stories, ...entry.stories] }),
    /duplicate story/,
  );
  assert.throws(
    () =>
      defineEntry({
        ...entry,
        variants: [{ id: "x", title: "X", values: { size: 99 } }],
      }),
    /bounds/,
  );
  assert.throws(() => validateRegistry([entry, entry]), /Duplicate entry/);
  assert.throws(
    () =>
      validateRegistry([
        { ...entry, meta: { ...fixtureMeta, related: ["page/missing"] } },
      ]),
    /does not exist/,
  );
  const peer: EntryMeta = {
    ...fixtureMeta,
    id: "page/peer",
    kind: "page",
    related: [],
  };
  assert.equal(
    validateRegistry([
      { ...entry, meta: { ...fixtureMeta, related: [peer.id] } },
      { meta: peer, controls: {} },
    ]).length,
    2,
  );
});
test("scenario limits bound browser dimensions and scaling", () => {
  assert.deepEqual(validateScenario(defaultScenario), defaultScenario);
  for (const scenario of [
    { ...defaultScenario, width: 0 },
    { ...defaultScenario, textScale: Infinity },
    { ...defaultScenario, density: "dense" },
    { ...defaultScenario, surprise: true },
  ]) {
    assert.throws(() => validateScenario(scenario));
  }
});
test("the immutable reducer retains note kinds, snapshots and backward lifecycle changes", () => {
  const original = initialState("ready");
  const note = reduceEvent(
    original,
    event({ type: "note", kind: "critique", text: "Less chrome." }),
  );
  assert.equal(original.revision, 0);
  assert.equal(original.notes.length, 0);
  assert.equal(note.notes[0].kind, "critique");
  const state = reduceEvents(
    [
      ...note.events,
      event({ type: "status", status: "exploring" }, "event-2"),
      event(
        {
          type: "snapshot",
          name: "Quiet",
          values: { size: 20 },
          scenario: { ...defaultScenario },
        },
        "event-3",
      ),
    ],
    "ready",
    fixtureControls,
  );
  assert.equal(state.status, "exploring");
  assert.equal(state.revision, 3);
  assert.equal(state.snapshots[0].values.size, 20);
  assert.throws(() => reduceEvent(state, state.events[0]), /Duplicate event/);
  assert.throws(
    () => validateAction({ type: "note", kind: "verdict", text: "No" }),
    /note kind/,
  );
});
test("annotations fold latest active state while preserving their entire audit trail", () => {
  const actions: Action[] = [
    {
      type: "annotation",
      operation: "add",
      annotation: {
        id: "a-1",
        comment: "Too small",
        elementPath: "main > button",
        x: 10,
      },
    },
    {
      type: "annotation",
      operation: "update",
      annotation: { id: "a-1", comment: "Too quiet" },
    },
    { type: "annotation", operation: "resolve", annotation: { id: "a-1" } },
  ];
  const state = reduceEvents(
    actions.map((action, index) => event(action, `event-${index}`)),
  );
  assert.equal(state.annotations[0].comment, "Too quiet");
  assert.equal(state.annotations[0].resolved, true);
  assert.equal(state.annotations[0].x, 10);
  assert.equal(state.events.length, 3);
  assert.equal(
    (state.events[0].action as Extract<Action, { type: "annotation" }>)
      .annotation.comment,
    "Too small",
  );
  const deleted = reduceEvent(
    state,
    event(
      { type: "annotation", operation: "delete", annotation: { id: "a-1" } },
      "deleted",
    ),
  );
  assert.deepEqual(deleted.annotations, []);
  assert.equal(deleted.events.length, 4);
  assert.throws(
    () =>
      reduceEvent(
        initialState(),
        event({
          type: "annotation",
          operation: "update",
          annotation: { id: "missing", comment: "No" },
        }),
      ),
    /Unknown annotation/,
  );
  for (const annotation of [
    null,
    { id: "bad", comment: "No", x: NaN },
    { id: "bad", comment: "No", nested: { fn: () => true } },
  ]) {
    assert.throws(
      () =>
        validateAction({ type: "annotation", operation: "add", annotation }),
      { name: "ValidationError" },
    );
  }
});
test("version dispatch migrates the supported old envelope and fails closed on future versions", () => {
  const input = event({ type: "note", kind: "decision", text: "Keep it." });
  assert.deepEqual(migrateEvent({ ...input, version: 0 }), input);
  assert.throws(
    () => migrateEvent({ ...input, version: 2 }),
    /Future event version/,
  );
  assert.throws(
    () => migrateEvent({ ...input, version: -1 }),
    /nonnegative integer/,
  );
  assert.throws(() => migrateEvent({ ...input, at: "not a date" }), /ISO/);
});
