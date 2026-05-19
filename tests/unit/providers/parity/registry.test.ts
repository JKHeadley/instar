import { describe, it, expect } from 'vitest';
import { getParityRule, listParityRules } from '../../../../src/providers/parity/registry.js';
import { skillParityRule } from '../../../../src/providers/parity/rules/skillParityRule.js';
import { hookParityRule } from '../../../../src/providers/parity/rules/hookParityRule.js';
import { memoryParityRule } from '../../../../src/providers/parity/rules/memoryParityRule.js';

describe('ParityRegistry', () => {
  it('exposes the skill parity rule', () => {
    expect(getParityRule('skill')).toBe(skillParityRule);
  });

  it('exposes the hook parity rule', () => {
    expect(getParityRule('hook')).toBe(hookParityRule);
  });

  it('exposes the memory parity rule', () => {
    expect(getParityRule('memory')).toBe(memoryParityRule);
  });

  it('returns undefined for unregistered primitives', () => {
    expect(getParityRule('agent')).toBeUndefined();
    expect(getParityRule('tool')).toBeUndefined();
    expect(getParityRule('instruction-file')).toBeUndefined();
  });

  it('listParityRules includes all registered rules', () => {
    const rules = listParityRules();
    const primitives = rules.map((r) => r.primitive).sort();
    expect(primitives).toEqual(['hook', 'memory', 'skill']);
  });
});
