/**
 * lease-renew-unreachable-peers — a renewal must never wait on the slowest peer.
 *
 * 2026-09-27 (Mac Studio): one permanently-unreachable peer's rope timed out at
 * 30s, and broadcast() awaited EVERY peer, so each renewal overran the 20s tick
 * await even while other peers were confirming. Under CPU load the preferred
 * captain's lease lapsed and every outbound Telegram send was refused for ~30min.
 *
 * Real HttpLeaseTransport + real LeaseCoordinator + real Ed25519 keys; only fetch
 * is injected (a hanging fetch models a peer whose every rope is dead).
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import { HttpLeaseTransport, type LeasePeer } from '../../src/core/HttpLeaseTransport.js';
import { FencedLease, type LeaseCrypto } from '../../src/core/FencedLease.js';
import { LeaseCoordinator, type LeaseStore } from '../../src/core/LeaseCoordinator.js';
import type { LeaseRecord } from '../../src/core/types.js';
import { PeerEndpointResolver } from '../../src/core/PeerEndpointResolver.js';
import { signLeaseAck } from '../../src/server/machineAuth.js';

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
const fl = (id: string) => new FencedLease(crypt(id), { leaseTtlMs: TTL, failoverThresholdMs: 15 * 60_000 });

class FakeStore implements LeaseStore {
  lease: LeaseRecord | null = null;
  epoch = 0;
  read() { return { lease: this.lease, epoch: this.epoch }; }
  refresh() { return false; }
  casWrite(candidate: LeaseRecord) {
    if (candidate.epoch === this.epoch + 1) { this.lease = candidate; this.epoch = candidate.epoch; return { ok: true, observed: { lease: this.lease, epoch: this.epoch } }; }
    return { ok: false, observed: { lease: this.lease, epoch: this.epoch } };
  }
}

const DEAD = 'http://dead-peer';
const LIVE = 'http://live-peer';
/** A dead rope never answers; it only settles when its abort signal fires. */
function fetchImpl(liveUp: { value: boolean }) {
  return (async (url: string, opts: { signal?: AbortSignal }) => {
    if (url.startsWith(LIVE) && liveUp.value) return { ok: true, json: async () => ({}) };
    return new Promise((_resolve, reject) => {
      opts.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted due to timeout')));
    });
  }) as unknown as typeof fetch;
}

function transport(peers: LeasePeer[], liveUp = { value: true }, deadlineMs = 150) {
  let seq = 0;
  return new HttpLeaseTransport({
    selfMachineId: 'A',
    signingKeyPem: KEYS.A.privateKey,
    peers: () => peers,
    nextSequence: () => ++seq,
    fetchImpl: fetchImpl(liveUp),
    requestTimeoutMs: 30_000, // production rope timeout — far longer than the tick await
    broadcastDeadlineMs: deadlineMs,
  });
}

const leaseRec = (): LeaseRecord => ({ holder: 'A', epoch: 1, acquiredAt: 'x', expiresAt: 'y', signature: 's', nonce: 1 });
const timed = async <T>(p: Promise<T>) => { const t0 = Date.now(); const v = await p; return { v, ms: Date.now() - t0 }; };

describe('HttpLeaseTransport.broadcast — never waits on the slowest peer', () => {
  it('resolves true on the first confirming peer while another peer hangs', async () => {
    const t = transport([{ machineId: 'dead', url: DEAD }, { machineId: 'live', url: LIVE }], { value: true }, 5_000);
    const { v, ms } = await timed(t.broadcast(leaseRec()));
    expect(v).toBe(true);
    expect(ms).toBeLessThan(1_000); // not the 5s deadline, not the 30s rope timeout
    expect(t.isReachable()).toBe(true);
  });

  it('resolves false at the deadline when every peer hangs (not at the 30s rope timeout)', async () => {
    const t = transport([{ machineId: 'dead', url: DEAD }, { machineId: 'dead2', url: `${DEAD}2` }]);
    const { v, ms } = await timed(t.broadcast(leaseRec()));
    expect(v).toBe(false);
    expect(ms).toBeGreaterThanOrEqual(140);
    expect(ms).toBeLessThan(2_000);
  });

  it('resolves false promptly when every peer refuses (no deadline wait)', async () => {
    const t = new HttpLeaseTransport({
      selfMachineId: 'A', signingKeyPem: KEYS.A.privateKey, peers: () => [{ machineId: 'b', url: DEAD }],
      nextSequence: () => 1, fetchImpl: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch,
      broadcastDeadlineMs: 5_000,
    });
    const { v, ms } = await timed(t.broadcast(leaseRec()));
    expect(v).toBe(false);
    expect(ms).toBeLessThan(1_000);
  });
});

