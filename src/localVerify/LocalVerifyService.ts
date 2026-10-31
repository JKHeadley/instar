/**
 * A preflight red creates a durable full-suite replay obligation; only full green is merge authority.
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
import { PreflightReplayStore, replayKey, type PreflightReplay } from './preflightReplay.js';
import { FailedFileDiagnosisCoordinator } from './FailedFileDiagnosisCoordinator.js';
import { FailedFileDiagnosisPeerService } from './FailedFileDiagnosisPeerService.js';
import type { DiagnosisMode } from './failedFileDiagnosis.js';
import type { DiagnosisPeerClient, DiagnosisPeerRequest } from './failedFileDiagnosisPeer.js';
import { MainHealth, MAIN_VERIFY_LIMITS, releaseCollapsesInto, type CommitInfo, decideMainEnqueue, decideMainErrorRetry, decideMainHeadEnqueue, type MainHealthSnapshot } from './mainHealth.js';
import { isMergeEligible } from '../../scripts/local-verify-floor.mjs';
import { LOCAL_VERIFY_DEADLINES, LOCAL_VERIFY_LIMITS, computePolicyHash } from './policy.js';
import { decideMainRedHold, holdReasonText, mainFailureFromRunDetail, prMatchText, repairVerdict, type MainFailureDetail, type MainRedHoldDecision, type RepairCandidate } from './mainRedHold.js';
import type { RestartHold } from '../core/UpdateGate.js';
import { MAX_LANE_SHARDS, type FailureDetail, type VerifyRunInput, type VerifyRunResult } from './orchestrator.js';
import { PREFLIGHT_LIMITS } from './preflight.js';
import {
  PEER_LIMITS, importRefusal, noteFailure, noteSuccess, parsePeers, peerHealthy,
  type PeerClient, type PeerHealth, type PeerResult, type PeerRunAnswer, type PeerRunRequest, type PeerStatus, type PeerTarget, type RemoteMarker,
} from './peer.js';

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
  /** Title + body + changed files (gh `--json title,body,files`; files = the first 100). Absent on older seams ⇒ unknown. */
  title?: string | null;
  body?: string | null;
  files?: ReadonlyArray<{ path: string }> | null;
  /** The PR's labels (gh `--json labels`). Absent ⇒ none: ordinary priority. */
  labels?: ReadonlyArray<{ name: string }> | null;
}

/**
 * Queue priority levels (higher starts first; FIFO within a level). The `main` health
 * verify stays on top; a PR labelled `merge-throughput` (work that safely raises merge
 * throughput) runs ahead of ordinary PRs. While the main-red hold is active only repair
 * candidates may start at all, so a labelled PR never runs ahead of the PR fixing a red
 * `main` unless it is itself such a repair.
 */
export const MERGE_THROUGHPUT_LABEL = 'merge-throughput';
/** The ONE attention item for the "main is red" condition (stable id: a newer red head refreshes the same row; green closes it). */
export const MAIN_RED_HOLD_SIGNAL_KEY = 'local-verify:main-red-hold';
export const QUEUE_PRIORITY = Object.freeze({ main: MAIN_VERIFY_LIMITS.priority, mergeThroughput: 10, ordinary: 0 });
/**
 * The bound on the label: an ordinary PR that has waited this long (update pauses excluded)
 * is ranked at the throughput level too, so no labelled PR queued after it can pass it. Half
 * of `starvedAfterMs` (3 h), and the starved alarm is unchanged.
 */
export const THROUGHPUT_AGING_MS = 90 * 60_000;

/** The queue cap an entry of this priority is admitted under: labelled throughput work gets a bounded overflow. */
export function capFor(priority: number): number {
  return priority === QUEUE_PRIORITY.mergeThroughput
    ? LOCAL_VERIFY_LIMITS.queueCap + LOCAL_VERIFY_LIMITS.throughputOverflow
    : LOCAL_VERIFY_LIMITS.queueCap;
}

/** The stored priority for a PR entry, from its labels. */
export function prPriority(view: Pick<PrView, 'labels'> | null | undefined): number {
  const labels = view?.labels;
  return Array.isArray(labels) && labels.some((l) => !!l && l.name === MERGE_THROUGHPUT_LABEL) ? QUEUE_PRIORITY.mergeThroughput : QUEUE_PRIORITY.ordinary;
}

/** The priority the queue is sorted by: stored priority, raised to the throughput level once an ordinary PR has aged. Pure. */
export function effectivePriority(e: { priority: number; kind?: 'main'; firstQueuedAt: number; pausedMs?: number }, now: number, agingMs: number = THROUGHPUT_AGING_MS): number {
  if (e.kind === 'main') return e.priority;
  const waited = now - e.firstQueuedAt - (e.pausedMs ?? 0);
  return waited >= agingMs ? Math.max(e.priority, QUEUE_PRIORITY.mergeThroughput) : e.priority;
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
  /** Host suite cap; unknown capacity leaves spare-slot policy unchanged. */
  suiteCapacity?(): number;
  /** Publish/clear the merge-gate's short host-wide claim for the next suite slot. */
  setSuitePriority?(active: boolean): void;
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
  /** Close a deduped attention item whose condition ended (the main-red hold item, on green). */
  clearSignal?(key: string, resolution: string): void;
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
  /**
   * A peer-only service (spec local-verify-capacity.md Part D): built on a machine with no
   * instar source checkout so it can run verifies a coordinator hands it. It refuses every
   * coordinator role: no requests, no queue, no merge line, no `main` verifies.
   */
  peerOnly?: boolean;
}

