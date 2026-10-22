/**
 * LocalVerifyService — the server-side queue, in-flight protocol, completion
 * path and record index for local-verify (spec local-verify-merge-authority.md
 * §2: "Who starts a verify" (POST path), Keys, Retry transitions, Single flight,
 * Slots and timing, step 6 and the in-flight protocol).
 *
 * - Queue: FIFO, one pending entry per PR, cap 10 (full → `queue-full`, the
 *   route maps it to 429), one run at a time.
 * - Keys: records by (repo, pr, headSha, baseRefName); executions deduplicated
 *   by (headSha, baseSha) — a second PR with the same merge inputs gets a
 *   record derived from the finished execution instead of a re-run.
 * - Retry table: `error` re-runs once automatically, then stays until the head
 *   moves or someone asks; `failure` re-runs on a head move or an explicit
 *   request, at most once per new base; a capacity wait is never an attempt.
 * - In-flight: MergeRunner's two-phase durable intent (record with an attempt
 *   token BEFORE spawn, pid/pgid patched after). At boot the recorded group is
 *   killed only after its identity is corroborated (the token on its argv); an
 *   uncorroborated record is KEPT, audited `orphan-reap-incomplete`, and blocks
 *   new runs until the group is shown to be gone.
 * - Completion path: the ONLY writer of `state/local-verify/journal.jsonl` and
 *   the in-memory index. At boot the index is rebuilt from the journal, keeping
 *   only entries whose verifierVersion and policyHash match the running code and
 *   whose PR is still open.
 *
 * Main health (piece 3a): a `main` verify entry (priority, outside the cap of 10,
 * at most one pending, a newer head replaces a pending one, a running one is
 * never cancelled), debounced 10 minutes of an unchanged head and capped at 30
 * minutes from the first unverified head (boot and lease acquisition skip the
 * debounce). Its record feeds `MainHealth` only (never the PR index). A red→green
 * transition re-runs failed PR verifies oldest first up to the queue cap. While
 * `main` is unhealthy the watcher's (non-explicit) requests are refused.
 *
 * Seams: `onRecord` (status projection / posting), `onStarved` (attention item),
 * `onMainHealthChange` (event-driven withdrawal), `signal` (main-red, main-unverified).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { executionKey, recordKey, validateRecord, isValidPr, isValidSha, MAIN_VERIFY_PR, type LocalVerifyRecord } from './record.js';
import { MainHealth, MAIN_VERIFY_LIMITS, decideMainEnqueue, decideMainErrorRetry, decideMainHeadEnqueue, type MainHealthSnapshot } from './mainHealth.js';
import { isMergeEligible } from '../../scripts/local-verify-floor.mjs';
import { LOCAL_VERIFY_LIMITS, computePolicyHash } from './policy.js';
import type { VerifyRunInput, VerifyRunResult } from './orchestrator.js';

// ── Eligibility ────────────────────────────────────────────────────────

export interface PrView {
  author: { login: string } | null;
  isCrossRepository: boolean;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  baseRefOid: string;
}

export function checkEligibility(
  v: PrView,
  logins: { expectedGhLogin: string; operatorGhLogin?: string | null },
): { eligible: true } | { eligible: false; reason: 'untrusted-head' } {
  // One implementation: safe-merge, the watcher and the verifier share isMergeEligible.
  return isMergeEligible(v, logins) ? { eligible: true } : { eligible: false, reason: 'untrusted-head' };
}

// ── Seams / config ─────────────────────────────────────────────────────

export interface ChildHandle {
  pid: number;
  exited: Promise<{ status: number | null; signal: string | null }>;
}

export interface LocalVerifyServiceSeams {
  /** `gh pr view <pr> --json author,isCrossRepository,headRefName,headRefOid,baseRefName,baseRefOid`; null on read failure. */
  prView(pr: number): Promise<PrView | null>;
  /** true/false, or null when it cannot be read (the entry is then kept out of the index but not deleted). */
  isPrOpen(pr: number): Promise<boolean | null>;
  /** Spawn the run child DETACHED (its own process group); stdio to `logFile`. */
  spawnRun(a: { command: string; args: string[]; env: NodeJS.ProcessEnv; logFile: string }): ChildHandle;
  isGroupAlive(pgid: number): boolean;
  killGroup(pgid: number, signal: 'SIGTERM' | 'SIGKILL'): void;
  /** The live process's argv, or null if it cannot be read. */
  readProcessArgs(pid: number): Promise<string | null>;
  /** Live full-suite holders of the host test-runner bound. */
  foreignSuiteHolders(): Array<{ pid: number }>;
  onStarved?(info: { pr: number; headSha: string; waitedMs: number }): void;
  /** Called by the completion path after a record is journaled (status projection plugs in here later). */
  onRecord?(record: LocalVerifyRecord): void;
  /** `git merge-base --is-ancestor` through the verifier's git funnel; null = undecidable (main health stays unhealthy). */
  isAncestor?(ancestor: string, descendant: string): Promise<boolean | null>;
  /** Synchronous hook after every main-health state change (event-driven withdrawal). */
  onMainHealthChange?(snap: MainHealthSnapshot, prev: MainHealthSnapshot): void;
  /** Deduped attention signal (`local-verify:main-red`, `local-verify:main-unverified`). */
  signal?(key: string, detail: Record<string, unknown>): void;
  now?(): number;
  setTimer?(fn: () => void, ms: number): void;
}

