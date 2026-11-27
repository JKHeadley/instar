// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * planned-restart-keeps-lead (fb-135e3043-add) — the BOOT PATH, end to end, plus production wiring:
 *  - LIVE: the previous process left a window lease on disk (continuity record + store marker); the real
 *    MultiMachineCoordinator.initializeLease starts the pull loop first, holds nothing until a peer's
 *    identity-verified answer lands, then renews the SAME epoch and comes up awake — with boot claim
 *    safety on and off (rule 1b is keyed on the disk state).
 *  - LIVE, dark pool: every known peer silent for the boot hold's span → survivor hold, same epoch.
 *  - the restart announce reaches the coordinator and shows in syncStatus.pendingRestart.
 *  - server.ts hands the coordinator the continuity deps, stamps the exit first in shutdown, and gives
 *    the foreground watcher its wait; every in-process writer announces before it publishes.
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
import { LeaseContinuityStore } from '../../src/core/LeaseContinuity.js';
import { resolveBootClaimSafety, resolvePlannedRestartLeaseContinuity, UNSIGNED_WINDOW_CEILING_MS, type PeerProbeRecord, type ProbeAnswer } from '../../src/core/BootClaimHold.js';
import { announceRestartRequested, _resetRestartSignalForTests } from '../../src/core/restartRequestSignal.js';
import type { LeaseRecord } from '../../src/core/types.js';

const KEY = crypto.generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const TTL = 60_000;
const WINDOW = 3 * TTL + 53_000;

let dir = '';
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prkl-e2e-')); _resetRestartSignalForTests(); });
afterEach(() => {
  vi.useRealTimers();
  _resetRestartSignalForTests();
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/planned-restart-keeps-lead-boot-path.test.ts:afterEach' });
});

/** The one peer: answers signed with no lease of its own, or stays silent. */
class PeerTransport implements LeaseTransport {
  answer: ProbeAnswer = 'signed';
  /** Set when this machine's own dials fail (every route refused here): silence that is ours, not the peer's. */
  cause: 'local-refusal' | 'no-route' | undefined = undefined;
  peerLease: LeaseRecord | null = null;
  pullTimes: number[] = [];
  broadcasts: LeaseRecord[] = [];
  private probes = new Map<string, PeerProbeRecord>();
  private verified = new Map<string, { lease: LeaseRecord | null; atMs: number; round: number }>();
  private round = 0;
  private roundStart = 0;
  private listeners: Array<(p: string, a: ProbeAnswer, r: number) => void> = [];
  private obs: LeaseRecord | null = null;
  broadcast = async (lease: LeaseRecord) => { this.broadcasts.push(lease); return this.answer === 'signed'; };
  observed = () => ({ lease: this.obs, lastNonceByHolder: this.obs ? { [this.obs.holder]: this.obs.nonce } : {} });
  isReachable = () => this.answer === 'signed';
  async pullAllPeers(): Promise<void> {
    this.round++;
    this.roundStart = Date.now();
    this.pullTimes.push(Date.now());
    const r = this.probes.get('m_laptop') ?? { probes: [], unsignedSinceMs: null, firstSignedAtMs: null };
    r.probes.push(this.answer === 'silent' && this.cause ? { atMs: Date.now(), answer: this.answer, cause: this.cause } : { atMs: Date.now(), answer: this.answer });
    this.probes.set('m_laptop', r);
    if (this.answer === 'signed') {
      this.verified.set('m_laptop', { lease: this.peerLease, atMs: Date.now(), round: this.round });
      if (this.peerLease) this.obs = this.peerLease;
    }
    for (const fn of this.listeners) fn('m_laptop', this.answer, this.round);
  }
  probeHistory = () => new Map(this.probes);
  knownPeerIds = () => ['m_laptop'];
  verifiedAnswers = () => new Map(this.verified);
  currentPullRound = () => ({ round: this.round, startedAtMs: this.roundStart });
  attachProbeListener = (fn: (p: string, a: ProbeAnswer, r: number) => void) => { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter((l) => l !== fn); }; };
}

