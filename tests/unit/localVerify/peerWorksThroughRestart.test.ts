// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * docs/specs/local-verify-peer-works-through-restart.md: a helper machine keeps working while the
 * coordinator restarts. A (dispatch during a restart pause), B (restart episode), C (adopt a peer attempt
 * across this coordinator's own restart, on PR 3451's holding record), E (progress, not the clock alone,
 * ends a peer attempt), the setting as kill switch, and the guard on raw marker-epoch reads.
 * Real fs in temp state dirs; the child process, gh, the peer client, the lease and the clock are fakes.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { LocalVerifyService, pauseDispatchAllowed, runSlowdown, type LocalVerifyServiceSeams, type PrView } from '../../../src/localVerify/LocalVerifyService.js';
import { computePolicyHash, LOCAL_VERIFY_DEADLINES } from '../../../src/localVerify/policy.js';
import type { LocalVerifyRecord } from '../../../src/localVerify/record.js';
import { verifyPaths } from '../../../src/localVerify/orchestrator.js';
import {
  PEER_LIMITS, cleanMarkerExtras, importRefusal, judgePeerAttempt, laneOfKey, markerCurrent, markerEpochDecision, parsePeerProgress, stallWindowMs,
  type PeerClient, type PeerProgress, type PeerResult, type PeerRunRequest, type PeerStatus, type RemoteMarker,
} from '../../../src/localVerify/peer.js';
import { emptyPeerTrust, holdingDecision, keptHolding, resetHoldingState } from '../../../src/localVerify/peerTrust.js';
import { generateSigningKeyPair, sign as edSign } from '../../../src/core/MachineIdentity.js';
import { signerKeyHashOf, type MachineKeyLookup, type MachineSigner } from '../../../src/core/AppRecordSignatures.js';
import { requestDigest, signPeerResult } from '../../../src/localVerify/peerResultSignature.js';

const REPO = 'JKHeadley/instar';
const sha = (c: string) => c.repeat(40);
const ATT = 'a'.repeat(32);
const POLICY = computePolicyHash();
const T0 = Date.parse('2026-10-21T12:00:00.000Z');
const MIN = 60_000;
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'peerWorksThroughRestart.test.ts' }); });

function view(over: Partial<PrView> = {}): PrView {
  return { author: { login: 'EchoOfDawn' }, isCrossRepository: false, headRefName: 'echo/x', headRefOid: sha('a'), baseRefName: 'main', baseRefOid: sha('b'), ...over };
}

function record(over: Partial<LocalVerifyRecord> = {}): LocalVerifyRecord {
  return {
    repo: REPO, pr: 1, headSha: sha('a'), baseSha: sha('b'), baseRefName: 'main', mergeTree: sha('d'),
    lanes: [{ name: 'unit', gating: true, files: 1, tests: 3, passed: 3, failed: 0, skipped: 0, todo: 0, seconds: 1 }],
    nodeVersion: 'v24', machineId: 'peer1', startedAt: new Date(T0 + 60_000).toISOString(), finishedAt: new Date(T0 + 20 * MIN).toISOString(),
    outcome: 'success', harnessChanging: false, protectedPath: false, skipsAdded: false, testsRemoved: false,
    verifierVersion: '1.0.0', policyHash: POLICY, ...over,
  };
}

function marker(over: Partial<RemoteMarker> = {}): RemoteMarker {
  return {
    machineId: 'peer1', attemptId: ATT, leaseEpoch: 7, sentAt: T0, state: 'accepted',
    dispatched: { pr: 1, headSha: sha('a'), baseSha: sha('b'), baseRefName: 'main', verifierVersion: '1.0.0', policyHash: POLICY }, ...over,
  };
}

function runReq(over: Partial<PeerRunRequest> = {}): PeerRunRequest {
  return { attemptId: ATT, pr: 1, headSha: sha('a'), baseSha: sha('b'), baseRefName: 'main', verifierVersion: '1.0.0', policyHash: POLICY, coordinatorMachineId: 'coord', leaseEpoch: 7, ...over };
}

// ── harness (the same shape as peerVerifier.test.ts) ──────────────────

const PEER_KEYS = generateSigningKeyPair();
const PEER_KEY_HASH = signerKeyHashOf(PEER_KEYS.publicKey);
const peerSigner = (machineId = 'peer1'): MachineSigner => ({
  machineId: () => machineId, signerKeyHash: () => PEER_KEY_HASH,
  sign: (payload) => ({ machineId, signerKeyHash: PEER_KEY_HASH, sig: edSign(payload, PEER_KEYS.privateKey) }),
});
const pinnedPeerKeys = (): MachineKeyLookup => (_m, hash) => hash === PEER_KEY_HASH ? { status: 'ok', publicKeyPem: PEER_KEYS.publicKey } : { status: 'unknown' };

interface Clock { t: number }

