/**
 * PlacementExecutor — resource-aware placement (docs/specs/resource-aware-placement.md §2).
 * The fleet fixture mirrors Echo's live pool on 2026-11-07 (cores / memory from each
 * machine's own load report): Studio 16/64 at 1.50 per core, M5 Pro 18/48 at 0.71,
 * Laptop 16/128 at 6.77, Mini 10/16 at 1.55, Mama PC 10/12 at 1.44.
 */
import { describe, it, expect } from 'vitest';
import { PlacementExecutor, type PlacementRequest } from '../../src/core/PlacementExecutor.js';
import type { MachineCapacity } from '../../src/core/types.js';

const GIB = 1024 ** 3;

function m(id: string, cores: number | null, memGiB: number | null, lpc: number | null, over: Partial<MachineCapacity> = {}): MachineCapacity {
  return {
    machineId: id,
    nickname: id,
    online: true,
    clockSkewStatus: 'ok',
    activeSessionCount: 2,
    maxSessions: 10,
    memPressure: 'low',
    capabilities: ['sessions'],
    loadReport: {
      bootId: 'b', seq: 1, sampleAgeMs: 0, platform: 'darwin', cores, totalMemBytes: memGiB === null ? null : memGiB * GIB,
      loadPerCore: lpc, cpuIdlePct: 40, memAvailablePct: 40, memPressureNative: 'normal', eventLoopLagP99Ms: 5,
      sessionsActive: 2, sessionsMax: 10, spawnCapSaturated: false, testRunnerSaturated: false, verdict: 'ok', uptimeS: 1000,
    },
    loadReportAgeMs: 10_000,
    loadVerdict: 'ok',
    ...over,
  } as MachineCapacity;
}

const req = (over: Partial<PlacementRequest>): PlacementRequest => ({ sessionKey: 's', topicMetadata: {}, machineRegistry: [], reason: 'new', ...over });

function fleet(): MachineCapacity[] {
  return [
    m('studio', 16, 64, 1.5, { loadVerdict: 'saturated' }),
    m('m5pro', 18, 48, 0.71),
    m('laptop', 16, 128, 6.77, { loadVerdict: 'saturated' }),
    m('mini', 10, 16, 1.55, { loadVerdict: 'saturated' }),
    m('mamapc', 10, 12, 1.44, { loadVerdict: 'unknown' }),
  ];
}

describe('heavy work', () => {
  const exec = new PlacementExecutor();

  it('on the real fleet shape, heavy goes to the M5 Pro (big, with room)', () => {
    expect(exec.decide(req({ workWeight: 'heavy', machineRegistry: fleet() }))).toMatchObject({ chosenMachine: 'm5pro', outcome: 'placed', reason: 'heavy-least-loaded' });
  });

  it('never to a small machine, however idle', () => {
    const reg = [m('mini', 10, 16, 0.05), m('studio', 16, 64, 0.9)];
    expect(exec.decide(req({ workWeight: 'heavy', machineRegistry: reg })).chosenMachine).toBe('studio');
  });

  it('only small machines → queued no-heavy-capable-machine', () => {
    const reg = [m('mini', 10, 16, 0.05), m('mamapc', 10, 12, 0.1)];
    expect(exec.decide(req({ workWeight: 'heavy', machineRegistry: reg }))).toMatchObject({ chosenMachine: null, outcome: 'queued', reason: 'no-heavy-capable-machine' });
  });

  it('big machines all busy → queued heavy-capable-machines-busy (never piled on)', () => {
    const reg = [m('studio', 16, 64, 1.5), m('laptop', 16, 128, 0.2, { loadVerdict: 'saturated' }), m('mini', 10, 16, 0.1)];
    expect(exec.decide(req({ workWeight: 'heavy', machineRegistry: reg }))).toMatchObject({ outcome: 'queued', reason: 'heavy-capable-machines-busy' });
  });

  it('a big machine with no fresh load is not eligible (load-unknown is never idle)', () => {
    const reg = [m('studio', 16, 64, 0.2, { loadReportAgeMs: 120_000, loadVerdict: 'unknown' })];
    expect(exec.decide(req({ workWeight: 'heavy', machineRegistry: reg })).outcome).toBe('queued');
  });

  it('override allow admits the Mini; deny removes a big machine', () => {
    const mini = m('mini', 10, 16, 0.1);
    mini.loadReport!.heavyWork = 'allow';
    expect(exec.decide(req({ workWeight: 'heavy', machineRegistry: [mini] })).chosenMachine).toBe('mini');
    const studio = m('studio', 16, 64, 0.1);
    studio.loadReport!.heavyWork = 'deny';
    expect(exec.decide(req({ workWeight: 'heavy', machineRegistry: [studio, m('m5pro', 18, 48, 0.5)] })).chosenMachine).toBe('m5pro');
  });

  it('pending heavy items push a machine over its headroom', () => {
    const reg = [m('m5pro', 18, 48, 0.6), m('studio', 16, 64, 0.8)];
    const busyM5 = new PlacementExecutor(undefined, { pendingHeavy: (id) => (id === 'm5pro' ? 1 : 0) });
    expect(exec.decide(req({ workWeight: 'heavy', machineRegistry: reg })).chosenMachine).toBe('m5pro');
    expect(busyM5.decide(req({ workWeight: 'heavy', machineRegistry: reg })).chosenMachine).toBe('studio');
  });

  it('the machine\'s own advertised heavyPending counts too', () => {
    const m5 = m('m5pro', 18, 48, 0.6);
    m5.loadReport!.heavyPending = 1;
    expect(exec.decide(req({ workWeight: 'heavy', machineRegistry: [m5, m('studio', 16, 64, 0.8)] })).chosenMachine).toBe('studio');
  });

  it('a hard pin is honoured only inside the heavy-eligible set', () => {
    const reg = [m('mini', 10, 16, 0.1), m('studio', 16, 64, 0.5)];
    expect(exec.decide(req({ workWeight: 'heavy', machineRegistry: reg, topicMetadata: { pinned: true, preferredMachine: 'mini' } })))
      .toMatchObject({ outcome: 'queued', reason: 'hard-pin-not-heavy-capable' });
    expect(exec.decide(req({ workWeight: 'heavy', machineRegistry: reg, topicMetadata: { pinned: true, preferredMachine: 'studio' } })))
      .toMatchObject({ chosenMachine: 'studio', reason: 'hard-pin' });
  });

  it('every machine quota-blocked → queued (no place-anyway fallback for a headless helper)', () => {
    const reg = [m('studio', 16, 64, 0.2, { quotaState: { blocked: true } })];
    expect(exec.decide(req({ workWeight: 'heavy', machineRegistry: reg }))).toMatchObject({ outcome: 'queued', reason: 'all-machines-quota-blocked' });
  });

  it('a refusing machine stays excluded for heavy work too', () => {
    const studio = m('studio', 16, 64, 0.2, { loadReportAgeMs: 5_000 });
    studio.loadReport!.admissionEnforced = true;
    studio.loadReport!.acceptingWork = false;
    expect(exec.decide(req({ workWeight: 'heavy', machineRegistry: [studio, m('m5pro', 18, 48, 0.9)] })).chosenMachine).toBe('m5pro');
  });
});