function machine(developmentAgent: boolean, extra: Record<string, unknown> = {}, restartAdmission = false) {
  const machineId = `m_${crypto.randomBytes(6).toString('hex')}`;
  const identity = { machineId, signingPublicKey: 'k1', encryptionPublicKey: 'k2', name: 'studio', platform: 'test', createdAt: new Date().toISOString(), capabilities: ['sessions'] };
  fs.mkdirSync(path.join(dir, 'machine'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'machine', 'identity.json'), JSON.stringify(identity));
  new MachineIdentityManager(dir).registerMachine(identity as never, 'standby');
  const crypt: LeaseCrypto = {
    selfMachineId: machineId,
    sign: (c) => crypto.sign(null, Buffer.from(c), KEY.privateKey).toString('base64'),
    verify: (c, sig) => { try { return crypto.verify(null, Buffer.from(c), KEY.publicKey, Buffer.from(sig, 'base64')); } catch { return false; } },
  };
  const fl = new FencedLease(crypt, { leaseTtlMs: TTL, failoverThresholdMs: 15 * 60_000 });
  const config = { developmentAgent, multiMachine: { leasePullIntervalMs: 5_000, leaseSelfHeal: { preferredAwakeMachineId: machineId }, ...extra } };
  const store = new LocalLeaseStore({ filePath: path.join(dir, 'state', 'lease-local.json') });
  const continuity = new LeaseContinuityStore({
    stateDir: dir, selfMachineId: machineId,
    sign: (c) => fl.signContinuityMeta(c), verify: (c, s, h) => fl.verifyContinuityMeta(c, s, h), verifyLease: (l) => fl.verifyLease(l),
    unsignedCeilingMs: UNSIGNED_WINDOW_CEILING_MS,
  });
  const build = (tunnel: PeerTransport) => {
    const logs: string[] = [];
    const coord = new MultiMachineCoordinator(new StateManager(dir), { stateDir: dir, ...config } as never);
    const lc = new LeaseCoordinator({
      lease: fl,
      store,
      tunnel,
      continuity,
      presumedDeadHolders: () => new Set(),
      now: () => Date.now(),
      soloCaptainHold: () => ({ enabled: false }),
      survivorMayHold: () => true,
      bootClaimSafety: () => resolveBootClaimSafety(config),
      plannedRestartContinuity: () => resolvePlannedRestartLeaseContinuity(config),
      plannedRestartAdmissionEnabled: () => restartAdmission,
      plannedRestartMinimumRemainingMs: () => restartAdmission ? 131_000 : null,
      renewIntervalMs: () => coord.leaseRenewIntervalMs(),
      broadcastDeadlineMs: () => 8_000,
      readRequestFile: () => ({ present: false }),
      findConsumption: () => ({ record: null, coverage: 'full' }),
      bootRoleAwake: () => true,
      onEpisodeChange: (p) => coord.noteLeaseEpisodeChange(p),
      logger: (m) => logs.push(m),
    });
    coord.start();
    coord.attachLeaseCoordinator(lc);
    return { coord, lc, logs };
  };
  return { machineId, fl, store, continuity, build, config };
}

/** The previous process: holder at epoch 1 that announced a role-change restart and exited. */
async function previousProcessLeftAWindowLease(m: ReturnType<typeof machine>) {
  const tunnel = new PeerTransport();
  const { coord, lc } = m.build(tunnel);
  await coord.initializeLease();
  expect(lc.holdsLease()).toBe(true);
  const epoch = lc.currentEpoch();
  const outcome = await announceRestartRequested({ requestedBy: 'role-change', reason: 'this machine took the lease', requestedAt: new Date().toISOString() });
  expect(outcome).toBe('confirmed');
  expect(coord.getSyncStatus().pendingRestart).toMatchObject({ requestedBy: 'role-change', windowMs: WINDOW });
  expect(Date.parse(tunnel.broadcasts.at(-1)!.expiresAt)).toBe(Date.now() + WINDOW);
  expect(lc.stampContinuityExit()).toBe(true);
  coord.stop();
  _resetRestartSignalForTests();
  return epoch;
}

