// safe-git-allow: test file — fs.rmSync is per-test tmpdir cleanup; no git used here.
/**
 * Tier 1 (unit) tests for the Tier-3 CI ratchet script (scripts/standards-coverage.mjs),
 * cartographer-conformance-audit spec #3 Part E. Runs the REAL script against a temp
 * fixture registry + repo, asserting: a healthy fixture passes; an enforced-ratio
 * floor regression fails; a synthetic dangling ref fails the ZERO ceiling; the floor
 * is the (env-overridable) committed constant; and the output file is written but is
 * never the read baseline.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '../../scripts/standards-coverage.mjs');

let repo: string;

function write(rel: string, content: string): void {
  const full = path.join(repo, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'std-ratchet-'));
  // A repo whose ONLY standard is guarded by a real ratchet test on disk → ratio 1,
  // zero dangling. src/ present so resolveRoot picks the repo.
  write('src/server/routes.ts', "router.get('/x', (req,res)=>{});\n");
  write('tests/unit/widget.test.ts', '// ratchet\n');
  write('docs/STANDARDS-REGISTRY.md', [
    '## Building',
    '',
    '### Guarded',
    '**Rule.** r.',
    '**Applied through.** Enforced by `tests/unit/widget.test.ts`.',
    '',
  ].join('\n'));
});
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

function runCheck(env: Record<string, string> = {}): { code: number; out: string } {
  try {
    const out = execFileSync('node', [SCRIPT, '--check'], {
      cwd: repo, encoding: 'utf8',
      env: { ...process.env, STANDARDS_COVERAGE_ROOT: repo, ...env },
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stderr?: string; stdout?: string };
    return { code: err.status ?? 1, out: `${err.stderr ?? ''}${err.stdout ?? ''}` };
  }
}

describe('standards-coverage ratchet script', () => {
  it('passes on a fully-guarded fixture with the default floors', () => {
    expect(runCheck().code).toBe(0);
  });

  it('passes a high enforced-ratio floor when every standard is guarded', () => {
    expect(runCheck({ STANDARDS_ENFORCED_RATIO_FLOOR: '1' }).code).toBe(0);
  });

  it('FAILS the enforced-ratio floor on a regression (an unguarded standard added)', () => {
    fs.appendFileSync(
      path.join(repo, 'docs', 'STANDARDS-REGISTRY.md'),
      '\n### Unguarded\n**Rule.** r.\n**In practice.** just remember it.\n',
    );
    const r = runCheck({ STANDARDS_ENFORCED_RATIO_FLOOR: '1' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('enforced ratio');
  });

  it('FAILS the ZERO dangling ceiling when a standard cites a guard not on disk', () => {
    fs.appendFileSync(
      path.join(repo, 'docs', 'STANDARDS-REGISTRY.md'),
      '\n### Broken\n**Rule.** r.\n**Applied through.** Enforced by `tests/unit/removed.test.ts`.\n',
    );
    const r = runCheck(); // default dangling ceiling is 0
    expect(r.code).toBe(1);
    expect(r.out).toContain('dangling refs');
    expect(r.out).toContain('removed.test.ts');
  });

  it('writes the output file but it is NOT the read baseline (the floor is the committed constant)', () => {
    runCheck();
    const outPath = path.join(repo, '.instar', 'standards-coverage.json');
    expect(fs.existsSync(outPath)).toBe(true);
    const report = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
    // The output records the floors but they come from the script constant/env, never
    // from a previously-written output file — corrupting the output cannot lower the bar.
    expect(report.floors.danglingCeiling).toBe(0);
    fs.writeFileSync(outPath, JSON.stringify({ enforcedRatio: -999, danglingCount: 999, floors: { enforcedRatio: -1, danglingCeiling: 999 } }));
    // The next check ignores the poisoned output entirely and still passes on the real state.
    expect(runCheck().code).toBe(0);
  });

  it('fails OPEN (vacuous pass) when the registry is absent', () => {
    fs.rmSync(path.join(repo, 'docs', 'STANDARDS-REGISTRY.md'));
    const r = runCheck({ STANDARDS_ENFORCED_RATIO_FLOOR: '1' });
    expect(r.code).toBe(0);
  });
});
