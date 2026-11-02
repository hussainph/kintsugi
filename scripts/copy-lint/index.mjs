// Shared core of `pnpm lint:copy` and `pnpm copy:inventory`.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { ALLOW, HINTS, checkText } from './rules.mjs';
import { extractTs } from './extract-ts.mjs';
import { extractRust } from './extract-rust.mjs';
import { extractCss, extractHtml, extractMarkdown } from './extract-docs.mjs';

export const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');

/** What the checker covers, relative to the repo root. */
export const SCOPE = [
  { dir: 'apps/desktop/src', ext: /\.(?:tsx?|css)$/ },
  { dir: 'apps/mobile/src', ext: /\.(?:tsx?|css)$/ },
  { dir: 'packages/editor/src', ext: /\.(?:tsx?|css)$/ },
  { dir: 'packages/ui/src', ext: /\.(?:tsx?|css)$/ },
  { dir: 'packages/core/src', ext: /\.(?:tsx?|css)$/ },
  { dir: 'apps/desktop/src-tauri/src', ext: /\.rs$/ },
  { dir: 'docs', ext: /\.(?:md|html)$/, flat: true },
  { file: 'README.md' },
];

/** Files that are not copy. Keep this short and say why. */
export const IGNORE = [
  [/(?:^|\/)[^/]*\.test\.tsx?$/, 'tests assert copy, they are not copy'],
  [/\.d\.ts$/, 'type declarations'],
  [/^apps\/desktop\/src-tauri\/src\/(?:.*\/)?tests?(?:\.rs|\/)/, 'Rust tests'],
  [/^apps\/desktop\/src-tauri\/src\/phone\/dev\.rs$/, 'test-only dev server (`#[cfg(all(test, feature = "headless"))] mod dev`)'],
  [/^docs\/voice\.md$/, 'the voice rules quote the banned examples on purpose'],
];

export function inScope(path) {
  if (IGNORE.some(([re]) => re.test(path))) return false;
  return SCOPE.some((s) => s.file ? path === s.file : path.startsWith(`${s.dir}/`) && s.ext.test(path) && (!s.flat || !path.slice(s.dir.length + 1).includes('/')));
}

export function scopeFiles(root = ROOT) {
  const out = [];
  const walk = (dir, flat) => {
    let entries;
    try { entries = readdirSync(join(root, dir), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const path = `${dir}/${e.name}`;
      if (e.isDirectory()) { if (!flat && e.name !== 'node_modules') walk(path, flat); } else if (inScope(path)) out.push(path);
    }
  };
  for (const s of SCOPE) {
    if (s.file) { try { if (statSync(join(root, s.file)).isFile() && inScope(s.file)) out.push(s.file); } catch {} } else walk(s.dir, s.flat);
  }
  return out.sort();
}

export function stagedFiles(root = ROOT) {
  const names = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  return names.filter(inScope);
}

export function readStaged(path, root = ROOT) {
  return execFileSync('git', ['show', `:${path}`], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });
}

export function extract(path, source) {
  if (/\.tsx?$/.test(path)) return extractTs(path, source);
  if (path.endsWith('.rs')) return extractRust(path, source);
  if (path.endsWith('.md')) return extractMarkdown(path, source);
  if (path.endsWith('.html')) return extractHtml(path, source);
  if (path.endsWith('.css')) return extractCss(path, source);
  return { texts: [], styles: [] };
}

