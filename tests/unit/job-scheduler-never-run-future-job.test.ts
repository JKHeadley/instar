/**
 * A never-run job scheduled for the FUTURE must not fire at startup.
 *
 * THE DEFECT (ACT-724 motivating defect (a), observed 2026-07-17 on the
 * hand-built benchmark-checkin-reminder): the startup missed-job sweep treats
 * *every* job with no `lastRun` as missed —
 *
 *     if (!jobState?.lastRun) {
 *       missedJobs.push({ job, overdueRatio: 1.5 });
 *       continue;
 *     }
 *
 * — so a brand-new job whose first scheduled window is months away is triggered
 * immediately on the next boot. A reminder set for December fires today.
 *
 * The comment directly above that branch says the intended rule out loud:
 * "trigger on startup IF THEIR FIRST EXPECTED RUN TIME HAS ALREADY PASSED."
 * The code never checks that condition. The prose is right and the structure
 * does not implement it.
 *
 * Corroboration that this is real and long-known: tests/unit/JobScheduler.test.ts
 * pre-seeds `lastRun` in `beforeEach` with the comment "so checkMissedJobs
 * doesn't trigger jobs at startup" — the suite works around the behaviour as a
 * fixture quirk rather than reporting it as a bug.
 *
 * This matters beyond the annoyance: ACT-724 requires date-bearing commitments
 * to materialize a one-shot reminder on the scheduler. A reminder that fires at
 * boot instead of on its date is worse than no reminder, because it looks
 * delivered.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { createTempProject, createMockSessionManager, createSampleJobsFile } from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { JobSchedulerConfig } from '../../src/core/types.js';

describe('startup missed-job sweep — never-run jobs', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let scheduler: JobScheduler | undefined;
  let jobsFile: string;

  /** A jobs file with one job on the given cron, deliberately never run. */
  function writeJobsFile(slug: string, schedule: string): string {
    return createSampleJobsFile(project.stateDir, [
      {
        slug,
        name: slug,
        description: `test job ${slug}`,
        schedule,
        priority: 'medium',
        expectedDurationMinutes: 1,
        model: 'haiku',
        enabled: true,
        execute: { type: 'prompt', value: 'noop' },
      },
    ] as any);
  }

  beforeEach(() => {
    project = createTempProject();
    mockSM = createMockSessionManager();
    // NOTE: deliberately NO lastRun pre-seeding — that workaround is what has
    // been hiding this behaviour.
  });

  afterEach(() => {
    scheduler?.stop();
    scheduler = undefined;
    project.cleanup();
    vi.restoreAllMocks();
  });

  function makeConfig(over?: Partial<JobSchedulerConfig>): JobSchedulerConfig {
    return {
      jobsFile,
      enabled: true,
      maxParallelJobs: 2,
      quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
      startupGraceMs: 0,
      ...over,
    } as JobSchedulerConfig;
  }

  async function startAndSettle(): Promise<string[]> {
    scheduler = new JobScheduler(makeConfig(), mockSM as any, project.state, project.stateDir);
    const triggered: string[] = [];
    const orig = (scheduler as any).triggerJob.bind(scheduler);
    vi.spyOn(scheduler as any, 'triggerJob').mockImplementation(async (slug: string, reason: string) => {
      triggered.push(`${slug}:${reason}`);
      return undefined; // do not actually spawn anything
    });
    void orig;
    await scheduler.start();
    // The startup sweep is fired without await inside start(); let it drain.
    await new Promise((r) => setTimeout(r, 250));
    return triggered;
  }

  it('does NOT fire a never-run ANNUAL job whose next window is months away', async () => {
    // 03:00 on 1 December — for most of the year this is far in the future.
    jobsFile = writeJobsFile('year-away-reminder', '0 3 1 12 *');
    const triggered = await startAndSettle();
    expect(
      triggered,
      'a brand-new future-dated job must wait for its date, not fire at the next boot',
    ).toEqual([]);
  });

  it('does NOT fire a never-run DAILY job that was only just registered', async () => {
    jobsFile = writeJobsFile('fresh-daily', '0 4 * * *');
    const triggered = await startAndSettle();
    expect(triggered).toEqual([]);
  });

  it('DOES still fire a never-run job that has genuinely outlived a full interval', async () => {
    // The catch-up behaviour the branch exists for must survive: a job that has
    // been registered for longer than its own interval without ever running has
    // really missed a window. Seed firstSeenAt far in the past to represent it.
    jobsFile = writeJobsFile('long-overdue', '*/5 * * * *'); // every 5 minutes
    project.state.saveJobState({
      slug: 'long-overdue',
      firstSeenAt: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(), // 6h ago
      runCount: 0,
      consecutiveFailures: 0,
    } as any);
    const triggered = await startAndSettle();
    expect(
      triggered.some((t) => t.startsWith('long-overdue:')),
      'a job registered 6h ago on a 5-minute cron that has never run HAS missed windows',
    ).toBe(true);
  });
});
