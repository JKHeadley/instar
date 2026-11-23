import type { DesignRule } from './standardParser.js';

export interface RuleIdError { code: string; ruleId?: string }
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
function readLock(value: unknown): string[] | null {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.ids)
    || !value.ids.every(id => typeof id === 'string' && /^DS-[A-Z][A-Z0-9]*-\d+$/.test(id))) return null;
  return value.ids;
}

/** Permanent issuance history, not permission to retire or weaken a rule. */
export function validateDesignRuleIds(input: {
  lock: unknown; rules: readonly Pick<DesignRule, 'id'>[]; baseLock?: unknown;
}): RuleIdError[] {
  const ids = readLock(input.lock);
  if (!ids) return [{ code: 'rule-id-lock-invalid' }];
  const errors: RuleIdError[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) errors.push({ code: 'rule-id-lock-duplicate', ruleId: id });
    seen.add(id);
  }
  for (const rule of input.rules) if (!seen.has(rule.id)) errors.push({ code: 'rule-id-unissued', ruleId: rule.id });
  if (input.baseLock !== undefined) {
    const base = readLock(input.baseLock);
    if (!base || new Set(base).size !== base.length) errors.push({ code: 'base-rule-id-lock-invalid' });
    else for (const id of base) if (!seen.has(id)) errors.push({ code: 'rule-id-history-removed', ruleId: id });
  }
  return errors;
}
