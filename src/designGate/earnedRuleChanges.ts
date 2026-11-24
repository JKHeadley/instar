/** Signal producer for design-standard-enforcement section 5, never a wording or waiver authority. */
import type { DesignRule, DesignSurface } from './standardParser.js';
import type { DesignMode } from './modes.js';
export interface EarnedCoverageRow {
  readonly ruleId: string; readonly surface: DesignSurface; readonly kind: 'check' | 'staged'; readonly checker?: string;
}
export interface EarnedRulePolicy {
  readonly rules: readonly DesignRule[];
  readonly coverage: readonly EarnedCoverageRow[];
  readonly modes: Readonly<Record<string, DesignMode>>;
}
export type EarnedRuleChange =
  | { ruleId: string; kind: 'retired' | 'machine-to-review' }
  | { ruleId: string; kind: 'surface-removed'; surface: DesignSurface }
  | { ruleId: string; kind: 'provenance-removed'; entryId: string }
  | { ruleId: string; kind: 'wording-review'; field: 'rule' | 'check' | 'measurement' | 'surfaceText'; before: string | null; after: string | null }
  | { ruleId: string; kind: 'coverage-staged'; surface: DesignSurface; checker: string }
  | { ruleId: string; kind: 'mode-report'; surface: DesignSurface; beforeChecker: string; afterChecker: string };
const key = (row: EarnedCoverageRow) => `${row.ruleId}:${row.surface}`;
function coverageIndex(policy: EarnedRulePolicy): Map<string, EarnedCoverageRow> {
  const index = new Map<string, EarnedCoverageRow>();
  for (const row of policy.coverage) {
    if (!row || index.has(key(row)) || !['check', 'staged'].includes(row.kind)
      || row.kind === 'check' && (!row.checker || !['block', 'report'].includes(policy.modes[row.checker]))) throw new Error('Unvalidated earned-rule coverage or modes');
    index.set(key(row), row);
  }
  return index;
}
/**
 * Takes structurally linted BASE and HEAD policy snapshots, including BASE provenance.
 * This comparison does not certify complete coverage, validate a changelog/card or approve a reduction.
 * Every textual change retains both exact wordings for the required independent semantic review;
 * even an apparently harmless edit cannot be silently classified as permission to loosen a rule.
 */
export function inspectEarnedRuleChanges(base: EarnedRulePolicy, head: EarnedRulePolicy): EarnedRuleChange[] {
  for (const policy of [base, head]) {
    const seen = new Set<string>();
    for (const rule of policy.rules) {
      if (!rule || seen.has(rule.id) || !['machine', 'review'].includes(rule.checkKind ?? '')) throw new Error('Unvalidated earned-rule definitions');
      seen.add(rule.id);
    }
  }
  const baseCoverage = coverageIndex(base), headCoverage = coverageIndex(head);
  const nextRules = new Map(head.rules.map(rule => [rule.id, rule]));
  const changes: EarnedRuleChange[] = [];
  for (const before of base.rules) {
    if (!before.earnedFrom.length) continue;
    const after = nextRules.get(before.id), ruleId = before.id;
    if (!after) { changes.push({ ruleId, kind: 'retired' }); continue; }
    for (const entryId of before.earnedFrom) if (!after.earnedFrom.includes(entryId)) changes.push({ ruleId, kind: 'provenance-removed', entryId });
    for (const surface of before.surfaces) if (!after.surfaces.includes(surface)) changes.push({ ruleId, kind: 'surface-removed', surface });
    if (before.checkKind === 'machine' && after.checkKind === 'review') changes.push({ ruleId, kind: 'machine-to-review' });
    for (const field of ['rule', 'check', 'measurement', 'surfaceText'] as const) {
      if (before[field] !== after[field]) changes.push({ ruleId, kind: 'wording-review', field, before: before[field], after: after[field] });
    }
    for (const surface of before.surfaces) {
      const oldRow = baseCoverage.get(`${ruleId}:${surface}`), newRow = headCoverage.get(`${ruleId}:${surface}`);
      if (oldRow?.kind !== 'check' || !newRow) continue; // Missing rows fail the separate structural coverage lint.
      if (newRow.kind === 'staged') changes.push({ ruleId, kind: 'coverage-staged', surface, checker: oldRow.checker! });
      else if (base.modes[oldRow.checker!] === 'block' && head.modes[newRow.checker!] === 'report') changes.push({ ruleId, kind: 'mode-report', surface, beforeChecker: oldRow.checker!, afterChecker: newRow.checker! });
    }
  }
  return changes;
}
