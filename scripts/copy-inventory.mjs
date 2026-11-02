#!/usr/bin/env node
// pnpm copy:inventory: every user-facing string with its location, grouped by
// screen, so one person can read all of Kintsugi's copy in one place.
//
//   node scripts/copy-inventory.mjs [--json] [files…]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, inventory, rel, scopeFiles } from './copy-lint/index.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const paths = args.filter((a) => !a.startsWith('--'));
const files = paths.length ? paths.map((p) => rel(resolve(p))) : scopeFiles();
const groups = inventory(files, (path) => readFileSync(resolve(ROOT, path), 'utf8'));

if (json) {
  console.log(JSON.stringify(Object.fromEntries(groups), null, 2));
} else {
  for (const [screen, items] of groups) {
    console.log(`\n## ${screen}\n`);
    for (const item of items) console.log(`${item.file}:${item.line}  ${item.text.replace(/\n/g, '\n      ')}`);
  }
}
