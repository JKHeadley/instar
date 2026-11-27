// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * planned-restart-keeps-lead (fb-135e3043-add) — LeaseCoordinator with real Ed25519 leases, the real
 * LocalLeaseStore and the real continuity store on a temp dir:
 *  - the night of 2026-11-21 reproduced: a holder restarts for a role change, its boot outlasts the
 *    lease TTL, and without the fix it comes up asking and the lead is gone; with the fix the pending
 *    renewal carries the window, the continuity record folds at boot, a peer's qualifying answer
 *    confirms the same epoch, and the lead is kept;
 *  - the boundaries: not the holder / no peers → inert; superseded at boot → adopt; every peer silent
 *    → survivor hold; episode end rules; rule 1b keyed on disk, not the switch; relinquish cleans up.
 */
import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FencedLease, type LeaseCrypto } from '../../src/core/FencedLease.js';
import { LeaseCoordinator, type LeaseTransport } from '../../src/core/LeaseCoordinator.js';
import { LocalLeaseStore } from '../../src/core/LocalLeaseStore.js';
import { LeaseContinuityStore } from '../../src/core/LeaseContinuity.js';
import { UNSIGNED_WINDOW_CEILING_MS } from '../../src/core/BootClaimHold.js';
import { findRestartRequestRecord, recordRestartRequest } from '../../src/core/restartRequestAttribution.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { PeerProbeRecord, ProbeAnswer, ProbeSilenceCause } from '../../src/core/BootClaimHold.js';
import type { LeaseRecord } from '../../src/core/types.js';

const IDS = ['studio', 'laptop', 'mini'];
const KEYS = Object.fromEntries(IDS.map((id) => [id, crypto.generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})])) as Record<string, { publicKey: string; privateKey: string }>;
function crypt(self: string): LeaseCrypto {
  return {
    selfMachineId: self,
    sign: (c) => crypto.sign(null, Buffer.from(c), KEYS[self].privateKey).toString('base64'),
    verify: (c, sig, holder) => { const pub = KEYS[holder]?.publicKey; if (!pub) return false; try { return crypto.verify(null, Buffer.from(c), pub, Buffer.from(sig, 'base64')); } catch { return false; } },
  };
}
const TTL = 60_000;
const FAILOVER = 15 * 60_000;
const WINDOW = 3 * TTL + 53_000; // the unmeasured base on this rig: 233 s
const fl = (id: string) => new FencedLease(crypt(id), { leaseTtlMs: TTL, failoverThresholdMs: FAILOVER });

/** Scripted pull transport with rounds and identity-verified answers (what HttpLeaseTransport now exposes). */
class ScriptedTransport implements LeaseTransport {
  answers: Record<string, ProbeAnswer> = {};
  /** Why a peer's silence is this machine's own (every route refused here), when it is. */
  causes: Record<string, ProbeSilenceCause | undefined> = {};
  leases: Record<string, LeaseRecord | null> = {};
  broadcastOk = true;
  broadcasts: LeaseRecord[] = [];
  private obs: LeaseRecord | null = null;
  private probes = new Map<string, PeerProbeRecord>();
  private verified = new Map<string, { lease: LeaseRecord | null; atMs: number; round: number }>();
  private round = 0;
  private roundStart = 0;
  private listeners: Array<(p: string, a: ProbeAnswer, r: number) => void> = [];
  constructor(private peers: string[], private now: () => number) {}
  broadcast = async (lease: LeaseRecord) => { this.broadcasts.push(lease); return this.broadcastOk && (this.peers.length === 0 || this.peers.some((p) => this.answers[p] === 'signed')); };
  observed = () => ({ lease: this.obs, lastNonceByHolder: this.obs ? { [this.obs.holder]: this.obs.nonce } : {} });
  isReachable = () => true;
  async pullAllPeers(): Promise<void> {
    this.round++;
    this.roundStart = this.now();
    for (const p of this.peers) {
      const a = this.answers[p] ?? 'silent';
      const r = this.probes.get(p) ?? { probes: [], unsignedSinceMs: null, firstSignedAtMs: null };
      r.probes.push(a === 'silent' && this.causes[p] ? { atMs: this.now(), answer: a, cause: this.causes[p] } : { atMs: this.now(), answer: a });
      if (a === 'signed') { r.unsignedSinceMs = null; if (r.firstSignedAtMs == null) r.firstSignedAtMs = this.now(); }
      else if (a === 'unsigned' && r.unsignedSinceMs === null) r.unsignedSinceMs = this.now();
      this.probes.set(p, r);
      const l = this.leases[p] ?? null;
      if (a === 'signed') {
        this.verified.set(p, { lease: l, atMs: this.now(), round: this.round });
        if (l && (!this.obs || l.epoch >= this.obs.epoch)) this.obs = l;
      }
      for (const fn of this.listeners) fn(p, a, this.round);
    }
  }
  probeHistory = () => new Map(this.probes);
  knownPeerIds = () => [...this.peers];
  verifiedAnswers = () => new Map(this.verified);
  currentPullRound = () => ({ round: this.round, startedAtMs: this.roundStart });
  attachProbeListener = (fn: (p: string, a: ProbeAnswer, r: number) => void) => { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter((l) => l !== fn); }; };
}

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'LeaseCoordinator-plannedRestartContinuity-test-cleanup' }); });

interface RigOpts {
  self?: string;
  peers?: string[];
  dir?: string;
  clock?: { wall: number; mono: number };
  continuityOn?: boolean;
  admissionMinimumRemainingMs?: number;
  safetyOn?: boolean;
  requestFile?: { present: boolean; requestedBy?: string; reason?: string; requestedAt?: string };
  bootRoleAwake?: boolean | null;
  shutdownDeadlineMs?: number;
  livenessEnabled?: boolean;
  presumedDead?: () => Set<string>;
}

