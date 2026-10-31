#!/usr/bin/env node
// Builds, signs, notarizes and (with --publish) releases the Mac app.
//
//   node scripts/release-desktop.mjs            # build into target/release/bundle
//   node scripts/release-desktop.mjs --publish  # …and create GitHub release v<version>
//
// Needs, from the environment (never committed):
//   TAURI_SIGNING_PRIVATE_KEY_PASSWORD  updater key password (key: ~/.tauri/kintsugi-updater.key)
//   APPLE_ID, APPLE_PASSWORD            notarization (an app-specific password)
// and a "Developer ID Application" identity in the login keychain.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const repo = "hussainph/kintsugi";
const conf = JSON.parse(readFileSync(join(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"));
const version = conf.version;
const tag = `v${version}`;
const publish = process.argv.includes("--publish");

const keyPath = process.env.TAURI_SIGNING_PRIVATE_KEY ?? join(homedir(), ".tauri/kintsugi-updater.key");
const env = {
  ...process.env,
  TAURI_SIGNING_PRIVATE_KEY: keyPath,
  APPLE_SIGNING_IDENTITY: process.env.APPLE_SIGNING_IDENTITY ?? "Developer ID Application: Hussain Phalasiya (Y54F649NH4)",
  APPLE_TEAM_ID: process.env.APPLE_TEAM_ID ?? "Y54F649NH4",
};
for (const name of ["TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "APPLE_ID", "APPLE_PASSWORD"]) {
  if (!env[name]) fail(`${name} is not set`);
}
if (!existsSync(keyPath)) fail(`updater key not found at ${keyPath}`);

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, env, stdio: "inherit", ...opts });

console.log(`Building Kintsugi ${version}…`);
run("pnpm", ["--filter", "@kintsugi/desktop", "tauri", "build"]);

const bundle = join(root, "target/release/bundle");
const one = (dir, suffix) => {
  const hits = readdirSync(join(bundle, dir)).filter((f) => f.endsWith(suffix));
  if (hits.length !== 1) fail(`expected one *${suffix} in ${dir}, found ${hits.length}`);
  return join(bundle, dir, hits[0]);
};
const dmg = one("dmg", ".dmg");
const archive = one("macos", ".app.tar.gz");

// Tauri notarizes the app but not the disk image around it; Gatekeeper
// rejects a downloaded DMG without its own ticket.
console.log("Notarizing the DMG…");
run("xcrun", ["notarytool", "submit", dmg, "--apple-id", env.APPLE_ID, "--password", env.APPLE_PASSWORD,
  "--team-id", env.APPLE_TEAM_ID, "--wait"]);
run("xcrun", ["stapler", "staple", dmg]);
const signature = readFileSync(`${archive}.sig`, "utf8").trim();

// The updater reads this from releases/latest/download/latest.json.
const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
const manifest = {
  version,
  notes: `Kintsugi ${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    [`darwin-${arch}`]: {
      signature,
      url: `https://github.com/${repo}/releases/download/${tag}/${archive.split("/").pop()}`,
    },
  },
};
const latest = join(bundle, "latest.json");
writeFileSync(latest, JSON.stringify(manifest, null, 2) + "\n");

console.log(`\nBuilt:\n  ${dmg}\n  ${archive}\n  ${latest}`);
if (!publish) process.exit(0);

run("gh", ["release", "create", tag, dmg, archive, `${archive}.sig`, latest,
  "--repo", repo, "--title", `Kintsugi ${version}`, "--notes", manifest.notes]);
console.log(`\nPublished https://github.com/${repo}/releases/tag/${tag}`);

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}
