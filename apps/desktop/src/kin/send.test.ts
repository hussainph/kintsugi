import assert from "node:assert/strict";
import { test } from "node:test";
import { createComposerSendQueue, failedSubmissionDraft, type Submission } from "./attachments.ts";
import type { Chip } from "../lib/chips.ts";

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const file: Chip = { kind: "attachment", path: "@attachment/staged/photo.png", label: "photo.png" };
const doc: Chip = { kind: "doc", path: "drafts/post.md" };
const submission = (text: string): Submission => ({ text, draft: text, chips: [doc, file] });

function harness(submit: (submission: Submission) => Promise<boolean>) {
  const scope = { composer: 0, vault: 0 };
  const { composer, vault } = scope;
  const state = { sending: false, draft: "", chips: [doc, file], thread: null as string | null };
  const busy: boolean[] = [];
  const accepted: Submission[] = [];
  const failures: { unsent: readonly Submission[]; error: unknown }[] = [];
  const queue = createComposerSendQueue({
    current: () => scope.composer === composer && scope.vault === vault,
    sending: (value) => { state.sending = value; busy.push(value); },
    submit,
    accepted: (item) => {
      accepted.push(item);
      if (state.draft === item.draft) state.draft = "";
      const sent = new Set(item.chips.filter((chip) => chip.kind === "attachment").map((chip) => chip.path));
      state.chips = state.chips.filter((chip) => !sent.has(chip.path));
    },
    failed: (unsent, error) => {
      failures.push({ unsent, error });
      state.draft = failedSubmissionDraft(unsent, state.draft);
    },
  });
  const say = (text: string) => {
    state.draft = text;
    return queue.enqueue({ ...submission(text), chips: [...state.chips] });
  };
  return { queue, say, state, busy, accepted, failures, cancel: (boundary: "composer" | "vault") => { scope[boundary]++; } };
}

