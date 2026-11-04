import assert from "node:assert/strict";
import { test } from "node:test";
import type { StashApi, StashItem } from "./api.ts";
import { mergeEditorItems, moveItem, splitWikiLinks } from "./model.ts";
import { StashSession } from "./persistence.ts";

const item = (id: string, patch: Partial<StashItem> = {}): StashItem => ({ id, by: "owner", kind: "text", text: id, created: "2026-11-04T10:00:00Z", ...patch });
const ids = (items: StashItem[]) => items.map((entry) => entry.id);
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function setup(initial: StashItem[] = []) {
  let disk = structuredClone(initial);
  let active = true;
  let writable = true;
  const errors: unknown[] = [];
  const calls: string[] = [];
  const api: StashApi = {
    load: async (path) => { calls.push("load"); return { path, items: structuredClone(disk) }; },
    save: async (_path, items) => { calls.push("save"); disk = structuredClone(items); },
    dismiss: async (_path, id) => { calls.push("dismiss"); disk = disk.filter((entry) => entry.id !== id); },
    ask: async () => { calls.push("ask"); },
  };
  const session = new StashSession("drafts/a.md", api, () => active, () => writable, (error) => errors.push(error));
  return { session, api, calls, errors, disk: () => disk, replace: (items: StashItem[]) => { disk = structuredClone(items); }, deactivate: () => { active = false; }, readOnly: () => { writable = false; } };
}

test("dismissing an unsaved Kin reply sends its snapshot for the signal", async () => {
  const h = setup();
  await h.session.reload();
  const reply = item("reply", { by: "kin", kind: "idea", text: "A requested reply" });
  h.session.onUpdate("drafts/a.md", [reply]);
  h.session.onUpdate("drafts/a.md", []);
  let signalled: StashItem | undefined;
  h.api.dismiss = async (_path, _id, fallback) => { signalled = fallback; };
  assert.equal(await h.session.remove(reply.id), true);
  assert.deepEqual(signalled, reply);
  assert.deepEqual(h.disk(), []);
});

test("reorder uses final positions, preserves item data and clamps boundaries", () => {
  const list = [item("a"), item("b"), item("c")];
  assert.deepEqual(ids(moveItem(list, "a", 2)), ["b", "c", "a"]);
  assert.deepEqual(ids(moveItem(list, "c", -10)), ["c", "a", "b"]);
  assert.strictEqual(moveItem(list, "missing", 1), list);
  assert.strictEqual(moveItem(list, "b", NaN), list);
  assert.deepEqual(ids(list), ["a", "b", "c"]);
});

test("late editor anchor changes preserve shared additions, ordering and changed text", () => {
  const a = item("a", { anchor: { exact: "a", prefix: "", suffix: "", line: 1 } });
  const b = item("b");
  const kin = item("kin", { by: "kin", kind: "idea" });
  const edited = [{ ...a, anchor: { ...a.anchor!, line: 2 } }, b];
  const merged = mergeEditorItems([a, b], edited, [b, { ...a, text: "changed elsewhere" }, kin]);
  assert.deepEqual(ids(merged), ["b", "a", "kin"]);
  assert.equal(merged[1].text, "changed elsewhere");
  assert.equal(merged[1].anchor?.line, 2);
});

test("editor removals never resurrect dismissed IDs, but new local items and reordering survive", () => {
  const a = item("a"), b = item("b"), c = item("c"), kin = item("kin", { by: "kin" });
  assert.deepEqual(ids(mergeEditorItems([a, b], [b, a, c], [b, kin])), ["b", "c", "kin"]);
  assert.deepEqual(ids(mergeEditorItems([a, b], [a], [b, a, kin])), ["a", "kin"]);
});

test("only explicit wikilinks become controls, with aliases and literal text retained", () => {
  assert.deepEqual(splitWikiLinks("Read [[posts/one|One]] and [[notes/two]]."), ["Read ", { target: "posts/one", label: "One" }, " and ", { target: "notes/two", label: "notes/two" }, "."]);
  assert.deepEqual(splitWikiLinks("[[ ]] and <script>keep text</script>"), ["[[ ]] and <script>keep text</script>"]);
  assert.deepEqual(splitWikiLinks("No [[unfinished"), ["No [[unfinished"]);
});

