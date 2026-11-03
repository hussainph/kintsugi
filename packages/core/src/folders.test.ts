import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { canMove, FOLDER_COLORS, FOLDER_ICONS, isFolderColor, isFolderIcon } from "./folders.ts";

test("a document or folder moves only somewhere new, never into itself", () => {
  assert.equal(canMove("notes/a.mdx", ""), true);
  assert.equal(canMove("notes/a.mdx", "posts/series"), true);
  assert.equal(canMove("notes/a.mdx", "notes"), false);
  assert.equal(canMove("a.mdx", ""), false);
  assert.equal(canMove("posts", "posts"), false);
  assert.equal(canMove("posts", "posts/series"), false);
  assert.equal(canMove("posts", "posts-old"), true);
  assert.equal(canMove("posts/series", ""), true);
  assert.equal(canMove("", "posts"), false);
});

test("colour and icon keys match the vault crate", () => {
  const rust = readFileSync(new URL("../../../crates/vault/src/folders.rs", import.meta.url), "utf8");
  const list = (name: string) =>
    [...(new RegExp(`${name}: \\[&str; \\d+\\] = \\[([^\\]]*)\\]`).exec(rust)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(list("FOLDER_COLORS"), [...FOLDER_COLORS]);
  assert.deepEqual(list("FOLDER_ICONS"), [...FOLDER_ICONS]);
  assert.equal(isFolderColor("sage"), true);
  assert.equal(isFolderColor("magenta"), false);
  assert.equal(isFolderIcon("pen"), true);
  assert.equal(isFolderIcon(undefined), false);
});
