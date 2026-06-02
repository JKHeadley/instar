/**
 * Integration proof for #680 Problem A — git-less same-epoch lease convergence
 * driven through the REAL HttpLeaseTransport wire path (broadcast / pullPeer /
 * recordObserved + real request signing), not the in-memory tunnel mock the
 * LeaseCoordinator-convergence unit test uses.
 *
 * Two LeaseCoordinators (A, B) over git-less LocalLeaseStores are wired to two
 * real HttpLeaseTransports, bridged by an in-process fetch that faithfully
 * implements the POST /api/lease (recordObserved) + POST /api/lease/pull (serve
 * currentLease) contract. This is the closest deterministic proxy to the live
 * two-machine mesh — same transport code, no orphaned servers, no registry/key
 * plumbing. It proves the v3 resolution (loser relinquishes + winner advances
 * once to N+1) converges with the lease actually travelling over the wire path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { FencedLease, type LeaseCrypto } from '../../src/core/FencedLease.js';
import { LeaseCoordinator } from '../../src/core/LeaseCoordinator.js';
import { LocalLeaseStore } from '../../src/core/LocalLeaseStore.js';
import { HttpLeaseTransport } from '../../src/core/HttpLeaseTransport.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
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
function fl(self: string) { return new FencedLease(crypt(self), { leaseTtlMs: TTL, failoverThresholdMs: 15 * 60_000 }); }

describe('Lease convergence over the REAL HttpLeaseTransport (#680 Problem A)', () => {
  let dir: string;
  let now: number;
  let linked: boolean;
  let lcA: LeaseCoordinator;
  let lcB: LeaseCoordinator;
  let seq = 0;

  // In-process fetch bridge: routes POST /api/lease → target.recordObserved, and
  // POST /api/lease/pull → { lease: target.currentLease() }. Unreachable until
  // `linked` (models each machine booting solo before they discover each other).
  function makeBridge(handlers: () => Record<string, { transport: HttpLeaseTransport; coord: () => LeaseCoordinator }>) {
    return (async (url: string, opts: any) => {
      if (!linked) return { ok: false } as any;
      const host = new URL(url).host; // 'a' or 'b'
      const target = handlers()[host];
      if (!target) return { ok: false } as any;
      const body = opts?.body ? JSON.parse(opts.body) : {};
      if (url.endsWith('/api/lease/pull')) {
        return { ok: true, json: async () => ({ lease: target.coord().currentLease() }) } as any;
      }
      if (url.endsWith('/api/lease')) {
        if (body?.lease) target.transport.recordObserved(body.lease);
        return { ok: true } as any;
      }
      return { ok: false } as any;
    }) as unknown as typeof fetch;
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-http-'));
    now = 2_000;
    linked = false;
    seq = 0;

    let tA!: HttpLeaseTransport;
    let tB!: HttpLeaseTransport;
    const bridge = makeBridge(() => ({
      a: { transport: tA, coord: () => lcA },
      b: { transport: tB, coord: () => lcB },
    }));
    tA = new HttpLeaseTransport({
      selfMachineId: 'A', signingKeyPem: KEYS.A.privateKey,
      peers: () => [{ machineId: 'B', url: 'http://b' }],
      nextSequence: () => ++seq, reachabilityWindowMs: TTL, fetchImpl: bridge, now: () => now,
    });
    tB = new HttpLeaseTransport({
      selfMachineId: 'B', signingKeyPem: KEYS.B.privateKey,
      peers: () => [{ machineId: 'A', url: 'http://a' }],
      nextSequence: () => ++seq, reachabilityWindowMs: TTL, fetchImpl: bridge, now: () => now,
    });
    lcA = new LeaseCoordinator({
      lease: fl('A'), store: new LocalLeaseStore({ filePath: path.join(dir, 'a.json') }),
      tunnel: tA, presumedDeadHolders: () => new Set(), now: () => now, monotonicNow: () => now,
    });
    lcB = new LeaseCoordinator({
      lease: fl('B'), store: new LocalLeaseStore({ filePath: path.join(dir, 'b.json') }),
      tunnel: tB, presumedDeadHolders: () => new Set(), now: () => now, monotonicNow: () => now,
    });

    // Post-teardown split-brain: each acquires epoch 1 SOLO (unlinked → broadcast
    // is an unreachable no-op, so neither observes the other at acquire).
    expect(await lcA.acquireIfEligible()).toBe(true);
    expect(await lcB.acquireIfEligible()).toBe(true);
    linked = true; // the wire now carries each peer's lease
  });

  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/lease-http-convergence.test.ts' }); } catch { /* ignore */ }
  });

  it('sets up a genuine same-epoch split-brain (both hold epoch 1)', () => {
    expect(lcA.currentHolder()).toBe('A');
    expect(lcB.currentHolder()).toBe('B');
    expect(lcA.currentEpoch()).toBe(1);
    expect(lcB.currentEpoch()).toBe(1);
  });

  it('CONVERGES over the real wire: pull surfaces the peer, winner advances to N+1, loser adopts it', async () => {
    // Each pulls the other over the real transport → observes the same-epoch peer.
    await lcA.pullFromPeers();
    await lcB.pullFromPeers();
    expect(lcA.observedPeerLease()?.holder).toBe('B'); // B@1 arrived over the wire
    expect(lcB.observedPeerLease()?.holder).toBe('A');

    // v3 resolution (A = lower machineId = winner; B = loser):
    lcB.relinquish();                          // loser steps down
    await lcA.advanceEpochForContestedWin();   // winner → epoch 2, BROADCAST over the wire

    // Winner: holds epoch 2.
    expect(lcA.currentHolder()).toBe('A');
    expect(lcA.holdsLease()).toBe(true);
    expect(lcA.currentEpoch()).toBe(2);

    // Loser: adopts winner@2 — the lease arrived via the real broadcast→recordObserved
    // path (not a hand-injected mock). currentHolder() names the WINNER (the headless-
    // loser guard), holdsLease() false.
    expect(lcB.currentHolder()).toBe('A');
    expect(lcB.holdsLease()).toBe(false);
    expect(lcB.currentEpoch()).toBe(2);
  });

  it('the winner advancing ALONE propagates over the wire and demotes the loser (no explicit relinquish)', async () => {
    await lcA.advanceEpochForContestedWin(); // A → 2, broadcast to B over the wire
    expect(lcB.currentHolder()).toBe('A');   // B observed A@2 via recordObserved
    expect(lcB.holdsLease()).toBe(false);
  });
});
