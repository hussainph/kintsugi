import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);

test("Node-facing core loads with native type stripping and no tsx loader", async () => {
  const urls = ["schema", "state", "discovery", "store", "server", "cli"].map(
    (name) => new URL(`../src/${name}.ts`, import.meta.url).href,
  );
  const code = `${urls.map((url) => `await import(${JSON.stringify(url)});`).join("\n")}
console.log('Native Node core imports passed');`;
  const result = await exec(process.execPath, [
    "--input-type=module",
    "-e",
    code,
  ]);
  assert.equal(result.stdout.trim(), "Native Node core imports passed");
});
