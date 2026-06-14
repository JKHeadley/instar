/**
 * Integration test — WS4.3 role-guard-at-spawn (MULTI-MACHINE-SEAMLESSNESS-SPEC
 * §WS4.3, CMT-1416) through the FULL JobScheduler.triggerJob pipeline with a
 * config-flag-driven provider (the exact shape server.ts wires) + a real
 * SkipLedger + real StateManager.
 *
 * This is the tier-2 test for a route-less, scheduler-internal feature: it drives
 * the whole trigger path (machine-scope → role-guard → claim → capacity → spawn)
 * and proves the role-guard's REAL effects land — a refused spawn, a 'role-guard'
 * skip-ledger row, a job_skipped state event, and a re-route-by-construction (the
 * lease-holder pass spawns the same job). The provider mirrors how server.ts
 * reads `multiMachine.seamlessness.ws43RoleGuard` and `coordinator.holdsLease()`
 * LIVE at each spawn boundary.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { SessionManager } from '../../src/core/SessionManager.js';
import type { InstarConfig, JobDefinition, JobSchedulerConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-sched-roleguard-'));
}

function cleanup(dir: string): void {
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/scheduler-role-guard-integration.test.ts' });
}

function writeJobsFile(dir: string, jobs: JobDefinition[]): string {
  const jobsFile = path.join(dir, 'jobs.json');
  fs.writeFileSync(jobsFile, JSON.stringify(jobs, null, 2));
  return jobsFile;
}

function mockSessionManager(): { sm: SessionManager; spawn: ReturnType<typeof vi.fn> } {
  const spawn = vi.fn().mockResolvedValue(undefined);
  const sm = {
    listRunningSessions: vi.fn().mockReturnValue([]),
    spawnSession: spawn,
    captureOutput: vi.fn().mockReturnValue(''),
    getSessionDiagnostics: vi.fn().mockReturnValue({
      maxSessions: 3, sessions: [], memoryPressure: 'normal',
      memoryUsedPercent: 50, freeMemoryMB: 8000, suggestions: [],
    }),
  } as unknown as SessionManager;
  return { sm, spawn };
}

const writerJob: JobDefinition = {
  slug: 'replicated-store-sweep',
  name: 'Replicated Store Sweep',
  description: 'A state-writing maintenance job',
  schedule: '0 */6 * * *',
  priority: 'medium',
  expectedDurationMinutes: 5,
  model: 'sonnet',
  enabled: true,
  writesState: true,
  execute: { type: 'prompt', value: 'sweep the replicated store' },
};

/** Build the provider exactly as server.ts does: read config + a holdsLease fn LIVE. */
function makeRoleGuardProvider(config: InstarConfig, holdsLease: () => boolean) {
  return () => ({
    enabled: config.multiMachine?.seamlessness?.ws43RoleGuard === true,
    holdsLease: holdsLease(),
  });
}

function schedulerConfig(jobsFile: string): JobSchedulerConfig {
  return {
    jobsFile, enabled: true, maxParallelJobs: 3,
    quotaThresholds: { normal: 50, elevated: 75, critical: 90, shutdown: 100 },
  };
}

function baseConfig(roleGuard: boolean): InstarConfig {
  return {
    multiMachine: { seamlessness: { ws43RoleGuard: roleGuard } },
  } as unknown as InstarConfig;
}