function rig(o: RigOpts = {}) {
  const self = o.self ?? 'studio';
  const dir = o.dir ?? (() => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'prkl-')); dirs.push(d); return d; })();
  const clock = o.clock ?? { wall: 1_700_000_000_000, mono: 1_000 };
  const store = new LocalLeaseStore({ filePath: path.join(dir, 'state', 'lease-local.json') });
  const tunnel = new ScriptedTransport(o.peers ?? ['laptop'], () => clock.wall);
  const f = fl(self);
  const continuity = new LeaseContinuityStore({
    stateDir: dir, selfMachineId: self,
    sign: (c) => f.signContinuityMeta(c), verify: (c, sig, h) => f.verifyContinuityMeta(c, sig, h), verifyLease: (l) => f.verifyLease(l),
    unsignedCeilingMs: UNSIGNED_WINDOW_CEILING_MS, now: () => clock.wall,
  });
  const logs: string[] = [];
  const episodeChanges: boolean[] = [];
  const request = { current: o.requestFile ?? { present: false } };
  const lc = new LeaseCoordinator({
    lease: f,
    store,
    tunnel,
    presumedDeadHolders: () => (o.presumedDead ? o.presumedDead() : new Set()),
    getLivenessEnabled: () => o.livenessEnabled ?? true,
    now: () => clock.wall,
    monotonicNow: () => clock.mono,
    survivorMayHold: () => true,
    soloCaptainHold: () => ({ enabled: false }),
    staleHolderTakeover: () => ({ enabled: true, nonRenewalMissedObservations: 6 }),
    bootClaimSafety: () => (o.safetyOn === false ? null : { enabled: true, preferredMachineId: 'studio' }),
    plannedRestartContinuity: () => ({ enabled: o.continuityOn !== false, windowMs: null }),
    continuity,
    plannedRestartAdmissionEnabled: () => o.admissionMinimumRemainingMs !== undefined,
    plannedRestartMinimumRemainingMs: () => o.admissionMinimumRemainingMs ?? null,
    renewIntervalMs: () => 30_000,
    broadcastDeadlineMs: () => 8_000,
    shutdownDeadlineMs: () => o.shutdownDeadlineMs ?? 20_000,
    readRequestFile: () => request.current,
    findConsumption: (lookup) => findRestartRequestRecord(dir, lookup),
    bootRoleAwake: () => o.bootRoleAwake ?? true,
    onEpisodeChange: (p) => episodeChanges.push(p),
    logger: (m) => logs.push(m),
  });
  const advance = (ms: number) => { clock.wall += ms; clock.mono += ms; };
  return { lc, tunnel, store, continuity, logs, episodeChanges, request, advance, clock, dir, self };
}

/** Phase A of the night: Studio holds epoch 41 with the Laptop alive beside it. */
async function holderAtEpoch41(o: RigOpts = {}) {
  const r = rig({ ...o, safetyOn: false });
  r.tunnel.answers.laptop = 'signed';
  expect(await r.lc.acquireIfEligible()).toBe(true);
  expect(r.lc.holdsLease()).toBe(true);
  expect(r.lc.currentEpoch()).toBe(1);
  return r;
}

const expiryOf = (l: LeaseRecord | null) => (l ? Date.parse(l.expiresAt) : NaN);

