/** Code-owned rollout authority; config cannot promote an agent by itself. */
import { JOB_COST_AUDIT_READY } from './JobCostAuditReadiness.js';

export const JOB_RESULT_SUPERVISION_COHORT: 'off' | 'test-agent' | 'development-agent' = 'off';

export interface JobSupervisionRolloutState {
  auditReady: boolean;
  cohort: 'off' | 'test-agent' | 'development-agent';
  active: boolean;
}

/** A test cohort requires the expiring init record, not a caller-supplied boolean. */
export function jobSupervisionCohortEligible(
  cohort: JobSupervisionRolloutState['cohort'],
  config: unknown,
  now = Date.now(),
): boolean {
  const values = config && typeof config === 'object' ? config as Record<string, unknown> : {};
  if (cohort === 'development-agent') return values.developmentAgent === true;
  if (cohort !== 'test-agent') return false;
  const record = values.throwawayAgent;
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  const { createdAt, expiresAt } = record as Record<string, unknown>;
  return typeof createdAt === 'string' && Number.isFinite(Date.parse(createdAt))
    && Date.parse(createdAt) <= now
    && typeof expiresAt === 'string' && Number.isFinite(Date.parse(expiresAt))
    && Date.parse(expiresAt) > now;
}

export function jobSupervisionRolloutState(config: unknown = {}): JobSupervisionRolloutState {
  const cohort = JOB_RESULT_SUPERVISION_COHORT;
  const eligible = jobSupervisionCohortEligible(cohort, config);
  return { auditReady: JOB_COST_AUDIT_READY.resultTriage, cohort,
    active: JOB_COST_AUDIT_READY.resultTriage && eligible };
}
