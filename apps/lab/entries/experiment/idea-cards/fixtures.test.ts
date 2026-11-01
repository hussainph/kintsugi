import assert from "node:assert/strict";
import { test } from "node:test";
import { FADE_DAYS, clipsFor, frontmatter, freshness, ideas } from "./fixtures.ts";

// The seed script is untyped JavaScript; a variable specifier keeps tsc from asking for types.
type SeedFile = { path: string; content: string };
const seedScript = "../../../../../scripts/seed-desktop.mjs";
const seed: { documentFiles(): SeedFile[]; clipFiles(): SeedFile[] } = await import(seedScript);
const vault = new Map(
  [...seed.documentFiles(), ...seed.clipFiles()].map((f) => [f.path.replace(/\.mdx?$/, ""), f.content]),
);
// Seed files wrap prose at ~80 columns; compare quotes on collapsed whitespace.
const flat = (s: string) => s.replace(/\s+/g, " ");

test("every quote is verbatim from the seed vault file it links to", () => {
  for (const idea of ideas)
    for (const clip of idea.clips) {
      if (clip.extra) continue;
      const file = vault.get(clip.path);
      assert.ok(file, `${idea.id}: ${clip.path} is not in the seed vault`);
      assert.ok(flat(file).includes(flat(clip.quote)), `${idea.id}: quote not found in ${clip.path}`);
    }
});

test("ideas follow the disclosure contract", () => {
  assert.ok(ideas.filter((i) => i.age === 0).length <= 5, "a daily batch is up to five");
  for (const idea of ideas) {
    assert.ok(idea.clips.length >= 2 && idea.clips.length <= 4, `${idea.id}: 2–4 clips`);
    assert.ok(idea.snippet.length <= 90, `${idea.id}: snippet fits one line`);
    assert.ok(idea.observed.length > 0 && idea.hunch, `${idea.id}: observed and hunch`);
  }
  assert.equal(freshness(0), 1);
  assert.equal(freshness(FADE_DAYS), 0);
});

test("Adopt writes the idea to frontmatter, without linking a draft to itself", () => {
  const idea = ideas.find((i) => i.id === "kintsugi-draft-home")!;
  const fm = frontmatter(idea, "Repair is a kind of attention", "notes/repair");
  assert.match(fm, /^---\ntitle: "Repair is a kind of attention"\nstatus: draft\ntags: \[repair, attention\]\nideas:\n {2}- id: kintsugi-draft-home/);
  assert.ok(!fm.includes("[[notes/repair]]"));
  assert.deepEqual(clipsFor(idea, "notes/repair").map((c) => c.path), ["drafts/kintsugi-and-gold"]);
});
