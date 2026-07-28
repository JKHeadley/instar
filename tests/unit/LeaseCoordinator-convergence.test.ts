/**
 * Empirical convergence proof for the git-less same-epoch split-brain fix
 * (docs/specs/MULTI-MACHINE-LEASE-ROBUSTNESS-SPEC.md §Problem A).
 *
 * The DESIGN failed verification twice in convergence (R1 zombie-holder, R2
 * headless-loser); this test is the ground truth. Two coordinators both hold
 * epoch N over a git-less LocalLeaseStore (the post-teardown split-brain). After
 * the v3 resolution — loser relinquishes + winner advances ONCE to N+1 — assert
 * the SINGLE-holder fixpoint, INCLUDING the headless-loser guard: the loser's
 * currentHolder() must equal the WINNER (not itself, not null).
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

describe('LeaseCoordinator — git-less same-epoch convergence (#680 Problem A v3)', () => {
  let dir: string;
  let now: number;
  let linked: boolean;
  let mesh: Record<string, LeaseRecord | null>;
  let lcA: LeaseCoordinator;
  let lcB: LeaseCoordinator;

  /** Push-based tunnel: broadcast writes mesh[self]; observed reads mesh[peer]
   *  (only once linked). Reading a buffer — NOT the peer's live currentLease() —
   *  avoids mutual effectiveView() recursion and models the real push transport. */
  function tunnelFor(self: string, peer: string) {
    return {
      broadcast: async (lease: LeaseRecord) => { mesh[self] = lease; return true; },
      observed: () => {
        const p = linked ? mesh[peer] : null;
        return { lease: p, lastNonceByHolder: p ? { [p.holder]: p.nonce } : {} };
      },
      isReachable: () => true,
      pullAllPeers: async () => { /* push-based: observed() reads the buffer */ },
    };
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-conv-'));
    now = 2_000;
    linked = false;
    mesh = { A: null, B: null };
    lcA = new LeaseCoordinator({
      lease: fl('A'), store: new LocalLeaseStore({ filePath: path.join(dir, 'a.json') }),
      tunnel: tunnelFor('A', 'B'), presumedDeadHolders: () => new Set(), now: () => now, monotonicNow: () => now,
    });
    lcB = new LeaseCoordinator({
      lease: fl('B'), store: new LocalLeaseStore({ filePath: path.join(dir, 'b.json') }),
      tunnel: tunnelFor('B', 'A'), presumedDeadHolders: () => new Set(), now: () => now, monotonicNow: () => now,
    });
    // Post-teardown split-brain: each acquired epoch 1 SOLO (unlinked → no peer
    // observed), so both believe they hold epoch 1.
    expect(await lcA.acquireIfEligible()).toBe(true);
    expect(await lcB.acquireIfEligible()).toBe(true);
    linked = true; // the tunnel now carries each peer's lease (a push finally arrives)
  });

  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/LeaseCoordinator-convergence.test.ts' }); } catch { /* ignore */ }
  });

  it('sets up a genuine same-epoch split-brain (both hold epoch 1)', () => {
    expect(lcA.holdsLease()).toBe(true);
    expect(lcB.holdsLease()).toBe(true);
    expect(lcA.currentHolder()).toBe('A');
    expect(lcB.currentHolder()).toBe('B');
    expect(lcA.currentEpoch()).toBe(1);
    expect(lcB.currentEpoch()).toBe(1);
  });

  it('CONVERGES when the winner advances then the loser relinquishes', async () => {
    // A = lower machineId = winner; B = loser.
    await lcA.advanceEpochForContestedWin(); // A → epoch 2, broadcast
    lcB.relinquish();                        // B clears selfIssued + forces local expiry

    // Winner: holds epoch 2.
    expect(lcA.holdsLease()).toBe(true);
    expect(lcA.currentHolder()).toBe('A');
    expect(lcA.currentEpoch()).toBe(2);

    // Loser: the HEADLESS-LOSER GUARD — currentHolder() names the WINNER, not
    // itself, not null. holdsLease() false. This is the assertion R2 caught.
    expect(lcB.currentHolder()).toBe('A');
    expect(lcB.holdsLease()).toBe(false);
    expect(lcB.currentEpoch()).toBe(2);
  });

  it('CONVERGES regardless of order — loser relinquishes BEFORE the winner advances', async () => {
    lcB.relinquish();                        // loser yields first
    await lcA.advanceEpochForContestedWin(); // winner advances after

    expect(lcA.currentHolder()).toBe('A');
    expect(lcA.holdsLease()).toBe(true);
    expect(lcA.currentEpoch()).toBe(2);
    expect(lcB.currentHolder()).toBe('A'); // adopts winner@2 via strict-> fold
    expect(lcB.holdsLease()).toBe(false);
  });

  it('the winner advancing ALONE already demotes the loser (strict-> fold adopts N+1)', async () => {
    // Even without an explicit relinquish, once the winner is at N+1 the loser's
    // effectiveView folds it in (N+1 > N) and holdsLease() flips false.
    await lcA.advanceEpochForContestedWin();
    expect(lcB.currentHolder()).toBe('A');
    expect(lcB.holdsLease()).toBe(false);
  });

  it('relinquish() makes the loser stop holding and clears its self-claim', () => {
    expect(lcB.holdsLease()).toBe(true);
    lcB.relinquish();
    expect(lcB.holdsLease()).toBe(false);
  });

  it('forceLocalExpiry keeps the epoch FLOOR (a cleared-to-0 floor would let a stale lease win)', () => {
    const store = new LocalLeaseStore({ filePath: path.join(dir, 'c.json') });
    const lease = fl('A').buildAcquisition(undefined, now, 1); // epoch 1
    store.casWrite(lease);
    expect(store.read().epoch).toBe(1);
    store.forceLocalExpiry();
    // Epoch floor retained at 1 (not reset to 0); the record now reads expired.
    expect(store.read().epoch).toBe(1);
    expect(store.read().lease?.expiresAt).toBe(new Date(0).toISOString());
    // A same-or-lower epoch CAS still rejected (floor intact).
    expect(store.casWrite(lease).ok).toBe(false);
  });
});
