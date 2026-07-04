import { describe, it, expect } from 'vitest';
import {
  advanceSampler,
  isSamplerDead,
  EMPTY_SAMPLER_STATE,
  type SamplerState,
  type SamplerOpts,
} from '../../src/monitoring/ExternalHogSampler.js';
import type { ProcTableRow } from '../../src/monitoring/ExternalHogProcTable.js';
import type { ProcTree, OwnedRefs } from '../../src/monitoring/ExternalHogOwnership.js';

/**
 * ExternalHogSampler — the pure stage-1 candidacy state machine (CMT-1901, §1). Computes hog
 * candidates from successive ps snapshots via the cross-tick delta; excludes instar-own; keeps
 * a liveness heartbeat that advances only on a plausible parse.
 */

const OWN = 501;
const opts = (over: Partial<SamplerOpts> = {}): SamplerOpts => ({
  ownEuid: OWN,
  cpuCoreThreshold: 1.5,
  sampleWindowMs: 30_000,
  maxAncestorHops: 30,
  minPlausibleRows: 1,
  ...over,
});

function row(pid: number, cpu: number | undefined, opts: Partial<ProcTableRow> = {}): ProcTableRow {
  return { pid, ppid: 1, uid: OWN, startTime: `S${pid}`, cputimeSeconds: cpu, comm: `p${pid}`, ...opts };
}
const noTree: ProcTree = new Map();
const noOwned: OwnedRefs = new Map();

describe('advanceSampler — cross-tick delta candidacy', () => {
  it('first sight establishes a baseline, no candidate yet', () => {
    const t = advanceSampler(EMPTY_SAMPLER_STATE, [row(9000, 100)], noTree, noOwned, 0, opts());
    expect(t.candidates).toHaveLength(0);
    expect(t.parsedOk).toBe(true);
    expect(t.nextState.lastSnapshotAt).toBe(0);
  });
  it('a process pinning ~2 cores across the tick becomes a candidate', () => {
    const s1 = advanceSampler(EMPTY_SAMPLER_STATE, [row(9000, 100)], noTree, noOwned, 0, opts()).nextState;
    // +60 CPU-sec over 30s = 2.0 cores >= 1.5.
    const t2 = advanceSampler(s1, [row(9000, 160)], noTree, noOwned, 30_000, opts());
    expect(t2.candidates.map((c) => c.pid)).toEqual([9000]);
    expect(t2.candidates[0]!.coreEquivalents).toBeCloseTo(2.0, 5);
  });
  it('an EMERGENT hog (idle 23h, only now pinning cores) is caught by the delta', () => {
    // Baseline high cumulative (idle-but-old) then a big jump: the DELTA is what matters.
    const s1 = advanceSampler(EMPTY_SAMPLER_STATE, [row(9000, 100_000)], noTree, noOwned, 0, opts()).nextState;
    const t2 = advanceSampler(s1, [row(9000, 100_060)], noTree, noOwned, 30_000, opts());
    expect(t2.candidates.map((c) => c.pid)).toEqual([9000]);
  });
  it('a low-CPU process is NOT a candidate', () => {
    const s1 = advanceSampler(EMPTY_SAMPLER_STATE, [row(9000, 100)], noTree, noOwned, 0, opts()).nextState;
    const t2 = advanceSampler(s1, [row(9000, 101)], noTree, noOwned, 30_000, opts()); // 1 CPU-sec/30s = 0.03 core
    expect(t2.candidates).toHaveLength(0);
  });
});

