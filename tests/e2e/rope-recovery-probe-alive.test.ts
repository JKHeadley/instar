// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * E2E "feature is alive" + wiring-integrity for U4.3 RopeRecoveryProber
 * (u4-3-breaker-recovery-probe §6 "E2E lifecycle" + "Wiring-integrity").
 *
 * Mirrors the PRODUCTION wiring contract in src/commands/server.ts:
 *   - the flag resolves through the REAL resolveDevAgentGate;
 *   - LIVE: the prober rides the REAL MultiMachineCoordinator lease-pull tick
 *     via attachLeasePullTickListener (the carrier — no new loop), its
 *     recordResult calls reach the SAME PeerEndpointResolver instance the
 *     transport uses (ONE health authority, not a copy), `lastProbeAt`
 *     advances on a dead rope, and attachRopeHealthProvider serves the
 *     `ropeHealth` field on getSyncStatus (the authed /health source);
 *   - DARK: nothing is attached — zero probes ever fire and the syncStatus
 *     field is simply absent.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { MultiMachineCoordinator } from '../../src/core/MultiMachineCoordinator.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { StateManager } from '../../src/core/StateManager.js';
import { FencedLease, type LeaseCrypto } from '../../src/core/FencedLease.js';
import { LeaseCoordinator, type LeaseTransport } from '../../src/core/LeaseCoordinator.js';
import { LocalLeaseStore } from '../../src/core/LocalLeaseStore.js';
import { PeerEndpointResolver } from '../../src/core/PeerEndpointResolver.js';
import { RopeRecoveryProber } from '../../src/core/RopeRecoveryProber.js';
import { resolveDevAgentGate } from '../../src/core/devAgentGate.js';

function genKey() {
  return crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}
const KEY = genKey();
const leaseCrypto: LeaseCrypto = {
  selfMachineId: 'A',
  sign: (c) => crypto.sign(null, Buffer.from(c), KEY.privateKey).toString('base64'),
  verify: (c, sig) => {
    try { return crypto.verify(null, Buffer.from(c), KEY.publicKey, Buffer.from(sig, 'base64')); } catch { return false; }
  },
};

let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rope-probe-e2e-'));
});
afterEach(() => {
  vi.useRealTimers();
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/rope-recovery-probe-alive.test.ts:afterEach' });
});

function seedIdentity(stateDir: string, machineId: string) {
  const identity = {
    machineId, signingPublicKey: 'k1', encryptionPublicKey: 'k2',
    name: 'machine-a', platform: 'test', createdAt: new Date().toISOString(), capabilities: ['sessions'],
  };
  fs.mkdirSync(path.join(stateDir, 'machine'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'machine', 'identity.json'), JSON.stringify(identity));
  return identity;
}

function mkResolver(): PeerEndpointResolver {
  return new PeerEndpointResolver({
    config: {
      enabled: true,
      hedgeDelayMs: 1500,
      priorityTailscale: 10,
      priorityLan: 20,
      priorityCloudflare: 30,
      tailscaleEnabled: true,
      lanSubnetGate: false,
      unhealthyAfterFailures: 3,
      endpointEvictionMs: 3_600_000,
      maxProbeBackoffMs: 300_000,
      requestTimeoutMs: 30_000,
    },
  });
}

/** A real coordinator with a real (solo) lease pull loop armed. */
async function mkCoordinator(): Promise<{ coord: MultiMachineCoordinator }> {
  const machineId = `m_${crypto.randomBytes(8).toString('hex')}`;
  const identity = seedIdentity(dir, machineId);
  new MachineIdentityManager(dir).registerMachine(identity as never, 'awake');
  const soloTunnel: LeaseTransport = {
    broadcast: async () => true,
    observed: () => ({ lease: null, lastNonceByHolder: {} }),
    isReachable: () => true,
    pullAllPeers: async () => { /* solo */ },
  };
  const lc = new LeaseCoordinator({
    lease: new FencedLease(leaseCrypto, { leaseTtlMs: 60_000, failoverThresholdMs: 15 * 60_000 }),
    store: new LocalLeaseStore({ filePath: path.join(dir, 'lease-local.json') }),
    tunnel: soloTunnel,
    presumedDeadHolders: () => new Set(),
    now: () => Date.now(),
  });
  const coord = new MultiMachineCoordinator(new StateManager(dir), {
    stateDir: dir,
    multiMachine: { leasePullIntervalMs: 1_000 } as never,
  });
  coord.start();
  coord.attachLeaseCoordinator(lc);
  await coord.initializeLease();
  return { coord };
}

