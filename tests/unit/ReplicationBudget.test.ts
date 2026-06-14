/**
 * Tier-1 unit tests for ReplicationBudget — Component 7 bounds (WS2 replicated-
 * store foundation, §8 + §8.1 Phase C).
 *
 * Covers (§12):
 *   #9  cross-kind fairness under BURST — a flood on kind A does NOT consume kind
 *       B's share.
 *   #15 sustained pressure — throttle CONTINUOUSLY surfaced; other kinds keep
 *       their share over multiple intervals.
 *   §8.1 Phase-C — budget = perPeer × online-count, hard ceiling, hysteresis on
 *       the multiplier (a transient spike does not widen; a loss shrinks immediately).
 *   #13 tombstone-horizon — a peer below oldestRetained is FORCED to a full
 *       snapshot re-join (delete-resurrection guard).
 *   coalescing — a burst on one recordKey collapses to the LATEST per interval.
 */

import { describe, it, expect } from 'vitest';

import {
  CoalescingReplicator,
  AggregateJournalBudget,
  PhaseCBudgetController,
  phaseCBudget,
  rejoinVerdict,
} from '../../src/core/ReplicationBudget.js';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';

function hlc(p: number, l: number, n: string): HlcTimestamp {
  return { physical: p, logical: l, node: n };
}

describe('CoalescingReplicator (§8 coalescing)', () => {
  it('collapses a burst on one key to the LATEST record', () => {
    const c = new CoalescingReplicator();
    c.stage('k1', 'v1', 10, hlc(1, 0, 'A'));
    c.stage('k1', 'v2', 10, hlc(2, 0, 'A')); // newer
    c.stage('k1', 'v1again', 10, hlc(1, 5, 'A')); // older — ignored
    const out = c.drain();
    expect(out).toHaveLength(1);
    expect(out[0].line).toBe('v2');
  });

  it('keeps distinct keys separate; drain clears for the next interval', () => {
    const c = new CoalescingReplicator();
    c.stage('k1', 'a', 5, hlc(1, 0, 'A'));
    c.stage('k2', 'b', 5, hlc(1, 0, 'A'));
    expect(c.pendingCount).toBe(2);
    expect(c.drain()).toHaveLength(2);
    expect(c.pendingCount).toBe(0);
  });
});

describe('AggregateJournalBudget — cross-kind fairness (§12 #9/#15)', () => {
  it('BURST: a flood on kind A does NOT consume kind B share (anti-starvation)', () => {
    const b = new AggregateJournalBudget();
    // Budget 100; A floods (1000), B modest (40). Fair split: B's 40 fits, A capped.
    const res = b.allocate(100, { A: 1000, B: 40 });
    expect(res.B.admittedBytes).toBe(40); // B keeps its full (modest) demand
    expect(res.B.throttled).toBe(false);
    expect(res.A.admittedBytes).toBe(60); // A gets the remainder, throttled
    expect(res.A.throttled).toBe(true);
    expect(res.A.throttledBytes).toBe(940);
  });

  it('a single chatty kind on an idle pool gets the WHOLE budget (fair, not wasteful)', () => {
    const b = new AggregateJournalBudget();
    const res = b.allocate(100, { A: 1000, B: 0 });
    expect(res.A.admittedBytes).toBe(100);
  });

  it('SUSTAINED: throttle is surfaced continuously across intervals; B never starves', () => {
    const b = new AggregateJournalBudget();
    for (let i = 0; i < 5; i++) {
      const res = b.allocate(100, { A: 1000, B: 40 });
      expect(res.B.admittedBytes).toBe(40); // B keeps its share EVERY interval
      expect(res.A.throttled).toBe(true);
    }
    const deg = b.getDegradation();
    expect(deg.throttledIntervals).toBe(5);
    expect(deg.perKindThrottledBytes.A).toBeGreaterThan(0);
    expect(deg.perKindThrottledBytes.B ?? 0).toBe(0); // B never throttled
  });

  it('zero budget with demand ⇒ everything throttled + surfaced (never a silent stall)', () => {
    const b = new AggregateJournalBudget();
    const res = b.allocate(0, { A: 50 });
    expect(res.A.admittedBytes).toBe(0);
    expect(res.A.throttled).toBe(true);
    expect(b.getDegradation().throttledIntervals).toBe(1);
  });
});

describe('Phase-C budget scaling (§8.1)', () => {
  it('phaseCBudget = perPeer × count, clamped to the hard ceiling', () => {
    expect(phaseCBudget(100, 3, 1000)).toBe(300);
    expect(phaseCBudget(100, 50, 1000)).toBe(1000); // ceiling binds
    expect(phaseCBudget(100, 0, 1000)).toBe(0);
  });

  it('hysteresis: a RISE only takes effect after it holds for the window', () => {
    let t = 0;
    const ctrl = new PhaseCBudgetController({ perPeerBytes: 100, hardCeilingBytes: 100000, hysteresisRiseMs: 1000 }, () => t);
    ctrl.observePeerCount(1); // start at 1
    expect(ctrl.getEffectivePeerCount()).toBe(1);
    ctrl.observePeerCount(3); // spike to 3 — not yet (pending)
    expect(ctrl.getEffectivePeerCount()).toBe(1);
    t = 500;
    ctrl.observePeerCount(3); // still within the window
    expect(ctrl.getEffectivePeerCount()).toBe(1);
    t = 1500;
    ctrl.observePeerCount(3); // held past the window ⇒ rise takes effect
    expect(ctrl.getEffectivePeerCount()).toBe(3);
    expect(ctrl.currentBudget()).toBe(300);
  });

  it('hysteresis: a transient SPIKE that retracts never widens the budget', () => {
    let t = 0;
    const ctrl = new PhaseCBudgetController({ perPeerBytes: 100, hardCeilingBytes: 100000, hysteresisRiseMs: 1000 }, () => t);
    ctrl.observePeerCount(1);
    t = 100; ctrl.observePeerCount(5); // spike
    t = 200; ctrl.observePeerCount(1); // retracts before the window elapses
    expect(ctrl.getEffectivePeerCount()).toBe(1); // never widened
  });

  it('a FALL takes effect immediately (shrink-on-loss is safe)', () => {
    let t = 0;
    const ctrl = new PhaseCBudgetController({ perPeerBytes: 100, hardCeilingBytes: 100000, hysteresisRiseMs: 1000 }, () => t);
    ctrl.observePeerCount(1);
    t = 2000; ctrl.observePeerCount(3); // rise (held)
    t = 4000; ctrl.observePeerCount(3);
    expect(ctrl.getEffectivePeerCount()).toBe(3);
    ctrl.observePeerCount(1); // immediate fall
    expect(ctrl.getEffectivePeerCount()).toBe(1);
  });
});

describe('tombstone-horizon re-join (§8 / §12 #13)', () => {
  it('a peer below oldestRetained is FORCED to a full snapshot re-join', () => {
    // peer lastHeld=5, holder oldestRetained=20 ⇒ the gap (incl. a possible delete
    // tombstone) rotated out ⇒ a stale tail would resurrect ⇒ force full snapshot.
    const v = rejoinVerdict(5, 20);
    expect(v.mode).toBe('full-snapshot');
    if (v.mode === 'full-snapshot') expect(v.reason).toBe('below-oldest-retained');
  });

  it('a peer within the retained window tails normally', () => {
    const v = rejoinVerdict(19, 20); // next-needed 20 === oldestRetained ⇒ contiguous
    expect(v.mode).toBe('tail');
    if (v.mode === 'tail') expect(v.fromSeq).toBe(19);
  });
});