export interface LocalVerifyServiceConfig {
  repo: string;
  /** The agent's `.instar` directory; state/ and logs/ live under it. */
  stateDir: string;
  agentHome: string;
  expectedGhLogin: string;
  operatorGhLogin?: string | null;
  verifierVersion: string;
  /** Defaults to computePolicyHash(). */
  policyHash?: string;
  nodePath: string;
  /** Absolute path of the installed runVerifyMain.js. */
  mainEntry: string;
  /** Prefix the child with `nice -n 10` (default true). */
  nice?: boolean;
  remoteUrl: string;
  machineId: string;
  nodeVersion: string;
  protectedList: readonly string[];
  extraHarnessGlobs?: readonly string[];
  baseEnv: Record<string, string>;
}

export interface QueueEntry {
  id: string;
  pr: number;
  headSha: string;
  baseSha: string;
  baseRefName: string;
  /** First time this (pr, head) was queued; capacity waits never reset it. */
  firstQueuedAt: number;
  attempts: number;
  errorRetries: number;
  starvedRaised: boolean;
  /** Higher runs first; the `main` verify uses MAIN_VERIFY_LIMITS.priority. */
  priority: number;
  /** 'main' for a post-merge verify of `main` (pr 0, head == base). */
  kind?: 'main';
  /** Not started before this time (backoff of a `main` error re-run). */
  notBefore?: number;
}

export { MAIN_VERIFY_LIMITS };

// ---- the queue's self-action decisions (pure; the service calls these, and the
//      self-action registry drives the SAME functions under sustained pressure —
//      tests/unit/self-action-convergence.test.ts) ----

export type VerifyRetryAction = 're-run' | 'requeue' | 'stop';

/**
 * What happens to a queue entry after a run ends:
 *   'error'   — re-run at once, at most `errorAutoRetries` times per entry (per (pr, head)),
 *               then stop: the record stays `error` until the head moves or someone asks.
 *   'requeue' — a capacity wait: back to the front of the queue and the attempt is NOT counted.
 */
export function decideVerifyRetry(
  entry: { attempts: number; errorRetries: number },
  outcome: 'error' | 'requeue',
  limits: { errorAutoRetries: number } = LOCAL_VERIFY_LIMITS,
): { action: VerifyRetryAction; attempts: number; errorRetries: number } {
  if (outcome === 'requeue') return { action: 'requeue', attempts: Math.max(0, entry.attempts - 1), errorRetries: entry.errorRetries };
  if (entry.errorRetries < limits.errorAutoRetries) return { action: 're-run', attempts: entry.attempts, errorRetries: entry.errorRetries + 1 };
  return { action: 'stop', attempts: entry.attempts, errorRetries: entry.errorRetries };
}

/** The starved signal: once per entry, when it has waited (capacity waits included) longer than `starvedAfterMs`. */
export function decideStarved(
  entry: { firstQueuedAt: number; starvedRaised: boolean },
  now: number,
  limits: { starvedAfterMs: number } = LOCAL_VERIFY_LIMITS,
): { raise: boolean; waitedMs: number } {
  const waitedMs = now - entry.firstQueuedAt;
  return { raise: waitedMs > limits.starvedAfterMs && !entry.starvedRaised, waitedMs };
}

/**
 * Start admission for the (priority-sorted) queue: a foreign full suite holding the
 * slot is a capacity wait (not an attempt, the entry keeps its place); otherwise the
 * first entry whose backoff has elapsed starts.
 */
export function decideStart(
  i: { foreignHolders: number; queue: ReadonlyArray<{ notBefore?: number }>; now: number },
): { kind: 'capacity-wait' } | { kind: 'idle' } | { kind: 'start'; index: number } {
  if (i.foreignHolders > 0) return { kind: 'capacity-wait' };
  const index = i.queue.findIndex((e) => e.notBefore === undefined || e.notBefore <= i.now);
  return index < 0 ? { kind: 'idle' } : { kind: 'start', index };
}

export interface InFlightIntent {
  pr: number;
  headSha: string;
  baseSha: string;
  baseRefName: string;
  attemptToken: string;
  startedAt: number;
  pid: number | null;
  pgid: number | null;
}

export type RequestResult =
  | { ok: true; status: 'queued' | 'already-queued' | 'in-flight'; position?: number }
  | { ok: true; status: 'recorded'; record: LocalVerifyRecord }
  | { ok: false; code: 'invalid-pr' | 'pr-unreadable' | 'untrusted-head' | 'queue-full' | 'pr-invalid-shas' | 'main-unhealthy' };

interface InFlight {
  entry: QueueEntry;
  token: string;
  pgid: number;
  inputPath: string;
  resultPath: string;
  cancelled: boolean;
}

interface JournalLine {
  v: 1;
  writtenAt: string;
  record: LocalVerifyRecord;
}

// ── The service ────────────────────────────────────────────────────────

export class LocalVerifyService {
  private readonly cfg: LocalVerifyServiceConfig;
  private readonly seams: LocalVerifyServiceSeams;
  private readonly now: () => number;
  private readonly policyHash: string;
  private readonly queue: QueueEntry[] = [];
  private inFlight: InFlight | null = null;
  private blockedBy: InFlightIntent | null = null;
  private readonly index = new Map<string, LocalVerifyRecord>();
  private readonly execIndex = new Map<string, LocalVerifyRecord>();
  /** Bases a failed (pr, head, baseRef) record was already re-run against. */
  private readonly failureReruns = new Map<string, Set<string>>();
  private idleWaiters: Array<() => void> = [];
  private readonly health: MainHealth;
  /** Main-head debounce state. */
  private readonly mainObs: { head: string | null; since: number; firstUnverifiedAt: number | null; handled: string | null; immediate: boolean; oldestUnverifiedAt: number | null } =
    { head: null, since: 0, firstUnverifiedAt: null, handled: null, immediate: true, oldestUnverifiedAt: null };
  private readonly mainErrorRetries = new Map<string, number>();
  private readonly pendingMainWork: Array<Promise<unknown>> = [];

