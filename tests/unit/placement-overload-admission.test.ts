/**
 * PlacementExecutor × overload admission (trustworthy-machine-load spec C1/C5):
 * a machine that REFUSES work on fresh, enforced evidence is never chosen; stale
 * or non-enforced evidence never reads as refusing; with every candidate
 * refusing the message is QUEUED (never pushed onto an overloaded machine); and
 * with ranking on, live ok/elevated machines beat unknown, which beat stale.
 */
import { describe, expect, it } from 'vitest';
import { PlacementExecutor, isRefusingWork, loadEvidenceTier, type PlacementRequest } from '../../src/core/PlacementExecutor.js';
import type { MachineCapacity } from '../../src/core/types.js';
import type { MachineLoadReport } from '../../src/core/machineLoadReport.js';

function report(over: Partial<MachineLoadReport> = {}): MachineLoadReport {
  return {
    bootId: 'b', seq: 1, sampleAgeMs: 0, platform: 'darwin', cores: 8, totalMemBytes: 1, loadPerCore: 0.5,
    cpuIdlePct: 60, memAvailablePct: 50, memPressureNative: 'normal', eventLoopLagP99Ms: 10,
    sessionsActive: 1, sessionsMax: 10, spawnCapSaturated: false, testRunnerSaturated: false,
    verdict: 'ok', uptimeS: 1000, ...over,
  };
}
function machine(id: string, over: Partial<MachineCapacity> = {}): MachineCapacity {
  return { machineId: id, online: true, clockSkewStatus: 'ok', loadAvg: 1, activeSessionCount: 1, maxSessions: 10, memPressure: 'low', capabilities: ['sessions'], ...over };
}
const refusing = (id: string, over: Partial<MachineCapacity> = {}) => machine(id, {
  loadAvg: 0, loadVerdict: 'saturated', loadReportAgeMs: 5_000,
  loadReport: report({ verdict: 'saturated', acceptingWork: false, admissionEnforced: true }),
  ...over,
});
function req(over: Partial<PlacementRequest> = {}): PlacementRequest {
  return { sessionKey: 's', topicMetadata: {}, machineRegistry: [], reason: 'new', ...over };
}

describe('isRefusingWork (C1: positive, fresh, enforced evidence only)', () => {
  it('fresh + enforced + acceptingWork:false → refusing', () => {
    expect(isRefusingWork(refusing('m'))).toBe(true);
  });
  it('dry-run (not enforced) never refuses, even when closed', () => {
    expect(isRefusingWork(refusing('m', { loadReport: report({ acceptingWork: false, admissionEnforced: false }) }))).toBe(false);
  });
  it('a report past the 60 s expiry never refuses (stale evidence is ranked lower, not excluded)', () => {
    expect(isRefusingWork(refusing('m', { loadReportAgeMs: 61_000 }))).toBe(false);
  });
  it('no report / older code (acceptingWork absent or null) never refuses', () => {
    expect(isRefusingWork(machine('m'))).toBe(false);
    expect(isRefusingWork(machine('m', { loadReport: report({ acceptingWork: null, admissionEnforced: true }), loadReportAgeMs: 1 }))).toBe(false);
  });
});

describe('PlacementExecutor.decide with refusing machines', () => {
  const exec = new PlacementExecutor();

  it('skips a refusing machine even when it is the least loaded', () => {
    const d = exec.decide(req({ machineRegistry: [refusing('overloaded'), machine('busy', { loadAvg: 6 })] }));
    expect(d).toMatchObject({ chosenMachine: 'busy', outcome: 'placed' });
  });

  it('queues when every candidate refuses — never pushes onto an overloaded machine', () => {
    const d = exec.decide(req({ machineRegistry: [refusing('a'), refusing('b')] }));
    expect(d).toMatchObject({ chosenMachine: null, outcome: 'queued', reason: 'all-machines-refusing-work', escalationReason: 'all-machines-refusing-work' });
  });

  it('a hard pin to a refusing machine queues (hard-pin-unavailable), it does not re-route', () => {
    const d = exec.decide(req({ topicMetadata: { preferredMachine: 'a', pinned: true }, machineRegistry: [refusing('a'), machine('b')] }));
    expect(d).toMatchObject({ chosenMachine: null, outcome: 'queued', reason: 'hard-pin-unavailable' });
  });

  it('sticky: the current owner is left when it starts refusing', () => {
    const d = exec.decide(req({ currentOwner: 'a', machineRegistry: [refusing('a'), machine('b', { loadAvg: 5 })] }));
    expect(d.chosenMachine).toBe('b');
  });

  it('a dry-run (non-enforced) closed machine is still placeable (today\'s behaviour)', () => {
    const d = exec.decide(req({ machineRegistry: [refusing('a', { loadReport: report({ acceptingWork: false, admissionEnforced: false }) }), machine('b', { loadAvg: 6 })] }));
    expect(d.chosenMachine).toBe('a');
  });
});

describe('C5 evidence ranking', () => {
  it('tiers: live ok/elevated < unknown < stale < unreachable', () => {
    expect(loadEvidenceTier(machine('a', { loadVerdict: 'ok', liveness: { state: 'live', evidenceAgeMs: 0, evidenceAt: 'x', source: 'direct' } }))).toBe(0);
    expect(loadEvidenceTier(machine('a', { loadVerdict: 'elevated' }))).toBe(0);
    expect(loadEvidenceTier(machine('a', { loadVerdict: 'unknown' }))).toBe(1);
    expect(loadEvidenceTier(machine('a'))).toBe(1);
    expect(loadEvidenceTier(machine('a', { loadVerdict: 'ok', liveness: { state: 'stale', evidenceAgeMs: 1, evidenceAt: 'x', source: 'saved' } }))).toBe(2);
    expect(loadEvidenceTier(machine('a', { liveness: { state: 'unreachable', evidenceAgeMs: 1, evidenceAt: 'x', source: 'direct' } }))).toBe(3);
  });

  it('ranking OFF (default): plain least-loaded, an unknown machine can still win on load', () => {
    const exec = new PlacementExecutor();
    const d = exec.decide(req({ machineRegistry: [machine('unknown', { loadAvg: 0 }), machine('known', { loadAvg: 2, loadVerdict: 'ok' })] }));
    expect(d.chosenMachine).toBe('unknown');
  });

  it('ranking ON: a live ok machine beats a lower-loaded unknown one; among a tier, least-loaded wins', () => {
    const exec = new PlacementExecutor(undefined, { overloadAwareRanking: () => true });
    const d = exec.decide(req({ machineRegistry: [machine('unknown', { loadAvg: 0 }), machine('known', { loadAvg: 2, loadVerdict: 'ok' }), machine('known2', { loadAvg: 3, loadVerdict: 'elevated' })] }));
    expect(d.chosenMachine).toBe('known');
  });

  it('ranking ON: with only unknown/stale machines, unknown beats stale; a broken seam keeps plain order', () => {
    const stale = machine('stale', { loadAvg: 0, liveness: { state: 'stale', evidenceAgeMs: 1, evidenceAt: 'x', source: 'saved' } });
    const unknown = machine('unknown', { loadAvg: 5 });
    expect(new PlacementExecutor(undefined, { overloadAwareRanking: () => true }).decide(req({ machineRegistry: [stale, unknown] })).chosenMachine).toBe('unknown');
    expect(new PlacementExecutor(undefined, { overloadAwareRanking: () => { throw new Error('x'); } }).decide(req({ machineRegistry: [stale, unknown] })).chosenMachine).toBe('stale');
  });
});
