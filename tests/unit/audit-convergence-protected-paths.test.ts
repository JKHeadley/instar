/**
 * Arm-time auto-merge protection for audit-report PRs (audit-convergence-enforcement
 * §3, the DETERMINISTIC arm-time layer). A PR touching docs/audits/ — or the
 * validator's own enforcing machinery — must be excluded from green-PR auto-merge
 * so it gets a human eye (the ADV-3 shape≠depth mitigation) and so the validator
 * can't be neutered by an auto-merged PR (adversarial-R4 finding-2).
 *
 * NOTE: this covers the ARM-TIME (PR-opened-with-the-report) common case. The
 * adversarial arm-then-push TOCTOU hardening (gather() re-check + re-adoption)
 * ships as tracked follow-up ACT-1192.
 */
import { describe, it, expect } from 'vitest';
import { diffTouchesProtected, PROTECTED_PATH_PREFIXES } from '../../src/monitoring/greenPrAutomergeWiring.js';

describe('audit-convergence arm-time protected paths', () => {
  it('an audit report under docs/audits/ is protected (routes to operator, not auto-merged)', () => {
    expect(diffTouchesProtected(['docs/audits/silent-catch-fallbacks.md'])).toBe(true);
    expect(diffTouchesProtected(['docs/audits/2026/nested-report.md'])).toBe(true);
  });

  it("the validator's own enforcing machinery is protected", () => {
    expect(diffTouchesProtected(['scripts/write-audit-convergence.mjs'])).toBe(true);
    expect(diffTouchesProtected(['scripts/audit-secret-patterns.mjs'])).toBe(true);
    expect(diffTouchesProtected(['tests/unit/audit-convergence-reports.test.ts'])).toBe(true);
  });

  it('an unrelated PR is NOT falsely protected', () => {
    expect(diffTouchesProtected(['src/core/SomethingElse.ts', 'README.md'])).toBe(false);
  });

  it('the protected set retains its prior members (extend, never shrink)', () => {
    for (const p of ['.github/', 'scripts/safe-merge.mjs', 'src/monitoring/GreenPrAutoMerger.ts']) {
      expect(PROTECTED_PATH_PREFIXES).toContain(p);
    }
  });
});
