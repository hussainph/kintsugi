import assert from "node:assert/strict";
import { test } from "node:test";
import { HELD, Saves } from "./saves.ts";

const disk = () => {
  const files = new Map<string, string>();
  const broken = new Set<string>();
  const write = async (path: string, contents: string) => {
    if (broken.has(path)) throw `permission denied: ${path}`;
    files.set(path, contents);
  };
  return { files, broken, write };
};

test("a failed write stays pending until a retry reaches the disk", async () => {
  const d = disk();
  const saves = new Saves(d.write);
  d.broken.add("a.md");
  saves.set("a.md", "marker");
  saves.set("b.md", "fine");
  assert.deepEqual(await saves.flush(), { ok: false, failures: [{ path: "a.md", error: "permission denied: a.md" }] });
  assert.deepEqual(saves.paths(), ["a.md"]);
  assert.equal(d.files.get("b.md"), "fine");
  // Still failing: still pending, never silently dropped.
  assert.equal((await saves.flush()).ok, false);
  assert.equal(saves.size, 1);
  d.broken.clear();
  assert.deepEqual(await saves.flush(), { ok: true });
  assert.equal(saves.size, 0);
  assert.equal(d.files.get("a.md"), "marker");
});

test("discarding is the only other way out", async () => {
  const d = disk();
  const saves = new Saves(d.write);
  d.broken.add("a.md");
  saves.set("a.md", "marker");
  await saves.flush();
  assert.deepEqual(saves.discard(), ["a.md"]);
  assert.deepEqual(await saves.flush(), { ok: true });
  assert.equal(d.files.has("a.md"), false);
});

test("keystrokes typed during a write stay pending; flushes never overlap", async () => {
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const saves = new Saves(async (_path, contents) => {
    order.push(`start ${contents}`);
    if (contents === "one") await gate;
    order.push(`end ${contents}`);
  });
  saves.set("a.md", "one");
  const first = saves.flush();
  await Promise.resolve();
  saves.set("a.md", "two");
  const second = saves.flush();
  release();
  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(saves.paths(), ["a.md"], "'two' arrived during the write");
  await second;
  assert.equal(saves.size, 0);
  assert.deepEqual(order, ["start one", "end one", "start two", "end two"]);
});

test("the phone's newer copy replaces a pending write", async () => {
  const d = disk();
  const saves = new Saves(d.write);
  saves.set("a.md", "here");
  saves.drop("a.md");
  await saves.flush();
  assert.equal(d.files.has("a.md"), false);
});

test("a held change is neither written nor dropped until it is released", async () => {
  const d = disk();
  const saves = new Saves(d.write);
  saves.set("a.md", "mine");
  saves.set("b.md", "fine");
  saves.hold("a.md");
  assert.deepEqual(await saves.flush(), { ok: false, failures: [{ path: "a.md", error: HELD, held: true }] });
  assert.equal(d.files.has("a.md"), false);
  assert.equal(d.files.get("b.md"), "fine");
  assert.deepEqual(saves.paths(), ["a.md"]);
  saves.release("a.md");
  assert.deepEqual(await saves.flush(), { ok: true });
  assert.equal(d.files.get("a.md"), "mine");
});

test("a write that finds another app's edit can hold its change", async () => {
  const saves = new Saves(async (path) => {
    saves.hold(path);
  });
  saves.set("a.md", "mine");
  assert.equal((await saves.flush()).ok, false);
  assert.deepEqual(saves.paths(), ["a.md"], "still pending");
});