function locate(item, f, matched) {
  if (item.map) return item.map(f.index);
  if (item.column) return item.line;
  let at = item.raw.indexOf(matched);
  if (at < 0) {
    const re = new RegExp(matched.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'));
    const m = re.exec(item.raw);
    at = m ? m.index : -1;
  }
  if (at < 0) return item.line;
  return item.rawLine + (item.raw.slice(0, at).match(/\n/g)?.length ?? 0);
}

/** Lint one file's source. Returns findings { file, line, rule, detail, hint }. */
export function lintSource(path, source) {
  const { texts, styles } = extract(path, source);
  const findings = [];
  for (const s of styles) findings.push({ file: path, line: s.line, rule: s.rule, detail: s.detail });
  for (const item of texts) {
    for (const f of checkText(item.text)) {
      const matched = item.text.slice(f.index, f.index + f.length);
      findings.push({ file: path, line: locate(item, f, matched), rule: f.rule, detail: f.detail });
    }
  }
  const lines = source.split('\n');
  const result = [];
  const seen = new Set();
  for (const f of findings) {
    const line = lines[f.line - 1] ?? '';
    const allow = ALLOW.exec(line);
    if (allow && allow[1]) continue;
    const key = `${f.line}:${f.rule}:${f.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...f, hint: HINTS[f.rule] });
  }
  lines.forEach((line, i) => {
    const allow = ALLOW.exec(line);
    if (allow && !allow[1] && /copy-lint-allow/.test(line)) result.push({ file: path, line: i + 1, rule: 'allow-reason', detail: '', hint: HINTS['allow-reason'] });
  });
  return result.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

/** Every `copy-lint-allow` in the given files, for the PR body. */
export function allowances(files, read) {
  const out = [];
  for (const path of files) {
    read(path).split('\n').forEach((line, i) => {
      const allow = ALLOW.exec(line);
      if (allow && allow[1]) out.push({ file: path, line: i + 1, reason: allow[1].trim() });
    });
  }
  return out;
}

export function format(f) {
  return `${f.file}:${f.line}: ${f.rule}${f.detail ? ` ${f.detail}` : ''}\n    fix: ${f.hint}`;
}

const AREAS = {
  feed: 'Feed', inspiration: 'Inspiration', ideas: 'Ideas', kin: 'Kin', publish: 'Publish', export: 'Export', references: 'Write: references',
  refine: 'Write: refine', comments: 'Write: comments', lib: 'shared', headless: 'headless bridge',
};

/** The screen or area a file belongs to, for the inventory. */
export function screenOf(path) {
  const parts = path.split('/');
  const base = parts.at(-1).replace(/\.[^.]+$/, '');
  if (path.startsWith('apps/desktop/src-tauri/src/')) {
    const rest = parts.slice(4);
    if (rest[0] === 'ai' && (rest[1] === 'ideas' || base === 'ideas')) return 'Backend: Ideas';
    if (rest[0] === 'ai' && /^(?:prompt|kin|chat|about|memory|tools|agent|scripted|comments|history)$/.test(rest[1]?.replace(/\.rs$/, '') ?? '')) return 'Backend: Kin';
    if (rest[0] === 'phone') return 'Backend: phone API';
    return `Backend: ${rest.length > 1 ? rest[0] : base}`;
  }
  if (path.startsWith('apps/desktop/src/')) {
    const area = parts[3];
    if (area === 'components') return `Mac: ${base}`;
    if (parts.length === 4) return `Mac: ${base === 'App' ? 'app shell' : base}`;
    return `Mac: ${AREAS[area] ?? area}`;
  }
  if (path.startsWith('apps/mobile/src/')) {
    if (parts[3] === 'app') return `Phone: ${base === 'index' ? 'home' : base}`;
    if (parts[3] === 'components') return `Phone: ${parts.length > 5 ? parts[4] : base}`;
    return `Phone: ${parts[3] === 'lib' ? 'shared' : base}`;
  }
  if (path.startsWith('packages/')) return `${parts[1][0].toUpperCase()}${parts[1].slice(1)} package: ${base}`;
  if (path.startsWith('docs/') || path === 'README.md') return `Docs: ${path}`;
  return path;
}

export function inventory(files, read) {
  const groups = new Map();
  for (const path of files) {
    const source = read(path);
    for (const item of extract(path, source).texts) {
      const screen = screenOf(path);
      if (!groups.has(screen)) groups.set(screen, []);
      groups.get(screen).push({ file: path, line: item.line, text: item.text.trim(), context: item.context, name: item.name });
    }
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export function rel(path) {
  return relative(ROOT, path).split(sep).join('/');
}