describe('advanceSampler — exclusions', () => {
  it('a DIFFERENT-uid process is never a candidate', () => {
    const s1 = advanceSampler(EMPTY_SAMPLER_STATE, [row(9000, 100, { uid: 999 })], noTree, noOwned, 0, opts()).nextState;
    const t2 = advanceSampler(s1, [row(9000, 160, { uid: 999 })], noTree, noOwned, 30_000, opts());
    expect(t2.candidates).toHaveLength(0);
  });
  it('an instar-OWNED process is excluded (own build child not flagged)', () => {
    // 5000 is instar root (startTime R); 9000 is its child. ownedRefs matches 5000@R.
    const tree: ProcTree = new Map([
      [5000, { pid: 5000, ppid: 1, startTime: 'R' }],
      [9000, { pid: 9000, ppid: 5000, startTime: 'S9000' }],
    ]);
    const owned: OwnedRefs = new Map([[5000, 'R']]);
    const s1 = advanceSampler(EMPTY_SAMPLER_STATE, [row(9000, 100)], tree, owned, 0, opts()).nextState;
    const t2 = advanceSampler(s1, [row(9000, 160)], tree, owned, 30_000, opts());
    expect(t2.candidates).toHaveLength(0);
  });
  it('a non-positive sampleWindowMs (misconfig) yields NO false candidate (delta fails closed)', () => {
    // round-11 cross-module fix: a ≤0 window makes computeCoreEquivalents return UNKNOWN, so
    // even a huge cputime jump over a tiny Δwall cannot emit a false stage-1 candidate.
    const s1 = advanceSampler(EMPTY_SAMPLER_STATE, [row(9000, 100)], noTree, noOwned, 0, opts({ sampleWindowMs: 0 })).nextState;
    const t2 = advanceSampler(s1, [row(9000, 160)], noTree, noOwned, 50, opts({ sampleWindowMs: 0 }));
    expect(t2.candidates).toHaveLength(0);
  });
  it('a row with UNKNOWN cputime (malformed time) is never a candidate', () => {
    const s1 = advanceSampler(EMPTY_SAMPLER_STATE, [row(9000, 100)], noTree, noOwned, 0, opts()).nextState;
    const t2 = advanceSampler(s1, [row(9000, undefined)], noTree, noOwned, 30_000, opts());
    expect(t2.candidates).toHaveLength(0);
  });
});

describe('advanceSampler — liveness heartbeat', () => {
  it('advances on a plausible parse even with ZERO candidates (idle machine not sampler-dead)', () => {
    const t = advanceSampler(EMPTY_SAMPLER_STATE, [row(9000, 5)], noTree, noOwned, 12_345, opts());
    expect(t.parsedOk).toBe(true);
    expect(t.nextState.lastSnapshotAt).toBe(12_345);
  });
  it('a FAILED/empty parse does NOT advance the heartbeat and keeps the baseline', () => {
    const s1 = advanceSampler(EMPTY_SAMPLER_STATE, [row(9000, 100)], noTree, noOwned, 0, opts()).nextState;
    const t2 = advanceSampler(s1, [], noTree, noOwned, 30_000, opts()); // empty parse
    expect(t2.parsedOk).toBe(false);
    expect(t2.nextState.lastSnapshotAt).toBe(0); // unchanged
    expect(t2.nextState).toBe(s1); // baseline preserved
  });
  it('a non-finite clock read is treated as a failed parse (no advance)', () => {
    const t = advanceSampler(EMPTY_SAMPLER_STATE, [row(9000, 5)], noTree, noOwned, NaN, opts());
    expect(t.parsedOk).toBe(false);
  });
});

describe('isSamplerDead', () => {
  const st = (last: number | null): SamplerState => ({ prev: new Map(), lastSnapshotAt: last });
  it('never-run (null heartbeat) is NOT dead', () => {
    expect(isSamplerDead(st(null), 1_000_000, 120_000)).toBe(false);
  });
  it('a fresh heartbeat is not dead; a stale one is dead', () => {
    expect(isSamplerDead(st(1_000_000), 1_050_000, 120_000)).toBe(false);
    expect(isSamplerDead(st(1_000_000), 1_200_000, 120_000)).toBe(true);
  });
  it('a non-finite now does NOT declare dead (avoid a false restart on a bad clock)', () => {
    expect(isSamplerDead(st(1_000_000), NaN, 120_000)).toBe(false);
  });
});