describe('LeaseCoordinator.renew over a real transport with unreachable peers', () => {
  function captain(peers: LeasePeer[], opts: { allGone: boolean; liveUp?: { value: boolean } }) {
    let mono = 1_000;
    let suspended: string | null = null;
    const tunnel = transport(peers, opts.liveUp ?? { value: true });
    const lc = new LeaseCoordinator({
      lease: fl('A'),
      store: new FakeStore(),
      tunnel,
      presumedDeadHolders: () => new Set(),
      now: () => 1_000,
      monotonicNow: () => mono,
      onSelfSuspend: (r) => { suspended = r; },
      soloCaptainHold: () => ({ enabled: true }),
      isPreferredAwakeAgreed: () => true,
      allPeersPresumedGone: () => opts.allGone,
    });
    return { lc, tunnel, advance: (ms: number) => { mono += ms; }, suspended: () => suspended };
  }

  it('peers reachable: one dead peer does not block — renewal confirms fast and the clock is re-armed', async () => {
    const { lc, advance } = captain([{ machineId: 'dead', url: DEAD }, { machineId: 'live', url: LIVE }], { allGone: false });
    expect(await lc.acquireIfEligible()).toBe(true);
    advance(TTL - 1_000);
    const { v, ms } = await timed(lc.renew());
    expect(v).toBe(true);
    expect(ms).toBeLessThan(1_000);
    advance(TTL - 1_000); // would be past the self-fence had the renewal not been confirmed
    expect(lc.holdsLease()).toBe(true);
  });

  it('peers unreachable: renew returns inside the tick budget and the preferred captain HOLDS (same epoch)', async () => {
    const { lc, advance } = captain([{ machineId: 'dead', url: DEAD }, { machineId: 'dead2', url: `${DEAD}2` }], { allGone: true });
    expect(await lc.acquireIfEligible()).toBe(true);
    const epoch = lc.currentEpoch();
    advance(TTL + 1); // past the self-fence horizon — only the hold can keep us serving
    const { v, ms } = await timed(lc.renew());
    expect(v).toBe(true);
    expect(ms).toBeLessThan(20_000 / 2); // well inside the 20s tick await
    expect(lc.holdsLease()).toBe(true);
    expect(lc.currentEpoch()).toBe(epoch); // hold never advances the epoch
  });

  it('peers unreachable but recently alive (not presumed-gone): renew still returns in budget, then the self-fence applies', async () => {
    const { lc, advance, suspended } = captain([{ machineId: 'dead', url: DEAD }], { allGone: false });
    expect(await lc.acquireIfEligible()).toBe(true);
    advance(TTL + 1);
    const { v, ms } = await timed(lc.renew());
    expect(ms).toBeLessThan(20_000 / 2);
    expect(v).toBe(false);
    expect(suspended()).toMatch(/could not confirm/);
    expect(lc.holdsLease()).toBe(false);
  });

  it('an already-observed higher-epoch lease: no hold, even with every peer unreachable and presumed-gone', async () => {
    const { lc, tunnel, advance } = captain([{ machineId: 'dead', url: DEAD }], { allGone: true });
    expect(await lc.acquireIfEligible()).toBe(true);
    // Peer B's signed epoch-2 lease is already in our observed view (push/pull path).
    tunnel.recordObserved(fl('B').signLease(2, new Date(1_000).toISOString(), new Date(1_000 + TTL).toISOString(), 5));
    advance(TTL + 1);
    expect(await lc.renew()).toBe(false);
    expect(lc.holdsLease()).toBe(false);
    expect(lc.currentHolder()).toBe('B');
  });
});

/**
 * Real signed accept-acks over the production mesh path (resolver + verifyLeaseAck),
 * on a fake clock. Covers the two review findings: a genuine slow confirmation must
 * not be thrown away at the deadline, and a verified higher-epoch ack — early, late,
 * or beside a confirming peer — must fence the older holder.
 */
