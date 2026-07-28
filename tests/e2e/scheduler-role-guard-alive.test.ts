// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 "feature is alive" E2E for WS4.3 role-guard-at-spawn (MULTI-MACHINE-
 * SEAMLESSNESS-SPEC §WS4.3, CMT-1416).
 *
 * This is a route-less, scheduler-internal feature, so "alive" is proven through
 * the production wiring CONTRACT rather than an HTTP route: the role-guard
 * provider built EXACTLY as src/commands/server.ts builds it — reading
 * `multiMachine.seamlessness.ws43RoleGuard` from a real config object AND the
 * lease verdict from a REAL MultiMachineCoordinator.holdsLease() (no `() => bool`
 * mock) — drives a REAL JobScheduler.triggerJob through to a real refusal.
 *
 * A fresh single-machine coordinator with no lease attached resolves
 * holdsLease() === false (role defaults to 'standby'), so a flag-ON state-writing
 * job is REFUSED at the spawn boundary by the real lease authority — proving the
 * guard is wired and acting, not a no-op stub. With the flag OFF the same real
 * authority is a strict no-op (the job spawns), proving the gate is present.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { vi } from 'vitest';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { MultiMachineCoordinator } from '../../src/core/MultiMachineCoordinator.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { SessionManager } from '../../src/core/SessionManager.js';
import type { InstarConfig, JobDefinition, JobSchedulerConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
let scheduler: JobScheduler | undefined;

afterEach(() => {
  scheduler?.stop();
  scheduler = undefined;
  for (const d of dirs) {
    try { SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/scheduler-role-guard-alive.test.ts' }); } catch { /* ignore */ }
  }
  dirs.length = 0;
});

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

function setup(roleGuard: boolean): {
  scheduler: JobScheduler;
  spawn: ReturnType<typeof vi.fn>;
  coordinator: MultiMachineCoordinator;
} {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roleguard-alive-'));
  dirs.push(tmpDir);
  const stateDir = path.join(tmpDir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  const state = new StateManager(stateDir);
  state.saveJobState({
    slug: writerJob.slug, lastRun: new Date().toISOString(),
    lastResult: 'success', runCount: 1, consecutiveFailures: 0,
  });

  const jobsFile = path.join(stateDir, 'jobs.json');
  fs.writeFileSync(jobsFile, JSON.stringify([writerJob], null, 2));

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

  // A REAL coordinator — its holdsLease() is the lease authority, not a mock.
  const coordinator = new MultiMachineCoordinator(state, { stateDir } as never);

  const config = {
    multiMachine: { seamlessness: { ws43RoleGuard: roleGuard } },
  } as unknown as InstarConfig;

  const schedConfig: JobSchedulerConfig = {
    jobsFile, enabled: true, maxParallelJobs: 3,
    quotaThresholds: { normal: 50, elevated: 75, critical: 90, shutdown: 100 },
  };
  const sched = new JobScheduler(schedConfig, sm, state, stateDir);

  // The EXACT provider closure shape server.ts wires.
  sched.setRoleGuard(() => ({
    enabled: config.multiMachine?.seamlessness?.ws43RoleGuard === true,
    holdsLease: coordinator.holdsLease(),
  }));
  sched.start();
  scheduler = sched;
  return { scheduler: sched, spawn, coordinator };
}

describe('E2E: WS4.3 role-guard-at-spawn is ALIVE through the real lease authority', () => {
  it('flag ON: a real standby coordinator (holdsLease()===false) REFUSES a state-writing job', async () => {
    const { scheduler: sched, spawn, coordinator } = setup(true);
    // Prove the lease authority is real and reads false on a fresh single-machine
    // coordinator (no lease attached → role defaults to standby).
    expect(coordinator.holdsLease()).toBe(false);

    const result = await sched.triggerJob(writerJob.slug, 'scheduled');
    expect(result).toBe('skipped');
    expect(spawn).not.toHaveBeenCalled();
    const skips = sched.getSkipLedger().getSkips({ slug: writerJob.slug });
    expect(skips.some((s) => s.reason === 'role-guard')).toBe(true);
  });

  it('flag OFF: the same real authority is a strict no-op (job spawns) — the gate is present', async () => {
    const { scheduler: sched, spawn } = setup(false);
    const result = await sched.triggerJob(writerJob.slug, 'scheduled');
    expect(result).toBe('triggered');
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