describe('the night of 2026-11-21 — a role-change restart whose boot outlasts the TTL', () => {
  it('WITHOUT the fix the restarted holder comes up with a lapsed lease, asks, and the lead is gone', async () => {
    const r = await holderAtEpoch41({ continuityOn: false });
    const epoch = r.lc.currentEpoch();
    // The role-change writer announces; nothing is extended with the switch off.
    expect(r.lc.beginPendingRestart({ requestedBy: 'role-change', reason: 'this machine took the lease', requestedAt: new Date(r.clock.wall).toISOString() })).toBeNull();
    expect(expiryOf(r.lc.currentLease())).toBe(r.clock.wall + TTL);
    expect(fs.existsSync(r.continuity.filePath)).toBe(false);
    // Supervisor kill, 90 s boot (the Studio's boots that night ran 1.5–14 minutes).
    r.advance(90_000);
    // Meanwhile the Laptop, seeing the lapsed lease, took the next epoch.
    const boot = rig({ dir: r.dir, clock: r.clock, continuityOn: false });
    boot.tunnel.answers.laptop = 'signed';
    boot.tunnel.leases.laptop = fl('laptop').signLease(epoch + 1, new Date(r.clock.wall - 5_000).toISOString(), new Date(r.clock.wall + TTL).toISOString(), 9);
    expect(boot.lc.bootReclaimPending()).toBe(false);
    await boot.lc.pullFromPeers();
    expect(await boot.lc.acquireIfEligible()).toBe(false);
    expect(boot.lc.holdsLease()).toBe(false);
    expect(boot.lc.currentHolder()).toBe('laptop');
    expect(boot.lc.currentEpoch()).toBe(epoch + 1);
  });

  it('WITH the fix the pending renewal outlives the boot and the same epoch is confirmed back: the lead is kept', async () => {
    const r = await holderAtEpoch41();
    const epoch = r.lc.currentEpoch();
    const requestedAt = new Date(r.clock.wall).toISOString();
    // §1 step 2 — the role-change writer announces before publishing; the holder signs the window renewal.
    const p = r.lc.beginPendingRestart({ requestedBy: 'role-change', reason: 'this machine took the lease', requestedAt });
    expect(p).not.toBeNull();
    await expect(p).resolves.toBe('confirmed');
    expect(r.lc.holdsLease()).toBe(true);
    expect(r.lc.currentEpoch()).toBe(epoch);
    expect(expiryOf(r.lc.currentLease())).toBe(r.clock.wall + WINDOW);
    expect(r.tunnel.broadcasts.at(-1)?.expiresAt).toBe(new Date(r.clock.wall + WINDOW).toISOString());
    expect(r.episodeChanges).toEqual([true]);
    expect(r.lc.pendingRestartStatus()).toMatchObject({ requestedBy: 'role-change', windowMs: WINDOW });
    // Persisted beside the lease: the continuity file and the store's pending marker.
    const file = r.continuity.read();
    expect(file.verdict).toBe('ok');
    expect(file.file?.meta).toMatchObject({ requestedBy: 'role-change', confirmed: true, windowMs: WINDOW, exitedAt: null });
    expect(r.store.readPendingEpisodeId()).toBe(file.file?.episodeId);
    expect(expiryOf(r.store.read().lease)).toBe(r.clock.wall + WINDOW);
    expect(r.logs.some((l) => l.includes('lease-continuity: a restart is pending (role-change'))).toBe(true);
    // The file becomes visible; the supervisor records its row and kills the process; shutdown stamps the exit.
    r.request.current = { present: true, requestedBy: 'role-change', reason: 'this machine took the lease', requestedAt };
    r.lc.pollRequestFile();
    r.advance(3_000);
    recordRestartRequest(r.dir, { requestedAt, requestedBy: 'role-change', plannedRestart: true }, 'supervisor', new Date(r.clock.wall));
    expect(r.lc.stampContinuityExit()).toBe(true);
    const exitAt = r.clock.wall;
    // A 90 s boot: longer than the TTL, inside the window.
    r.advance(90_000);
    const boot = rig({ dir: r.dir, clock: r.clock });
    // §2 — rule 1b: the window lease is on disk; nothing is held until a peer confirms.
    expect(boot.lc.bootReclaimPending()).toBe(true);
    expect(boot.lc.holdsLease()).toBe(false);
    expect(boot.lc.msSinceConfirmedRenewal()).toBeNull();
    // Before any round nothing can be judged.
    expect(await boot.lc.acquireIfEligible()).toBe(false);
    expect(boot.lc.bootReclaimPending()).toBe(true);
    // The Laptop answers (honest "no lease of its own"): a qualifying answer from a live peer.
    boot.tunnel.answers.laptop = 'signed';
    boot.tunnel.leases.laptop = null;
    const verdict = boot.lc.awaitReclaimVerdict(5_000);
    await boot.lc.pullFromPeers();
    expect(await boot.lc.acquireIfEligible()).toBe(true);
    await expect(verdict).resolves.toBe('confirmed');
    expect(boot.lc.holdsLease()).toBe(true);
    expect(boot.lc.currentEpoch()).toBe(epoch); // the SAME epoch: no claim, no handover
    expect(boot.lc.currentHolder()).toBe('studio');
    expect(boot.lc.bootReclaimPending()).toBe(false);
    // The confirmed boot renewal is a TTL renewal without the marker; the continuity file is gone.
    expect(expiryOf(boot.lc.currentLease())).toBe(r.clock.wall + TTL);
    expect(boot.store.readPendingEpisodeId()).toBeNull();
    expect(fs.existsSync(boot.continuity.filePath)).toBe(false);
    // The boot was measured from the exit stamp (the later of exit and consumption).
    expect(boot.continuity.bootSamplesMs()).toEqual([r.clock.wall - exitAt]);
    expect(boot.logs.some((l) => l.includes('renewed its own epoch') && l.includes('keeps the lead'))).toBe(true);
    // A renewal in the new process is an ordinary one again.
    boot.advance(30_000);
    expect(await boot.lc.renew()).toBe(true);
    expect(expiryOf(boot.lc.currentLease())).toBe(r.clock.wall + TTL);
  });

  it('a second boot uses the measured budget: a slower measured boot widens the window', async () => {
    const r = await holderAtEpoch41();
    r.continuity.appendBootSample(200_000, 'planned', 'peer-confirmed');
    await r.lc.beginPendingRestart({ requestedBy: 'auto-updater', reason: 'update', requestedAt: new Date(r.clock.wall).toISOString() });
    expect(expiryOf(r.lc.currentLease())).toBe(r.clock.wall + 200_000 + 53_000);
    expect(r.lc.pendingRestartStatus()?.windowMs).toBe(253_000);
  });

  it('keeps admission closed and reports both values when measured boot exceeds the ceiling', async () => {
    const minimumRemainingMs = 400_000;
    const r = await holderAtEpoch41({ admissionMinimumRemainingMs: minimumRemainingMs });
    const request = { requestedBy: 'api', reason: 'restart', requestedAt: new Date(r.clock.wall).toISOString() };
    await r.lc.beginPendingRestart(request);

    const ceilingMs = TTL * 6 - 8_000;
    expect(r.lc.pendingRestartStatus()?.windowMs).toBe(ceilingMs);
    expect(r.lc.confirmedPlannedRestartWindow({ ...request, minimumRemainingMs })).toBeNull();
    expect(r.logs).toContainEqual(expect.stringContaining(`window target is 420000 ms but the stale-holder ceiling is ${ceilingMs} ms`));
  });

  it('an explicit windowMs replaces the base; the stale-holder cap still binds', async () => {
    const r = rig();
    (r.lc as unknown as { d: { plannedRestartContinuity: () => unknown } }).d.plannedRestartContinuity = () => ({ enabled: true, windowMs: 900_000 });
    r.tunnel.answers.laptop = 'signed';
    await r.lc.acquireIfEligible();
    await r.lc.beginPendingRestart({ requestedBy: 'api', reason: 'restart', requestedAt: new Date(r.clock.wall).toISOString() });
    expect(expiryOf(r.lc.currentLease())).toBe(r.clock.wall + TTL * 6 - 8_000);
    expect(r.logs.some((l) => l.includes('clamped to its ceiling'))).toBe(true);
  });
});

