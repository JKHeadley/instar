// Self-test for the Standard-B deterministic self-heal field-schema floor
// (scripts/lint-self-heal-fields.js), the no-LLM parser that grades a spec's
// self-heal declaration per docs/specs/three-standards-enforcement.md §256-289,
// §343-361. It must:
//   - PASS a complete self-heal declaration (all P19 brake fields + non-empty
//     remediation-actions + a units-carrying latency + a known severity class),
//   - treat a spec with NO remediation-actions anchor as OUT OF SCOPE (a one-shot
//     reply is not a watcher, §353-355),
//   - FAIL (strict) a declaration missing required brake fields (rule B1),
//   - FAIL (strict) the anti-gaming cases: a no-op remediation list (B2), a
//     unitless max-notification-latency (B3), and an unknown severity class (B4),
//   - ship REPORT-FIRST: a finding is a non-blocking signal (exit 0) unless
//     --strict is passed.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..');
const LINT = path.join(REPO_ROOT, 'scripts', 'lint-self-heal-fields.js');
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

describe('lint-self-heal-fields (Standard B self-heal field floor)', () => {
  // ── Positive case ──
  it('PASSES a complete self-heal declaration', () => {
    const r = runLint('--strict', fx('B-good-complete.md'));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('clean');
  });

  // ── Scope boundary (§353-355) ──
  it('treats a spec with no remediation-actions anchor as OUT OF SCOPE (clean)', () => {
    const r = runLint('--strict', fx('B-out-of-scope.md'));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('clean');
  });

  // ── Negative case (rule B1 — missing required brakes) ──
  it('FAILS (strict) a declaration missing required brake fields', () => {
    const r = runLint('--strict', fx('B-bad-missing-fields.md'));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('B1-missing-field');
    // Names the specific brakes that are absent.
    expect(r.stderr).toContain('breaker');
    expect(r.stderr).toContain('max-notification-latency');
  });

  // ── Anti-gaming cases (rules B2/B3/B4) ──
  it('FAILS (strict) a no-op remediation list, a unitless latency, and an unknown class', () => {
    const r = runLint('--strict', fx('B-bad-noop-and-unitless.md'));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('B2-noop-remediation');
    expect(r.stderr).toContain('B3-latency-unitless');
    expect(r.stderr).toContain('B4-unknown-severity-class');
  });

  // ── Report-first rollout mode ──
  it('is REPORT-FIRST: a finding is a non-blocking signal (exit 0) without --strict', () => {
    const r = runLint(fx('B-bad-missing-fields.md'));
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('B1-missing-field');
  });

  // ── JSON surface ──
  it('emits deterministic JSON findings under --json', () => {
    const r = runLint('--json', fx('B-bad-noop-and-unitless.md'));
    const parsed = JSON.parse(r.stdout) as { findings: Array<{ rule: string }> };
    expect(parsed.findings.some((f) => f.rule === 'B3-latency-unitless')).toBe(true);
  });
});
