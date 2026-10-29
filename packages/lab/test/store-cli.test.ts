import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  link,
  readFile,
  readdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createStore,
  LockTimeout,
  parseLog,
  RevisionConflict,
} from "../src/store.ts";
import { runCli } from "../src/cli.ts";
import { fixture } from "./helpers.ts";

const exec = promisify(execFile);
const loader = import.meta.resolve("tsx");
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const storeUrl = new URL("../src/store.ts", import.meta.url).href;

test("store persists complete reducer state, reloads and rejects stale revisions", async () => {
  const f = await fixture();
  try {
    const store = createStore(f);
    assert.equal((await store.read("component/sample")).revision, 0);
    const saved = await store.append("component/sample", 0, {
      type: "note",
      kind: "decision",
      text: "Keep the words first.",
    });
    assert.equal(saved.revision, 1);
    assert.deepEqual(await createStore(f).read("component/sample"), saved);
    await assert.rejects(
      store.append("component/sample", 0, { type: "status", status: "ready" }),
      RevisionConflict,
    );
    assert.equal((await store.read("component/sample")).revision, 1);
    assert.deepEqual((await readdir(f.directory)).sort(), [
      "entry.tsx",
      "thread.jsonl",
    ]);
    await assert.rejects(
      store.append("../outside", 1, { type: "status", status: "ready" }),
      /Invalid entry id/,
    );
    await assert.rejects(
      store.append("component/sample", 1.5, {
        type: "status",
        status: "ready",
      }),
      /revision/,
    );
  } finally {
    await f.cleanup();
  }
});
test("corrupt and future logs fail closed; failed writes do not erase them", async () => {
  const f = await fixture();
  try {
    const store = createStore(f);
    const path = join(f.directory, "thread.jsonl");
    for (const content of [
      "{truncated",
      "\n",
      '{"version":99,"id":"x","at":"2026-01-01T00:00:00.000Z","action":{"type":"status","status":"ready"}}\n',
    ]) {
      await writeFile(path, content);
      await assert.rejects(
        store.read("component/sample"),
        /Corrupt|incomplete/,
      );
      await assert.rejects(
        store.append("component/sample", 0, {
          type: "status",
          status: "ready",
        }),
      );
      assert.equal(await readFile(path, "utf8"), content);
      assert.ok(!(await readdir(f.directory)).includes("thread.jsonl.lock"));
    }
    assert.throws(
      () => parseLog('{"version":1}\n'),
      /Corrupt thread at line 1/,
    );
    await writeFile(path, Buffer.from([0xff, 0x0a]));
    await assert.rejects(store.read("component/sample"), /invalid UTF-8/);
  } finally {
    await f.cleanup();
  }
});
test("supported legacy events migrate in memory and replace the original on the next write", async () => {
  const f = await fixture();
  try {
    const path = join(f.directory, "thread.jsonl");
    await writeFile(
      path,
      JSON.stringify({
        version: 0,
        id: "old",
        at: "2026-01-01T00:00:00.000Z",
        action: { type: "note", kind: "critique", text: "Before migration." },
      }) + "\n",
    );
    const store = createStore(f);
    assert.equal((await store.read("component/sample")).events[0].version, 1);
    assert.equal(JSON.parse((await readFile(path, "utf8")).trim()).version, 0);
    const next = await store.append("component/sample", 1, {
      type: "status",
      status: "refining",
    });
    assert.equal(next.revision, 2);
    assert.ok(
      (await readFile(path, "utf8"))
        .trim()
        .split("\n")
        .every((line) => JSON.parse(line).version === 1),
    );
    assert.deepEqual((await readdir(f.directory)).sort(), [
      "entry.tsx",
      "thread.jsonl",
    ]);
  } finally {
    await f.cleanup();
  }
});
test("locks bound waiting and symlinks/hard links never become write destinations", async () => {
  const f = await fixture();
  try {
    const store = createStore({ ...f, lockTimeoutMs: 25 });
    const lock = join(f.directory, "thread.jsonl.lock");
    const path = join(f.directory, "thread.jsonl");
    const source = join(f.root, "source.tsx");
    await writeFile(lock, "a different process owns this\n");
    await assert.rejects(
      store.append("component/sample", 0, { type: "status", status: "ready" }),
      LockTimeout,
    );
    assert.equal(
      await readFile(lock, "utf8"),
      "a different process owns this\n",
    );
    await unlink(lock);
    await symlink(source, path);
    await assert.rejects(store.read("component/sample"), /Symlink/);
    await assert.rejects(
      store.append("component/sample", 0, { type: "status", status: "ready" }),
      /Symlink/,
    );
    await unlink(path);
    await link(source, path);
    await assert.rejects(store.read("component/sample"), /regular/);
    assert.equal(
      await readFile(source, "utf8"),
      "export const source = true;\n",
    );
  } finally {
    await f.cleanup();
  }
});
test("cross-process writers serialize through an exclusive lock and CAS prevents lost updates", async () => {
  const f = await fixture();
  try {
    const script = `import {createStore} from ${JSON.stringify(storeUrl)};
try { await createStore({root:process.argv[1],entriesDir:'entries'}).append('component/sample',0,{type:'note',kind:'note',text:process.argv[2]}); console.log('saved'); }
catch (error) { if(error.name==='RevisionConflict') console.log('conflict'); else throw error; }`;
    const results = await Promise.all(
      ["one", "two"].map((name) =>
        exec(
          process.execPath,
          [
            "--import",
            loader,
            "--input-type=module",
            "-e",
            script,
            f.root,
            name,
          ],
          { cwd: f.root },
        ),
      ),
    );
    assert.deepEqual(results.map((result) => result.stdout.trim()).sort(), [
      "conflict",
      "saved",
    ]);
    assert.equal((await createStore(f).read("component/sample")).revision, 1);
  } finally {
    await f.cleanup();
  }
});
test("offline CLI list/show/note/status/snapshot share registry and state with the store", async () => {
  const f = await fixture();
  try {
    const cli = (...args: string[]) =>
      exec(
        process.execPath,
        [
          "--import",
          loader,
          cliPath,
          "--root",
          f.root,
          "--entries",
          f.entriesDir,
          ...args,
        ],
        { cwd: f.root },
      );
    assert.equal(
      JSON.parse((await cli("list", "--json")).stdout)[0].id,
      "component/sample",
    );
    await cli(
      "note",
      "component/sample",
      "A critique from the CLI.",
      "--kind",
      "critique",
    );
    await cli("status", "component/sample", "refining");
    await cli(
      "snapshot",
      "component/sample",
      "Phone dark",
      "--values",
      '{"size":24}',
      "--scenario",
      '{"theme":"dark","width":390}',
    );
    const shown = JSON.parse(
      (await cli("show", "component/sample", "--json")).stdout,
    );
    assert.equal(shown.state.revision, 3);
    assert.equal(shown.state.notes[0].kind, "critique");
    assert.equal(shown.state.snapshots[0].values.size, 24);
    assert.equal(shown.state.snapshots[0].values.enabled, true);
    assert.equal(shown.state.snapshots[0].scenario.width, 390);
    assert.deepEqual(
      shown.state,
      await createStore(f).read("component/sample"),
    );
    await cli("check");
    await cli("status", "component/sample", "archived");
    assert.deepEqual(JSON.parse((await cli("list", "--json")).stdout), []);
    assert.equal(
      JSON.parse((await cli("list", "--json", "--include-archived")).stdout)
        .length,
      1,
    );
    await assert.rejects(
      cli("note", "component/sample", "Stale.", "--revision", "0"),
      /Stale revision/,
    );
    const out: string[] = [];
    await runCli(["--help"], { out: (message) => out.push(message) });
    assert.match(out[0], /No running server/);
  } finally {
    await f.cleanup();
  }
});
