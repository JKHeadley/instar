// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Peer verifiers (spec docs/specs/local-verify-capacity.md Part D): the pure checks in
 * peer.ts, the peer side of LocalVerifyService (accept, run, report, cancel, restart) and
 * the coordinator side (dispatch, poll, import, reclaim, bounds). Real fs in temp state
 * dirs; the child process, gh, the peer HTTP client, the lease and the clock are fakes.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { LocalVerifyService, STRAINED_PEER_PREFERENCE_MS, type LocalVerifyServiceSeams, type PrView } from '../../../src/localVerify/LocalVerifyService.js';
import { PEER_RESTART_HOLD_MS } from '../../../src/core/PlannedRestartVerifyGuard.js';
import { computePolicyHash } from '../../../src/localVerify/policy.js';
import type { LocalVerifyRecord } from '../../../src/localVerify/record.js';
import type { VerifyRunResult } from '../../../src/localVerify/orchestrator.js';
import {
  PEER_LIMITS, importRefusal, noteFailure, parsePeerRunRequest, parsePeers, peerHealthy, remoteLeaseDecision,
  type PeerClient, type PeerHealth, type PeerResult, type PeerRunAnswer, type PeerRunRequest, type PeerStatus, type RemoteMarker,
} from '../../../src/localVerify/peer.js';

const REPO = 'JKHeadley/instar';
const sha = (c: string) => c.repeat(40);
const ATT = 'a'.repeat(32);
const POLICY = computePolicyHash();
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'peerVerifier.test.ts' }); });

function view(over: Partial<PrView> = {}): PrView {
  return { author: { login: 'EchoOfDawn' }, isCrossRepository: false, headRefName: 'echo/x', headRefOid: sha('a'), baseRefName: 'main', baseRefOid: sha('b'), ...over };
}

function record(over: Partial<LocalVerifyRecord> = {}): LocalVerifyRecord {
  return {
    repo: REPO, pr: 1, headSha: sha('a'), baseSha: sha('b'), baseRefName: 'main', mergeTree: sha('d'),
    lanes: [{ name: 'unit', gating: true, files: 1, tests: 3, passed: 3, failed: 0, skipped: 0, todo: 0, seconds: 1 }],
    nodeVersion: 'v24', machineId: 'peer1', startedAt: '2026-10-21T12:00:30.000Z', finishedAt: '2026-10-21T12:20:00.000Z',
    outcome: 'success', harnessChanging: false, protectedPath: false, skipsAdded: false, testsRemoved: false,
    verifierVersion: '1.0.0', policyHash: POLICY, ...over,
  };
}

function marker(over: Partial<RemoteMarker> = {}): RemoteMarker {
  return {
    machineId: 'peer1', attemptId: ATT, leaseEpoch: 7, sentAt: Date.parse('2026-10-21T12:00:00.000Z'), state: 'accepted',
    dispatched: { pr: 1, headSha: sha('a'), baseSha: sha('b'), baseRefName: 'main', verifierVersion: '1.0.0', policyHash: POLICY }, ...over,
  };
}

function runReq(over: Partial<PeerRunRequest> = {}): PeerRunRequest {
  return {
    attemptId: ATT, pr: 1, headSha: sha('a'), baseSha: sha('b'), baseRefName: 'main', verifierVersion: '1.0.0', policyHash: POLICY,
    coordinatorMachineId: 'coord', leaseEpoch: 7, ...over,
  };
}

// ── pure checks ────────────────────────────────────────────────────────

describe('parsePeerRunRequest', () => {
  it('accepts exactly the request fields (plus an optional isolation block)', () => {
    expect(parsePeerRunRequest(runReq())).toEqual(runReq());
    expect(parsePeerRunRequest({ ...runReq(), isolation: { allowed: true, notCleanOnGreenMain: ['tests/x.test.ts'] } })).toBeTruthy();
  });
  it('refuses a missing field, an extra field, a bad attempt id, a bad sha or a bad isolation block', () => {
    const { pr: _p, ...noPr } = runReq(); void _p;
    for (const bad of [noPr, { ...runReq(), extra: 1 }, runReq({ attemptId: 'XYZ' }), runReq({ headSha: 'nope' }), { ...runReq(), isolation: { allowed: 'yes' } }, null, []]) {
      expect(parsePeerRunRequest(bad)).toBeNull();
    }
  });
});

describe('importRefusal', () => {
  const ctx = { repo: REPO, verifierVersion: '1.0.0', policyHash: POLICY, holdsLease: true, leaseEpoch: 7, coordinatorMachineId: 'coord' };
  const withAttempt = (over: Partial<LocalVerifyRecord> = {}) => record({ attempt: { id: ATT, coordinatorMachineId: 'coord', leaseEpoch: 7 }, ...over });
  it('imports a record that answers exactly the dispatched attempt', () => {
    expect(importRefusal(withAttempt(), marker(), ctx)).toBeNull();
  });
  it('preserves a peer early red only with valid, exact-head preflight evidence', () => {
    const preflight = { mode: 'enforce', outcome: 'red', reason: 'preflight-red', elapsedMs: 1200,
      changedFiles: 1, selectedFiles: ['tests/unit/example.test.ts'], selectedCases: 1,
      repeatedFailedFile: 'tests/unit/example.test.ts', headSha: sha('a'), baseSha: sha('b') } as const;
    const earlyRed = withAttempt({ outcome: 'failure', lanes: [], preflight: { ...preflight, selectedFiles: [...preflight.selectedFiles] } });
    expect(importRefusal(earlyRed, marker(), ctx)).toBeNull();
    expect(importRefusal({ ...earlyRed, preflight: { ...earlyRed.preflight!, headSha: sha('c') } }, marker(), ctx)).toMatch(/^invalid-record/);
  });
  it('refuses every mismatch, each with its reason', () => {
    const cases: Array<[unknown, Partial<RemoteMarker> | null, Partial<typeof ctx> | null, string]> = [
      [record(), null, null, 'no-attempt'],
      [withAttempt({ attempt: { id: 'b'.repeat(32), coordinatorMachineId: 'coord', leaseEpoch: 7 } }), null, null, 'wrong-attempt'],
      [withAttempt({ machineId: 'other' }), null, null, 'wrong-peer'],
      [withAttempt({ attempt: { id: ATT, coordinatorMachineId: 'someone-else', leaseEpoch: 7 } }), null, null, 'wrong-coordinator'],
      [withAttempt({ pr: 2 }), null, null, 'wrong-pr'],
      [withAttempt({ headSha: sha('c') }), null, null, 'wrong-head'],
      [withAttempt({ baseSha: sha('c') }), null, null, 'wrong-base'],
      [withAttempt({ verifierVersion: '2.0.0' }), null, null, 'verifier-mismatch'],
      [withAttempt({ policyHash: 'f'.repeat(64) }), null, null, 'policy-mismatch'],
      [withAttempt(), null, { holdsLease: false }, 'not-lease-holder'],
      [withAttempt(), null, { leaseEpoch: 8 }, 'lease-epoch-changed'],
      [withAttempt({ startedAt: '2026-10-21T11:00:00.000Z' }), null, null, 'started-before-dispatch'],
      [{ nope: true }, null, null, 'invalid-record'],
    ];
    for (const [rec, m, c, want] of cases) {
      expect(importRefusal(rec, marker(m ?? {}), { ...ctx, ...(c ?? {}) })).toMatch(new RegExp(`^${want}`));
    }
  });
});

describe('remoteLeaseDecision (CMT-1605)', () => {
  const ctx = { selfMachineId: 'coord', now: 1000, maxRunMs: PEER_LIMITS.maxRunMs };
  it('keeps at the same epoch, carries at exactly the next, abandons a jump or a step back', () => {
    expect(remoteLeaseDecision(7, 0, { holds: true, epoch: 7, holder: 'coord' }, ctx)).toBe('keep');
    expect(remoteLeaseDecision(7, 0, { holds: true, epoch: 8, holder: 'coord' }, ctx)).toBe('carry');
    expect(remoteLeaseDecision(7, 0, { holds: true, epoch: 9, holder: 'coord' }, ctx)).toBe('abandon');
    expect(remoteLeaseDecision(7, 0, { holds: true, epoch: 6, holder: 'coord' }, ctx)).toBe('abandon');
  });
  it('a null epoch never carries', () => {
    expect(remoteLeaseDecision(null, 0, { holds: true, epoch: null, holder: 'coord' }, ctx)).toBe('keep');
    expect(remoteLeaseDecision(null, 0, { holds: true, epoch: 1, holder: 'coord' }, ctx)).toBe('abandon');
  });
  it('not held: waits unless another machine holds it or the run bound passed', () => {
    expect(remoteLeaseDecision(7, 0, { holds: false, epoch: 7, holder: 'coord' }, ctx)).toBe('wait');
    expect(remoteLeaseDecision(7, 0, { holds: false, epoch: null, holder: null }, ctx)).toBe('wait');
    expect(remoteLeaseDecision(7, 0, { holds: false, epoch: 8, holder: 'peer1' }, ctx)).toBe('abandon');
    expect(remoteLeaseDecision(7, 0, { holds: false, epoch: 7, holder: null }, { ...ctx, now: PEER_LIMITS.maxRunMs + 1 })).toBe('abandon');
  });
});

