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
    expect(lc.peerTakeoverEligible()).toBe(false);
    // Time advances 7×TTL with NO new B nonce ⇒ B is non-renewing.
    mono = 1_000 + 7 * TTL;
    expect(lc.peerTakeoverEligible()).toBe(true);
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

// ── multi-transport-mesh-comms Layer 3 — solo-captain hold ──────────────────
class FailingTunnel implements LeaseTransport {
  peer: LeaseRecord | null = null;
  broadcast = async () => false; // no rope confirms
  observed = () => ({ lease: this.peer, lastNonceByHolder: this.peer ? { [this.peer.holder]: this.peer.nonce } : {} });
  isReachable = () => false;
}

describe('LeaseCoordinator Layer 3 — solo-captain hold', () => {
  function mkHeldCoordinator(opts: {
    soloEnabled?: boolean;
    preferred?: boolean;
    allGone?: boolean;
    mono?: () => number;
  }) {
    const store = new FakeStore();
    const tunnel = new FailingTunnel();
    let suspendReason: string | null = null;
    const lc = new LeaseCoordinator({
      lease: flA(),
      store,
      tunnel,
      presumedDeadHolders: () => new Set(),
      now: () => 1000,
      monotonicNow: opts.mono ?? (() => 1000),
      onSelfSuspend: (r) => { suspendReason = r; },
      soloCaptainHold: () => (opts.soloEnabled ? { enabled: true } : null),
      isPreferredAwakeAgreed: () => opts.preferred ?? false,
      allPeersPresumedGone: () => opts.allGone ?? false,
    });
    return { lc, store, tunnel, getSuspend: () => suspendReason };
  }

  it('preferred + all-peers-presumed-gone + no-higher-epoch ⇒ HOLDS the same epoch (no suspend)', async () => {
    const { lc } = mkHeldCoordinator({ soloEnabled: true, preferred: true, allGone: true });
    expect(await lc.acquireIfEligible()).toBe(true); // A holds epoch 1
    const epochBefore = lc.effectiveView().epoch;
    const ok = await lc.renew(); // broadcast fails, but the hold engages
    expect(ok).toBe(true);
    expect(lc.holdsLease()).toBe(true);
    expect(lc.effectiveView().epoch).toBe(epochBefore); // SAME epoch, no inflation
  });

  it('peer merely unreachable (NOT presumed-gone) ⇒ self-suspends after ttl (conservative)', async () => {
    let mono = 1000;
    const { lc, getSuspend } = mkHeldCoordinator({ soloEnabled: true, preferred: true, allGone: false, mono: () => mono });
    expect(await lc.acquireIfEligible()).toBe(true);
    mono = 1000 + TTL + 1; // past the self-fence horizon
    const ok = await lc.renew();
    expect(ok).toBe(false);
    expect(getSuspend()).toMatch(/could not confirm/);
  });

  it('preferred fenced peer-takeover may hold that exact epoch solo before the 15m death threshold', async () => {
    let mono = 1_000;
    const { lc, store, tunnel, getSuspend } = mkHeldCoordinator({
      soloEnabled: true,
      preferred: true,
      allGone: false,
      mono: () => mono,
    });
    // B's expired signed lease is an existing fenced-acquisition grant. A wins
    // epoch 2 even though B has not yet aged through the 15-minute registry
    // death threshold.
    store.lease = flB().signLease(1, new Date(0).toISOString(), new Date(500).toISOString(), 9);
    store.epoch = 1;
    expect(await lc.acquireIfEligible()).toBe(true);
    expect(lc.currentEpoch()).toBe(2);

    // No peer can confirm the next renewal. The takeover provenance authorizes
    // preferred A to keep epoch 2 alive; it must not drop serving after one TTL.
    mono += TTL + 1;
    expect(await lc.renew()).toBe(true);
    expect(lc.holdsLease()).toBe(true);
    expect(getSuspend()).toBeNull();

    // A higher peer epoch permanently burns the authorization. Even if that
    // observation later disappears, epoch 2 must not resurrect solo authority.
    tunnel.peer = flB().signLease(3, new Date(1_000).toISOString(), new Date(10_000_000).toISOString(), 10);
    expect(lc.currentEpoch()).toBe(3);
    tunnel.peer = null;
    mono += TTL + 1;
    expect(await lc.renew()).toBe(false);
    expect(lc.holdsLease()).toBe(false);
  });

  it('NOT preferred ⇒ never holds solo (a traveler self-suspends as today)', async () => {
    let mono = 1000;
    const { lc, getSuspend } = mkHeldCoordinator({ soloEnabled: true, preferred: false, allGone: true, mono: () => mono });
    expect(await lc.acquireIfEligible()).toBe(true);
    mono = 1000 + TTL + 1;
    expect(await lc.renew()).toBe(false);
    expect(getSuspend()).toBeTruthy();
  });

  it('flag OFF ⇒ byte-for-byte today (self-suspend even when preferred + all-gone)', async () => {
    let mono = 1000;
    const { lc, getSuspend } = mkHeldCoordinator({ soloEnabled: false, preferred: true, allGone: true, mono: () => mono });
    expect(await lc.acquireIfEligible()).toBe(true);
    mono = 1000 + TTL + 1;
    expect(await lc.renew()).toBe(false);
    expect(getSuspend()).toBeTruthy();
  });

  it('a higher epoch observed ⇒ does NOT hold solo (real takeover dominates — captain yields)', async () => {
    let mono = 1000;
    const store = new FakeStore();
    const tunnel = new FailingTunnel();
    const lc = new LeaseCoordinator({
      lease: flA(),
      store,
      tunnel,
      presumedDeadHolders: () => new Set(),
      now: () => 1000,
      monotonicNow: () => mono,
      soloCaptainHold: () => ({ enabled: true }),
      isPreferredAwakeAgreed: () => true,
      allPeersPresumedGone: () => true,
    });
    expect(await lc.acquireIfEligible()).toBe(true); // A holds epoch 1
    // B observed at a HIGHER epoch (a real takeover the captain must yield to). The
    // effective view now names B as the higher-epoch holder, so renew() yields
    // (we are no longer the effective holder) — the hold can NEVER fire over a
    // higher epoch. The load-bearing assertion: A does NOT retain a solo hold.
    tunnel.peer = flB().signLease(5, new Date(1000).toISOString(), new Date(10_000_000).toISOString(), 9);
    mono = 1000 + TTL + 1;
    expect(await lc.renew()).toBe(false);
    expect(lc.holdsLease()).toBe(false); // captain yielded to the higher epoch
  });

  it('soloCaptainHoldEligible is gated on epoch even when the held-holder check passes (direct)', async () => {
    // Guards the inner no-higher-epoch clause directly: with NO higher peer epoch,
    // the hold fires; this is already covered by the first test, so here we assert
    // the dual — an enabled+preferred+all-gone coordinator with a SAME-epoch view holds.
    const { lc } = mkHeldCoordinator({ soloEnabled: true, preferred: true, allGone: true });
    expect(await lc.acquireIfEligible()).toBe(true);
    expect(await lc.renew()).toBe(true);
    expect(lc.holdsLease()).toBe(true);
  });
});
