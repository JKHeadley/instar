import { describe, it, expect } from 'vitest';
import { validateDesignCoverage } from '../../src/designGate/coverage.js';
import type { DesignRule } from '../../src/designGate/standardParser.js';
const rules = [{ id: 'DS-A11Y-1', checkKind: 'machine', surfaces: ['Web', 'Mac'] }] as DesignRule[];
const staged = (surface: string) => ({ ruleId: 'DS-A11Y-1', surface, kind: 'staged', trackedBy: 'CMT-2169', reason: 'Native/render checker is not implemented.' });
const checks = [{ id: 'web-accessibility', ruleIds: ['DS-A11Y-1'], surfaces: ['Web'] }] as const;
describe('design coverage is a complete capability map, never a pass result', () => {
  it('requires one explicit row for every applicable rule and surface', () => {
    expect(validateDesignCoverage({ version: 1, rows: [staged('Web'), staged('Mac')] }, rules, checks)).toEqual([]);
    expect(validateDesignCoverage({ version: 1, rows: [staged('Web')] }, rules, checks)).toContainEqual({ code: 'coverage-missing', ruleId: 'DS-A11Y-1', surface: 'Mac' });
  });
  it('refuses a duplicate or an inapplicable rule/surface pair', () => {
    const errors = validateDesignCoverage({ version: 1, rows: [staged('Web'), staged('Web'), staged('Mac'), staged('Android')] }, rules, checks);
    expect(errors.some(e => e.code === 'coverage-duplicate')).toBe(true);
    expect(errors.some(e => e.code === 'coverage-inapplicable')).toBe(true);
  });
  it('requires a tracked carrier and a reason for an unimplemented check', () => {
    expect(validateDesignCoverage({ version: 1, rows: [{ ...staged('Web'), trackedBy: '' }, { ...staged('Mac'), reason: '' }] }, rules, checks).map(e => e.code)).toEqual(['coverage-untracked', 'coverage-reason-missing']);
  });
  it('accepts a real checker only on the rules and surfaces its implementation declares', () => {
    expect(validateDesignCoverage({ version: 1, rows: [{ ruleId: 'DS-A11Y-1', surface: 'Web', kind: 'check', checker: 'web-accessibility' }, staged('Mac')] }, rules, checks)).toEqual([]);
    expect(validateDesignCoverage({ version: 1, rows: [staged('Web'), { ruleId: 'DS-A11Y-1', surface: 'Mac', kind: 'check', checker: 'web-accessibility' }] }, rules, checks).some(e => e.code === 'coverage-check-mismatch')).toBe(true);
    expect(validateDesignCoverage({ version: 1, rows: [{ ruleId: 'DS-A11Y-1', surface: 'Web', kind: 'check', checker: 'imaginary' }, staged('Mac')] }, rules, checks).some(e => e.code === 'coverage-check-unknown')).toBe(true);
  });
  it('requires review rules to declare their evidence kind, including staged review coverage', () => {
    const reviewRules = [{ ...rules[0], checkKind: 'review' as const }];
    expect(validateDesignCoverage({ version: 1, rows: [staged('Web'), staged('Mac')] }, reviewRules, checks).filter(e => e.code === 'coverage-evidence-kind-missing')).toHaveLength(2);
    expect(validateDesignCoverage({ version: 1, rows: [{ ...staged('Web'), evidenceKind: 'paired-captures' }, { ...staged('Mac'), evidenceKind: 'interaction-trace' }] }, reviewRules, checks)).toEqual([]);
  });
  it('does not turn malformed or unreadable policy into an empty green map', () => {
    expect(validateDesignCoverage(null, rules, checks)).toEqual([{ code: 'coverage-invalid' }]);
    expect(validateDesignCoverage({ version: 1, rows: [] }, rules, checks)).toHaveLength(2);
    expect(validateDesignCoverage({ version: 1, rows: [{ ...staged('Web'), checker: 'web-accessibility' }, staged('Mac')] }, rules, checks).some(e => e.code === 'coverage-ambiguous')).toBe(true);
  });
});
