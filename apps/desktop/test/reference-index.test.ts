import assert from "node:assert/strict";
import { test } from "node:test";
import { IndexStore, type ReferenceIndex } from "../src/references/useReferenceIndex.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const snapshot = (path: string): ReferenceIndex => ({ documents: [{ path, title: path, status: "draft", text: "" }], clips: [], links: [] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const requests: ReturnType<typeof deferred<ReferenceIndex>>[] = [];
  const watchers = new Map<string, () => void>();
  const store = new IndexStore(() => {
    const request = deferred<ReferenceIndex>(); requests.push(request); return request.promise;
  }, async (event, changed) => {
    watchers.set(event, changed);
    return () => { if (watchers.get(event) === changed) watchers.delete(event); };
  });
  return { store, requests, watchers };
}

test("margin and Used in subscriptions share one scan and listen to every mutation channel", async () => {
  const { store, requests, watchers } = fixture();
  let updates = 0;
  const first = store.subscribe(() => updates++);
  const second = store.subscribe(() => updates++);
  await tick();
  assert.deepEqual([...watchers.keys()].sort(), ["clips:changed", "references:changed", "vault:changed"]);
  assert.equal(requests.length, 1);
  requests[0].resolve(snapshot("one.md"));
  await tick();
  assert.equal(updates, 2);
  assert.equal(store.getSnapshot().documents[0].path, "one.md");
  first(); await tick();
  assert.equal(watchers.size, 3);
  second(); await tick();
  assert.equal(watchers.size, 0);
});

test("saves and clip changes during a scan coalesce into one follow-up without losing the update", async () => {
  const { store, requests, watchers } = fixture();
  const stop = store.subscribe(() => {});
  await tick();
  watchers.get("references:changed")!();
  watchers.get("clips:changed")!();
  watchers.get("vault:changed")!();
  assert.equal(requests.length, 1);
  requests[0].resolve(snapshot("before.md")); await tick();
  assert.equal(requests.length, 2);
  requests[1].resolve(snapshot("after.md")); await tick();
  assert.equal(store.getSnapshot().documents[0].path, "after.md");
  assert.equal(requests.length, 2);
  stop();
});

test("an abandoned scan cannot overwrite the remounted view's newer snapshot", async () => {
  const { store, requests } = fixture();
  const stop = store.subscribe(() => {}); await tick();
  stop();
  const nextStop = store.subscribe(() => {}); await tick();
  requests[1].resolve(snapshot("new.md")); await tick();
  requests[0].resolve(snapshot("old.md")); await tick();
  assert.equal(store.getSnapshot().documents[0].path, "new.md");
  nextStop();
});
