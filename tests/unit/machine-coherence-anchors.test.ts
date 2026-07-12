/**
 * M-P0 anchors — the identity-independent durable clock layer
 * (calm-transient-episode-alerting spec). Pins the exact convergence
 * obligations: onset survives identity churn/advances; participant-aware clear
 * (3-machine blinking laggard does not clear; singleton never clears);
 * accumulator bounded-gap + clamp arithmetic; ceiling on activeSkewMs with
 * "N successive advances still confirm"; gap-narrowing predicate (regression /
 * lateral / unparseable / past-max never advance); flap event = confirm +
 * genuine convergence; per-key 24 h derived latches (episode churn cannot
 * multiply); wave backstop threshold + dedupe.
 */
import { describe, it, expect } from 'vitest';
import {
  emptyAnchors,
  anchorKey,
  reconcileAnchors,
  recordConfirmTransition,
  decidePatchSkew,
  tryArmDerivedLatch,
  flapBrakeEligible,
  recordCalmOnsetAndCheckWave,
  isGapNarrowingAdvance,
  poolMaxVersion,
  type AnchorReconcileInput,
} from '../../src/monitoring/machineCoherenceAnchors.js';
import type { SkewRow } from '../../src/monitoring/machineCoherenceEvaluate.js';

const TICK = 30_000;
const T0 = 1_000_000_000;

function versionRow(versions: Record<string, string>): SkewRow {
  const vc: Record<string, string> = {};
  for (const [m, v] of Object.entries(versions)) vc[m] = v.replace(/[^a-z0-9-]/g, '-');
  return {
    identity: `version|instarVersion|${Object.entries(vc).map(([m, v]) => `${m}=${v}`).join(',')}`,
    dimension: 'version',
    key: 'instarVersion',
    participants: Object.keys(versions).sort(),
    valueClasses: vc,
    versionSeverity: 'patch-only',
  };
}

function input(over: Partial<AnchorReconcileInput> & { nowMs: number }): AnchorReconcileInput {
  return {
    tickMs: TICK,
    kTicks: 4,
    rows: [],
    comparedMachines: ['m1', 'm2'],
    versionsByMachine: {},
    resolveTicks: 3,
    retireAfterMs: 24 * 3_600_000,
    ...over,
  };
}

/** Drive N ticks of continuous skew with the given versions. */
function driveSkew(block: ReturnType<typeof emptyAnchors>, fromMs: number, ticks: number, versions: Record<string, string>, compared = ['m1', 'm2']) {
  let t = fromMs;
  for (let i = 0; i < ticks; i++) {
    t += TICK;
    reconcileAnchors(block, input({ nowMs: t, rows: [versionRow(versions)], comparedMachines: compared, versionsByMachine: versions }));
  }
  return t;
}

const K = anchorKey('version', 'instarVersion');

describe('M-P0 anchors — onset + accumulator', () => {
  it('onset survives identity churn: a version advance never resets skewOnsetAtMs or activeSkewMs', () => {
    const b = emptyAnchors();
    let t = driveSkew(b, T0, 10, { m1: '1.3.800', m2: '1.3.810' });
    const onset = b.entries[K].skewOnsetAtMs;
    const active = b.entries[K].activeSkewMs;
    expect(active).toBeGreaterThan(0);
    // the laggard advances a patch — NEW row identity in rowState terms; anchors must not care
    t = driveSkew(b, t, 10, { m1: '1.3.801', m2: '1.3.810' });
    expect(b.entries[K].skewOnsetAtMs).toBe(onset);
    expect(b.entries[K].activeSkewMs).toBeGreaterThan(active);
  });

  it('accumulator gap rule: a long gap (restart/offline) credits at most K ticks', () => {
    const b = emptyAnchors();
    const t = driveSkew(b, T0, 2, { m1: '1.3.800', m2: '1.3.810' });
    const before = b.entries[K].activeSkewMs;
    // 2 hours of silence, then one reconcile — credit clamps to K×tick, not 2h
    reconcileAnchors(b, input({ nowMs: t + 2 * 3_600_000, rows: [versionRow({ m1: '1.3.800', m2: '1.3.810' })], versionsByMachine: { m1: '1.3.800', m2: '1.3.810' } }));
    expect(b.entries[K].activeSkewMs - before).toBeLessThanOrEqual(4 * TICK);
  });

  it('accumulator clamps negative deltas to zero (wall-clock regression)', () => {
    const b = emptyAnchors();
    const t = driveSkew(b, T0, 3, { m1: '1.3.800', m2: '1.3.810' });
    const before = b.entries[K].activeSkewMs;
    reconcileAnchors(b, input({ nowMs: t - 60_000, rows: [versionRow({ m1: '1.3.800', m2: '1.3.810' })], versionsByMachine: { m1: '1.3.800', m2: '1.3.810' } }));
    expect(b.entries[K].activeSkewMs).toBe(before);
  });

  it('accumulator credits ONLY all-participants-present divergent ticks (departed laggard freezes the clock)', () => {
    const b = emptyAnchors();
    const t = driveSkew(b, T0, 3, { m1: '1.3.800', m2: '1.3.810' });
    const frozen = b.entries[K].activeSkewMs;
    // m1 (the laggard, a participant) departs; m2+m3 remain compared — the row may
    // even vanish while it's gone; the clock must FREEZE, not credit
    let t2 = t;
    for (let i = 0; i < 20; i++) {
      t2 += TICK;
      reconcileAnchors(b, input({ nowMs: t2, rows: [], comparedMachines: ['m2', 'm3'], versionsByMachine: { m2: '1.3.810', m3: '1.3.810' } }));
    }
    expect(b.entries[K].activeSkewMs).toBe(frozen);
    expect(b.entries[K].skewOnsetAtMs).not.toBe(0); // and it did NOT clear either
  });
});