  constructor(cfg: LocalVerifyServiceConfig, seams: LocalVerifyServiceSeams) {
    this.cfg = cfg;
    this.seams = seams;
    this.now = seams.now ?? (() => Date.now());
    this.policyHash = cfg.policyHash ?? computePolicyHash();
    this.health = new MainHealth(cfg.stateDir, cfg.machineId, {
      now: this.now,
      isAncestor: (a, d) => (seams.isAncestor ? seams.isAncestor(a, d) : Promise.resolve(null)),
      signal: (k, d) => seams.signal?.(k, d),
      onChange: (snap, prev) => seams.onMainHealthChange?.(snap, prev),
      audit: (e) => this.audit(e),
    });
    this.health.load(); // the watermark decides from the start (boot() re-reads it)
  }

  // ---- paths ----

  private get lvStateDir(): string { return path.join(this.cfg.stateDir, 'state', 'local-verify'); }
  get journalPath(): string { return path.join(this.lvStateDir, 'journal.jsonl'); }
  get inFlightPath(): string { return path.join(this.lvStateDir, 'inflight.json'); }
  private get closedSeenPath(): string { return path.join(this.lvStateDir, 'closed-seen.json'); }
  private get runsDir(): string { return path.join(this.lvStateDir, 'runs'); }
  get auditPath(): string { return path.join(this.cfg.stateDir, 'logs', 'local-verify.jsonl'); }

  // ---- read surface ----

  getRecord(pr: number, headSha: string, baseRefName: string): LocalVerifyRecord | null {
    try { return this.index.get(recordKey(this.cfg.repo, pr, headSha, baseRefName)) ?? null; } catch { return null; }
  }

  snapshot(): { queue: QueueEntry[]; inFlight: { pr: number; headSha: string; kind?: 'main' } | null; blocked: boolean; records: number } {
    return {
      queue: this.queue.map((e) => ({ ...e })),
      inFlight: this.inFlight
        ? { pr: this.inFlight.entry.pr, headSha: this.inFlight.entry.headSha, ...(this.inFlight.entry.kind ? { kind: this.inFlight.entry.kind } : {}) }
        : null,
      blocked: this.blockedBy !== null,
      records: this.index.size,
    };
  }

  /** Main health (the machine state, not whether an attention item is open). */
  mainHealth(): MainHealthSnapshot & { currentMainHead: string | null; pendingMainHead: string | null; mainInFlight: string | null } {
    const pending = this.queue.find((e) => e.kind === 'main');
    return {
      ...this.health.snapshot(),
      currentMainHead: this.mainObs.head,
      pendingMainHead: pending?.headSha ?? null,
      mainInFlight: this.inFlight?.entry.kind === 'main' ? this.inFlight.entry.headSha : null,
    };
  }

  /** True while a verify of exactly (pr, head) is queued or running. */
  isVerifying(pr: number, headSha: string): boolean {
    const f = this.inFlight;
    if (f && !f.cancelled && f.entry.kind !== 'main' && f.entry.pr === pr && f.entry.headSha === headSha) return true;
    return this.queue.some((e) => e.kind !== 'main' && e.pr === pr && e.headSha === headSha);
  }

  /** Resolves when pending main-health work (ancestry checks, re-runs) has settled (tests). */
  async settle(): Promise<void> {
    while (this.pendingMainWork.length) await Promise.allSettled(this.pendingMainWork.splice(0));
  }

  /** Resolves when nothing is running (tests and shutdown). */
  whenIdle(): Promise<void> {
    if (!this.inFlight) return Promise.resolve();
    return new Promise((r) => { this.idleWaiters.push(r); });
  }

  // ---- boot ----

  async boot(): Promise<void> {
    this.health.load();
    this.mainObs.immediate = true; // the boot-time `main` verify skips the debounce
    await this.reapOrphan();
    await this.rebuildIndex();
  }

  /**
   * Lease acquisition. `foreignHolder`: a different machine held the lease since
   * this machine last did (it enters main-suspect). The journal is machine-local,
   * so the index it keeps holds only this machine's own records.
   */
  onLeaseAcquired(opts: { foreignHolder: boolean; epoch?: number | null }): void {
    this.health.load({ foreignHolder: opts.foreignHolder, epoch: opts.epoch });
    this.mainObs.immediate = true;
    this.mainObs.handled = null;
  }

  /**
   * The remote `main` head as observed by the reconcile loop. Enqueues a `main`
   * verify whenever it differs from the last enqueued or verified head, debounced.
   */
  noteMainHead(sha: string | null): void {
    if (sha === null || !isValidSha(sha)) {
      // One failed read ⇒ the current head is unknown ⇒ no repair admission
      // (the repair exception compares against the CURRENT main head).
      this.mainObs.head = null;
      this.mainObs.since = this.now();
      return;
    }
    const now = this.now();
    const o = this.mainObs;
    if (sha !== this.health.snapshot().lastGreenHead && o.oldestUnverifiedAt === null) o.oldestUnverifiedAt = now;
    const d = decideMainHeadEnqueue(o, sha, now);
    o.head = d.next.head; o.since = d.next.since; o.firstUnverifiedAt = d.next.firstUnverifiedAt;
    o.handled = d.next.handled; o.immediate = d.next.immediate;
    if (d.enqueue) this.enqueueMain(sha, 'head-changed');
  }

