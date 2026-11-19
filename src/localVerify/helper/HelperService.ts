/**
 * The borrowed-machine helper role (docs/specs/local-verify-borrowed-unit-slices.md, B to E).
 *
 * Built only on a helper machine whose own agent set `monitoring.localVerify.helper.enabled`
 * after its owner's yes; never by config defaults or migration. It serves only the helper routes
 * and never starts the run-machine Local Verify service. What a run machine does with an answer
 * is the run machine's rule; this side only runs and reports.
 *
 * Owner first:
 *  - one worker: preparations and slices run one at a time;
 *  - the governor samples the owner every 2 s and stops at once on zero workers, memory pressure,
 *    battery (when `stopOnBattery`), the deadline, a cancel or a pause; a stop kills every process
 *    in the runner's scope and confirms none is left before answering `handed-back` / `prep-stopped`;
 *  - memory pressure, battery, pause and 15 min idle stop the sandbox itself (memory is only given
 *    back that way); after a pressure stop a hold-off answers `owner-busy`;
 *  - the sandbox walls are checked at every start (`helper-containment-unproven` otherwise), and the
 *    host disk must cover the remaining growth of the sandbox disk and of the package volume's
 *    own disk, plus 5 GB. The checks include the paired network test (a listener on the host's
 *    local-network address and one on its tailnet address, each unreachable from a test namespace
 *    and answering from the host side) and the sandbox property test: as `tester` and as
 *    `builder`, no host path is readable and no host credential is reachable.
 *
 * What it accepts (docs/specs/local-verify-borrowed-slices-count.md, C), checked by the helper
 * itself, in this order, each with its own named refusal, before anything runs:
 *  1. `baseSha` is merged: reachable from `main` in the pinned repository;
 *  2. `headSha` is ours: `baseSha` itself, or the current head of an open pull request whose head
 *     repository is the pinned repository (by id). GitHub's listing is the only evidence;
 *  3. its own dry run of the lane is done on the current sandbox image (dryRunRecord.ts), before
 *     any `headSha` that differs from `baseSha`;
 *  4. the merge tree, built in its own clone; a conflict refuses; the tree's hash rides every answer;
 *  5. the install inputs of the merge tree hash equal to those at `baseSha`;
 *  then packages: looked up by that hash, installed ONLY in a merged commit's tree after this
 *  helper's own merged check for it, locked root-owned and read-only before any file of the tree
 *  to test is placed beside them, and re-verified against their manifest before each use.
 *
 * How it runs a slice (docs/specs/local-verify-borrowed-slices-count.md, E):
 *  - a preparation may arrive with no files, when the verify starts; a whole-run cancel stops it;
 *  - a slice request is checked, QUEUED and answered at once (`queued`, with its id). Waiting
 *    slices are served one at a time: the check slice first, then slices whose results will be
 *    used, then compare-only slices; within one class, in order of arrival;
 *  - one vitest process per slice with its lane's own configuration; integration and end-to-end
 *    files one at a time, a unit slice with as many workers as the governor allows;
 *  - results come through the SIGNED status answer: each finished slice's signed answer, and for
 *    the running slice signed progress (the files finished so far, the unhandled errors so far, a
 *    rising sequence number, the request's ids). Progress leaves the sandbox through the root-owned
 *    runner on a pipe it opened. A hand-back repeats the finished files' results, which the run
 *    machine may then use as provisional; a last answer that would contradict earlier progress is
 *    withheld (`progress-contradicted`) instead of sent;
 *  - a per-slice cancel stops or dequeues only the named slices; a prepared tree is kept until the
 *    run machine says the verify is over (`verifyOver`) or 10 minutes pass with no request for it.
 *
 * Which files (D): the learned list's rules (learnedList.ts) and the record of files this helper
 * has been compared on (comparedFiles.ts), both fed by the signed learned request, keyed by the
 * merge tree's hash.
 *
 * Every OS/sandbox interaction goes through injected seams (driver, owner-load reader, GitHub
 * reader, tree source, signer, clock).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MachineKeyLookup, MachineSigner } from '../../core/AppRecordSignatures.js';
import { SafeFsExecutor } from '../../core/SafeFsExecutor.js';
import { parseVitestJson } from '../laneReport.js';
import { excludedBy, isBorrowableTestFile, isBorrowedCanaryFile, judgeEligibility, laneOfTestFile, type EligibilityVerdict, type TreeReader } from '../borrowedEligibility.js';
import { sandboxWorkerCeiling, type HelperConfig, type HelperTarget } from './helperConfig.js';
import {
  HELPER_LANES, HELPER_LIMITS, finalContradictsProgress, parseHelperRequest, signHelperAnswer, signHelperHere, signHelperProgress, signHelperStatus,
  type HelperCancelRequest, type HelperHereRequest, type HelperLane, type HelperProgressAnswer, type HelperRefusal, type HelperSliceAnswer, type HelperSliceRequest, type HelperPerFile, type SignedHelperRequest, type HelperLearnedRequest,
} from './helperProtocol.js';
import { sliceBudgetMs, sliceClassRank, sliceWorkers } from './sliceBudget.js';
import { HelperComparedStore, type ComparedKey } from './comparedFiles.js';
import { routeRefusal, signedRequestRefusal, type RouteFacts } from './admission.js';
import { HelperLearnedStore } from './learnedList.js';
import { HelperSeenAttempts } from './seenAttempts.js';
import { PressureHoldOff, decideGovernor, stopsSandbox, type GovernorStop, type OwnerLoadReader } from './governor.js';
import { PKG_VOLUME_MISSING_EXIT, hostDiskOk, type ContainmentReport, type HelperSandboxDriver, type TesterProgress } from './sandboxDriver.js';
import type { HelperGitHubReader, HostTreeSource } from './hostTree.js';
import { headRefusal, judgeInstallInputs, readInstallInputs, treeHasNodeModules } from './acceptance.js';
import { HelperDryRunStore, dryRunLaneProven, type SandboxImageIdentity } from './dryRunRecord.js';
import { HelperPackageIndex } from './packageCache.js';

export interface HelperServiceDeps {
  /** Live, parsed setting; null = disabled (routes 404). */
  config: () => HelperConfig | null;
  /** Null when this platform has no supported sandbox (every request refuses `no-sandbox`). */
  driver: HelperSandboxDriver | null;
  ownerLoad: OwnerLoadReader;
  github: HelperGitHubReader;
  trees: HostTreeSource;
  signer: MachineSigner | null;
  keyLookup: () => MachineKeyLookup;
  stateDir: string;
  helperVersion: string;
  /**
   * The helper's runner version (helperRunnerVersion.ts): a hash of its runner and sandbox-driver
   * source. Learned-list trials and the "compared on" record follow it, not Instar's release number.
   */
  runnerVersion: string;
  hostFreeBytes: () => Promise<number | null>;
  /**
   * sha256 (hex) of each host credential the sandbox must not hold (the helper's GitHub token),
   * for the sandbox property test at every start. Only digests are ever passed into the sandbox.
   */
  credentialDigests?: () => string[];
  /**
   * Sends the signed "I am here" to this helper's one run machine; true when it was accepted.
   * Absent: nothing is sent (the run machine then keeps its slower asking until it next asks).
   */
  announce?: (target: HelperTarget, body: HelperHereRequest) => Promise<boolean>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  audit?: (event: Record<string, unknown>) => void;
  /** On-host test suites only; production wiring never sets it. */
  allowLoopback?: boolean;
}

/** One prepared merge of two commits. Keyed by the pair: the tree's hash is known only once the merge is built. */
interface PreparedTree {
  key: string;
  baseSha: string;
  headSha: string;
  /** The merge tree's hash, once built. It is also the tree's id inside the sandbox. */
  treeHash: string | null;
  /** The install-inputs hash its packages were looked up by. */
  installHash: string | null;
  state: 'preparing' | 'ready' | 'failed';
  reason?: string;
  prepMs: number | null;
  copyMs: number | null;
  /** When a request last named this pair (a preparation, a slice) or a slice of it last ended. */
  lastUsed: number;
  /** The run whose request started the preparation. */
  runAttemptId: string;
  /** Every verify that has asked for this tree and has not said it is over. */
  runs: Set<string>;
  /** Its last verify said it is over: nothing keeps the tree but work still using it. */
  over: boolean;
}

/** One accepted slice waiting its turn. */
interface QueuedSlice {
  req: HelperSliceRequest;
  cfg: HelperConfig;
  /** The prepared tree's key (`pairKey`). */
  key: string;
  /** The slice's class (check, count, compare), then arrival: the order of service. */
  rank: number;
  order: number;
}

/** The running slice's progress, as the status answer signs it. */
interface SliceProgress {
  attemptId: string;
  runAttemptId: string;
  lane: HelperLane;
  treeHash: string;
  seq: number;
  files: Map<string, HelperPerFile>;
  unhandled: number;
}

/** What a status request may ask for beyond the standing answer. */
export interface HelperStatusQuery {
  /** Only this verify's finished slices. */
  runAttemptId?: string;
  /** Only finished slices after this sequence number (the last one the reader has). */
  sinceSeq?: number;
  /** Include the full list of files this helper has been compared on, for one lane. */
  comparedLane?: HelperLane;
}

interface CurrentWork {
  kind: 'prep' | 'slice';
  runAttemptId: string;
  attemptId: string;
  /** The prepared tree's key (`pairKey`). */
  key: string;
  abort: AbortController;
  stop: GovernorStop | null;
  stopAt: number | null;
  ownerCoresMax: number | null;
}

