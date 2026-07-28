/**
 * machine-coherence-guard §5b — the LEASE-LIVE `awakeMachineCount` derivation.
 *
 * THE LOAD-BEARING SCENARIO (reproduces the live 2026-07-04 incident on the real
 * Laptop+Mini pair, and the original v1.3.722 report): a peer holds the lease and
 * is reachable over healthy ropes (Tailscale/LAN) while the Cloudflare rope is
 * dead — and the registry role field has NOT propagated the peer's 'awake' role.
 * The OLD counting rule read the stale registry role and reported
 * `awakeMachineCount: 0` even though `leaseHolder` correctly named the peer. The
 * new rule derives the count from the SAME authoritative lease observations that
 * `leaseHolder` uses, so it reports `1` + source `'lease-live'`.
 *
 * These tests drive the REAL getSyncStatus() path through a real
 * MultiMachineCoordinator + LeaseCoordinator, with a mock LeaseTransport whose
 * `observedByPeer()` stands in for "what the hedged multi-rope transport pulled
 * from the peer" (the hedge itself is covered by the PeerEndpointResolver /
 * HttpLeaseTransport suites — here the rope outcome is an input: the peer's lease
 * WAS observed, because Tailscale/LAN carried the pull past the dead Cloudflare
 * rope).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
const KEYS: Record<string, { publicKey: string; privateKey: string }> = { LAPTOP: genKey(), MINI: genKey() };
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
const NOW = 1_000_000;
function fl(self: string) { return new FencedLease(crypt(self), { leaseTtlMs: TTL, failoverThresholdMs: FAILOVER }); }

function seedIdentity(stateDir: string, machineId: string) {
  const identity = {
    machineId, signingPublicKey: 'k1', encryptionPublicKey: 'k2',
    name: machineId, platform: 'test', createdAt: new Date(NOW).toISOString(), capabilities: ['sessions'],
  };
  fs.mkdirSync(path.join(stateDir, 'machine'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'machine', 'identity.json'), JSON.stringify(identity));
  return identity;
}

/**
 * A pull-capable mock transport. `observedByPeer()` is the seam the §5b counting
 * rule reads. `observed()` returns the single latest slot (unused by the count).
 * `now` is shared with the coordinator/lease so freshness/liveness are deterministic.
 */
function mockTransport(
  peerObs: Map<string, { lease: LeaseRecord | null; observedAtMs: number }>,
  opts: { pullCapable?: boolean } = {},
): LeaseTransport {
  // A real pull records into BOTH observedByPeer (per-peer) and observed() (the
  // single latest slot leaseHolder reads) — so derive observed() from the freshest
  // highest-epoch live peer lease here, mirroring recordObserved().
  const bestObserved = (): LeaseRecord | null => {
    let best: LeaseRecord | null = null;
    for (const { lease } of peerObs.values()) {
      if (lease && (!best || lease.epoch > best.epoch)) best = lease;
    }
    return best;
  };
  const base: LeaseTransport = {
    broadcast: async () => true,
    observed: () => {
      const lease = bestObserved();
      return { lease, lastNonceByHolder: lease ? { [lease.holder]: lease.nonce } : {} };
    },
    isReachable: () => true,
    observedByPeer: () => peerObs,
  };
  if (opts.pullCapable !== false) base.pullAllPeers = async () => { /* the map is pre-seeded */ };
  return base;
}

