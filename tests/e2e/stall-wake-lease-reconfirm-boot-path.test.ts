// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * stall-wake-lease-reconfirm (fb-fdb55c1c-a79) — the real boot and tick path, end to end, plus
 * production wiring:
 *  - the real MultiMachineCoordinator boots a standby through initializeLease with the switch
 *    resolved by the real resolveStallReconfirm, sees the Studio holding, then the clock jumps
 *    226 s and the overdue heartbeat tick runs the one lease actor first (the order at wake on
 *    2026-11-21 16:09:47Z). LIVE: no claim, the Studio re-confirmed. DARK: the claim at once.
 *  - server.ts hands the coordinator the live switch from the real config.
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
import { resolveBootClaimSafety, type PeerProbeRecord } from '../../src/core/BootClaimHold.js';
import { resolveStallReconfirm } from '../../src/core/StallReconfirm.js';
import type { LeaseRecord } from '../../src/core/types.js';

const TTL = 60_000;
const KEYS: Record<string, { publicKey: string; privateKey: string }> = {};
const keyFor = (id: string) => (KEYS[id] ??= crypto.generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } }));
const crypt = (self: string): LeaseCrypto => ({
  selfMachineId: self,
  sign: (c) => crypto.sign(null, Buffer.from(c), keyFor(self).privateKey).toString('base64'),
  verify: (c, sig, holder) => { try { return crypto.verify(null, Buffer.from(c), keyFor(holder).publicKey, Buffer.from(sig, 'base64')); } catch { return false; } },
});

let dir = '';
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-reconfirm-e2e-')); });
afterEach(() => {
  vi.useRealTimers();
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/stall-wake-lease-reconfirm-boot-path.test.ts:afterEach' });
});

/** The Studio, alive and renewing: every pull returns its lease signed at the current clock. */
class RenewingStudioTransport implements LeaseTransport {
  pullTimes: number[] = [];
  private obs: LeaseRecord | null = null;
  private nonce = 900;
  private probes = new Map<string, PeerProbeRecord>();
  private disclosed = new Map<string, { lease: LeaseRecord | null; observedAtMs: number }>();
  /** Folding paused: what this process cannot do while it is stalled. */
  frozen = false;
  constructor(private studio: FencedLease) {}
  studioLease(): LeaseRecord {
    return this.studio.signLease(23760, new Date(Date.now() - 3.5 * 3_600_000).toISOString(), new Date(Date.now() + TTL).toISOString(), ++this.nonce);
  }
  broadcast = async () => true;
  observed = () => ({ lease: this.obs, lastNonceByHolder: this.obs ? { [this.obs.holder]: this.obs.nonce } : {} });
  isReachable = () => true;
  async pullAllPeers(): Promise<void> {
    if (this.frozen) return;
    this.pullTimes.push(Date.now());
    const r = this.probes.get('m_studio') ?? { probes: [], unsignedSinceMs: null, firstSignedAtMs: null };
    r.probes.push({ atMs: Date.now(), answer: 'signed' });
    if (r.firstSignedAtMs == null) r.firstSignedAtMs = Date.now();
    this.probes.set('m_studio', r);
    const l = this.studioLease();
    this.disclosed.set('m_studio', { lease: l, observedAtMs: Date.now() });
    this.obs = l;
  }
  probeHistory = () => new Map(this.probes);
  knownPeerIds = () => ['m_studio'];
  observedByPeer = () => new Map(this.disclosed);
}

