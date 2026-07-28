/**
 * B4 (multimachine-lease-poll-robustness, Decision 10) — unit tests for the
 * skew-immune peer-liveness decision. Proves the flag-off legacy behavior, the
 * skew-immune path, the conservative direction, and the not-yet-observed edge.
 */

import { describe, it, expect } from 'vitest';
import { isPeerPresumedDead } from '../../src/core/leaseLiveness.js';

const FAILOVER = 15 * 60_000;
const NOW = 1_000_000_000;

describe('B4 isPeerPresumedDead — skew-immune lease liveness', () => {
  it('flag OFF → legacy lastSeen threshold (fresh = alive, stale = dead)', () => {
    expect(isPeerPresumedDead({
      lastSeenMs: NOW - 1000, routerObserved: false, routerOnline: false,
      nowMs: NOW, failoverThresholdMs: FAILOVER, skewImmune: false,
    })).toBe(false); // 1s ago → alive
    expect(isPeerPresumedDead({
      lastSeenMs: NOW - FAILOVER - 1, routerObserved: false, routerOnline: false,
      nowMs: NOW, failoverThresholdMs: FAILOVER, skewImmune: false,
    })).toBe(true); // past horizon → dead
  });

  it('flag ON + router observed → uses skew-immune online (ignores a skewed lastSeen)', () => {
    // A +Ns-fast peer writes a FUTURE lastSeen → legacy would call it alive.
    // Skew-immune router says it has NOT been heard from → presumed dead.
    expect(isPeerPresumedDead({
      lastSeenMs: NOW + 5 * 60_000, // future (fast clock) — legacy fooled into "alive"
      routerObserved: true, routerOnline: false,
      nowMs: NOW, failoverThresholdMs: FAILOVER, skewImmune: true,
    })).toBe(true); // skew-immune wins → dead

    // Inverse: a −Ns-slow peer writes a stale-looking lastSeen → legacy would
    // FALSE-failover. Skew-immune router says it's online → NOT dead (kills the flap).
    expect(isPeerPresumedDead({
      lastSeenMs: NOW - FAILOVER - 60_000, // looks dead by wall clock (slow peer)
      routerObserved: true, routerOnline: true,
      nowMs: NOW, failoverThresholdMs: FAILOVER, skewImmune: true,
    })).toBe(false); // skew-immune wins → alive
  });

  it('flag ON + observed-but-stale router → presumed dead EVEN WITH a fresh lastSeen (the load-bearing override)', () => {
    // The riskiest direction: the router has not heard from the peer in >horizon
    // (genuinely unreachable), but the peer\'s own clock wrote a recent lastSeen.
    // Skew-immune must override to DEAD — this is the override that makes failover
    // work under skew. (2nd-pass coverage request.)
    expect(isPeerPresumedDead({
      lastSeenMs: NOW - 1000, // fresh by the peer\'s own clock
      routerObserved: true, routerOnline: false, // but the router hasn\'t heard from it
      nowMs: NOW, failoverThresholdMs: FAILOVER, skewImmune: true,
    })).toBe(true);
  });

  it('flag ON but peer NOT yet observed this incarnation → falls back to lastSeen (convergence edge)', () => {
    // Known on disk (fresh lastSeen) but no routerReceivedAt yet (just booted).
    // Must NOT presume-dead a peer we simply haven\'t heard from in-process yet.
    expect(isPeerPresumedDead({
      lastSeenMs: NOW - 1000, routerObserved: false, routerOnline: false,
      nowMs: NOW, failoverThresholdMs: FAILOVER, skewImmune: true,
    })).toBe(false); // fallback to lastSeen → alive (NOT wrongly dead)
  });

  it('conservative: unknown/unparseable lastSeen with no router opinion → NOT presumed dead', () => {
    expect(isPeerPresumedDead({
      lastSeenMs: null, routerObserved: false, routerOnline: false,
      nowMs: NOW, failoverThresholdMs: FAILOVER, skewImmune: true,
    })).toBe(false);
    expect(isPeerPresumedDead({
      lastSeenMs: NaN, routerObserved: false, routerOnline: false,
      nowMs: NOW, failoverThresholdMs: FAILOVER, skewImmune: false,
    })).toBe(false);
  });
});
