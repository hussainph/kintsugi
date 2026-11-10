import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build, entry, PROVIDERS, readPiAuth } from "./gen-models.mjs";

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
  assert.deepEqual(Object.keys(e), ["provider", "id", "name", "api", "baseUrl", "reasoning", "input", "inputLimits", "contextWindow", "maxTokens", "cost", "compat"]);
  assert.equal(entry(model({ type: "image" })), null);
  assert.equal(entry(model({ provider: "amazon-bedrock" })), null);
  assert.equal(entry(model({ api: "bedrock-converse-stream" })), null);
  assert.throws(() => entry(model({ maxTokens: 0 })), /maxTokens/);
  assert.throws(() => entry(model({ cost: { input: 1 } })), /cost.output/);
});

test("retains all input-limit metadata from Pi", () => {
  const inputLimits = {
    maxRequestBytes: 20 * 1024 * 1024,
    images: { resize: { maxWidth: 512, maxHeight: 768, maxBytes: 50000, jpegQuality: 70 }, maxPerMessage: 8, maxPerRequest: 100 },
  };
  assert.deepEqual(entry(model({ inputLimits })).inputLimits, inputLimits);
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

test("Pi's auth facts are read from its built source: constants, literals, request fields, providers", () => {
  const dist = mkdtempSync(join(tmpdir(), "ki92-pi-dist-"));
  try {
    mkdirSync(join(dist, "auth/oauth"), { recursive: true });
    mkdirSync(join(dist, "providers"), { recursive: true });
    writeFileSync(
      join(dist, "auth/oauth/demo.js"),
      [
        'const decode = (s) => atob(s);',
        'const CLIENT_ID = decode("SXYxLmFiYw==");',
        'const BASE = "https://auth.example.com";',
        'const TOKEN_URL = `${BASE}/oauth/token`;',
        'const TIMEOUT_MS = 5 * 60 * 1000;',
        'const body = new URLSearchParams({ grant_type: "refresh_token", client_id: CLIENT_ID, scope });',
        'fetch(`${BASE}/device`, { body: JSON.stringify({ "device_code": x, user_code }) });',
      ].join("\n"),
    );
    writeFileSync(join(dist, "providers/demo.js"), 'createProvider({ id: "demo", auth: { apiKey: envApiKeyAuth("Demo key", ["DEMO_API_KEY"]), oauth: lazyOAuth({ load: loadDemoOAuth }) } });');
    writeFileSync(join(dist, "providers/plain.js"), 'createProvider({ id: "plain", auth: { apiKey: customAuth } });');
    const auth = readPiAuth(dist);
    const demo = auth.oauth.demo;
    assert.equal(demo.constants.CLIENT_ID, "Iv1.abc");
    assert.equal(demo.constants.TOKEN_URL, "https://auth.example.com/oauth/token");
    assert.equal(demo.constants.TIMEOUT_MS, 300000);
    assert.deepEqual(demo.constants.decode, { source: "(s) => atob(s)" });
    assert.ok(demo.strings.includes("${BASE}/device"));
    assert.deepEqual(demo.bodies, [["grant_type", "client_id", "scope"], ["device_code", "user_code"]]);
    assert.deepEqual(auth.providers, { demo: { apiKey: ["DEMO_API_KEY"], oauth: "Demo" }, plain: { apiKey: "custom", oauth: null } });
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test("the checked-in auth facts are Pi's at the pinned version", () => {
  const path = join(dirname(fileURLToPath(import.meta.url)), "../apps/desktop/src-tauri/src/ai/auth.pi.json");
  const json = JSON.parse(readFileSync(path, "utf8"));
  const pinned = /const VERSION = "([^"]+)"/.exec(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "gen-models.mjs"), "utf8"))[1];
  assert.equal(json.source.version, pinned);
  assert.equal(JSON.parse(readFileSync(join(dirname(path), "catalog.json"), "utf8")).source.version, pinned);
  for (const id of ["openai-codex", "openai-chatgpt", "github-copilot", "kimi-coding", "xai", "meta", "openrouter"]) assert.ok(json.oauth[id], id);
});