async function boot(stallOn: boolean) {
  const machineId = `m_${crypto.randomBytes(6).toString('hex')}`;
  const identity = { machineId, signingPublicKey: 'k1', encryptionPublicKey: 'k2', name: 'laptop', platform: 'test', createdAt: new Date().toISOString(), capabilities: ['sessions'] };
  fs.mkdirSync(path.join(dir, 'machine'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'machine', 'identity.json'), JSON.stringify(identity));
  new MachineIdentityManager(dir).registerMachine(identity as never, 'standby');
  const fl = new FencedLease(crypt(machineId), { leaseTtlMs: TTL, failoverThresholdMs: 15 * 60_000 });
  const config = {
    developmentAgent: true,
    multiMachine: {
      leasePullIntervalMs: 5_000,
      leaseSelfHeal: { preferredAwakeMachineId: 'm_studio' },
      takeoverReadyPool: { stallReconfirm: { enabled: stallOn } },
    },
  };
  const tunnel = new RenewingStudioTransport(new FencedLease(crypt('m_studio'), { leaseTtlMs: TTL, failoverThresholdMs: 15 * 60_000 }));
  const logs: string[] = [];
  const lc = new LeaseCoordinator({
    lease: fl,
    store: new LocalLeaseStore({ filePath: path.join(dir, 'lease-local.json') }),
    tunnel,
    presumedDeadHolders: () => new Set(),
    now: () => Date.now(),
    monotonicNow: () => Date.now(),
    survivorMayHold: () => false,
    bootClaimSafety: () => resolveBootClaimSafety(config),
    stallReconfirm: () => resolveStallReconfirm(config), // the production resolution
    logger: (m) => logs.push(m),
  });
  const coord = new MultiMachineCoordinator(new StateManager(dir), { stateDir: dir, ...config } as never);
  coord.start();
  coord.attachLeaseCoordinator(lc);
  return { coord, lc, tunnel, logs };
}

/** Boot, run a minute of normal pulls, then the 226 s stall and the overdue heartbeat tick first. */
async function stallAndWake(stallOn: boolean) {
  vi.useFakeTimers();
  const b = await boot(stallOn);
  await b.coord.initializeLease();
  expect(b.lc.holdsLease()).toBe(false);
  expect(b.lc.currentHolder()).toBe('m_studio');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(b.lc.bootHoldActive()).toBe(false);
  expect(b.lc.holdsLease()).toBe(false);
  b.tunnel.frozen = true; // the stall: nothing is folded
  vi.setSystemTime(Date.now() + 226_000);
  b.tunnel.frozen = false; // awake again: the next pull answers
  await (b.coord as unknown as { tickLease(): Promise<void> }).tickLease();
  return b;
}

describe('stall reconfirm — the real boot and tick path (feature is alive)', () => {
  it('LIVE: after a 226 s jump the heartbeat tick re-asks the Studio and does not claim', async () => {
    const { coord, lc, tunnel, logs } = await stallAndWake(true);
    expect(lc.stallReconfirmEnabled()).toBe(true);
    expect(lc.holdsLease()).toBe(false);
    expect(lc.currentHolder()).toBe('m_studio');
    expect(lc.currentEpoch()).toBe(23760);
    expect(coord.isAwake).toBe(false);
    expect(tunnel.pullTimes.at(-1)).toBe(Date.now()); // the fresh pull at wake
    expect(logs.some((l) => /stall-reconfirm: opened/.test(l))).toBe(true);
    // Normal running afterwards: still the Studio's.
    await vi.advanceTimersByTimeAsync(180_000);
    expect(lc.holdsLease()).toBe(false);
    expect(lc.currentEpoch()).toBe(23760);
    coord.stop();
  });

  it('DARK: the same wake claims the aged copy at once (today\'s behaviour, the incident)', async () => {
    const { coord, lc } = await stallAndWake(false);
    expect(lc.stallReconfirmEnabled()).toBe(false);
    expect(lc.holdsLease()).toBe(true);
    expect(lc.currentEpoch()).toBe(23761);
    coord.stop();
  });
});

describe('stall reconfirm — production wiring', () => {
  it('server.ts hands the coordinator the live switch from the real config', () => {
    const server = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf-8');
    const start = server.indexOf('const leaseCoordinator = new LeaseCoordinator({');
    expect(start).toBeGreaterThan(-1);
    expect(server.slice(start, start + 5000)).toMatch(/stallReconfirm: \(\) => resolveStallReconfirm\(config\),/);
    expect(server).toMatch(/import \{ resolveStallReconfirm \} from '\.\.\/core\/StallReconfirm\.js';/);
  });
});