export type HelperHttpAnswer = { status: number; body: unknown };

const pairKey = (baseSha: string, headSha: string): string => `${baseSha}:${headSha}`;

/**
 * Acceptance refusals that the same two commits will always produce: the merge of two fixed
 * commits and their install inputs do not change. Remembered per pair, so a repeated request is
 * answered with the reason at once instead of preparing again.
 */
const PAIR_REFUSALS: readonly HelperRefusal[] = Object.freeze(['merge-conflict', 'tree-has-node-modules', 'install-inputs-changed']);

/** A slice refused for one of these was refused for the sandbox's state, not for anything about the slice. */
const SANDBOX_REFUSALS: readonly string[] = Object.freeze(['helper-containment-unproven', 'host-disk-low']);

/** Refusals that mean "GitHub could not say": answered 503, not 409. */
const UNKNOWN_REFUSALS: readonly string[] = Object.freeze(['merged-unknown', 'merged-rate-limited', 'head-unknown', 'head-rate-limited']);

/** The idle sweep runs every 60 s; a gap of 3 minutes between two runs means the machine slept in between. */
const WAKE_GAP_MS = 3 * 60_000;

/** PRACTICE-PHASE DEFAULT: how often the owner is sampled while idle in a memory hold-off. */
const HOLD_OFF_SAMPLE_MS = 30_000;

const CONTROL_FILE = (stateDir: string) => path.join(stateDir, 'state', 'local-verify', 'helper-control.json');

/** Pause state, written by `instar helper pause|resume` and the dashboard toggle. */
export function readHelperPaused(stateDir: string): boolean {
  try { return (JSON.parse(fs.readFileSync(CONTROL_FILE(stateDir), 'utf-8')) as { paused?: unknown }).paused === true; }
  catch { return false; } // @silent-fallback-ok: no control file means not paused (the role itself is still off unless enabled)
}

export function writeHelperPaused(stateDir: string, paused: boolean, by: string): void {
  fs.mkdirSync(path.dirname(CONTROL_FILE(stateDir)), { recursive: true });
  SafeFsExecutor.atomicWriteJsonSync(CONTROL_FILE(stateDir), { paused, by, at: new Date().toISOString() }, { operation: 'local-verify:helper-control' });
}

export class HelperService {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly learned: HelperLearnedStore;
  private readonly seen: HelperSeenAttempts;
  private readonly holdOff = new PressureHoldOff();
  private readonly trees = new Map<string, PreparedTree>();
  private readonly mergedCache = new Map<string, true>();
  /** Heads GitHub listed as ours, for the life of one run only: a head can move and a pull request can close. */
  private readonly headCache = new Map<string, true>();
  private readonly pairRefusals = new Map<string, HelperRefusal>();
  private readonly dryRun: HelperDryRunStore;
  private readonly packages: HelperPackageIndex;
  private readonly compared: HelperComparedStore;
  /** Accepted slices waiting: served check first, then counted, then compare-only. */
  private readonly queue: QueuedSlice[] = [];
  private arrival = 0;
  /** Finished slices' signed answers, oldest first, each with its place in the helper's result sequence. */
  private results: Array<{ seq: number; runAttemptId: string; answer: HelperSliceAnswer }> = [];
  private resultSeq = 0;
  private readonly waiters = new Map<string, Array<(a: HelperSliceAnswer) => void>>();
  private progress: SliceProgress | null = null;
  /** The sandbox image identity last read from the driver (the "compared on" record belongs to it). */
  private imageKey: SandboxImageIdentity | null = null;
  /** The governor's last reading: how many workers the owner's use left free, and when. */
  private lastOwner: { at: number; workersFree: number; ownerCores: number | null; stop: string | null } | null = null;
  private lastTickAt: number | null = null;
  private current: CurrentWork | null = null;
  private pendingPrep: { baseSha: string; headSha: string; runAttemptId: string; attemptId: string } | null = null;
  private sandboxUp = false;
  private containment: (ContainmentReport & { checkedAt: string }) | null = null;
  private lastWorkAt: number;
  private lastCreatedAt: number | null = null;
  private lastRefusal: { reason: string; at: string } | null = null;
  private peakPrepBytes = 0;
  private lastSandboxStartMs: number | null = null;
  private sandboxPeakMemMb: number | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private holdOffTimer: NodeJS.Timeout | null = null;
  private readonly day = { date: '', sandboxStops: 0, sandboxStarts: 0, pressureStops: 0 };
  private stopped = false;
  /** Content hashes of the newest prepared tree's test files (every lane): a changed file is due a trial. */
  private currentBlobs = new Map<string, string>();