test("a failed or mismatched initial load cannot overwrite an existing stash", async () => {
  const h = setup([item("old")]);
  h.api.load = async () => { throw new Error("damaged"); };
  assert.equal(await h.session.reload(), false);
  assert.equal(await h.session.add(item("new")), false);
  assert.equal(h.session.getSnapshot().loaded, false);
  assert.deepEqual(ids(h.disk()), ["old"]);
  assert.equal(h.errors.length, 1);
  h.api.load = async () => ({ path: "drafts/wrong.md", items: [] });
  assert.equal(await h.session.reload(), false);
  assert.equal(h.session.getSnapshot().file, null);
});

test("live editor changes show immediately without replacing the disk/config baseline", async () => {
  const a = item("a");
  const h = setup([a]);
  await h.session.reload();
  h.session.onUpdate("drafts/a.md", [a, item("new")]);
  assert.deepEqual(ids(h.session.getSnapshot().items), ["a", "new"]);
  assert.deepEqual(ids(h.session.getSnapshot().file!.items), ["a"]);
  h.session.onUpdate("drafts/other.md", []);
  assert.deepEqual(ids(h.session.getSnapshot().items), ["a", "new"]);
  assert.deepEqual(h.calls, ["load"]);
});

test("serialized editor saves retain concurrent Kin items and a shared reorder", async () => {
  const a = item("a"), b = item("b"), kin = item("kin", { by: "kin", kind: "idea" });
  const h = setup([a, b]);
  await h.session.reload();
  h.replace([b, a, kin]);
  await Promise.all([
    h.session.saveEditor([a, b], [{ ...a, text: "new a" }, b]),
    h.session.saveEditor([a, b], [{ ...a, text: "newest a" }, b]),
    h.session.reload(),
  ]);
  assert.deepEqual(ids(h.disk()), ["b", "a", "kin"]);
  assert.equal(h.disk()[1].text, "newest a");
  assert.equal(h.session.getSnapshot().items[1].text, "newest a");
});

test("compare-and-save retries against disk when a shared add lands after the read", async () => {
  const a = item("a"), kin = item("kin", { by: "kin", kind: "idea" });
  const h = setup([a]);
  await h.session.reload();
  let attempts = 0;
  const save = h.api.save;
  h.api.save = async (path, items, base) => {
    attempts++;
    if (attempts === 1) {
      assert.deepEqual(ids(base!), ["a"]);
      h.replace([a, kin]);
      throw new Error("Stash changed. Reload and try again.");
    }
    assert.deepEqual(ids(base!), ["a", "kin"]);
    return save(path, items, base);
  };
  assert.equal(await h.session.saveEditor([a], [{ ...a, text: "edited" }]), true);
  assert.deepEqual(ids(h.disk()), ["a", "kin"]);
  assert.equal(h.disk()[0].text, "edited");
  assert.equal(attempts, 2);
  assert.equal(h.errors.length, 0);
});

test("refresh keeps unsaved editor removals, while acknowledging new shared items", async () => {
  const a = item("a"), b = item("b"), kin = item("kin", { by: "kin", kind: "idea" });
  const h = setup([a, b]);
  await h.session.reload();
  h.session.onChange([b]);
  h.replace([a, b, kin]);
  await h.session.reload();
  assert.deepEqual(ids(h.session.getSnapshot().items), ["b", "kin"]);
  h.session.onChange([b, kin]);
  h.session.onChange([b]);
  await h.session.flush();
  assert.deepEqual(ids(h.disk()), ["b"]);
});

test("editor reordering is saved and a later anchor-only save does not undo it", async () => {
  const a = item("a"), b = item("b");
  const h = setup([a, b]);
  await h.session.reload();
  h.session.onChange([b, a]);
  assert.deepEqual(ids(h.session.getSnapshot().items), ["b", "a"]);
  await h.session.flush();
  assert.deepEqual(ids(h.disk()), ["b", "a"]);
  await h.session.saveEditor([a, b], [{ ...a, text: "updated" }, b]);
  assert.deepEqual(ids(h.disk()), ["b", "a"]);
});

