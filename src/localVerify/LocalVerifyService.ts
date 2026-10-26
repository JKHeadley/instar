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
 * Merge line (amendment 2026-10-23, CMT-980): a queued PR keeps its place and its
 * `firstQueuedAt` when its head or base moves (the base is refreshed in place, a
 * new head takes the old entry's slot — CMT-973); every PR verify starts against
 * the base branch's CURRENT head (re-read right before the start when `main` has
 * moved since the entry's base was resolved, or the entry has waited a while); and
 * a green PR record is handed to the merge watcher at once (`setMergeHandoff`),
 * with the queue HELD until that attempt settles (bounded), so the next PR is
 * verified on top of the merge instead of racing it.
 *
 * Seams: `onRecord` (status projection / posting), `onStarved` (attention item),
 * `onMainHealthChange` (event-driven withdrawal), `signal` (main-red, main-unverified).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { executionKey, recordKey, validateRecord, isValidPr, isValidSha, MAIN_VERIFY_PR, type LocalVerifyRecord } from './record.js';
import { MainHealth, MAIN_VERIFY_LIMITS, releaseCollapsesInto, type CommitInfo, decideMainEnqueue, decideMainErrorRetry, decideMainHeadEnqueue, type MainHealthSnapshot } from './mainHealth.js';
import { isMergeEligible } from '../../scripts/local-verify-floor.mjs';
import { LOCAL_VERIFY_DEADLINES, LOCAL_VERIFY_LIMITS, computePolicyHash } from './policy.js';
import type { RestartHold } from '../core/UpdateGate.js';
import type { FailureDetail, VerifyRunInput, VerifyRunResult } from './orchestrator.js';

/** Repeat-flake escalation (one tracked item per file, re-raised when the flake keeps recurring). */
export const FLAKY_REPEAT = Object.freeze({ count: 3, windowMs: 7 * 24 * 60 * 60_000, keep: 20 });

interface FlakyHistory {
  v: 1;
  files: Record<string, { seen: string[]; escalatedAt: string | null }>;
  greenMain: { headSha: string; finishedAt: string; notClean: string[] } | null;
}

/**
 * A file re-run-passed ≥ 3 times within 7 days opens a NEW episode of its flaky item (with the
 * count); at most one escalation per 7-day window per file. Pure (convergence model input).
 */
export function decideFlakyEscalation(
  h: { seen: readonly string[]; escalatedAt: string | null },
  now: number,
  limits: { count: number; windowMs: number } = FLAKY_REPEAT,
): { escalate: boolean; count: number } {
  const count = h.seen.filter((iso) => now - Date.parse(iso) <= limits.windowMs).length;
  const recent = h.escalatedAt !== null && now - Date.parse(h.escalatedAt) < limits.windowMs;
  return { escalate: count >= limits.count && !recent, count };
}

/** The bounded `run-detail` audit/signal payload for a finished verify (PR or `main`). */
export function runDetail(record: LocalVerifyRecord, run?: { reasons?: string[]; failures?: FailureDetail[] }): Record<string, unknown> {
  return {
    ...(record.kind === 'main' ? { kind: 'main' } : { pr: record.pr }),
    headSha: record.headSha,
    outcome: record.outcome,
    ...(record.errorStep ? { errorStep: record.errorStep } : {}),
    reasons: (run?.reasons ?? []).slice(0, 40),
    failures: (run?.failures ?? []).slice(0, 30),
    ...(record.flakyRetried ? { flakyRetried: record.flakyRetried } : {}),
  };
}

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
  /**
   * The CURRENT head of a base branch (`gh api repos/{repo}/branches/{b}`), or null on
   * read failure. A PR's `baseRefOid` is the base as of the PR's last update, which
   * can be days stale; a verify must test the merge with today's base. Absent ⇒ the
   * PR view's `baseRefOid` is used (test seams only).
   */
  baseHead?(baseRefName: string): Promise<string | null>;
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
  onStarved?(info: { pr: number; headSha: string; waitedMs: number; interruptions?: number; reason?: 'waited' | 'interrupted' }): void;
  /** Called by the completion path after a record is journaled (status projection plugs in here later). */
  onRecord?(record: LocalVerifyRecord): void;
  /** `git merge-base --is-ancestor` through the verifier's git funnel; null = undecidable (main health stays unhealthy). */
  isAncestor?(ancestor: string, descendant: string): Promise<boolean | null>;
  /** Synchronous hook after every main-health state change (event-driven withdrawal). */
  onMainHealthChange?(snap: MainHealthSnapshot, prev: MainHealthSnapshot): void;
  /** The AutoUpdater state rule (b) needs (narrow seam; absent or null ⇒ never pauses). */
  updatePending?(): UpdatePendingState | null;
  /**
   * The verifier version as the files ON DISK compute it right now (what a run child spawned
   * now would see). Absent or null ⇒ unknown: the pre-start check never holds, the child's own
   * check still refuses a changed verifier.
   */
  installedVerifierVersion?(): string | null;
  /** Deduped attention signal (`local-verify:main-red`, `local-verify:main-unverified`, `local-verify:flaky:<file>`). */
  signal?(key: string, detail: Record<string, unknown>): void;
  /** A `main` head's subject and parents (release collapse); null when unreadable (verify as usual). */
  commitInfo?(sha: string): Promise<CommitInfo | null>;
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
  /** Time spent paused for a pending update; subtracted from the starved clock. */
  pausedMs?: number;
  /** When `baseSha` was last read from the base branch (request, in-place update or pre-start refresh). */
  baseResolvedAt?: number;
  /**
   * Runs of this (pr, head) a server stop killed before they finished. Each one is also an
   * attempt (`attempts` is not rolled back), and INTERRUPTION_LIMITS.starvedAfter of them
   * raise the starved signal without waiting for the clock.
   */
  interruptions?: number;
  /** Set when a server stop killed this entry's run: it starts ahead of a `main` verify next (cleared at start). */
  resumeFirst?: true;
}

export { MAIN_VERIFY_LIMITS };

// ---- the merge line (CMT-980) ----

/** Bounds of the merge line: the hand-off hold and the pre-start base refresh. */
export const MERGE_LINE = Object.freeze({
  /** The queue is held for a merge hand-off at most this long (the watcher's 25-min sync merge + margin). */
  handoffMaxMs: 30 * 60_000,
  /** An entry whose base was resolved this long ago re-reads the base head before it starts. */
  baseRefreshAfterMs: 5 * 60_000,
});

/** What the service hands the watcher for a green PR record. */
export interface MergeHandoffContext {
  /** Whether the record's base is the `main` head the reconcile loop last observed; null when unknown or not a `main` PR. */
  baseIsCurrentMain: boolean | null;
  currentMainHead: string | null;
}

export type MergeHandoffResult = { acted: boolean; reason: string };

/** The late-bound merge watcher: one attempt for exactly this (pr, head), through every existing gate. */
export type MergeHandoff = (record: LocalVerifyRecord, ctx: MergeHandoffContext) => Promise<MergeHandoffResult>;

/**
 * Should a PR entry re-read its base head before it starts? Yes when `main` moved
 * after the entry's base was resolved (a merge landed, or the reconcile loop saw a
 * new head), or when the entry has waited `baseRefreshAfterMs` since then. Pure.
 */
export function decideBaseRefresh(
  entry: { baseRefName: string; firstQueuedAt: number; baseResolvedAt?: number },
  i: { now: number; mainMovedAt: number | null },
  limits: { baseRefreshAfterMs: number } = MERGE_LINE,
): boolean {
  const resolvedAt = entry.baseResolvedAt ?? entry.firstQueuedAt;
  if (i.mainMovedAt !== null && entry.baseRefName === 'main' && i.mainMovedAt > resolvedAt) return true;
  return i.now - resolvedAt >= limits.baseRefreshAfterMs;
}