describe('the announce is inert when there is nothing to extend', () => {
  it('not the holder: null, no file, no marker', async () => {
    const r = rig();
    expect(r.lc.beginPendingRestart({ requestedBy: 'role-change', reason: 'x' })).toBeNull();
    expect(fs.existsSync(r.continuity.filePath)).toBe(false);
    expect(r.store.readPendingEpisodeId()).toBeNull();
  });
  it('a holder with no known peer: null (a window no peer will fold means nothing)', async () => {
    const r = rig({ peers: [], safetyOn: false });
    expect(await r.lc.acquireIfEligible()).toBe(true);
    expect(r.lc.beginPendingRestart({ requestedBy: 'role-change', reason: 'x' })).toBeNull();
    expect(fs.existsSync(r.continuity.filePath)).toBe(false);
  });
  it('switch off: null, today\'s renewal exactly', async () => {
    const r = await holderAtEpoch41({ continuityOn: false });
    expect(r.lc.beginPendingRestart({ requestedBy: 'role-change', reason: 'x' })).toBeNull();
    r.advance(30_000);
    await r.lc.renew();
    expect(expiryOf(r.lc.currentLease())).toBe(r.clock.wall + TTL);
    expect(r.lc.pendingRestartStatus()).toBeNull();
  });
  it('an unconfirmed broadcast resolves unconfirmed; the renewal is still persisted for the boot', async () => {
    const r = await holderAtEpoch41();
    r.tunnel.broadcastOk = false;
    await expect(r.lc.beginPendingRestart({ requestedBy: 'role-change', reason: 'x', requestedAt: new Date(r.clock.wall).toISOString() })).resolves.toBe('unconfirmed');
    expect(r.continuity.read().file?.meta.confirmed).toBe(false);
    expect(expiryOf(r.store.read().lease)).toBe(r.clock.wall + WINDOW);
  });
});

describe('every renewal in an open episode carries the window; the episode ends only by its rules', () => {
  it('the renew tick and the peer-pull refresh carry the window while the file is present', async () => {
    const r = await holderAtEpoch41();
    const requestedAt = new Date(r.clock.wall).toISOString();
    await r.lc.beginPendingRestart({ requestedBy: 'role-change', reason: 'x', requestedAt });
    r.request.current = { present: true, requestedBy: 'role-change', reason: 'x', requestedAt };
    r.advance(10_000);
    r.lc.pollRequestFile();
    expect(await r.lc.renew()).toBe(true);
    expect(expiryOf(r.lc.currentLease())).toBe(r.clock.wall + WINDOW);
    expect(r.continuity.read().file?.meta.renewedAt).toBe(new Date(r.clock.wall).toISOString());
    expect(r.lc.pendingRenewIntervalMs()).toBe(10_000);
  });
  it('a consumer\'s deletion with a ledger row keeps it open; absent 60 s with no row ends it (TTL renewals resume)', async () => {
    const r = await holderAtEpoch41({ shutdownDeadlineMs: 90_000 }); // the consumed-but-alive bound is then 118 s
    const requestedAt = new Date(r.clock.wall).toISOString();
    await r.lc.beginPendingRestart({ requestedBy: 'role-change', reason: 'x', requestedAt });
    r.request.current = { present: true, requestedBy: 'role-change', reason: 'x', requestedAt };
    r.lc.pollRequestFile();
    // Consumer deletes the file and writes its row (kill follows): the episode stays open past 60 s.
    recordRestartRequest(r.dir, { requestedAt, requestedBy: 'role-change', plannedRestart: true }, 'supervisor', new Date(r.clock.wall));
    r.request.current = { present: false };
    r.advance(61_000);
    r.lc.pollRequestFile();
    expect(r.lc.pendingRestartStatus()).not.toBeNull();
    // Same shape without a row: the request was withdrawn by another process → ended.
    const r2 = await holderAtEpoch41();
    const at2 = new Date(r2.clock.wall).toISOString();
    await r2.lc.beginPendingRestart({ requestedBy: 'role-change', reason: 'x', requestedAt: at2 });
    r2.request.current = { present: true, requestedBy: 'role-change', reason: 'x', requestedAt: at2 };
    r2.lc.pollRequestFile();
    r2.request.current = { present: false };
    r2.advance(59_000);
    r2.lc.pollRequestFile();
    expect(r2.lc.pendingRestartStatus()).not.toBeNull();
    r2.advance(1_000);
    r2.lc.pollRequestFile();
    expect(r2.lc.pendingRestartStatus()).toBeNull();
    expect(fs.existsSync(r2.continuity.filePath)).toBe(false);
    expect(r2.store.readPendingEpisodeId()).toBeNull();
    expect(r2.episodeChanges).toEqual([true, false]);
    expect(await r2.lc.renew()).toBe(true);
    expect(expiryOf(r2.lc.currentLease())).toBe(r2.clock.wall + TTL);
  });
  it('in-process withdrawal ends it at once; a consumed request with the process still alive ends it after the bound', async () => {
    const r = await holderAtEpoch41();
    await r.lc.beginPendingRestart({ requestedBy: 'role-change', reason: 'x', requestedAt: new Date(r.clock.wall).toISOString() });
    r.lc.noteRestartWithdrawn();
    expect(r.lc.pendingRestartStatus()).toBeNull();
    expect(fs.existsSync(r.continuity.filePath)).toBe(false);
    const r2 = await holderAtEpoch41({ shutdownDeadlineMs: 90_000 });
    const at2 = new Date(r2.clock.wall).toISOString();
    await r2.lc.beginPendingRestart({ requestedBy: 'role-change', reason: 'x', requestedAt: at2 });
    r2.request.current = { present: true, requestedBy: 'role-change', reason: 'x', requestedAt: at2 };
    r2.lc.pollRequestFile();
    recordRestartRequest(r2.dir, { requestedAt: at2, requestedBy: 'role-change', plannedRestart: true }, 'supervisor', new Date(r2.clock.wall));
    r2.request.current = { present: false };
    r2.advance(61_000);
    r2.lc.pollRequestFile();
    expect(r2.lc.pendingRestartStatus()).not.toBeNull();
    r2.advance(60_000); // 121 s after the row: max(60 s, 90 s + 3 s + 25 s) = 118 s passed with the process alive
    r2.lc.pollRequestFile();
    expect(r2.lc.pendingRestartStatus()).toBeNull();
    expect(r2.logs.some((l) => l.includes('still running'))).toBe(true);
  });
  it('with the default 20 s shutdown deadline a consumed request leaves the process 60 s to die; alive after that, the episode ends with error evidence', async () => {
    const r = await holderAtEpoch41();
    const at = new Date(r.clock.wall).toISOString();
    await r.lc.beginPendingRestart({ requestedBy: 'role-change', reason: 'x', requestedAt: at });
    r.request.current = { present: true, requestedBy: 'role-change', reason: 'x', requestedAt: at };
    r.lc.pollRequestFile();
    recordRestartRequest(r.dir, { requestedAt: at, requestedBy: 'role-change', plannedRestart: true }, 'supervisor', new Date(r.clock.wall));
    r.request.current = { present: false };
    r.advance(30_000);
    r.lc.pollRequestFile();
    expect(r.lc.pendingRestartStatus()).not.toBeNull();
    r.advance(31_000);
    r.lc.pollRequestFile();
    expect(r.lc.pendingRestartStatus()).toBeNull();
    expect(r.logs.some((l) => l.includes('still running'))).toBe(true);
  });
  it('an out-of-process request file (the fix-command, the self-heal) opens an episode through the poll', async () => {
    const r = await holderAtEpoch41();
    r.request.current = { present: true, requestedBy: 'fix-command', reason: 'operator', requestedAt: new Date(r.clock.wall).toISOString() };
    expect(r.lc.pollRequestFile()).toBe(true);
    expect(r.lc.pendingRestartStatus()?.requestedBy).toBe('fix-command');
    expect(await r.lc.renew()).toBe(true);
    expect(expiryOf(r.lc.currentLease())).toBe(r.clock.wall + WINDOW);
    expect(r.continuity.read().verdict).toBe('ok');
  });
  it('the four-hour cap ends the episode and the same request opens nothing until the file changes', async () => {
    const r = await holderAtEpoch41();
    const at = new Date(r.clock.wall).toISOString();
    r.request.current = { present: true, requestedBy: 'self-heal', reason: 'x', requestedAt: at };
    r.lc.pollRequestFile();
    for (let t = 0; t < 4 * 60 * 60_000; t += 30_000) { r.advance(30_000); expect(await r.lc.renew()).toBe(true); }
    expect(r.lc.pendingRestartStatus()).not.toBeNull();
    r.advance(1_000);
    r.lc.pollRequestFile();
    expect(r.lc.pendingRestartStatus()).toBeNull();
    expect(r.lc.holdsLease()).toBe(true);
    r.lc.pollRequestFile();
    expect(r.lc.pendingRestartStatus()).toBeNull();
    r.request.current = { present: true, requestedBy: 'self-heal', reason: 'x', requestedAt: new Date(r.clock.wall).toISOString() };
    r.lc.pollRequestFile();
    expect(r.lc.pendingRestartStatus()).not.toBeNull();
  });
});