describe('peer breaker and peer list', () => {
  it('opens after the configured consecutive failures and closes after its window', () => {
    const h: PeerHealth = { consecutiveFailures: 0, openUntil: null, status: null, statusAt: 0 };
    expect(noteFailure(h, 0)).toBe(false);
    expect(noteFailure(h, 0)).toBe(false);
    expect(noteFailure(h, 0)).toBe(true);
    expect(peerHealthy(h, 1)).toBe(false);
    expect(peerHealthy(h, PEER_LIMITS.breakerOpenMs + 1)).toBe(true);
  });
  it('parsePeers keeps at most the limit, drops self, bad urls and duplicates', () => {
    const peers = parsePeers([
      { machineId: 'self', url: 'http://a:1' }, { machineId: 'p1', url: 'http://192.168.0.2:4042/' }, { machineId: 'p1', url: 'http://x:1' },
      { machineId: 'p2', url: 'ftp://nope' }, { machineId: 'p3', url: 'https://p3.example' }, { machineId: 'p4', url: 'http://p4:1' },
    ], 'self');
    expect(peers).toEqual([{ machineId: 'p1', url: 'http://192.168.0.2:4042' }, { machineId: 'p3', url: 'https://p3.example' }]);
  });
});

// ── service harness ────────────────────────────────────────────────────

interface Spawned { pid: number; args: string[]; resultPath: string; inputPath: string; resolve: (x: { status: number | null; signal: string | null }) => void }

function harness(opts: { peerOnly?: boolean; machineId?: string; stateDir?: string; views?: Record<number, PrView>; spawnThrows?: boolean } = {}) {
  const stateDir = opts.stateDir ?? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvpeer-')));
  if (!opts.stateDir) {
    dirs.push(stateDir);
    fs.mkdirSync(path.join(stateDir, 'state', 'local-verify'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'state', 'local-verify', 'main-health.json'), JSON.stringify({
      v: 1, machineId: opts.machineId ?? 'coord', state: 'healthy', redHead: null, lastGreenHead: null, reason: 'green', updatedAt: '2026-10-21T00:00:00.000Z',
    }));
  }
  const views: Record<number, PrView> = opts.views ?? { 1: view(), 2: view({ headRefOid: sha('c') }), 3: view({ headRefOid: sha('e') }) };
  const spawned: Spawned[] = [];
  const killed: Array<{ pgid: number; signal: string }> = [];
  const timers: Array<() => void> = [];
  const signals: string[] = [];
  const priorities: boolean[] = [];
  let t = Date.parse('2026-10-21T12:00:00.000Z');
  let pid = 7000;
  let prOpen = true;
  let foreignHolders: Array<{ pid: number }> = [];
  const seams: LocalVerifyServiceSeams = {
    prView: async (pr) => views[pr] ?? null,
    isPrOpen: async () => prOpen,
    baseHead: async () => sha('b'),
    spawnRun: (a) => {
      if (opts.spawnThrows) throw new Error('spawn EAGAIN');
      const p = ++pid;
      let resolve!: Spawned['resolve'];
      const exited = new Promise<{ status: number | null; signal: string | null }>((r) => { resolve = r; });
      spawned.push({ pid: p, args: [a.command, ...a.args], resultPath: a.args[a.args.indexOf('--result') + 1], inputPath: a.args[a.args.indexOf('--input') + 1], resolve });
      return { pid: p, exited };
    },
    isGroupAlive: () => false,
    killGroup: (pgid, signal) => { killed.push({ pgid, signal }); },
    readProcessArgs: async () => null,
    foreignSuiteHolders: () => foreignHolders,
    setSuitePriority: (active) => { priorities.push(active); },
    signal: (key) => { signals.push(key); },
    now: () => t,
    setTimer: (fn) => { timers.push(fn); },
  };
  const svc = new LocalVerifyService({
    repo: REPO, stateDir, agentHome: '/agents/echo', expectedGhLogin: 'EchoOfDawn', operatorGhLogin: 'JKHeadley',
    verifierVersion: '1.0.0', nodePath: '/usr/bin/node', mainEntry: '/opt/instar/dist/localVerify/runVerifyMain.js',
    remoteUrl: 'https://github.com/JKHeadley/instar.git', machineId: opts.machineId ?? 'coord', nodeVersion: 'v24',
    protectedList: ['.github/'], baseEnv: { PATH: '/usr/bin' }, ...(opts.peerOnly ? { peerOnly: true } : {}),
  }, seams);
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  const runTimers = async () => { for (let k = 0; k < 5; k++) { const ts = timers.splice(0); for (const f of ts) f(); await flush(); } };
  const finish = async (i: number, result: VerifyRunResult | null) => {
    if (result) fs.writeFileSync(spawned[i].resultPath, JSON.stringify(result));
    spawned[i].resolve({ status: 0, signal: null });
    await flush();
  };
  const queueFile = () => JSON.parse(fs.readFileSync(path.join(stateDir, 'state', 'local-verify', 'queue.json'), 'utf-8')) as { entries: Array<Record<string, unknown>> };
  return { svc, seams, stateDir, views, spawned, killed, timers, signals, priorities, flush, runTimers, finish, queueFile, setPrOpen: (v: boolean) => { prOpen = v; }, setForeignHolders: (pids: number[]) => { foreignHolders = pids.map((pid) => ({ pid })); }, advance: (ms: number) => { t += ms; }, now: () => t };
}

const ok = (r: LocalVerifyRecord): VerifyRunResult => ({ kind: 'record', record: r, reasons: [], overlaps: [], keptWorktree: null });

/** A fake peer the coordinator talks to. */
function fakePeer() {
  const calls: Array<{ kind: string; arg?: unknown }> = [];
  let status: PeerStatus | null = { inFlight: null, verifierVersion: '1.0.0', policyHash: POLICY, slotBusy: false };
  let runAnswer: (req: PeerRunRequest) => PeerRunAnswer | null = (req) => ({ ok: true, attemptId: req.attemptId });
  let resultFor: (id: string) => PeerResult | null | Promise<PeerResult | null> = () => ({ state: 'running' });
  let queueAtSend: unknown = null;
  let readQueue: (() => unknown) | null = null;
  const client: PeerClient = {
    status: async () => { calls.push({ kind: 'status' }); return status; },
    run: async (_p, req) => { calls.push({ kind: 'run', arg: req }); queueAtSend = readQueue?.(); return runAnswer(req); },
    result: async (_p, id) => { calls.push({ kind: 'result', arg: id }); return resultFor(id); },
    cancel: async (_p, id) => { calls.push({ kind: 'cancel', arg: id }); },
  };
  return {
    client, calls,
    setStatus: (s: PeerStatus | null) => { status = s; },
    setRun: (f: typeof runAnswer) => { runAnswer = f; },
    setResult: (f: typeof resultFor) => { resultFor = f; },
    watchQueue: (f: () => unknown) => { readQueue = f; },
    queueAtSend: () => queueAtSend,
    runs: () => calls.filter((c) => c.kind === 'run').map((c) => c.arg as PeerRunRequest),
  };
}

import { registerLocalVerifyRestartHold, updatePendingFromAutoUpdater } from '../../../src/localVerify/localVerifyWiring.js';
import { AutoUpdater } from '../../../src/core/AutoUpdater.js';
import type { UpdateChecker } from '../../../src/core/UpdateChecker.js';
import type { StateManager } from '../../../src/core/StateManager.js';

function coordinator(opts: { epoch?: number; holds?: boolean } = {}) {
  const h = harness();
  const peer = fakePeer();
  let epoch = opts.epoch ?? 7;
  let holds = opts.holds ?? true;
  let fit: ((id: string) => { eligible: boolean; reason: string; score: number | null }) | null = null;
  h.svc.setPeerWiring({
    peers: () => [{ machineId: 'peer1', url: 'http://peer1:4042' }],
    client: peer.client,
    lease: { holdsLease: () => holds, leaseEpoch: () => epoch, holderMachineId: () => 'coord' },
    peerFit: (id) => (fit ? fit(id) : { eligible: true, reason: 'fits', score: 0.1 }),
  });
  peer.watchQueue(() => h.queueFile());
  return { ...h, peer, setEpoch: (e: number) => { epoch = e; }, setHolds: (v: boolean) => { holds = v; }, setFit: (f: typeof fit) => { fit = f; } };
}

// ── coordinator ────────────────────────────────────────────────────────