  /* @self-action-controller: local-verify-main-schedule */
  private enqueueMain(sha: string, why: 'head-changed' | 'rerun'): void {
    const f = this.inFlight;
    const i = this.queue.findIndex((e) => e.kind === 'main');
    const d = decideMainEnqueue({
      sha, why,
      inFlightMain: f?.entry.kind === 'main' ? { headSha: f.entry.headSha, cancelled: f.cancelled } : null,
      pendingMainHead: i >= 0 ? this.queue[i].headSha : null,
    });
    if (d.action === 'skip') return;
    if (d.action === 'replace') {
      const old = this.queue[i];
      this.queue.splice(i, 1); // a newer head replaces a pending one; a running one is never cancelled
      this.audit({ event: 'main-replaced', oldHead: old.headSha, newHead: sha });
    }
    this.queue.push({
      id: crypto.randomBytes(6).toString('hex'), pr: MAIN_VERIFY_PR, headSha: sha, baseSha: sha, baseRefName: 'main',
      firstQueuedAt: this.now(), attempts: 0, errorRetries: 0, starvedRaised: false, priority: MAIN_VERIFY_LIMITS.priority, kind: 'main',
    });
    this.audit({ event: 'main-queued', headSha: sha, why });
    this.pump();
  }

  /** The two-phase in-flight protocol's boot half. */
  async reapOrphan(): Promise<'none' | 'cleared-pidless' | 'gone' | 'reaped' | 'incomplete'> {
    const rec = this.readInFlight();
    if (!rec) { this.blockedBy = null; return 'none'; }
    if (rec.pid === null || rec.pgid === null) {
      // Crash between intent and pid patch (same synchronous turn as the spawn): the
      // spawn result is unknown but no group was recorded to corroborate or kill.
      this.audit({ event: 'orphan-pidless-cleared', pr: rec.pr, headSha: rec.headSha });
      this.clearInFlight();
      this.blockedBy = null;
      return 'cleared-pidless';
    }
    if (!this.seams.isGroupAlive(rec.pgid)) {
      this.audit({ event: 'orphan-gone', pr: rec.pr, headSha: rec.headSha, pgid: rec.pgid });
      this.clearInFlight();
      this.blockedBy = null;
      return 'gone';
    }
    const args = await this.seams.readProcessArgs(rec.pid).catch(() => null);
    if (args && args.includes(`--attempt-token ${rec.attemptToken}`)) {
      this.seams.killGroup(rec.pgid, 'SIGKILL');
      if (!this.seams.isGroupAlive(rec.pgid)) {
        this.audit({ event: 'orphan-reaped', pr: rec.pr, headSha: rec.headSha, pgid: rec.pgid });
        this.clearInFlight();
        this.blockedBy = null;
        return 'reaped';
      }
    }
    // Identity unconfirmed (leader dead with a live group, pid reused, argv unreadable),
    // or the kill did not take: keep the record and block new runs.
    if (!this.blockedBy) this.audit({ event: 'orphan-reap-incomplete', pr: rec.pr, headSha: rec.headSha, pgid: rec.pgid });
    this.blockedBy = rec;
    return 'incomplete';
  }

  /** Rebuild the in-memory index from the journal; compact the journal (retention + cap). */
  async rebuildIndex(): Promise<{ loaded: number; skippedVersion: number; skippedClosed: number; kept: number }> {
    this.index.clear();
    this.execIndex.clear();
    const lines = this.readJournal();
    const latest = new Map<string, JournalLine>();
    for (const l of lines) {
      const k = recordKey(l.record.repo, l.record.pr, l.record.headSha, l.record.baseRefName);
      latest.set(k, l); // later lines win
    }
    const closedSeen = this.readClosedSeen();
    const nowMs = this.now();
    const openByPr = new Map<number, boolean | null>();
    let skippedVersion = 0;
    let skippedClosed = 0;
    const keep: JournalLine[] = [];
    for (const [k, l] of latest) {
      const r = l.record;
      if (!openByPr.has(r.pr)) openByPr.set(r.pr, await this.seams.isPrOpen(r.pr).catch(() => null));
      const open = openByPr.get(r.pr)!;
      if (open === false && closedSeen[r.pr] === undefined) closedSeen[r.pr] = nowMs;
      if (open === true) delete closedSeen[r.pr];
      const withinRetention = open !== false || nowMs - (closedSeen[r.pr] ?? nowMs) < LOCAL_VERIFY_LIMITS.retentionAfterCloseMs;
      if (withinRetention) keep.push(l);
      if (r.repo !== this.cfg.repo || r.verifierVersion !== this.cfg.verifierVersion || r.policyHash !== this.policyHash) {
        skippedVersion++;
        continue;
      }
      if (open !== true) { skippedClosed++; continue; }
      this.index.set(k, r);
      if (r.outcome !== 'error') this.execIndex.set(executionKey(r.headSha, r.baseSha), r);
    }
    keep.sort((a, b) => (a.writtenAt < b.writtenAt ? -1 : a.writtenAt > b.writtenAt ? 1 : 0));
    const capped = keep.slice(-LOCAL_VERIFY_LIMITS.journalCap);
    this.rewriteJournal(capped);
    for (const pr of Object.keys(closedSeen)) {
      if (nowMs - closedSeen[Number(pr)] >= LOCAL_VERIFY_LIMITS.retentionAfterCloseMs) delete closedSeen[Number(pr)];
    }
    this.writeClosedSeen(closedSeen);
    this.audit({ event: 'index-rebuilt', loaded: this.index.size, skippedVersion, skippedClosed, kept: capped.length });
    return { loaded: this.index.size, skippedVersion, skippedClosed, kept: capped.length };
  }