describe('rule 1b at boot — the window lease on disk', () => {
  async function restartedHolder(o: { laptopEpoch?: number | null; laptopAnswer?: ProbeAnswer; continuityOn?: boolean; safetyOn?: boolean; bootMs?: number } = {}) {
    const r = await holderAtEpoch41();
    const epoch = r.lc.currentEpoch();
    const requestedAt = new Date(r.clock.wall).toISOString();
    await r.lc.beginPendingRestart({ requestedBy: 'role-change', reason: 'x', requestedAt });
    r.lc.stampContinuityExit();
    r.advance(o.bootMs ?? 90_000);
    const boot = rig({ dir: r.dir, clock: r.clock, continuityOn: o.continuityOn, safetyOn: o.safetyOn });
    boot.tunnel.answers.laptop = o.laptopAnswer ?? 'signed';
    boot.tunnel.leases.laptop = o.laptopEpoch ? fl('laptop').signLease(o.laptopEpoch, new Date(r.clock.wall - 5_000).toISOString(), new Date(r.clock.wall + TTL).toISOString(), 9) : null;
    return { r, boot, epoch };
  }

  it('is keyed on the disk state: the switch off at boot still withholds the hold until a peer confirms', async () => {
    const { boot, epoch } = await restartedHolder({ continuityOn: false });
    expect(boot.lc.bootReclaimPending()).toBe(true);
    expect(boot.lc.holdsLease()).toBe(false);
    await boot.lc.pullFromPeers();
    expect(await boot.lc.acquireIfEligible()).toBe(true);
    expect(boot.lc.holdsLease()).toBe(true);
    expect(boot.lc.currentEpoch()).toBe(epoch);
  });
  it('and whatever boot claim safety says', async () => {
    const { boot } = await restartedHolder({ safetyOn: false });
    expect(boot.lc.bootReclaimPending()).toBe(true);
    expect(boot.lc.holdsLease()).toBe(false);
  });
  it('superseded: a peer answers with a newer epoch → adopt, measure, discard', async () => {
    const { boot } = await restartedHolder({ laptopEpoch: 99 });
    const verdict = boot.lc.awaitReclaimVerdict(5_000);
    await boot.lc.pullFromPeers();
    expect(await boot.lc.acquireIfEligible()).toBe(false);
    await expect(verdict).resolves.toBe('superseded');
    expect(boot.lc.holdsLease()).toBe(false);
    expect(boot.lc.currentHolder()).toBe('laptop');
    expect(boot.lc.currentEpoch()).toBe(99);
    expect(fs.existsSync(boot.continuity.filePath)).toBe(false);
    expect(boot.store.readPendingEpisodeId()).toBeNull();
    expect(boot.continuity.bootSamplesMs()).toHaveLength(1);
    expect(boot.logs.some((l) => l.includes('was superseded by epoch 99'))).toBe(true);
  });
  it('a live peer that has not answered yet: wait (no hold, no claim)', async () => {
    const { boot } = await restartedHolder({ laptopAnswer: 'silent' });
    await boot.lc.pullFromPeers();
    expect(await boot.lc.acquireIfEligible()).toBe(false);
    expect(boot.lc.bootReclaimPending()).toBe(true);
    expect(boot.lc.holdsLease()).toBe(false);
    await expect(boot.lc.awaitReclaimVerdict(0)).resolves.toBe('timeout');
  });
  it('every known peer silent for the boot hold\'s span → survivor hold: keep the epoch, prime the fence', async () => {
    const { boot, epoch } = await restartedHolder({ laptopAnswer: 'silent' });
    for (let i = 0; i < 3; i++) { await boot.lc.pullFromPeers(); boot.advance(25_000); }
    boot.tunnel.broadcastOk = true; // no signed peer: the scripted broadcast reads false, as a dark pool would
    expect(await boot.lc.acquireIfEligible()).toBe(true);
    expect(boot.lc.holdsLease()).toBe(true);
    expect(boot.lc.currentEpoch()).toBe(epoch);
    expect(boot.lc.bootReclaimPending()).toBe(false);
    expect(boot.logs.some((l) => l.includes('as a survivor hold'))).toBe(true);
  });
  it('the window lease already expired at boot: no reclaim, today\'s lapsed path (rule 1 asks first)', async () => {
    const { boot } = await restartedHolder({ bootMs: WINDOW + 1_000 });
    expect(boot.lc.bootReclaimPending()).toBe(false);
    expect(boot.lc.holdsLease()).toBe(false);
  });
  it('a continuity file whose lease does not match the store is measured, discarded and never folded', async () => {
    const { r } = await restartedHolder();
    // Another process relinquished the store record (force-expired under the signature).
    r.store.forceLocalExpiry();
    const boot = rig({ dir: r.dir, clock: r.clock });
    expect(boot.lc.bootReclaimPending()).toBe(false);
    expect(fs.existsSync(boot.continuity.filePath)).toBe(false);
    expect(boot.logs.some((l) => l.includes('not usable here'))).toBe(true);
  });
  it('a tampered continuity file is discarded', async () => {
    const { r } = await restartedHolder();
    const raw = JSON.parse(fs.readFileSync(r.continuity.filePath, 'utf8'));
    raw.meta.windowMs = 9_999_999;
    fs.writeFileSync(r.continuity.filePath, JSON.stringify(raw));
    const boot = rig({ dir: r.dir, clock: r.clock });
    // The store record still carries the marker, so rule 1b applies to IT; the file itself is gone.
    expect(fs.existsSync(boot.continuity.filePath)).toBe(false);
    expect(boot.lc.bootReclaimPending()).toBe(true);
  });
  it('the boot renewal while an episode is still open (file re-seen) carries the window and keeps the marker', async () => {
    const { r, boot, epoch } = await restartedHolder();
    const requestedAt = new Date(r.clock.wall).toISOString();
    boot.request.current = { present: true, requestedBy: 'auto-updater', reason: 'second request', requestedAt };
    boot.lc.pollRequestFile(); // not holder yet: the episode still opens (the file is there)
    await boot.lc.pullFromPeers();
    expect(await boot.lc.acquireIfEligible()).toBe(true);
    expect(boot.lc.currentEpoch()).toBe(epoch);
    expect(expiryOf(boot.lc.currentLease())).toBe(boot.clock.wall + WINDOW);
    expect(boot.store.readPendingEpisodeId()).not.toBeNull();
    expect(boot.continuity.read().verdict).toBe('ok');
  });
  it('relinquish deletes the continuity record and clears the marker', async () => {
    const r = await holderAtEpoch41();
    await r.lc.beginPendingRestart({ requestedBy: 'role-change', reason: 'x', requestedAt: new Date(r.clock.wall).toISOString() });
    expect(fs.existsSync(r.continuity.filePath)).toBe(true);
    r.lc.relinquish('test');
    expect(fs.existsSync(r.continuity.filePath)).toBe(false);
    expect(r.store.readPendingEpisodeId()).toBeNull();
  });
  it('a late promotion is remembered in the record', async () => {
    const r = rig({ bootRoleAwake: false, safetyOn: false });
    r.tunnel.answers.laptop = 'signed';
    await r.lc.acquireIfEligible();
    await r.lc.beginPendingRestart({ requestedBy: 'role-change', reason: 'this machine took the lease', requestedAt: new Date(r.clock.wall).toISOString() });
    expect(r.continuity.read().file?.meta.afterLatePromotion).toBe(true);
    r.advance(30_000);
    const boot = rig({ dir: r.dir, clock: r.clock });
    expect(boot.lc.reclaimAfterLatePromotion()).toBe(true);
    expect(boot.lc.reclaimRemainingWindowMs()).toBe(WINDOW - 30_000);
  });
});