test("dismissed items are not revived by an editor save whose old baseline lacked them", async () => {
  const a = item("a"), kin = item("kin", { by: "kin", kind: "idea" });
  const h = setup([a]);
  await h.session.reload();
  h.replace([a, kin]);
  await h.session.reload();
  await h.session.remove("kin");
  assert.deepEqual(h.session.getSnapshot().dismissedIds, ["kin"]);
  await h.session.saveEditor([a], [a, kin]);
  assert.deepEqual(ids(h.disk()), ["a"]);
});

test("an explicit editor absent-to-present restore clears its dismissal tombstone", async () => {
  const a = item("a");
  const h = setup([a]);
  await h.session.reload();
  h.session.onChange([a]);
  h.session.onChange([]); // Synchronous non-history removal in the editor.
  await h.session.remove("a");
  assert.deepEqual(h.session.getSnapshot().dismissedIds, ["a"]);
  h.session.onChange([a]); // Undo/redo of an earlier stash/insert.
  assert.deepEqual(h.session.getSnapshot().dismissedIds, []);
  assert.deepEqual(ids(h.session.getSnapshot().items), ["a"]);
  await h.session.flush();
  assert.deepEqual(ids(h.disk()), ["a"]);
});

test("undo during an in-flight dismissal restores the latest editor item and disk", async () => {
  const a = item("a"), b = item("b"), kin = item("kin", { by: "kin", kind: "idea" });
  const h = setup([a, b]);
  await h.session.reload();
  h.session.onChange([a, b]);
  h.session.onChange([b]);
  const requested = deferred<void>();
  const started = deferred<void>();
  const dismiss = h.api.dismiss;
  h.api.dismiss = async (path, id) => { started.resolve(); await requested.promise; return dismiss(path, id); };
  const removing = h.session.remove("a");
  await started.promise;
  const staleSave = h.session.flush(); // Old debounce snapshot lacks a.
  h.session.onChange([b, a]); // Undo while the network request is pending.
  h.session.onChange([b, { ...a, text: "restored latest" }, item("local")]);
  h.replace([a, b, kin]);
  requested.resolve();
  assert.equal(await removing, true);
  await staleSave;
  assert.deepEqual(h.session.getSnapshot().dismissedIds, []);
  assert.deepEqual(ids(h.disk()), ["b", "a", "local", "kin"]);
  assert.equal(h.disk().find((entry) => entry.id === "a")?.text, "restored latest");
  assert.equal(h.session.getSnapshot().items.find((entry) => entry.id === "a")?.text, "restored latest");
});

test("a restore followed by another editor removal during dismiss stays removed", async () => {
  const a = item("a");
  const h = setup([a]);
  await h.session.reload();
  h.session.onChange([a]);
  h.session.onChange([]);
  const requested = deferred<void>();
  const started = deferred<void>();
  const dismiss = h.api.dismiss;
  h.api.dismiss = async (path, id) => { started.resolve(); await requested.promise; return dismiss(path, id); };
  const removing = h.session.remove("a");
  await started.promise;
  h.session.onChange([a]);
  h.session.onChange([]);
  requested.resolve();
  await removing;
  assert.deepEqual(h.session.getSnapshot().dismissedIds, ["a"]);
  assert.deepEqual(h.disk(), []);
});

