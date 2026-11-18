/**
 * restart-lock-continuity C.2: the first unlocked reading after a locked one, while the
 * canary has not passed this boot, brings the next sample forward and logs each canary
 * result for 30 minutes as `post-unlock-canary`. Both sides: a canary that already passed
 * this boot triggers nothing, and nothing is logged outside the window.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { HostMaintenanceStore } from '../../src/monitoring/machineMaintenance/HostMaintenanceStore.js';
import type { ProbeResult, ReadingName } from '../../src/monitoring/machineMaintenance/readings.js';
import { WedgeMonitor, POST_UNLOCK_WINDOW_MS } from '../../src/monitoring/machineMaintenance/WedgeMonitor.js';

const MIN = 60_000;
const ok = (stdout: string): ProbeResult => ({ ok: true, stdout, ms: 40, timedOut: false, code: null });
const timedOut = (): ProbeResult => ({ ok: false, stdout: null, ms: 10_000, timedOut: true, code: null });

describe('WedgeMonitor unlock re-sample (C.2)', () => {
  let dir: string;
  let clock: number;
  let monitors: WedgeMonitor[];
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-unlock-')); clock = Date.parse('2026-11-18T12:00:00Z'); monitors = []; });
  afterEach(() => { for (const m of monitors) m.stop(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/machine-wedge-unlock-resample.test.ts' }); });

  const logPath = () => path.join(dir, 'logs', 'machine-maintenance.jsonl');
  const rows = (type: string) => (fs.existsSync(logPath()) ? fs.readFileSync(logPath(), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.type === type) : []);

  function make(canary: () => ProbeResult, lock: () => string | null, canaryInstalled = true): WedgeMonitor {
    const bootAt = clock - 3 * 24 * 60 * MIN;
    const m = new WedgeMonitor({
      agentName: 'echo', machineId: () => 'm_mac', platform: 'darwin',
      logPath: logPath(),
      store: new HostMaintenanceStore({ dir: path.join(dir, 'host'), now: () => clock }),
      enabled: () => true, settings: () => ({ dryRun: true, dryRunNotice: false }),
      probe: async (name: ReadingName) => (name === 'guiCanary' ? canary() : name === 'consoleOwner' ? ok('me\n') : ok('S\n')),
      readBootAt: async () => bootAt,
      lockState: async () => lock(),
      canaryAvailable: () => canaryInstalled,
      ownUser: 'me', ownUid: 501,
      endCanary: () => true, settle: async () => {},
      loadReading: () => null, spawnSystemFailures30m: () => null, sessionsCount: () => 0,
      nextWindowRestartAt: (now) => now + 60 * MIN, judge: null, raiseNotice: null, now: () => clock,
    });
    monitors.push(m);
    return m;
  }

  it('locked then unlocked with the canary never passed: logs the unlock sample, then follow-ups for 30 minutes only', async () => {
    let lock = 'locked';
    const m = make(timedOut, () => lock);
    await m.tick();
    expect(rows('post-unlock-canary')).toHaveLength(0);
    lock = 'unlocked';
    clock += 10 * MIN;
    await m.tick();
    const first = rows('post-unlock-canary');
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ trigger: 'unlock', openOk: false, openTimedOut: true });
    // The next sample is due now (the extra sample), not 10 minutes on.
    await m.tick();
    expect(rows('post-unlock-canary')).toHaveLength(2);
    expect(rows('post-unlock-canary')[1]).toMatchObject({ trigger: 'follow-up' });
    clock += POST_UNLOCK_WINDOW_MS + MIN;
    await m.tick();
    expect(rows('post-unlock-canary')).toHaveLength(2);
  });

  it('a canary that already passed this boot: an unlock triggers nothing', async () => {
    let lock = 'unlocked';
    const m = make(() => ok(''), () => lock);
    await m.tick();
    lock = 'locked';
    clock += 10 * MIN;
    await m.tick();
    lock = 'unlocked';
    clock += 10 * MIN;
    await m.tick();
    expect(rows('post-unlock-canary')).toHaveLength(0);
  });

  it('an unknown reading between locked and unlocked still counts as the same locked episode', async () => {
    let lock: string | null = 'locked';
    const m = make(timedOut, () => lock);
    await m.tick();
    lock = 'unknown';
    clock += 10 * MIN;
    await m.tick();
    lock = 'unlocked';
    clock += 10 * MIN;
    await m.tick();
    expect(rows('post-unlock-canary')[0]).toMatchObject({ trigger: 'unlock' });
  });

  it('stopped while a triggering sample runs: no extra-sample timer is armed afterwards', async () => {
    let lock = 'locked';
    const m = make(timedOut, () => lock);
    await m.tick();
    lock = 'unlocked';
    clock += 10 * MIN;
    m.stop();
    await m.tick();
    expect((m as unknown as { unlockResample: unknown }).unlockResample).toBeNull();
  });

  it('no canary installed: an unlock brings nothing forward and logs nothing', async () => {
    let lock = 'locked';
    const m = make(timedOut, () => lock, false);
    await m.tick();
    lock = 'unlocked';
    clock += 10 * MIN;
    await m.tick();
    expect((m as unknown as { unlockResample: unknown }).unlockResample).toBeNull();
    expect(rows('post-unlock-canary')).toHaveLength(0);
  });
});