  constructor(private readonly d: HelperServiceDeps) {
    this.now = d.now ?? (() => Date.now());
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); }));
    this.learned = new HelperLearnedStore(d.stateDir, this.now);
    this.seen = new HelperSeenAttempts(d.stateDir, this.now);
    this.dryRun = new HelperDryRunStore(d.stateDir, this.now);
    this.packages = new HelperPackageIndex(d.stateDir, this.now);
    this.compared = new HelperComparedStore(d.stateDir);
    this.lastWorkAt = this.now();
  }

  /** Start the idle sweep (15 min without work stops the sandbox; a daily recreate while idle), and say "I am here". */
  start(): void {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => { void this.tickIdle().catch((e) => this.audit({ event: 'helper-idle-error', detail: String(e) })); }, 60_000);
    this.idleTimer.unref?.();
    void this.sayHere('start');
  }

  /**
   * One signed "I am here" to this helper's pinned run machine (spec F "Asking the helper"): the
   * service started, the owner resumed it, or the machine woke. Never awaited by work, never
   * retried: a run machine that missed it still asks again at its slower rate.
   */
  async sayHere(why: HelperHereRequest['why']): Promise<boolean> {
    const cfg = this.d.config();
    if (!cfg || !this.d.signer || !this.d.announce || this.stopped || this.paused()) return false;
    const at = this.now();
    const body = signHelperHere(this.d.signer, { kind: 'here', helperMachineId: this.d.signer.machineId(), runMachineId: cfg.pinnedRequester.machineId, why, at, expiresAt: at + HELPER_LIMITS.requestMaxLifetimeMs, runnerVersion: this.d.runnerVersion });
    let ok = false;
    try { ok = await this.d.announce(cfg.pinnedRequester, body); } catch { ok = false; } // @silent-fallback-ok: an unreachable run machine is audited below and asks again by itself
    this.audit({ event: 'helper-here', why, ok });
    return ok;
  }

  shutdown(): void {
    this.stopped = true;
    this.pendingPrep = null;
    this.flushQueue('refused', 'helper-stopped');
    if (this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = null; }
    if (this.holdOffTimer) { clearInterval(this.holdOffTimer); this.holdOffTimer = null; }
    this.current?.abort.abort();
  }

  enabled(): boolean { return this.d.config() !== null; }
  paused(): boolean { return readHelperPaused(this.d.stateDir); }

  /** Pause stops current work at once (and the sandbox); resume only allows new work. */
  async setPaused(paused: boolean, by: string): Promise<void> {
    writeHelperPaused(this.d.stateDir, paused, by);
    this.audit({ event: paused ? 'helper-paused' : 'helper-resumed', by });
    // A paused helper refuses new work: a queued preparation is dropped too.
    if (paused && this.pendingPrep) { this.audit({ event: 'helper-prep-dropped', headSha: this.pendingPrep.headSha, why: 'paused' }); this.pendingPrep = null; }
    // Waiting slices are handed back at once: the run machine runs those files itself.
    if (paused) this.flushQueue('owner-busy', 'paused');
    if (paused && this.current) { this.current.stop = 'paused'; this.current.stopAt = this.now(); this.current.abort.abort(); }
    if (paused) await this.stopSandbox('paused');
    if (!paused) void this.sayHere('resume');
  }

  private audit(e: Record<string, unknown>): void {
    try { this.d.audit?.({ src: 'helper', ...e }); } catch { /* @silent-fallback-ok: audit never breaks the helper */ }
  }

  private refuse(reason: HelperRefusal | string, status = 409): HelperHttpAnswer {
    this.lastRefusal = { reason, at: new Date(this.now()).toISOString() };
    if (reason === 'expired') this.audit({ event: 'helper-refused-expired' });
    else this.audit({ event: 'helper-refused', reason });
    return { status, body: { state: 'refused', reason } };
  }

  private bumpDay(field: 'sandboxStops' | 'sandboxStarts' | 'pressureStops'): void {
    const date = new Date(this.now()).toISOString().slice(0, 10);
    if (this.day.date !== date) Object.assign(this.day, { date, sandboxStops: 0, sandboxStarts: 0, pressureStops: 0 });
    this.day[field]++;
  }

  // ── status ──────────────────────────────────────────────────────────

  /**
   * The status answer, signed as a whole (and its progress and each finished slice's answer signed
   * by themselves, under their own domains, so each can be kept and checked alone). `at` is this
   * helper's clock: a reader refuses an old one.
   */
  status(q: HelperStatusQuery = {}): Record<string, unknown> {
    const now = this.now();
    const learned = this.learned.entries();
    const key = this.comparedKey();
    const since = typeof q.sinceSeq === 'number' && Number.isSafeInteger(q.sinceSeq) && q.sinceSeq >= 0 ? q.sinceSeq : 0;
    const wanted = this.results.filter((r) => r.seq > since && (q.runAttemptId === undefined || r.runAttemptId === q.runAttemptId));
    const records = this.dryRun.records();
    const body: Record<string, unknown> = {
      enabled: true,
      at: now,
      paused: this.paused(),
      helperVersion: this.d.helperVersion,
      runnerVersion: this.d.runnerVersion,
      sandbox: { kind: this.d.driver?.kind ?? null, up: this.sandboxUp, containment: this.containment, image: this.imageKey, ownerBusy: this.holdOff.holding(now), holdOffMs: this.holdOff.currentHoldMs(), startMs: this.lastSandboxStartMs, peakMemMb: this.sandboxPeakMemMb },
      busy: this.current ? { kind: this.current.kind, runAttemptId: this.current.runAttemptId, attemptId: this.current.attemptId } : null,
      // The governor's last reading of what the owner's use leaves free, with its time (it is taken while the helper works, not on a status request).
      owner: this.lastOwner ? { ...this.lastOwner } : null,
      trees: [...this.trees.values()].map((t) => ({ baseSha: t.baseSha, headSha: t.headSha, treeHash: t.treeHash, state: t.state, prepMs: t.prepMs, copyMs: t.copyMs, ...(t.reason ? { reason: t.reason } : {}) })),
      // Slices waiting, in the order they will be served.
      queue: this.orderedQueue().map((x) => ({ attemptId: x.req.attemptId, runAttemptId: x.req.runAttemptId, lane: x.req.lane, use: x.req.use, files: x.req.files.length })),
      // The running slice's progress, signed by itself; results taken from it are provisional.
      progress: this.signedProgress(),
      // Finished slices: each one's last signed answer. A reader asks again from the last sequence number it has.
      results: wanted.slice(0, HELPER_LIMITS.statusResultsMax).map((r) => ({ seq: r.seq, answer: r.answer })),
      resultsMore: wanted.length > HELPER_LIMITS.statusResultsMax,
      resultSeq: this.resultSeq,
      // The helper's own "dry run done" records (one per lane, with the image they were made on, the share of the lane's time that passed and whether that proves the lane) and any dry run in progress.
      dryRun: { records: records.map((r) => ({ ...r, proven: dryRunLaneProven(r) })), progress: Object.fromEntries(HELPER_LANES.map((l) => [l, this.dryRun.progress(l)])) },
      packages: this.packages.list().map((p) => ({ hash: p.hash, mergedCommit: p.mergedCommit, installedAt: p.installedAt })),
      lastRefusal: this.lastRefusal,
      today: { ...this.day },
      learned: {
        entries: learned.map((e) => ({ ...e, retrialDue: this.learned.retrialDue(e, { runnerVersion: this.d.runnerVersion, currentBlob: this.currentBlobs.get(e.file) ?? null }) })),
        candidates: this.learned.candidates().length,
        runsSeen: this.learned.runsSeen(),
      },
      // Per lane, the files this helper has had an agreeing comparison on (on this image and runner version): any other file is new to it.
      compared: this.compared.summary(key),
      ...(q.comparedLane && (HELPER_LANES as readonly string[]).includes(q.comparedLane) ? { comparedFiles: { lane: q.comparedLane, files: this.compared.files(key, q.comparedLane) } } : {}),
    };
    return this.d.signer ? signHelperStatus(this.d.signer, body) : body;
  }

  private comparedKey(): ComparedKey | null {
    return this.imageKey ? { ...this.imageKey, runnerVersion: this.d.runnerVersion } : null;
  }

  private signedProgress(): HelperProgressAnswer | null {
    const p = this.progress;
    if (!p) return null;
    const body: HelperProgressAnswer = { kind: 'progress', attemptId: p.attemptId, runAttemptId: p.runAttemptId, lane: p.lane, treeHash: p.treeHash, seq: p.seq, files: [...p.files.values()], unhandledErrors: p.unhandled, helperVersion: this.d.helperVersion };
    return this.d.signer ? signHelperProgress(this.d.signer, body) : body;
  }

  // ── requests ────────────────────────────────────────────────────────

  private admit(body: unknown, kind: 'slice' | 'cancel' | 'learned', route: RouteFacts): { req: SignedHelperRequest; cfg: HelperConfig } | HelperHttpAnswer {
    const cfg = this.d.config();
    if (!cfg) return { status: 404, body: { error: 'not found' } };
    if (routeRefusal(route, { allowLoopback: this.d.allowLoopback === true })) return this.refuse('tunnel', 403);
    const req = parseHelperRequest(body, kind);
    if (!req) return this.refuse('invalid-request', 400);
    if (!this.d.signer) return this.refuse('no-signer', 503);
    const why = signedRequestRefusal(req, { selfMachineId: this.d.signer.machineId(), pinnedRequester: cfg.pinnedRequester.machineId, keyLookup: this.d.keyLookup(), now: this.now(), seen: this.seen });
    if (why) return this.refuse(why, why === 'unsigned' || why.startsWith('signature') || why === 'requester-not-pinned' ? 401 : 409);
    try { this.seen.add(req.attemptId); } catch { return this.refuse('state-unwritable', 503); }
    return { req, cfg };
  }

  /** C item 1. Only "merged" is remembered: merged stays merged, while a commit that is not on main today may be tomorrow. */
  private async mergedOnMain(cfg: HelperConfig, sha: string): Promise<boolean | null | 'rate-limited'> {
    const cached = this.mergedCache.get(sha);
    if (cached !== undefined) return cached;
    const v = await this.d.github.isOnMain(cfg.repo, sha).catch(() => null);
    if (v === true) this.mergedCache.set(sha, true);
    if (this.mergedCache.size > 20) this.mergedCache.delete(this.mergedCache.keys().next().value as string);
    return v;
  }

  /**
   * C item 2, for a head that is not `baseSha`: null when GitHub lists it as the current head of an
   * open pull request from the pinned repository itself, else the refusal. An accepted head is
   * remembered for the same run only.
   */
  private async headNotOurs(cfg: HelperConfig, runAttemptId: string, headSha: string): Promise<HelperRefusal | null> {
    const k = `${runAttemptId}:${headSha}`;
    if (this.headCache.has(k)) return null;
    const why = headRefusal(await this.d.github.ownOpenHead(cfg.repo, headSha).catch(() => 'unreachable' as const));
    if (why === null) {
      this.headCache.set(k, true);
      if (this.headCache.size > 20) this.headCache.delete(this.headCache.keys().next().value as string);
    }
    return why;
  }

  /** The sandbox's image identity, or null when the driver cannot name it. */
  private async imageIdentity(cfg: HelperConfig): Promise<SandboxImageIdentity | null> {
    let image: SandboxImageIdentity | null = null;
    try { image = this.d.driver ? await this.d.driver.imageIdentity(cfg.sandbox) : null; } catch { image = null; } // @silent-fallback-ok: an image that cannot be named refuses every waiting change
    this.imageKey = image;
    return image;
  }

  private answer(req: HelperSliceRequest, state: HelperSliceAnswer['state'], extra: Partial<HelperSliceAnswer> = {}): HelperSliceAnswer {
    const tree = this.trees.get(pairKey(req.baseSha, req.headSha));
    const base: HelperSliceAnswer = {
      state, attemptId: req.attemptId, runAttemptId: req.runAttemptId, lane: req.lane, baseSha: req.baseSha, headSha: req.headSha,
      // The merge tree this helper built itself. Null only while there is none: a refusal, or a preparation that has not merged yet.
      treeHash: tree?.treeHash ?? null, requestedFiles: [...req.files],
      perFile: [], slice: null, ownerCoresMax: null, handBackMs: null, prepMs: tree?.prepMs ?? null, progress: 0,
      helperVersion: this.d.helperVersion, ...extra,
    };
    return this.d.signer ? signHelperAnswer(this.d.signer, base) : base;
  }

  private refuseAccept(reason: HelperRefusal): HelperHttpAnswer {
    return this.refuse(reason, UNKNOWN_REFUSALS.includes(reason) ? 503 : 409);
  }

  async handleSlice(body: unknown, route: RouteFacts): Promise<HelperHttpAnswer> {
    const a = this.admit(body, 'slice', route);
    if ('status' in a) return a;
    const req = a.req as SignedHelperRequest<HelperSliceRequest>;
    const cfg = a.cfg;
    if (!this.d.signer) return this.refuse('no-signer', 503);
    if (!this.d.driver) return this.refuse('no-sandbox', 503);
    if (this.paused()) return this.refuse('paused', 409);
    // E: a slice states its budget, and it is at most its lane's (60 s for integration and end-to-end, 10 s for unit).
    if (!req.prepare && req.budgetMs > sliceBudgetMs(req.lane)) return this.refuse('budget-over-limit');
    // C item 1: the base commit is merged.
    const merged = await this.mergedOnMain(cfg, req.baseSha);
    if (merged === false) return this.refuseAccept('base-not-merged');
    if (merged === 'rate-limited') return this.refuseAccept('merged-rate-limited');
    if (merged !== true) return this.refuseAccept('merged-unknown');
    if (req.headSha !== req.baseSha) {
      // C item 2: the head is ours, by GitHub's own listing.
      const notOurs = await this.headNotOurs(cfg, req.runAttemptId, req.headSha);
      if (notOurs) return this.refuseAccept(notOurs);
      // C item 3: this helper's own dry run of the lane is done on its current image. Not on the run machine's word.
      const image = await this.imageIdentity(cfg);
      if (!image) return this.refuseAccept('image-identity-unknown');
      if (!this.dryRun.doneFor(req.lane, image)) return this.refuseAccept('dry-run-not-done');
    }
    // C items 4 and 5, when an earlier preparation of these two commits already found the answer.
    const known = this.pairRefusals.get(pairKey(req.baseSha, req.headSha));
    if (known) return this.refuseAccept(known);
    if (this.holdOff.holding(this.now())) await this.sampleDuringHoldOff();
    if (this.holdOff.holding(this.now())) return { status: 200, body: this.answer(req, 'owner-busy') };
    if (req.prepare) return this.acceptPrepare(req);
    return this.acceptSlice(req, cfg);
  }

  private acceptPrepare(req: HelperSliceRequest): HelperHttpAnswer {
    this.learned.noteRun(req.runAttemptId);
    const t = this.trees.get(pairKey(req.baseSha, req.headSha));
    if (t && t.state !== 'failed') { this.touchTree(t, req.runAttemptId); return { status: 202, body: this.answer(req, 'preparing') }; }
    // A new request for a pair whose last preparation failed starts over: the old failure is no longer this pair's state.
    if (t) this.trees.delete(t.key);
    if (this.current || this.pendingPrep) {
      // One queue: a newer preparation waits for the current work (at most one waiting).
      this.pendingPrep = { baseSha: req.baseSha, headSha: req.headSha, runAttemptId: req.runAttemptId, attemptId: req.attemptId };
      return { status: 202, body: this.answer(req, 'preparing') };
    }
    void this.prepare(req.baseSha, req.headSha, req.runAttemptId, req.attemptId);
    return { status: 202, body: this.answer(req, 'preparing') };
  }

  private async drainPending(): Promise<void> {
    const p = this.pendingPrep;
    if (!p || this.current || this.stopped) return;
    this.pendingPrep = null;
    // It runs right after a stop too: a pause or a memory hold-off drops it instead of booting the sandbox.
    if (this.paused() || this.holdOff.holding(this.now())) {
      this.audit({ event: 'helper-prep-dropped', headSha: p.headSha, why: this.paused() ? 'paused' : 'owner-busy' });
      return;
    }
    await this.prepare(p.baseSha, p.headSha, p.runAttemptId, p.attemptId);
  }

  /** A request named this tree: it is in use by that verify, and its 10 minutes start again. */
  private touchTree(t: PreparedTree, runAttemptId: string): void {
    t.lastUsed = this.now();
    t.runs.add(runAttemptId);
    t.over = false;
  }

  /**
   * One owner sample while a memory hold-off is on, so it can end: memory must have stayed normal
   * for the hold-off period. Taken on each request during the hold-off and every 30 s by a timer.
   */
  async sampleDuringHoldOff(): Promise<void> {
    if (!this.holdOff.holding(this.now())) return;
    const s = await this.d.ownerLoad.sample().catch(() => null);
    this.holdOff.noteSample(s ? s.memoryPressure : null, this.now());
  }

  private startHoldOffSampling(): void {
    if (this.holdOffTimer || this.stopped) return;
    this.holdOffTimer = setInterval(() => {
      void this.sampleDuringHoldOff().then(() => {
        if (!this.holdOff.holding(this.now()) && this.holdOffTimer) { clearInterval(this.holdOffTimer); this.holdOffTimer = null; this.audit({ event: 'helper-hold-off-ended' }); }
      }).catch(() => undefined);
    }, HOLD_OFF_SAMPLE_MS);
    this.holdOffTimer.unref?.();
  }

  /** The owner check that comes BEFORE the sandbox boots: pause, hold-off, then one governor sample. */
  private async ownerGate(cfg: HelperConfig, deadlineAt: number | null): Promise<{ stop: GovernorStop | 'owner-busy' | null; workers: number; ownerCores: number | null }> {
    if (this.paused()) return { stop: 'paused', workers: 0, ownerCores: null };
    if (this.holdOff.holding(this.now())) return { stop: 'owner-busy', workers: 0, ownerCores: null };
    const s = await this.d.ownerLoad.sample().catch(() => null);
    if (s) this.holdOff.noteSample(s.memoryPressure, this.now());
    const dec = decideGovernor(s, { cpus: cfg.sandbox.cpus, reserveCores: cfg.reserveCores, stopOnBattery: cfg.stopOnBattery, workerCeiling: sandboxWorkerCeiling(cfg.sandbox, HELPER_LIMITS.workersPerGb), now: this.now(), deadlineAt, cancelled: false, paused: false });
    if (dec.stop === 'memory-pressure') { this.holdOff.noteStop(this.now()); this.bumpDay('pressureStops'); this.startHoldOffSampling(); }
    this.lastOwner = { at: this.now(), workersFree: dec.workersAllowed, ownerCores: dec.ownerCores, stop: dec.stop };
    return { stop: dec.stop, workers: dec.workersAllowed, ownerCores: dec.ownerCores };
  }

  private reader(treeish: string): TreeReader {
    return { read: (f) => this.d.trees.read(treeish, f) };
  }

  /**
   * Check a slice against the tree this helper built, then queue it and answer at once with its
   * id (`queued`). Its result comes through the signed status answer.
   */
  private async acceptSlice(req: HelperSliceRequest, cfg: HelperConfig): Promise<HelperHttpAnswer> {
    const tree = this.trees.get(pairKey(req.baseSha, req.headSha));
    if (!tree || tree.state !== 'ready' || !tree.treeHash) return this.refuse('not-prepared');
    // Every file exists in the merge tree this helper built, belongs to the requested lane, and passes D.
    let entries: Set<string>;
    try { entries = new Set((await this.d.trees.entries(tree.treeHash)).map((e) => e.path)); } catch { return this.refuse('merged-unknown', 503); }
    if (req.files.some((f) => !entries.has(f))) return this.refuse('file-missing');
    // The check slice holds the fixture files with known outcomes and nothing else: a real test
    // file never rides it (its result would be read as a fixture's, and it jumps the slice order).
    if (req.use === 'check' && req.files.some((f) => !isBorrowedCanaryFile(f))) return this.refuse('check-not-fixture');
    if (req.files.some((f) => !isBorrowableTestFile(f, req.lane))) return this.refuse('file-wrong-lane');
    const learnedFiles = this.learned.files();
    const onList = req.files.filter((f) => learnedFiles.has(f));
    if (req.retrial && onList.length > HELPER_LIMITS.retrialMaxFiles) return this.refuse('retrial-too-large');
    // The word scan does not run here: it records and no longer blocks (D, amended), and the run
    // machine is the one that records its hits. What still refuses: the Mac-only list and the learned list.
    const verdicts: EligibilityVerdict[] = await judgeEligibility(req.files, req.lane, this.reader(tree.treeHash), learnedFiles, { ...(req.retrial ? { bypassLearned: new Set(onList) } : {}), scan: false });
    const bad = verdicts.filter((v) => !v.eligible);
    if (bad.length > 0) return { ...this.refuse('file-ineligible'), body: { state: 'refused', reason: 'file-ineligible', files: bad.map((v) => ({ file: v.file, reason: v.reason })) } };
    if (this.paused()) return this.refuse('paused');
    if (this.stopped) return this.refuse('disabled');
    if (this.queue.length >= HELPER_LIMITS.maxQueuedSlices) return this.refuse('queue-full');
    this.touchTree(tree, req.runAttemptId);
    this.queue.push({ req, cfg, key: tree.key, rank: sliceClassRank(req.use ?? 'compare'), order: this.arrival++ });
    this.audit({ event: 'helper-slice-queued', attemptId: req.attemptId, lane: req.lane, use: req.use, files: req.files.length, waiting: this.queue.length });
    const queued = this.answer(req, 'queued');
    this.pump();
    return { status: 202, body: queued };
  }

  /** The waiting slices in the order they will be served: check, then counted, then compare-only; arrival within a class. */
  private orderedQueue(): QueuedSlice[] {
    return [...this.queue].sort((a, b) => a.rank - b.rank || a.order - b.order);
  }

  /** Start the next piece of work if nothing runs: the next slice in order, else a waiting preparation. */
  private pump(): void {
    if (this.current || this.stopped) return;
    const next = this.orderedQueue()[0];
    if (!next) { void this.drainPending(); return; }
    this.queue.splice(this.queue.indexOf(next), 1);
    void this.runQueued(next);
  }

  private async runQueued(q: QueuedSlice): Promise<void> {
    const tree = this.trees.get(q.key);
    let ans: HelperSliceAnswer;
    if (!tree || tree.state !== 'ready' || !tree.treeHash) {
      // Its tree went while it waited (evicted for a newer one, or the sandbox was re-created).
      ans = this.answer(q.req, 'refused', { reason: 'not-prepared' });
    } else {
      try { ans = await this.runSlice(q.req, q.cfg, tree); }
      catch (e) {
        this.audit({ event: 'helper-slice-error', attemptId: q.req.attemptId, detail: String(e instanceof Error ? e.message : e).slice(0, 200) });
        ans = this.answer(q.req, 'refused', { reason: 'slice-error' });
      }
    }
    this.record(q.req, ans);
    // The owner needs the machine (not: this one slice was cancelled, or ran out of its own time):
    // everything still waiting goes back too, instead of asking the owner again slice by slice.
    const ownerStop = (ans.state === 'owner-busy' || ans.state === 'handed-back') && ans.reason !== 'deadline' && ans.reason !== 'cancelled';
    if (ownerStop) this.flushQueue('owner-busy', String(ans.reason ?? 'owner-busy'));
    // The sandbox itself cannot be used (its walls are unproven, or the host disk is short): the
    // same holds for every waiting slice, and each try would start and check the sandbox again.
    if (ans.state === 'refused' && SANDBOX_REFUSALS.includes(String(ans.reason))) this.flushQueue('refused', String(ans.reason));
    await this.sweepTrees();
    this.pump();
  }

  /** Keep a finished slice's signed answer for the status answer, and wake anyone waiting on it in-process. */
  private record(req: HelperSliceRequest, ans: HelperSliceAnswer): void {
    this.results.push({ seq: ++this.resultSeq, runAttemptId: req.runAttemptId, answer: ans });
    if (this.results.length > HELPER_LIMITS.resultsKeptMax) {
      const dropped = this.results.splice(0, this.results.length - HELPER_LIMITS.resultsKeptMax);
      // Never Silently Cut: a result nobody read is named; the run machine runs those files itself.
      this.audit({ event: 'helper-results-dropped', count: dropped.length, lastSeq: dropped[dropped.length - 1].seq });
    }
    for (const w of this.waiters.get(req.attemptId) ?? []) w(ans);
    this.waiters.delete(req.attemptId);
  }

  /** Answer every waiting slice (or one verify's) without running it. */
  private flushQueue(state: 'owner-busy' | 'cancelled' | 'refused', reason: string, runAttemptId?: string): number {
    const out = this.queue.filter((x) => runAttemptId === undefined || x.req.runAttemptId === runAttemptId);
    for (const x of out) {
      this.queue.splice(this.queue.indexOf(x), 1);
      this.record(x.req, this.answer(x.req, state, { reason }));
    }
    if (out.length > 0) this.audit({ event: 'helper-queue-flushed', state, reason, slices: out.length });
    return out.length;
  }

  /**
   * In-process only (the on-host suites and a caller holding the service): the last signed answer
   * of an accepted slice, once it has one; null when this helper holds no such slice. Over the
   * wire the same answer is read from the status answer.
   */
  whenSliceAnswered(attemptId: string): Promise<HelperSliceAnswer | null> {
    const done = this.results.find((r) => r.answer.attemptId === attemptId);
    if (done) return Promise.resolve(done.answer);
    const held = this.queue.some((x) => x.req.attemptId === attemptId) || (this.current?.kind === 'slice' && this.current.attemptId === attemptId);
    if (!held) return Promise.resolve(null);
    return new Promise((resolve) => { this.waiters.set(attemptId, [...(this.waiters.get(attemptId) ?? []), resolve]); });
  }

  // ── the sandbox ─────────────────────────────────────────────────────

  private async ensureSandbox(cfg: HelperConfig): Promise<HelperRefusal | null> {
    const drv = this.d.driver!;
    const st = await drv.status();
    if (!st.exists) { await drv.create(cfg.sandbox); this.lastCreatedAt = this.now(); }
    if (!this.sandboxUp || !st.running) {
      const { startMs } = await drv.start();
      this.bumpDay('sandboxStarts');
      this.sandboxUp = true;
      this.lastSandboxStartMs = startMs;
      this.audit({ event: 'helper-sandbox-start', sandboxStartMs: startMs });
      // B2: the walls are checked at every start. A failed check recreates the sandbox at once, and is checked again.
      // B2 and the sandbox property test: the walls are checked at every start, with only the DIGESTS of host credentials passed in.
      const facts = { credentialDigests: this.credentialDigests() };
      let report = await drv.checks(facts);
      if (!report.ok) {
        this.audit({ event: 'helper-containment-failed', reason: report.reason });
        await drv.destroy();
        // The recreated sandbox has none of the old trees. (The package volume is its own disk and stays.)
        for (const [h, t] of [...this.trees]) if (t.state !== 'preparing') this.trees.delete(h);
        await drv.create(cfg.sandbox);
        this.lastCreatedAt = this.now();
        await drv.start();
        report = await drv.checks(facts);
      }
      this.containment = { ...report, checkedAt: new Date(this.now()).toISOString() };
      if (!report.ok) {
        await this.stopSandbox('containment');
        return 'helper-containment-unproven';
      }
    }
    if (!this.containment?.ok) return 'helper-containment-unproven';
    const st2 = await drv.status();
    // The margin covers what the sandbox disk AND the package volume's own disk may still grow by.
    const pkg = typeof st2.pkgDiskCapBytes === 'number' ? { capBytes: st2.pkgDiskCapBytes, fileBytes: st2.pkgDiskFileBytes ?? null } : undefined;
    if (!hostDiskOk(await this.d.hostFreeBytes(), cfg.sandbox.diskGb, st2.diskFileBytes, pkg)) return 'host-disk-low';
    return null;
  }

  private credentialDigests(): string[] {
    try { return (this.d.credentialDigests?.() ?? []).filter((x) => /^[0-9a-f]{64}$/.test(x)); } catch { return []; } // @silent-fallback-ok: without digests the property test still checks names, shapes, paths and sockets
  }

  private async stopSandbox(why: string): Promise<void> {
    if (!this.d.driver || !this.sandboxUp) return;
    try { await this.d.driver.stop(); } catch (e) { this.audit({ event: 'helper-sandbox-stop-error', detail: String(e) }); }
    this.sandboxUp = false;
    this.bumpDay('sandboxStops');
    let peak: number | null = null;
    try { peak = (await this.d.driver.status()).peakMemMb; } catch { peak = null; } // @silent-fallback-ok: peak memory is observability only
    if (peak !== null) this.sandboxPeakMemMb = Math.max(this.sandboxPeakMemMb ?? 0, peak);
    this.audit({ event: 'helper-sandbox-stop', why, sandboxPeakMemMb: peak });
  }

  /** Kill every tester/builder process, at most 3 times 1 s apart; survivors restart the sandbox. */
  private async boundedReap(): Promise<boolean> {
    const drv = this.d.driver!;
    for (let i = 0; i < HELPER_LIMITS.cleanupKillAttempts; i++) {
      const r = await drv.reap();
      if (r.survivors === 0) return true;
      if (i < HELPER_LIMITS.cleanupKillAttempts - 1) await this.sleep(HELPER_LIMITS.cleanupKillIntervalMs);
    }
    this.audit({ event: 'helper-reap-restart' });
    try { await drv.stop(); this.sandboxUp = false; await drv.start(); this.sandboxUp = true; this.bumpDay('sandboxStarts'); }
    catch (e) { this.sandboxUp = false; this.audit({ event: 'helper-reap-restart-error', detail: String(e) }); }
    return false;
  }

  /**
   * Run `fn` under the governor: every 2 s one owner sample; a stop aborts the work at once.
   * Returns the stop (if any), when it was decided, and the largest owner load seen.
   */
  private async governed<T>(work: CurrentWork, cfg: HelperConfig, deadlineAt: number | null, fn: (signal: AbortSignal) => Promise<T>): Promise<{ result: T | null; error: unknown }> {
    let done = false;
    const ceiling = sandboxWorkerCeiling(cfg.sandbox, HELPER_LIMITS.workersPerGb);
    const loop = (async () => {
      while (!done) {
        await this.sleep(HELPER_LIMITS.governorPeriodMs);
        if (done) break;
        const s = await this.d.ownerLoad.sample().catch(() => null);
        if (s) this.holdOff.noteSample(s.memoryPressure, this.now());
        const dec = decideGovernor(s, { cpus: cfg.sandbox.cpus, reserveCores: cfg.reserveCores, stopOnBattery: cfg.stopOnBattery, workerCeiling: ceiling, now: this.now(), deadlineAt, cancelled: work.stop === 'cancelled', paused: this.paused() });
        if (dec.ownerCores !== null) work.ownerCoresMax = Math.max(work.ownerCoresMax ?? 0, Math.round(dec.ownerCores * 100) / 100);
        if (work.stop !== 'cancelled' && dec.stop !== 'paused') this.lastOwner = { at: this.now(), workersFree: dec.workersAllowed, ownerCores: dec.ownerCores, stop: dec.stop };
        // The worker count is fixed when a slice starts: a lower allowance that stays ≥ 1 lets it finish.
        if (dec.stop && !done) {
          if (!work.stop) { work.stop = dec.stop; work.stopAt = this.now(); }
          work.abort.abort();
          break;
        }
      }
    })();
    try {
      const result = await fn(work.abort.signal);
      return { result, error: null };
    } catch (error) {
      return { result: null, error };
    } finally {
      done = true;
      await loop.catch(() => undefined);
    }
  }

  private async afterStop(work: CurrentWork): Promise<void> {
    if (work.stop === 'memory-pressure') { this.holdOff.noteStop(this.now()); this.bumpDay('pressureStops'); this.startHoldOffSampling(); }
    if (stopsSandbox(work.stop)) await this.stopSandbox(work.stop!);
  }

  /** Delete a prepared tree from the sandbox, unless another prepared pair has the very same tree. */
  private async removeSandboxTree(t: PreparedTree): Promise<void> {
    if (!t.treeHash || !this.d.driver) return;
    if ([...this.trees.values()].some((o) => o !== t && o.treeHash === t.treeHash)) return;
    await this.d.driver.removeTree(t.treeHash).catch((e) => this.audit({ event: 'helper-tree-remove-error', detail: String(e) }));
  }

  private evictFor(key: string): Promise<void>[] {
    const out: Promise<void>[] = [];
    const others = [...this.trees.values()].filter((t) => t.key !== key && this.current?.key !== t.key && !this.queue.some((q) => q.key === t.key)).sort((a, b) => a.lastUsed - b.lastUsed);
    while (this.trees.size >= HELPER_LIMITS.preparedTreesMax && others.length > 0) {
      const t = others.shift()!;
      this.trees.delete(t.key);
      this.audit({ event: 'helper-tree-evicted', baseSha: t.baseSha, headSha: t.headSha });
      out.push(this.removeSandboxTree(t));
    }
    return out;
  }

  // ── preparation ─────────────────────────────────────────────────────

  /**
   * The packages for one install-inputs hash, ready on the package volume; returns their manifest
   * digest, or null when the work was stopped.
   *
   * A cached set is used only after its manifest is recomputed inside the sandbox and equals the
   * digest this host recorded at install; a failed check discards the set. On a miss the packages
   * are installed in the tree of `mergedSha`, a commit this helper's OWN merged check has passed
   * (asserted again here, so no caller can install from anything else), with that commit's own
   * install steps. A waiting change's tree is never an install tree.
   */
  private async ensurePackages(cfg: HelperConfig, hash: string, mergedSha: string, signal: AbortSignal): Promise<string | null> {
    const drv = this.d.driver!;
    const have = this.packages.get(hash);
    if (have) {
      if (await drv.verifyPackages(hash, have.manifestDigest)) { this.packages.touch(hash); return have.manifestDigest; }
      this.audit({ event: 'helper-packages-discarded', hash, why: 'manifest-check-failed' });
      await drv.discardPackages(hash).catch((e) => this.audit({ event: 'helper-packages-discard-error', detail: String(e) }));
      this.packages.remove(hash);
    }
    if (signal.aborted) return null;
    if (await this.mergedOnMain(cfg, mergedSha) !== true) throw new Error('install-refused:base-not-merged');
    // Its own tree, used for the install and deleted: lifecycle scripts ran in it.
    const scratch = crypto.createHash('sha256').update(`install:${hash}:${mergedSha}`).digest('hex').slice(0, 40);
    await drv.reap();
    await drv.copyIn(scratch, await this.d.trees.archive(mergedSha));
    let r: { exitCode: number | null; manifestDigest: string | null } = { exitCode: null, manifestDigest: null };
    try {
      if (signal.aborted) return null;
      r = await drv.installPackages(hash, scratch, signal);
    } finally {
      // All builder processes are killed after every npm ci, and the install tree goes.
      await drv.reap();
      await drv.removeTree(scratch).catch((e) => this.audit({ event: 'helper-tree-remove-error', detail: String(e) }));
    }
    if (signal.aborted) return null;
    if (r.exitCode === PKG_VOLUME_MISSING_EXIT) throw new Error('package-volume-missing');
    if (r.exitCode !== 0 || !r.manifestDigest) throw new Error(`install-failed:${String(r.exitCode)}`);
    for (const old of this.packages.record(hash, mergedSha, r.manifestDigest)) {
      await drv.discardPackages(old).catch((e) => this.audit({ event: 'helper-packages-discard-error', detail: String(e) }));
    }
    this.audit({ event: 'helper-packages-installed', hash, mergedCommit: mergedSha });
    return r.manifestDigest;
  }

  async prepare(baseSha: string, headSha: string, runAttemptId: string, attemptId: string): Promise<void> {
    const cfg = this.d.config();
    if (!cfg || !this.d.driver || this.current || this.stopped) return;
    const key = pairKey(baseSha, headSha);
    const blank = (state: PreparedTree['state'], reason?: string): PreparedTree =>
      ({ key, baseSha, headSha, treeHash: null, installHash: null, state, ...(reason ? { reason } : {}), prepMs: null, copyMs: null, lastUsed: this.now(), runAttemptId, runs: new Set([runAttemptId]), over: false });
    // Owner first: nothing boots the sandbox while paused, in a hold-off, or with the owner busy.
    const gate = await this.ownerGate(cfg, null);
    if (gate.stop) {
      this.trees.set(key, blank('failed', `owner-busy:${gate.stop}`));
      this.audit({ event: 'helper-prep-refused', baseSha, headSha, reason: 'owner-busy', stop: gate.stop });
      return;
    }
    if (this.current) return;
    const work: CurrentWork = { kind: 'prep', runAttemptId, attemptId, key, abort: new AbortController(), stop: null, stopAt: null, ownerCoresMax: null };
    this.current = work;
    this.lastWorkAt = this.now();
    await Promise.all(this.evictFor(key));
    const tree = blank('preparing');
    this.trees.set(key, tree);
    const t0 = this.now();
    const sameCommit = baseSha === headSha;
    let refusal: HelperRefusal | null = null;
    try {
      const why = await this.ensureSandbox(cfg);
      if (why) { tree.state = 'failed'; tree.reason = why; this.lastRefusal = { reason: why, at: new Date(this.now()).toISOString() }; this.audit({ event: 'helper-prep-refused', baseSha, headSha, reason: why }); return; }
      const before = await this.d.driver.sandboxFreeBytes();
      if (before === null || before < this.peakPrepBytes) { tree.state = 'failed'; tree.reason = 'disk-low'; this.audit({ event: 'helper-prep-refused', baseSha, headSha, reason: 'disk-low', freeBytes: before, peakPrepBytes: this.peakPrepBytes }); return; }
      const { error } = await this.governed(work, cfg, null, async (signal) => {
        const drv = this.d.driver!;
        // C item 4: both commits with their history, then the merge, in this helper's own clone.
        await this.d.trees.fetch(cfg.pinnedRepoUrl, sameCommit ? [baseSha] : [baseSha, headSha]);
        if (signal.aborted) return;
        const merge = await this.d.trees.mergeTree(baseSha, headSha);
        if ('conflict' in merge) { refusal = 'merge-conflict'; return; }
        tree.treeHash = merge.tree;
        const mergeEntries = await this.d.trees.entries(merge.tree);
        const baseEntries = sameCommit ? mergeEntries : await this.d.trees.entries(baseSha);
        if (treeHasNodeModules(mergeEntries) || treeHasNodeModules(baseEntries)) { refusal = 'tree-has-node-modules'; return; }
        // C item 5: the install inputs of the merge tree against the same inputs at `baseSha`.
        const baseInputs = await readInstallInputs(baseEntries, (f) => this.d.trees.read(baseSha, f));
        const mergedInputs = sameCommit ? baseInputs : await readInstallInputs(mergeEntries, (f) => this.d.trees.read(merge.tree, f));
        const inputs = judgeInstallInputs({ base: baseInputs, merged: mergedInputs, baseEntries, mergeEntries, sameCommit });
        if (!inputs.ok) { refusal = 'install-inputs-changed'; this.audit({ event: 'helper-install-inputs-changed', baseSha, headSha, why: inputs.why }); return; }
        tree.installHash = inputs.hash;
        if (signal.aborted) return;
        // The package volume is its own disk beside the sandbox image: without it nothing is installed or placed.
        if (!(await drv.packageVolumeReady())) { refusal = 'package-volume-missing'; return; }
        // Packages: by that hash, from merged code only.
        const manifest = await this.ensurePackages(cfg, inputs.hash, baseSha, signal);
        if (manifest === null || signal.aborted) return;
        // The locked packages go in first; only then is any file of the tree to test placed beside them.
        await drv.reap();
        await drv.placePackages(merge.tree, inputs.hash, manifest);
        const { copyMs } = await drv.copyIn(merge.tree, await this.d.trees.archive(merge.tree), { placed: true });
        tree.copyMs = copyMs;
        if (signal.aborted) return;
        // All builder processes are killed before and after every build.
        await drv.reap();
        const r = await drv.build(merge.tree, signal);
        if (signal.aborted) return;
        if (r.exitCode !== 0) throw new Error(`build-failed:${String(r.exitCode)}`);
        await drv.reap();
        await drv.sealTree(merge.tree);
      });
      if (work.stop) {
        await this.boundedReap();
        tree.state = 'failed'; tree.reason = `prep-stopped:${work.stop}`;
        this.trees.delete(key);
        await this.removeSandboxTree(tree);
        this.audit({ event: 'helper-prep-stopped', baseSha, headSha, stop: work.stop, handBackMs: work.stopAt !== null ? this.now() - work.stopAt : null });
        await this.afterStop(work);
        return;
      }
      // `refusal` is assigned inside the governed callback; the cast undoes the narrowing to null.
      const refused = refusal as HelperRefusal | null;
      if (refused) {
        tree.state = 'failed'; tree.reason = refused;
        if (PAIR_REFUSALS.includes(refused)) {
          this.pairRefusals.set(key, refused);
          if (this.pairRefusals.size > 50) this.pairRefusals.delete(this.pairRefusals.keys().next().value as string);
        }
        this.lastRefusal = { reason: refused, at: new Date(this.now()).toISOString() };
        this.audit({ event: 'helper-prep-refused', baseSha, headSha, reason: refused });
        return;
      }
      if (error) { tree.state = 'failed'; tree.reason = String(error instanceof Error ? error.message : error).slice(0, 200); this.audit({ event: 'helper-prep-failed', baseSha, headSha, reason: tree.reason }); return; }
      const after = await this.d.driver.sandboxFreeBytes();
      if (after !== null) this.peakPrepBytes = Math.max(this.peakPrepBytes, before - after);
      try {
        // Every lane's test files: a learned-list file whose content changed is due a trial.
        const tests = (await this.d.trees.entries(tree.treeHash!)).filter((e) => laneOfTestFile(e.path) !== null);
        this.currentBlobs = new Map(tests.map((e) => [e.path, e.object]));
      } catch { /* @silent-fallback-ok: the content hashes stay at their last values */ }
      await this.imageIdentity(cfg);
      tree.state = 'ready';
      // Its 10 minutes without a request start when it is ready, not when its preparation was asked for.
      tree.lastUsed = this.now();
      tree.prepMs = this.now() - t0;
      this.audit({ event: 'helper-prepared', baseSha, headSha, treeHash: tree.treeHash, installHash: tree.installHash, prepMs: tree.prepMs, copyMs: tree.copyMs });
    } catch (e) {
      tree.state = 'failed';
      tree.reason = String(e instanceof Error ? e.message : e).slice(0, 200);
      this.audit({ event: 'helper-prep-failed', baseSha, headSha, reason: tree.reason });
    } finally {
      this.current = null;
      this.lastWorkAt = this.now();
      // Slices that waited for this tree go first; a waiting preparation follows them.
      this.pump();
    }
  }

  /**
   * One dry-run slice was answered: note its files (each with its helper time and whether it
   * passed here), and write this lane's "dry run done" record once every file of the lane a helper
   * may be sent has been answered for this commit on this image. The record is what C item 3 reads
   * before any waiting change, and it carries the share of the lane's time that passed ("lane proven").
   */
  private async noteDryRun(req: HelperSliceRequest, cfg: HelperConfig, tree: PreparedTree, perFile: readonly HelperPerFile[]): Promise<void> {
    try {
      const image = await this.imageIdentity(cfg);
      if (!image || !tree.treeHash) return;
      const laneFiles = (await this.d.trees.entries(tree.treeHash)).map((e) => e.path).filter((f) => laneOfTestFile(f) === req.lane && excludedBy(f) === null);
      const answered = perFile.map((p) => ({ file: p.file, ms: p.ms, passed: p.tests > 0 && p.failed === 0 }));
      const done = this.dryRun.noteAnswered(req.lane, image, req.baseSha, answered, laneFiles);
      if (done) this.audit({ event: 'helper-dry-run-done', lane: done.lane, commit: done.commit, imageDigest: done.imageDigest, settingsHash: done.settingsHash, files: done.files, passedFiles: done.passedFiles, passedShare: done.passedShare, proven: dryRunLaneProven(done) });
    } catch (e) {
      this.audit({ event: 'helper-dry-run-note-error', detail: String(e instanceof Error ? e.message : e).slice(0, 200) });
    }
  }

  // ── a slice ─────────────────────────────────────────────────────────

  /** One finished file of the running slice, passed on by the root-owned runner: it joins the slice's progress. */
  private noteProgress(prog: SliceProgress, req: HelperSliceRequest, p: TesterProgress): void {
    if (this.progress !== prog) return;
    const got = buildPerFile(req.files, p.reportText, p.rootDir, { onlyReported: true });
    let changed = false;
    for (const f of got.files) {
      // The first report of a file stands: progress never changes a result it has already given.
      if (prog.files.has(f.file)) continue;
      prog.files.set(f.file, f);
      changed = true;
    }
    if (p.unhandledErrors > prog.unhandled) { prog.unhandled = p.unhandledErrors; changed = true; }
    // The sequence number rises with every change, so a reader can tell a newer progress answer from an older one.
    if (changed) prog.seq++;
  }

  private async runSlice(req: HelperSliceRequest, cfg: HelperConfig, tree: PreparedTree): Promise<HelperSliceAnswer> {
    const work: CurrentWork = { kind: 'slice', runAttemptId: req.runAttemptId, attemptId: req.attemptId, key: tree.key, abort: new AbortController(), stop: null, stopAt: null, ownerCoresMax: null };
    this.current = work;
    this.lastWorkAt = this.now();
    tree.lastUsed = this.now();
    const prog: SliceProgress = { attemptId: req.attemptId, runAttemptId: req.runAttemptId, lane: req.lane, treeHash: tree.treeHash!, seq: 0, files: new Map(), unhandled: 0 };
    // What the slice finished before it was stopped, in the request's order: a hand-back repeats it.
    const finished = (): HelperPerFile[] => req.files.map((f) => prog.files.get(f)).filter((x): x is HelperPerFile => !!x);
    try {
      // Owner first: the sample comes before the sandbox boots.
      const dec = await this.ownerGate(cfg, req.deadlineAt);
      if (dec.stop) {
        if (dec.stop === 'battery' || dec.stop === 'paused') await this.stopSandbox(dec.stop);
        if (dec.stop === 'memory-pressure') await this.stopSandbox(dec.stop);
        return this.answer(req, 'owner-busy', { reason: dec.stop, ownerCoresMax: dec.ownerCores });
      }
      const why = await this.ensureSandbox(cfg);
      if (why) return this.answer(req, 'refused', { reason: why });
      work.ownerCoresMax = dec.ownerCores;
      this.progress = prog;
      // One process per slice. A unit slice takes as many workers as the governor allows;
      // integration and end-to-end files run one at a time, as on a run machine.
      const workers = sliceWorkers(req.lane, dec.workers);
      const { result, error } = await this.governed(work, cfg, req.deadlineAt, (signal) => this.d.driver!.execAsTester(tree.treeHash!, { lane: req.lane, files: req.files, workers, signal, onProgress: (p) => this.noteProgress(prog, req, p) }));
      // Clean-up after every slice, and the confirmation that nothing is left before answering.
      await this.boundedReap();
      const handBackMs = work.stopAt !== null ? this.now() - work.stopAt : null;
      if (work.stop) {
        // A hand-back (or a cancel) keeps the files that finished: the answer repeats their
        // results, and lists nothing for the rest. The run machine may use them as provisional
        // only because this last answer repeats them and reports the unhandled errors so far.
        const kept = finished();
        this.audit({ event: 'helper-handed-back', attemptId: req.attemptId, stop: work.stop, handBackMs, finished: kept.length, of: req.files.length });
        await this.afterStop(work);
        return this.answer(req, work.stop === 'cancelled' ? 'cancelled' : 'handed-back', {
          reason: work.stop, handBackMs, ownerCoresMax: work.ownerCoresMax, perFile: kept,
          slice: { exitCode: null, unhandledErrors: prog.unhandled, collected: false, vitestStartMs: null },
          progress: req.files.length > 0 ? Math.round((kept.length / req.files.length) * 1000) / 1000 : 0,
        });
      }
      if (error || !result) {
        this.audit({ event: 'helper-slice-error', attemptId: req.attemptId, detail: String(error instanceof Error ? error.message : error).slice(0, 200) });
        return this.answer(req, 'done', { slice: { exitCode: null, unhandledErrors: prog.unhandled, collected: false, vitestStartMs: null }, perFile: [], ownerCoresMax: work.ownerCoresMax });
      }
      if (result.oversize) {
        // Never Silently Cut: the whole result is refused, counted and named in the report.
        this.audit({ event: 'result-oversize', attemptId: req.attemptId, bytesSeen: result.oversize.bytesSeen });
        return this.answer(req, 'done', { resultOversize: { bytesSeen: result.oversize.bytesSeen }, slice: { exitCode: result.exitCode, unhandledErrors: result.unhandledErrors, collected: false, vitestStartMs: result.vitestStartMs }, ownerCoresMax: work.ownerCoresMax });
      }
      const perFile = buildPerFile(req.files, result.resultText, result.rootDir);
      const collected = perFile.parsed && perFile.files.every((p) => p.tests > 0);
      const unhandled = Math.max(result.unhandledErrors, prog.unhandled);
      const final = this.answer(req, 'done', {
        perFile: perFile.files,
        slice: { exitCode: result.exitCode, unhandledErrors: unhandled, collected, vitestStartMs: result.vitestStartMs },
        ownerCoresMax: work.ownerCoresMax, handBackMs: null, progress: 1,
      });
      // The last answer must repeat what progress already reported for each file. One that would
      // not is withheld whole: this helper never sends a last answer that contradicts its progress.
      const contradicted = finalContradictsProgress(finished(), final);
      if (contradicted !== null) {
        this.audit({ event: 'helper-progress-contradicted', attemptId: req.attemptId, file: contradicted });
        return this.answer(req, 'done', { reason: 'progress-contradicted', perFile: [], slice: { exitCode: result.exitCode, unhandledErrors: unhandled, collected: false, vitestStartMs: result.vitestStartMs }, ownerCoresMax: work.ownerCoresMax });
      }
      // A dry-run slice whose report was read counts toward this lane's dry run, whatever its files' outcomes.
      if (req.dryRun && perFile.parsed) await this.noteDryRun(req, cfg, tree, perFile.files);
      return final;
    } catch (e) {
      this.audit({ event: 'helper-slice-error', attemptId: req.attemptId, detail: String(e instanceof Error ? e.message : e).slice(0, 200) });
      return this.answer(req, 'refused', { reason: 'slice-error' });
    } finally {
      if (this.progress === prog) this.progress = null;
      this.current = null;
      this.lastWorkAt = this.now();
      tree.lastUsed = this.now();
    }
  }

  /**
   * A signed cancel. With slice ids: stop or dequeue only those slices of the run, and delete
   * nothing. Without: stop the run's work and drop everything of it that waits (its slices, a
   * queued preparation, a preparation in progress). The run's prepared tree is KEPT, so the
   * failing-direction request can still use it; it goes when the run machine says the verify is
   * over (`verifyOver`) or after 10 minutes with no request for it.
   */
  async handleCancel(body: unknown, route: RouteFacts): Promise<HelperHttpAnswer> {
    const a = this.admit(body, 'cancel', route);
    if ('status' in a) return a;
    const req = a.req as SignedHelperRequest<HelperCancelRequest>;
    const cur = this.current;
    let stopped = false;
    let dequeued = 0;
    if (req.attemptIds) {
      if (cur && cur.kind === 'slice' && cur.runAttemptId === req.runAttemptId && req.attemptIds.includes(cur.attemptId)) {
        if (!cur.stop) { cur.stop = 'cancelled'; cur.stopAt = this.now(); }
        cur.abort.abort();
        stopped = true;
      }
      for (const x of this.queue.filter((q) => q.req.runAttemptId === req.runAttemptId && req.attemptIds!.includes(q.req.attemptId))) {
        this.queue.splice(this.queue.indexOf(x), 1);
        this.record(x.req, this.answer(x.req, 'cancelled', { reason: 'cancelled' }));
        dequeued++;
      }
      this.audit({ event: 'helper-cancel', runAttemptId: req.runAttemptId, stopped, dequeued, removed: 0, slices: req.attemptIds.length });
      return { status: 200, body: { cancelled: true, stopped, dequeued, removedTrees: [] } };
    }
    if (cur && cur.runAttemptId === req.runAttemptId) {
      if (!cur.stop) { cur.stop = 'cancelled'; cur.stopAt = this.now(); }
      cur.abort.abort();
      stopped = true;
    }
    dequeued = this.flushQueue('cancelled', 'cancelled', req.runAttemptId);
    if (this.pendingPrep?.runAttemptId === req.runAttemptId) this.pendingPrep = null;
    const removed: string[] = [];
    if (req.verifyOver) {
      // The verify is over: its trees are no longer kept for it, and its finished answers are no longer needed.
      for (const t of this.trees.values()) {
        if (!t.runs.delete(req.runAttemptId)) continue;
        if (t.runs.size === 0) t.over = true;
      }
      this.results = this.results.filter((r) => r.runAttemptId !== req.runAttemptId);
      removed.push(...await this.sweepTrees());
    }
    this.audit({ event: 'helper-cancel', runAttemptId: req.runAttemptId, stopped, dequeued, removed: removed.length, verifyOver: req.verifyOver === true });
    return { status: 200, body: { cancelled: true, stopped, dequeued, removedTrees: removed } };
  }

  /**
   * Delete prepared trees nothing keeps any more: one whose last verify said it is over, or one no
   * request has named for 10 minutes. Never a tree that is being prepared, is running a slice, or
   * has a slice waiting. Returns the head commits of the trees removed.
   */
  private async sweepTrees(): Promise<string[]> {
    const now = this.now();
    const removed: string[] = [];
    for (const t of [...this.trees.values()]) {
      if (t.state === 'preparing' || this.current?.key === t.key || this.queue.some((q) => q.key === t.key)) continue;
      const idle = now - t.lastUsed >= HELPER_LIMITS.treeRetentionMs;
      if (!t.over && !idle) continue;
      this.trees.delete(t.key);
      removed.push(t.headSha);
      this.audit({ event: 'helper-tree-released', baseSha: t.baseSha, headSha: t.headSha, why: t.over ? 'verify-over' : 'no-request-10-min' });
      await this.removeSandboxTree(t);
    }
    return removed;
  }

  /**
   * What the run machine's comparisons showed, about one merge tree (D). Each observation moves
   * the learned list by its rule; an agreeing one also marks the file as compared on this helper,
   * on its current image and runner version.
   */
  async handleLearned(body: unknown, route: RouteFacts): Promise<HelperHttpAnswer> {
    const a = this.admit(body, 'learned', route);
    if ('status' in a) return a;
    const req = a.req as SignedHelperRequest<HelperLearnedRequest>;
    let blobs: Map<string, string> | null = null;
    try { blobs = new Map((await this.d.trees.entries(req.treeHash)).map((e) => [e.path, e.object])); } catch { blobs = null; } // @silent-fallback-ok: an unknown content hash only means a content change cannot trigger a file's trial
    const results: Array<{ file: string; result: string }> = [];
    const agreed: Record<HelperLane, string[]> = { unit: [], integration: [], e2e: [] };
    for (const o of req.observations) {
      const r = this.learned.observe(o, { runMachine: req.requesterMachineId, runAttemptId: req.runAttemptId, treeHash: req.treeHash, runnerVersion: this.d.runnerVersion, blob: blobs?.get(o.file) ?? null });
      results.push({ file: o.file, result: r });
      const lane = o.kind === 'agree' ? laneOfTestFile(o.file) : null;
      if (lane) agreed[lane].push(o.file);
    }
    // "Compared on": only with an image this helper can name; otherwise the files stay new to it.
    const image = this.d.driver ? await this.imageIdentity(a.cfg) : null;
    let compared = 0;
    if (image) for (const lane of HELPER_LANES) if (agreed[lane].length > 0) compared += this.compared.note({ ...image, runnerVersion: this.d.runnerVersion }, lane, agreed[lane]);
    const count = (k: string): number => results.filter((r) => r.result === k).length;
    this.audit({ event: 'helper-learned', runAttemptId: req.runAttemptId, treeHash: req.treeHash, added: count('added'), removed: count('removed'), candidates: count('candidate'), full: count('full'), compared });
    return { status: 200, body: { ok: true, results, compared } };
  }

  // ── idle ────────────────────────────────────────────────────────────

  async tickIdle(): Promise<void> {
    const now = this.now();
    // The 60 s timer was held for minutes: the machine slept and has woken. Its run machine may have slowed its asking.
    const woke = this.lastTickAt !== null && now - this.lastTickAt >= WAKE_GAP_MS;
    this.lastTickAt = now;
    if (woke) void this.sayHere('wake');
    if (!this.d.driver) return;
    // Prepared trees nobody has asked for in 10 minutes go, whatever else is running.
    await this.sweepTrees();
    if (this.current) return;
    if (this.sandboxUp && now - this.lastWorkAt >= HELPER_LIMITS.idleStopMs) await this.stopSandbox('idle');
    // Fresh sandbox: recreated from its base image once a day while idle. The same pinned image:
    // not an image change, so the dry-run record stands; the package volume is its own disk and stays.
    if (!this.sandboxUp && this.queue.length === 0 && this.lastCreatedAt !== null && now - this.lastCreatedAt >= 24 * 60 * 60_000 && this.d.config()) {
      await this.d.driver.destroy();
      this.trees.clear();
      this.lastCreatedAt = null;
      this.audit({ event: 'helper-sandbox-daily-destroy' });
    }
  }

  /** `instar helper uninstall`: only through the driver seam, plus the helper's own records. */
  async uninstall(): Promise<void> {
    this.shutdown();
    if (this.d.driver) await this.d.driver.uninstall();
    this.learned.clear();
    this.compared.clear();
    this.dryRun.clear();
    this.packages.clear();
  }
}