  // ---- the POST path ----

  async request(pr: number, opts: { explicit?: boolean; force?: boolean } = {}): Promise<RequestResult> {
    const explicit = opts.explicit ?? true;
    if (!isValidPr(pr)) return { ok: false, code: 'invalid-pr' };
    // While `main` is unhealthy the watcher requests no PR verifies (they fail by
    // construction); POSTed ones still run, which is how a repair gets its record.
    if (!explicit && !this.health.isHealthy()) return { ok: false, code: 'main-unhealthy' };
    const view = await this.seams.prView(pr).catch(() => null);
    if (!view) return { ok: false, code: 'pr-unreadable' };
    if (!checkEligibility(view, this.cfg).eligible) {
      this.audit({ event: 'refused', pr, reason: 'untrusted-head' });
      return { ok: false, code: 'untrusted-head' };
    }
    if (!isValidSha(view.headRefOid) || !isValidSha(view.baseRefOid)) return { ok: false, code: 'pr-invalid-shas' };
    const headSha = view.headRefOid;
    const baseSha = view.baseRefOid;
    const baseRefName = view.baseRefName;
    const key = recordKey(this.cfg.repo, pr, headSha, baseRefName);

    // A moved head (or retarget) cancels the in-flight run for the old one.
    const f = this.inFlight;
    if (f && f.entry.pr === pr) {
      if (f.entry.headSha !== headSha || f.entry.baseRefName !== baseRefName) this.cancelInFlight('head-moved');
      else if (!f.cancelled) return { ok: true, status: 'in-flight' };
    }
    const pendingIdx = this.queue.findIndex((e) => e.pr === pr);
    if (pendingIdx >= 0) {
      const e = this.queue[pendingIdx];
      if (e.headSha === headSha && e.baseRefName === baseRefName && e.baseSha === baseSha) {
        return { ok: true, status: 'already-queued', position: pendingIdx };
      }
      this.queue.splice(pendingIdx, 1);
      this.audit({ event: 'dequeued', pr, reason: 'head-or-base-moved', headSha: e.headSha });
    }

    const existing = this.index.get(key);
    if (existing) {
      if (existing.outcome === 'success') return { ok: true, status: 'recorded', record: existing };
      if (existing.outcome === 'failure') {
        const tried = this.failureReruns.get(key) ?? new Set<string>();
        const newBase = existing.baseSha !== baseSha && !tried.has(baseSha);
        if (!opts.force && (!explicit || !newBase)) return { ok: true, status: 'recorded', record: existing };
        tried.add(baseSha);
        this.failureReruns.set(key, tried);
      } else if (!explicit) {
        return { ok: true, status: 'recorded', record: existing };
      }
    }

    // Execution dedupe: identical merge inputs already verified under this policy.
    const exec = this.execIndex.get(executionKey(headSha, baseSha));
    if (exec && !(opts.force && exec.outcome === 'failure') && !(existing && existing.outcome === 'failure' && exec === existing)) {
      const derived = this.complete({ ...exec, pr, baseRefName }, 'derived');
      if (derived) return { ok: true, status: 'recorded', record: derived };
    }

    if (this.prQueueLength() >= LOCAL_VERIFY_LIMITS.queueCap) {
      this.audit({ event: 'queue-full', pr });
      return { ok: false, code: 'queue-full' };
    }
    const entry: QueueEntry = {
      id: crypto.randomBytes(6).toString('hex'), pr, headSha, baseSha, baseRefName,
      firstQueuedAt: this.now(), attempts: 0, errorRetries: 0, starvedRaised: false, priority: 0,
    };
    this.queue.push(entry);
    this.audit({ event: 'queued', pr, headSha, baseSha, explicit });
    const position = this.queue.length - 1;
    this.pump();
    return { ok: true, status: 'queued', position };
  }

  /** Periodic driver: orphan unblock, starvation signal, start the next run. */
  async tick(): Promise<void> {
    if (this.blockedBy) await this.reapOrphan();
    this.checkStarved();
    this.health.noteUnverifiedAge(this.mainObs.oldestUnverifiedAt);
    this.pump();
  }

  private prQueueLength(): number {
    return this.queue.reduce((n, e) => n + (e.kind === 'main' ? 0 : 1), 0);
  }

  /** Server shutdown: stop the in-flight run (its group) — a restart re-queues lazily. */
  shutdown(): void {
    if (this.inFlight) this.cancelInFlight('shutdown');
  }

  // ---- internals ----

  private checkStarved(): void {
    const prs = this.queue.filter((e) => e.kind !== 'main');
    if (prs.length === 0) return;
    const oldest = prs.reduce((a, b) => (a.firstQueuedAt <= b.firstQueuedAt ? a : b));
    const { raise, waitedMs: waited } = decideStarved(oldest, this.now());
    if (raise) {
      oldest.starvedRaised = true;
      this.audit({ event: 'starved', pr: oldest.pr, headSha: oldest.headSha, waitedMs: waited });
      this.seams.onStarved?.({ pr: oldest.pr, headSha: oldest.headSha, waitedMs: waited });
    }
  }

