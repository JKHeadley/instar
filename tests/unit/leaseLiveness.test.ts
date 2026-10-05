/**
 * B4 (multimachine-lease-poll-robustness, Decision 10) — unit tests for the
 * skew-immune peer-liveness decision. Proves the flag-off legacy behavior, the
 * skew-immune path, the conservative direction, and the not-yet-observed edge.
 */

import { describe, it, expect, vi } from 'vitest';
import { buildLeaseLivenessCallbacks, createLeaseFlapSwitchGetter, isDialableLeasePeer, isPeerPresumedDead, reportLeaseOrderingDegradation } from '../../src/core/leaseLiveness.js';
import { MachinePoolRegistry } from '../../src/core/MachinePoolRegistry.js';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const FAILOVER = 15 * 60_000;
const NOW = 1_000_000_000;

describe('B4 isPeerPresumedDead — skew-immune lease liveness', () => {
  it('flag OFF → legacy lastSeen threshold (fresh = alive, stale = dead)', () => {
    expect(isPeerPresumedDead({
      lastSeenMs: NOW - 1000, routerObserved: false, routerOnline: false,
      nowMs: NOW, failoverThresholdMs: FAILOVER, skewImmune: false,
    })).toBe(false); // 1s ago → alive
    expect(isPeerPresumedDead({
      lastSeenMs: NOW - FAILOVER - 1, routerObserved: false, routerOnline: false,
      nowMs: NOW, failoverThresholdMs: FAILOVER, skewImmune: false,
    })).toBe(true); // past horizon → dead
  });

  it('flag ON + router observed → uses skew-immune online (ignores a skewed lastSeen)', () => {
    // A +Ns-fast peer writes a FUTURE lastSeen → legacy would call it alive.
    // Skew-immune router says it has NOT been heard from → presumed dead.
    expect(isPeerPresumedDead({
      lastSeenMs: NOW + 5 * 60_000, // future (fast clock) — legacy fooled into "alive"
      routerObserved: true, routerOnline: false,
      nowMs: NOW, failoverThresholdMs: FAILOVER, skewImmune: true,
    })).toBe(true); // skew-immune wins → dead

    // Inverse: a −Ns-slow peer writes a stale-looking lastSeen → legacy would
    // FALSE-failover. Skew-immune router says it's online → NOT dead (kills the flap).
    expect(isPeerPresumedDead({
      lastSeenMs: NOW - FAILOVER - 60_000, // looks dead by wall clock (slow peer)
      routerObserved: true, routerOnline: true,
      nowMs: NOW, failoverThresholdMs: FAILOVER, skewImmune: true,
    })).toBe(false); // skew-immune wins → alive
  });

  it('flag ON + observed-but-stale router → presumed dead EVEN WITH a fresh lastSeen (the load-bearing override)', () => {
    // The riskiest direction: the router has not heard from the peer in >horizon
    // (genuinely unreachable), but the peer\'s own clock wrote a recent lastSeen.
    // Skew-immune must override to DEAD — this is the override that makes failover
    // work under skew. (2nd-pass coverage request.)
    expect(isPeerPresumedDead({
      lastSeenMs: NOW - 1000, // fresh by the peer\'s own clock
      routerObserved: true, routerOnline: false, // but the router hasn\'t heard from it
      nowMs: NOW, failoverThresholdMs: FAILOVER, skewImmune: true,
    })).toBe(true);
  });

  it('flag ON but peer NOT yet observed this incarnation → falls back to lastSeen (convergence edge)', () => {
    // Known on disk (fresh lastSeen) but no routerReceivedAt yet (just booted).
    // Must NOT presume-dead a peer we simply haven\'t heard from in-process yet.
    expect(isPeerPresumedDead({
      lastSeenMs: NOW - 1000, routerObserved: false, routerOnline: false,
      nowMs: NOW, failoverThresholdMs: FAILOVER, skewImmune: true,
    })).toBe(false); // fallback to lastSeen → alive (NOT wrongly dead)
  });

  it('conservative: unknown/unparseable lastSeen with no router opinion → NOT presumed dead', () => {
    expect(isPeerPresumedDead({
      lastSeenMs: null, routerObserved: false, routerOnline: false,
      nowMs: NOW, failoverThresholdMs: FAILOVER, skewImmune: true,
    })).toBe(false);
    expect(isPeerPresumedDead({
      lastSeenMs: NaN, routerObserved: false, routerOnline: false,
      nowMs: NOW, failoverThresholdMs: FAILOVER, skewImmune: false,
    })).toBe(false);
  });
});