describe('coordinator — dispatch', () => {
  it('hands the next entry to an idle peer after local work starts, with the intent persisted before the send', async () => {
    const c = coordinator();
    await c.svc.request(1);
    await c.runTimers();
    expect(c.spawned).toHaveLength(1); // PR 1 runs locally
    expect(c.peer.runs()).toHaveLength(0); // nothing else queued yet
    await c.svc.request(2);
    await c.runTimers();
    const sent = c.peer.runs();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ pr: 2, headSha: sha('c'), baseSha: sha('b'), coordinatorMachineId: 'coord', leaseEpoch: 7, verifierVersion: '1.0.0', policyHash: POLICY });
    // Durable intent BEFORE the send: the queue file already carried the marker when run() was called.
    const atSend = c.peer.queueAtSend() as { entries: Array<{ pr: number; remote?: { attemptId: string; state: string } }> };
    expect(atSend.entries.find((e) => e.pr === 2)?.remote).toMatchObject({ attemptId: sent[0].attemptId, state: 'sending' });
    expect(c.svc.snapshot().peers.reserved).toEqual([expect.objectContaining({ pr: 2, peer: 'peer1', state: 'accepted' })]);
  });

  it('uses an idle peer while an unrelated suite holds the local slot', async () => {
    const c = coordinator();
    c.setForeignHolders([9001]);
    await c.svc.request(1);
    expect(c.spawned).toHaveLength(0);
    await c.runTimers();
    expect(c.peer.runs().map((r) => r.pr)).toEqual([1]);
    expect(c.svc.snapshot().peers.reserved).toEqual([expect.objectContaining({ pr: 1, state: 'accepted' })]);
    expect(c.priorities.at(-1)).toBe(false); // no local work remains after the remote reservation
  });

  it('keeps main for the coordinator while dispatching a PR past a busy local slot', async () => {
    const c = coordinator();
    c.setForeignHolders([9001]);
    c.svc.noteMainHead(sha('d'));
    await c.svc.request(1);
    await c.runTimers();
    expect(c.spawned).toHaveLength(0);
    expect(c.peer.runs().map((r) => r.pr)).toEqual([1]);
    expect(c.svc.snapshot().queue.some((e) => e.kind === 'main')).toBe(true);
    expect(c.priorities.at(-1)).toBe(true); // main still owns Studio's next slot
  });

  it('releases the Studio claim when base refresh finds the sole queued PR closed', async () => {
    const c = coordinator();
    c.setForeignHolders([9001]);
    await c.svc.request(1);
    expect(c.priorities.at(-1)).toBe(true);
    c.advance(5 * 60_000); // require the dispatcher's pre-send base refresh
    c.setPrOpen(false);
    await c.runTimers();
    expect(c.peer.runs()).toHaveLength(0);
    expect(c.svc.snapshot().queue).toEqual([]);
    expect(c.priorities.at(-1)).toBe(false);
  });

  // CMT-1605: a busy coordinator leaves queued PRs for a free peer instead of starting them itself.
  describe('while this machine is too busy for heavy work', () => {
    const busySelf = (id: string) => (id === 'coord' ? { eligible: false, reason: 'machine-busy', score: 2.4 } : { eligible: true, reason: 'fits', score: 0.2 });

    it('the first queued PR goes to the free peer, not to the local slot', async () => {
      const c = coordinator();
      c.setFit(busySelf);
      await c.svc.request(1);
      await c.runTimers();
      expect(c.spawned).toHaveLength(0);
      expect(c.peer.runs().map((r) => r.pr)).toEqual([1]);
    });

    it('when the peer is already busy, the next PR still runs here', async () => {
      const c = coordinator();
      c.setFit(busySelf);
      await c.svc.request(1);
      await c.runTimers();
      await c.svc.request(2);
      await c.runTimers();
      expect(c.peer.runs().map((r) => r.pr)).toEqual([1]);
      expect(c.spawned).toHaveLength(1);
    });

    it('a main verify is never deferred', async () => {
      const c = coordinator();
      c.setFit(busySelf);
      c.svc.noteMainHead(sha('d'));
      await c.runTimers();
      expect(c.spawned).toHaveLength(1);
      expect(c.peer.runs()).toHaveLength(0);
    });

    it('the preference is bounded: a PR the peer never takes starts here after the window', async () => {
      const c = coordinator();
      c.setFit(busySelf);
      c.peer.setStatus(null); // the peer cannot be read, so dispatch never sends
      await c.svc.request(1);
      await c.svc.tick();
      expect(c.spawned).toHaveLength(0);
      c.advance(STRAINED_PEER_PREFERENCE_MS + 1);
      await c.svc.tick();
      await c.runTimers();
      expect(c.spawned).toHaveLength(1);
    });

    it('a machine with headroom keeps the local-first order', async () => {
      const c = coordinator();
      await c.svc.request(1);
      await c.runTimers();
      expect(c.spawned).toHaveLength(1);
      expect(c.peer.runs()).toHaveLength(0);
    });
  });

  it('a reserved entry is never started locally, even when the local slot frees', async () => {
    const c = coordinator();
    await c.svc.request(1);
    await c.svc.request(2);
    await c.runTimers();
    expect(c.peer.runs().map((r) => r.pr)).toEqual([2]);
    await c.finish(0, ok(record({ pr: 1, machineId: 'coord' })));
    await c.runTimers();
    expect(c.spawned).toHaveLength(1); // PR 2 belongs to the peer
  });

  it('peer-busy is backpressure: the attempt does not count and no breaker opens', async () => {
    const c = coordinator();
    c.peer.setRun(() => ({ ok: false, reason: 'peer-busy' }));
    await c.svc.request(1);
    await c.svc.request(2);
    for (let i = 0; i < 5; i++) { c.advance(PEER_LIMITS.statusMs); c.svc.snapshot(); await c.svc.tick(); await c.runTimers(); }
    expect(c.peer.runs().length).toBeGreaterThanOrEqual(3);
    expect(c.signals.filter((s) => s.startsWith('local-verify:peer-breaker'))).toEqual([]);
    expect(c.svc.snapshot().queue.find((e) => e.pr === 2)?.remoteAttempts ?? 0).toBe(0);
  });

  it('other refusals count, and after the per-entry bound the entry is only run locally', async () => {
    const c = coordinator();
    c.peer.setRun(() => ({ ok: false, reason: 'head-moved' }));
    await c.svc.request(1);
    await c.svc.request(2);
    for (let i = 0; i < 4; i++) { c.advance(PEER_LIMITS.statusMs); await c.svc.tick(); await c.runTimers(); }
    expect(c.peer.runs()).toHaveLength(PEER_LIMITS.maxAttemptsPerEntry);
    await c.finish(0, ok(record({ pr: 1, machineId: 'coord' })));
    await c.runTimers();
    expect(c.spawned).toHaveLength(2); // PR 2 now runs here
  });

  it('a version mismatch or a busy peer status means no dispatch', async () => {
    const c = coordinator();
    c.peer.setStatus({ inFlight: null, verifierVersion: '2.0.0', policyHash: POLICY, slotBusy: false });
    await c.svc.request(1);
    await c.svc.request(2);
    await c.runTimers();
    expect(c.peer.runs()).toHaveLength(0);
  });

  it('a skipped peer leaves one audit row per version change, and one when the skew ends', async () => {
    const c = coordinator();
    const rows = (event: string) => {
      const f = path.join(c.stateDir, 'logs', 'local-verify.jsonl');
      return fs.readFileSync(f, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => e.event === event);
    };
    const inner = c.svc as unknown as { peerHealth: Map<string, { statusAt: number }>; dispatchOnce(): Promise<void> };
    const pollAgain = async () => { inner.peerHealth.forEach((h) => { h.statusAt = 0; }); await inner.dispatchOnce(); };
    c.peer.setStatus({ inFlight: null, verifierVersion: '2.0.0', policyHash: POLICY, slotBusy: false });
    await c.svc.request(1);
    await c.svc.request(2);
    await c.runTimers();
    await pollAgain();
    expect(rows('peer-skipped-skew')).toHaveLength(1);
    expect(rows('peer-skipped-skew')[0]).toMatchObject({ peerVerifierVersion: '2.0.0', verifierVersion: '1.0.0', policyMatches: true });

    c.peer.setStatus({ inFlight: null, verifierVersion: '3.0.0', policyHash: POLICY, slotBusy: false });
    await pollAgain();
    expect(rows('peer-skipped-skew')).toHaveLength(2);
    expect(rows('peer-skew-cleared')).toHaveLength(0);

    c.peer.setStatus({ inFlight: null, verifierVersion: '1.0.0', policyHash: POLICY, slotBusy: false });
    await pollAgain();
    expect(rows('peer-skew-cleared')).toHaveLength(1);
    expect(rows('peer-skipped-skew')).toHaveLength(2);
  });

  it('a peer that was never skewed leaves no skew rows', async () => {
    const c = coordinator();
    await c.svc.request(1);
    await c.svc.request(2);
    await c.runTimers();
    const log = fs.readFileSync(path.join(c.stateDir, 'logs', 'local-verify.jsonl'), 'utf-8');
    expect(log).not.toContain('peer-skipped-skew');
    expect(log).not.toContain('peer-skew-cleared');
  });

  it('no lease, no dispatch', async () => {
    const c = coordinator({ holds: false });
    await c.svc.request(1);
    await c.svc.request(2);
    await c.runTimers();
    expect(c.peer.runs()).toHaveLength(0);
  });

  it('does not dispatch another PR while a pending update waits for the local verifier', async () => {
    const c = coordinator();
    await c.svc.request(1);
    c.svc.setUpdatePendingProvider(() => ({ pending: true, pendingSinceMs: c.now(), otherBlockers: false }));
    await c.svc.request(2);
    await c.runTimers();
    expect(c.peer.runs()).toHaveLength(0);
    expect(c.svc.snapshot().queue.find((e) => e.pr === 2)?.remote).toBeUndefined();
    c.svc.setUpdatePendingProvider(() => null);
    await c.svc.tick();
    await c.runTimers();
    expect(c.peer.runs().map((r) => r.pr)).toEqual([2]);
  });

  it('rechecks the update pause after the peer status read', async () => {
    const c = coordinator();
    await c.svc.request(1);
    await c.svc.request(2);
    const status = c.peer.client.status;
    c.peer.client.status = async (p) => {
      c.svc.setUpdatePendingProvider(() => ({ pending: true, pendingSinceMs: c.now(), otherBlockers: false }));
      return status(p);
    };
    await c.runTimers();
    expect(c.peer.runs()).toHaveLength(0);
  });
});