  private pump(): void {
    if (this.inFlight || this.blockedBy || this.queue.length === 0) return;
    const holders = this.seams.foreignSuiteHolders();
    if (holders.length > 0) {
      // A capacity wait: not an attempt, the entry keeps its place.
      this.audit({ event: 'overlap', where: 'before-start', holders: holders.map((h) => h.pid) });
      return;
    }
    this.queue.sort((a, b) => b.priority - a.priority); // stable: FIFO within a priority
    const d = decideStart({ foreignHolders: 0, queue: this.queue, now: this.now() });
    if (d.kind !== 'start') return;
    const [entry] = this.queue.splice(d.index, 1);
    this.start(entry);
  }

  private start(entry: QueueEntry): void {
    const token = crypto.randomBytes(16).toString('hex');
    fs.mkdirSync(this.runsDir, { recursive: true });
    const inputPath = path.join(this.runsDir, `${token}.input.json`);
    const resultPath = path.join(this.runsDir, `${token}.result.json`);
    const logFile = path.join(this.runsDir, `${token}.log`);
    const input: VerifyRunInput = {
      repo: this.cfg.repo, pr: entry.pr, headSha: entry.headSha, baseSha: entry.baseSha, baseRefName: entry.baseRefName,
      agentHome: this.cfg.agentHome, remoteUrl: this.cfg.remoteUrl, nodeVersion: this.cfg.nodeVersion,
      machineId: this.cfg.machineId, verifierVersion: this.cfg.verifierVersion, policyHash: this.policyHash,
      protectedList: this.cfg.protectedList, extraHarnessGlobs: this.cfg.extraHarnessGlobs, baseEnv: this.cfg.baseEnv,
      ...(entry.kind === 'main' ? { kind: 'main' as const } : {}),
    };
    fs.writeFileSync(inputPath, JSON.stringify(input), { mode: 0o600 });

    // Phase 1: durable intent BEFORE the spawn.
    const intent: InFlightIntent = {
      pr: entry.pr, headSha: entry.headSha, baseSha: entry.baseSha, baseRefName: entry.baseRefName,
      attemptToken: token, startedAt: this.now(), pid: null, pgid: null,
    };
    this.writeInFlight(intent);
    entry.attempts++;

    const childArgs = [this.cfg.mainEntry, '--input', inputPath, '--result', resultPath, '--attempt-token', token];
    const useNice = this.cfg.nice ?? true;
    let handle: ChildHandle;
    try {
      handle = this.seams.spawnRun({
        command: useNice ? 'nice' : this.cfg.nodePath,
        args: useNice ? ['-n', '10', this.cfg.nodePath, ...childArgs] : childArgs,
        env: this.cfg.baseEnv, logFile,
      });
    } catch (e) {
      this.clearInFlight();
      this.complete(this.syntheticError(entry, 'spawn'), 'run');
      this.audit({ event: 'spawn-failed', pr: entry.pr, detail: e instanceof Error ? e.message : String(e) });
      this.handleErrorRetry(entry);
      this.pump();
      return;
    }
    // Phase 2: patch pid/pgid (detached: the child's pid IS its pgid).
    intent.pid = handle.pid;
    intent.pgid = handle.pid;
    this.writeInFlight(intent);
    this.inFlight = { entry, token, pgid: handle.pid, inputPath, resultPath, cancelled: false };
    this.audit({ event: 'started', pr: entry.pr, headSha: entry.headSha, baseSha: entry.baseSha, pgid: handle.pid, attempt: entry.attempts });
    const mine = this.inFlight;
    handle.exited.then((x) => this.onExit(mine, x), () => this.onExit(mine, { status: null, signal: null }));
  }

  private cancelInFlight(reason: string): void {
    const f = this.inFlight;
    if (!f || f.cancelled) return;
    f.cancelled = true;
    this.audit({ event: 'cancel', pr: f.entry.pr, headSha: f.entry.headSha, reason });
    try { this.seams.killGroup(f.pgid, 'SIGTERM'); } catch { /* @silent-fallback-ok: group may already be gone */ }
    const setTimer = this.seams.setTimer ?? ((fn: () => void, ms: number) => { const t = setTimeout(fn, ms); t.unref?.(); });
    setTimer(() => {
      if (this.seams.isGroupAlive(f.pgid)) {
        try { this.seams.killGroup(f.pgid, 'SIGKILL'); } catch { /* @silent-fallback-ok: best-effort */ }
      }
    }, LOCAL_VERIFY_LIMITS.cancelGraceMs);
  }

  private onExit(f: InFlight, exit: { status: number | null; signal: string | null }): void {
    // Sweep leftovers of the group right away (step processes the child left behind).
    if (this.seams.isGroupAlive(f.pgid)) {
      try { this.seams.killGroup(f.pgid, 'SIGKILL'); } catch { /* @silent-fallback-ok: best-effort */ }
    }
    this.clearInFlight();
    if (this.inFlight === f) this.inFlight = null;
    const result = this.readResult(f.resultPath);
    this.removeRunFiles(f);
    if (f.cancelled) {
      this.audit({ event: 'cancelled', pr: f.entry.pr, headSha: f.entry.headSha, exit });
    } else if (f.entry.kind === 'main' && result?.kind !== 'requeue') {
      if (!result || result.kind === 'crash' || result.kind === 'invalid') {
        this.audit({ event: 'run-error', kind: 'main', headSha: f.entry.headSha, exit });
        this.completeMain(this.syntheticError(f.entry, !result || result.kind === 'crash' ? 'crash' : 'invalid-record'), f.entry);
      } else {
        this.completeMain(result.record, f.entry);
      }
    } else if (!result || result.kind === 'crash' || result.kind === 'invalid') {
      const step = !result ? 'crash' : result.kind === 'crash' ? 'crash' : 'invalid-record';
      this.audit({ event: 'run-error', pr: f.entry.pr, step, exit, detail: result && 'detail' in result ? result.detail : undefined });
      this.complete(this.syntheticError(f.entry, step), 'run');
      this.handleErrorRetry(f.entry);
    } else if (result.kind === 'requeue') {
      // A capacity wait is never an attempt.
      f.entry.attempts = decideVerifyRetry(f.entry, 'requeue').attempts;
      this.audit({ event: 'requeued', pr: f.entry.pr, reason: result.reason, overlaps: result.overlaps.length });
      this.retry(f.entry);
    } else {
      for (const o of result.overlaps) this.audit({ event: 'overlap', where: `before-${o.beforeLane}`, holders: o.holders });
      const rec = this.complete(result.record, 'run');
      if (rec && rec.outcome !== 'success') {
        // Why it went red, bounded: reasons plus each failed file's first error.
        this.audit({ event: 'run-detail', pr: rec.pr, headSha: rec.headSha, outcome: rec.outcome, reasons: result.reasons.slice(0, 40), failures: (result.failures ?? []).slice(0, 30) });
      }
      if (rec && rec.outcome === 'error') this.handleErrorRetry(f.entry);
    }
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
    this.pump();
  }

