/**
 * The borrowed-machine helper role (docs/specs/local-verify-borrowed-unit-slices.md, B to E).
 *
 * Built only on a helper machine whose own agent set `monitoring.localVerify.helper.enabled`
 * after its owner's yes; never by config defaults or migration. It serves only the helper routes
 * and never starts the run-machine Local Verify service. SHADOW ONLY: nothing it answers can
 * reach a verdict.
 *
 * Owner first:
 *  - one queue: preparations and slices run one at a time (a slice arriving while busy is `busy`);
 *  - the governor samples the owner every 2 s and stops at once on zero workers, memory pressure,
 *    battery (when `stopOnBattery`), the deadline, a cancel or a pause; a stop kills every process
 *    in the runner's scope and confirms none is left before answering `handed-back` / `prep-stopped`;
 *  - memory pressure, battery, pause and 15 min idle stop the sandbox itself (memory is only given
 *    back that way); after a pressure stop a hold-off answers `owner-busy`;
 *  - the sandbox walls are checked at every start (`helper-containment-unproven` otherwise), and the
 *    host disk must cover the sandbox disk's remaining growth plus 5 GB.
 *
 * Every OS/sandbox interaction goes through injected seams (driver, owner-load reader, GitHub
 * checker, tree source, signer, clock).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MachineKeyLookup, MachineSigner } from '../../core/AppRecordSignatures.js';
import { SafeFsExecutor } from '../../core/SafeFsExecutor.js';
import { parseVitestJson } from '../laneReport.js';
import { isBorrowableTestFile, judgeEligibility, type EligibilityVerdict, type ScanCache, type TreeReader } from '../borrowedEligibility.js';
import { sandboxWorkerCeiling, type HelperConfig } from './helperConfig.js';
import {
  HELPER_LIMITS, parseHelperRequest, signHelperAnswer,
  type HelperRefusal, type HelperSliceAnswer, type HelperSliceRequest, type HelperPerFile, type SignedHelperRequest, type HelperLearnedRequest,
} from './helperProtocol.js';
import { routeRefusal, signedRequestRefusal, type RouteFacts } from './admission.js';
import { HelperLearnedStore } from './learnedList.js';
import { HelperSeenAttempts } from './seenAttempts.js';
import { PressureHoldOff, decideGovernor, stopsSandbox, type GovernorStop, type OwnerLoadReader } from './governor.js';
import { hostDiskOk, type ContainmentReport, type HelperSandboxDriver } from './sandboxDriver.js';
import type { HostTreeSource, MergedOnMainChecker } from './hostTree.js';

export interface HelperServiceDeps {
  /** Live, parsed setting; null = disabled (routes 404). */
  config: () => HelperConfig | null;
  /** Null when this platform has no supported sandbox (every request refuses `no-sandbox`). */
  driver: HelperSandboxDriver | null;
  ownerLoad: OwnerLoadReader;
  github: MergedOnMainChecker;
  trees: HostTreeSource;
  signer: MachineSigner | null;
  keyLookup: () => MachineKeyLookup;
  stateDir: string;
  helperVersion: string;
  hostFreeBytes: () => Promise<number | null>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  audit?: (event: Record<string, unknown>) => void;
  /** On-host test suites only; production wiring never sets it. */
  allowLoopback?: boolean;
}

interface PreparedTree {
  headSha: string;
  treeId: string;
  state: 'preparing' | 'ready' | 'failed';
  reason?: string;
  prepMs: number | null;
  copyMs: number | null;
  lastUsed: number;
  runAttemptId: string;
}

interface CurrentWork {
  kind: 'prep' | 'slice';
  runAttemptId: string;
  attemptId: string;
  headSha: string;
  abort: AbortController;
  stop: GovernorStop | null;
  stopAt: number | null;
  ownerCoresMax: number | null;
}

