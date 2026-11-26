// safe-fs-allow: test helper — SafeFsExecutor used for tmpdir cleanup.
/**
 * The fake-clock LocalVerifyService harness for the operator queue controls (spec
 * docs/specs/local-verify-queue-controls.md). Real fs in a temp state dir; the child process,
 * gh, the peer client, the lease and the clock are fakes. Same shape as the harness in
 * tests/unit/localVerify/LocalVerifyService.test.ts, plus: the live switch, a gate on the base
 * read (the wait between a pick and its start or reservation), a gate on a PR view (a restart
 * in the middle of an admission), and an optional fake peer.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateSigningKeyPair } from '../../src/core/MachineIdentity.js';
import { signerKeyHashOf, type MachineKeyLookup } from '../../src/core/AppRecordSignatures.js';
import { LocalVerifyService, type LocalVerifyServiceSeams, type PrView } from '../../src/localVerify/LocalVerifyService.js';
import { computePolicyHash } from '../../src/localVerify/policy.js';
import type { LocalVerifyRecord } from '../../src/localVerify/record.js';
import type { VerifyRunResult } from '../../src/localVerify/orchestrator.js';
import type { PeerClient, PeerResult, PeerRunAnswer, PeerRunRequest, PeerStatus } from '../../src/localVerify/peer.js';

export const REPO = 'JKHeadley/instar';
export const sha = (c: string) => c.repeat(40);
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const POLICY = computePolicyHash();
export const T0 = Date.parse('2026-11-18T12:00:00.000Z');

const dirs: string[] = [];
/** Call from `afterEach`. */
export function cleanupHarnessDirs(): void {
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'operatorQueueHarness.ts' });
}

/** A distinct 40-hex head per PR number. */
export const headOf = (pr: number) => pr.toString(16).padStart(4, '0').repeat(10);

export function view(pr: number, over: Partial<PrView> = {}): PrView {
  return { author: { login: 'EchoOfDawn' }, isCrossRepository: false, headRefName: `echo/pr-${pr}`, headRefOid: headOf(pr), baseRefName: 'main', baseRefOid: sha('b'), ...over };
}

export function record(over: Partial<LocalVerifyRecord> = {}): LocalVerifyRecord {
  return {
    repo: REPO, pr: 1, headSha: headOf(1), baseSha: sha('b'), baseRefName: 'main', mergeTree: sha('d'),
    lanes: [{ name: 'unit', gating: true, files: 1, tests: 3, passed: 3, failed: 0, skipped: 0, todo: 0, seconds: 1 }],
    nodeVersion: 'v24', machineId: 'm1', startedAt: '2026-11-18T11:00:00.000Z', finishedAt: '2026-11-18T11:40:00.000Z',
    outcome: 'success', harnessChanging: false, protectedPath: false, skipsAdded: false, testsRemoved: false,
    verifierVersion: '1.0.0', policyHash: POLICY, ...over,
  };
}

export const ok = (r: LocalVerifyRecord): VerifyRunResult => ({ kind: 'record', record: r, reasons: [], overlaps: [], keptWorktree: null });

const PEER_KEYS = generateSigningKeyPair();
const PEER_KEY_HASH = signerKeyHashOf(PEER_KEYS.publicKey);
const pinnedPeerKeys = (): MachineKeyLookup => (_machineId, hash) => hash === PEER_KEY_HASH ? { status: 'ok', publicKeyPem: PEER_KEYS.publicKey } : { status: 'unknown' };

export interface HarnessOpts {
  /** PR numbers to give a view (each with its own head). */
  prs?: number[];
  views?: Record<number, PrView>;
  stateDir?: string;
  /** The live switch (default on). */
  controls?: boolean;
  /** Extra fields of the main-health watermark (default: healthy, this machine). */
  watermark?: Record<string, unknown>;
  /** Wire one fake peer and a lease view (default: no peer, single machine). */
  peer?: boolean;
  mainOnPeers?: boolean;
  /** Give the service a `baseHead` seam (needed for the base-read gate). Default true. */
  baseHead?: boolean;
}

