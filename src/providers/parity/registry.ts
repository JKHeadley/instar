/**
 * ParityRegistry — registry of all active parity rules.
 *
 * Spec: specs/instar-foundations/framework-functional-parity.md
 *       specs/provider-portability/13-framework-parity-sentinel.md
 *
 * Skill prototype shape (this PR): one rule (skillParityRule). Hook, Agent,
 * Tool, Memory primitives add their rules later. The FrameworkParitySentinel
 * (separate spec) consumes this registry to drive its scan + remediate loop.
 *
 * Registry is a plain in-memory map seeded at boot. No persistence needed —
 * rules are code; registration is declarative.
 */

import type { ParityRule, FunctionalPrimitive } from './types.js';
import { skillParityRule } from './rules/skillParityRule.js';
import { hookParityRule } from './rules/hookParityRule.js';

const RULES: Map<FunctionalPrimitive, ParityRule> = new Map([
  [skillParityRule.primitive, skillParityRule],
  [hookParityRule.primitive, hookParityRule],
]);

export function getParityRule(primitive: FunctionalPrimitive): ParityRule | undefined {
  return RULES.get(primitive);
}

export function listParityRules(): ReadonlyArray<ParityRule> {
  return [...RULES.values()];
}

/**
 * Test-only seam — replace the rule for a primitive (used in unit tests to
 * inject mock rules without rebuilding the import graph).
 * @internal
 */
export function _replaceParityRuleForTest(primitive: FunctionalPrimitive, rule: ParityRule): () => void {
  const prior = RULES.get(primitive);
  RULES.set(primitive, rule);
  return () => {
    if (prior) RULES.set(primitive, prior);
    else RULES.delete(primitive);
  };
}