test("a failed optimistic removal survives an already queued deletion save and can be restored", async () => {
  const a = item("a"), b = item("b");
  const h = setup([a, b]);
  await h.session.reload();
  h.session.onChange([a, b]);
  h.session.onChange([b]);
  const requested = deferred<void>();
  const started = deferred<void>();
  h.api.dismiss = async () => { started.resolve(); await requested.promise; };
  const removing = h.session.remove("a");
  await started.promise;
  const staleSave = h.session.flush();
  h.session.onChange([b, item("local")]);
  requested.reject(new Error("disk full"));
  assert.equal(await removing, false);
  await staleSave;
  assert.deepEqual(h.session.getSnapshot().dismissedIds, []);
  assert.deepEqual(ids(h.disk()), ["a", "b", "local"]);
  assert.deepEqual(ids(h.session.getSnapshot().items), ["a", "b", "local"]);
  // Explicit recovery releases the guard, so a later real insert can consume it.
  h.session.onChange([a, b, item("local")]);
  h.session.onChange([b, item("local")]);
  await h.session.flush();
  assert.deepEqual(ids(h.disk()), ["b", "local"]);
});

test("recovery snapshots expose the item and position, stay stable, and clear after editor restoration", async () => {
  const a = item("a"), b = item("b"), c = item("c");
  const h = setup([a, b, c]);
  const empty = h.session.getSnapshot().recoveryItems;
  assert.deepEqual(empty, []);
  await h.session.reload();
  h.session.onChange([a, b, c]);
  assert.strictEqual(h.session.getSnapshot().recoveryItems, empty);
  h.session.onChange([a, c]);
  h.api.dismiss = async () => { throw new Error("unavailable"); };
  assert.equal(await h.session.remove("b"), false);
  const pending = h.session.getSnapshot().recoveryItems;
  assert.deepEqual(pending, [{ item: b, index: 1 }]);
  assert.notStrictEqual(pending, empty);
  await h.session.reload();
  h.session.onChange([a, c, item("local")]);
  await h.session.flush();
  assert.strictEqual(h.session.getSnapshot().recoveryItems, pending);
  // The parent effect explicitly adds the item to the matching editor.
  h.session.onChange([a, b, c, item("local")]);
  const cleared = h.session.getSnapshot().recoveryItems;
  assert.deepEqual(cleared, []);
  assert.notStrictEqual(cleared, pending);
  h.session.onChange([a, b, c]);
  await h.session.flush();
  await h.session.reload();
  assert.strictEqual(h.session.getSnapshot().recoveryItems, cleared);
});

test("a failed removal of an unsaved note retains a recoverable item for the next flush", async () => {
  const a = item("a"), note = item("note", { text: "Not saved yet." });
  const h = setup([a]);
  await h.session.reload();
  h.session.onChange([a, note]);
  h.session.onChange([a]);
  h.api.dismiss = async () => { throw new Error("unavailable"); };
  assert.equal(await h.session.remove("note"), false);
  assert.deepEqual(ids(h.session.getSnapshot().items), ["a", "note"]);
  assert.equal(await h.session.flush(), true);
  assert.deepEqual(ids(h.disk()), ["a", "note"]);
});

test("undo before a failed dismiss does not leave a permanent recovery guard", async () => {
  const a = item("a");
  const h = setup([a]);
  await h.session.reload();
  h.session.onChange([a]);
  h.session.onChange([]);
  const requested = deferred<void>();
  const started = deferred<void>();
  h.api.dismiss = async () => { started.resolve(); await requested.promise; };
  const removing = h.session.remove("a");
  await started.promise;
  h.session.onChange([a]);
  requested.reject(new Error("disk full"));
  assert.equal(await removing, false);
  await h.session.flush();
  h.session.onChange([]);
  await h.session.flush();
  assert.deepEqual(h.disk(), []);
});

test("an unchanged old editor snapshot does not clear a successful dismissal", async () => {
  const a = item("a");
  const h = setup([a]);
  await h.session.reload();
  h.session.onChange([a]);
  await h.session.remove("a");
  h.session.onChange([a]);
  assert.deepEqual(h.session.getSnapshot().dismissedIds, ["a"]);
  assert.deepEqual(h.session.getSnapshot().items, []);
});

test("a failed explicit dismissal keeps the item and does not create a tombstone", async () => {
  const h = setup([item("a")]);
  await h.session.reload();
  h.api.dismiss = async () => { throw new Error("disk full"); };
  assert.equal(await h.session.remove("a"), false);
  assert.deepEqual(h.session.getSnapshot().dismissedIds, []);
  assert.deepEqual(ids(h.session.getSnapshot().items), ["a"]);
});

