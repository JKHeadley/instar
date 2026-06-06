/**
 * JobScheduler per-slug double-run guard (june15-headless-spawn-reroute, PR2
 * finding O3). A rerouted job REPL survives a server restart but
 * JobScheduler.activeRunIds (in-memory) is lost; without a guard the same slug
 * could re-trigger on its next cron tick while the orphan session still runs —
 * double execution + double billing. triggerJob now skips (no throw) when a live
 * session already holds the slug.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { createTempProject, createMockSessionManager, createSampleJobsFile } from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { JobSchedulerConfig, Session } from '../../src/core/types.js';

describe('JobScheduler triggerJob — per-slug double-run guard', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let scheduler: JobScheduler;
  let jobsFile: string;

  beforeEach(() => {
    project = createTempProject();
    mockSM = createMockSessionManager();
    jobsFile = createSampleJobsFile(project.stateDir);
    // Pre-seed lastRun so missed-job detection doesn't auto-trigger.
    for (const slug of ['health-check', 'email-check']) {
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

  it('skips the trigger when a live session already holds the jobSlug', async () => {
    createScheduler();
    scheduler.start();

    // Simulate a surviving rerouted job REPL holding the slug (e.g. across a
    // restart) — the in-memory activeRunIds is gone, but the session is alive.
    const orphan: Session = {
      id: 'orphan-1', name: 'health-check', status: 'running',
      tmuxSession: 'proj-health-check', startedAt: new Date().toISOString(),
      jobSlug: 'health-check', launchLane: 'rerouted-interactive',
      completionMode: 'pattern',
    };
    mockSM._sessions.push(orphan);
    mockSM._aliveSet.add(orphan.tmuxSession);

    const result = await scheduler.triggerJob('health-check', 'cron-tick');
    expect(result).toBe('skipped');
    // No new spawn — the orphan is the only session for this slug.
    expect(mockSM._spawnCount).toBe(0);
  });

  it('skip is recorded with the already-running reason', async () => {
    createScheduler();
    scheduler.start();
    const orphan: Session = {
      id: 'orphan-2', name: 'health-check', status: 'running',
      tmuxSession: 'proj-health-check-2', startedAt: new Date().toISOString(),
      jobSlug: 'health-check',
    };
    mockSM._sessions.push(orphan);
    mockSM._aliveSet.add(orphan.tmuxSession);

    await scheduler.triggerJob('health-check', 'cron-tick');
    const skips = scheduler.getSkipLedger?.()?.getSkips?.({ slug: 'health-check' }) ?? [];
    // The ledger records 'already-running' for this slug.
    expect(skips.some((s) => s.reason === 'already-running')).toBe(true);
  });

  it('a different slug with no live session still triggers normally', async () => {
    createScheduler();
    scheduler.start();
    // A live session for health-check, but we trigger email-check (different slug).
    mockSM._sessions.push({
      id: 'orphan-3', name: 'health-check', status: 'running',
      tmuxSession: 'proj-health-check-3', startedAt: new Date().toISOString(),
      jobSlug: 'health-check',
    });
    mockSM._aliveSet.add('proj-health-check-3');

    const result = await scheduler.triggerJob('email-check', 'cron-tick');
    expect(result).toBe('triggered');
    expect(mockSM._spawnCount).toBe(1);
  });
});
