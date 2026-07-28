/**
 * MultiMachineCoordinator contested-resolution orchestration (#680 Problem A v3,
 * docs/specs/MULTI-MACHINE-LEASE-ROBUSTNESS-SPEC.md).
 *
 * surfacePullDiscoveredSplitBrain only DETECTS; resolveContestedSplitBrain ACTS.
 * This exercises BOTH sides of the tie-break decision boundary on the real pull
 * loop (single MMC + a controllable observed peer):
 *   - WINNER (lower machineId): advances ONCE to N+1, and the one-shot latch
 *     means the epoch does NOT climb on subsequent ticks (no re-leapfrog).
 *   - LOSER (higher machineId): relinquishes (holdsLease→false, role→standby).
 *   - Bounded escalation: a persistently-contested episode emits ONE deduped
 *     splitBrainEscalation with a deterministic "demote <loser>" recommendation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { MultiMachineCoordinator } from '../../src/core/MultiMachineCoordinator.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { FencedLease, type LeaseCrypto } from '../../src/core/FencedLease.js';
import { LeaseCoordinator, type LeaseTransport } from '../../src/core/LeaseCoordinator.js';
import { LocalLeaseStore } from '../../src/core/LocalLeaseStore.js';
import type { LeaseRecord } from '../../src/core/types.js';

function genKey() {
  return crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}
const KEYS: Record<string, { publicKey: string; privateKey: string }> = { Aaa: genKey(), Bbb: genKey(), Zzz: genKey() };
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
function seedIdentity(stateDir: string, machineId: string) {
  const identity = { machineId, signingPublicKey: 'k1', encryptionPublicKey: 'k2', name: machineId, platform: 'test', createdAt: new Date(2_000).toISOString(), capabilities: ['sessions'] };
  fs.mkdirSync(path.join(stateDir, 'machine'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'machine', 'identity.json'), JSON.stringify(identity));
  return identity;
}

describe('MultiMachineCoordinator — contested-resolution (Problem A v3)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmc-resolve-')); });
  afterEach(() => {
    vi.useRealTimers();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/lease-contested-resolution.test.ts' });
  });

  /** Build one MMC whose machineId === its FencedLease id (so the tie-break is
   *  meaningful), with a controllable `observed` peer lease. */
  async function setup(selfId: string, peerLeaseGetter: () => LeaseRecord | null) {
    seedIdentity(dir, selfId);
    new MachineIdentityManager(dir).registerMachine(
      { machineId: selfId, signingPublicKey: 'k1', encryptionPublicKey: 'k2', name: selfId, platform: 'test', createdAt: new Date(2_000).toISOString(), capabilities: ['sessions'] } as any,
      'awake',
    );
    const tunnel: LeaseTransport = {
      broadcast: async () => true,
      observed: () => { const p = peerLeaseGetter(); return { lease: p, lastNonceByHolder: p ? { [p.holder]: p.nonce } : {} }; },
      isReachable: () => true,
      pullAllPeers: async () => { /* observed() reads the controllable peer */ },
    };
    const lc = new LeaseCoordinator({
      lease: fl(selfId), store: new LocalLeaseStore({ filePath: path.join(dir, 'lease-local.json') }),
      tunnel, presumedDeadHolders: () => new Set(), now: () => 2_000, monotonicNow: () => 2_000,
    });
    vi.useFakeTimers();
    const coord = new MultiMachineCoordinator(new StateManager(dir), { stateDir: dir, multiMachine: { leasePullIntervalMs: 1_000 } as any });
    coord.start();
    coord.attachLeaseCoordinator(lc);
    await coord.initializeLease(); // selfId acquires epoch 1 (peer not yet visible)
    return { lc, coord };
  }

  it('WINNER (lower machineId) advances ONCE to N+1; the latch stops the epoch climbing', async () => {
    let peer: LeaseRecord | null = null;
    const { lc, coord } = await setup('Aaa', () => peer);
    expect(lc.currentEpoch()).toBe(1);
    expect(lc.holdsLease()).toBe(true);

    // A higher-machineId peer at the same epoch appears (Aaa < Bbb → we WIN).
    peer = fl('Bbb').buildAcquisition(undefined, 1_000, 7); // Bbb @ epoch 1

    await vi.advanceTimersByTimeAsync(1_300); // one pull tick → resolve → advance
    expect(lc.currentEpoch()).toBe(2);          // advanced once
    expect(lc.holdsLease()).toBe(true);
    expect(lc.currentHolder()).toBe('Aaa');

    // Several more ticks: the one-shot latch means NO further advance (no leapfrog).
    await vi.advanceTimersByTimeAsync(5_000);
    expect(lc.currentEpoch()).toBe(2);          // STILL 2 — epoch stopped climbing
    coord.stop();
  });

  it('LOSER (higher machineId) relinquishes — stops holding, reconciles to standby', async () => {
    let peer: LeaseRecord | null = null;
    const { lc, coord } = await setup('Zzz', () => peer);
    expect(lc.holdsLease()).toBe(true);
    expect(coord.isAwake).toBe(true);

    // A lower-machineId peer at the same epoch appears (Aaa < Zzz → we LOSE).
    peer = fl('Aaa').buildAcquisition(undefined, 1_000, 7); // Aaa @ epoch 1

    await vi.advanceTimersByTimeAsync(1_300); // one pull tick → resolve → relinquish
    expect(lc.holdsLease()).toBe(false);        // relinquished
    expect(coord.getSyncStatus().role).toBe('standby');
    coord.stop();
  });

  it('bounded escalation: a persistently-contested episode emits ONE deduped splitBrainEscalation', async () => {
    // A "stuck" peer that keeps pace at our epoch every tick (a leapfrogger that
    // never converges) → the WINNER advances once, but the peer keeps reappearing
    // at-or-above our epoch, so the episode persists past K cycles.
    let peerActive = false; // invisible during the solo acquire, like the other tests
    let peerEpoch = 1;
    const peerGetter = (): LeaseRecord | null => {
      if (!peerActive) return null;
      // Bbb keeps claiming the SAME epoch we currently hold (a stuck leapfrogger
      // that never converges). buildAcquisition writes currentEpoch+1, so pass
      // {epoch: peerEpoch-1} to land the peer exactly at peerEpoch.
      return fl('Bbb').buildAcquisition({ epoch: peerEpoch - 1 } as unknown as LeaseRecord, 1_000, 100 + peerEpoch);
    };
    const { lc, coord } = await setup('Aaa', peerGetter);
    expect(lc.holdsLease()).toBe(true); // acquired epoch 1 solo
    peerActive = true;                  // now the stuck leapfrogger appears
    const escalations: any[] = [];
    coord.on('splitBrainEscalation', (e: any) => escalations.push(e));

    // Keep the peer pinned at our epoch each tick so `peer.epoch >= ourEpoch` holds.
    for (let i = 0; i < 8; i++) {
      peerEpoch = lc.currentEpoch();
      await vi.advanceTimersByTimeAsync(1_300);
    }

    expect(escalations.length).toBe(1);                       // deduped — exactly once
    expect(escalations[0].recommendation).toBe('demote Bbb'); // deterministic loser (Bbb > Aaa)
    expect(escalations[0].winner).toBe('Aaa');
    coord.stop();
  });
});