describe('planned restart keeps the lead — the real boot path (feature is alive)', () => {
  for (const safetyOn of [true, false]) {
    it(`LIVE (boot claim safety ${safetyOn ? 'on' : 'off'}): the window lease is held only after a peer confirms, then the same epoch is kept and the machine is awake`, async () => {
      vi.useFakeTimers();
      // The continuity switch is read live; rule 1b does not depend on boot claim safety.
      const m = safetyOn ? machine(true) : machine(false, { takeoverReadyPool: { bootClaimSafety: { enabled: false }, plannedRestartLeaseContinuity: { enabled: true } } });
      const epoch = await previousProcessLeftAWindowLease(m);
      // A 90 s boot: past the TTL, inside the window.
      await vi.advanceTimersByTimeAsync(90_000);
      const tunnel = new PeerTransport();
      const { coord, lc, logs } = m.build(tunnel);
      expect(lc.bootClaimSafetyEnabled()).toBe(safetyOn);
      expect(lc.bootReclaimPending()).toBe(true);
      expect(lc.holdsLease()).toBe(false); // nothing is held from the local file
      const init = coord.initializeLease();
      await vi.advanceTimersByTimeAsync(7_000); // the first ask, then one pull round
      await init;
      expect(tunnel.pullTimes.length).toBeGreaterThanOrEqual(1); // asked before anything was held
      expect(lc.holdsLease()).toBe(true);
      expect(lc.currentEpoch()).toBe(epoch);
      expect(coord.isAwake).toBe(true);
      expect(lc.bootReclaimPending()).toBe(false);
      expect(fs.existsSync(m.continuity.filePath)).toBe(false);
      expect(m.store.readPendingEpisodeId()).toBeNull();
      expect(m.continuity.bootSamplesMs()).toHaveLength(1);
      expect(m.continuity.bootSamplesMs()[0]).toBeGreaterThanOrEqual(90_000);
      expect(logs.some((l) => l.includes('keeps the lead'))).toBe(true);
      expect(coord.getSyncStatus().pendingRestart).toBeNull();
      coord.stop();
    });
  }

  it('LIVE, dark pool: every known peer silent for the boot hold\'s span → survivor hold on the same epoch', async () => {
    vi.useFakeTimers();
    const m = machine(true);
    const epoch = await previousProcessLeftAWindowLease(m);
    await vi.advanceTimersByTimeAsync(60_000);
    const tunnel = new PeerTransport();
    tunnel.answer = 'silent';
    const { coord, lc, logs } = m.build(tunnel);
    const init = coord.initializeLease();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(lc.holdsLease()).toBe(false); // three probes but not 45 s yet
    await vi.advanceTimersByTimeAsync(25_000);
    await init;
    expect(lc.holdsLease()).toBe(true);
    expect(lc.currentEpoch()).toBe(epoch);
    expect(coord.isAwake).toBe(true);
    expect(logs.some((l) => l.includes('as a survivor hold'))).toBe(true);
    coord.stop();
  });

  it('LIVE: a peer alive but refused from this machine only (Local Network permission) — no survivor hold; standby after the wait, still asking', async () => {
    vi.useFakeTimers();
    const m = machine(true);
    const epoch = await previousProcessLeftAWindowLease(m);
    await vi.advanceTimersByTimeAsync(60_000);
    const tunnel = new PeerTransport();
    tunnel.answer = 'silent';
    tunnel.cause = 'local-refusal';
    const { coord, lc, logs } = m.build(tunnel);
    const init = coord.initializeLease();
    await vi.advanceTimersByTimeAsync(60_000); // well past boot claim safety's 45 s silence span
    expect(lc.holdsLease()).toBe(false); // the survivor hold is NOT taken on our own blindness
    expect(logs.some((l) => l.includes('as a survivor hold'))).toBe(false);
    expect(logs.some((l) => l.includes('alive and unknown'))).toBe(true);
    await vi.advanceTimersByTimeAsync(65_000); // the 120 s verdict wait ends
    await init;
    expect(coord.isAwake).toBe(false);
    expect(lc.bootReclaimPending()).toBe(true); // the pull tick keeps asking
    expect(lc.currentEpoch()).toBe(epoch);
    // The permission is granted (or the Tailscale rope comes up): the next round confirms the same epoch.
    tunnel.answer = 'signed';
    tunnel.cause = undefined;
    await vi.advanceTimersByTimeAsync(7_000);
    expect(lc.holdsLease()).toBe(true);
    expect(lc.currentEpoch()).toBe(epoch);
    expect(coord.isAwake).toBe(true);
    coord.stop();
  });

  it('LIVE: a peer already at a newer epoch supersedes the window lease — adopt, standby', async () => {
    vi.useFakeTimers();
    const m = machine(true);
    const epoch = await previousProcessLeftAWindowLease(m);
    await vi.advanceTimersByTimeAsync(60_000);
    const tunnel = new PeerTransport();
    const peerCrypt: LeaseCrypto = { selfMachineId: 'm_laptop', sign: (c) => crypto.sign(null, Buffer.from(c), KEY.privateKey).toString('base64'), verify: () => true };
    tunnel.peerLease = new FencedLease(peerCrypt, { leaseTtlMs: TTL, failoverThresholdMs: 15 * 60_000 }).signLease(epoch + 5, new Date(Date.now() - 5_000).toISOString(), new Date(Date.now() + TTL).toISOString(), 9);
    const { coord, lc, logs } = m.build(tunnel);
    const init = coord.initializeLease();
    await vi.advanceTimersByTimeAsync(7_000);
    await init;
    expect(lc.holdsLease()).toBe(false);
    expect(lc.currentEpoch()).toBe(epoch + 5);
    expect(coord.isAwake).toBe(false);
    expect(fs.existsSync(m.continuity.filePath)).toBe(false);
    expect(logs.some((l) => l.includes('was superseded by epoch'))).toBe(true);
    coord.stop();
  });

  it('DARK: with the switch off nothing is extended and today\'s renewal is byte-for-byte', async () => {
    vi.useFakeTimers();
    const m = machine(false);
    const tunnel = new PeerTransport();
    const { coord, lc } = m.build(tunnel);
    await coord.initializeLease();
    expect(lc.holdsLease()).toBe(true);
    const outcome = await announceRestartRequested({ requestedBy: 'role-change', reason: 'x', requestedAt: new Date().toISOString() });
    expect(outcome).toBeNull();
    expect(coord.getSyncStatus().pendingRestart).toBeNull();
    expect(fs.existsSync(m.continuity.filePath)).toBe(false);
    expect(Date.parse(lc.currentLease()!.expiresAt)).toBe(Date.now() + TTL);
    coord.stop();
  });
});

