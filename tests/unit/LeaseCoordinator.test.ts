/**
 * Tier-1 tests for LeaseCoordinator — drives FencedLease over a (fake) durable
 * store + (fake) tunnel. Covers acquisition, CAS contention, presumed-dead
 * takeover, the tunnel-renewal self-suspend, the max(tunnel,git) fencing view,
 * and unresolvable-split escalation. Real Ed25519 keys.
 */

import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import { FencedLease, type LeaseCrypto } from '../../src/core/FencedLease.js';
import { LeaseCoordinator, type LeaseStore, type LeaseTransport } from '../../src/core/LeaseCoordinator.js';
import type { LeaseRecord } from '../../src/core/types.js';

function genKey() {
  return crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}
const KEYS: Record<string, { publicKey: string; privateKey: string }> = { A: genKey(), B: genKey() };
function crypt(self: string): LeaseCrypto {
  return {
    selfMachineId: self,
    sign: (c) => crypto.sign(null, Buffer.from(c), KEYS[self].privateKey).toString('base64'),
    verify: (c, sig, holder) => {
      const pub = KEYS[holder]?.publicKey;
      if (!pub) return false;
      try { return crypto.verify(null, Buffer.from(c), pub, Buffer.from(sig, 'base64')); } catch { return false; }
    },
  };
}

const TTL = 60_000;
const FAILOVER = 15 * 60_000;

/** In-memory durable store with optional pre-write contention injection. */
class FakeStore implements LeaseStore {
  lease: LeaseRecord | null = null;
  epoch = 0;
  /** If set, runs before each casWrite to simulate a peer advancing. */
  beforeWrite?: () => void;
  /** Controls whether a same-epoch refresh push succeeds (git reachability). */
  refreshOk = true;
  read() { return { lease: this.lease, epoch: this.epoch }; }
  refresh(lease: LeaseRecord) {
    if (!this.refreshOk) return false;
    if ((this.lease?.epoch ?? 0) > lease.epoch) return false;
    this.lease = lease;
    return true;
  }
  casWrite(candidate: LeaseRecord) {
    this.beforeWrite?.();
    // Fast-forward accepted only if candidate strictly advances by exactly +1
    // over the CURRENT committed epoch (anything else = lost the race).
    if (candidate.epoch === this.epoch + 1) {
      this.lease = candidate;
      this.epoch = candidate.epoch;
      return { ok: true, observed: { lease: this.lease, epoch: this.epoch } };
    }
    return { ok: false, observed: { lease: this.lease, epoch: this.epoch } };
  }
}

function makeFlA() { return new FencedLease(crypt('A'), { leaseTtlMs: TTL, failoverThresholdMs: FAILOVER }); }
function makeFlB() { return new FencedLease(crypt('B'), { leaseTtlMs: TTL, failoverThresholdMs: FAILOVER }); }