describe('Integration: WS4.3 role-guard-at-spawn through the full triggerJob pipeline', () => {
  let dir: string;
  let state: StateManager;
  let scheduler: JobScheduler;

  beforeEach(() => {
    dir = createTempDir();
    const stateDir = path.join(dir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    state = new StateManager(stateDir);
    // Pre-seed lastRun so missed-job detection doesn't auto-trigger at start().
    state.saveJobState({
      slug: writerJob.slug, lastRun: new Date().toISOString(),
      lastResult: 'success', runCount: 1, consecutiveFailures: 0,
    });
  });

  afterEach(() => {
    scheduler?.stop();
    cleanup(dir);
  });

  it('flag ON + not lease-holder: refuses, records role-guard skip + job_skipped event, no spawn', async () => {
    const jobsFile = writeJobsFile(dir, [writerJob]);
    const { sm, spawn } = mockSessionManager();
    const config = baseConfig(true);
    scheduler = new JobScheduler(schedulerConfig(jobsFile), sm, state, path.join(dir, '.instar'));

    const attention: Array<{ slug: string; machineId: string | null }> = [];
    scheduler.setRoleGuard(
      makeRoleGuardProvider(config, () => false), // read-only standby
      (slug, machineId) => attention.push({ slug, machineId }),
    );
    scheduler.start();

    const result = await scheduler.triggerJob(writerJob.slug, 'scheduled');
    expect(result).toBe('skipped');
    expect(spawn).not.toHaveBeenCalled();

    // Real SkipLedger row.
    const skips = scheduler.getSkipLedger().getSkips({ slug: writerJob.slug });
    expect(skips.some((s) => s.reason === 'role-guard')).toBe(true);

    // Real state event.
    const events = state.queryEvents({ type: 'job_skipped', limit: 50 });
    expect(events.some((e) => (e.metadata as Record<string, unknown> | undefined)?.gateReason === 'role-guard')).toBe(true);

    // The deduped attention heads-up fired with the slug.
    expect(attention).toHaveLength(1);
    expect(attention[0].slug).toBe(writerJob.slug);
  });

  it('re-route-by-construction: the SAME job spawns on the machine that HOLDS the lease', async () => {
    const jobsFile = writeJobsFile(dir, [writerJob]);
    const { sm, spawn } = mockSessionManager();
    const config = baseConfig(true);
    scheduler = new JobScheduler(schedulerConfig(jobsFile), sm, state, path.join(dir, '.instar'));
    scheduler.setRoleGuard(makeRoleGuardProvider(config, () => true)); // writable owner
    scheduler.start();

    const result = await scheduler.triggerJob(writerJob.slug, 'scheduled');
    expect(result).toBe('triggered');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('flag OFF: strict no-op — a state-writing job spawns even without the lease', async () => {
    const jobsFile = writeJobsFile(dir, [writerJob]);
    const { sm, spawn } = mockSessionManager();
    const config = baseConfig(false); // flag off
    scheduler = new JobScheduler(schedulerConfig(jobsFile), sm, state, path.join(dir, '.instar'));
    scheduler.setRoleGuard(makeRoleGuardProvider(config, () => false));
    scheduler.start();

    const result = await scheduler.triggerJob(writerJob.slug, 'scheduled');
    expect(result).toBe('triggered');
    expect(spawn).toHaveBeenCalledTimes(1);
    const skips = scheduler.getSkipLedger().getSkips({ slug: writerJob.slug });
    expect(skips.some((s) => s.reason === 'role-guard')).toBe(false);
  });

  it('live re-read: a mid-run demotion takes effect on the NEXT trigger (provider is read each time)', async () => {
    const jobsFile = writeJobsFile(dir, [writerJob]);
    const { sm, spawn } = mockSessionManager();
    const config = baseConfig(true);
    scheduler = new JobScheduler(schedulerConfig(jobsFile), sm, state, path.join(dir, '.instar'));

    // A mutable lease flag — flips from held to lost mid-run (a demotion).
    let holds = true;
    scheduler.setRoleGuard(makeRoleGuardProvider(config, () => holds));
    scheduler.start();

    // First tick: lease held → spawns.
    expect(await scheduler.triggerJob(writerJob.slug, 'scheduled')).toBe('triggered');
    expect(spawn).toHaveBeenCalledTimes(1);

    // Demote mid-run; clear the live-session double-run guard so the next tick
    // reaches the role-guard (isolating the lease re-read).
    holds = false;
    (sm.listRunningSessions as ReturnType<typeof vi.fn>).mockReturnValue([]);

    // Next tick: lease lost → refused.
    expect(await scheduler.triggerJob(writerJob.slug, 'scheduled')).toBe('skipped');
    expect(spawn).toHaveBeenCalledTimes(1); // still 1 — no new spawn
  });
});
