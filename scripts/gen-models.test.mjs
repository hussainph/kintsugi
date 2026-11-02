import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build, entry, PROVIDERS } from "./gen-models.mjs";

const model = (over = {}) => ({
  type: "chat",
  provider: "groq",
  id: "llama",
  name: "Llama",
  api: "openai-completions",
  baseUrl: "https://api.groq.com/openai/v1",
  reasoning: false,
  input: ["text"],
  contextWindow: 131072,
  maxTokens: 8192,
  cost: { input: 0.05, output: 0.08, cacheRead: 0, cacheWrite: 0 },
  inputLimits: { images: {} },
  ...over,
});

test("keeps chat models of supported providers and APIs, with only the fields Kin reads", () => {
  const e = entry(model({ compat: { supportsStore: false } }));
  assert.deepEqual(Object.keys(e), ["provider", "id", "name", "api", "baseUrl", "reasoning", "input", "contextWindow", "maxTokens", "cost", "compat"]);
  assert.equal(entry(model({ type: "image" })), null);
  assert.equal(entry(model({ provider: "amazon-bedrock" })), null);
  assert.equal(entry(model({ api: "bedrock-converse-stream" })), null);
  assert.throws(() => entry(model({ maxTokens: 0 })), /maxTokens/);
  assert.throws(() => entry(model({ cost: { input: 1 } })), /cost.output/);
});

test("extras fill gaps but never replace Pi's entries, and the output is sorted", () => {
  const all = PROVIDERS.map((provider) => model({ provider, id: "m" }));
  const extras = [model({ id: "aaa", name: "Hand" }), model({ id: "m", name: "Ignored" })];
  const json = JSON.parse(build(all.reverse(), extras, { version: "test" }));
  const groq = json.models.filter((m) => m.provider === "groq");
  assert.deepEqual(groq.map((m) => [m.id, m.name]), [["aaa", "Hand"], ["m", "Llama"]]);
  assert.equal(json.models[0].provider, [...PROVIDERS].sort()[0]);
  assert.throws(() => build([], [], {}), /no models for/);
});

test("the checked-in catalog is in the generated shape", () => {
  const path = join(dirname(fileURLToPath(import.meta.url)), "../apps/desktop/src-tauri/src/ai/catalog.json");
  const text = readFileSync(path, "utf8");
  const json = JSON.parse(text);
  assert.ok(json.models.length > 100);
  for (const p of PROVIDERS) assert.ok(json.models.some((m) => m.provider === p), p);
  for (const m of json.models) assert.deepEqual(entry({ type: "chat", ...m }), m);
});
