#!/usr/bin/env node
// pnpm lint:copy: no eyebrow text, plain copy. Rules: docs/voice.md.
//
//   node scripts/lint-copy.mjs              whole repo scope
//   node scripts/lint-copy.mjs --staged     staged files only (pre-commit)
//   node scripts/lint-copy.mjs <files…>     these files, in scope or not
//   node scripts/lint-copy.mjs --allows     list every copy-lint-allow
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, allowances, format, lintSource, readStaged, rel, scopeFiles, stagedFiles } from './copy-lint/index.mjs';

const args = process.argv.slice(2);
const staged = args.includes('--staged');
const listAllows = args.includes('--allows');
const paths = args.filter((a) => !a.startsWith('--'));

const files = staged ? stagedFiles() : paths.length ? paths.map((p) => rel(resolve(p))) : scopeFiles();
const read = (path) => (staged ? readStaged(path) : readFileSync(resolve(ROOT, path), 'utf8'));

if (listAllows) {
  for (const a of allowances(files, read)) console.log(`${a.file}:${a.line}: ${a.reason}`);
  process.exit(0);
}

let findings = [];
try {
  for (const path of files) findings.push(...lintSource(path, read(path)));
} catch (error) {
  console.error(`lint:copy: ${error.message}`);
  process.exit(2);
}
if (findings.length) {
  for (const f of findings) console.log(format(f));
  console.log(`\nlint:copy: ${findings.length} problem${findings.length === 1 ? '' : 's'} in ${new Set(findings.map((f) => f.file)).size} file(s). Rules: docs/voice.md.`);
  console.log('A line that must keep its wording can carry `copy-lint-allow: <reason>`. Use it rarely.');
  process.exit(1);
}
console.log(`lint:copy: ${files.length} file(s) clean.`);
