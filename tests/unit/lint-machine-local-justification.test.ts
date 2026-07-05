// Self-test for the Standard-A deterministic marker floor
// (scripts/lint-machine-local-justification.js), the no-LLM parser that grades
// the `machine-local-justification: <taxonomy-key>` marker per
// docs/specs/three-standards-enforcement.md §178-202. It must:
//   - PASS a well-defended machine-local surface (valid taxonomy key in the
//     `## Multi-machine posture` section),
//   - PASS an operator-ratified-exception that cites a resolvable ref,
//   - FAIL (strict) an undefended machine-local assertion (rule A1),
//   - FAIL (strict) the reverse direction — a spurious/malformed marker: an
//     out-of-taxonomy key and an operator-ratified-exception with no ref (rule A2),
//   - ship REPORT-FIRST: a finding is a non-blocking signal (exit 0) unless
//     --strict is passed.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..');
const LINT = path.join(REPO_ROOT, 'scripts', 'lint-machine-local-justification.js');
const FIX = path.join(REPO_ROOT, 'tests', 'fixtures', 'spec-lint');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runLint(...args: string[]): RunResult {
  // spawnSync captures BOTH streams regardless of exit code — needed to inspect
  // the report-mode (exit 0) findings that print to stderr.
  const r = spawnSync('node', [LINT, ...args], { encoding: 'utf8' });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const fx = (name: string) => path.join(FIX, name);

describe('lint-machine-local-justification (Standard A marker floor)', () => {
  // ── Positive cases ──
  it('PASSES a defended machine-local surface with a valid taxonomy key', () => {
    const r = runLint('--strict', fx('A-good-defended.md'));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('clean');
  });

  it('PASSES an operator-ratified-exception that cites a resolvable ref', () => {
    const r = runLint('--strict', fx('A-good-ratified.md'));
    expect(r.code).toBe(0);
  });

  // ── Negative case (rule A1 — undefended machine-local) ──
  it('FAILS (strict) an undefended machine-local assertion', () => {
    const r = runLint('--strict', fx('A-bad-undefended.md'));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('A1-undefended-machine-local');
  });

  // ── Bidirectional case (rule A2 — the reverse direction, a spurious marker) ──
  it('FAILS (strict) a spurious marker whose key is outside the closed taxonomy', () => {
    const r = runLint('--strict', fx('A-bad-spurious-key.md'));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('A2-invalid-taxonomy-key');
  });

  it('FAILS (strict) an operator-ratified-exception with no machine-verifiable ref', () => {
    const r = runLint('--strict', fx('A-bad-ratified-noref.md'));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('A2-unresolvable-ratification-ref');
  });

  // ── Report-first rollout mode ──
  it('is REPORT-FIRST: a finding is a non-blocking signal (exit 0) without --strict', () => {
    const r = runLint(fx('A-bad-undefended.md'));
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('A1-undefended-machine-local');
  });

  // ── JSON surface (deterministic, machine-readable) ──
  it('emits deterministic JSON findings under --json', () => {
    const r = runLint('--json', fx('A-bad-spurious-key.md'));
    const parsed = JSON.parse(r.stdout) as { findings: Array<{ rule: string }> };
    expect(parsed.findings.some((f) => f.rule === 'A2-invalid-taxonomy-key')).toBe(true);
  });
});