  /* @self-action-controller: local-verify-error-rerun */
  private handleErrorRetry(entry: QueueEntry): void {
    const d = decideVerifyRetry(entry, 'error');
    if (d.action !== 're-run') return;
    entry.errorRetries = d.errorRetries;
    this.audit({ event: 'error-auto-retry', pr: entry.pr, headSha: entry.headSha });
    this.retry(entry);
  }

  /* @self-action-controller: local-verify-capacity-requeue */
  /** The automatic re-run emit: back to the front of the queue (an error re-run or a capacity requeue). */
  private retry(entry: QueueEntry): void {
    this.queue.unshift(entry);
  }

  private syntheticError(entry: QueueEntry, step: string): LocalVerifyRecord {
    const at = new Date(this.now()).toISOString();
    return {
      repo: this.cfg.repo, pr: entry.pr, headSha: entry.headSha, baseSha: entry.baseSha, baseRefName: entry.baseRefName,
      mergeTree: '', lanes: [], nodeVersion: this.cfg.nodeVersion, machineId: this.cfg.machineId,
      startedAt: at, finishedAt: at, outcome: 'error', errorStep: step,
      harnessChanging: false, protectedPath: false, skipsAdded: false, testsRemoved: false,
      verifierVersion: this.cfg.verifierVersion, policyHash: this.policyHash,
      ...(entry.kind === 'main' ? { kind: 'main' as const } : {}),
    };
  }

  /** Completion of a `main` verify: feeds main health only, never the PR index or journal. */
  private completeMain(record: LocalVerifyRecord, entry: QueueEntry): void {
    const v = validateRecord(record);
    if (!v.ok || record.kind !== 'main' || record.headSha !== entry.headSha) {
      this.audit({ event: 'record-rejected', kind: 'main', errors: v.ok ? ['kind-or-head'] : v.errors });
      return;
    }
    const head = record.headSha;
    this.audit({ event: 'main-record', headSha: head, outcome: record.outcome, errorStep: record.errorStep });
    if (record.outcome === 'error') {
      // Only `failure` counts as red; an error re-queues with backoff, at most 3 times per head.
      const d = decideMainErrorRetry({ priorRetries: this.mainErrorRetries.get(head) ?? 0, mainPending: this.queue.some((e) => e.kind === 'main'), now: this.now() });
      const n = d.retries;
      this.mainErrorRetries.set(head, n);
      if (d.requeue) {
        this.queue.push({ ...entry, id: crypto.randomBytes(6).toString('hex'), notBefore: d.notBefore });
        this.audit({ event: 'main-error-retry', headSha: head, attempt: n });
      }
      return;
    }
    if (record.outcome === 'success' && head === this.mainObs.head) this.mainObs.oldestUnverifiedAt = null;
    const work = this.health.onVerify(head, record.outcome).then(async (action) => {
      if (action === 'rerun') this.enqueueMain(head, 'rerun');
      else if (action === 'cleared') await this.rerunFailures();
    }).catch((e) => this.audit({ event: 'main-health-error', detail: e instanceof Error ? e.message : String(e) }));
    this.pendingMainWork.push(work);
  }

  /** Red → green: re-run failed PR verifies, oldest first, up to the queue cap; overflow stays failed and is logged. */
  private async rerunFailures(): Promise<void> {
    const failed = [...this.index.values()]
      .filter((r) => r.outcome === 'failure' && r.kind === undefined)
      .sort((a, b) => (a.finishedAt < b.finishedAt ? -1 : a.finishedAt > b.finishedAt ? 1 : 0));
    const seen = new Set<number>();
    for (const r of failed) {
      if (seen.has(r.pr)) continue;
      seen.add(r.pr);
      if (this.prQueueLength() >= LOCAL_VERIFY_LIMITS.queueCap) {
        this.audit({ event: 'rerun-after-green-overflow', pr: r.pr, headSha: r.headSha });
        continue;
      }
      const res = await this.request(r.pr, { explicit: true, force: true });
      this.audit({ event: 'rerun-after-green', pr: r.pr, result: res.ok ? res.status : res.code });
    }
  }

