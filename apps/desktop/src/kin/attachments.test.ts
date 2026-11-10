import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attachmentError,
  attachmentFailure,
  createAttachmentQueue,
  importAttachmentFiles,
  imageAttachment,
  imageModelWarning,
  MAX_ATTACHMENT_BYTES,
  type AttachmentFile,
} from "./attachments.ts";
import type { Chip } from "../lib/chips.ts";

const file = (name = "photo.png", size = 3, type = ""): AttachmentFile => ({
  name, size, type,
  arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
});
const chip: Chip = { kind: "attachment", path: "@attachment/staged/photo.png", label: "photo.png" };

test("attachments accept images, PDF, Markdown and text with a per-file cap", () => {
  for (const name of ["photo.png", "PHOTO.JPG", "paper.pdf", "notes.md", "notes.markdown", "notes.txt", "photo.webp"])
    assert.equal(attachmentError([file(name)], 0), null);
  assert.equal(attachmentError([file("clipboard", 3, "image/png")], 0), null);
  assert.equal(attachmentError([file("archive.zip")], 0), "Choose an image, PDF, Markdown or text file.");
  assert.equal(attachmentError([file("photo.png", MAX_ATTACHMENT_BYTES)], 0), null);
  assert.equal(attachmentError([file("photo.png", MAX_ATTACHMENT_BYTES + 1)], 0), "Each file must be 20 MiB or smaller.");
});

test("the eight-file limit counts attachments already pending", () => {
  assert.equal(attachmentError([file()], 7), null);
  assert.equal(attachmentError([file()], 8), "Up to 8 files per message.");
  assert.equal(attachmentError(Array.from({ length: 9 }, () => file()), 0), "Up to 8 files per message.");
});

test("file import sends bytes and pins the backend's opaque reference", async () => {
  const imported: unknown[] = [];
  const appended: Chip[] = [];
  await importAttachmentFiles([file()], () => true, async (name, bytes) => {
    imported.push({ name, bytes });
    return chip;
  }, (value) => appended.push(value));
  assert.deepEqual(imported, [{ name: "photo.png", bytes: [1, 2, 3] }]);
  assert.deepEqual(appended, [chip]);
});

test("switching composer or vault while reading prevents an import", async () => {
  let active = true;
  let imports = 0;
  const reading: AttachmentFile = { ...file(), arrayBuffer: async () => {
    active = false;
    return new ArrayBuffer(3);
  } };
  await importAttachmentFiles([reading], () => active, async () => { imports++; return chip; }, () => assert.fail("stale chip"));
  assert.equal(imports, 0);
});

test("switching while importing discards the response and the remaining batch", async () => {
  let active = true;
  let imports = 0;
  await importAttachmentFiles([file(), file("other.png")], () => active, async () => {
    imports++;
    active = false;
    return chip;
  }, () => assert.fail("stale chip"));
  assert.equal(imports, 1);
});

test("image warnings distinguish text attachments and unknown model capability", () => {
  assert.equal(imageAttachment(chip), true);
  assert.equal(imageAttachment({ ...chip, kind: "doc" }), false);
  assert.equal(imageAttachment({ ...chip, path: "@attachment/thread/photo.HEIC" }), true);
  assert.equal(imageModelWarning([{ ...chip, path: "@attachment/thread/notes.txt" }], false, []), null);
  assert.equal(imageModelWarning([chip], true, []), null);
  assert.equal(imageModelWarning([chip], undefined, []), null);
  assert.equal(imageModelWarning([chip], false, []), "This model can’t view images.");
});

test("image warnings suggest a usable enabled model before a model in Settings", () => {
  const alternatives = [
    { name: "Unavailable", images: true, usable: false, enabled: true },
    { name: "Text only", images: false, usable: true, enabled: true },
    { name: "Vision A", images: true, usable: true, enabled: false },
    { name: "Vision B", images: true, usable: true, enabled: true },
  ];
  assert.equal(imageModelWarning([chip], false, alternatives), "This model can’t view images. Try Vision B.");
  assert.equal(imageModelWarning([chip], false, alternatives.slice(0, 3)), "This model can’t view images. Enable Vision A.");
});

