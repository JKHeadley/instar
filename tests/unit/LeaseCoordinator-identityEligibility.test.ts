/**
 * a2a-single-agent-identity §1.1 — the lease decision point, both sides of the boundary.
 *
 * An unprovisioned machine that can see a live sibling holding the agent identity must not
 * hold the serving lease (it holds the one relay connection and cannot use it). Everywhere
 * else — eligible again after adoption, or never ineligible at all — the coordinator behaves
 * exactly as before. `isLeaseEligible` is read LIVE on every acquire tick.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { FencedLease, type LeaseCrypto } from '../../src/core/FencedLease.js';
import { LeaseCoordinator, type LeaseStore, type LeaseTransport } from '../../src/core/LeaseCoordinator.js';
import type { LeaseRecord } from '../../src/core/types.js';

const KEY = crypto.generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const crypt: LeaseCrypto = {
  selfMachineId: 'A',
  sign: (c) => crypto.sign(null, Buffer.from(c), KEY.privateKey).toString('base64'),
  verify: (c, sig) => crypto.verify(null, Buffer.from(c), KEY.publicKey, Buffer.from(sig, 'base64')),
};

class FakeStore implements LeaseStore {
  lease: LeaseRecord | null = null;
  epoch = 0;
  read() { return { lease: this.lease, epoch: this.epoch }; }
  refresh(lease: LeaseRecord) { this.lease = lease; return true; }
  casWrite(candidate: LeaseRecord) {
    if (candidate.epoch === this.epoch + 1) {
      this.lease = candidate;
      this.epoch = candidate.epoch;
      return { ok: true, observed: { lease: this.lease, epoch: this.epoch } };
    }
    return { ok: false, observed: { lease: this.lease, epoch: this.epoch } };
  }
  // The real stores keep epoch + holder as the floor and push expiresAt into the deep past.
  forceLocalExpiry() { if (this.lease) this.lease = { ...this.lease, expiresAt: new Date(0).toISOString() }; }
}

function rig(eligible: () => boolean) {
  const store = new FakeStore();
  const broadcasts: LeaseRecord[] = [];
  const tunnel: LeaseTransport = {
    broadcast: async (l) => { broadcasts.push(l); return true; },
    observed: () => ({ lease: null, lastNonceByHolder: {} }),
    isReachable: () => true,
  };
  let t = 1_000;
  const lc = new LeaseCoordinator({
    lease: new FencedLease(crypt, { leaseTtlMs: 60_000, failoverThresholdMs: 15 * 60_000 }),
    store,
    tunnel,
    presumedDeadHolders: () => new Set(),
    isLeaseEligible: eligible,
    now: () => (t += 1_000),
  });
  return { lc, store, broadcasts };
}

describe('LeaseCoordinator — §1.1 identity lease eligibility', () => {
  it('an ineligible machine that never held the lease does not acquire it', async () => {
    const { lc, store } = rig(() => false);
    expect(await lc.acquireIfEligible()).toBe(false);
    expect(lc.holdsLease()).toBe(false);
    expect(store.epoch).toBe(0); // no write was even attempted
  });

  it('a holder that becomes ineligible releases at the next tick with a SIGNED tombstone, and re-acquires once eligible again', async () => {
    let eligible = true;
    const { lc, broadcasts } = rig(() => eligible);
    expect(await lc.acquireIfEligible()).toBe(true);
    expect(lc.holdsLease()).toBe(true);

    eligible = false; // a live sibling holding the identity came into view
    const before = broadcasts.length;
    expect(await lc.acquireIfEligible()).toBe(false);
    expect(lc.holdsLease()).toBe(false);
    const tombstone = broadcasts.slice(before).find((l) => l.released === true);
    expect(tombstone).toBeDefined(); // peers stop deferring now, not at TTL expiry
    expect(tombstone!.holder).toBe('A');

    expect(await lc.acquireIfEligible()).toBe(false); // stays released while ineligible
    expect(lc.holdsLease()).toBe(false);

    eligible = true; // adoption landed
    expect(await lc.acquireIfEligible()).toBe(true);
    expect(lc.holdsLease()).toBe(true);
  });

  it('absent the dep (every pre-existing caller, single-machine installs) the coordinator is unchanged', async () => {
    const store = new FakeStore();
    const lc = new LeaseCoordinator({
      lease: new FencedLease(crypt, { leaseTtlMs: 60_000, failoverThresholdMs: 15 * 60_000 }),
      store,
      presumedDeadHolders: () => new Set(),
      now: () => 1_000,
    });
    expect(await lc.acquireIfEligible()).toBe(true);
    expect(lc.holdsLease()).toBe(true);
  });
});