describe('coordinator — results', () => {
  async function dispatched() {
    const c = coordinator();
    await c.svc.request(1);
    await c.svc.request(2);
    await c.runTimers();
    const req = c.peer.runs()[0];
    return { c, req };
  }
  const peerRecord = (req: PeerRunRequest, over: Partial<LocalVerifyRecord> = {}) => record({
    pr: req.pr, headSha: req.headSha, baseSha: req.baseSha, machineId: 'peer1', startedAt: new Date(Date.parse('2026-10-21T12:00:00.000Z') + 60_000).toISOString(),
    attempt: { id: req.attemptId, coordinatorMachineId: 'coord', leaseEpoch: 7 }, ...over,
  });

  it('a matching record is imported through the one completion path and the entry leaves the queue', async () => {
    const { c, req } = await dispatched();
    c.peer.setResult(() => ({ state: 'done', record: peerRecord(req) }));
    await c.svc.tick();
    expect(c.svc.getRecord(2, sha('c'), 'main')).toMatchObject({ outcome: 'success', machineId: 'peer1' });
    expect(c.svc.snapshot().queue.some((e) => e.pr === 2)).toBe(false);
  });

  it('a PR closed during a peer-result fetch is dequeued and its late success is not imported', async () => {
    const { c, req } = await dispatched();
    let release!: (result: PeerResult) => void;
    c.peer.setResult(() => new Promise<PeerResult>((resolve) => { release = resolve; }));
    const polling = c.svc.tick();
    await c.flush();
    c.setPrOpen(false);
    expect(await c.svc.request(2)).toEqual({ ok: false, code: 'pr-closed' });
    expect(c.peer.calls.some((x) => x.kind === 'cancel' && x.arg === req.attemptId)).toBe(true);
    release({ state: 'done', record: peerRecord(req) });
    await polling;
    expect(c.svc.getRecord(2, sha('c'), 'main')).toBeNull();
    expect(c.svc.snapshot().queue.some((e) => e.pr === 2)).toBe(false);
  });

  it('tracks flaky tests from an imported peer record', async () => {
    const { c, req } = await dispatched();
    c.peer.setResult(() => ({ state: 'done', record: peerRecord(req, {
      flakyRetried: [{ file: 'tests/e2e/unstable.test.ts', lane: 'e2e', firstMessage: 'intermittent failure' }],
    }) }));
    await c.svc.tick();
    expect(c.svc.getRecord(2, sha('c'), 'main')?.flakyRetried).toHaveLength(1);
    expect(c.signals).toContain('local-verify:flaky:tests/e2e/unstable.test.ts');
  });

  it('a record for another attempt or another base is rejected; the entry stays and the attempt counts', async () => {
    const { c, req } = await dispatched();
    c.peer.setResult(() => ({ state: 'done', record: peerRecord(req, { baseSha: sha('f') }) }));
    await c.svc.tick();
    expect(c.svc.getRecord(2, sha('c'), 'main')).toBeNull();
    const e = c.svc.snapshot().queue.find((x) => x.pr === 2)!;
    expect(e.remote).toBeUndefined();
    expect(e.remoteAttempts).toBe(1);
  });

  it('an error record is not recorded; the PR goes back to scheduling', async () => {
    const { c, req } = await dispatched();
    c.peer.setResult(() => ({ state: 'done', record: peerRecord(req, { outcome: 'error', errorStep: 'npm-ci', mergeTree: '', lanes: [] }) }));
    await c.svc.tick();
    expect(c.svc.getRecord(2, sha('c'), 'main')).toBeNull();
    expect(c.svc.snapshot().queue.find((x) => x.pr === 2)?.remote).toBeUndefined();
    expect(c.svc.peersInfo().configured[0].consecutiveFailures).toBe(1);
  });

  it('a PR merge conflict spends its peer attempts without degrading a healthy peer', async () => {
    const { c } = await dispatched();
    c.peer.setResult((attemptId) => {
      const req = c.peer.runs().find((r) => r.attemptId === attemptId)!;
      return { state: 'done', record: peerRecord(req, { outcome: 'error', errorStep: 'conflict', mergeTree: '', lanes: [] }) };
    });
    for (let i = 0; i < PEER_LIMITS.maxAttemptsPerEntry; i++) {
      await c.svc.tick();
      await c.runTimers();
    }
    expect(c.peer.runs()).toHaveLength(PEER_LIMITS.maxAttemptsPerEntry);
    expect(c.svc.peersInfo().configured[0]).toMatchObject({ healthy: true, consecutiveFailures: 0 });
    expect(c.signals.filter((s) => s.startsWith('local-verify:peer-breaker'))).toEqual([]);
    expect(c.svc.snapshot().queue.find((x) => x.pr === 2)?.remoteAttempts).toBe(PEER_LIMITS.maxAttemptsPerEntry);
    expect(c.svc.getRecord(2, sha('c'), 'main')).toBeNull();
  });

  it('a conflict does not erase an earlier peer execution failure', async () => {
    const { c, req } = await dispatched();
    c.peer.setResult(() => ({ state: 'done', record: peerRecord(req, { outcome: 'error', errorStep: 'npm-ci', mergeTree: '', lanes: [] }) }));
    await c.svc.tick();
    expect(c.svc.peersInfo().configured[0].consecutiveFailures).toBe(1);
    await c.runTimers();
    const retry = c.peer.runs()[1];
    c.peer.setResult(() => ({ state: 'done', record: peerRecord(retry, { outcome: 'error', errorStep: 'conflict', mergeTree: '', lanes: [] }) }));
    await c.svc.tick();
    expect(c.svc.peersInfo().configured[0]).toMatchObject({ healthy: true, consecutiveFailures: 1 });
  });

  it('keeps a peer preflight cleanup retry local and bypasses preflight', async () => {
    const { c, req } = await dispatched();
    c.svc.setPreflightMode(() => 'enforce');
    c.peer.setResult(() => ({ state: 'done', record: peerRecord(req, {
      outcome: 'error', errorStep: 'preflight-dirty-tree', lanes: [],
    }) }));
    await c.svc.tick();
    expect(c.svc.snapshot().queue.find((x) => x.pr === 2)?.remote).toBeUndefined();
    const saved = c.queueFile() as { entries: Array<{ pr: number; preflightBypassRetry?: boolean }> };
    expect(saved.entries.find((e) => e.pr === 2)?.preflightBypassRetry).toBe(true);
    await c.runTimers();
    expect(c.peer.runs()).toHaveLength(1);
    await c.finish(0, ok(record({ machineId: 'coord' })));
    expect(c.spawned).toHaveLength(2);
    const input = JSON.parse(fs.readFileSync(c.spawned[1].inputPath, 'utf8')) as { preflightMode: string };
    expect(input.preflightMode).toBe('off');
  });

  it('`unknown` past the grace reclaims (and cancels) the attempt; within the grace it waits', async () => {
    const { c } = await dispatched();
    c.peer.setResult(() => ({ state: 'unknown' }));
    await c.svc.tick();
    expect(c.svc.snapshot().queue.find((x) => x.pr === 2)?.remote).toBeTruthy();
    c.advance(PEER_LIMITS.unknownGraceMs + PEER_LIMITS.pollMs);
    await c.svc.tick();
    expect(c.svc.snapshot().queue.find((x) => x.pr === 2)?.remote).toBeUndefined();
    expect(c.peer.calls.some((x) => x.kind === 'cancel')).toBe(true);
  });

  it('a lease epoch jump (another machine held it since) abandons the attempt and imports nothing', async () => {
    const { c, req } = await dispatched();
    c.setEpoch(9);
    c.peer.setResult(() => ({ state: 'done', record: peerRecord(req) }));
    await c.svc.tick();
    expect(c.svc.getRecord(2, sha('c'), 'main')).toBeNull();
    expect(c.svc.snapshot().queue.find((x) => x.pr === 2)?.remote).toBeUndefined();
  });

  it('a restart that re-takes the lease on the same machine (new epoch, no foreign holder) keeps and imports the attempt', async () => {
    const { c, req } = await dispatched();
    c.svc.shutdown();
    const h2 = harness({ stateDir: c.stateDir });
    const peer2 = fakePeer();
    peer2.setResult(() => ({ state: 'done', record: peerRecord(req) }));
    let holds = false;
    h2.svc.setPeerWiring({ peers: () => [{ machineId: 'peer1', url: 'http://peer1:4042' }], client: peer2.client, lease: { holdsLease: () => holds, leaseEpoch: () => (holds ? 8 : null), holderMachineId: () => (holds ? 'coord' : null) } });
    await h2.svc.boot();
    await h2.svc.tick(); // lease not back yet: the attempt waits instead of being abandoned
    expect(h2.svc.snapshot().queue.find((x) => x.pr === 2)?.remote?.attemptId).toBe(req.attemptId);
    expect(peer2.calls.some((x) => x.kind === 'cancel')).toBe(false);
    holds = true;
    h2.svc.onLeaseAcquired({ foreignHolder: false, epoch: 8 });
    h2.advance(PEER_LIMITS.pollMs + 1);
    await h2.svc.tick();
    expect(h2.svc.getRecord(2, sha('c'), 'main')).toMatchObject({ machineId: 'peer1', outcome: 'success' });
  });

  it('a foreign holder in between still abandons the attempt and imports nothing', async () => {
    const { c, req } = await dispatched();
    c.setEpoch(10);
    c.svc.onLeaseAcquired({ foreignHolder: true, epoch: 10 });
    c.peer.setResult(() => ({ state: 'done', record: peerRecord(req) }));
    c.advance(PEER_LIMITS.pollMs + 1);
    await c.svc.tick();
    expect(c.svc.getRecord(2, sha('c'), 'main')).toBeNull();
    expect(c.svc.snapshot().queue.find((x) => x.pr === 2)?.remote).toBeUndefined();
  });

  it('another machine holding the lease after a restart abandons at once, without waiting out the grace', async () => {
    const { c, req } = await dispatched();
    c.svc.shutdown();
    const h2 = harness({ stateDir: c.stateDir });
    const peer2 = fakePeer();
    h2.svc.setPeerWiring({ peers: () => [{ machineId: 'peer1', url: 'http://peer1:4042' }], client: peer2.client, lease: { holdsLease: () => false, leaseEpoch: () => 11, holderMachineId: () => 'other' } });
    await h2.svc.boot();
    await h2.svc.tick();
    expect(h2.svc.snapshot().queue.find((x) => x.pr === 2)?.remote).toBeUndefined();
    expect(peer2.calls.some((x) => x.kind === 'cancel' && x.arg === req.attemptId)).toBe(true);
  });

  // CMT-1605: only the very next epoch proves nobody else held the lease; `foreignHolder` is in-memory.
  it('a same-machine re-acquisition with an epoch gap is not adopted: the attempt is abandoned', async () => {
    const { c, req } = await dispatched();
    c.setEpoch(10);
    c.svc.onLeaseAcquired({ foreignHolder: false, epoch: 10 });
    c.peer.setResult(() => ({ state: 'done', record: peerRecord(req) }));
    c.advance(PEER_LIMITS.pollMs + 1);
    await c.svc.tick();
    expect(c.svc.getRecord(2, sha('c'), 'main')).toBeNull();
    expect(c.svc.snapshot().queue.find((x) => x.pr === 2)?.remote).toBeUndefined();
  });

  it('the poll itself carries the attempt when this machine holds exactly the next epoch', async () => {
    const { c, req } = await dispatched();
    c.setEpoch(8); // no onLeaseAcquired: the reconciler has not reported it yet
    c.peer.setResult(() => ({ state: 'done', record: peerRecord(req) }));
    await c.svc.tick();
    expect(c.svc.getRecord(2, sha('c'), 'main')).toMatchObject({ machineId: 'peer1' });
    expect(c.peer.calls.some((x) => x.kind === 'cancel')).toBe(false);
  });

  it('two carries in a row are one continuous hold', async () => {
    const { c, req } = await dispatched();
    c.setEpoch(8);
    await c.svc.tick(); // still running: carried to 8
    expect(c.queueFile().entries.find((e) => e.pr === 2)?.remote).toMatchObject({ adoptedEpoch: 8 });
    c.setEpoch(9);
    c.advance(PEER_LIMITS.pollMs);
    c.peer.setResult(() => ({ state: 'done', record: peerRecord(req) }));
    await c.svc.tick();
    expect(c.svc.getRecord(2, sha('c'), 'main')).toMatchObject({ machineId: 'peer1' });
  });

  it('a lease lapse without a restart waits instead of abandoning, then carries', async () => {
    const { c, req } = await dispatched();
    c.advance(30 * 60_000); // long after boot: no boot grace involved
    c.setHolds(false);
    c.peer.setResult(() => ({ state: 'done', record: peerRecord(req) }));
    await c.svc.tick();
    expect(c.svc.getRecord(2, sha('c'), 'main')).toBeNull();
    expect(c.svc.snapshot().queue.find((x) => x.pr === 2)?.remote).toBeTruthy();
    expect(c.peer.calls.some((x) => x.kind === 'cancel' || x.kind === 'result')).toBe(false);
    c.setHolds(true); c.setEpoch(8);
    await c.svc.tick();
    expect(c.svc.getRecord(2, sha('c'), 'main')).toMatchObject({ machineId: 'peer1' });
  });

  it('a wait for the lease is bounded by the run bound', async () => {
    const { c } = await dispatched();
    c.setHolds(false);
    await c.svc.tick();
    expect(c.svc.snapshot().queue.find((x) => x.pr === 2)?.remote).toBeTruthy();
    c.advance(PEER_LIMITS.maxRunMs + 1);
    await c.svc.tick();
    expect(c.svc.snapshot().queue.find((x) => x.pr === 2)?.remote).toBeUndefined();
  });

  it('a run past the run bound is abandoned', async () => {
    const { c } = await dispatched();
    c.advance(PEER_LIMITS.maxRunMs + 1);
    await c.svc.tick();
    expect(c.svc.snapshot().queue.find((x) => x.pr === 2)?.remote).toBeUndefined();
  });

  it('a new head for a reserved PR abandons the attempt and keeps the place', async () => {
    const { c } = await dispatched();
    c.views[2] = view({ headRefOid: sha('9') });
    await c.svc.request(2);
    const e = c.svc.snapshot().queue.find((x) => x.pr === 2)!;
    expect(e.headSha).toBe(sha('9'));
    expect(e.remote).toBeUndefined();
  });

  it('a restart keeps the reservation and resumes polling the same attempt', async () => {
    const { c, req } = await dispatched();
    c.svc.shutdown();
    const saved = c.queueFile().entries.find((e) => e.pr === 2) as { remote?: { attemptId: string } };
    expect(saved.remote?.attemptId).toBe(req.attemptId);
    const h2 = harness({ stateDir: c.stateDir });
    const peer2 = fakePeer();
    peer2.setResult(() => ({ state: 'done', record: peerRecord(req) }));
    h2.svc.setPeerWiring({ peers: () => [{ machineId: 'peer1', url: 'http://peer1:4042' }], client: peer2.client, lease: { holdsLease: () => true, leaseEpoch: () => 7, holderMachineId: () => 'coord' } });
    await h2.svc.boot();
    await h2.svc.tick();
    expect(h2.svc.getRecord(2, sha('c'), 'main')).toMatchObject({ machineId: 'peer1' });
  });
});