describe('standard work — size-aware scoring', () => {
  const exec = new PlacementExecutor();

  it('per-core load: a big machine at the same raw load beats a small one', () => {
    // Same raw load average 10: Studio 16 cores (0.625/core) vs Mini 10 cores (1.0/core).
    const reg = [m('mini', 10, 16, 1.0), m('studio', 16, 64, 0.625)];
    expect(exec.decide(req({ machineRegistry: reg })).chosenMachine).toBe('studio');
  });

  it('small machines stay eligible for conversations', () => {
    const reg = [m('mini', 10, 16, 0.1), m('studio', 16, 64, 1.4)];
    expect(exec.decide(req({ machineRegistry: reg })).chosenMachine).toBe('mini');
  });

  it('measured first: a machine with no fresh load never wins by scoring 0', () => {
    const blind = m('blind', 16, 64, null, { loadReportAgeMs: 120_000, loadVerdict: 'unknown' });
    const reg = [blind, m('m5pro', 18, 48, 0.9)];
    expect(exec.decide(req({ machineRegistry: reg })).chosenMachine).toBe('m5pro');
  });

  it('a stale raw load average does not count as measured', () => {
    const stale = m('stale', null, null, null, { loadAvg: 0, loadReport: undefined, loadReportAgeMs: undefined, routerReceivedAt: new Date(Date.now() - 5 * 60_000).toISOString() });
    const reg = [stale, m('m5pro', 18, 48, 0.9)];
    expect(exec.decide(req({ machineRegistry: reg })).chosenMachine).toBe('m5pro');
  });

  it('when nothing is measured, placement still places (today\'s behaviour)', () => {
    const a = m('a', null, null, null, { loadReport: undefined, loadReportAgeMs: undefined });
    expect(exec.decide(req({ machineRegistry: [a] }))).toMatchObject({ chosenMachine: 'a', outcome: 'placed' });
  });

  it('sticky\'s comparison ignores an unmeasured machine', () => {
    const cur = m('cur', 16, 64, 0.5);
    const blind = m('blind', 16, 64, null, { loadReportAgeMs: 120_000, loadVerdict: 'unknown' });
    const peer = m('peer', 16, 64, 0.49); // 0.01 per core = 0.08 on the 8-core scale, inside the 0.15 hysteresis
    expect(exec.decide(req({ currentOwner: 'cur', machineRegistry: [cur, blind, peer] }))).toMatchObject({ chosenMachine: 'cur', reason: 'sticky' });
  });

  it('the light weight adds no size filter', () => {
    const reg = [m('mini', 10, 16, 0.1), m('studio', 16, 64, 1.4)];
    expect(exec.decide(req({ workWeight: 'light', machineRegistry: reg })).chosenMachine).toBe('mini');
  });
});