test("overlapping distinct Enter presses serialize with the attachment only once", async () => {
  const first = deferred<boolean>();
  const second = deferred<boolean>();
  const secondStarted = deferred<void>();
  const calls: Submission[] = [];
  const h = harness(async (item) => {
    calls.push(item);
    if (calls.length === 1) return first.promise;
    secondStarted.resolve();
    return second.promise;
  });
  const a = h.say("Also: the ending.");
  const b = h.say("And the title.");
  assert.equal(h.state.sending, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(h.state.chips, [doc, file], "files remain pinned before acceptance");
  first.resolve(true);
  await secondStarted.promise;
  assert.equal(h.state.sending, true, "no idle gap between IPC calls");
  assert.equal(h.state.draft, "And the title.", "accepting the first send retains the newer draft");
  assert.deepEqual(calls.map((item) => item.text), ["Also: the ending.", "And the title."]);
  assert.deepEqual(calls[0]!.chips, [doc, file]);
  assert.deepEqual(calls[1]!.chips, [doc]);
  assert.deepEqual(h.state.chips, [doc]);
  second.resolve(true);
  await Promise.all([a, b]);
  assert.equal(h.state.draft, "");
  assert.deepEqual(h.busy, [true, false]);
  assert.deepEqual(h.failures, []);
});

test("double Enter deduplicates the current draft and queued drafts", async () => {
  const first = deferred<boolean>();
  const calls: string[] = [];
  const h = harness(async ({ text }) => { calls.push(text); return calls.length === 1 ? first.promise : true; });
  const attempts = [h.say("First"), h.say("First"), h.say("Second"), h.say("Second")];
  first.resolve(true);
  await Promise.all(attempts);
  assert.deepEqual(calls, ["First", "Second"]);
  await h.say("Second");
  assert.deepEqual(calls, ["First", "Second", "Second"], "the same text can be sent again after acceptance");
});

test("a queued submit uses the thread created by the first IPC", async () => {
  const created = deferred<boolean>();
  const destinations: (string | null)[] = [];
  const h = harness(async () => {
    destinations.push(h.state.thread);
    if (h.state.thread === null) {
      const ok = await created.promise;
      h.state.thread = "created-thread";
      return ok;
    }
    return true;
  });
  const a = h.say("Start a thread");
  const b = h.say("One more thing");
  created.resolve(true);
  await Promise.all([a, b]);
  assert.deepEqual(destinations, [null, "created-thread"]);
});

test("a failed first IPC stops the burst and restores unsent text without consuming attachments", async () => {
  const first = deferred<boolean>();
  const calls: Submission[] = [];
  const h = harness(async (item) => { calls.push(item); return calls.length === 1 ? first.promise : true; });
  const a = h.say("First");
  const b = h.say("Second");
  h.state.draft = "Still typing";
  first.reject(new Error("Offline"));
  await Promise.all([a, b]);
  assert.equal(calls.length, 1, "later text is not sent after failure");
  assert.deepEqual(h.state.chips, [doc, file]);
  assert.equal(h.state.draft, "First\n\nSecond\n\nStill typing");
  assert.match(String(h.failures[0]?.error), /Offline/);
  assert.equal(h.state.sending, false);
  await h.say(h.state.draft);
  assert.equal(h.state.draft, "");
  assert.deepEqual(calls[1]?.chips, [doc, file], "retry still carries the staged file");
});

test("a failed later IPC preserves its draft but never resends accepted attachments", async () => {
  const first = deferred<boolean>();
  const calls: Submission[] = [];
  const h = harness(async (item) => { calls.push(item); return calls.length === 1 ? first.promise : false; });
  const a = h.say("First");
  const b = h.say("Second");
  first.resolve(true);
  await Promise.all([a, b]);
  assert.equal(h.state.draft, "Second");
  assert.deepEqual(h.state.chips, [doc]);
  assert.deepEqual(calls[1]?.chips, [doc]);
  assert.deepEqual(h.failures[0]?.unsent.map((item) => item.text), ["Second"]);
});

test("single-send failure and edits typed during a send retain the existing draft behavior", async () => {
  const failed = deferred<boolean>();
  const h = harness(() => failed.promise);
  const a = h.say("First");
  h.state.draft = "Edited while waiting";
  failed.resolve(false);
  await a;
  assert.equal(h.state.draft, "Edited while waiting");
  assert.deepEqual(h.state.chips, [doc, file]);
  assert.equal(failedSubmissionDraft([submission("First"), submission("Second")], "Second"), "First\n\nSecond");
});

for (const boundary of ["composer", "vault"] as const) {
  for (const outcome of ["accepted", "failed"] as const) {
    test(`${boundary} switch drops queued sends and stale ${outcome} responses without blocking a new composer`, async () => {
      const first = deferred<boolean>();
      const calls: Submission[] = [];
      const old = harness(async (item) => { calls.push(item); return first.promise; });
      const a = old.say("Old first");
      const b = old.say("Old queued");
      old.cancel(boundary);
      const next = harness(async () => true);
      await next.say("New composer");
      assert.equal(next.state.draft, "");
      if (outcome === "accepted") first.resolve(true);
      else first.reject(new Error("Stale failure"));
      await Promise.all([a, b]);
      assert.equal(calls.length, 1);
      assert.deepEqual(old.accepted, []);
      assert.deepEqual(old.failures, []);
      assert.deepEqual(old.busy, [true], "stale finalizers do not update UI state");
      assert.deepEqual(next.busy, [true, false]);
    });
  }
}

test("a synchronous submit failure clears busy state and allows a retry", async () => {
  let calls = 0;
  const h = harness(() => {
    if (++calls === 1) throw new Error("Synchronous IPC failure");
    return Promise.resolve(true);
  });
  await h.say("First");
  assert.equal(h.state.sending, false);
  assert.match(String(h.failures[0]?.error), /Synchronous IPC failure/);
  await h.say("Retry");
  assert.equal(calls, 2);
  assert.equal(h.state.draft, "");
  assert.equal(h.state.sending, false);
});
