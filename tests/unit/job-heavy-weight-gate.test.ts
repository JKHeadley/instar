/**
 * JobScheduler — heavy jobs and machine size (docs/specs/resource-aware-placement.md §5),
 * plus the pure selfHeavyJobProfile input (single-machine survivability).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { validateJob } from '../../src/scheduler/JobLoader.js';
import { createTempProject, createMockSessionManager, createSampleJobsFile } from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { MachineCapacity } from '../../src/core/types.js';
import { selfHeavyJobProfile } from '../../src/core/machineResourceProfile.js';

const GIB = 1024 ** 3;
const small = { heavyCapable: false, reason: 'below-floor', cores: 10, memGiB: 16 };
const big = { heavyCapable: true, reason: 'meets-floor', cores: 16, memGiB: 64 };

function heavyJob(over: Record<string, unknown> = {}) {
  return {
    slug: 'heavy-build', name: 'Heavy Build', description: 'Runs a full build', schedule: '0 */4 * * *',
    priority: 'medium', expectedDurationMinutes: 5, model: 'haiku', enabled: true,
    execute: { type: 'skill', value: 'scan' }, workWeight: 'heavy', ...over,
  };
}

describe('JobScheduler — heavy-weight gate', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let scheduler: JobScheduler;

  beforeEach(() => { project = createTempProject(); mockSM = createMockSessionManager(); });
  afterEach(() => { scheduler?.stop(); project.cleanup(); });

  function make(jobs: Array<Record<string, unknown>>): JobScheduler {
    const jobsFile = createSampleJobsFile(project.stateDir, jobs as never);
    scheduler = new JobScheduler({ jobsFile, enabled: true, maxParallelJobs: 2, quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 } }, mockSM as never, project.state, project.stateDir);
    scheduler.setMachineIdentity('m_mini', 'mac-mini');
    return scheduler;
  }

  it('a heavy job is skipped on a small machine (machine-too-small) and nothing spawns', async () => {
    make([heavyJob()]);
    scheduler.setSelfHeavyProfile(() => small);
    scheduler.start();
    expect(await scheduler.triggerJob('heavy-build', 'test')).toBe('skipped');
    expect(mockSM._spawnCount).toBe(0);
    const events = project.state.queryEvents({ type: 'job_skipped' } as never) as Array<{ metadata?: Record<string, unknown> }>;
    expect(events.some((e) => e.metadata?.workWeight === 'heavy' && e.metadata?.cores === 10)).toBe(true);
  });

  it('the same job runs on a big machine', async () => {
    make([heavyJob()]);
    scheduler.setSelfHeavyProfile(() => big);
    scheduler.start();
    expect(await scheduler.triggerJob('heavy-build', 'test')).toBe('triggered');
  });

  it('the author naming this machine in `machines` overrides the size gate', async () => {
    make([heavyJob({ machines: ['mac-mini'] })]);
    scheduler.setSelfHeavyProfile(() => small);
    scheduler.start();
    expect(await scheduler.triggerJob('heavy-build', 'test')).toBe('triggered');
  });

  it('no profile (null: alone, or no other big machine) → runs as today', async () => {
    make([heavyJob()]);
    scheduler.setSelfHeavyProfile(() => null);
    scheduler.start();
    expect(await scheduler.triggerJob('heavy-build', 'test')).toBe('triggered');
  });

  it('an undeclared job is never gated', async () => {
    make([heavyJob({ workWeight: undefined })]);
    scheduler.setSelfHeavyProfile(() => small);
    scheduler.start();
    expect(await scheduler.triggerJob('heavy-build', 'test')).toBe('triggered');
  });

  it('a throwing profile seam keeps today\'s behaviour', async () => {
    make([heavyJob()]);
    scheduler.setSelfHeavyProfile(() => { throw new Error('no pool'); });
    scheduler.start();
    expect(await scheduler.triggerJob('heavy-build', 'test')).toBe('triggered');
  });
});

describe('validateJob — workWeight', () => {
  it('accepts the three weights and rejects anything else', () => {
    for (const w of ['light', 'standard', 'heavy']) expect(() => validateJob(heavyJob({ workWeight: w }))).not.toThrow();
    expect(() => validateJob(heavyJob({ workWeight: 'huge' }))).toThrow(/workWeight/);
  });
});

function cap(id: string, cores: number, memGiB: number, over: Partial<MachineCapacity> = {}): MachineCapacity {
  return {
    machineId: id, online: true, clockSkewStatus: 'ok',
    loadReport: { bootId: 'b', seq: 1, sampleAgeMs: 0, platform: 'darwin', cores, totalMemBytes: memGiB * GIB, loadPerCore: 0.1, cpuIdlePct: 90, memAvailablePct: 50, memPressureNative: 'normal', eventLoopLagP99Ms: 1, sessionsActive: 0, sessionsMax: 10, spawnCapSaturated: false, testRunnerSaturated: false, verdict: 'ok', uptimeS: 10 },
    loadReportAgeMs: 5_000, ...over,
  } as MachineCapacity;
}

describe('selfHeavyJobProfile — single-machine survivability', () => {
  it('small self with an online big peer → gate applies', () => {
    expect(selfHeavyJobProfile([cap('mini', 10, 16), cap('studio', 16, 64)], 'mini', 'auto')).toMatchObject({ heavyCapable: false });
  });
  it('small self alone, or only small/offline peers → null (job runs)', () => {
    expect(selfHeavyJobProfile([cap('mini', 10, 16)], 'mini', 'auto')).toBeNull();
    expect(selfHeavyJobProfile([cap('mini', 10, 16), cap('mamapc', 10, 12), cap('studio', 16, 64, { online: false })], 'mini', 'auto')).toBeNull();
  });
  it('big self → capable', () => {
    expect(selfHeavyJobProfile([cap('studio', 16, 64)], 'studio', 'auto')).toMatchObject({ heavyCapable: true });
  });
  it('the live override on this machine is honoured', () => {
    expect(selfHeavyJobProfile([cap('mini', 10, 16), cap('studio', 16, 64)], 'mini', 'allow')).toMatchObject({ heavyCapable: true });
    expect(selfHeavyJobProfile([cap('studio', 16, 64), cap('m5', 18, 48)], 'studio', 'deny')).toMatchObject({ heavyCapable: false });
  });
  it('unknown self → null', () => {
    expect(selfHeavyJobProfile([cap('studio', 16, 64)], 'nope', 'auto')).toBeNull();
    expect(selfHeavyJobProfile([cap('studio', 16, 64)], null, 'auto')).toBeNull();
  });
});
