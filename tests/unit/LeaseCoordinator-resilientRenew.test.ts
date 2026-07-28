/**
 * B3 (multimachine-lease-poll-robustness) — the epoch-climb fix.
 *
 * Root cause: the lease TTL (default 60s) is SHORTER than the heartbeat tick that
 * renews it (120s), so a sole, uncontested holder's lease ALWAYS lapses before
 * the next tick → tickLease falls to acquireIfEligible → re-acquires at epoch+1
 * every tick (epoch climbs ~1/2min forever, observed live 2026-06-20).
 *
 * B3's fix is a dedicated renew timer at clamp(TTL×0.5,[5s,60s]) so the holder
 * renews (SAME epoch) before the lease lapses. These tests prove the load-bearing
 * property at the LeaseCoordinator level: renewing within the TTL keeps the epoch
 * stable, and (the contrast) letting it lapse is exactly what climbs the epoch.
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
const KEYS: Record<string, { publicKey: string; privateKey: string }> = { A: genKey() };
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

class FakeStore implements LeaseStore {
  lease: LeaseRecord | null = null;
  epoch = 0;
  refreshOk = true;
  read() { return { lease: this.lease, epoch: this.epoch }; }
  refresh(lease: LeaseRecord) {
    if (!this.refreshOk) return false;
    if ((this.lease?.epoch ?? 0) > lease.epoch) return false;
    this.lease = lease;
    return true;
  }
  casWrite(candidate: LeaseRecord) {
    if (candidate.epoch === this.epoch + 1) {
      this.lease = candidate;
      this.epoch = candidate.epoch;
      return { ok: true, observed: { lease: this.lease, epoch: this.epoch } };
    }
    return { ok: false, observed: { lease: this.lease, epoch: this.epoch } };
  }
}

function makeCoordinator(clockRef: { t: number }) {
  const store = new FakeStore();
  const lc = new LeaseCoordinator({
    lease: new FencedLease(crypt('A'), { leaseTtlMs: TTL, failoverThresholdMs: 15 * 60_000 }),
    store,
    presumedDeadHolders: () => new Set(),
    now: () => clockRef.t,
    monotonicNow: () => clockRef.t,
  });
  return { lc, store };
}

describe('B3 resilient renew — epoch stays stable when renewed within TTL', () => {
  it('renewing every TTL/2 keeps the SAME epoch over 50 cycles (no climb)', async () => {
    const clock = { t: 1_000 };
    const { lc } = makeCoordinator(clock);
    expect(await lc.acquireIfEligible()).toBe(true);
    const epoch0 = lc.currentEpoch();
    expect(epoch0).toBe(1);

    // What the B3 renew timer does: renew at TTL/2, before the lease lapses.
    for (let i = 0; i < 50; i++) {
      clock.t += TTL / 2;
      expect(lc.holdsLease()).toBe(true); // still fresh at TTL/2 — never lapses
      await lc.renew();
    }

    expect(lc.currentEpoch()).toBe(epoch0); // SAME epoch — no climb
    expect(lc.holdsLease()).toBe(true);
  });

  it('CONTRAST: letting the lease lapse (tick interval > TTL) re-acquires at epoch+1 — the bug B3 fixes', async () => {
    const clock = { t: 1_000 };
    const { lc } = makeCoordinator(clock);
    expect(await lc.acquireIfEligible()).toBe(true);
    expect(lc.currentEpoch()).toBe(1);

    // The OLD cadence: the renew tick (2×TTL, like the 120s heartbeat vs 60s TTL)
    // lands AFTER the lease already lapsed.
    clock.t += TTL * 2;
    expect(lc.holdsLease()).toBe(false); // lapsed — holdsLease() false
    await lc.acquireIfEligible(); // tickLease's fallback path
    expect(lc.currentEpoch()).toBe(2); // climbed +1 — exactly the observed bug
  });
});
