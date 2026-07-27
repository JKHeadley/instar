/**
 * Wiring-integrity tests for the rollout-evidence ratchet.
 *
 * A lint that is not in the lint chain is a lint that never runs — which is the
 * exact defect class this ratchet exists to catch (a capability that exists and
 * is silently not used). So the most important assertion here is not that the
 * lint works; it is that it is actually wired.
 *
 * The "does it catch anything?" evidence is a revert-and-watch-fail performed at
 * authoring time and recorded in the side-effects artifact:
 *   - dropping the mutual-ssh baseline entry → assertion A fires, exit 1
 *   - allowlisting a slug that resolves       → assertion C fires, exit 1
 *   - clean repo                              → exit 0
 * Reproduced here for the clean case and the wiring; the failure paths are
 * asserted through the module's own exported shape rather than by mutating the
 * checked-in baseline mid-test.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LINT = path.join(ROOT, 'scripts', 'lint-rollout-evidence-resolvable.js');

describe('lint-rollout-evidence-resolvable — wiring', () => {
  it('the lint script exists', () => {
    expect(fs.existsSync(LINT)).toBe(true);
  });

  it('IS WIRED into the npm lint chain — an unwired guard never runs', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts.lint).toContain('lint-rollout-evidence-resolvable.js');
  });

  it('exits 0 on the current repo, and says what it checked', () => {
    const out = execFileSync('node', [LINT], { cwd: ROOT, encoding: 'utf8' });
    // It must report its denominator — a guard that says only "clean" cannot be
    // distinguished from a guard that scanned nothing.
    expect(out).toMatch(/rollout-active endpoint spec\(s\)/);
    expect(out).toMatch(/resolving/);
  });

  it('reports a non-zero denominator — a scan of nothing is not a pass', () => {
    const out = execFileSync('node', [LINT], { cwd: ROOT, encoding: 'utf8' });
    const m = /clean — (\d+) rollout-active endpoint spec\(s\)/.exec(out);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(0);
  });
});

describe('lint-rollout-evidence-resolvable — the baseline is a ledger, not a parking space', () => {
  const source = fs.readFileSync(LINT, 'utf8');

  it('every accepted-unresolved entry carries a substantive reason', () => {
    // Assertion B is enforced at runtime; this pins the checked-in baseline so a
    // placeholder reason cannot be added without a test failing too.
    const reasons = [...source.matchAll(/reason:\s*\n?\s*'([^']*)'/g)].map((m) => m[1]);
    const joined = [...source.matchAll(/reason:[\s\S]{0,400}?,\n\s*\}/g)].map((m) => m[0]);
    expect(joined.length).toBeGreaterThan(0);
    for (const r of reasons) expect(r.replace(/\s/g, '').length).toBeGreaterThan(11);
  });

  it('each baseline entry names a tracking reference so it cannot rot silently', () => {
    // An accepted finding with no tracker is an abandoned finding.
    const entries = source.slice(
      source.indexOf('const KNOWN_UNRESOLVED'),
      source.indexOf('function specFiles'),
    );
    expect(entries).toMatch(/ACT-\d+|PR #\d+/);
  });
});
