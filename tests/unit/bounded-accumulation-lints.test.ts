// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * Bounded Accumulation §3b/§3c — the two enforcement lints (Lint 1 + Lint 2).
 * Both sides of each decision boundary, run as the real CLI (exit codes are the
 * contract CI depends on).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LINT1 = path.join(ROOT, 'scripts', 'lint-store-retention-declared.js');
const LINT2 = path.join(ROOT, 'scripts', 'lint-no-wholefile-sync-read.js');
const REAL_REGISTRY = path.join(ROOT, 'src', 'data', 'state-coherence-registry.json');
const REAL_BASE1 = path.join(ROOT, 'scripts', 'bounded-accumulation-retention-baseline.json');
const REAL_BASE2 = path.join(ROOT, 'scripts', 'bounded-accumulation-wholefile-read-baseline.json');

function exit(cmd: string[]): number {
  try {
    execFileSync('node', cmd, { cwd: ROOT, stdio: 'pipe' });
    return 0;
  } catch (e: any) {
    return e.status ?? 1;
  }
}

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba-lint-')); });
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('Lint 1 — store-retention-declared (ratchet)', () => {
  it('PASSES on the real registry (every store retentioned or grandfathered)', () => {
    expect(exit([LINT1, '--registry', REAL_REGISTRY, '--baseline', REAL_BASE1])).toBe(0);
  });

  it('FAILS when a NEW un-retentioned store is added (not in the baseline)', () => {
    const reg = JSON.parse(fs.readFileSync(REAL_REGISTRY, 'utf8'));
    reg.entries.push({ category: 'brand-new-unbounded', scope: 'machine-local', conflictShape: 'append-only', paths: ['state/new.jsonl'] });
    const f = path.join(dir, 'reg.json');
    fs.writeFileSync(f, JSON.stringify(reg));
    expect(exit([LINT1, '--registry', f, '--baseline', REAL_BASE1])).toBe(1);
  });

  it('PASSES when the new store is added WITH a retention policy', () => {
    const reg = JSON.parse(fs.readFileSync(REAL_REGISTRY, 'utf8'));
    reg.entries.push({ category: 'brand-new-bounded', scope: 'machine-local', conflictShape: 'append-only', paths: ['state/new2.jsonl'], retention: { class: 'A', access: 'streamed', maxBytes: 1000, keepSegments: 2 } });
    const f = path.join(dir, 'reg.json');
    fs.writeFileSync(f, JSON.stringify(reg));
    expect(exit([LINT1, '--registry', f, '--baseline', REAL_BASE1])).toBe(0);
  });

  it('FAILS when the frozen baseline GREW past its frozen count (D6 set-monotonicity)', () => {
    const base = JSON.parse(fs.readFileSync(REAL_BASE1, 'utf8'));
    base.categories.push('sneaky-1', 'sneaky-2', 'sneaky-3');
    const f = path.join(dir, 'base.json');
    fs.writeFileSync(f, JSON.stringify(base));
    expect(exit([LINT1, '--registry', REAL_REGISTRY, '--baseline', f])).toBe(1);
  });
});

describe('Lint 2 — no-wholefile-sync-read (forward guardrail)', () => {
  it('PASSES on the real tree (clean baseline)', () => {
    expect(exit([LINT2, '--registry', REAL_REGISTRY, '--baseline', REAL_BASE2])).toBe(0);
  });

  it('FAILS on a NEW literal whole-file sync read of a streamed store', () => {
    // A fixture src dir with the forbidden pattern referencing a streamed-store basename.
    const srcDir = path.join(dir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, 'Offender.ts'),
      [
        'import fs from "node:fs";',
        'export function load() {',
        '  return JSON.parse(fs.readFileSync("state/job-runs.jsonl", "utf8"));',
        '}',
      ].join('\n'),
    );
    const emptyBase = path.join(dir, 'empty-base.json');
    fs.writeFileSync(emptyBase, JSON.stringify({ violations: [] }));
    expect(exit([LINT2, '--registry', REAL_REGISTRY, '--baseline', emptyBase, '--root', srcDir])).toBe(1);
  });

  it('PASSES the same fixture when the hit is in the baseline (grandfathered)', () => {
    const srcDir = path.join(dir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    const offender = path.join(srcDir, 'Offender.ts');
    fs.writeFileSync(
      offender,
      'import fs from "node:fs";\nexport const x = JSON.parse(fs.readFileSync("state/job-runs.jsonl", "utf8"));\n',
    );
    // The lint records path.relative(ROOT, file) — compute the exact key it will use.
    const relPath = path.relative(ROOT, offender);
    const base = path.join(dir, 'base.json');
    fs.writeFileSync(base, JSON.stringify({ violations: [{ file: relPath, basename: 'job-runs.jsonl' }] }));
    expect(exit([LINT2, '--registry', REAL_REGISTRY, '--baseline', base, '--root', srcDir])).toBe(0);
  });
});