// ── peer side ──────────────────────────────────────────────────────────

describe('coordinator — heartbeat for a planned restart', () => {
  async function dispatched() {
    const c = coordinator();
    await c.svc.request(1);
    await c.svc.request(2);
    await c.runTimers();
    const req = c.peer.runs()[0];
    const file = path.join(c.stateDir, 'state', 'local-verify', 'peer-hold.json');
    const read = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) as { v: number; writtenAt: number; leaseEpoch: number; attempts: Array<{ attemptId: string; pr: number; sentAt: number; lastPollOkAt: number }> } : null);
    const audits = () => fs.readFileSync(path.join(c.stateDir, 'logs', 'local-verify.jsonl'), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { event: string; reason?: string; attemptId?: string });
    const requestRestart = (over: Record<string, unknown> = {}) => fs.writeFileSync(path.join(c.stateDir, 'state', 'restart-requested.json'), JSON.stringify({
      plannedRestart: true, requestedBy: 'update', requestedAt: new Date(c.seams.now!()).toISOString(), expiresAt: new Date(c.seams.now!() + 3_600_000).toISOString(), ...over,
    }));
    return { c, req, file, read, audits, requestRestart };
  }
  const done = (req: PeerRunRequest) => ({ state: 'done', record: record({
    pr: req.pr, headSha: req.headSha, baseSha: req.baseSha, machineId: 'peer1', startedAt: new Date(Date.parse('2026-10-21T12:00:00.000Z') + 60_000).toISOString(),
    attempt: { id: req.attemptId, coordinatorMachineId: 'coord', leaseEpoch: 7 },
  }) }) as PeerResult;

  it('publishes an attempt the moment it is accepted, before any tick', async () => {
    const { req, read } = await dispatched();
    expect(read()).toMatchObject({ attempts: [{ attemptId: req.attemptId }] });
  });

  it('clears the heartbeat in the same poll that imports the record', async () => {
    const { c, req, read } = await dispatched();
    c.peer.setResult(() => done(req));
    await c.svc.tick();
    expect(c.svc.getRecord(2, sha('c'), 'main')).toMatchObject({ machineId: 'peer1' });
    expect(read()).toBeNull();
  });

  it('lists an accepted reservation before its first poll, with no restart pending', async () => {
    const { c, req, read } = await dispatched();
    c.peer.setResult(() => new Promise<PeerResult>(() => {})); // nothing has been polled yet and nothing will answer
    void c.svc.tick();
    expect(read()).toMatchObject({ v: 1, leaseEpoch: 7, attempts: [{ attemptId: req.attemptId, pr: req.pr }] });
    expect(c.peer.calls.filter((x) => x.kind === 'result')).toHaveLength(1);
  });

  it('a hanging poll does not delay the heartbeat on the next tick', async () => {
    const { c, file, read } = await dispatched();
    c.peer.setResult(() => new Promise<PeerResult>(() => {}));
    void c.svc.tick();
    await c.flush();
    SafeFsExecutor.safeRmSync(file, { force: true, operation: 'peerVerifier.test' });
    void c.svc.tick();
    expect(read()).not.toBeNull();
  });

  it('drops an attempt on an epoch change or a lost lease', async () => {
    for (const change of ['epoch', 'lease'] as const) {
      const { c, read } = await dispatched();
      await c.svc.tick();
      expect(read()).not.toBeNull();
      if (change === 'epoch') c.setEpoch(9); else c.setHolds(false);
      await c.svc.tick();
      expect(read()).toBeNull();
    }
  });

  it('excludes a marker still in sending, and a peer with no successful poll in two minutes', async () => {
    const { c, read } = await dispatched();
    c.peer.setResult(() => ({ state: 'running' }));
    await c.svc.tick();
    expect(read()).not.toBeNull();
    c.peer.setResult(() => null); // from here the peer answers nothing
    c.advance(PEER_LIMITS.pollMs + 1);
    await c.svc.tick();
    c.advance(PEER_LIMITS.pollMs + 1);
    await c.svc.tick();
    c.advance(1);
    await c.svc.tick();
    expect(read()).toBeNull();

    const s = coordinator();
    s.peer.setRun(() => null); // sent, never answered: the marker stays sending
    await s.svc.request(1);
    await s.svc.request(2);
    await s.runTimers();
    await s.svc.tick();
    expect(fs.existsSync(path.join(s.stateDir, 'state', 'local-verify', 'peer-hold.json'))).toBe(false);
  });

  it('an unknown answer does not count as contact', async () => {
    const { c, read } = await dispatched();
    c.peer.setResult(() => ({ state: 'unknown' }));
    await c.svc.tick();
    const seeded = read()!.attempts[0].lastPollOkAt;
    c.advance(PEER_LIMITS.pollMs + 1);
    await c.svc.tick();
    await c.flush();
    c.advance(1);
    await c.svc.tick();
    expect(read()!.attempts[0].lastPollOkAt).toBe(seeded);
  });

  it('import removes the attempt and the file goes away on the next tick', async () => {
    const { c, req, read } = await dispatched();
    await c.svc.tick();
    expect(read()).not.toBeNull();
    c.peer.setResult(() => done(req));
    c.advance(PEER_LIMITS.pollMs + 1);
    await c.svc.tick();
    await c.svc.tick();
    expect(c.svc.getRecord(2, sha('c'), 'main')).toMatchObject({ machineId: 'peer1' });
    expect(read()).toBeNull();
  });

  it('holds off a new dispatch while a planned restart waits on the attempt', async () => {
    const { c, requestRestart } = await dispatched();
    await c.svc.request(3);
    requestRestart();
    const before = c.peer.runs().length;
    c.peer.setResult(() => ({ state: 'running' }));
    await c.svc.tick();
    await c.runTimers();
    expect(c.peer.runs()).toHaveLength(before);
  });

  it('audits the hold once per attempt per request, then why it ended', async () => {
    const { c, req, audits, requestRestart } = await dispatched();
    requestRestart();
    await c.svc.tick();
    await c.svc.tick();
    expect(audits().filter((e) => e.event === 'restart-held-for-peer' && e.attemptId === req.attemptId)).toHaveLength(1);
    c.peer.setResult(() => done(req));
    c.advance(PEER_LIMITS.pollMs + 1);
    await c.svc.tick();
    expect(audits().filter((e) => e.event === 'restart-peer-hold-ended').map((e) => e.reason)).toEqual(['imported']);
  });

  describe('the update restart, which never writes its request while a hold is named', () => {
    const deferred = (c: { svc: { setUpdatePendingProvider(fn: () => { pending: boolean; pendingSinceMs: number | null; otherBlockers: boolean; restartHeldForPeer?: boolean }): void } }, heldForPeer: boolean) => {
      let since = 1_000;
      c.svc.setUpdatePendingProvider(() => ({ pending: true, pendingSinceMs: since++, otherBlockers: false, ...(heldForPeer ? { restartHeldForPeer: true } : {}) }));
    };

    // PR 1 runs locally in this harness and keeps its own hold; these are about the peer's.
    const peerHolds = (c: { svc: LocalVerifyService }, maxDeferralMs = 4 * 3_600_000) => c.svc.restartHolds(maxDeferralMs).filter((h) => h.name.startsWith('local-verify:peer-'));

    it('names an accepted attempt as a restart hold, bounded by the attempt and the ceiling', async () => {
      const { c, req } = await dispatched();
      const sentAt = c.seams.now!();
      expect(peerHolds(c, 4 * 3_600_000)).toEqual([expect.objectContaining({ name: `local-verify:peer-pr-${req.pr}`, until: sentAt + PEER_RESTART_HOLD_MS })]);
      expect(peerHolds(c, 60_000)[0].until).toBe(sentAt + 60_000);
    });

    it('stops naming it when the peer goes quiet, the lease moves or the attempt ends', async () => {
      const quiet = await dispatched();
      quiet.c.peer.setResult(() => null);
      quiet.c.advance(2 * PEER_LIMITS.pollMs + 1);
      expect(peerHolds(quiet.c)).toEqual([]);

      const moved = await dispatched();
      moved.c.setEpoch(8);
      expect(peerHolds(moved.c)).toEqual([]);

      const ended = await dispatched();
      ended.c.peer.setResult(() => done(ended.req));
      await ended.c.svc.tick();
      expect(peerHolds(ended.c)).toEqual([]);
    });

    it('rechecks the deferred restart as soon as the attempt is imported or abandoned', async () => {
      const imported = await dispatched();
      let calls = 0;
      imported.c.svc.setRunEndedListener(() => { calls++; });
      imported.c.peer.setResult(() => done(imported.req));
      await imported.c.svc.tick();
      expect(calls).toBeGreaterThan(0);

      const abandoned = await dispatched();
      let abandonedCalls = 0;
      abandoned.c.svc.setRunEndedListener(() => { abandonedCalls++; });
      abandoned.c.setEpoch(8);
      await abandoned.c.svc.tick();
      expect(abandonedCalls).toBeGreaterThan(0);
    });

    it('audits the hold once across retries while the restart is deferred, then why it ended', async () => {
      const { c, req, audits } = await dispatched();
      deferred(c, true);
      await c.svc.tick();
      await c.svc.tick();
      expect(audits().filter((e) => e.event === 'restart-held-for-peer' && e.attemptId === req.attemptId)).toHaveLength(1);
      c.peer.setResult(() => done(req));
      c.advance(PEER_LIMITS.pollMs + 1);
      await c.svc.tick();
      expect(audits().filter((e) => e.event === 'restart-peer-hold-ended').map((e) => e.reason)).toEqual(['imported']);
    });

    it('rechecks when a peer goes quiet, not only when its attempt ends', async () => {
      const { c } = await dispatched();
      let calls = 0;
      c.svc.setRunEndedListener(() => { calls++; });
      c.peer.setResult(() => null);
      c.advance(2 * PEER_LIMITS.pollMs + 1);
      await c.svc.tick();
      expect(calls).toBeGreaterThan(0);
    });

    it('audits nothing while an update is deferred for something other than a peer attempt', async () => {
      const { c, audits } = await dispatched();
      deferred(c, false);
      await c.svc.tick();
      expect(audits().filter((e) => e.event === 'restart-held-for-peer')).toEqual([]);
    });

    it('through the real AutoUpdater: no restart request is written while the attempt runs, and one is once it is imported', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const c = coordinator();
      c.advance(Date.now() - c.seams.now!()); // the AutoUpdater reads the real clock: dispatch on it, so the attempt's bound is live
      await c.svc.request(1);
      await c.svc.request(2);
      await c.runTimers();
      const req = c.peer.runs()[0];
      const audits = () => fs.readFileSync(path.join(c.stateDir, 'logs', 'local-verify.jsonl'), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { event: string; attemptId?: string });
      c.peer.setResult(() => ({ state: 'running' }));
      await c.svc.tick();
      await c.finish(0, ok(record()));
      await c.svc.tick();
      const checker = { getInstalledVersion: vi.fn().mockReturnValue('0.9.8'), check: vi.fn(), applyUpdate: vi.fn(), getLastCheck: vi.fn().mockReturnValue(null) } as unknown as UpdateChecker;
      const state = { get: vi.fn().mockReturnValue(997), set: vi.fn() } as unknown as StateManager;
      const u = new AutoUpdater(checker, state, c.stateDir, { preRestartDelaySecs: 0 });
      const flag = path.join(c.stateDir, 'state', 'restart-requested.json');
      try {
        u.setSessionDeps({ listRunningSessions: () => [] });
        registerLocalVerifyRestartHold(u, c.svc);
        const gated = () => (u as unknown as { gatedRestart(v: string, b?: boolean): Promise<void> }).gatedRestart('0.9.9', false);
        await gated();
        expect(fs.existsSync(flag)).toBe(false);
        expect(u.getStatus().restartDeferral).toMatchObject({ active: true, currentBlockers: [`local-verify:peer-pr-${req.pr}`] });
        await c.svc.tick();
        expect(audits().filter((e) => e.event === 'restart-held-for-peer' && e.attemptId === req.attemptId)).toHaveLength(1);
        c.peer.setResult(() => done(req));
        c.advance(PEER_LIMITS.pollMs + 1);
        await c.svc.tick();
        expect(c.svc.restartHolds(4 * 3_600_000)).toEqual([]);
        // No manual retry: the import's recheck alone brings the restart forward.
        for (let i = 0; i < 80 && !fs.existsSync(flag); i++) await new Promise((r) => setTimeout(r, 100));
        expect(fs.existsSync(flag)).toBe(true);
      } finally {
        u.stop();
        vi.restoreAllMocks();
      }
    });

    it('an update waiting only on the peer hold counts as this verifier\'s own hold', () => {
      const status = { config: { autoApply: true }, restartDeferral: { active: true, firstDeferredAt: '2026-10-21T12:00:00.000Z', currentBlockers: ['local-verify:peer-pr-2'] } };
      expect(updatePendingFromAutoUpdater(status, ['hold:local-verify:peer-pr-2'])).toMatchObject({ pending: true, otherBlockers: false, restartHeldForPeer: true });
      const forSessions = { ...status, restartDeferral: { ...status.restartDeferral, currentBlockers: ['echo-topic-1'] } };
      expect(updatePendingFromAutoUpdater(forSessions, ['echo-topic-1'])).not.toHaveProperty('restartHeldForPeer');
      expect(updatePendingFromAutoUpdater({ config: { autoApply: true } }, [])).not.toHaveProperty('restartHeldForPeer');
    });
  });

  it('records the other ways a hold ends: abandoned, bypass and the bound', async () => {
    const a = await dispatched();
    a.requestRestart();
    await a.c.svc.tick();
    a.c.setEpoch(9);
    await a.c.svc.tick();
    expect(a.audits().filter((e) => e.event === 'restart-peer-hold-ended').map((e) => e.reason)).toEqual(['abandoned']);

    const b = await dispatched();
    b.requestRestart();
    await b.c.svc.tick();
    b.c.advance(1_000); // the bypass writer stamps a new requestedAt
    b.requestRestart({ bypassHolds: true });
    await b.c.svc.tick();
    expect(b.audits().filter((e) => e.event === 'restart-peer-hold-ended').map((e) => e.reason)).toEqual(['bypass']);

    const d = await dispatched();
    d.requestRestart();
    await d.c.svc.tick();
    d.c.advance(PEER_RESTART_HOLD_MS + 1);
    await d.c.svc.tick();
    expect(d.audits().filter((e) => e.event === 'restart-peer-hold-ended').map((e) => e.reason)).toEqual(['bound-reached']);

    const f = await dispatched(); // the guard released at the bound and the request was consumed before this tick
    f.requestRestart();
    await f.c.svc.tick();
    f.c.advance(PEER_RESTART_HOLD_MS + 1);
    SafeFsExecutor.safeRmSync(path.join(f.c.stateDir, 'state', 'restart-requested.json'), { force: true, operation: 'peerVerifier.test' });
    await f.c.svc.tick();
    expect(f.audits().filter((e) => e.event === 'restart-peer-hold-ended').map((e) => e.reason)).toEqual(['bound-reached']);

    const g = await dispatched(); // the peer went silent, so the guard no longer holds for it
    g.requestRestart();
    g.c.peer.setResult(() => null);
    await g.c.svc.tick();
    g.c.advance(2 * PEER_LIMITS.pollMs + 1);
    await g.c.svc.tick();
    expect(g.audits().filter((e) => e.event === 'restart-peer-hold-ended').map((e) => e.reason)).toEqual(['no-longer-qualifies']);
  });
});

