// `pnpm --filter @kintsugi/mobile export:check` (KI-53)
//
// Runs `expo export --platform ios` (what `eas update` runs) into a temporary
// directory, checks that the DOM components exported whole, and deletes the
// directory. The export once failed on the DOM editor with
// "Asset not found: _expo/static/js/web/__common-*.js" while dev and Release
// builds kept working, so nothing else would have noticed.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const app = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const tmp = mkdtempSync(path.join(tmpdir(), 'kintsugi-export-check-'));
const out = path.join(tmp, 'dist');

function fail(message) {
  console.error(`export:check failed: ${message}`);
  process.exitCode = 1;
}

try {
  const result = spawnSync('expo', ['export', '--platform', 'ios', '--output-dir', out], {
    cwd: app,
    env: { ...process.env, CI: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(`${result.stdout}\n${result.stderr}`.trim().split('\n').slice(-40).join('\n') + '\n');
    fail(`expo export exited with ${result.status}`);
  } else {
    check();
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

function check() {
  const metadata = JSON.parse(readFileSync(path.join(out, 'metadata.json'), 'utf8'));
  const ios = metadata.fileMetadata?.ios;
  if (!ios) return fail('metadata.json has no ios entry');

  for (const asset of [{ path: ios.bundle }, ...ios.assets]) {
    if (!existsSync(path.join(out, asset.path))) fail(`metadata lists a missing file: ${asset.path}`);
  }

  const www = path.join(out, 'www.bundle');
  const pages = existsSync(www) ? readdirSync(www).filter((f) => f.endsWith('.html')) : [];
  if (pages.length === 0) return fail('no DOM components were exported (www.bundle/*.html)');

  const native = readFileSync(path.join(out, ios.bundle));
  for (const page of pages) {
    if (!native.includes(page)) fail(`the native bundle never references ${page}`);
    if (!ios.assets.some((a) => a.path === `www.bundle/${page}`)) fail(`metadata omits www.bundle/${page}`);
    const html = readFileSync(path.join(www, page), 'utf8');
    const refs = [...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map((m) => m[1]);
    if (!refs.some((r) => r.endsWith('.js'))) fail(`${page} loads no script`);
    for (const ref of refs) {
      if (!existsSync(path.join(www, ref))) fail(`${page} references a missing file: ${ref}`);
    }
  }

  if (!process.exitCode) console.log(`export:check ok: ${pages.length} DOM component(s), ${ios.assets.length} assets`);
}