function harness(opts: { peerOnly?: boolean; machineId?: string; stateDir?: string; agentHome?: string; verifierVersion?: string; clock?: Clock } = {}) {
  const fresh = !opts.stateDir;
  const stateDir = opts.stateDir ?? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvpwtr-')));
  if (fresh) {
    dirs.push(stateDir);
    fs.mkdirSync(path.join(stateDir, 'state', 'local-verify'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'state', 'local-verify', 'main-health.json'), JSON.stringify({
      v: 1, machineId: opts.machineId ?? 'coord', state: 'healthy', redHead: null, lastGreenHead: null, reason: 'green', updatedAt: '2026-10-21T00:00:00.000Z',
    }));
  }
  const agentHome = opts.agentHome ?? path.join(stateDir, 'home');
  const views: Record<number, PrView> = { 1: view(), 2: view({ headRefOid: sha('c') }), 3: view({ headRefOid: sha('e') }) };
  const spawned: Array<{ pid: number; resultPath: string; resolve: (x: { status: number | null; signal: string | null }) => void }> = [];
  const timers: Array<() => void> = [];
  const clock = opts.clock ?? { t: T0 };
  let pid = 7000;
  let foreignHolders: Array<{ pid: number }> = [];
  let installedVerifier: string | null = null;
  const seams: LocalVerifyServiceSeams = {
    prView: async (pr) => views[pr] ?? null,
    isPrOpen: async () => true,
    baseHead: async () => sha('b'),
    spawnRun: (a) => {
      const p = ++pid;
      let resolve!: (x: { status: number | null; signal: string | null }) => void;
      const exited = new Promise<{ status: number | null; signal: string | null }>((r) => { resolve = r; });
      spawned.push({ pid: p, resultPath: a.args[a.args.indexOf('--result') + 1], resolve });
      return { pid: p, exited };
    },
    isGroupAlive: () => false,
    killGroup: () => {},
    readProcessArgs: async () => null,
    foreignSuiteHolders: () => foreignHolders,
    setSuitePriority: () => {},
    signal: () => {},
    installedVerifierVersion: () => installedVerifier,
    now: () => clock.t,
    setTimer: (fn) => { timers.push(fn); },
  };
  const svc = new LocalVerifyService({
    repo: REPO, stateDir, agentHome, expectedGhLogin: 'EchoOfDawn', operatorGhLogin: 'JKHeadley',
    verifierVersion: opts.verifierVersion ?? '1.0.0', nodePath: '/usr/bin/node', mainEntry: '/opt/instar/dist/localVerify/runVerifyMain.js',
    remoteUrl: 'https://github.com/JKHeadley/instar.git', machineId: opts.machineId ?? 'coord', nodeVersion: 'v24',
    protectedList: ['.github/'], baseEnv: { PATH: '/usr/bin' }, ...(opts.peerOnly ? { peerOnly: true } : {}),
  }, seams);
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  const runTimers = async () => { for (let k = 0; k < 5; k++) { const tt = timers.splice(0); for (const f of tt) f(); await flush(); } };
  const audits = (event?: string) => {
    const f = path.join(stateDir, 'logs', 'local-verify.jsonl');
    const rows = fs.existsSync(f) ? fs.readFileSync(f, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
    return event ? rows.filter((r) => r.event === event) : rows;
  };
  const queueFile = () => JSON.parse(fs.readFileSync(path.join(stateDir, 'state', 'local-verify', 'queue.json'), 'utf-8')) as { v: number; entries: Array<Record<string, unknown>> };
  return {
    svc, seams, stateDir, agentHome, views, spawned, timers, clock, flush, runTimers, audits, queueFile,
    advance: (ms: number) => { clock.t += ms; },
    setForeignHolders: (pids: number[]) => { foreignHolders = pids.map((p) => ({ pid: p })); },
    setInstalledVerifier: (v: string | null) => { installedVerifier = v; },
  };
}

function fakePeer() {
  const calls: Array<{ kind: string; arg?: unknown }> = [];
  const received = new Map<string, PeerRunRequest>();
  let status: PeerStatus | null = { inFlight: null, verifierVersion: '1.0.0', policyHash: POLICY, slotBusy: false, signerKeyHash: PEER_KEY_HASH };
  let resultFor: (id: string) => PeerResult | null = () => ({ state: 'running' });
  const client: PeerClient = {
    status: async () => { calls.push({ kind: 'status' }); return status; },
    run: async (_p, req) => { calls.push({ kind: 'run', arg: req }); received.set(req.attemptId, JSON.parse(JSON.stringify(req))); return { ok: true, attemptId: req.attemptId }; },
    result: async (_p, id) => {
      calls.push({ kind: 'result', arg: id });
      const r = resultFor(id);
      const req = received.get(id);
      if (!r || r.state !== 'done' || !req) return r;
      const digest = requestDigest(req);
      return { ...r, requestDigest: digest, sig: signPeerResult(peerSigner(), { record: r.record, run: r.run, requestDigest: digest }) };
    },
    cancel: async (_p, id) => { calls.push({ kind: 'cancel', arg: id }); },
  };
  return {
    client, calls,
    setStatus: (s: PeerStatus | null) => { status = s; },
    setResult: (f: typeof resultFor) => { resultFor = f; },
    prime: (req: PeerRunRequest) => { received.set(req.attemptId, JSON.parse(JSON.stringify(req))); },
    runs: () => calls.filter((c) => c.kind === 'run').map((c) => c.arg as PeerRunRequest),
    cancels: () => calls.filter((c) => c.kind === 'cancel').map((c) => c.arg as string),
  };
}

/** A lease the test drives: who holds it, at which epoch, or unreadable. */
function leaseCtl(init: { epoch?: number | null; holder?: string | null } = {}) {
  const st = { epoch: init.epoch === undefined ? 7 : init.epoch, holder: init.holder === undefined ? 'coord' : init.holder, unreadable: false };
  return {
    st,
    view: {
      holdsLease: () => { if (st.unreadable) throw new Error('lease unreadable'); return st.holder === 'coord'; },
      leaseEpoch: () => { if (st.unreadable) throw new Error('lease unreadable'); return st.epoch; },
      holderMachineId: () => { if (st.unreadable) throw new Error('lease unreadable'); return st.holder; },
    },
  };
}

function seedHolding(stateDir: string, holding: Record<string, unknown> | null) {
  const file = path.join(stateDir, 'state', 'local-verify', 'peer-trust.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...emptyPeerTrust(), holding }));
}

const trustFile = (stateDir: string) => JSON.parse(fs.readFileSync(path.join(stateDir, 'state', 'local-verify', 'peer-trust.json'), 'utf-8')) as { holding: { holder: string; epoch: number; since?: unknown } | null };

function coordinator(o: { stateDir?: string; clock?: Clock; verifierVersion?: string; enabled?: boolean; lease?: ReturnType<typeof leaseCtl>; peer?: ReturnType<typeof fakePeer> } = {}) {
  const h = harness({ stateDir: o.stateDir, clock: o.clock, verifierVersion: o.verifierVersion });
  const peer = o.peer ?? fakePeer();
  const lease = o.lease ?? leaseCtl();
  let enabled: unknown = o.enabled ?? true;
  h.svc.setPeerWiring({ peers: () => [{ machineId: 'peer1', url: 'http://peer1:4042' }], client: peer.client, lease: lease.view, keyLookupFactory: pinnedPeerKeys });
  h.svc.setPeerWorksThroughRestart(() => enabled);
  return { ...h, peer, lease, setEnabled: (v: unknown) => { enabled = v; } };
}

/** A coordinator that has ticked once at epoch 7 (holding since 7) and dispatched PR 2 to the peer. */
async function dispatched(o: { enabled?: boolean } = {}) {
  const c = coordinator({ enabled: o.enabled });
  seedHolding(c.stateDir, { holder: 'coord', epoch: 7, since: 7 });
  await c.svc.tick();
  await c.svc.request(1); // runs here
  await c.svc.request(2); // goes to the peer
  await c.runTimers();
  const req = c.peer.runs()[0];
  expect(req).toMatchObject({ pr: 2, leaseEpoch: 7 });
  return { c, req };
}

/** The same state dir after a restart: a new service at the next epoch, booted. */
async function restarted(prev: ReturnType<typeof coordinator>, o: { epoch?: number | null; holder?: string | null; verifierVersion?: string; enabled?: boolean } = {}) {
  prev.svc.shutdown();
  const peer = fakePeer();
  for (const r of prev.peer.runs()) peer.prime(r);
  const lease = leaseCtl({ epoch: o.epoch === undefined ? 8 : o.epoch, holder: o.holder === undefined ? 'coord' : o.holder });
  const c = coordinator({ stateDir: prev.stateDir, clock: prev.clock, verifierVersion: o.verifierVersion, enabled: o.enabled, lease, peer });
  await c.svc.boot();
  return c;
}

const peerRecord = (req: PeerRunRequest, over: Partial<LocalVerifyRecord> = {}) => record({
  pr: req.pr, headSha: req.headSha, baseSha: req.baseSha, machineId: 'peer1', verifierVersion: req.verifierVersion,
  attempt: { id: req.attemptId, coordinatorMachineId: 'coord', leaseEpoch: req.leaseEpoch }, ...over,
});

const reserved = (c: { svc: LocalVerifyService }, pr = 2) => c.svc.snapshot().queue.find((e) => e.pr === pr)?.remote;

// ── pure ───────────────────────────────────────────────────────────────

describe('A: the dispatch gate (pure truth table)', () => {
  it('outside a pause only a changed verifier stops it; during a pause only setting on + unchanged verifier + no forced restart + a PR verify passes', () => {
    for (const enabled of [false, true]) for (const paused of [false, true]) for (const verifierChanged of [false, true])
      for (const bypassHolds of [false, true]) for (const kind of [undefined, 'main' as const]) {
        const want = !verifierChanged && (!paused || (enabled && !bypassHolds && kind !== 'main'));
        expect(pauseDispatchAllowed({ enabled, paused, verifierChanged, bypassHolds, kind }), JSON.stringify({ enabled, paused, verifierChanged, bypassHolds, kind })).toBe(want);
      }
  });
});

describe('C.1: holding.since on PR 3451\'s holding record', () => {
  it('pins the merged holdingDecision contract this spec depends on', () => {
    const self = 'coord';
    const read = (epoch: number | null, holder: string | null = self, holds = holder === self) => ({ holds, epoch, holder });
    expect(holdingDecision({ holder: self, epoch: 7 }, { unreadable: true, holds: false, epoch: null, holder: null }, self)).toBe('skip');
    expect(holdingDecision({ holder: self, epoch: 7 }, read(8, null, false), self)).toBe('not-held');
    expect(holdingDecision({ holder: self, epoch: 7 }, read(8, 'other', false), self)).toBe('other-holder');
    expect(holdingDecision({ holder: self, epoch: 7 }, read(7), self)).toBe('keep');
    expect(holdingDecision({ holder: self, epoch: 7 }, read(8), self)).toBe('keep');
    expect(holdingDecision({ holder: self, epoch: 7 }, read(9), self)).toBe('reset');
    expect(holdingDecision({ holder: self, epoch: 7 }, read(6), self)).toBe('reset');
    expect(holdingDecision({ holder: 'other', epoch: 7 }, read(8), self)).toBe('reset');
  });

  it('set on first creation, on reset, and on a keep that finds it missing, null or invalid; kept on an ordinary keep', () => {
    expect(keptHolding(null, 'coord', 7)).toEqual({ holder: 'coord', epoch: 7, since: 7 });
    expect(resetHoldingState(emptyPeerTrust(), { holder: 'coord', epoch: 9 }).holding).toEqual({ holder: 'coord', epoch: 9, since: 9 });
    expect(resetHoldingState(emptyPeerTrust(), null).holding).toBeNull();
    for (const bad of [undefined, null, 'x', 1.5, Number.NaN]) {
      expect(keptHolding({ holder: 'coord', epoch: 7, since: bad as never }, 'coord', 8)).toEqual({ holder: 'coord', epoch: 8, since: 8 });
    }
    expect(keptHolding({ holder: 'coord', epoch: 7, since: 3 }, 'coord', 8)).toEqual({ holder: 'coord', epoch: 8, since: 3 });
  });

  it('the service writes since through checkTrustHolding: created, backfilled on a pre-upgrade record, kept on keep, reset on a gap', async () => {
    const c = coordinator();
    await c.svc.tick();
    expect(trustFile(c.stateDir).holding).toEqual({ holder: 'coord', epoch: 7, since: 7 });
    c.lease.st.epoch = 8;
    await c.svc.tick();
    expect(trustFile(c.stateDir).holding).toEqual({ holder: 'coord', epoch: 8, since: 7 });
    c.lease.st.epoch = 10; // a gap of 2: another machine could have held it
    await c.svc.tick();
    expect(trustFile(c.stateDir).holding).toEqual({ holder: 'coord', epoch: 10, since: 10 });

    const old = coordinator();
    seedHolding(old.stateDir, { holder: 'coord', epoch: 6 }); // written by 3451 before this field
    await old.svc.tick();
    expect(trustFile(old.stateDir).holding).toEqual({ holder: 'coord', epoch: 7, since: 7 });
  });
});

describe('C.2/C.3: markerCurrent and the adoption decision (pure)', () => {
  const base = {
    enabled: true, self: 'coord', verifierVersion: '1.0.0', policyHash: POLICY,
    lease: { holds: true, epoch: 8 as number | null, holder: 'coord' as string | null },
    holding: { holder: 'coord', epoch: 8, since: 7 } as { holder: string | null; epoch: number | null; since?: number | null } | null,
    entry: { pr: 1, headSha: sha('a'), baseSha: sha('b'), baseRefName: 'main' } as { kind?: 'main'; pr: number; headSha: string; baseSha: string; baseRefName: string } | null,
  };
  it('markerCurrent compares the adopted epoch only with the setting on', () => {
    expect(markerCurrent(marker(), { epoch: 7 }, true)).toBe(true);
    expect(markerCurrent(marker({ adoptedEpoch: 8 }), { epoch: 8 }, true)).toBe(true);
    expect(markerCurrent(marker({ adoptedEpoch: 8 }), { epoch: 8 }, false)).toBe(false);
    expect(markerCurrent(marker({ adoptedEpoch: 8 }), { epoch: 7 }, true)).toBe(false);
  });
  it('each case: another holder, skip, no holder, not caught up, since before/after, entry moved, verifier, main, setting off', () => {
    const d = (over: Partial<typeof base>, m: RemoteMarker = marker()) => markerEpochDecision(m, { ...base, ...over });
    expect(d({})).toEqual({ action: 'adopt', fromEpoch: 7, toEpoch: 8 });
    expect(d({ lease: { holds: false, epoch: 9, holder: 'other' } })).toEqual({ action: 'abandon', reason: 'lease-changed:holding-broken' });
    expect(d({ lease: { holds: false, epoch: null, holder: null, unreadable: true } as never })).toEqual({ action: 'wait', why: 'unreadable' });
    expect(d({ lease: { holds: false, epoch: 8, holder: null } })).toEqual({ action: 'wait', why: 'not-held' });
    expect(d({ holding: { holder: 'coord', epoch: 7, since: 7 } })).toEqual({ action: 'wait', why: 'not-caught-up' });
    expect(d({ holding: null })).toEqual({ action: 'wait', why: 'not-caught-up' });
    expect(d({ holding: { holder: 'coord', epoch: 8, since: 8 } })).toEqual({ action: 'abandon', reason: 'lease-changed:holding-broken' }); // since after the dispatch
    expect(d({ holding: { holder: 'coord', epoch: 8, since: 3 } })).toMatchObject({ action: 'adopt' }); // since before it
    expect(d({ holding: { holder: 'coord', epoch: 8, since: null } })).toEqual({ action: 'abandon', reason: 'lease-changed:holding-broken' });
    expect(d({ lease: { holds: true, epoch: 6, holder: 'coord' }, holding: { holder: 'coord', epoch: 6, since: 6 } })).toEqual({ action: 'abandon', reason: 'lease-changed:holding-broken' }); // went backwards
    expect(d({ entry: { pr: 1, headSha: sha('c'), baseSha: sha('b'), baseRefName: 'main' } })).toEqual({ action: 'abandon', reason: 'lease-changed:entry-moved' });
    expect(d({ entry: null })).toEqual({ action: 'abandon', reason: 'lease-changed:entry-moved' });
    expect(d({ verifierVersion: '2.0.0' })).toEqual({ action: 'abandon', reason: 'lease-changed:verifier' });
    expect(d({ policyHash: 'f'.repeat(64) })).toEqual({ action: 'abandon', reason: 'lease-changed:verifier' });
    expect(d({}, marker({ dispatched: { ...marker().dispatched, pr: 0, headSha: sha('b'), kind: 'main' } }))).toEqual({ action: 'abandon', reason: 'lease-changed:main' });
    expect(d({ enabled: false })).toEqual({ action: 'abandon', reason: 'lease-changed:disabled' });
    expect(d({ enabled: false }, marker({ adoptedEpoch: 8 }))).toEqual({ action: 'abandon', reason: 'lease-changed:disabled' });
    expect(d({ enabled: false, lease: { holds: true, epoch: 7, holder: 'coord' } })).toEqual({ action: 'current' });
    // Already adopted at 8: current at 8; a later restart decides again against the dispatch epoch.
    expect(d({}, marker({ adoptedEpoch: 8 }))).toEqual({ action: 'current' });
    expect(d({ lease: { holds: true, epoch: 9, holder: 'coord' }, holding: { holder: 'coord', epoch: 9, since: 7 } }, marker({ adoptedEpoch: 8 }))).toEqual({ action: 'adopt', fromEpoch: 8, toEpoch: 9 });
  });
  it('importRefusal: an adopted marker imports at its adopted epoch only while the signed record names the dispatch epoch', () => {
    const ctx = { repo: REPO, verifierVersion: '1.0.0', policyHash: POLICY, holdsLease: true, leaseEpoch: 8, coordinatorMachineId: 'coord', adoptionOn: true };
    const rec = record({ attempt: { id: ATT, coordinatorMachineId: 'coord', leaseEpoch: 7 } });
    expect(importRefusal(rec, marker({ adoptedEpoch: 8 }), ctx)).toBeNull();
    expect(importRefusal(record({ attempt: { id: ATT, coordinatorMachineId: 'coord', leaseEpoch: 8 } }), marker({ adoptedEpoch: 8 }), ctx)).toBe('lease-epoch-changed');
    expect(importRefusal(rec, marker({ adoptedEpoch: 8 }), { ...ctx, adoptionOn: false })).toBe('lease-epoch-changed');
    expect(importRefusal(rec, marker(), ctx)).toBe('lease-epoch-changed');
  });
  it('a malformed optional marker field is dropped alone', () => {
    expect(cleanMarkerExtras(marker({ sentDuringPause: 'nope', adoptedEpoch: 8 }))).toEqual(marker({ adoptedEpoch: 8 }));
    expect(cleanMarkerExtras(marker({ sentDuringPause: 'c'.repeat(32), adoptedEpoch: -1 }))).toEqual(marker({ sentDuringPause: 'c'.repeat(32) }));
    expect(cleanMarkerExtras(marker({ adoptedEpoch: '8' as never }))).toEqual(marker());
  });
});

describe('E: progress judgment (pure)', () => {
  const lanes = LOCAL_VERIFY_DEADLINES.lanes;
  const prog = (over: Partial<PeerProgress> = {}): PeerProgress => ({ finishedFiles: 40, lastFinishedAt: T0 + 59 * MIN, running: [{ file: 'tests/integration/a.test.ts', seconds: 30, lane: 'integration', recordedMs: 5 * MIN }], slowdown: 1, ...over });
  it('stallMs: twice the longest recorded running file, times the slowdown; a file with no history uses its lane deadline', () => {
    expect(stallWindowMs(prog(), lanes)).toBe(10 * MIN);
    expect(stallWindowMs(prog({ slowdown: 1.5 }), lanes)).toBe(15 * MIN);
    expect(stallWindowMs(prog({ running: [{ file: 'u.test.ts', seconds: 1, lane: 'unit', recordedMs: null }] }), lanes)).toBe(2 * lanes.unit);
    expect(stallWindowMs(prog({ running: [] }), lanes)).toBeNull();
    expect(runSlowdown([])).toBe(1);
    expect(runSlowdown([0.5, 0.7])).toBe(1); // never below 1
    expect(runSlowdown([1, 2, 3])).toBe(2);
  });
  it('each verdict on both sides of its boundary', () => {
    const j = (over: Partial<Parameters<typeof judgePeerAttempt>[0]>) => judgePeerAttempt({ ageMs: 61 * MIN, progress: prog(), startedAt: T0, now: T0 + 61 * MIN, laneDeadlines: lanes, ...over }).verdict;
    expect(j({})).toBe('progressing'); // last finish 2 min ago, window 10 min
    expect(j({ now: T0 + 59 * MIN + 10 * MIN })).toBe('progressing'); // exactly at the window
    expect(j({ now: T0 + 59 * MIN + 10 * MIN + 1 })).toBe('stalled');
    expect(j({ progress: null })).toBe('unknown');
    expect(j({ childGone: true })).toBe('unknown');
    expect(j({ progress: prog({ running: [] }) })).toBe('unknown');
    expect(j({ ageMs: PEER_LIMITS.backstopMs - 1 })).toBe('progressing');
    expect(j({ ageMs: PEER_LIMITS.backstopMs })).toBe('backstop');
    expect(j({ progress: prog({ lastFinishedAt: null }), now: T0 + 61 * MIN })).toBe('stalled'); // nothing finished since the start
    expect(PEER_LIMITS.backstopMs).toBe(LOCAL_VERIFY_DEADLINES.fetchMs + LOCAL_VERIFY_DEADLINES.npmCiMs + LOCAL_VERIFY_DEADLINES.buildLintMs + LOCAL_VERIFY_DEADLINES.totalActiveMs);
  });
  it('parsePeerProgress bounds and shape-checks; anything malformed is null', () => {
    expect(parsePeerProgress(prog())).toEqual(prog());
    expect(parsePeerProgress({ ...prog(), slowdown: 0.5 })).toBeNull();
    expect(parsePeerProgress({ ...prog(), running: [{ file: '', seconds: 1, lane: 'unit', recordedMs: null }] })).toBeNull();
    expect(parsePeerProgress({ ...prog(), running: Array.from({ length: 41 }, () => prog().running[0]) })).toBeNull();
    expect(parsePeerProgress(null)).toBeNull();
    expect(laneOfKey('integration-2')).toBe('integration');
    expect(laneOfKey('unit')).toBe('unit');
  });
});

// ── the raw-epoch guard ───────────────────────────────────────────────

describe('C.2 guard: no raw RemoteMarker epoch read outside the allowed places', () => {
  it('reads of leaseEpoch / adoptedEpoch on a marker happen only in markerCurrent, markerEpochDecision, importRefusal, the dispatchOnce builder, marker validation and the display projection', () => {
    // Display and validation do not compare with the lease; markerEpochDecision is C.3's adoption rule itself.
    const allowed = new Set(['markerCurrent', 'markerEpochDecision', 'importRefusal', 'dispatchOnce', 'isRemoteMarker', 'cleanMarkerExtras', 'peersInfo']);
    const dir = path.join(__dirname, '..', '..', '..', 'src', 'localVerify');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && fs.readFileSync(path.join(dir, f), 'utf-8').includes('RemoteMarker'));
    expect(files.sort()).toEqual(['LocalVerifyService.ts', 'peer.ts']);
    const offenders = files.flatMap((f) => rawMarkerEpochReads(f, fs.readFileSync(path.join(dir, f), 'utf-8'), allowed));
    expect(offenders).toEqual([]);
    // The scan itself catches a raw comparison (negative control).
    expect(rawMarkerEpochReads('x.ts', 'function bad(m: RemoteMarker, e: { remote?: RemoteMarker }) { return m.leaseEpoch === 1 || e.remote!.adoptedEpoch === 2; }', allowed)).toHaveLength(2);
    expect(rawMarkerEpochReads('x.ts', 'function markerCurrent(m: RemoteMarker) { m.adoptedEpoch = 3; return m.leaseEpoch; }', allowed)).toEqual([]);
  });
});

function rawMarkerEpochReads(f: string, text: string, allowed: Set<string>): string[] {
    const markerish = /^(m|marker|out|remote|[A-Za-z_]+\.remote!?|[A-Za-z_]+\?\.remote!?)$/;
    const offenders: string[] = [];
    {
      const src = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true);
      const enclosing = (n: ts.Node): string => {
        for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
          if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name) return p.name.getText(src);
        }
        return '<top>';
      };
      const visit = (n: ts.Node) => {
        if (ts.isPropertyAccessExpression(n) && (n.name.text === 'leaseEpoch' || n.name.text === 'adoptedEpoch')) {
          const obj = n.expression.getText(src).replace(/\s+/g, '');
          const isWrite = ts.isBinaryExpression(n.parent) && n.parent.left === n && n.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
          if (markerish.test(obj) && !isWrite && !allowed.has(enclosing(n))) {
            offenders.push(`${f}:${src.getLineAndCharacterOfPosition(n.getStart()).line + 1} ${enclosing(n)}: ${n.getText(src)}`);
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(src);
    }
    return offenders;
}

// ── A + B on the service ─────────────────────────────────────────────

describe('A: dispatch to an idle peer during a restart pause', () => {
  async function pausedCoordinator(enabled: boolean) {
    const c = coordinator({ enabled });
    await c.svc.request(1); // runs here: the pause waits on it
    c.svc.setUpdatePendingProvider(() => ({ pending: true, pendingSinceMs: c.clock.t, otherBlockers: false }));
    await c.svc.tick();
    await c.svc.request(2);
    await c.runTimers();
    return c;
  }

  it('setting off: nothing is sent while paused (today)', async () => {
    const c = await pausedCoordinator(false);
    expect(c.peer.runs()).toHaveLength(0);
  });

  it('setting on: a PR goes to the idle peer, stamped with the restart episode; the local slot starts nothing', async () => {
    const c = await pausedCoordinator(true);
    expect(c.peer.runs().map((r) => r.pr)).toEqual([2]);
    const ep = c.svc.peersInfo().restartEpisode!;
    expect(ep).not.toBeNull();
    expect(reserved(c)?.sentDuringPause).toBe(ep.id);
    expect(c.svc.peersInfo().reserved[0]).toMatchObject({ sentDuringPause: ep.id, adoptedEpoch: null });
    expect(c.spawned).toHaveLength(1);
  });

  it('setting on: a forced restart (bypassHolds) or a verifier changed on disk sends nothing', async () => {
    const forced = coordinator();
    await forced.svc.request(1);
    fs.writeFileSync(path.join(forced.stateDir, 'state', 'restart-requested.json'), JSON.stringify({
      plannedRestart: true, requestedBy: 'update', bypassHolds: true, requestedAt: new Date(forced.clock.t).toISOString(), expiresAt: new Date(forced.clock.t + 3_600_000).toISOString(),
    }));
    forced.svc.setUpdatePendingProvider(() => ({ pending: true, pendingSinceMs: forced.clock.t, otherBlockers: false }));
    await forced.svc.request(2);
    await forced.runTimers();
    expect(forced.peer.runs()).toHaveLength(0);

    const changed = coordinator();
    await changed.svc.request(1);
    changed.svc.setUpdatePendingProvider(() => ({ pending: true, pendingSinceMs: changed.clock.t, otherBlockers: false }));
    changed.setInstalledVerifier('2.0.0');
    await changed.svc.request(2);
    await changed.runTimers();
    expect(changed.peer.runs()).toHaveLength(0);
  });

  it('setting on: a main verify is never sent while paused (and is sent with the same setup unpaused)', async () => {
    const run = async (paused: boolean) => {
      const c = coordinator();
      // SEC-113 D2.3: a coordinator that has run main itself (anchor + ten measured runs), so main may go to a peer.
      fs.writeFileSync(path.join(c.stateDir, 'state', 'local-verify', 'peer-trust.json'), JSON.stringify({ ...emptyPeerTrust(), holding: { holder: 'coord', epoch: 7, since: 7 },
        anchor: { head: sha('f'), finishedAt: new Date(T0 - 3_600_000).toISOString() }, locallyVerified: [sha('f')], durations: Array.from({ length: 10 }, () => 10 * MIN) }));
      c.svc.setPeerWiring({ mainOnPeers: () => true });
      c.setForeignHolders([9001]); // the local slot is busy, so main waits in the queue
      if (paused) c.svc.setUpdatePendingProvider(() => ({ pending: true, pendingSinceMs: c.clock.t, otherBlockers: false }));
      c.svc.noteMainHead(sha('d'));
      await c.runTimers();
      await c.svc.tick();
      await c.runTimers();
      return c.peer.runs().filter((r) => r.kind === 'main');
    };
    expect(await run(false)).toHaveLength(1);
    expect(await run(true)).toEqual([]);
  });
});

describe('B: the restart episode', () => {
  it('minted when an update is pending, kept while the pause flips off and on under it, cleared (with its row) when nothing is pending', async () => {
    const c = coordinator();
    await c.svc.tick();
    expect(c.svc.peersInfo().restartEpisode).toBeNull();
    let blockers = false;
    c.svc.setUpdatePendingProvider(() => ({ pending: true, pendingSinceMs: T0, otherBlockers: blockers }));
    await c.svc.tick();
    const id = c.svc.peersInfo().restartEpisode!.id;
    blockers = true; // the pause ends (another blocker), the restart stays pending
    await c.svc.tick();
    blockers = false;
    await c.svc.tick();
    expect(c.svc.peersInfo().restartEpisode!.id).toBe(id);
    c.svc.setUpdatePendingProvider(() => null);
    await c.svc.tick();
    expect(c.svc.peersInfo().restartEpisode).toBeNull();
    expect(c.audits('restart-episode-ended')).toEqual([expect.objectContaining({ episodeId: id, restarted: false })]);
  });

  it('a planned restart mints it too; the server stopping ends it as restarted, with the attempts in flight', async () => {
    const { c } = await dispatched();
    fs.writeFileSync(path.join(c.stateDir, 'state', 'restart-requested.json'), JSON.stringify({
      plannedRestart: true, requestedBy: 'update', requestedAt: new Date(c.clock.t).toISOString(), expiresAt: new Date(c.clock.t + 3_600_000).toISOString(),
    }));
    await c.svc.tick();
    const id = c.svc.peersInfo().restartEpisode!.id;
    c.svc.shutdown();
    expect(c.audits('restart-episode-ended')).toEqual([expect.objectContaining({ episodeId: id, restarted: true, attemptsInFlightAtRestart: 1 })]);
  });

  it('only the coordinator mints one: never a peer-only service, never without the lease', async () => {
    const p = harness({ peerOnly: true, machineId: 'peer1' });
    p.svc.setPeerWorksThroughRestart(() => true);
    p.svc.setUpdatePendingProvider(() => ({ pending: true, pendingSinceMs: T0, otherBlockers: false }));
    await p.svc.tick();
    expect(p.svc.peersInfo().restartEpisode).toBeNull();
    const c = coordinator({ lease: leaseCtl({ holder: 'peer1' }) });
    c.svc.setUpdatePendingProvider(() => ({ pending: true, pendingSinceMs: T0, otherBlockers: false }));
    await c.svc.tick();
    expect(c.svc.peersInfo().restartEpisode).toBeNull();
  });

  it('qualifying + peerIdleMs: a pause with a waiting PR and an idle healthy peer counts idle time (setting off: the peer stays idle)', async () => {
    const c = coordinator({ enabled: false });
    await c.svc.request(1);
    await c.svc.request(2);
    c.svc.setUpdatePendingProvider(() => ({ pending: true, pendingSinceMs: c.clock.t, otherBlockers: false }));
    await c.svc.tick();
    await c.runTimers();
    // The peer status is read once (the dispatch path) and found free.
    (c.svc as unknown as { peerHealth: Map<string, unknown> }).peerHealth.set('peer1', { consecutiveFailures: 0, openUntil: null, status: { inFlight: null, verifierVersion: '1.0.0', policyHash: POLICY, slotBusy: false }, statusAt: c.clock.t });
    c.advance(5 * MIN);
    await c.svc.tick();
    c.svc.setUpdatePendingProvider(() => null);
    c.advance(MIN);
    await c.svc.tick();
    expect(c.audits('restart-episode-ended')).toEqual([expect.objectContaining({ restarted: false, qualifying: true, peerIdleMs: 5 * MIN, pauseDispatches: 0 })]);
  });
});

describe('B: qualifyingPeerAttempts (which attempts hold a restart)', () => {
  const peerHolds = (c: { svc: LocalVerifyService }) => c.svc.restartHolds(4 * 3_600_000).filter((h) => h.name.startsWith('local-verify:peer-'));

  it('a pause-time attempt does not hold its own episode\'s restart; it holds once the episode ends, and under a later episode', async () => {
    const c = coordinator();
    await c.svc.request(1);
    let pending = true;
    c.svc.setUpdatePendingProvider(() => (pending ? { pending: true, pendingSinceMs: c.clock.t, otherBlockers: false } : null));
    await c.svc.tick();
    await c.svc.request(2);
    await c.runTimers();
    expect(reserved(c)?.sentDuringPause).toBeTruthy();
    expect(peerHolds(c)).toEqual([]);
    pending = false;
    await c.svc.tick(); // the episode ends with no restart
    expect(peerHolds(c)).toEqual([expect.objectContaining({ name: 'local-verify:peer-pr-2' })]);
    pending = true;
    await c.svc.tick(); // a later episode: a different id
    expect(peerHolds(c)).toEqual([expect.objectContaining({ name: 'local-verify:peer-pr-2' })]);
  });

  it('setting off: no exemption (the same pause-time marker holds)', async () => {
    const c = coordinator();
    await c.svc.request(1);
    c.svc.setUpdatePendingProvider(() => ({ pending: true, pendingSinceMs: c.clock.t, otherBlockers: false }));
    await c.svc.tick();
    await c.svc.request(2);
    await c.runTimers();
    expect(peerHolds(c)).toEqual([]);
    c.setEnabled(false);
    expect(peerHolds(c)).toEqual([expect.objectContaining({ name: 'local-verify:peer-pr-2' })]);
  });
});

// ── C on the service ─────────────────────────────────────────────────

describe('C: a peer attempt survives this coordinator\'s own restart', () => {
  it('epoch + 1 under the same holding: adopted once (no re-adoption), imported, the record counts', async () => {
    const { c, req } = await dispatched();
    const c2 = await restarted(c);
    c2.peer.setResult(() => ({ state: 'running' }));
    await c2.svc.tick();
    expect(c2.audits('peer-attempt-adopted')).toEqual([expect.objectContaining({ pr: 2, attemptId: req.attemptId, fromEpoch: 7, toEpoch: 8 })]);
    expect(reserved(c2)?.adoptedEpoch).toBe(8);
    expect((c2.queueFile().entries.find((e) => e.pr === 2)?.remote as { adoptedEpoch?: number }).adoptedEpoch).toBe(8);
    c2.advance(PEER_LIMITS.pollMs);
    await c2.svc.tick();
    expect(c2.audits('peer-attempt-adopted')).toHaveLength(1);
    c2.peer.setResult(() => ({ state: 'done', record: peerRecord(req) }));
    c2.advance(PEER_LIMITS.pollMs);
    await c2.svc.tick();
    expect(c2.svc.getRecord(2, sha('c'), 'main')).toMatchObject({ outcome: 'success', machineId: 'peer1' });
    expect(c2.peer.cancels()).toEqual([]);
  });

  it('the first tick after boot with no holder yet waits (no cancel); the next tick adopts', async () => {
    const { c, req } = await dispatched();
    const c2 = await restarted(c, { holder: null });
    await c2.svc.tick();
    expect(reserved(c2)).toBeTruthy();
    expect(c2.peer.cancels()).toEqual([]);
    expect(c2.audits('peer-attempt-adoption-waiting')).toEqual([expect.objectContaining({ attemptId: req.attemptId, why: 'not-held' })]);
    c2.lease.st.holder = 'coord';
    await c2.svc.tick();
    expect(reserved(c2)?.adoptedEpoch).toBe(8);
  });

  it('an unreadable lease waits (audited once per attempt and epoch)', async () => {
    const { c } = await dispatched();
    const c2 = await restarted(c);
    c2.lease.st.unreadable = true;
    await c2.svc.tick();
    await c2.svc.tick();
    expect(reserved(c2)).toBeTruthy();
    expect(c2.peer.cancels()).toEqual([]);
    expect(c2.audits('peer-attempt-adoption-waiting')).toHaveLength(1);
  });

  it('another machine named as holder abandons at once and cancels (holding-broken)', async () => {
    const { c, req } = await dispatched();
    const c2 = await restarted(c, { holder: 'other' });
    await c2.svc.tick();
    expect(reserved(c2)).toBeUndefined();
    expect(c2.peer.cancels()).toEqual([req.attemptId]);
    expect(c2.audits('peer-attempt-abandoned')).toEqual([expect.objectContaining({ reason: 'lease-changed:holding-broken', refunded: false })]);
  });

  it('a gap of 2 epochs (another holder could have been in between) abandons: holding-broken', async () => {
    const { c } = await dispatched();
    const c2 = await restarted(c, { epoch: 9 });
    await c2.svc.tick();
    expect(reserved(c2)).toBeUndefined();
    expect(c2.audits('peer-attempt-abandoned')[0]).toMatchObject({ reason: 'lease-changed:holding-broken' });
  });

  it('a holding record from before the upgrade (no since) never vouches for the earlier dispatch', async () => {
    const c = coordinator();
    seedHolding(c.stateDir, { holder: 'coord', epoch: 7 });
    await c.svc.request(1);
    await c.svc.request(2);
    await c.runTimers(); // dispatched at 7 before any tick wrote since
    const c2 = await restarted(c);
    await c2.svc.tick();
    expect(c2.audits('peer-attempt-abandoned')[0]).toMatchObject({ reason: 'lease-changed:holding-broken' });
  });

  it('the entry moved (its saved base no longer matches the dispatch) abandons: entry-moved', async () => {
    const { c } = await dispatched();
    c.svc.shutdown();
    const q = c.queueFile();
    const e = q.entries.find((x) => x.pr === 2)!;
    e.baseSha = sha('9');
    fs.writeFileSync(path.join(c.stateDir, 'state', 'local-verify', 'queue.json'), JSON.stringify(q));
    const c2 = await restarted(c);
    await c2.svc.tick();
    expect(c2.audits('peer-attempt-abandoned')[0]).toMatchObject({ reason: 'lease-changed:entry-moved', refunded: false });
  });

  it('a verifier change abandons and refunds the attempt, once per entry; a second one spends it', async () => {
    const { c } = await dispatched();
    expect(c.svc.snapshot().queue.find((e) => e.pr === 2)?.remoteAttempts).toBe(1);
    const c2 = await restarted(c, { verifierVersion: '2.0.0' });
    await c2.svc.tick();
    expect(c2.audits('peer-attempt-abandoned')[0]).toMatchObject({ reason: 'lease-changed:verifier', refunded: true, refunds: 1 });
    expect(c2.svc.snapshot().queue.find((e) => e.pr === 2)?.remoteAttempts ?? 0).toBe(0);
    expect(c2.queueFile().entries.find((e) => e.pr === 2)?.peerRefunded).toBe(true);
    // The next dispatch (to a peer on the new verifier), then another verifier-changing restart.
    c2.peer.setStatus({ inFlight: null, verifierVersion: '2.0.0', policyHash: POLICY, slotBusy: false, signerKeyHash: PEER_KEY_HASH });
    c2.advance(PEER_LIMITS.statusMs);
    await c2.svc.tick();
    await c2.runTimers();
    expect(reserved(c2)?.dispatched.verifierVersion).toBe('2.0.0');
    const c3 = await restarted(c2, { epoch: 9, verifierVersion: '3.0.0' });
    await c3.svc.tick();
    expect(c3.audits('peer-attempt-abandoned').at(-1)).toMatchObject({ reason: 'lease-changed:verifier', refunded: false, refunds: 1 });
    expect(c3.svc.snapshot().queue.find((e) => e.pr === 2)?.remoteAttempts).toBe(1);
  });

  it('only lease-changed:verifier refunds: holding-broken and entry-moved spend the attempt', async () => {
    const { c } = await dispatched();
    const c2 = await restarted(c, { epoch: 9 });
    await c2.svc.tick();
    expect(c2.svc.snapshot().queue.find((e) => e.pr === 2)?.remoteAttempts).toBe(1);
  });

  it('setting off: an adopted marker and a waiting marker both abandon with lease-changed:disabled', async () => {
    const { c } = await dispatched();
    const c2 = await restarted(c);
    await c2.svc.tick();
    expect(reserved(c2)?.adoptedEpoch).toBe(8);
    c2.setEnabled(false);
    await c2.svc.tick();
    expect(reserved(c2)).toBeUndefined();
    expect(c2.audits('peer-attempt-abandoned').at(-1)).toMatchObject({ reason: 'lease-changed:disabled' });

    const w = await dispatched();
    const w2 = await restarted(w.c, { holder: null });
    await w2.svc.tick();
    expect(reserved(w2)).toBeTruthy(); // waiting
    w2.setEnabled('true'); // anything but a real `true` is off
    await w2.svc.tick();
    expect(reserved(w2)).toBeUndefined();
    expect(w2.audits('peer-attempt-abandoned').at(-1)).toMatchObject({ reason: 'lease-changed:disabled' });
    expect(w2.peer.cancels()).toHaveLength(1);
  });

  it('a waiting attempt still blocks dispatch to its peer and does not hold restarts', async () => {
    const { c } = await dispatched();
    const c2 = await restarted(c, { holder: null });
    await c2.svc.request(3);
    await c2.svc.tick();
    await c2.runTimers();
    expect(reserved(c2)).toBeTruthy();
    expect(c2.peer.runs()).toHaveLength(0);
    expect(c2.svc.restartHolds(4 * 3_600_000).filter((h) => h.name.startsWith('local-verify:peer-'))).toEqual([]);
  });

  it('a malformed sentDuringPause on disk is dropped alone; the marker and its attempt survive', async () => {
    const { c, req } = await dispatched();
    c.svc.shutdown();
    const q = c.queueFile();
    (q.entries.find((x) => x.pr === 2)!.remote as Record<string, unknown>).sentDuringPause = 'NOT-AN-ID';
    fs.writeFileSync(path.join(c.stateDir, 'state', 'local-verify', 'queue.json'), JSON.stringify(q));
    const c2 = await restarted(c, { epoch: 7 });
    expect(reserved(c2)).toMatchObject({ attemptId: req.attemptId });
    expect(reserved(c2)?.sentDuringPause).toBeUndefined();
  });
});

// ── E on the service ─────────────────────────────────────────────────

describe('E: at the review point the coordinator judges the peer\'s progress', () => {
  const running = (c: { clock: Clock }, lastAgoMs: number, over: Partial<PeerProgress> = {}): PeerResult => ({
    state: 'running', progress: { finishedFiles: 30, lastFinishedAt: c.clock.t - lastAgoMs, running: [{ file: 'tests/integration/x.test.ts', seconds: 60, lane: 'integration', recordedMs: 5 * MIN }], slowdown: 1, ...over },
  });

  it('setting off: the run bound ends it whatever the progress (today)', async () => {
    const { c } = await dispatched({ enabled: false });
    c.advance(PEER_LIMITS.maxRunMs + 1);
    c.peer.setResult(() => running(c, MIN));
    await c.svc.tick();
    expect(reserved(c)).toBeUndefined();
    expect(c.audits('peer-attempt-judged')).toEqual([]);
  });

  it('progressing keeps it; stalled ends it; each judgment is audited', async () => {
    const { c } = await dispatched();
    c.advance(PEER_LIMITS.maxRunMs + 1);
    c.peer.setResult(() => running(c, MIN));
    await c.svc.tick();
    expect(reserved(c)).toBeTruthy();
    expect(c.audits('peer-attempt-judged').at(-1)).toMatchObject({ side: 'coordinator', verdict: 'progressing', finishedFiles: 30, lastFinishedAgoMs: MIN, stallMs: 10 * MIN });
    c.advance(PEER_LIMITS.pollMs);
    c.peer.setResult(() => running(c, 11 * MIN));
    await c.svc.tick();
    expect(reserved(c)).toBeUndefined();
    expect(c.audits('peer-attempt-judged').at(-1)).toMatchObject({ verdict: 'stalled' });
    expect(c.audits('peer-attempt-abandoned').at(-1)).toMatchObject({ reason: 'run-bound' });
  });

  it('unknown (no progress reported) ends it; the backstop ends a progressing one', async () => {
    const u = await dispatched();
    u.c.advance(PEER_LIMITS.maxRunMs + 1);
    u.c.peer.setResult(() => ({ state: 'running' }));
    await u.c.svc.tick();
    expect(reserved(u.c)).toBeUndefined();
    expect(u.c.audits('peer-attempt-judged').at(-1)).toMatchObject({ verdict: 'unknown' });

    const b = await dispatched();
    b.c.advance(PEER_LIMITS.backstopMs);
    b.c.peer.setResult(() => running(b.c, MIN));
    await b.c.svc.tick();
    expect(reserved(b.c)).toBeUndefined();
    expect(b.c.audits('peer-attempt-judged').at(-1)).toMatchObject({ verdict: 'backstop' });
  });
});

describe('E: the peer judges its own attempt on its own progress files', () => {
  async function peerRunning(o: { enabled?: boolean; start?: boolean } = {}) {
    const agentHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvpwtr-home-')));
    dirs.push(agentHome);
    const h = harness({ peerOnly: true, machineId: 'peer1', agentHome });
    h.svc.setPeerWiring({ peerRoleEnabled: () => true, lease: { holdsLease: () => false, leaseEpoch: () => 7, holderMachineId: () => 'coord' } });
    h.svc.setPeerWorksThroughRestart(() => o.enabled ?? true);
    expect(await h.svc.peerRun(runReq(), { holdsLease: false, holderMachineId: 'coord' })).toEqual({ ok: true, attemptId: ATT });
    // The run child is gone while the attempt still reads as running (its exit not handled yet).
    if (o.start === false) (h.svc as unknown as { inFlight: unknown }).inFlight = null;
    const p = verifyPaths(agentHome, sha('a'));
    fs.mkdirSync(p.reportsDir, { recursive: true });
    fs.writeFileSync(p.durationsPath, JSON.stringify({ 'tests/integration/x.test.ts': 5 * MIN }));
    const write = (finishedFiles: number, running: Array<{ file: string; startedAt: number }>) => fs.writeFileSync(path.join(p.reportsDir, 'integration-1.progress.json'),
      JSON.stringify({ v: 1, writtenAt: h.clock.t, finishedFiles, running: running.map((r) => ({ ...r, file: path.join(p.runDir, r.file) })) }));
    return { h, write };
  }

  it('progressing past the review point keeps it, and the running answer carries the progress', async () => {
    const { h, write } = await peerRunning();
    write(0, [{ file: 'tests/integration/x.test.ts', startedAt: h.clock.t }]);
    for (let i = 1; i <= 62; i++) {
      h.advance(MIN);
      write(i, [{ file: 'tests/integration/x.test.ts', startedAt: h.clock.t - 30_000 }]);
      await h.svc.tick();
    }
    expect(h.svc.peerResult(ATT)).toMatchObject({ state: 'running', progress: { finishedFiles: 62, running: [{ file: 'tests/integration/x.test.ts', lane: 'integration', recordedMs: 5 * MIN }] } });
    expect(h.audits('peer-attempt-judged').at(-1)).toMatchObject({ side: 'peer', verdict: 'progressing' });
    expect(h.audits('peer-attempt-self-cancelled')).toEqual([]);
  });

  it('stalled past the review point ends it', async () => {
    const { h, write } = await peerRunning();
    write(5, [{ file: 'tests/integration/x.test.ts', startedAt: h.clock.t }]);
    await h.svc.tick();
    h.advance(PEER_LIMITS.maxRunMs + 1);
    await h.svc.tick();
    expect(h.audits('peer-attempt-judged').at(-1)).toMatchObject({ verdict: 'stalled' });
    expect(h.svc.peerResult(ATT)).toEqual({ state: 'unknown' });
  });

  it('a run child that is gone ends it (unknown); the backstop ends even a progressing one; setting off ends it at the bound', async () => {
    const gone = await peerRunning({ start: false });
    gone.h.advance(PEER_LIMITS.maxRunMs + 1);
    await gone.h.svc.tick();
    expect(gone.h.audits('peer-attempt-judged').at(-1)).toMatchObject({ verdict: 'unknown', childGone: true });
    expect(gone.h.svc.peerResult(ATT)).toEqual({ state: 'unknown' });

    const b = await peerRunning();
    b.write(0, [{ file: 'tests/integration/x.test.ts', startedAt: b.h.clock.t }]);
    await b.h.svc.tick();
    b.h.advance(PEER_LIMITS.backstopMs);
    b.write(99, [{ file: 'tests/integration/x.test.ts', startedAt: b.h.clock.t }]);
    await b.h.svc.tick();
    expect(b.h.audits('peer-attempt-judged').at(-1)).toMatchObject({ verdict: 'backstop' });
    expect(b.h.svc.peerResult(ATT)).toEqual({ state: 'unknown' });

    const off = await peerRunning({ enabled: false });
    off.h.advance(PEER_LIMITS.maxRunMs + 1);
    await off.h.svc.tick();
    expect(off.h.audits('peer-attempt-judged')).toEqual([]);
    expect(off.h.svc.peerResult(ATT)).toEqual({ state: 'unknown' });
  });
});

// ── with the operator's queue controls (docs/specs/local-verify-queue-controls.md) ──
describe('with queue controls: hold and front on the pause path, and a hold on an adopted attempt', () => {
  const BY = 'echo-increasing-throughput';

  /** Paused for a restart with PR 1 running here and PRs 2 and 3 queued; nothing handed to the peer yet. */
  async function pausedWithTwoQueued() {
    const c = coordinator();
    c.svc.setQueueControlsEnabled(() => true);
    await c.svc.request(1); // runs here: the pause waits on it
    c.svc.setUpdatePendingProvider(() => ({ pending: true, pendingSinceMs: c.clock.t, otherBlockers: false }));
    await c.svc.tick();
    await c.svc.request(2);
    await c.svc.request(3);
    return c;
  }

  it('without a control the older change goes to the peer during the pause (the baseline the next two differ from)', async () => {
    const c = await pausedWithTwoQueued();
    await c.runTimers();
    expect(c.peer.runs().map((r) => r.pr)).toEqual([2]);
  });

  it('a held change is not handed to the peer during the pause; the next one is, stamped', async () => {
    const c = await pausedWithTwoQueued();
    expect(await c.svc.operatorHold({ pr: 2, by: BY, reason: 'not yet' })).toMatchObject({ ok: true, held: true, running: false, removed: 'queue' });
    await c.runTimers();
    expect(c.peer.runs().map((r) => r.pr)).toEqual([3]);
    expect(reserved(c, 3)?.sentDuringPause).toBe(c.svc.peersInfo().restartEpisode!.id);
    expect(c.svc.snapshot().queue.map((e) => e.pr)).not.toContain(2);
    expect(c.spawned).toHaveLength(1); // the local slot started nothing more
  });

  it('a fronted change is the one handed to the peer during the pause', async () => {
    const c = await pausedWithTwoQueued();
    expect(await c.svc.operatorFront({ pr: 3, by: BY, reason: 'unblocks others' })).toMatchObject({ ok: true });
    await c.runTimers();
    expect(c.peer.runs().map((r) => r.pr)).toEqual([3]);
    expect(reserved(c, 3)?.sentDuringPause).toBe(c.svc.peersInfo().restartEpisode!.id);
  });

  /** PR 2 on the peer, then held (it is running: left alone), then the coordinator restarts at the next epoch. */
  async function heldThenRestarted() {
    const { c, req } = await dispatched();
    c.svc.setQueueControlsEnabled(() => true);
    expect(await c.svc.operatorHold({ pr: 2, by: BY, reason: 'not yet' })).toMatchObject({ ok: true, held: true, running: true, where: 'peer', removed: null });
    c.svc.shutdown();
    const peer = fakePeer();
    for (const r of c.peer.runs()) peer.prime(r);
    const c2 = coordinator({ stateDir: c.stateDir, clock: c.clock, lease: leaseCtl({ epoch: 8 }), peer });
    c2.svc.setQueueControlsEnabled(() => true);
    await c2.svc.boot();
    return { c2, req };
  }

  it('a hold never touches the running attempt: it is adopted after the restart, not cancelled, and its result is imported', async () => {
    const { c2, req } = await heldThenRestarted();
    await c2.svc.tick();
    expect(c2.audits('peer-attempt-adopted')).toEqual([expect.objectContaining({ pr: 2, attemptId: req.attemptId, fromEpoch: 7, toEpoch: 8 })]);
    expect(reserved(c2)?.adoptedEpoch).toBe(8);
    expect(c2.peer.cancels()).toEqual([]);
    expect(c2.audits('operator-held-out')).toEqual([]);
    c2.peer.setResult(() => ({ state: 'done', record: peerRecord(req) }));
    c2.advance(PEER_LIMITS.pollMs);
    await c2.svc.tick();
    expect(c2.svc.getRecord(2, sha('c'), 'main')).toMatchObject({ outcome: 'success', machineId: 'peer1' });
    expect(c2.svc.snapshot().operator?.held.map((x) => x.pr)).toEqual([2]); // the hold stands; nothing is queued for it
    expect(c2.svc.snapshot().queue.map((e) => e.pr)).not.toContain(2);
  });

  it('an adopted attempt of a held change that comes back without a result goes to held, not back to the queue', async () => {
    const { c2 } = await heldThenRestarted();
    await c2.svc.tick();
    expect(reserved(c2)?.adoptedEpoch).toBe(8);
    c2.peer.setResult(() => ({ state: 'unknown' })); // the peer no longer knows the attempt
    c2.advance(3 * MIN);
    await c2.svc.tick();
    await c2.runTimers();
    expect(c2.audits('peer-attempt-abandoned')).toHaveLength(1);
    expect(reserved(c2)).toBeUndefined();
    expect(c2.svc.snapshot().queue.map((e) => e.pr)).not.toContain(2);
    expect(c2.audits('operator-held-out')).toEqual([expect.objectContaining({ pr: 2, from: 'queue', why: 'found-queued' })]);
    expect(c2.peer.runs()).toHaveLength(0); // not offered to the peer again
    expect(c2.audits('operator-held-started')).toEqual([]);
    expect(c2.svc.snapshot().operator?.held.map((x) => x.pr)).toEqual([2]);
  });
});
