/**
 * lease-restart-no-tie: the loop measured on a live pair with no shared store (fb-c51067c6-148).
 * A machine that restarted claimed the lease from its own stale copy, tied with the live holder,
 * and the tie made one of them restart again, every 15 minutes, for good. Two coordinators over
 * real LocalLeaseStores and the real HttpLeaseTransport. A "restart" is a new coordinator and
 * transport over the same file, which is exactly what survives a real one.
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

describe('a restart on a pair with no shared store', () => {
  let dir: string;
  let now: number;
  let seq: number;
  let up: Record<string, boolean>;
  const live: Record<string, { lc: LeaseCoordinator; t: HttpLeaseTransport }> = {};

  const bridge = (async (url: string, opts: { body?: string }) => {
    const id = new URL(url).host.toUpperCase();
    if (!up[id] || !live[id]) return { ok: false };
    if (url.endsWith('/api/lease/pull')) {
      live[id].lc.confirmHoldOnPeerPull(); // as the route does
      return { ok: true, json: async () => ({ lease: live[id].lc.currentLease() }) };
    }
    const body = opts?.body ? JSON.parse(opts.body) : {};
    if (body?.lease) live[id].t.recordObserved(body.lease);
    return { ok: true };
  }) as unknown as typeof fetch;

  function boot(self: 'A' | 'B', o: { named?: boolean } = {}): LeaseCoordinator {
    const other = self === 'A' ? 'B' : 'A';
    const t = new HttpLeaseTransport({
      selfMachineId: self, signingKeyPem: KEYS[self].privateKey,
      peers: () => [{ machineId: other, url: `http://${other.toLowerCase()}` }],
      nextSequence: () => ++seq, reachabilityWindowMs: TTL, fetchImpl: bridge, now: () => now,
    });
    const lc = new LeaseCoordinator({
      lease: new FencedLease(crypt(self), { leaseTtlMs: TTL, failoverThresholdMs: 15 * 60_000 }),
      store: new LocalLeaseStore({ filePath: path.join(dir, `${self}.json`) }),
      tunnel: t, presumedDeadHolders: () => new Set(), now: () => now, monotonicNow: () => now,
      soloCaptainHold: () => null, // the switch off, as on the pair that showed this
      survivorMayHold: () => !o.named,
    });
    live[self] = { lc, t };
    up[self] = false; // a real server claims and pulls before it listens
    return lc;
  }
  /** B held once at epoch `epoch`, lost it, and A has held since. */
  async function bHeldThenLost(): Promise<void> {
    up.A = false;
    const b = boot('B');
    expect(await b.acquireIfEligible()).toBe(true);
    now += TTL * 2;
    const a = boot('A');
    up.B = false;
    expect(await a.acquireIfEligible()).toBe(true);
    now += TTL * 2;
    expect(await a.acquireIfEligible()).toBe(true);
    await a.renew();
    up.A = true;
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-restart-'));
    now = 2_000;
    seq = 0;
    up = { A: false, B: false };
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/lease-restart-no-tie.test.ts' });
  });

  /** Renew the way a running holder does: well inside the lease lifetime, for this long. */
  async function holderRenewsFor(a: LeaseCoordinator, ms: number): Promise<void> {
    for (let t = 0; t < ms; t += TTL / 3) {
      now += TTL / 3;
      await a.renew();
    }
  }

  it('a holder that stays up keeps the lease through ten restarts of the other machine', async () => {
    await bHeldThenLost();
    const a = live.A.lc;
    const epoch = a.currentEpoch();
    for (let i = 0; i < 10; i++) {
      const b = boot('B');
      expect(await b.acquireIfEligible()).toBe(false);
      expect(b.holdsLease()).toBe(false);
      expect(b.currentHolder()).toBe('A');
      expect(b.currentEpoch()).toBe(epoch);
      expect(a.holdsLease()).toBe(true);
      up.B = true;
      await holderRenewsFor(a, 15 * 60_000); // B runs for a while
      up.B = false; // then goes down for the measured time from exit to next boot
      now += 13_000;
      await a.renew();
    }
    expect(a.holdsLease()).toBe(true);
    expect(a.currentEpoch()).toBe(epoch);
  });

  it('a restart that outlasts the lease hands over once, and then stops', async () => {
    await bHeldThenLost();
    const a = live.A.lc;
    const epoch = a.currentEpoch();
    now += TTL * 2; // B stays down past the lease, so A cannot confirm and its lease lapses
    await a.renew();
    expect(a.holdsLease()).toBe(false);
    const b = boot('B');
    expect(await b.acquireIfEligible()).toBe(true);
    const taken = b.currentEpoch();
    expect(taken).toBeGreaterThan(epoch);
    up.B = true;
    await b.renew();
    // A follows by restarting, which is what the role change does. That restart must end it.
    for (let i = 0; i < 5; i++) {
      const a2 = boot('A');
      expect(await a2.acquireIfEligible()).toBe(false);
      expect(a2.currentHolder()).toBe('B');
      up.A = true;
      await holderRenewsFor(b, 15 * 60_000);
      up.A = false;
      now += 13_000;
      await b.renew();
    }
    expect(b.holdsLease()).toBe(true);
    expect(b.currentEpoch()).toBe(taken);
  });

  it('with the holder really down, the restarted machine takes over, and the holder does not fight it on return', async () => {
    await bHeldThenLost();
    up.A = false;
    now += TTL * 2;
    const b = boot('B');
    expect(await b.acquireIfEligible()).toBe(true);
    expect(b.holdsLease()).toBe(true);
    // B could not see the number A reached, so both can stand at one number. A's copy is the lapsed one.
    expect(b.currentEpoch()).toBe(live.A.lc.currentEpoch());
    up.B = true;
    await b.renew();
    const a = boot('A');
    expect(await a.acquireIfEligible()).toBe(false);
    expect(a.holdsLease()).toBe(false);
    expect(b.holdsLease()).toBe(true);
  });

  it('a machine with no lease file asks too, and stays standby behind a live holder', async () => {
    await bHeldThenLost();
    SafeFsExecutor.safeRmSync(path.join(dir, 'B.json'), { force: true, operation: 'tests/integration/lease-restart-no-tie.test.ts' });
    const b = boot('B');
    expect(await b.acquireIfEligible()).toBe(false);
    expect(b.currentHolder()).toBe('A');
  });

  it('a pool with a named machine does not ask, as before', async () => {
    await bHeldThenLost();
    let pulls = 0;
    const b = boot('B', { named: true });
    const pull = live.B.t.pullAllPeers.bind(live.B.t);
    live.B.t.pullAllPeers = async () => { pulls++; await pull(); };
    await b.acquireIfEligible();
    expect(pulls).toBe(0);
  });
});
