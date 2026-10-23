// safe-fs-allow: test file — SafeFsExecutor for tmpdir cleanup, and for the one
// removal inside a fixture tmpdir that proves the loader caches rather than
// merely being deterministic.
/**
 * Tier-1 tests for WHERE the skip ratchet resolves its TypeScript parser from
 * (regression: 2026-10-23, PR #2318).
 *
 * The verifier process loads `src/localVerify/*` from the agent's SHADOW
 * INSTALL — a production npm install with no devDependencies — so this
 * module's own `require` cannot see `typescript`. Before this fix the ratchet
 * only tried that one location and threw `Cannot find module 'typescript'`.
 * The parser is resolved BEFORE any file is inspected, so the orchestrator's
 * catch-all classified EVERY verify as harness-changing — pull requests with no
 * test-file change and `main` verifies with an empty diff alike — routing clean
 * PRs to the operator and leaving `skipsAdded`/`testsRemoved` at a `false` that
 * had counted nothing.
 *
 * These tests run inside a source checkout, where the module's own resolution
 * succeeds — which is exactly why the pre-existing ratchet tests could not see
 * the bug. They therefore assert the resolution ORDER and the wiring, not the
 * classifier's outcome.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { loadTsFrom, evaluateSkipRatchet } from '../../../src/localVerify/skipRatchet.js';

const tmpDirs: string[] = [];
/** Every fixture directory this file created, for the post-cleanup assertion. */
const created: string[] = [];
function leaked(): string[] { return created; }

function repoWithStubTypescript(marker: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skipratchet-ts-'));
  tmpDirs.push(dir); created.push(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'under-verification' }));
  const mod = path.join(dir, 'node_modules', 'typescript');
  fs.mkdirSync(mod, { recursive: true });
  fs.writeFileSync(path.join(mod, 'package.json'), JSON.stringify({ name: 'typescript', main: 'index.js' }));
  fs.writeFileSync(path.join(mod, 'index.js'), `module.exports = { __stubMarker: ${JSON.stringify(marker)} };`);
  return dir;
}

function emptyRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skipratchet-nots-'));
  tmpDirs.push(dir); created.push(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'under-verification' }));
  return dir;
}

afterAll(() => {
  const failed: string[] = [];
  for (const d of tmpDirs.splice(0)) {
    try {
      SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'test-cleanup: skip-ratchet ts-resolution fixtures' });
    } catch (e) {
      // A silent catch here is exactly how the first version of this cleanup
      // leaked every fixture directory for the life of the file: it called a
      // method that did not exist and nobody heard. Say so, and assert.
      failed.push(`${d}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (failed.length > 0) console.warn(`[skipRatchetTsResolution] fixture cleanup failed:\n${failed.join('\n')}`);
  expect(failed).toEqual([]);
  for (const d of leaked()) expect(fs.existsSync(d)).toBe(false);
});

describe('loadTsFrom', () => {
  it("prefers the verified repo's own node_modules over this module's", () => {
    const dir = repoWithStubTypescript('from-run-dir');
    const mod = loadTsFrom(dir) as unknown as { __stubMarker?: string };
    expect(mod.__stubMarker).toBe('from-run-dir');
  });

  it("falls back to this module's own resolution when the repo has no copy", () => {
    const mod = loadTsFrom(emptyRepo()) as unknown as { createSourceFile?: unknown; __stubMarker?: string };
    expect(mod.__stubMarker).toBeUndefined();
    expect(typeof mod.createSourceFile).toBe('function');
  });

  it('resolves with no directory at all (the pre-existing behaviour)', () => {
    const mod = loadTsFrom() as unknown as { createSourceFile?: unknown };
    expect(typeof mod.createSourceFile).toBe('function');
  });

  it('does not let two repos share a parser', () => {
    const a = repoWithStubTypescript('repo-a');
    const b = repoWithStubTypescript('repo-b');
    expect((loadTsFrom(a) as unknown as { __stubMarker: string }).__stubMarker).toBe('repo-a');
    expect((loadTsFrom(b) as unknown as { __stubMarker: string }).__stubMarker).toBe('repo-b');
    expect((loadTsFrom(a) as unknown as { __stubMarker: string }).__stubMarker).toBe('repo-a');
  });

  it('caches, so a second call does not resolve again', () => {
    const dir = repoWithStubTypescript('cached-once');
    expect((loadTsFrom(dir) as unknown as { __stubMarker: string }).__stubMarker).toBe('cached-once');
    // Make the directory unresolvable. A cached parser is returned anyway; an
    // uncached implementation would fall back to the real typescript, which
    // carries no marker. (This asserts the cache, not merely determinism.)
    SafeFsExecutor.safeRmSync(path.join(dir, 'node_modules'), {
      recursive: true,
      force: true,
      operation: 'test: prove loadTsFrom caches rather than re-resolving',
    });
    expect((loadTsFrom(dir) as unknown as { __stubMarker?: string }).__stubMarker).toBe('cached-once');
  });

  it('falls through to the fallback when the repo copy is present but unloadable', () => {
    const dir = emptyRepo();
    const broken = path.join(dir, 'node_modules', 'typescript');
    fs.mkdirSync(broken, { recursive: true });
    fs.writeFileSync(path.join(broken, 'package.json'), JSON.stringify({ name: 'typescript', main: 'missing.js' }));
    // A broken copy must not shadow a working one: the repo attempt throws and
    // the module's own resolution answers. (The both-missing case throws by
    // construction — the loop re-raises the last error — and is unreachable
    // inside a source checkout, which is where this suite runs.)
    const mod = loadTsFrom(dir) as unknown as { createSourceFile?: unknown };
    expect(typeof mod.createSourceFile).toBe('function');
  });
});

describe('evaluateSkipRatchet with an injected parser', () => {
  it('uses the injected module rather than resolving one', () => {
    const real = loadTsFrom();
    const r = evaluateSkipRatchet(
      [{ path: 'tests/unit/a.test.ts', base: `import { it } from 'vitest'; it('a', () => {});`, head: `import { it } from 'vitest'; it.skip('a', () => {});` }],
      real,
    );
    expect(r.skipsAdded).toBe(true);
  });
});
