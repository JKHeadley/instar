import fs from 'node:fs';
import { parseDesignStandard } from '../../src/designGate/standardParser.js';
import { describe, it, expect } from 'vitest';
import { validateDesignRuleIds } from '../../src/designGate/ruleIds.js';
const lock = (...ids: string[]) => ({ version: 1, ids });
const rules = [{ id: 'DS-A11Y-1' }];
describe('permanent design rule issuance', () => {
  it('records every actual approved rule in the repository issuance history', () => {
    const parsed = parseDesignStandard(fs.readFileSync('docs/DESIGN-STANDARD.md', 'utf8'));
    expect(parsed.errors).toEqual([]);
    const issued = JSON.parse(fs.readFileSync('docs/design/rule-ids.lock.json', 'utf8'));
    expect(validateDesignRuleIds({ lock: issued, rules: parsed.rules })).toEqual([]);
  });
  it('keeps retired identifiers issued while allowing new issuance', () => {
    expect(validateDesignRuleIds({ lock: lock('DS-A11Y-1', 'DS-DATA-1', 'DS-LAYOUT-2'), rules,
      baseLock: lock('DS-A11Y-1', 'DS-DATA-1') })).toEqual([]);
  });
  it('refuses erasing an identifier even when its rule is no longer active', () => {
    expect(validateDesignRuleIds({ lock: lock('DS-A11Y-1'), rules,
      baseLock: lock('DS-A11Y-1', 'DS-DATA-1') })).toContainEqual({ code: 'rule-id-history-removed', ruleId: 'DS-DATA-1' });
  });
  it('requires active identifiers to be issued exactly once', () => {
    expect(validateDesignRuleIds({ lock: lock('DS-DATA-1', 'DS-DATA-1'), rules })).toEqual([
      { code: 'rule-id-lock-duplicate', ruleId: 'DS-DATA-1' }, { code: 'rule-id-unissued', ruleId: 'DS-A11Y-1' },
    ]);
  });
  it('refuses unreadable base policy rather than silently treating it as no history', () => {
    expect(validateDesignRuleIds({ lock: lock('DS-A11Y-1'), rules, baseLock: null })).toEqual([{ code: 'base-rule-id-lock-invalid' }]);
    expect(validateDesignRuleIds({ lock: lock('DS-A11Y-1'), rules,
      baseLock: lock('DS-A11Y-1', 'DS-A11Y-1') })).toEqual([{ code: 'base-rule-id-lock-invalid' }]);
    expect(validateDesignRuleIds({ lock: null, rules })).toEqual([{ code: 'rule-id-lock-invalid' }]);
    expect(validateDesignRuleIds({ lock: lock('DS-A11Y-X'), rules })).toEqual([{ code: 'rule-id-lock-invalid' }]);
  });
});