test("failed imports stop the batch without losing files already staged", async () => {
  const appended: Chip[] = [];
  await assert.rejects(importAttachmentFiles([file(), file("bad.png")], () => true, async (name) => {
    if (name === "bad.png") throw new Error("Unreadable image");
    return chip;
  }, (value) => appended.push(value)), /Unreadable image/);
  assert.deepEqual(appended, [chip]);
  assert.equal(attachmentFailure("Couldn't attach\n  Try again."), "Couldn't attach Try again.");
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const importedChip = (name: string): Chip => ({ ...chip, path: `@attachment/staged/${name}`, label: name });

function queueHarness(importFile = async (name: string) => importedChip(name)) {
  const pending: Chip[] = [];
  const errors: unknown[] = [];
  const busy: boolean[] = [];
  const epoch = { composer: 0, vault: 0 };
  const { composer, vault } = epoch;
  const queue = createAttachmentQueue({
    current: () => epoch.composer === composer && epoch.vault === vault,
    pendingCount: () => pending.length,
    importFile,
    append: (value) => pending.push(value),
    importing: (value) => busy.push(value),
    error: (error) => errors.push(error),
  });
  return { queue, pending, errors, busy, cancel: (boundary: "composer" | "vault") => { epoch[boundary]++; } };
}

test("overlapping paste and drop batches reserve immediately and import serially", async () => {
  const reading = deferred<ArrayBuffer>();
  const importing = deferred<Chip>();
  const entered = deferred<void>();
  const reads: string[] = [];
  const imports: string[] = [];
  const h = queueHarness(async (name) => {
    imports.push(name);
    if (name === "paste.png") {
      entered.resolve();
      return importing.promise;
    }
    return importedChip(name);
  });
  const paste = h.queue.enqueue([{ ...file("paste.png"), arrayBuffer: () => {
    reads.push("paste.png");
    return reading.promise;
  } }]);
  assert.equal(h.busy.at(-1), true, "busy before either read completes");
  await Promise.resolve();
  assert.deepEqual(reads, ["paste.png"]);
  const drop = h.queue.enqueue([{ ...file("drop.png"), arrayBuffer: async () => {
    reads.push("drop.png");
    return new ArrayBuffer(3);
  } }]);
  reading.resolve(new ArrayBuffer(3));
  await entered.promise;
  assert.deepEqual(imports, ["paste.png"]);
  assert.deepEqual(reads, ["paste.png"], "queued files are not read ahead");
  const screenshot = h.queue.enqueue([file("screenshot.png")]);
  importing.resolve(importedChip("paste.png"));
  await paste;
  assert.equal(h.busy.at(-1), true, "send stays blocked while drop is queued");
  assert.equal(h.pending[0]?.label, "paste.png");
  await Promise.all([drop, screenshot]);
  assert.deepEqual(imports, ["paste.png", "drop.png", "screenshot.png"]);
  assert.deepEqual(h.pending.map((value) => value.label), ["paste.png", "drop.png", "screenshot.png"]);
  assert.deepEqual(h.errors, []);
  assert.equal(h.busy.at(-1), false);
  assert.equal(h.busy.filter((value) => !value).length, 1, "no idle gap between batches");
});

test("eight slots include pending chips, in-flight reads and queued batches", async () => {
  const reading = deferred<ArrayBuffer>();
  const h = queueHarness();
  h.pending.push(importedChip("already.png"));
  const paste = h.queue.enqueue([{ ...file("paste.png"), arrayBuffer: () => reading.promise }]);
  const drop = h.queue.enqueue(Array.from({ length: 6 }, (_, i) => file(`drop-${i}.png`)));
  let overflowRead = false;
  const overflow = () => h.queue.enqueue([{ ...file("overflow.png"), arrayBuffer: async () => {
    overflowRead = true;
    return new ArrayBuffer(3);
  } }]);
  await overflow();
  assert.deepEqual(h.errors, ["Up to 8 files per message."]);
  assert.equal(overflowRead, false);
  assert.equal(h.busy.at(-1), true);
  reading.resolve(new ArrayBuffer(3));
  await Promise.all([paste, drop]);
  assert.equal(h.pending.length, 8, "accepted files become pending, not extra reservations");
  await overflow();
  assert.equal(h.errors.length, 2, "completed imports still occupy slots");
  h.pending.pop();
  await h.queue.enqueue([file("replacement.png")]);
  assert.equal(h.pending.length, 8, "removing a chip frees exactly one slot");
  assert.equal(h.pending.at(-1)?.label, "replacement.png");
});

test("a failed batch releases its remaining slots, preserves successes and drains later events", async () => {
  const importing = deferred<Chip>();
  const entered = deferred<void>();
  const imports: string[] = [];
  const h = queueHarness(async (name) => {
    imports.push(name);
    if (name === "bad.png") {
      entered.resolve();
      return importing.promise;
    }
    return importedChip(name);
  });
  const first = h.queue.enqueue([file("good.png"), file("bad.png"), file("unread.png")]);
  await entered.promise;
  const later = h.queue.enqueue([file("later.png")]);
  importing.reject(new Error("Unreadable image"));
  await first;
  assert.equal(h.busy.at(-1), true);
  await later;
  assert.deepEqual(imports, ["good.png", "bad.png", "later.png"]);
  assert.deepEqual(h.pending.map((value) => value.label), ["good.png", "later.png"]);
  assert.match(String(h.errors[0]), /Unreadable image/);
  await h.queue.enqueue(Array.from({ length: 6 }, (_, i) => file(`retry-${i}.png`)));
  assert.equal(h.pending.length, 8, "failed and skipped files release reservations");
  assert.equal(h.errors.length, 1);
  assert.equal(h.busy.at(-1), false);
});

test("read failures and rejected validation do not hold slots or lose pending chips", async () => {
  const h = queueHarness();
  h.pending.push(importedChip("pending.png"));
  await h.queue.enqueue([file("archive.zip")]);
  assert.deepEqual(h.busy, []);
  await h.queue.enqueue([{ ...file(), arrayBuffer: async () => { throw new Error("Read failed"); } }]);
  assert.equal(h.busy.at(-1), false);
  assert.equal(h.pending[0]?.label, "pending.png");
  await h.queue.enqueue(Array.from({ length: 7 }, (_, i) => file(`after-${i}.png`)));
  assert.equal(h.pending.length, 8);
  assert.equal(h.errors.length, 2);
});

for (const boundary of ["composer", "vault"] as const) {
  for (const phase of ["read", "import", "failure"]) {
    test(`${boundary} switch during ${phase} drops stale work without blocking the next composer`, async () => {
      const blocked = deferred<Chip>();
      const reading = deferred<ArrayBuffer>();
      const entered = deferred<void>();
      const imports: string[] = [];
      const old = queueHarness(async (name) => {
        imports.push(name);
        entered.resolve();
        return blocked.promise;
      });
      const first = old.queue.enqueue([{ ...file("old.png"), arrayBuffer: () => {
        if (phase === "read") {
          entered.resolve();
          return reading.promise;
        }
        return Promise.resolve(new ArrayBuffer(3));
      } }]);
      const queued = old.queue.enqueue([file("old-queued.png")]);
      await entered.promise;
      old.cancel(boundary);
      const notifications = old.busy.length;
      // useKin resets its queue on both composer and vault changes.
      const next = queueHarness();
      await next.queue.enqueue(Array.from({ length: 8 }, (_, i) => file(`new-${i}.png`)));
      assert.equal(next.pending.length, 8, "old reservations do not carry over or block new work");
      if (phase === "read") reading.resolve(new ArrayBuffer(3));
      else if (phase === "failure") blocked.reject(new Error("Stale failure"));
      else blocked.resolve(importedChip("old.png"));
      await Promise.all([first, queued]);
      assert.deepEqual(imports, phase === "read" ? [] : ["old.png"]);
      assert.deepEqual(old.pending, []);
      assert.deepEqual(old.errors, [], "stale failures are not shown in the new composer");
      assert.equal(old.busy.length, notifications, "stale finalizers cannot clear the new busy state");
      assert.equal(next.pending.length, 8);
      assert.equal(next.busy.at(-1), false);
    });
  }
}
