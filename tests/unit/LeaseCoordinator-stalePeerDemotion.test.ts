/**
 * Regression: a STALE/EXPIRED or lower-epoch observed peer lease must NEVER
 * demote a legitimate holder via the active-pull loop.
 *
 * Live incident 2026-06-02 (the real laptop+mini pair): the pull-loop demotion
 * gate was `if (observedPeerLease())` — ANY non-null observed peer. A standby
 * peer kept disclosing a 2-DAY-EXPIRED, epoch-150 lease, so every time the live
 * holder's own ~60s lease lapsed transiently between renewals it flipped to
 * read-only standby (~50% of the time), blocking real writes (#673 caught the
 * crash but the writes still failed). The fix gates the demotion on
 * `peerLeaseSupersedes()` — LIVE (not expired) AND strictly-higher epoch than our
 * own self-issued lease. This test is the deterministic ground truth: live
 * observation on the real pair was too flaky to prove a timing-sensitive race.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { FencedLease, type LeaseCrypto } from '../../src/core/FencedLease.js';
import { LeaseCoordinator } from '../../src/core/LeaseCoordinator.js';
import { LocalLeaseStore } from '../../src/core/LocalLeaseStore.js';
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
const FAILOVER = 15 * 60_000;
function fl(self: string) { return new FencedLease(crypt(self), { leaseTtlMs: TTL, failoverThresholdMs: FAILOVER }); }

describe('LeaseCoordinator.peerLeaseSupersedes — stale/lower peer must not demote a holder (incident 2026-06-02)', () => {
  let dir: string;
  let now: number;
  let observedPeer: LeaseRecord | null;
  let lc: LeaseCoordinator;

  function tunnel() {
    return {
      broadcast: async () => true,
      observed: () => ({
        lease: observedPeer,
        lastNonceByHolder: observedPeer ? { [observedPeer.holder]: observedPeer.nonce } : {},
      }),
      isReachable: () => true,
      pullAllPeers: async () => { /* observed() reads the injected buffer */ },
    };
  }

  /** A peer (B) lease at a given epoch with an explicit expiry instant. */
  function peerLease(epoch: number, expiresAtMs: number, acquiredAtMs = now): LeaseRecord {
    return fl('B').signLease(epoch, new Date(acquiredAtMs).toISOString(), new Date(expiresAtMs).toISOString(), 1);
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-stale-'));
    now = 2_000_000; // arbitrary fixed clock
    observedPeer = null;
    lc = new LeaseCoordinator({
      lease: fl('A'),
      store: new LocalLeaseStore({ filePath: path.join(dir, 'a.json') }),
      tunnel: tunnel(),
      presumedDeadHolders: () => new Set(),
      now: () => now,
      monotonicNow: () => now,
    });
    // A acquires a fresh lease at epoch 1 (no peer observed at acquire time).
    expect(await lc.acquireIfEligible()).toBe(true);
    expect(lc.holdsLease()).toBe(true);
    expect(lc.currentEpoch()).toBe(1);
  });

  afterEach(() => {
    try {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/LeaseCoordinator-stalePeerDemotion.test.ts' });
    } catch { /* ignore */ }
  });

  it('no observed peer → does not supersede', () => {
    observedPeer = null;
    expect(lc.peerLeaseSupersedes()).toBe(false);
  });

  it('THE INCIDENT: an EXPIRED, lower-epoch peer lease does NOT supersede the live holder', () => {
    // Mirror the real shape: peer at a lower epoch, long expired (2 days).
    const twoDays = 2 * 24 * 60 * 60 * 1000;
    observedPeer = peerLease(0, now - twoDays, now - twoDays);
    expect(lc.peerLeaseSupersedes()).toBe(false);
  });

  it('an EXPIRED peer lease does NOT supersede even at a HIGHER epoch (expiry strips authority)', () => {
    observedPeer = peerLease(99, now - 1000); // epoch 99 (>1) but expired 1s ago
    expect(lc.peerLeaseSupersedes()).toBe(false);
  });

  it('a LIVE peer lease at our epoch or below does NOT supersede', () => {
    observedPeer = peerLease(1, now + TTL); // live, same epoch → contested resolver's job, not a demote
    expect(lc.peerLeaseSupersedes()).toBe(false);
  });

  it('a LIVE, strictly-higher-epoch peer lease DOES supersede (genuine takeover preserved)', () => {
    observedPeer = peerLease(2, now + TTL); // live, higher epoch
    expect(lc.peerLeaseSupersedes()).toBe(true);
  });

  it('the incident self-lapse: our own lease lapsed AND only a stale peer is observed → still does NOT supersede', () => {
    // Advance the clock past our own lease expiry — the transient between-renewals
    // lapse that USED to trigger the spurious demotion in tickLeasePull.
    now += TTL + 1;
    expect(lc.holdsLease()).toBe(false); // our self-lease has lapsed (not yet renewed)
    observedPeer = peerLease(0, now - 60_000); // stale, lower-epoch peer still being disclosed
    // The bug demoted the holder right here. The fix: a stale peer carries no
    // fencing authority, so peerLeaseSupersedes() stays false → tickLease re-acquires.
    expect(lc.peerLeaseSupersedes()).toBe(false);
  });
});