describe('planned restart keeps the lead — production wiring', () => {
  const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf-8');
  it('server.ts hands the coordinator the live switch, the continuity store and the request/ledger readers', () => {
    const server = read('src/commands/server.ts');
    const start = server.indexOf('const leaseCoordinator = new LeaseCoordinator({');
    expect(start).toBeGreaterThan(-1);
    const block = server.slice(start, start + 8000);
    expect(block).toContain('plannedRestartContinuity: () => resolvePlannedRestartLeaseContinuity(config),');
    expect(block).toContain('continuity: new LeaseContinuityStore({');
    expect(block).toContain('findConsumption: (lookup) => findRestartRequestRecord(config.stateDir, lookup),');
    expect(block).toContain('onEpisodeChange: (pending) => coordinator.noteLeaseEpisodeChange(pending),');
    expect(server).toContain('bootRoleAwakeForLease = coordinator.isAwake;');
  });
  it('shutdown stamps the exit as its first action; the foreground watcher waits for the window renewal', () => {
    const server = read('src/commands/server.ts');
    const shutdown = server.indexOf('_shuttingDown = true;');
    const tail = server.slice(shutdown, shutdown + 6000);
    expect(tail).toContain('leaseCoordinatorRef?.stampContinuityExit()');
    expect(tail.indexOf('await ')).toBeGreaterThan(-1);
    expect(tail.indexOf('stampContinuityExit')).toBeLessThan(tail.indexOf('await '));
    expect(server).toMatch(/beforeConsume: \(request\) => leaseCoordinatorRef\?\.awaitWindowRenewalForConsumer\(/);
  });
  it('every in-process writer announces before it publishes', () => {
    for (const [file, fn] of [
      ['src/core/roleFollowRestart.ts', 'export async function requestRoleRestart('],
      ['src/core/AutoUpdater.ts', 'private async requestRestart('],
      ['src/server/AgentServer.ts', 'private async requestSupervisedRestart('],
      ['src/core/sessionPoolPairActivation.ts', 'export async function requestPairActivationRestart('],
      ['src/core/SubscriptionReloginOperatorConfig.ts', 'export function writeSubscriptionReloginRestartRequest('],
      ['src/threadline/connectEnable.ts', 'export function writeConnectRestartRequest('],
      ['src/feedback-factory/drain/FeedbackFactoryDefaultsSelfHeal.ts', 'export function requestSelfHealRestart('],
    ] as const) {
      const src = read(file);
      const at = src.indexOf(fn);
      expect(at, file).toBeGreaterThan(-1);
      const body = src.slice(at, at + 2500);
      const announce = body.indexOf('announceRestartRequested(');
      const publish = body.search(/(?:publishRestartRequestFile(?:Async)?|replaceRestartRequestFile|publishRestartRequestUnderLock)\(/);
      expect(publish, `${file}: publish`).toBeGreaterThan(-1);
      expect(announce, `${file}: announce`).toBeGreaterThan(-1);
      expect(announce, `${file}: announce before publish`).toBeLessThan(publish);
    }
    // The three hot writers await the confirmation.
    expect(read('src/core/roleFollowRestart.ts')).toContain('await announceRestartRequested(');
    expect(read('src/core/AutoUpdater.ts')).toContain('await announceRestartRequested(');
    expect(read('src/server/AgentServer.ts')).toContain('await announceRestartRequested(');
    const server = read('src/commands/server.ts');
    const fix = server.indexOf("if (cmd === 'restart') {");
    expect(server.slice(fix, fix + 1500)).toContain('await announceRestartRequested(');
    expect(server.slice(fix, fix + 1500)).toContain('plannedRestart: true');
    // Withdrawal announces too, and the coordinator subscribes to both.
    expect(read('src/core/roleFollowRestart.ts')).toContain('announceRestartWithdrawn();');
    const mmc = read('src/core/MultiMachineCoordinator.ts');
    expect(mmc).toContain('onRestartRequested(');
    expect(mmc).toContain('onRestartWithdrawn(');
  });
});

it('requires an exact request and exact confirmed nonce for dark restart admission', async () => {
  vi.useFakeTimers();
  const m = machine(true, {}, true);
  const tunnel = new PeerTransport();
  const { coord, lc } = m.build(tunnel);
  const request = { requestedBy: 'fixture-supervisor', requestedAt: new Date().toISOString(), minimumRemainingMs: 131_000 };
  try {
    await coord.initializeLease();
    expect(lc.confirmedPlannedRestartWindow(request)).toBeNull();
    expect(await announceRestartRequested({ ...request, reason: 'fixture update' })).toBe('confirmed');
    const confirmed = m.continuity.read().file!;
    expect(lc.confirmedPlannedRestartWindow(request)).toEqual({
      holder: m.machineId, epoch: confirmed.lease.epoch, nonce: confirmed.lease.nonce, expiresAt: confirmed.lease.expiresAt,
    });
    expect(lc.confirmedPlannedRestartWindow({ ...request, requestedAt: new Date(Date.now() + 1).toISOString() })).toBeNull();
    expect(lc.confirmedPlannedRestartWindow({ ...request, requestedBy: 'role-change' })).toBeNull();
    expect(lc.confirmedPlannedRestartWindow({ ...request, minimumRemainingMs: 900_000 })).toBeNull();

    // Even when the episode's confirmation bit remains set, a different nonce is not a confirmed window.
    const newer = m.fl.signLease(confirmed.lease.epoch, confirmed.lease.acquiredAt, confirmed.lease.expiresAt, confirmed.lease.nonce + 1);
    expect(m.continuity.write(m.continuity.sign({ ...confirmed, lease: newer }))).toBe(true);
    expect(lc.confirmedPlannedRestartWindow(request)).toBeNull();

    const replacement = { ...request, requestedAt: new Date(Date.now() + 1).toISOString() };
    let finishTtlBroadcast!: (ok: boolean) => void;
    vi.spyOn(tunnel, 'broadcast').mockImplementationOnce(() => new Promise(resolve => { finishTtlBroadcast = resolve; }));
    expect(await lc.awaitWindowRenewalForConsumer(replacement)).toBe('confirmed');
    finishTtlBroadcast(true);
    await Promise.resolve();
    expect(lc.confirmedPlannedRestartWindow(request)).toBeNull();
    expect(lc.confirmedPlannedRestartWindow(replacement)).not.toBeNull();
  } finally {
    coord.stop();
  }
});
