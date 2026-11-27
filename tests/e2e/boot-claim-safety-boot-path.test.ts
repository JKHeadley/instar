// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * takeover-ready-pool R1 (boot claim safety) — the BOOT PATH, end to end, plus production
 * wiring integrity:
 *  - LIVE (development agent, resolved through the real resolveBootClaimSafety): the real
 *    MultiMachineCoordinator.initializeLease starts the pull loop BEFORE the boot claim, the
 *    restarted machine (own lease-local.json: held epoch 41, lapsed) does not claim while the
 *    preferred machine is silent, the pull loop's probes accrue, and when the hold ends the
 *    nudge runs the one lease actor and it takes epoch 42 — no claim before 45 s.
 *  - DARK (fleet): byte-for-byte today: the boot claim runs at once from the stale record.
 *  - server.ts hands the coordinator the live switch; AgentServer and the boot beacon carry
 *    the marker.
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

const KEY = crypto.generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const TTL = 60_000;

let dir = '';
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-claim-e2e-')); });
afterEach(() => {
  vi.useRealTimers();
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/boot-claim-safety-boot-path.test.ts:afterEach' });
});

/** The preferred machine is dead: every pull is silence. */
class DeadPreferredTransport implements LeaseTransport {
  pullTimes: number[] = [];
  private probes = new Map<string, PeerProbeRecord>();
  broadcast = async () => false;
  observed = () => ({ lease: null, lastNonceByHolder: {} });
  isReachable = () => false;
  async pullAllPeers(): Promise<void> {
    this.pullTimes.push(Date.now());
    const r = this.probes.get('m_pref') ?? { probes: [], unsignedSinceMs: null };
    r.probes.push({ atMs: Date.now(), answer: 'silent' });
    this.probes.set('m_pref', r);
  }
  probeHistory = () => new Map(this.probes);
  knownPeerIds = () => ['m_pref'];
}

async function boot(developmentAgent: boolean) {
  const machineId = `m_${crypto.randomBytes(6).toString('hex')}`;
  const identity = { machineId, signingPublicKey: 'k1', encryptionPublicKey: 'k2', name: 'laptop', platform: 'test', createdAt: new Date().toISOString(), capabilities: ['sessions'] };
  fs.mkdirSync(path.join(dir, 'machine'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'machine', 'identity.json'), JSON.stringify(identity));
  new MachineIdentityManager(dir).registerMachine(identity as never, 'standby');
  const crypt: LeaseCrypto = {
    selfMachineId: machineId,
    sign: (c) => crypto.sign(null, Buffer.from(c), KEY.privateKey).toString('base64'),
    verify: (c, sig) => { try { return crypto.verify(null, Buffer.from(c), KEY.publicKey, Buffer.from(sig, 'base64')); } catch { return false; } },
  };
  const fl = new FencedLease(crypt, { leaseTtlMs: TTL, failoverThresholdMs: 15 * 60_000 });
  const leaseFile = path.join(dir, 'lease-local.json');
  const now = Date.now();
  fs.writeFileSync(leaseFile, JSON.stringify({ lease: fl.signLease(41, new Date(now - 10 * TTL).toISOString(), new Date(now - TTL).toISOString(), 3) }));
  const config = { developmentAgent, multiMachine: { leasePullIntervalMs: 5_000, leaseSelfHeal: { preferredAwakeMachineId: 'm_pref' } } };
  const tunnel = new DeadPreferredTransport();
  const logs: string[] = [];
  const lc = new LeaseCoordinator({
    lease: fl,
    store: new LocalLeaseStore({ filePath: leaseFile }),
    tunnel,
    presumedDeadHolders: () => new Set(),
    now: () => Date.now(),
    soloCaptainHold: () => ({ enabled: true }),
    survivorMayHold: () => false, // server.ts: hard-false while a preferred machine is named
    bootClaimSafety: () => resolveBootClaimSafety(config), // the production resolution
    logger: (m) => logs.push(m),
  });
  const coord = new MultiMachineCoordinator(new StateManager(dir), { stateDir: dir, ...config } as never);
  coord.start();
  coord.attachLeaseCoordinator(lc);
  return { coord, lc, tunnel, logs };
}

