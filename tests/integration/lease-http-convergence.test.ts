/**
 * Integration proof for #680 Problem A — git-less same-epoch lease convergence
 * driven through the REAL HttpLeaseTransport wire path (broadcast / pullPeer /
 * recordObserved + real request signing), not the in-memory tunnel mock the
 * LeaseCoordinator-convergence unit test uses.
 *
 * Two LeaseCoordinators (A, B) over git-less LocalLeaseStores are wired to two
 * real HttpLeaseTransports, bridged by an in-process fetch that faithfully
 * implements the POST /api/lease (recordObserved) + POST /api/lease/pull (serve
 * currentLease) contract. This is the closest deterministic proxy to the live
 * two-machine mesh — same transport code, no orphaned servers, no registry/key
 * plumbing. It proves the v3 resolution (loser relinquishes + winner advances
 * once to N+1) converges with the lease actually travelling over the wire path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { FencedLease, type LeaseCrypto } from '../../src/core/FencedLease.js';
import { LeaseCoordinator, type LeaseTransport } from '../../src/core/LeaseCoordinator.js';
import { LocalLeaseStore } from '../../src/core/LocalLeaseStore.js';
import { HttpLeaseTransport } from '../../src/core/HttpLeaseTransport.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { LeaseRecord } from '../../src/core/types.js';
import { MachinePoolRegistry } from '../../src/core/MachinePoolRegistry.js';
import { buildLeaseLivenessCallbacks } from '../../src/core/leaseLiveness.js';
import { GitLeaseStore } from '../../src/core/GitLeaseStore.js';
import { selectLeaseMedium } from '../../src/core/leaseMediumSelection.js';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';

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
function fl(self: string) { return new FencedLease(crypt(self), { leaseTtlMs: TTL, failoverThresholdMs: 15 * 60_000 }); }

describe('Lease convergence over the REAL HttpLeaseTransport (#680 Problem A)', () => {
  let dir: string;
  let now: number;
  let linked: boolean;
  let lcA: LeaseCoordinator;
  let lcB: LeaseCoordinator;
  let seq = 0;

  // In-process fetch bridge: routes POST /api/lease → target.recordObserved, and
  // POST /api/lease/pull → { lease: target.currentLease() }. Unreachable until
  // `linked` (models each machine booting solo before they discover each other).
  function makeBridge(handlers: () => Record<string, { transport: HttpLeaseTransport; coord: () => LeaseCoordinator }>) {
    return (async (url: string, opts: any) => {
      if (!linked) return { ok: false } as any;
      const host = new URL(url).host; // 'a' or 'b'
      const target = handlers()[host];
      if (!target) return { ok: false } as any;
      const body = opts?.body ? JSON.parse(opts.body) : {};
      if (url.endsWith('/api/lease/pull')) {
        return { ok: true, json: async () => ({ lease: target.coord().currentLease() }) } as any;
      }
      if (url.endsWith('/api/lease')) {
        if (body?.lease) target.transport.recordObserved(body.lease);
        return { ok: true } as any;
      }
      return { ok: false } as any;
    }) as unknown as typeof fetch;
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-http-'));
    now = 2_000;
    linked = false;
    seq = 0;

    let tA!: HttpLeaseTransport;
    let tB!: HttpLeaseTransport;
    const bridge = makeBridge(() => ({
      a: { transport: tA, coord: () => lcA },
      b: { transport: tB, coord: () => lcB },
    }));
    tA = new HttpLeaseTransport({
      selfMachineId: 'A', signingKeyPem: KEYS.A.privateKey,
      peers: () => [{ machineId: 'B', url: 'http://b' }],
      nextSequence: () => ++seq, reachabilityWindowMs: TTL, fetchImpl: bridge, now: () => now,
    });
    tB = new HttpLeaseTransport({
      selfMachineId: 'B', signingKeyPem: KEYS.B.privateKey,
      peers: () => [{ machineId: 'A', url: 'http://a' }],
      nextSequence: () => ++seq, reachabilityWindowMs: TTL, fetchImpl: bridge, now: () => now,
    });
    lcA = new LeaseCoordinator({
      lease: fl('A'), store: new LocalLeaseStore({ filePath: path.join(dir, 'a.json') }),
      tunnel: tA, presumedDeadHolders: () => new Set(), now: () => now, monotonicNow: () => now,
    });
    lcB = new LeaseCoordinator({
      lease: fl('B'), store: new LocalLeaseStore({ filePath: path.join(dir, 'b.json') }),
      tunnel: tB, presumedDeadHolders: () => new Set(), now: () => now, monotonicNow: () => now,
    });

    // Post-teardown split-brain: each acquires epoch 1 SOLO (unlinked → broadcast
    // is an unreachable no-op, so neither observes the other at acquire).
    expect(await lcA.acquireIfEligible()).toBe(true);
    expect(await lcB.acquireIfEligible()).toBe(true);
    linked = true; // the wire now carries each peer's lease
  });

  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/lease-http-convergence.test.ts' }); } catch { /* ignore */ }
  });

  it('sets up a genuine same-epoch split-brain (both hold epoch 1)', () => {
    expect(lcA.currentHolder()).toBe('A');
    expect(lcB.currentHolder()).toBe('B');
    expect(lcA.currentEpoch()).toBe(1);
    expect(lcB.currentEpoch()).toBe(1);
  });

  it('CONVERGES over the real wire: pull surfaces the peer, winner advances to N+1, loser adopts it', async () => {
    // Each pulls the other over the real transport → observes the same-epoch peer.
    await lcA.pullFromPeers();
    await lcB.pullFromPeers();
    expect(lcA.observedPeerLease()?.holder).toBe('B'); // B@1 arrived over the wire
    expect(lcB.observedPeerLease()?.holder).toBe('A');

    // v3 resolution (A = lower machineId = winner; B = loser):
    lcB.relinquish();                          // loser steps down
    await lcA.advanceEpochForContestedWin();   // winner → epoch 2, BROADCAST over the wire

    // Winner: holds epoch 2.
    expect(lcA.currentHolder()).toBe('A');
    expect(lcA.holdsLease()).toBe(true);
    expect(lcA.currentEpoch()).toBe(2);

    // Loser: adopts winner@2 — the lease arrived via the real broadcast→recordObserved
    // path (not a hand-injected mock). currentHolder() names the WINNER (the headless-
    // loser guard), holdsLease() false.
    expect(lcB.currentHolder()).toBe('A');
    expect(lcB.holdsLease()).toBe(false);
    expect(lcB.currentEpoch()).toBe(2);
  });

  it('the winner advancing ALONE propagates over the wire and demotes the loser (no explicit relinquish)', async () => {
    await lcA.advanceEpochForContestedWin(); // A → 2, broadcast to B over the wire
    expect(lcB.currentHolder()).toBe('A');   // B observed A@2 via recordObserved
    expect(lcB.holdsLease()).toBe(false);
  });
});