/**
 * Should a finished record be handed to the merge watcher now? Only a green PR
 * record, only with a watcher attached, only while the service runs, and only one
 * hand-off at a time (a second green record while a hold is open is left to the
 * watcher's next tick, never queued behind the hold). Pure.
 */
export function decideMergeHandoff(
  i: { outcome: LocalVerifyRecord['outcome']; kind?: 'main'; wired: boolean; enabled?: boolean; stopped: boolean; holdOpen: boolean },
): { handoff: boolean; skip?: 'not-success' | 'main-record' | 'no-watcher' | 'disabled' | 'stopping' | 'hold-active' } {
  if (!i.wired) return { handoff: false, skip: 'no-watcher' };
  if (i.enabled === false) return { handoff: false, skip: 'disabled' };
  if (i.stopped) return { handoff: false, skip: 'stopping' };
  if (i.kind === 'main') return { handoff: false, skip: 'main-record' };
  if (i.outcome !== 'success') return { handoff: false, skip: 'not-success' };
  if (i.holdOpen) return { handoff: false, skip: 'hold-active' };
  return { handoff: true };
}

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

/** A run a server stop kills: how many of them make an entry starved without waiting for the clock. */
export const INTERRUPTION_LIMITS = Object.freeze({ starvedAfter: 2 });

/**
 * The starved signal: once per entry, when it has waited (capacity waits included) longer
 * than `starvedAfterMs`, or when server stops have killed its run `starvedAfter` times
 * (each restart puts it back to zero, so waiting alone hides a run that can never finish).
 */
export function decideStarved(
  entry: { firstQueuedAt: number; starvedRaised: boolean; interruptions?: number },
  now: number,
  limits: { starvedAfterMs: number; interruptedStarvedAfter?: number } = { ...LOCAL_VERIFY_LIMITS, interruptedStarvedAfter: INTERRUPTION_LIMITS.starvedAfter },
): { raise: boolean; waitedMs: number; reason: 'waited' | 'interrupted' | null } {
  const waitedMs = now - entry.firstQueuedAt;
  if (entry.starvedRaised) return { raise: false, waitedMs, reason: null };
  if (waitedMs > limits.starvedAfterMs) return { raise: true, waitedMs, reason: 'waited' };
  const after = limits.interruptedStarvedAfter ?? INTERRUPTION_LIMITS.starvedAfter;
  if ((entry.interruptions ?? 0) >= after) return { raise: true, waitedMs, reason: 'interrupted' };
  return { raise: false, waitedMs, reason: null };
}

/**
 * Start admission for the (priority-sorted) queue: a foreign full suite holding the
 * slot is a capacity wait (not an attempt, the entry keeps its place); otherwise the
 * first entry whose backoff has elapsed starts.
 */
export function decideStart(
  i: {
    foreignHolders: number;
    queue: ReadonlyArray<{ notBefore?: number; kind?: 'main'; resumeFirst?: true }>;
    now: number;
    /** The fair-share inputs (absent ⇒ the first ready entry, the pre-fair-share order). */
    fairShare?: FairShareState;
  },
  limits: { mainFairShareMs: number } = { mainFairShareMs: MAIN_FAIR_SHARE_MS },
): { kind: 'capacity-wait' } | { kind: 'idle' } | { kind: 'start'; index: number } {
  if (i.foreignHolders > 0) return { kind: 'capacity-wait' };
  const ready = (e: { notBefore?: number }) => e.notBefore === undefined || e.notBefore <= i.now;
  const first = i.queue.findIndex(ready);
  if (first < 0) return { kind: 'idle' };
  if (!i.fairShare) return { kind: 'start', index: first };
  const fs = i.fairShare;
  // A PR run a server stop killed goes back first (wherever it sits among the ready PRs, with
  // or without a `main` verify waiting): the restart, not the PR, lost its place. Not while
  // `main` is known red (the repair path).
  const resumeIdx = i.queue.findIndex((e) => ready(e) && e.kind !== 'main' && e.resumeFirst);
  if (resumeIdx >= 0 && !fs.mainRed) return { kind: 'start', index: resumeIdx };
  const mainIdx = i.queue.findIndex((e) => ready(e) && e.kind === 'main');
  const prIdx = i.queue.findIndex((e) => ready(e) && e.kind !== 'main');
  if (mainIdx < 0 || prIdx < 0) return { kind: 'start', index: mainIdx < 0 ? prIdx : mainIdx };
  if (fs.mainHealthy) {
    // Healthy: `main` goes first once its oldest unverified merge is old enough that waiting
    // longer would approach the unverified alarm; until then waiting PRs go first.
    const due = fs.oldestUnverifiedMainAt !== null && i.now - fs.oldestUnverifiedMainAt >= limits.mainFairShareMs;
    return { kind: 'start', index: due ? mainIdx : prIdx };
  }
  // Suspect or red: `main` keeps priority (the repair path), but at most every other start.
  return { kind: 'start', index: fs.lastStartWasMain ? prIdx : mainIdx };
}

/** Fair share between `main` and PR verifies (Throughput budget). */
export interface FairShareState {
  mainHealthy: boolean;
  /** `main` is known red (not just unverified or suspect). Absent ⇒ not red. */
  mainRed?: boolean;
  /** When the oldest `main` merge not yet covered by a green verify was first seen; null if none. */
  oldestUnverifiedMainAt: number | null;
  /** Whether the last verify started was a `main` verify. */
  lastStartWasMain: boolean;
}

/**
 * With `main` healthy, a `main` verify goes ahead of waiting PRs once its oldest unverified
 * merge is this old (so a healthy main never nears the 3 h unverified alarm just by waiting:
 * 90 min + one PR verify + its own verify stays under it); before that, PRs go first.
 */
export const MAIN_FAIR_SHARE_MS = 90 * 60_000;

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
  | { ok: false; code: 'invalid-pr' | 'pr-unreadable' | 'pr-closed' | 'untrusted-head' | 'queue-full' | 'pr-invalid-shas' | 'main-unhealthy' | 'stopping' };

interface InFlight {
  entry: QueueEntry;
  token: string;
  pgid: number;
  inputPath: string;
  resultPath: string;
  cancelled: boolean;
  /** When the run child started (restart-hold bound). */
  startedAt: number;
}

/** A queue entry as persisted in `state/local-verify/queue.json` (PR verifies only; `main` is re-derived). */
export interface PersistedQueueEntry {
  pr: number;
  headSha: string;
  baseSha: string;
  baseRefName: string;
  firstQueuedAt: number;
  attempts: number;
  errorRetries: number;
  starvedRaised: boolean;
  /** Time spent paused for a pending update (never counts toward starved). */
  pausedMs?: number;
  /** When the base was last resolved; absent on a file written before the merge line (the base is then refreshed at start). */
  baseResolvedAt?: number;
  /** Present on the entry that was RUNNING when the file was written: found at boot ⇒ an unclean exit. */
  inFlight?: true;
  /** Runs a server stop killed (see QueueEntry.interruptions). */
  interruptions?: number;
  /** The entry's run was killed by a server stop: it starts first after the restart. */
  resumeFirst?: true;
}

/** What the AutoUpdater tells the verifier (spec §2 Restarts rule (b)); null = unknown (never pauses). */
export interface UpdatePendingState {
  /** autoApply is on and an update is pending (pendingUpdate set, or coalescingUntil holds a time). */
  pending: boolean;
  /** When the pending update was first detected (pendingUpdateDetectedAt), ms; null if unknown. */
  pendingSinceMs: number | null;
  /** Something other than this verifier's own hold is delaying the restart (sessions, other holds). */
  otherBlockers: boolean;
}

export const UPDATE_PAUSE_MAX_MS = 120 * 60_000;

/**
 * A verifier-changed hold normally ends with the update's restart (~1 min after the files
 * land). One that outlives this is a restart that is not coming: it is signalled once.
 */
