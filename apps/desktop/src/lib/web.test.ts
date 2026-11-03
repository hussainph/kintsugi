import assert from "node:assert/strict";
import { test } from "node:test";
import { domain, markdownLink, sourcesOf, type WebCall } from "./web.ts";

test("a source becomes a Markdown link that can't break out of its brackets", () => {
  assert.equal(markdownLink({ title: "Kintsugi - Wikipedia", url: "https://en.wikipedia.org/wiki/Kintsugi" }), "[Kintsugi - Wikipedia](https://en.wikipedia.org/wiki/Kintsugi)");
  assert.equal(markdownLink({ title: "A [draft]\n title", url: "https://example.com/a (b)" }), "[A \\[draft\\] title](https://example.com/a%20%28b%29)");
  assert.equal(markdownLink({ title: "", url: "https://www.example.com/x" }), "[example.com](https://www.example.com/x)");
});

test("domains drop www and survive bad URLs", () => {
  assert.equal(domain("https://www.newyorker.com/magazine"), "newyorker.com");
  assert.equal(domain("not a url"), null);
});

test("sources list pages read first, then search results, each URL once", () => {
  const calls: WebCall[] = [
    { tool: "search", query: "q", results: [{ url: "https://a.com/", title: "A" }, { url: "https://b.com/", title: "B" }] },
    { tool: "fetch", results: [{ url: "https://b.com/", title: "B, read" }] },
  ];
  assert.deepEqual(sourcesOf(calls).map((s) => s.title), ["B, read", "A"]);
  assert.deepEqual(sourcesOf([]), []);
});