/**
 * Per-file answer entries for exactly the requested files, from the vitest JSON report: the four
 * counts, the names-and-outcomes digest, and the failed test names (at most 50 per file, each at
 * most 300 characters; a longer or later name is left out, which `failedTests.length < failed` shows).
 */
export function buildPerFile(files: readonly string[], reportText: string | null, rootDir: string, opts: { onlyReported?: boolean } = {}): { files: HelperPerFile[]; parsed: boolean } {
  let report: ReturnType<typeof parseVitestJson> | null = null;
  if (reportText) { try { report = parseVitestJson(reportText, rootDir, { outcomeDigest: true }); } catch { report = null; } } // @silent-fallback-ok: an unparseable report answers uncollected files, which the run machine judges as disagreement-free slice errors
  const out: HelperPerFile[] = [];
  for (const f of files) {
    const c = report?.files.get(f);
    // Every requested file is listed exactly once; one the report lacks has zero tests (not collected) and no digest.
    // (A progress entry lists only what its one-file report holds: `onlyReported`.)
    if (!c) { if (!opts.onlyReported) out.push({ file: f, tests: 0, passed: 0, failed: 0, skipped: 0, todo: 0, ms: 0, digest: null, failedTests: [] }); continue; }
    const failedTests = (c.failedTests ?? []).map((t) => t.name)
      .filter((n) => n.length >= 1 && n.length <= HELPER_LIMITS.maxTestNameChars)
      .slice(0, HELPER_LIMITS.maxFailedTestNamesPerFile);
    out.push({ file: f, tests: c.passed + c.failed + c.skipped + c.todo, passed: c.passed, failed: c.failed, skipped: c.skipped, todo: c.todo, ms: c.ms ?? 0, digest: c.outcomeDigest ?? null, failedTests });
  }
  return { files: out, parsed: report !== null };
}
