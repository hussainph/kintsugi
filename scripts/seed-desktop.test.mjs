// Run with: node --test scripts/seed-desktop.test.mjs
//
// These tests read the generated files the way Kintsugi's Rust vault crate
// does: flat clip frontmatter, local-time capture stamps, `image` relative to
// the clip as media/<stem>.<ext>, and a flat list of allowed image types.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { symlink } from "node:fs/promises";
import {
  REPO_ROOT,
  SEED_DATE,
  SeedError,
  artworkSpecs,
  assertSafeTarget,
  clipFiles,
  documentFiles,
  generateArtwork,
  ownerRoots,
  seedVault,
} from "./seed-desktop.mjs";

const SCRIPT = fileURLToPath(new URL("./seed-desktop.mjs", import.meta.url));
const TEST_ROOT = join(REPO_ROOT, ".headless");
const created = [];

// Tests write only inside the worktree; remove every scratch directory even
// when an assertion fails.
async function scratch(prefix = "kintsugi-seed-") {
  await mkdir(TEST_ROOT, { recursive: true });
  const dir = await mkdtemp(join(TEST_ROOT, `${prefix}test-seed-`));
  created.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function walk(root, dir = root) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(root, path)));
    else files.push(relative(root, path).split("\\").join("/"));
  }
  return files.sort();
}

function parseValue(raw, file, key) {
  if (raw === "") return "";
  if (raw.startsWith("[")) {
    assert.ok(raw.endsWith("]"), `${file}: unclosed list for ${key}`);
    const items = raw
      .slice(1, -1)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        if (item.startsWith('"')) return JSON.parse(item);
        if (item.startsWith("'")) return item.slice(1, -1).replace(/''/g, "'");
        return item;
      });
    return items;
  }
  if (raw.startsWith('"')) return JSON.parse(raw);
  if (raw.startsWith("'")) {
    assert.ok(raw.endsWith("'"), `${file}: unclosed quoted ${key}`);
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  return raw.split(" #")[0].trim();
}

function frontmatter(text, file) {
  const normalized = text.replace(/\r\n/g, "\n");
  assert.ok(normalized.startsWith("---\n"), `${file}: missing frontmatter`);
  const end = normalized.indexOf("\n---\n", 4);
  assert.notEqual(end, -1, `${file}: unclosed frontmatter`);
  const header = normalized.slice(4, end);
  const body = normalized.slice(end + 5);
  const fields = new Map();
  for (const line of header.split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    assert.ok(!/^\s/.test(line), `${file}: frontmatter must be flat, got ${JSON.stringify(line)}`);
    const colon = line.indexOf(":");
    assert.ok(colon > 0, `${file}: invalid frontmatter line ${JSON.stringify(line)}`);
    const key = line.slice(0, colon).trim();
    assert.match(key, /^[A-Za-z0-9_-]+$/, `${file}: invalid field ${key}`);
    assert.ok(!fields.has(key), `${file}: duplicate field ${key}`);
    fields.set(key, parseValue(line.slice(colon + 1).trim(), file, key));
  }
  return { fields, body };
}

function validStamp(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return false;
  const [year, month, day, hour, minute] = value.split(/[-T:]/).map(Number);
  if (year === 0 || month < 1 || month > 12 || hour > 23 || minute > 59) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day >= 1 && day <= days;
}

