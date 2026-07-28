/**
 * vitest globalSetup (fix instar#1069): build the project to `dist/` before the
 * integration/e2e run so the dist-backed worker test
 * (cartographer-eventloop-worker.test.ts) has a real compiled
 * `dist/core/cartographerDetect.worker.js` to resolve — proving the PROD worker
 * path, not a transpile-on-the-fly stand-in. Idempotent: it skips the build when
 * the worker dist is newer than every `src/**.ts` (so local re-runs are fast).
 *
 * The current pipeline runs vitest on TS source with NO preceding build; without
 * this, the dist-backed test would find no dist. It fails LOUD (throws) if the
 * build fails, rather than letting the dist-backed test skip silently.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function newestSrcMtime(dir: string): number {
  let newest = 0;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return newest; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) newest = Math.max(newest, newestSrcMtime(p));
    else if (e.name.endsWith('.ts')) {
      try { newest = Math.max(newest, fs.statSync(p).mtimeMs); } catch { /* ignore */ }
    }
  }
  return newest;
}

export default function setup(): void {
  const distWorker = path.join(ROOT, 'dist', 'core', 'cartographerDetect.worker.js');
  const fresh = fs.existsSync(distWorker) &&
    fs.statSync(distWorker).mtimeMs >= newestSrcMtime(path.join(ROOT, 'src'));
  if (fresh) return;
  // tsc only (skip manifest-gen/sign-lockfile from the full `build` — we just need dist).
  execSync('npx tsc', { cwd: ROOT, stdio: 'inherit' });
  // Restore the bin exec bit the full build script applies (tsc emits 0644) — the
  // package-completeness guard asserts every package.json bin ships executable.
  try { fs.chmodSync(path.join(ROOT, 'dist', 'cli.js'), 0o755); } catch { /* dist/cli.js absent in partial builds */ }
}