test("a root switch during a write's read prevents sending that save to the next vault", async () => {
  const h = setup([item("a")]);
  await h.session.reload();
  const loaded = deferred<{ path: string; items: StashItem[] }>();
  const started = deferred<void>();
  h.api.load = async () => { started.resolve(); return loaded.promise; };
  const saving = h.session.add(item("new"));
  await started.promise;
  h.deactivate();
  loaded.resolve({ path: "drafts/a.md", items: [item("a")] });
  assert.equal(await saving, false);
  assert.ok(!h.calls.includes("save"));
  assert.deepEqual(ids(h.disk()), ["a"]);
});

test("a queued document flush completes while its root remains active", async () => {
  const h = setup([item("a")]);
  await h.session.reload();
  h.session.onUpdate("drafts/a.md", [item("a"), item("set-aside")]);
  // There is intentionally no active-document predicate on a session.
  const flush = h.session.flush();
  await h.session.reload();
  assert.equal(await flush, true);
  assert.deepEqual(ids(h.disk()), ["a", "set-aside"]);
});

test("read-only mode can read but cannot add, save, dismiss, move or ask", async () => {
  const h = setup([item("a")]);
  h.readOnly();
  assert.equal(await h.session.reload(), true);
  assert.equal(await h.session.add(item("b")), false);
  assert.equal(await h.session.saveEditor([item("a")], []), false);
  assert.equal(await h.session.remove("a"), false);
  assert.equal(await h.session.move("a", 1), false);
  assert.equal(await h.session.ask(), false);
  assert.deepEqual(h.calls, ["load"]);
});

test("Ask Kin is explicit, deduplicates requests, and flushes the newest editor stash first", async () => {
  const h = setup([item("a")]);
  await h.session.reload();
  await h.session.reload();
  assert.ok(!h.calls.includes("ask"));
  h.session.onChange([item("a"), item("pending")]);
  const requested = deferred<void>();
  const started = deferred<void>();
  h.api.ask = async (path, text) => {
    h.calls.push("ask");
    assert.equal(path, "drafts/a.md");
    assert.equal(text, "The newest draft text.");
    assert.deepEqual(ids(h.disk()), ["a", "pending"]);
    started.resolve();
    return requested.promise;
  };
  const asking = h.session.ask("The newest draft text.");
  assert.equal(h.session.getSnapshot().asking, true);
  assert.equal(await h.session.ask(), false);
  await started.promise;
  requested.resolve();
  assert.equal(await asking, true);
  assert.equal(h.session.getSnapshot().asking, false);
  assert.ok(h.calls.indexOf("save") < h.calls.indexOf("ask"));
});

test("editor writes wait for an explicit Kin turn and preserve its new arrivals", async () => {
  const h = setup([item("a")]);
  await h.session.reload();
  const requested = deferred<void>();
  const started = deferred<void>();
  h.api.ask = async () => { started.resolve(); return requested.promise; };
  const asking = h.session.ask();
  await started.promise;
  h.session.onChange([item("a"), item("local")]);
  const saving = h.session.flush();
  assert.deepEqual(ids(h.session.getSnapshot().items), ["a", "local"]);
  assert.ok(!h.calls.includes("save"));
  h.replace([item("a"), item("kin", { by: "kin", kind: "idea" })]);
  requested.resolve();
  await Promise.all([asking, saving]);
  assert.deepEqual(ids(h.disk()), ["a", "kin", "local"]);
});

test("a failed pending save stops Ask Kin and preserves the unsaved UI", async () => {
  const h = setup([item("a")]);
  await h.session.reload();
  h.session.onChange([item("a"), item("pending")]);
  h.api.save = async () => { throw new Error("disk full"); };
  assert.equal(await h.session.ask(), false);
  assert.ok(!h.calls.includes("ask"));
  assert.deepEqual(ids(h.session.getSnapshot().items), ["a", "pending"]);
  assert.equal(h.session.getSnapshot().asking, false);
  assert.equal(h.errors.length, 1);
});
