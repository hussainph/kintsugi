import assert from "node:assert/strict";
import { test } from "node:test";
import { appearancePreference, resolveAppearance } from "./appearance.ts";

test("appearance defaults to System, including unknown stored values", () => {
  for (const value of [null, undefined, "", "sepia", {}, "system"]) assert.equal(appearancePreference(value), "system");
  assert.equal(appearancePreference("light"), "light");
  assert.equal(appearancePreference("dark"), "dark");
});

test("System follows this device; explicit light and dark ignore it", () => {
  for (const dark of [false, true]) {
    assert.equal(resolveAppearance("system", dark), dark ? "dark" : "light");
    assert.equal(resolveAppearance("light", dark), "light");
    assert.equal(resolveAppearance("dark", dark), "dark");
  }
});