describe('M-P0 anchors — participant-aware clear', () => {
  it('3-machine pool: the laggard blipping offline does NOT clear the onset (the round-2 hole)', () => {
    const b = emptyAnchors();
    const versions = { m1: '1.3.800', m2: '1.3.810', m3: '1.3.810' };
    const t = driveSkew(b, T0, 5, versions, ['m1', 'm2', 'm3']);
    // m1 goes offline; m2+m3 agree — WITHOUT participant awareness this "converges"
    let t2 = t;
    for (let i = 0; i < 10; i++) {
      t2 += TICK;
      reconcileAnchors(b, input({ nowMs: t2, rows: [], comparedMachines: ['m2', 'm3'], versionsByMachine: { m2: '1.3.810', m3: '1.3.810' } }));
    }
    expect(b.entries[K].skewOnsetAtMs).not.toBe(0);
  });

  it('a singleton compared set can never clear (vacuous truth)', () => {
    const b = emptyAnchors();
    const t = driveSkew(b, T0, 5, { m1: '1.3.800', m2: '1.3.810' });
    let t2 = t;
    for (let i = 0; i < 10; i++) {
      t2 += TICK;
      reconcileAnchors(b, input({ nowMs: t2, rows: [], comparedMachines: ['m1'], versionsByMachine: { m1: '1.3.810' } }));
    }
    expect(b.entries[K].skewOnsetAtMs).not.toBe(0);
  });

  it('genuine convergence (all participants present + agreeing, sustained) clears — and latches survive', () => {
    const b = emptyAnchors();
    const t = driveSkew(b, T0, 5, { m1: '1.3.800', m2: '1.3.810' });
    expect(tryArmDerivedLatch(b, 'version', 'instarVersion', 'stalled', t)).toBe(true);
    let t2 = t;
    for (let i = 0; i < 3; i++) {
      t2 += TICK;
      reconcileAnchors(b, input({ nowMs: t2, rows: [], comparedMachines: ['m1', 'm2'], versionsByMachine: { m1: '1.3.810', m2: '1.3.810' } }));
    }
    expect(b.entries[K].skewOnsetAtMs).toBe(0); // cleared
    // latch survives the clear: a re-skew within 24 h cannot re-fire :stalled
    expect(tryArmDerivedLatch(b, 'version', 'instarVersion', 'stalled', t2 + TICK)).toBe(false);
  });

  it('retirement drops the entry only after sustained absence (24 h)', () => {
    const b = emptyAnchors();
    const t = driveSkew(b, T0, 5, { m1: '1.3.800', m2: '1.3.810' });
    let t2 = t;
    for (let i = 0; i < 3; i++) {
      t2 += TICK;
      reconcileAnchors(b, input({ nowMs: t2, rows: [], versionsByMachine: { m1: '1.3.810', m2: '1.3.810' } }));
    }
    expect(b.entries[K].skewOnsetAtMs).toBe(0);
    // 1 h later: still present
    reconcileAnchors(b, input({ nowMs: t2 + 3_600_000, rows: [], versionsByMachine: {} }));
    expect(b.entries[K]).toBeDefined();
    // 25 h later: retired
    reconcileAnchors(b, input({ nowMs: t2 + 25 * 3_600_000, rows: [], versionsByMachine: {} }));
    expect(b.entries[K]).toBeUndefined();
  });
});