describe('lease-flap v3 omitted-row executable harness', () => {
  it('measures git synchronization, restart, renewal-freeze, and revocation rows', async () => {
    const step = 5_000, ttl = 20_000, failover = 60_000, duration = 3 * failover + ttl;
    type M = { bothHoldingMs: number; noHolderMs: number; epochChanges: number; samples: number; intervalMs: number; durationMs: number; onsetMs: number | null };
    class Wire implements LeaseTransport {
      peer?: Wire; observedLease: LeaseRecord | null = null; up = true;
      broadcast = async (lease: LeaseRecord) => { if (!this.up || !this.peer?.up) return false; this.peer.observedLease = lease; return true; };
      observed = () => ({ lease: this.observedLease, lastNonceByHolder: this.observedLease ? { [this.observedLease.holder]: this.observedLease.nonce } : {} });
      isReachable = () => this.up;
    }
    const git = (cwd: string, args: string[], allow = false): string => {
      try { return SafeGitExecutor.execSync(args, { cwd, operation: 'tests/integration/lease-http-convergence.test.ts:git-world' }).trim(); }
      catch (error) { if (allow) return ''; throw error; }
    };
    const makeGitWorld = (ignored: boolean, addable: boolean) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-git-world-'));
      const bare = path.join(root, 'remote.git');
      SafeGitExecutor.execSync(['init', '--bare', '-q', bare], { cwd: root, stdio: 'ignore', operation: 'tests/integration/lease-http-convergence.test.ts:init-bare' });
      const seed = path.join(root, 'seed'); fs.mkdirSync(seed);
      git(seed, ['init', '-q']); git(seed, ['config', 'user.email', 'e2e@example.invalid']); git(seed, ['config', 'user.name', 'E2E']);
      fs.writeFileSync(path.join(seed, 'README.md'), 'seed\n'); git(seed, ['add', '.']); git(seed, ['commit', '-qm', 'seed']);
      git(seed, ['remote', 'add', 'origin', bare]); git(seed, ['push', '-q', '-u', 'origin', 'HEAD']);
      const a = path.join(root, 'a'), b = path.join(root, 'b'); git(root, ['clone', '-q', bare, a]); git(root, ['clone', '-q', bare, b]);
      for (const clone of [a, b]) { git(clone, ['config', 'user.email', 'e2e@example.invalid']); git(clone, ['config', 'user.name', 'E2E']); fs.mkdirSync(path.join(clone, '.instar/machines'), { recursive: true }); }
      if (ignored) { fs.writeFileSync(path.join(b, '.gitignore'), '.instar/machines/\n'); git(b, ['add', '.gitignore']); git(b, ['commit', '-qm', 'ignore registry']); git(b, ['push', '-q']); }
      const initial = { machines: { A: { lastSeen: new Date(0).toISOString() }, B: { lastSeen: new Date(0).toISOString() } } };
      for (const clone of [a, b]) fs.writeFileSync(path.join(clone, '.instar/machines/registry.json'), JSON.stringify(initial));
      if (!ignored && !addable) { git(a, ['add', '.instar/machines/registry.json']); git(a, ['commit', '-qm', 'track registry']); git(a, ['push', '-q']); SafeFsExecutor.safeUnlinkSync(path.join(b, '.instar/machines/registry.json'), { operation: 'tests/integration/lease-http-convergence.test.ts:remove-untracked-registry' }); git(b, ['pull', '--rebase', '-q']); }
      return { root, a, b };
    };
    const gitStore = (clone: string, machineId: string) => {
      const file = path.join(clone, '.instar/machines/registry.json');
      return new GitLeaseStore({ machineId, registryAbsPath: file,
        loadRegistry: () => JSON.parse(fs.readFileSync(file, 'utf8')),
        saveRegistry: (r) => fs.writeFileSync(file, JSON.stringify(r)),
        pullRebase: () => { git(clone, ['pull', '--rebase', '-q'], true); return true; },
        commitAndPush: (message) => { try {
          SafeGitExecutor.execSync(['add', file], { cwd: clone, stdio: 'ignore', operation: 'tests/integration/lease-http-convergence.test.ts:add-lease' });
          SafeGitExecutor.execSync(['commit', '-qm', message], { cwd: clone, stdio: 'ignore', operation: 'tests/integration/lease-http-convergence.test.ts:commit-lease' });
          SafeGitExecutor.execSync(['push', '-q'], { cwd: clone, stdio: 'ignore', operation: 'tests/integration/lease-http-convergence.test.ts:push-lease' });
          return true;
        } catch { return false; } } });
    };
    const measure = async (opts: { name: string; ignored?: boolean; addable?: boolean; bothGit?: boolean; fixed?: boolean;
      restartAt?: number; rollbackOnRestart?: boolean; mediumOnlyRollback?: boolean; freezeAt?: number; revokeAt?: number; partition?: boolean }): Promise<M> => {
      const world = makeGitWorld(!!opts.ignored, !!opts.addable);
      let mono = 0, wall = 100_000, revoked = false, livenessEnabled = opts.fixed !== false;
      const wa = new Wire(), wb = new Wire(); wa.peer = wb; wb.peer = wa;
      let routerA = new MachinePoolRegistry({ listMachines: () => [{ machineId: 'B' }], clockSkewToleranceMs: 100, failoverThresholdMs: failover, now: () => wall, monoNow: () => mono });
      let routerB = new MachinePoolRegistry({ listMachines: () => [{ machineId: 'A' }], clockSkewToleranceMs: 100, failoverThresholdMs: failover, now: () => wall, monoNow: () => mono });
      const regA = () => ({ machines: { A: { lastSeen: new Date(100_000).toISOString() }, B: { lastSeen: new Date(100_000).toISOString(), ...(revoked ? { revokedAt: new Date(wall).toISOString() } : {}) } } });
      const regB = () => ({ machines: { A: { lastSeen: new Date(100_000).toISOString() }, B: { lastSeen: new Date(100_000).toISOString() } } });
      let a!: LeaseCoordinator, b!: LeaseCoordinator;
      const build = (id: 'A' | 'B', local: boolean) => {
        const router = id === 'A' ? () => routerA : () => routerB;
        const registry = id === 'A' ? regA : regB;
        const fresh = () => id === 'A' ? a : b;
        const live = buildLeaseLivenessCallbacks({ selfMachineId: id, loadDiskRegistry: registry, getRouter: router, getFreshness: fresh,
          getLeaseFlapFixConfig: () => ({ liveness: livenessEnabled }), getSkewImmune: () => false,
          failoverThresholdMs: failover, bootMonoMs: mono, monoNow: () => mono, wallNow: () => wall });
        return new LeaseCoordinator({ lease: new FencedLease(crypt(id), { leaseTtlMs: ttl, failoverThresholdMs: failover }),
          store: local ? new LocalLeaseStore({ filePath: path.join(world.root, `${id}.local.json`) }) : gitStore(id === 'A' ? world.a : world.b, id),
          tunnel: id === 'A' ? wa : wb, presumedDeadHolders: live.presumedDeadHolders,
          getLivenessEnabled: () => livenessEnabled, now: () => wall, monotonicNow: () => mono });
      };
      const bSelection = selectLeaseMedium({ projectDir: world.b, registryAbsPath: path.join(world.b, '.instar/machines/registry.json'),
        hasGitSyncManager: true, mediumCheckEnabled: opts.fixed !== false });
      a = build('A', !opts.bothGit);
      b = build('B', bSelection.medium === 'local');
      await a.acquireIfEligible();
      let both = 0, none = 0, changes = 0, samples = 0, onset: number | null = null, last = `${a.currentEpoch()}:${b.currentEpoch()}`;
      for (mono = 0; mono <= duration; mono += step) {
        wall += step;
        if (opts.partition && mono < 2 * failover) wa.up = wb.up = false; else wa.up = wb.up = true;
        if (opts.revokeAt === mono) revoked = true;
        if (opts.restartAt === mono) {
          const mediumRollback = !!opts.rollbackOnRestart || !!opts.mediumOnlyRollback;
          livenessEnabled = !opts.rollbackOnRestart;
          const selected = selectLeaseMedium({ projectDir: world.b, registryAbsPath: path.join(world.b, '.instar/machines/registry.json'), hasGitSyncManager: true, mediumCheckEnabled: !mediumRollback });
          b = build('B', selected.medium === 'local');
        }
        routerA.recordHeartbeat({ machineId: 'B' }); routerB.recordHeartbeat({ machineId: 'A' });
        for (const [id, lc] of [['A', a], ['B', b]] as const) {
          if (opts.freezeAt !== undefined && mono >= opts.freezeAt && id === 'A') continue;
          if (lc.holdsLease()) await lc.renew(); else await lc.acquireIfEligible();
        }
        const ha = a.holdsLease(), hb = b.holdsLease(); if (ha && hb) both += step; if (!ha && !hb) none += step;
        const e = `${a.currentEpoch()}:${b.currentEpoch()}`; if (e !== last) { changes++; onset ??= mono; last = e; } samples++;
      }
      SafeFsExecutor.safeRmSync(world.root, { recursive: true, force: true, operation: 'v3 git world cleanup' });
      return { bothHoldingMs: both, noHolderMs: none, epochChanges: changes, samples, intervalMs: step, durationMs: duration, onsetMs: onset };
    };
    const rows = [] as Array<{ scenario: string; measured: true; metrics: M }>;
    const cases = [
      { name: 'true-mixed-medium-incident-baseline', ignored: true, fixed: false },
      { name: 'true-mixed-medium-incident-fix', ignored: true, fixed: true },
      { name: 'git-carried-http-partition', bothGit: true, partition: true },
      { name: 'untracked-addable', addable: true },
      { name: 'upgrade-store-transition', ignored: true, fixed: false, restartAt: 65_000 },
      { name: 'full-rollback', ignored: true, restartAt: 65_000, rollbackOnRestart: true },
      { name: 'mediumCheck-only-rollback', ignored: true, restartAt: 65_000, mediumOnlyRollback: true },
      { name: 'renewal-only-expiry', freezeAt: 65_000 },
      { name: 'revoked-peer-mid-schedule', revokeAt: 65_000 },
    ];
    for (const c of cases) rows.push({ scenario: c.name, measured: true, metrics: await measure(c) });
    const baseline = rows.find((r) => r.scenario.endsWith('baseline'))!.metrics;
    const fixed = rows.find((r) => r.scenario.endsWith('fix'))!.metrics;
    expect(baseline.epochChanges).toBeGreaterThan(fixed.epochChanges);
    expect(fixed.epochChanges).toBe(0);
    expect(fixed.bothHoldingMs).toBe(0);
    expect(fixed.noHolderMs).toBe(0);
    const artifact = path.join(os.tmpdir(), `lease-flap-characterization-v3-${process.pid}.json`);
    fs.writeFileSync(artifact, JSON.stringify({ measured: true, rows }, null, 2));
    console.log(`[lease-flap-characterization-v3] ${artifact}`);
    expect(rows.every((r) => r.metrics.samples > 0)).toBe(true);
  });
});

