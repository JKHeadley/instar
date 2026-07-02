/**
 * U4.4 — lease hand-back to the preferred captain (docs/specs/u4-4-lease-handback.md).
 *
 * Locks: hysteresis window arm/reset (absent rope snapshot ⇒ NOT healthy —
 * R-r2-7), clean-boundary predicate (each signal), deferral ceiling → relax +
 * ONE notice + queued inbound DRAINED before step-down (R-r2-6),
 * claim-before-release (a failed/declined/silent offer leaves the holder
 * holding — zero-holder impossibility), offer backoff + legacy-peer episode
 * stop (R-r2-3), operator latch (R-r2-5 — written by the flip action, never
 * inferred), churn-latch + split-brain suppression, the episode cap counting
 * OFFERS, the receiving-side typed offer decision, and the §5 enable
 * chokepoint (dryRun:false requires pollFollowsLease live).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LeaseHandbackReconciler,
  DEFAULT_LEASE_HANDBACK_CONFIG,
  HANDBACK_CONSENT_TTL_MS,
  HANDBACK_QUIET_INGRESS_MS,
  validateHandbackEnableChokepoint,
  decideHandbackOffer,
  type LeaseHandbackDeps,
  type LeaseHandbackConfig,
  type HandbackOfferResponse,
} from '../../src/core/LeaseHandbackReconciler.js';
import { writeHandbackLatch, readHandbackLatchUntilMs, readHandbackLatchRecord, clearHandbackLatch } from '../../src/core/handbackLatch.js';
import { setRopeHealthProvider, ropeReachableOnAnyRope } from '../../src/core/ropeHealth.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { HandbackConsentToken } from '../../src/core/FencedLease.js';

const HOLDER = 'm_standby';
const PREFERRED = 'm_captain';

interface Harness {
  r: LeaseHandbackReconciler;
  advance: (ms: number) => void;
  offers: Array<{ target: string; proposedEpoch: number }>;
  notices: Array<{ key: string; title: string }>;
  metrics: string[];
  drains: number[];
  set: {
    holdsLease: (v: boolean) => void;
    healthy: (v: boolean) => void;
    boundary: (v: { inFlightForwards?: boolean; queuedInbound?: number; msSinceLastIngress?: number | null }) => void;
    latchUntil: (v: number | null) => void;
    churn: (v: boolean) => void;
    splitBrain: (v: boolean) => void;
    offerResponse: (v: HandbackOfferResponse) => void;
    mintNull: (v: boolean) => void;
  };
}

function makeHarness(cfg?: Partial<LeaseHandbackConfig>): Harness {
  let wall = 1_000_000;
  let mono = 100_000;
  let holdsLease = true;
  let healthy = true;
  let boundary = { inFlightForwards: false, queuedInbound: 0, msSinceLastIngress: null as number | null };
  let latchUntil: number | null = null;
  let churn = false;
  let splitBrain = false;
  let offerResponse: HandbackOfferResponse = 'accept';
  let mintNull = false;
  const offers: Harness['offers'] = [];
  const notices: Harness['notices'] = [];
  const metrics: string[] = [];
  const drains: number[] = [];
  const config: LeaseHandbackConfig = { ...DEFAULT_LEASE_HANDBACK_CONFIG, enabled: true, dryRun: false, ...cfg };
  const deps: LeaseHandbackDeps = {
    config: () => config,
    selfMachineId: () => HOLDER,
    preferredAwakeMachineId: () => PREFERRED,
    holdsLease: () => holdsLease,
    currentEpoch: () => 7,
    preferredHealth: () => ({ heartbeatFresh: healthy, ropeReachable: healthy ? true : undefined, leaseEligible: true, quotaOk: true }),
    cleanBoundary: () => ({ ...boundary }),
    kickInboundDrain: () => drains.push(1),
    splitBrainActive: () => splitBrain,
    churnLatched: () => churn,
    recordChurnFlip: () => {},
    operatorLatchUntilMs: () => latchUntil,
    mintConsentToken: (target, ttlMs) =>
      mintNull
        ? null
        : ({ holder: HOLDER, epoch: 7, target, expiresAt: new Date(wall + ttlMs).toISOString(), nonce: 1, signature: 'sig' } as HandbackConsentToken),
    sendOffer: async (target, offer) => {
      offers.push({ target, proposedEpoch: offer.proposedEpoch });
      return offerResponse;
    },
    metric: (e) => metrics.push(e),
    notify: (key, title) => notices.push({ key, title }),
    now: () => wall,
    monotonicNow: () => mono,
  };
  const r = new LeaseHandbackReconciler(deps);
  return {
    r,
    advance: (ms) => {
      wall += ms;
      mono += ms;
    },
    offers,
    notices,
    metrics,
    drains,
    set: {
      holdsLease: (v) => (holdsLease = v),
      healthy: (v) => (healthy = v),
      boundary: (v) => (boundary = { ...boundary, ...v }),
      latchUntil: (v) => (latchUntil = v),
      churn: (v) => (churn = v),
      splitBrain: (v) => (splitBrain = v),
      offerResponse: (v) => (offerResponse = v),
      mintNull: (v) => (mintNull = v),
    },
  };
}

/** Drive the hysteresis window to ARMED (healthy for healthWindowMs). */
function armWindow(h: Harness) {
  h.r.observe(); // window-start
  h.advance(DEFAULT_LEASE_HANDBACK_CONFIG.healthWindowMs + 1_000);
  h.r.observe(); // armed (+ may fire)
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('LeaseHandbackReconciler — hysteresis (arm / reset)', () => {
  it('arms only after CONTINUOUS health for healthWindowMs; any unhealthy observation resets', () => {
    const h = makeHarness();
    h.r.observe();
    expect(h.r.status().state).toBe('window-open');
    h.advance(5 * 60_000);
    h.set.healthy(false); // one unhealthy observation
    h.r.observe();
    expect(h.r.status().state).toBe('observing');
    expect(h.metrics).toContain('window-reset');
    h.set.healthy(true);
    h.r.observe(); // fresh window
    h.advance(DEFAULT_LEASE_HANDBACK_CONFIG.healthWindowMs - 1_000);
    h.r.observe();
    expect(h.r.status().state).toBe('window-open'); // not yet armed
    h.advance(2_000);
    h.r.observe();
    expect(['armed', 'offer-in-flight']).toContain(h.r.status().state);
  });

  it('R-r2-7: an ABSENT rope-health snapshot reads NOT-healthy → defer (never a transfer on missing data)', () => {
    // The real seam: no provider registered ⇒ undefined ⇒ consumers defer.
    setRopeHealthProvider(null);
    expect(ropeReachableOnAnyRope(PREFERRED)).toBeUndefined();
    const h = makeHarness();
    // Simulate the seam's verdict: heartbeat fresh but ropeReachable undefined.
    (h as unknown as { r: LeaseHandbackReconciler }).r = new LeaseHandbackReconciler({
      config: () => ({ ...DEFAULT_LEASE_HANDBACK_CONFIG, enabled: true, dryRun: false }),
      selfMachineId: () => HOLDER,
      preferredAwakeMachineId: () => PREFERRED,
      holdsLease: () => true,
      currentEpoch: () => 7,
      preferredHealth: () => ({ heartbeatFresh: true, ropeReachable: undefined, leaseEligible: true, quotaOk: true }),
      cleanBoundary: () => ({ inFlightForwards: false, queuedInbound: 0, msSinceLastIngress: null }),
      kickInboundDrain: () => {},
      splitBrainActive: () => false,
      churnLatched: () => false,
      recordChurnFlip: () => {},
      operatorLatchUntilMs: () => null,
      mintConsentToken: () => null,
      sendOffer: async () => 'accept',
      metric: () => {},
      notify: () => {},
    });
    h.r.observe();
    expect(h.r.status().state).toBe('observing'); // deferred — never window-open
  });

  it('a throwing rope provider reads as no-data (fail toward holding)', () => {
    setRopeHealthProvider({ reachableOnAnyRope: () => { throw new Error('boom'); } });
    expect(ropeReachableOnAnyRope(PREFERRED)).toBeUndefined();
    setRopeHealthProvider(null);
  });

  it('unset preference / self-is-preferred / not-holder are strict no-ops', () => {
    const h = makeHarness();
    h.set.holdsLease(false);
    h.r.observe();
    expect(h.r.status().state).toBe('not-holder');
    expect(h.offers).toHaveLength(0);
  });
});

describe('LeaseHandbackReconciler — clean boundary + bounded deferral (R-r2-6)', () => {
  it('defers on EACH boundary signal (in-flight forwards / queued inbound / recent ingress)', () => {
    for (const b of [
      { inFlightForwards: true },
      { queuedInbound: 3 },
      { msSinceLastIngress: HANDBACK_QUIET_INGRESS_MS - 1_000 },
    ]) {
      const h = makeHarness();
      h.set.boundary(b);
      armWindow(h);
      expect(h.r.status().state).toBe('deferring');
      expect(h.offers).toHaveLength(0);
      expect(h.metrics).toContain('deferral');
    }
  });

  it('deferral ceiling → ONE deduped notice + relaxed boundary; queued inbound is DRAINED before step-down, never abandoned', async () => {
    const h = makeHarness();
    h.set.boundary({ queuedInbound: 2 });
    armWindow(h);
    // Push past the 2h ceiling.
    h.advance(DEFAULT_LEASE_HANDBACK_CONFIG.deferralCeilingMs + 60_000);
    h.r.observe();
    expect(h.notices.filter((n) => n.key === 'lease-handback-deferral-ceiling')).toHaveLength(1);
    expect(h.metrics).toContain('ceiling-relaxation');
    // Relaxed boundary with items still queued: kick the drain, DO NOT offer yet.
    expect(h.drains.length).toBeGreaterThan(0);
    expect(h.offers).toHaveLength(0);
    // Re-observe with queue still non-empty → still no offer, another drain kick.
    h.r.observe();
    expect(h.offers).toHaveLength(0);
    // Queue drained → the relaxed boundary fires the offer.
    h.set.boundary({ queuedInbound: 0, msSinceLastIngress: 10_000 /* still "not quiet" — relaxed ignores it */ });
    h.r.observe();
    await flush();
    expect(h.offers).toHaveLength(1);
    // The notice stays ONE (deduped).
    expect(h.notices.filter((n) => n.key === 'lease-handback-deferral-ceiling')).toHaveLength(1);
  });
});

describe('LeaseHandbackReconciler — claim-before-release (zero-holder impossibility)', () => {
  it('an accepted offer does NOT step down until the higher epoch is OBSERVED (holdsLease flips)', async () => {
    const h = makeHarness();
    armWindow(h);
    await flush();
    expect(h.offers).toHaveLength(1);
    expect(h.metrics).toContain('claim');
    // Still holding: no step-down yet.
    expect(h.metrics).not.toContain('step-down');
    // The preferred captain's fenced claim lands → we observe not-holder.
    h.set.holdsLease(false);
    h.r.observe();
    expect(h.metrics).toContain('step-down');
    expect(h.r.status().state).toBe('handed-back');
  });

  it('failed-handback-never-leaves-zero-holders: decline/timeout leaves the holder HOLDING with widened backoff', async () => {
    for (const resp of ['timeout', 'declined:other', 'declined:quota', 'declined:churn-latched'] as const) {
      const h = makeHarness();
      h.set.offerResponse(resp);
      armWindow(h);
      await flush();
      expect(h.offers).toHaveLength(1);
      expect(h.metrics).toContain('failure');
      // Immediately re-observe: the offer backoff (R-r2-3) blocks a re-offer.
      h.r.observe();
      await flush();
      expect(h.offers).toHaveLength(1);
      // Still the holder (nothing stepped down).
      expect(h.metrics).not.toContain('step-down');
      // Backoff widens: after 5 min the first retry window opens.
      h.advance(5 * 60_000 + 1_000);
      h.r.observe();
      await flush();
      if (resp === 'declined:churn-latched' || resp === 'declined:quota' || resp === 'declined:other' || resp === 'timeout') {
        expect(h.offers.length).toBeLessThanOrEqual(2); // bounded, never a stream
      }
    }
  });

  it('a legacy peer (403/no-handler → declined:legacy-peer) STOPS re-offering for the episode (version skew)', async () => {
    const h = makeHarness();
    h.set.offerResponse('declined:legacy-peer');
    armWindow(h);
    await flush();
    expect(h.offers).toHaveLength(1);
    // Advance well past any backoff — the episode stop holds.
    h.advance(60 * 60_000);
    h.r.observe();
    await flush();
    expect(h.offers).toHaveLength(1);
  });

  it('a refused mint (not actually holding) sends nothing', async () => {
    const h = makeHarness();
    h.set.mintNull(true);
    armWindow(h);
    await flush();
    expect(h.offers).toHaveLength(0);
  });
});

describe('LeaseHandbackReconciler — the human always wins + composition', () => {
  it('operator latch fully inerts the reconciler and is visible in status (R-r2-5)', () => {
    const h = makeHarness();
    h.set.latchUntil(2_000_000);
    h.r.observe();
    expect(h.r.status().state).toBe('latched');
    expect(h.r.status().latchSuppressedUntil).toBeTruthy();
    expect(h.metrics).toContain('suppressed-by-latch');
    expect(h.offers).toHaveLength(0);
  });

  it('a LATCHED churn breaker suppresses hand-back (breaker wins)', () => {
    const h = makeHarness();
    h.set.churn(true);
    h.r.observe();
    expect(h.r.status().state).toBe('suppressed-churn');
    expect(h.offers).toHaveLength(0);
  });

  it('split-brain suppresses (reconciliation waits for a settled mesh)', () => {
    const h = makeHarness();
    h.set.splitBrain(true);
    h.r.observe();
    expect(h.r.status().state).toBe('suppressed-split-brain');
  });

  it('episode cap counts OFFERS too (R-r2-3): at the cap → sticky + ONE deduped item', async () => {
    const h = makeHarness({ maxPerWindow: 2 });
    h.set.offerResponse('declined:other');
    armWindow(h);
    await flush(); // offer 1
    h.advance(6 * 60_000);
    h.r.observe();
    await flush(); // offer 2 (after backoff)
    h.advance(20 * 60_000);
    h.r.observe(); // now at the cap → sticky
    expect(h.offers).toHaveLength(2);
    expect(h.r.status().state).toBe('episode-cap-sticky');
    expect(h.notices.filter((n) => n.key === 'lease-handback-episode-cap')).toHaveLength(1);
    h.advance(60_000);
    h.r.observe();
    expect(h.notices.filter((n) => n.key === 'lease-handback-episode-cap')).toHaveLength(1); // ONE
  });

  it('dry-run logs ONE would-hand-back and sends NOTHING', async () => {
    const h = makeHarness({ dryRun: true });
    armWindow(h);
    await flush();
    h.r.observe();
    await flush();
    expect(h.offers).toHaveLength(0);
    expect(h.metrics.filter((m) => m === 'would-hand-back')).toHaveLength(1);
  });
});

describe('decideHandbackOffer — the receiving side (typed declines, R-r2-2)', () => {
  const base = {
    enabled: true,
    selfMachineId: PREFERRED,
    preferredAwakeMachineId: PREFERRED,
    churnLatched: false,
    quotaBlocked: false,
    tokenAlreadyUsed: false,
  };
  it('accepts only when enabled + self-agrees-preferred + fresh token + no latch/quota', () => {
    expect(decideHandbackOffer(base)).toBe('accept');
  });
  it('feature dark here ⇒ declined:legacy-peer (cannot hand-back)', () => {
    expect(decideHandbackOffer({ ...base, enabled: false })).toBe('declined:legacy-peer');
  });
  it('config disagreement (self is not the preferred captain) ⇒ declined:legacy-peer', () => {
    expect(decideHandbackOffer({ ...base, preferredAwakeMachineId: 'someone-else' })).toBe('declined:legacy-peer');
    expect(decideHandbackOffer({ ...base, selfMachineId: null })).toBe('declined:legacy-peer');
  });
  it('a replayed offer never re-authorizes (single-use token)', () => {
    expect(decideHandbackOffer({ ...base, tokenAlreadyUsed: true })).toBe('declined:other');
  });
  it('churn-latched and quota-blocked decline typed', () => {
    expect(decideHandbackOffer({ ...base, churnLatched: true })).toBe('declined:churn-latched');
    expect(decideHandbackOffer({ ...base, quotaBlocked: true })).toBe('declined:quota');
  });
});

describe('validateHandbackEnableChokepoint — §5 HARD graduation dependency', () => {
  it('config validation refuses dryRun:false without pollFollowsLease live', () => {
    expect(validateHandbackEnableChokepoint({ enabled: true, dryRun: false }, false, true)).toMatch(/pollFollowsLease/);
  });
  it('dark or dry-run configurations pass (nothing to refuse)', () => {
    expect(validateHandbackEnableChokepoint({ enabled: false, dryRun: false }, false, true)).toBeNull();
    expect(validateHandbackEnableChokepoint({ enabled: true, dryRun: true }, false, true)).toBeNull();
  });
  it('pollFollowsLease live — or no poller split — waives the refusal', () => {
    expect(validateHandbackEnableChokepoint({ enabled: true, dryRun: false }, true, true)).toBeNull();
    expect(validateHandbackEnableChokepoint({ enabled: true, dryRun: false }, false, false)).toBeNull();
  });
});

describe('handbackLatch — the machine-local operator-flip marker (R-r2-5)', () => {
  it('write → read → clear roundtrip; an expired latch reads as none; malformed reads as none', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-latch-'));
    try {
      expect(readHandbackLatchUntilMs(dir)).toBeNull(); // absent = no latch
      const rec = writeHandbackLatch(dir, 60_000, 'operator flip', 1_000_000);
      expect(rec.reason).toBe('operator flip');
      expect(readHandbackLatchUntilMs(dir, 1_030_000)).toBe(1_060_000);
      expect(readHandbackLatchRecord(dir)?.reason).toBe('operator flip');
      // Expired-but-present marker reads as NO latch.
      expect(readHandbackLatchUntilMs(dir, 2_000_000)).toBeNull();
      // Malformed marker reads as no latch (the reconciler's other bounds still apply).
      fs.writeFileSync(path.join(dir, 'state', 'handback-operator-latch.json'), '{not json');
      expect(readHandbackLatchUntilMs(dir)).toBeNull();
      expect(readHandbackLatchRecord(dir)).toBeNull();
      clearHandbackLatch(dir); // idempotent
      expect(readHandbackLatchUntilMs(dir)).toBeNull();
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/LeaseHandbackReconciler.test.ts' });
    }
  });

  it('a transfer WITHOUT the marker never latches (attribution is mechanical, never inferred)', () => {
    // The reconciler consults ONLY operatorLatchUntilMs — there is no transfer-origin
    // inference path. Assert the source keeps that promise.
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/core/LeaseHandbackReconciler.ts'), 'utf-8');
    expect(src).not.toMatch(/transferOrigin|inferLatch/);
    const h = makeHarness();
    // No latch written → observe proceeds normally (window opens).
    h.r.observe();
    expect(h.r.status().state).toBe('window-open');
  });

  it('the consent-token TTL constant stays short (one offer round-trip plus slack)', () => {
    expect(HANDBACK_CONSENT_TTL_MS).toBeLessThanOrEqual(120_000);
  });
});
