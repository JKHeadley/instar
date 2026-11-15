/**
 * Quota enforcement must leave a VISIBLE pause reason (feedback e588a2a1).
 *
 * The reported ~11.6h outage was undetectable: JobScheduler.paused was a bare
 * in-memory boolean, so /status and GET /guards showed "paused" (or just
 * enabled:false) with no reason, no setter and no start time. The enforcement
 * branches also gave the scheduler no reason when pausing. This pins that:
 *  - the migrator hands the scheduler a reason when it pauses for quota,
 *  - the migrator reports the outstanding enforcement pause in its status,
 *  - the scheduler surfaces reason + since in getStatus() and guardStatus(),
 *  - all of it clears when quota recovers and the pause is released.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionMigrator } from '../../src/monitoring/SessionMigrator.js';
import type { SessionMigratorDeps } from '../../src/monitoring/SessionMigrator.js';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { createMockSessionManager, createSampleJobsFile, createTempProject } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function createMockDeps(overrides?: Partial<SessionMigratorDeps>): SessionMigratorDeps {
  return {
    listRunningSessions: vi.fn(() => []),
    sendKey: vi.fn(() => true),
    killSession: vi.fn(() => true),
    isSessionAlive: vi.fn(() => false),
    pauseScheduler: vi.fn(),
    resumeScheduler: vi.fn(),
    respawnJob: vi.fn(async () => {}),
    getAccountStatuses: vi.fn(() => []),
    switchAccount: vi.fn(async () => ({ success: true, message: 'ok' })),
    ...overrides,
  };
}

describe('quota enforcement pause reason visibility', () => {
  let tmpDir: string;
  let project: TempProject | null = null;
  let scheduler: JobScheduler | null = null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qe-reason-'));
  });

  afterEach(() => {
    scheduler?.stop();
    scheduler = null;
    project?.cleanup();
    project = null;
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/quota-enforcement-pause-reason.test.ts:cleanup' });
  });

  it('enforcement pause records a visible reason on the migrator and scheduler, cleared on recovery', async () => {
    project = createTempProject();
    const jobsFile = createSampleJobsFile(project.stateDir, [{
      slug: 'health-check', name: 'Health Check', description: 'critical watchdog',
      schedule: '*/5 * * * *', priority: 'critical', expectedDurationMinutes: 1,
      model: 'haiku', enabled: true, execute: { type: 'prompt', value: 'check' },
    }]);
    scheduler = new JobScheduler({
      jobsFile, enabled: true, maxParallelJobs: 1, gateRetries: 1,
      quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
    }, createMockSessionManager() as any, project.state, project.stateDir);
    scheduler.start();
    const sched = scheduler;

    const migrator = new SessionMigrator({ stateDir: tmpDir, thresholds: { gracePeriodMs: 10 } });
    const deps = createMockDeps({
      pauseScheduler: vi.fn((reason?: string) => sched.pause(reason)),
      resumeScheduler: vi.fn(() => sched.resume()),
    });
    migrator.setDeps(deps);

    // Single-account agent at 96% → the no-alternative enforced_kill branch.
    await migrator.checkAndMigrate({ percentUsed: 50, fiveHourPercent: 96, activeAccountEmail: 'a@test.io' });

    expect(deps.pauseScheduler).toHaveBeenCalledWith(expect.stringMatching(/quota enforcement.*96%/i));

    const status = migrator.getMigrationStatus() as Record<string, any>;
    expect(status.enforcementPause).toMatchObject({ result: 'enforced_kill', fiveHourPercent: 96 });
    expect(typeof status.enforcementPause?.since).toBe('string');

    const schedStatus = sched.getStatus() as Record<string, any>;
    expect(schedStatus.paused).toBe(true);
    expect(schedStatus.pauseReason).toMatch(/quota enforcement/i);
    expect(typeof schedStatus.pausedSince).toBe('string');
    expect((sched.guardStatus() as Record<string, any>).pauseReason).toMatch(/quota enforcement/i);

    // Quota recovers → pause released and every reason surface clears.
    expect(migrator.releaseEnforcementPauseIfRecovered({ percentUsed: 40, fiveHourPercent: 20 })).toBe(true);
    expect((migrator.getMigrationStatus() as Record<string, any>).enforcementPause).toBeNull();
    const after = sched.getStatus() as Record<string, any>;
    expect(after.paused).toBe(false);
    expect(after.pauseReason).toBeNull();
    expect(after.pausedSince).toBeNull();
  });
});
