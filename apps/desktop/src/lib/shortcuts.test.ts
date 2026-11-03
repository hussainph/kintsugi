import assert from "node:assert/strict";
import { test } from "node:test";
import { holdCommand } from "./holdCommand.ts";
import { keysOf, matches } from "./keys.ts";
import { SHORTCUTS } from "./shortcuts.ts";
import { textSizeForKey } from "./textSize.ts";

const key = (key: string, mods: Partial<Record<"metaKey" | "shiftKey" | "altKey" | "ctrlKey", boolean>> = {}, code = "") => ({
  key, code, metaKey: false, shiftKey: false, altKey: false, ctrlKey: false, ...mods,
});

test("specs read as Mac shortcuts, modifiers in Apple's order", () => {
  assert.equal(keysOf("Mod-Shift-f"), "⇧⌘F");
  assert.equal(keysOf("Mod-Alt-e"), "⌥⌘E");
  assert.equal(keysOf("Ctrl-Alt-Shift-Mod-x"), "⌃⌥⇧⌘X");
  assert.equal(keysOf("Mod--"), "⌘−");
  assert.equal(keysOf("Mod-\\"), "⌘\\");
  assert.equal(keysOf("Mod-Backspace"), "⌘⌫");
  assert.equal(keysOf("Escape"), "Esc");
});

test("a keydown matches only with exactly the spec's modifiers", () => {
  assert.ok(matches(key("f", { metaKey: true, shiftKey: true }), "Mod-Shift-f"));
  assert.ok(matches(key("F", { metaKey: true, shiftKey: true }), "Mod-Shift-f"));
  assert.ok(!matches(key("f", { metaKey: true }), "Mod-Shift-f"));
  assert.ok(!matches(key("f", { metaKey: true, shiftKey: true, altKey: true }), "Mod-Shift-f"));
  // ⌥ changes the character; the physical key still counts.
  assert.ok(matches(key("´", { metaKey: true, altKey: true }, "KeyE"), "Mod-Alt-e"));
  // Another layout's letter is the letter he sees, not the physical key.
  assert.ok(!matches(key("l", { metaKey: true }, "KeyP"), "Mod-p"));
  assert.ok(matches(key("&", { metaKey: true, shiftKey: true }, "Digit7"), "Mod-Shift-7"));
  assert.ok(matches(key(",", { metaKey: true }), "Mod-,"));
  assert.ok(matches(key("-", { metaKey: true }), "Mod--"));
  assert.ok(matches(key("Escape"), "Escape"));
});

test("every app shortcut is distinct, and the text-size ones are the keys textSize handles", () => {
  const specs = Object.values(SHORTCUTS).map((s) => s.key);
  assert.equal(new Set(specs).size, specs.length);
  for (const id of ["textLarger", "textSmaller", "textReset"] as const) {
    const spec = SHORTCUTS[id].key;
    assert.notEqual(textSizeForKey(spec.slice("Mod-".length)), null, spec);
  }
});

function fakeTimers() {
  let pending: (() => void) | null = null;
  return {
    timers: { set: (run: () => void) => { pending = run; return 1; }, clear: () => { pending = null; } },
    fire: () => { const run = pending; pending = null; run?.(); },
    get armed() { return pending !== null; },
  };
}

function press(target: EventTarget, type: string, init: Record<string, unknown>) {
  target.dispatchEvent(Object.assign(new Event(type), init));
}

test("holding ⌘ alone shows the shortcuts until it's let go", () => {
  const target = new EventTarget();
  const clock = fakeTimers();
  const seen: boolean[] = [];
  const stop = holdCommand(target, (shown) => seen.push(shown), clock.timers);
  press(target, "keydown", { key: "Meta", metaKey: true });
  assert.ok(clock.armed);
  press(target, "keydown", { key: "Meta", metaKey: true, repeat: true });
  clock.fire();
  assert.deepEqual(seen, [true]);
  press(target, "keyup", { key: "Meta", metaKey: false });
  assert.deepEqual(seen, [true, false]);
  stop();
});

test("a ⌘-combo, a click or leaving the window cancels the hold", () => {
  const target = new EventTarget();
  const clock = fakeTimers();
  const seen: boolean[] = [];
  holdCommand(target, (shown) => seen.push(shown), clock.timers);

  press(target, "keydown", { key: "Meta", metaKey: true });
  press(target, "keydown", { key: "s", metaKey: true });
  assert.ok(!clock.armed);

  press(target, "keydown", { key: "Meta", metaKey: true, shiftKey: true });
  assert.ok(!clock.armed, "⇧ held first is a combo, not a hold");

  press(target, "keyup", { key: "Shift", metaKey: false });
  press(target, "keydown", { key: "Meta", metaKey: true });
  clock.fire();
  press(target, "pointerdown", {});
  press(target, "keydown", { key: "Meta", metaKey: true });
  clock.fire();
  press(target, "blur", {});
  assert.deepEqual(seen, [true, false, true, false]);
});
