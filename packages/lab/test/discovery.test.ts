import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { discover } from "../src/discovery.ts";
import { entrySource, fixture, fixtureMeta } from "./helpers.ts";

test("AST discovery derives exported literals without resolving or executing product imports", async () => {
  const f = await fixture();
  try {
    const entries = await discover(f.root, f.entriesDir);
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].meta, fixtureMeta);
    assert.equal(entries[0].controls.size.default, 16);
    assert.equal(entries[0].directory, f.directory);
  } finally {
    await f.cleanup();
  }
});
test("discovery rejects missing literals, references, spreads and duplicate literal keys", async () => {
  const f = await fixture();
  try {
    for (const source of [
      entrySource().replace("export const controls =", "const controls ="),
      entrySource().replace(
        /export const controls = [\s\S]*? satisfies Record<string, Control>;/,
        "export const controls = importedControls;",
      ),
      entrySource().replace(
        "export const meta = {",
        "export const meta = { ...base,",
      ),
      entrySource().replace(
        '"title": "Sample",',
        '"title": "Sample", "title": "Duplicate",',
      ),
    ]) {
      await writeFile(f.file, source);
      await assert.rejects(discover(f.root, f.entriesDir), /literal|duplicate/);
    }
  } finally {
    await f.cleanup();
  }
});
test("discovery validates source existence, metadata relations, and directory identity", async () => {
  const f = await fixture();
  try {
    await writeFile(
      f.file,
      entrySource({ ...fixtureMeta, sources: ["missing.tsx"] }),
    );
    await assert.rejects(discover(f.root, f.entriesDir), /ENOENT/);
    await writeFile(
      f.file,
      entrySource({ ...fixtureMeta, related: ["page/missing"] }),
    );
    await assert.rejects(
      discover(f.root, f.entriesDir),
      /related entry does not exist/,
    );
    await writeFile(
      f.file,
      entrySource({ ...fixtureMeta, id: "component/another" }),
    );
    await assert.rejects(
      discover(f.root, f.entriesDir),
      /does not match its path/,
    );
    await writeFile(f.file, entrySource());
    const nested = join(f.directory, "scratch");
    await mkdir(nested);
    await writeFile(join(nested, "entry.tsx"), entrySource());
    await assert.rejects(discover(f.root, f.entriesDir), /Misplaced entry/);
  } finally {
    await f.cleanup();
  }
});
test("discovery fails duplicate inline story identities before rendering", async () => {
  const f = await fixture();
  try {
    await writeFile(
      f.file,
      entrySource().replace(
        "stories: [{id: 'default', title: 'Default', render: () => null}]",
        "stories: [{id: 'same', title: 'One', render: () => null}, {id: 'same', title: 'Two', render: () => null}]",
      ),
    );
    await assert.rejects(
      discover(f.root, f.entriesDir),
      /duplicate stories id/,
    );
  } finally {
    await f.cleanup();
  }
});
test("discovery rejects symlinks in sources and entries and paths outside root", async () => {
  const f = await fixture();
  try {
    await symlink(join(f.root, "source.tsx"), join(f.root, "source-link.tsx"));
    await writeFile(
      f.file,
      entrySource({ ...fixtureMeta, sources: ["source-link.tsx"] }),
    );
    await assert.rejects(discover(f.root, f.entriesDir), /Symlink/);
    await writeFile(f.file, entrySource());
    await symlink(f.directory, join(f.root, "entries", "alias"));
    await assert.rejects(discover(f.root, f.entriesDir), /Symlink/);
    await assert.rejects(discover(f.root, ".."), /escapes workspace/);
  } finally {
    await f.cleanup();
  }
});
