import assert from "node:assert/strict";
import { test } from "node:test";
import { createLabBridge, installLabBridge } from "./install.ts";

test("unknown commands fail closed, including native/file operations", async () => {
  const bridge = createLabBridge();
  for (const command of [
    "vault_current",
    "clip_image",
    "plugin:opener|open_url",
    "plugin:window|start_dragging",
  ]) {
    await assert.rejects(
      bridge.internals.invoke(command),
      /no fixture handler/,
    );
  }
  assert.throws(
    () => bridge.internals.convertFileSrc(),
    /filesystem assets are unavailable/,
  );
});

test("entry registration replaces handlers and stale cleanup cannot clear a newer entry", async () => {
  const bridge = createLabBridge();
  const dispose = bridge.register("component/one", { one: () => 1 });
  bridge.register("component/two", { two: () => 2 });
  dispose();
  assert.equal(await bridge.internals.invoke("two"), 2);
  await assert.rejects(bridge.internals.invoke("one"), /no fixture handler/);
});

test("event listen, emit, unlisten and once callbacks match Tauri event contracts", async () => {
  const bridge = createLabBridge();
  const received: unknown[] = [];
  const handler = bridge.internals.transformCallback((event) =>
    received.push(event),
  );
  const eventId = await bridge.internals.invoke("plugin:event|listen", {
    event: "clips:changed",
    handler,
  });
  bridge.emit("clips:changed", { path: "inspiration/a.md" });
  assert.deepEqual(received, [
    {
      event: "clips:changed",
      id: eventId,
      payload: { path: "inspiration/a.md" },
    },
  ]);
  bridge.eventInternals.unregisterListener("clips:changed", Number(eventId));
  await bridge.internals.invoke("plugin:event|unlisten", {
    event: "clips:changed",
    eventId,
  });
  bridge.emit("clips:changed", {});
  assert.equal(received.length, 1);
  let onceCount = 0;
  const once = bridge.internals.transformCallback(() => {
    onceCount++;
  }, true);
  bridge.internals.runCallback(once, "once");
  bridge.internals.runCallback(once, "twice");
  assert.equal(onceCount, 1);
});

test("image fixtures retain binary buffers; installing refuses a native runtime", async () => {
  const bridge = createLabBridge();
  bridge.register("component/clip-card", {
    clip_image: () => Uint8Array.from([137, 80, 78, 71]).buffer,
  });
  assert.ok(
    (await bridge.internals.invoke("clip_image")) instanceof ArrayBuffer,
  );
  assert.throws(
    () => installLabBridge({ __TAURI_INTERNALS__: {} }),
    /refuses to replace/,
  );
  const win = {};
  installLabBridge(win);
  assert.ok("__TAURI_INTERNALS__" in win);
});
