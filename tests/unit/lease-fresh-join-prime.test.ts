/**
 * Regression test for the fresh-join-grabs-lease bug (verified live on a
 * two-machine mesh, 2026-05-28): a freshly-joined/booted standby evaluated
 * failover-eligibility against a STALE seed `lastSeen` for the live holder,
 * presumed it dead, and grabbed its lease. The fix: prime from the durable
 * medium (LeaseCoordinator.primeFromDurable → store.syncDown) before the first
 * eligibility check, so the standby sees the holder's CURRENT heartbeat.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { FencedLease, type LeaseCrypto } from '../../src/core/FencedLease.js';
import { LeaseCoordinator, type LeaseStore } from '../../src/core/LeaseCoordinator.js';
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
const NOW = 1_000_000;

/** A valid, fresh lease held by machine A (the live holder). */
function aLease(): LeaseRecord {
  return new FencedLease(crypt('A'), { leaseTtlMs: TTL, failoverThresholdMs: FAILOVER })
    .buildAcquisition(null, NOW, 1); // epoch 1, holder A, expiresAt NOW+TTL
}

/**
 * Store whose `presumedDead` view is STALE (A looks dead) until syncDown() is
 * called, after which the fresh durable state shows A alive (not dead) —
 * modeling the seed-timestamp → fresh-heartbeat transition.
 */
class PrimingStore implements LeaseStore {
  lease = aLease();
  epoch = 1;
  synced = false;
  read() { return { lease: this.lease, epoch: this.epoch }; }
  refresh() { return true; }
  syncDown() { this.synced = true; }
  casWrite(candidate: LeaseRecord) {
    if (candidate.epoch === this.epoch + 1) { this.lease = candidate; this.epoch = candidate.epoch; return { ok: true, observed: { lease: this.lease, epoch: this.epoch } }; }
    return { ok: false, observed: { lease: this.lease, epoch: this.epoch } };
  }
}

describe('LeaseCoordinator.primeFromDurable — fresh-join must not grab a live holder', () => {
  function coordFor(store: PrimingStore) {
    return new LeaseCoordinator({
      lease: new FencedLease(crypt('B'), { leaseTtlMs: TTL, failoverThresholdMs: FAILOVER }),
      store,
      // Stale view presumes A dead; after a durable sync, A is observed alive.
      presumedDeadHolders: () => (store.synced ? new Set<string>() : new Set(['A'])),
      now: () => NOW + 1_000, // still well within A's lease TTL
    });
  }

  it('WITHOUT priming, the stale view causes the bug (B grabs A’s live lease)', async () => {
    const store = new PrimingStore();
    const lc = coordFor(store);
    // Demonstrates the pre-fix hazard: stale presumedDead={A} → B acquires.
    expect(await lc.acquireIfEligible()).toBe(true);
    expect(store.lease.holder).toBe('B');
  });

  it('WITH primeFromDurable first, B defers to the live holder A (bug fixed)', async () => {
    const store = new PrimingStore();
    const lc = coordFor(store);
    lc.primeFromDurable();           // pulls fresh durable state → A observed alive
    expect(store.synced).toBe(true); // syncDown was invoked
    expect(await lc.acquireIfEligible()).toBe(false); // does NOT grab a live holder
    expect(store.lease.holder).toBe('A');             // A keeps the lease
    expect(lc.holdsLease()).toBe(false);
  });
});
