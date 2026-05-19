import { describe, it, expect } from 'vitest';
import { getParityRule, listParityRules } from '../../../../src/providers/parity/registry.js';
import { skillParityRule } from '../../../../src/providers/parity/rules/skillParityRule.js';
import { hookParityRule } from '../../../../src/providers/parity/rules/hookParityRule.js';

describe('ParityRegistry', () => {
  it('exposes the skill parity rule', () => {
    expect(getParityRule('skill')).toBe(skillParityRule);
  });

  it('exposes the hook parity rule', () => {
    expect(getParityRule('hook')).toBe(hookParityRule);
  });

  it('returns undefined for unregistered primitives', () => {
    expect(getParityRule('agent')).toBeUndefined();
    expect(getParityRule('memory')).toBeUndefined();
    expect(getParityRule('tool')).toBeUndefined();
  });

  it('listParityRules includes both registered rules', () => {
    const rules = listParityRules();
    const primitives = rules.map((r) => r.primitive).sort();
    expect(primitives).toEqual(['hook', 'skill']);
  });
});