function wikilinks(text) {
  const withoutFrontmatter = text.replace(/^---\n[\s\S]*?\n---\n/, "");
  const found = [];
  let fence = null;
  for (const rawLine of withoutFrontmatter.replace(/\r\n/g, "\n").split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(rawLine);
    if (marker) {
      if (!fence) {
        fence = marker[1][0];
        continue;
      }
      if (marker[1][0] === fence && marker[2].trim() === "") {
        fence = null;
        continue;
      }
    }
    if (fence) continue;
    let line = rawLine.replace(/<!--.*?-->/g, "");
    line = line.replace(/(`+)[\s\S]*?\1/g, "");
    const pattern = /\[\[([^\[\]]+)\]\]/g;
    let match;
    while ((match = pattern.exec(line))) {
      let slashes = 0;
      for (let index = match.index - 1; index >= 0 && line[index] === "\\"; index--) slashes++;
      if (slashes % 2 === 0) found.push(match[1]);
    }
  }
  return found;
}

function targetOf(link) {
  return link
    .split("|")[0]
    .split("#")[0]
    .trim()
    .replace(/^\.\//, "")
    .replace(/\.mdx?$/i, "");
}

function sourceIndex(documents, clips) {
  return [
    ...documents.map((path) => ({ kind: "document", path: path.replace(/\.mdx?$/, "") })),
    ...clips.map((path) => ({ kind: "clip", path: path.replace(/\.md$/, "") })),
  ];
}

/** A small mirror of packages/core/src/references.ts resolution. */
function resolveLink(target, sources) {
  if (target === "") return null;
  if (target.includes("/")) return sources.find((source) => source.path === target) ?? null;
  const matches = sources.filter((source) => source.path.split("/").pop() === target);
  const documents = matches.filter((source) => source.kind === "document");
  const preferred = documents.length ? documents : matches;
  const roots = preferred.filter((source) => source.path === target);
  if (roots.length === 1) return roots[0];
  if (preferred.length === 1) return preferred[0];
  return null;
}

async function validateVault(root, { allowExtra = [] } = {}) {
  const documents = documentFiles();
  const clips = clipFiles();
  const images = artworkSpecs();
  const expected = [
    ...documents.map((file) => file.path),
    ...clips.map((file) => file.path),
    ...images.map((image) => image.file),
    ...allowExtra,
  ].sort();
  assert.deepEqual(await walk(root), expected, "seed wrote an unexpected tree");

  for (const document of documents) {
    const text = await readFile(join(root, document.path), "utf8");
    const { fields } = frontmatter(text, document.path);
    assert.ok(typeof fields.get("title") === "string" && fields.get("title").length, `${document.path}: title`);
    assert.ok(["draft", "complete"].includes(fields.get("status")), `${document.path}: status`);
    assert.match(document.path, /\.(md|mdx)$/);
    if (fields.has("captured")) assert.ok(validStamp(fields.get("captured")), `${document.path}: captured`);
  }

  const sources = sourceIndex(
    documents.map((file) => file.path),
    clips.map((file) => file.path),
  );
  const unresolved = new Set(["a-book-about-walking"]);
  const ignored = new Set([
    "not-a-real-link",
    "also-not-a-real-link",
    "commented-out-link",
    "still-not-a-link",
  ]);

  for (const document of [...documents, ...clips]) {
    const text = await readFile(join(root, document.path), "utf8");
    const links = wikilinks(text);
    for (const link of links) {
      const target = targetOf(link);
      if (ignored.has(target)) continue;
      if (unresolved.has(target)) continue;
      assert.ok(
        resolveLink(target, sources),
        `${document.path}: unresolved seeded wikilink [[${link}]]`,
      );
    }
    for (const target of ignored) {
      assert.ok(!links.some((link) => targetOf(link) === target), `${document.path}: ignored code/comment link parsed`);
    }
  }

  const kinds = new Set(["link", "post", "video", "image", "quote", "note"]);
  const vias = new Set(["mac", "phone", "share"]);
  const extensions = new Set(["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "avif"]);
  const allowed = new Set([
    "kind",
    "title",
    "url",
    "site",
    "author",
    "image",
    "captured",
    "via",
    "tags",
    "summary",
    "enriched",
    "enrich_error",
  ]);
  const referenced = new Set();

  for (const clip of clips) {
    const text = await readFile(join(root, clip.path), "utf8");
    const { fields, body } = frontmatter(text, clip.path);
    const stem = clip.path.split("/").pop().replace(/\.md$/, "");
    assert.match(clip.path, /^inspiration\/[^/.][^/]*\.md$/, `${clip.path}: clip namespace`);
    for (const key of fields.keys()) assert.ok(allowed.has(key), `${clip.path}: unexpected field ${key}`);

    assert.ok(kinds.has(fields.get("kind")), `${clip.path}: kind`);
    assert.ok(validStamp(fields.get("captured")), `${clip.path}: captured`);
    if (fields.has("via")) assert.ok(vias.has(fields.get("via")), `${clip.path}: via`);
    if (fields.has("tags")) {
      const tags = fields.get("tags");
      assert.ok(Array.isArray(tags), `${clip.path}: tags must be a list`);
      for (const tag of tags) {
        assert.equal(tag, tag.toLowerCase(), `${clip.path}: tag ${tag} must be lowercase`);
        assert.ok(tag.length > 0, `${clip.path}: empty tag`);
      }
      assert.equal(new Set(tags).size, tags.length, `${clip.path}: duplicate tag`);
    }
    if (fields.has("enriched")) {
      assert.ok(validStamp(fields.get("enriched")), `${clip.path}: enriched`);
      assert.ok(fields.has("summary"), `${clip.path}: enriched clip needs a summary`);
    }
    if (fields.has("enrich_error")) {
      assert.ok(!fields.has("enriched"), `${clip.path}: an error clip is not enriched`);
    }
    if (fields.has("url")) assert.match(fields.get("url"), /^https?:\/\//, `${clip.path}: URL`);

    if (fields.has("image")) {
      const image = fields.get("image");
      const extension = image.split(".").pop();
      assert.ok(extensions.has(extension), `${clip.path}: image type`);
      assert.equal(image, `media/${stem}.${extension}`, `${clip.path}: media path must match stem`);
      const media = join(root, "inspiration", image);
      const info = await stat(media);
      assert.ok(info.size > 0 && info.size <= 15 * 1024 * 1024, `${clip.path}: image size`);
      const bytes = await readFile(media);
      assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      assert.equal(bytes.toString("ascii", 12, 16), "IHDR");
      referenced.add(image);
    }

    const marker = "<!-- kintsugi:source -->";
    assert.ok(body.includes(marker), `${clip.path}: capture marker`);
    const [own, source] = body.split(marker);
    assert.ok(!own.includes(marker), `${clip.path}: duplicate marker`);
    if (source.includes("## Source")) {
      assert.ok(source.split("## Source")[1].trim().length > 0, `${clip.path}: empty source`);
      assert.ok(fields.has("enriched"), `${clip.path}: a source is enrichment`);
    }
  }

  const media = images.map((image) => image.file.replace(/^inspiration\//, ""));
  assert.deepEqual([...referenced].sort(), media.sort(), "every seeded PNG is referenced by a clip");
  assert.ok(!(await walk(root)).some((path) => path.endsWith(".svg")), "seed must use raster images only");

  return { documents, clips, images };
}

test("seedVault writes documents, clips and deterministic raster images", async () => {
  const dir = await scratch();
  const result = await seedVault(dir);
  assert.deepEqual(await validateVault(result.root), {
    documents: documentFiles(),
    clips: clipFiles(),
    images: artworkSpecs(),
  });
  assert.ok(result.imageBytes > 0);
  assert.equal(result.documents.length, 9);
  assert.equal(result.clips.length, 7);
  assert.equal(result.images.length, 4);
  assert.ok(result.root.endsWith(dir.split("/").pop()));
});

test("two runs are byte-for-byte identical", async () => {
  const first = await seedVault(await scratch());
  const second = await seedVault(await scratch());
  assert.deepEqual(await walk(first.root), await walk(second.root));
  for (const path of await walk(first.root)) {
    const a = await readFile(join(first.root, path));
    const b = await readFile(join(second.root, path));
    assert.ok(a.equals(b), `${path} differs between runs`);
  }
  for (const spec of artworkSpecs()) {
    const bytes = await readFile(join(first.root, spec.file));
    assert.ok(bytes.equals(generateArtwork(spec)), `${spec.file} is not the deterministic encoder output`);
  }
});

test("an existing nonempty directory is always refused", async () => {
  const dir = await scratch();
  await seedVault(dir);
  await assert.rejects(() => seedVault(dir), (error) => error instanceof SeedError && /nonempty/.test(error.message));

  await writeFile(join(dir, "keep.txt"), "not seeded\n");
  await assert.rejects(() => seedVault(dir), (error) => error instanceof SeedError && /nonempty/.test(error.message));
  assert.equal(await readFile(join(dir, "keep.txt"), "utf8"), "not seeded\n");
  await validateVault(dir, { allowExtra: ["keep.txt"] });
});

test("owner vault/config, home, filesystem root and repo root are refused", async () => {
  const home = await scratch("kintsugi-owner-");
  for (const forbidden of ownerRoots(home)) {
    await assert.rejects(
      () => assertSafeTarget(forbidden.path, { home }),
      (error) => error instanceof SeedError && /refusing/.test(error.message),
      forbidden.path,
    );
    await assert.rejects(
      () => assertSafeTarget(join(forbidden.path, "nested"), { home }),
      (error) => error instanceof SeedError && /refusing/.test(error.message),
    );
  }
  await assert.rejects(() => assertSafeTarget(home, { home }), SeedError);
  await assert.rejects(() => assertSafeTarget(resolve(home, ".."), { home }), SeedError);
  await assert.rejects(
    () => assertSafeTarget(REPO_ROOT, { home, repoRoot: REPO_ROOT }),
    SeedError,
  );
  await assert.rejects(() => assertSafeTarget("/", { home }), SeedError);
  const safe = await scratch("kintsugi-safe-");
  assert.equal(await assertSafeTarget(safe, { home }), await realpath(safe));
});

test("a symlink into the owner vault is refused", async () => {
  const home = await scratch("kintsugi-owner-");
  const vault = join(home, "Documents", "Kintsugi");
  await mkdir(vault, { recursive: true });
  await writeFile(join(vault, "real.mdx"), "owner writing\n");
  const link = join(await scratch("kintsugi-link-"), "vault");
  await symlink(vault, link, "dir");
  await assert.rejects(
    () => assertSafeTarget(link, { home }),
    (error) => error instanceof SeedError && /owner's vault/.test(error.message),
  );
  await assert.rejects(
    () => seedVault(link, { home }),
    (error) => error instanceof SeedError && /owner's vault/.test(error.message),
  );
  assert.equal(await readFile(join(vault, "real.mdx"), "utf8"), "owner writing\n");
});

test("the CLI seeds, refuses repeats and prints the next command", async () => {
  const parent = await scratch();
  const dir = join(parent, "vault");
  const first = spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Seeded 9 documents and 7 clips \(4 PNG images\)/);
  assert.match(first.stdout, /KINTSUGI_VAULT="[^"]*vault" pnpm desktop:headless/);
  await validateVault(await realpath(dir));

  const repeat = spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8" });
  assert.notEqual(repeat.status, 0);
  assert.match(repeat.stderr, /nonempty/);

  const help = spawnSync(process.execPath, [SCRIPT, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /pnpm desktop:seed <dir>/);
  assert.match(help.stdout, /must be empty/);
  assert.doesNotMatch(help.stdout, /--force/);

  const missing = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /scratch directory is required/);

  const force = spawnSync(process.execPath, [SCRIPT, dir, "--force"], { encoding: "utf8" });
  assert.notEqual(force.status, 0);
  assert.match(force.stderr, /unknown option/);

  const unknown = spawnSync(process.execPath, [SCRIPT, dir, "--bogus"], { encoding: "utf8" });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unknown option/);
});

test("a nested symlink to the owner's vault is refused before any write", async () => {
  const home = await scratch("kintsugi-owner-");
  const owner = join(home, "Documents", "Kintsugi");
  await mkdir(owner, { recursive: true });
  await writeFile(join(owner, "sentinel.mdx"), "owner\n");

  const dir = await scratch("kintsugi-nested-");
  await symlink(owner, join(dir, "inspiration"), "dir");
  // The symlink makes the otherwise empty target nonempty, so the seed stops
  // before it can follow it; the owner directory stays byte-for-byte intact.
  await assert.rejects(
    () => seedVault(dir, { home }),
    (error) => error instanceof SeedError && /nonempty/.test(error.message),
  );
  await assert.rejects(
    () => assertSafeTarget(join(dir, "inspiration"), { home }),
    (error) => error instanceof SeedError && /owner's vault/.test(error.message),
  );
  assert.equal(await readFile(join(owner, "sentinel.mdx"), "utf8"), "owner\n");
  assert.deepEqual(await walk(owner), ["sentinel.mdx"]);
  assert.deepEqual(await walk(dir), ["inspiration"]);
});

test("the CLI refuses the owner's paths and leaves them untouched", async () => {
  const home = await scratch("kintsugi-owner-");
  const vault = join(home, "Documents", "Kintsugi");
  const config = join(home, "Library", "Application Support", "dev.phalasiya.kintsugi");
  await mkdir(vault, { recursive: true });
  await mkdir(config, { recursive: true });
  await writeFile(join(vault, "sentinel.mdx"), "owner\n");
  await writeFile(join(config, "config.json"), "{\"vault\":\"owner\"}\n");

  for (const target of [vault, config]) {
    const result = spawnSync(process.execPath, [SCRIPT, target], {
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    });
    assert.notEqual(result.status, 0, target);
    assert.match(result.stderr, /refusing/);
  }

  assert.equal(await readFile(join(vault, "sentinel.mdx"), "utf8"), "owner\n");
  assert.equal(await readFile(join(config, "config.json"), "utf8"), "{\"vault\":\"owner\"}\n");
  assert.deepEqual(await walk(vault), ["sentinel.mdx"]);
  assert.deepEqual(await walk(config), ["config.json"]);
});

test("the generated vault keeps the seed date and the expected wikilink shapes", async () => {
  const result = await seedVault(await scratch());
  const onCraft = await readFile(join(result.root, "posts/on-craft.mdx"), "utf8");
  assert.match(onCraft, new RegExp(SEED_DATE === "2026-10-29" ? "\\[\\[notes/attention#The cost\\|What attention costs\\]\\]" : ""));
  assert.match(onCraft, /\[\[notes\/repair\]\]/);
  assert.match(onCraft, /\[\[inspiration\/golden-joinery\]\]/);
  const reading = await readFile(join(result.root, "notes/reading-list.md"), "utf8");
  assert.match(reading, /~~~\n\[\[not-a-real-link\]\]\n~~~/);
  assert.match(reading, /`\[\[also-not-a-real-link\]\]`/);
  assert.match(reading, /<!-- \[\[commented-out-link\]\] -->/);
});
