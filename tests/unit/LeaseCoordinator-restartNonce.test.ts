/** Restart and epoch-scoped replay behavior through the holder and receiving coordinator. */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { FencedLease, type LeaseCrypto } from '../../src/core/FencedLease.js';
import { LeaseCoordinator, type LeaseStore, type LeaseTransport } from '../../src/core/LeaseCoordinator.js';
import { HttpLeaseTransport } from '../../src/core/HttpLeaseTransport.js';
import type { LeaseRecord } from '../../src/core/types.js';

const KEY = crypto.generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const crypt = (selfMachineId: string): LeaseCrypto => ({
  selfMachineId,
  sign: (c) => crypto.sign(null, Buffer.from(c), KEY.privateKey).toString('base64'),
  verify: (c, sig) => {
    try { return crypto.verify(null, Buffer.from(c), KEY.publicKey, Buffer.from(sig, 'base64')); } catch { return false; }
  },
});
const TTL = 60_000;
const BASE = 1_791_000_000_000;

class FakeStore implements LeaseStore {
  lease: LeaseRecord | null = null;
  epoch = 0;
  read() { return { lease: this.lease, epoch: this.epoch }; }
  refresh(lease: LeaseRecord) { if ((this.lease?.epoch ?? 0) > lease.epoch) return false; this.lease = lease; return true; }
  casWrite(candidate: LeaseRecord) {
    if (candidate.epoch === this.epoch + 1) { this.lease = candidate; this.epoch = candidate.epoch; return { ok: true, observed: this.read() }; }
    return { ok: false, observed: this.read() };
  }
}