describe('second-pass fixes — the store never keeps an unmarked long-expiry record; verdicts are honest', () => {
  it('an episode\'s end writes a TTL renewal to the store at once, without the marker, and broadcasts it', async () => {
    const r = await holderAtEpoch41();
    await r.lc.beginPendingRestart({ requestedBy: 'role-change', reason: 'x', requestedAt: new Date(r.clock.wall).toISOString() });
    expect(expiryOf(r.store.read().lease)).toBe(r.clock.wall + WINDOW);
    const before = r.tunnel.broadcasts.length;
    r.lc.noteRestartWithdrawn();
    await Promise.resolve();
    expect(r.store.readPendingEpisodeId()).toBeNull();
    expect(expiryOf(r.store.read().lease)).toBe(r.clock.wall + TTL);
    expect(r.tunnel.broadcasts.length).toBe(before + 1);
    expect(expiryOf(r.tunnel.broadcasts.at(-1)!)).toBe(r.clock.wall + TTL);
    expect(expiryOf(r.lc.currentLease())).toBe(r.clock.wall + TTL);
  });
  it('a superseded window lease leaves the store force-expired (epoch floor kept, no marker), never a live-looking record', async () => {
    const r = await holderAtEpoch41();
    const epoch = r.lc.currentEpoch();
    await r.lc.beginPendingRestart({ requestedBy: 'role-change', reason: 'x', requestedAt: new Date(r.clock.wall).toISOString() });
    r.advance(90_000);
    const boot = rig({ dir: r.dir, clock: r.clock });
    boot.tunnel.answers.laptop = 'signed';
    boot.tunnel.leases.laptop = fl('laptop').signLease(epoch + 1, new Date(r.clock.wall - 5_000).toISOString(), new Date(r.clock.wall + TTL).toISOString(), 9);
    await boot.lc.pullFromPeers();
    expect(await boot.lc.acquireIfEligible()).toBe(false);
    const stored = boot.store.read().lease!;
    expect(stored.epoch).toBe(epoch);
    expect(stored.holder).toBe('studio');
    expect(Date.parse(stored.expiresAt)).toBe(0);
    expect(boot.store.readPendingEpisodeId()).toBeNull();
    // A crash right now boots on today's path with an expired record: no window lease, no hold from the file.
    const again = rig({ dir: r.dir, clock: r.clock });
    expect(again.lc.bootReclaimPending()).toBe(false);
    expect(again.lc.holdsLease()).toBe(false);
  });
  it('with the liveness derivation off, a stale registry never makes a survivor hold: only settled silence does', async () => {
    const r = await holderAtEpoch41();
    const epoch = r.lc.currentEpoch();
    await r.lc.beginPendingRestart({ requestedBy: 'role-change', reason: 'x', requestedAt: new Date(r.clock.wall).toISOString() });
    r.advance(60_000);
    const boot = rig({ dir: r.dir, clock: r.clock, livenessEnabled: false, presumedDead: () => new Set(['laptop']) });
    boot.tunnel.answers.laptop = 'silent';
    await boot.lc.pullFromPeers();
    expect(await boot.lc.acquireIfEligible()).toBe(false); // one silent probe: not settled, not dead for rule 1b
    expect(boot.lc.holdsLease()).toBe(false);
    for (let i = 0; i < 2; i++) { boot.advance(25_000); await boot.lc.pullFromPeers(); }
    expect(await boot.lc.acquireIfEligible()).toBe(true); // three silent probes over 50 s: settled silent
    expect(boot.lc.currentEpoch()).toBe(epoch);
  });
  it('a window that runs out before any answer is a lapsed verdict, not a takeover: today\'s path, honest evidence', async () => {
    const r = await holderAtEpoch41();
    const epoch = r.lc.currentEpoch();
    await r.lc.beginPendingRestart({ requestedBy: 'role-change', reason: 'x', requestedAt: new Date(r.clock.wall).toISOString() });
    r.advance(60_000);
    const boot = rig({ dir: r.dir, clock: r.clock, safetyOn: false });
    boot.tunnel.answers.laptop = 'silent';
    await boot.lc.pullFromPeers();
    expect(await boot.lc.acquireIfEligible()).toBe(false);
    const verdict = boot.lc.awaitReclaimVerdict(5_000);
    boot.advance(WINDOW); // the window is gone
    await boot.lc.pullFromPeers();
    await boot.lc.acquireIfEligible(); // today's lapsed path (boot claim safety off here: claims N+1)
    await expect(verdict).resolves.toBe('lapsed');
    expect(boot.lc.bootReclaimPending()).toBe(false);
    expect(boot.lc.currentEpoch()).toBe(epoch + 1);
    expect(boot.logs.some((l) => l.includes('ran out') && l.includes("today's lapsed path"))).toBe(true);
    expect(boot.logs.some((l) => l.includes('was superseded by epoch'))).toBe(false);
    expect(boot.continuity.readBudget().at(-1)?.outcome).toBe('lapsed');
  });
  it('git-store shape: the store holds only the TTL acquisition, the continuity file carries the window — the fold makes the window the view', async () => {
    const r = await holderAtEpoch41();
    const epoch = r.lc.currentEpoch();
    const acquisition = r.store.read().lease!;
    await r.lc.beginPendingRestart({ requestedBy: 'role-change', reason: 'x', requestedAt: new Date(r.clock.wall).toISOString() });
    // A git store never takes the pending refresh: put the acquisition back (with the marker a git store would not even have).
    fs.writeFileSync(path.join(r.dir, 'state', 'lease-local.json'), JSON.stringify({ lease: acquisition }));
    r.advance(90_000); // the acquisition is expired; the window is not
    const boot = rig({ dir: r.dir, clock: r.clock });
    expect(boot.lc.bootReclaimPending()).toBe(true);
    expect(boot.lc.currentLease()?.nonce).toBe(acquisition.nonce + 1); // the file's renewal is the view
    expect(expiryOf(boot.lc.currentLease())).toBeGreaterThan(r.clock.wall);
    boot.tunnel.answers.laptop = 'signed';
    await boot.lc.pullFromPeers();
    expect(await boot.lc.acquireIfEligible()).toBe(true);
    expect(boot.lc.currentEpoch()).toBe(epoch);
    expect(boot.lc.holdsLease()).toBe(true);
    expect(boot.lc.currentLease()!.nonce).toBeGreaterThan(acquisition.nonce + 1); // the nonce floor was seeded above the file's
  });
  it('an expired marked record at boot clears its marker so the next boot is an ordinary one', async () => {
    const r = await holderAtEpoch41();
    await r.lc.beginPendingRestart({ requestedBy: 'role-change', reason: 'x', requestedAt: new Date(r.clock.wall).toISOString() });
    r.advance(WINDOW + 1_000);
    const boot = rig({ dir: r.dir, clock: r.clock });
    expect(boot.lc.bootReclaimPending()).toBe(false);
    expect(boot.store.readPendingEpisodeId()).toBeNull();
  });
  it('the announce itself logs and records nothing on a machine that extends nothing', async () => {
    const r = rig();
    expect(r.lc.beginPendingRestart({ requestedBy: 'role-change', reason: 'x' })).toBeNull();
    expect(r.logs.some((l) => l.includes('is being renewed with'))).toBe(false);
  });
});

