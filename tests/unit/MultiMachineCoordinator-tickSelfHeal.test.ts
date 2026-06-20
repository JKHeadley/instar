/**
 * multi-machine-lease-self-heal F1 — tick self-heal unit tests.
 *
 * Covers the PRIMARY fix (F1a bounded await — a hung tick-path call can never
 * wedge the loop) and the BACKSTOP (F1b monotonic watchdog — re-arms a stalled
 * tick, resets a STUCK reentrancy guard but NOT a legitimately-slow live one,
 * and self-disarms if it fires too often). White-box where needed; the watchdog
 * decision is the load-bearing both-sides-of-boundary semantics.
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

function genKey() {
  return crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}
const KEYS: Record<string, { publicKey: string; privateKey: string }> = { A: genKey() };
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
function tempDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'mmc-selfheal-')); }
function seedIdentity(stateDir: string, machineId: string) {
  const identity = {
    machineId, signingPublicKey: 'k1', encryptionPublicKey: 'k2',
    name: 'machine-a', platform: 'test', createdAt: new Date().toISOString(), capabilities: ['sessions'],
  };
  fs.mkdirSync(path.join(stateDir, 'machine'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'machine', 'identity.json'), JSON.stringify(identity));
  return identity;
}

function makeCoord(dir: string, leaseSelfHeal: Record<string, unknown>) {
  const machineId = `m_${crypto.randomBytes(8).toString('hex')}`;
  const identity = seedIdentity(dir, machineId);
  const mgr = new MachineIdentityManager(dir);
  mgr.registerMachine(identity as any, 'awake');
  const tunnel: LeaseTransport = {
    broadcast: async () => true,
    observed: () => ({ lease: null, lastNonceByHolder: {} }),
    isReachable: () => true,
    pullAllPeers: async () => {},
  };
  const lc = new LeaseCoordinator({
    lease: new FencedLease(crypt('A'), { leaseTtlMs: TTL, failoverThresholdMs: 15 * 60_000 }),
    store: new LocalLeaseStore({ filePath: path.join(dir, 'lease-local.json') }),
    tunnel,
    presumedDeadHolders: () => new Set(),
    now: () => 2_000,
  });
  const state = new StateManager(dir);
  const coord = new MultiMachineCoordinator(state, {
    stateDir: dir,
    multiMachine: { leaseSelfHeal } as any,
  });
  coord.start();
  coord.attachLeaseCoordinator(lc);
  return coord;
}

describe('MultiMachineCoordinator F1 — tick self-heal', () => {
  let dir: string;
  beforeEach(() => { dir = tempDir(); });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tickSelfHeal:afterEach' });
  });

  it('F1a withTickTimeout: a never-settling call REJECTS after awaitTimeoutMs', async () => {
    const coord = makeCoord(dir, { tickWatchdog: { awaitTimeoutMs: 40 } });
    const hung = new Promise<void>(() => { /* never resolves */ });
    await expect((coord as any).withTickTimeout('hung', () => hung)).rejects.toThrow(/timeout/);
    coord.stop();
  });

  it('F1a withTickTimeout: a fast call RESOLVES with its value (no false timeout)', async () => {
    const coord = makeCoord(dir, { tickWatchdog: { awaitTimeoutMs: 1000 } });
    await expect((coord as any).withTickTimeout('ok', async () => 42)).resolves.toBe(42);
    coord.stop();
  });

  it('F1b watchdog: re-arms on a STALLED tick and clears a STUCK guard (old in-flight)', () => {
    const coord = makeCoord(dir, { tickWatchdog: { staleFactorMissedTicks: 2, maxReArmsPerHour: 6 } });
    const c = coord as any;
    // Simulate: main loop stalled (lastTickRunMonoMs ancient) AND a guard stuck
    // with an ANCIENT in-flight start (a tick that never reached its finally).
    c.lastTickRunMonoMs = 1;       // ancient ⇒ stale
    c.leaseTicking = true;
    c.leaseTickStartMonoMs = 1;    // ancient ⇒ stuck, not slow-but-live
    c.runTickWatchdog();
    expect(c.leaseTicking).toBe(false);                 // stuck guard cleared
    expect(c.watchdogReArmTimes.length).toBe(1);        // re-armed once
    coord.stop();
  });

  it('F1b watchdog: does NOT preempt a legitimately-slow LIVE tick (recent in-flight)', () => {
    const coord = makeCoord(dir, { tickWatchdog: { staleFactorMissedTicks: 2 } });
    const c = coord as any;
    c.lastTickRunMonoMs = 1;                 // main loop looks stalled
    c.leaseTicking = true;
    c.leaseTickStartMonoMs = c.monoNowMs();  // but THIS tick just started ⇒ slow-but-live
    c.runTickWatchdog();
    expect(c.leaseTicking).toBe(true);       // guard NOT reset — live tick protected
    coord.stop();
  });

  it('F1b watchdog: a FRESH tick is a no-op (no re-arm)', () => {
    const coord = makeCoord(dir, { tickWatchdog: { staleFactorMissedTicks: 2 } });
    const c = coord as any;
    c.lastTickRunMonoMs = c.monoNowMs();  // fresh ⇒ healthy
    c.runTickWatchdog();
    expect(c.watchdogReArmTimes.length).toBe(0);
    coord.stop();
  });

  it('F1b watchdog: SELF-DISARMS after maxReArmsPerHour re-arms', () => {
    const coord = makeCoord(dir, { tickWatchdog: { staleFactorMissedTicks: 2, maxReArmsPerHour: 3 } });
    const c = coord as any;
    for (let i = 0; i < 5; i++) {
      c.lastTickRunMonoMs = 1; // re-stale before each fire (re-arm resets it to now)
      c.runTickWatchdog();
    }
    expect(c.watchdogDisarmed).toBe(true);
    coord.stop();
  });

  it('F1b watchdog: disabled flag (read live) makes it a no-op', () => {
    const coord = makeCoord(dir, { tickWatchdog: { enabled: false, staleFactorMissedTicks: 2 } });
    const c = coord as any;
    c.lastTickRunMonoMs = 1;
    c.leaseTicking = true;
    c.leaseTickStartMonoMs = 1;
    c.runTickWatchdog();
    expect(c.leaseTicking).toBe(true);            // untouched — watchdog off
    expect(c.watchdogReArmTimes.length).toBe(0);
    coord.stop();
  });

  describe('F4 — preferred-awake deferral (opt-in)', () => {
    it('F4 off (no preferredAwakeMachineId) ⇒ never defers', () => {
      const coord = makeCoord(dir, {});
      const c = coord as any;
      c.leaseCoordinator.isHolderHealthy = () => true;
      expect(c.shouldDeferToPreferred()).toBe(false);
      coord.stop();
    });

    it('WE are the preferred machine ⇒ never defer', () => {
      const coord = makeCoord(dir, {});
      const c = coord as any;
      // point the preference at OURSELF
      c.config.multiMachine.leaseSelfHeal = { preferredAwakeMachineId: c._identity.machineId };
      c.leaseCoordinator.isHolderHealthy = () => true;
      expect(c.shouldDeferToPreferred()).toBe(false);
      coord.stop();
    });

    it('non-preferred + preferred peer HEALTHY ⇒ defer; UNHEALTHY ⇒ acquire', () => {
      const coord = makeCoord(dir, {});
      const c = coord as any;
      c.config.multiMachine.leaseSelfHeal = { preferredAwakeMachineId: 'm_preferred_peer' };
      c.leaseCoordinator.isHolderHealthy = (id: string) => id === 'm_preferred_peer'; // healthy
      expect(c.shouldDeferToPreferred()).toBe(true);
      c.leaseCoordinator.isHolderHealthy = () => false; // preferred down ⇒ no stranding
      expect(c.shouldDeferToPreferred()).toBe(false);
      coord.stop();
    });
  });
});
