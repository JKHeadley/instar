/** Code-owned rollout authority; config cannot promote an agent by itself. */
import { JOB_COST_AUDIT_READY } from './JobCostAuditReadiness.js';

export const JOB_RESULT_SUPERVISION_COHORT: 'off' | 'test-agent' | 'development-agent' = 'off';

export interface JobSupervisionRolloutState {
  auditReady: boolean;
  cohort: 'off' | 'test-agent' | 'development-agent';
  active: boolean;
}

export function jobSupervisionRolloutState(config: { developmentAgent?: boolean; throwawayAgent?: boolean } = {}): JobSupervisionRolloutState {
  const cohort = JOB_RESULT_SUPERVISION_COHORT;
  const eligible = cohort === 'test-agent' ? config.throwawayAgent === true
    : cohort === 'development-agent' ? config.developmentAgent === true : false;
  return { auditReady: JOB_COST_AUDIT_READY.resultTriage, cohort,
    active: JOB_COST_AUDIT_READY.resultTriage && eligible };
}
