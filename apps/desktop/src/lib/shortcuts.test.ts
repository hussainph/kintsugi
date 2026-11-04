import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { builtinKeymap, macSpecs } from "@kintsugi/editor/keymaps";
import { formatKeymap } from "@kintsugi/editor/format";
import { alternativeShortcuts } from "@kintsugi/editor/alternatives";
import { stashShortcuts } from "@kintsugi/editor/stash";
import { ACTIONS } from "../refine/prompts.ts";
import { holdCommand } from "./holdCommand.ts";
import { canonical, keysOf, matches } from "./keys.ts";
import {
  EDIT_KEYS, entries, filterSections, GROUPS, OVERRIDES, README_END, README_START, readmeTables, rowsOf, type Scope, sections, SHORTCUTS,
} from "./shortcuts.ts";
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
  // ⇧ turns / into ?; the physical key counts.
  assert.ok(matches(key("?", { metaKey: true, shiftKey: true }, "Slash"), "Mod-Shift-/"));
  assert.ok(!matches(key("/", { metaKey: true }, "Slash"), "Mod-Shift-/"));
  assert.ok(matches(key("†", { metaKey: true, altKey: true }, "KeyT"), "Mod-Alt-t"));
  assert.ok(matches(key("F10", { shiftKey: true }), "Shift-F10"));
});

test("one spelling per key", () => {
  assert.equal(canonical("Shift-Mod-z"), canonical("Mod-Shift-z"));
  assert.equal(canonical("Mod-Z"), canonical("Mod-Shift-z"));
  assert.equal(canonical("Cmd-ArrowUp"), canonical("Mod-ArrowUp"));
  assert.notEqual(canonical("Ctrl-k"), canonical("Mod-k"));
});

/** Scopes whose keys are live at the same time. */
function together(a: Scope, b: Scope): boolean {
  if (a === b || a === "app" || b === "app" || a === "system" || b === "system") return true;
  const pair = new Set([a, b]);
  return (pair.has("writing") && (pair.has("editor") || pair.has("refine")));
}

type Use = { spec: string; scope: Scope; from: string };

function uses(): Use[] {
  const out: Use[] = [];
  for (const s of entries()) {
    if (s.typed || s.builtin) continue;
    const scope = s.scope ?? (s.group ? GROUPS[s.group].scope : "app");
    // Formatting entries are the editor's keymap below.
    if (s.group === "formatting") continue;
    out.push({ spec: s.key, scope, from: `${s.id ?? "system"}: ${s.label}${s.soon ? ` (${s.soon})` : ""}` });
  }
  for (const binding of formatKeymap) out.push({ spec: binding.key!, scope: "editor", from: `format: ${binding.key}` });
  for (const binding of builtinKeymap) for (const spec of macSpecs(binding)) out.push({ spec, scope: "editor", from: `codemirror: ${spec}` });
  return out;
}

test("no two shortcuts share a key where both work, CodeMirror's and the Mac's included", () => {
  const byKey = new Map<string, Use[]>();
  for (const use of uses()) {
    const id = canonical(use.spec);
    byKey.set(id, [...(byKey.get(id) ?? []), use]);
  }
  const clashes: string[] = [];
  const overridden = new Set<string>();
  for (const [id, list] of byKey) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const [a, b] = [list[i], list[j]];
        // CodeMirror's keymaps fall through to each other on purpose.
        if (a.from.startsWith("codemirror") && b.from.startsWith("codemirror")) continue;
        if (!together(a.scope, b.scope)) continue;
        if (OVERRIDES[id]) overridden.add(id);
        else clashes.push(`${keysOf(a.spec)}: ${a.from} / ${b.from}`);
      }
    }
  }
  assert.deepEqual(clashes, [], "Pick another key, or add it to OVERRIDES with the reason");
  assert.deepEqual(Object.keys(OVERRIDES).filter((id) => !overridden.has(id)), [], "OVERRIDES entries that no longer clash");
});

test("⌘/ is Dim's alone: CodeMirror's comment toggles are out of the keymap", () => {
  const dim = uses().filter((use) => canonical(use.spec) === canonical("Mod-/"));
  assert.deepEqual(dim.map((use) => use.from), ["format: Mod-/"]);
  assert.ok(!OVERRIDES[canonical("Mod-/")]);
});

test("the alternatives keys listed are the editor's", () => {
  const listed = entries().filter((s) => s.group === "alternatives").map((s) => [canonical(s.key), s.label]);
  assert.deepEqual(listed, alternativeShortcuts.map((s) => [canonical(s.key), s.label]));
});

test("the stash keys listed are the editor's", () => {
  const listed = entries().filter((s) => s.group === "stash").map((s) => [canonical(s.key), s.label]);
  assert.deepEqual(listed, stashShortcuts.map((s) => [canonical(s.key), s.label]));
});

test("CodeMirror's keys in the list are still its keys", () => {
  const theirs = new Set(builtinKeymap.flatMap(macSpecs).map(canonical));
  for (const s of entries().filter((s) => s.builtin)) assert.ok(theirs.has(canonical(s.key)), `${s.label} ${s.key}`);
});

test("every edit with a key is one of ⌘K's edits", () => {
  for (const id of Object.keys(EDIT_KEYS)) assert.ok(ACTIONS.some((a) => a.id === id), id);
});

test("the list has every shortcut but the reserved and hidden ones, grouped", () => {
  const listed = sections().flatMap((s) => s.rows.map((r) => r.label));
  for (const s of entries()) {
    if (s.soon || !s.group) assert.ok(!listed.includes(s.label) || entries().some((o) => o !== s && o.label === s.label && o.group), s.label);
    else assert.ok(listed.includes(s.label), s.label);
  }
  const heading = sections(["formatting"])[0].rows.find((r) => r.label === "Heading");
  assert.deepEqual(heading?.keys, ["⌥⌘1–6"]);
  assert.deepEqual(rowsOf([SHORTCUTS.back, SHORTCUTS.backAlt]), [{ label: "Back", keys: ["Esc", "⌘["] }]);
  assert.deepEqual(sections(["formatting"])[0].rows.find((r) => r.label === "Link a document or clip")?.keys, ["@", "[["]);
});

test("typing filters the list by name, group or key", () => {
  const find = (query: string) => filterSections(sections(), query).flatMap((s) => s.rows.map((r) => r.label));
  assert.deepEqual(find("tight"), ["Tighten"]);
  assert.ok(find("opt t").includes("Tighten"));
  assert.ok(find("⌥⌘T").includes("Tighten"));
  assert.ok(find("formatting").includes("Bold"));
  assert.deepEqual(find("nothing like this"), []);
});

test("README's shortcut tables are the registry's", () => {
  const path = resolve(import.meta.dirname, "../../../../README.md");
  const readme = readFileSync(path, "utf8");
  const start = readme.indexOf(README_START);
  const end = readme.indexOf(README_END);
  assert.ok(start >= 0 && end > start, "README has the shortcut markers");
  const now = readme.slice(start + README_START.length, end).trim();
  assert.equal(now, readmeTables(), "Run pnpm shortcuts:readme");
});

test("the text-size shortcuts are the keys textSize handles", () => {
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
