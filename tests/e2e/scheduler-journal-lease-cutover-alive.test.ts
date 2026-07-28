// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 "feature is alive" E2E for WS4.3 journal-lease cutover (MULTI-MACHINE-
 * SEAMLESSNESS-SPEC §WS4.3, "Cutover discipline").
 *
 * This is a route-less, scheduler-internal feature, so "alive" is proven through
 * the production wiring CONTRACT rather than an HTTP route: the cutover provider
 * built EXACTLY as src/commands/server.ts builds it — reading the flags from a
 * real config object, the lease epoch from a REAL MultiMachineCoordinator, and
 * the peers' advertised capability from a REAL MachinePoolRegistry fed by a real
 * heartbeat — drives a REAL JobScheduler.triggerJob to take a journal lease
 * (coherent pool) or fall back to the bus (mixed pool / flag off), proving the
 * gate is wired and acting, not a no-op stub.
 *
 * The load-bearing invariant verified end-to-end: never-both — a coherent pool
 * takes the durable journal lease and NEVER the bus broadcast; a mixed pool
 * takes the bus and NEVER the journal lease.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { JobClaimManager } from '../../src/scheduler/JobClaimManager.js';
import { JobLeaseClaimStore } from '../../src/scheduler/JobLeaseClaimStore.js';
import { MultiMachineCoordinator } from '../../src/core/MultiMachineCoordinator.js';
import { MachinePoolRegistry } from '../../src/core/MachinePoolRegistry.js';
import { GuardPostureStore } from '../../src/core/GuardPostureStore.js';
import { AgentBus } from '../../src/core/AgentBus.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { SessionManager } from '../../src/core/SessionManager.js';
import type { InstarConfig, JobDefinition, JobSchedulerConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
let scheduler: JobScheduler | undefined;
let bus: AgentBus | undefined;
let busClaim: JobClaimManager | undefined;

afterEach(() => {
  scheduler?.stop(); scheduler = undefined;
  busClaim?.destroy(); busClaim = undefined;
  bus?.destroy(); bus = undefined;
  for (const d of dirs) {
    try { SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/scheduler-journal-lease-cutover-alive.test.ts' }); } catch { /* ignore */ }
  }
  dirs.length = 0;
});

const job: JobDefinition = {
  slug: 'daily-sync', name: 'Daily Sync', description: 'd', schedule: '0 * * * *',
  priority: 'medium', expectedDurationMinutes: 10, model: 'haiku', enabled: true,
  execute: { type: 'prompt', value: 'sync now' },
};

function setup(opts: { enabled: boolean; dryRun: boolean; peerAdvertises: boolean | 'no-peer' }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jl-cutover-alive-'));
  dirs.push(tmpDir);
  const stateDir = path.join(tmpDir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  const state = new StateManager(stateDir);
  state.saveJobState({ slug: job.slug, lastRun: new Date().toISOString(), lastResult: 'success', runCount: 1, consecutiveFailures: 0 });
  const jobsFile = path.join(stateDir, 'jobs.json');
  fs.writeFileSync(jobsFile, JSON.stringify([job], null, 2));

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

  // REAL coordinator — its getLeaseEpoch() is the live epoch authority.
  const coordinator = new MultiMachineCoordinator(state, { stateDir } as never);

  // REAL registry — peers + advertised flags come through a real heartbeat.
  const poolSelfId = 'm1';
  const knownPeers = opts.peerAdvertises === 'no-peer' ? [] : [{ machineId: 'm2' }];
  const registry = new MachinePoolRegistry({
    postureStore: new GuardPostureStore(stateDir),
    listMachines: () => knownPeers,
    clockSkewToleranceMs: 300_000,
    failoverThresholdMs: 15 * 60_000,
  });
  if (opts.peerAdvertises !== 'no-peer') {
    registry.recordHeartbeat({
      machineId: 'm2',
      selfReportedLastSeen: new Date().toISOString(),
      seamlessnessFlags: { ws43JournalLease: opts.peerAdvertises === true },
    });
  }

  const leaseStore = new JobLeaseClaimStore({ machineId: poolSelfId, stateDir });

  bus = new AgentBus({ stateDir, machineId: poolSelfId, transport: 'jsonl', defaultTtlMs: 0 });
  busClaim = new JobClaimManager({ bus, machineId: poolSelfId, stateDir, pruneIntervalMs: 60 * 60_000 });

  const config = { multiMachine: { seamlessness: { ws43JournalLease: opts.enabled, ws43JournalLeaseDryRun: opts.dryRun } } } as unknown as InstarConfig;

  const schedConfig: JobSchedulerConfig = {
    jobsFile, enabled: true, maxParallelJobs: 3,
    quotaThresholds: { normal: 50, elevated: 75, critical: 90, shutdown: 100 },
  };
  const sched = new JobScheduler(schedConfig, sm, state, stateDir);
  sched.setJobClaimManager(busClaim);

  // The EXACT provider closure shape server.ts wires.
  sched.setJournalLeaseCutover(
    leaseStore,
    () => ({
      enabled: config.multiMachine?.seamlessness?.ws43JournalLease === true,
      dryRun: config.multiMachine?.seamlessness?.ws43JournalLeaseDryRun !== false,
      epoch: coordinator.getLeaseEpoch(),
      peers: registry.getCapacities().filter((c) => c.machineId !== poolSelfId).map((c) => ({
        machineId: c.machineId, online: c.online, ws43JournalLease: c.seamlessnessFlags?.ws43JournalLease === true,
      })),
    }),
  );
  sched.start();
  scheduler = sched;
  return { sched, spawn, leaseStore, busClaim: busClaim! };
}

describe('E2E: WS4.3 journal-lease cutover is ALIVE through the real production wiring', () => {
  it('flag ON + coherent pool → takes the durable JOURNAL lease (never the bus)', async () => {
    // dryRun:false means the live provider must report dryRun:false; we pass it.
    const { sched, spawn, leaseStore, busClaim: bc } = setup({ enabled: true, dryRun: false, peerAdvertises: true });
    const busSpy = vi.spyOn(bc, 'tryClaim');
    const result = await sched.triggerJob(job.slug, 'scheduled');
    expect(result).toBe('triggered');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(leaseStore.getClaim(job.slug)?.machineId).toBe('m1');
    expect(busSpy).not.toHaveBeenCalled(); // never-both
  });

  it('flag ON + mixed pool (peer does not advertise) → BUS broadcast (never the journal)', async () => {
    const { sched, leaseStore, busClaim: bc } = setup({ enabled: true, dryRun: false, peerAdvertises: false });
    const busSpy = vi.spyOn(bc, 'tryClaim');
    const result = await sched.triggerJob(job.slug, 'scheduled');
    expect(result).toBe('triggered');
    expect(busSpy).toHaveBeenCalled();
    expect(leaseStore.getClaim(job.slug)).toBeUndefined(); // never-both
  });

  it('flag OFF → strict no-op (legacy bus path), even with a coherent peer', async () => {
    const { sched, leaseStore, busClaim: bc } = setup({ enabled: false, dryRun: false, peerAdvertises: true });
    const busSpy = vi.spyOn(bc, 'tryClaim');
    const result = await sched.triggerJob(job.slug, 'scheduled');
    expect(result).toBe('triggered');
    expect(busSpy).toHaveBeenCalled();
    expect(leaseStore.getClaim(job.slug)).toBeUndefined();
  });

  it('single-machine (no peers) → strict no-op, journal NEVER taken', async () => {
    const { sched, leaseStore } = setup({ enabled: true, dryRun: false, peerAdvertises: 'no-peer' });
    const result = await sched.triggerJob(job.slug, 'scheduled');
    expect(result).toBe('triggered');
    expect(leaseStore.getClaim(job.slug)).toBeUndefined();
  });
});
