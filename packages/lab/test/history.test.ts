import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { defaultScenario, defaultValues, type Control } from "../src/schema.ts";
import { createStore } from "../src/store.ts";
import {
  entrySource,
  fixture,
  fixtureControls,
  fixtureMeta,
} from "./helpers.ts";

function sourceWithControls(controls: Record<string, Control>): string {
  // Keep the fixture variant valid independently of the evolving controls.
  return entrySource(fixtureMeta, controls).replace(
    "values:{size:24}",
    "values:{}",
  );
}

test("committed snapshots survive renamed controls, tightened bounds and changed types/options", async (t) => {
  const { size: removedSize, ...withoutSize } = fixtureControls;
  const cases: Array<{ name: string; controls: Record<string, Control> }> = [
    {
      name: "removed and renamed control",
      controls: { ...withoutSize, fontSize: removedSize },
    },
    {
      name: "tightened number bounds",
      controls: {
        ...fixtureControls,
        size: { ...fixtureControls.size, max: 20 },
      },
    },
    {
      name: "changed scalar type",
      controls: {
        ...fixtureControls,
        label: { type: "number", default: 1, target: "source.tsx:label" },
      },
    },
    {
      name: "removed select option",
      controls: {
        ...fixtureControls,
        tone: { ...fixtureControls.tone, options: ["quiet"] },
      },
    },
  ];
  for (const { name, controls } of cases) {
    await t.test(name, async () => {
      const f = await fixture();
      try {
        const store = createStore(f);
        const values = {
          ...defaultValues(fixtureControls),
          size: 24,
          tone: "loud",
        };
        const original = await store.append("component/sample", 0, {
          type: "snapshot",
          name: "Before controls changed",
          values,
          scenario: { ...defaultScenario },
        });
        const log = join(f.directory, "thread.jsonl");
        const before = await readFile(log, "utf8");
        await writeFile(f.file, sourceWithControls(controls));

        assert.deepEqual(
          await createStore(f).read("component/sample"),
          original,
        );
        assert.equal(
          await readFile(log, "utf8"),
          before,
          "reading never rewrites history",
        );
        await assert.rejects(
          store.append("component/sample", 1, {
            type: "snapshot",
            name: "Invalid with today's controls",
            values,
            scenario: { ...defaultScenario },
          }),
          /Unknown control|bounds|expected|select option/,
        );
        assert.equal(
          await readFile(log, "utf8"),
          before,
          "invalid new snapshots cannot alter history",
        );

        const next = await store.append("component/sample", 1, {
          type: "snapshot",
          name: "Current controls",
          values: defaultValues(controls),
          scenario: { ...defaultScenario },
        });
        assert.equal(next.revision, 2);
        assert.deepEqual(next.snapshots[0], original.snapshots[0]);
        assert.deepEqual(next.events[0], original.events[0]);
        assert.deepEqual(await createStore(f).read("component/sample"), next);
        const noted = await store.append("component/sample", 2, {
          type: "note",
          kind: "decision",
          text: "Continue exploring without losing the old direction.",
        });
        assert.equal(noted.revision, 3);
        assert.deepEqual(
          (await store.read("component/sample")).snapshots[0].values,
          values,
        );
      } finally {
        await f.cleanup();
      }
    });
  }
});

test("legacy snapshots migrate without checking retired controls and preserve their values on write", async () => {
  const f = await fixture();
  try {
    await writeFile(f.file, sourceWithControls({}));
    const log = join(f.directory, "thread.jsonl");
    const old = {
      version: 0,
      id: "legacy-snapshot",
      at: "2026-01-01T00:00:00.000Z",
      action: {
        type: "snapshot",
        name: "Retired controls",
        values: { retired: 500, oldLabel: "Original" },
        scenario: { ...defaultScenario },
      },
    };
    await writeFile(log, JSON.stringify(old) + "\n");
    const store = createStore(f);
    const read = await store.read("component/sample");
    assert.equal(read.events[0].version, 1);
    assert.deepEqual(read.snapshots[0].values, old.action.values);
    const next = await store.append("component/sample", 1, {
      type: "note",
      kind: "note",
      text: "The controls have evolved.",
    });
    assert.equal(next.revision, 2);
    assert.deepEqual(next.snapshots, read.snapshots);
    const migrated = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(migrated[0].version, 1);
    assert.deepEqual(migrated[0].action.values, old.action.values);
    assert.deepEqual(await store.read("component/sample"), next);
  } finally {
    await f.cleanup();
  }
});

test("historical validation still rejects nonscalar data, corrupt events and future versions without rewriting them", async () => {
  const f = await fixture();
  try {
    const store = createStore(f);
    const log = join(f.directory, "thread.jsonl");
    const event = {
      version: 1,
      id: "old-snapshot",
      at: "2026-01-01T00:00:00.000Z",
      action: {
        type: "snapshot",
        name: "Historical",
        values: { retired: 24 },
        scenario: { ...defaultScenario },
      },
    };
    const invalidEvents = [
      {
        ...event,
        action: { ...event.action, values: { retired: { nested: true } } },
      },
      { ...event, action: { ...event.action, values: { retired: null } } },
      { ...event, action: { ...event.action, values: [] } },
      {
        ...event,
        action: { ...event.action, scenario: { ...defaultScenario, width: 0 } },
      },
      { ...event, action: { type: "unknown" } },
      { ...event, version: 2 },
      { ...event, version: "unknown" },
    ];
    const contents = invalidEvents.map((item) => JSON.stringify(item) + "\n");
    contents.push(
      JSON.stringify(event).replace('"retired":24', '"retired":1e999') + "\n",
    );
    for (const content of contents) {
      await writeFile(log, content);
      await assert.rejects(store.read("component/sample"), /Corrupt thread/);
      await assert.rejects(
        store.append("component/sample", 0, {
          type: "note",
          kind: "note",
          text: "This must not overwrite invalid history.",
        }),
        /Corrupt thread/,
      );
      assert.equal(await readFile(log, "utf8"), content);
    }
  } finally {
    await f.cleanup();
  }
});