describe('U4.3 rope recovery probe — E2E lifecycle (feature is alive)', () => {
  it('DEV AGENT (gate live): the prober rides the REAL lease-pull tick — a dead rope gets probed (lastProbeAt advances) and recordResult reaches the SAME resolver', async () => {
    // The production gate resolution (server.ts): omitted flag + dev agent ⇒ live.
    expect(resolveDevAgentGate(undefined, { developmentAgent: true })).toBe(true);

    vi.useFakeTimers();
    const { coord } = await mkCoordinator();
    const resolver = mkResolver();
    // The transport kills a rope on the ONE health authority (3 consecutive fails).
    for (let i = 0; i < 3; i++) resolver.recordResult('m_peer', 'tailscale', false, 40);
    expect(resolver.snapshot()[0].dead).toBe(true);

    const probes: string[] = [];
    const prober = new RopeRecoveryProber(
      {
        resolver,
        listTargets: () => [{ machineId: 'm_peer', kind: 'tailscale', url: 'https://peer.example' }],
        // A typed success (the peer's real dispatcher answered the canary).
        sendProbe: async (t) => {
          probes.push(`${t.machineId}/${t.kind}`);
          return { typedSuccess: true, detail: 'refused-not-router', latencyMs: 12 };
        },
      },
      { dryRun: false, floorMs: 900_000, exhaustAttempts: 20, reopenEpisodeWindowMs: 600_000, midIntervalMs: 45_000, maxUnreclaimedSuccesses: 20 },
    );
    // The PRODUCTION carrier attachment (server.ts):
    coord.attachLeasePullTickListener(() => prober.onTick());
    coord.attachRopeHealthProvider(() => prober.view());

    // Fire real (jittered ≤1.2s) lease-pull ticks — the probe carrier.
    await vi.advanceTimersByTimeAsync(1_300);
    expect(probes.length).toBeGreaterThanOrEqual(1); // the dead rope WAS dialed

    // WIRING INTEGRITY: the probe's typed success reached the SAME resolver
    // instance the transport uses — the dead flag cleared on the FIRST typed
    // success (R-r2-3 close semantics).
    expect(resolver.snapshot()[0].dead).toBe(false);
    expect(resolver.snapshot()[0].recoveryStreak).toBeGreaterThanOrEqual(1);

    // The /health source: getSyncStatus carries ropeHealth via the handle.
    const sync = coord.getSyncStatus();
    expect(Array.isArray(sync.ropeHealth)).toBe(true);
    expect(sync.ropeHealth![0]).toMatchObject({ peer: 'm_peer', kind: 'tailscale' });
    expect(sync.ropeHealth![0].lastProbeAt).toBeTypeOf('number'); // lastProbeAt advanced

    coord.stop();
  });

  it('DARK (fleet posture): gate resolves off — nothing attached, ZERO probes, syncStatus omits ropeHealth', async () => {
    expect(resolveDevAgentGate(undefined, {})).toBe(false);

    vi.useFakeTimers();
    const { coord } = await mkCoordinator();
    const resolver = mkResolver();
    for (let i = 0; i < 3; i++) resolver.recordResult('m_peer', 'tailscale', false, 40);
    // Production dark path: the prober is never constructed, no listener attached.
    await vi.advanceTimersByTimeAsync(5_000);
    expect('ropeHealth' in coord.getSyncStatus()).toBe(false);
    expect(resolver.snapshot()[0].dead).toBe(true); // nothing touched the record
    coord.stop();
  });

  it('carrier robustness: a THROWING tick listener never breaks the lease pull (error-isolated)', async () => {
    vi.useFakeTimers();
    const { coord } = await mkCoordinator();
    let calls = 0;
    coord.attachLeasePullTickListener(() => {
      calls += 1;
      throw new Error('probe scan fault');
    });
    await vi.advanceTimersByTimeAsync(1_300);
    const first = calls;
    expect(first).toBeGreaterThanOrEqual(1);
    // The pull loop survives and keeps ticking (the listener keeps being called).
    await vi.advanceTimersByTimeAsync(1_300);
    expect(calls).toBeGreaterThan(first);
    coord.stop();
  });
});