describe('peer — accepting and running', () => {
  function peerSide() {
    const h = harness({ peerOnly: true, machineId: 'peer1' });
    h.svc.setPeerWiring({ peerRoleEnabled: () => true });
    return h;
  }
  const notHolder = { holdsLease: false, holderMachineId: 'coord' };

  it('refuses each condition with its reason', async () => {
    const h = peerSide();
    expect(await h.svc.peerRun(runReq(), { holdsLease: true, holderMachineId: 'peer1' })).toEqual({ ok: false, reason: 'is-lease-holder' });
    expect(await h.svc.peerRun(runReq({ coordinatorMachineId: 'someone' }), notHolder)).toEqual({ ok: false, reason: 'not-coordinator' });
    expect(await h.svc.peerRun(runReq({ verifierVersion: '9' }), notHolder)).toEqual({ ok: false, reason: 'verifier-mismatch' });
    expect(await h.svc.peerRun(runReq({ headSha: sha('c'), pr: 1 }), notHolder)).toEqual({ ok: false, reason: 'head-moved' });
    h.views[5] = view({ author: { login: 'stranger' } });
    expect(await h.svc.peerRun(runReq({ pr: 5 }), notHolder)).toEqual({ ok: false, reason: 'untrusted-head' });
    expect(await h.svc.peerRun(runReq({ pr: 99 }), notHolder)).toEqual({ ok: false, reason: 'pr-unreadable' });
    h.svc.setPeerWiring({ peerRoleEnabled: () => false });
    expect(await h.svc.peerRun(runReq(), notHolder)).toEqual({ ok: false, reason: 'peer-disabled' });
  });

  it('accepts once (idempotent), runs against exactly the dispatched base, refuses a second attempt as busy', async () => {
    const h = peerSide();
    expect(await h.svc.peerRun(runReq({ baseSha: sha('7') }), notHolder)).toEqual({ ok: true, attemptId: ATT });
    expect(h.priorities.at(-1)).toBe(true);
    await h.svc.tick();
    expect(h.priorities.at(-1)).toBe(true);
    h.seams.foreignSuiteHolders = () => [{ pid: h.spawned[0].pid }];
    await h.svc.tick();
    expect(h.priorities.at(-1)).toBe(false);
    expect(await h.svc.peerRun(runReq({ baseSha: sha('7') }), notHolder)).toEqual({ ok: true, attemptId: ATT });
    expect(h.spawned).toHaveLength(1);
    const input = JSON.parse(fs.readFileSync(h.spawned[0].inputPath, 'utf-8'));
    expect(input).toMatchObject({ pr: 1, headSha: sha('a'), baseSha: sha('7'), attempt: { id: ATT, coordinatorMachineId: 'coord', leaseEpoch: 7 } });
    expect(await h.svc.peerRun(runReq({ attemptId: 'b'.repeat(32), pr: 2, headSha: sha('c') }), notHolder)).toEqual({ ok: false, reason: 'peer-busy' });
    expect(h.svc.peerStatus()).toMatchObject({ inFlight: { attemptId: ATT, pr: 1 }, slotBusy: true });
    expect(h.svc.peerResult(ATT)).toEqual({ state: 'running' });
  });

  it('refuses a new handoff during an update pause, including one that begins during the PR read', async () => {
    const h = peerSide();
    h.svc.setUpdatePendingProvider(() => ({ pending: true, pendingSinceMs: h.now(), otherBlockers: false }));
    expect(h.svc.peerStatus().slotBusy).toBe(true);
    expect(await h.svc.peerRun(runReq(), notHolder)).toEqual({ ok: false, reason: 'peer-busy' });
    h.svc.setUpdatePendingProvider(() => null);
    const read = h.seams.prView;
    h.seams.prView = async (pr) => {
      h.svc.setUpdatePendingProvider(() => ({ pending: true, pendingSinceMs: h.now(), otherBlockers: false }));
      return read(pr);
    };
    expect(await h.svc.peerRun(runReq(), notHolder)).toEqual({ ok: false, reason: 'peer-busy' });
    expect(h.spawned).toHaveLength(0);
  });

  it('the result is kept for the coordinator and never enters this machine\'s own index or queue file', async () => {
    const h = peerSide();
    await h.svc.peerRun(runReq(), notHolder);
    expect(h.priorities.at(-1)).toBe(true);
    await h.finish(0, ok(record({ machineId: 'peer1', attempt: { id: ATT, coordinatorMachineId: 'coord', leaseEpoch: 7 } })));
    expect(h.priorities.at(-1)).toBe(false);
    expect(h.svc.peerResult(ATT)).toMatchObject({ state: 'done', record: { outcome: 'success', attempt: { id: ATT } } });
    expect(h.svc.getRecord(1, sha('a'), 'main')).toBeNull();
    const qf = path.join(h.stateDir, 'state', 'local-verify', 'queue.json');
    if (fs.existsSync(qf)) expect(JSON.parse(fs.readFileSync(qf, 'utf-8')).entries).toEqual([]);
    expect(h.svc.peerStatus().inFlight).toBeNull();
  });

  it('a crashed run answers an error record for that attempt (the coordinator re-schedules it)', async () => {
    const h = peerSide();
    await h.svc.peerRun(runReq(), notHolder);
    await h.finish(0, null);
    expect(h.svc.peerResult(ATT)).toMatchObject({ state: 'done', record: { outcome: 'error', attempt: { id: ATT } } });
  });

  it('cancel tombstones the id: a delayed peer-run for it is refused', async () => {
    const h = peerSide();
    h.svc.peerCancel(ATT);
    expect(await h.svc.peerRun(runReq(), notHolder)).toEqual({ ok: false, reason: 'attempt-cancelled' });
  });

  it('a restart mid-run tombstones the interrupted attempt and answers unknown for it', async () => {
    const h = peerSide();
    await h.svc.peerRun(runReq(), notHolder);
    h.svc.shutdown();
    const h2 = harness({ peerOnly: true, machineId: 'peer1', stateDir: h.stateDir });
    h2.svc.setPeerWiring({ peerRoleEnabled: () => true });
    await h2.svc.boot();
    expect(h2.svc.peerResult(ATT)).toEqual({ state: 'unknown' });
    expect(await h2.svc.peerRun(runReq(), notHolder)).toEqual({ ok: false, reason: 'attempt-cancelled' });
  });

  it('a peer-only service refuses ordinary verify requests', async () => {
    const h = peerSide();
    expect(await h.svc.request(1)).toEqual({ ok: false, code: 'peer-only' });
  });
});

