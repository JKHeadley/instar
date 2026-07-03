// safe-git-allow: test-tmpdir-cleanup — afterEach removes per-test mkdtempSync tmpdirs.
/**
 * Unit (Tier 1) — the self-contained guard grader (scripts/lib/class-closure-grader.mjs).
 *
 * The spec's G3 rule: a `closure:'guard'` citation that does NOT resolve to a
 * LIVE enforcing guard (ratchet/gate/lint on disk) downgrades the declaration to
 * `gap`. A grader error fails CLOSED (downgrade). Covers BOTH sides:
 *   - a resolving ratchet/gate/lint citation → guard upheld;
 *   - a spec-only path → gap downgrade;
 *   - a non-existent path → gap downgrade;
 *   - a throwing input → gap (fail-closed).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error — .mjs script, no type declarations; runtime import is fine under vitest
import { evaluateGuardClosure } from '../../scripts/lib/class-closure-grader.mjs';

let repo: string;

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-grader-'));
  fs.mkdirSync(path.join(repo, 'tests'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'docs', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'tests', 'sample.test.ts'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(repo, 'src', 'Gate.ts'), 'export function gateFn() { return true; }\n');
  fs.writeFileSync(path.join(repo, 'scripts', 'lint-thing.js'), '// a lint\n');
  fs.writeFileSync(path.join(repo, 'docs', 'specs', 'foo.md'), '# spec\n');
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('evaluateGuardClosure', () => {
  it('upholds guard for a resolving RATCHET citation (a *.test.ts file)', () => {
    const v = evaluateGuardClosure(repo, 'tests/sample.test.ts');
    expect(v.effectiveClosure).toBe('guard');
    expect(v.gradedKind).toBe('ratchet');
    expect(v.resolved).toBe(true);
    expect(v.downgradeReason).toBeNull();
  });

  it('upholds guard for a resolving GATE citation (a src/ file)', () => {
    const v = evaluateGuardClosure(repo, 'src/Gate.ts');
    expect(v.effectiveClosure).toBe('guard');
    expect(v.gradedKind).toBe('gate');
  });

  it('upholds guard for a resolving LINT citation (a scripts/lint-* file)', () => {
    const v = evaluateGuardClosure(repo, 'scripts/lint-thing.js');
    expect(v.effectiveClosure).toBe('guard');
    expect(v.gradedKind).toBe('lint');
  });

  it('downgrades to gap for a spec-only path (docs/specs/*.md guards nothing)', () => {
    const v = evaluateGuardClosure(repo, 'docs/specs/foo.md');
    expect(v.effectiveClosure).toBe('gap');
    expect(v.gradedKind).toBe('spec-only');
    expect(v.resolved).toBe(true); // the file exists…
    expect(v.downgradeReason).toContain('not a live enforcing guard');
  });

  it('downgrades to gap for a non-existent path', () => {
    const v = evaluateGuardClosure(repo, 'scripts/does-not-exist.mjs');
    expect(v.effectiveClosure).toBe('gap');
    expect(v.resolved).toBe(false);
    expect(v.downgradeReason).toContain('does not resolve');
  });

  it('fails CLOSED (gap) on a throwing input', () => {
    // A non-string citation makes the grader's `.trim()` throw — evaluateGuardClosure
    // must catch it and downgrade, never propagate.
    const v = evaluateGuardClosure(repo, {} as unknown as string);
    expect(v.effectiveClosure).toBe('gap');
    expect(v.resolved).toBe(false);
    expect(v.downgradeReason).toContain('grader error (fail-closed)');
  });
});
