import { DESIGN_SURFACES, type DesignRule, type DesignSurface } from './standardParser.js';

export interface DesignCheckCapability {
  id: string;
  ruleIds: readonly string[];
  surfaces: readonly DesignSurface[];
}
export interface CoverageError { code: string; ruleId?: string; surface?: string }
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
/** Validate declared implementation coverage, not execution evidence or a passing gate. */
export function validateDesignCoverage(value: unknown, rules: readonly DesignRule[], checks: readonly DesignCheckCapability[]): CoverageError[] {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.rows)) return [{ code: 'coverage-invalid' }];
  const errors: CoverageError[] = [];
  const expected = new Map<string, { ruleId: string; surface: string }>();
  for (const rule of rules) for (const surface of rule.surfaces) expected.set(`${rule.id}:${surface}`, { ruleId: rule.id, surface });
  const byRule = new Map(rules.map(rule => [rule.id, rule]));
  const seen = new Set<string>();
  const catalog = new Map(checks.map(check => [check.id, check]));
  if (catalog.size !== checks.length) errors.push({ code: 'coverage-check-catalog-duplicate' });
  for (const row of value.rows) {
    if (!object(row) || typeof row.ruleId !== 'string' || typeof row.surface !== 'string'
      || !DESIGN_SURFACES.includes(row.surface as DesignSurface)) { errors.push({ code: 'coverage-row-invalid' }); continue; }
    const at = { ruleId: row.ruleId, surface: row.surface };
    const key = `${row.ruleId}:${row.surface}`;
    if (!expected.has(key)) { errors.push({ code: 'coverage-inapplicable', ...at }); continue; }
    if (seen.has(key)) errors.push({ code: 'coverage-duplicate', ...at });
    seen.add(key);
    if (byRule.get(row.ruleId)?.checkKind === 'review' && (typeof row.evidenceKind !== 'string' || !row.evidenceKind.trim())) errors.push({ code: 'coverage-evidence-kind-missing', ...at });
    if (row.kind === 'staged') {
      if (row.checker !== undefined) errors.push({ code: 'coverage-ambiguous', ...at });
      if (typeof row.trackedBy !== 'string' || !/^CMT-[1-9]\d*$/.test(row.trackedBy)) errors.push({ code: 'coverage-untracked', ...at });
      if (typeof row.reason !== 'string' || !row.reason.trim()) errors.push({ code: 'coverage-reason-missing', ...at });
    } else if (row.kind === 'check') {
      if (row.trackedBy !== undefined || row.reason !== undefined) errors.push({ code: 'coverage-ambiguous', ...at });
      const check = typeof row.checker === 'string' ? catalog.get(row.checker) : undefined;
      if (!check) errors.push({ code: 'coverage-check-unknown', ...at });
      else if (!check.ruleIds.includes(row.ruleId) || !check.surfaces.includes(row.surface as DesignSurface)) errors.push({ code: 'coverage-check-mismatch', ...at });
    } else errors.push({ code: 'coverage-kind-invalid', ...at });
  }
  for (const [key, at] of expected) if (!seen.has(key)) errors.push({ code: 'coverage-missing', ...at });
  return errors;
}
