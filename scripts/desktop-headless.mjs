#!/usr/bin/env node
// Deliberately never invokes the Tauri CLI or a native runtime.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function canonical(path) {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  return resolve(canonical(parent), relative(parent, path));
}
const contains = (parent, child) => child === parent || child.startsWith(parent + sep);
export function scratchPath(path, home = homedir()) {
  const target = canonical(resolve(path));
  for (const forbidden of ['Documents/Kintsugi', 'Library/Application Support/dev.phalasiya.kintsugi'].map(p => canonical(resolve(home, p)))) {
    if (contains(target, forbidden) || contains(forbidden, target)) {
      throw new Error('Refusing the owner’s vault/config or their ancestors; choose a scratch directory');
    }
  }
  return target;
}

export function run() {
  mkdirSync(resolve(root, '.headless'), { recursive: true });
  const runDir = mkdtempSync(resolve(root, '.headless/run-'));
  const vault = scratchPath(process.env.KINTSUGI_VAULT || resolve(runDir, 'vault'));
  const config = scratchPath(process.env.KINTSUGI_CONFIG_DIR || resolve(runDir, 'config'));
  if (contains(vault, config) || contains(config, vault)) throw new Error('Scratch vault and config must be separate directories');
  mkdirSync(vault, { recursive: true });
  mkdirSync(config, { recursive: true });
  if (!process.env.KINTSUGI_VAULT) {
    const seed = spawnSync(process.execPath, [resolve(root, 'scripts/seed-desktop.mjs'), vault], { cwd: root, stdio: 'inherit' });
    if (seed.status !== 0) throw new Error('Could not seed the default scratch vault');
  }
  const env = {
    ...process.env,
    KINTSUGI_HEADLESS: '1',
    KINTSUGI_VAULT: vault,
    KINTSUGI_CONFIG_DIR: config,
    KINTSUGI_FRONTEND_PORT: process.env.KINTSUGI_FRONTEND_PORT || '1422',
    KINTSUGI_BACKEND_PORT: process.env.KINTSUGI_BACKEND_PORT || '1423',
  };
  for (const key of ['KINTSUGI_FRONTEND_PORT', 'KINTSUGI_BACKEND_PORT']) {
    if (!/^\d+$/.test(env[key]) || +env[key] < 1 || +env[key] > 65535) throw new Error(`Invalid ${key}`);
  }
  if (env.KINTSUGI_FRONTEND_PORT === env.KINTSUGI_BACKEND_PORT) throw new Error('Frontend/backend ports must differ');
  const children = [];
  let stopping = false;
  const stop = (code = 0) => {
    if (stopping) return;
    stopping = true;
    for (const child of children) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ }
    }
    process.exitCode = code;
  };
  const start = (command, args) => {
    const child = spawn(command, args, { cwd: root, env, stdio: 'inherit', detached: true });
    children.push(child);
    child.on('error', error => { console.error(error.message); stop(1); });
    child.on('exit', (code, signal) => { if (!stopping) stop(code ?? (signal ? 1 : 0)); });
  };
  process.on('SIGINT', () => stop());
  process.on('SIGTERM', () => stop());
  process.on('exit', () => stop());
  console.log(`Scratch run: ${runDir}\nAI: ${env.KINTSUGI_HEADLESS_PI_READONLY === '1' ? 'read-only Pi opt-in' : 'disabled (no credentials read)'}`);
  start('cargo', ['run', '-p', 'kintsugi', '--bin', 'kintsugi', '--no-default-features', '--features', 'headless', '-j', env.VOLLI_CONCURRENCY_HINT || '1']);
  start('pnpm', ['--filter', '@kintsugi/desktop', 'dev']);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { run(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
