// safe-git-allow: test file — fs.rmSync is per-test tmpdir cleanup; execFile runs the lint under test.
/**
 * Tier 1 — the lint that pins the un-awaited-Awaitable defect class must itself
 * discriminate.
 *
 * WHY THIS EXISTS. A lint that never fires is indistinguishable from a clean
 * repo, and this branch has already produced two "fixes" whose tests passed both
 * before and after the fix. So the lint gets the same treatment it enforces:
 * fixtures that MUST trip it, fixtures that MUST NOT, and the historical defect
 * verbatim as the anchor case. Without these, `lint: clean` is an unfalsifiable
 * claim.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LINT = path.join(ROOT, 'scripts', 'lint-no-unawaited-awaitable-test.js');

let dir: string;
beforeAll(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lint-awaitable-'))); });
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

/** Run the lint over one fixture; returns its exit code + combined output. */
function runLint(source: string, name: string): { code: number; out: string } {
  const file = path.join(dir, `${name}.ts`);
  fs.writeFileSync(file, source);
  try {
    const out = execFileSync('node', [LINT, file], { cwd: ROOT, encoding: 'utf-8', stdio: 'pipe' });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const PREAMBLE = `
export type Awaitable<T> = T | Promise<T>;
interface Deps {
  isInUse: (p: string) => Awaitable<boolean>;
  isClean: (p: string) => Awaitable<boolean>;
  hasMarker?: (p: string) => Awaitable<boolean>;
}
declare const deps: Deps;
`;

describe('lint-no-unawaited-awaitable-test', () => {
  it('FIRES on the historical defect: an Awaitable signal tested truthily', () => {
    // The permanently-TRUE half: a pending promise is always truthy, so this gate
    // refused every delete and made the reaper silently inert.
    const r = runLint(`${PREAMBLE}
export async function f(p: string): Promise<boolean> {
  if (deps.isInUse(p)) return true;
  return false;
}`, 'truthy');
    expect(r.code).toBe(1);
    expect(r.out).toContain('isInUse');
  });

  it('FIRES on the dangerous half: an Awaitable signal tested with negation', () => {
    // The permanently-FALSE half: `!promise` is always false, so the gate that
    // protects UNCOMMITTED WORK always passed. This is the delete-anyway shape.
    const r = runLint(`${PREAMBLE}
export async function f(p: string): Promise<boolean> {
  if (!deps.isClean(p)) return true;
  return false;
}`, 'negated');
    expect(r.code).toBe(1);
    expect(r.out).toContain('isClean');
  });

  it('is CLEAN on the awaited forms — both `await x()` and `!(await x())`', () => {
    const r = runLint(`${PREAMBLE}
export async function f(p: string): Promise<string> {
  if (await deps.isInUse(p)) return 'in-use';
  if (!(await deps.isClean(p))) return 'dirty';
  const v = await deps.isClean(p);
  if (!v) return 'dirty-via-binding';
  return 'ok';
}`, 'awaited');
    expect(r.code).toBe(0);
  });

  it('is CLEAN when the FUNCTION itself is tested (an optional dep), not a call', () => {
    // The obvious false positive. A lint that flags `if (deps.hasMarker)` gets
    // disabled by the first person it annoys, which protects nothing.
    const r = runLint(`${PREAMBLE}
export async function f(p: string): Promise<boolean> {
  if (deps.hasMarker) return await deps.hasMarker(p);
  return false;
}`, 'optional-dep');
    expect(r.code).toBe(0);
  });

  it('honours the inline justification escape hatch', () => {
    const r = runLint(`${PREAMBLE}
export async function f(p: string): Promise<boolean> {
  // lint-allow-unawaited-awaitable: deliberate and reviewed
  if (deps.isInUse(p)) return true;
  return false;
}`, 'justified');
    expect(r.code).toBe(0);
  });

  it('FIRES on the INLINE-UNION spelling, not just the Awaitable alias', () => {
    // THE PIN THE RE-KEY DID NOT HAVE. Round four widened the matcher because the
    // sibling module spells the same widening as an inline union, and the lint had
    // skipped it entirely. But every fixture here used the alias, so deleting the
    // inline-union regex left this whole suite green — the re-key was itself
    // unpinned, which is verbatim the finding it was fixing.
    const r = runLint(`
interface Deps {
  isInUse: (p: string) => boolean | 'unknown' | Promise<boolean | 'unknown'>;
  hasWork: (p: string) => boolean | Promise<boolean>;
}
declare const deps: Deps;
export async function f(p: string): Promise<boolean> {
  if (!deps.hasWork(p)) return true;
  return false;
}`, 'inline-union');
    expect(r.code).toBe(1);
    expect(r.out).toContain('hasWork');
  });

  it('does NOT register a PARAMETER off a one-line async signature', () => {
    // The round-five integration finding. The matcher is line-scoped, so before the
    // `=>` anchor an inline union PARAMETER was registered whenever the RETURN type
    // was a Promise on the same line — falsely claiming `reason`, `origin`, `tier`
    // and other very common identifiers across 37 files. Nothing fired only because
    // a call in boolean position is also required; the first person to write
    // `if (reason(x))` would have hit a hard failure with the WRONG remedy, and the
    // realistic response is to disable the lint.
    const r = runLint(`
declare function check(x: string): boolean;
export class C {
  private async go(a: string, reason: 'wall-clock' | 'flap'): Promise<void> {
    if (check(reason)) return;
  }
}`, 'param-not-registered');
    expect(r.code).toBe(0);
  });

  it('the repo itself is clean under this lint', () => {
    // The regression guard: if a future change reintroduces the class anywhere in
    // the scanned dirs, this fails in the normal unit run, not only in the lint job.
    const out = execFileSync('node', [LINT], { cwd: ROOT, encoding: 'utf-8', stdio: 'pipe' });
    expect(out).toContain('clean');
  });
});