describe('lease-flap deterministic characterization matrix', () => {
  it('feeds builder callbacks from live/coarse receipts and verified renewals', () => {
    let mono = 0;
    let router: MachinePoolRegistry | undefined = new MachinePoolRegistry({
      listMachines: () => [{ machineId: 'live' }, { machineId: 'renewal' }, { machineId: 'revoked' }],
      clockSkewToleranceMs: 100, failoverThresholdMs: 10, now: () => 1_000, monoNow: () => mono,
    });
    let renewalFresh = true;
    const callbacks = buildLeaseLivenessCallbacks({ selfMachineId: 'self',
      loadDiskRegistry: () => ({ machines: {
        live: { lastSeen: new Date(0).toISOString(), lastKnownUrl: 'http://live' },
        renewal: { lastSeen: new Date(0).toISOString(), lastKnownUrl: 'http://renewal' },
        revoked: { lastSeen: new Date(0).toISOString(), revokedAt: new Date(0).toISOString() },
      } }), getRouter: () => router,
      getFreshness: () => ({ freshRenewalWithin: (id) => id === 'renewal' && renewalFresh,
        lastRenewalObservedMono: (id) => id === 'renewal' ? 0 : undefined }),
      getLeaseFlapFixConfig: () => ({ liveness: true }), getSkewImmune: () => false,
      failoverThresholdMs: 10, bootMonoMs: 0, monoNow: () => mono, wallNow: () => 1_000 });
    router.recordHeartbeat({ machineId: 'live' });
    mono = 5;
    router.recordHeartbeat({ machineId: 'live', coarseHeartbeat: true });
    mono = 11;
    expect(callbacks.presumedDeadHolders().has('live')).toBe(true); // coarse did not refresh live receipt
    expect(callbacks.presumedDeadHolders().has('renewal')).toBe(false); // renewal-only peer
    expect(callbacks.presumedDeadHolders().has('revoked')).toBe(false); // never observed remains unknown
    expect(callbacks.allPeersPresumedGone()).toBe(false); // revoked omitted; renewal keeps non-revoked set alive
    renewalFresh = false;
    expect(callbacks.presumedDeadHolders().has('renewal')).toBe(false); // renewal-only history never becomes dead
    router = undefined;
    expect(callbacks.presumedDeadHolders().size).toBe(0); // absent/restarted router: none-ever, safe direction
  });

  it('measures executable local-store fault scenarios and writes only sampled values', async () => {
    const interval = 5_000, ttl = 20_000, failover = 60_000, healAt = 3 * failover, endAt = healAt + ttl + 2 * interval;
    type Mode = 'normal' | 'partition' | 'one-way' | 'broadcast-only' | 'coarse' | 'router-restart' | 'backward-wall' | 'forward-nonholder';
    type Metrics = { bothHoldingMs: number; noHolderMs: number; epochChanges: number; samples: number; convergedAfterFaultMs: number | null; intervalMs: number; durationMs: number; onsetMs: number | null };
    class PairTunnel implements LeaseTransport {
      observedLease: LeaseRecord | null = null;
      peer?: PairTunnel;
      allowBroadcast = true;
      broadcast = async (lease: LeaseRecord) => { if (!this.allowBroadcast || !this.peer) return false; this.peer.observedLease = lease; return true; };
      observed = () => ({ lease: this.observedLease, lastNonceByHolder: this.observedLease ? { [this.observedLease.holder]: this.observedLease.nonce } : {} });
      isReachable = () => this.allowBroadcast;
    }
    const run = async (scenario: string, mode: Mode, liveness: boolean, solo = false): Promise<Metrics> => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-matrix-'));
      let mono = 0, wallA = 100_000, wallB = 100_000;
      let routerA: MachinePoolRegistry | undefined = new MachinePoolRegistry({ listMachines: () => [{ machineId: 'B' }], clockSkewToleranceMs: 100,
        failoverThresholdMs: failover, now: () => wallA, monoNow: () => mono });
      let routerB: MachinePoolRegistry | undefined = new MachinePoolRegistry({ listMachines: () => [{ machineId: 'A' }], clockSkewToleranceMs: 100,
        failoverThresholdMs: failover, now: () => wallB, monoNow: () => mono });
      const ta = new PairTunnel(), tb = new PairTunnel(); ta.peer = tb; tb.peer = ta;
      let a!: LeaseCoordinator, b!: LeaseCoordinator;
      const registryA = () => ({ machines: { A: { lastSeen: new Date(100_000).toISOString() }, B: { lastSeen: new Date(100_000).toISOString() } } });
      const registryB = () => ({ machines: { A: { lastSeen: new Date(100_000).toISOString() }, B: { lastSeen: new Date(100_000).toISOString() } } });
      const la = buildLeaseLivenessCallbacks({ selfMachineId: 'A', loadDiskRegistry: registryA, getRouter: () => routerA, getFreshness: () => a,
        getLeaseFlapFixConfig: () => ({ liveness }), getSkewImmune: () => false, failoverThresholdMs: failover, bootMonoMs: 0, monoNow: () => mono, wallNow: () => wallA });
      const lb = buildLeaseLivenessCallbacks({ selfMachineId: 'B', loadDiskRegistry: registryB, getRouter: () => routerB, getFreshness: () => b,
        getLeaseFlapFixConfig: () => ({ liveness }), getSkewImmune: () => false, failoverThresholdMs: failover, bootMonoMs: 0, monoNow: () => mono, wallNow: () => wallB });
      a = new LeaseCoordinator({ lease: new FencedLease(crypt('A'), { leaseTtlMs: ttl, failoverThresholdMs: failover }),
        store: new LocalLeaseStore({ filePath: path.join(root, 'a.json') }), tunnel: ta, presumedDeadHolders: la.presumedDeadHolders,
        getLivenessEnabled: () => liveness, sampleLiveness: la.sample, now: () => wallA, monotonicNow: () => mono,
        soloCaptainHold: () => solo ? { enabled: true } : null, isPreferredAwakeAgreed: () => solo, allPeersPresumedGone: la.allPeersPresumedGone });
      b = new LeaseCoordinator({ lease: new FencedLease(crypt('B'), { leaseTtlMs: ttl, failoverThresholdMs: failover }),
        store: new LocalLeaseStore({ filePath: path.join(root, 'b.json') }), tunnel: tb, presumedDeadHolders: lb.presumedDeadHolders,
        getLivenessEnabled: () => liveness, sampleLiveness: lb.sample, now: () => wallB, monotonicNow: () => mono });
      await a.acquireIfEligible();
      let both = 0, none = 0, changes = 0, onset: number | null = null, lastEpochs = `${a.currentEpoch()}:${b.currentEpoch()}`, converged: number | null = null, samples = 0;
      for (mono = 0; mono <= endAt; mono += interval) {
        wallA += interval; wallB += interval;
        const fault = mono < healAt;
        ta.allowBroadcast = tb.allowBroadcast = true;
        if (fault && mode === 'partition') ta.allowBroadcast = tb.allowBroadcast = false;
        if (fault && mode === 'one-way') tb.allowBroadcast = false;
        if (fault && mode === 'broadcast-only') ta.allowBroadcast = false;
        if (fault && mode === 'backward-wall') wallA -= interval * 2;
        if (fault && mode === 'forward-nonholder') wallB += interval * 2;
        if (fault && mode === 'router-restart') { routerA = undefined; routerB = undefined; }
        if (!fault && !routerA) {
          routerA = new MachinePoolRegistry({ listMachines: () => [{ machineId: 'B' }], clockSkewToleranceMs: 100, failoverThresholdMs: failover, now: () => wallA, monoNow: () => mono });
          routerB = new MachinePoolRegistry({ listMachines: () => [{ machineId: 'A' }], clockSkewToleranceMs: 100, failoverThresholdMs: failover, now: () => wallB, monoNow: () => mono });
        }
        if (routerA && routerB) {
          routerA.recordHeartbeat({ machineId: 'B', coarseHeartbeat: fault && mode === 'coarse' });
          routerB.recordHeartbeat({ machineId: 'A', coarseHeartbeat: fault && mode === 'coarse' });
        }
        if (!fault && a.holdsLease() && b.holdsLease() && a.currentEpoch() === b.currentEpoch()) {
          b.relinquish();
          await a.advanceEpochForContestedWin();
        }
        for (const lc of [a, b]) { lc.sampleLiveness(); if (lc.holdsLease()) await lc.renew(); else await lc.acquireIfEligible(); }
        const ha = a.holdsLease(), hb = b.holdsLease();
        if (mono < healAt) { if (ha && hb) both += interval; if (!ha && !hb) none += interval; }
        const epochs = `${a.currentEpoch()}:${b.currentEpoch()}`; if (epochs !== lastEpochs) { changes++; onset ??= mono; lastEpochs = epochs; }
        if (mono >= healAt && converged === null && ha !== hb) converged = mono - healAt;
        samples++;
      }
      SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'lease matrix cleanup' });
      return { bothHoldingMs: both, noHolderMs: none, epochChanges: changes, samples, convergedAfterFaultMs: converged,
        intervalMs: interval, durationMs: endAt, onsetMs: onset };
    };
    const definitions: Array<[string, Mode, boolean]> = [
      ['incident-local-proxy', 'normal', false], ['two-local-stores-frozen-lastSeen', 'normal', false],
      ['live-then-coarse-only', 'coarse', false], ['router-restart', 'router-restart', false],
      ['mixed-version-one-way', 'one-way', false], ['broadcast-only-failure', 'broadcast-only', false],
      ['window-a-partition', 'partition', false], ['window-b-boot-overlap', 'normal', false],
      ['window-c-restart-handover', 'router-restart', false], ['window-d-intermittent-holding', 'broadcast-only', false],
      ['backward-wall-clock-step', 'backward-wall', false], ['forward-step-non-holder', 'forward-nonholder', false],
      ['enabled-solo-hold', 'broadcast-only', true],
    ];
    const rows = [] as Array<{ scenario: string; measured: true; fix: Metrics; baseline: Metrics }>;
    for (const [scenario, mode, solo] of definitions) {
      const baseline = await run(scenario, mode, false, solo);
      const fix = await run(scenario, mode, true, solo);
      rows.push({ scenario, measured: true, fix, baseline });
      expect(fix.bothHoldingMs).toBeLessThanOrEqual(baseline.bothHoldingMs);
      expect(fix.convergedAfterFaultMs, scenario).not.toBeNull();
    }
    const incident = rows.find((r) => r.scenario === 'incident-local-proxy')!;
    expect(incident.baseline.epochChanges).toBeGreaterThan(0);
    expect(incident.fix.epochChanges).toBe(0);
    expect(incident.fix.bothHoldingMs).toBe(0);
    const artifact = path.join(os.tmpdir(), `lease-flap-characterization-v2-${process.pid}.json`);
    fs.writeFileSync(artifact, JSON.stringify({ measured: true, schedule: { interval, ttl, failover, healAt, endAt }, rows }, null, 2));
    console.log(`[lease-flap-characterization] ${artifact}`);
    expect(fs.existsSync(artifact)).toBe(true);
  });
});