describe('M-P1 — decidePatchSkew (grace / extend / no-progress / ceiling)', () => {
  const cfg = { graceMs: 2_700_000, progressWindowMs: 1_800_000, ceilingMs: 10_800_000, progressExtensionEnabled: true };

  it('within grace: no confirm', () => {
    const b = emptyAnchors();
    const t = driveSkew(b, T0, 5, { m1: '1.3.800', m2: '1.3.810' });
    expect(decidePatchSkew(b, 'instarVersion', cfg, t, { m1: '1.3.800', m2: '1.3.810' })).toEqual({ confirm: false, reason: 'grace' });
  });

  it('past grace with a recent gap-narrowing advance: extend; without: confirm', () => {
    const b = emptyAnchors();
    // 95 ticks × 30s ≈ 47.5 min of active skew (past 45-min grace)
    let t = driveSkew(b, T0, 95, { m1: '1.3.800', m2: '1.3.810' });
    expect(decidePatchSkew(b, 'instarVersion', cfg, t, { m1: '1.3.800', m2: '1.3.810' }).confirm).toBe(true);
    // the laggard advances → observed by reconcile → extend
    t = driveSkew(b, t, 1, { m1: '1.3.801', m2: '1.3.810' });
    expect(decidePatchSkew(b, 'instarVersion', cfg, t, { m1: '1.3.801', m2: '1.3.810' })).toEqual({ confirm: false, reason: 'extend' });
  });

  it('N successive advances still confirm at the ceiling (advances cannot reset it)', () => {
    const b = emptyAnchors();
    let t = T0;
    let patch = 700;
    // crawling laggard: one patch per ~25 min (50 ticks), for > 3 h of active skew
    for (let hop = 0; hop < 10; hop++) {
      t = driveSkew(b, t, 50, { m1: `1.3.${patch}`, m2: '1.3.900' });
      patch += 1;
    }
    const d = decidePatchSkew(b, 'instarVersion', cfg, t, { m1: `1.3.${patch - 1}`, m2: '1.3.900' });
    expect(d).toEqual({ confirm: true, reason: 'ceiling' });
  });

  it('progressExtensionEnabled:false restores confirm-at-grace (rollback lever)', () => {
    const b = emptyAnchors();
    const t = driveSkew(b, T0, 95, { m1: '1.3.800', m2: '1.3.810' });
    driveSkew(b, t, 1, { m1: '1.3.801', m2: '1.3.810' }); // an advance that WOULD extend
    const d = decidePatchSkew(b, 'instarVersion', { ...cfg, progressExtensionEnabled: false }, t + TICK, { m1: '1.3.801', m2: '1.3.810' });
    expect(d.confirm).toBe(true);
  });
});

describe('gap-narrowing predicate', () => {
  it('advance toward pool max counts; regression / lateral / past-max / unparseable never do', () => {
    expect(isGapNarrowingAdvance('1.3.800', '1.3.801', '1.3.810')).toBe(true);
    expect(isGapNarrowingAdvance('1.3.800', '1.3.799', '1.3.810')).toBe(false); // regression
    expect(isGapNarrowingAdvance('1.3.800', '1.3.800', '1.3.810')).toBe(false); // lateral
    expect(isGapNarrowingAdvance('1.3.800', '99.0.0', '1.3.810')).toBe(false);  // past-max (forged)
    expect(isGapNarrowingAdvance('1.3.800', 'garbage', '1.3.810')).toBe(false); // unparseable
    expect(isGapNarrowingAdvance(undefined, '1.3.801', '1.3.810')).toBe(false); // baseline
    expect(isGapNarrowingAdvance('1.3.800', '1.3.810', '1.3.810')).toBe(true);  // reaching max is narrowing
  });

  it('poolMaxVersion picks the numeric max, ignoring unparseables', () => {
    expect(poolMaxVersion({ a: '1.3.810', b: '1.3.802', c: 'garbage' })).toBe('1.3.810');
  });
});

describe('flap brake + derived latches', () => {
  it('flap event = confirm transition FOLLOWED BY genuine convergence; 3 cycles arm the brake', () => {
    const b = emptyAnchors();
    let t = T0;
    for (let cycle = 0; cycle < 3; cycle++) {
      t = driveSkew(b, t, 5, { m1: '1.3.800', m2: '1.3.810' });
      recordConfirmTransition(b, 'version', 'instarVersion');
      for (let i = 0; i < 3; i++) {
        t += TICK;
        reconcileAnchors(b, input({ nowMs: t, rows: [], versionsByMachine: { m1: '1.3.810', m2: '1.3.810' } }));
      }
    }
    expect(flapBrakeEligible(b, 'version', 'instarVersion', 3, t)).toBe(true);
    expect(tryArmDerivedLatch(b, 'version', 'instarVersion', 'recurring', t)).toBe(true);
    expect(tryArmDerivedLatch(b, 'version', 'instarVersion', 'recurring', t + TICK)).toBe(false); // 24h latch
  });

  it('bare re-confirms without a heal never complete a cycle (never-healed = stall path, not flap)', () => {
    const b = emptyAnchors();
    let t = driveSkew(b, T0, 5, { m1: '1.3.800', m2: '1.3.810' });
    recordConfirmTransition(b, 'version', 'instarVersion');
    recordConfirmTransition(b, 'version', 'instarVersion'); // re-confirm, no heal between
    t = driveSkew(b, t, 5, { m1: '1.3.801', m2: '1.3.810' }); // identity re-mint, still skewed
    expect(flapBrakeEligible(b, 'version', 'instarVersion', 1, t)).toBe(false);
  });
});

describe('wave backstop', () => {
  it('fires once at the threshold, then dedupes for 24 h; disabled at threshold<=0', () => {
    const b = emptyAnchors();
    let fired = 0;
    for (let i = 0; i < 8; i++) {
      if (recordCalmOnsetAndCheckWave(b, T0 + i * 3_600_000, 6)) fired++;
    }
    expect(fired).toBe(1);
    const b2 = emptyAnchors();
    for (let i = 0; i < 8; i++) expect(recordCalmOnsetAndCheckWave(b2, T0 + i * 1000, 0)).toBe(false);
  });
});
