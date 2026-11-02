#!/usr/bin/env node
// CI's packaged-app smoke test (KI-55). Launches a built Kintsugi.app on a
// scratch HOME, config and seeded vault with KINTSUGI_SMOKE=1, and passes only
// when the real webview rendered the app: the frontend loads the vault and
// calls `app_ready`, the app asks for one reload (the app's own origin has to
// pass the navigation guard), and after the reloaded page renders the backend
// prints KINTSUGI_SMOKE_READY and exits 0 (apps/desktop/src-tauri/src/smoke.rs).
// A blank window, a blocked reload or a crash never prints the marker, so the
// run times out and fails.
//
//   node scripts/smoke-app.mjs [path/to/Kintsugi.app]
//
// It opens a real window, so it only runs where CI is set (the GitHub macOS
// runner). Never run it on the owner's Mac.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = 'KINTSUGI_SMOKE_READY';
const TIMEOUT = Number(process.env.KINTSUGI_SMOKE_TIMEOUT ?? 120_000);

function fail(message) {
  console.error(`smoke: ${message}`);
  process.exit(1);
}

if (!process.env.CI) fail('this opens a native window; it only runs in CI (set CI=1 on a CI runner)');
if (process.platform !== 'darwin') fail('the packaged app is macOS only');

const app = resolve(process.argv[2] ?? join(root, 'target/debug/bundle/macos/Kintsugi.app'));
if (!existsSync(app)) fail(`no app at ${app}; build it with pnpm tauri build --debug --bundles app`);
const plist = spawnSync('plutil', ['-extract', 'CFBundleExecutable', 'raw', join(app, 'Contents/Info.plist')], { encoding: 'utf8' });
if (plist.status !== 0) fail(`could not read the bundle's executable name: ${plist.stderr}`);
const binary = join(app, 'Contents/MacOS', plist.stdout.trim());

const scratch = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'kintsugi-smoke-'));
const [home, vault, config] = ['home', 'vault', 'config'].map((name) => join(scratch, name));
mkdirSync(home);
mkdirSync(config);
const seeded = spawnSync(process.execPath, [join(root, 'scripts/seed-desktop.mjs'), vault], { encoding: 'utf8' });
if (seeded.status !== 0) fail(`seeding the scratch vault failed:\n${seeded.stderr}`);

console.log(`smoke: launching ${binary}\nsmoke: scratch ${scratch}`);
const started = Date.now();
const child = spawn(binary, [], {
  cwd: scratch,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    HOME: home,
    KINTSUGI_SMOKE: '1',
    // Debug builds only: an isolated vault and config, never persisted.
    KINTSUGI_VAULT: vault,
    KINTSUGI_CONFIG_DIR: config,
    // No model download; search is not under test here.
    KINTSUGI_EMBEDDINGS: 'off',
  },
});

let output = '';
let ready = null;
const seen = (chunk) => {
  output += chunk;
  const found = new RegExp(`^${MARKER} rendered=(\\d+)$`, 'm').exec(output);
  if (found && !ready) {
    ready = Number(found[1]);
    console.log(`smoke: ${found[0]} after ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
};
child.stdout.on('data', seen);
child.stderr.on('data', (chunk) => (output += chunk));

const timer = setTimeout(() => {
  // Evidence for the failure: what the screen showed (a blank window, a dialog).
  const shot = join(process.env.KINTSUGI_SMOKE_SHOTS || scratch, 'timeout.png');
  mkdirSync(dirname(shot), { recursive: true });
  spawnSync('screencapture', ['-x', shot]);
  child.kill('SIGKILL');
  fail(`no ${MARKER} within ${TIMEOUT / 1000}s (screenshot: ${shot}). The app's output:\n${output.slice(-8000)}`);
}, TIMEOUT);

child.on('exit', (code, signal) => {
  clearTimeout(timer);
  if (!/^smoke: first render/m.test(output)) fail(`the app never reported its first render. Its output:\n${output.slice(-8000)}`);
  if (ready === null) fail(`the app exited (${signal ?? code}) without ${MARKER}. Its output:\n${output.slice(-8000)}`);
  if (!(ready > 0)) fail(`the app reported an empty page (rendered=${ready})`);
  if (code !== 0) fail(`the app printed ${MARKER} but exited with ${signal ?? code}`);
  console.log(output.split('\n').filter((line) => line.startsWith('smoke: ')).map((line) => `  app ${line}`).join('\n'));
  console.log('smoke: the packaged app rendered its vault, reloaded and exited cleanly');
});
