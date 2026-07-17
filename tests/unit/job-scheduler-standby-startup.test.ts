import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { createMockSessionManager, createSampleJobsFile, createTempProject } from '../helpers/setup.js';
import type { JobDefinition, JobSchedulerConfig } from '../../src/core/types.js';
import type { MockSessionManager, TempProject } from '../helpers/setup.js';

describe('JobScheduler read-only standby startup containment', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let scheduler: JobScheduler;

  beforeEach(() => {
    project = createTempProject();
    mockSM = createMockSessionManager();
  });

  afterEach(() => {
    project?.state.setReadOnly(false);
    scheduler?.stop();
    project.cleanup();
  });

  it('skips a never-run missed job without touching shared state after demotion', async () => {
    const jobs: JobDefinition[] = [{
      slug: 'startup-miss',
      name: 'Startup Miss',
      description: 'A job missed while the machine was offline',
      schedule: '* * * * *',
      priority: 'medium',
      expectedDurationMinutes: 5,
      model: 'sonnet',
      enabled: true,
      gate: 'exit 1',
      execute: { type: 'prompt', value: 'do work' },
    }];
    const jobsFile = createSampleJobsFile(project.stateDir, jobs);
    const config: JobSchedulerConfig = {
      jobsFile,
      enabled: true,
      maxParallelJobs: 1,
      gateRetries: 1,
      quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
    };
    scheduler = new JobScheduler(config, mockSM as any, project.state, project.stateDir);
    scheduler.start();

    project.state.setReadOnly(true);

    await expect(scheduler.triggerJob('startup-miss', 'missed')).resolves.toBe('skipped');
    expect(mockSM._spawnCount).toBe(0);
    const skips = scheduler.getSkipLedger?.()?.getSkips?.({ slug: 'startup-miss' }) ?? [];
    expect(skips.filter((s) => s.reason === 'role-guard')).toHaveLength(1);
  });

  it('contains a demotion that races a startup missed-job gate', async () => {
    const jobs: JobDefinition[] = [{
      slug: 'raced-startup-miss',
      name: 'Raced Startup Miss',
      description: 'Demotes while its gate is in flight',
      schedule: '* * * * *',
      priority: 'medium',
      expectedDurationMinutes: 5,
      model: 'sonnet',
      enabled: true,
      gate: 'sleep 0.1; exit 1',
      execute: { type: 'prompt', value: 'do work' },
    }];
    const jobsFile = createSampleJobsFile(project.stateDir, jobs);
    scheduler = new JobScheduler({
      jobsFile,
      enabled: true,
      maxParallelJobs: 1,
      gateRetries: 1,
      startupGraceMs: 60_000,
      quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
    }, mockSM as any, project.state, project.stateDir);
    scheduler.start();

    const evaluation = (scheduler as any).checkMissedJobs(jobs);
    await new Promise((resolve) => setTimeout(resolve, 20));
    project.state.setReadOnly(true);

    await expect(evaluation).resolves.toBeUndefined();
    expect(mockSM._spawnCount).toBe(0);
  });
});
