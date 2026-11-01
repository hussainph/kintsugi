import assert from "node:assert/strict";
import { test } from "node:test";
import type { Listed } from "./api.ts";
import { adoptedIds, ageLabel, concerns, footprint, group, opacity } from "./model.ts";

const idea = (patch: Partial<Listed> = {}): Listed => ({
  id: "idea-1", created: "2026-11-01T09:00:00+01:00", job: "job-1", versions: [],
  kind: "gap", title: "T", draftTitle: "D", snippet: "S", observed: ["o"], hunch: "h",
  quotes: [{ source: "posts/on-craft.mdx", text: "q", title: "On craft", origin: "Your writing", own: true, link: "posts/on-craft" }],
  steps: [], reasons: [], about: ["drafts/started.mdx"],
  footprint: { searches: 2, files: 5, seconds: 31, usd: 0.042, model: "m", batch: 3 },
  age: 0, stage: "fresh", ...patch,
});

test("the list groups today, earlier and faded; dismissed ideas leave unless just dismissed", () => {
  const list = [
    idea({ id: "a" }),
    idea({ id: "b", age: 2 }),
    idea({ id: "c", age: 8, stage: "faded" }),
    idea({ id: "d", dismissed: { at: "x", reasons: [] } }),
    idea({ id: "e", age: 9, adopted: { path: "drafts/x.mdx", at: "x", new: true } }),
  ];
  const g = group(list);
  assert.deepEqual([g.today, g.earlier, g.faded].map((l) => l.map((i) => i.id)), [["a"], ["b", "e"], ["c"]]);
  assert.deepEqual(group(list, new Set(["d"])).today.map((i) => i.id), ["a", "d"]);
});

test("ideas thin from day three and adopted ones never do", () => {
  assert.equal(opacity(idea({ age: 2 })), 1);
  assert.ok(opacity(idea({ age: 3 })) < 1 && opacity(idea({ age: 6 })) < opacity(idea({ age: 3 })));
  assert.equal(opacity(idea({ age: 6, adopted: { path: "p", at: "x", new: true } })), 1);
  assert.deepEqual([0, 1, 3, 5, 6, 7].map(ageLabel), ["Today", "Yesterday", "3 days ago", "Fades in 2 days", "Fades in 1 day", "Faded"]);
});

test("an idea concerns the documents it's about, quotes or was adopted into", () => {
  assert.ok(concerns(idea(), "drafts/started.mdx"));
  assert.ok(concerns(idea(), "posts/on-craft.mdx"));
  assert.ok(!concerns(idea(), "notes/other.md"));
  assert.ok(concerns(idea({ adopted: { path: "notes/other.md", at: "x", new: false } }), "notes/other.md"));
});

test("the footprint reads as one line", () => {
  assert.equal(footprint(idea().footprint), "2 searches · 5 files read · 31 s · $0.04 · for the batch of 3");
  assert.equal(footprint({ searches: 1, files: 1, seconds: 3, usd: 0, model: "", batch: 1 }), "1 search · 1 file read · 3 s · $0");
});

test("adopted ids come from the ideas: frontmatter list only", () => {
  const text = "---\ntitle: \"x\"\nideas:\n  - id: idea-1\n    from: kin\n    clips:\n      - \"[[a]]\"\n  - id: idea-2\nother:\n  - id: nope\n---\n\n  - id: body\n";
  assert.deepEqual(adoptedIds(text), ["idea-1", "idea-2"]);
  assert.deepEqual(adoptedIds("no frontmatter"), []);
});