export interface QueueEntry {
  id: string;
  pr: number;
  headSha: string;
  baseSha: string;
  baseRefName: string;
  /** Set only by the automatic merge watcher, whose candidates can be rediscovered after lease movement. */
  preflightRediscoverable?: boolean;
  /** This attempt consumes the durable full-suite replay, never a new preflight. */
  preflightReplay?: boolean;
  /** A contained preflight infrastructure error retries in a fresh tree without another preflight. */
  preflightBypassRetry?: true;
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
  /** Repo-relative files the PR changes (from the PR view; null = unreadable). In memory only: a restore re-reads the view. */
  files?: string[] | null;
  /** The PR's title + body, lowercased and bounded, for the main-red repair match. In memory only. */
  text?: string;
  /** Coordinator: reserved for one peer attempt (spec local-verify-capacity.md Part D). Persisted. */
  remote?: RemoteMarker;
  /** Coordinator: remote attempts spent on this entry (bounded by PEER_LIMITS.maxAttemptsPerEntry). Persisted. */
  remoteAttempts?: number;
  /** Peer: the coordinator's attempt this run answers. Never persisted in the queue (the peer keeps its own attempt file). */
  peerAttempt?: { id: string; coordinatorMachineId: string; leaseEpoch: number | null };
  /** Peer: the coordinator's isolation input for this run (its last green `main`). */
  peerIsolation?: { allowed: boolean; notCleanOnGreenMain: string[] };
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

/** Why a queued PR is not starting yet (GET /local-verify `mainRedHold`, the POST answer's `hold`). */
export interface MainRedHoldInfo {
  reason: 'main-red';
  state: 'main-suspect' | 'main-red';
  redHead: string;
  failingFiles: string[];
  /** PRs admitted as repair candidates (they run first). */
  repairPrs: number[];
  /** PRs waiting for `main` to be green. */
  heldPrs: number[];
  detail: string;
}

export type RequestResult =
  | { ok: true; status: 'queued' | 'already-queued' | 'in-flight'; position?: number; hold?: MainRedHoldInfo }
  | { ok: true; status: 'recorded'; record: LocalVerifyRecord }
  | { ok: false; code: 'invalid-pr' | 'pr-unreadable' | 'pr-closed' | 'untrusted-head' | 'queue-full' | 'pr-invalid-shas' | 'main-unhealthy' | 'stopping' | 'peer-only' };

interface InFlight {
  entry: QueueEntry;
  token: string;
  pgid: number;
  inputPath: string;
  resultPath: string;
  cancelled: boolean;
  /** Latched once the child itself holds a suite slot; frees spare slots when cap > 1. */
  suiteSlotAcquired?: boolean;
  /** When the run child started (restart-hold bound). */
  startedAt: number;
  /** Latched at spawn: a live setting change cannot shorten this child's restart hold. */
  preflightAllowanceMs: number;
}

/** Peer side: what this machine knows about the attempts coordinators handed it. */
interface PeerAttemptState {
  current: { attemptId: string; pr: number; headSha: string; state: 'running' | 'done'; acceptedAt: number; record?: LocalVerifyRecord } | null;
  /** The last few finished attempts (so a late poll still finds its result). */
  results: Array<{ attemptId: string; record: LocalVerifyRecord }>;
  /** attemptId → when it was cancelled or abandoned; a peer-run for one is refused. */
  tombstones: Record<string, number>;
}

const PEER_RESULTS_KEPT = 20;

function isRemoteMarker(v: unknown): v is RemoteMarker {
  if (!v || typeof v !== 'object') return false;
  const m = v as RemoteMarker;
  const d = m.dispatched as unknown as Record<string, unknown> | undefined;
  return typeof m.machineId === 'string' && typeof m.attemptId === 'string' && /^[0-9a-f]{32}$/.test(m.attemptId)
    && (m.leaseEpoch === null || Number.isSafeInteger(m.leaseEpoch)) && Number.isFinite(m.sentAt)
    && (m.state === 'sending' || m.state === 'accepted') && !!d && isValidPr(d.pr) && isValidSha(d.headSha) && isValidSha(d.baseSha)
    && typeof d.baseRefName === 'string' && typeof d.verifierVersion === 'string' && typeof d.policyHash === 'string';
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
  /** The merge-throughput priority, kept so a restore whose PR view is unreadable does not drop the label. Absent ⇒ ordinary. */
  priority?: number;
  /** A peer reservation (Part D), kept as written so a restart resumes polling the same attempt. */
  remote?: RemoteMarker;
  remoteAttempts?: number;
  preflightBypassRetry?: true;
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
 * this is the run's own ceiling, never longer). A child that can enter focused
 * preflight has one additional bounded allowance. Capped at `now + maxDeferralMs`.
 */
export function restartHoldUntil(
  startedAt: number,
  now: number,
  maxDeferralMs: number,
  preflightAllowanceMs: number = 0,
  limits: { totalActiveMs: number; waitInPlaceMs: number; inPlaceWaits: number } = {
    totalActiveMs: LOCAL_VERIFY_DEADLINES.totalActiveMs,
    waitInPlaceMs: LOCAL_VERIFY_LIMITS.waitInPlaceMs,
    inPlaceWaits: 2,
  },
): number {
  const runCeiling = startedAt + limits.totalActiveMs + limits.inPlaceWaits * limits.waitInPlaceMs + preflightAllowanceMs;
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
  /** Main-red hold (CMT-1033): the last failed `main` verify's failing files, the live switch, and the once-per-episode bookkeeping. */
  private mainFailure: MainFailureDetail | null = null;
  private mainRedHoldEnabled: (() => boolean) | null = null;
  // ---- peer verifiers (spec local-verify-capacity.md Part D) ----
  /** Peer role switch (`monitoring.localVerify.peer.enabled`; absent ⇒ off). */
  private peerRoleEnabled: (() => boolean) | null = null;
  /** Coordinator: the configured peers (`monitoring.localVerify.peers`; absent ⇒ none). */
  private peersSetting: (() => unknown) | null = null;
  private peerClient: PeerClient | null = null;
  private leaseView: { holdsLease(): boolean; leaseEpoch(): number | null; holderMachineId(): string | null } | null = null;
  private readonly peerHealth = new Map<string, PeerHealth>();
  private readonly remotePolledAt = new Map<string, number>();
  private dispatching: QueueEntry | null = null;
  private dispatchScheduled = false;
  private dispatchRunning = false;
  private pollRunning = false;
  /** Peer side: the current attempt, recent results and cancelled ids (persisted to peer-attempts.json). */
  private peerState: PeerAttemptState = { current: null, results: [], tombstones: {} };
  /** Fail-fast for PR verifies (`monitoring.localVerify.failFast`; absent ⇒ on). */
  private failFastEnabled: (() => boolean) | null = null;
  /** Focused preflight is dark unless a host explicitly selects observe or enforce. */
  private preflightModeSetting: (() => unknown) | null = null;
  /** Null means the durable replay store could not be read; fail to observe mode. */
  private readonly preflightReplays: PreflightReplayStore | null;
  private failedFileDiagnosis: FailedFileDiagnosisCoordinator | null = null;
  private failedFileDiagnosisPeer: FailedFileDiagnosisPeerService | null = null;
  private replayAdmissionRunning = false;
  private replayWakeAt = 0;
  private replayCapacitySweepAt = 0;
  private replayCapacitySweepCursor = 0;
  /** Processes per slow lane (`monitoring.localVerify.laneShards`; absent ⇒ the policy defaults). */
  private laneShardsSetting: (() => unknown) | null = null;
  /** pr → the red head it was audited as held for (one `main-red-held` line per PR per episode). */
  private readonly heldAudited = new Map<number, string>();
  /** What the ONE hold item last said: the red head and the sorted repair-PR list (re-raised only when either changes). */
  private holdSignalled: string | null = null;
  /** Repair candidates seen this episode (kept after they leave the queue, until green). */
  private readonly repairSeen = new Map<number, RepairCandidate>();
  private holdIdleAudited: string | null = null;
  private suitePriorityClaimed = false;

  constructor(cfg: LocalVerifyServiceConfig, seams: LocalVerifyServiceSeams) {
    this.cfg = cfg;
    this.seams = seams;
    this.now = seams.now ?? (() => Date.now());
    this.policyHash = cfg.policyHash ?? computePolicyHash();
    try { this.preflightReplays = new PreflightReplayStore(path.join(cfg.stateDir, 'state')); }
    catch (e) {
      this.preflightReplays = null;
      this.audit({ event: 'preflight-replay-store-unreadable', detail: e instanceof Error ? e.message : String(e) });
    }
    this.health = new MainHealth(cfg.stateDir, cfg.machineId, {
      now: this.now,
      isAncestor: (a, d) => (seams.isAncestor ? seams.isAncestor(a, d) : Promise.resolve(null)),
      signal: (k, d) => seams.signal?.(k, d),
      onChange: (snap, prev) => seams.onMainHealthChange?.(snap, prev),
      audit: (e) => this.audit(e),
    });
    this.health.load(); // the watermark decides from the start (boot() re-reads it)
  }

  async wireFailedFileDiagnosis(modeSetting: () => unknown, client: DiagnosisPeerClient): Promise<void> {
    const mode = (): DiagnosisMode => {
      let value: unknown;
      try { value = modeSetting(); } catch { return 'off'; }
      return value === 'observe' || value === 'auto' ? value : 'off';
    };
    try {
      const peer = new FailedFileDiagnosisPeerService({
        stateDir: this.cfg.stateDir, agentHome: this.cfg.agentHome, repo: this.cfg.repo,
        remoteUrl: this.cfg.remoteUrl, machineId: this.cfg.machineId,
        verifierVersion: this.cfg.verifierVersion, policyHash: this.policyHash,
        nodePath: this.cfg.nodePath, childEntry: path.join(path.dirname(this.cfg.mainEntry), 'runFailedFileDiagnosisMain.js'),
        protectedList: this.cfg.protectedList, baseEnv: this.cfg.baseEnv,
      }, {
        now: this.now, mode: () => this.peerRoleOn() ? mode() : 'off',
        fullVerifyBusy: () => this.isDiagnosisCapacityBusy(), updatePending: () => this.notePause(),
        prView: (pr) => this.seams.prView(pr), baseHead: (ref) => this.seams.baseHead?.(ref) ?? Promise.resolve(null),
        isPrOpen: (pr) => this.seams.isPrOpen(pr), spawnRun: (arg) => this.seams.spawnRun(arg),
        currentLease: () => { const live = this.leaseState(); return { holdsLease: live.holds, holderMachineId: live.holder, leaseEpoch: live.epoch }; },
        isGroupAlive: (pid) => this.seams.isGroupAlive(pid), killGroup: (pid, signal) => this.seams.killGroup(pid, signal),
        readProcessArgs: (pid) => this.seams.readProcessArgs(pid), audit: (event) => this.audit(event),
      });
      await peer.boot();
      this.failedFileDiagnosisPeer = peer;
    } catch (error) {
      this.audit({ event: 'failed-file-diagnosis-peer-unavailable', detail: String(error).slice(0, 160) });
      this.failedFileDiagnosisPeer = null;
    }
    if (this.cfg.peerOnly) return;
    this.failedFileDiagnosis = new FailedFileDiagnosisCoordinator({
      stateDir: this.cfg.stateDir, repo: this.cfg.repo, machineId: this.cfg.machineId,
      verifierVersion: this.cfg.verifierVersion, policyHash: this.policyHash,
    }, {
      now: this.now, mode, holdsLease: () => this.leaseState().holds,
      leaseEpoch: () => this.leaseState().epoch,
      peers: () => this.peersSetting?.() ?? [], fullVerifyWaiting: () => this.isDiagnosisCapacityBusy(),
      prView: (pr) => this.seams.prView(pr), baseHead: (ref) => this.seams.baseHead?.(ref) ?? Promise.resolve(null),
      isPrOpen: (pr) => this.seams.isPrOpen(pr), client, audit: (event) => this.audit(event),
    });
  }

  diagnosisSummary() { return this.failedFileDiagnosis?.summary() ?? { mode: 'off' as const, storeReady: false, pending: 0, completed: 0, machineMinutes: 0 }; }
  diagnosisForRecord(record: LocalVerifyRecord) { return this.failedFileDiagnosis?.forRecord(record) ?? null; }
  diagnosisPeerStatus() { return this.failedFileDiagnosisPeer?.status() ?? { enabled: false, busy: false, verifierVersion: this.cfg.verifierVersion, policyHash: this.policyHash }; }
  diagnosisPeerResult(attemptId: string) { return this.failedFileDiagnosisPeer?.result(attemptId) ?? { state: 'unknown' as const }; }
  async diagnosisPeerAccept(request: DiagnosisPeerRequest, ctx: { holdsLease: boolean; holderMachineId: string | null; leaseEpoch: number | null }) {
    return this.failedFileDiagnosisPeer?.accept(request, ctx) ?? { accepted: false, reason: 'disabled' };
  }

  isDiagnosisCapacityBusy(): boolean {
    return !!this.inFlight || !!this.starting || this.queue.length > 0 || !!this.blockedBy || !!this.verifierHold || this.notePause();
  }

  // ---- paths ----

  private get lvStateDir(): string { return path.join(this.cfg.stateDir, 'state', 'local-verify'); }
  get journalPath(): string { return path.join(this.lvStateDir, 'journal.jsonl'); }
  get inFlightPath(): string { return path.join(this.lvStateDir, 'inflight.json'); }
  get queuePath(): string { return path.join(this.lvStateDir, 'queue.json'); }
  private get closedSeenPath(): string { return path.join(this.lvStateDir, 'closed-seen.json'); }
  private get mainFailurePath(): string { return path.join(this.lvStateDir, 'main-failure.json'); }
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

  /** Called once each time a verify run ends (its restart hold is gone). */
  private runEnded: (() => void) | null = null;
  setRunEndedListener(fn: (() => void) | null): void { this.runEnded = fn; }

  /** The live setting for processes per slow lane (read at each start; invalid values are ignored). */
  setLaneShards(fn: (() => unknown) | null): void { this.laneShardsSetting = fn; }

  private laneShards(): { integration?: number; e2e?: number } | null {
    let v: unknown;
    try { v = this.laneShardsSetting ? this.laneShardsSetting() : null; } catch { return null; } // @silent-fallback-ok: an unreadable setting means the policy defaults
    if (!v || typeof v !== 'object') return null;
    const out: { integration?: number; e2e?: number } = {};
    for (const k of ['integration', 'e2e'] as const) {
      const n = (v as Record<string, unknown>)[k];
      if (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= MAX_LANE_SHARDS) out[k] = n;
    }
    return Object.keys(out).length ? out : null;
  }

  /** The live switch for PR-verify fail-fast (`monitoring.localVerify.failFast`; absent ⇒ on). Read at each start. */
  setFailFastEnabled(fn: (() => boolean) | null): void { this.failFastEnabled = fn; }

  private failFastOn(): boolean {
    try { return this.failFastEnabled ? this.failFastEnabled() !== false : true; } catch { return false; } // @silent-fallback-ok: an unreadable switch reads as off (every lane runs, today's behaviour)
  }

  setPreflightMode(fn: (() => unknown) | null): void { this.preflightModeSetting = fn; }

  private preflightMode(): 'off' | 'observe' | 'enforce' {
    try {
      const mode = this.preflightModeSetting?.();
      return mode === 'enforce' && (!this.preflightReplays || !this.preflightReplays.hasCapacityForNew()
        || this.preflightReplays.list().some((r) => r.state === 'blocked'))
        ? 'observe' : mode === 'observe' || mode === 'enforce' ? mode : 'off';
    } catch { return 'off'; } // @silent-fallback-ok: unreadable tuning keeps the optional check dark
  }

  /** The live kill switch for the main-red hold (`monitoring.localVerify.mainRedHold`; absent ⇒ on). */
  setMainRedHoldEnabled(fn: (() => boolean) | null): void { this.mainRedHoldEnabled = fn; }

  private mainRedHoldOn(): boolean {
    try { return this.mainRedHoldEnabled ? this.mainRedHoldEnabled() !== false : true; } catch { return true; } // @silent-fallback-ok: an unreadable switch reads as on (the hold is the safe default: it only delays doomed runs)
  }

  /** The main-red hold over the current queue (pure decision over health, the kept failure detail and the queue). */
  private holdDecision(): MainRedHoldDecision {
    const h = this.health.snapshot();
    const asInput = (e: QueueEntry) => ({ pr: e.pr, kind: e.kind, files: e.files ?? null, text: e.text ?? '' });
    const f = this.inFlight;
    return decideMainRedHold({
      enabled: this.mainRedHoldOn(),
      health: { state: h.state, redHead: h.redHead },
      failure: this.mainFailure,
      queue: this.queue.map(asInput),
      inFlight: f && !f.cancelled ? asInput(f.entry) : null,
      remembered: [...this.repairSeen.values()],
    });
  }

  /** The hold as the read surface shows it (null when inactive). */
  mainRedHold(): (MainRedHoldInfo & { since: string | null }) | null {
    const d = this.holdDecision();
    if (!d.active) return null;
    return { ...this.holdInfo(d), since: this.mainFailure ? this.mainFailure.recordedAt : null };
  }

  private holdInfo(d: Extract<MainRedHoldDecision, { active: true }>): MainRedHoldInfo {
    return {
      reason: 'main-red', state: d.state as 'main-suspect' | 'main-red', redHead: d.redHead, failingFiles: d.failingFiles,
      repairPrs: d.repairPrs.map((r) => r.pr), heldPrs: d.heldPrs.map((h) => h.pr), detail: holdReasonText(d),
    };
  }

  /** The repair/held split for a failure over the queue as it is now (for the main-red signal's detail). */
  private holdLists(f: MainFailureDetail): { failingFiles: string[]; repairPrs: number[]; heldPrs: number[] } {
    const repairPrs: number[] = [];
    const heldPrs: number[] = [];
    for (const e of this.queue) {
      if (e.kind === 'main') continue;
      (repairVerdict({ files: e.files ?? null, text: e.text ?? '' }, f.files).candidate ? repairPrs : heldPrs).push(e.pr);
    }
    return { failingFiles: [...f.files], repairPrs, heldPrs };
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

  snapshot(): { queue: Array<QueueEntry & { held?: { reason: 'main-red'; why: 'no-overlap' | 'files-unknown' } }>; inFlight: { pr: number; headSha: string; kind?: 'main' } | null; blocked: boolean; verifierHold: { since: string; detail: string; where: VerifierHold['where'] } | null; records: number; flakyFiles: Record<string, { count: number; lastSeen: string; lane: string }>; mergeLine: ReturnType<LocalVerifyService['mergeLine']>; mainRedHold: ReturnType<LocalVerifyService['mainRedHold']>; peers: ReturnType<LocalVerifyService['peersInfo']>; preflight: { mode: 'off' | 'observe' | 'enforce'; replayStoreReady: boolean; replays: Array<{ pr: number; headSha: string; baseRefName: string; state: PreflightReplay['state']; admissionAttempts: number; executionAttempts: number; blockedReason?: string }> } } {
    const h = this.verifierHold;
    const hold = this.holdDecision();
    const heldWhy = new Map<number, 'no-overlap' | 'files-unknown'>(hold.active ? hold.heldPrs.map((x) => [x.pr, x.reason] as const) : []);
    return {
      // `text` (the PR body) stays out of the read surface; `files` is bounded and useful.
      queue: this.queue.map((e) => { const { text: _t, ...rest } = e; void _t; const why = heldWhy.get(e.pr); return why && e.kind !== 'main' ? { ...rest, held: { reason: 'main-red' as const, why } } : { ...rest }; }),
      mainRedHold: hold.active ? { ...this.holdInfo(hold), since: this.mainFailure ? this.mainFailure.recordedAt : null } : null,
      preflight: { mode: this.preflightMode(), replayStoreReady: this.preflightReplays !== null,
        replays: this.preflightReplays?.list().filter((r) => r.state !== 'completed').map((r) => ({ pr: r.pr, headSha: r.headSha, baseRefName: r.baseRefName,
          state: r.state, admissionAttempts: r.admissionAttempts, executionAttempts: r.executionAttempts,
          ...(r.blockedReason ? { blockedReason: r.blockedReason } : {}) })) ?? [] },
      inFlight: this.inFlight
        ? { pr: this.inFlight.entry.pr, headSha: this.inFlight.entry.headSha, ...(this.inFlight.entry.kind ? { kind: this.inFlight.entry.kind } : {}) }
        : null,
      blocked: this.blockedBy !== null,
      verifierHold: h ? { since: new Date(h.since).toISOString(), detail: h.detail, where: h.where } : null,
      records: this.index.size,
      flakyFiles: this.flakyFiles(),
      mergeLine: this.mergeLine(),
      peers: this.peersInfo(),
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
    this.mainFailure = this.readMainFailure();
    this.mainObs.immediate = true; // the boot-time `main` verify skips the debounce
    // Order matters: the orphan reap runs first, and a still-blocked reap keeps every
    // restored entry waiting (pump refuses while blockedBy is set).
    await this.reapOrphan();
    this.loadPeerState(); // after the reap: an interrupted peer attempt is tombstoned, never resumed
    await this.rebuildIndex();
    if (!this.cfg.peerOnly) await this.reconcilePreflightReplays();
    if (!this.cfg.peerOnly) await this.restoreQueue();
    this.scheduleReplayAdmission();
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
      until: restartHoldUntil(f.startedAt, now, maxDeferralMs, f.preflightAllowanceMs),
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
    const drops = { closed: 0, 'head-or-base-moved': 0, 'already-recorded': 0, duplicate: 0, 'queue-full': 0, 'server-restarted': 0, 'replay-managed': 0 };
    for (const e of saved) {
      if (this.queue.some((q) => q.pr === e.pr) || (this.inFlight && this.inFlight.entry.pr === e.pr)) { drops.duplicate++; continue; }
      const replay = this.preflightReplays?.get(replayKey({ repo: this.cfg.repo, pr: e.pr, headSha: e.headSha,
        baseRefName: e.baseRefName, policyHash: this.policyHash }));
      // The replay marker is the durable admission authority. A queued copy from
      // before a restart must not bypass its backoff or execution breaker. The
      // replay admission loop will re-read the PR and requeue when due.
      if (replay && (replay.state === 'pending' || replay.state === 'retryable-error' || e.inFlight)) {
        drops['replay-managed']++;
        this.audit({ event: 'queue-restore-dropped', pr: e.pr, headSha: e.headSha, reason: 'replay-managed', replayState: replay.state });
        continue;
      }
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
      const restoredPriority = view ? prPriority(view) : (e.priority === QUEUE_PRIORITY.mergeThroughput ? QUEUE_PRIORITY.mergeThroughput : QUEUE_PRIORITY.ordinary);
      // What was durably queued comes back, bounded by the largest cap any entry could have been
      // admitted under (labelled overflow included): restoring the labelled entries first must not
      // push ordinary entries that were legitimately queued below the cap out of the queue.
      // +1: the run interrupted by the restart comes back at the head on top of a full overflow.
      if (this.prQueueLength() >= capFor(QUEUE_PRIORITY.mergeThroughput) + 1) { drops['queue-full']++; continue; }
      const entry: QueueEntry = {
        id: crypto.randomBytes(6).toString('hex'), pr: e.pr, headSha: e.headSha,
        // A reserved entry keeps the base it was dispatched with (the marker's snapshot decides import).
        baseSha: e.remote ? e.baseSha : (view?.baseRefOid && isValidSha(view.baseRefOid) ? view.baseRefOid : e.baseSha),
        baseRefName: e.baseRefName, firstQueuedAt: e.firstQueuedAt, attempts: e.attempts,
        errorRetries: e.errorRetries, starvedRaised: e.starvedRaised,
        // An unreadable view keeps the saved label level (never more than the throughput level).
        priority: restoredPriority,
        files: view ? viewFiles(view) : null, text: view ? prMatchText(view.title, view.body) : '',
        ...(e.pausedMs ? { pausedMs: e.pausedMs } : {}),
        ...(e.baseResolvedAt ? { baseResolvedAt: e.baseResolvedAt } : {}),
        ...(e.remote ? { remote: e.remote } : {}),
        ...(e.remoteAttempts ? { remoteAttempts: e.remoteAttempts } : {}),
        ...(e.preflightBypassRetry ? { preflightBypassRetry: true as const } : {}),
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
    const replayReds = new Map<string, JournalLine>();
    for (const l of lines) {
      const k = recordKey(l.record.repo, l.record.pr, l.record.headSha, l.record.baseRefName);
      latest.set(k, l); // later lines win
      if (l.record.preflight?.mode === 'enforce' && l.record.preflight.reason === 'preflight-red') {
        const marker = this.preflightReplays?.get(replayKey(l.record));
        if (marker && marker.state !== 'completed') replayReds.set(marker.key, l);
      }
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
      if (r.outcome !== 'error' && r.preflight?.reason !== 'preflight-red') this.execIndex.set(executionKey(r.headSha, r.baseSha), r);
      this.noteFlaky(r, { signal: false });
    }
    keep.sort((a, b) => (a.writtenAt < b.writtenAt ? -1 : a.writtenAt > b.writtenAt ? 1 : 0));
    // A pending replay's red proof must survive journal compaction even when a later
    // infrastructure-error record superseded it in the latest-value index.
    const essential = [...replayReds.values()];
    const ordinary = keep.filter((l) => !essential.includes(l));
    const ordinaryRoom = Math.max(0, LOCAL_VERIFY_LIMITS.journalCap - essential.length);
    const capped = [...(ordinaryRoom > 0 ? ordinary.slice(-ordinaryRoom) : []), ...essential]
      .sort((a, b) => (a.writtenAt < b.writtenAt ? -1 : a.writtenAt > b.writtenAt ? 1 : 0));
    this.rewriteJournal(capped);
    for (const pr of Object.keys(closedSeen)) {
      if (nowMs - closedSeen[Number(pr)] >= LOCAL_VERIFY_LIMITS.retentionAfterCloseMs) delete closedSeen[Number(pr)];
    }
    this.writeClosedSeen(closedSeen);
    this.audit({ event: 'index-rebuilt', loaded: this.index.size, skippedVersion, skippedClosed, kept: capped.length });
    return { loaded: this.index.size, skippedVersion, skippedClosed, kept: capped.length };
  }

  /** Repair both crash windows around red-record publication and replay-marker persistence. */
  private async reconcilePreflightReplays(): Promise<void> {
    const store = this.preflightReplays;
    if (!store) return;
    const reds = new Map<string, LocalVerifyRecord>();
    for (const line of this.readJournal()) {
      const r = line.record;
      if (r.repo === this.cfg.repo && r.policyHash === this.policyHash && r.preflight?.mode === 'enforce'
        && r.preflight.outcome === 'red' && r.preflight.reason === 'preflight-red') reds.set(replayKey(r), r);
    }
    for (const marker of store.list()) {
      if (marker.policyHash !== this.policyHash) { store.cancel(marker.key); continue; }
      const [view, open] = await Promise.all([this.seams.prView(marker.pr).catch(() => null), this.seams.isPrOpen(marker.pr).catch(() => null)]);
      if (open === false || view && (view.headRefOid !== marker.headSha || view.baseRefName !== marker.baseRefName)) {
        store.cancel(marker.key);
        continue;
      }
      // The terminal marker is the durable evidence that this exact head already
      // received its one full-suite replay. Its red journal line may have been
      // compacted, and an upgrade may exclude the old full record from the index.
      if (marker.state === 'completed') continue;
      const latest = this.index.get(recordKey(marker.repo, marker.pr, marker.headSha, marker.baseRefName));
      if (latest && latest.outcome !== 'error' && latest.preflight?.reason !== 'preflight-red') {
        store.completeFromJournal(marker.key, this.now());
        continue;
      }
      if (!reds.has(marker.key)) {
        store.cancel(marker.key); // phantom marker: no validated red record authorizes admission
        this.audit({ event: 'preflight-replay-phantom-cancelled', pr: marker.pr });
        continue;
      }
      if (marker.state === 'running') store.recoverInterrupted(marker.key, this.now());
      if (marker.state === 'blocked' && marker.verifierVersion !== this.cfg.verifierVersion && open === true && view) {
        if (store.rearmOnce(marker.key, this.now())) this.audit({ event: 'preflight-replay-rearmed', pr: marker.pr, trigger: 'verifier-upgrade' });
      }
    }
    for (const [key, red] of reds) {
      if (store.get(key)) continue;
      const latest = this.index.get(recordKey(red.repo, red.pr, red.headSha, red.baseRefName));
      if (latest && latest.preflight?.reason !== 'preflight-red') continue;
      const [view, open] = await Promise.all([this.seams.prView(red.pr).catch(() => null), this.seams.isPrOpen(red.pr).catch(() => null)]);
      if (open !== true || !view || view.headRefOid !== red.headSha || view.baseRefName !== red.baseRefName) continue;
      store.ensureRed(red, this.now());
      this.audit({ event: 'preflight-replay-repaired-from-red', pr: red.pr, headSha: red.headSha });
    }
  }

  // ---- the POST path ----

  async request(pr: number, opts: { explicit?: boolean; force?: boolean; replay?: boolean } = {}): Promise<RequestResult> {
    const explicit = opts.explicit ?? true;
    if (!isValidPr(pr)) return { ok: false, code: 'invalid-pr' };
    if (this.cfg.peerOnly) return { ok: false, code: 'peer-only' };
    if (this.stopped) return { ok: false, code: 'stopping' };
    if (this.restoring) await this.restoring.catch(() => undefined);
    // While `main` is unhealthy the watcher requests no PR verifies (they fail by
    // construction); POSTed ones still run, which is how a repair gets its record.
    if (!explicit && !this.health.isHealthy()) return { ok: false, code: 'main-unhealthy' };
    const view = await this.seams.prView(pr).catch(() => null);
    if (!view) return { ok: false, code: 'pr-unreadable' };
    // A merged or closed PR has nothing to verify (an unknown answer queues it: the pre-start check asks again).
    if ((await this.seams.isPrOpen(pr).catch(() => null)) === false) {
      for (const marker of this.preflightReplays?.list().filter((r) => r.pr === pr) ?? []) this.preflightReplays?.cancel(marker.key);
      this.audit({ event: 'refused', pr, reason: 'pr-closed' });
      // A queued entry for it is no better: drop it now (a run in flight carries on to its own record).
      const queued = this.queue.findIndex((e) => e.pr === pr && e.kind !== 'main');
      if (queued >= 0) {
        const [e] = this.queue.splice(queued, 1);
        if (e.remote) this.abandonRemote(e, 'pr-closed', { failure: false, cancel: true });
        this.audit({ event: 'dequeued', pr, reason: 'closed', headSha: e.headSha });
        this.persistQueue();
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
    for (const marker of this.preflightReplays?.list().filter((r) => r.pr === pr
      && (r.headSha !== headSha || r.baseRefName !== baseRefName || r.policyHash !== this.policyHash)) ?? []) this.preflightReplays?.cancel(marker.key);
    const key = recordKey(this.cfg.repo, pr, headSha, baseRefName);
    const pendingReplay = this.preflightReplays?.get(replayKey({ repo: this.cfg.repo, pr, headSha, baseRefName, policyHash: this.policyHash }));
    const replayPriority = opts.replay || pendingReplay?.state === 'pending' || pendingReplay?.state === 'retryable-error';
    const requestedPriority = replayPriority ? QUEUE_PRIORITY.ordinary : prPriority(view);
    const prFiles = viewFiles(view);
    const prText = prMatchText(view.title, view.body);

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
        if (!explicit) e.preflightRediscoverable = true;
        // A reserved entry keeps the base it was handed to its peer with (the marker decides import).
        if (e.baseSha !== baseSha && !e.remote) {
          const oldBase = e.baseSha;
          e.baseSha = baseSha;
          this.audit({ event: 'base-updated', pr, headSha, oldBase, newBase: baseSha, position: pendingIdx, firstQueuedAt: e.firstQueuedAt });
        }
        e.baseResolvedAt = this.now(); // the base was just read: no pre-start re-read needed for a while
        e.priority = requestedPriority; // replay never inherits a throughput label
        e.files = prFiles; // the title/body may have been edited to name the failing check: re-read it
        e.text = prText;
        this.persistQueue();
        this.pump(); // a renamed PR may now be a repair candidate
        return { ok: true, status: 'already-queued', position: pendingIdx, ...this.holdFor(pr) };
      }
      // A new head abandons any peer attempt for the old one (its result can no longer be imported).
      if (e.remote) this.abandonRemote(e, 'head-moved', { failure: false, cancel: true });
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
    if (exec && exec.preflight?.reason !== 'preflight-red' && !(opts.force && exec.outcome === 'failure') && !(existing && existing.outcome === 'failure' && exec === existing)) {
      const derived = this.complete({ ...exec, pr, baseRefName }, 'derived');
      if (derived) return { ok: true, status: 'recorded', record: derived };
    }

    // A pushed head re-queued in its kept place replaces an entry that was already admitted:
    // it is never refused for capacity (it would otherwise lose its place while the overflow is in use).
    if (!keptPlace && this.prQueueLength() >= LOCAL_VERIFY_LIMITS.queueCap) {
      // A queue full of HELD entries must not refuse the repair that would release them: a
      // repair candidate is admitted past the cap while the hold is active. There is no
      // second cap: candidates past it are bounded only by the open PRs that touch, name
      // or revert the failing check, and each one is audited below.
      const hold = this.holdDecision();
      const repair = hold.active && repairVerdict({ files: prFiles, text: prText }, hold.failingFiles).candidate;
      // A merge-throughput PR gets a bounded overflow (LOCAL_VERIFY_LIMITS.throughputOverflow).
      const throughput = !replayPriority && !repair && requestedPriority === QUEUE_PRIORITY.mergeThroughput
        && this.prQueueLength() < capFor(QUEUE_PRIORITY.mergeThroughput);
      if (!repair && !throughput) {
        this.audit({ event: 'queue-full', pr, ...(hold.active ? { mainRedHold: true } : {}) });
        return { ok: false, code: 'queue-full' };
      }
      if (repair) this.audit({ event: 'queue-full-repair-admitted', pr, headSha, redHead: hold.active ? hold.redHead : null });
      else this.audit({ event: 'queue-full-throughput-admitted', pr, headSha });
    }
    const entry: QueueEntry = {
      id: crypto.randomBytes(6).toString('hex'), pr, headSha, baseSha, baseRefName,
      ...(!explicit ? { preflightRediscoverable: true } : {}),
      firstQueuedAt: keptPlace?.firstQueuedAt ?? this.now(), attempts: 0, errorRetries: 0,
      starvedRaised: keptPlace?.starvedRaised ?? false, priority: requestedPriority, baseResolvedAt: this.now(),
      files: prFiles, text: prText,
      ...(keptPlace?.pausedMs ? { pausedMs: keptPlace.pausedMs } : {}),
      ...(keptPlace?.resumeFirst ? { resumeFirst: true as const } : {}),
    };
    if (keptPlace && keptPlace.index < this.queue.length) this.queue.splice(keptPlace.index, 0, entry);
    else this.queue.push(entry);
    this.audit({ event: 'queued', pr, headSha, baseSha, explicit, ...(keptPlace ? { keptPlace: true, firstQueuedAt: entry.firstQueuedAt } : {}) });
    const position = this.queue.indexOf(entry);
    this.pump();
    return { ok: true, status: 'queued', position, ...this.holdFor(pr) };
  }

  /** `{ hold }` for a POST answer when the main-red hold is holding THIS pr; `{}` otherwise. */
  private holdFor(pr: number): { hold?: MainRedHoldInfo } {
    const d = this.holdDecision();
    if (!d.active || !d.heldPrs.some((h) => h.pr === pr)) return {};
    return { hold: this.holdInfo(d) };
  }

  // ---- peer verifiers (spec local-verify-capacity.md Part D) ----

  /** Wire the peer settings (read at each use) and the coordinator's client and lease view. */
  setPeerWiring(o: {
    peerRoleEnabled?: (() => boolean) | null;
    peers?: (() => unknown) | null;
    client?: PeerClient | null;
    lease?: { holdsLease(): boolean; leaseEpoch(): number | null; holderMachineId(): string | null } | null;
  }): void {
    if (o.peerRoleEnabled !== undefined) this.peerRoleEnabled = o.peerRoleEnabled;
    if (o.peers !== undefined) this.peersSetting = o.peers;
    if (o.client !== undefined) this.peerClient = o.client;
    if (o.lease !== undefined) this.leaseView = o.lease;
  }

  isPeerOnly(): boolean { return this.cfg.peerOnly === true; }

  private peerRoleOn(): boolean {
    try { return this.peerRoleEnabled ? this.peerRoleEnabled() === true : false; } catch { return false; } // @silent-fallback-ok: an unreadable switch reads as off (no peer runs)
  }

  private configuredPeers(): PeerTarget[] {
    if (this.cfg.peerOnly) return [];
    let v: unknown = null;
    try { v = this.peersSetting ? this.peersSetting() : null; } catch { v = null; } // @silent-fallback-ok: an unreadable setting means no peers (local only)
    return parsePeers(v, this.cfg.machineId);
  }

  private leaseState(): { holds: boolean; epoch: number | null; holder: string | null } {
    if (!this.leaseView) return { holds: true, epoch: null, holder: this.cfg.machineId };
    try {
      return { holds: this.leaseView.holdsLease(), epoch: this.leaseView.leaseEpoch(), holder: this.leaseView.holderMachineId() };
    } catch {
      return { holds: false, epoch: null, holder: null }; // @silent-fallback-ok: an unreadable lease reads as not held (no dispatch, no import)
    }
  }

  private get peerStatePath(): string { return path.join(this.lvStateDir, 'peer-attempts.json'); }

  private loadPeerState(): void {
    try {
      const o = JSON.parse(fs.readFileSync(this.peerStatePath, 'utf-8')) as PeerAttemptState;
      this.peerState = {
        current: o.current && typeof o.current.attemptId === 'string' ? o.current : null,
        results: Array.isArray(o.results) ? o.results.slice(-PEER_RESULTS_KEPT) : [],
        tombstones: o.tombstones && typeof o.tombstones === 'object' ? o.tombstones : {},
      };
    } catch {
      this.peerState = { current: null, results: [], tombstones: {} }; // @silent-fallback-ok: no peer state yet (first boot)
    }
    // A run interrupted by the restart is gone (its child was reaped): its id is tombstoned so
    // the coordinator's `unknown` reclaim is final and a delayed peer-run for it is refused.
    if (this.peerState.current && this.peerState.current.state === 'running') {
      this.peerState.tombstones[this.peerState.current.attemptId] = this.now();
      this.audit({ event: 'peer-attempt-interrupted', attemptId: this.peerState.current.attemptId, pr: this.peerState.current.pr });
      this.peerState.current = null;
    }
    this.persistPeerState();
  }

  private persistPeerState(): boolean {
    const now = this.now();
    for (const [id, at] of Object.entries(this.peerState.tombstones)) {
      if (now - at > PEER_LIMITS.tombstoneMs) delete this.peerState.tombstones[id];
    }
    try {
      fs.mkdirSync(this.lvStateDir, { recursive: true });
      const tmp = this.peerStatePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.peerState), { mode: 0o600 }); /* state-registry: local-verify-peer-attempts */
      fs.renameSync(tmp, this.peerStatePath);
      return true;
    } catch (e) {
      this.audit({ event: 'peer-state-write-failed', detail: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }

  /** Peer side: `POST /local-verify/peer-run`. Idempotent per attemptId. */
  async peerRun(req: PeerRunRequest, ctx: { holdsLease: boolean; holderMachineId: string | null }): Promise<PeerRunAnswer> {
    const refuse = (reason: Extract<PeerRunAnswer, { ok: false }>['reason']): PeerRunAnswer => {
      this.audit({ event: 'peer-run-refused', attemptId: req.attemptId, pr: req.pr, reason });
      return { ok: false, reason };
    };
    if (!this.peerRoleOn() || this.stopped) return refuse('peer-disabled');
    if (ctx.holdsLease) return refuse('is-lease-holder');
    if (!ctx.holderMachineId || req.coordinatorMachineId !== ctx.holderMachineId) return refuse('not-coordinator');
    if (this.peerState.tombstones[req.attemptId] !== undefined) return refuse('attempt-cancelled');
    if (this.peerState.current?.attemptId === req.attemptId || this.peerState.results.some((r) => r.attemptId === req.attemptId)) {
      return { ok: true, attemptId: req.attemptId };
    }
    if (this.failedFileDiagnosisPeer?.busy() && !await this.failedFileDiagnosisPeer.preempt('peer-full-verify')) return refuse('peer-busy');
    const busy = () => !!this.inFlight || !!this.starting || this.peerState.current?.state === 'running' || this.seams.foreignSuiteHolders().length > 0 || !!this.blockedBy;
    if (busy()) return refuse('peer-busy');
    // A pending update waiting on this verifier must not gain a new restart hold.
    // Treat it as backpressure so the coordinator can offer the PR again later.
    if (this.notePause()) return refuse('peer-busy');
    if (req.verifierVersion !== this.cfg.verifierVersion || req.policyHash !== this.policyHash || this.verifierChangedOnDisk()) return refuse('verifier-mismatch');
    const view = await this.seams.prView(req.pr).catch(() => null);
    if (!view) return refuse('pr-unreadable');
    if (!checkEligibility(view, this.cfg).eligible) return refuse('untrusted-head');
    if (view.headRefOid !== req.headSha || view.baseRefName !== req.baseRefName) return refuse('head-moved');
    // The read awaited: re-check everything that could have changed meanwhile, the role and the
    // lease included (live, not the request-time snapshot).
    if (!this.peerRoleOn() || this.stopped) return refuse('peer-disabled');
    const live = this.leaseState();
    if (this.leaseView && live.holds) return refuse('is-lease-holder');
    if (this.leaseView && (live.holder !== req.coordinatorMachineId || live.epoch !== req.leaseEpoch)) return refuse('not-coordinator');
    if (this.peerState.tombstones[req.attemptId] !== undefined) return refuse('attempt-cancelled');
    if (this.peerState.current?.attemptId === req.attemptId) return { ok: true, attemptId: req.attemptId };
    // A diagnostic may have been admitted while the PR read was in flight.
    // Reclaim it before this full verify records intent or starts its child.
    if (this.failedFileDiagnosisPeer?.busy() && !await this.failedFileDiagnosisPeer.preempt('peer-full-verify')) return refuse('peer-busy');
    if (!this.peerRoleOn() || this.stopped) return refuse('peer-disabled');
    const leaseAfterPreempt = this.leaseState();
    if (this.leaseView && leaseAfterPreempt.holds) return refuse('is-lease-holder');
    if (this.leaseView && (leaseAfterPreempt.holder !== req.coordinatorMachineId || leaseAfterPreempt.epoch !== req.leaseEpoch)) return refuse('not-coordinator');
    if (this.peerState.tombstones[req.attemptId] !== undefined) return refuse('attempt-cancelled');
    if (this.failedFileDiagnosisPeer?.busy()) return refuse('peer-busy');
    if (busy()) return refuse('peer-busy');
    if (this.notePause()) return refuse('peer-busy');
    if (this.verifierChangedOnDisk()) return refuse('verifier-mismatch');
    const entry: QueueEntry = {
      id: crypto.randomBytes(6).toString('hex'), pr: req.pr, headSha: req.headSha, baseSha: req.baseSha, baseRefName: req.baseRefName,
      firstQueuedAt: this.now(), attempts: 0, errorRetries: 0, starvedRaised: false, priority: QUEUE_PRIORITY.ordinary,
      peerAttempt: { id: req.attemptId, coordinatorMachineId: req.coordinatorMachineId, leaseEpoch: req.leaseEpoch },
      ...(req.preflightRediscoverable === true ? { preflightRediscoverable: true } : {}),
      ...(req.isolation ? { peerIsolation: req.isolation } : {}),
    };
    this.peerState.current = { attemptId: req.attemptId, pr: req.pr, headSha: req.headSha, state: 'running', acceptedAt: this.now() };
    if (!this.persistPeerState()) {
      // Without the durable record a restart could not tombstone this attempt: never start it.
      this.peerState.current = null;
      return refuse('state-unwritable');
    }
    this.audit({ event: 'peer-run-accepted', attemptId: req.attemptId, pr: req.pr, headSha: req.headSha, baseSha: req.baseSha, coordinator: req.coordinatorMachineId });
    try {
      this.start(entry);
    } catch (e) {
      if (this.inFlight?.entry === entry) {
        // The child exists: keep its durable intent and exit handler until it dies.
        // Clearing either here would leave an untracked verifier running.
        this.audit({ event: 'peer-run-setup-failed-after-spawn', attemptId: req.attemptId, pr: req.pr, detail: e instanceof Error ? e.message : String(e) });
        this.cancelInFlight('peer-run-setup-failed');
        return { ok: true, attemptId: req.attemptId };
      }
      // A setup failure before the child exists (runs dir, input file, in-flight intent): the
      // attempt ends now with an error record instead of looking busy until the run bound.
      try { this.clearInFlight(); } catch { /* @silent-fallback-ok: nothing was written */ }
      if (this.inFlight?.entry === entry) this.inFlight = null;
      this.audit({ event: 'peer-run-setup-failed', attemptId: req.attemptId, pr: req.pr, detail: e instanceof Error ? e.message : String(e) });
      this.finishPeerAttempt({ entry, cancelled: false }, { kind: 'crash' });
    }
    return { ok: true, attemptId: req.attemptId };
  }

  /** Peer side: `GET /local-verify/peer-status`. */
  peerStatus(): PeerStatus & { enabled: boolean } {
    const cur = this.peerState.current;
    return {
      enabled: this.peerRoleOn(),
      inFlight: cur && cur.state === 'running' ? { attemptId: cur.attemptId, pr: cur.pr } : null,
      verifierVersion: this.cfg.verifierVersion,
      policyHash: this.policyHash,
      slotBusy: !!this.inFlight || !!this.starting || this.seams.foreignSuiteHolders().length > 0 || this.notePause(),
    };
  }

  /** Peer side: `GET /local-verify/peer-result`. */
  peerResult(attemptId: string): PeerResult {
    const cur = this.peerState.current;
    if (cur && cur.attemptId === attemptId) return cur.state === 'done' && cur.record ? { state: 'done', record: cur.record } : { state: 'running' };
    const done = this.peerState.results.find((r) => r.attemptId === attemptId);
    return done ? { state: 'done', record: done.record } : { state: 'unknown' };
  }

  /** Peer side: `POST /local-verify/peer-cancel`. Tombstones the id; cancels it if it is running. */
  peerCancel(attemptId: string): { cancelled: boolean } {
    this.peerState.tombstones[attemptId] = this.now();
    const running = this.inFlight && this.inFlight.entry.peerAttempt?.id === attemptId;
    if (running) this.cancelInFlight('peer-cancel');
    if (this.peerState.current?.attemptId === attemptId && this.peerState.current.state === 'running') this.peerState.current = null;
    this.persistPeerState();
    this.audit({ event: 'peer-attempt-cancelled', attemptId, wasRunning: !!running });
    return { cancelled: !!running };
  }

  /**
   * Peer side, every tick: a running peer attempt is cancelled (tombstoned) when it outlives
   * PEER_LIMITS.maxRunMs, when the peer role is switched off, or when this machine has become the
   * lease holder (peer attempts are never promoted into a coordinator's own authority).
   */
  private checkPeerAttempt(): void {
    const cur = this.peerState.current;
    if (!cur || cur.state !== 'running') return;
    const lease = this.leaseState();
    const why = this.now() - cur.acceptedAt > PEER_LIMITS.maxRunMs ? 'run-bound'
      : !this.peerRoleOn() ? 'peer-disabled'
        : this.leaseView && lease.holds ? 'became-lease-holder' : null;
    if (!why) return;
    this.audit({ event: 'peer-attempt-self-cancelled', attemptId: cur.attemptId, pr: cur.pr, reason: why });
    this.peerCancel(cur.attemptId);
  }

  /** Peer side: a peer run ended. Its record is kept for the coordinator, never put in this machine's index. */
  private finishPeerAttempt(f: Pick<InFlight, 'entry' | 'cancelled'>, result: VerifyRunResult | null | { kind: 'crash' | 'invalid' } | unknown): void {
    const id = f.entry.peerAttempt!.id;
    const cur = this.peerState.current;
    if (f.cancelled || this.peerState.tombstones[id] !== undefined || !cur || cur.attemptId !== id) {
      this.peerState.tombstones[id] = this.peerState.tombstones[id] ?? this.now();
      if (cur && cur.attemptId === id) this.peerState.current = null;
      this.persistPeerState();
      this.audit({ event: 'peer-attempt-dropped', attemptId: id, pr: f.entry.pr });
      return;
    }
    const r = result as { kind?: string; record?: LocalVerifyRecord } | null;
    let record: LocalVerifyRecord;
    if (r && r.kind === 'record' && r.record && validateRecord(r.record).ok) {
      record = r.record;
    } else {
      // Anything else (crash, invalid record, a capacity requeue, a verifier mismatch) is an
      // infrastructure error for this attempt: the coordinator counts it and runs the PR again.
      record = { ...this.syntheticError(f.entry, r && typeof r.kind === 'string' ? `peer-${r.kind}` : 'peer-crash'), attempt: f.entry.peerAttempt };
    }
    cur.state = 'done';
    cur.record = record;
    this.peerState.results = [...this.peerState.results.filter((x) => x.attemptId !== id), { attemptId: id, record }].slice(-PEER_RESULTS_KEPT);
    this.persistPeerState();
    this.audit({ event: 'peer-attempt-done', attemptId: id, pr: record.pr, outcome: record.outcome });
  }

  /** Coordinator: after any pump, try to hand one more entry to an idle peer (never blocks the pump). */
  private scheduleDispatch(): void {
    if (this.dispatchScheduled || this.cfg.peerOnly || !this.peerClient) return;
    this.dispatchScheduled = true;
    const run = () => { this.dispatchScheduled = false; void this.dispatchOnce().catch((e) => this.audit({ event: 'peer-dispatch-error', detail: e instanceof Error ? e.message : String(e) })); };
    if (this.seams.setTimer) this.seams.setTimer(run, 0); else setImmediate(run);
  }

  private dispatchable(e: QueueEntry, heldPrs: Set<number>): boolean {
    // The replay marker is coordinator-owned and changes state at local child
    // start. Keep these entries local until peer handoff carries that authority.
    if (this.preflightReplays?.get(replayKey({ repo: this.cfg.repo, ...e, policyHash: this.policyHash }))) return false;
    // A contained preflight error must reach a fresh full-only local attempt;
    // the peer request protocol has no preflight-bypass field.
    if (e.preflightBypassRetry) return false;
    return e.kind !== 'main' && !e.remote && !e.peerAttempt && e !== this.dispatching && e !== this.starting && this.inFlight?.entry !== e
      && !heldPrs.has(e.pr) && (e.remoteAttempts ?? 0) < PEER_LIMITS.maxAttemptsPerEntry && !(e.notBefore && e.notBefore > this.now());
  }

  /* @self-action-controller: local-verify-peer-dispatch */
  private async dispatchOnce(): Promise<void> {
    if (this.dispatchRunning) return;
    const peers = this.configuredPeers();
    const client = this.peerClient;
    if (!client || peers.length === 0) return;
    if (this.stopped || this.restoring || this.blockedBy || this.mergeHold || this.verifierHold) return;
    if (this.notePause() || this.verifierChangedOnDisk()) return;
    // The pump has already given the local slot its first chance before this
    // scheduled dispatch runs. If another suite holds that slot, an idle peer
    // can take a queued PR without a local verifier already in flight.
    const lease = this.leaseState();
    if (!lease.holds) return;
    this.dispatchRunning = true;
    try {
      const now = this.now();
      for (const peer of peers) {
        const h = this.peerHealth.get(peer.machineId) ?? { consecutiveFailures: 0, openUntil: null, status: null, statusAt: 0 };
        this.peerHealth.set(peer.machineId, h);
        if (!peerHealthy(h, now)) continue;
        if (this.queue.some((e) => e.remote?.machineId === peer.machineId)) continue; // one outstanding attempt per peer
        if (now - h.statusAt >= PEER_LIMITS.statusMs || !h.status) {
          const st = await client.status(peer).catch(() => null);
          h.statusAt = this.now();
          h.status = st;
          if (!st) { this.peerFailure(peer, h, 'status-unreachable'); continue; }
        }
        const st = h.status;
        if (!st || st.inFlight || st.slotBusy || st.verifierVersion !== this.cfg.verifierVersion || st.policyHash !== this.policyHash) continue;
        const hold = this.holdDecision();
        const held = new Set(hold.active ? hold.heldPrs.map((x) => x.pr) : []);
        const sorted = [...this.queue].sort((a, b) => effectivePriority(b, this.now()) - effectivePriority(a, this.now()));
        const entry = sorted.find((e) => this.dispatchable(e, held));
        if (!entry) return;
        // Today's base first: the same conditional refresh a local start uses.
        if (decideBaseRefresh(entry, { now: this.now(), mainMovedAt: this.mainMovedAt })) {
          this.dispatching = entry;
          const [fresh, open] = await Promise.all([
            this.seams.baseHead ? this.seams.baseHead(entry.baseRefName).catch(() => null) : Promise.resolve(null),
            this.seams.isPrOpen(entry.pr).catch(() => null),
          ]);
          this.dispatching = null;
          if (!this.queue.includes(entry)) continue;
          if (open === false) {
            this.queue.splice(this.queue.indexOf(entry), 1);
            this.audit({ event: 'dequeued', pr: entry.pr, reason: 'closed', headSha: entry.headSha });
            this.persistQueue();
            this.reconcileSuitePriority();
            continue;
          }
          if (this.seams.baseHead) {
            if (fresh && isValidSha(fresh)) {
              if (fresh !== entry.baseSha) { this.audit({ event: 'base-refreshed', pr: entry.pr, headSha: entry.headSha, oldBase: entry.baseSha, newBase: fresh }); entry.baseSha = fresh; }
            } else {
              this.audit({ event: 'base-refresh-failed', pr: entry.pr, headSha: entry.headSha, baseSha: entry.baseSha });
            }
          }
          entry.baseResolvedAt = this.now();
        }
        // Re-check after the await: still queued, unreserved, unheld, dispatchable; peer still free; lease still ours.
        const lease2 = this.leaseState();
        const hold2 = this.holdDecision();
        const held2 = new Set(hold2.active ? hold2.heldPrs.map((x) => x.pr) : []);
        if (!this.queue.includes(entry) || !this.dispatchable(entry, held2) || !lease2.holds || lease2.epoch !== lease.epoch) continue;
        // The scheduling holds again too: a merge hand-off (or anything else that holds the queue)
        // that began during the awaits means the next verify must wait for it, remote or local.
        if (this.stopped || this.restoring || this.blockedBy || this.mergeHold || this.verifierHold) return;
        if (this.notePause() || this.verifierChangedOnDisk()) return;
        if (this.queue.some((e) => e.remote?.machineId === peer.machineId) || this.stopped) continue;
        const marker: RemoteMarker = {
          machineId: peer.machineId, attemptId: crypto.randomBytes(16).toString('hex'), leaseEpoch: lease.epoch,
          sentAt: this.now(), state: 'sending',
          dispatched: { pr: entry.pr, headSha: entry.headSha, baseSha: entry.baseSha, baseRefName: entry.baseRefName, verifierVersion: this.cfg.verifierVersion, policyHash: this.policyHash },
        };
        entry.remote = marker;
        entry.remoteAttempts = (entry.remoteAttempts ?? 0) + 1;
        if (!this.persistQueue()) { // durable intent BEFORE the send, or no send at all
          entry.remote = undefined;
          entry.remoteAttempts -= 1;
          this.audit({ event: 'peer-dispatch-skipped', pr: entry.pr, reason: 'queue-unwritable' });
          return;
        }
        // The reserved PR no longer needs Studio's next suite slot. Retire a
        // stale claim now, without waiting for the next coordinator tick.
        this.reconcileSuitePriority();
        this.audit({ event: 'peer-dispatch', pr: entry.pr, headSha: entry.headSha, baseSha: entry.baseSha, peer: peer.machineId, attemptId: marker.attemptId, attempt: entry.remoteAttempts });
        const iso = this.isolationInput();
        const ans = await client.run(peer, {
          attemptId: marker.attemptId, ...marker.dispatched, coordinatorMachineId: this.cfg.machineId, leaseEpoch: marker.leaseEpoch,
          isolation: { allowed: iso.allowed, notCleanOnGreenMain: [...iso.notCleanOnGreenMain] },
          ...(entry.preflightRediscoverable === true ? { preflightRediscoverable: true } : {}),
        }).catch(() => null);
        if (entry.remote !== marker) continue; // abandoned meanwhile
        if (ans === null) {
          this.audit({ event: 'peer-dispatch-unanswered', pr: entry.pr, peer: peer.machineId, attemptId: marker.attemptId });
        } else if (ans.ok) {
          marker.state = 'accepted';
          this.audit({ event: 'peer-dispatch-accepted', pr: entry.pr, peer: peer.machineId, attemptId: marker.attemptId });
        } else if (ans.reason === 'peer-busy') {
          // Backpressure, not a failure: the attempt does not count and the breaker is untouched.
          entry.remote = undefined;
          entry.remoteAttempts = Math.max(0, (entry.remoteAttempts ?? 1) - 1);
          h.statusAt = 0;
          this.audit({ event: 'peer-dispatch-busy', pr: entry.pr, peer: peer.machineId });
        } else {
          entry.remote = undefined;
          this.audit({ event: 'peer-dispatch-refused', pr: entry.pr, peer: peer.machineId, attemptId: marker.attemptId, reason: ans.reason });
          this.peerFailure(peer, h, `refused:${ans.reason}`);
        }
        this.persistQueue();
        this.reconcileSuitePriority();
      }
    } finally {
      this.dispatchRunning = false;
    }
  }

  private peerFailure(peer: PeerTarget, h: PeerHealth, why: string): void {
    if (noteFailure(h, this.now())) {
      this.audit({ event: 'peer-breaker-open', peer: peer.machineId, why, untilMs: h.openUntil });
      this.seams.signal?.(`local-verify:peer-breaker:${peer.machineId}`, {
        peer: peer.machineId, why, until: h.openUntil ? new Date(h.openUntil).toISOString() : null,
        note: `The peer verifier ${peer.machineId} failed ${PEER_LIMITS.breakerFailures} times in a row (last: ${why}); this machine runs every verify itself for the next ${Math.round(PEER_LIMITS.breakerOpenMs / 60_000)} minutes.`,
      });
    }
  }

  /** Coordinator: drop a reservation. `count` = the attempt was spent; `failure` = it counts toward the peer's breaker. */
  private abandonRemote(entry: QueueEntry, reason: string, o: { failure: boolean; cancel: boolean }): void {
    const m = entry.remote;
    if (!m) return;
    entry.remote = undefined;
    this.remotePolledAt.delete(m.attemptId);
    this.audit({ event: 'peer-attempt-abandoned', pr: entry.pr, peer: m.machineId, attemptId: m.attemptId, reason });
    const peer = this.configuredPeers().find((p) => p.machineId === m.machineId);
    if (o.cancel && peer && this.peerClient) void this.peerClient.cancel(peer, m.attemptId).catch(() => undefined);
    if (o.failure && peer) {
      const h = this.peerHealth.get(peer.machineId) ?? { consecutiveFailures: 0, openUntil: null, status: null, statusAt: 0 };
      this.peerHealth.set(peer.machineId, h);
      this.peerFailure(peer, h, reason);
    }
    this.persistQueue();
  }

  /* @self-action-controller: local-verify-peer-poll */
  /** Coordinator: poll each reserved entry's attempt (bounded rate) and import, reclaim or abandon. */
  private async pollPeers(): Promise<void> {
    if (this.pollRunning || this.cfg.peerOnly) return;
    const reserved = this.queue.filter((e) => e.remote);
    if (reserved.length === 0) return;
    this.pollRunning = true;
    try {
      for (const entry of reserved) {
        const m = entry.remote;
        if (!m) continue;
        const now = this.now();
        const lease = this.leaseState();
        if (!lease.holds || lease.epoch !== m.leaseEpoch) { this.abandonRemote(entry, 'lease-changed', { failure: false, cancel: true }); continue; }
        const peer = this.configuredPeers().find((p) => p.machineId === m.machineId);
        if (!peer || !this.peerClient) { this.abandonRemote(entry, 'peer-not-configured', { failure: false, cancel: false }); continue; }
        if (now - (this.remotePolledAt.get(m.attemptId) ?? 0) < PEER_LIMITS.pollMs) continue;
        this.remotePolledAt.set(m.attemptId, now);
        const res = await this.peerClient.result(peer, m.attemptId).catch(() => null);
        if (entry.remote !== m) continue; // changed while we waited
        if (!this.queue.includes(entry)) {
          this.abandonRemote(entry, 'entry-no-longer-queued', { failure: false, cancel: true });
          continue;
        }
        const age = this.now() - m.sentAt;
        const h = this.peerHealth.get(peer.machineId) ?? { consecutiveFailures: 0, openUntil: null, status: null, statusAt: 0 };
        this.peerHealth.set(peer.machineId, h);
        if (res === null) {
          if (age > PEER_LIMITS.maxRunMs) this.abandonRemote(entry, 'unreachable-past-run-bound', { failure: true, cancel: true });
          else this.peerFailure(peer, h, 'result-unreachable');
          continue;
        }
        if (res.state === 'unknown') {
          if (age > PEER_LIMITS.unknownGraceMs) this.abandonRemote(entry, 'unknown-attempt', { failure: true, cancel: true });
          continue;
        }
        if (res.state === 'running') {
          if (age > PEER_LIMITS.maxRunMs) this.abandonRemote(entry, 'run-bound', { failure: true, cancel: true });
          else if (m.state === 'sending') { m.state = 'accepted'; this.persistQueue(); }
          continue;
        }
        // The lease is read again NOW (the result fetch awaited): a lease lost or moved meanwhile imports nothing.
        const leaseNow = this.leaseState();
        const why = importRefusal(res.record, m, { repo: this.cfg.repo, verifierVersion: this.cfg.verifierVersion, policyHash: this.policyHash, holdsLease: leaseNow.holds, leaseEpoch: leaseNow.epoch, coordinatorMachineId: this.cfg.machineId });
        if (why) {
          this.audit({ event: 'peer-record-rejected', pr: entry.pr, peer: peer.machineId, attemptId: m.attemptId, reason: why });
          this.abandonRemote(entry, `rejected:${why}`, { failure: true, cancel: false });
          continue;
        }
        if (res.record.outcome === 'error') {
          this.audit({ event: 'peer-record-error', pr: entry.pr, peer: peer.machineId, attemptId: m.attemptId, errorStep: res.record.errorStep });
          if (this.preflightErrorNeedsBypass(res.record.errorStep)) entry.preflightBypassRetry = true;
          this.abandonRemote(entry, 'peer-error', { failure: true, cancel: false });
          continue;
        }
        // Import: the one completion path, then the entry leaves the queue.
        noteSuccess(h);
        entry.remote = undefined;
        this.remotePolledAt.delete(m.attemptId);
        const i = this.queue.indexOf(entry);
        if (i >= 0) this.queue.splice(i, 1);
        this.audit({ event: 'peer-imported', pr: entry.pr, peer: peer.machineId, attemptId: m.attemptId, outcome: res.record.outcome });
        const imported = this.complete(res.record, 'peer');
        if (imported) this.noteFlaky(imported);
        this.persistQueue();
      }
    } finally {
      this.pollRunning = false;
    }
    this.pump();
  }

  /** Coordinator view of the peers for `GET /local-verify`. */
  peersInfo(): { configured: Array<{ machineId: string; healthy: boolean; status: PeerStatus | null; consecutiveFailures: number; openUntil: string | null }>; reserved: Array<{ pr: number; peer: string; attemptId: string; state: string; sentAt: string }> } {
    const now = this.now();
    return {
      configured: this.configuredPeers().map((p) => {
        const h = this.peerHealth.get(p.machineId);
        return { machineId: p.machineId, healthy: peerHealthy(h, now), status: h?.status ?? null, consecutiveFailures: h?.consecutiveFailures ?? 0, openUntil: h?.openUntil ? new Date(h.openUntil).toISOString() : null };
      }),
      reserved: this.queue.filter((e) => e.remote).map((e) => ({ pr: e.pr, peer: e.remote!.machineId, attemptId: e.remote!.attemptId, state: e.remote!.state, sentAt: new Date(e.remote!.sentAt).toISOString() })),
    };
  }

  /** Periodic driver: orphan unblock, starvation signal, start the next run. */
  async tick(): Promise<void> {
    if (this.blockedBy) await this.reapOrphan();
    if (this.verifierHold) this.recheckVerifierHold();
    this.notePause();
    this.checkStarved();
    this.health.noteUnverifiedAge(this.mainObs.oldestUnverifiedAt);
    if (!this.cfg.peerOnly) await this.pollPeers().catch((e) => this.audit({ event: 'peer-poll-error', detail: e instanceof Error ? e.message : String(e) }));
    if (!this.cfg.peerOnly) await this.sweepReplayCapacity();
    this.checkPeerAttempt();
    await this.failedFileDiagnosisPeer?.tick();
    this.pump();
    if (!this.cfg.peerOnly) await this.failedFileDiagnosis?.tick([...this.index.values()]);
  }

  /** Bounded reclamation when terminal keys fill the store; unknown PR state retains proof. */
  private async sweepReplayCapacity(): Promise<void> {
    const store = this.preflightReplays;
    const now = this.now();
    if (!store || store.hasCapacityForNew() || !this.leaseState().holds
      || now - this.replayCapacitySweepAt < 5 * 60_000) return;
    this.replayCapacitySweepAt = now;
    const completed = store.list().filter((r) => r.state === 'completed');
    if (!completed.length) return;
    const count = Math.min(5, completed.length);
    const start = this.replayCapacitySweepCursor % completed.length;
    this.replayCapacitySweepCursor = (start + count) % completed.length;
    for (let n = 0; n < count; n++) {
      if (this.stopped || !this.leaseState().holds) return;
      const marker = completed[(start + n) % completed.length];
      const [view, open] = await Promise.all([
        this.seams.prView(marker.pr).catch(() => null),
        this.seams.isPrOpen(marker.pr).catch(() => null),
      ]);
      if (open === false || view && (view.headRefOid !== marker.headSha || view.baseRefName !== marker.baseRefName)) {
        try { store.cancel(marker.key); }
        catch (e) { this.audit({ event: 'preflight-replay-capacity-sweep-error', pr: marker.pr, detail: String(e) }); continue; }
        this.audit({ event: 'preflight-replay-capacity-reclaimed', pr: marker.pr, reason: open === false ? 'closed' : 'head-or-target-moved' });
      }
    }
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
    void this.failedFileDiagnosisPeer?.preempt('shutdown');
    this.publishSuitePriority(false);
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

  private wakeReplayAt(at: number): void {
    if (this.stopped || this.replayWakeAt && this.replayWakeAt <= at) return;
    this.replayWakeAt = at;
    const run = () => {
      if (this.replayWakeAt !== at) return;
      this.replayWakeAt = 0;
      this.scheduleReplayAdmission();
    };
    const delay = Math.max(1, at - this.now());
    if (this.seams.setTimer) this.seams.setTimer(run, delay);
    else { const timer = setTimeout(run, delay); timer.unref?.(); }
  }

  /** Persisted, ordinary-priority replay admission; every read is of the current PR. */
  private scheduleReplayAdmission(): void {
    if (this.replayAdmissionRunning || this.stopped || this.cfg.peerOnly || !this.preflightReplays || !this.leaseState().holds) return;
    const due = this.preflightReplays.list().some((r) => r.state === 'pending' || r.state === 'retryable-error');
    if (!due) return;
    this.replayAdmissionRunning = true;
    const run = () => { void this.admitReplays()
      .catch((e) => this.audit({ event: 'preflight-replay-admission-error', detail: String(e) }))
      .finally(() => { this.replayAdmissionRunning = false; }); };
    if (this.seams.setTimer) this.seams.setTimer(run, 0); else setImmediate(run);
  }

  private async admitReplays(): Promise<void> {
    const store = this.preflightReplays;
    if (!store) return;
    for (const marker of store.list()) {
      if (this.stopped || !this.leaseState().holds) return;
      if (marker.state !== 'pending' && marker.state !== 'retryable-error') continue;
      const current = store.blockIfExpired(marker.key, this.now());
      if (current?.state === 'blocked') {
        this.audit({ event: 'preflight-replay-blocked', pr: marker.pr, reason: current.blockedReason });
        continue;
      }
      const indexed = this.index.get(recordKey(marker.repo, marker.pr, marker.headSha, marker.baseRefName));
      if (indexed && indexed.outcome !== 'error' && indexed.preflight?.reason !== 'preflight-red') {
        store.completeFromJournal(marker.key, this.now());
        continue;
      }
      const same = (e: QueueEntry) => e.pr === marker.pr && e.headSha === marker.headSha && e.baseRefName === marker.baseRefName;
      if (this.queue.some(same) || this.inFlight && same(this.inFlight.entry)) continue;
      if (this.now() < marker.nextAdmissionAt) { this.wakeReplayAt(marker.nextAdmissionAt); continue; }
      const [view, open] = await Promise.all([this.seams.prView(marker.pr).catch(() => null), this.seams.isPrOpen(marker.pr).catch(() => null)]);
      if (open === false || view && (view.headRefOid !== marker.headSha || view.baseRefName !== marker.baseRefName)) {
        store.cancel(marker.key);
        this.audit({ event: 'preflight-replay-cancelled', pr: marker.pr, reason: open === false ? 'closed' : 'head-or-target-moved' });
        continue;
      }
      if (!view || open === null) {
        const next = store.admissionFailed(marker.key, this.now(), 'pr-unreadable');
        if (next.state !== 'blocked') this.wakeReplayAt(next.nextAdmissionAt);
        continue;
      }
      const result = await this.request(marker.pr, { explicit: true, force: true, replay: true });
      if (result.ok && (result.status === 'queued' || result.status === 'already-queued' || result.status === 'in-flight')) {
        this.audit({ event: 'preflight-replay-admitted', pr: marker.pr, headSha: marker.headSha, status: result.status });
        continue;
      }
      if (result.ok && result.status === 'recorded' && result.record.preflight?.reason !== 'preflight-red') {
        store.completeFromJournal(marker.key, this.now());
        continue;
      }
      const next = store.admissionFailed(marker.key, this.now(), result.ok ? result.status : result.code);
      this.audit({ event: 'preflight-replay-admission-wait', pr: marker.pr, reason: result.ok ? result.status : result.code, attempt: next.admissionAttempts, state: next.state });
      if (next.state !== 'blocked') this.wakeReplayAt(next.nextAdmissionAt);
    }
  }

  private pump(): void {
    this.persistQueue();
    this.scheduleReplayAdmission();
    if (this.inFlight && !this.inFlight.suiteSlotAcquired &&
        this.seams.foreignSuiteHolders().some((h) => h.pid === this.inFlight!.pgid)) {
      // The child's own holder is an acknowledgement that it has the suite
      // slot. Retire the service claim so cap>1 can use spare capacity.
      this.inFlight.suiteSlotAcquired = true;
    }
    if (this.cfg.peerOnly) {
      // A peer verify also prepares before acquiring its suite slot.
      this.publishSuitePriority(!this.stopped && !!this.inFlight && !this.inFlight.cancelled && !this.inFlight.suiteSlotAcquired);
      return;
    } // a peer-only service never starts its own queued work
    this.scheduleDispatch();
    // Keep renewing the reservation through child preparation. Releasing it at
    // spawn let ad-hoc suites take the slot before the child reached its lanes.
    // At cap one, a second runnable entry also owns the next slot after this
    // child acquires it; otherwise an ordinary waiter can overtake the queue.
    if (this.inFlight || this.starting) {
      this.reconcileSuitePriority();
      return;
    }
    const next = this.nextRunnableQueuedEntry();
    if (!next) { this.publishSuitePriority(false); return; }
    // This claim is written BEFORE checking an occupied slot. Once that slot
    // releases, ordinary suites yield and the next pump can start this verify.
    this.publishSuitePriority(true);
    if (this.failedFileDiagnosisPeer?.busy()) {
      void this.failedFileDiagnosisPeer.preempt('queued-full-verify').then((cleared) => { if (cleared) this.pump(); });
      return;
    }
    const holders = this.seams.foreignSuiteHolders();
    if (holders.length > 0) {
      this.audit({ event: 'overlap', where: 'before-start', holders: holders.map((h) => h.pid) });
      return;
    }
    if (next.kind !== 'main' && decideBaseRefresh(next, { now: this.now(), mainMovedAt: this.mainMovedAt })) {
      // The verify tests the merge with TODAY's base: re-read it right before the start, and
      // confirm the PR is still open (a PR merged or closed while it waited is dropped, not run).
      this.starting = next;
      void this.refreshBaseThenPump(next);
      return;
    }
    const [entry] = this.queue.splice(this.queue.indexOf(next), 1);
    this.lastStartWasMain = entry.kind === 'main';
    this.start(entry);
  }

  private reconcileSuitePriority(): void {
    if (this.inFlight || this.starting) {
      const preparing = !!this.starting || (!!this.inFlight && !this.inFlight.cancelled && !this.inFlight.suiteSlotAcquired);
      let onlySlot = false;
      try { onlySlot = this.seams.suiteCapacity?.() === 1; } catch { /* @silent-fallback-ok: unknown cap never over-reserves */ }
      const nextQueued = !preparing && onlySlot && this.nextRunnableQueuedEntry() !== null;
      this.publishSuitePriority(!this.stopped && (preparing || nextQueued));
      return;
    }
    this.publishSuitePriority(this.nextRunnableQueuedEntry() !== null);
  }

  private nextRunnableQueuedEntry(): QueueEntry | null {
    // A merge hand-off holds the queue (bounded): the next PR is verified on top of the merge, not against it.
    if (this.stopped || this.restoring || this.blockedBy || this.mergeHold || this.verifierHold || this.queue.length === 0) {
      return null;
    }
    if (this.notePause()) return null; // an update is waiting only on us
    // The files on disk must still be the verifier this server labels records with: an update
    // that landed under us holds the queue for the restart instead of spawning a child that refuses.
    if (this.verifierChangedOnDisk()) return null;
    const now = this.now();
    // Stable: FIFO within a level. An ordinary PR that has waited THROUGHPUT_AGING_MS ranks with
    // the merge-throughput label, so the label can never hold an old PR back indefinitely.
    this.queue.sort((a, b) => effectivePriority(b, now) - effectivePriority(a, now));
    // Main-red hold (CMT-1033): while `main` fails a known check, only a repair candidate
    // (a PR that touches or names a failing file) or a `main` verify may take the slot;
    // every other PR entry keeps its place and waits for green. Never a doomed run.
    const hold = this.holdDecision();
    // An entry reserved for a peer attempt (or being prepared for one) is the peer's, never started here.
    let admissible: QueueEntry[] = this.queue.filter((e) => !e.remote && e !== this.dispatching);
    if (hold.active) {
      this.noteHold(hold);
      const held = new Set(hold.heldPrs.map((h) => h.pr));
      admissible = admissible.filter((e) => e.kind === 'main' || !held.has(e.pr));
      if (admissible.length === 0) {
        if (this.holdIdleAudited !== hold.redHead) {
          this.holdIdleAudited = hold.redHead;
          this.audit({ event: 'main-red-hold-idle', redHead: hold.redHead, held: hold.heldPrs.length, failingFiles: hold.failingFiles });
        }
        return null;
      }
    }
    const d = decideStart({
      foreignHolders: 0, queue: admissible, now: this.now(),
      fairShare: { mainHealthy: this.health.isHealthy(), mainRed: this.health.snapshot().state === 'main-red', oldestUnverifiedMainAt: this.mainObs.oldestUnverifiedAt, lastStartWasMain: this.lastStartWasMain },
    });
    return d.kind === 'start' ? admissible[d.index] : null;
  }

  private publishSuitePriority(active: boolean): void {
    if (!active && !this.suitePriorityClaimed) return;
    try {
      this.seams.setSuitePriority?.(active);
      this.suitePriorityClaimed = active;
    } catch (err) {
      this.audit({ event: 'suite-priority-error', detail: err instanceof Error ? err.message.slice(0, 200) : String(err) });
    }
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
    const replay = entry.kind === 'main' ? null : this.preflightReplays?.get(replayKey({ repo: this.cfg.repo, ...entry, policyHash: this.policyHash }));
    if (replay && (replay.state === 'pending' || replay.state === 'retryable-error')) {
      try {
        this.preflightReplays?.admitted(replay.key, this.now());
        entry.preflightReplay = true;
      } catch (e) {
        this.queue.unshift(entry);
        this.audit({ event: 'preflight-replay-start-persist-failed', pr: entry.pr, detail: String(e) });
        return;
      }
    }
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
      ...(entry.kind === 'main' ? {} : { isolation: entry.peerIsolation ?? this.isolationInput() }),
      // PR verifies: stop the other lanes once one lane has a failure its re-run did not clear.
      ...(entry.kind !== 'main' && this.failFastOn() ? { failFast: true } : {}),
      ...(entry.kind !== 'main' ? { preflightMode: replay || entry.preflightBypassRetry ? 'off' as const : this.preflightMode() } : {}),
      ...(entry.kind !== 'main' ? { preflightRediscoverable: entry.preflightRediscoverable === true } : {}),
      ...(() => { const ls = this.laneShards(); return ls ? { laneShards: ls } : {}; })(),
      ...(entry.kind === 'main' ? { kind: 'main' as const } : {}),
      // A peer run answers one coordinator attempt: the record carries it (spec local-verify-capacity.md Part D).
      ...(entry.peerAttempt ? { attempt: entry.peerAttempt } : {}),
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
      if (entry.preflightReplay && replay) {
        try { this.preflightReplays?.finished(replay.key, this.now(), 'error'); }
        catch (persistError) { this.audit({ event: 'preflight-replay-finish-persist-failed', pr: entry.pr, detail: String(persistError) }); }
      }
      if (entry.peerAttempt) {
        // A peer attempt never touches this machine's own index or queue: the coordinator gets an error record.
        this.audit({ event: 'spawn-failed', pr: entry.pr, detail: e instanceof Error ? e.message : String(e), peerAttempt: entry.peerAttempt.id });
        this.finishPeerAttempt({ entry, cancelled: false }, { kind: 'crash' });
        return;
      }
      this.complete(this.syntheticError(entry, 'spawn'), 'run');
      this.audit({ event: 'spawn-failed', pr: entry.pr, detail: e instanceof Error ? e.message : String(e) });
      if (!entry.preflightReplay) this.handleErrorRetry(entry);
      this.pump();
      return;
    }
    // Phase 2: patch pid/pgid (detached: the child's pid IS its pgid).
    intent.pid = handle.pid;
    intent.pgid = handle.pid;
    this.inFlight = { entry, token, pgid: handle.pid, inputPath, resultPath, cancelled: false, startedAt: intent.startedAt,
      preflightAllowanceMs: input.preflightMode && input.preflightMode !== 'off' ? PREFLIGHT_LIMITS.totalMs : 0 };
    this.publishSuitePriority(true);
    const mine = this.inFlight;
    handle.exited.then((x) => this.onExit(mine, x), () => this.onExit(mine, { status: null, signal: null }));
    this.writeInFlight(intent);
    this.persistQueue();
    this.audit({ event: 'started', pr: entry.pr, headSha: entry.headSha, baseSha: entry.baseSha, pgid: handle.pid, attempt: entry.attempts });
  }

  private cancelInFlight(reason: string, opts: { armKillTimer?: boolean } = {}): void {
    const f = this.inFlight;
    if (!f || f.cancelled) return;
    f.cancelled = true;
    this.publishSuitePriority(false);
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
    // The restart hold this run held is gone: let a waiting update restart now, not at its next re-check.
    try { this.runEnded?.(); } catch { /* @silent-fallback-ok: the updater's own re-check still runs within 5 minutes */ }
    const result = this.readResult(f.resultPath);
    this.removeRunFiles(f);
    if (f.entry.peerAttempt) {
      this.publishSuitePriority(false);
      this.finishPeerAttempt(f, result);
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const w of waiters) w();
      return;
    }
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
      if (!f.entry.preflightReplay) this.handleErrorRetry(f.entry);
    } else if (result.kind === 'requeue') {
      // A capacity wait is never an attempt.
      f.entry.attempts = decideVerifyRetry(f.entry, 'requeue').attempts;
      if (f.entry.preflightReplay) {
        try { this.preflightReplays?.releasedForCapacity(replayKey({ repo: this.cfg.repo, ...f.entry, policyHash: this.policyHash }), this.now()); }
        catch (e) { this.audit({ event: 'preflight-replay-capacity-release-failed', pr: f.entry.pr, detail: String(e) }); }
      }
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
      if (rec && rec.outcome === 'error' && !f.entry.preflightReplay) this.handleErrorRetry(f.entry, rec.errorStep);
    }
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
    this.pump();
  }

  /* @self-action-controller: local-verify-error-rerun */
  private handleErrorRetry(entry: QueueEntry, errorStep?: string): void {
    const d = decideVerifyRetry(entry, 'error');
    if (d.action !== 're-run') return;
    entry.errorRetries = d.errorRetries;
    if (this.preflightErrorNeedsBypass(errorStep)) entry.preflightBypassRetry = true;
    this.audit({ event: 'error-auto-retry', pr: entry.pr, headSha: entry.headSha });
    this.retry(entry);
  }

  private preflightErrorNeedsBypass(errorStep?: string): boolean {
    return errorStep?.startsWith('preflight-') === true || errorStep?.startsWith('deadline:preflight') === true;
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
    let detail = runDetail(record, run);
    if (record.outcome === 'failure') {
      // Kept (and written durably) for the main-red hold: which files failed, so a repair can be told from a doomed run.
      this.mainFailure = mainFailureFromRunDetail(head, run, new Date(this.now()).toISOString());
      this.writeMainFailure(this.mainFailure);
      detail = { ...detail, hold: this.holdLists(this.mainFailure) };
    }
    if (record.outcome !== 'error') this.noteMainHeadVerified(head);
    if (record.outcome === 'success') this.saveGreenMain(record);
    if (record.outcome === 'success' && this.preflightReplays) {
      const work = (async () => {
        for (const marker of this.preflightReplays!.list().filter((r) => r.state === 'blocked')) {
          const [view, open] = await Promise.all([this.seams.prView(marker.pr).catch(() => null), this.seams.isPrOpen(marker.pr).catch(() => null)]);
          if (open === false || view && (view.headRefOid !== marker.headSha || view.baseRefName !== marker.baseRefName)) {
            this.preflightReplays!.cancel(marker.key);
            continue;
          }
          if (open !== true || !view) continue;
          if (this.preflightReplays!.rearmOnce(marker.key, this.now())) this.audit({ event: 'preflight-replay-rearmed', pr: marker.pr, trigger: 'healthy-main' });
        }
        this.scheduleReplayAdmission();
      })().catch((e) => this.audit({ event: 'preflight-replay-rearm-failed', detail: String(e) }));
      this.pendingMainWork.push(work);
    }
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
      if (this.health.isHealthy()) this.clearMainFailure();
      if (action === 'rerun') this.enqueueMain(head, 'rerun');
      else if (action === 'cleared') await this.rerunFailures();
      this.pump(); // a hold that just lifted (or just engaged) changes what may start
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
      // Skipped at the ordinary cap BEFORE asking: request() marks the new base as tried even
      // when it then answers queue-full, which would spend this PR's one re-run for nothing.
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
  private complete(record: LocalVerifyRecord, source: 'run' | 'derived' | 'peer'): LocalVerifyRecord | null {
    const v = validateRecord(record);
    if (!v.ok || record.repo !== this.cfg.repo) {
      this.audit({ event: 'record-rejected', pr: record.pr, errors: v.ok ? ['repo'] : v.errors });
      return null;
    }
    const enforcedRed = record.preflight?.mode === 'enforce' && record.preflight.outcome === 'red' && record.preflight.reason === 'preflight-red';
    if (enforcedRed) {
      try {
        if (!this.preflightReplays) throw new Error('replay store unavailable');
        this.preflightReplays.ensureRed(record, this.now()); // durable BEFORE the red journal record
      } catch (e) {
        this.audit({ event: 'preflight-replay-persist-failed', pr: record.pr, detail: e instanceof Error ? e.message : String(e) });
        record = { ...record, outcome: 'error', errorStep: 'preflight-replay-persist', preflight: undefined };
      }
    }
    const line: JournalLine = { v: 1, writtenAt: new Date(this.now()).toISOString(), record };
    fs.mkdirSync(path.dirname(this.journalPath), { recursive: true });
    fs.appendFileSync(this.journalPath, JSON.stringify(line) + '\n'); /* state-registry: local-verify-journal */
    const key = recordKey(record.repo, record.pr, record.headSha, record.baseRefName);
    this.index.set(key, record);
    if (!enforcedRed) {
      const replay = this.preflightReplays?.get(replayKey(record));
      if (replay?.state === 'running') {
        try { this.preflightReplays?.finished(replay.key, this.now(), record.outcome); }
        catch (e) { this.audit({ event: 'preflight-replay-finish-persist-failed', pr: record.pr, detail: String(e) }); }
      } else if (replay && record.outcome !== 'error') {
        try { this.preflightReplays?.completeFromJournal(replay.key, this.now()); }
        catch (e) { this.audit({ event: 'preflight-replay-completion-persist-failed', pr: record.pr, detail: String(e) }); }
      }
      if (record.outcome === 'success' && (record.preflight?.outcome === 'red' || replay)) {
        this.audit({ event: 'preflight-false-red', pr: record.pr, headSha: record.headSha, baseSha: record.baseSha,
          mode: record.preflight?.outcome === 'red' ? 'observe' : 'enforce',
          repeatedFailedFile: record.preflight?.repeatedFailedFile ?? null });
      }
    }
    this.audit({ event: 'record', source, pr: record.pr, headSha: record.headSha, baseSha: record.baseSha, outcome: record.outcome, errorStep: record.errorStep });
    this.seams.onRecord?.(record);
    this.offerMerge(record);
    if (enforcedRed || this.preflightReplays?.get(replayKey(record))?.state === 'retryable-error') this.scheduleReplayAdmission();
    if (record.outcome !== 'error') {
      const ek = executionKey(record.headSha, record.baseSha);
      if (source === 'run' && record.preflight?.reason !== 'preflight-red') this.execIndex.set(ek, record);
      if (record.preflight?.reason === 'preflight-red') return record; // another PR cannot inherit this liveness-costly early red
      for (let i = this.queue.length - 1; i >= 0; i--) {
        const e = this.queue[i];
        if (!e.remote && e.headSha === record.headSha && e.baseSha === record.baseSha && !(e.pr === record.pr && e.baseRefName === record.baseRefName)) {
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
  private persistQueue(): boolean {
    if (this.restoring) return true; // restore writes once it has the whole picture
    try {
      const entries: QueueEntry[] = [];
      const f = this.inFlight;
      if (f && !f.cancelled && f.entry.kind !== 'main' && !f.entry.peerAttempt) entries.push(f.entry);
      for (const e of this.queue) if (e.kind !== 'main' && !e.peerAttempt && !entries.includes(e)) entries.push(e);
      const out: PersistedQueueEntry[] = entries.map((e) => ({
        pr: e.pr, headSha: e.headSha, baseSha: e.baseSha, baseRefName: e.baseRefName,
        firstQueuedAt: e.firstQueuedAt, attempts: e.attempts, errorRetries: e.errorRetries, starvedRaised: e.starvedRaised,
        ...(e.pausedMs ? { pausedMs: e.pausedMs } : {}),
        ...(e.baseResolvedAt ? { baseResolvedAt: e.baseResolvedAt } : {}),
        ...(e.interruptions ? { interruptions: e.interruptions } : {}),
        ...(e.resumeFirst ? { resumeFirst: true as const } : {}),
        ...(e.priority === QUEUE_PRIORITY.mergeThroughput ? { priority: e.priority } : {}),
        ...(e.remote ? { remote: e.remote } : {}),
        ...(e.remoteAttempts ? { remoteAttempts: e.remoteAttempts } : {}),
        ...(e.preflightBypassRetry ? { preflightBypassRetry: true as const } : {}),
        // The running entry is marked: a clean shutdown re-queues it unmarked, so a marked
        // entry found at boot means the server died mid-run.
        ...(f && !f.cancelled && f.entry === e ? { inFlight: true as const } : {}),
      }));
      const json = JSON.stringify({ v: 1, entries: out });
      if (json === this.lastQueueJson) return true; // unchanged: no write
      fs.mkdirSync(this.lvStateDir, { recursive: true });
      const tmp = this.queuePath + '.tmp';
      fs.writeFileSync(tmp, json, { mode: 0o600 }); /* state-registry: local-verify-queue */
      fs.renameSync(tmp, this.queuePath);
      this.lastQueueJson = json;
      return true;
    } catch (e) {
      this.audit({ event: 'queue-persist-failed', detail: e instanceof Error ? e.message : String(e) });
      return false;
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
      remote: isRemoteMarker(x.remote) ? x.remote : undefined,
      remoteAttempts: Number.isSafeInteger(x.remoteAttempts) && (x.remoteAttempts as number) > 0 ? x.remoteAttempts : undefined,
      preflightBypassRetry: x.preflightBypassRetry === true ? true as const : undefined,
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

  /**
   * Once-per-episode bookkeeping for an active hold: one `main-red-held` audit line per held
   * PR, and — only once `main` is RED (a first failure raises no notice, spec §2) — one deduped
   * item for the "main is red" condition (`local-verify:main-red-hold`) naming the failing
   * check and every PR already fixing it, re-raised (same id: the row's body refreshes) only
   * when the red head or the sorted fixing list changes, so a second session does not write
   * the same fix.
   */
  private noteHold(d: Extract<MainRedHoldDecision, { active: true }>): void {
    for (const r of d.repairPrs) if (!this.repairSeen.has(r.pr)) this.repairSeen.set(r.pr, r);
    for (const h of d.heldPrs) {
      if (this.heldAudited.get(h.pr) === d.redHead) continue;
      this.heldAudited.set(h.pr, d.redHead);
      this.audit({ event: 'main-red-held', pr: h.pr, redHead: d.redHead, reason: h.reason, failingFiles: d.failingFiles, state: d.state });
    }
    if (d.state !== 'main-red') return;
    // Sorted: the same PRs in another order (one started, one was remembered, a label re-sorted
    // the queue) is the same news and must not repost the item or reopen an acknowledged row.
    const prs = d.repairPrs.map((r) => r.pr).sort((a, b) => a - b);
    const signature = `${d.redHead}|${prs.join(',')}`;
    if (this.holdSignalled === signature) return;
    this.holdSignalled = signature;
    const key = MAIN_RED_HOLD_SIGNAL_KEY;
    const fixing = d.repairPrs.length === 0
      ? 'No queued PR is fixing it yet.'
      : `Already fixing it: ${prs.map((pr) => `PR #${pr}`).join(', ')}. Check ${prs.length === 1 ? 'it' : 'them'} before writing another fix.`;
    const detail = {
      // `note` first: the attention summary reads it as the plain-words body.
      note: `main is red on ${d.failingFiles.join(', ')}. ${fixing} ${d.heldPrs.length} other PR${d.heldPrs.length === 1 ? '' : 's'} held until main is green. A fix runs first when its diff touches the failing file or its title or body names it; a revert of the breaking change also runs first.`,
      redHead: d.redHead, failingFiles: d.failingFiles,
      repairPrs: [...d.repairPrs].sort((a, b) => a.pr - b.pr).map((r) => ({ pr: r.pr, by: r.by, file: r.file })), heldPrs: d.heldPrs.map((h) => h.pr),
    };
    this.audit({ event: 'signal', key, ...detail });
    try { this.seams.signal?.(key, detail); } catch { /* @silent-fallback-ok: a signal sink failure never changes the queue */ }
  }

  /**
   * Close the hold item. Keyed on the stable id, not on memory: after a restart the item may be
   * open while nothing in memory says so; closing a row that is not open is a no-op.
   */
  private clearHoldSignal(resolution: string): void {
    this.holdSignalled = null;
    this.audit({ event: 'signal-cleared', key: MAIN_RED_HOLD_SIGNAL_KEY, resolution });
    try { this.seams.clearSignal?.(MAIN_RED_HOLD_SIGNAL_KEY, resolution); } catch { /* @silent-fallback-ok: a clear-sink failure never changes the queue; the attention lifecycle still expires the row */ }
  }

  private clearMainFailure(): void {
    if (this.mainFailure === null && this.heldAudited.size === 0 && this.holdSignalled === null && this.repairSeen.size === 0) return;
    this.mainFailure = null;
    this.heldAudited.clear();
    this.clearHoldSignal('main is green again');
    this.repairSeen.clear();
    this.holdIdleAudited = null;
    try {
      SafeFsExecutor.safeRmSync(this.mainFailurePath, { force: true, operation: 'local-verify:main-failure-cleared' });
    } catch (e) {
      this.audit({ event: 'main-failure-remove-failed', detail: e instanceof Error ? e.message : String(e) });
    }
  }

  private readMainFailure(): MainFailureDetail | null {
    try {
      const o = JSON.parse(fs.readFileSync(this.mainFailurePath, 'utf-8')) as { v?: unknown; detail?: MainFailureDetail };
      const d = o?.v === 1 ? o.detail : undefined;
      if (d && isValidSha(d.headSha) && Array.isArray(d.files) && d.files.every((f) => typeof f === 'string') && Array.isArray(d.reasons) && typeof d.recordedAt === 'string') {
        return { headSha: d.headSha, files: d.files, reasons: d.reasons.filter((r): r is string => typeof r === 'string'), messages: d.messages && typeof d.messages === 'object' ? d.messages : {}, recordedAt: d.recordedAt };
      }
    } catch { /* @silent-fallback-ok: missing/unreadable ⇒ failing files unknown ⇒ no hold (today's behaviour) */ }
    return null;
  }

  private writeMainFailure(d: MainFailureDetail): void {
    try {
      fs.mkdirSync(this.lvStateDir, { recursive: true });
      const tmp = `${this.mainFailurePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, detail: d }), { mode: 0o600 }); /* state-registry: local-verify-main-failure */
      fs.renameSync(tmp, this.mainFailurePath);
    } catch (e) {
      this.audit({ event: 'main-failure-write-failed', detail: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Metadata-only audit log, rotating at 5 MB, 10 files kept. */
  private audit(event: Record<string, unknown>): void {
    appendLocalVerifyAudit(this.auditPath, event, this.now());
  }
}

/** The PR's changed files from its view (null when the seam did not read them). */
function viewFiles(view: PrView): string[] | null {
  if (!Array.isArray(view.files)) return null;
  return view.files.filter((f) => !!f && typeof f.path === 'string').map((f) => f.path).slice(0, 300);
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
