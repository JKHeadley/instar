import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { requestRoleRestart } from '../../src/core/roleFollowRestart.js';
import { PromotionCatchUpStore } from '../../src/scheduler/PromotionCatchUpStore.js';
import { createMockSessionManager, createSampleJobsFile, createTempProject } from '../helpers/setup.js';
import type { JobDefinition, JobSchedulerConfig } from '../../src/core/types.js';
import type { MockSessionManager, TempProject } from '../helpers/setup.js';

function job(slug: string, catchUpPolicy?: JobDefinition['catchUpPolicy']): JobDefinition {
  return { slug, name: slug, description: slug, schedule: '* * * * *', priority: 'medium',
    expectedDurationMinutes: 5, model: 'sonnet', enabled: true, execute: { type: 'prompt', value: 'work' },
    catchUpPolicy };
}

describe('promotion catch-up policy', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let scheduler: JobScheduler;
  beforeEach(() => { project = createTempProject(); mockSM = createMockSessionManager(); });
  afterEach(() => { scheduler?.stop(); project.cleanup(); });

  it('asks by default, skips explicit skip, and requests explicit run-once once', async () => {
    const jobs = [job('ask-default'), job('skip-explicit', 'skip'), job('run-once-explicit', 'run-once')];
    const jobsFile = createSampleJobsFile(project.stateDir, jobs);
    const config: JobSchedulerConfig = { jobsFile, enabled: true, startupGraceMs: 60_000,
      maxParallelJobs: 1, gateRetries: 1,
      quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 } };
    requestRoleRestart({ stateDir: project.stateDir, leaseEpoch: 3,
      machineId: 'm_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, true);
    scheduler = new JobScheduler(config, mockSM as any, project.state, project.stateDir);
    scheduler.setPromotionLeaseProvider(() => ({ leaseEpoch: 3,
      machineId: 'm_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', holdsLease: true, runOnceWitness: true }));
    scheduler.start();
    for (const row of jobs) project.state.saveJobState({ slug: row.slug, consecutiveFailures: 0,
      firstSeenAt: new Date(Date.now() - 10 * 60_000).toISOString() });
    const trigger = vi.spyOn(scheduler, 'triggerJob').mockResolvedValue('triggered');
    await (scheduler as any).checkMissedJobs(jobs);
    expect(trigger.mock.calls.map(call => call[0])).toEqual(['run-once-explicit']);
    expect(trigger.mock.calls[0][1]).toBe('promotion-catch-up');
    await (scheduler as any).checkMissedJobs(jobs);
    expect(trigger).toHaveBeenCalledTimes(1);
    const promotionId = JSON.parse(await (await import('node:fs/promises')).readFile(
      `${project.stateDir}/state/role-restart.json`, 'utf8')).promotionId as string;
    const store = new PromotionCatchUpStore(project.stateDir);
    expect(store.get(promotionId, 'ask-default')?.status).toBe('ask');
    expect(store.get(promotionId, 'skip-explicit')?.status).toBe('skip');
    expect(store.get(promotionId, 'run-once-explicit')?.status).toBe('triggered');
  });

  it('asks for run-once when another holder could have launched the job', async () => {
    const jobs = [job('run-once-explicit', 'run-once')];
    const jobsFile = createSampleJobsFile(project.stateDir, jobs);
    requestRoleRestart({ stateDir: project.stateDir, leaseEpoch: 3,
      machineId: 'm_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, true);
    scheduler = new JobScheduler({ jobsFile, enabled: true, startupGraceMs: 60_000,
      maxParallelJobs: 1, gateRetries: 1,
      quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 } },
      mockSM as any, project.state, project.stateDir);
    scheduler.setPromotionLeaseProvider(() => ({ leaseEpoch: 3,
      machineId: 'm_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', holdsLease: true, runOnceWitness: false }));
    scheduler.start();
    project.state.saveJobState({ slug: jobs[0].slug, consecutiveFailures: 0,
      firstSeenAt: new Date(Date.now() - 10 * 60_000).toISOString() });
    const trigger = vi.spyOn(scheduler, 'triggerJob').mockResolvedValue('triggered');
    await (scheduler as any).checkMissedJobs(jobs);
    expect(trigger).not.toHaveBeenCalled();
  });

  it('retries an undelivered ask and keeps it from auto-running on a later normal boot', async () => {
    const jobs = [job('needs-review')];
    const jobsFile = createSampleJobsFile(project.stateDir, jobs);
    requestRoleRestart({ stateDir: project.stateDir, leaseEpoch: 3,
      machineId: 'm_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, true);
    const config: JobSchedulerConfig = { jobsFile, enabled: true, startupGraceMs: 60_000,
      maxParallelJobs: 1, gateRetries: 1,
      quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 } };
    scheduler = new JobScheduler(config, mockSM as any, project.state, project.stateDir);
    scheduler.setPromotionLeaseProvider(() => ({ leaseEpoch: 3,
      machineId: 'm_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', holdsLease: true }));
    scheduler.start();
    project.state.saveJobState({ slug: jobs[0].slug, consecutiveFailures: 0,
      firstSeenAt: new Date(Date.now() - 10 * 60_000).toISOString() });
    const trigger = vi.spyOn(scheduler, 'triggerJob').mockResolvedValue('triggered');
    await (scheduler as any).checkMissedJobs(jobs);
    expect(trigger).not.toHaveBeenCalled();
    const { readRecentPromotion } = await import('../../src/core/roleFollowRestart.js');
    expect(readRecentPromotion(project.stateDir)).toBeNull();
    const send = vi.fn().mockResolvedValue(undefined);
    scheduler.setMessenger({ send } as any);
    (scheduler as any).retryUnresolvedCatchUpNotices();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await (scheduler as any).checkMissedJobs(jobs);
    expect(trigger).not.toHaveBeenCalled();
  });

  it('degrades run-once to ask when the live lease epoch cannot verify the stamp', async () => {
    const jobs = [job('run-once-explicit', 'run-once')];
    const jobsFile = createSampleJobsFile(project.stateDir, jobs);
    requestRoleRestart({ stateDir: project.stateDir, leaseEpoch: 3,
      machineId: 'm_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, true);
    scheduler = new JobScheduler({ jobsFile, enabled: true, startupGraceMs: 60_000,
      maxParallelJobs: 1, gateRetries: 1,
      quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 } },
      mockSM as any, project.state, project.stateDir);
    scheduler.setPromotionLeaseProvider(() => ({ leaseEpoch: 4,
      machineId: 'm_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', holdsLease: true }));
    scheduler.start();
    project.state.saveJobState({ slug: jobs[0].slug, consecutiveFailures: 0,
      firstSeenAt: new Date(Date.now() - 10 * 60_000).toISOString() });
    const trigger = vi.spyOn(scheduler, 'triggerJob').mockResolvedValue('triggered');
    await (scheduler as any).checkMissedJobs(jobs);
    expect(trigger).not.toHaveBeenCalled();
  });
});