export const VERIFIER_HOLD_SIGNAL_MS = 15 * 60_000;

/** A run child's `verifier-mismatch` refusal (runVerifyMain.checkVerifierVersion), as distinct from any other crash. */
export function isVerifierMismatch(result: VerifyRunResult | { kind: 'crash'; detail: string } | null): boolean {
  return !!result && result.kind === 'crash' && String((result as { detail?: unknown }).detail ?? '').startsWith('verifier-mismatch');
}

/** The verifier-changed hold: the installed verifier differs from the one this server labels records with. */
export interface VerifierHold {
  since: number;
  detail: string;
  /** How it was found: the run child refused, or the pre-start check saw the files differ. */
  where: 'run' | 'before-start';
  signalled: boolean;
}

/**
 * Spec §2 Restarts rule (b): while an update is pending and this verifier's own hold is the
 * only thing delaying the restart, NO NEW verify starts (the running one finishes and the
 * restart goes ahead). Starts resume once the update has been pending > 120 min, or when
 * something else is delaying the restart anyway. Unknown state never pauses.
 */
export function decideUpdatePause(u: UpdatePendingState | null, now: number, maxMs: number = UPDATE_PAUSE_MAX_MS): boolean {
  if (!u || !u.pending || u.otherBlockers) return false;
  if (u.pendingSinceMs !== null && now - u.pendingSinceMs > maxMs) return false;
  return true;
}

/**
 * The longest a verify that started at `startedAt` can still be running: its whole
 * active-work budget plus the in-place waits it may make before lanes 2 and 3 (the
 * child's own hard bounds — the server cannot see how much of either it has used, so
 * this is the run's own ceiling, never longer). Capped at `now + maxDeferralMs`.
 */