  /**
   * THE completion path: the only writer of the journal and the index.
   * Validates, appends, indexes, then derives records for queued PRs that share
   * the execution key (dedupe by merge-tree inputs).
   */
  private complete(record: LocalVerifyRecord, source: 'run' | 'derived'): LocalVerifyRecord | null {
    const v = validateRecord(record);
    if (!v.ok || record.repo !== this.cfg.repo) {
      this.audit({ event: 'record-rejected', pr: record.pr, errors: v.ok ? ['repo'] : v.errors });
      return null;
    }
    const line: JournalLine = { v: 1, writtenAt: new Date(this.now()).toISOString(), record };
    fs.mkdirSync(path.dirname(this.journalPath), { recursive: true });
    fs.appendFileSync(this.journalPath, JSON.stringify(line) + '\n'); /* state-registry: local-verify-journal */
    const key = recordKey(record.repo, record.pr, record.headSha, record.baseRefName);
    this.index.set(key, record);
    this.audit({ event: 'record', source, pr: record.pr, headSha: record.headSha, baseSha: record.baseSha, outcome: record.outcome, errorStep: record.errorStep });
    this.seams.onRecord?.(record);
    if (record.outcome !== 'error') {
      const ek = executionKey(record.headSha, record.baseSha);
      if (source === 'run') this.execIndex.set(ek, record);
      for (let i = this.queue.length - 1; i >= 0; i--) {
        const e = this.queue[i];
        if (e.headSha === record.headSha && e.baseSha === record.baseSha && !(e.pr === record.pr && e.baseRefName === record.baseRefName)) {
          this.queue.splice(i, 1);
          this.complete({ ...record, pr: e.pr, baseRefName: e.baseRefName }, 'derived');
        }
      }
    }
    return record;
  }

  // ---- durable files ----

  private writeInFlight(rec: InFlightIntent): void {
    fs.mkdirSync(this.lvStateDir, { recursive: true });
    const tmp = this.inFlightPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 }); /* state-registry: local-verify-inflight */
    fs.renameSync(tmp, this.inFlightPath);
  }

  private readInFlight(): InFlightIntent | null {
    try {
      const o = JSON.parse(fs.readFileSync(this.inFlightPath, 'utf-8')) as InFlightIntent;
      if (typeof o.pr === 'number' && typeof o.attemptToken === 'string') return o;
    } catch { /* @silent-fallback-ok: no record */ }
    return null;
  }

  private clearInFlight(): void {
    try { SafeFsExecutor.safeRmSync(this.inFlightPath, { force: true, operation: 'local-verify:clear-in-flight' }); } catch { /* @silent-fallback-ok: best-effort */ }
  }

  private readResult(p: string): (VerifyRunResult | { kind: 'crash'; detail: string }) | null {
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
  }

  private removeRunFiles(f: InFlight): void {
    for (const p of [f.inputPath, f.resultPath]) {
      try { SafeFsExecutor.safeRmSync(p, { force: true, operation: 'local-verify:remove-run-file' }); } catch { /* @silent-fallback-ok: best-effort */ }
    }
  }

  private readJournal(): JournalLine[] {
    let text = '';
    try { text = fs.readFileSync(this.journalPath, 'utf-8'); } catch { return []; }
    const out: JournalLine[] = [];
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue;
      try {
        const l = JSON.parse(raw) as JournalLine;
        if (l && l.v === 1 && typeof l.writtenAt === 'string' && validateRecord(l.record).ok) out.push(l);
      } catch { /* @silent-fallback-ok: a torn last line is skipped */ }
    }
    return out;
  }

  private rewriteJournal(lines: JournalLine[]): void {
    fs.mkdirSync(path.dirname(this.journalPath), { recursive: true });
    const tmp = this.journalPath + '.tmp';
    fs.writeFileSync(tmp, lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : '')); /* state-registry: local-verify-journal */
    fs.renameSync(tmp, this.journalPath);
  }

  private readClosedSeen(): Record<number, number> {
    try {
      const o = JSON.parse(fs.readFileSync(this.closedSeenPath, 'utf-8'));
      return o && typeof o === 'object' ? o : {};
    } catch { return {}; }
  }

  private writeClosedSeen(o: Record<number, number>): void {
    fs.mkdirSync(this.lvStateDir, { recursive: true });
    fs.writeFileSync(this.closedSeenPath, JSON.stringify(o)); /* state-registry: local-verify-journal */
  }

  /** Metadata-only audit log, rotating at 5 MB, 10 files kept. */
  private audit(event: Record<string, unknown>): void {
    appendLocalVerifyAudit(this.auditPath, event, this.now());
  }
}

/** Append one metadata-only line to the local-verify audit log (rotates at 5 MB, 10 files kept). Never throws. */
export function appendLocalVerifyAudit(p: string, event: Record<string, unknown>, nowMs: number): void {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const line = JSON.stringify({ ts: new Date(nowMs).toISOString(), ...event }) + '\n';
    let size = 0;
    try { size = fs.statSync(p).size; } catch { size = 0; }
    if (size + line.length > LOCAL_VERIFY_LIMITS.auditRotateBytes) {
      const keep = LOCAL_VERIFY_LIMITS.auditKeepFiles - 1; // base file + .1 … .9
      try { SafeFsExecutor.safeRmSync(`${p}.${keep}`, { force: true, operation: 'local-verify:audit-rotate' }); } catch { /* @silent-fallback-ok */ }
      for (let i = keep - 1; i >= 1; i--) {
        if (fs.existsSync(`${p}.${i}`)) fs.renameSync(`${p}.${i}`, `${p}.${i + 1}`);
      }
      if (fs.existsSync(p)) fs.renameSync(p, `${p}.1`);
    }
    fs.appendFileSync(p, line); /* state-registry: local-verify-audit */
  } catch { /* @silent-fallback-ok: the audit log never breaks a verify */ }
}