describe('code review round 1 fixes', () => {
  const peerRecordFor = (req: PeerRunRequest) => record({
    pr: req.pr, headSha: req.headSha, baseSha: req.baseSha, machineId: 'peer1', startedAt: new Date(Date.parse('2026-10-21T12:00:00.000Z') + 60_000).toISOString(),
    attempt: { id: req.attemptId, coordinatorMachineId: 'coord', leaseEpoch: 7 },
  });

  it('the lease is read again after the result fetch: a lease moved during the fetch imports nothing', async () => {
    const c = coordinator();
    await c.svc.request(1);
    await c.svc.request(2);
    await c.runTimers();
    const req = c.peer.runs()[0];
    c.peer.setResult(() => { c.setEpoch(9); return { state: 'done', record: peerRecordFor(req) }; });
    await c.svc.tick();
    expect(c.svc.getRecord(2, sha('c'), 'main')).toBeNull();
  });

  it('a peer whose attempts keep failing opens the breaker across entries (acceptance does not reset it)', async () => {
    const c = coordinator();
    for (const pr of [1, 2, 3]) await c.svc.request(pr);
    c.views[4] = view({ headRefOid: sha('4') });
    c.views[5] = view({ headRefOid: sha('5') });
    await c.svc.request(4);
    await c.svc.request(5);
    c.peer.setResult((id) => {
      const req = c.peer.runs().find((r) => r.attemptId === id)!;
      return { state: 'done', record: { ...peerRecordFor(req), outcome: 'error', errorStep: 'npm-ci', mergeTree: '', lanes: [] } };
    });
    for (let i = 0; i < 8 && !c.signals.some((x) => x.startsWith('local-verify:peer-breaker')); i++) {
      await c.runTimers();
      c.advance(PEER_LIMITS.pollMs + PEER_LIMITS.statusMs);
      await c.svc.tick();
    }
    expect(c.signals).toContain('local-verify:peer-breaker:peer1');
  });

  it('dispatch is skipped (nothing sent) when the queue cannot be written', async () => {
    const c = coordinator();
    await c.svc.request(1);
    await c.svc.request(2);
    const dir = path.join(c.stateDir, 'state', 'local-verify');
    fs.chmodSync(dir, 0o500);
    try {
      await c.runTimers();
      expect(c.peer.runs()).toHaveLength(0);
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });

  it('peer: a spawn failure answers an error record for the attempt and touches neither index nor queue', async () => {
    const h = harness({ peerOnly: true, machineId: 'peer1', spawnThrows: true });
    h.svc.setPeerWiring({ peerRoleEnabled: () => true });
    expect(await h.svc.peerRun(runReq(), { holdsLease: false, holderMachineId: 'coord' })).toEqual({ ok: true, attemptId: ATT });
    expect(h.svc.peerResult(ATT)).toMatchObject({ state: 'done', record: { outcome: 'error', attempt: { id: ATT } } });
    expect(h.svc.getRecord(1, sha('a'), 'main')).toBeNull();
    expect(h.svc.snapshot().queue).toEqual([]);
  });

  it('peer: a running attempt cancels itself past the run bound, and when this machine becomes the lease holder', async () => {
    for (const trigger of ['run-bound', 'lease'] as const) {
      const h = harness({ peerOnly: true, machineId: 'peer1' });
      let holds = false;
      h.svc.setPeerWiring({ peerRoleEnabled: () => true, lease: { holdsLease: () => holds, leaseEpoch: () => 7, holderMachineId: () => (holds ? 'peer1' : 'coord') } });
      await h.svc.peerRun(runReq(), { holdsLease: false, holderMachineId: 'coord' });
      if (trigger === 'run-bound') h.advance(PEER_LIMITS.maxRunMs + 1); else holds = true;
      await h.svc.tick();
      expect(h.svc.peerResult(ATT)).toEqual({ state: 'unknown' });
      expect(await h.svc.peerRun(runReq(), { holdsLease: false, holderMachineId: 'coord' })).toEqual({ ok: false, reason: 'attempt-cancelled' });
    }
  });

  it('peer: a lease change while the PR read is pending refuses the attempt', async () => {
    const h = harness({ peerOnly: true, machineId: 'peer1' });
    let holds = false;
    h.svc.setPeerWiring({ peerRoleEnabled: () => true, lease: { holdsLease: () => holds, leaseEpoch: () => 7, holderMachineId: () => (holds ? 'peer1' : 'coord') } });
    const orig = h.views[1];
    Object.defineProperty(h.views, 1, { get: () => { holds = true; return orig; }, configurable: true });
    expect(await h.svc.peerRun(runReq(), { holdsLease: false, holderMachineId: 'coord' })).toEqual({ ok: false, reason: 'is-lease-holder' });
    expect(h.spawned).toHaveLength(0);
  });
});

describe('code review round 2 fixes', () => {
  it('peer: a run-setup failure before the child exists ends the attempt with an error record (not a phantom running attempt)', async () => {
    const h = harness({ peerOnly: true, machineId: 'peer1' });
    h.svc.setPeerWiring({ peerRoleEnabled: () => true });
    // The runs directory path is occupied by a FILE: mkdir/write of the run input fails inside start().
    const runs = path.join(h.stateDir, 'state', 'local-verify', 'runs');
    fs.writeFileSync(runs, 'not a dir');
    expect(await h.svc.peerRun(runReq(), { holdsLease: false, holderMachineId: 'coord' })).toEqual({ ok: true, attemptId: ATT });
    expect(h.svc.peerResult(ATT)).toMatchObject({ state: 'done', record: { outcome: 'error', attempt: { id: ATT } } });
    expect(h.svc.peerStatus().inFlight).toBeNull();
  });

  it('peer: a write failure after spawn keeps the child tracked until it exits', async () => {
    const h = harness({ peerOnly: true, machineId: 'peer1' });
    h.svc.setPeerWiring({ peerRoleEnabled: () => true });
    const original = fs.renameSync.bind(fs);
    let writes = 0;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).endsWith('inflight.json') && ++writes === 2) throw new Error('disk write failed');
      return original(from, to);
    });
    try {
      expect(await h.svc.peerRun(runReq(), { holdsLease: false, holderMachineId: 'coord' })).toEqual({ ok: true, attemptId: ATT });
    } finally {
      spy.mockRestore();
    }
    expect(h.spawned).toHaveLength(1);
    expect(h.svc.peerStatus().inFlight).toMatchObject({ attemptId: ATT });
    expect(h.killed).toContainEqual({ pgid: h.spawned[0].pid, signal: 'SIGTERM' });
    expect(fs.existsSync(h.svc.inFlightPath)).toBe(true);
    await h.finish(0, null);
    expect(h.svc.peerStatus().inFlight).toBeNull();
    expect(fs.existsSync(h.svc.inFlightPath)).toBe(false);
  });

  it('coordinator: a merge hold that begins during the dispatch awaits stops the dispatch', async () => {
    const c = coordinator();
    await c.svc.request(1);
    await c.svc.request(2);
    // The peer status read is the await; the local run finishes green during it and opens a merge hold.
    c.svc.setMergeHandoff(() => new Promise(() => {}));
    const realStatus = c.peer.client.status;
    c.peer.client.status = async (p) => {
      await c.finish(0, { kind: 'record', record: record({ pr: 1, machineId: 'coord' }), reasons: [], overlaps: [], keptWorktree: null });
      return realStatus(p);
    };
    // Run only the dispatch that is scheduled now (not the merge hand-off's own timeout timer).
    for (const f of c.timers.splice(0)) f();
    await c.flush();
    expect(c.peer.calls.some((x) => x.kind === 'status')).toBe(true);
    expect(c.svc.snapshot().mergeLine.hold).toBeTruthy();
    expect(c.peer.runs()).toHaveLength(0);
  });
});