export function restartHoldUntil(
  startedAt: number,
  now: number,
  maxDeferralMs: number,
  limits: { totalActiveMs: number; waitInPlaceMs: number; inPlaceWaits: number } = {
    totalActiveMs: LOCAL_VERIFY_DEADLINES.totalActiveMs,
    waitInPlaceMs: LOCAL_VERIFY_LIMITS.waitInPlaceMs,
    inPlaceWaits: 2,
  },
): number {
  const runCeiling = startedAt + limits.totalActiveMs + limits.inPlaceWaits * limits.waitInPlaceMs;
  return Math.min(runCeiling, now + maxDeferralMs);
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
  /** Late-bound rule (b) source (the AutoUpdater is wired after the service is built). */
  setUpdatePendingProvider(fn: (() => UpdatePendingState | null) | null): void { this.updateProvider = fn; }
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
  /** Set by shutdown(): nothing new starts, no timers are armed. */
  private stopped = false;
  /** Fair-share bookkeeping (decideStart). */
  private lastStartWasMain = false;
  /** `main` heads this machine has a (non-error) main record for, newest last; bounded. */
  private readonly verifiedMainHeads: string[] = [];
  /** A collapsed release head → the covered parent it stands for. */
  private readonly releaseAlias = new Map<string, string>();
  /** Flaky files seen in records: file → { count, lastSeen }. */
  private readonly flaky = new Map<string, { count: number; lastSeen: string; lane: string }>();
  private readonly flakySignalled = new Set<string>();
  /** Set while restoreQueue() runs: request() waits behind it, pump() starts nothing, nothing is persisted. */
  private restoring: Promise<unknown> | null = null;
  /** The last queue.json content written (write only on change). */
  private lastQueueJson: string | null = null;
  /** Rule (b) pause bookkeeping. */
  private pausedSince: number | null = null;
  private updateProvider: (() => UpdatePendingState | null) | null = null;
  /**
   * The installed verifier changed under this server (an update replaced the files on disk;
   * the restart follows). Nothing starts while set; the hold is in-memory only, so the next
   * boot — whose verifierVersion is computed from the new files — resumes the queue in order.
   */
  private verifierHold: VerifierHold | null = null;
  /** Merge line (CMT-980): the late-bound watcher, the open hold, and when `main` last moved. */
  private mergeHandoff: MergeHandoff | null = null;
  /** The live kill switch (`monitoring.localVerify.mergeLine`); absent ⇒ on. */
  private mergeLineEnabled: (() => boolean) | null = null;
  private mergeHold: { pr: number; headSha: string; since: number } | null = null;
  /** A PR entry re-reading its base head right before it starts (pump starts nothing meanwhile). */
  private starting: QueueEntry | null = null;
  private mainMovedAt: number | null = null;
  private readonly mergeLineStats = { handoffs: 0, merged: 0, lastOutcome: null as string | null, lastPr: null as number | null };

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
  get queuePath(): string { return path.join(this.lvStateDir, 'queue.json'); }
  private get closedSeenPath(): string { return path.join(this.lvStateDir, 'closed-seen.json'); }
  private get runsDir(): string { return path.join(this.lvStateDir, 'runs'); }
  get auditPath(): string { return path.join(this.cfg.stateDir, 'logs', 'local-verify.jsonl'); }

  /** Late-bind the merge watcher (built before this service). null detaches it: records are left to the watcher's ticks. */
  /** `opts.enabled` is the live switch; ABSENT means on (the line is on by default, off only by `monitoring.localVerify.mergeLine: false`). */
  setMergeHandoff(fn: MergeHandoff | null, opts: { enabled?: () => boolean } = {}): void {
    this.mergeHandoff = fn;
    this.mergeLineEnabled = fn ? (opts.enabled ?? null) : null;
  }

  private mergeLineOn(): boolean {
    try { return this.mergeLineEnabled ? this.mergeLineEnabled() !== false : true; } catch { return true; } // @silent-fallback-ok: an unreadable switch reads as on (today's default)
  }

  /** The merge line's state: wired or not, the live switch, the open hold, and the hand-off counters (`merged` counts acted hand-offs). */
  mergeLine(): { wired: boolean; enabled: boolean; hold: { pr: number; headSha: string; since: string } | null; handoffs: number; merged: number; lastOutcome: string | null; lastPr: number | null } {
    const h = this.mergeHold;
    return {
      wired: this.mergeHandoff !== null,
      enabled: this.mergeHandoff !== null && this.mergeLineOn(),
      hold: h ? { pr: h.pr, headSha: h.headSha, since: new Date(h.since).toISOString() } : null,
      ...this.mergeLineStats,
    };
  }

  // ---- read surface ----

  getRecord(pr: number, headSha: string, baseRefName: string): LocalVerifyRecord | null {
    try { return this.index.get(recordKey(this.cfg.repo, pr, headSha, baseRefName)) ?? null; } catch { return null; }
  }

  snapshot(): { queue: QueueEntry[]; inFlight: { pr: number; headSha: string; kind?: 'main' } | null; blocked: boolean; verifierHold: { since: string; detail: string; where: VerifierHold['where'] } | null; records: number; flakyFiles: Record<string, { count: number; lastSeen: string; lane: string }>; mergeLine: ReturnType<LocalVerifyService['mergeLine']> } {
    const h = this.verifierHold;
    return {
      queue: this.queue.map((e) => ({ ...e })),
      inFlight: this.inFlight
        ? { pr: this.inFlight.entry.pr, headSha: this.inFlight.entry.headSha, ...(this.inFlight.entry.kind ? { kind: this.inFlight.entry.kind } : {}) }
        : null,
      blocked: this.blockedBy !== null,
      verifierHold: h ? { since: new Date(h.since).toISOString(), detail: h.detail, where: h.where } : null,
      records: this.index.size,
      flakyFiles: this.flakyFiles(),
      mergeLine: this.mergeLine(),
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
    // Order matters: the orphan reap runs first, and a still-blocked reap keeps every
    // restored entry waiting (pump refuses while blockedBy is set).
    await this.reapOrphan();
    await this.rebuildIndex();
    await this.restoreQueue();
  }

  /**
   * The restart hold for the AutoUpdater: while a verify runs, an automatic update
   * restart waits until the run's own ceiling (capped by `maxDeferralMs`). A manual
   * apply is not held (the AutoUpdater skips holds for it).
   */
  restartHolds(maxDeferralMs: number): RestartHold[] {
    const f = this.inFlight;
    if (!f || f.cancelled || this.stopped) return [];
    const now = this.now();
    const what = f.entry.kind === 'main' ? `main ${f.entry.headSha.slice(0, 12)}` : `PR #${f.entry.pr} at ${f.entry.headSha.slice(0, 12)}`;
    return [{
      name: f.entry.kind === 'main' ? 'local-verify:main' : `local-verify:pr-${f.entry.pr}`,
      until: restartHoldUntil(f.startedAt, now, maxDeferralMs),
      reason: `a local verify of ${what} is running`,
    }];
  }

  /**
   * Restore the durable queue written before the last stop. An entry is dropped when its
   * PR is closed or its head (or base branch) moved since; one already recorded is not
   * re-queued. An unreadable PR is kept (it refuses at request time if it stays so).
   */
  async restoreQueue(): Promise<{ restored: number; dropped: number }> {
    const run = this.doRestoreQueue();
    this.restoring = run;
    try {
      return await run;
    } finally {
      this.restoring = null;
      this.persistQueue(); // the next tick (or request) starts work: never before the boot finishes
    }
  }

  private async doRestoreQueue(): Promise<{ restored: number; dropped: number }> {
    const saved = this.readQueueFile();
    let restored = 0;
    const drops = { closed: 0, 'head-or-base-moved': 0, 'already-recorded': 0, duplicate: 0, 'queue-full': 0, 'server-restarted': 0 };
    for (const e of saved) {
      if (this.queue.some((q) => q.pr === e.pr) || (this.inFlight && this.inFlight.entry.pr === e.pr)) { drops.duplicate++; continue; }
      const open = await this.seams.isPrOpen(e.pr).catch(() => null);
      const view = open === false ? null : await this.seams.prView(e.pr).catch(() => null);
      const why = open === false ? 'closed'
        : view && (view.headRefOid !== e.headSha || view.baseRefName !== e.baseRefName) ? 'head-or-base-moved'
          : this.getRecord(e.pr, e.headSha, e.baseRefName)?.outcome === 'success' ? 'already-recorded' : null;
      if (why) {
        drops[why]++;
        this.audit({ event: 'queue-restore-dropped', pr: e.pr, headSha: e.headSha, reason: why });
        continue;
      }
      if (this.prQueueLength() >= LOCAL_VERIFY_LIMITS.queueCap) { drops['queue-full']++; continue; }
      const entry: QueueEntry = {
        id: crypto.randomBytes(6).toString('hex'), pr: e.pr, headSha: e.headSha,
        baseSha: view?.baseRefOid && isValidSha(view.baseRefOid) ? view.baseRefOid : e.baseSha,
        baseRefName: e.baseRefName, firstQueuedAt: e.firstQueuedAt, attempts: e.attempts,
        errorRetries: e.errorRetries, starvedRaised: e.starvedRaised, priority: 0,
        ...(e.pausedMs ? { pausedMs: e.pausedMs } : {}),
        ...(e.baseResolvedAt ? { baseResolvedAt: e.baseResolvedAt } : {}),
        ...(e.interruptions ? { interruptions: e.interruptions } : {}),
        ...(e.resumeFirst ? { resumeFirst: true as const } : {}),
      };
      if (e.inFlight) {
        // The server stopped without a clean shutdown while this ran: also an interruption.
        entry.interruptions = (entry.interruptions ?? 0) + 1;
        entry.resumeFirst = true;
        // It was running when the server died without a clean shutdown: that is one error
        // retry; past the limit it stops with an `error` record instead of re-running forever.
        const d = decideVerifyRetry(entry, 'error');
        if (d.action !== 're-run') {
          // Dropped with an error record past the retry limit — but a PR the server keeps
          // dying under still raises its alarm (otherwise the drop hides the second kill).
          this.raiseStarvedIfDue(entry);
          drops['server-restarted']++;
          this.complete(this.syntheticError(entry, 'server-restarted'), 'run');
          this.audit({ event: 'queue-restore-stopped', pr: e.pr, headSha: e.headSha, reason: 'server-restarted' });
          continue;
        }
        entry.errorRetries = d.errorRetries;
        this.audit({ event: 'queue-restore-unclean', pr: e.pr, headSha: e.headSha, errorRetries: entry.errorRetries });
      }
      this.queue.push(entry);
      restored++;
    }
    // A restored entry the restarts have already killed twice alarms NOW, before anything
    // can start it (a `main` observation pumps the queue before the first tick).
    for (const e of this.queue) if (e.kind !== 'main') this.raiseStarvedIfDue(e);
    const dropped = Object.values(drops).reduce((a, b) => a + b, 0);
    this.audit({ event: 'queue-restored', restored, dropped, drops });
    return { restored, dropped };
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
    // A head different from the last one observed: queued PR entries resolved before now re-read their base at start.
    if (o.head !== null && o.head !== sha) this.mainMovedAt = now;
    if (sha !== this.health.snapshot().lastGreenHead && o.oldestUnverifiedAt === null) o.oldestUnverifiedAt = now;
    const d = decideMainHeadEnqueue(o, sha, now);
    o.head = d.next.head; o.since = d.next.since; o.firstUnverifiedAt = d.next.firstUnverifiedAt;
    o.handled = d.next.handled; o.immediate = d.next.immediate;
    if (d.enqueue) {
      if (!this.seams.commitInfo) this.enqueueMain(sha, 'head-changed');
      else {
        // A release commit of a head already queued or verified never starts a verify of its own.
        // Covered = a head this machine holds a main record for, or one queued/running now. A
        // force-pushed main (parent from an old history with no record here) is verified.
        const covered = new Set<string>(this.verifiedMainHeads);
        const pend = this.queue.find((e) => e.kind === 'main');
        if (pend) covered.add(pend.headSha);
        if (this.inFlight?.entry.kind === 'main' && !this.inFlight.cancelled) covered.add(this.inFlight.entry.headSha);
        const work = this.seams.commitInfo(sha).catch(() => null).then((info) => {
          const parent = releaseCollapsesInto(info, covered);
          if (parent === null) { this.enqueueMain(sha, 'head-changed'); return; }
          this.releaseAlias.set(sha, parent);
          if (this.releaseAlias.size > 50) this.releaseAlias.delete(this.releaseAlias.keys().next().value as string);
          if (parent === this.health.snapshot().lastGreenHead && this.mainObs.head === sha) this.mainObs.oldestUnverifiedAt = null;
          this.audit({ event: 'main-release-collapsed', headSha: sha, into: parent });
        });
        this.pendingMainWork.push(work);
      }
    }
  }

  private noteMainHeadVerified(sha: string): void {
    const i = this.verifiedMainHeads.indexOf(sha);
    if (i >= 0) this.verifiedMainHeads.splice(i, 1);
    this.verifiedMainHeads.push(sha);
    if (this.verifiedMainHeads.length > 20) this.verifiedMainHeads.shift();
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
      this.noteFlaky(r, { signal: false });
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
    if (this.stopped) return { ok: false, code: 'stopping' };
    if (this.restoring) await this.restoring.catch(() => undefined);
    // While `main` is unhealthy the watcher requests no PR verifies (they fail by
    // construction); POSTed ones still run, which is how a repair gets its record.
    if (!explicit && !this.health.isHealthy()) return { ok: false, code: 'main-unhealthy' };
    const view = await this.seams.prView(pr).catch(() => null);
    if (!view) return { ok: false, code: 'pr-unreadable' };
    // A merged or closed PR has nothing to verify (an unknown answer queues it: the pre-start check asks again).
    if ((await this.seams.isPrOpen(pr).catch(() => null)) === false) {
      this.audit({ event: 'refused', pr, reason: 'pr-closed' });
      // A queued entry for it is no better: drop it now (a run in flight carries on to its own record).
      const queued = this.queue.findIndex((e) => e.pr === pr && e.kind !== 'main');
      if (queued >= 0) {
        const [e] = this.queue.splice(queued, 1);
        this.audit({ event: 'dequeued', pr, reason: 'closed', headSha: e.headSha });
        this.pump();
      }
      return { ok: false, code: 'pr-closed' };
    }
    if (!checkEligibility(view, this.cfg).eligible) {
      this.audit({ event: 'refused', pr, reason: 'untrusted-head' });
      return { ok: false, code: 'untrusted-head' };
    }
    // Verify against the base branch's current head, never the PR's stale baseRefOid.
    let currentBase: string | null = view.baseRefOid;
    if (this.seams.baseHead) {
      currentBase = await this.seams.baseHead(view.baseRefName).catch(() => null);
      if (!currentBase) return { ok: false, code: 'pr-unreadable' };
    }
    if (!isValidSha(view.headRefOid) || !isValidSha(currentBase)) return { ok: false, code: 'pr-invalid-shas' };
    const headSha = view.headRefOid;
    const baseSha = currentBase;
    const baseRefName = view.baseRefName;
    const key = recordKey(this.cfg.repo, pr, headSha, baseRefName);

    // CMT-973: a PR keeps its place and its firstQueuedAt. A base that moved is refreshed in
    // place; a moved head (or a retarget) takes the old entry's slot — the FRONT when the old
    // head was the run in flight (a push during a PR's own run never sends it to the back).
    // A new head is new work: `interruptions` start over, but a turn lost to a restart (`resumeFirst`) is kept.
    let keptPlace: { index: number; firstQueuedAt: number; pausedMs?: number; starvedRaised: boolean; resumeFirst?: true } | null = null;
    // A moved head (or retarget) cancels the in-flight run for the old one.
    const f = this.inFlight;
    if (f && f.entry.pr === pr) {
      if (f.entry.headSha !== headSha || f.entry.baseRefName !== baseRefName) {
        this.cancelInFlight('head-moved');
        keptPlace = { index: 0, firstQueuedAt: f.entry.firstQueuedAt, pausedMs: f.entry.pausedMs, starvedRaised: f.entry.starvedRaised, resumeFirst: f.entry.resumeFirst };
      } else if (!f.cancelled) return { ok: true, status: 'in-flight' };
    }
    const pendingIdx = this.queue.findIndex((e) => e.pr === pr);
    if (pendingIdx >= 0) {
      const e = this.queue[pendingIdx];
      if (e.headSha === headSha && e.baseRefName === baseRefName) {
        if (e.baseSha !== baseSha) {
          const oldBase = e.baseSha;
          e.baseSha = baseSha;
          this.audit({ event: 'base-updated', pr, headSha, oldBase, newBase: baseSha, position: pendingIdx, firstQueuedAt: e.firstQueuedAt });
        }
        e.baseResolvedAt = this.now(); // the base was just read: no pre-start re-read needed for a while
        this.persistQueue();
        return { ok: true, status: 'already-queued', position: pendingIdx };
      }
      this.queue.splice(pendingIdx, 1);
      keptPlace = { index: pendingIdx, firstQueuedAt: e.firstQueuedAt, pausedMs: e.pausedMs, starvedRaised: e.starvedRaised, resumeFirst: e.resumeFirst };
      this.persistQueue();
      this.audit({ event: 'dequeued', pr, reason: 'head-moved', headSha: e.headSha });
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
      firstQueuedAt: keptPlace?.firstQueuedAt ?? this.now(), attempts: 0, errorRetries: 0,
      starvedRaised: keptPlace?.starvedRaised ?? false, priority: 0, baseResolvedAt: this.now(),
      ...(keptPlace?.pausedMs ? { pausedMs: keptPlace.pausedMs } : {}),
      ...(keptPlace?.resumeFirst ? { resumeFirst: true as const } : {}),
    };
    if (keptPlace && keptPlace.index < this.queue.length) this.queue.splice(keptPlace.index, 0, entry);
    else this.queue.push(entry);
    this.audit({ event: 'queued', pr, headSha, baseSha, explicit, ...(keptPlace ? { keptPlace: true, firstQueuedAt: entry.firstQueuedAt } : {}) });
    const position = this.queue.indexOf(entry);
    this.pump();
    return { ok: true, status: 'queued', position };
  }

  /** Periodic driver: orphan unblock, starvation signal, start the next run. */
  async tick(): Promise<void> {
    if (this.blockedBy) await this.reapOrphan();
    if (this.verifierHold) this.recheckVerifierHold();
    this.notePause();
    this.checkStarved();
    this.health.noteUnverifiedAge(this.mainObs.oldestUnverifiedAt);
    this.pump();
  }

  private prQueueLength(): number {
    return this.queue.reduce((n, e) => n + (e.kind === 'main' ? 0 : 1), 0);
  }

  /**
   * Server shutdown: stop the in-flight run's group and start nothing else. The
   * cancelled entry goes back to the head of the durable queue (not as an attempt),
   * so the next boot resumes it. No timer is armed (the process is exiting); a group
   * that survives SIGTERM is found by the next boot's orphan reap.
   */
  shutdown(): void {
    if (this.stopped) return;
    this.stopped = true;
    const f = this.inFlight;
    if (f && !f.cancelled) {
      this.cancelInFlight('shutdown', { armKillTimer: false });
      if (f.entry.kind !== 'main') {
        // The stop killed a real run: it stays counted as an attempt, it is recorded as an
        // interruption (enough of them raise the starved signal), and it goes back first.
        f.entry.interruptions = (f.entry.interruptions ?? 0) + 1;
        f.entry.resumeFirst = true;
        this.queue.unshift(f.entry);
        this.audit({ event: 'interrupted', pr: f.entry.pr, headSha: f.entry.headSha, interruptions: f.entry.interruptions, ranMs: this.now() - f.startedAt });
      }
    }
    this.persistQueue();
  }

  // ---- internals ----

  private checkStarved(): void {
    // Queued PRs plus the one running (or about to): an interrupted PR that resumed first
    // is in flight by the first tick and must still raise its alarm.
    const prs = this.queue.filter((e) => e.kind !== 'main');
    const f = this.inFlight;
    if (f && !f.cancelled && f.entry.kind !== 'main' && !prs.includes(f.entry)) prs.push(f.entry);
    if (prs.length === 0) return;
    const oldest = prs.reduce((a, b) => (a.firstQueuedAt <= b.firstQueuedAt ? a : b));
    // The oldest entry by the clock, and any entry whose run keeps being killed by restarts.
    const candidates = [oldest, ...prs.filter((e) => e !== oldest && (e.interruptions ?? 0) > 0)];
    let changed = false;
    for (const e of candidates) if (this.raiseStarvedIfDue(e)) changed = true;
    if (changed) this.persistQueue(); // once-per-entry survives a crash right after the signal
  }

  /** The starved signal for one entry, once (time paused for a pending update never counts). */
  private raiseStarvedIfDue(e: QueueEntry): boolean {
    const { raise, waitedMs: waited, reason } = decideStarved({ ...e, firstQueuedAt: e.firstQueuedAt + (e.pausedMs ?? 0) }, this.now());
    if (!raise || !reason) return false;
    e.starvedRaised = true;
    const interruptions = e.interruptions ?? 0;
    this.audit({ event: 'starved', pr: e.pr, headSha: e.headSha, waitedMs: waited, reason, interruptions });
    this.seams.onStarved?.({ pr: e.pr, headSha: e.headSha, waitedMs: waited, interruptions, reason });
    return true;
  }

  /** Rule (b): is starting a new verify paused for a pending update right now? Also accrues paused time. */
  private notePause(): boolean {
    const now = this.now();
    let state: UpdatePendingState | null = null;
    try { state = (this.updateProvider ?? this.seams.updatePending)?.() ?? null; } catch { state = null; }
    const paused = decideUpdatePause(state, now);
    if (this.pausedSince !== null) {
      const dt = Math.max(0, now - this.pausedSince);
      for (const e of this.queue) if (e.kind !== 'main') e.pausedMs = (e.pausedMs ?? 0) + dt;
    }
    if (paused && this.pausedSince === null) this.audit({ event: 'update-pause', pendingSinceMs: state?.pendingSinceMs ?? null });
    if (!paused && this.pausedSince !== null) this.audit({ event: 'update-pause-ended' });
    this.pausedSince = paused ? now : null;
    return paused;
  }

  /**
   * The installed verifier changed under this server: hold the queue for the restart. One open
   * hold at a time (the first finding is audited; later ones while held are the same event).
   * Never a record, never an attempt — the entries are intact for the next boot, which resumes
   * them in order.
   */
  private enterVerifierHold(detail: string, where: VerifierHold['where'], ctx: Record<string, unknown> = {}): void {
    if (this.verifierHold) return;
    this.verifierHold = { since: this.now(), detail, where, signalled: false };
    this.audit({ event: 'verifier-changed', where, detail, serverVersion: this.cfg.verifierVersion, ...ctx });
  }

  /**
   * Before a start: do the files on disk still compute this server's verifierVersion? When they
   * do not, a run child spawned now would refuse (`verifier-mismatch`), so the hold is entered
   * without spawning. Unknown (no seam, a read error mid-replacement) ⇒ false: the child's own
   * check still decides.
   */
  private verifierChangedOnDisk(): boolean {
    if (this.verifierHold) return true;
    let disk: string | null = null;
    try { disk = this.seams.installedVerifierVersion?.() ?? null; } catch { disk = null; } // @silent-fallback-ok: unknown never holds; the run child re-checks
    if (disk === null || disk === this.cfg.verifierVersion) return false;
    this.enterVerifierHold(`verifier-mismatch: server ${this.cfg.verifierVersion}, disk ${disk}`, 'before-start');
    return true;
  }

  /**
   * While held: the files may compute this server's version again (a flip that undid itself),
   * which releases the hold; a hold that outlives the restart it waits for is signalled once.
   */
  private recheckVerifierHold(): void {
    const h = this.verifierHold;
    if (!h) return;
    let disk: string | null = null;
    try { disk = this.seams.installedVerifierVersion?.() ?? null; } catch { disk = null; } // @silent-fallback-ok: unknown keeps the hold
    if (disk !== null && disk === this.cfg.verifierVersion) {
      this.verifierHold = null;
      this.audit({ event: 'verifier-hold-released', heldMs: this.now() - h.since, where: h.where });
      return;
    }
    const heldMs = this.now() - h.since;
    if (!h.signalled && heldMs >= VERIFIER_HOLD_SIGNAL_MS) {
      h.signalled = true;
      this.audit({ event: 'verifier-hold-overdue', heldMs, where: h.where, queued: this.queue.length });
      this.seams.signal?.('local-verify:verifier-hold', { heldMs, detail: h.detail, queued: this.queue.length, serverVersion: this.cfg.verifierVersion });
    }
  }

  private pump(): void {
    this.persistQueue();
    // A merge hand-off holds the queue (bounded): the next PR is verified on top of the merge, not against it.
    if (this.stopped || this.restoring || this.inFlight || this.starting || this.blockedBy || this.mergeHold || this.verifierHold || this.queue.length === 0) return;
    if (this.notePause()) return; // an update is waiting only on us: let the running verify end, start nothing
    const holders = this.seams.foreignSuiteHolders();
    if (holders.length > 0) {
      // A capacity wait: not an attempt, the entry keeps its place.
      this.audit({ event: 'overlap', where: 'before-start', holders: holders.map((h) => h.pid) });
      return;
    }
    // The files on disk must still be the verifier this server labels records with: an update
    // that landed under us holds the queue for the restart instead of spawning a child that refuses.
    if (this.verifierChangedOnDisk()) return;
    this.queue.sort((a, b) => b.priority - a.priority); // stable: FIFO within a priority
    const d = decideStart({
      foreignHolders: 0, queue: this.queue, now: this.now(),
      fairShare: { mainHealthy: this.health.isHealthy(), mainRed: this.health.snapshot().state === 'main-red', oldestUnverifiedMainAt: this.mainObs.oldestUnverifiedAt, lastStartWasMain: this.lastStartWasMain },
    });
    if (d.kind !== 'start') return;
    const next = this.queue[d.index];
    if (next.kind !== 'main' && decideBaseRefresh(next, { now: this.now(), mainMovedAt: this.mainMovedAt })) {
      // The verify tests the merge with TODAY's base: re-read it right before the start, and
      // confirm the PR is still open (a PR merged or closed while it waited is dropped, not run).
      this.starting = next;
      void this.refreshBaseThenPump(next);
      return;
    }
    const [entry] = this.queue.splice(d.index, 1);
    this.lastStartWasMain = entry.kind === 'main';
    this.start(entry);
  }

  /**
   * Re-read the base branch's head for an entry about to start (the entry stays in the
   * queue meanwhile, so a request for the same PR still finds it), and ask whether the PR
   * is still open: a definite "closed" drops it (audited `dequeued`, reason `closed`); an
   * unknown answer keeps it. A base read failure starts the run on the last known base (audited). Identical merge inputs already verified
   * green under this policy derive a record instead of re-running. Then pump again.
   */
  private async refreshBaseThenPump(entry: QueueEntry): Promise<void> {
    const [fresh, open] = await Promise.all([
      this.seams.baseHead ? this.seams.baseHead(entry.baseRefName).catch(() => null) : Promise.resolve(null),
      this.seams.isPrOpen(entry.pr).catch(() => null),
    ]);
    this.starting = null;
    if (this.stopped) return;
    if (this.queue.includes(entry) && open === false) {
      // Unknown (null) keeps it: only a definite "not open" drops an entry.
      this.queue.splice(this.queue.indexOf(entry), 1);
      this.audit({ event: 'dequeued', pr: entry.pr, reason: 'closed', headSha: entry.headSha });
    } else if (this.queue.includes(entry)) {
      if (this.seams.baseHead) { // without a base reader the base stays as resolved
        if (fresh && isValidSha(fresh)) {
          if (fresh !== entry.baseSha) {
            this.audit({ event: 'base-refreshed', pr: entry.pr, headSha: entry.headSha, oldBase: entry.baseSha, newBase: fresh });
            entry.baseSha = fresh;
          }
        } else {
          this.audit({ event: 'base-refresh-failed', pr: entry.pr, headSha: entry.headSha, baseSha: entry.baseSha });
        }
      }
      entry.baseResolvedAt = this.now();
      const exec = this.execIndex.get(executionKey(entry.headSha, entry.baseSha));
      if (exec && exec.outcome === 'success') {
        this.queue.splice(this.queue.indexOf(entry), 1);
        this.audit({ event: 'derived-at-start', pr: entry.pr, headSha: entry.headSha, baseSha: entry.baseSha });
        this.complete({ ...exec, pr: entry.pr, baseRefName: entry.baseRefName }, 'derived');
      }
    }
    this.pump();
  }

  /* @self-action-controller: local-verify-merge-handoff */
  /**
   * Hand a green PR record to the merge watcher at once and hold the queue until that
   * attempt settles (or `MERGE_LINE.handoffMaxMs`), so the next verify starts on top of
   * the merge. One hand-off per record; one hold at a time; every merge gate (lease,
   * latches, breaker, holds, code owners, independent review, safe-merge) stays the
   * watcher's. A hand-off never retries: a refused merge waits for the watcher's tick.
   */
  private offerMerge(record: LocalVerifyRecord): void {
    const d = decideMergeHandoff({ outcome: record.outcome, kind: record.kind, wired: this.mergeHandoff !== null, enabled: this.mergeLineOn(), stopped: this.stopped, holdOpen: this.mergeHold !== null });
    if (!d.handoff) {
      if (d.skip === 'hold-active') this.audit({ event: 'merge-handoff-skipped', pr: record.pr, headSha: record.headSha, reason: d.skip, holdPr: this.mergeHold?.pr });
      return;
    }
    const fn = this.mergeHandoff!;
    const currentMainHead = this.mainObs.head;
    const baseIsCurrentMain = record.baseRefName !== 'main' || currentMainHead === null ? null : currentMainHead === record.baseSha;
    const hold = { pr: record.pr, headSha: record.headSha, since: this.now() };
    this.mergeHold = hold;
    this.mergeLineStats.handoffs++;
    this.mergeLineStats.lastPr = record.pr;
    this.audit({ event: 'merge-handoff', pr: record.pr, headSha: record.headSha, baseSha: record.baseSha, baseIsCurrentMain, currentMainHead });
    let settled = false;
    const finish = (outcome: string, acted: boolean) => {
      if (settled) {
        // The watcher answered after the hold timed out (a long in-flight wait plus its own merge).
        // The hold is gone, but a landed merge still moves main: the next start re-reads its base.
        if (outcome !== 'timeout') {
          if (acted) this.mainMovedAt = this.now();
          this.audit({ event: 'merge-handoff-late-answer', pr: record.pr, headSha: record.headSha, outcome, acted, heldMs: this.now() - hold.since, inFlight: this.inFlight?.entry.pr ?? null });
        }
        return;
      }
      settled = true;
      if (this.mergeHold === hold) this.mergeHold = null;
      this.mergeLineStats.lastOutcome = outcome;
      if (acted) {
        this.mergeLineStats.merged++;
        this.mainMovedAt = this.now(); // the next PR verify re-reads its base: it is tested on top of this merge
      }
      this.audit({ event: 'merge-handoff-result', pr: record.pr, headSha: record.headSha, outcome, acted, heldMs: this.now() - hold.since });
      this.pump();
    };
    const setTimer = this.seams.setTimer ?? ((f: () => void, ms: number) => { const t = setTimeout(f, ms); t.unref?.(); });
    setTimer(() => finish('timeout', false), MERGE_LINE.handoffMaxMs);
    Promise.resolve()
      .then(() => fn(record, { baseIsCurrentMain, currentMainHead }))
      .then(
        (r) => finish(r && typeof r.reason === 'string' ? r.reason : 'unknown', r?.acted === true),
        (e) => finish(`error:${(e instanceof Error ? e.message : String(e)).slice(0, 80)}`, false),
      );
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
      // PR verifies: an isolation re-run needs this machine's last green main record.
      ...(entry.kind === 'main' ? {} : { isolation: this.isolationInput() }),
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
    delete entry.resumeFirst; // it has its turn now

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
    this.inFlight = { entry, token, pgid: handle.pid, inputPath, resultPath, cancelled: false, startedAt: intent.startedAt };
    this.persistQueue();
    this.audit({ event: 'started', pr: entry.pr, headSha: entry.headSha, baseSha: entry.baseSha, pgid: handle.pid, attempt: entry.attempts });
    const mine = this.inFlight;
    handle.exited.then((x) => this.onExit(mine, x), () => this.onExit(mine, { status: null, signal: null }));
  }

  private cancelInFlight(reason: string, opts: { armKillTimer?: boolean } = {}): void {
    const f = this.inFlight;
    if (!f || f.cancelled) return;
    f.cancelled = true;
    this.audit({ event: 'cancel', pr: f.entry.pr, headSha: f.entry.headSha, reason });
    try { this.seams.killGroup(f.pgid, 'SIGTERM'); } catch { /* @silent-fallback-ok: group may already be gone */ }
    if (opts.armKillTimer === false) return;
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
    } else if (isVerifierMismatch(result)) {
      // The run child found the installed verifier differs from this server's (an update landed
      // on disk; the restart follows). Not this entry's fault and not an attempt: it goes back
      // to the head of the queue with no record, and nothing starts until the restart. PR and
      // `main` entries alike — the old 'error' record burned the whole queue in a second
      // (2026-10-24, three times: 9, 4 and 10 PRs), each record dequeuing its entry, so the next boot restored nothing.
      f.entry.attempts = Math.max(0, f.entry.attempts - 1);
      this.queue.unshift(f.entry);
      this.enterVerifierHold(String((result as { detail: string }).detail), 'run', { pr: f.entry.pr, headSha: f.entry.headSha, ...(f.entry.kind ? { kind: f.entry.kind } : {}), exit });
    } else if (f.entry.kind === 'main' && result?.kind !== 'requeue') {
      if (!result || result.kind === 'crash' || result.kind === 'invalid') {
        this.audit({ event: 'run-error', kind: 'main', headSha: f.entry.headSha, exit });
        this.completeMain(this.syntheticError(f.entry, !result || result.kind === 'crash' ? 'crash' : 'invalid-record'), f.entry);
      } else {
        this.completeMain(result.record, f.entry, { reasons: result.reasons, failures: result.failures });
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
      if (rec && (rec.outcome !== 'success' || rec.flakyRetried)) {
        // Why it went red (or what was flaky), bounded: reasons, each failed file's first error, the flaky re-runs.
        this.audit({ event: 'run-detail', ...runDetail(rec, result) });
      }
      if (rec) this.noteFlaky(rec);
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
  private completeMain(record: LocalVerifyRecord, entry: QueueEntry, run?: { reasons: string[]; failures?: FailureDetail[] }): void {
    const v = validateRecord(record);
    if (!v.ok || record.kind !== 'main' || record.headSha !== entry.headSha) {
      this.audit({ event: 'record-rejected', kind: 'main', errors: v.ok ? ['kind-or-head'] : v.errors });
      return;
    }
    const head = record.headSha;
    this.audit({ event: 'main-record', headSha: head, outcome: record.outcome, errorStep: record.errorStep });
    const detail = runDetail(record, run);
    if (record.outcome !== 'error') this.noteMainHeadVerified(head);
    if (record.outcome === 'success') this.saveGreenMain(record);
    if (record.outcome !== 'success' || record.flakyRetried) this.audit({ event: 'run-detail', kind: 'main', ...detail });
    this.noteFlaky(record);
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
    const current = this.mainObs.head;
    if (record.outcome === 'success' && current !== null && (head === current || this.releaseAlias.get(current) === head)) this.mainObs.oldestUnverifiedAt = null;
    const work = this.health.onVerify(head, record.outcome, detail).then(async (action) => {
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
    this.offerMerge(record);
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
      this.persistQueue();
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

  /**
   * Persist the PR queue (the in-flight PR entry first, then the pending ones) with an
   * atomic write. `main` entries are not persisted: the reconcile loop re-derives them.
   */
  private persistQueue(): void {
    if (this.restoring) return; // restore writes once it has the whole picture
    try {
      const entries: QueueEntry[] = [];
      const f = this.inFlight;
      if (f && !f.cancelled && f.entry.kind !== 'main') entries.push(f.entry);
      for (const e of this.queue) if (e.kind !== 'main' && !entries.includes(e)) entries.push(e);
      const out: PersistedQueueEntry[] = entries.map((e) => ({
        pr: e.pr, headSha: e.headSha, baseSha: e.baseSha, baseRefName: e.baseRefName,
        firstQueuedAt: e.firstQueuedAt, attempts: e.attempts, errorRetries: e.errorRetries, starvedRaised: e.starvedRaised,
        ...(e.pausedMs ? { pausedMs: e.pausedMs } : {}),
        ...(e.baseResolvedAt ? { baseResolvedAt: e.baseResolvedAt } : {}),
        ...(e.interruptions ? { interruptions: e.interruptions } : {}),
        ...(e.resumeFirst ? { resumeFirst: true as const } : {}),
        // The running entry is marked: a clean shutdown re-queues it unmarked, so a marked
        // entry found at boot means the server died mid-run.
        ...(f && !f.cancelled && f.entry === e ? { inFlight: true as const } : {}),
      }));
      const json = JSON.stringify({ v: 1, entries: out });
      if (json === this.lastQueueJson) return; // unchanged: no write
      fs.mkdirSync(this.lvStateDir, { recursive: true });
      const tmp = this.queuePath + '.tmp';
      fs.writeFileSync(tmp, json, { mode: 0o600 }); /* state-registry: local-verify-queue */
      fs.renameSync(tmp, this.queuePath);
      this.lastQueueJson = json;
    } catch (e) {
      this.audit({ event: 'queue-persist-failed', detail: e instanceof Error ? e.message : String(e) });
    }
  }

  /**
   * Read the saved queue. A file that exists but cannot be parsed (or has the wrong shape)
   * is moved aside to `queue.json.corrupt-<ts>` and audited `queue-restore-unreadable`, so
   * the evidence survives and the next write starts clean. Individually invalid entries are
   * skipped and counted.
   */
  private readQueueFile(): PersistedQueueEntry[] {
    let text: string;
    try { text = fs.readFileSync(this.queuePath, 'utf-8'); } catch { return []; } // @silent-fallback-ok: no saved queue (first boot)
    let o: { v?: number; entries?: unknown } | null = null;
    try { o = JSON.parse(text) as { v?: number; entries?: unknown }; } catch { o = null; }
    if (!o || o.v !== 1 || !Array.isArray(o.entries)) {
      const aside = `${this.queuePath}.corrupt-${this.now()}`;
      try { fs.renameSync(this.queuePath, aside); } catch { /* @silent-fallback-ok: audited below either way */ }
      this.audit({ event: 'queue-restore-unreadable', movedTo: path.basename(aside), bytes: text.length });
      return [];
    }
    const valid = o.entries.filter((e): e is PersistedQueueEntry => {
      const x = e as PersistedQueueEntry;
      return !!x && isValidPr(x.pr) && isValidSha(x.headSha) && isValidSha(x.baseSha) && typeof x.baseRefName === 'string'
        && Number.isFinite(x.firstQueuedAt) && Number.isFinite(x.attempts) && Number.isFinite(x.errorRetries);
    }).map((x) => ({
      ...x, starvedRaised: x.starvedRaised === true,
      pausedMs: Number.isFinite(x.pausedMs) && (x.pausedMs as number) > 0 ? x.pausedMs : undefined,
      baseResolvedAt: Number.isFinite(x.baseResolvedAt) && (x.baseResolvedAt as number) > 0 ? x.baseResolvedAt : undefined,
      inFlight: x.inFlight === true ? true as const : undefined,
      interruptions: Number.isInteger(x.interruptions) && (x.interruptions as number) > 0 ? x.interruptions : undefined,
      resumeFirst: x.resumeFirst === true ? true as const : undefined,
    }));
    if (valid.length !== o.entries.length) this.audit({ event: 'queue-restore-invalid-entries', skipped: o.entries.length - valid.length });
    return valid;
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

  /**
   * Every record with `flakyRetried` (PR or main) counts each file and raises ONE deduped
   * signal per file (`local-verify:flaky:<file>`), so each flaky test becomes a tracked item.
   */
  private noteFlaky(record: LocalVerifyRecord, opts: { signal?: boolean } = {}): void {
    if (!record.flakyRetried?.length) return;
    const hist = this.readFlakyHistory();
    for (const f of record.flakyRetried) {
      const prev = this.flaky.get(f.file);
      this.flaky.set(f.file, { count: (prev?.count ?? 0) + 1, lastSeen: record.finishedAt > (prev?.lastSeen ?? '') ? record.finishedAt : prev!.lastSeen, lane: f.lane });
      if (opts.signal === false) continue;
      const base = { file: f.file, lane: f.lane, firstMessage: f.firstMessage, headSha: record.headSha, ...(record.kind === 'main' ? { kind: 'main' } : { pr: record.pr }) };
      // Durable per-file history: re-run passes in the last 7 days, and the last escalation.
      const h = hist.files[f.file] ?? { seen: [], escalatedAt: null };
      const nowMs = this.now();
      h.seen = [...h.seen, record.finishedAt].filter((iso) => nowMs - Date.parse(iso) <= FLAKY_REPEAT.windowMs).slice(-FLAKY_REPEAT.keep);
      const d = decideFlakyEscalation({ seen: h.seen, escalatedAt: h.escalatedAt }, nowMs);
      if (d.escalate) {
        h.escalatedAt = new Date(nowMs).toISOString();
        this.signal(`local-verify:flaky:${f.file}:repeat-${h.escalatedAt.slice(0, 10)}`, { ...base, count: d.count, windowDays: 7 });
      }
      hist.files[f.file] = h;
      const key = `local-verify:flaky:${f.file}`;
      if (this.flakySignalled.has(key)) continue;
      this.flakySignalled.add(key);
      this.signal(key, base);
    }
    if (opts.signal !== false) this.writeFlakyHistory(hist);
  }

  private signal(key: string, detail: Record<string, unknown>): void {
    try { this.seams.signal?.(key, detail); } catch { /* @silent-fallback-ok: a signal sink failure never changes a record */ }
  }

  private get flakyHistoryPath(): string { return path.join(this.lvStateDir, 'flaky-history.json'); }

  private readFlakyHistory(): FlakyHistory {
    try {
      const o = JSON.parse(fs.readFileSync(this.flakyHistoryPath, 'utf-8')) as Partial<FlakyHistory>;
      if (o && o.v === 1 && o.files && typeof o.files === 'object') return { v: 1, files: o.files, greenMain: o.greenMain ?? null };
    } catch { /* @silent-fallback-ok: no history yet */ }
    return { v: 1, files: {}, greenMain: null };
  }

  private writeFlakyHistory(h: FlakyHistory): void {
    try {
      // Bounded: newest 500 files.
      const entries = Object.entries(h.files).sort(([, a], [, b]) => ((a.seen.at(-1) ?? '') < (b.seen.at(-1) ?? '') ? 1 : -1)).slice(0, 500);
      const out: FlakyHistory = { v: 1, files: Object.fromEntries(entries), greenMain: h.greenMain };
      fs.mkdirSync(this.lvStateDir, { recursive: true });
      const tmp = this.flakyHistoryPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(out)); /* state-registry: local-verify-flaky */
      fs.renameSync(tmp, this.flakyHistoryPath);
    } catch (e) {
      this.audit({ event: 'flaky-history-write-failed', detail: e instanceof Error ? e.message : String(e) });
    }
  }

  /** The last green `main` record this machine holds (its head and the files that were NOT clean on it). */
  private saveGreenMain(record: LocalVerifyRecord): void {
    const h = this.readFlakyHistory();
    h.greenMain = { headSha: record.headSha, finishedAt: record.finishedAt, notClean: (record.flakyRetried ?? []).map((f) => f.file) };
    this.writeFlakyHistory(h);
  }

  /** What a PR verify's isolation re-run may use: allowed only with a green main record on this machine. */
  isolationInput(): { allowed: boolean; notCleanOnGreenMain: string[] } {
    const g = this.readFlakyHistory().greenMain;
    return g ? { allowed: true, notCleanOnGreenMain: g.notClean } : { allowed: false, notCleanOnGreenMain: [] };
  }

  /** file → { count, lastSeen, lane } over the journal and this process's records. */
  flakyFiles(): Record<string, { count: number; lastSeen: string; lane: string }> {
    return Object.fromEntries([...this.flaky.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
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
