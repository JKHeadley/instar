/**
 * Conformance grade-flip verification (audit-convergence-enforcement §4).
 * Before this spec, the "Iterative Audit to Convergence" standard's prose named
 * no citation the StandardsEnforcementAuditor could resolve → it graded
 * `documented-only` (zero guards). The registry edit adds an `**Applied through.**`
 * line citing the precommit gate + the CI ratchet test. This test proves those
 * citations resolve AND classify to a real guard (ratchet, the strongest here) —
 * i.e. the standard is now structurally enforced, not merely documented.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadStandardsRegistry } from '../../src/core/StandardsRegistryParser.js';
import { extractEnforcementRefs } from '../../src/core/StandardEnforcementExtractor.js';
import { classifyFileGuard } from '../../src/core/StandardsEnforcementAuditor.js';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

describe('Iterative Audit to Convergence — conformance grade-flip', () => {
  const articles = loadStandardsRegistry(path.join(ROOT, 'docs', 'STANDARDS-REGISTRY.md'));
  const article = articles.find((a) => /Iterative Audit to Convergence/i.test(a.name));

  it('the standard exists and now carries an Applied-through enforcement line', () => {
    expect(article, 'standard not found in registry').toBeTruthy();
    expect(article!.appliedThrough ?? '', 'no Applied-through line').toMatch(/write-audit-convergence|instar-dev-precommit|audit-convergence-reports/);
  });

  it('its citations resolve to the precommit gate + the CI ratchet test', () => {
    const refs = extractEnforcementRefs(article!);
    expect(refs.files, 'precommit gate not cited').toContain('scripts/instar-dev-precommit.js');
    expect(refs.files, 'CI ratchet test not cited').toContain('tests/unit/audit-convergence-reports.test.ts');
  });

  it('classifies to a real guard — the ratchet test grades ratchet, the precommit grades gate', () => {
    expect(classifyFileGuard('tests/unit/audit-convergence-reports.test.ts')).toBe('ratchet');
    expect(classifyFileGuard('scripts/instar-dev-precommit.js')).toBe('gate');
    // strongest-guard wins → the standard is no longer `documented-only`.
    const strengths = ['tests/unit/audit-convergence-reports.test.ts', 'scripts/instar-dev-precommit.js'].map(classifyFileGuard);
    expect(strengths).toContain('ratchet');
  });
});