describe('LeaseCoordinator', () => {
  it('acquires from empty and reports holding', async () => {
    const store = new FakeStore();
    const lc = new LeaseCoordinator({
      lease: makeFlA(), store, presumedDeadHolders: () => new Set(), now: () => 1_000,
    });
    expect(await lc.acquireIfEligible()).toBe(true);
    expect(lc.holdsLease()).toBe(true);
    expect(lc.currentEpoch()).toBe(1);
    expect(lc.currentHolder()).toBe('A');
  });

  it('cannot acquire a live peer-held lease, can take a presumed-dead one', async () => {
    const store = new FakeStore();
    // B holds epoch 1.
    store.lease = makeFlB().buildAcquisition(undefined, 500, 1);
    store.epoch = 1;
    let dead = new Set<string>();
    const lc = new LeaseCoordinator({
      lease: makeFlA(), store, presumedDeadHolders: () => dead, now: () => 2_000,
    });
    expect(await lc.acquireIfEligible()).toBe(false); // B live
    dead = new Set(['B']);
    expect(await lc.acquireIfEligible()).toBe(true); // B presumed dead → A takes over
    expect(lc.currentEpoch()).toBe(2);
    expect(lc.currentHolder()).toBe('A');
  });

  it('CAS contention: yields when a live peer advances the epoch mid-flight', async () => {
    const store = new FakeStore();
    const lc = new LeaseCoordinator({
      lease: makeFlA(), store, presumedDeadHolders: () => new Set(), now: () => 1_000,
    });
    // Just before A's write lands, B sneaks in epoch 1 (live, not dead).
    store.beforeWrite = () => {
      if (store.epoch === 0) {
        store.lease = makeFlB().buildAcquisition(undefined, 900, 1);
        store.epoch = 1;
      }
    };
    const got = await lc.acquireIfEligible();
    expect(got).toBe(false); // A's epoch-1 candidate is rejected; B (live) holds it
    expect(store.lease?.holder).toBe('B');
  });

  it('self-suspends when the tunnel is unreachable past leaseTtlMs', async () => {
    const store = new FakeStore();
    let reachable = true;
    let now = 1_000;
    const onSelfSuspend = vi.fn();
    const tunnel: LeaseTransport = {
      broadcast: async () => reachable,
      observed: () => ({ lease: null, lastNonceByHolder: {} }),
      isReachable: () => reachable,
    };
    const lc = new LeaseCoordinator({
      lease: makeFlA(), store, tunnel, presumedDeadHolders: () => new Set(),
      now: () => now, monotonicNow: () => now, onSelfSuspend,
    });
    expect(await lc.acquireIfEligible()).toBe(true);
    // Tunnel goes dark; advance time past TTL and renew. The self-fence is judged
    // on the monotonic clock (here tied to `now`), per spec §L−1.
    reachable = false;
    now = 1_000 + TTL + 1;
    expect(await lc.renew()).toBe(false);
    expect(onSelfSuspend).toHaveBeenCalledTimes(1);
    expect(lc.holdsLease()).toBe(false); // suspended → no authority
  });

  it('git-only: self-suspends when the durable refresh cannot push past leaseTtlMs', async () => {
    const store = new FakeStore();
    let now = 1_000;
    const onSelfSuspend = vi.fn();
    const lc = new LeaseCoordinator({
      lease: makeFlA(), store, presumedDeadHolders: () => new Set(),
      now: () => now, monotonicNow: () => now, onSelfSuspend,
    });
    expect(await lc.acquireIfEligible()).toBe(true);
    // Git push (refresh) starts failing — partitioned holder.
    store.refreshOk = false;
    now = 1_000 + TTL + 1;
    expect(await lc.renew()).toBe(false);
    expect(onSelfSuspend).toHaveBeenCalledTimes(1);
    expect(lc.holdsLease()).toBe(false);
  });

  it('a reachable tunnel keeps the lease alive across renewals', async () => {
    const store = new FakeStore();
    let now = 1_000;
    const tunnel: LeaseTransport = {
      broadcast: async () => true,
      observed: () => ({ lease: null, lastNonceByHolder: {} }),
      isReachable: () => true,
    };
    const lc = new LeaseCoordinator({
      lease: makeFlA(), store, tunnel, presumedDeadHolders: () => new Set(), now: () => now,
    });
    await lc.acquireIfEligible();
    now += TTL * 2;
    expect(await lc.renew()).toBe(true);
    expect(lc.holdsLease()).toBe(true);
  });

  it('escalates an unresolvable split (dead holder + tunnel down)', async () => {
    const store = new FakeStore();
    store.lease = makeFlB().buildAcquisition(undefined, 500, 1);
    store.epoch = 1;
    const onEscalate = vi.fn();
    const tunnel: LeaseTransport = {
      broadcast: async () => false,
      observed: () => ({ lease: null, lastNonceByHolder: {} }),
      isReachable: () => false,
    };
    const lc = new LeaseCoordinator({
      lease: makeFlA(), store, tunnel, presumedDeadHolders: () => new Set(['B']),
      now: () => 2_000, onEscalate,
    });
    lc.checkForUnresolvableSplit('episode-1');
    expect(onEscalate).toHaveBeenCalledTimes(1);
    expect(onEscalate.mock.calls[0][0].holder).toBe('B');
  });

  it('fires onEpochAdvance when the epoch moves', async () => {
    const store = new FakeStore();
    const onEpochAdvance = vi.fn();
    const lc = new LeaseCoordinator({
      lease: makeFlA(), store, presumedDeadHolders: () => new Set(), now: () => 1_000, onEpochAdvance,
    });
    await lc.acquireIfEligible();
    expect(onEpochAdvance).toHaveBeenCalledWith(1);
  });

  // ── Monotonic self-fence (Session Pool §L−1 — the router-lease robustness fold-in) ──
  describe('monotonic self-fence (spec §L−1)', () => {
    it('self-suspends on a backward WALL-clock jump (NTP step) once the MONOTONIC TTL elapses', async () => {
      // The exact bug class the spec §L−1 + SleepWakeDetector lesson guard against:
      // the wall clock jumps BACKWARD (e.g. NTP corrects a fast clock), so a
      // wall-clock self-suspend (`now - lastRenewOkAt > ttl`) would compute a
      // NEGATIVE elapsed and NEVER fire — a partitioned holder keeps acting.
      // The monotonic clock cannot jump backward, so the self-fence still fires.
      const store = new FakeStore();
      let wall = 100_000; // wall clock
      let mono = 100_000; // monotonic clock (separate, controllable)
      const onSelfSuspend = vi.fn();
      const lc = new LeaseCoordinator({
        lease: makeFlA(), store, presumedDeadHolders: () => new Set(),
        now: () => wall, monotonicNow: () => mono, onSelfSuspend,
      });
      expect(await lc.acquireIfEligible()).toBe(true);
      // Partition: git refresh now fails.
      store.refreshOk = false;
      // Real time elapses past the TTL (monotonic advances)...
      mono = 100_000 + TTL + 1;
      // ...but the WALL clock jumps BACKWARD (NTP correction). A wall-clock
      // self-suspend would see elapsed = (50_000 - 100_000) = -50_000 < TTL and
      // WRONGLY keep the lease. The monotonic fence ignores the wall jump.
      wall = 50_000;
      expect(await lc.renew()).toBe(false);
      expect(onSelfSuspend).toHaveBeenCalledTimes(1);
      expect(lc.holdsLease()).toBe(false);
    });

    it('holdsLease() fences a holder past the monotonic TTL even before renew() runs', async () => {
      // The hot-path authority check must not grant authority to a holder that
      // has not confirmed a renewal within the monotonic TTL — independent of
      // the wall-clock expiry (which here is frozen, so isExpired would pass).
      const store = new FakeStore();
      const wall = 100_000; // frozen wall clock → wall-clock expiry never passes
      let mono = 100_000;
      const lc = new LeaseCoordinator({
        lease: makeFlA(), store, presumedDeadHolders: () => new Set(),
        now: () => wall, monotonicNow: () => mono,
      });
      expect(await lc.acquireIfEligible()).toBe(true);
      expect(lc.holdsLease()).toBe(true); // just acquired → monotonic elapsed ~0
      // No renew happens; monotonic time passes the TTL.
      mono = 100_000 + TTL + 1;
      expect(lc.holdsLease()).toBe(false); // monotonic self-fence, despite frozen wall clock
    });

    it('uses the REAL monotonic clock by default (no injection) — production wiring integrity', async () => {
      // Proves the default `process.hrtime` path (not just the injected fake) is
      // wired: a freshly-acquired holder holds, because real monotonic elapsed is
      // ~0 ≪ TTL. This is what the server constructs (no monotonicNow injection).
      const store = new FakeStore();
      const lc = new LeaseCoordinator({
        lease: makeFlA(), store, presumedDeadHolders: () => new Set(), now: () => Date.now(),
        // no monotonicNow → exercises the default process.hrtime monotonic clock
      });
      expect(await lc.acquireIfEligible()).toBe(true);
      expect(lc.holdsLease()).toBe(true);
    });

    it('a confirmed renewal resets the monotonic self-fence clock', async () => {
      const store = new FakeStore();
      const wall = 100_000;
      let mono = 100_000;
      const lc = new LeaseCoordinator({
        lease: makeFlA(), store, presumedDeadHolders: () => new Set(),
        now: () => wall, monotonicNow: () => mono,
      });
      expect(await lc.acquireIfEligible()).toBe(true);
      // Advance most of the TTL, then renew successfully (git refresh ok).
      mono = 100_000 + TTL - 10;
      expect(await lc.renew()).toBe(true);
      // The renewal reset the monotonic mark; advancing another (TTL - 10) keeps it live.
      mono = 100_000 + (TTL - 10) + (TTL - 10);
      expect(lc.holdsLease()).toBe(true);
    });
  });

  describe('acquireOnConsent (planned-handoff yield, §8 G3e)', () => {
    it('takes a LIVE peer-held lease when that peer yielded (the consent bypass)', async () => {
      const store = new FakeStore();
      store.lease = makeFlB().buildAcquisition(undefined, 500, 1); // B holds, LIVE
      store.epoch = 1;
      // No presumed-dead, B is live → ordinary acquire would refuse.
      const lc = new LeaseCoordinator({
        lease: makeFlA(), store, presumedDeadHolders: () => new Set(), now: () => 2_000,
      });
      expect(await lc.acquireIfEligible()).toBe(false); // B live → normal path refuses
      // But B explicitly yielded → consent path takes it, advancing the epoch.
      expect(await lc.acquireOnConsent('B')).toBe(true);
      expect(lc.holdsLease()).toBe(true);
      expect(lc.currentHolder()).toBe('A');
      expect(lc.currentEpoch()).toBe(2);
    });

    it('SECURITY: refuses a yield from a machine that is NOT the current holder', async () => {
      const store = new FakeStore();
      store.lease = makeFlB().buildAcquisition(undefined, 500, 1); // B holds
      store.epoch = 1;
      const lc = new LeaseCoordinator({
        lease: makeFlA(), store, presumedDeadHolders: () => new Set(), now: () => 2_000,
      });
      // A yield purporting to come from 'C' (not the holder B) must NOT grant a takeover.
      expect(await lc.acquireOnConsent('C')).toBe(false);
      expect(lc.currentHolder()).toBe('B'); // unchanged
      expect(lc.currentEpoch()).toBe(1);
    });

    it('is idempotent when this machine already holds the lease', async () => {
      const store = new FakeStore();
      const lc = new LeaseCoordinator({
        lease: makeFlA(), store, presumedDeadHolders: () => new Set(), now: () => 1_000,
      });
      await lc.acquireIfEligible(); // A holds epoch 1
      expect(await lc.acquireOnConsent('B')).toBe(true); // already ours → true, no change
      expect(lc.currentEpoch()).toBe(1);
    });

    it('acquires from an empty lease on consent (no prior holder to guard against)', async () => {
      const store = new FakeStore();
      const lc = new LeaseCoordinator({
        lease: makeFlA(), store, presumedDeadHolders: () => new Set(), now: () => 1_000,
      });
      expect(await lc.acquireOnConsent('B')).toBe(true);
      expect(lc.currentEpoch()).toBe(1);
    });
  });
});