describe('lease-flap live-evidence callbacks', () => {
  it('production switch getter observes config.json changes and logs transitions', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-live-config-'));
    try {
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ multiMachine: { leaseFlapFix: { liveness: true } } }));
      const live = new LiveConfig(dir);
      const logs: string[] = [];
      const getSwitch = createLeaseFlapSwitchGetter((p, f) => live.get<boolean>(p, f), (m) => logs.push(m));
      expect(getSwitch('liveness')).toBe(true);
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ multiMachine: { leaseFlapFix: { liveness: false } } }));
      live.forceRefresh();
      expect(getSwitch('liveness')).toBe(false);
      expect(logs).toEqual([expect.stringContaining('actor: config-file')]);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/leaseLiveness.test.ts:cleanup-live-config' });
    }
  });
  it.each([
    ['fresh', false, false],
    ['fresh', true, false],
    ['stale', false, true],
    ['stale', true, false],
    ['none', false, false],
    ['none', true, false],
  ] as const)('classifies receipt=%s renewal=%s as dead=%s', (receipt, renewalFresh, dead) => {
    let mono = 100;
    const router = new MachinePoolRegistry({
      listMachines: () => [{ machineId: 'peer' }], clockSkewToleranceMs: 100,
      failoverThresholdMs: 10, now: () => 1_000, monoNow: () => mono,
    });
    if (receipt !== 'none') router.recordHeartbeat({ machineId: 'peer' });
    if (receipt === 'stale') mono = 111;
    const callbacks = buildLeaseLivenessCallbacks({
      selfMachineId: 'self',
      loadDiskRegistry: () => ({ machines: { peer: { lastSeen: new Date(0).toISOString() } } }),
      getRouter: () => router,
      getFreshness: () => ({ freshRenewalWithin: () => renewalFresh, lastRenewalObservedMono: () => undefined }),
      getLeaseFlapFixConfig: () => ({ liveness: true }), getSkewImmune: () => false,
      failoverThresholdMs: 10, bootMonoMs: 0, monoNow: () => mono, wallNow: () => 1_000,
    });
    expect(callbacks.presumedDeadHolders().has('peer')).toBe(dead);
    expect(callbacks.allPeersPresumedGone()).toBe(dead);
  });

  it('uses the legacy rule when liveness is off and sees a router constructed later', () => {
    let router: MachinePoolRegistry | undefined;
    let mono = 100;
    const callbacks = buildLeaseLivenessCallbacks({
      selfMachineId: 'self',
      loadDiskRegistry: () => ({ machines: { peer: { lastSeen: new Date(0).toISOString() } } }),
      getRouter: () => router, getFreshness: () => undefined,
      getLeaseFlapFixConfig: () => ({ liveness: false }), getSkewImmune: () => false,
      failoverThresholdMs: 10, bootMonoMs: 0, monoNow: () => mono, wallNow: () => 1_000,
    });
    expect(callbacks.presumedDeadHolders().has('peer')).toBe(true);
    router = new MachinePoolRegistry({ listMachines: () => [{ machineId: 'peer' }], clockSkewToleranceMs: 10, failoverThresholdMs: 10, now: () => 1_000, monoNow: () => mono });
    router.recordHeartbeat({ machineId: 'peer' });
    expect(callbacks.presumedDeadHolders({ liveness: true }).has('peer')).toBe(false);
  });

  it('keeps the empty and all-revoked peer sets from reading as all gone', () => {
    const callbacks = buildLeaseLivenessCallbacks({
      selfMachineId: 'self', loadDiskRegistry: () => ({ machines: { peer: { lastSeen: '', revokedAt: 'now' } } }),
      getRouter: () => undefined, getFreshness: () => undefined, getLeaseFlapFixConfig: () => ({}),
      getSkewImmune: () => false, failoverThresholdMs: 10, bootMonoMs: 0, monoNow: () => 100, wallNow: () => 100,
    });
    expect(callbacks.allPeersPresumedGone()).toBe(false);
  });

  it('reports each never-observed peer window once with dialability and pull tags', () => {
    let mono = 0;
    let dialable = false;
    const report = vi.spyOn(DegradationReporter.getInstance(), 'report').mockImplementation(() => undefined);
    const callbacks = buildLeaseLivenessCallbacks({
      selfMachineId: 'self',
      loadDiskRegistry: () => ({ machines: { peer: {
        lastSeen: '', status: 'standby', ...(dialable ? { lastKnownUrl: 'http://peer' } : {}),
      } } }),
      getRouter: () => undefined, getFreshness: () => undefined,
      getLeaseFlapFixConfig: () => ({ liveness: true }), getSkewImmune: () => false,
      failoverThresholdMs: 10, bootMonoMs: 0, monoNow: () => mono, wallNow: () => 0,
    });
    callbacks.sample();
    mono = 20;
    callbacks.sample();
    callbacks.sample();
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0].reason).toContain('never-dialable, not-pulled (status: standby)');
    dialable = true;
    callbacks.sample();
    mono = 40;
    callbacks.sample();
    callbacks.sample();
    expect(report).toHaveBeenCalledTimes(2);
    expect(report.mock.calls[1][0].reason).toContain('currently-dialable');
    report.mockRestore();
  });

  it('labels a peer previously-dialable after its endpoint disappears without repeating that window', () => {
    let mono = 0;
    let endpoint = true;
    const report = vi.spyOn(DegradationReporter.getInstance(), 'report').mockImplementation(() => undefined);
    const callbacks = buildLeaseLivenessCallbacks({ selfMachineId: 'self',
      loadDiskRegistry: () => ({ machines: { peer: { lastSeen: '', ...(endpoint ? { lastKnownUrl: 'http://peer' } : {}) } } }),
      getRouter: () => undefined, getFreshness: () => undefined, getLeaseFlapFixConfig: () => ({}), getSkewImmune: () => false,
      failoverThresholdMs: 10, bootMonoMs: 0, monoNow: () => mono, wallNow: () => 0 });
    callbacks.sample();
    endpoint = false;
    mono = 20;
    callbacks.sample();
    callbacks.sample();
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0].reason).toContain('previously-dialable');
    report.mockRestore();
  });

  it('reports never-dialable then gives a newly dialable-but-unreachable peer one fresh window', () => {
    let mono = 0;
    let endpoint = false;
    const report = vi.spyOn(DegradationReporter.getInstance(), 'report').mockImplementation(() => undefined);
    const callbacks = buildLeaseLivenessCallbacks({ selfMachineId: 'self',
      loadDiskRegistry: () => ({ machines: { peer: { lastSeen: '', ...(endpoint ? { lastKnownUrl: 'http://peer' } : {}) } } }),
      getRouter: () => undefined, getFreshness: () => undefined, getLeaseFlapFixConfig: () => ({}), getSkewImmune: () => false,
      failoverThresholdMs: 10, bootMonoMs: 0, monoNow: () => mono, wallNow: () => 0 });
    callbacks.sample();
    mono = 20;
    callbacks.sample();
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0].reason).toContain('never-dialable');
    endpoint = true;
    callbacks.sample(); // first dialability starts a new full window
    endpoint = false; // unreachable before it can ever produce a receipt
    mono = 40;
    callbacks.sample();
    callbacks.sample();
    expect(report).toHaveBeenCalledTimes(2);
    expect(report.mock.calls[1][0].reason).toContain('previously-dialable');
    report.mockRestore();
  });

  it('uses only monotonic receipt age across a backward and forward wall-clock step', () => {
    let mono = 100;
    let wall = 1_000;
    const router = new MachinePoolRegistry({ listMachines: () => [{ machineId: 'peer' }], clockSkewToleranceMs: 10,
      failoverThresholdMs: 10, now: () => wall, monoNow: () => mono });
    router.recordHeartbeat({ machineId: 'peer' });
    const callbacks = buildLeaseLivenessCallbacks({ selfMachineId: 'self', loadDiskRegistry: () => ({ machines: { peer: { lastSeen: '' } } }),
      getRouter: () => router, getFreshness: () => undefined, getLeaseFlapFixConfig: () => ({}), getSkewImmune: () => false,
      failoverThresholdMs: 10, bootMonoMs: 0, monoNow: () => mono, wallNow: () => wall });
    wall = -1_000_000;
    expect(callbacks.presumedDeadHolders().has('peer')).toBe(false);
    wall = 9_000_000;
    expect(callbacks.presumedDeadHolders().has('peer')).toBe(false);
    mono = 111;
    expect(callbacks.presumedDeadHolders().has('peer')).toBe(true);
  });

  it.each(['no-git-manager', 'git-manager-ignored-registry'])('classifies live evidence identically on the %s route', () => {
    let mono = 5;
    const router = new MachinePoolRegistry({ listMachines: () => [{ machineId: 'peer' }], clockSkewToleranceMs: 10,
      failoverThresholdMs: 10, now: () => 0, monoNow: () => mono });
    router.recordHeartbeat({ machineId: 'peer' });
    const callbacks = buildLeaseLivenessCallbacks({ selfMachineId: 'self', loadDiskRegistry: () => ({ machines: { peer: { lastSeen: '' } } }),
      getRouter: () => router, getFreshness: () => undefined, getLeaseFlapFixConfig: () => ({}), getSkewImmune: () => false,
      failoverThresholdMs: 10, bootMonoMs: 0, monoNow: () => mono, wallNow: () => 0 });
    expect(callbacks.presumedDeadHolders()).toEqual(new Set());
  });

  it('liveness:false with B4 on matches the router branch of isPeerPresumedDead', () => {
    let mono = 0;
    const router = new MachinePoolRegistry({ listMachines: () => [{ machineId: 'peer' }], clockSkewToleranceMs: 10,
      failoverThresholdMs: 10, now: () => 100, monoNow: () => mono });
    router.recordHeartbeat({ machineId: 'peer' });
    mono = 11;
    const callbacks = buildLeaseLivenessCallbacks({ selfMachineId: 'self', loadDiskRegistry: () => ({ machines: { peer: { lastSeen: new Date(100).toISOString() } } }),
      getRouter: () => router, getFreshness: () => undefined, getLeaseFlapFixConfig: () => ({ liveness: false }), getSkewImmune: () => true,
      failoverThresholdMs: 10, bootMonoMs: 0, monoNow: () => mono, wallNow: () => 100 });
    expect(callbacks.presumedDeadHolders().has('peer')).toBe(
      isPeerPresumedDead({ lastSeenMs: 100, routerObserved: true, routerOnline: true, nowMs: 100, failoverThresholdMs: 10, skewImmune: true }),
    );
  });

  it('shares endpoint dialability with the transport peer filter before any receipt', () => {
    const entry = { lastSeen: '', endpoints: [] as Array<{ kind: string; url: string }> };
    const transportPeers = () => isDialableLeasePeer(entry) ? ['peer'] : [];
    expect(isDialableLeasePeer(entry)).toBe(false);
    expect(transportPeers()).toEqual([]);
    entry.endpoints = [{ kind: 'lan', url: 'http://peer' }];
    expect(isDialableLeasePeer(entry)).toBe(true);
    expect(transportPeers()).toEqual(['peer']);
  });

  it('reports the failover/TTL ordering boundary only when enabled and <=', () => {
    const reporter = { report: vi.fn() };
    expect(reportLeaseOrderingDegradation(60, 60, true, reporter)).toBe(true);
    expect(reportLeaseOrderingDegradation(59, 60, true, reporter)).toBe(true);
    expect(reportLeaseOrderingDegradation(61, 60, true, reporter)).toBe(false);
    expect(reportLeaseOrderingDegradation(60, 60, false, reporter)).toBe(false);
    expect(reporter.report).toHaveBeenCalledTimes(2);
  });

  it('characterises forged-once receipt history: stale becomes dead/gone and suppresses unobserved reporting', () => {
    let mono = 0;
    const router = new MachinePoolRegistry({ listMachines: () => [{ machineId: 'peer' }], clockSkewToleranceMs: 10,
      failoverThresholdMs: 10, now: () => 0, monoNow: () => mono });
    const report = vi.spyOn(DegradationReporter.getInstance(), 'report').mockImplementation(() => undefined);
    const callbacks = buildLeaseLivenessCallbacks({ selfMachineId: 'self', loadDiskRegistry: () => ({ machines: { peer: { lastSeen: '', lastKnownUrl: 'http://peer' } } }),
      getRouter: () => router, getFreshness: () => undefined, getLeaseFlapFixConfig: () => ({}), getSkewImmune: () => false,
      failoverThresholdMs: 10, bootMonoMs: 0, monoNow: () => mono, wallNow: () => 0 });
    expect(callbacks.presumedDeadHolders().has('peer')).toBe(false); // never observed
    router.recordHeartbeat({ machineId: 'peer' }); // unauthenticated receipt may be forged
    mono = 11;
    expect(callbacks.presumedDeadHolders().has('peer')).toBe(true);
    expect(callbacks.allPeersPresumedGone()).toBe(true);
    mono = 30;
    callbacks.sample();
    expect(report).not.toHaveBeenCalled();
    report.mockRestore();
  });
});
