#!/usr/bin/env node
// Builds Kin's model catalog from Pi's (KI-60).
//
//   pnpm gen:models                 # the version pinned below
//   pnpm gen:models 1.6.0           # another published version
//   pnpm gen:models ./path/to/data  # a folder of Pi's provider data files
//
// Pi (github.com/badlogic/pi-mono, packages/ai) publishes its generated
// catalog as `dist/providers/data/<provider>.json` in the npm package
// `@earendil-works/pi-ai`: per provider, the models grouped by API, each with
// its base URL, limits, prices, reasoning support, input modalities and the
// per-model quirks ("compat", "thinkingLevelMap"). Pi keeps only tool-capable
// chat models. `npm pack` downloads the tarball alone, without installing
// Pi or any of its dependencies.
//
// Writes apps/desktop/src-tauri/src/ai/catalog.json: the chat models of the
// providers Kin speaks (PROVIDERS, matching `wire::PROVIDERS` in Rust) on the
// APIs it implements (APIS), sorted, one model per line. Hand-maintained
// entries in catalog.extra.json are added where Pi has no model of that
// provider and id.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = "@earendil-works/pi-ai";
const VERSION = "1.5.0";
const AI = join(dirname(fileURLToPath(import.meta.url)), "..", "apps/desktop/src-tauri/src/ai");
const OUT = join(AI, "catalog.json");
const EXTRA = join(AI, "catalog.extra.json");

/** Pi's API ids that Kin's `wire.rs` implements. Mistral's own API is served
 *  over its OpenAI-compatible chat completions (see `wire::Wire::from_api`). */
export const APIS = [
  "anthropic-messages",
  "google-generative-ai",
  "google-vertex",
  "mistral-conversations",
  "openai-codex-responses",
  "openai-completions",
  "openai-responses",
];

/** Pi's providers Kin has a `wire::Provider` for. Left out: Amazon Bedrock
 *  (AWS request signing), Azure and Cloudflare (per-account URLs), Radius
 *  and Typesafe (Pi's own APIs). */
export const PROVIDERS = [
  "ant-ling",
  "anthropic",
  "baseten",
  "cerebras",
  "deepseek",
  "fireworks",
  "github-copilot",
  "google",
  "google-vertex",
  "groq",
  "huggingface",
  "kimi-coding",
  "meta",
  "minimax",
  "minimax-cn",
  "mistral",
  "moonshotai",
  "moonshotai-cn",
  "nvidia",
  "openai",
  "openai-codex",
  "opencode",
  "opencode-go",
  "openrouter",
  "qwen-token-plan",
  "qwen-token-plan-cn",
  "qwen-token-plan-individual",
  "together",
  "vercel-ai-gateway",
  "xai",
  "xiaomi",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-sgp",
  "zai",
  "zai-coding-cn",
];

/** The fields Kin keeps, in this order. */
const FIELDS = [
  "provider",
  "id",
  "name",
  "api",
  "baseUrl",
  "reasoning",
  "input",
  "contextWindow",
  "maxTokens",
  "cost",
  "thinkingLevelMap",
  "compat",
  "headers",
];

/** One Pi model as a catalog entry, or null when Kin can't use it. */
export function entry(model) {
  if (model.type !== "chat" || !APIS.includes(model.api) || !PROVIDERS.includes(model.provider)) return null;
  for (const field of ["id", "name", "baseUrl"]) {
    if (typeof model[field] !== "string" || !model[field]) throw new Error(`${model.provider}/${model.id}: no ${field}`);
  }
  for (const field of ["contextWindow", "maxTokens"]) {
    if (!(Number.isFinite(model[field]) && model[field] > 0)) throw new Error(`${model.provider}/${model.id}: bad ${field}`);
  }
  for (const field of ["input", "output", "cacheRead", "cacheWrite"]) {
    if (!Number.isFinite(model.cost?.[field])) throw new Error(`${model.provider}/${model.id}: bad cost.${field}`);
  }
  const out = {};
  for (const field of FIELDS) if (model[field] !== undefined) out[field] = model[field];
  out.reasoning = model.reasoning === true;
  return out;
}

/** Every usable model in a folder of Pi's `<provider>.json` files. */
export function readPiData(dir) {
  const models = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith(".")).sort()) {
    const groups = JSON.parse(readFileSync(join(dir, file), "utf8"));
    for (const group of Object.values(groups)) {
      for (const model of Object.values(group)) {
        const e = entry(model);
        if (e) models.push(e);
      }
    }
  }
  return models;
}

const byKey = (a, b) => (a.provider === b.provider ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.provider < b.provider ? -1 : 1);

/** Pi's models plus the extras Pi lacks, sorted, with the source noted. */
export function build(models, extras, source) {
  const seen = new Set(models.map((m) => `${m.provider}/${m.id}`));
  const all = [...models];
  for (const extra of extras) {
    const e = entry({ type: "chat", ...extra });
    if (!e) throw new Error(`catalog.extra.json: ${extra.provider}/${extra.id} has an unsupported provider or API`);
    if (!seen.has(`${e.provider}/${e.id}`)) all.push(e);
  }
  all.sort(byKey);
  const missing = PROVIDERS.filter((p) => !all.some((m) => m.provider === p));
  if (missing.length) throw new Error(`no models for ${missing.join(", ")}`);
  return format(source, all);
}

/** Stable, diff-friendly JSON: one model per line. */
export function format(source, models) {
  return `{\n  "source": ${JSON.stringify(source)},\n  "models": [\n${models.map((m) => `    ${JSON.stringify(m)}`).join(",\n")}\n  ]\n}\n`;
}

function fromNpm(version) {
  const dir = mkdtempSync(join(tmpdir(), "kintsugi-pi-ai-"));
  try {
    const out = execFileSync("npm", ["pack", `${PACKAGE}@${version}`, "--json", "--pack-destination", dir], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
    const [packed] = JSON.parse(out);
    execFileSync("tar", ["xzf", join(dir, packed.filename), "-C", dir, "package/dist/providers/data"]);
    const models = readPiData(join(dir, "package/dist/providers/data"));
    return { models, source: { package: PACKAGE, version: packed.version, integrity: packed.integrity } };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const arg = process.argv[2] ?? VERSION;
  const local = existsSync(arg) && statSync(arg).isDirectory();
  const { models, source } = local
    ? { models: readPiData(resolve(arg)), source: { package: PACKAGE, version: "local" } }
    : fromNpm(arg);
  const extras = existsSync(EXTRA) ? JSON.parse(readFileSync(EXTRA, "utf8")) : [];
  writeFileSync(OUT, build(models, extras, source));
  const providers = new Set(models.map((m) => m.provider));
  console.log(`catalog.json: ${models.length} models from ${providers.size} providers (${PACKAGE} ${source.version})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
