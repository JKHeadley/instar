import { describe, expect, it } from 'vitest';
import { jobSupervisionCohortEligible, jobSupervisionRolloutState } from '../../src/scheduler/JobSupervisionRollout.js';

describe('job supervision cohort eligibility', () => {
  const now = Date.parse('2026-10-28T15:00:00Z');

  it('accepts only an unexpired throwaway-agent record for the test cohort', () => {
    expect(jobSupervisionCohortEligible('test-agent', {
      throwawayAgent: { createdAt: '2026-10-28T14:00:00Z', expiresAt: '2026-10-28T16:00:00Z' },
    }, now)).toBe(true);
    expect(jobSupervisionCohortEligible('test-agent', { throwawayAgent: true }, now)).toBe(false);
    expect(jobSupervisionCohortEligible('test-agent', {
      throwawayAgent: { createdAt: '2026-10-28T14:00:00Z', expiresAt: '2026-10-28T15:00:00Z' },
    }, now)).toBe(false);
    expect(jobSupervisionCohortEligible('test-agent', {
      throwawayAgent: { createdAt: '2026-10-28T14:00:00Z' },
    }, now)).toBe(false);
    expect(jobSupervisionCohortEligible('test-agent', { throwawayAgent: { expiresAt: '2026-10-28T16:00:00Z' } }, now)).toBe(false);
    expect(jobSupervisionCohortEligible('test-agent', {
      throwawayAgent: { createdAt: '2026-10-28T16:00:00Z', expiresAt: '2026-10-28T17:00:00Z' },
    }, now)).toBe(false);
    expect(jobSupervisionCohortEligible('test-agent', {
      throwawayAgent: { createdAt: '2026-10-28T14:00:00Z', expiresAt: 'invalid' },
    }, now)).toBe(false);
  });

  it('keeps development and test cohorts separate and the rollout off', () => {
    const testAgent = { throwawayAgent: { createdAt: '2026-10-28T14:00:00Z', expiresAt: '2026-10-28T16:00:00Z' } };
    expect(jobSupervisionCohortEligible('development-agent', testAgent, now)).toBe(false);
    expect(jobSupervisionCohortEligible('development-agent', { developmentAgent: true }, now)).toBe(true);
    expect(jobSupervisionCohortEligible('off', { developmentAgent: true, ...testAgent }, now)).toBe(false);
    expect(jobSupervisionRolloutState(testAgent)).toEqual({ auditReady: false, cohort: 'off', active: false });
  });
});