describe('machine-coherence-guard §5b — lease-live awakeMachineCount', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-awake-')); });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/multimachine-awake-count-lease-live.test.ts:afterEach' }); });

  /** Build a standby Laptop coordinator whose lease transport has observed `peerObs`. */
  async function standbyLaptop(peerObs: Map<string, { lease: LeaseRecord | null; observedAtMs: number }>, opts: { pullCapable?: boolean } = {}) {
    const identity = seedIdentity(dir, 'LAPTOP');
    const mgr = new MachineIdentityManager(dir);
    mgr.registerMachine(identity as any, 'standby'); // Laptop is standby; registry role NOT awake
    const lc = new LeaseCoordinator({
      lease: fl('LAPTOP'),
      store: new LocalLeaseStore({ filePath: path.join(dir, 'lease-local.json') }),
      tunnel: mockTransport(peerObs, opts),
      presumedDeadHolders: () => new Set(),
      now: () => NOW,
      monotonicNow: () => NOW,
    });
    const coord = new MultiMachineCoordinator(new StateManager(dir), {
      stateDir: dir,
      // observe-only so the Laptop never acquires its own lease in the test (it is
      // the standby, learning the Mini's lease via the pull observation).
      multiMachine: { leasePullIntervalMs: 5_000, leaseSelfHeal: { leaseRole: 'observe-only' } } as any,
    });
    coord.start();
    coord.attachLeaseCoordinator(lc);
    await coord.initializeLease();
    return coord;
  }

  it('LOAD-BEARING: Mini holds the lease, reachable over Tailscale/LAN (Cloudflare dead), registry role NOT propagated → count is 1 + lease-live (NOT 0)', async () => {
    // The Mini's live, self-claiming lease was pulled over a healthy rope. The
    // registry still shows the Laptop=standby and no awake role for the Mini.
    const miniLease = fl('MINI').buildAcquisition(undefined, NOW, 42); // holder=MINI, live
    const coord = await standbyLaptop(new Map([['MINI', { lease: miniLease, observedAtMs: NOW }]]));

    const s = coord.getSyncStatus();
    expect(s.holdsLease).toBe(false);              // Laptop is standby
    expect(s.leaseHolder).toBe('MINI');            // lease path names the Mini
    expect(s.awakeMachineCountSource).toBe('lease-live');
    expect(s.awakeMachineCount).toBe(1);           // ← the fix: NOT 0
    expect(s.splitBrainState).toBe('clear');
    coord.stop();
  });

  it('self holds + one live self-claiming peer → count 2 → contested (genuine split-brain)', async () => {
    // Rare, but the count must SEE a genuine two-holder split. Laptop acquires its
    // own lease (peer not yet visible — a partition), THEN the peer's own live
    // self-lease at a LOWER epoch becomes observable on heal (does not supersede →
    // Laptop keeps the lease, but both are self-asserting awake).
    const identity = seedIdentity(dir, 'LAPTOP');
    new MachineIdentityManager(dir).registerMachine(identity as any, 'awake');
    const peerObs = new Map<string, { lease: LeaseRecord | null; observedAtMs: number }>();
    const lc = new LeaseCoordinator({
      lease: fl('LAPTOP'),
      store: new LocalLeaseStore({ filePath: path.join(dir, 'lease-local.json') }),
      tunnel: mockTransport(peerObs),
      presumedDeadHolders: () => new Set(),
      now: () => NOW,
      monotonicNow: () => NOW,
    });
    const coord = new MultiMachineCoordinator(new StateManager(dir), { stateDir: dir, multiMachine: { leasePullIntervalMs: 5_000 } as any });
    coord.start();
    coord.attachLeaseCoordinator(lc);
    await coord.initializeLease(); // Laptop acquires epoch 1 unopposed (peer not visible)
    expect(lc.holdsLease()).toBe(true);

    // Now the Mini's own lower-epoch live self-lease becomes observable (a stale
    // partitioned holder that has not yet stepped down). It does NOT supersede
    // Laptop (lower epoch), so Laptop keeps the lease — but the count sees both.
    peerObs.set('MINI', { lease: fl('MINI').buildAcquisition(undefined, NOW, 7), observedAtMs: NOW });

    const s = coord.getSyncStatus();
    expect(s.holdsLease).toBe(true);
    expect(s.awakeMachineCount).toBe(2);
    expect(s.awakeMachineCountSource).toBe('lease-live');
    expect(s.splitBrainState).toBe('contested');
    coord.stop();
  });

  it('a STALE observation (older than the freshness bound) does NOT count', async () => {
    const miniLease = fl('MINI').buildAcquisition(undefined, NOW, 42);
    // staleMs = max(30s, 3×5s) = 30s; observe 40s ago → aged out.
    const coord = await standbyLaptop(new Map([['MINI', { lease: miniLease, observedAtMs: NOW - 40_000 }]]));
    const s = coord.getSyncStatus();
    expect(s.awakeMachineCount).toBe(0);
    expect(s.awakeMachineCountSource).toBe('lease-live');
    coord.stop();
  });

  it('an EXPIRED peer lease carries no authority → does NOT count', async () => {
    // Acquired 2×TTL ago → expired at NOW.
    const expired = fl('MINI').buildAcquisition(undefined, NOW - 2 * TTL, 42);
    const coord = await standbyLaptop(new Map([['MINI', { lease: expired, observedAtMs: NOW }]]));
    const s = coord.getSyncStatus();
    expect(s.awakeMachineCount).toBe(0);
    coord.stop();
  });

  it('HEARSAY (a peer discloses a THIRD machine as holder) does NOT count', async () => {
    // The Mini's pulled VIEW names OTHER as holder (its effective view re-served a
    // third machine) — that is hearsay about someone else, not the Mini's self-claim.
    const otherLease = fl('MINI'); // signer irrelevant; holder mismatch is what matters
    const hearsay = { ...otherLease.buildAcquisition(undefined, NOW, 9), holder: 'OTHER' } as LeaseRecord;
    const coord = await standbyLaptop(new Map([['MINI', { lease: hearsay, observedAtMs: NOW }]]));
    const s = coord.getSyncStatus();
    expect(s.awakeMachineCount).toBe(0); // holder(OTHER) !== peerId(MINI)
    coord.stop();
  });

  it('an honest "no lease" observation from a peer does NOT count', async () => {
    const coord = await standbyLaptop(new Map([['MINI', { lease: null, observedAtMs: NOW }]]));
    const s = coord.getSyncStatus();
    expect(s.awakeMachineCount).toBe(0);
    expect(s.awakeMachineCountSource).toBe('lease-live');
    coord.stop();
  });

  it('LEGACY git-only mesh (transport cannot pull) → registry-role count, honestly tagged', async () => {
    // No pull capability → the lease-live basis is unavailable; the count degrades
    // to the registry role field, tagged 'registry-roles'.
    const identity = seedIdentity(dir, 'LAPTOP');
    const mgr = new MachineIdentityManager(dir);
    mgr.registerMachine(identity as any, 'awake'); // registry says the Laptop is awake
    const lc = new LeaseCoordinator({
      lease: fl('LAPTOP'),
      store: new LocalLeaseStore({ filePath: path.join(dir, 'lease-local.json') }),
      tunnel: mockTransport(new Map(), { pullCapable: false }),
      presumedDeadHolders: () => new Set(),
      now: () => NOW,
      monotonicNow: () => NOW,
    });
    const coord = new MultiMachineCoordinator(new StateManager(dir), { stateDir: dir, multiMachine: { leasePullIntervalMs: 5_000 } as any });
    coord.start();
    coord.attachLeaseCoordinator(lc);
    await coord.initializeLease();
    const s = coord.getSyncStatus();
    expect(s.awakeMachineCountSource).toBe('registry-roles');
    expect(s.awakeMachineCount).toBe(1); // the one registry 'awake' row
    coord.stop();
  });

  it('READ failure of the lease view → null + unavailable (never a silent 0)', async () => {
    const identity = seedIdentity(dir, 'LAPTOP');
    new MachineIdentityManager(dir).registerMachine(identity as any, 'standby');
    // A transport whose observedByPeer throws — the derive path must fail honest.
    const throwing: LeaseTransport = {
      broadcast: async () => true,
      observed: () => ({ lease: null, lastNonceByHolder: {} }),
      isReachable: () => true,
      pullAllPeers: async () => {},
      observedByPeer: () => { throw new Error('boom'); },
    };
    const lc = new LeaseCoordinator({
      lease: fl('LAPTOP'),
      store: new LocalLeaseStore({ filePath: path.join(dir, 'lease-local.json') }),
      tunnel: throwing,
      presumedDeadHolders: () => new Set(),
      now: () => NOW,
      monotonicNow: () => NOW,
    });
    const coord = new MultiMachineCoordinator(new StateManager(dir), {
      stateDir: dir,
      multiMachine: { leasePullIntervalMs: 5_000, leaseSelfHeal: { leaseRole: 'observe-only' } } as any,
    });
    coord.start();
    coord.attachLeaseCoordinator(lc);
    await coord.initializeLease();
    const s = coord.getSyncStatus();
    expect(s.awakeMachineCount).toBeNull();
    expect(s.awakeMachineCountSource).toBe('unavailable');
    // splitBrainState degrades to the pull-contest latch alone (clear here).
    expect(s.splitBrainState).toBe('clear');
    coord.stop();
  });
});
