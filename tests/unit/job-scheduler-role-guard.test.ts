/**
 * JobScheduler WS4.3 role-guard-at-spawn (MULTI-MACHINE-SEAMLESSNESS-SPEC §WS4.3,
 * CMT-1416). A STATE-WRITING job (JobDefinition.writesState) must not spawn on a
 * read-only standby. The scheduler is constructed only on an awake machine but is
 * NEVER torn down on demotion — so a machine awake at boot that loses the lease
 * mid-run keeps firing cron tasks. triggerJob re-checks the lease at the spawn
 * boundary (the TOCTOU re-check, same family as WS1.1 _ownershipReadForDrain) and
 * refuses (no throw, no spawn) when the role-guard is on and this machine does not
 * hold the lease. DARK by default (provider unset or enabled:false → strict no-op).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { createTempProject, createMockSessionManager, createSampleJobsFile } from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { JobSchedulerConfig, JobDefinition } from '../../src/core/types.js';

describe('JobScheduler triggerJob — WS4.3 role-guard-at-spawn', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let scheduler: JobScheduler;
  let jobsFile: string;

  /** A state-writing job + a plain (non-state-writing) job, both enabled. */
  const sampleJobs: JobDefinition[] = [
    {
      slug: 'writer-job',
      name: 'Writer Job',
      description: 'A job that mutates shared state',
      schedule: '0 */4 * * *',
      priority: 'medium',
      expectedDurationMinutes: 5,
      model: 'sonnet',
      enabled: true,
      writesState: true,
      execute: { type: 'prompt', value: 'do the write' },
    },
    {
      slug: 'reader-job',
      name: 'Reader Job',
      description: 'A job that does not write shared state',
      schedule: '0 */2 * * *',
      priority: 'medium',
      expectedDurationMinutes: 5,
      model: 'sonnet',
      enabled: true,
      // writesState absent ⇒ NOT a state-writing job (additive-safe default).
      execute: { type: 'prompt', value: 'just read' },
    },
  ];

  beforeEach(() => {
    project = createTempProject();
    mockSM = createMockSessionManager();
    jobsFile = createSampleJobsFile(project.stateDir, sampleJobs);
    // Pre-seed lastRun so missed-job detection doesn't auto-trigger.
    for (const slug of ['writer-job', 'reader-job']) {
      project.state.saveJobState({
        slug, lastRun: new Date().toISOString(), lastResult: 'success',
        runCount: 1, consecutiveFailures: 0,
      });
    }
  });

  afterEach(() => {
    scheduler?.stop();
    project.cleanup();
  });

  function createScheduler(): JobScheduler {
    const config: JobSchedulerConfig = {
      jobsFile, enabled: true, maxParallelJobs: 5,
      quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
    };
    scheduler = new JobScheduler(config, mockSM as any, project.state, project.stateDir);
    return scheduler;
  }

  it('refuses a state-writing job at the spawn boundary on a read-only standby (guard on, no lease)', async () => {
    createScheduler();
    let attentionRaised: { slug: string; machineId: string | null } | null = null;
    scheduler.setRoleGuard(
      () => ({ enabled: true, holdsLease: false }), // read-only standby
      (slug, machineId) => { attentionRaised = { slug, machineId }; },
    );
    scheduler.start();

    const result = await scheduler.triggerJob('writer-job', 'cron-tick');
    expect(result).toBe('skipped');
    // No session spawned — the refusal happened before the spawn path.
    expect(mockSM._spawnCount).toBe(0);
    // The deduped attention item was raised.
    expect(attentionRaised).not.toBeNull();
    expect(attentionRaised!.slug).toBe('writer-job');
  });

  it('records the refusal as a role-guard skip', async () => {
    createScheduler();
    scheduler.setRoleGuard(() => ({ enabled: true, holdsLease: false }));
    scheduler.start();

    await scheduler.triggerJob('writer-job', 'cron-tick');
    const skips = scheduler.getSkipLedger?.()?.getSkips?.({ slug: 'writer-job' }) ?? [];
    expect(skips.some((s) => s.reason === 'role-guard')).toBe(true);
  });

  it('ALLOWS a state-writing job when this machine HOLDS the lease (writable owner)', async () => {
    createScheduler();
    scheduler.setRoleGuard(() => ({ enabled: true, holdsLease: true })); // lease-holder
    scheduler.start();

    const result = await scheduler.triggerJob('writer-job', 'cron-tick');
    expect(result).toBe('triggered');
    expect(mockSM._spawnCount).toBe(1);
  });

  it('does NOT guard a non-state-writing job even on a read-only standby', async () => {
    createScheduler();
    scheduler.setRoleGuard(() => ({ enabled: true, holdsLease: false }));
    scheduler.start();

    const result = await scheduler.triggerJob('reader-job', 'cron-tick');
    expect(result).toBe('triggered');
    expect(mockSM._spawnCount).toBe(1);
  });

  it('is a strict no-op when the flag is OFF (state-writing job spawns even without the lease)', async () => {
    createScheduler();
    scheduler.setRoleGuard(() => ({ enabled: false, holdsLease: false })); // flag off
    scheduler.start();

    const result = await scheduler.triggerJob('writer-job', 'cron-tick');
    expect(result).toBe('triggered');
    expect(mockSM._spawnCount).toBe(1);
  });

  it('is a strict no-op when NO provider is wired (byte-for-byte today\'s behavior)', async () => {
    createScheduler();
    // setRoleGuard never called.
    scheduler.start();

    const result = await scheduler.triggerJob('writer-job', 'cron-tick');
    expect(result).toBe('triggered');
    expect(mockSM._spawnCount).toBe(1);
  });

  it('degrades to spawn-proceeds (never wedges) when the provider THROWS', async () => {
    createScheduler();
    scheduler.setRoleGuard(() => { throw new Error('provider boom'); });
    scheduler.start();

    const result = await scheduler.triggerJob('writer-job', 'cron-tick');
    // A throwing provider must never gate a job — additive safety degrades to
    // today's behavior (spawn proceeds) rather than wedging the scheduler.
    expect(result).toBe('triggered');
    expect(mockSM._spawnCount).toBe(1);
  });

  it('the refusal still happens even when the attention callback throws (refusal is load-bearing)', async () => {
    createScheduler();
    scheduler.setRoleGuard(
      () => ({ enabled: true, holdsLease: false }),
      () => { throw new Error('attention boom'); },
    );
    scheduler.start();

    const result = await scheduler.triggerJob('writer-job', 'cron-tick');
    expect(result).toBe('skipped');
    expect(mockSM._spawnCount).toBe(0);
  });
});
