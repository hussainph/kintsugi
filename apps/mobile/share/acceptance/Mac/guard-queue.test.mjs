import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const work = resolve(here, "../../../.expo/share-acceptance/guard-tests");
const source = readFileSync(resolve(here, "../run.sh"), "utf8");
const guard = source.match(/^guard_existing_outbox\(\) \{[\s\S]*?^\}/m)?.[0];
assert.ok(guard, "test the actual pre-pairing guard, not a copy");

// Replace only simctl container lookup: no real simulator, app, Keychain or
// private container is read/written. All fixtures and SQLite snapshots stay
// inside the worktree. Unknown simctl operations fail the test immediately.
const script = `
set -euo pipefail
WORK=$2
GROUP=$3
APP_DATA=$4
UDID=fixture
KI2_APP_ID=fixture
KI2_APP_GROUP=fixture-group
die() { printf '%s\\n' "$*" >&2; exit 1; }
xcrun() {
  case "$2" in
    terminate) return 1 ;;
    get_app_container)
      if [ "$5" = data ]; then printf '%s\\n' "$APP_DATA"; else printf '%s\\n' "$GROUP"; fi ;;
    *) printf 'unexpected simctl operation\\n' >&2; exit 99 ;;
  esac
}
eval "$1"
guard_existing_outbox
`;

function fixture(t) {
  mkdirSync(work, { recursive: true });
  const root = mkdtempSync(`${work}/run-`);
  const group = `${root}/group`;
  const app = `${root}/app`;
  const database = `${app}/Documents/SQLite/ExpoSQLiteStorage`;
  mkdirSync(dirname(database), { recursive: true });
  mkdirSync(group);
  t.after(() => rmSync(root, { recursive: true }));
  const sql = (query) => {
    const result = spawnSync("sqlite3", [database, query], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  return {
    group, database, sql,
    run: () => spawnSync("/bin/bash", ["-c", script, "--", guard, root, group, app], { encoding: "utf8" }),
  };
}

test("pre-pairing guard accepts a fresh install", (t) => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
});

for (const folder of ["captures", "malformed"]) {
  test(`pre-pairing guard preserves existing native ${folder}`, (t) => {
    const f = fixture(t);
    const capture = `${f.group}/Captures/${folder}/old-capture`;
    mkdirSync(capture, { recursive: true });
    writeFileSync(`${capture}/payload.json`, "preserve these bytes");
    const result = f.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /existing shared captures/);
    assert.equal(readFileSync(`${capture}/payload.json`, "utf8"), "preserve these bytes");
  });
}

test("pre-pairing guard accepts an empty legacy SQLite queue without modifying it", (t) => {
  const f = fixture(t);
  f.sql("CREATE TABLE storage (key TEXT PRIMARY KEY, value TEXT); INSERT INTO storage VALUES ('outbox', '[]');");
  const before = readFileSync(f.database);
  assert.equal(f.run().status, 0);
  assert.deepEqual(readFileSync(f.database), before);
});

for (const [key, value] of [["outbox", '[{"text":"keep me"}]'], ["outbox.recovery.123", "damaged but recoverable"]]) {
  test(`pre-pairing guard preserves legacy ${key}`, (t) => {
    const f = fixture(t);
    f.sql(`CREATE TABLE storage (key TEXT PRIMARY KEY, value TEXT); INSERT INTO storage VALUES ('${key}', '${value}');`);
    const before = readFileSync(f.database);
    const result = f.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /existing legacy captures/);
    assert.deepEqual(readFileSync(f.database), before);
  });
}

test("pre-pairing guard fails closed on an unreadable legacy database", (t) => {
  const f = fixture(t);
  writeFileSync(f.database, "not a SQLite database");
  assert.equal(f.run().status, 1);
  assert.equal(readFileSync(f.database, "utf8"), "not a SQLite database");
});
