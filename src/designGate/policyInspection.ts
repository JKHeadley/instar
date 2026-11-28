/** Manual tree-only observations. No render, waiver, review or merge authority. */
import { parseDesignStandard } from './standardParser.js';
import { validateDesignRuleIds } from './ruleIds.js';
import { classifyDesignPaths, validateScreenRegistry, type ScreenRegistry } from './surfaceClassifier.js';
import { inspectEarnedRuleChanges } from './earnedRuleChanges.js';
export interface DesignPolicySnapshot { standard: string; lock: unknown; registry: unknown }
export interface InspectionFinding { side: 'base' | 'head' | 'diff'; code: string; ruleId?: string; path?: string; screen?: string; line?: number }
export function inspectDesignPolicy(input: {
  base: DesignPolicySnapshot; head: DesignPolicySnapshot; changedPaths: readonly string[];
  /** Includes both sides for changed source files, so deleted HTML remains visible. */
  sourceText: Readonly<Record<string, string | null>>;
}) {
  const findings: InspectionFinding[] = [];
  const parsed = { base: parseDesignStandard(input.base.standard), head: parseDesignStandard(input.head.standard) };
  for (const side of ['base', 'head'] as const) {
    for (const error of parsed[side].errors) findings.push({ side, code: error.code, ruleId: error.ruleId, line: error.line });
    // An empty document has no individual malformed heading; it is still not a standard.
    if (!parsed[side].rules.length) findings.push({ side, code: 'standard-empty' });
    for (const error of validateScreenRegistry(input[side].registry)) findings.push({ side, ...error });
    for (const error of validateDesignRuleIds({ lock: input[side].lock, rules: parsed[side].rules,
      ...(side === 'head' ? { baseLock: input.base.lock } : {}) })) findings.push({ side, ...error });
  }
  const structurallyValid = findings.length === 0;
  // A rule present at base and absent at head was deleted, or its heading no longer
  // parses as a rule. Earned or not, that is never a clean report.
  const headRuleIds = new Set(parsed.head.rules.map(rule => rule.id));
  for (const rule of parsed.base.rules) if (!headRuleIds.has(rule.id)) findings.push({ side: 'head', code: 'rule-removed', ruleId: rule.id });
  const classification = classifyDesignPaths({ changedPaths: input.changedPaths,
    baseRegistry: input.base.registry as ScreenRegistry, candidateRegistry: input.head.registry as ScreenRegistry,
    sourceText: input.sourceText });
  for (const path of classification.unregistered) findings.push({ side: 'diff', code: 'screen-unregistered', path });
  for (const code of classification.errors) findings.push({ side: 'diff', code });
  // Coverage/modes have their own validators. Empty coverage here explicitly limits
  // this manual slice to rule text/provenance/applicability; it cannot clear modes.
  const earnedRuleChanges = structurallyValid ? inspectEarnedRuleChanges(
    { rules: parsed.base.rules, coverage: [], modes: {} },
    { rules: parsed.head.rules, coverage: [], modes: {} }) : [];
  const status = !structurallyValid ? 'invalid-policy' : findings.length ? 'findings'
    : earnedRuleChanges.length ? 'review-required' : 'structurally-valid';
  return { schemaVersion: 1 as const, scope: 'manual-design-policy' as const, mergeAuthority: false as const, status,
    evaluated: ['standard-structure', 'permanent-rule-history', 'screen-registration', 'earned-rule-text-and-provenance'],
    notEvaluated: ['rendering', 'accessibility', 'coverage-and-modes', 'feedback-entry-lint', 'semantic-wording-review', 'owner-waivers', 'merge-enforcement'],
    findings, earnedRuleChanges, classification,
    counts: { baseRules: parsed.base.rules.length, headRules: parsed.head.rules.length } };
}
