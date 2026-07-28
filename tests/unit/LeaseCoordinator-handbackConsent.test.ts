/**
 * U4.4 — LeaseCoordinator hand-back plumbing: mintHandbackConsent (HOLDER side)
 * + acquireOnHandbackConsent (PREFERRED-CAPTAIN side, the consent-authorized
 * canAcquire branch → fenced CAS).
 *
 * Locks: a non-holder can never mint consent; a valid token claims at the next
 * epoch (claim-before-release — the old holder steps down only by OBSERVING
 * the higher epoch); a replayed token is burned on FIRST presentation
 * (single-use, success or not); a bad/expired/foreign token changes NOTHING —
 * `failed-handback-never-leaves-zero-holders` at the coordinator level.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { FencedLease, type LeaseCrypto, type HandbackConsentToken } from '../../src/core/FencedLease.js';
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
const KEYS: Record<string, { publicKey: string; privateKey: string }> = { HOLDER: genKey(), CAPTAIN: genKey() };
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
const fl = (self: string) => new FencedLease(crypt(self), { leaseTtlMs: TTL, failoverThresholdMs: FAILOVER });

describe('LeaseCoordinator — hand-back consent (mint + consent-claim)', () => {
  let dir: string;
  let now: number;
  // ONE shared durable store — the CAS arbiter both coordinators talk to
  // (the real topology's git/local single source of truth).
  let holder: LeaseCoordinator;
  let captain: LeaseCoordinator;
  let observedByCaptain: LeaseRecord | null;

  const tunnelFor = (observed: () => LeaseRecord | null) => ({
    broadcast: async () => true,
    observed: () => ({ lease: observed(), lastNonceByHolder: {} }),
    isReachable: () => true,
    pullAllPeers: async () => {},
  });

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-handback-'));
    now = 5_000_000;
    observedByCaptain = null;
    const sharedPath = path.join(dir, 'lease.json');
    holder = new LeaseCoordinator({
      lease: fl('HOLDER'),
      store: new LocalLeaseStore({ filePath: sharedPath }),
      tunnel: tunnelFor(() => null),
      presumedDeadHolders: () => new Set(),
      now: () => now,
      monotonicNow: () => now,
    });
    captain = new LeaseCoordinator({
      lease: fl('CAPTAIN'),
      store: new LocalLeaseStore({ filePath: sharedPath }),
      tunnel: tunnelFor(() => observedByCaptain),
      presumedDeadHolders: () => new Set(),
      now: () => now,
      monotonicNow: () => now,
    });
    expect(await holder.acquireIfEligible()).toBe(true);
    expect(holder.holdsLease()).toBe(true);
    // The captain OBSERVES the holder's live lease (the normal steady state).
    observedByCaptain = holder.currentLease();
  });

  afterEach(() => {
    try {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/LeaseCoordinator-handbackConsent.test.ts' });
    } catch { /* ignore */ }
  });

  it('mintHandbackConsent: the holder mints a verifiable, epoch-bound token; a NON-holder mints null', () => {
    const token = holder.mintHandbackConsent('CAPTAIN', 60_000);
    expect(token).not.toBeNull();
    expect(token!.holder).toBe('HOLDER');
    expect(token!.epoch).toBe(holder.currentEpoch());
    expect(token!.target).toBe('CAPTAIN');
    expect(fl('CAPTAIN').verifyHandbackConsent(token!)).toBe(true);
    // The captain does not hold — it can never mint consent.
    expect(captain.mintHandbackConsent('HOLDER', 60_000)).toBeNull();
  });

  it('a VALID consent token claims at the NEXT epoch (claim-before-release)', async () => {
    const before = holder.currentEpoch();
    const token = holder.mintHandbackConsent('CAPTAIN', 60_000)!;
    const res = await captain.acquireOnHandbackConsent(token);
    expect(res.ok).toBe(true);
    expect(res.reason).toBe('handback-claimed');
    expect(captain.holdsLease()).toBe(true);
    expect(captain.currentEpoch()).toBe(before + 1);
    // The old holder's stamps go stale by the SAME fencing that guards every
    // transfer: the durable record now names CAPTAIN at the higher epoch.
    expect(captain.currentHolder()).toBe('CAPTAIN');
  });

  it('single-use: the token burns on FIRST presentation — a replay changes nothing', async () => {
    const token = holder.mintHandbackConsent('CAPTAIN', 60_000)!;
    expect((await captain.acquireOnHandbackConsent(token)).ok).toBe(true);
    const epochAfter = captain.currentEpoch();
    const replay = await captain.acquireOnHandbackConsent(token);
    expect(replay.ok).toBe(false);
    expect(captain.currentEpoch()).toBe(epochAfter); // no second CAS
  });

  it('failed-handback-never-leaves-zero-holders: expired/foreign/forged tokens change NOTHING', async () => {
    const live = holder.currentLease()!;
    const cases: HandbackConsentToken[] = [
      // expired
      fl('HOLDER').signHandbackConsent(live.epoch, 'CAPTAIN', new Date(now - 1).toISOString(), 11),
      // wrong target
      fl('HOLDER').signHandbackConsent(live.epoch, 'SOMEONE-ELSE', new Date(now + 60_000).toISOString(), 12),
      // wrong epoch (an old token after the lease moved)
      fl('HOLDER').signHandbackConsent(live.epoch - 1, 'CAPTAIN', new Date(now + 60_000).toISOString(), 13),
      // forged signature
      { holder: 'HOLDER', epoch: live.epoch, target: 'CAPTAIN', expiresAt: new Date(now + 60_000).toISOString(), nonce: 14, signature: 'AAAA' },
    ];
    for (const token of cases) {
      const res = await captain.acquireOnHandbackConsent(token);
      expect(res.ok).toBe(false);
      expect(captain.holdsLease()).toBe(false);
    }
    // The HOLDER still holds — a failed hand-back can never leave zero holders.
    expect(holder.holdsLease()).toBe(true);
    expect(holder.currentHolder()).toBe('HOLDER');
  });

  it('FAIL-CLOSED grant discipline: a coincidentally-claimable lease does not launder a bad token', async () => {
    // Expire the holder's lease (a non-consent grant path would open), then
    // present an INVALID token: the consent path must refuse rather than let
    // the bad token ride the expiry grant.
    now += TTL + 5_000;
    const bad: HandbackConsentToken = { holder: 'HOLDER', epoch: 1, target: 'CAPTAIN', expiresAt: new Date(now + 60_000).toISOString(), nonce: 20, signature: 'AAAA' };
    const res = await captain.acquireOnHandbackConsent(bad);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('non-consent-grant-refused');
  });
});