export type HelperHttpAnswer = { status: number; body: unknown };

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
  private readonly mergedCache = new Map<string, boolean>();
  private readonly scanCache = new Map<string, ScanCache>();
  private current: CurrentWork | null = null;
  private pendingPrep: { headSha: string; runAttemptId: string; attemptId: string } | null = null;
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
  private eligibleCount = 0;
  /** Content hashes of the newest prepared tree's test files: a changed file is due a re-trial. */
  private currentBlobs = new Map<string, string>();

  constructor(private readonly d: HelperServiceDeps) {
    this.now = d.now ?? (() => Date.now());
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); }));
    this.learned = new HelperLearnedStore(d.stateDir, this.now);
    this.seen = new HelperSeenAttempts(d.stateDir, this.now);
    this.lastWorkAt = this.now();
  }

  /** Start the idle sweep (15 min without work stops the sandbox; a daily recreate while idle). */
  start(): void {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => { void this.tickIdle().catch((e) => this.audit({ event: 'helper-idle-error', detail: String(e) })); }, 60_000);
    this.idleTimer.unref?.();
  }

  shutdown(): void {
    this.stopped = true;
    this.pendingPrep = null;
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
    if (paused && this.current) { this.current.stop = 'paused'; this.current.stopAt = this.now(); this.current.abort.abort(); }
    if (paused) await this.stopSandbox('paused');
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

  status(): Record<string, unknown> {
    const now = this.now();
    const learned = this.learned.entries();
    return {
      enabled: true,
      paused: this.paused(),
      helperVersion: this.d.helperVersion,
      sandbox: { kind: this.d.driver?.kind ?? null, up: this.sandboxUp, containment: this.containment, ownerBusy: this.holdOff.holding(now), holdOffMs: this.holdOff.currentHoldMs(), startMs: this.lastSandboxStartMs, peakMemMb: this.sandboxPeakMemMb },
      busy: this.current ? { kind: this.current.kind, runAttemptId: this.current.runAttemptId, attemptId: this.current.attemptId } : null,
      trees: [...this.trees.values()].map((t) => ({ headSha: t.headSha, state: t.state, prepMs: t.prepMs, copyMs: t.copyMs, ...(t.reason ? { reason: t.reason } : {}) })),
      lastRefusal: this.lastRefusal,
      today: { ...this.day },
      learned: {
        entries: learned.map((e) => ({ ...e, retrialDue: this.learned.retrialDue(e, { helperVersion: this.d.helperVersion, currentBlob: this.currentBlobs.get(e.file) ?? null }) })),
        eligibleCount: this.eligibleCount,
        incompatible: this.learned.incompatible(this.eligibleCount),
        runsSeen: this.learned.runsSeen(),
      },
    };
  }

  // ── requests ────────────────────────────────────────────────────────

  private admit(body: unknown, kind: 'slice' | 'cancel' | 'learned', route: RouteFacts): { req: SignedHelperRequest; cfg: HelperConfig } | HelperHttpAnswer {
    const cfg = this.d.config();
    if (!cfg) return { status: 404, body: { error: 'not found' } };
    if (routeRefusal(route, { allowLoopback: this.d.allowLoopback === true })) return this.refuse('tunnel', 403);
    const req = parseHelperRequest(body, kind);
    if (!req) return this.refuse('invalid-request', 400);
    if (!this.d.signer) return this.refuse('no-signer', 503);
    const why = signedRequestRefusal(req, { selfMachineId: this.d.signer.machineId(), pinnedRequesters: cfg.pinnedRequesters, keyLookup: this.d.keyLookup(), now: this.now(), seen: this.seen });
    if (why) return this.refuse(why, why === 'unsigned' || why.startsWith('signature') || why === 'requester-not-pinned' ? 401 : 409);
    try { this.seen.add(req.attemptId); } catch { return this.refuse('state-unwritable', 503); }
    return { req, cfg };
  }

  private async mergedOnMain(cfg: HelperConfig, headSha: string): Promise<boolean | null> {
    const cached = this.mergedCache.get(headSha);
    if (cached !== undefined) return cached;
    const v = await this.d.github.isOnMain(cfg.repo, headSha);
    if (v !== null) this.mergedCache.set(headSha, v);
    if (this.mergedCache.size > 20) this.mergedCache.delete(this.mergedCache.keys().next().value as string);
    return v;
  }

  private answer(req: HelperSliceRequest, state: HelperSliceAnswer['state'], extra: Partial<HelperSliceAnswer> = {}): HelperSliceAnswer {
    const base: HelperSliceAnswer = {
      state, attemptId: req.attemptId, runAttemptId: req.runAttemptId, headSha: req.headSha, requestedFiles: [...req.files],
      perFile: [], slice: null, ownerCoresMax: null, handBackMs: null, prepMs: this.trees.get(req.headSha)?.prepMs ?? null, progress: 0,
      helperVersion: this.d.helperVersion, ...extra,
    };
    return this.d.signer ? signHelperAnswer(this.d.signer, base) : base;
  }

  async handleSlice(body: unknown, route: RouteFacts): Promise<HelperHttpAnswer> {
    const a = this.admit(body, 'slice', route);
    if ('status' in a) return a;
    const req = a.req as SignedHelperRequest<HelperSliceRequest>;
    const cfg = a.cfg;
    if (!this.d.signer) return this.refuse('no-signer', 503);
    if (!this.d.driver) return this.refuse('no-sandbox', 503);
    if (this.paused()) return this.refuse('paused', 409);
    const merged = await this.mergedOnMain(cfg, req.headSha);
    if (merged === false) return this.refuse('not-merged');
    if (merged === null) return this.refuse('merged-unknown', 503);
    if (this.holdOff.holding(this.now())) await this.sampleDuringHoldOff();
    if (this.holdOff.holding(this.now())) return { status: 200, body: this.answer(req, 'owner-busy') };
    if (req.prepare) return this.acceptPrepare(req);
    return this.runSliceRequest(req, cfg);
  }

  private acceptPrepare(req: HelperSliceRequest): HelperHttpAnswer {
    this.learned.noteRun(req.runAttemptId);
    const t = this.trees.get(req.headSha);
    if (t && t.state !== 'failed') { t.lastUsed = this.now(); return { status: 202, body: this.answer(req, 'preparing') }; }
    if (this.current || this.pendingPrep) {
      // One queue: a newer head's preparation waits for the current work (at most one waiting).
      this.pendingPrep = { headSha: req.headSha, runAttemptId: req.runAttemptId, attemptId: req.attemptId };
      return { status: 202, body: this.answer(req, 'preparing') };
    }
    void this.prepare(req.headSha, req.runAttemptId, req.attemptId);
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
    await this.prepare(p.headSha, p.runAttemptId, p.attemptId);
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
    return { stop: dec.stop, workers: dec.workersAllowed, ownerCores: dec.ownerCores };
  }

  private reader(headSha: string): TreeReader {
    // Read errors propagate: the scan fails closed on them (the file stays local, counted `unreadable`).
    return { read: (f) => this.d.trees.read(headSha, f) };
  }

  private async runSliceRequest(req: HelperSliceRequest, cfg: HelperConfig): Promise<HelperHttpAnswer> {
    const tree = this.trees.get(req.headSha);
    if (!tree || tree.state !== 'ready') return this.refuse('not-prepared');
    if (this.current) return { status: 200, body: this.answer(req, 'busy') };
    // C.2: every file exists in that commit, is a unit test file, and passes D.
    let entries: Set<string>;
    try { entries = new Set((await this.d.trees.entries(req.headSha)).map((e) => e.path)); } catch { return this.refuse('merged-unknown', 503); }
    if (req.files.some((f) => !entries.has(f))) return this.refuse('file-missing');
    if (req.files.some((f) => !isBorrowableTestFile(f))) return this.refuse('file-not-unit');
    const learnedFiles = this.learned.files();
    const onList = req.files.filter((f) => learnedFiles.has(f));
    if (req.retrial && onList.length > HELPER_LIMITS.retrialMaxFiles) return this.refuse('retrial-too-large');
    const cache = this.scanCache.get(req.headSha) ?? new Map();
    this.scanCache.set(req.headSha, cache);
    if (this.scanCache.size > 2) this.scanCache.delete(this.scanCache.keys().next().value as string);
    const verdicts: EligibilityVerdict[] = await judgeEligibility(req.files, this.reader(req.headSha), learnedFiles, { ...(req.retrial ? { bypassLearned: new Set(onList) } : {}), cache });
    const bad = verdicts.filter((v) => !v.eligible);
    for (const v of bad) for (const h of v.hits) this.audit({ event: 'scan-hit', ...h });
    if (bad.length > 0) return { ...this.refuse('file-ineligible'), body: { state: 'refused', reason: 'file-ineligible', files: bad.map((v) => ({ file: v.file, reason: v.reason })) } };
    if (this.paused()) return this.refuse('paused');
    const ans = await this.runSlice(req, cfg, tree);
    return { status: 200, body: ans };
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
      let report = await drv.checks();
      if (!report.ok) {
        this.audit({ event: 'helper-containment-failed', reason: report.reason });
        await drv.destroy();
        // The recreated sandbox has none of the old trees.
        for (const [h, t] of [...this.trees]) if (t.state !== 'preparing') this.trees.delete(h);
        await drv.create(cfg.sandbox);
        this.lastCreatedAt = this.now();
        await drv.start();
        report = await drv.checks();
      }
      this.containment = { ...report, checkedAt: new Date(this.now()).toISOString() };
      if (!report.ok) {
        await this.stopSandbox('containment');
        return 'helper-containment-unproven';
      }
    }
    if (!this.containment?.ok) return 'helper-containment-unproven';
    const st2 = await drv.status();
    if (!hostDiskOk(await this.d.hostFreeBytes(), cfg.sandbox.diskGb, st2.diskFileBytes)) return 'host-disk-low';
    return null;
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

  private evictFor(headSha: string): Promise<void>[] {
    const out: Promise<void>[] = [];
    const others = [...this.trees.values()].filter((t) => t.headSha !== headSha && this.current?.headSha !== t.headSha).sort((a, b) => a.lastUsed - b.lastUsed);
    while (this.trees.size >= HELPER_LIMITS.preparedTreesMax && others.length > 0) {
      const t = others.shift()!;
      this.trees.delete(t.headSha);
      this.audit({ event: 'helper-tree-evicted', headSha: t.headSha });
      out.push(this.d.driver!.removeTree(t.treeId).catch((e) => this.audit({ event: 'helper-tree-remove-error', detail: String(e) })));
    }
    return out;
  }

  // ── preparation ─────────────────────────────────────────────────────

  async prepare(headSha: string, runAttemptId: string, attemptId: string): Promise<void> {
    const cfg = this.d.config();
    if (!cfg || !this.d.driver || this.current || this.stopped) return;
    // Owner first: nothing boots the sandbox while paused, in a hold-off, or with the owner busy.
    const gate = await this.ownerGate(cfg, null);
    if (gate.stop) {
      const treeId0 = crypto.createHash('sha256').update(headSha).digest('hex').slice(0, 16);
      this.trees.set(headSha, { headSha, treeId: treeId0, state: 'failed', reason: `owner-busy:${gate.stop}`, prepMs: null, copyMs: null, lastUsed: this.now(), runAttemptId });
      this.audit({ event: 'helper-prep-refused', headSha, reason: 'owner-busy', stop: gate.stop });
      return;
    }
    if (this.current) return;
    const work: CurrentWork = { kind: 'prep', runAttemptId, attemptId, headSha, abort: new AbortController(), stop: null, stopAt: null, ownerCoresMax: null };
    this.current = work;
    this.lastWorkAt = this.now();
    const treeId = crypto.createHash('sha256').update(headSha).digest('hex').slice(0, 16);
    await Promise.all(this.evictFor(headSha));
    const tree: PreparedTree = { headSha, treeId, state: 'preparing', prepMs: null, copyMs: null, lastUsed: this.now(), runAttemptId };
    this.trees.set(headSha, tree);
    const t0 = this.now();
    try {
      const why = await this.ensureSandbox(cfg);
      if (why) { tree.state = 'failed'; tree.reason = why; this.lastRefusal = { reason: why, at: new Date(this.now()).toISOString() }; this.audit({ event: 'helper-prep-refused', headSha, reason: why }); return; }
      const before = await this.d.driver.sandboxFreeBytes();
      if (before === null || before < this.peakPrepBytes) { tree.state = 'failed'; tree.reason = 'disk-low'; this.audit({ event: 'helper-prep-refused', headSha, reason: 'disk-low', freeBytes: before, peakPrepBytes: this.peakPrepBytes }); return; }
      const { error } = await this.governed(work, cfg, null, async (signal) => {
        await this.d.trees.fetch(cfg.pinnedRepoUrl, headSha);
        if (signal.aborted) return;
        const tar = await this.d.trees.archive(headSha);
        const { copyMs } = await this.d.driver!.copyIn(treeId, tar);
        tree.copyMs = copyMs;
        for (const step of ['npm-ci', 'build'] as const) {
          if (signal.aborted) return;
          // All builder processes are killed after every build and before every npm ci.
          await this.d.driver!.reap();
          const r = await this.d.driver!.execAsBuilder(treeId, step, signal);
          if (signal.aborted) return;
          if (r.exitCode !== 0) throw new Error(`${step}-failed:${String(r.exitCode)}`);
        }
        await this.d.driver!.reap();
        await this.d.driver!.sealTree(treeId);
      });
      if (work.stop) {
        await this.boundedReap();
        tree.state = 'failed'; tree.reason = `prep-stopped:${work.stop}`;
        this.trees.delete(headSha);
        await this.d.driver.removeTree(treeId).catch(() => undefined);
        this.audit({ event: 'helper-prep-stopped', headSha, stop: work.stop, handBackMs: work.stopAt !== null ? this.now() - work.stopAt : null });
        await this.afterStop(work);
        return;
      }
      if (error) { tree.state = 'failed'; tree.reason = String(error instanceof Error ? error.message : error).slice(0, 200); this.audit({ event: 'helper-prep-failed', headSha, reason: tree.reason }); return; }
      const after = await this.d.driver.sandboxFreeBytes();
      if (after !== null) this.peakPrepBytes = Math.max(this.peakPrepBytes, before - after);
      try {
        const tests = (await this.d.trees.entries(headSha)).filter((e) => isBorrowableTestFile(e.path));
        this.eligibleCount = tests.length;
        this.currentBlobs = new Map(tests.map((e) => [e.path, e.object]));
      } catch { /* @silent-fallback-ok: the cap and content hashes stay at their last values */ }
      tree.state = 'ready';
      tree.prepMs = this.now() - t0;
      this.audit({ event: 'helper-prepared', headSha, prepMs: tree.prepMs, copyMs: tree.copyMs });
    } catch (e) {
      tree.state = 'failed';
      tree.reason = String(e instanceof Error ? e.message : e).slice(0, 200);
      this.audit({ event: 'helper-prep-failed', headSha, reason: tree.reason });
    } finally {
      this.current = null;
      this.lastWorkAt = this.now();
      void this.drainPending();
    }
  }

  // ── a slice ─────────────────────────────────────────────────────────

  private async runSlice(req: HelperSliceRequest, cfg: HelperConfig, tree: PreparedTree): Promise<HelperSliceAnswer> {
    const work: CurrentWork = { kind: 'slice', runAttemptId: req.runAttemptId, attemptId: req.attemptId, headSha: req.headSha, abort: new AbortController(), stop: null, stopAt: null, ownerCoresMax: null };
    this.current = work;
    this.lastWorkAt = this.now();
    tree.lastUsed = this.now();
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
      const { result, error } = await this.governed(work, cfg, req.deadlineAt, (signal) => this.d.driver!.execAsTester(tree.treeId, { files: req.files, workers: dec.workers, signal }));
      // Clean-up after every slice, and the confirmation that nothing is left before answering.
      await this.boundedReap();
      const handBackMs = work.stopAt !== null ? this.now() - work.stopAt : null;
      if (work.stop) {
        this.audit({ event: 'helper-handed-back', attemptId: req.attemptId, stop: work.stop, handBackMs });
        await this.afterStop(work);
        return this.answer(req, work.stop === 'cancelled' ? 'cancelled' : 'handed-back', { reason: work.stop, handBackMs, ownerCoresMax: work.ownerCoresMax });
      }
      if (error || !result) {
        this.audit({ event: 'helper-slice-error', attemptId: req.attemptId, detail: String(error instanceof Error ? error.message : error).slice(0, 200) });
        return this.answer(req, 'done', { slice: { exitCode: null, unhandledErrors: 0, collected: false, vitestStartMs: null }, perFile: [], ownerCoresMax: work.ownerCoresMax });
      }
      if (result.oversize) {
        // Never Silently Cut: the whole result is refused, counted and named in the report.
        this.audit({ event: 'result-oversize', attemptId: req.attemptId, bytesSeen: result.oversize.bytesSeen });
        return this.answer(req, 'done', { resultOversize: { bytesSeen: result.oversize.bytesSeen }, slice: { exitCode: result.exitCode, unhandledErrors: result.unhandledErrors, collected: false, vitestStartMs: result.vitestStartMs }, ownerCoresMax: work.ownerCoresMax });
      }
      const perFile = buildPerFile(req.files, result.resultText, result.rootDir);
      const collected = perFile.parsed && perFile.files.every((p) => p.tests > 0);
      return this.answer(req, 'done', {
        perFile: perFile.files,
        slice: { exitCode: result.exitCode, unhandledErrors: result.unhandledErrors, collected, vitestStartMs: result.vitestStartMs },
        ownerCoresMax: work.ownerCoresMax, handBackMs: null, progress: 1,
      });
    } catch (e) {
      this.audit({ event: 'helper-slice-error', attemptId: req.attemptId, detail: String(e instanceof Error ? e.message : e).slice(0, 200) });
      return this.answer(req, 'refused', { reason: 'slice-error' });
    } finally {
      this.current = null;
      this.lastWorkAt = this.now();
      void this.drainPending();
    }
  }

  async handleCancel(body: unknown, route: RouteFacts): Promise<HelperHttpAnswer> {
    const a = this.admit(body, 'cancel', route);
    if ('status' in a) return a;
    const req = a.req;
    const cur = this.current;
    let stopped = false;
    if (cur && cur.runAttemptId === req.runAttemptId) {
      if (!cur.stop) { cur.stop = 'cancelled'; cur.stopAt = this.now(); }
      cur.abort.abort();
      stopped = true;
    }
    if (this.pendingPrep?.runAttemptId === req.runAttemptId) this.pendingPrep = null;
    // Prepared trees are deleted on cancel.
    const removed: string[] = [];
    for (const t of [...this.trees.values()]) {
      if (t.runAttemptId !== req.runAttemptId || this.current?.headSha === t.headSha) continue;
      this.trees.delete(t.headSha);
      removed.push(t.headSha);
      if (this.d.driver) await this.d.driver.removeTree(t.treeId).catch((e) => this.audit({ event: 'helper-tree-remove-error', detail: String(e) }));
    }
    this.audit({ event: 'helper-cancel', runAttemptId: req.runAttemptId, stopped, removed: removed.length });
    return { status: 200, body: { cancelled: true, stopped, removedTrees: removed } };
  }

  async handleLearned(body: unknown, route: RouteFacts): Promise<HelperHttpAnswer> {
    const a = this.admit(body, 'learned', route);
    if ('status' in a) return a;
    const req = a.req as SignedHelperRequest<HelperLearnedRequest>;
    const results: Array<{ file: string; result: string }> = [];
    for (const o of req.observations) {
      let blob: string | null = null;
      try { blob = (await this.d.trees.entries(req.headSha)).find((e) => e.path === o.file)?.object ?? null; } catch { blob = null; } // @silent-fallback-ok: an unknown content hash only means a content change cannot trigger its re-trial
      const r = this.learned.observe(o, { runMachine: req.requesterMachineId, runAttemptId: req.runAttemptId, helperVersion: this.d.helperVersion, blob, eligibleCount: Math.max(this.eligibleCount, 1) });
      results.push({ file: o.file, result: r });
    }
    this.audit({ event: 'helper-learned', runAttemptId: req.runAttemptId, added: results.filter((r) => r.result === 'added').length, removed: results.filter((r) => r.result === 'removed').length, capped: results.filter((r) => r.result === 'capped').length });
    return { status: 200, body: { ok: true, results } };
  }

  // ── idle ────────────────────────────────────────────────────────────

  async tickIdle(): Promise<void> {
    if (this.current || !this.d.driver) return;
    const now = this.now();
    if (this.sandboxUp && now - this.lastWorkAt >= HELPER_LIMITS.idleStopMs) await this.stopSandbox('idle');
    // Fresh sandbox: recreated from its base image once a day while idle.
    if (!this.sandboxUp && this.lastCreatedAt !== null && now - this.lastCreatedAt >= 24 * 60 * 60_000 && this.d.config()) {
      await this.d.driver.destroy();
      this.trees.clear();
      this.lastCreatedAt = null;
      this.audit({ event: 'helper-sandbox-daily-destroy' });
    }
  }

  /** `instar helper uninstall`: only through the driver seam, plus the learned list. */
  async uninstall(): Promise<void> {
    this.shutdown();
    if (this.d.driver) await this.d.driver.uninstall();
    this.learned.clear();
  }
}

/** Per-file answer entries for exactly the requested files, from the vitest JSON report. */
export function buildPerFile(files: readonly string[], reportText: string | null, rootDir: string): { files: HelperPerFile[]; parsed: boolean } {
  let report: ReturnType<typeof parseVitestJson> | null = null;
  if (reportText) { try { report = parseVitestJson(reportText, rootDir); } catch { report = null; } } // @silent-fallback-ok: an unparseable report answers uncollected files, which the run machine judges as disagreement-free slice errors
  const out: HelperPerFile[] = [];
  for (const f of files) {
    const c = report?.files.get(f);
    // Every requested file is listed exactly once; one the report lacks has zero tests (not collected).
    if (!c) { out.push({ file: f, tests: 0, passed: 0, failed: 0, skipped: 0, todo: 0, ms: 0 }); continue; }
    out.push({ file: f, tests: c.passed + c.failed + c.skipped + c.todo, passed: c.passed, failed: c.failed, skipped: c.skipped, todo: c.todo, ms: c.ms ?? 0 });
  }
  return { files: out, parsed: report !== null };
}
