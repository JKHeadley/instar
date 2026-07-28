/**
 * E2E (Cross-Machine Coherence) — split-brain DETECTION + PULL-based convergence.
 *
 * Stands up the REAL lease stack per machine — FencedLease + LocalLeaseStore
 * (git-less, the substrate that makes a same-store CAS impossible) + the real
 * HttpLeaseTransport + LeaseCoordinator — and wires the two machines together
 * over MOCK HTTP (an injected fetchImpl that dispatches POST /api/lease and
 * POST /api/lease/pull to the peer's real coordinator). A `partitioned` flag
 * simulates a network partition.
 *
 * Proves the robustness property Justin asked for ("robust even in poor
 * conditions"): a partition produces a two-awake split-brain, and on heal the
 * active PULL (§D3, pullPeer over mock HTTP) folds the higher-epoch peer lease
 * so the mesh CONVERGES back to exactly one awake machine — no operator action.
 *
 * Route auth (signed empty body) is covered by tests/integration/machine-routes;
 * here the mock transport focuses on the convergence behavior end-to-end.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { FencedLease, type LeaseCrypto } from '../../src/core/FencedLease.js';
import { LeaseCoordinator } from '../../src/core/LeaseCoordinator.js';
import { LocalLeaseStore } from '../../src/core/LocalLeaseStore.js';
import { HttpLeaseTransport } from '../../src/core/HttpLeaseTransport.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
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
const FAILOVER = 15 * 60_000;
const NOW = 2_000;

describe('Multi-Machine E2E — split-brain detection + pull-based convergence', () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/multi-machine-lease-split-brain.test.ts:afterEach' });
    dirs = [];
  });

  function tmp(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-sb-')); dirs.push(d); return d; }

  it('partition → two awake (split-brain); heal → pull converges to one', async () => {
    // Shared registry so awakeMachineCount reflects BOTH machines' roles (this is
    // exactly what reconcileRoleToLease writes in production).
    const regDir = tmp();
    const mgr = new MachineIdentityManager(regDir);
    const idA = { machineId: 'A', signingPublicKey: 'a', encryptionPublicKey: 'a', name: 'A', platform: 'test', createdAt: new Date(NOW).toISOString(), capabilities: ['sessions'] };
    const idB = { machineId: 'B', signingPublicKey: 'b', encryptionPublicKey: 'b', name: 'B', platform: 'test', createdAt: new Date(NOW).toISOString(), capabilities: ['sessions'] };
    mgr.registerMachine(idA as any, 'standby');
    mgr.registerMachine(idB as any, 'standby');

    let partitioned = false;
    // Lazily-bound peer refs (assigned below before any fetch fires).
    let aTransport!: HttpLeaseTransport, bTransport!: HttpLeaseTransport;
    let aLc!: LeaseCoordinator, bLc!: LeaseCoordinator;

    // Mock HTTP: dispatch a transport's POST to the PEER's real coordinator/transport.
    const makeFetch = (peerLc: () => LeaseCoordinator, peerTransport: () => HttpLeaseTransport) =>
      (async (url: string, opts: any) => {
        if (partitioned) throw new Error('partitioned');
        const u = String(url);
        if (u.endsWith('/api/lease/pull')) {
          return { ok: true, json: async () => ({ lease: peerLc().currentLease() }) } as any;
        }
        if (u.endsWith('/api/lease')) {
          const body = JSON.parse(opts.body);
          peerTransport().recordObserved(body.lease);
          return { ok: true, json: async () => ({}) } as any;
        }
        return { ok: false } as any;
      }) as unknown as typeof fetch;

    let seqA = 0, seqB = 0;
    aTransport = new HttpLeaseTransport({
      selfMachineId: 'A', signingKeyPem: KEYS.A.privateKey,
      peers: () => [{ machineId: 'B', url: 'http://b' }],
      nextSequence: () => ++seqA,
      fetchImpl: makeFetch(() => bLc, () => bTransport),
    });
    bTransport = new HttpLeaseTransport({
      selfMachineId: 'B', signingKeyPem: KEYS.B.privateKey,
      peers: () => [{ machineId: 'A', url: 'http://a' }],
      nextSequence: () => ++seqB,
      fetchImpl: makeFetch(() => aLc, () => aTransport),
    });

    const aDead = new Set<string>();
    const bDead = new Set<string>();
    aLc = new LeaseCoordinator({
      lease: new FencedLease(crypt('A'), { leaseTtlMs: TTL, failoverThresholdMs: FAILOVER }),
      store: new LocalLeaseStore({ filePath: path.join(tmp(), 'a-lease.json') }),
      tunnel: aTransport, presumedDeadHolders: () => aDead, now: () => NOW,
    });
    bLc = new LeaseCoordinator({
      lease: new FencedLease(crypt('B'), { leaseTtlMs: TTL, failoverThresholdMs: FAILOVER }),
      store: new LocalLeaseStore({ filePath: path.join(tmp(), 'b-lease.json') }),
      tunnel: bTransport, presumedDeadHolders: () => bDead, now: () => NOW,
    });

    const reflect = () => {
      mgr.updateRole('A', aLc.holdsLease() ? 'awake' : 'standby');
      mgr.updateRole('B', bLc.holdsLease() ? 'awake' : 'standby');
    };
    const awakeCount = () => Object.values(mgr.loadRegistry().machines ?? {}).filter((m: any) => m.role === 'awake').length;

    // ── 1. A acquires epoch 1 and broadcasts; B observes A as holder. ──
    expect(await aLc.acquireIfEligible()).toBe(true);
    expect(aLc.holdsLease()).toBe(true);
    expect(aLc.currentEpoch()).toBe(1);
    expect(bLc.currentHolder()).toBe('A'); // B learned A via the broadcast over mock HTTP
    reflect();
    expect(awakeCount()).toBe(1);

    // ── 2. PARTITION: B can't reach A, presumes A dead, and acquires its own lease. ──
    partitioned = true;
    bDead.add('A');
    expect(await bLc.acquireIfEligible()).toBe(true); // B builds epoch 2 (over the observed epoch 1)
    expect(bLc.currentEpoch()).toBe(2);

    // Both machines now believe they are awake — the split-brain.
    expect(aLc.holdsLease()).toBe(true);
    expect(bLc.holdsLease()).toBe(true);
    expect(aLc.currentHolder()).toBe('A');
    expect(bLc.currentHolder()).toBe('B');
    reflect();
    expect(awakeCount()).toBe(2); // ← partition → awakeMachineCount === 2

    // ── 3. HEAL: the active PULL (§D3) folds the higher-epoch peer lease. ──
    partitioned = false;
    bDead.delete('A'); // A is reachable again
    await aLc.pullFromPeers(); // A pulls B → observes epoch 2 → A is fenced (demotes)
    await bLc.pullFromPeers(); // B pulls A → observes epoch 1 < 2 → B keeps the lease

    expect(aLc.holdsLease()).toBe(false); // A folded B's epoch-2 lease and stepped down
    expect(bLc.holdsLease()).toBe(true);  // B (higher epoch) survives
    expect(aLc.currentHolder()).toBe('B');
    expect(bLc.currentHolder()).toBe('B');
    reflect();
    expect(awakeCount()).toBe(1); // ← heal → converges to 1 (registry-role basis)

    // ── 4. machine-coherence-guard §5b — the SAME convergence at the LEASE-LIVE
    //    count level, derived from each machine's OWN pulled observations (the
    //    basis getSyncStatus() now uses; observedByPeer() was populated by the
    //    phase-3 pulls over the real HttpLeaseTransport). Each machine honestly
    //    reports exactly ONE awake after heal. ──
    const STALE = 10 * 60_000; // well within freshness (observations stamped at NOW)
    // A demoted (holds=false) but its pull of B recorded B's live epoch-2 self-lease.
    expect(aLc.deriveLiveAwakeCount(STALE)).toBe(1);
    // B holds (1); A now re-serves B's epoch-2 lease, so B's pull of A is
    // hearsay-about-B (holder !== the dialed peer id) and adds nothing.
    expect(bLc.deriveLiveAwakeCount(STALE)).toBe(1);
  });
});
