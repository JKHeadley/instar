/**
 * The cleanup breaker counts failed cleanups, not deferrals (fb-58754ac0-5e8). On the Studio three
 * automatic runs skipped the npm cache as "npm-busy" (6-8 GB planned, nothing freed); the breaker
 * counted them as failures, tripped at 3, and auto cleanup stayed off through a critical episode.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DiskSteward, onlyBusyDeferred, type DiskStewardDeps } from '../../src/monitoring/DiskSteward.js';
import type { PruneChildResult } from '../../src/monitoring/diskStewardMain.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const GiB = 1024 ** 3;
const TOTAL = 926 * GiB;

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-steward-busy-')); });
afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/diskSteward-breaker-busy.test.ts' }); });

function steward(): DiskSteward {
  const deps: DiskStewardDeps = {
    machineId: 'm_studio', machineName: () => 'Mac Studio', agentHome: dir,
    stateFile: path.join(dir, 'state.json'), now: () => 1_800_000_000_000,
    statfs: () => ({ free: 60 * GiB, total: TOTAL }),
    isHolder: () => true,
    runner: { start: () => null, running: () => null },
    pruneEnabled: () => true, pruneDryRun: () => false, reaperArmed: () => false,
    thresholds: () => ({ warnPercent: 15, warnMinGiB: 100, escalatePercent: 10, escalateMinGiB: 60, forecastEscalateDays: 3 }),
    pruneMinIntervalMs: () => 6 * 60 * 60_000,
    peers: async () => [], send: async () => 'posted', log: () => {}, degrade: () => {},
  };
  return new DiskSteward(deps);
}

type Cat = PruneChildResult['categories'][number];
const run = (id: string, categories: Cat[]): PruneChildResult => ({
  runId: id, startedAt: 1, finishedAt: 1, trigger: 'auto', dryRun: false, categories,
  bytesFreed: categories.reduce((a, c) => a + c.bytesFreed, 0), statfsBefore: null, statfsAfter: null, cachesLock: 'held',
});
const npmBusy: Cat = { category: 'npm-cache', plannedBytes: 7 * GiB, plannedItems: 1, removedItems: 0, bytesFreed: 0, skipped: 'npm-busy' };
const xcodeBusyPartial: Cat = { category: 'derived-data', plannedBytes: 400_000, plannedItems: 2, removedItems: 1, bytesFreed: 167_936, skipped: 'xcode-busy' };
const archiveUnder: Cat = { category: 'context-archive', plannedBytes: 0, plannedItems: 0, removedItems: 0, bytesFreed: 0, skipped: 'under-limit' };
const npmIneffective: Cat = { category: 'npm-cache', plannedBytes: 7 * GiB, plannedItems: 1, removedItems: 1, bytesFreed: 1_000 };

describe('disk steward breaker: busy deferrals are not failures', () => {
  it('onlyBusyDeferred: true only when every category with planned bytes was cut short as busy', () => {
    expect(onlyBusyDeferred([npmBusy, xcodeBusyPartial, archiveUnder])).toBe(true);
    expect(onlyBusyDeferred([npmBusy, npmIneffective])).toBe(false);
    expect(onlyBusyDeferred([archiveUnder])).toBe(false); // nothing planned: not a deferral
    expect(onlyBusyDeferred([])).toBe(false);
  });

  it('three busy-only automatic runs leave the breaker at 0 (the Studio, 2026-11-17)', async () => {
    const s = steward();
    await s.tick();
    for (const id of ['a', 'b', 'c']) s.adoptRecoveredResult(run(id, [npmBusy, xcodeBusyPartial, archiveUnder]));
    expect(s.status().prune.breaker).toBe(0);
  });

  it('three genuinely ineffective automatic runs still trip it', async () => {
    const s = steward();
    await s.tick();
    for (const id of ['a', 'b', 'c']) s.adoptRecoveredResult(run(id, [npmIneffective, archiveUnder]));
    expect(s.status().prune.breaker).toBe(3);
  });
});
