/**
 * multi-machine-lease-self-heal — LeaseCoordinator wiring tests:
 *  F2 — staleHolderTakeover end-to-end (freshness stamped on the verified
 *       fold-in; a non-renewing peer is taken over, a renewing one is not).
 *  F3 — relinquishAndBroadcast emits a SIGNED released tombstone; a released
 *       lease names no current holder (no zombie). Real Ed25519 keys.
 */

import { describe, it, expect } from 'vitest';
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
function flA() { return new FencedLease(crypt('A'), { leaseTtlMs: TTL, failoverThresholdMs: FAILOVER }); }
function flB() { return new FencedLease(crypt('B'), { leaseTtlMs: TTL, failoverThresholdMs: FAILOVER }); }

class FakeStore implements LeaseStore {
  lease: LeaseRecord | null = null;
  epoch = 0;
  read() { return { lease: this.lease, epoch: this.epoch }; }
  refresh(lease: LeaseRecord) { if ((this.lease?.epoch ?? 0) > lease.epoch) return false; this.lease = lease; return true; }
  casWrite(candidate: LeaseRecord) {
    if (candidate.epoch === this.epoch + 1) { this.lease = candidate; this.epoch = candidate.epoch; return { ok: true, observed: { lease: this.lease, epoch: this.epoch } }; }
    return { ok: false, observed: { lease: this.lease, epoch: this.epoch } };
  }
  forceLocalExpiry() { /* keep epoch floor; drop holder authority — modelled as clearing the lease object */ this.lease = null; }
}

class FakeTunnel implements LeaseTransport {
  peer: LeaseRecord | null = null;
  sent: LeaseRecord[] = [];
  broadcast = async (l: LeaseRecord) => { this.sent.push(l); return true; };
  observed = () => ({ lease: this.peer, lastNonceByHolder: this.peer ? { [this.peer.holder]: this.peer.nonce } : {} });
  isReachable = () => true;
}

describe('LeaseCoordinator self-heal wiring (F2 + F3)', () => {
  it('F3 relinquishAndBroadcast emits a SIGNED released tombstone and drops our hold', async () => {
    const store = new FakeStore();
    const tunnel = new FakeTunnel();
    let mono = 1000;
    const lc = new LeaseCoordinator({ lease: flA(), store, tunnel, presumedDeadHolders: () => new Set(), now: () => 1000, monotonicNow: () => mono });
    expect(await lc.acquireIfEligible()).toBe(true); // A holds epoch 1
    tunnel.sent = [];
    await lc.relinquishAndBroadcast();
    expect(lc.holdsLease()).toBe(false);
    const tomb = tunnel.sent.find((l) => l.released === true);
    expect(tomb).toBeDefined();
    expect(tomb!.holder).toBe('A');
    expect(flA().verifyLease(tomb!)).toBe(true); // the tombstone is genuinely signed
  });

  it('F3 a RELEASED tombstone observed from a peer names NO current holder (no zombie)', () => {
    const store = new FakeStore();
    const tunnel = new FakeTunnel();
    const lc = new LeaseCoordinator({ lease: flA(), store, tunnel, presumedDeadHolders: () => new Set(), now: () => 1000 });
    // B broadcasts a tombstone for epoch 2 (released).
    tunnel.peer = flB().signLease(2, new Date(1000).toISOString(), new Date(1000).toISOString(), 9, true);
    expect(tunnel.peer.released).toBe(true);
    expect(lc.currentHolder()).toBeNull(); // released ⇒ not folded as a live holder
  });

  it('F2 takes over a NON-renewing peer (watermark stale) when the flag is on', async () => {
    const store = new FakeStore();
    const tunnel = new FakeTunnel();
    let mono = 1_000;
    const lc = new LeaseCoordinator({
      lease: flA(), store, tunnel, presumedDeadHolders: () => new Set(),
      now: () => 1000, monotonicNow: () => mono,
      staleHolderTakeover: () => ({ enabled: true, nonRenewalMissedObservations: 6 }),
    });
    // B holds epoch 1, far-future expiry (NOT expired), in both git + tunnel.
    const bLease = flB().signLease(1, new Date(1000).toISOString(), new Date(10_000_000).toISOString(), 5);
    store.lease = bLease; store.epoch = 1; tunnel.peer = bLease;
    // First observation stamps B's freshness at mono=1000.
    expect(lc.currentHolder()).toBe('B');
    // Time advances 7×TTL with NO new B nonce ⇒ B is non-renewing.
    mono = 1_000 + 7 * TTL;
    expect(await lc.acquireIfEligible()).toBe(true); // A takes over
    expect(lc.currentEpoch()).toBe(2);
  });

  it('F2 does NOT take over a RENEWING peer (watermark fresh)', async () => {
    const store = new FakeStore();
    const tunnel = new FakeTunnel();
    let mono = 1_000;
    const lc = new LeaseCoordinator({
      lease: flA(), store, tunnel, presumedDeadHolders: () => new Set(),
      now: () => 1000, monotonicNow: () => mono,
      staleHolderTakeover: () => ({ enabled: true, nonRenewalMissedObservations: 6 }),
    });
    const bLease = flB().signLease(1, new Date(1000).toISOString(), new Date(10_000_000).toISOString(), 5);
    store.lease = bLease; store.epoch = 1; tunnel.peer = bLease;
    expect(lc.currentHolder()).toBe('B'); // stamp fresh[B]=1000
    mono = 1_000 + 2 * TTL; // only 2×TTL — within the 6×TTL window ⇒ still renewing
    expect(await lc.acquireIfEligible()).toBe(false); // held-by-live-peer, no takeover
    expect(lc.currentHolder()).toBe('B');
  });

  it('F4 isHolderHealthy: true for a LIVE peer holder; false when expired/released/absent/other', () => {
    const store = new FakeStore();
    const tunnel = new FakeTunnel();
    const lc = new LeaseCoordinator({ lease: flA(), store, tunnel, presumedDeadHolders: () => new Set(), now: () => 1000 });
    // B holds a live lease.
    tunnel.peer = flB().signLease(1, new Date(1000).toISOString(), new Date(10_000_000).toISOString(), 5);
    expect(lc.isHolderHealthy('B')).toBe(true);
    expect(lc.isHolderHealthy('A')).toBe(false); // not the holder
    // expired lease ⇒ not healthy
    tunnel.peer = flB().signLease(1, new Date(0).toISOString(), new Date(500).toISOString(), 6);
    expect(lc.isHolderHealthy('B')).toBe(false);
    // released tombstone ⇒ not healthy
    tunnel.peer = flB().signLease(2, new Date(1000).toISOString(), new Date(10_000_000).toISOString(), 7, true);
    expect(lc.isHolderHealthy('B')).toBe(false);
    // no observed lease ⇒ not healthy
    tunnel.peer = null;
    expect(lc.isHolderHealthy('B')).toBe(false);
  });
});