describe('boot claim safety — the real boot path (feature is alive)', () => {
  it('LIVE: pull loop first, no claim from the stale record, claim only after ≥3 silent probes over ≥45 s', async () => {
    vi.useFakeTimers();
    const { coord, lc, tunnel, logs } = await boot(true);
    const t0 = Date.now();
    await coord.initializeLease();
    expect(lc.bootClaimSafetyEnabled()).toBe(true);
    expect(lc.holdsLease()).toBe(false); // the 2026-11-20 bug was a claim right here
    expect(tunnel.pullTimes.length).toBeGreaterThanOrEqual(1); // rule 1: asked first
    expect(logs.some((l) => l.includes('boot-hold: rule-2 defer'))).toBe(true);

    await vi.advanceTimersByTimeAsync(40_000);
    expect(lc.holdsLease()).toBe(false);
    expect(tunnel.pullTimes.length).toBeGreaterThanOrEqual(4); // the pull loop kept probing

    let claimedAt: number | null = null;
    for (let i = 0; i < 30 && claimedAt === null; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
      if (lc.holdsLease()) claimedAt = Date.now() - t0;
    }
    expect(claimedAt).not.toBeNull();
    expect(claimedAt!).toBeGreaterThanOrEqual(45_000);
    expect(lc.currentEpoch()).toBe(42);
    expect(coord.isAwake).toBe(true); // the nudge reconciled the role without waiting a heartbeat
    expect(logs.some((l) => l.includes('boot-hold: rule-4 end'))).toBe(true);
    coord.stop();
  });

  it('LIVE: a nudge that lands while another lease tick is in flight is kept for the next pull tick', async () => {
    vi.useFakeTimers();
    const { coord, lc } = await boot(true);
    await coord.initializeLease();
    await vi.advanceTimersByTimeAsync(40_000);
    const busy = coord as unknown as { leaseTicking: boolean };
    busy.leaseTicking = true; // a heartbeat tick is in flight when the hold ends
    await vi.advanceTimersByTimeAsync(20_000);
    expect(lc.bootHoldActive()).toBe(false);
    expect(lc.holdsLease()).toBe(false);
    busy.leaseTicking = false;
    await vi.advanceTimersByTimeAsync(7_000); // one pull tick (5 s ± 20%), far short of a heartbeat
    expect(lc.holdsLease()).toBe(true);
    coord.stop();
  });

  it('DARK (fleet): today\'s boot claim runs at once from the stale record', async () => {
    const { coord, lc, tunnel } = await boot(false);
    await coord.initializeLease();
    expect(lc.bootClaimSafetyEnabled()).toBe(false);
    expect(lc.holdsLease()).toBe(true);
    expect(lc.currentEpoch()).toBe(42);
    expect(tunnel.pullTimes.length).toBe(0);
    coord.stop();
  });
});

describe('boot claim safety — production wiring', () => {
  const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf-8');
  it('server.ts hands the coordinator the live switch from the real config', () => {
    const server = read('src/commands/server.ts');
    const start = server.indexOf('const leaseCoordinator = new LeaseCoordinator({');
    expect(start).toBeGreaterThan(-1);
    expect(server.slice(start, start + 5000)).toMatch(/bootClaimSafety: \(\) => resolveBootClaimSafety\(config\),/);
  });
  it('the boot beacon is given this machine\'s marker', () => {
    const server = read('src/commands/server.ts');
    expect(server).toMatch(/beaconMarker = instarMachineMarker\(beaconIdMgr\.loadIdentity\(\)\.machineId\)/);
    expect(server).toMatch(/new BootHealthBeacon\(config\.port, earlyBindHost, beaconMarker\)/);
  });
  it('AgentServer sets the marker before any route can answer', () => {
    const agent = read('src/server/AgentServer.ts');
    const marker = agent.indexOf('res.setHeader(INSTAR_MACHINE_HEADER, m)');
    const firstParser = agent.indexOf("this.app.use('/completion-claim/observe'");
    expect(marker).toBeGreaterThan(-1);
    expect(marker).toBeLessThan(firstParser);
  });
});
