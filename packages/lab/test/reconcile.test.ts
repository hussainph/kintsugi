import assert from "node:assert/strict";
import test from "node:test";
import { reconcileValues, type Control } from "../src/schema.ts";

test("historical settings reconcile visibly without modifying history or discarding valid settings", () => {
  const controls: Record<string, Control> = {
    radius: {
      type: "number",
      default: 8,
      min: 0,
      max: 16,
      target: "src/Card.tsx#radius",
    },
    title: { type: "text", default: "Card", target: "src/Card.tsx#title" },
    enabled: { type: "boolean", default: true, target: "src/Card.tsx#enabled" },
  };
  const saved = {
    radius: 40,
    title: "Old direction",
    removed: "retained in history",
  };
  const result = reconcileValues(saved, controls);
  assert.deepEqual(result.values, {
    radius: 8,
    title: "Old direction",
    enabled: true,
  });
  assert.deepEqual(result.issues, [
    "radius no longer matches its control",
    "removed was removed",
  ]);
  assert.deepEqual(saved, {
    radius: 40,
    title: "Old direction",
    removed: "retained in history",
  });
  assert.deepEqual(reconcileValues({}, controls), {
    values: { radius: 8, title: "Card", enabled: true },
    issues: [],
  });
});
