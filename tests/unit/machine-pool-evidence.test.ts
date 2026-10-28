/**
 * MachinePoolRegistry evidence slots + MachineEvidenceStore
 * (trustworthy-machine-load-and-mesh-floor spec, A1/A3/A4, B1 transport slot).
 *
 * The 2026-10-25 regression class: after a restart a peer read `online:false`
 * with no time; a coarse beat erased the load; re-reading a relayed record made
 * it look fresh. Each of those is pinned here.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MachinePoolRegistry } from '../../src/core/MachinePoolRegistry.js';
import { MachineEvidenceStore, EVIDENCE_PERSIST_INTERVAL_MS } from '../../src/core/MachineEvidenceStore.js';
import { clampLoadReport } from '../../src/core/machineLoadReport.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const T0 = 1_800_000_000_000;
const THRESH = 15 * 60_000;

function makeRegistry(opts: { now: () => number; evidenceStore?: MachineEvidenceStore | null; self?: string }) {
  return new MachinePoolRegistry({
    listMachines: () => [
      { machineId: 'm_self', nickname: 'Studio' },
      { machineId: 'm_pc', nickname: 'Mama PC' },
      { machineId: 'm_mini', nickname: 'Mac Mini' },
    ],
    clockSkewToleranceMs: 300_000,
    failoverThresholdMs: THRESH,
    now: opts.now,
    monoNow: opts.now,
    evidenceStore: opts.evidenceStore ?? null,
    selfMachineId: () => opts.self ?? 'm_self',
  });
}

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-evidence-')); });
afterEach(() => { SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/machine-pool-evidence.test.ts' }); });

describe('liveness on GET /pool capacities (A1/A2)', () => {
  it('a never-heard peer is unknown (not offline), and self is live', () => {
    const reg = makeRegistry({ now: () => T0 });
    const caps = Object.fromEntries(reg.getCapacities().map((c) => [c.machineId, c]));
    expect(caps.m_pc.liveness).toMatchObject({ state: 'unknown', source: 'none' });
    expect(caps.m_pc.online).toBe(false); // the placement flag keeps its semantics (A2)
    expect(caps.m_self.liveness).toMatchObject({ state: 'live', source: 'self' });
    expect(caps.m_pc.loadVerdict).toBe('unknown');
  });

  it('a live pull records direct evidence; a later failure flips it to unreachable with the failure shape', () => {
    let now = T0;
    const reg = makeRegistry({ now: () => now });
    reg.recordHeartbeat({ machineId: 'm_pc', selfReportedLastSeen: new Date(now).toISOString(), loadAvg: 11.5, rttMs: 820 });
    let cap = reg.getCapacity('m_pc')!;
    expect(cap.liveness).toMatchObject({ state: 'live', source: 'direct', evidenceAgeMs: 0 });
    expect(cap.lastDirectLoadAvg).toEqual({ value: 11.5, at: new Date(T0).toISOString() });
    expect(cap.lastPullRttMs).toBe(820);

    now += THRESH + 1;
    reg.recordPullFailure('m_pc', 'reset');
    cap = reg.getCapacity('m_pc')!;
    expect(cap.liveness).toMatchObject({ state: 'unreachable', shape: 'refusing', lastFailure: 'reset', source: 'direct', evidenceAgeMs: THRESH + 1 });
    // The last direct load stays visible with its own time (A3): it is not erased by the failure.
    expect(cap.lastDirectLoadAvg?.value).toBe(11.5);
  });

  it('a coarse (relayed) beat is stale evidence with its ORIGINAL age — re-recording never makes it younger', () => {
    let now = T0;
    const reg = makeRegistry({ now: () => now });
    const origin = new Date(T0 - 50 * 60_000).toISOString();
    reg.recordHeartbeat({ machineId: 'm_pc', selfReportedLastSeen: origin, coarseHeartbeat: true });
    expect(reg.getCapacity('m_pc')!.liveness).toMatchObject({ state: 'stale', source: 'relayed', evidenceAgeMs: 50 * 60_000 });
    now += 30_000;
    reg.recordHeartbeat({ machineId: 'm_pc', selfReportedLastSeen: origin, coarseHeartbeat: true });
    expect(reg.getCapacity('m_pc')!.liveness.evidenceAgeMs).toBe(50 * 60_000 + 30_000);
    // The legacy online flag still refreshes on a coarse beat (unchanged in P1).
    expect(reg.getCapacity('m_pc')!.online).toBe(true);
  });

  it('a relayed beat from the future is clamped to now (never negative age)', () => {
    const reg = makeRegistry({ now: () => T0 });
    reg.recordHeartbeat({ machineId: 'm_pc', selfReportedLastSeen: new Date(T0 + 3600_000).toISOString(), coarseHeartbeat: true });
    expect(reg.getCapacity('m_pc')!.liveness.evidenceAgeMs).toBe(0);
  });

  it('peer sightings are display-only: attached with the observer, never changing state or online', () => {
    const reg = makeRegistry({ now: () => T0 });
    reg.recordPeerSightings('m_mini', { m_pc: { ageMs: 180_000 }, m_self: { ageMs: 5 }, m_mini: { ageMs: 0 }, bad: { ageMs: -1 }, m_unknown_machine: { ageMs: 1 } });
    expect(reg.getCapacities().map((c) => c.machineId)).not.toContain('m_unknown_machine');
    const cap = reg.getCapacity('m_pc')!;
    expect(cap.online).toBe(false);
    expect(cap.liveness.state).toBe('unknown');
    expect(cap.liveness.peerSighting).toEqual({ observerMachineId: 'm_mini', ageMs: 180_000 });
    // The freshest sighting wins; a staler one later does not replace it.
    reg.recordPeerSightings('m_self', { m_pc: { ageMs: 900_000 } });
    expect(reg.getCapacity('m_pc')!.liveness.peerSighting?.observerMachineId).toBe('m_mini');
  });

  it('the sightings advert carries ONLY this process’s direct contacts, as ages', () => {
    let now = T0;
    const reg = makeRegistry({ now: () => now });
    reg.recordHeartbeat({ machineId: 'm_pc', selfReportedLastSeen: new Date(now).toISOString() });
    reg.recordHeartbeat({ machineId: 'm_mini', selfReportedLastSeen: new Date(now).toISOString(), coarseHeartbeat: true });
    reg.recordPeerSightings('m_mini', { m_pc: { ageMs: 1 } });
    now += 4000;
    expect(reg.getSightingsAdvert()).toEqual({ m_pc: { ageMs: 4000 } }); // coarse + sightings excluded
  });
});

describe('MachineEvidenceStore (A3) — a restart shows stale with the saved age, never offline', () => {
  it('persists the last direct contact and a fresh registry reads it as stale/saved with its load', () => {
    let now = T0;
    const store = new MachineEvidenceStore(tmp, () => now);
    const reg = makeRegistry({ now: () => now, evidenceStore: store });
    reg.recordHeartbeat({ machineId: 'm_pc', selfReportedLastSeen: new Date(now).toISOString(), loadAvg: 11.5 });
    expect(fs.existsSync(path.join(tmp, 'state', 'machine-direct-evidence.json'))).toBe(true);

    now += 20 * 60_000; // "restart" 20 min later: a new store + registry, nothing in memory
    const store2 = new MachineEvidenceStore(tmp, () => now);
    const reg2 = makeRegistry({ now: () => now, evidenceStore: store2 });
    const cap = reg2.getCapacity('m_pc')!;
    expect(cap.online).toBe(false);
    expect(cap.liveness).toMatchObject({ state: 'stale', source: 'saved', evidenceAgeMs: 20 * 60_000 });
    expect(cap.lastDirectLoadAvg).toEqual({ value: 11.5, at: new Date(T0).toISOString() });
  });

  it('persists at most once per interval per machine and never moves a record backwards', () => {
    let now = T0;
    const store = new MachineEvidenceStore(tmp, () => now);
    const file = path.join(tmp, 'state', 'machine-direct-evidence.json');
    store.record('m_pc', { receivedAtMs: now });
    const first = fs.statSync(file).mtimeMs;
    now += 1000;
    store.record('m_pc', { receivedAtMs: now, loadAvg: 2 });
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).machines.m_pc.receivedAtMs).toBe(T0); // not re-persisted yet
    expect(store.get('m_pc')?.receivedAtMs).toBe(T0 + 1000); // but in memory
    store.record('m_pc', { receivedAtMs: T0 - 5 }); // backwards: ignored
    expect(store.get('m_pc')?.receivedAtMs).toBe(T0 + 1000);
    now += EVIDENCE_PERSIST_INTERVAL_MS;
    store.record('m_pc', { receivedAtMs: now });
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).machines.m_pc.receivedAtMs).toBe(now);
    expect(fs.statSync(file).mtimeMs).toBeGreaterThanOrEqual(first);
  });

  it('a corrupt file starts empty (unknown), never invented data', () => {
    fs.mkdirSync(path.join(tmp, 'state'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'state', 'machine-direct-evidence.json'), '{not json');
    const store = new MachineEvidenceStore(tmp, () => T0);
    expect(store.get('m_pc')).toBeNull();
  });
});

describe('load report slot (B1): separate receipt, coarse beats carry it forward, 60 s expiry', () => {
  const report = clampLoadReport({ bootId: 'b', seq: 1, sampleAgeMs: 5000, verdict: 'saturated', cpuIdlePct: 3, loadPerCore: 2, memAvailablePct: 30 })!;

  it('a beat WITH a report stamps it; a coarse beat WITHOUT one carries it forward with the ORIGINAL age', () => {
    let now = T0;
    const reg = makeRegistry({ now: () => now });
    reg.recordHeartbeat({ machineId: 'm_pc', selfReportedLastSeen: new Date(now).toISOString(), loadReport: report });
    let cap = reg.getCapacity('m_pc')!;
    expect(cap.loadVerdict).toBe('saturated');
    expect(cap.loadReportAgeMs).toBe(5000);
    now += 20_000;
    reg.recordHeartbeat({ machineId: 'm_pc', selfReportedLastSeen: new Date(now).toISOString(), coarseHeartbeat: true });
    cap = reg.getCapacity('m_pc')!;
    expect(cap.loadReport).toBe(report);
    expect(cap.loadReportAgeMs).toBe(25_000);
    expect(cap.loadVerdict).toBe('saturated');
  });

  it('past 60 s of report age the verdict is unknown even though the machine was just contacted', () => {
    let now = T0;
    const reg = makeRegistry({ now: () => now });
    reg.recordHeartbeat({ machineId: 'm_pc', selfReportedLastSeen: new Date(now).toISOString(), loadReport: report });
    now += 56_000; // 5 s sample age + 56 s = 61 s
    reg.recordHeartbeat({ machineId: 'm_pc', selfReportedLastSeen: new Date(now).toISOString() }); // fresh contact, no report
    const cap = reg.getCapacity('m_pc')!;
    expect(cap.liveness.state).toBe('live');
    expect(cap.loadVerdict).toBe('unknown');
    expect(cap.loadReport).toBe(report); // retained for forensics, not treated as current
  });
});