// ── resource-aware placement §4: peers respect size and load ───────────

describe('coordinator — peer fit (resource-aware placement)', () => {
  function twoPeers(peerFit?: (id: string) => { eligible: boolean; reason: string; score: number | null }) {
    const h = harness();
    const peer = fakePeer();
    const sentTo: string[] = [];
    const client: PeerClient = { ...peer.client, run: async (p, req) => { sentTo.push(p.machineId); return peer.client.run(p, req); } };
    h.svc.setPeerWiring({
      peers: () => [{ machineId: 'mini', url: 'http://mini:4042' }, { machineId: 'm5pro', url: 'http://m5pro:4042' }],
      client,
      lease: { holdsLease: () => true, leaseEpoch: () => 7, holderMachineId: () => 'coord' },
      ...(peerFit ? { peerFit } : {}),
    });
    return { ...h, peer, sentTo };
  }

  it('without the seam, the configured order is kept (today\'s behaviour)', async () => {
    const c = twoPeers();
    c.setForeignHolders([9001]);
    await c.svc.request(1);
    await c.runTimers();
    expect(c.sentTo[0]).toBe('mini');
  });

  it('a peer below the floor is skipped and the skip is audited', async () => {
    const c = twoPeers((id) => (id === 'mini' ? { eligible: false, reason: 'machine-too-small', score: null } : { eligible: true, reason: 'fits', score: 0.7 }));
    c.setForeignHolders([9001]);
    await c.svc.request(1);
    await c.runTimers();
    expect(c.sentTo).toEqual(['m5pro']);
    const audit = fs.readFileSync(path.join(c.stateDir, 'logs', 'local-verify.jsonl'), 'utf-8');
    expect(audit).toContain('"event":"peer-skipped-resource"');
    expect(audit).toContain('"reason":"machine-too-small"');
  });

  it('every peer ineligible → nothing is handed off (the entry waits for the local slot)', async () => {
    const c = twoPeers(() => ({ eligible: false, reason: 'machine-busy', score: null }));
    c.setForeignHolders([9001]);
    await c.svc.request(1);
    await c.runTimers();
    expect(c.sentTo).toEqual([]);
  });

  it('eligible peers are tried least-loaded first', async () => {
    const c = twoPeers((id) => ({ eligible: true, reason: 'fits', score: id === 'mini' ? 0.9 : 0.3 }));
    c.setForeignHolders([9001]);
    await c.svc.request(1);
    await c.runTimers();
    expect(c.sentTo[0]).toBe('m5pro');
  });

  it('a fit seam that throws keeps that peer (no silent drop)', async () => {
    const c = twoPeers(() => { throw new Error('registry gone'); });
    c.setForeignHolders([9001]);
    await c.svc.request(1);
    await c.runTimers();
    expect(c.sentTo[0]).toBe('mini');
  });
});