interface RunInput { pr: number; headSha: string; baseSha: string; baseRefName: string; kind?: string }
/** `input` is read at spawn: the service removes the input file when the run ends. */
interface Spawned { pid: number; input: RunInput; resultPath: string; resolve: (x: { status: number | null; signal: string | null }) => void }

export function harness(opts: HarnessOpts = {}) {
  const fresh = !opts.stateDir;
  const stateDir = opts.stateDir ?? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvopq-')));
  const lvDir = path.join(stateDir, 'state', 'local-verify');
  if (fresh) {
    dirs.push(stateDir);
    fs.mkdirSync(lvDir, { recursive: true });
    fs.writeFileSync(path.join(lvDir, 'main-health.json'), JSON.stringify({
      v: 1, machineId: 'm1', state: 'healthy', redHead: null, lastGreenHead: null, reason: 'green', updatedAt: '2026-11-18T00:00:00.000Z', ...(opts.watermark ?? {}),
    }));
    if (opts.peer) {
      // A coordinator that has run main itself before (SEC-113 D2.3), so a peer may be offered main.
      fs.writeFileSync(path.join(lvDir, 'peer-trust.json'), JSON.stringify({ v: 1, holding: { holder: 'm1', epoch: 7 }, anchor: { head: 'f'.repeat(40), finishedAt: '2026-11-18T11:00:00.000Z' },
        notLocallyVerifiedAt: null, locallyVerified: ['f'.repeat(40)], peerMainGreens: [], quarantine: {}, arbitration: null, durations: Array.from({ length: 10 }, () => 10 * MIN) }));
    }
  }
  const views: Record<number, PrView> = opts.views ?? Object.fromEntries((opts.prs ?? []).map((pr) => [pr, view(pr)]));
  const open: Record<number, boolean | null> = {};
  const spawned: Spawned[] = [];
  const timers: Array<() => void> = [];
  const signals: Array<{ key: string; detail: Record<string, unknown> }> = [];
  const starved: Array<{ pr: number; reason?: string }> = [];
  let holders: number[] = [];
  let controls = opts.controls ?? true;
  let t = T0;
  let pid = 5000;
  let openReads = 0;

  // The base-read gate: while closed, every `baseHead` read waits.
  let baseGate: Promise<void> | null = null;
  let openBaseGate: (() => void) | null = null;
  let baseReads = 0;
  /** The current head of each base branch (default: sha('b')). */
  const bases: Record<string, string> = {};
  // The view gate: a PR whose view read waits (and may be abandoned by a "restart").
  const viewGates = new Map<number, { wait: Promise<void>; open: () => void }>();

  const seams: LocalVerifyServiceSeams = {
    prView: async (pr) => {
      const g = viewGates.get(pr);
      if (g) await g.wait;
      return views[pr] ?? null;
    },
    isPrOpen: async (pr) => { openReads++; return pr in open ? open[pr] : true; },
    ...(opts.baseHead === false ? {} : {
      baseHead: async (ref: string) => {
        baseReads++;
        if (baseGate) await baseGate;
        return bases[ref] ?? sha('b');
      },
    }),
    spawnRun: (a) => {
      const p = ++pid;
      let resolve!: Spawned['resolve'];
      const exited = new Promise<{ status: number | null; signal: string | null }>((r) => { resolve = r; });
      const input = JSON.parse(fs.readFileSync(a.args[a.args.indexOf('--input') + 1], 'utf-8')) as RunInput;
      spawned.push({ pid: p, input, resultPath: a.args[a.args.indexOf('--result') + 1], resolve });
      return { pid: p, exited };
    },
    isGroupAlive: () => false,
    killGroup: () => {},
    readProcessArgs: async () => null,
    foreignSuiteHolders: () => holders.map((pid) => ({ pid })),
    suiteCapacity: () => 1,
    isAncestor: async () => false,
    onStarved: (i) => { starved.push(i); },
    signal: (key, detail) => { signals.push({ key, detail }); },
    now: () => t,
    setTimer: (fn) => { timers.push(fn); },
  };
  const svc = new LocalVerifyService({
    repo: REPO, stateDir, agentHome: '/agents/echo', expectedGhLogin: 'EchoOfDawn', operatorGhLogin: 'JKHeadley',
    verifierVersion: '1.0.0', nodePath: '/usr/bin/node', mainEntry: '/opt/instar/dist/localVerify/runVerifyMain.js',
    remoteUrl: 'https://github.com/JKHeadley/instar.git', machineId: 'm1', nodeVersion: 'v24',
    protectedList: ['.github/'], baseEnv: { PATH: '/usr/bin' }, nice: false,
  }, seams);
  svc.setQueueControlsEnabled(() => controls);

  // ---- the fake peer ----
  const peerRuns: PeerRunRequest[] = [];
  const peerCancels: string[] = [];
  let peerStatus: PeerStatus | null = { inFlight: null, verifierVersion: '1.0.0', policyHash: POLICY, slotBusy: false, signerKeyHash: PEER_KEY_HASH };
  let peerAnswer: (req: PeerRunRequest) => PeerRunAnswer | null = (req) => ({ ok: true, attemptId: req.attemptId });
  let peerResult: (id: string) => PeerResult | null = () => ({ state: 'running' });
  let holdsLease = true;
  let leaseEpoch = 7;
  let leaseHolder = 'm1';
  let mainOnPeers = opts.mainOnPeers ?? false;
  const client: PeerClient = {
    status: async () => peerStatus,
    run: async (_p, req) => { peerRuns.push(JSON.parse(JSON.stringify(req)) as PeerRunRequest); return peerAnswer(req); },
    result: async (_p, id) => peerResult(id),
    cancel: async (_p, id) => { peerCancels.push(id); },
  };
  if (opts.peer) {
    svc.setPeerWiring({
      peers: () => [{ machineId: 'peer1', url: 'http://peer1:4042' }],
      client,
      lease: { holdsLease: () => holdsLease, leaseEpoch: () => leaseEpoch, holderMachineId: () => leaseHolder },
      mainOnPeers: () => mainOnPeers,
      keyLookupFactory: pinnedPeerKeys,
    });
  }

  const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
  /** Run the timers the service armed (the peer dispatch runs from one), a few rounds. */
  const runTimers = async () => { for (let k = 0; k < 5; k++) { const ts = timers.splice(0); for (const f of ts) f(); await flush(); } };
  const settle = async () => { await flush(); await svc.settle(); await flush(); };
  const inputOf = (i: number): RunInput => spawned[i].input;
  /** The PR (0 = main) each started run was for, in start order. */
  const startedPrs = () => spawned.map((_, i) => inputOf(i).pr);
  /** Finish run `i` with a result (null = crash), then let every follow-up settle. */
  const finish = async (i: number, result: VerifyRunResult | null) => {
    if (result) fs.writeFileSync(spawned[i].resultPath, JSON.stringify(result));
    spawned[i].resolve({ status: 0, signal: null });
    await settle();
  };
  /** Finish run `i` with a record for exactly what it ran. */
  const finishAs = async (i: number, outcome: 'success' | 'failure' | 'error', over: Partial<LocalVerifyRecord> = {}) => {
    const input = inputOf(i);
    return finish(i, ok(record({
      pr: input.pr, headSha: input.headSha, baseSha: input.baseSha, baseRefName: input.baseRefName, outcome,
      ...(input.kind === 'main' ? { kind: 'main' as const } : {}),
      ...(outcome === 'error' ? { errorStep: 'fetch', lanes: [], mergeTree: '' } : {}),
      startedAt: new Date(t - 10 * MIN).toISOString(), finishedAt: new Date(t).toISOString(), ...over,
    })));
  };
  const audits = () => {
    try { return fs.readFileSync(path.join(stateDir, 'logs', 'local-verify.jsonl'), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown> & { event: string }); }
    catch { return []; }
  };
  const auditsOf = (event: string) => audits().filter((a) => a.event === event);
  const operatorPath = path.join(lvDir, 'operator-queue.json');
  const operatorFile = () => JSON.parse(fs.readFileSync(operatorPath, 'utf-8')) as {
    v: number; nextOrder: number; overCap: number[]; leaseNoticeAt?: number;
    records: Array<{ pr: number; hold?: Record<string, unknown> & { entry?: Record<string, unknown>; waiter?: Record<string, unknown>; releasing?: Record<string, unknown> }; front?: Record<string, unknown> }>;
  };
  const queueFile = () => JSON.parse(fs.readFileSync(path.join(lvDir, 'queue.json'), 'utf-8')) as { entries: Array<Record<string, unknown> & { pr: number }> };
  const waitingFile = () => JSON.parse(fs.readFileSync(path.join(lvDir, 'waiting.json'), 'utf-8')) as { waiters: Array<{ pr: number; firstRefusedAt: number }> };
  /** The PR numbers in the queue, in the queue's current order (main = 0). */
  const queued = () => svc.snapshot().queue.map((e) => e.pr);

  return {
    svc, seams, stateDir, lvDir, views, open, spawned, timers, signals, starved, operatorPath,
    flush, runTimers, settle, finish, finishAs, inputOf, startedPrs, audits, auditsOf, operatorFile, queueFile, waitingFile, queued,
    advance: (ms: number) => { t += ms; },
    now: () => t,
    setHolders: (h: number[]) => { holders = h; },
    /** Move a base branch's head (a merge landed). */
    setBase: (ref: string, head: string) => { bases[ref] = head; },
    setControls: (v: boolean) => { controls = v; },
    openReads: () => openReads,
    baseReads: () => baseReads,
    /** Close the base-read gate: the next pick that re-reads its base waits there. */
    holdBase: () => { if (!baseGate) baseGate = new Promise<void>((r) => { openBaseGate = r; }); },
    /** Open it again and let the waiting start or reservation proceed. */
    releaseBase: async () => { const o = openBaseGate; baseGate = null; openBaseGate = null; o?.(); await flush(); },
    /** Make the view read of one PR wait (a request for it then hangs until `releaseView`). */
    holdView: (pr: number) => { let o!: () => void; const wait = new Promise<void>((r) => { o = r; }); viewGates.set(pr, { wait, open: o }); },
    releaseView: async (pr: number) => { const g = viewGates.get(pr); viewGates.delete(pr); g?.open(); await flush(); },
    peer: {
      runs: () => peerRuns, cancels: () => peerCancels,
      setStatus: (s: PeerStatus | null) => { peerStatus = s; },
      setAnswer: (f: typeof peerAnswer) => { peerAnswer = f; },
      setResult: (f: typeof peerResult) => { peerResult = f; },
    },
    setLease: (o: { holds?: boolean; epoch?: number; holder?: string }) => {
      if (o.holds !== undefined) holdsLease = o.holds;
      if (o.epoch !== undefined) leaseEpoch = o.epoch;
      if (o.holder !== undefined) leaseHolder = o.holder;
    },
    setMainOnPeers: (v: boolean) => { mainOnPeers = v; },
  };
}

export type Harness = ReturnType<typeof harness>;

/**
 * Fill the queue to its ordinary cap with PRs `from … from+9` while another suite holds the
 * slot (so nothing starts). Each PR needs a view in the harness.
 */
export async function fillQueue(h: Harness, from: number, count = 10): Promise<void> {
  h.setHolders([9001]);
  for (let pr = from; pr < from + count; pr++) {
    const r = await h.svc.request(pr, { explicit: true });
    if (!r.ok) throw new Error(`fillQueue: PR ${pr} refused: ${r.code}`);
  }
}
