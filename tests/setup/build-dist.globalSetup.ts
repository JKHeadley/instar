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

/**
 * TWO steps, in this order, and the ORDER IS LOAD-BEARING IN BOTH DIRECTIONS — which is
 * the whole lesson of this function's history:
 *
 *   1. `ensureDistBuilt()` — conditional (skipped when dist is already fresh).
 *   2. `ensureRegistryAsset()` — UNCONDITIONAL, and necessarily AFTER step 1.
 *
 * The generator imports `dist/core/StandardsRegistryParser.js` and its own header says it
 * must run after `tsc`. So it cannot go first. But it also cannot live INSIDE step 1,
 * because step 1 returns early on a freshness probe of an unrelated artifact (the
 * cartographer worker) — so a fresh dist skipped the asset entirely.
 *
 * Both orderings have now been shipped and both were wrong, in opposite directions:
 * originally the call sat below the early return (unreachable whenever dist was fresh);
 * the fix for that hoisted it above `tsc` (fatal on CI, where `npm ci` → `npm run test:*`
 * runs with NO build, so `dist/` does not exist, the generator exits 1, and `execSync`
 * throws out of globalSetup before a single test runs). Locally both bugs are invisible
 * because `dist/` happens to exist. Separating the two concerns is what makes the
 * constraint expressible instead of accidental.
 */
export default function setup(): void {
  ensureDistBuilt();
  ensureRegistryAsset();
}

function ensureDistBuilt(): void {
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

/**
 * Generate the packed constitution if it is absent.
 *
 * `src/data/standards-registry.{md,meta.json}` are gitignored BUILD OUTPUT, and any test
 * that exercises the production resolver (rather than injecting a fixture path) needs
 * them. On a fresh CI checkout — `npm ci`, no `npm run build` — they do not exist, and the
 * `npx tsc` in `ensureDistBuilt()` does not create them either: the generator is a separate
 * step of the full build. (`ensureDistBuilt` runs FIRST — the generator needs its output.
 * The word here used to be "above", which stopped being true the moment the reorder moved
 * the build into its own function; naming the function instead of a direction is what stops
 * that recurring.)
 *
 * WHY THIS IS HERE AND NOT IN A `beforeAll` (measured, and I got it wrong first):
 * exactly one test file carried a self-bootstrapping `beforeAll`. When a review round
 * raised "CI cannot run this green", I tested THAT file, saw it pass, and recorded the
 * finding as unreproducible. Then I added a production-path block to a sharded
 * INTEGRATION file — which has no such bootstrap — making the finding concrete.
 * Reproduced afterwards with both asset copies moved aside: exactly 2 failures.
 *
 * The lesson is about the rebuttal, not the bug: I disproved a claim by measuring a
 * different subject than the one it was about. A per-file bootstrap is invisible to the
 * next file that needs it, so the guarantee belongs at the setup layer where every file
 * inherits it.
 *
 * It runs AFTER the dist build above, never before — see the ordering note on `setup()`.
 */
function ensureRegistryAsset(): void {
  // BOTH output dirs, not just `src/data`. The generator writes the pair to each, and
  // they are consumed by different readers: tests resolving through TS source read
  // `src/data`, while the migrator's mirror sources `dist/data` (the copy that actually
  // ships). A `dist` clean therefore leaves `src/data` present and the mirror's source
  // gone — and probing only `src/data` would return early over exactly that state.
  const needed = [
    path.join(ROOT, 'src', 'data', 'standards-registry.md'),
    path.join(ROOT, 'src', 'data', 'standards-registry.meta.json'),
    path.join(ROOT, 'src', 'data', 'standards-guard-index.json'),
    path.join(ROOT, 'src', 'data', 'standards-guard-index.meta.json'),
    path.join(ROOT, 'dist', 'data', 'standards-registry.md'),
    path.join(ROOT, 'dist', 'data', 'standards-registry.meta.json'),
    path.join(ROOT, 'dist', 'data', 'standards-guard-index.json'),
    path.join(ROOT, 'dist', 'data', 'standards-guard-index.meta.json'),
  ];
  if (needed.every((p) => fs.existsSync(p))) return;
  execSync('node scripts/generate-standards-registry-asset.mjs', { cwd: ROOT, stdio: 'inherit' });
}