function peerTransport(): HttpLeaseTransport {
  const peerKey = crypto.generateKeyPairSync('ed25519', { privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  let seq = 0;
  return new HttpLeaseTransport({ selfMachineId: 'B', signingKeyPem: peerKey.privateKey, peers: () => [], nextSequence: () => ++seq, reachabilityWindowMs: TTL });
}

function coordinator(self: string, store: LeaseStore, tunnel: LeaseTransport, now: () => number, monotonicNow: () => number): LeaseCoordinator {
  return new LeaseCoordinator({
    lease: new FencedLease(crypt(self), { leaseTtlMs: TTL, failoverThresholdMs: 15 * TTL }),
    store, tunnel, presumedDeadHolders: () => new Set(), now, monotonicNow,
    staleHolderTakeover: () => ({ enabled: true, nonRenewalMissedObservations: 2 }),
  });
}

function pair() {
  const store = new FakeStore();
  const received = peerTransport();
  const receiverStore = new FakeStore();
  let wall = BASE;
  let mono = 0;
  const now = () => wall;
  const monotonicNow = () => mono;
  const sent: LeaseRecord[] = [];
  const senderTunnel: LeaseTransport = {
    broadcast: async (lease) => { sent.push(lease); received.recordObserved(lease); return true; },
    observed: () => ({ lease: null, lastNonceByHolder: {} }),
    isReachable: () => true,
  };
  const receiver = coordinator('B', receiverStore, received, now, monotonicNow);
  const advance = (ms: number) => { wall += ms; mono += ms; };
  return { store, receiverStore, received, sent, senderTunnel, receiver, now, monotonicNow, advance, setWall: (ms: number) => { wall = ms; } };
}

describe('LeaseCoordinator restart nonce', () => {
  it('boots from an unexpired persisted own lease and credits same-epoch renewals on the receiver', async () => {
    const p = pair();
    const first = coordinator('A', p.store, p.senderTunnel, p.now, p.monotonicNow);
    expect(await first.acquireIfEligible()).toBe(true);
    for (let i = 0; i < 20; i++) expect(await first.renew()).toBe(true);
    const before = p.sent.at(-1)!;
    p.store.refresh(before); // durable own lease is genuinely unexpired at boot
    p.receiver.currentEpoch();
    const stamped = p.receiver.lastRenewalObservedMono('A');
    p.advance(1);
    const restarted = coordinator('A', p.store, p.senderTunnel, p.now, p.monotonicNow);
    restarted.primeFromDurable();
    expect(await restarted.acquireIfEligible()).toBe(true);
    const bootRenewal = p.sent.at(-1)!;
    expect(bootRenewal.epoch).toBe(before.epoch);
    expect(bootRenewal.nonce).toBeGreaterThan(before.nonce);
    p.receiver.currentEpoch();
    expect(p.receiver.lastRenewalObservedMono('A')).toBeGreaterThan(stamped!);
    p.advance(1_000);
    expect(await restarted.renew()).toBe(true);
    p.receiver.currentEpoch();
    expect(p.receiver.lastRenewalObservedMono('A')).toBe(1_001);
    expect(p.received.observed().lease?.nonce).toBe(p.sent.at(-1)!.nonce);
    expect(await p.receiver.acquireIfEligible()).toBe(false);
    expect(p.receiver.currentHolder()).toBe('A');
  });

  it('seeds above its own durable high nonce even after a clock correction', async () => {
    const p = pair();
    const first = coordinator('A', p.store, p.senderTunnel, p.now, p.monotonicNow);
    await first.acquireIfEligible();
    p.setWall(BASE + 3_600_000);
    await first.renew();
    const high = p.sent.at(-1)!;
    p.store.refresh(high);
    p.setWall(BASE + 1_000); // clock corrected; future-dated durable lease remains unexpired
    const restarted = coordinator('A', p.store, p.senderTunnel, p.now, p.monotonicNow);
    restarted.primeFromDurable();
    expect(await restarted.acquireIfEligible()).toBe(true);
    expect(p.sent.at(-1)!.nonce).toBeGreaterThan(high.nonce);
    expect(p.sent.at(-1)!.epoch).toBe(high.epoch);
    p.receiver.currentEpoch();
    expect(await p.receiver.acquireIfEligible()).toBe(false);
  });

  it('bounds a corrected-clock gap to one takeover, then credits the next epoch and rejects replays', async () => {
    const p = pair();
    const lease = new FencedLease(crypt('A'), { leaseTtlMs: TTL, failoverThresholdMs: 15 * TTL });
    const signed = (epoch: number, nonce: number) => lease.signLease(epoch, new Date(BASE).toISOString(), new Date(p.now() + TTL).toISOString(), nonce);
    const future = signed(1, BASE + 3_600_000);
    p.receiverStore.lease = future;
    p.receiverStore.epoch = 1;
    p.received.recordObserved(future);
    p.receiver.currentEpoch();
    const initialStamp = p.receiver.lastRenewalObservedMono('A');
    p.advance(1_000); // clock corrected below the prior emitted high nonce
    p.received.recordObserved(signed(1, BASE + 1_000));
    expect(p.received.observed().lastNonceByHolder.A).toBe(future.nonce);
    p.advance(2 * TTL + 1);
    expect(await p.receiver.acquireIfEligible()).toBe(true);
    expect(p.receiverStore.epoch).toBe(2); // one fenced takeover
    const nextEpoch = signed(3, BASE + 1_000);
    p.received.recordObserved(nextEpoch);
    expect(p.received.observed().lastNonceByHolder.A).toBe(nextEpoch.nonce);
    p.receiver.currentEpoch();
    expect(p.receiver.lastRenewalObservedMono('A')).toBeGreaterThan(initialStamp!);
    p.advance(1_000);
    const creditedAt = 2 * TTL + 2_001;
    const renewal = signed(3, BASE + 1_001);
    p.received.recordObserved(renewal);
    p.receiver.currentEpoch();
    expect(p.receiver.lastRenewalObservedMono('A')).toBe(creditedAt);
    p.advance(1_000);
    p.received.recordObserved(nextEpoch); // same-epoch replay
    p.receiver.currentEpoch();
    expect(p.received.observed().lease?.nonce).toBe(renewal.nonce);
    expect(p.receiver.lastRenewalObservedMono('A')).toBe(creditedAt);
    p.received.recordObserved(signed(1, BASE + 4_000_000)); // old epoch, larger nonce
    p.receiver.currentEpoch();
    expect(p.received.observed().lastNonceByHolder.A).toBe(renewal.nonce);
    expect(p.receiver.lastRenewalObservedMono('A')).toBe(creditedAt);
    expect(await p.receiver.acquireIfEligible()).toBe(false);
    expect(p.receiverStore.epoch).toBe(2);
  });
});

describe('LeaseCoordinator nonce floor sources', () => {
  const forged = (nonce: number): LeaseRecord => ({ holder: 'A', epoch: 2, acquiredAt: new Date(BASE).toISOString(),
    expiresAt: new Date(BASE + TTL).toISOString(), nonce, signature: 'not-a-signature' });

  it('ignores a forged own-holder lease observed over the network', async () => {
    const store = new FakeStore();
    const sent: LeaseRecord[] = [];
    const tunnel: LeaseTransport = { broadcast: async (l) => { sent.push(l); return true; },
      observed: () => ({ lease: forged(1e20), lastNonceByHolder: { A: 1e20 } }), isReachable: () => true };
    let wall = BASE;
    const lc = coordinator('A', store, tunnel, () => wall, () => wall - BASE);
    expect(await lc.acquireIfEligible()).toBe(true);
    for (let i = 0; i < 3; i++) { wall += 20_000; await lc.renew(); }
    const nonces = sent.map(l => l.nonce);
    expect(nonces.length).toBeGreaterThan(1);
    for (const n of nonces) { expect(Number.isSafeInteger(n)).toBe(true); expect(n).toBeLessThan(BASE + 10 * TTL); }
    for (let i = 1; i < nonces.length; i++) expect(nonces[i]).toBeGreaterThan(nonces[i - 1]);
  });

  it('ignores an unverified or unsafe durable own nonce', async () => {
    for (const lease of [forged(BASE * 1000), { ...forged(Number.MAX_SAFE_INTEGER), epoch: 0 }]) {
      const store = new FakeStore();
      store.lease = lease; store.epoch = 0;
      const sent: LeaseRecord[] = [];
      const tunnel: LeaseTransport = { broadcast: async (l) => { sent.push(l); return true; },
        observed: () => ({ lease: null, lastNonceByHolder: {} }), isReachable: () => true };
      const lc = coordinator('A', store, tunnel, () => BASE, () => 0);
      await lc.acquireIfEligible();
      await lc.renew();
      for (const n of sent.map(l => l.nonce)) expect(n).toBeLessThan(BASE + 1000);
    }
  });
});

describe('LeaseCoordinator nonce seed bounds', () => {
  const signed = (nonce: number): LeaseRecord => new FencedLease(crypt('A'), { leaseTtlMs: TTL, failoverThresholdMs: 15 * TTL })
    .signLease(1, new Date(BASE).toISOString(), new Date(BASE + TTL).toISOString(), nonce);
  const run = async (lease: LeaseRecord) => {
    const store = new FakeStore(); store.lease = lease; store.epoch = 1;
    const sent: LeaseRecord[] = [];
    const tunnel: LeaseTransport = { broadcast: async (l) => { sent.push(l); return true; },
      observed: () => ({ lease: null, lastNonceByHolder: {} }), isReachable: () => true };
    const lc = coordinator('A', store, tunnel, () => BASE + 1000, () => 0);
    await lc.acquireIfEligible();
    await lc.renew(); await lc.renew();
    return sent.map(l => l.nonce);
  };

  it('seeds from a signed durable nonce ahead of the clock within the bound', async () => {
    const nonces = await run(signed(BASE + 3_600_000));
    expect(nonces[0]).toBe(BASE + 3_600_001);
    for (let i = 1; i < nonces.length; i++) expect(nonces[i]).toBe(nonces[i - 1] + 1);
  });

  it('ignores a correctly signed durable nonce near MAX_SAFE_INTEGER', async () => {
    const nonces = await run(signed(Number.MAX_SAFE_INTEGER - 1));
    expect(nonces.length).toBeGreaterThan(1);
    for (const n of nonces) expect(n).toBeLessThan(BASE + 10_000);
    for (let i = 1; i < nonces.length; i++) expect(nonces[i]).toBeGreaterThan(nonces[i - 1]);
  });
});
