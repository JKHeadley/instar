/**
 * Integration tests — JobScheduler × WS4.3 journal-lease cutover.
 *
 * Verifies the scheduler routes job claims through the cutover gate:
 *   - coherent pool → journal lease taken, NOT the bus broadcast
 *   - mixed pool → bus broadcast, NOT the journal lease (never-both)
 *   - dry-run → bus broadcast (legacy path runs; journal logged-only)
 *   - flag off / not wired → byte-for-byte legacy behavior
 *   - a remote journal lease causes a skip
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { JobClaimManager } from '../../src/scheduler/JobClaimManager.js';
import { JobLeaseClaimStore } from '../../src/scheduler/JobLeaseClaimStore.js';
import { AgentBus } from '../../src/core/AgentBus.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { SessionManager } from '../../src/core/SessionManager.js';
import type { JobSchedulerConfig } from '../../src/core/types.js';
import type { CutoverGateInput } from '../../src/scheduler/JobLeaseCutoverGate.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'sched-jl-')); }

function mockSessionManager(): SessionManager {
  return {
    listRunningSessions: vi.fn().mockReturnValue([]),
    spawnSession: vi.fn().mockResolvedValue(undefined),
    captureOutput: vi.fn().mockReturnValue(''),
    getSessionDiagnostics: vi.fn().mockReturnValue({
      maxSessions: 3, sessions: [], memoryPressure: 'normal',
      memoryUsedPercent: 50, freeMemoryMB: 8000, suggestions: [],
    }),
  } as unknown as SessionManager;
}

function jobsFile(dir: string): string {
  const f = path.join(dir, 'jobs.json');
  fs.writeFileSync(f, JSON.stringify([{
    slug: 'daily-sync', name: 'Daily Sync', description: 'd', schedule: '0 * * * *',
    enabled: true, priority: 'medium', model: 'haiku', expectedDurationMinutes: 10,
    execute: { type: 'prompt', value: 'sync now' },
  }], null, 2));
  return f;
}

function cfg(f: string): JobSchedulerConfig {
  return { jobsFile: f, enabled: true, maxParallelJobs: 3,
    quotaThresholds: { normal: 50, elevated: 75, critical: 90, shutdown: 100 } };
}

interface Harness {
  dir: string; bus: AgentBus; busClaim: JobClaimManager;
  leaseStore: JobLeaseClaimStore; scheduler: JobScheduler;
  sessionManager: SessionManager; gate: { input: CutoverGateInput & { epoch: number } };
  destroy(): void;
}

function makeHarness(initialInput: CutoverGateInput & { epoch: number }): Harness {
  const dir = tmp();
  const f = jobsFile(dir);
  const bus = new AgentBus({ stateDir: dir, machineId: 'm1', transport: 'jsonl', defaultTtlMs: 0 });
  const busClaim = new JobClaimManager({ bus, machineId: 'm1', stateDir: dir, pruneIntervalMs: 60 * 60_000 });
  const leaseStore = new JobLeaseClaimStore({ machineId: 'm1', stateDir: dir });
  const state = new StateManager(dir);
  state.saveJobState({ slug: 'daily-sync', lastRun: new Date().toISOString(), lastResult: 'success', runCount: 1, consecutiveFailures: 0 });
  const sessionManager = mockSessionManager();
  const scheduler = new JobScheduler(cfg(f), sessionManager, state, dir);
  scheduler.setJobClaimManager(busClaim);
  const gate = { input: initialInput };
  scheduler.setJournalLeaseCutover(leaseStore, () => gate.input);
  scheduler.start();
  return {
    dir, bus, busClaim, leaseStore, scheduler, sessionManager, gate,
    destroy() { scheduler.stop(); busClaim.destroy(); bus.destroy(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/scheduler-journal-lease-cutover.test.ts' }); },
  };
}

const coherent = (): CutoverGateInput & { epoch: number } =>
  ({ enabled: true, dryRun: false, epoch: 7, peers: [{ machineId: 'm2', online: true, ws43JournalLease: true }] });

describe('JobScheduler × WS4.3 journal-lease cutover', () => {
  let h: Harness;
  afterEach(() => h?.destroy());

  it('coherent pool → takes the JOURNAL lease (not the bus broadcast)', async () => {
    h = makeHarness(coherent());
    const busSpy = vi.spyOn(h.busClaim, 'tryClaim');
    const r = await h.scheduler.triggerJob('daily-sync', 'manual');
    expect(r).toBe('triggered');
    // The journal lease was taken under the live epoch...
    const claim = h.leaseStore.getClaim('daily-sync');
    expect(claim?.machineId).toBe('m1');
    expect(claim?.epoch).toBe(7);
    // ...and the bus broadcast was NOT used (never-both).
    expect(busSpy).not.toHaveBeenCalled();
  });

  it('mixed pool → uses the BUS broadcast (not the journal lease)', async () => {
    h = makeHarness({ enabled: true, dryRun: false, epoch: 7,
      peers: [{ machineId: 'm2', online: true, ws43JournalLease: false }] });
    const busSpy = vi.spyOn(h.busClaim, 'tryClaim');
    const r = await h.scheduler.triggerJob('daily-sync', 'manual');
    expect(r).toBe('triggered');
    expect(busSpy).toHaveBeenCalled();
    expect(h.leaseStore.getClaim('daily-sync')).toBeUndefined();
  });

  it('dry-run on a coherent pool → bus path runs, journal NOT taken', async () => {
    h = makeHarness({ enabled: true, dryRun: true, epoch: 7,
      peers: [{ machineId: 'm2', online: true, ws43JournalLease: true }] });
    const busSpy = vi.spyOn(h.busClaim, 'tryClaim');
    const r = await h.scheduler.triggerJob('daily-sync', 'manual');
    expect(r).toBe('triggered');
    expect(busSpy).toHaveBeenCalled();
    expect(h.leaseStore.getClaim('daily-sync')).toBeUndefined();
  });

  it('single-machine (no peers) → bus path, journal NOT taken (no-op)', async () => {
    h = makeHarness({ enabled: true, dryRun: false, epoch: 7, peers: [] });
    const busSpy = vi.spyOn(h.busClaim, 'tryClaim');
    const r = await h.scheduler.triggerJob('daily-sync', 'manual');
    expect(r).toBe('triggered');
    expect(busSpy).toHaveBeenCalled();
    expect(h.leaseStore.getClaim('daily-sync')).toBeUndefined();
  });

  it('a remote JOURNAL lease causes a skip on a coherent pool', async () => {
    h = makeHarness(coherent());
    h.leaseStore.applyRemote({
      claimId: 'lease_peer', jobSlug: 'daily-sync', machineId: 'm2', epoch: 7,
      claimedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(), completed: false,
    });
    const r = await h.scheduler.triggerJob('daily-sync', 'manual');
    expect(r).toBe('skipped');
    expect(h.sessionManager.spawnSession).not.toHaveBeenCalled();
    const skips = h.scheduler.getSkipLedger().getSkips({ slug: 'daily-sync' });
    expect(skips.some(s => s.reason === 'claimed')).toBe(true);
  });

  it('a live FLAG FLIP at the boundary changes the path immediately', async () => {
    h = makeHarness(coherent());
    // First run: coherent → journal.
    await h.scheduler.triggerJob('daily-sync', 'manual');
    expect(h.leaseStore.getClaim('daily-sync')?.machineId).toBe('m1');
    h.leaseStore.completeClaim('daily-sync', 'success');
    // Flip the flag off live; next run must use the bus.
    h.gate.input = { ...h.gate.input, enabled: false };
    const busSpy = vi.spyOn(h.busClaim, 'tryClaim');
    await h.scheduler.triggerJob('daily-sync', 'manual');
    expect(busSpy).toHaveBeenCalled();
  });
});
