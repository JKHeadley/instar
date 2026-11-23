/** Declared coverage/mode observations; never execution evidence or merge authority. */
import { validateDesignCoverage, type DesignCheckCapability } from './coverage.js';
import { validateDesignModes, type DesignMode } from './modes.js';
import { inspectEarnedRuleChanges, type EarnedCoverageRow } from './earnedRuleChanges.js';
import { DESIGN_SURFACES, type DesignRule, type DesignSurface } from './standardParser.js';
/** Rules must come from parseDesignStandard with zero errors; this is not a replacement parser. */
export interface CoveragePolicySnapshot { rules: readonly DesignRule[]; modes: unknown; coverage: unknown }
interface CoveragePolicyError { side: 'base' | 'head' | 'catalog'; code: string; ruleId?: string; surface?: string; id?: string }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Catalog and tracked IDs must be selected by trusted executing code from BASE, never HEAD metadata. */
export function inspectDesignCoveragePolicy(input: {
  base: CoveragePolicySnapshot; head: CoveragePolicySnapshot;
  checks: readonly DesignCheckCapability[]; trackedCommitments: ReadonlySet<string>;
}) {
  const errors: CoveragePolicyError[] = [];
  const catalogValid = Array.isArray(input.checks) && input.checks.every(check => object(check)
    && typeof check.id === 'string' && !!check.id.trim() && Array.isArray(check.ruleIds) && check.ruleIds.length > 0
    && check.ruleIds.every(id => typeof id === 'string' && /^DS-[A-Z][A-Z0-9]*-\d+$/.test(id))
    && Array.isArray(check.surfaces) && check.surfaces.length > 0
    && check.surfaces.every(surface => DESIGN_SURFACES.includes(surface)));
  if (!catalogValid) errors.push({ side: 'catalog', code: 'coverage-catalog-invalid' });
  if (catalogValid) for (const side of ['base', 'head'] as const) {
    const policy = input[side];
    const rulesValid = Array.isArray(policy.rules) && policy.rules.length > 0
      && new Set(policy.rules.map(rule => rule?.id)).size === policy.rules.length
      && policy.rules.every(rule => rule && typeof rule.id === 'string' && ['machine', 'review'].includes(rule.checkKind ?? '')
        && Array.isArray(rule.surfaces) && rule.surfaces.length > 0 && rule.surfaces.every((s: unknown) => DESIGN_SURFACES.includes(s as DesignSurface))
        && Array.isArray(rule.earnedFrom) && rule.earnedFrom.every((id: unknown) => typeof id === 'string')
        && ['rule', 'check', 'surfaceText'].every(field => typeof rule[field as 'rule'] === 'string')
        && (rule.measurement === null || typeof rule.measurement === 'string'));
    if (!rulesValid) { errors.push({ side, code: 'coverage-rules-invalid' }); continue; }
    for (const error of validateDesignModes(policy.modes, input.checks.map(check => check.id))) errors.push({ side, ...error });
    for (const error of validateDesignCoverage(policy.coverage, policy.rules, input.checks)) errors.push({ side, ...error });
    if (object(policy.coverage) && Array.isArray(policy.coverage.rows)) for (const row of policy.coverage.rows) {
      if (object(row) && row.kind === 'staged' && typeof row.trackedBy === 'string' && !input.trackedCommitments.has(row.trackedBy)) {
        errors.push({ side, code: 'coverage-tracker-unknown', ruleId: typeof row.ruleId === 'string' ? row.ruleId : undefined,
          surface: typeof row.surface === 'string' ? row.surface : undefined });
      }
    }
  }
  const view = (policy: CoveragePolicySnapshot) => ({ rules: policy.rules,
    coverage: (policy.coverage as { rows: EarnedCoverageRow[] }).rows,
    modes: (policy.modes as { modes: Record<string, DesignMode> }).modes });
  const changes = errors.length ? [] : inspectEarnedRuleChanges(view(input.base), view(input.head));
  return { schemaVersion: 1 as const, scope: 'declared-design-coverage' as const, mergeAuthority: false as const,
    executionEvidence: false as const, status: errors.length ? 'invalid-policy' : changes.length ? 'review-required' : 'structurally-valid', errors, changes };
}