describe('signed accept-acks: slow confirmations are kept, higher epochs fence', () => {
  const ACK_KEYS: Record<string, { publicKey: string; privateKey: string }> = { A: KEYS.A, B: KEYS.B, C: genKey() };
  afterEach(() => vi.useRealTimers());

  function mesh(opts: { delayMs?: number; bDelayMs?: number; bEpoch?: number; peerIds: string[]; solo?: boolean }) {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    let peers: LeasePeer[] = [];
    let suspended: string | null = null;
    let stored: LeaseRecord | null = null;
    let seq = 0;
    const bLease = fl('B').signLease(2, new Date(1_000_000).toISOString(), new Date(1_000_000 + 10 * TTL).toISOString(), 7);
    const resolver = new PeerEndpointResolver({ config: {
      enabled: true, hedgeDelayMs: 1500, priorityTailscale: 10, priorityLan: 20, priorityCloudflare: 30,
      tailscaleEnabled: true, lanSubnetGate: false, unhealthyAfterFailures: 3, endpointEvictionMs: 3_600_000,
      maxProbeBackoffMs: 300_000, requestTimeoutMs: 30_000,
    } });
    const tunnel = new HttpLeaseTransport({
      selfMachineId: 'A', signingKeyPem: KEYS.A.privateKey, peers: () => peers, nextSequence: () => ++seq,
      now: Date.now, resolver, broadcastDeadlineMs: 8_000,
      fetchImpl: (async (url: string, init: { body: string }) => {
        const body = JSON.parse(init.body);
        const id = url.includes('peer-b') ? 'B' : 'C';
        if (id === 'B' && opts.bDelayMs) await new Promise((r) => setTimeout(r, opts.bDelayMs));
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        if (url.endsWith('/api/lease/pull')) {
          const ack = { machineId: id, reqNonce: body.reqNonce, observedEpoch: 0 };
          return { ok: true, json: async () => ({ lease: id === 'B' ? bLease : null, ack, sig: signLeaseAck(ack, ACK_KEYS[id].privateKey) }) };
        }
        const observedEpoch = id === 'B' && opts.bEpoch ? opts.bEpoch : body.lease.epoch;
        const ack = { machineId: id, reqNonce: body.reqNonce, observedEpoch };
        return { ok: true, json: async () => ({ ack, sig: signLeaseAck(ack, ACK_KEYS[id].privateKey) }) };
      }) as unknown as typeof fetch,
    });
    const lc = new LeaseCoordinator({
      lease: fl('A'), tunnel, now: Date.now, monotonicNow: Date.now, presumedDeadHolders: () => new Set(),
      onSelfSuspend: (r) => { suspended = r; },
      store: { read: () => ({ lease: stored, epoch: stored?.epoch ?? 0 }), refresh: () => false,
        casWrite: (c: LeaseRecord) => { stored = c; return { ok: true, observed: { lease: stored, epoch: c.epoch } }; },
        // As LocalLeaseStore: keep epoch + holder as the floor, expiry deep in the past.
        forceLocalExpiry: () => { if (stored) stored = { ...stored, expiresAt: new Date(0).toISOString() }; } },
      ...(opts.solo ? { soloCaptainHold: () => ({ enabled: true }), isPreferredAwakeAgreed: () => true, allPeersPresumedGone: () => true } : {}),
    });
    const connect = () => {
      peers = opts.peerIds.map((id) => ({ machineId: id, url: `https://peer-${id.toLowerCase()}.example`,
        publicKeyPem: ACK_KEYS[id].publicKey, meshAckCapable: true }));
    };
    return { lc, tunnel, connect, suspended: () => suspended };
  }

  it('a healthy peer whose genuine acks take 10s keeps the holder serving across renewals', async () => {
    const { lc, connect, suspended } = mesh({ delayMs: 10_000, peerIds: ['C'] });
    expect(await lc.acquireIfEligible()).toBe(true);
    connect();
    for (const at of [30_000, 60_000, 90_000, 120_000]) {
      await vi.advanceTimersByTimeAsync(at - (Date.now() - 1_000_000));
      const p = lc.renew();
      await vi.advanceTimersByTimeAsync(8_000);
      expect(await p).toBe(true); // the deadline answers inside the tick budget (grace)
      await vi.advanceTimersByTimeAsync(2_000); // the genuine ack lands at +10s and is adopted
      expect(lc.holdsLease()).toBe(true);
    }
    expect(suspended()).toBe(null);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('without any confirmation the same schedule still lapses (the self-fence is intact)', async () => {
    const { lc, connect, suspended } = mesh({ delayMs: 40_000, peerIds: ['C'] });
    expect(await lc.acquireIfEligible()).toBe(true);
    connect();
    await vi.advanceTimersByTimeAsync(30_000);
    let p = lc.renew(); await vi.advanceTimersByTimeAsync(8_000); expect(await p).toBe(true);
    await vi.advanceTimersByTimeAsync(22_000);
    p = lc.renew(); await vi.advanceTimersByTimeAsync(8_000); expect(await p).toBe(false);
    expect(suspended()).toMatch(/could not confirm/);
    expect(lc.holdsLease()).toBe(false);
    // A confirmation arriving after suspension never revives the lapsed lease.
    await vi.advanceTimersByTimeAsync(40_000);
    expect(lc.holdsLease()).toBe(false);
  });

  it('a late ack for a renewal sent before relinquish() never brings the lease back', async () => {
    const { lc, connect } = mesh({ delayMs: 10_000, peerIds: ['C'] });
    expect(await lc.acquireIfEligible()).toBe(true);
    connect();
    await vi.advanceTimersByTimeAsync(30_000);
    const p = lc.renew();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await p).toBe(true); // grace
    lc.relinquish();
    expect(lc.holdsLease()).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000); // the pre-relinquish renewal's ack lands
    expect(lc.holdsLease()).toBe(false);
  });

  it('an on-time ack for a renewal in flight across relinquish() never brings the lease back', async () => {
    const { lc, connect } = mesh({ delayMs: 1_000, peerIds: ['C'] });
    expect(await lc.acquireIfEligible()).toBe(true);
    connect();
    await vi.advanceTimersByTimeAsync(30_000);
    const p = lc.renew();
    lc.relinquish();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await p).toBe(false);
    expect(lc.holdsLease()).toBe(false);
  });

  it('a verified higher-epoch ack blocks the solo-captain hold', async () => {
    const { lc, tunnel, connect } = mesh({ bEpoch: 2, peerIds: ['B'], solo: true });
    expect(await lc.acquireIfEligible()).toBe(true);
    connect();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(await lc.renew()).toBe(false);
    expect(tunnel.higherEpochEvidence()).toBe(2);
    expect(lc.holdsLease()).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    expect(lc.currentHolder()).toBe('B'); // B's signed lease recovered through the pull path
  });

  it('B reports epoch 2 while C confirms epoch 1: the old holder is fenced', async () => {
    const { lc, connect } = mesh({ bEpoch: 2, peerIds: ['B', 'C'] });
    expect(await lc.acquireIfEligible()).toBe(true);
    connect();
    await vi.advanceTimersByTimeAsync(30_000);
    await lc.renew();
    await vi.advanceTimersByTimeAsync(10);
    expect(lc.holdsLease()).toBe(false);
    expect(await lc.renew()).toBe(false); // a later same-epoch confirmation cannot erase it
    expect(lc.holdsLease()).toBe(false);
  });

  it('C confirms first, B\'s verified higher-epoch ack arrives after early success: the old holder is fenced', async () => {
    const { lc, tunnel, connect } = mesh({ bEpoch: 2, bDelayMs: 100, peerIds: ['B', 'C'] });
    expect(await lc.acquireIfEligible()).toBe(true);
    connect();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await lc.renew()).toBe(true); // early success on C
    expect(lc.holdsLease()).toBe(true);
    await vi.advanceTimersByTimeAsync(100); // B's authenticated epoch-2 ack lands late
    expect(tunnel.higherEpochEvidence()).toBe(2);
    expect(lc.holdsLease()).toBe(false);
  });

  it('a higher-epoch ack arriving after the deadline still fences, and no late adopt revives the lease', async () => {
    const { lc, tunnel, connect } = mesh({ bEpoch: 2, bDelayMs: 12_000, peerIds: ['B'] });
    expect(await lc.acquireIfEligible()).toBe(true);
    connect();
    await vi.advanceTimersByTimeAsync(30_000);
    const p = lc.renew();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await p).toBe(true); // grace — nothing confirmed yet
    await vi.advanceTimersByTimeAsync(4_000);
    expect(tunnel.higherEpochEvidence()).toBe(2);
    expect(lc.holdsLease()).toBe(false);
  });
});
