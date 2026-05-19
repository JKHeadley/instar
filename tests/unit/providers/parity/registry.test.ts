import { describe, it, expect } from 'vitest';
import { getParityRule, listParityRules } from '../../../../src/providers/parity/registry.js';
import { skillParityRule } from '../../../../src/providers/parity/rules/skillParityRule.js';

describe('ParityRegistry', () => {
  it('exposes the skill parity rule', () => {
    expect(getParityRule('skill')).toBe(skillParityRule);
  });

  it('returns undefined for unregistered primitives', () => {
    expect(getParityRule('hook')).toBeUndefined();
    expect(getParityRule('agent')).toBeUndefined();
    expect(getParityRule('memory')).toBeUndefined();
  });

  it('listParityRules includes the skill rule', () => {
    const rules = listParityRules();
    expect(rules).toHaveLength(1);
    expect(rules[0].primitive).toBe('skill');
  });
});
