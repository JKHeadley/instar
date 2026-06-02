/**
 * Cross-Machine Coherence — the active lease-PULL loop surfaces a same-epoch
 * split-brain that the registry awakeMachineCount would miss.
 *
 * Scenario this locks in (the git-less LocalLeaseStore split-brain from
 * 2026-05-31): machine A holds epoch 1 and its OWN registry shows only itself
 * awake (count 1 → 'clear'). A peer B independently holds epoch 1 too. A push
 * never arrives (one-way/quiet network). The constant-cadence PULL fetches B's
 * same-epoch lease; effectiveView()'s tie-break keeps A as currentHolder, but
 * the loop reads the RAW observed peer lease and latches `contested` —
 * Near-Silently (no user buzz), visible only via getSyncStatus()/dashboard.
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

function tempDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'mmc-pull-')); }
function seedIdentity(stateDir: string, machineId: string) {
  const identity = {
    machineId, signingPublicKey: 'k1', encryptionPublicKey: 'k2',
    name: 'machine-a', platform: 'test', createdAt: new Date().toISOString(), capabilities: ['sessions'],
  };
  fs.mkdirSync(path.join(stateDir, 'machine'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'machine', 'identity.json'), JSON.stringify(identity));
  return identity;
}

describe('MultiMachineCoordinator — active lease-pull split-brain surface', () => {
  let dir: string;

  beforeEach(() => { dir = tempDir(); });
  afterEach(() => {
    vi.useRealTimers();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/MultiMachineCoordinator-leasePull.test.ts:afterEach' });
  });

  it('pull loop latches getSyncStatus().splitBrainState=contested when a same-epoch peer appears', async () => {
    const machineId = `m_${crypto.randomBytes(8).toString('hex')}`;
    const identity = seedIdentity(dir, machineId);
    const mgr = new MachineIdentityManager(dir);
    mgr.registerMachine(identity as any, 'awake');

    // A pull-capable tunnel. `observed` is null at acquire time (so A wins epoch 1
    // unopposed), then flips to a peer B at the SAME epoch (the split-brain).
    let observed: LeaseRecord | null = null;
    const tunnel: LeaseTransport = {
      broadcast: async () => true,
      observed: () => ({ lease: observed, lastNonceByHolder: observed ? { [observed.holder]: observed.nonce } : {} }),
      isReachable: () => true,
      pullAllPeers: async () => { /* the peer lease is folded by setting `observed` below */ },
    };
    const lc = new LeaseCoordinator({
      lease: fl('A'),
      store: new LocalLeaseStore({ filePath: path.join(dir, 'lease-local.json') }),
      tunnel,
      presumedDeadHolders: () => new Set(),
      now: () => 2_000,
    });

    vi.useFakeTimers();
    const state = new StateManager(dir);
    const coord = new MultiMachineCoordinator(state, { stateDir: dir, multiMachine: { leasePullIntervalMs: 1_000 } as any });
    coord.start();
    coord.attachLeaseCoordinator(lc);
    await coord.initializeLease(); // A acquires epoch 1; pull loop armed (observed still null)

    expect(lc.holdsLease()).toBe(true);
    expect(coord.getSyncStatus().splitBrainState).toBe('clear'); // registry sees only us

    // The peer's same-epoch lease now becomes observable (a push never reached us).
    observed = fl('B').buildAcquisition(undefined, 1_000, 7); // B at epoch 1, nonce 7

    // Fire one jittered pull tick (base 1000ms, ±20% → ≤1200ms).
    await vi.advanceTimersByTimeAsync(1_300);

    // currentHolder is still A (tie-break), but the pull surfaced the contention.
    expect(lc.currentHolder()).toBe('A');
    expect(coord.getSyncStatus().splitBrainState).toBe('contested');

    coord.stop();
  });

  it('REGRESSION (incident 2026-06-02): a solo holder whose self-lease lapses is NOT demoted by the pull loop when no peer lease was observed', async () => {
    // The crash-loop root cause: tickLeasePull reconciled role UNCONDITIONALLY every
    // ~5s. A solo machine's 60s self-lease momentarily lapses between renewals →
    // holdsLease() false → the pull loop flipped it to STANDBY → StateManager
    // read-only → a standby write crashed the server in a restart loop. The fix:
    // the pull loop only reconciles when a peer lease was actually OBSERVED.
    const machineId = `m_${crypto.randomBytes(8).toString('hex')}`;
    const identity = seedIdentity(dir, machineId);
    new MachineIdentityManager(dir).registerMachine(identity as any, 'awake');

    // Solo machine: pull-CAPABLE transport (loop arms) that NEVER observes a peer
    // lease (no peers; nothing pushed or pulled) → observed() always null.
    const soloTunnel: LeaseTransport = {
      broadcast: async () => true,
      observed: () => ({ lease: null, lastNonceByHolder: {} }),
      isReachable: () => true,
      pullAllPeers: async () => { /* solo: pulls nothing */ },
    };
    let now = 2_000;
    const lc = new LeaseCoordinator({
      lease: fl('A'),
      store: new LocalLeaseStore({ filePath: path.join(dir, 'lease-local.json') }),
      tunnel: soloTunnel,
      presumedDeadHolders: () => new Set(),
      now: () => now,
      monotonicNow: () => now,
    });

    vi.useFakeTimers();
    const state = new StateManager(dir);
    const coord = new MultiMachineCoordinator(state, { stateDir: dir, multiMachine: { leasePullIntervalMs: 1_000 } as any });
    coord.start();
    coord.attachLeaseCoordinator(lc);
    await coord.initializeLease(); // A acquires epoch 1 → awake
    expect(coord.isAwake).toBe(true);
    expect(lc.holdsLease()).toBe(true);
    expect(state.readOnly).toBe(false);

    // The self-lease LAPSES (TTL elapses before a renewal) — holdsLease() now false.
    now = 2_000 + TTL + 1;
    expect(lc.holdsLease()).toBe(false); // genuinely lapsed

    // Fire a pull tick. With NO peer observed, the pull loop must NOT reconcile/demote.
    await vi.advanceTimersByTimeAsync(1_300);

    expect(coord.isAwake).toBe(true);                 // NOT demoted by the pull loop
    expect(coord.getSyncStatus().role).toBe('awake');
    expect(state.readOnly).toBe(false);               // never flipped to read-only (no crash path)
    coord.stop();
  });

  it('pull loop does not arm when the transport cannot pull (git-only mesh)', async () => {
    const machineId = `m_${crypto.randomBytes(8).toString('hex')}`;
    const identity = seedIdentity(dir, machineId);
    new MachineIdentityManager(dir).registerMachine(identity as any, 'awake');

    const noPull: LeaseTransport = {
      broadcast: async () => true,
      observed: () => ({ lease: null, lastNonceByHolder: {} }),
      isReachable: () => true,
      // no pullAllPeers → canPullPeers() false
    };
    const lc = new LeaseCoordinator({
      lease: fl('A'),
      store: new LocalLeaseStore({ filePath: path.join(dir, 'lease-local.json') }),
      tunnel: noPull,
      presumedDeadHolders: () => new Set(),
      now: () => 2_000,
    });

    const state = new StateManager(dir);
    const coord = new MultiMachineCoordinator(state, { stateDir: dir, multiMachine: { leasePullIntervalMs: 1_000 } as any });
    coord.start();
    coord.attachLeaseCoordinator(lc);
    await coord.initializeLease();
    // Nothing to assert on a timer; the contract is "no crash, no contested state".
    expect(coord.getSyncStatus().splitBrainState).toBe('clear');
    coord.stop();
  });
});
