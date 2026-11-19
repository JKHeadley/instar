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
import { LocalVerifyService, type LocalVerifyServiceSeams, type PrView } from '../../../src/localVerify/LocalVerifyService.js';
import { PEER_RESTART_HOLD_MS } from '../../../src/core/PlannedRestartVerifyGuard.js';
import { computePolicyHash } from '../../../src/localVerify/policy.js';
import type { LocalVerifyRecord } from '../../../src/localVerify/record.js';
import type { VerifyRunResult } from '../../../src/localVerify/orchestrator.js';
import {
  PEER_LIMITS, importRefusal, noteFailure, parsePeerMainRun, parsePeerRunRequest, parsePeers, peerHealthy,
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

describe('parsePeerRunRequest — import-related re-run fields', () => {
  const HASH = 'ab'.repeat(32);
  const t = (over: Record<string, unknown> = {}) => ({ test: 's one', at: '2026-11-16T10:00:00.000Z', line: 'Error: x', setHash: HASH, runLog: 'a'.repeat(32) + '.log', ...over });
  const iso = (over: Record<string, unknown> = {}) => ({ allowed: true, notCleanOnGreenMain: [], importRelatedRerun: true, flakyOnMain: [{ file: 'tests/unit/a.test.ts', tests: [t()] }], ...over });
  const parse = (isolation: unknown) => parsePeerRunRequest({ ...runReq(), isolation });
  it('accepts the new fields, with the optional cut markers', () => {
    expect(parse(iso())).toBeTruthy();
    expect(parse(iso({ importRelatedRerun: false, flakyOnMain: [] }))).toBeTruthy();
    expect(parse(iso({ flakyOnMain: [{ file: 'tests/unit/a.test.ts', tests: [t({ lineCut: true })], namesCut: true }] }))).toBeTruthy();
    expect(parse(iso({ flakyOnMain: [{ file: 'tests/unit/a.test.ts', tests: [], namesCut: true }] }))).toBeTruthy();
  });
  it('refuses each malformed shape and each bound, whole', () => {
    const files = (n: number) => Array.from({ length: n }, (_, i) => ({ file: `tests/unit/f${i}.test.ts`, tests: [t()] }));
    const bad: unknown[] = [
      iso({ importRelatedRerun: 'yes' }),
      iso({ flakyOnMain: 'x' }),
      iso({ flakyOnMain: undefined }), // the switch without its list
      iso({ flakyOnMain: files(201) }),
      iso({ flakyOnMain: [{ file: '', tests: [] }] }),
      iso({ flakyOnMain: [{ file: 'f'.repeat(301), tests: [] }] }),
      iso({ flakyOnMain: [{ file: 'a', tests: Array.from({ length: 41 }, (_, i) => t({ test: `t${i}` })) }] }),
      iso({ flakyOnMain: [{ file: 'a', tests: [t({ test: '' })] }] }),
      iso({ flakyOnMain: [{ file: 'a', tests: [t({ test: 'n'.repeat(301) })] }] }),
      iso({ flakyOnMain: [{ file: 'a', tests: [t({ at: 'yesterday' })] }] }),
      iso({ flakyOnMain: [{ file: 'a', tests: [t({ line: 'x'.repeat(401) })] }] }),
      iso({ flakyOnMain: [{ file: 'a', tests: [t({ setHash: 'nope' })] }] }),
      iso({ flakyOnMain: [{ file: 'a', tests: [t({ runLog: '../../etc/passwd' })] }] }),
      iso({ flakyOnMain: [{ file: 'a', tests: [t({ lineCut: false })] }] }),
      iso({ flakyOnMain: [{ file: 'a', tests: [t()], namesCut: false }] }),
      iso({ flakyOnMain: [{ file: 'a', tests: [t()], extra: 1 }] }),
      iso({ flakyOnMain: [{ file: 'a', tests: [t({ extra: 1 })] }] }),
      iso({ flakyOnMain: [null] }),
    ];
    for (const b of bad) expect(parse(b), JSON.stringify(b).slice(0, 100)).toBeNull();
    expect(parse(iso({ flakyOnMain: files(200) }))).toBeTruthy();
  });
  it('strict keys inside isolation only when importRelatedRerun is present; without it the block parses as today', () => {
    expect(parse(iso({ surprise: 1 }))).toBeNull();
    expect(parse({ allowed: true, notCleanOnGreenMain: [], surprise: 1 })).toBeTruthy();
    expect(parse({ allowed: true, notCleanOnGreenMain: [], flakyOnMain: [] })).toBeTruthy(); // not read without the switch field (as today: unknown keys pass)
  });
  it('isolation stays refused on both main kinds', () => {
    for (const kind of ['main', 'main-arbitration'] as const) {
      const req = { ...runReq({ pr: 0, baseSha: sha('a'), kind }) };
      expect(parsePeerRunRequest(req)).toBeTruthy();
      expect(parsePeerRunRequest({ ...req, isolation: iso() })).toBeNull();
      expect(parsePeerRunRequest({ ...req, isolation: { allowed: true, notCleanOnGreenMain: [] } })).toBeNull();
    }
  });
});

describe('importRefusal — a clear the coordinator did not offer', () => {
  const ctx = { repo: REPO, verifierVersion: '1.0.0', policyHash: POLICY, holdsLease: true, leaseEpoch: 7, coordinatorMachineId: 'coord' };
  const HASH = 'ab'.repeat(32);
  const ev = (test: string) => ({ test, mainAt: '2026-10-20T10:00:00.000Z', mainLine: 'Error: x', prLine: 'Error: x', mainRunLog: 'a'.repeat(32) + '.log' });
  const cleared = (file: string, tests: string[]) => record({
    attempt: { id: ATT, coordinatorMachineId: 'coord', leaseEpoch: 7 },
    flakyRetried: [{ file, lane: 'unit', firstMessage: 'boom', importRelated: true, failedTests: tests, failedTestsTotal: tests.length, soloPassedByName: tests, testSetHash: HASH, soloPasses: 3, soloSeconds: [1, 1, 1], evidence: tests.map(ev) } as never],
  });
  const offered = [{ file: 'tests/unit/a.test.ts', tests: ['s one', 's two'] }];
  it('accepts an offered clear', () => {
    expect(importRefusal(cleared('tests/unit/a.test.ts', ['s one']), marker({ offeredFlakyOnMain: offered } as never), ctx)).toBeNull();
    expect(importRefusal(cleared('tests/unit/a.test.ts', ['s one', 's two']), marker({ offeredFlakyOnMain: offered } as never), ctx)).toBeNull();
  });
  it('refuses an unoffered file, an unoffered test name, and any clear when the marker has no valid list', () => {
    expect(importRefusal(cleared('tests/unit/other.test.ts', ['s one']), marker({ offeredFlakyOnMain: offered } as never), ctx)).toBe('import-related-not-offered');
    expect(importRefusal(cleared('tests/unit/a.test.ts', ['s one', 's three']), marker({ offeredFlakyOnMain: offered } as never), ctx)).toBe('import-related-not-offered');
    expect(importRefusal(cleared('tests/unit/a.test.ts', ['s one']), marker(), ctx)).toBe('import-related-not-offered');
    for (const broken of ['x', [{ file: 1, tests: [] }], [{ file: 'tests/unit/a.test.ts', tests: 'all' }], { file: 'tests/unit/a.test.ts' }]) {
      expect(importRefusal(cleared('tests/unit/a.test.ts', ['s one']), marker({ offeredFlakyOnMain: broken } as never), ctx)).toBe('import-related-not-offered');
    }
  });
  it('a record without an import-related clear is imported whatever the marker holds (plain flaky entries are not bound to the list)', () => {
    const plain = record({ attempt: { id: ATT, coordinatorMachineId: 'coord', leaseEpoch: 7 }, flakyRetried: [{ file: 'tests/unit/z.test.ts', lane: 'unit', firstMessage: 'boom', failedTests: ['q'], failedTestsTotal: 1, soloPassedByName: ['q'], testSetHash: HASH } as never] });
    expect(importRefusal(plain, marker(), ctx)).toBeNull();
    expect(importRefusal(plain, marker({ offeredFlakyOnMain: 'x' } as never), ctx)).toBeNull();
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

/** The fake peer's machine key, pinned on the coordinator (SEC-113 D1). */
const PEER_KEYS = generateSigningKeyPair();
const PEER_KEY_HASH = signerKeyHashOf(PEER_KEYS.publicKey);
const peerSigner = (machineId = 'peer1'): MachineSigner => ({
  machineId: () => machineId,
  signerKeyHash: () => PEER_KEY_HASH,
  sign: (payload) => ({ machineId, signerKeyHash: PEER_KEY_HASH, sig: edSign(payload, PEER_KEYS.privateKey) }),
});
/** The coordinator's pinned-key lookup: every peer machine id signs with PEER_KEYS. */
const pinnedPeerKeys = (): MachineKeyLookup => (_machineId, hash) => hash === PEER_KEY_HASH ? { status: 'ok', publicKeyPem: PEER_KEYS.publicKey } : { status: 'unknown' };

/** A fake peer the coordinator talks to. Like a real peer, it signs each finished answer over the request it received. */
function fakePeer() {
  const calls: Array<{ kind: string; arg?: unknown }> = [];
  const received = new Map<string, PeerRunRequest>();
  let signAs: string | null = 'peer1';
  let status: PeerStatus | null = { inFlight: null, verifierVersion: '1.0.0', policyHash: POLICY, slotBusy: false, signerKeyHash: PEER_KEY_HASH };
  let runAnswer: (req: PeerRunRequest) => PeerRunAnswer | null = (req) => ({ ok: true, attemptId: req.attemptId });
  let resultFor: (id: string) => PeerResult | null | Promise<PeerResult | null> = () => ({ state: 'running' });
  let queueAtSend: unknown = null;
  let readQueue: (() => unknown) | null = null;
  const client: PeerClient = {
    status: async () => { calls.push({ kind: 'status' }); return status; },
    run: async (_p, req) => { calls.push({ kind: 'run', arg: req }); received.set(req.attemptId, JSON.parse(JSON.stringify(req))); queueAtSend = readQueue?.(); return runAnswer(req); },
    result: async (p, id) => {
      calls.push({ kind: 'result', arg: id });
      const r = await resultFor(id);
      const req = received.get(id);
      if (!r || r.state !== 'done' || !req || !signAs || r.sig) return r;
      const digest = requestDigest(req);
      return { ...r, requestDigest: digest, sig: signPeerResult(peerSigner(signAs === 'self' ? p.machineId : signAs), { record: r.record, run: r.run, requestDigest: digest }) };
    },
    cancel: async (_p, id) => { calls.push({ kind: 'cancel', arg: id }); },
  };
  return {
    client, calls,
    setStatus: (s: PeerStatus | null) => { status = s; },
    setRun: (f: typeof runAnswer) => { runAnswer = f; },
    setResult: (f: typeof resultFor) => { resultFor = f; },
    /** Who signs answers: a machine id, 'self' (the peer it was asked as), or null (unsigned). */
    signAs: (m: string | null) => { signAs = m; },
    /** A peer that already received this request before a restart (its persisted digest). */
    prime: (req: PeerRunRequest) => { received.set(req.attemptId, JSON.parse(JSON.stringify(req))); },
    watchQueue: (f: () => unknown) => { readQueue = f; },
    queueAtSend: () => queueAtSend,
    runs: () => calls.filter((c) => c.kind === 'run').map((c) => c.arg as PeerRunRequest),
  };
}

import { generateSigningKeyPair, sign as edSign } from '../../../src/core/MachineIdentity.js';
import { signerKeyHashOf, type MachineKeyLookup, type MachineSigner } from '../../../src/core/AppRecordSignatures.js';
import { requestDigest, signPeerResult } from '../../../src/localVerify/peerResultSignature.js';
import { registerLocalVerifyRestartHold, updatePendingFromAutoUpdater } from '../../../src/localVerify/localVerifyWiring.js';
import { AutoUpdater } from '../../../src/core/AutoUpdater.js';
import type { UpdateChecker } from '../../../src/core/UpdateChecker.js';
import type { StateManager } from '../../../src/core/StateManager.js';

/**
 * SEC-113 D2.3: a coordinator that has run main itself before: a local anchor on an earlier head and
 * ten measured local main runs (10 minutes each), so peers may serve main until the refresh age.
 */
function seedLocalAnchor(stateDir: string, epoch = 7): void {
  const file = path.join(stateDir, 'state', 'local-verify', 'peer-trust.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ v: 1, holding: { holder: 'coord', epoch }, anchor: { head: 'f'.repeat(40), finishedAt: '2026-10-21T11:00:00.000Z' },
    notLocallyVerifiedAt: null, locallyVerified: ['f'.repeat(40)], peerMainGreens: [], quarantine: {}, arbitration: null, durations: Array.from({ length: 10 }, () => 10 * 60_000) }));
}

function coordinator(opts: { epoch?: number; holds?: boolean; mainOnPeers?: boolean; noAnchor?: boolean } = {}) {
  const h = harness();
  if (!opts.noAnchor) seedLocalAnchor(h.stateDir, opts.epoch ?? 7);
  const peer = fakePeer();
  let epoch = opts.epoch ?? 7;
  let holds = opts.holds ?? true;
  let mainOnPeers = opts.mainOnPeers ?? false;
  h.svc.setPeerWiring({
    peers: () => [{ machineId: 'peer1', url: 'http://peer1:4042' }],
    client: peer.client,
    lease: { holdsLease: () => holds, leaseEpoch: () => epoch, holderMachineId: () => 'coord' },
    mainOnPeers: () => mainOnPeers,
    keyLookupFactory: pinnedPeerKeys,
  });
  peer.watchQueue(() => h.queueFile());
  return { ...h, peer, setEpoch: (e: number) => { epoch = e; }, setHolds: (v: boolean) => { holds = v; }, setMainOnPeers: (v: boolean) => { mainOnPeers = v; } };
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

  describe('signed answers (SEC-113 D1)', () => {
    const entry2 = (c: Awaited<ReturnType<typeof dispatched>>['c']) => c.queueFile().entries.find((e: { pr: number }) => e.pr === 2) as { remote?: unknown; remoteAttempts?: number } | undefined;

    it('an unsigned answer is refused, counted against the peer, and the PR is not sent to a peer again', async () => {
      const { c, req } = await dispatched();
      c.peer.signAs(null);
      c.peer.setResult(() => ({ state: 'done', record: peerRecord(req) }));
      await c.svc.tick();
      expect(c.svc.getRecord(2, sha('c'), 'main')).toBeNull();
      expect(entry2(c)?.remote).toBeUndefined();
      expect(entry2(c)?.remoteAttempts).toBe(PEER_LIMITS.maxAttemptsPerEntry);
      await c.runTimers();
      expect(c.peer.runs().filter((r) => r.pr === 2)).toHaveLength(1);
    });

    it('an answer signed by another machine, or with an outcome edited after signing, is refused and raises one item', async () => {
      const { c, req } = await dispatched();
      c.peer.signAs('m_intruder');
      c.peer.setResult(() => ({ state: 'done', record: peerRecord(req) }));
      await c.svc.tick();
      expect(c.svc.getRecord(2, sha('c'), 'main')).toBeNull();
      expect(c.signals.filter((k) => k.startsWith('local-verify:peer-result-unverified'))).toHaveLength(0); // wrong machine is a fault, not a failed check
    });

    it('a tampered answer (flaky list added after the peer signed) opens the breaker at once and raises the unverified item', async () => {
      const { c, req } = await dispatched();
      c.peer.setResult(() => ({ state: 'done', record: peerRecord(req) }));
      const inner = c.peer.client.result;
      c.peer.client.result = async (p, id) => {
        const r = await inner(p, id);
        return r && r.state === 'done' ? { ...r, record: { ...r.record, flakyRetried: [{ file: 'tests/unit/x.test.ts', lane: 'unit', firstMessage: 'm' }] } } : r;
      };
      await c.svc.tick();
      expect(c.svc.getRecord(2, sha('c'), 'main')).toBeNull();
      expect(c.signals).toContain('local-verify:peer-result-unverified:peer1');
    });

    it('a request loosened on the way is refused even when the peer signs honestly', async () => {
      const { c, req } = await dispatched();
      c.peer.prime({ ...req, preflightRediscoverable: true });
      c.peer.setResult(() => ({ state: 'done', record: peerRecord(req) }));
      await c.svc.tick();
      expect(c.svc.getRecord(2, sha('c'), 'main')).toBeNull();
      expect(c.signals).toContain('local-verify:peer-result-unverified:peer1');
    });

    it('a peer whose signing key is not pinned here is never sent work', async () => {
      const c = coordinator();
      c.peer.setStatus({ inFlight: null, verifierVersion: '1.0.0', policyHash: POLICY, slotBusy: false, signerKeyHash: 'f'.repeat(64) });
      await c.svc.request(1);
      await c.svc.request(2);
      await c.runTimers();
      expect(c.peer.runs()).toHaveLength(0);
    });

    it('a verifier-version skew across an upgrade is refused without counting against the peer', async () => {
      const { c, req } = await dispatched();
      c.peer.setResult(() => ({ state: 'done', record: peerRecord(req, { verifierVersion: '2.0.0' }) }));
      await c.svc.tick();
      expect(c.svc.getRecord(2, sha('c'), 'main')).toBeNull();
      const lines = fs.readFileSync(path.join(c.stateDir, 'logs', 'local-verify.jsonl'), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { event: string; why?: string });
      expect(lines.some((e) => e.event === 'peer-breaker-open')).toBe(false);
    });
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

  it('keeps an imported peer record\'s flaky list on the record, but out of flaky history and flaky items (SEC-113 D2.1)', async () => {
    const { c, req } = await dispatched();
    c.peer.setResult(() => ({ state: 'done', record: peerRecord(req, {
      flakyRetried: [{ file: 'tests/e2e/unstable.test.ts', lane: 'e2e', firstMessage: 'intermittent failure' }],
    }) }));
    await c.svc.tick();
    expect(c.svc.getRecord(2, sha('c'), 'main')?.flakyRetried).toHaveLength(1);
    expect(c.signals).not.toContain('local-verify:flaky:tests/e2e/unstable.test.ts');
    expect(Object.keys(c.svc.flakyFiles())).not.toContain('tests/e2e/unstable.test.ts');
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

  it('a lease epoch change abandons the attempt and imports nothing', async () => {
    const { c, req } = await dispatched();
    c.setEpoch(8);
    c.peer.setResult(() => ({ state: 'done', record: peerRecord(req) }));
    await c.svc.tick();
    expect(c.svc.getRecord(2, sha('c'), 'main')).toBeNull();
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
    peer2.prime(req);
    peer2.setResult(() => ({ state: 'done', record: peerRecord(req) }));
    h2.svc.setPeerWiring({ peers: () => [{ machineId: 'peer1', url: 'http://peer1:4042' }], client: peer2.client, lease: { holdsLease: () => true, leaseEpoch: () => 7, holderMachineId: () => 'coord' }, keyLookupFactory: pinnedPeerKeys });
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
      if (change === 'epoch') c.setEpoch(8); else c.setHolds(false);
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
    a.c.setEpoch(8);
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

describe('import-related re-run across two machines (spec local-verify-import-related-rerun.md, Peer safety)', () => {
  const X = 'tests/unit/x.test.ts';
  const HASH = 'ab'.repeat(32);
  const NOW = '2026-10-21T12:00:00.000Z';
  const seedEvidence = (stateDir: string) => {
    const file = path.join(stateDir, 'state', 'local-verify', 'flaky-history.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ v: 1, greenMain: { headSha: sha('9'), finishedAt: NOW, notClean: [], origin: 'local' },
      files: { [X]: { seen: [NOW], escalatedAt: null, mainSeen: [
        { test: 's flaky', at: NOW, line: 'Error: main boom', setHash: HASH, runLog: 'cd'.repeat(16) + '.log' },
        { test: 's other', at: NOW, line: 'Error: other', setHash: HASH, runLog: 'cd'.repeat(16) + '.log' },
      ] } } }));
  };
  async function dispatchedWith(on: boolean) {
    const c = coordinator();
    seedEvidence(c.stateDir);
    c.svc.setImportRelatedRerunEnabled(() => on);
    await c.svc.request(1);
    await c.svc.request(2);
    await c.runTimers();
    return { c, req: c.peer.runs()[0] };
  }
  const ev = (test: string) => ({ test, mainAt: NOW, mainLine: 'Error: main boom', prLine: 'Error: pr boom', mainRunLog: 'cd'.repeat(16) + '.log' });
  const clearOf = (req: PeerRunRequest, file: string, tests: string[]) => record({
    pr: req.pr, headSha: req.headSha, baseSha: req.baseSha, machineId: 'peer1', startedAt: new Date(Date.parse(NOW) + 60_000).toISOString(),
    attempt: { id: req.attemptId, coordinatorMachineId: 'coord', leaseEpoch: 7 },
    flakyRetried: [{ file, lane: 'unit', firstMessage: 'boom', importRelated: true, failedTests: tests, failedTestsTotal: tests.length, soloPassedByName: tests, testSetHash: HASH, soloPasses: 3, soloSeconds: [1, 1, 1], evidence: tests.map(ev) } as never],
  });
  const audit = (dir: string) => fs.readFileSync(path.join(dir, 'logs', 'local-verify.jsonl'), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

  it('the dispatch carries the switch and the list, and the marker holds the same files and names before it is persisted', async () => {
    const { c, req } = await dispatchedWith(true);
    expect(parsePeerRunRequest(JSON.parse(JSON.stringify(req)))).toBeTruthy(); // what is sent is what the peer parser accepts
    expect(req.isolation).toMatchObject({ allowed: true, importRelatedRerun: true });
    expect(req.isolation!.flakyOnMain).toEqual([{ file: X, tests: [expect.objectContaining({ test: 's flaky', setHash: HASH }), expect.objectContaining({ test: 's other' })] }]);
    const atSend = c.peer.queueAtSend() as { entries: Array<{ pr: number; remote?: { state: string; offeredFlakyOnMain?: unknown; dispatched: Record<string, unknown> } }> };
    const remote = atSend.entries.find((e) => e.pr === 2)!.remote!;
    expect(remote.state).toBe('sending');
    expect(remote.offeredFlakyOnMain).toEqual([{ file: X, tests: ['s flaky', 's other'] }]); // names only, no failure lines
    expect(Object.keys(remote.dispatched)).not.toContain('offeredFlakyOnMain'); // beside `dispatched`, never inside it
  });

  it('switch off on the coordinator: the block says off, the list is empty and the marker keeps none', async () => {
    const { c, req } = await dispatchedWith(false);
    expect(req.isolation).toEqual({ allowed: true, notCleanOnGreenMain: [], importRelatedRerun: false, flakyOnMain: [] });
    const atSend = c.peer.queueAtSend() as { entries: Array<{ pr: number; remote?: Record<string, unknown> }> };
    expect(atSend.entries.find((e) => e.pr === 2)!.remote!.offeredFlakyOnMain).toBeUndefined();
  });

  it('an offered clear is imported; a clear of an unoffered test or file is rejected, the attempt abandoned and the PR verified again', async () => {
    const good = await dispatchedWith(true);
    good.c.peer.setResult(() => ({ state: 'done', record: clearOf(good.req, X, ['s flaky']) }));
    await good.c.svc.tick();
    expect(good.c.svc.getRecord(2, sha('c'), 'main')?.flakyRetried?.[0]).toMatchObject({ importRelated: true, failedTests: ['s flaky'] });

    for (const [file, tests] of [[X, ['s flaky', 's invented']], ['tests/unit/elsewhere.test.ts', ['s flaky']]] as Array<[string, string[]]>) {
      const bad = await dispatchedWith(true);
      bad.c.peer.setResult(() => ({ state: 'done', record: clearOf(bad.req, file, tests) }));
      await bad.c.svc.tick();
      expect(bad.c.svc.getRecord(2, sha('c'), 'main')).toBeNull();
      expect(audit(bad.c.stateDir).find((l) => l.event === 'peer-record-rejected')).toMatchObject({ pr: 2, reason: 'import-related-not-offered' });
      const e = bad.c.svc.snapshot().queue.find((x) => x.pr === 2)!;
      expect(e.remote).toBeUndefined(); // back in the queue: it is verified again
    }
  });

  it('a coordinator with its switch off imports no import-related clear at all (nothing was offered)', async () => {
    const { c, req } = await dispatchedWith(false);
    c.peer.setResult(() => ({ state: 'done', record: clearOf(req, X, ['s flaky']) }));
    await c.svc.tick();
    expect(c.svc.getRecord(2, sha('c'), 'main')).toBeNull();
    expect(audit(c.stateDir).find((l) => l.event === 'peer-record-rejected')).toMatchObject({ reason: 'import-related-not-offered' });
  });

  describe('peer side', () => {
    const notHolder = { holdsLease: false, holderMachineId: 'coord' };
    const sent = { allowed: true, notCleanOnGreenMain: [], importRelatedRerun: true, flakyOnMain: [{ file: X, tests: [{ test: 's flaky', at: NOW, line: 'Error: main boom', setHash: HASH, runLog: 'cd'.repeat(16) + '.log' }] }] };
    const childIso = async (peerSwitch: boolean | null, isolation: unknown) => {
      const h = harness({ peerOnly: true, machineId: 'peer1' });
      h.svc.setPeerWiring({ peerRoleEnabled: () => true });
      if (peerSwitch !== null) h.svc.setImportRelatedRerunEnabled(() => peerSwitch);
      expect(await h.svc.peerRun(parsePeerRunRequest({ ...runReq({ baseSha: sha('7') }), isolation })!, notHolder)).toEqual({ ok: true, attemptId: ATT });
      return (JSON.parse(fs.readFileSync(h.spawned[0].inputPath, 'utf-8')) as { isolation: unknown }).isolation;
    };
    it('applies the rule only when the received block enables it AND its own switch is on', async () => {
      expect(await childIso(true, sent)).toEqual(sent);
      // Own switch off, or never wired: the rule is passed off with an empty list.
      expect(await childIso(false, sent)).toEqual({ allowed: true, notCleanOnGreenMain: [], importRelatedRerun: false, flakyOnMain: [] });
      expect(await childIso(null, sent)).toEqual({ allowed: true, notCleanOnGreenMain: [], importRelatedRerun: false, flakyOnMain: [] });
      // Own switch on but the coordinator's off: off. The peer never computes a list of its own.
      expect(await childIso(true, { ...sent, importRelatedRerun: false })).toEqual({ allowed: true, notCleanOnGreenMain: [], importRelatedRerun: false, flakyOnMain: [] });
      // A block in the older shape is passed through as it came.
      expect(await childIso(true, { allowed: true, notCleanOnGreenMain: ['tests/e2e/a.test.ts'] })).toEqual({ allowed: true, notCleanOnGreenMain: ['tests/e2e/a.test.ts'] });
    });
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

  it('a failed peer run writes why it failed to this machine\'s audit log; a green one writes no detail', async () => {
    const lines = (dir: string) => fs.readFileSync(path.join(dir, 'logs', 'local-verify.jsonl'), 'utf-8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l) as { event: string; source?: string; attemptId?: string; pr?: number; outcome?: string; reasons?: string[]; failures?: Array<{ file: string; message: string }> });
    const attempt = { id: ATT, coordinatorMachineId: 'coord', leaseEpoch: 7 };

    const red = peerSide();
    await red.svc.peerRun(runReq(), notHolder);
    await red.finish(0, {
      kind: 'record', record: record({ machineId: 'peer1', attempt, outcome: 'failure' }), overlaps: [], keptWorktree: null,
      reasons: ['lane-failed:unit:1'], failures: [{ file: 'tests/unit/x.test.ts', lane: 'unit', failed: 0, message: 'Unhandled Rejection: boom' }],
    } as unknown as VerifyRunResult);
    const detail = lines(red.stateDir).filter((l) => l.event === 'run-detail');
    expect(detail).toHaveLength(1);
    expect(detail[0]).toMatchObject({ source: 'peer-run', attemptId: ATT, pr: 1, outcome: 'failure', reasons: ['lane-failed:unit:1'] });
    expect(detail[0].failures?.[0]).toMatchObject({ file: 'tests/unit/x.test.ts', message: 'Unhandled Rejection: boom' });

    // A crash (no result) is an error record: detail is written, with nothing to name.
    const crashed = peerSide();
    await crashed.svc.peerRun(runReq(), notHolder);
    await crashed.finish(0, null);
    expect(lines(crashed.stateDir).filter((l) => l.event === 'run-detail')).toMatchObject([{ source: 'peer-run', outcome: 'error', reasons: [], failures: [] }]);

    const green = peerSide();
    await green.svc.peerRun(runReq(), notHolder);
    await green.finish(0, ok(record({ machineId: 'peer1', attempt })));
    expect(lines(green.stateDir).some((l) => l.event === 'run-detail')).toBe(false);
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
      keyLookupFactory: pinnedPeerKeys,
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

// ── a `main` verify on a peer ──────────────────────────────────────────

describe('a main verify on whichever host is free', () => {
  const HEAD = sha('d');
  const mainReq = (over: Partial<PeerRunRequest> = {}): PeerRunRequest => runReq({ pr: 0, headSha: HEAD, baseSha: HEAD, kind: 'main', ...over });
  const mainRecord = (req: PeerRunRequest, over: Partial<LocalVerifyRecord> = {}) => record({
    pr: 0, kind: 'main', headSha: req.headSha, baseSha: req.baseSha, machineId: 'peer1',
    startedAt: new Date(Date.parse('2026-10-21T12:00:00.000Z') + 60_000).toISOString(),
    attempt: { id: req.attemptId, coordinatorMachineId: 'coord', leaseEpoch: 7 }, ...over,
  });
  /** main queued while another suite holds the coordinator's slot, then handed to the idle peer. */
  async function mainOnPeer() {
    const c = coordinator({ mainOnPeers: true });
    c.setForeignHolders([9001]);
    c.svc.noteMainHead(HEAD);
    await c.runTimers();
    return { c, req: c.peer.runs()[0] };
  }

  describe('bounded peer authority (SEC-113 D2)', () => {
    const trustFile = (dir: string) => path.join(dir, 'state', 'local-verify', 'peer-trust.json');
    const trustOf = (dir: string) => JSON.parse(fs.readFileSync(trustFile(dir), 'utf-8')) as { anchor: { head: string } | null; quarantine: Record<string, unknown>; notLocallyVerifiedAt: number | null };
    const auditsOf = (dir: string) => fs.readFileSync(path.join(dir, 'logs', 'local-verify.jsonl'), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { event: string; peer?: string });
    const H = 60 * 60_000;
    /** A peer green on HEAD imported; main healthy; only the second clock remains (HEAD is not this machine's own). */
    async function peerGreen() {
      const { c, req } = await mainOnPeer();
      c.peer.setResult(() => ({ state: 'done', record: mainRecord(req) }));
      await c.svc.tick();
      await c.flush();
      expect(c.svc.mainHealth()).toMatchObject({ state: 'healthy', lastGreenHead: HEAD });
      return { c, req };
    }
    const mainRun = (c: Awaited<ReturnType<typeof peerGreen>>['c'], i: number, outcome: 'success' | 'failure') => {
      const input = JSON.parse(fs.readFileSync(c.spawned[i]!.inputPath, 'utf-8')) as { headSha: string };
      return c.finish(i, { kind: 'record', record: record({ pr: 0, kind: 'main', headSha: input.headSha, baseSha: input.headSha, machineId: 'coord', outcome,
        startedAt: new Date(c.now() - 10 * 60_000).toISOString(), finishedAt: new Date(c.now()).toISOString() }),
        reasons: outcome === 'failure' ? ['lane-failed:unit:1'] : [], overlaps: [], keptWorktree: null,
        ...(outcome === 'failure' ? { failures: [{ file: 'tests/unit/broken.test.ts', lane: 'unit', failed: 1, message: 'x' }] } : {}) } as unknown as VerifyRunResult);
    };

    it('a coordinator with no local anchor (fresh lease holder) never sends main to a peer', async () => {
      const c = coordinator({ mainOnPeers: true, noAnchor: true });
      c.setForeignHolders([9001]);
      c.svc.noteMainHead(HEAD);
      await c.runTimers();
      expect(c.peer.runs()).toHaveLength(0);
      expect(c.svc.snapshot().queue.filter((e) => e.kind === 'main').map((e) => !!e.remote)).toEqual([false]);
    });

    it('peer greens alone never carry main past 3 h after the first merge this machine has not verified', async () => {
      const { c } = await peerGreen();
      for (let i = 0; i < 4; i++) { c.advance(50 * 60_000); await c.svc.tick(); await c.flush(); }
      expect(c.svc.mainHealth().state).toBe('main-suspect');
    });

    it('past the refresh age the coordinator queues its own check of a head a peer already called green', async () => {
      const { c } = await peerGreen();
      c.advance(2.5 * H + 60_000);
      await c.svc.tick();
      expect(c.svc.snapshot().queue.filter((e) => e.kind === 'main').map((e) => [e.headSha, !!e.remote])).toEqual([[HEAD, false]]);
      expect(auditsOf(c.stateDir).some((e) => e.event === 'main-local-corroboration')).toBe(true);
      c.setForeignHolders([]);
      await c.svc.tick();
      await c.runTimers();
      expect(JSON.parse(fs.readFileSync(c.spawned[0]!.inputPath, 'utf-8'))).toMatchObject({ kind: 'main', headSha: HEAD });
      await mainRun(c, 0, 'success');
      await c.flush();
      expect(trustOf(c.stateDir)).toMatchObject({ anchor: { head: HEAD }, notLocallyVerifiedAt: null });
    });

    it('this machine\'s own red on the head a peer called green quarantines that peer and, with no third machine, tells the owner', async () => {
      const { c } = await peerGreen();
      c.advance(2.5 * H + 60_000);
      await c.svc.tick();
      c.setForeignHolders([]);
      await c.svc.tick();
      await c.runTimers();
      await mainRun(c, 0, 'failure'); // first strike: suspect, rerun queued
      await c.flush();
      await c.svc.tick();
      await c.runTimers();
      await mainRun(c, 1, 'failure'); // second strike: red
      await c.flush();
      expect(c.svc.mainHealth().state).toBe('main-red');
      expect(Object.keys(trustOf(c.stateDir).quarantine)).toEqual(['peer1']);
      expect(c.signals).toContain('local-verify:peer-main-disagreement:peer1');
      // The owner clears it.
      expect(c.svc.clearMainQuarantine('peer1', 'owner')).toEqual({ cleared: true });
      expect(trustOf(c.stateDir).quarantine).toEqual({});
    });

    it('when two peers called the same red head green, both are kept off main and the second is told to the owner at once', async () => {
      const { c } = await peerGreen();
      const t = (c.svc as unknown as { trust(): { peerMainGreens: Array<Record<string, unknown>> } }).trust();
      const g = t.peerMainGreens[0]!;
      t.peerMainGreens.push({ ...g, peer: 'peer2' });
      c.advance(2.5 * H + 60_000);
      await c.svc.tick();
      c.setForeignHolders([]);
      await c.svc.tick();
      await c.runTimers();
      await mainRun(c, 0, 'failure');
      await c.flush();
      await c.svc.tick();
      await c.runTimers();
      await mainRun(c, 1, 'failure');
      await c.flush();
      expect(Object.keys(trustOf(c.stateDir).quarantine).sort()).toEqual(['peer1', 'peer2']);
      expect(c.signals).toContain('local-verify:peer-main-disagreement:peer2');
    });

    it('a third machine\'s green on the same head lifts the quarantine without telling the owner, and never touches main health', async () => {
      const { c } = await peerGreen();
      c.peer.signAs('self');
      c.svc.setPeerWiring({ peers: () => [{ machineId: 'peer1', url: 'http://peer1:4042' }, { machineId: 'peer2', url: 'http://peer2:4042' }] });
      c.advance(2.5 * H + 60_000);
      await c.svc.tick();
      c.setForeignHolders([]);
      await c.svc.tick();
      await c.runTimers();
      await mainRun(c, 0, 'failure');
      await c.flush();
      await c.svc.tick();
      await c.runTimers();
      await mainRun(c, 1, 'failure');
      await c.flush();
      expect(Object.keys(trustOf(c.stateDir).quarantine)).toEqual(['peer1']);
      const arb = c.peer.runs().find((r) => r.kind === 'main-arbitration');
      expect(arb).toMatchObject({ pr: 0, headSha: HEAD, baseSha: HEAD });
      // The arbitration answer names flaky tests: it settles the disagreement and reaches no flaky history (never main evidence).
      c.peer.setResult((id) => (id === arb!.attemptId ? { state: 'done', record: record({ pr: 0, kind: 'main', headSha: HEAD, baseSha: HEAD, machineId: 'peer2',
        attempt: { id: arb!.attemptId, coordinatorMachineId: 'coord', leaseEpoch: 7 },
        flakyRetried: [{ file: 'tests/unit/arb.test.ts', lane: 'unit', firstMessage: 'boom', failedTests: ['s flaky'], failedTestsTotal: 1, soloPassedByName: ['s flaky'], testSetHash: 'ab'.repeat(32) }] as never }) } : { state: 'running' }));
      await c.svc.tick();
      await c.flush();
      const histFile = path.join(c.stateDir, 'state', 'local-verify', 'flaky-history.json');
      const histFiles = fs.existsSync(histFile) ? (JSON.parse(fs.readFileSync(histFile, 'utf-8')) as { files: Record<string, unknown> }).files : {};
      expect(histFiles['tests/unit/arb.test.ts']).toBeUndefined();
      expect(Object.keys(c.svc.flakyFiles())).not.toContain('tests/unit/arb.test.ts');
      expect(trustOf(c.stateDir).quarantine).toEqual({});
      expect(c.signals).not.toContain('local-verify:peer-main-disagreement:peer1');
      expect(c.svc.mainHealth().state).toBe('main-red'); // the coordinator's own red stands
    });

    it('a restart while holding (epoch + 1) keeps the anchor; an epoch gap of 2 (another holder in between) resets it', async () => {
      const c = coordinator({ mainOnPeers: true });
      await c.svc.tick();
      c.setEpoch(8);
      await c.svc.tick();
      expect(trustOf(c.stateDir).anchor).not.toBeNull();
      c.setEpoch(10);
      await c.svc.tick();
      expect(trustOf(c.stateDir).anchor).toBeNull();
      expect(auditsOf(c.stateDir).some((e) => e.event === 'peer-trust-holding-lost')).toBe(true);
    });
  });

  describe('the request and the record (pure)', () => {
    it('accepts a main request only in its exact shape', () => {
      expect(parsePeerRunRequest(mainReq())).not.toBeNull();
      expect(parsePeerRunRequest(mainReq({ pr: 1 }))).toBeNull();
      expect(parsePeerRunRequest(mainReq({ baseSha: sha('b') }))).toBeNull();
      expect(parsePeerRunRequest(mainReq({ baseRefName: 'release' }))).toBeNull();
      expect(parsePeerRunRequest(mainReq({ preflightRediscoverable: true }))).toBeNull();
      expect(parsePeerRunRequest(mainReq({ isolation: { allowed: true, notCleanOnGreenMain: [] } }))).toBeNull();
      expect(parsePeerRunRequest({ ...mainReq(), kind: 'other' })).toBeNull();
      // A PR request still needs a real PR number, with or without the new key.
      expect(parsePeerRunRequest(runReq({ pr: 0 }))).toBeNull();
      expect(parsePeerRunRequest(runReq())).not.toBeNull();
    });
    it('imports a main record only for a main dispatch, and a PR record only for a PR dispatch', () => {
      const ctx = { repo: REPO, verifierVersion: '1.0.0', policyHash: POLICY, holdsLease: true, leaseEpoch: 7, coordinatorMachineId: 'coord' };
      const m = marker({ dispatched: { pr: 0, headSha: HEAD, baseSha: HEAD, baseRefName: 'main', verifierVersion: '1.0.0', policyHash: POLICY, kind: 'main' } });
      const rec = mainRecord(mainReq());
      expect(importRefusal(rec, m, ctx)).toBeNull();
      expect(importRefusal({ ...rec, attempt: undefined }, m, ctx)).toBe('no-attempt');
      expect(importRefusal(record({ attempt: { id: ATT, coordinatorMachineId: 'coord', leaseEpoch: 7 } }), m, ctx)).toBe('wrong-kind');
      expect(importRefusal(rec, marker(), ctx)).toBe('wrong-kind');
    });
    it('bounds and shape-checks the failure detail a peer sends with a red main', () => {
      expect(parsePeerMainRun(undefined)).toBeUndefined();
      expect(parsePeerMainRun({ reasons: [], failures: [] })).toBeUndefined();
      const many = Array.from({ length: 80 }, (_, i) => ({ file: `tests/unit/f${i}.test.ts`, lane: 'unit', failed: 1, message: 'x'.repeat(5000) }));
      const run = parsePeerMainRun({ reasons: ['unit lane failed', 7, ''], failures: [...many, { file: 5 }, null, { file: '' }] })!;
      expect(run.reasons).toEqual(['unit lane failed']);
      expect(run.failures).toHaveLength(30);
      expect(run.failures[0]).toEqual({ file: 'tests/unit/f0.test.ts', lane: 'unit', failed: 1, message: 'x'.repeat(2000) });
    });
  });

  describe('coordinator', () => {
    it('hands a waiting main verify to an idle peer when its own slot is taken, with the reservation saved before the send', async () => {
      const { c, req } = await mainOnPeer();
      expect(c.spawned).toHaveLength(0);
      expect(req).toMatchObject({ pr: 0, kind: 'main', headSha: HEAD, baseSha: HEAD, baseRefName: 'main', coordinatorMachineId: 'coord' });
      expect(req.isolation).toBeUndefined(); // a main verify has no isolation input
      const atSend = c.peer.queueAtSend() as { entries: Array<{ kind?: string; pr: number; remote?: { attemptId: string; state: string; dispatched: { kind?: string } } }> };
      expect(atSend.entries).toEqual([expect.objectContaining({ kind: 'main', pr: 0, remote: expect.objectContaining({ attemptId: req.attemptId, state: 'sending', dispatched: expect.objectContaining({ kind: 'main' }) }) })]);
      expect(c.svc.mainHealth()).toMatchObject({ mainInFlight: HEAD, pendingMainHead: null });
    });

    it('fair share holds on the peer too: a waiting PR goes first until main is due, then main goes', async () => {
      const early = coordinator({ mainOnPeers: true });
      early.setForeignHolders([9001]);
      early.svc.noteMainHead(HEAD);
      await early.svc.request(1);
      await early.runTimers();
      expect(early.peer.runs().map((r) => r.pr)).toEqual([1]); // main not due: the PR takes the free peer

      const due = coordinator({ mainOnPeers: true });
      due.setForeignHolders([9001]);
      due.svc.noteMainHead(HEAD);
      await due.svc.request(1);
      due.advance(91 * 60_000); // past the fair-share window
      await due.runTimers();
      expect(due.peer.runs().map((r) => r.kind ?? r.pr)).toEqual(['main']);
      expect(due.svc.snapshot().queue.some((e) => e.pr === 1 && !e.remote)).toBe(true); // the PR keeps its place
    });

    it('a green main record from the peer feeds main health, never the PR index', async () => {
      const { c, req } = await mainOnPeer();
      c.peer.setResult(() => ({ state: 'done', record: mainRecord(req) }));
      await c.svc.tick();
      await c.flush();
      expect(c.svc.mainHealth()).toMatchObject({ state: 'healthy', lastGreenHead: HEAD, mainInFlight: null });
      expect(c.svc.snapshot().queue).toEqual([]);
      expect(c.svc.getRecord(0, HEAD, 'main')).toBeNull();
      expect(fs.existsSync(path.join(c.stateDir, 'state', 'local-verify', 'journal.jsonl'))).toBe(false);
    });

    it('a green main record from a peer never becomes the isolation baseline (SEC-113 D2.1)', async () => {
      const { c, req } = await mainOnPeer();
      c.peer.setResult(() => ({ state: 'done', record: mainRecord(req) }));
      await c.svc.tick();
      await c.flush();
      expect(c.svc.mainHealth().lastGreenHead).toBe(HEAD);
      expect(c.svc.isolationInput()).toEqual({ allowed: false, notCleanOnGreenMain: [], importRelatedRerun: false, flakyOnMain: [] });
    });

    it('a green main record from a peer that names flaky tests writes no main evidence (S2): nothing a peer returns can make a test eligible', async () => {
      const { c, req } = await mainOnPeer();
      c.svc.setImportRelatedRerunEnabled(() => true);
      const named = [{ file: 'tests/unit/x.test.ts', lane: 'unit', firstMessage: 'boom', failedTests: ['s flaky'], failedTestsTotal: 1, soloPassedByName: ['s flaky'], testSetHash: 'ab'.repeat(32) }];
      c.peer.setResult(() => ({ state: 'done', record: { ...mainRecord(req), flakyRetried: named as never } }));
      await c.svc.tick();
      await c.flush();
      expect(c.svc.mainHealth().lastGreenHead).toBe(HEAD); // the record itself was imported
      const file = path.join(c.stateDir, 'state', 'local-verify', 'flaky-history.json');
      const hist = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) as { files: Record<string, { mainSeen?: unknown }> } : { files: {} };
      expect(hist.files['tests/unit/x.test.ts']?.mainSeen).toBeUndefined();
      // Even with a local green baseline in place, the offered list stays empty.
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ v: 1, files: hist.files, greenMain: { headSha: HEAD, finishedAt: '2026-10-21T12:00:00.000Z', notClean: [], origin: 'local' } }));
      expect(c.svc.isolationInput()).toMatchObject({ allowed: true, importRelatedRerun: true, flakyOnMain: [] });
    });

    it('a green-main record written by older code (no origin) never enables isolation, even after later flaky writes (SEC-113 D2.1)', async () => {
      const c = coordinator();
      const file = path.join(c.stateDir, 'state', 'local-verify', 'flaky-history.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ v: 1, files: {}, greenMain: { headSha: HEAD, finishedAt: '2026-10-21T12:00:00.000Z', notClean: [] } }));
      expect(c.svc.isolationInput().allowed).toBe(false);
      fs.writeFileSync(file, JSON.stringify({ v: 1, files: {}, greenMain: { headSha: HEAD, finishedAt: '2026-10-21T12:00:00.000Z', notClean: [], origin: 'local' } }));
      expect(c.svc.isolationInput().allowed).toBe(true);
    });

    it('a green peer run covers merges by the coordinator\'s own clock and the first newer head, never the peer\'s clock', async () => {
      const { c, req } = await mainOnPeer();
      const obs = (c.svc as unknown as { mainObs: { oldestUnverifiedAt: number | null } }).mainObs;
      const dispatchedAt = Date.parse('2026-10-21T12:00:00.000Z');
      expect(obs.oldestUnverifiedAt).toBe(dispatchedAt);
      c.advance(60_000);
      c.svc.noteMainHead(sha('e')); // a merge the peer run does not contain, first seen one minute after dispatch
      c.advance(60_000);
      // The peer's clock runs an hour ahead.
      c.peer.setResult(() => ({ state: 'done', record: mainRecord(req, { startedAt: new Date(dispatchedAt + 60 * 60_000).toISOString(), finishedAt: new Date(dispatchedAt + 61 * 60_000).toISOString() }) }));
      await c.svc.tick();
      await c.flush();
      expect(c.svc.mainHealth().lastGreenHead).toBe(HEAD);
      // Unverified since the newer head was first seen: not cleared, and not the peer's future time.
      expect(obs.oldestUnverifiedAt).toBe(dispatchedAt + 60_000);
    });

    it('a red main record from the peer turns main suspect, keeps the failing files, and queues the re-run', async () => {
      const { c, req } = await mainOnPeer();
      c.peer.setResult(() => ({
        state: 'done', record: mainRecord(req, { outcome: 'failure' }),
        run: { reasons: ['unit lane failed'], failures: [{ file: 'tests/unit/broken.test.ts', lane: 'unit', failed: 1, message: 'expected 1 to be 2' }] },
      }));
      await c.svc.tick();
      await c.flush();
      expect(c.svc.mainHealth().state).toBe('main-suspect');
      const saved = JSON.parse(fs.readFileSync(path.join(c.stateDir, 'state', 'local-verify', 'main-failure.json'), 'utf-8')) as { detail: { headSha: string; files: string[] } };
      expect(saved.detail).toMatchObject({ headSha: HEAD, files: ['tests/unit/broken.test.ts'] });
      expect(c.svc.snapshot().queue.filter((e) => e.kind === 'main').map((e) => e.headSha)).toEqual([HEAD]); // the re-run of the failed head
      // The confirming re-run is the coordinator's own: a peer can make main suspect, never red.
      for (let i = 0; i < 4; i++) { c.advance(PEER_LIMITS.statusMs); await c.svc.tick(); await c.runTimers(); }
      expect(c.peer.runs()).toHaveLength(1);
      expect(c.svc.snapshot().peers.reserved).toEqual([]);
      c.setForeignHolders([]);
      await c.svc.tick();
      await c.runTimers();
      expect(c.spawned).toHaveLength(1);
      expect(JSON.parse(fs.readFileSync(c.spawned[0].inputPath, 'utf-8'))).toMatchObject({ kind: 'main', headSha: HEAD });
    });

    it('a record that arrives after main stopped being healthy is not judged in either direction: the coordinator runs it itself', async () => {
      for (const outcome of ['failure', 'success'] as const) {
        const { c, req } = await mainOnPeer();
        // Main turns suspect while the peer runs (here: the state file says so, as after a boot or a too-long-unverified alarm).
        const health = (c.svc as unknown as { health: { snapshot(): { state: string }; isHealthy(): boolean } }).health;
        const real = health.isHealthy.bind(health);
        health.isHealthy = () => false;
        c.peer.setResult(() => ({ state: 'done', record: mainRecord(req, { outcome }) }));
        await c.svc.tick();
        await c.flush();
        health.isHealthy = real;
        expect(c.svc.mainHealth().lastGreenHead).toBeNull(); // nothing was recorded
        expect(c.svc.mainHealth().state).toBe('healthy'); // and nothing turned suspect or red from it
        expect(c.svc.snapshot().queue.filter((e) => e.kind === 'main').map((e) => [e.headSha, !!e.remote])).toEqual([[HEAD, false]]);
        expect(fs.readFileSync(path.join(c.stateDir, 'logs', 'local-verify.jsonl'), 'utf-8')).toContain('"event":"peer-main-unjudged"');
      }
    });

    it('when main stops being healthy while a peer runs its verify, the run is taken back at the next poll and cancelled', async () => {
      const { c, req } = await mainOnPeer();
      const health = (c.svc as unknown as { health: { isHealthy(): boolean } }).health;
      health.isHealthy = () => false;
      c.advance(PEER_LIMITS.pollMs);
      await c.svc.tick(); // the peer answers "running"
      expect(c.svc.snapshot().peers.reserved).toEqual([]);
      expect(c.peer.calls.some((x) => x.kind === 'cancel' && x.arg === req.attemptId)).toBe(true);
      expect(c.signals.some((k) => k.startsWith('local-verify:peer-breaker:'))).toBe(false);
      // Not offered to the peer again while unhealthy: it waits for the coordinator's own slot.
      for (let i = 0; i < 3; i++) { await c.runTimers(); c.advance(PEER_LIMITS.statusMs); await c.svc.tick(); }
      expect(c.peer.runs()).toHaveLength(1);
      expect(c.svc.snapshot().queue.filter((e) => e.kind === 'main').map((e) => [e.headSha, !!e.remote])).toEqual([[HEAD, false]]);
    });

    it('a red main record whose failure detail is missing or malformed still turns main suspect, with no files named', async () => {
      const { c, req } = await mainOnPeer();
      c.peer.setResult(() => ({ state: 'done', record: mainRecord(req, { outcome: 'failure' }) }));
      await c.svc.tick();
      await c.flush();
      expect(c.svc.mainHealth().state).toBe('main-suspect');
      const saved = JSON.parse(fs.readFileSync(path.join(c.stateDir, 'state', 'local-verify', 'main-failure.json'), 'utf-8')) as { detail: { files: string[] } };
      expect(saved.detail.files).toEqual([]);
    });

    it('the switch is off unless set: main stays on the coordinator, and turning it off live stops new hand-outs', async () => {
      const off = coordinator();
      off.setForeignHolders([9001]);
      off.svc.noteMainHead(HEAD);
      for (let i = 0; i < 3; i++) { await off.runTimers(); off.advance(PEER_LIMITS.statusMs); await off.svc.tick(); }
      expect(off.peer.runs()).toHaveLength(0);
      expect(off.svc.snapshot().queue.filter((e) => e.kind === 'main' && !e.remote)).toHaveLength(1);

      const { c, req } = await mainOnPeer();
      c.setMainOnPeers(false); // a reserved attempt finishes as usual
      c.peer.setResult(() => ({ state: 'done', record: mainRecord(req) }));
      await c.svc.tick();
      await c.flush();
      expect(c.svc.mainHealth().lastGreenHead).toBe(HEAD);
      c.advance(60_000); c.svc.noteMainHead(sha('e')); c.advance(10 * 60_000); c.svc.noteMainHead(sha('e'));
      for (let i = 0; i < 3; i++) { await c.runTimers(); c.advance(PEER_LIMITS.statusMs); await c.svc.tick(); }
      expect(c.peer.runs()).toHaveLength(1); // nothing new went out
    });

    it('main is not offered to a peer while the coordinator runs a main verify itself', async () => {
      const c = coordinator({ mainOnPeers: true });
      c.svc.noteMainHead(HEAD); // free local slot: it starts here
      await c.runTimers();
      expect(c.spawned).toHaveLength(1);
      c.advance(60_000); c.svc.noteMainHead(sha('e')); c.advance(10 * 60_000); c.svc.noteMainHead(sha('e'));
      for (let i = 0; i < 3; i++) { await c.runTimers(); c.advance(PEER_LIMITS.statusMs); await c.svc.tick(); }
      expect(c.svc.snapshot().queue.filter((e) => e.kind === 'main').map((e) => e.headSha)).toEqual([sha('e')]);
      expect(c.peer.runs()).toHaveLength(0);
    });

    it('a peer that cannot confirm main three times in a row is offered no main verify for a while, with one signal', async () => {
      const c = coordinator({ mainOnPeers: true });
      c.setForeignHolders([9001]);
      c.peer.setRun((r) => (r.kind === 'main' ? { ok: false, reason: 'pr-unreadable' } : { ok: true, attemptId: r.attemptId }));
      c.svc.noteMainHead(HEAD);
      for (let i = 0; i < 4; i++) { await c.runTimers(); c.advance(PEER_LIMITS.statusMs); await c.svc.tick(); }
      expect(c.peer.runs()).toHaveLength(2); // the entry's two peer attempts
      // A newer head is a fresh entry: its first refusal is the third in a row.
      c.advance(60_000); c.svc.noteMainHead(sha('e')); c.advance(10 * 60_000); c.svc.noteMainHead(sha('e'));
      for (let i = 0; i < 4; i++) { await c.runTimers(); c.advance(PEER_LIMITS.statusMs); await c.svc.tick(); }
      expect(c.peer.runs()).toHaveLength(3);
      expect(c.signals.filter((k) => k === 'local-verify:peer-main-unconfirmed:peer1')).toHaveLength(1);
      expect(c.signals.some((k) => k.startsWith('local-verify:peer-breaker:'))).toBe(false);
      // Paused: the peer still takes PRs.
      await c.svc.request(1);
      for (let i = 0; i < 2; i++) { await c.runTimers(); c.advance(PEER_LIMITS.statusMs); await c.svc.tick(); }
      expect(c.peer.runs().map((r) => r.kind ?? r.pr)).toEqual(['main', 'main', 'main', 1]);
    });

    it('a second main reservation found in the saved queue is dropped and audited, never restored', async () => {
      const { c, req } = await mainOnPeer();
      c.svc.shutdown();
      const file = path.join(c.stateDir, 'state', 'local-verify', 'queue.json');
      const q = JSON.parse(fs.readFileSync(file, 'utf-8')) as { v: number; entries: Array<Record<string, unknown>> };
      const second = JSON.parse(JSON.stringify(q.entries[0])) as { headSha: string; baseSha: string; remote: { attemptId: string; dispatched: { headSha: string; baseSha: string } } };
      second.headSha = second.baseSha = second.remote.dispatched.headSha = second.remote.dispatched.baseSha = sha('e');
      second.remote.attemptId = 'f'.repeat(32);
      fs.writeFileSync(file, JSON.stringify({ v: 1, entries: [...q.entries, second] }));
      const h2 = harness({ stateDir: c.stateDir });
      h2.svc.setPeerWiring({ peers: () => [{ machineId: 'peer1', url: 'http://peer1:4042' }], client: fakePeer().client, lease: { holdsLease: () => true, leaseEpoch: () => 7, holderMachineId: () => 'coord' }, mainOnPeers: () => true });
      await h2.svc.boot();
      expect(h2.svc.snapshot().peers.reserved).toEqual([expect.objectContaining({ pr: 0, attemptId: req.attemptId })]);
      const audit = fs.readFileSync(path.join(c.stateDir, 'logs', 'local-verify.jsonl'), 'utf-8');
      expect(audit).toContain('"event":"queue-restore-dropped","kind":"main"');
    });

    it('a newer head never cancels the peer run: it queues behind it and does not start beside it', async () => {
      const { c, req } = await mainOnPeer();
      c.setForeignHolders([]); // the coordinator's own slot is free again
      c.advance(60_000);
      c.svc.noteMainHead(sha('e'));
      c.advance(10 * 60_000);
      c.svc.noteMainHead(sha('e'));
      await c.svc.tick();
      await c.runTimers();
      expect(c.peer.calls.some((x) => x.kind === 'cancel')).toBe(false);
      const mains = c.svc.snapshot().queue.filter((e) => e.kind === 'main');
      expect(mains.find((e) => e.remote)?.headSha).toBe(HEAD);
      expect(c.spawned).toHaveLength(0); // one main verify at a time, on either host
      // When the peer run ends green, the pending one may start.
      c.peer.setResult(() => ({ state: 'done', record: mainRecord(req) }));
      c.advance(PEER_LIMITS.pollMs);
      await c.svc.tick();
      await c.runTimers();
      expect(c.svc.mainHealth().lastGreenHead).toBe(HEAD);
      // ... and it does: the newer head now runs here (the peer is asked for nothing more).
      await c.flush();
      await c.runTimers();
      expect(c.spawned).toHaveLength(1);
      expect(JSON.parse(fs.readFileSync(c.spawned[0].inputPath, 'utf-8'))).toMatchObject({ kind: 'main', headSha: sha('e') });
    });

    it('a peer that goes silent gives the main verify back within minutes, not at the run bound', async () => {
      const { c, req } = await mainOnPeer();
      c.peer.setResult(() => null); // unreachable
      c.peer.setStatus(null);
      for (let i = 0; i < 4; i++) { c.advance(PEER_LIMITS.pollMs); await c.svc.tick(); }
      expect(c.svc.snapshot().peers.reserved).toHaveLength(1); // four minutes: still the peer's
      for (let i = 0; i < 2; i++) { c.advance(PEER_LIMITS.pollMs); await c.svc.tick(); }
      expect(c.svc.snapshot().peers.reserved).toEqual([]);
      expect(c.peer.calls.some((x) => x.kind === 'cancel' && x.arg === req.attemptId)).toBe(true);
      // The entry is the coordinator's again and starts as soon as its slot is free.
      c.setForeignHolders([]);
      await c.svc.tick();
      await c.runTimers();
      expect(c.spawned).toHaveLength(1);
      expect(JSON.parse(fs.readFileSync(c.spawned[0].inputPath, 'utf-8'))).toMatchObject({ kind: 'main', headSha: HEAD });
    });

    it('a peer that keeps answering "running" keeps a long main verify', async () => {
      const { c } = await mainOnPeer();
      for (let i = 0; i < 20; i++) { c.advance(PEER_LIMITS.pollMs); await c.svc.tick(); }
      expect(c.svc.snapshot().peers.reserved).toHaveLength(1);
      expect(c.peer.calls.some((x) => x.kind === 'cancel')).toBe(false);
    });

    it('an error record from the peer hands the main verify back; it is not judged and not lost', async () => {
      const { c, req } = await mainOnPeer();
      c.peer.setResult(() => ({ state: 'done', record: mainRecord(req, { outcome: 'error', errorStep: 'peer-crash' }) }));
      c.peer.setStatus({ inFlight: null, verifierVersion: '1.0.0', policyHash: POLICY, slotBusy: true }); // no second hand-out in this test
      c.advance(PEER_LIMITS.statusMs);
      await c.svc.tick();
      await c.flush();
      expect(c.svc.mainHealth()).toMatchObject({ state: 'healthy', lastGreenHead: null });
      expect(c.svc.snapshot().queue.filter((e) => e.kind === 'main').map((e) => [e.headSha, !!e.remote])).toEqual([[HEAD, false]]);
    });

    it('a main verify taken back beside a newer pending head is dropped: the newer one covers it', async () => {
      const { c } = await mainOnPeer();
      c.advance(60_000);
      c.svc.noteMainHead(sha('e'));
      c.advance(10 * 60_000);
      c.svc.noteMainHead(sha('e')); // debounced enqueue of the newer head
      expect(c.svc.snapshot().queue.filter((e) => e.kind === 'main')).toHaveLength(2);
      c.setHolds(false); // the lease moves: the reservation is abandoned
      await c.svc.tick();
      expect(c.svc.snapshot().queue.filter((e) => e.kind === 'main').map((e) => [e.headSha, !!e.remote])).toEqual([[sha('e'), false]]);
    });

    it('a peer that cannot confirm the head is not counted as a failing peer', async () => {
      const c = coordinator({ mainOnPeers: true });
      c.setForeignHolders([9001]);
      c.peer.setRun(() => ({ ok: false, reason: 'head-moved' }));
      c.svc.noteMainHead(HEAD);
      for (let i = 0; i < 6; i++) { await c.runTimers(); c.advance(PEER_LIMITS.statusMs); await c.svc.tick(); }
      expect(c.signals.some((k) => k.startsWith('local-verify:peer-breaker:'))).toBe(false);
      // The attempts are spent: after the limit the entry is the coordinator's own.
      expect(c.peer.runs()).toHaveLength(PEER_LIMITS.maxAttemptsPerEntry);
      expect(c.svc.snapshot().queue.filter((e) => e.kind === 'main' && !e.remote)).toHaveLength(1);
    });

    it('a restart keeps the main reservation and imports the same attempt', async () => {
      const { c, req } = await mainOnPeer();
      c.svc.shutdown();
      const saved = c.queueFile().entries as Array<{ kind?: string; remote?: { attemptId: string } }>;
      expect(saved).toEqual([expect.objectContaining({ kind: 'main', remote: expect.objectContaining({ attemptId: req.attemptId }) })]);
      const h2 = harness({ stateDir: c.stateDir });
      const peer2 = fakePeer();
      peer2.prime(req);
      peer2.setResult(() => ({ state: 'done', record: mainRecord(req) }));
      h2.svc.setPeerWiring({ peers: () => [{ machineId: 'peer1', url: 'http://peer1:4042' }], client: peer2.client, lease: { holdsLease: () => true, leaseEpoch: () => 7, holderMachineId: () => 'coord' }, mainOnPeers: () => true, keyLookupFactory: pinnedPeerKeys });
      await h2.svc.boot();
      expect(h2.svc.snapshot().peers.reserved).toEqual([expect.objectContaining({ pr: 0, attemptId: req.attemptId })]);
      await h2.svc.tick();
      await h2.flush();
      expect(h2.svc.mainHealth().lastGreenHead).toBe(HEAD);
    });

    it('an unreserved main entry is still never saved (it is re-derived)', async () => {
      const c = coordinator({ mainOnPeers: true });
      c.setForeignHolders([9001]);
      c.peer.setStatus({ inFlight: null, verifierVersion: '1.0.0', policyHash: POLICY, slotBusy: true });
      c.svc.noteMainHead(HEAD);
      await c.runTimers();
      expect(c.peer.runs()).toHaveLength(0);
      expect(c.queueFile().entries).toEqual([]);
    });
  });

  describe('peer', () => {
    function peerSide(mainHead: string) {
      const h = harness({ peerOnly: true, machineId: 'peer1' });
      h.svc.setPeerWiring({ peerRoleEnabled: () => true });
      h.seams.baseHead = async () => mainHead;
      return h;
    }
    const notHolder = { holdsLease: false, holderMachineId: 'coord' };

    it('runs main at its head, as a main verify that carries the attempt, and returns the failing files with a red result', async () => {
      const h = peerSide(HEAD);
      expect(await h.svc.peerRun(mainReq(), notHolder)).toEqual({ ok: true, attemptId: ATT });
      const input = JSON.parse(fs.readFileSync(h.spawned[0].inputPath, 'utf-8'));
      expect(input).toMatchObject({ pr: 0, kind: 'main', headSha: HEAD, baseSha: HEAD, attempt: { id: ATT, coordinatorMachineId: 'coord', leaseEpoch: 7 } });
      expect(input.isolation).toBeUndefined();
      expect(input.preflightMode).toBeUndefined();
      const rec = mainRecord(mainReq(), { outcome: 'failure' });
      await h.finish(0, { kind: 'record', record: rec, reasons: ['unit lane failed'], overlaps: [], keptWorktree: null,
        failures: [{ file: 'tests/unit/broken.test.ts', lane: 'unit', failed: 1, message: 'expected 1 to be 2' }] });
      expect(h.svc.peerResult(ATT)).toEqual({ state: 'done', record: rec,
        run: { reasons: ['unit lane failed'], failures: [{ file: 'tests/unit/broken.test.ts', lane: 'unit', failed: 1, message: 'expected 1 to be 2' }] } });
      // The peer never judges main itself.
      expect(h.svc.mainHealth().state).toBe('healthy');
    });

    it('a crashed main run still answers with a valid error record for the attempt', async () => {
      const h = peerSide(HEAD);
      await h.svc.peerRun(mainReq(), notHolder);
      await h.finish(0, null);
      const res = h.svc.peerResult(ATT);
      expect(res).toMatchObject({ state: 'done', record: { kind: 'main', pr: 0, outcome: 'error', attempt: { id: ATT } } });
    });

    it('accepts the commit directly under main (a release commit on top), refuses a head main does not contain', async () => {
      const under = peerSide(sha('f'));
      under.seams.commitInfo = async (s) => (s === sha('f') ? { subject: 'chore: release v1', parents: [HEAD], files: null } : null);
      expect(await under.svc.peerRun(mainReq(), notHolder)).toEqual({ ok: true, attemptId: ATT });

      const stranger = peerSide(sha('f'));
      stranger.seams.commitInfo = async () => ({ subject: 'x', parents: [sha('9')], files: null });
      stranger.seams.isAncestor = async () => false;
      expect(await stranger.svc.peerRun(mainReq(), notHolder)).toEqual({ ok: false, reason: 'head-moved' });
      expect(stranger.spawned).toHaveLength(0);

      const blind = peerSide(HEAD);
      blind.seams.baseHead = async () => null;
      expect(await blind.svc.peerRun(mainReq(), notHolder)).toEqual({ ok: false, reason: 'pr-unreadable' });
    });
  });
});