describe('a peer that is alive but refused from this machine only (macOS Local Network permission, no route)', () => {
  async function refusedBoot(cause: ProbeSilenceCause = 'local-refusal') {
    const r = await holderAtEpoch41();
    const epoch = r.lc.currentEpoch();
    await r.lc.beginPendingRestart({ requestedBy: 'role-change', reason: 'x', requestedAt: new Date(r.clock.wall).toISOString() });
    r.advance(60_000);
    const boot = rig({ dir: r.dir, clock: r.clock });
    boot.tunnel.answers.laptop = 'silent';
    boot.tunnel.causes.laptop = cause;
    return { r, boot, epoch };
  }
  it('three refused probes over the silence span are NOT death: no survivor hold, the reclaim stays pending (unknown)', async () => {
    const { boot, epoch } = await refusedBoot();
    for (let i = 0; i < 3; i++) { await boot.lc.pullFromPeers(); boot.advance(25_000); }
    expect(await boot.lc.acquireIfEligible()).toBe(false);
    expect(boot.lc.holdsLease()).toBe(false);
    expect(boot.lc.bootReclaimPending()).toBe(true);
    expect(boot.lc.currentEpoch()).toBe(epoch);
    expect(boot.logs.some((l) => l.includes('as a survivor hold'))).toBe(false);
    expect(boot.logs.some((l) => l.includes('cannot be dialed from this machine') && l.includes('alive and unknown'))).toBe(true);
    // Even a registry that presumes the peer dead does not turn our own blindness into a hold.
    const { boot: boot2 } = await refusedBoot();
    const stale = rig({ dir: boot2.dir, clock: boot2.clock, presumedDead: () => new Set(['laptop']) });
    stale.tunnel.answers.laptop = 'silent';
    stale.tunnel.causes.laptop = 'local-refusal';
    for (let i = 0; i < 3; i++) { await stale.lc.pullFromPeers(); stale.advance(25_000); }
    expect(await stale.lc.acquireIfEligible()).toBe(false);
    expect(stale.lc.holdsLease()).toBe(false);
  });
  it('the moment any route answers, the same epoch is confirmed as usual', async () => {
    const { boot, epoch } = await refusedBoot();
    for (let i = 0; i < 3; i++) { await boot.lc.pullFromPeers(); boot.advance(25_000); }
    expect(await boot.lc.acquireIfEligible()).toBe(false);
    boot.tunnel.answers.laptop = 'signed'; // the Tailscale rope came up, or the permission was granted
    boot.tunnel.causes.laptop = undefined;
    await boot.lc.pullFromPeers();
    expect(await boot.lc.acquireIfEligible()).toBe(true);
    expect(boot.lc.holdsLease()).toBe(true);
    expect(boot.lc.currentEpoch()).toBe(epoch);
  });
  it('if the refusal lasts past the window, the lease lapses and today\'s path applies (a lapsed verdict, never a takeover row)', async () => {
    const { boot } = await refusedBoot();
    for (let i = 0; i < 3; i++) { await boot.lc.pullFromPeers(); boot.advance(25_000); }
    expect(await boot.lc.acquireIfEligible()).toBe(false);
    const verdict = boot.lc.awaitReclaimVerdict(5_000);
    boot.advance(WINDOW);
    await boot.lc.pullFromPeers();
    await boot.lc.acquireIfEligible();
    await expect(verdict).resolves.toBe('lapsed');
    expect(boot.logs.some((l) => l.includes('was superseded by epoch'))).toBe(false);
  });
  it('a peer with no dialable route is unknown too; real silence (connection refused by the far side, timeouts) still counts', async () => {
    const { boot } = await refusedBoot('no-route');
    for (let i = 0; i < 3; i++) { await boot.lc.pullFromPeers(); boot.advance(25_000); }
    expect(await boot.lc.acquireIfEligible()).toBe(false);
    expect(boot.lc.bootReclaimPending()).toBe(true);
    const { boot: real, epoch } = await refusedBoot();
    real.tunnel.causes.laptop = undefined; // ECONNREFUSED / timeout: the far side, or its absence, answered
    for (let i = 0; i < 3; i++) { await real.lc.pullFromPeers(); real.advance(25_000); }
    expect(await real.lc.acquireIfEligible()).toBe(true);
    expect(real.lc.currentEpoch()).toBe(epoch);
    expect(real.logs.some((l) => l.includes('as a survivor hold'))).toBe(true);
  });
});
