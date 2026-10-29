import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const work = resolve(here, "../../../.expo/share-acceptance/stub-tests");

test("handoff commits once, fails extension retries closed, and accepts only the app's same-ID retry", { timeout: 20_000 }, async (t) => {
  mkdirSync(work, { recursive: true });
  const scratch = mkdtempSync(`${work}/run-`);
  const journalPath = `${scratch}/mac.jsonl`;
  const child = spawn(process.execPath, [resolve(here, "fake-mac.mjs"), "--port", "0", "--mode", "handoff", "--journal", journalPath]);
  let output = "";
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    rmSync(scratch, { recursive: true });
  });
  const port = await new Promise((resolvePort, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`fixture exited ${code}: ${output}`)));
    child.stdout.on("data", (data) => {
      output += data;
      const match = output.match(/LISTENING (\d+)/);
      if (match) resolvePort(match[1]);
    });
    child.stderr.on("data", (data) => { output += data; });
  });
  const base = `http://127.0.0.1:${port}`;
  const capture = {
    id: "A1234567-1234-4234-8234-123456789ABC",
    via: "share",
    url: `${base}/page.html?case=url`,
    note: "the same note",
    capturedAt: "2026-10-29T17:50",
  };
  const post = (userAgent, body = capture, token = "test-token") => fetch(`${base}/v1/clips`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": userAgent },
    body: JSON.stringify(body),
  });
  const control = (mode) => fetch(`${base}/_control`, { method: "POST", body: JSON.stringify({ mode }) });

  assert.equal((await post("unknown")).status, 503);
  assert.equal((await post("KintsugiShare/1", capture, "wrong-token")).status, 401);
  await assert.rejects(post("KintsugiShare/1")); // committed, connection dropped
  assert.equal((await post("KintsugiShare/1")).status, 503);
  assert.equal((await post("")).status, 503);
  assert.equal((await control("handoff")).status, 200); // launch marker preserves receipt
  const reordered = Object.fromEntries(Object.entries(capture).reverse());
  const accepted = await post("Kintsugi/1", reordered);
  assert.equal(accepted.status, 200);
  const { path } = await accepted.json();
  const duplicate = await post("Kintsugi/1", { ...capture, id: capture.id.toLowerCase() });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).path, path); // UUID receipt lookup is case-insensitive

  const events = readFileSync(journalPath, "utf8").trim().split("\n").map(JSON.parse);
  const committed = events.find((event) => event.outcome === "reply-lost");
  const retried = events.find((event) => event.outcome === "accepted");
  assert.equal(committed.id, retried.id);
  assert.equal(committed.path, path);
  assert.equal(retried.path, path);
  assert.equal(retried.dedup, true);
  assert.equal(committed.captureSha256, retried.captureSha256);
  assert.notEqual(committed.bodySha256, retried.bodySha256); // key order must not matter
  assert.equal(events.filter((event) => event.dedup === false && event.path === path).length, 1);
  assert.equal((await (await fetch(`${base}/_state`)).json()).ids.length, 1);

  for (const mode of ["500", "400"]) {
    assert.equal((await control(mode)).status, 200);
    assert.equal((await post("Kintsugi/1")).status, Number(mode));
  }
});
