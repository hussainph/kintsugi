import assert from "node:assert/strict";
import { test } from "node:test";
import { discardStashes, flushStashes, registerStashFlush, retireStashes, trackStashWrite } from "./stashFlush.ts";

test("stash barriers wait for every document in only the requested vault", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const seen: string[] = [];
  const off = [
    registerStashFlush("one", async () => { await pending; seen.push("draft"); return true; }),
    registerStashFlush("one", async () => { seen.push("earlier draft"); return true; }),
    registerStashFlush("two", async () => { seen.push("other vault"); return false; }),
  ];
  try {
    let done = false;
    const barrier = flushStashes("one").then((ok) => { done = true; return ok; });
    await Promise.resolve();
    assert.equal(done, false);
    assert.deepEqual(seen, ["earlier draft"]);
    release();
    assert.equal(await barrier, true);
    assert.deepEqual(seen, ["earlier draft", "draft"]);
  } finally { off.forEach((stop) => stop()); }
  assert.equal(await flushStashes("one"), true);
});

test("an in-flight reply preflight finishes before the queues flush", async () => {
  let release!: () => void;
  const checked = new Promise<void>((resolve) => { release = resolve; });
  let added = false;
  const add = trackStashWrite("reply", async () => { await checked; added = true; });
  const stop = registerStashFlush("reply", async () => { assert.equal(added, true); return true; });
  try {
    let done = false;
    const barrier = flushStashes("reply").then((ok) => { done = true; return ok; });
    await Promise.resolve();
    assert.equal(done, false);
    release();
    await add;
    assert.equal(await barrier, true);
    await assert.rejects(trackStashWrite("reply", async () => { throw new Error("rejected before mutation"); }));
    assert.equal(await flushStashes("reply"), true, "a rejected preflight cannot poison the barrier");
  } finally { stop(); }
});

test("renames retire only the saved path in the matching vault", () => {
  const retired: string[] = [];
  const off = [
    registerStashFlush("one", async () => true, undefined, (path) => retired.push(`one:${path}`)),
    registerStashFlush("two", async () => true, undefined, (path) => retired.push(`two:${path}`)),
  ];
  try {
    retireStashes("one", "drafts/moved.md");
    assert.deepEqual(retired, ["one:drafts/moved.md"]);
    retireStashes(null, "drafts/moved.md");
  } finally { off.forEach((stop) => stop()); }
});

test("only an explicit discard invalidates the matching vault's queues", async () => {
  const discarded: string[] = [];
  const off = [
    registerStashFlush("one", async () => false, () => discarded.push("one")),
    registerStashFlush("two", async () => false, () => discarded.push("two")),
  ];
  try {
    assert.equal(await flushStashes("one"), false);
    assert.deepEqual(discarded, []);
    discardStashes("one");
    assert.deepEqual(discarded, ["one"]);
    discardStashes(null);
  } finally { off.forEach((stop) => stop()); }
});

test("a rejected or failed stash write blocks the barrier, and a retry can succeed", async () => {
  let fail = true;
  const stop = registerStashFlush("vault", async () => { if (fail) throw new Error("disk full"); return true; });
  try {
    assert.equal(await flushStashes("vault"), false);
    fail = false;
    assert.equal(await flushStashes("vault"), true);
    const off = registerStashFlush("vault", async () => false);
    try { assert.equal(await flushStashes("vault"), false); } finally { off(); }
  } finally { stop(); }
  assert.equal(await flushStashes(null), true);
});
