import assert from "node:assert/strict";
import { test } from "node:test";
import { installLabBridge } from "../../../bridge/install.ts";
import { createInspirationFixtures, writingPath } from "./fixtures.ts";

function setup(empty = false) {
  const bridge = installLabBridge({});
  const fixture = createInspirationFixtures("page/inspiration-library", empty);
  return { bridge, fixture, invoke: bridge.internals.invoke };
}

test("fixtures search real own text / metadata, filter tags, paginate and return copies", async () => {
  const { fixture } = setup();
  assert.equal(fixture.search().total, 6);
  assert.equal(fixture.search({ query: "seam craft" }).total, 1);
  assert.equal(fixture.search({ tags: ["attention"] }).total, 3);
  assert.equal(fixture.search({ limit: 2, offset: 2 }).clips.length, 2);
  const result = fixture.search();
  result.clips[0].title = "mutated by caller";
  assert.equal(fixture.search().clips[0].title, "The beauty of repair");
});

test("reference fixture uses product wikilink resolution and keeps missing targets visible", () => {
  const { fixture } = setup();
  const index = fixture.referenceIndex();
  assert.ok(
    index.links.some(
      (link) => link.source === writingPath && link.resolved === "on-craft.md",
    ),
  );
  assert.ok(
    index.links.some(
      (link) =>
        link.target === "an-unfinished-thought" && link.resolved === null,
    ),
  );
  assert.ok(
    index.links.some(
      (link) =>
        link.source === "notes/windows.md" &&
        link.resolved === "inspiration/the-beauty-of-repair.md",
    ),
  );
  fixture.saveDocument(writingPath, "# Revised\n\n[[a-room-to-think]]");
  assert.ok(
    fixture
      .referenceIndex()
      .links.some(
        (link) =>
          link.source === writingPath &&
          link.resolved === "inspiration/a-room-to-think.md",
      ),
  );
});

test("fixture mutations are isolated, emit events, and return actual PNG ArrayBuffers", async () => {
  const { bridge, invoke } = setup();
  const path = "inspiration/the-beauty-of-repair.md";
  const seen: unknown[] = [];
  const handler = bridge.internals.transformCallback((event) =>
    seen.push(event),
  );
  await invoke("plugin:event|listen", { event: "clips:changed", handler });
  const image = (await invoke("clip_image", { path })) as ArrayBuffer;
  assert.deepEqual(
    [...new Uint8Array(image).slice(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
  );
  const updated = (await invoke("clip_update", {
    path,
    title: "My title",
    note: "My words",
    tags: ["mine"],
  })) as { title: string; text: string; tags: string[]; summary: string };
  assert.equal(updated.title, "My title");
  assert.equal(updated.text, "My words");
  assert.deepEqual(updated.tags, ["mine"]);
  assert.equal(
    updated.summary,
    "A visible seam makes the repair part of the object’s story.",
  );
  await invoke("clip_trash", { path });
  await assert.rejects(invoke("clip_read", { path }), /not found/);
  assert.equal(seen.length, 2);
  const next = setup();
  assert.equal(
    ((await next.invoke("clip_read", { path })) as { title: string }).title,
    "The beauty of repair",
  );
});

test("capture starts in memory, source opens never navigate, and native commands remain unavailable", async () => {
  const { fixture, invoke } = setup(true);
  assert.equal(fixture.search().total, 0);
  const path = await invoke("clip_create", {
    capture: {
      text: "A passing thought",
      capturedAt: "2026-10-29T17:00",
      via: "mac",
    },
  });
  assert.equal(typeof path, "string");
  assert.equal(fixture.search().total, 1);
  assert.equal(fixture.search().clips[0].text, "A passing thought");
  await invoke("plugin:opener|open_url", {
    url: "https://example.com/fixture",
  });
  assert.deepEqual(fixture.openedSources, ["https://example.com/fixture"]);
  await assert.rejects(
    invoke("plugin:opener|open_url", { url: "file:///owner/vault" }),
    /Only HTTP/,
  );
  await assert.rejects(invoke("vault_current"), /no fixture handler/);
  await assert.rejects(
    invoke("clip_create", { capture: {} }),
    /empty fixture capture/,
  );
});
