/**
 * Regression (2026-05-31, found via live two-machine test): a standby that joins
 * the pool over HTTP — WITHOUT a git medium — must still resolve the lease holder,
 * or MeshRpc rejects the holder's router-only commands (deliverMessage/place/
 * transfer) as `not-router` and cross-machine session transfer is impossible.
 *
 * The original bug was server-wiring: the LeaseCoordinator block was nested inside
 * a git-gated try, so when git-sync was unavailable (gitBackup off, or SourceTreeGuard
 * refusing GitSyncManager on an instar-source-tree home) the whole lease coordinator
 * — including the git-LESS HttpLeaseTransport — never ran, leaving the standby with
 * leaseHolder=null. These tests lock in the composition the fix relies on: a git-less
 * standby (LocalLeaseStore + HttpLeaseTransport observed broadcast) resolves the holder.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { FencedLease, type LeaseCrypto } from '../../src/core/FencedLease.js';
import { LeaseCoordinator, type LeaseTransport } from '../../src/core/LeaseCoordinator.js';
import { LocalLeaseStore } from '../../src/core/LocalLeaseStore.js';
import { HttpLeaseTransport } from '../../src/core/HttpLeaseTransport.js';
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
function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'slo-')), 'lease-local.json');
}

describe('standby learns the lease holder over HTTP without git', () => {
  it('git-less standby (LocalLeaseStore) resolves the holder from a tunnel-observed broadcast', () => {
    // Holder A's lease at epoch 1, signed by A.
    const aLease = fl('A').buildAcquisition(undefined, 1000, 1);
    // Standby B: empty local store + a tunnel that has OBSERVED A's broadcast.
    const tunnel: LeaseTransport = {
      broadcast: async () => true,
      observed: () => ({ lease: aLease, lastNonceByHolder: {} }),
      isReachable: () => true,
    };
    const lcB = new LeaseCoordinator({
      lease: fl('B'),
      store: new LocalLeaseStore({ filePath: tmpFile() }),
      tunnel,
      presumedDeadHolders: () => new Set(),
      now: () => 2000,
    });
    // Before the fix the standby had NO lease coordinator at all → null → not-router.
    expect(lcB.currentHolder()).toBe('A');
    expect(lcB.holdsLease()).toBe(false); // B is standby; A holds.
  });

  it('real HttpLeaseTransport.recordObserved feeds the git-less standby currentHolder', () => {
    const aLease = fl('A').buildAcquisition(undefined, 1000, 1);
    const transport = new HttpLeaseTransport({
      selfMachineId: 'B',
      signingKeyPem: KEYS.B.privateKey,
      peers: () => [],
      nextSequence: () => 1,
    });
    transport.recordObserved(aLease); // simulate the POST /api/lease receive on the standby
    const lcB = new LeaseCoordinator({
      lease: fl('B'),
      store: new LocalLeaseStore({ filePath: tmpFile() }),
      tunnel: transport,
      presumedDeadHolders: () => new Set(),
      now: () => 2000,
    });
    expect(lcB.currentHolder()).toBe('A');
  });

  it('holder side: a git-less holder acquires via LocalLeaseStore and broadcasts so a standby can observe it', async () => {
    let broadcasted: LeaseRecord | null = null;
    const tunnel: LeaseTransport = {
      broadcast: async (l) => { broadcasted = l; return true; },
      observed: () => ({ lease: null, lastNonceByHolder: {} }),
      isReachable: () => true,
    };
    const lcA = new LeaseCoordinator({
      lease: fl('A'),
      store: new LocalLeaseStore({ filePath: tmpFile() }),
      tunnel,
      presumedDeadHolders: () => new Set(),
      now: () => 1000,
    });
    expect(await lcA.acquireIfEligible()).toBe(true);
    expect(lcA.currentHolder()).toBe('A');
    // The acquisition is broadcast over the tunnel → a standby's recordObserved sees it.
    expect((broadcasted as LeaseRecord | null)?.holder).toBe('A');
  });
});
