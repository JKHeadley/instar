/**
 * Test-agent leak guard: the scheduler gate refuses every job when the injected
 * guard says throwaway, records the 'throwaway-agent' skip reason, emits one
 * job_skipped event and schedules NO retry. With no guard, nothing changes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { createTempProject, createMockSessionManager, createSampleJobsFile } from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';

describe('JobScheduler throwaway-agent gate', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let scheduler: JobScheduler;

  beforeEach(() => {
    project = createTempProject();
    mockSM = createMockSessionManager();
    const jobsFile = createSampleJobsFile(project.stateDir);
    scheduler = new JobScheduler(
      { jobsFile, enabled: true, maxParallelJobs: 2, quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 } },
      mockSM as any, project.state, project.stateDir,
    );
  });

  afterEach(() => { scheduler?.stop(); project.cleanup(); });

  it('refuses, records the reason, and schedules no retry', async () => {
    scheduler.setThrowawayJobGuard(() => ({ refuse: true, reason: 'throwaway agent (project-under-temp)' }));
    expect(scheduler.hasThrowawayJobGuard()).toBe(true);
    const r = await scheduler.triggerJob('health-check', 'test');
    expect(r).toBe('skipped');
    expect(mockSM._sessions.length).toBe(0);
    expect((scheduler as any).retryState.size).toBe(0);
    const events = project.state.queryEvents({ type: 'job_skipped' });
    const mine = events.filter((e: any) => e.metadata?.gateReason === 'throwaway-agent');
    expect(mine.length).toBe(1);
    expect(mine[0].summary).toContain('project-under-temp');
  });

  it('allows when the guard does not refuse, and without a guard', async () => {
    scheduler.setThrowawayJobGuard(() => ({ refuse: false }));
    expect(await scheduler.triggerJob('health-check', 'test')).not.toBe('skipped');
    scheduler.setThrowawayJobGuard(null);
    expect(scheduler.hasThrowawayJobGuard()).toBe(false);
  });
});
