#!/usr/bin/env node
// PROTOTYPE (KI-96), throwaway: the Kin and writing surface prototype.
// Starts the headless app (scratch vault, Kin's scripted mock model, no
// credentials read, nothing sent anywhere) and prints the prototype's URL.
// `--open` also opens it in the default browser.
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const open = process.argv.includes('--open');
const variant = process.argv.find((a) => /^--variant=[ABC]$/.test(a))?.slice(10) ?? 'A';
const runner = spawn(process.execPath, [resolve(root, 'scripts/desktop-headless.mjs')], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'inherit'],
  env: { ...process.env, KINTSUGI_HEADLESS_KIN: 'mock' },
});
let shown = false;
let buffer = '';
runner.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  if (shown) return;
  buffer += chunk;
  const match = buffer.match(/(http:\/\/127\.0\.0\.1:\d+)\/(#headless=\S+)/);
  if (!match) return;
  shown = true;
  const url = `${match[1]}/?proto=kin-surface&variant=${variant}${match[2]}`;
  console.log(`\nKin surface prototype (KI-96). A, B and C switch with the bar at the top or ← →:\n${url}\n`);
  if (open) spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
});
const stop = () => { try { runner.kill('SIGTERM'); } catch { /* gone */ } };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
runner.on('exit', (code) => process.exit(code ?? 0));
