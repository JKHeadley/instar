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
import { exitSeenPath, MERGE_HANDOFF_RESTART_HOLD_MS, mergeHoldPath, PEER_RESTART_HOLD_MS, peerHoldPath, plannedRestartBypassesHolds, readPlannedRestartVerifyState, VERIFY_RESTART_HOLD_MS } from '../core/PlannedRestartVerifyGuard.js';
import { executionKey, recordKey, validateRecord, isValidPr, isValidSha, MAIN_VERIFY_PR, type FlakyRetry, type LocalVerifyRecord } from './record.js';
import { PreflightReplayStore, replayKey, type PreflightReplay } from './preflightReplay.js';
import { FailedFileDiagnosisCoordinator } from './FailedFileDiagnosisCoordinator.js';
import { FailedFileDiagnosisPeerService } from './FailedFileDiagnosisPeerService.js';
import type { DiagnosisMode } from './failedFileDiagnosis.js';
import type { DiagnosisPeerClient, DiagnosisPeerRequest } from './failedFileDiagnosisPeer.js';
import { MainHealth, MAIN_HEALTH_LIMITS, MAIN_VERIFY_LIMITS, releaseCollapsesInto, type CommitInfo, decideMainEnqueue, decideMainErrorRetry, decideMainHeadEnqueue, decideMainRearmAfterGreen, noteHeadSuperseded, oldestUnverifiedAfterGreen, supersededAtFor, type MainHealthSnapshot } from './mainHealth.js';
import { isMergeEligible } from '../../scripts/local-verify-floor.mjs';
import { IMPORT_RELATED_RERUN, LOCAL_VERIFY_DEADLINES, LOCAL_VERIFY_LIMITS, computePolicyHash } from './policy.js';
import { boundedHead } from '../core/boundedInput.js';
import { WaitingList, type Waiter } from './waitingList.js';
import { OPERATOR_QUEUE_LIMITS, OperatorQueueStore, bootReason, holdReminderDue, isValidTime, safeIso, type OperatorRecord, type SavedQueueEntry } from './operatorQueue.js';
import { readLastRestartRequest } from '../core/restartRequestAttribution.js';
import { decideMainRedHold, holdReasonText, mainFailureFromRunDetail, prMatchText, repairVerdict, type MainFailureDetail, type MainRedHoldDecision, type RepairCandidate } from './mainRedHold.js';
import type { RestartHold } from '../core/UpdateGate.js';
import { MAX_LANE_SHARDS, MAX_UNIT_WORKERS, type FailureDetail, type FlakyOnMainFile, type FlakyOnMainTest, type IsolationInput, type IsolationRefusals, type VerifyRunInput, type VerifyRunResult, type RunDegradation } from './orchestrator.js';
import { PREFLIGHT_LIMITS } from './preflight.js';
import { requestDigest, signPeerResult, verifyPeerResult, type PeerResultRefusal } from './peerResultSignature.js';
import { holdingDecision, noteDuration, refreshAgeMs, noteLocallyVerified, olderClock, peerMainRoutingAllowed, peersGreenOn, readPeerTrust, rememberPeerGreen, resetHoldingState, writePeerTrust, type PeerTrustState } from './peerTrust.js';
import type { MachineKeyLookup, MachineSigner } from '../core/AppRecordSignatures.js';
import {
  PEER_LIMITS, importRefusal, noteFailure, noteSuccess, parsePeerMainRun, parsePeers, peerHealthy,
  type PeerClient, type PeerMainRun, type PeerHealth, type PeerResult, type PeerRunAnswer, type PeerRunRequest, type PeerStatus, type PeerTarget, type RemoteMarker,
} from './peer.js';
import { localVerifyRunPrefixes, type LeftoverPrefix, type ReapOptions, type ReapResult } from './leftoverReaper.js';
import { FIRST_PART_LIMITS, boundLikelyFailingWire, parseFirstPartSetting, type FirstPartGroup, type FirstPartInput, type FirstPartSetting, type FirstPartSummary, type LikelyFailingWire } from './firstPart.js';
import { LikelyFailingStore, type LikelyFailingInfo } from './likelyFailingList.js';
import { FirstPartGroups } from './firstPartTrial.js';
import { FirstPartReport, observation, redMainEpisode, type FirstPartEvidence, type ObservationDetail } from './firstPartReport.js';

/** A verify peer's fit for a full verify (resource-aware placement §4). */
export interface PeerFit {
  eligible: boolean;
  reason: string;
  score: number | null;
  /** Plain words when the peer is out of the line because it is short of memory (raises the notice). */
  memoryReason?: string | null;
}

/**
 * Machine memory care (docs/specs/machine-memory-care.md): a machine short of memory is out of
 * the test line, with one notice per episode; and leftover test processes are ended.
 */
export const MEMORY_CARE = Object.freeze({
  /**
   * The notice closes only after the machine has been fine this long (the hold itself lifts at
   * once). A machine that flaps keeps ONE open item instead of a new notice per flap.
   */
  clearAfterMs: 10 * 60_000,
  /**
   * A coordinator held this long starts ONE entry anyway, then holds again for another window:
   * `main` verifies and replays can run only here, so an endless hold would stop merging.
   */
  selfHoldMaxMs: 45 * 60_000,
  /** The backstop leftover sweep runs at most this often (also once at boot). */
  sweepEveryMs: 10 * 60_000,
  /**
   * A matching process at least this old is a leftover whatever is running: no run lasts this
   * long (120 min active ceiling plus preflight), so it cannot belong to a live run, on this
   * agent or any other agent sharing the temp folder.
   */
  leftoverMinAgeS: 6 * 60 * 60,
});
/** A peer skipped for the same reason is audited at most this often. */
export const PEER_SKIP_AUDIT_MS = 10 * 60_000;

/** Repeat-flake escalation (one tracked item per file, re-raised when the flake keeps recurring). */
export const FLAKY_REPEAT = Object.freeze({ count: 3, windowMs: 7 * 24 * 60 * 60_000, keep: 20 });

/**
 * The flaky history. Per file: `seen`, the times an isolation re-run passed it (PR and `main`
 * runs mixed), and `mainSeen`, the named tests a green `main` verify THIS machine ran saw fail
 * in a lane and pass alone by name (spec local-verify-import-related-rerun.md): one entry per
 * test with its newest time, kept 7 days, at most 40 per file. `mainSeenCut` is when a name was
 * last dropped by that cap or the length bound. `mainSeen` is the ONLY evidence the
 * import-related re-run uses; `seen` and `greenMain.notClean` never are.
 */
interface FlakyHistory {
  v: 1;
  files: Record<string, { seen: string[]; escalatedAt: string | null; mainSeen?: FlakyOnMainTest[]; mainSeenCut?: string }>;
  greenMain: { headSha: string; finishedAt: string; notClean: string[]; origin?: 'local' } | null;
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
/**
 * `finishedAt` (with the head: the identity of one verify, so a replica of the same verify is
 * counted once) and `runLog` (the run's log file on the machine that ran it: the pointer to the
 * full failure output) ride on every line. A PR run under the import-related rule also carries
 * the import-related files that got no re-run, each list at most 10 entries with its true count.
 */
export function runDetail(record: LocalVerifyRecord, run?: { reasons?: string[]; failures?: FailureDetail[]; runLog?: string; isolationRefusals?: IsolationRefusals }): Record<string, unknown> {
  return {
    ...(record.kind === 'main' ? { kind: 'main' } : { pr: record.pr }),
    headSha: record.headSha,
    outcome: record.outcome,
    finishedAt: record.finishedAt,
    ...(typeof run?.runLog === 'string' && run.runLog ? { runLog: run.runLog } : {}),
    ...(record.errorStep ? { errorStep: record.errorStep } : {}),
    reasons: (run?.reasons ?? []).slice(0, 40),
    failures: (run?.failures ?? []).slice(0, 30),
    ...(record.flakyRetried ? { flakyRetried: record.flakyRetried } : {}),
    // A flat marker of a PR line that carries an import-related clear (the ladder's evidence reader matches flat fields only).
    ...(record.kind !== 'main' && record.flakyRetried?.some((f) => f.importRelated === true) ? { importRelatedClear: true } : {}),
    ...(record.kind === 'main' ? {} : refusalFields(run?.isolationRefusals)),
  };
}

/** The refusal lists of a run result, re-bounded here (the result is a file a run child wrote). Pure. */
function refusalFields(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const x = v as Record<string, unknown>;
  const cap = IMPORT_RELATED_RERUN.auditRefusals;
  const out: Record<string, unknown> = {};
  for (const key of ['noMainEvidence', 'noMainEvidenceForTest', 'importRelatedRefused'] as const) {
    const list = (Array.isArray(x[key]) ? x[key] as unknown[] : []).filter((e): e is Record<string, unknown> => !!e && typeof e === 'object' && typeof (e as { file?: unknown }).file === 'string');
    const count = x[`${key}Count`];
    out[key] = list.slice(0, cap).map((e) => ({
      file: (e.file as string).slice(0, 300),
      ...(typeof e.reason === 'string' ? { reason: e.reason.slice(0, 40) } : {}),
      ...(typeof e.test === 'string' ? { test: e.test.slice(0, IMPORT_RELATED_RERUN.nameChars) } : {}),
      ...(e.namesCut === true ? { namesCut: true } : {}),
    }));
    out[`${key}Count`] = typeof count === 'number' && Number.isSafeInteger(count) && count >= list.length ? count : list.length;
  }
  return out;
}

/** A stored main-evidence entry that can be offered: every field present and inside its bound. Pure. */
function usableMainSeen(e: unknown): e is FlakyOnMainTest {
  const x = e as Partial<FlakyOnMainTest> | null;
  return !!x && typeof x === 'object' && typeof x.test === 'string' && x.test.length >= 1 && x.test.length <= IMPORT_RELATED_RERUN.nameChars
    && typeof x.at === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(x.at) && !Number.isNaN(Date.parse(x.at))
    && typeof x.line === 'string' && x.line.length <= IMPORT_RELATED_RERUN.lineChars
    && typeof x.setHash === 'string' && /^[0-9a-f]{64}$/.test(x.setHash) && typeof x.runLog === 'string' && /^[0-9a-f]{0,64}(\.log)?$/.test(x.runLog);
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

/**
 * The priority the queue is sorted by: stored priority, raised to the throughput level once an
 * ordinary PR has aged. The wait counts from its first queue-full refusal when it had one, so a
 * PR that already waited outside the queue is not made to wait the window again inside it. Pure.
 */
export function effectivePriority(e: { priority: number; kind?: 'main'; firstQueuedAt: number; firstRefusedAt?: number; pausedMs?: number }, now: number, agingMs: number = THROUGHPUT_AGING_MS): number {
  if (e.kind === 'main') return e.priority;
  const since = e.firstRefusedAt !== undefined ? Math.min(e.firstRefusedAt, e.firstQueuedAt) : e.firstQueuedAt;
  const waited = now - since - (e.pausedMs ?? 0);
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
  /**
   * Every open PR in one read, or null when a complete list cannot be read (including a list
   * that may be cut short). Lets boot avoid one network call per journal PR. Absent or null ⇒
   * the per-PR `isPrOpen` path is used.
   */
  listOpenPrs?(): Promise<ReadonlySet<number> | null>;
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
  /**
   * A degradation the run child carried in its result (disk-steward §5: an unreadable
   * kept-failed.json). The real seam hands it to this server's DegradationReporter, the
   * one that reaches /health; the child never writes the server's file itself.
   */
  onDegradation?(event: RunDegradation): void;
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
  /**
   * Plain words when THIS machine is short of memory over its last samples (the load
   * sampler's memory row), else null. Absent or null ⇒ never held for memory.
   */
  selfMemoryPressure?(): string | null;
  /** End leftover test processes under the given prefixes (leftoverReaper.ts). Absent ⇒ no sweep. */
  reapLeftovers?(prefixes: LeftoverPrefix[], opts?: ReapOptions): Promise<ReapResult>;
  /** The run temp root (`/tmp` real path on POSIX). Absent ⇒ only the agent's run worktrees are swept. */
  tempRoot?(): string;
  /** Deduped attention signal (`local-verify:main-red`, `local-verify:main-unverified`, `local-verify:flaky:<file>`). */
  signal?(key: string, detail: Record<string, unknown>): void;
  /** Close a deduped attention item whose condition ended (the main-red hold item, on green). */
  clearSignal?(key: string, resolution: string): void;
  /** A `main` head's subject and parents (release collapse); null when unreadable (verify as usual). */
  commitInfo?(sha: string): Promise<CommitInfo | null>;
  firstPartHistory?(green: string, red: string): Promise<Array<{ head: string; message: string }> | null>;
  now?(): number;
  setTimer?(fn: () => void, ms: number): void;
  /** The draw that assigns a pull request to the first-part trial's `with` or `without` (0..1). Absent ⇒ Math.random. */
  random?(): number;
}

export interface LocalVerifyServiceConfig {
  repo: string;
  /** The agent's `.instar` directory; state/ and logs/ live under it. */
  stateDir: string;
  agentHome: string;
  expectedGhLogin: string;
  operatorGhLogin?: string | null;
  /**
   * `monitoring.localVerify.operatorGhLogin`, read live. When set it wins over the boot-time
   * `operatorGhLogin`, so changing the trusted operator login needs no server restart (a
   * hand-written restart on 2026-11-16 took the M5 offline for 2m43s to apply it).
   */
  liveOperatorGhLogin?: () => string | null;
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
  /** When the PR was first refused for a full queue before this entry was admitted (fb-7fde7f49-8ee). Absent = never refused. */
  firstRefusedAt?: number;
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
  /** Peer: the coordinator's isolation input for this run (its last green `main`, and its switch and list of main-flaky tests). */
  peerIsolation?: IsolationInput;
  /** Peer: the coordinator's likely-failing list in use and the change's previous failures (spec local-verify-likely-failing-first.md B). */
  peerLikelyFailing?: LikelyFailingWire;
  /** Peer: the coordinator's assignment of this pull request for the first-part trial. */
  peerFirstPartGroup?: FirstPartGroup;
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
 * new head), or when the entry has waited `baseRefreshAfterMs` since then, or when the
 * entry was restored after a restart (`baseResolvedAt: 0`): what merged while the server was
 * down is unknown. Pure.
 */
export function decideBaseRefresh(
  entry: { baseRefName: string; firstQueuedAt: number; baseResolvedAt?: number },
  i: { now: number; mainMovedAt: number | null },
  limits: { baseRefreshAfterMs: number } = MERGE_LINE,
): boolean {
  // 0 = restored from the durable queue and not resolved by this process yet: always re-read.
  if (entry.baseResolvedAt === 0) return true;
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
 * The `restart-interrupted-runs` row. A consumed restart request explains a stop only when it was
 * consumed within two minutes before it: both consumers record the request and then stop the
 * server within seconds, and an older request belongs to an earlier restart.
 */
const RESTART_REQUEST_EXPLAINS_STOP_MS = 2 * 60_000;
const RESTART_INTERRUPTED_MAX_PEER_ATTEMPTS = 20;

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
    // An UNKNOWN age (a restart or a lease change lost it) is due: the merge may be older than the limit.
    const due = fs.oldestUnverifiedMainUnknown === true
      || (fs.oldestUnverifiedMainAt !== null && i.now - fs.oldestUnverifiedMainAt >= limits.mainFairShareMs);
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
  /**
   * That time is unknown (no usable stored value after a restart, or another machine held the
   * lease): treated as due. Absent ⇒ known.
   */
  oldestUnverifiedMainUnknown?: boolean;
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
  | { ok: true; status: 'queued' | 'already-queued' | 'in-flight'; position?: number; hold?: MainRedHoldInfo; /** Admitted over the cap by an operator front or release. */ operatorOverCap?: true }
  | { ok: true; status: 'recorded'; record: LocalVerifyRecord }
  /** `held`: the operator holds this change (queue controls). `overflow-full`: an operator admission found the queue and its overflow full. */
  | { ok: false; code: 'invalid-pr' | 'pr-unreadable' | 'pr-closed' | 'untrusted-head' | 'queue-full' | 'pr-invalid-shas' | 'main-unhealthy' | 'stopping' | 'peer-only' | 'held' | 'overflow-full' };

// ---- operator queue controls (spec local-verify-queue-controls.md) ----

export type OperatorRefusal = 'disabled' | 'peer-only' | 'stopping' | 'invalid-pr' | 'invalid-time' | 'operator-file-full' | 'state-unwritable';
type RequestRefusal = Extract<RequestResult, { ok: false }>['code'];

export type OperatorHoldResult =
  | { ok: true; pr: number; held: true; alreadyHeld: boolean; /** A verify of this change is running (here or on a peer); it is left alone. */ running: boolean; where?: 'here' | 'peer'; removed: 'queue' | 'waiting-list' | null }
  | { ok: false; code: OperatorRefusal };

export type OperatorReleaseResult =
  | { ok: true; pr: number; released: boolean; placed: 'queue' | 'waiting-list' | 'already-placed' | 'none' | 'pending'; overCap?: true; detail?: string }
  | { ok: false; code: OperatorRefusal | 'not-held' };

export type OperatorFrontResult =
  | { ok: true; pr: number; status: 'fronted' | 'admitted' | 'running' | 'held' | 'recorded'; order?: number; overCap?: true; /** Its place among the fronted changes: 1 = the next change to start. */ rank?: number; where?: 'here' | 'peer' }
  | { ok: false; code: OperatorRefusal | RequestRefusal | 'front-limit'; fronted?: Array<{ pr: number; reason: string; by: string; at: string | null }> };

export type OperatorUnfrontResult =
  | { ok: true; pr: number; unfronted: true }
  | { ok: false; code: OperatorRefusal | 'not-fronted' };

/** The operator's holds and front marks as `GET /local-verify` shows them. */
export interface OperatorQueueView {
  enabled: true;
  held: Array<{ pr: number; reason: string; by: string; at: string | null; until: string | null; heldMs: number; wanted: boolean; reminded: boolean; running: boolean; releasing: boolean; savedEntry: boolean }>;
  fronted: Array<{ pr: number; reason: string; by: string; at: string | null; order: number; held: boolean; queued: boolean; running: boolean; admitting: boolean }>;
  overflow: { used: number; max: number };
  limits: { fronted: number; records: number };
}

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
  /** Latched once this run's exit has been handled, so it is handled exactly once (see shutdown()). */
  settled?: boolean;
  /** The immutable setting and assignment used by this run. */
  runInput?: VerifyRunInput;
}

/** Peer side: what this machine knows about the attempts coordinators handed it. */
interface PeerAttemptState {
  /** `requestDigest`: the digest of the request body exactly as received (SEC-113 D1), signed with the answer. */
  current: { attemptId: string; pr: number; headSha: string; state: 'running' | 'done'; acceptedAt: number; record?: LocalVerifyRecord; run?: PeerMainRun; requestDigest?: string } | null;
  /** The last few finished attempts (so a late poll still finds its result). */
  results: Array<{ attemptId: string; record: LocalVerifyRecord; run?: PeerMainRun; requestDigest?: string }>;
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
    && (m.state === 'sending' || m.state === 'accepted') && !!d
    && (d.kind === 'main' ? d.pr === MAIN_VERIFY_PR : d.kind === undefined && isValidPr(d.pr)) && isValidSha(d.headSha) && isValidSha(d.baseSha)
    && typeof d.baseRefName === 'string' && typeof d.verifierVersion === 'string' && typeof d.policyHash === 'string'
    && (m.requestDigest === undefined || (typeof m.requestDigest === 'string' && /^[0-9a-f]{64}$/.test(m.requestDigest)));
}

/**
 * A queue entry as persisted in `state/local-verify/queue.json`: PR verifies, and a `main` verify
 * only while it is reserved for a peer attempt (an unreserved `main` entry is re-derived).
 */
export interface PersistedQueueEntry {
  /** Present only on a `main` verify reserved for a peer. */
  kind?: 'main';
  pr: number;
  headSha: string;
  baseSha: string;
  baseRefName: string;
  firstQueuedAt: number;
  /** When the PR was first refused for a full queue before admission (fb-7fde7f49-8ee). */
  firstRefusedAt?: number;
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
  /** The update is installed and its restart is durably deferred because of a peer attempt. */
  restartHeldForPeer?: boolean;
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
  /** The head of the `main` run in flight, when that head was main's observed head at the run's start; else null. */
  private mainRunOnCurrentHead: string | null = null;
  /** When this process restored its queue: a restored `main` reservation's silence is counted from here. */
  private queueRestoredAt = 0;
  /** head → when a different `main` head was first observed after it (see `noteHeadSuperseded`). In memory; rebuilt after a restart. */
  private readonly mainSupersededAt = new Map<string, number>();
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
  /** Coordinator: the live switch for handing `main` verifies to peers (absent or false ⇒ `main` stays here). */
  private mainOnPeersEnabled: (() => boolean) | null = null;
  private peerSigner: MachineSigner | null = null;
  private peerKeyLookupFactory: (() => MachineKeyLookup) | null = null;
  /** Peers whose last answer failed its signature or request check (an open item to close on the next verified one). */
  private readonly peerResultTampered = new Set<string>();
  /** Peers whose unverified item this process already closed (one clear per peer until it is raised again). */
  private readonly peerResultTamperedCleared = new Set<string>();
  /** Peers already audited as unpinned this boot (one line per peer per boot). */
  private readonly peerUnpinnedAudited = new Set<string>();
  /** SEC-113: main verifies kept on this machine by the D2.3 routing rule (this process). */
  private mainKeptLocalCount = 0;
  /** SEC-113: each peer's last refused answer reason (status display). */
  private readonly peerLastRefusal = new Map<string, string>();
  /** Coordinator, per peer: consecutive `main` requests it could not confirm, and until when it is offered none. */
  private readonly mainUnconfirmed = new Map<string, { count: number; pausedUntil: number; raised?: true }>();
  /** Coordinator: the configured peers (`monitoring.localVerify.peers`; absent ⇒ none). */
  private peersSetting: (() => unknown) | null = null;
  private peerClient: PeerClient | null = null;
  private peerFitFn: ((machineId: string) => PeerFit) | null = null;
  private readonly peerSkipAudited = new Map<string, number>();
  /** Machines out of the line for memory now (machineId → since). */
  private memoryHeld = new Map<string, { since: number; reason: string }>();
  /** Open memory notices (machineId → when the machine was first seen fine again, or null). */
  private memoryNoticeOpen = new Map<string, { healthySince: number | null }>();
  /** Machines evaluated since boot: the first fine reading closes a notice an earlier process left open. */
  private memoryEvaluated = new Set<string>();
  private lastLeftoverSweepAt = 0;
  private leftoverSweeping = false;
  private tmuxSocketsUnreadableAudited = false;
  private leaseView: { holdsLease(): boolean; leaseEpoch(): number | null; holderMachineId(): string | null } | null = null;
  private readonly peerHealth = new Map<string, PeerHealth>();
  private readonly remotePolledAt = new Map<string, number>();
  /** Coordinator: last SUCCESSFUL peer contact per attempt, seeded at accept. `remotePolledAt` records tries, not successes. */
  private readonly remoteLastOkAt = new Map<string, number>();
  /** attemptId → consecutive polls the peer did not answer (a `main` reservation is given back on silence). */
  private readonly remoteMisses = new Map<string, number>();
  /** Starts true so a heartbeat left by an earlier process is removed once, then idle ticks do no file I/O. */
  private peerHoldCount = 0;
  private peerHoldFilePresent = true;
  private peerHoldWriteFailed = false;
  /** Attempts already reported as holding the current planned restart. */
  private readonly peerHoldsAudited = new Map<string, { pr: number; sentAt: number; requestedAt: number | null }>();
  private dispatching: QueueEntry | null = null;
  private dispatchScheduled = false;
  private dispatchRunning = false;
  private pollRunning = false;
  /** Peer side: the current attempt, recent results and cancelled ids (persisted to peer-attempts.json). */
  private peerState: PeerAttemptState = { current: null, results: [], tombstones: {} };
  /** Fail-fast for PR verifies (`monitoring.localVerify.failFast`; absent ⇒ on). */
  private failFastEnabled: (() => boolean) | null = null;
  /** `monitoring.localVerify.importRelatedRerun`, read live when a run starts or is dispatched. Absent ⇒ off. */
  private importRelatedRerunEnabled: (() => boolean) | null = null;
  private runLogsSweptAt = 0;
  /** `monitoring.localVerify.likelyFailingFirst`, read live at the start of each verify this machine runs. Absent ⇒ off. */
  private likelyFailingFirstSetting: (() => unknown) | null = null;
  /** Writes `off` to that setting on this machine (the verdict check's brake). Absent ⇒ the trial state file alone holds it off. */
  private likelyFailingFirstOff: (() => void) | null = null;
  /** The likely-failing list: ONE store, shared by the recorder (complete()) and the run input (start() and a hand-off to a peer). */
  readonly likelyFailing: LikelyFailingStore;
  /** The coordinator's assignment of pull requests to the trial's two groups. */
  private readonly firstPartGroups: FirstPartGroups;
  readonly firstPartReport: FirstPartReport;
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
  /** PRs refused for a full queue, oldest first refusal first (fb-7fde7f49-8ee). Lease holder only. */
  private readonly waiting: WaitingList;
  // ---- operator queue controls (spec local-verify-queue-controls.md) ----
  /** `monitoring.localVerify.queueControls`, read live at each decision. Absent ⇒ off. */
  private queueControlsEnabled: (() => boolean) | null = null;
  /** The operator's holds and front marks, per PR number. ONE object: admission, the start check and the dispatch check all read it. */
  private readonly operator: OperatorQueueStore;
  private operatorLoadReported = false;
  private operatorCheckAt = 0;
  private operatorTicking = false;
  private operatorLeaseMisses = 0;
  private operatorClosedCursor = 0;
  /** The head and target branch last read for a fronted change (used when its view cannot be read at a result). */
  private readonly operatorSeen = new Map<number, { headSha: string; baseRefName: string }>();
  /** Switch off: how often a held change's re-admission could not read the change (bounded, then given up). */
  private readonly operatorReadmitTries = new Map<number, number>();

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
    // The age of the oldest unverified merge is restored once, here (it used to start again at every boot).
    this.mainObs.oldestUnverifiedAt = this.health.unverifiedAge().oldestUnverifiedAt;
    this.waiting = new WaitingList(path.join(this.lvStateDir, 'waiting.json'), this.now, (e) => this.audit(e));
    this.likelyFailing = new LikelyFailingStore(path.join(this.lvStateDir, 'likely-failing.json'), this.now, (e) => this.audit(e));
    this.firstPartGroups = new FirstPartGroups(path.join(this.lvStateDir, 'first-part-groups.json'), this.now, (e) => this.audit(e), () => (seams.random ? seams.random() : Math.random()));
    this.firstPartReport = new FirstPartReport(this.cfg.stateDir, this.now, (e) => this.audit(e));
    this.operator = new OperatorQueueStore(path.join(this.lvStateDir, 'operator-queue.json'), this.now, (e) => this.audit(e));
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

  /**
   * True while the verifier changed on disk and work is waiting on it: no verify can start until
   * this server restarts. Other restart holds (the feedback executor's) read this so they do not
   * defer the very restart the queue is waiting for. A pure read of the open hold — it never
   * enters one (that stays with the pre-start check and the run child's refusal).
   */
  restartNeededForQueuedWork(): boolean {
    return !this.stopped && !!this.verifierHold && this.queue.length > 0;
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

  private laneShards(): { integration?: number; e2e?: number; unitWorkers?: number } | null {
    let v: unknown;
    try { v = this.laneShardsSetting ? this.laneShardsSetting() : null; } catch { return null; } // @silent-fallback-ok: an unreadable setting means the policy defaults
    if (!v || typeof v !== 'object') return null;
    const out: { integration?: number; e2e?: number; unitWorkers?: number } = {};
    for (const k of ['integration', 'e2e'] as const) {
      const n = (v as Record<string, unknown>)[k];
      if (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= MAX_LANE_SHARDS) out[k] = n;
    }
    // Per-machine unit-lane worker count (hardware differs; 2026-11-12 the M5 sat 45-90 % idle
    // while its 4-worker unit lane hit the 20-min deadline). Which files run never changes.
    const u = (v as Record<string, unknown>).unitWorkers;
    if (typeof u === 'number' && Number.isInteger(u) && u >= 1 && u <= MAX_UNIT_WORKERS) out.unitWorkers = u;
    return Object.keys(out).length ? out : null;
  }

  /** The live switch for PR-verify fail-fast (`monitoring.localVerify.failFast`; absent ⇒ on). Read at each start. */
  setFailFastEnabled(fn: (() => boolean) | null): void { this.failFastEnabled = fn; }

  /** Late-bind the live `monitoring.localVerify.importRelatedRerun` switch (spec local-verify-import-related-rerun.md). */
  setImportRelatedRerunEnabled(fn: (() => boolean) | null): void { this.importRelatedRerunEnabled = fn; }

  private importRelatedRerunOn(): boolean {
    try { return this.importRelatedRerunEnabled ? this.importRelatedRerunEnabled() === true : false; } catch { return false; } // @silent-fallback-ok: an unreadable switch reads as off (the rule before this one)
  }

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

  snapshot(): { queue: Array<QueueEntry & { held?: { reason: 'main-red'; why: 'no-overlap' | 'files-unknown' } }>; inFlight: { pr: number; headSha: string; kind?: 'main' } | null; blocked: boolean; verifierHold: { since: string; detail: string; where: VerifierHold['where'] } | null; records: number; flakyFiles: Record<string, { count: number; lastSeen: string; lane: string }>; mergeLine: ReturnType<LocalVerifyService['mergeLine']>; mainRedHold: ReturnType<LocalVerifyService['mainRedHold']>; peers: ReturnType<LocalVerifyService['peersInfo']>; waiting: Array<Waiter & { live: boolean }>; operator?: OperatorQueueView; preflight: { mode: 'off' | 'observe' | 'enforce'; replayStoreReady: boolean; replays: Array<{ pr: number; headSha: string; baseRefName: string; state: PreflightReplay['state']; admissionAttempts: number; executionAttempts: number; blockedReason?: string }> }; likelyFailingFirst: ReturnType<LocalVerifyService['likelyFailingFirstStatus']> } {
    const h = this.verifierHold;
    const hold = this.holdDecision();
    const heldWhy = new Map<number, 'no-overlap' | 'files-unknown'>(hold.active ? hold.heldPrs.map((x) => [x.pr, x.reason] as const) : []);
    const operator = this.operatorQueue();
    return {
      // Present only while the queue controls are on: the changes the operator holds and fronts.
      ...(operator ? { operator } : {}),
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
      waiting: this.waiting.list(),
      likelyFailingFirst: this.likelyFailingFirstStatus(),
    };
  }

  /**
   * The age of the oldest `main` merge with no green verify after it. `atLeast`: the age is
   * unknown and `since` is only a lower bound, so it reads "at least", never an exact age or zero.
   */
  mainUnverifiedAge(): { since: number | null; atLeast: boolean } {
    const a = this.health.unverifiedAge();
    return a.unknownSince !== null ? { since: a.unknownSince, atLeast: true } : { since: this.mainObs.oldestUnverifiedAt, atLeast: false };
  }

  /** Main health (the machine state, not whether an attention item is open). */
  mainHealth(): MainHealthSnapshot & { currentMainHead: string | null; pendingMainHead: string | null; mainInFlight: string | null } {
    const pending = this.queue.find((e) => e.kind === 'main' && !e.remote);
    return {
      ...this.health.snapshot(),
      currentMainHead: this.mainObs.head,
      pendingMainHead: pending?.headSha ?? null,
      mainInFlight: this.inFlight?.entry.kind === 'main' ? this.inFlight.entry.headSha : (this.remoteMain()?.headSha ?? null),
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
    this.auditBoot();
    this.health.load();
    this.mainFailure = this.readMainFailure();
    this.mainObs.immediate = true; // the boot-time `main` verify skips the debounce
    // Order matters: the orphan reap runs first, and a still-blocked reap keeps every
    // restored entry waiting (pump refuses while blockedBy is set).
    await this.reapOrphan();
    this.loadPeerState(); // after the reap: an interrupted peer attempt is tombstoned, never resumed
    await this.sweepLeftovers('boot');
    await this.rebuildIndex();
    if (!this.cfg.peerOnly) await this.reconcilePreflightReplays();
    if (!this.cfg.peerOnly) this.waiting.load();
    if (!this.cfg.peerOnly) await this.restoreQueue();
    if (!this.cfg.peerOnly) await this.bootOperator();
    this.scheduleReplayAdmission();
  }

  /**
   * The restart hold for the AutoUpdater: while a verify runs, an update restart
   * waits until the run's own ceiling (capped by `maxDeferralMs`). Manual applies
   * keep the hold unless their caller explicitly requests a forced restart.
   */
  restartHolds(maxDeferralMs: number): RestartHold[] {
    if (this.stopped) return [];
    const now = this.now();
    const holds: RestartHold[] = [];
    const f = this.inFlight;
    if (f && !f.cancelled) {
      const what = f.entry.kind === 'main' ? `main ${f.entry.headSha.slice(0, 12)}` : `PR #${f.entry.pr} at ${f.entry.headSha.slice(0, 12)}`;
      holds.push({
        name: f.entry.kind === 'main' ? 'local-verify:main' : `local-verify:pr-${f.entry.pr}`,
        until: restartHoldUntil(f.startedAt, now, maxDeferralMs, f.preflightAllowanceMs),
        reason: `a local verify of ${what} is running`,
      });
    }
    // The updater runs in this process, so this hold takes effect on the first restart after
    // install. The peer-hold file alone is not enough: its other reader, the lifeline's
    // supervisor, stays on the code it started with and restarted past the file on 2026-11-06.
    for (const a of this.qualifyingPeerAttempts(now)) {
      holds.push({
        name: `local-verify:peer-pr-${a.pr}`,
        until: Math.min(a.sentAt + PEER_RESTART_HOLD_MS, now + maxDeferralMs),
        reason: `a peer verify of PR #${a.pr} is running`,
      });
    }
    // A green run's merge in progress: a restart now loses the merge (the hand-off fails while the
    // server stops, and a changed verifier no longer counts the record). Short and bounded.
    const m = this.mergeHold;
    if (m && m.since + MERGE_HANDOFF_RESTART_HOLD_MS > now) {
      holds.push({
        name: `local-verify:merge-pr-${m.pr}`,
        until: Math.min(m.since + MERGE_HANDOFF_RESTART_HOLD_MS, now + maxDeferralMs),
        reason: `PR #${m.pr} passed its verify and its merge is in progress`,
      });
    }
    return holds;
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
      this.sweepOperatorHeld(); // a restored entry of a held change goes to held, never back to the queue
      this.persistQueue(); // the next tick (or request) starts work: never before the boot finishes
    }
  }

  private async doRestoreQueue(): Promise<{ restored: number; dropped: number }> {
    const saved = this.readQueueFile();
    this.queueRestoredAt = this.now();
    let restored = 0;
    const drops = { closed: 0, 'head-or-base-moved': 0, 'already-recorded': 0, duplicate: 0, 'queue-full': 0, 'server-restarted': 0, 'replay-managed': 0 };
    for (const e of saved) {
      if (e.kind === 'main') {
        // A `main` verify reserved for a peer comes back reserved, so polling resumes on the same
        // attempt (the peer is still running it). Never two; an unreserved one is re-derived.
        // A `main` entry the reconcile loop queued meanwhile stays pending behind it.
        if (e.remote && !this.remoteMain() && this.inFlight?.entry.kind !== 'main') {
          this.queue.push({
            id: crypto.randomBytes(6).toString('hex'), pr: MAIN_VERIFY_PR, headSha: e.headSha, baseSha: e.baseSha, baseRefName: 'main',
            firstQueuedAt: e.firstQueuedAt, attempts: e.attempts, errorRetries: e.errorRetries, starvedRaised: false,
            priority: MAIN_VERIFY_LIMITS.priority, kind: 'main', remote: e.remote,
            ...(e.remoteAttempts ? { remoteAttempts: e.remoteAttempts } : {}),
          });
          restored++;
        } else {
          // Never two reservations (the service never writes two). The peer client is not wired
          // yet at boot, so a dropped one is not cancelled: it ends at the peer's own run bound.
          this.audit({ event: 'queue-restore-dropped', kind: 'main', headSha: e.headSha, reason: !e.remote ? 'unreserved' : this.inFlight?.entry.kind === 'main' ? 'main-running-here' : 'duplicate' });
        }
        continue;
      }
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
        if (why === 'closed') this.operatorOnClosed(e.pr);
        continue;
      }
      const restoredPriority = view ? prPriority(view) : (e.priority === QUEUE_PRIORITY.mergeThroughput ? QUEUE_PRIORITY.mergeThroughput : QUEUE_PRIORITY.ordinary);
      // What was durably queued comes back, bounded by the largest cap any entry could have been
      // admitted under (labelled overflow included): restoring the labelled entries first must not
      // push ordinary entries that were legitimately queued below the cap out of the queue.
      // +1: the run interrupted by the restart comes back at the head on top of a full overflow.
      // Entries an operator front or release admitted over the cap are restored too (their own bounded overflow).
      if (this.prQueueLength() >= capFor(QUEUE_PRIORITY.mergeThroughput) + 1 + this.operatorRestoreAllowance()) { drops['queue-full']++; continue; }
      const entry: QueueEntry = {
        id: crypto.randomBytes(6).toString('hex'), pr: e.pr, headSha: e.headSha,
        // The saved base, never the PR view's `baseRefOid`: that is the base as of the PR's last
        // update and can be hours or days stale (see LocalVerifyServiceSeams.baseHead). Restoring it
        // put two runs on a main from seven hours earlier (2026-11-13 18:50Z, PRs 3137 and 3096:
        // both failed, one on a flake fixed on main that morning). The saved base is the newest this
        // service resolved, and the pre-start refresh below re-reads today's head before any run.
        // A reserved entry keeps the base it was dispatched with (the marker's snapshot decides import).
        baseSha: e.baseSha,
        baseRefName: e.baseRefName, firstQueuedAt: e.firstQueuedAt, attempts: e.attempts,
        errorRetries: e.errorRetries, starvedRaised: e.starvedRaised,
        ...(e.firstRefusedAt !== undefined ? { firstRefusedAt: e.firstRefusedAt } : {}),
        // An unreadable view keeps the saved label level (never more than the throughput level).
        priority: restoredPriority,
        files: view ? viewFiles(view) : null, text: view ? prMatchText(view.title, view.body) : '',
        ...(e.pausedMs ? { pausedMs: e.pausedMs } : {}),
        // A reserved entry keeps when its base was resolved (it is not re-read: see above). Any other
        // entry comes back as "never resolved" (0), so decideBaseRefresh re-reads its base before it
        // starts, whatever its branch: this process cannot know what merged while it was down. The
        // next resolution (a pre-start refresh or a new request) writes a real time.
        ...(e.remote ? (e.baseResolvedAt ? { baseResolvedAt: e.baseResolvedAt } : {}) : { baseResolvedAt: 0 }),
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
    // Own machine: unchanged. A different holder in between: the age is now unknown (null here, due in decideStart).
    this.mainObs.oldestUnverifiedAt = this.health.unverifiedAge().oldestUnverifiedAt;
    this.mainObs.immediate = true;
    this.mainObs.handled = null;
    // Queue controls: holds in this machine's own file from an earlier period are kept, and that is written down once.
    if (opts.foreignHolder) this.noteOperatorRecordsKept();
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
    noteHeadSuperseded(this.mainSupersededAt, o.head, sha, now);
    // The age of the oldest unverified merge lives in the main-health watermark (it survives a restart).
    // The first unverified head after a boot with no usable stored value makes it unknown, never `now`.
    this.health.noteHeadObserved(sha);
    o.oldestUnverifiedAt = this.health.unverifiedAge().oldestUnverifiedAt;
    // SEC-113 D2.2: the second clock starts at the first head this machine has not verified itself.
    if (!this.cfg.peerOnly) {
      const t = this.trust();
      if (sha !== t.anchor?.head && t.notLocallyVerifiedAt === null) { t.notLocallyVerifiedAt = now; this.saveTrust(); }
    }
    const d = decideMainHeadEnqueue(o, sha, now, MAIN_VERIFY_LIMITS, { healthy: this.health.isHealthy() });
    o.head = d.next.head; o.since = d.next.since; o.firstUnverifiedAt = d.next.firstUnverifiedAt;
    o.handled = d.next.handled; o.immediate = d.next.immediate;
    if (d.enqueue) {
      if (!this.seams.commitInfo) this.enqueueMain(sha, 'head-changed');
      else {
        // A release commit of a head already queued or verified never starts a verify of its own.
        // Covered = a head this machine holds a main record for, or one queued/running now. A
        // force-pushed main (parent from an old history with no record here) is verified.
        // SEC-113 D2.3: covered by THIS machine's own verdicts (a peer's green is not enough to skip a release commit).
        // With `mainOnPeers` off no peer ever served main, so every verified head is this machine's own (unchanged behaviour).
        const trusted = this.cfg.peerOnly || !this.mainOnPeersOn() ? this.verifiedMainHeads : [...this.trust().locallyVerified, ...(this.trust().anchor ? [this.trust().anchor!.head] : [])];
        const covered = new Set<string>(trusted);
        for (const pend of this.queue) if (pend.kind === 'main') covered.add(pend.headSha); // pending, or running on a peer
        if (this.inFlight?.entry.kind === 'main' && !this.inFlight.cancelled) covered.add(this.inFlight.entry.headSha);
        const work = this.seams.commitInfo(sha).catch(() => null).then((info) => {
          const parent = releaseCollapsesInto(info, covered);
          if (parent === null) { this.enqueueMain(sha, 'head-changed'); return; }
          this.releaseAlias.set(sha, parent);
          if (this.releaseAlias.size > 50) this.releaseAlias.delete(this.releaseAlias.keys().next().value as string);
          if (parent === this.health.snapshot().lastGreenHead && this.mainObs.head === sha) { this.health.clearUnverifiedAge(); this.mainObs.oldestUnverifiedAt = null; }
          if (!this.cfg.peerOnly && parent === this.trust().anchor?.head && this.mainObs.head === sha) { this.trust().notLocallyVerifiedAt = null; this.saveTrust(); }
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
    // A `main` verify running on a peer counts as in flight: it is never replaced (that would
    // cancel it), and a newer head queues behind it exactly as behind a local run.
    const remote = this.remoteMain();
    if (why !== 'rerun' && remote && remote.headSha === sha) return;
    const i = this.queue.findIndex((e) => e.kind === 'main' && !e.remote);
    const d = decideMainEnqueue({
      sha, why,
      inFlightMain: f?.entry.kind === 'main' ? { headSha: f.entry.headSha, cancelled: f.cancelled } : remote ? { headSha: remote.headSha, cancelled: false } : null,
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
    // One list call instead of one call per PR: this runs before the server listens, and 275
    // journal PRs held boot for about 105s. A PR absent from a complete open list is not open.
    const openPrs = latest.size > 0 ? await (this.seams.listOpenPrs?.() ?? Promise.resolve(null)).catch(() => null) : null;
    let skippedVersion = 0;
    let skippedClosed = 0;
    const keep: JournalLine[] = [];
    for (const [k, l] of latest) {
      const r = l.record;
      if (!openByPr.has(r.pr)) openByPr.set(r.pr, openPrs ? openPrs.has(r.pr) : await this.seams.isPrOpen(r.pr).catch(() => null));
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
    // A merge-hold marker left by the previous process describes a hand-off that died with it.
    try { SafeFsExecutor.safeRmSync(mergeHoldPath(this.cfg.stateDir), { force: true, operation: 'local-verify:merge-hold-clear' }); }
    catch { /* @silent-fallback-ok: the marker's own short bound releases the restart */ }
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

  async request(pr: number, opts: {
    explicit?: boolean; force?: boolean; replay?: boolean; rerunAfterGreen?: boolean;
    /** Queue controls: an admission made by an operator front or release (its own bounded overflow; ignored while the switch is off). */
    operator?: 'front' | 'release';
    /** Queue controls: what a released change carries back (its first refusal, and the time it was held). */
    carry?: { firstRefusedAt?: number; pausedMs?: number };
  } = {}): Promise<RequestResult> {
    const explicit = opts.explicit ?? true;
    if (!isValidPr(pr)) return { ok: false, code: 'invalid-pr' };
    if (this.cfg.peerOnly) return { ok: false, code: 'peer-only' };
    if (this.stopped) return { ok: false, code: 'stopping' };
    if (this.restoring) await this.restoring.catch(() => undefined);
    // Queue controls: a held change answers `held` and admits nothing; the hold notes that it was
    // asked for, so a release admits it. A held change that has closed is dropped instead.
    if (this.operatorHeld(pr)) {
      const stillOpen = await this.seams.isPrOpen(pr).catch(() => null);
      if (stillOpen === false) this.operatorOnClosed(pr);
      else if (this.operatorHeld(pr)) {
        this.noteOperatorWanted(pr, explicit ? 'explicit' : 'watcher');
        return { ok: false, code: 'held' };
      }
    }
    // While `main` is unhealthy the watcher requests no PR verifies (they fail by
    // construction); POSTed ones still run, which is how a repair gets its record.
    if (!explicit && !this.health.isHealthy()) return { ok: false, code: 'main-unhealthy' };
    const view = await this.seams.prView(pr).catch(() => null);
    if (!view) return { ok: false, code: 'pr-unreadable' };
    // A merged or closed PR has nothing to verify (an unknown answer queues it: the pre-start check asks again).
    if ((await this.seams.isPrOpen(pr).catch(() => null)) === false) {
      for (const marker of this.preflightReplays?.list().filter((r) => r.pr === pr) ?? []) this.preflightReplays?.cancel(marker.key);
      this.audit({ event: 'refused', pr, reason: 'pr-closed' });
      this.waiting.remove(pr, 'closed');
      this.operatorOnClosed(pr);
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
    if (!checkEligibility(view, this.logins()).eligible) {
      this.audit({ event: 'refused', pr, reason: 'untrusted-head' });
      this.waiting.remove(pr, 'untrusted-head');
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
    if (this.queueControlsOn() && this.operator.frontOrder(pr) > 0) this.operatorSeen.set(pr, { headSha, baseRefName });

    // CMT-973: a PR keeps its place and its firstQueuedAt. A base that moved is refreshed in
    // place; a moved head (or a retarget) takes the old entry's slot — the FRONT when the old
    // head was the run in flight (a push during a PR's own run never sends it to the back).
    // A new head is new work: `interruptions` start over, but a turn lost to a restart (`resumeFirst`) is kept.
    let keptPlace: { index: number; firstQueuedAt: number; pausedMs?: number; starvedRaised: boolean; resumeFirst?: true; firstRefusedAt?: number } | null = null;
    // A moved head (or retarget) cancels the in-flight run for the old one.
    const f = this.inFlight;
    if (f && f.entry.pr === pr) {
      if (f.entry.headSha !== headSha || f.entry.baseRefName !== baseRefName) {
        this.cancelInFlight('head-moved');
        keptPlace = { index: 0, firstQueuedAt: f.entry.firstQueuedAt, pausedMs: f.entry.pausedMs, starvedRaised: f.entry.starvedRaised, resumeFirst: f.entry.resumeFirst, firstRefusedAt: f.entry.firstRefusedAt };
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
      keptPlace = { index: pendingIdx, firstQueuedAt: e.firstQueuedAt, pausedMs: e.pausedMs, starvedRaised: e.starvedRaised, resumeFirst: e.resumeFirst, firstRefusedAt: e.firstRefusedAt };
      this.persistQueue();
      this.audit({ event: 'dequeued', pr, reason: 'head-moved', headSha: e.headSha });
    }

    const existing = this.index.get(key);
    // The new base a failure re-run spends; marked only once the entry is admitted (fb-7fde7f49-8ee:
    // a capacity refusal — full queue or an older waiter's place — must not spend the PR's one re-run).
    let spendRerun: (() => void) | null = null;
    if (existing) {
      if (existing.outcome === 'success') return this.recordedAnswer(pr, existing);
      if (existing.outcome === 'failure') {
        const tried = this.failureReruns.get(key) ?? new Set<string>();
        const newBase = existing.baseSha !== baseSha && !tried.has(baseSha);
        if (!opts.force && (!explicit || !newBase)) return this.recordedAnswer(pr, existing);
        spendRerun = () => { tried.add(baseSha); this.failureReruns.set(key, tried); };
      } else if (!explicit) {
        return this.recordedAnswer(pr, existing);
      }
    }

    // Execution dedupe: identical merge inputs already verified under this policy.
    const exec = this.execIndex.get(executionKey(headSha, baseSha));
    if (exec && exec.preflight?.reason !== 'preflight-red' && !(opts.force && exec.outcome === 'failure') && !(existing && existing.outcome === 'failure' && exec === existing)) {
      const derived = this.complete({ ...exec, pr, baseRefName }, 'derived');
      if (derived) return this.recordedAnswer(pr, derived);
    }

    // Queue controls: an operator front or release admits into a full queue within its own
    // bounded overflow, and below the cap it does not wait behind the waiting list.
    const operatorAdmit = opts.operator && this.queueControlsOn() ? opts.operator : null;
    let operatorOverCap = false;
    // A pushed head re-queued in its kept place replaces an entry that was already admitted:
    // it is never refused for capacity (it would otherwise lose its place while the overflow is in use).
    if (operatorAdmit) {
      if (!keptPlace && this.prQueueLength() >= LOCAL_VERIFY_LIMITS.queueCap) {
        if (this.operatorOverflowUsed() >= OPERATOR_QUEUE_LIMITS.overflow) {
          this.audit({ event: 'operator-overflow-full', pr, by: operatorAdmit, used: this.operatorOverflowUsed(), max: OPERATOR_QUEUE_LIMITS.overflow });
          return { ok: false, code: 'overflow-full' };
        }
        operatorOverCap = true;
      }
    } else if (!keptPlace && this.prQueueLength() >= LOCAL_VERIFY_LIMITS.queueCap) {
      // A queue full of HELD entries must not refuse the repair that would release them: a
      // repair candidate is admitted past the cap while the hold is active. There is no
      // second cap: candidates past it are bounded only by the open PRs that touch, name
      // or revert the failing check, and each one is audited below.
      const hold = this.holdDecision();
      const repair = hold.active && repairVerdict({ files: prFiles, text: prText }, hold.failingFiles).candidate;
      // A merge-throughput PR gets a bounded overflow (LOCAL_VERIFY_LIMITS.throughputOverflow).
      // An ordinary PR that has waited THROUGHPUT_AGING_MS since its first refusal shares that
      // overflow, the rule effectivePriority already applies inside the queue: without it a steady
      // stream of labelled PRs keeps every ordinary waiter out for good (2026-11-13: PR 3108 waited
      // 18 h while ten labelled PRs opened after it were admitted).
      const agedWaiter = !replayPriority && !repair && requestedPriority !== QUEUE_PRIORITY.mergeThroughput
        && this.waiterAged(pr);
      const throughput = !replayPriority && !repair && (requestedPriority === QUEUE_PRIORITY.mergeThroughput || agedWaiter)
        && this.prQueueLength() < capFor(QUEUE_PRIORITY.mergeThroughput);
      if (!repair && !throughput) {
        // fb-7fde7f49-8ee: the refusal keeps a place in line (replays keep their own durable admission).
        const w = replayPriority ? null : this.waiting.refused(pr);
        this.audit({ event: 'queue-full', pr, ...(hold.active ? { mainRedHold: true } : {}),
          ...(w ? { firstRefusedAt: w.firstRefusedAt, refusals: w.refusals, waitPosition: this.waiting.liveAhead(pr).length + 1 } : {}) });
        return { ok: false, code: 'queue-full' };
      }
      if (repair) this.audit({ event: 'queue-full-repair-admitted', pr, headSha, redHead: hold.active ? hold.redHead : null });
      else this.audit({ event: 'queue-full-throughput-admitted', pr, headSha, ...(agedWaiter ? { agedWaiter: true } : {}) });
    } else if (!keptPlace && !replayPriority && !opts.rerunAfterGreen && requestedPriority !== QUEUE_PRIORITY.mergeThroughput) {
      // fb-7fde7f49-8ee: below the cap, the PRs refused earlier go first. Only LIVE waiters
      // (offered within WAITING_LIST_LIMITS.staleAfterMs) reserve a slot, only while `main` is
      // healthy, and never when nothing is queued — so a waiter that stops being offered or
      // eligible cannot hold a slot empty. A labelled throughput PR, a replay and the one-shot
      // red→green failure re-run are admitted exactly as before (nothing would offer the re-run
      // again); a repair needs a red `main`, when the list reserves nothing.
      const ahead = this.waitingAhead(pr);
      if (ahead.length > 0) {
        const w = this.waiting.refused(pr);
        this.audit({ event: 'queue-full-waiting', pr, firstRefusedAt: w.firstRefusedAt, refusals: w.refusals,
          waitPosition: ahead.length + 1, ahead: ahead.slice(0, 5).map((x) => x.pr), freeSlots: LOCAL_VERIFY_LIMITS.queueCap - this.prQueueLength() });
        return { ok: false, code: 'queue-full' };
      }
    }
    spendRerun?.();
    // Admitted: a waiter leaves the list and carries its first refusal onto the entry (a kept place carries its own).
    const waited = this.waiting.get(pr);
    const firstRefusedAt = keptPlace ? keptPlace.firstRefusedAt : (waited?.firstRefusedAt ?? opts.carry?.firstRefusedAt);
    // Time a change spent held is not waiting time (queue controls: a release carries it here).
    const carriedPausedMs = keptPlace ? keptPlace.pausedMs : opts.carry?.pausedMs;
    if (waited && !keptPlace) this.waiting.remove(pr, 'admitted');
    const entry: QueueEntry = {
      id: crypto.randomBytes(6).toString('hex'), pr, headSha, baseSha, baseRefName,
      ...(!explicit ? { preflightRediscoverable: true } : {}),
      firstQueuedAt: keptPlace?.firstQueuedAt ?? this.now(), attempts: 0, errorRetries: 0,
      starvedRaised: keptPlace?.starvedRaised ?? false, priority: requestedPriority, baseResolvedAt: this.now(),
      files: prFiles, text: prText,
      ...(carriedPausedMs ? { pausedMs: carriedPausedMs } : {}),
      ...(keptPlace?.resumeFirst ? { resumeFirst: true as const } : {}),
      ...(firstRefusedAt !== undefined ? { firstRefusedAt } : {}),
    };
    if (keptPlace && keptPlace.index < this.queue.length) this.queue.splice(keptPlace.index, 0, entry);
    else this.queue.push(entry);
    // The first-part trial's assignment is drawn once, here, when the pull request is first queued.
    this.firstPartGroups.assign(pr);
    if (operatorOverCap && operatorAdmit) {
      this.operator.markOverCap(pr);
      this.operator.persist();
      this.audit({ event: `${operatorAdmit}-admitted-over-cap`, pr, headSha, used: this.operatorOverflowUsed(), max: OPERATOR_QUEUE_LIMITS.overflow });
    }
    this.audit({ event: 'queued', pr, headSha, baseSha, explicit, ...(keptPlace ? { keptPlace: true, firstQueuedAt: entry.firstQueuedAt } : {}),
      ...(firstRefusedAt !== undefined ? { firstRefusedAt, refusedWaitMs: entry.firstQueuedAt - firstRefusedAt } : {}) });
    const position = this.queue.indexOf(entry);
    this.pump();
    return { ok: true, status: 'queued', position, ...this.holdFor(pr), ...(operatorOverCap ? { operatorOverCap: true as const } : {}) };
  }

  /**
   * A live waiting PR first refused at least THROUGHPUT_AGING_MS ago, with no older live aged
   * waiter ahead of it: it then shares the throughput overflow. Oldest first among aged waiters,
   * and a stale waiter (no longer offered) never counts. The wait outside the queue is not
   * reduced for update pauses, so it can only overcount: the PR reaches the overflow sooner.
   */
  private waiterAged(pr: number): boolean {
    const w = this.waiting.get(pr);
    const aged = (x: Waiter) => this.now() - x.firstRefusedAt >= THROUGHPUT_AGING_MS;
    return !!w && this.waiting.isLive(w) && aged(w) && !this.waiting.liveAhead(pr).some(aged);
  }

  /** A `recorded` answer: the PR has nothing left to queue for this head, so it leaves the waiting list. */
  private recordedAnswer(pr: number, record: LocalVerifyRecord): RequestResult {
    this.waiting.remove(pr, 'recorded');
    return { ok: true, status: 'recorded', record };
  }

  /**
   * The live waiters that must go before `pr` takes a free slot (fb-7fde7f49-8ee): empty when
   * `main` is not healthy (nothing is offered then) or nothing is queued (the verifier must
   * never sit idle for a reservation), or when there are more free slots than waiters ahead.
   */
  private waitingAhead(pr: number): Waiter[] {
    if (!this.health.isHealthy() || this.prQueueLength() === 0) return [];
    const ahead = this.waiting.liveAhead(pr);
    return ahead.length >= LOCAL_VERIFY_LIMITS.queueCap - this.prQueueLength() ? ahead : [];
  }

  /** Service tick: the waiting clock follows `main` health; idle waiters drop; closed or merged PRs leave (bounded batch). */
  private async tickWaitingList(): Promise<void> {
    this.waiting.setHealthy(this.health.isHealthy());
    this.waiting.tick();
    for (const pr of this.waiting.sweepBatch()) {
      if (this.stopped) return;
      const open = await this.seams.isPrOpen(pr).catch(() => null);
      if (open === false) { this.waiting.remove(pr, 'closed'); this.operatorOnClosed(pr); }
    }
  }

  /** The waiting list for the read surface (oldest first). */
  waitingList(): Array<Waiter & { live: boolean }> {
    return this.waiting.list();
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
    /** Resource-aware placement §4: a peer's fit for a full verify (heavy work). Absent ⇒ today's order, no filter. */
    peerFit?: ((machineId: string) => PeerFit) | null;
    /** `monitoring.localVerify.mainOnPeers`, read at each dispatch. */
    mainOnPeers?: (() => boolean) | null;
    /** SEC-113 D1, peer side: this machine's signer for peer answers. Absent ⇒ answers go out unsigned (and are refused). */
    signer?: MachineSigner | null;
    /** SEC-113 D1, coordinator side: builds an uncached pinned-key lookup per import. Absent ⇒ no peer is dispatchable. */
    keyLookupFactory?: (() => MachineKeyLookup) | null;
  }): void {
    if (o.signer !== undefined) this.peerSigner = o.signer;
    if (o.keyLookupFactory !== undefined) this.peerKeyLookupFactory = o.keyLookupFactory;
    if (o.mainOnPeers !== undefined) this.mainOnPeersEnabled = o.mainOnPeers;
    if (o.peerFit !== undefined) this.peerFitFn = o.peerFit;
    if (o.peerRoleEnabled !== undefined) this.peerRoleEnabled = o.peerRoleEnabled;
    if (o.peers !== undefined) this.peersSetting = o.peers;
    if (o.client !== undefined) this.peerClient = o.client;
    if (o.lease !== undefined) this.leaseView = o.lease;
  }

  isPeerOnly(): boolean { return this.cfg.peerOnly === true; }

  private mainOnPeersOn(): boolean {
    try { return this.mainOnPeersEnabled ? this.mainOnPeersEnabled() === true : false; } catch { return false; } // @silent-fallback-ok: an unreadable switch reads as off (main stays on the coordinator)
  }

  private peerRoleOn(): boolean {
    try { return this.peerRoleEnabled ? this.peerRoleEnabled() === true : false; } catch { return false; } // @silent-fallback-ok: an unreadable switch reads as off (no peer runs)
  }

  /**
   * Resource-aware placement §4: drop peers too small, too busy or unmeasurable for a
   * full verify, and try the rest least-loaded first. A skip is audited at most once
   * per peer per reason per PEER_SKIP_AUDIT_MS. Seam absent ⇒ the configured order.
   */
  private fitPeers(peers: PeerTarget[]): PeerTarget[] {
    const fitFn = this.peerFitFn;
    if (!fitFn || peers.length === 0) return peers;
    const now = this.now();
    const kept: Array<{ peer: PeerTarget; score: number; i: number }> = [];
    peers.forEach((peer, i) => {
      let fit: PeerFit;
      try { fit = fitFn(peer.machineId); } catch { fit = { eligible: true, reason: 'fit-unreadable', score: null }; } // @silent-fallback-ok: an unreadable fit keeps today's behaviour for that peer (no filter), never a silent drop
      this.noteMemory(peer.machineId, fit.eligible ? null : (fit.memoryReason ?? null), 'peer');
      if (fit.eligible) {
        kept.push({ peer, score: typeof fit.score === 'number' && Number.isFinite(fit.score) ? fit.score : Number.POSITIVE_INFINITY, i });
        return;
      }
      const key = `${peer.machineId}:${fit.reason}`;
      const last = this.peerSkipAudited.get(key) ?? 0;
      if (now - last >= PEER_SKIP_AUDIT_MS) {
        this.peerSkipAudited.set(key, now);
        this.audit({ event: 'peer-skipped-resource', machineId: peer.machineId, reason: fit.reason });
      }
    });
    kept.sort((a, b) => (a.score - b.score) || (a.i - b.i));
    return kept.map((k) => k.peer);
  }

  private configuredPeers(): PeerTarget[] {
    if (this.cfg.peerOnly) return [];
    let v: unknown = null;
    try { v = this.peersSetting ? this.peersSetting() : null; } catch { v = null; } // @silent-fallback-ok: an unreadable setting means no peers (local only)
    return parsePeers(v, this.cfg.machineId);
  }

  private leaseState(): { holds: boolean; epoch: number | null; holder: string | null; unreadable?: true } {
    if (!this.leaseView) return { holds: true, epoch: null, holder: this.cfg.machineId };
    try {
      return { holds: this.leaseView.holdsLease(), epoch: this.leaseView.leaseEpoch(), holder: this.leaseView.holderMachineId() };
    } catch {
      // `unreadable` lets the peer-trust holding check skip this read (SEC-113 D2.5); every other caller still sees "not held".
      return { holds: false, epoch: null, holder: null, unreadable: true }; // @silent-fallback-ok: an unreadable lease reads as not held (no dispatch, no import)
    }
  }

  // ── SEC-113 D2: how far a peer's main green is trusted (docs/specs/local-verify-peer-result-trust.md) ──

  private get peerTrustPath(): string { return path.join(this.lvStateDir, 'peer-trust.json'); }
  private trustState: PeerTrustState | null = null;
  /** Another holder seen on the previous readable read (two in a row count as lease loss). */
  private otherHolderSeen = false;

  private trust(): PeerTrustState {
    if (!this.trustState) this.trustState = readPeerTrust(this.peerTrustPath);
    return this.trustState;
  }

  private saveTrust(): void {
    try { writePeerTrust(this.peerTrustPath, this.trust()); } catch (e) {
      this.audit({ event: 'peer-trust-write-failed', detail: e instanceof Error ? e.message : String(e) });
    }
  }

  /**
   * Every tick, holding or not: is the trust state still this machine's unbroken holding? A restart
   * (epoch + 1) keeps it; another holder on two readable reads in a row, or an epoch gap of 2 or more,
   * is lease loss: the state is reset and open disagreement items resolve. An unreadable read decides nothing.
   */
  private checkTrustHolding(): void {
    const t = this.trust();
    const read = this.leaseState();
    const d = holdingDecision(t.holding, read, this.cfg.machineId);
    if (d === 'skip') return;
    if (d === 'not-held') { this.otherHolderSeen = false; return; }
    if (d === 'other-holder') {
      if (!this.otherHolderSeen) { this.otherHolderSeen = true; return; }
      this.otherHolderSeen = false;
      this.loseTrustHolding(read, 'another machine holds the lease');
      return;
    }
    this.otherHolderSeen = false;
    if (d === 'reset') { this.loseTrustHolding(read, 'restarted'); return; }
    if (!t.holding || t.holding.epoch !== read.epoch || t.holding.holder !== this.cfg.machineId) {
      t.holding = { holder: this.cfg.machineId, epoch: read.epoch };
      this.saveTrust();
    }
  }

  /** The `main` episode the corroboration trigger last fired for (one per head and clock episode). */
  private corroborationFiredFor: string | null = null;

  /**
   * SEC-113 D2.3 trigger: when the main commits only peers have checked reach the refresh age and no
   * main verify is queued or running, run the current head here. Once per (head, clock episode), only
   * while main is healthy or suspect for `unverified-too-long`, never past the error-retry cap. A red
   * head is left to the main-red flow.
   */
  private maybeEnqueueLocalCorroboration(): void {
    const t = this.trust();
    const head = this.mainObs.head;
    if (t.notLocallyVerifiedAt === null || head === null) return;
    const age = refreshAgeMs(t.durations, MAIN_HEALTH_LIMITS.unverifiedSuspectMs) ?? 2 * 60 * 60 * 1000;
    if (this.now() - t.notLocallyVerifiedAt <= Math.max(0, age)) return;
    const snap = this.health.snapshot();
    if (!(snap.state === 'healthy' || (snap.state === 'main-suspect' && snap.reason === 'unverified-too-long'))) return;
    const key = `${head}:${t.notLocallyVerifiedAt}`;
    if (this.corroborationFiredFor === key) return;
    if ((this.mainErrorRetries.get(head) ?? 0) > MAIN_VERIFY_LIMITS.errorRetries) return;
    if (this.queue.some((e) => e.kind === 'main') || this.inFlight?.entry.kind === 'main' || this.starting?.kind === 'main') return;
    this.corroborationFiredFor = key;
    this.audit({ event: 'main-local-corroboration', headSha: head, notLocallyVerifiedSinceMs: this.now() - t.notLocallyVerifiedAt });
    this.enqueueMain(head, 'head-changed');
  }

  /**
   * SEC-113 D2.4: peers that reported this exact head green (same verifier, same policy) are stopped
   * from serving `main` at once, then one arbitration attempt on another pinned peer settles it before
   * anyone is told. A red on any other head never counts against a peer.
   */
  private judgePeerDisagreement(head: string): void {
    const t = this.trust();
    const liars = peersGreenOn(t, head, this.cfg.verifierVersion, this.policyHash).filter((p) => !t.quarantine[p]);
    if (!liars.length) return;
    for (const p of liars) {
      t.quarantine[p] = { head, at: this.now(), arbitrated: false };
      this.audit({ event: 'peer-main-disagreement', peer: p, headSha: head });
    }
    this.saveTrust();
    // One arbitration at a time: the first disagreeing peer is arbitrated; every other one is told to the owner now.
    void this.startArbitration(liars[0]!, head).catch((e) => this.audit({ event: 'peer-arbitration-error', detail: e instanceof Error ? e.message : String(e) }));
    for (const p of liars.slice(1)) { t.quarantine[p]!.arbitrated = true; this.settleDisagreement(p, 'no-arbiter'); }
    if (liars.length > 1) this.saveTrust();
  }

  /** One arbitration per quarantine episode, on an idle, pinned, unquarantined peer; none available → the owner is told. */
  private async startArbitration(forPeer: string, head: string): Promise<void> {
    const t = this.trust();
    const q = t.quarantine[forPeer];
    if (!q || q.arbitrated || t.arbitration) return;
    q.arbitrated = true;
    this.saveTrust();
    const client = this.peerClient;
    const lease = this.leaseState();
    const candidates = this.configuredPeers().filter((p) => p.machineId !== forPeer && !t.quarantine[p.machineId]);
    for (const peer of client && lease.holds ? candidates : []) {
      const st = await client!.status(peer).catch(() => null);
      if (!st || st.inFlight || st.slotBusy || st.verifierVersion !== this.cfg.verifierVersion || st.policyHash !== this.policyHash) continue;
      if (!this.peerPinned(peer.machineId, st.signerKeyHash)) continue;
      const req: PeerRunRequest = {
        attemptId: crypto.randomBytes(16).toString('hex'), pr: MAIN_VERIFY_PR, headSha: head, baseSha: head, baseRefName: 'main',
        verifierVersion: this.cfg.verifierVersion, policyHash: this.policyHash, coordinatorMachineId: this.cfg.machineId, leaseEpoch: lease.epoch, kind: 'main-arbitration',
      };
      t.arbitration = { attemptId: req.attemptId, peer: peer.machineId, head, forPeer, requestDigest: requestDigest(req), sentAt: this.now() };
      this.saveTrust();
      const ans = await client!.run(peer, req).catch(() => null);
      if (ans && ans.ok) { this.audit({ event: 'peer-arbitration-sent', peer: peer.machineId, forPeer, headSha: head, attemptId: req.attemptId }); return; }
      t.arbitration = null;
      this.saveTrust();
    }
    this.settleDisagreement(forPeer, 'no-arbiter');
  }

  /** Coordinator, every poll: the one arbitration attempt (never a queue entry, never main health). */
  private async pollArbitration(): Promise<void> {
    const t = this.trust();
    const a = t.arbitration;
    if (!a || !this.peerClient) return;
    const peer = this.configuredPeers().find((p) => p.machineId === a.peer);
    const expired = this.now() - a.sentAt > PEER_LIMITS.maxRunMs;
    if (!peer || expired) { t.arbitration = null; this.saveTrust(); this.settleDisagreement(a.forPeer, 'no-arbiter'); return; }
    const res = await this.peerClient.result(peer, a.attemptId).catch(() => null);
    if (!res || res.state !== 'done') return;
    t.arbitration = null;
    this.saveTrust();
    const r = res.record;
    const shapeOk = r.kind === 'main' && r.headSha === a.head && r.attempt?.id === a.attemptId && r.machineId === a.peer
      && r.verifierVersion === this.cfg.verifierVersion && r.policyHash === this.policyHash;
    const unverified = shapeOk ? this.peerResultUnverified(res, { requestDigest: a.requestDigest } as RemoteMarker, a.peer) : 'request-mismatch';
    if (unverified || r.outcome === 'error') {
      this.audit({ event: 'peer-arbitration-unusable', peer: a.peer, attemptId: a.attemptId, reason: unverified ?? 'error' });
      this.settleDisagreement(a.forPeer, 'no-arbiter');
      return;
    }
    this.audit({ event: 'peer-arbitration-result', peer: a.peer, forPeer: a.forPeer, attemptId: a.attemptId, outcome: r.outcome });
    if (r.outcome === 'success') this.settleDisagreement(a.forPeer, 'third-machine-green', a.peer, a.attemptId);
    else this.settleDisagreement(a.forPeer, 'third-machine-red');
  }

  private settleDisagreement(peer: string, how: 'no-arbiter' | 'third-machine-red' | 'third-machine-green', arbiter?: string, attemptId?: string): void {
    const t = this.trust();
    const q = t.quarantine[peer];
    if (!q) return;
    if (how === 'third-machine-green') {
      // A peer vouching for a peer: lifts the quarantine (restoring P's bounded authority), never main health.
      delete t.quarantine[peer];
      this.saveTrust();
      this.audit({ event: 'peer-main-disagreement-cleared', peer, reason: how, arbiter, attemptId });
      return;
    }
    const holder = this.cfg.machineId;
    this.seams.signal?.(`local-verify:peer-main-disagreement:${peer}`, {
      peer, headSha: q.head, how,
      note: `${peer} said the main code passed its tests, but the same code fails on ${holder}. ${peer} no longer tests main until you clear it; other helper machines still can. To change that, open ${holder}'s console, go to Work, then Development, and on the card "A helper machine no longer tests main" tap "Let it test main again".`,
    });
  }

  /** SEC-113 D2.5: the owner clears a quarantine (the route checks the operator session). */
  clearMainQuarantine(machineId: string, by: 'owner'): { cleared: boolean } {
    const t = this.trust();
    if (!t.quarantine[machineId]) return { cleared: false };
    delete t.quarantine[machineId];
    if (t.arbitration?.forPeer === machineId) t.arbitration = null;
    this.saveTrust();
    this.audit({ event: 'peer-main-quarantine-cleared', peer: machineId, by });
    try { this.seams.clearSignal?.(`local-verify:peer-main-disagreement:${machineId}`, 'cleared by the owner'); } catch { /* @silent-fallback-ok: the attention item's own lifecycle still closes it */ }
    return { cleared: true };
  }

  private loseTrustHolding(read: { epoch: number | null; holder: string | null }, why: 'another machine holds the lease' | 'restarted'): void {
    const t = this.trust();
    const quarantined = Object.keys(t.quarantine);
    this.audit({ event: 'peer-trust-holding-lost', why, epoch: read.epoch, holder: read.holder, quarantined });
    for (const peer of quarantined) {
      try {
        this.seams.clearSignal?.(`local-verify:peer-main-disagreement:${peer}`, why === 'restarted'
          ? `Main checks restarted on ${this.cfg.machineId}.`
          : 'This machine no longer runs the tests; the machine that took over checks main itself first.');
      } catch { /* @silent-fallback-ok: the attention item's own lifecycle still closes it */ }
    }
    this.trustState = resetHoldingState(t, read.holder === this.cfg.machineId ? { holder: this.cfg.machineId, epoch: read.epoch } : null);
    this.saveTrust();
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
    // Short of memory: back-pressure (the coordinator offers the PR again later or elsewhere).
    // Its own heartbeat already says so; this catches a coordinator reading an older report.
    const mem = this.selfMemory();
    if (mem) { this.audit({ event: 'peer-run-memory', attemptId: req.attemptId, pr: req.pr, reason: mem }); return refuse('peer-busy'); }
    // A pending update waiting on this verifier must not gain a new restart hold.
    // Treat it as backpressure so the coordinator can offer the PR again later.
    if (this.notePause()) return refuse('peer-busy');
    if (req.verifierVersion !== this.cfg.verifierVersion || req.policyHash !== this.policyHash || this.verifierChangedOnDisk()) return refuse('verifier-mismatch');
    if ((req.kind === 'main' || req.kind === 'main-arbitration')) {
      // A `main` verify has no PR to read. The head must be code `main` already contains:
      // its head as read now, or a recent ancestor (the commit under a release commit).
      const contained = await this.mainContains(req.headSha);
      if (contained === null) return refuse('pr-unreadable');
      if (!contained) return refuse('head-moved');
    } else {
      const view = await this.seams.prView(req.pr).catch(() => null);
      if (!view) return refuse('pr-unreadable');
      if (!checkEligibility(view, this.logins()).eligible) return refuse('untrusted-head');
      if (view.headRefOid !== req.headSha || view.baseRefName !== req.baseRefName) return refuse('head-moved');
    }
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
      ...((req.kind === 'main' || req.kind === 'main-arbitration') ? { kind: 'main' as const } : {}),
      peerAttempt: { id: req.attemptId, coordinatorMachineId: req.coordinatorMachineId, leaseEpoch: req.leaseEpoch },
      ...(req.preflightRediscoverable === true ? { preflightRediscoverable: true } : {}),
      ...(req.isolation ? { peerIsolation: req.isolation } : {}),
      ...(req.likelyFailing ? { peerLikelyFailing: req.likelyFailing } : {}),
      ...(req.firstPartGroup ? { peerFirstPartGroup: req.firstPartGroup } : {}),
    };
    this.peerState.current = { attemptId: req.attemptId, pr: req.pr, headSha: req.headSha, state: 'running', acceptedAt: this.now(), requestDigest: requestDigest(req) };
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

  /**
   * Peer side: does `main` contain `sha`? True when it is main's head as read now, one of the
   * few commits directly under it (a release commit sits on top of the verified head), or an
   * ancestor in this machine's clone. Null when main cannot be read.
   */
  private async mainContains(sha: string): Promise<boolean | null> {
    const head = this.seams.baseHead ? await this.seams.baseHead('main').catch(() => null) : null;
    if (!head || !isValidSha(head)) return null;
    if (head === sha) return true;
    let cur = head;
    for (let n = 0; n < 2 && this.seams.commitInfo; n++) { // bounded: the coordinator's request waits seconds, not minutes
      const info = await this.seams.commitInfo(cur).catch(() => null);
      const parent = info?.parents[0];
      if (!parent) break;
      if (parent === sha) return true;
      cur = parent;
    }
    const anc = this.seams.isAncestor ? await this.seams.isAncestor(sha, head).catch(() => null) : null;
    return anc === true;
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
      ...(this.peerSignerKeyHash() ? { signerKeyHash: this.peerSignerKeyHash()! } : {}),
    };
  }

  private peerSignerKeyHash(): string | null {
    try { return this.peerSigner ? this.peerSigner.signerKeyHash() : null; } catch { return null; } // @silent-fallback-ok — the hint is optional; a missing one only skips the coordinator's pre-check
  }

  /** Peer side: `GET /local-verify/peer-result`. */
  peerResult(attemptId: string): PeerResult {
    const cur = this.peerState.current;
    if (cur && cur.attemptId === attemptId) return cur.state === 'done' && cur.record ? this.signedPeerAnswer(cur.record, cur.run, cur.requestDigest) : { state: 'running' };
    const done = this.peerState.results.find((r) => r.attemptId === attemptId);
    return done ? this.signedPeerAnswer(done.record, done.run, done.requestDigest) : { state: 'unknown' };
  }

  /**
   * A finished peer answer, signed with this machine's key over the request it ran and the result
   * (SEC-113 D1). With no signer or no stored request digest the answer goes out unsigned, and the
   * coordinator refuses it (`unsigned`) and runs the verify itself.
   */
  private signedPeerAnswer(record: LocalVerifyRecord, run: PeerMainRun | undefined, digest: string | undefined): PeerResult {
    const body = { record, ...(run ? { run } : {}) };
    if (!this.peerSigner || !digest) return { state: 'done', ...body };
    try {
      return { state: 'done', ...body, requestDigest: digest, sig: signPeerResult(this.peerSigner, { record, run, requestDigest: digest }) };
    } catch (e) {
      this.audit({ event: 'peer-result-sign-failed', detail: e instanceof Error ? e.message : String(e) });
      return { state: 'done', ...body }; // @silent-fallback-ok — audited above; an unsigned answer is refused by the coordinator, which then runs the verify itself
    }
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
  private finishPeerAttempt(f: Pick<InFlight, 'entry' | 'cancelled' | 'runInput'> & { token?: string }, result: VerifyRunResult | null | { kind: 'crash' | 'invalid' } | unknown): void {
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
      // Only this made-up record takes the evidence known at the start. A real record that came
      // back without the field stays without it, so it reads as unknown, never as "no first parts".
      if (record.kind !== 'main' && f.runInput?.firstPartEvidence) record.firstPart = f.runInput.firstPartEvidence;
    }
    this.noteFirstPart(f, { ...(r ?? {}), kind: 'record', record });
    // A red `main` run also hands over which files failed: the record itself may not carry them.
    const mainRun = record.kind === 'main' && record.outcome === 'failure' && r && r.kind === 'record' ? parsePeerMainRun(r) : undefined;
    cur.state = 'done';
    cur.record = record;
    if (mainRun) cur.run = mainRun;
    this.peerState.results = [...this.peerState.results.filter((x) => x.attemptId !== id), { attemptId: id, record, ...(mainRun ? { run: mainRun } : {}), ...(cur.requestDigest ? { requestDigest: cur.requestDigest } : {}) }].slice(-PEER_RESULTS_KEPT);
    this.persistPeerState();
    this.audit({ event: 'peer-attempt-done', attemptId: id, pr: record.pr, outcome: record.outcome });
    // Why it went red, in THIS machine's audit log. The coordinator imports only the record, so
    // until now a peer failure named no file on either machine: "unit 65,816 passed / 0 failed,
    // failure" could not be told apart from a real fault (2026-11-13: PRs 3139, 3096, 3133).
    if (record.outcome !== 'success' || record.flakyRetried) {
      const run = r && r.kind === 'record' ? r as { reasons?: string[]; failures?: FailureDetail[]; isolationRefusals?: IsolationRefusals } : undefined;
      this.audit({ event: 'run-detail', source: 'peer-run', attemptId: id, ...runDetail(record, { ...run, ...(f.token ? { runLog: `${f.token}.log` } : {}) }) });
    }
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
    // One `main` verify at a time, on either host: never beside one running here or on a peer.
    // A peer is offered `main` only while the switch is on and main is healthy: a peer can make
    // main suspect, never red (the confirming re-run and every run while suspect or red are the
    // coordinator's own).
    if (e.kind === 'main' && (!this.mainOnPeersOn() || !this.health.isHealthy())) return false;
    // SEC-113 D2.3: no local anchor, no measurement, or main commits only peers have checked past the
    // refresh age: `main` runs here, so a peer's green can never carry main past the 3 h bound alone.
    if (e.kind === 'main' && !peerMainRoutingAllowed(this.trust(), this.now(), MAIN_HEALTH_LIMITS.unverifiedSuspectMs).allowed) return false;
    if (e.kind === 'main' && (this.inFlight?.entry.kind === 'main' || this.starting?.kind === 'main' || this.remoteMain())) return false;
    return !e.remote && !e.peerAttempt && e !== this.dispatching && e !== this.starting && this.inFlight?.entry !== e
      && !heldPrs.has(e.pr) && (e.remoteAttempts ?? 0) < PEER_LIMITS.maxAttemptsPerEntry && !(e.notBefore && e.notBefore > this.now())
      // Queue controls: a change the operator holds is never handed to a peer.
      && !(e.kind !== 'main' && this.operatorHeld(e.pr));
  }

  /* @self-action-controller: local-verify-peer-dispatch */
  private async dispatchOnce(): Promise<void> {
    if (this.dispatchRunning) return;
    const peers = this.fitPeers(this.configuredPeers());
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
      // `repicks`: how often a reservation gave way to a newer choice in this pass (queue controls; bounded).
      for (let pi = 0, repicks = 0; pi < peers.length; pi++) {
        const peer = peers[pi];
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
        this.notePeerSkew(peer.machineId, h);
        if (!st || st.inFlight || st.slotBusy || st.verifierVersion !== this.cfg.verifierVersion || st.policyHash !== this.policyHash) continue;
        if (!this.peerPinned(peer.machineId, st.signerKeyHash)) continue; // SEC-113 D1: never burn a run whose answer could not be verified
        // The choice for this peer: the same order and the same turn rule as the local slot.
        // `null` = nothing to hand off; 'skip-peer' = this peer is offered nothing now.
        const pick = (): QueueEntry | null | 'skip-peer' => {
          this.sweepOperatorHeld(); // a queue entry of a held change goes to held before anything is chosen
          const hold = this.holdDecision();
          const held = new Set(hold.active ? hold.heldPrs.map((x) => x.pr) : []);
          const sorted = this.orderQueue([...this.queue], this.now());
          let chosen = sorted.find((e) => this.dispatchable(e, held));
          if (!chosen) return null;
          if (chosen.kind === 'main') {
            // A free peer takes `main` under the same fair share as the local slot (never by
            // priority alone, which would hand it every opening and starve the waiting PRs).
            const pr = sorted.find((e) => e.kind !== 'main' && this.dispatchable(e, held));
            const turn = pr ? decideStart({ foreignHolders: 0, queue: [chosen, pr], now: this.now(), fairShare: this.fairShareState() }) : null;
            // A peer that keeps failing to confirm main's head is offered PRs only, for a while.
            // SEC-113 D2.4: a quarantined peer is never sent `main` (it still takes PRs).
            const paused = (this.mainUnconfirmed.get(peer.machineId)?.pausedUntil ?? 0) > this.now() || !!this.trust().quarantine[peer.machineId];
            if (pr && (paused || (turn && turn.kind === 'start' && turn.index === 1))) chosen = pr;
            else if (paused) return 'skip-peer';
          }
          return chosen;
        };
        const picked = pick();
        if (picked === null) return;
        if (picked === 'skip-peer') continue;
        const entry: QueueEntry = picked;
        // Today's base first: the same conditional refresh a local start uses.
        if (entry.kind !== 'main' && decideBaseRefresh(entry, { now: this.now(), mainMovedAt: this.mainMovedAt })) {
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
            this.operatorOnClosed(entry.pr);
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
        // Queue controls, the moment of decision: the choice is made again here, at the point of
        // reserving, with no further wait. A change fronted during the base read now ranks first,
        // so the entry picked before it gives way and this peer is offered the new choice.
        if (this.queueControlsOn() && pick() !== entry) {
          if (repicks++ < 3) pi--;
          continue;
        }
        // The head is fixed here, before the snapshot: a reserved entry is never retargeted.
        if (entry.kind === 'main') this.retargetStaleMain(entry);
        // Computed ONCE, before the marker exists: the list that is sent is the list the marker remembers.
        const iso = entry.kind === 'main' ? null : this.isolationInput();
        const marker: RemoteMarker = {
          machineId: peer.machineId, attemptId: crypto.randomBytes(16).toString('hex'), leaseEpoch: lease.epoch,
          sentAt: this.now(), state: 'sending',
          dispatched: { pr: entry.pr, headSha: entry.headSha, baseSha: entry.baseSha, baseRefName: entry.baseRefName, verifierVersion: this.cfg.verifierVersion, policyHash: this.policyHash,
            ...(entry.kind === 'main' ? { kind: 'main' as const } : {}) },
          // Files and test names only (no failure lines): what a returned import-related clear is checked against.
          ...(iso && iso.flakyOnMain.length > 0 ? { offeredFlakyOnMain: iso.flakyOnMain.map((f) => ({ file: f.file, tests: f.tests.map((t) => t.test) })) } : {}),
        };
        const isMain = entry.kind === 'main';
        const req: PeerRunRequest = {
          attemptId: marker.attemptId, ...marker.dispatched, coordinatorMachineId: this.cfg.machineId, leaseEpoch: marker.leaseEpoch,
          ...(iso ? { isolation: { allowed: iso.allowed, notCleanOnGreenMain: [...iso.notCleanOnGreenMain], importRelatedRerun: iso.importRelatedRerun, flakyOnMain: iso.flakyOnMain } } : {}),
          ...(entry.preflightRediscoverable === true ? { preflightRediscoverable: true } : {}),
          ...(isMain ? {} : this.firstPartWire(entry.pr)),
        };
        // SEC-113 D1: the digest of exactly what is sent; the peer signs it back with its answer.
        marker.requestDigest = requestDigest(req);
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
        this.audit({ event: 'peer-dispatch', pr: entry.pr, headSha: entry.headSha, baseSha: entry.baseSha, peer: peer.machineId, attemptId: marker.attemptId, attempt: entry.remoteAttempts,
          ...(entry.kind === 'main' ? { kind: 'main' } : {}) });
        if (isMain) {
          // What a local start records (see start()): it covers every merge up to now only if it
          // runs main's head as observed now. (`lastStartWasMain` matters only while main is not
          // healthy, and then a peer is never offered main.)
          const curHead = this.mainObs.head;
          this.mainRunOnCurrentHead = curHead !== null && (entry.headSha === curHead || this.releaseAlias.get(curHead) === entry.headSha) ? entry.headSha : null;
        }
        const ans = await client.run(peer, req).catch(() => null);
        if (entry.remote !== marker) continue; // abandoned meanwhile
        if (ans === null) {
          this.audit({ event: 'peer-dispatch-unanswered', pr: entry.pr, peer: peer.machineId, attemptId: marker.attemptId });
        } else if (ans.ok) {
          marker.state = 'accepted';
          this.remoteLastOkAt.set(marker.attemptId, this.now()); // the accept was a successful round trip
          this.audit({ event: 'peer-dispatch-accepted', pr: entry.pr, peer: peer.machineId, attemptId: marker.attemptId });
          if (isMain) {
            const raised = this.mainUnconfirmed.get(peer.machineId)?.raised;
            this.mainUnconfirmed.delete(peer.machineId);
            if (raised) { try { this.seams.clearSignal?.(`local-verify:peer-main-unconfirmed:${peer.machineId}`, 'the peer accepted a main verify again'); } catch { /* @silent-fallback-ok: the attention item's own lifecycle still closes it */ } }
          }
          this.writePeerHold(); // a restart requested before the next tick must already see this attempt
        } else if (ans.reason === 'peer-busy') {
          // Backpressure, not a failure: the attempt does not count and the breaker is untouched.
          entry.remote = undefined;
          entry.remoteAttempts = Math.max(0, (entry.remoteAttempts ?? 1) - 1);
          h.statusAt = 0;
          this.audit({ event: 'peer-dispatch-busy', pr: entry.pr, peer: peer.machineId });
        } else {
          entry.remote = undefined;
          this.audit({ event: 'peer-dispatch-refused', pr: entry.pr, peer: peer.machineId, attemptId: marker.attemptId, reason: ans.reason });
          // The peer could not confirm `main` contains this head (its own read of main, a clone
          // that lacks the commit): the attempt is spent, but that says nothing about its health.
          if (!(isMain && (ans.reason === 'head-moved' || ans.reason === 'pr-unreadable'))) this.peerFailure(peer, h, `refused:${ans.reason}`);
          else this.noteMainUnconfirmed(peer, ans.reason);
        }
        this.persistQueue();
        this.reconcileSuitePriority();
      }
    } finally {
      this.dispatchRunning = false;
    }
  }

  /**
   * SEC-113 D1: why a done peer answer's signature does not hold, or null when it does. Checked on
   * the raw body as received, against the digest stored on the marker, with a fresh pinned-key
   * lookup (no cache, so a revocation counts at once) at this machine's receive time.
   */
  private peerResultUnverified(res: Extract<PeerResult, { state: 'done' }>, m: RemoteMarker, peerMachineId: string): PeerResultRefusal | null {
    if (!this.peerKeyLookupFactory || !m.requestDigest) return 'unsigned';
    const raw = res.raw ?? { record: res.record, run: res.run, requestDigest: res.requestDigest, sig: res.sig };
    try {
      return verifyPeerResult(raw, { peerMachineId, requestDigest: m.requestDigest }, this.peerKeyLookupFactory(), this.now());
    } catch {
      return 'signature-unknown-key'; // @silent-fallback-ok — an unreadable key history is "could not check": refused, audited by the caller
    }
  }

  /**
   * SEC-113 D1, before dispatch: this coordinator holds a current pinned key for the peer that
   * matches the key the peer says it signs with. A local fact (the hint only names which pin to
   * check), so an unpaired or rotated peer is skipped instead of costing a wasted run.
   */
  private peerPinned(machineId: string, signerKeyHash: string | undefined): boolean {
    const why = !this.peerKeyLookupFactory ? 'no-key-lookup'
      : !signerKeyHash ? 'no-key-hint'
        : (() => { try { return this.peerKeyLookupFactory!()(machineId, signerKeyHash, this.now()).status === 'ok' ? null : 'not-pinned'; } catch { return 'key-history-unreadable'; } })(); // @silent-fallback-ok — unreadable history skips the peer (the safe direction), audited below
    if (!why) return true;
    if (!this.peerUnpinnedAudited.has(machineId)) {
      this.peerUnpinnedAudited.add(machineId);
      this.audit({ event: why === 'no-key-lookup' ? 'peer-verify-unavailable' : 'peer-unpinned', peer: machineId, reason: why });
    }
    return false;
  }

  /** SEC-113 D1: a failed signature or request check opens the peer's breaker at once and raises one deduped item. */
  private notePeerResultTampered(peer: PeerTarget, h: PeerHealth, why: PeerResultRefusal): void {
    h.consecutiveFailures = 0;
    h.openUntil = this.now() + PEER_LIMITS.breakerOpenMs;
    this.peerHealth.set(peer.machineId, h);
    this.audit({ event: 'peer-breaker-open', peer: peer.machineId, why: `unverified:${why}`, untilMs: h.openUntil });
    this.peerResultTampered.add(peer.machineId);
    this.peerResultTamperedCleared.delete(peer.machineId);
    this.seams.signal?.(`local-verify:peer-result-unverified:${peer.machineId}`, {
      peer: peer.machineId, why,
      note: `A test result from ${peer.machineId} failed its check, so that verify ran on this machine instead.`,
    });
  }

  /** SEC-113 D1: the next verified answer from that peer closes its item. */
  private clearPeerResultTampered(machineId: string): void {
    // Not gated on this process having raised it: an item raised before a restart still closes here.
    if (!this.peerResultTampered.delete(machineId) && this.peerResultTamperedCleared.has(machineId)) return;
    this.peerResultTamperedCleared.add(machineId);
    try { this.seams.clearSignal?.(`local-verify:peer-result-unverified:${machineId}`, 'the peer sent a verified result again'); } catch { /* @silent-fallback-ok: the attention item's own lifecycle still closes it */ }
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
    this.remoteLastOkAt.delete(m.attemptId);
    this.remoteMisses.delete(m.attemptId);
    this.endPeerHold(m.attemptId, 'abandoned');
    this.audit({ event: 'peer-attempt-abandoned', pr: entry.pr, peer: m.machineId, attemptId: m.attemptId, reason });
    this.writePeerHold(); // this attempt must stop holding a restart now, not on the next tick
    const peer = this.configuredPeers().find((p) => p.machineId === m.machineId);
    if (o.cancel && peer && this.peerClient) void this.peerClient.cancel(peer, m.attemptId).catch(() => undefined);
    if (o.failure && peer) {
      const h = this.peerHealth.get(peer.machineId) ?? { consecutiveFailures: 0, openUntil: null, status: null, statusAt: 0 };
      this.peerHealth.set(peer.machineId, h);
      this.peerFailure(peer, h, reason);
    }
    // A `main` entry that comes back unreserved beside a newer pending one is covered by it.
    if (entry.kind === 'main' && this.queue.includes(entry) && this.queue.some((e) => e !== entry && e.kind === 'main' && !e.remote)) {
      this.queue.splice(this.queue.indexOf(entry), 1);
      this.audit({ event: 'main-replaced', oldHead: entry.headSha, newHead: this.queue.find((e) => e.kind === 'main' && !e.remote)!.headSha, why: 'peer-attempt-abandoned' });
    }
    this.persistQueue();
  }

  /**
   * Coordinator: a peer refused a `main` request because it could not confirm main contains the
   * head. Not a health failure, but never silent: after `mainUnconfirmedLimit` in a row the peer
   * is offered no `main` verify for `mainUnconfirmedPauseMs`, with one deduped signal.
   */
  private noteMainUnconfirmed(peer: PeerTarget, reason: string): void {
    const s = this.mainUnconfirmed.get(peer.machineId) ?? { count: 0, pausedUntil: 0 };
    s.count += 1;
    if (s.count >= PEER_LIMITS.mainUnconfirmedLimit) {
      s.count = 0;
      s.pausedUntil = this.now() + PEER_LIMITS.mainUnconfirmedPauseMs;
      s.raised = true;
      this.audit({ event: 'peer-main-paused', peer: peer.machineId, reason, untilMs: s.pausedUntil });
      try { this.seams.signal?.(`local-verify:peer-main-unconfirmed:${peer.machineId}`, {
        peer: peer.machineId, reason, until: new Date(s.pausedUntil).toISOString(),
        note: `The peer verifier ${peer.machineId} could not confirm that main contains the head it was asked to verify, ${PEER_LIMITS.mainUnconfirmedLimit} times in a row (last: ${reason}). It is offered no main verify for ${Math.round(PEER_LIMITS.mainUnconfirmedPauseMs / 60_000)} minutes; this machine runs them. Check the peer's GitHub read and its clone.`,
      }); } catch { /* @silent-fallback-ok: the audit row above still records the pause */ }
    }
    this.mainUnconfirmed.set(peer.machineId, s);
  }

  /** Coordinator: the `main` verify a peer is running for this machine, if any. */
  private remoteMain(): QueueEntry | undefined {
    return this.queue.find((e) => e.kind === 'main' && !!e.remote);
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
        if (res && res.state !== 'unknown') this.remoteLastOkAt.set(m.attemptId, this.now());
        if (!this.queue.includes(entry)) {
          this.abandonRemote(entry, 'entry-no-longer-queued', { failure: false, cancel: true });
          continue;
        }
        const age = this.now() - m.sentAt;
        const h = this.peerHealth.get(peer.machineId) ?? { consecutiveFailures: 0, openUntil: null, status: null, statusAt: 0 };
        this.peerHealth.set(peer.machineId, h);
        // Main stopped being healthy while the peer holds its verify: the verdict would not be
        // taken (see the import below), so the run is ended now and the coordinator runs it.
        if (entry.kind === 'main' && !this.health.isHealthy() && !(res && res.state === 'done')) {
          this.audit({ event: 'peer-main-unjudged', peer: peer.machineId, attemptId: m.attemptId, headSha: entry.headSha, outcome: null, state: this.health.snapshot().state });
          this.abandonRemote(entry, 'main-not-healthy', { failure: false, cancel: true });
          continue;
        }
        // A `main` reservation blocks every other `main` verify: a peer that stopped answering
        // gives it back within minutes, never at the run bound.
        // Two unanswered polls in a row, so one miss after this machine itself was paused never ends a healthy run.
        const misses = res === null || res.state === 'unknown' ? (this.remoteMisses.get(m.attemptId) ?? 0) + 1 : 0;
        if (misses > 0) this.remoteMisses.set(m.attemptId, misses); else this.remoteMisses.delete(m.attemptId);
        if (entry.kind === 'main' && misses >= 2
          && this.now() - Math.max(this.remoteLastOkAt.get(m.attemptId) ?? m.sentAt, this.queueRestoredAt) > PEER_LIMITS.mainSilentMs) {
          this.abandonRemote(entry, 'main-peer-silent', { failure: true, cancel: true });
          continue;
        }
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
          // A version or policy skew (an attempt that spans an upgrade) is not the peer's fault (SEC-113 D1).
          const skew = why === 'verifier-mismatch' || why === 'policy-mismatch';
          this.abandonRemote(entry, `rejected:${why}`, { failure: !skew, cancel: false });
          continue;
        }
        // SEC-113 D1: the signature is checked AFTER the field checks, on the raw body as received,
        // with the coordinator's receive time and a fresh (uncached) pinned-key lookup.
        const unverified = this.peerResultUnverified(res, m, peer.machineId);
        if (unverified) {
          this.audit({ event: 'peer-result-unverified', pr: entry.pr, peer: peer.machineId, attemptId: m.attemptId, reason: unverified });
          this.peerLastRefusal.set(peer.machineId, unverified);
          entry.remoteAttempts = PEER_LIMITS.maxAttemptsPerEntry; // the entry runs here, never on another peer
          this.abandonRemote(entry, `unverified:${unverified}`, { failure: true, cancel: false });
          if (unverified === 'signature-bad' || unverified === 'request-mismatch') this.notePeerResultTampered(peer, h, unverified);
          continue;
        }
        this.clearPeerResultTampered(peer.machineId);
        if (res.record.outcome === 'error') {
          this.audit({ event: 'peer-record-error', pr: entry.pr, peer: peer.machineId, attemptId: m.attemptId, errorStep: res.record.errorStep });
          if (this.preflightErrorNeedsBypass(res.record.errorStep)) entry.preflightBypassRetry = true;
          // A merge conflict belongs to this PR/base pair. It says nothing about the
          // peer's health, and counting it can open the breaker on a healthy host.
          const peerFault = res.record.errorStep !== 'conflict';
          this.abandonRemote(entry, peerFault ? 'peer-error' : 'merge-conflict', { failure: peerFault, cancel: false });
          continue;
        }
        if (entry.kind === 'main' && !this.health.isHealthy()) {
          // Main stopped being healthy while the peer ran (an unverified-too-long suspect, a lease
          // or boot state): its verdict is not taken. The entry comes back and, not being
          // dispatchable while unhealthy, runs here. Only the coordinator's own run judges then.
          noteSuccess(h);
          this.audit({ event: 'peer-main-unjudged', peer: peer.machineId, attemptId: m.attemptId, headSha: entry.headSha, outcome: res.record.outcome, state: this.health.snapshot().state });
          this.abandonRemote(entry, 'main-not-healthy-at-import', { failure: false, cancel: false });
          continue;
        }
        // Import: the one completion path, then the entry leaves the queue.
        noteSuccess(h);
        entry.remote = undefined;
        this.remotePolledAt.delete(m.attemptId);
        this.remoteLastOkAt.delete(m.attemptId);
        this.remoteMisses.delete(m.attemptId);
        this.endPeerHold(m.attemptId, 'imported');
        const i = this.queue.indexOf(entry);
        if (i >= 0) this.queue.splice(i, 1);
        this.audit({ event: 'peer-imported', pr: entry.pr, peer: peer.machineId, attemptId: m.attemptId, outcome: res.record.outcome });
        if (entry.kind === 'main') {
          // A `main` verify feeds main health only (never the PR index, the journal or the merge line).
          this.completeMain(res.record, entry, res.run, m.sentAt, 'peer');
        } else {
          // SEC-113 D2.1: a peer record is imported, but its flaky list is not taken into flaky history.
          this.complete(res.record, 'peer');
        }
        this.persistQueue();
        this.writePeerHold(); // the restart this attempt held need not wait for the next tick
      }
    } finally {
      this.pollRunning = false;
    }
    this.pump();
  }

  /**
   * Signal only: a peer on a different verifier or policy never receives work, and that skip
   * used to leave no trace. One audit row per change of the peer's versions, one when it ends.
   */
  private notePeerSkew(machineId: string, h: PeerHealth): void {
    const st = h.status;
    if (!st) return;
    const skewed = st.verifierVersion !== this.cfg.verifierVersion || st.policyHash !== this.policyHash;
    const key = skewed ? `${st.verifierVersion}|${st.policyHash}|${this.cfg.verifierVersion}|${this.policyHash}` : null;
    if (key === (h.skewKey ?? null)) return;
    const was = h.skewKey ?? null;
    h.skewKey = key;
    if (key) {
      this.audit({ event: 'peer-skipped-skew', peer: machineId, peerVerifierVersion: st.verifierVersion, verifierVersion: this.cfg.verifierVersion, policyMatches: st.policyHash === this.policyHash });
    } else if (was) {
      this.audit({ event: 'peer-skew-cleared', peer: machineId, verifierVersion: this.cfg.verifierVersion });
    }
  }

  /** Coordinator view of the peers for `GET /local-verify`. */
  peersInfo(): { configured: Array<{ machineId: string; healthy: boolean; status: PeerStatus | null; consecutiveFailures: number; openUntil: string | null }>; reserved: Array<{ pr: number; peer: string; attemptId: string; state: string; sentAt: string }>; trust: ReturnType<LocalVerifyService['peerTrustInfo']> } {
    const now = this.now();
    return {
      configured: this.configuredPeers().map((p) => {
        const h = this.peerHealth.get(p.machineId);
        return { machineId: p.machineId, healthy: peerHealthy(h, now), status: h?.status ?? null, consecutiveFailures: h?.consecutiveFailures ?? 0, openUntil: h?.openUntil ? new Date(h.openUntil).toISOString() : null };
      }),
      reserved: this.queue.filter((e) => e.remote).map((e) => ({ pr: e.pr, peer: e.remote!.machineId, attemptId: e.remote!.attemptId, state: e.remote!.state, sentAt: new Date(e.remote!.sentAt).toISOString() })),
      trust: this.peerTrustInfo(),
    };
  }

  /**
   * SEC-113: what the owner (and the console's Testing tile) can see about peer trust: per peer,
   * whether its key is pinned here, whether it is kept off `main`, and its last refused answer; plus
   * this machine's own anchor, how long main has gone without its own check, and how often `main`
   * was kept here (`mainKeptLocal`), so the offload `mainOnPeers` buys is measured, not assumed.
   */
  peerTrustInfo(): { localAnchor: { headSha: string; ageMs: number } | null; notLocallyVerifiedSinceMs: number | null; refreshAgeMs: number | null; mainKeptLocal: number;
    peers: Array<{ machineId: string; pinned: boolean; mainQuarantined: { headSha: string; at: string } | null; lastRefusal: string | null }> } {
    const now = this.now();
    const t = this.cfg.peerOnly ? null : this.trust();
    const anchorAt = t?.anchor ? Date.parse(t.anchor.finishedAt) : NaN;
    return {
      localAnchor: t?.anchor ? { headSha: t.anchor.head, ageMs: Number.isFinite(anchorAt) ? Math.max(0, now - anchorAt) : 0 } : null,
      notLocallyVerifiedSinceMs: t && t.notLocallyVerifiedAt !== null ? now - t.notLocallyVerifiedAt : null,
      refreshAgeMs: t ? refreshAgeMs(t.durations, MAIN_HEALTH_LIMITS.unverifiedSuspectMs) : null,
      mainKeptLocal: this.mainKeptLocalCount,
      peers: this.configuredPeers().map((p) => {
        const q = t?.quarantine[p.machineId];
        const hint = this.peerHealth.get(p.machineId)?.status?.signerKeyHash;
        let pinned = false;
        try { pinned = !!(this.peerKeyLookupFactory && hint && this.peerKeyLookupFactory()(p.machineId, hint, now).status === 'ok'); } catch { pinned = false; } // @silent-fallback-ok — status display only: unreadable reads as not pinned
        return { machineId: p.machineId, pinned, mainQuarantined: q ? { headSha: q.head, at: new Date(q.at).toISOString() } : null, lastRefusal: this.peerLastRefusal.get(p.machineId) ?? null };
      }),
    };
  }

  /** Periodic driver: orphan unblock, starvation signal, start the next run. */
  async tick(): Promise<void> {
    // Before any await: a slow reap or peer poll must not delay the heartbeat restarts read.
    this.notePause();
    this.writePeerHold();
    if (this.blockedBy) await this.reapOrphan();
    if (this.verifierHold) this.recheckVerifierHold();
    this.checkStarved();
    if (!this.cfg.peerOnly) this.checkTrustHolding();
    // SEC-113 D2.2: the older of the two clocks; peers can never move the second one.
    // An unknown age is at least as old as the moment it became unknown: that bound feeds the same 3-hour signal.
    const age = this.health.unverifiedAge();
    this.health.noteUnverifiedAge(
      olderClock(age.unknownSince ?? this.mainObs.oldestUnverifiedAt, this.cfg.peerOnly ? null : this.trust().notLocallyVerifiedAt),
      { atLeast: age.unknownSince !== null },
    );
    if (!this.cfg.peerOnly) this.maybeEnqueueLocalCorroboration();
    if (!this.cfg.peerOnly) await this.pollPeers().catch((e) => this.audit({ event: 'peer-poll-error', detail: e instanceof Error ? e.message : String(e) }));
    if (!this.cfg.peerOnly) await this.pollArbitration().catch((e) => this.audit({ event: 'peer-arbitration-error', detail: e instanceof Error ? e.message : String(e) }));
    if (!this.cfg.peerOnly) await this.sweepReplayCapacity();
    if (!this.cfg.peerOnly) await this.tickWaitingList();
    if (!this.cfg.peerOnly) await this.tickOperator().catch((e) => this.audit({ event: 'operator-tick-error', detail: e instanceof Error ? e.message : String(e) }));
    this.checkPeerAttempt();
    await this.failedFileDiagnosisPeer?.tick();
    this.pump();
    if (!this.cfg.peerOnly) await this.failedFileDiagnosis?.tick([...this.index.values()]);
    if (!this.cfg.peerOnly) this.tickMemory();
    if (this.now() - this.lastLeftoverSweepAt >= MEMORY_CARE.sweepEveryMs) await this.sweepLeftovers('tick');
  }

  /**
   * Every tick on a coordinator: this machine's own reading (so the notice closes even when
   * the queue is empty), and a peer no longer configured reads as fine (its notice closes).
   */
  private tickMemory(): void {
    this.noteMemory(this.cfg.machineId, this.selfMemory(), 'self');
    const peers = new Set(this.configuredPeers().map((p) => p.machineId));
    for (const id of new Set([...this.memoryHeld.keys(), ...this.memoryNoticeOpen.keys()])) {
      if (id !== this.cfg.machineId && !peers.has(id)) this.noteMemory(id, null, 'peer');
    }
  }

  /** Nothing of this service is running or about to run on this machine. */
  private localIdle(): boolean {
    return !this.inFlight && !this.starting && !this.blockedBy && this.peerState.current?.state !== 'running' && !this.failedFileDiagnosisPeer?.busy();
  }

  /**
   * Backstop leftover sweep (spec §2b): the run's own end-of-run reap cannot run when the run
   * child is killed, and piles from older code must go too. This agent's own run and diagnosis
   * worktrees: any age when this service is idle, else past the run ceiling. Shared temp folders
   * (`<tmp>/lv-…`, which another agent's run on this host may be using): always past the run
   * ceiling only (MEMORY_CARE.leftoverMinAgeS).
   */
  async sweepLeftovers(why: 'boot' | 'tick'): Promise<ReapResult | null> {
    if (!this.seams.reapLeftovers || this.leftoverSweeping) return null;
    this.leftoverSweeping = true;
    this.lastLeftoverSweepAt = this.now();
    try {
      const idle = this.localIdle();
      let tempRoot: string | null = null;
      try { tempRoot = this.seams.tempRoot ? this.seams.tempRoot() : null; } catch { tempRoot = null; } // @silent-fallback-ok: an unreadable temp root sweeps only the agent's own run worktrees
      const { runs, diagnosis, temp } = localVerifyRunPrefixes(this.cfg.agentHome, tempRoot ?? '/nonexistent-temp-root');
      const own = idle ? 0 : MEMORY_CARE.leftoverMinAgeS;
      const prefixes: LeftoverPrefix[] = [{ prefix: runs, minAgeS: own }, { prefix: diagnosis, minAgeS: own }];
      if (tempRoot) for (const t of temp) prefixes.push({ prefix: t, minAgeS: MEMORY_CARE.leftoverMinAgeS });
      // A run that starts while the process table is read owns fresh matches: the reaper never
      // takes a process that started after this moment (startedBeforeMs).
      const r = await this.seams.reapLeftovers(prefixes, { startedBeforeMs: this.now() });
      if (r.matched > 0) this.audit({ event: 'leftovers-reaped', where: why, matched: r.matched, killed: r.killed, idle, sample: r.sample });
      // No lsof (minimal Linux/WSL): orphaned tmux servers cannot be seen. Said once per process, never silent.
      if (r.socketsUnreadable && !this.tmuxSocketsUnreadableAudited) {
        this.tmuxSocketsUnreadableAudited = true;
        this.audit({ event: 'leftovers-tmux-sockets-unreadable', detail: 'lsof unavailable: orphaned tmux servers from test runs are not cleared on this machine' });
      }
      return r;
    } catch (e) {
      this.audit({ event: 'leftovers-reap-failed', where: why, detail: e instanceof Error ? e.message : String(e) });
      return null;
    } finally {
      this.leftoverSweeping = false;
    }
  }

  /** This machine's own memory state, read through the seam (null = fine or unknown). */
  private selfMemory(): string | null {
    try { return this.seams.selfMemoryPressure ? this.seams.selfMemoryPressure() : null; } catch { return null; } // @silent-fallback-ok: an unreadable memory state never holds the line (today's behaviour)
  }

  /**
   * One machine's memory reading (null = fine). Holds/lifts at once; the notice opens on the
   * first pressured reading and closes after MEMORY_CARE.clearAfterMs of fine readings (and on
   * the first fine reading after boot, for an item an earlier process left open).
   * Coordinator-side only, so each episode has one voice.
   */
  private noteMemory(machineId: string, reason: string | null, who: 'self' | 'peer'): void {
    const key = `local-verify:memory-pressure:${machineId}`;
    const now = this.now();
    const firstSinceBoot = !this.memoryEvaluated.has(machineId);
    this.memoryEvaluated.add(machineId);
    const held = this.memoryHeld.get(machineId);
    const open = this.memoryNoticeOpen.get(machineId);
    // One voice: only the lease holder raises or closes notices (a peer with a source checkout
    // runs this too, for its own hold). Single-machine installs always hold.
    const voice = this.leaseState().holds;
    if (reason) {
      if (!held) {
        this.memoryHeld.set(machineId, { since: now, reason });
        this.audit({ event: 'memory-hold', machineId, who, reason });
      }
      if (!voice) return;
      if (open) { open.healthySince = null; return; }
      this.memoryNoticeOpen.set(machineId, { healthySince: null });
      const note = who === 'self'
        ? `This machine is short of memory (${reason}), so it has stopped starting tests of its own. Tests it hands to other machines continue. It starts again by itself when memory recovers; if it stays short, it still runs one test every ${Math.round(MEMORY_CARE.selfHoldMaxMs / 60_000)} minutes so merging never stops completely. To help now: quit what is using the memory on this machine.`
        : `A test machine (${machineId.slice(0, 8)}) is short of memory (${reason}), so it is out of the test line. The other machines keep testing. It comes back by itself when memory recovers. To help now: quit what is using the memory on that machine.`;
      try { this.seams.signal?.(key, { machineId, who, reason, note }); } catch { /* @silent-fallback-ok: a signal sink failure never changes the line */ }
      return;
    }
    if (held) {
      this.memoryHeld.delete(machineId);
      this.audit({ event: 'memory-hold-cleared', machineId, who, heldMs: now - held.since });
    }
    if (!voice) return;
    if (!open) {
      // Only where memory care is wired (a memory reader exists): elsewhere no notice was ever raised.
      if (firstSinceBoot && this.seams.selfMemoryPressure) { try { this.seams.clearSignal?.(key, 'memory fine at boot'); } catch { /* @silent-fallback-ok: the attention lifecycle still expires the row */ } }
      return;
    }
    if (open.healthySince === null) open.healthySince = now;
    if (now - open.healthySince < MEMORY_CARE.clearAfterMs) return;
    this.memoryNoticeOpen.delete(machineId);
    try { this.seams.clearSignal?.(key, 'memory recovered'); } catch { /* @silent-fallback-ok: the attention lifecycle still expires the row */ }
  }


  /**
   * Coordinator: publish which accepted peer attempts a planned restart should wait for. The restart
   * consumers run in other processes and can read only files; only this process knows the live lease
   * and each peer's last answer. Attempts drop out on any failed condition, so a failed write or an
   * unreachable peer falls back to restarting exactly as if there were no peer work.
   */
  private writePeerHold(): void {
    const now = this.now();
    const attempts = this.qualifyingPeerAttempts(now);
    // Fewer attempts holding, for any reason including a peer gone quiet: a deferred update
    // restart need not sit out its retry timer.
    const shrank = attempts.length < this.peerHoldCount;
    this.peerHoldCount = attempts.length;
    if (shrank) {
      try { this.runEnded?.(); } catch { /* @silent-fallback-ok: the updater's own re-check still runs within 5 minutes */ }
    }
    try {
      if (attempts.length > 0) {
        SafeFsExecutor.atomicWriteJsonSync(peerHoldPath(this.cfg.stateDir), { v: 1, writtenAt: now, leaseEpoch: this.leaseState().epoch, attempts },
          { operation: 'local-verify:peer-hold', mode: 0o600 });
        this.peerHoldFilePresent = true;
      } else if (this.peerHoldFilePresent) {
        SafeFsExecutor.safeRmSync(peerHoldPath(this.cfg.stateDir), { force: true, operation: 'local-verify:peer-hold-clear' });
        this.peerHoldFilePresent = false;
      }
      this.peerHoldWriteFailed = false;
    } catch (e) {
      // @silent-fallback-ok: no fresh heartbeat means no peer hold; the restart proceeds as before this feature.
      if (!this.peerHoldWriteFailed) this.audit({ event: 'peer-hold-write-failed', detail: e instanceof Error ? e.message.slice(0, 200) : String(e) });
      this.peerHoldWriteFailed = true;
    }
    this.auditPeerHolds(attempts, now);
  }

  /** Accepted peer attempts under the live lease whose peer answered within two poll periods. */
  private qualifyingPeerAttempts(now: number): Array<{ attemptId: string; pr: number; sentAt: number; lastPollOkAt: number }> {
    const reserved = this.queue.filter((e) => e.remote);
    if (reserved.length === 0) return [];
    const lease = this.leaseState();
    return reserved.flatMap((e) => {
      const m = e.remote!;
      const lastPollOkAt = this.remoteLastOkAt.get(m.attemptId);
      return lease.holds && lease.epoch === m.leaseEpoch && m.state === 'accepted'
        && lastPollOkAt !== undefined && now - lastPollOkAt <= 2 * PEER_LIMITS.pollMs
        ? [{ attemptId: m.attemptId, pr: e.pr, sentAt: m.sentAt, lastPollOkAt }] : [];
    });
  }

  /** The audit trail for a restart that waited on peer work: once per attempt per pending request. */
  private auditPeerHolds(attempts: ReadonlyArray<{ attemptId: string; pr: number; sentAt: number }>, now: number): void {
    if (attempts.length === 0 && this.peerHoldsAudited.size === 0) return;
    const restart = readPlannedRestartVerifyState(this.cfg.stateDir, now);
    // The updater never writes its restart request while restartHolds() names an attempt, so that
    // hold shows up as a durable deferral. Its start time can move on each retry, so it is not
    // used as a request identity below.
    let update: UpdatePendingState | null = null;
    try { update = (this.updateProvider ?? this.seams.updatePending)?.() ?? null; } catch { update = null; }
    const updateHold = !restart.pending && update?.restartHeldForPeer === true;
    for (const [attemptId, held] of [...this.peerHoldsAudited]) {
      const pastBound = now >= held.sentAt + PEER_RESTART_HOLD_MS;
      if (!restart.pending && !updateHold) { if (pastBound) this.endPeerHold(attemptId, 'bound-reached'); else this.peerHoldsAudited.delete(attemptId); continue; }
      // Checked before the request identity: the bypass writer stamps a new requestedAt.
      if (plannedRestartBypassesHolds(this.cfg.stateDir)) { this.endPeerHold(attemptId, 'bypass'); continue; }
      if (restart.pending && restart.pendingSinceMs !== held.requestedAt) { this.peerHoldsAudited.delete(attemptId); continue; }
      if (pastBound) this.endPeerHold(attemptId, 'bound-reached');
      else if (!attempts.some((a) => a.attemptId === attemptId) && this.remoteEpochCurrent(attemptId)) this.endPeerHold(attemptId, 'no-longer-qualifies');
    }
    if (!updateHold && (!restart.pending || !restart.hold)) return;
    for (const a of attempts) {
      const bound = a.sentAt + PEER_RESTART_HOLD_MS;
      if (this.peerHoldsAudited.has(a.attemptId) || bound <= now) continue;
      this.peerHoldsAudited.set(a.attemptId, { pr: a.pr, sentAt: a.sentAt, requestedAt: restart.pending ? restart.pendingSinceMs : (update?.pendingSinceMs ?? null) });
      this.audit({ event: 'restart-held-for-peer', attemptId: a.attemptId, pr: a.pr, boundAt: new Date(bound).toISOString() });
    }
  }

  /** A lease change is reported as `abandoned` by the poll that follows; only a peer gone quiet under the current lease is reported here. */
  private remoteEpochCurrent(attemptId: string): boolean {
    const lease = this.leaseState();
    return lease.holds && this.queue.some((e) => e.remote?.attemptId === attemptId && e.remote.leaseEpoch === lease.epoch);
  }

  private endPeerHold(attemptId: string, reason: 'imported' | 'abandoned' | 'bound-reached' | 'bypass' | 'no-longer-qualifies'): void {
    const held = this.peerHoldsAudited.get(attemptId);
    if (!held) return;
    this.peerHoldsAudited.delete(attemptId);
    this.audit({ event: 'restart-peer-hold-ended', attemptId, pr: held.pr, reason });
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
   * Server shutdown: start nothing else, and deal with the run in flight.
   *
   * A run whose result is already on disk has finished: it is settled here, as its
   * exit handler would have settled it (see finishedResultAtShutdown()).
   *
   * Any other run is stopped. The cancelled entry goes back to the head of the durable
   * queue (not as an attempt), so the next boot resumes it. No timer is armed (the
   * process is exiting); a group that survives SIGTERM is found by the next boot's
   * orphan reap.
   *
   * Every stop writes one `restart-interrupted-runs` row first (also when nothing was running),
   * so restarts and what each one cost are counted here and not reconstructed from logs.
   */
  shutdown(): void {
    if (this.stopped) return;
    this.stopped = true;
    void this.failedFileDiagnosisPeer?.preempt('shutdown');
    this.publishSuitePriority(false);
    const f = this.inFlight && !this.inFlight.cancelled ? this.inFlight : null;
    const finished = f ? this.finishedResultAtShutdown(f) : null;
    // Observability only: whatever goes wrong while building the row, the stop below still
    // cancels the run, counts the interruption and persists the queue.
    try { this.auditRestartInterruptedRuns(f, finished); }
    catch (e) { this.audit({ event: 'restart-interrupted-runs', error: (e instanceof Error ? e.message : String(e)).slice(0, 200) }); } // @silent-fallback-ok: a minimal row says the stop happened; the stop itself never depends on it
    if (f && finished?.settle) {
      this.audit({ event: 'settled-at-shutdown', ...(f.entry.kind === 'main' ? { kind: 'main' } : { pr: f.entry.pr }), headSha: f.entry.headSha, ranMs: this.now() - f.startedAt });
      this.onExit(f, { status: null, signal: null });
    } else if (f) {
      if (finished?.finished) {
        // A verdict was on disk and is thrown away: counted by its own row, with the reason.
        this.audit({
          event: 'finished-result-discarded-at-shutdown', ...(f.entry.kind === 'main' ? { kind: 'main' } : { pr: f.entry.pr }), headSha: f.entry.headSha,
          ranMs: this.now() - f.startedAt, reason: finished.discardReason, resultKind: finished.resultKind,
          ...(finished.outcome ? { outcome: finished.outcome } : {}),
        });
      }
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
    this.sweepOperatorHeld(); // an interrupted run of a held change goes to held, not back to the queue
    this.persistQueue();
  }

  /**
   * Has the in-flight run already reached its verdict? The child writes its result with a
   * temporary name and a rename as its last act (after its own worktree cleanup and suite-slot
   * release), so a result file that holds a result object is a finished run. What may not have
   * happened yet is this process handling the child's exit: a planned restart is released the
   * moment the child is no longer alive, and on a busy event loop the stop request can arrive
   * before the exit event does (2026-11-13: a 24-minute run was cancelled 121 ms after it
   * finished, its result discarded, and it ran again from the start).
   *
   * Not settled when the verifier on disk has changed, and that stays so. The result itself is
   * valid for this process (the run child checked its own version against this server's when it
   * started), but a record written here is worth something only if the merge step also acts on
   * it before this process exits, because the restart loads a verifier whose index skips it
   * (`rebuildIndex`). That cannot happen at a stop: the hand-off is refused once the service is
   * stopping (`decideMergeHandoff`), the status poster has already been stopped, the merge
   * itself is several network calls that take from seconds to minutes, and the whole teardown
   * has a hard 20-second deadline (`shutdownDeadline.ts`). A record with no merge would be a
   * green that nothing may use, and the entry would leave the queue; the interruption path
   * instead keeps it at the head of the queue so the next boot runs it again. The loss is
   * recorded as `finished-result-discarded-at-shutdown`, with the reason. The place that
   * prevents the loss is before the stop: the restart guard's settle window keeps a planned
   * restart waiting until the exit handler has recorded the result and offered the merge.
   */
  private finishedResultAtShutdown(f: InFlight): { finished: boolean; settle: boolean; resultKind?: string; outcome?: string; discardReason?: 'verifier-changed-on-disk' } {
    const changed = this.verifierChangedOnDisk();
    const result = this.readResult(f.resultPath) as { kind?: unknown; record?: { outcome?: unknown } } | null;
    if (!result || typeof result !== 'object' || typeof result.kind !== 'string') return { finished: false, settle: false };
    const outcome = typeof result.record?.outcome === 'string' ? result.record.outcome.slice(0, 20) : undefined;
    const resultKind = result.kind.slice(0, 20);
    return changed
      ? { finished: true, settle: false, resultKind, outcome, discardReason: 'verifier-changed-on-disk' }
      : { finished: true, settle: true, resultKind, outcome };
  }

  /**
   * The `restart-interrupted-runs` row: what this stop found in progress. The local run (none
   * or one): which change, how long it had run, whether its child had already exited, whether a
   * verdict was on disk and what became of it. Each peer attempt accepted and not yet imported.
   * And the request that explains the stop, when one was consumed in the last two minutes:
   * planned or not, holds bypassed or not (null = the request wrote neither, or no request
   * explains this stop, such as a signal). A request this process's own `boot` row already
   * named explains its start, not its stop (the process booted from it and was then stopped by
   * something else). Bounded: one run, at most 20 attempts (the total is given). Written with
   * empty lists when nothing was running, so a clean restart is counted too. Every field read
   * from a file (the request log, a persisted queue entry) is type-checked: a malformed one is
   * left out, never thrown on.
   */
  private auditRestartInterruptedRuns(f: InFlight | null, finished: ReturnType<LocalVerifyService['finishedResultAtShutdown']> | null): void {
    const now = this.now();
    let last: ReturnType<typeof readLastRestartRequest> = null;
    try { last = readLastRestartRequest(this.cfg.stateDir); } catch { last = null; } // @silent-fallback-ok: no readable request reads as "no request explains this stop", which is what the row then says
    const at = last ? Date.parse(last.at) : Number.NaN;
    const req = last && typeof last.at === 'string' && Number.isFinite(at) && at <= now + 5_000 && now - at <= RESTART_REQUEST_EXPLAINS_STOP_MS
      && last.at !== this.bootRestartAt ? last : null;
    const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v ? v.slice(0, max) : null);
    const requestedBy = req ? text(req.requestedBy, 200) : null;
    const peerAttemptId = f ? text(f.entry.peerAttempt?.id, 80) : null;
    let childExited: boolean | null = null;
    if (f) { try { childExited = !this.seams.isGroupAlive(f.pgid); } catch { childExited = null; } } // @silent-fallback-ok: an unreadable process table reads as unknown
    const accepted = this.queue.filter((e) => e.remote?.state === 'accepted');
    this.audit({
      event: 'restart-interrupted-runs',
      planned: req && typeof req.plannedRestart === 'boolean' ? req.plannedRestart : null,
      bypassHolds: req && typeof req.bypassHolds === 'boolean' ? req.bypassHolds : null,
      ...(req ? { restartAt: req.at, ...(requestedBy ? { requestedBy } : {}) } : {}),
      localRuns: f ? [{
        ...(f.entry.kind === 'main' ? { kind: 'main' } : { pr: f.entry.pr }),
        headSha: f.entry.headSha, ranMs: Math.max(0, now - f.startedAt), childExited,
        // settled: recorded here; discarded: a verdict was on disk and is thrown away; none: no verdict yet.
        finishedResult: finished?.settle ? 'settled' : finished?.finished ? 'discarded' : 'none',
        ...(peerAttemptId ? { peerAttemptId } : {}),
      }] : [],
      peerAttempts: accepted.slice(0, RESTART_INTERRUPTED_MAX_PEER_ATTEMPTS).map((e) => {
        const sentAt = e.remote?.sentAt;
        return { pr: e.pr, attemptId: text(e.remote?.attemptId, 80), sentAgoMs: typeof sentAt === 'number' && Number.isFinite(sentAt) ? Math.max(0, now - sentAt) : null };
      }),
      peerAttemptsTotal: accepted.length,
    });
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

  /** Pause new work while an update or other planned restart waits on a running verify. */
  private notePause(): boolean {
    const now = this.now();
    let state: UpdatePendingState | null = null;
    try { state = (this.updateProvider ?? this.seams.updatePending)?.() ?? null; } catch { state = null; }
    const restart = readPlannedRestartVerifyState(this.cfg.stateDir, now);
    const plannedRestartPause = restart.pending && (restart.deferredDelivery === true
      || (restart.pendingSinceMs !== null
        && decideUpdatePause({ pending: true, pendingSinceMs: restart.pendingSinceMs, otherBlockers: false }, now, VERIFY_RESTART_HOLD_MS)));
    const paused = decideUpdatePause(state, now) || plannedRestartPause;
    if (this.pausedSince !== null) {
      const dt = Math.max(0, now - this.pausedSince);
      for (const e of this.queue) if (e.kind !== 'main') e.pausedMs = (e.pausedMs ?? 0) + dt;
    }
    if (paused && this.pausedSince === null) this.audit({ event: 'update-pause', pendingSinceMs: state?.pendingSinceMs ?? restart.pendingSinceMs ?? null });
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
      if (this.operatorHeld(marker.pr)) continue; // a held change spends no admission attempt; its replay waits for the release
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
    this.sweepOperatorHeld(); // queue controls: a queue entry of a held change goes to held before anything is chosen
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
    // A pending `main` entry starts on main's head as observed NOW, never the head it was queued
    // for. It can wait up to MAIN_FAIR_SHARE_MS behind PRs, so the queued head is usually stale by
    // the time it starts, and a green run of a stale head leaves the newer merges uncovered: a
    // second main run was due at once (2026-11-16: 80 minutes of back-to-back main runs). Healthy
    // only: while suspect or red the queued head (the re-run of a failed head) runs as queued.
    // Head unreadable (null) ⇒ as queued. One read is not trusted to move the run BACKWARD: a
    // head this machine already verified, the last green head, or a head already seen replaced
    // (a stale read, or main reset to an older head) never becomes the target.
    if (next.kind === 'main') this.retargetStaleMain(next);
    const [entry] = this.queue.splice(this.queue.indexOf(next), 1);
    this.lastStartWasMain = entry.kind === 'main';
    // SEC-113: a main verify started here while peers could have served it, because D2.3 kept it local.
    if (entry.kind === 'main' && !this.cfg.peerOnly && this.mainOnPeersOn() && !peerMainRoutingAllowed(this.trust(), this.now(), MAIN_HEALTH_LIMITS.unverifiedSuspectMs).allowed) this.mainKeptLocalCount++;
    this.start(entry);
  }

  /** A pending `main` entry about to start (here or on a peer) moves to main's head as observed now; see pump(). */
  private retargetStaleMain(next: QueueEntry): void {
    if (next.kind !== 'main' || !this.health.isHealthy()) return;
    const cur = this.mainObs.head;
    const target = cur === null ? null : (this.releaseAlias.get(cur) ?? cur);
    // SEC-113 D2.3: while main is routed here, only this machine's own verdicts count as covered
    // (peers can write `lastGreenHead` and `verifiedMainHeads`), so a head a peer called green still runs.
    const local = !this.cfg.peerOnly && this.mainOnPeersOn() && !peerMainRoutingAllowed(this.trust(), this.now(), MAIN_HEALTH_LIMITS.unverifiedSuspectMs).allowed;
    const alreadyCovered = target !== null && cur !== null && (local
      ? (target === this.trust().anchor?.head || this.trust().locallyVerified.includes(target))
      : (target === this.health.snapshot().lastGreenHead || this.verifiedMainHeads.includes(target) || this.mainSupersededAt.has(cur)));
    if (target !== null && target !== next.headSha && !alreadyCovered) {
      this.audit({ event: 'main-replaced', oldHead: next.headSha, newHead: target, why: 'stale-at-start' });
      next.headSha = target; next.baseSha = target;
      // The observed head is now the one being verified: its own debounced enqueue is not needed.
      this.mainObs.handled = cur; this.mainObs.firstUnverifiedAt = null;
    }
  }

  private fairShareState(): FairShareState {
    return { mainHealthy: this.health.isHealthy(), mainRed: this.health.snapshot().state === 'main-red', oldestUnverifiedMainAt: this.mainObs.oldestUnverifiedAt, oldestUnverifiedMainUnknown: this.health.unverifiedAge().unknownSince !== null, lastStartWasMain: this.lastStartWasMain };
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
    // Short of memory: this machine starts nothing of its own (peers keep their dispatches).
    const mem = this.selfMemory();
    this.noteMemory(this.cfg.machineId, mem, 'self');
    if (mem) {
      const held = this.memoryHeld.get(this.cfg.machineId);
      // Held a full window: one entry may go; start() begins the next window when it does.
      if (!held || this.now() - held.since < MEMORY_CARE.selfHoldMaxMs) return null;
    }
    // The files on disk must still be the verifier this server labels records with: an update
    // that landed under us holds the queue for the restart instead of spawning a child that refuses.
    if (this.verifierChangedOnDisk()) return null;
    const now = this.now();
    // Stable: FIFO within a level. An ordinary PR that has waited THROUGHPUT_AGING_MS ranks with
    // the merge-throughput label, so the label can never hold an old PR back indefinitely.
    // Queue controls: a fronted change goes ahead of every other change (the ONE order, also used for the hand-off to a peer).
    const ordered = this.orderQueue(this.queue, now);
    // Main-red hold (CMT-1033): while `main` fails a known check, only a repair candidate
    // (a PR that touches or names a failing file) or a `main` verify may take the slot;
    // every other PR entry keeps its place and waits for green. Never a doomed run.
    const hold = this.holdDecision();
    // An entry reserved for a peer attempt (or being prepared for one) is the peer's, never started here.
    // One `main` verify at a time: a pending one waits while a peer runs another.
    const mainOnPeer = !!this.remoteMain();
    let admissible: QueueEntry[] = ordered.filter((e) => !e.remote && e !== this.dispatching && !(mainOnPeer && e.kind === 'main'));
    // Queue controls, the start check: a change the operator holds never starts (its entry is
    // normally already out of the queue; this covers one that could not be moved yet).
    if (this.queueControlsOn() && this.operator.anyHold()) admissible = admissible.filter((e) => e.kind === 'main' || !this.operator.isHeld(e.pr));
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
      fairShare: this.fairShareState(),
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
      this.operatorOnClosed(entry.pr);
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
    this.writeMergeHold('handoff'); // a planned restart waits (bounded) for this merge attempt
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
      if (this.mergeHold === hold) { this.mergeHold = null; this.clearMergeHold(); }
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
    const memHeld = this.memoryHeld.get(this.cfg.machineId);
    if (memHeld && this.now() - memHeld.since >= MEMORY_CARE.selfHoldMaxMs) {
      memHeld.since = this.now(); // the one start a long memory hold allows per window
      this.audit({ event: 'memory-hold-window-start', machineId: this.cfg.machineId, pr: entry.pr, reason: memHeld.reason });
    }
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
    this.sweepRunLogs();
    const inputPath = path.join(this.runsDir, `${token}.input.json`);
    const resultPath = path.join(this.runsDir, `${token}.result.json`);
    const logFile = path.join(this.runsDir, `${token}.log`);
    const input: VerifyRunInput = {
      repo: this.cfg.repo, pr: entry.pr, headSha: entry.headSha, baseSha: entry.baseSha, baseRefName: entry.baseRefName,
      agentHome: this.cfg.agentHome, remoteUrl: this.cfg.remoteUrl, nodeVersion: this.cfg.nodeVersion,
      machineId: this.cfg.machineId, verifierVersion: this.cfg.verifierVersion, policyHash: this.policyHash,
      protectedList: this.cfg.protectedList, extraHarnessGlobs: this.cfg.extraHarnessGlobs, baseEnv: this.cfg.baseEnv,
      // PR verifies: an isolation re-run needs this machine's last green main record.
      ...(entry.kind === 'main' ? {} : { isolation: this.childIsolation(entry) }),
      // PR verifies: stop the other lanes once one lane has a failure its re-run did not clear.
      ...(entry.kind !== 'main' && this.failFastOn() ? { failFast: true } : {}),
      ...(entry.kind !== 'main' ? { preflightMode: replay || entry.preflightBypassRetry ? 'off' as const : this.preflightMode() } : {}),
      ...(entry.kind !== 'main' ? { preflightRediscoverable: entry.preflightRediscoverable === true } : {}),
      ...(() => { const ls = this.laneShards(); return ls ? { laneShards: ls } : {}; })(),
      ...(entry.kind === 'main' ? { kind: 'main' as const } : {}),
      // A peer run answers one coordinator attempt: the record carries it (spec local-verify-capacity.md Part D).
      ...(entry.peerAttempt ? { attempt: entry.peerAttempt } : {}),
      // PR verifies with the setting on or alternate here: the first parts' inputs. Off ⇒ nothing is added.
      ...this.firstPartInput(entry),
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
        this.finishPeerAttempt({ entry, cancelled: false, runInput: input, token }, { kind: 'crash' });
        return;
      }
      const failed = this.syntheticError(entry, 'spawn');
      if (input.firstPartEvidence) failed.firstPart = input.firstPartEvidence;
      this.complete(failed, 'run');
      this.noteFirstPart({ runInput: input, token }, { kind: 'record', record: failed });
      this.audit({ event: 'spawn-failed', pr: entry.pr, detail: e instanceof Error ? e.message : String(e) });
      if (!entry.preflightReplay) this.handleErrorRetry(entry);
      this.pump();
      return;
    }
    // Phase 2: patch pid/pgid (detached: the child's pid IS its pgid).
    intent.pid = handle.pid;
    intent.pgid = handle.pid;
    // A `main` run covers every merge up to its start only if it starts on main's head as observed
    // then. A run of an older head (it waited in the queue, an error retry, the re-run after a first
    // failure) leaves a newer merge uncovered, so its green must not move the unverified clock.
    if (entry.kind === 'main') {
      const cur = this.mainObs.head;
      this.mainRunOnCurrentHead = cur !== null && (entry.headSha === cur || this.releaseAlias.get(cur) === entry.headSha) ? entry.headSha : null;
    }
    this.inFlight = { entry, token, pgid: handle.pid, inputPath, resultPath, cancelled: false, startedAt: intent.startedAt,
      preflightAllowanceMs: input.preflightMode && input.preflightMode !== 'off' ? PREFLIGHT_LIMITS.totalMs : 0,
      runInput: input };
    this.publishSuitePriority(true);
    const mine = this.inFlight;
    handle.exited.then((x) => this.onExit(mine, x), () => this.onExit(mine, { status: null, signal: null }));
    this.writeInFlight(intent);
    this.persistQueue();
    this.audit({ event: 'started', pr: entry.pr, headSha: entry.headSha, baseSha: entry.baseSha, pgid: handle.pid, attempt: entry.attempts,
      ...(entry.firstRefusedAt !== undefined ? { firstRefusedAt: entry.firstRefusedAt } : {}) });
    // Queue controls, the harm detector: a start of a change that is held at that moment. The start
    // check and the dispatch check make this impossible; the row exists so the review can count zero.
    if (entry.kind !== 'main' && !entry.peerAttempt && this.operatorHeld(entry.pr)) this.audit({ event: 'operator-held-started', pr: entry.pr, headSha: entry.headSha });
  }

  /**
   * The isolation block a run child gets. A local run builds it now, so a queued entry takes the
   * switch and the list as they are at its start. A peer run uses the coordinator's block, and
   * applies the import-related rule only when the block enables it AND this machine's own switch
   * is on; otherwise the rule is passed off with an empty list. A block without the switch field
   * (an older shape) is passed through as it came.
   */
  private childIsolation(entry: QueueEntry): IsolationInput {
    const sent = entry.peerIsolation;
    if (!sent) return this.isolationInput();
    if (!('importRelatedRerun' in sent)) return sent;
    const on = sent.importRelatedRerun === true && this.importRelatedRerunOn();
    return { allowed: sent.allowed, notCleanOnGreenMain: sent.notCleanOnGreenMain, importRelatedRerun: on, flakyOnMain: on ? sent.flakyOnMain ?? [] : [] };
  }

  /**
   * Run logs are kept 30 days (the full-output pointers on the audit lines rest on them), then
   * removed: at most once an hour, when a run starts. Only `<token>.log` files in the runs folder.
   */
  private sweepRunLogs(): void {
    const now = this.now();
    if (now - this.runLogsSweptAt < 60 * 60_000) return;
    this.runLogsSweptAt = now;
    let removed = 0;
    try {
      for (const name of fs.readdirSync(this.runsDir)) {
        if (!/^[0-9a-f]{16,64}\.log$/.test(name)) continue;
        const file = path.join(this.runsDir, name);
        if (now - fs.statSync(file).mtimeMs <= IMPORT_RELATED_RERUN.runLogKeepMs) continue;
        SafeFsExecutor.safeRmSync(file, { force: true, operation: 'local-verify:run-log-retention' });
        removed++;
      }
    } catch (e) {
      this.audit({ event: 'run-logs-sweep-failed', detail: e instanceof Error ? e.message : String(e) });
    }
    if (removed > 0) this.audit({ event: 'run-logs-swept', removed, keepDays: IMPORT_RELATED_RERUN.runLogKeepMs / (24 * 60 * 60_000) });
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
    // Handled exactly once: shutdown() settles a run whose result is already on disk, and the
    // child's real exit event may still arrive afterwards. Handling it again would find the
    // result file gone and record a crash over the real verdict.
    if (f.settled) return;
    f.settled = true;
    // Sweep leftovers of the group right away (step processes the child left behind).
    if (this.seams.isGroupAlive(f.pgid)) {
      try { this.seams.killGroup(f.pgid, 'SIGKILL'); } catch { /* @silent-fallback-ok: best-effort */ }
    }
    // A PR run that may be handed to the merge line keeps a short restart hold across the gap
    // between its child exiting and the hand-off being offered (written BEFORE the in-flight
    // marker goes, so a waiting restart never sees neither).
    const settling = !f.cancelled && !f.entry.peerAttempt && f.entry.kind !== 'main' && this.mergeHandoff !== null && this.mergeLineOn() && !this.stopped;
    if (settling && this.mergeHoldFile !== 'handoff') this.writeMergeHold('settling'); // never replace another PR's open hand-off marker
    this.clearInFlight();
    if (this.inFlight === f) this.inFlight = null;
    // The restart hold this run held is gone: let a waiting update restart now, not at its next re-check.
    // (also when the settling marker could not be written: nothing would announce the end later)
    if (!settling || this.mergeHoldFile === null) { try { this.runEnded?.(); } catch { /* @silent-fallback-ok: the updater's own re-check still runs within 5 minutes */ } }
    const result = this.readResult(f.resultPath);
    if (!f.runInput) {
      try { f.runInput = JSON.parse(fs.readFileSync(f.inputPath, 'utf8')) as VerifyRunInput; }
      catch { /* An incomplete observation discloses an unavailable run input after restart. */ }
    }
    this.removeRunFiles(f);
    for (const d of (result && 'degradations' in result && Array.isArray(result.degradations)) ? result.degradations : []) {
      try { this.seams.onDegradation?.(d); } catch { /* @silent-fallback-ok: the run log still carries the event */ }
    }
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
        this.completeMain(result.record, f.entry, { reasons: result.reasons, failures: result.failures, runLog: `${f.token}.log`, flakyTestLines: result.flakyTestLines });
      }
    } else if (!result || result.kind === 'crash' || result.kind === 'invalid') {
      const step = !result ? 'crash' : result.kind === 'crash' ? 'crash' : 'invalid-record';
      this.audit({ event: 'run-error', pr: f.entry.pr, step, exit, detail: result && 'detail' in result ? result.detail : undefined });
      const synthetic = this.syntheticError(f.entry, step);
      if (f.runInput?.firstPartEvidence) synthetic.firstPart = f.runInput.firstPartEvidence;
      this.complete(synthetic, 'run');
      this.noteFirstPart(f, { kind: 'record', record: synthetic });
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
        this.audit({ event: 'run-detail', ...runDetail(rec, { ...result, runLog: `${f.token}.log` }) });
      }
      if (rec) this.noteFlaky(rec);
      if (rec && rec.outcome === 'success' && f.entry.kind !== 'main') this.rearmMainAfterGreen(rec.pr);
      if (rec && rec.outcome === 'error' && !f.entry.preflightReplay) this.handleErrorRetry(f.entry, rec.errorStep);
      // Record machine-local observations after the verify has been accepted.
      if (rec) this.noteFirstPart(f, result);
    }
    // No hand-off was opened for this run (red, error, re-queued, or the line held by another
    // PR): the settling hold ends here and a waiting restart may go.
    if (settling && this.mergeHoldFile === 'settling') this.clearMergeHold();
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
    this.pump();
  }

  /** A green PR run after `main`'s error retries ran out re-arms one `main` verify (see decideMainRearmAfterGreen). */
  private rearmMainAfterGreen(pr: number): void {
    const head = this.mainObs.head;
    if (head === null) return;
    const target = this.releaseAlias.get(head) ?? head;
    const rearm = decideMainRearmAfterGreen({
      priorRetries: this.mainErrorRetries.get(target) ?? 0,
      mainPending: this.queue.some((e) => e.kind === 'main'),
      mainInFlight: this.inFlight?.entry.kind === 'main' && !this.inFlight.cancelled,
      healthState: this.health.snapshot().state,
    });
    if (!rearm) return;
    this.mainErrorRetries.set(target, 0);
    this.audit({ event: 'main-retry-rearmed-after-green', headSha: target, afterPr: pr });
    this.enqueueMain(target, 'rerun');
  }

  /** The restart guard's view of a merge in progress (`PlannedRestartVerifyGuard`): a short, bounded marker. */
  private mergeHoldFile: 'settling' | 'handoff' | null = null;
  private writeMergeHold(phase: 'settling' | 'handoff'): void {
    try {
      SafeFsExecutor.atomicWriteJsonSync(mergeHoldPath(this.cfg.stateDir), { v: 1, phase, since: this.now() },
        { operation: 'local-verify:merge-hold', mode: 0o600 });
      this.mergeHoldFile = phase;
    } catch (e) {
      // @silent-fallback-ok: no marker means no merge hold; the restart proceeds as before this feature.
      this.audit({ event: 'merge-hold-write-failed', phase, detail: String(e).slice(0, 200) });
    }
  }
  private clearMergeHold(): void {
    if (this.mergeHoldFile === null) return;
    this.mergeHoldFile = null;
    try { SafeFsExecutor.safeRmSync(mergeHoldPath(this.cfg.stateDir), { force: true, operation: 'local-verify:merge-hold-clear' }); }
    catch { /* @silent-fallback-ok: the marker's own short bound releases the restart */ }
    // The hold is gone: let a waiting restart go now, not at its next re-check.
    try { this.runEnded?.(); } catch { /* @silent-fallback-ok: the updater's own re-check still runs within 5 minutes */ }
  }

  /* @self-action-controller: local-verify-error-rerun */
  private handleErrorRetry(entry: QueueEntry, errorStep?: string): void {
    // A merge conflict is decided by the head and the base alone: re-running the same pair a
    // second later gives the same conflict (it only doubled every conflict record and status
    // post). The head runs again when it moves, or on an explicit request for the same head.
    if (errorStep === 'conflict') return;
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
  private completeMain(record: LocalVerifyRecord, entry: QueueEntry, run?: { reasons: string[]; failures?: FailureDetail[]; runLog?: string; flakyTestLines?: unknown }, dispatchedAt?: number, source: 'local' | 'peer' = 'local'): void {
    const v = validateRecord(record);
    if (!v.ok || record.kind !== 'main' || record.headSha !== entry.headSha) {
      this.audit({ event: 'record-rejected', kind: 'main', errors: v.ok ? ['kind-or-head'] : v.errors });
      return;
    }
    const head = record.headSha;
    // `finishedAt` with the head identifies this verify (a replica is merged on it); `lanesCompleted`
    // says which lanes ran to their end with a report, so a rate counts only real observations.
    this.audit({
      event: 'main-record', headSha: head, outcome: record.outcome, errorStep: record.errorStep, finishedAt: record.finishedAt,
      lanesCompleted: record.outcome === 'error' ? [] : record.lanes.filter((l) => l.files > 0).map((l) => l.name),
      ...(source === 'local' ? (run?.runLog ? { runLog: run.runLog } : {}) : { source: 'peer' }),
    });
    let detail = runDetail(record, run);
    if (record.outcome === 'failure') {
      // Kept (and written durably) for the main-red hold: which files failed, so a repair can be told from a doomed run.
      this.mainFailure = mainFailureFromRunDetail(head, run, new Date(this.now()).toISOString());
      this.writeMainFailure(this.mainFailure);
      detail = { ...detail, hold: this.holdLists(this.mainFailure) };
    }
    if (record.outcome !== 'error') this.noteMainHeadVerified(head);
    // SEC-113 D2.1: only this machine's own green becomes the isolation baseline; a peer green never does.
    if (record.outcome === 'success' && source === 'local') this.saveGreenMain(record);
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
    // SEC-113 D2.1: a peer's flaky list never writes flaky history or raises flaky items.
    // Main evidence (named tests that failed and passed alone) is written here and nowhere else:
    // only from a `main` verify this machine ran itself that ended `success`.
    if (source === 'local') this.noteFlaky(record, record.outcome === 'success' ? { mainEvidence: { runLog: run?.runLog ?? '', lines: run?.flakyTestLines } } : {});
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
    if (record.outcome === 'success') {
      const isCurrent = current !== null && (head === current || this.releaseAlias.get(current) === head);
      const coversToStart = this.mainRunOnCurrentHead === head;
      const moved = oldestUnverifiedAfterGreen(
        this.mainObs.oldestUnverifiedAt, isCurrent,
        // A peer run covers merges up to its dispatch, by THIS machine's clock (never the peer's).
        coversToStart ? (dispatchedAt ?? Date.parse(record.startedAt)) : null,
        supersededAtFor(head, this.mainSupersededAt, this.releaseAlias),
      );
      // Never later than now: a record with a skewed start time must not park the clock in the future.
      this.mainObs.oldestUnverifiedAt = moved === null ? null : Math.min(moved, this.now());
      if (!this.cfg.peerOnly) {
        const t = this.trust();
        if (source === 'local') {
          // SEC-113 D2.2: only this machine's own green moves the second clock, by the same rule.
          const movedLocal = oldestUnverifiedAfterGreen(
            t.notLocallyVerifiedAt, isCurrent,
            coversToStart ? Date.parse(record.startedAt) : null,
            supersededAtFor(head, this.mainSupersededAt, this.releaseAlias),
          );
          t.notLocallyVerifiedAt = movedLocal === null ? null : Math.min(movedLocal, this.now());
          if (coversToStart) t.anchor = { head, finishedAt: record.finishedAt };
        } else {
          // SEC-113 D2.4: remembered so a later local red on this exact head can be judged against it.
          rememberPeerGreen(t, { head, peer: record.machineId, verifierVersion: record.verifierVersion, policyHash: record.policyHash, at: this.now() });
        }
        this.saveTrust();
      }
    }
    if (source === 'local' && !this.cfg.peerOnly) {
      // SEC-113 D2.3: the refresh age is derived from this machine's own completed main runs.
      // `locallyVerified`: heads this machine recorded a main verdict for itself (green or red), the
      // only "already covered" set while main runs here, and always for release collapsing.
      const ms = Date.parse(record.finishedAt) - Date.parse(record.startedAt);
      noteLocallyVerified(this.trust(), head);
      if (Number.isFinite(ms)) noteDuration(this.trust(), ms);
      this.saveTrust();
    }
    this.mainRunOnCurrentHead = null;
    // A green verify hands the age over, so it is written in the same watermark write as the green head (and ends an unknown age).
    const work = this.health.onVerify(head, record.outcome, detail, record.outcome === 'success' ? { oldestUnverifiedAt: this.mainObs.oldestUnverifiedAt } : undefined).then(async (action) => {
      if (this.health.isHealthy()) this.clearMainFailure();
      try {
        if (this.health.isHealthy()) this.firstPartReport.green();
        const snapshot = this.health.snapshot();
        if (snapshot.state === 'main-red' && snapshot.redHead && !this.cfg.peerOnly
          && !this.firstPartReport.hasOpenEpisode()) {
          const episode = redMainEpisode(snapshot.redHead, snapshot.lastGreenHead, this.now(), null, []);
          const records = [...this.index.values()];
          this.firstPartReport.episode(episode); // Reserve once before starting asynchronous history work.
          void Promise.resolve().then(async () => {
            const history = snapshot.lastGreenHead ? await this.seams.firstPartHistory?.(snapshot.lastGreenHead, snapshot.redHead!).catch(() => null) : null;
            this.firstPartReport.completeEpisode(redMainEpisode(episode.redHead, episode.lastGreenHead, episode.at, history, records));
          }).catch((e) => this.audit({ event: 'first-part-episode-write-failed', detail: String(e) }));
        }
      } catch (e) { this.audit({ event: 'first-part-episode-write-failed', detail: String(e) }); }
      // SEC-113 D2.4: this machine's own red on a head a peer called green (after the two-strike rerun).
      if (source === 'local' && record.outcome === 'failure' && !this.cfg.peerOnly) {
        const snap = this.health.snapshot();
        if (snap.state === 'main-red' && snap.redHead === head) this.judgePeerDisagreement(head);
      }
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
      // Skipped at the ordinary cap BEFORE asking (an overflow is audited and left failed, as
      // before). Below the cap the re-run is not held back by the waiting list (fb-7fde7f49-8ee).
      if (this.prQueueLength() >= LOCAL_VERIFY_LIMITS.queueCap) {
        this.audit({ event: 'rerun-after-green-overflow', pr: r.pr, headSha: r.headSha });
        continue;
      }
      const res = await this.request(r.pr, { explicit: true, force: true, rerunAfterGreen: true });
      this.audit({ event: 'rerun-after-green', pr: r.pr, result: res.ok ? res.status : res.code });
    }
  }

  // ---- first parts: the list, the assignment, the verdict check (spec local-verify-likely-failing-first.md) ----

  /** Late-bind `monitoring.localVerify.likelyFailingFirst` (`off` | `on` | `alternate`; absent ⇒ off). Read at the start of each verify this machine runs. */
  setLikelyFailingFirst(fn: (() => unknown) | null): void { this.likelyFailingFirstSetting = fn; }

  /** Late-bind the writer that sets `monitoring.localVerify.likelyFailingFirst` to `off` on this machine (the verdict check's brake). */
  setLikelyFailingFirstOff(fn: (() => void) | null): void { this.likelyFailingFirstOff = fn; }

  /**
   * This machine's setting as it applies now. An unreadable setting is `off` (today's behaviour).
   */
  likelyFailingFirst(): FirstPartSetting {
    let value: unknown = 'off';
    try { value = this.likelyFailingFirstSetting?.() ?? 'off'; }
    catch { /* An unreadable setting uses the existing off default. */ }
    const setting = parseFirstPartSetting(value);
    try { this.firstPartReport.readSetting(setting); }
    catch (e) { this.audit({ event: 'first-part-marker-write-failed', detail: String(e) }); }
    return setting;
  }

  /**
   * The files a pull request failed finally on in its previous verify (the newest record this
   * coordinator holds for it, whatever its head), at most 3. A file whose re-run alone was cut
   * off by another lane's failure is left out: a cut-off re-run is no evidence that it fails.
   */
  previousFailures(pr: number): string[] {
    let latest: LocalVerifyRecord | null = null;
    for (const r of this.index.values()) {
      if (r.pr !== pr || r.kind === 'main') continue;
      if (!latest || Date.parse(r.finishedAt) > Date.parse(latest.finishedAt)) latest = r;
    }
    if (!latest || latest.outcome !== 'failure' || !Array.isArray(latest.failedFiles)) return [];
    const cut = new Set(latest.rerunCutOff ?? []);
    return latest.failedFiles.filter((f) => !cut.has(f)).slice(0, FIRST_PART_LIMITS.previousMax);
  }

  /**
   * What the coordinator attaches to a verify of `pr`: its assignment (drawn when it was first
   * queued, kept for every later verify), its previous failures, and the 90 listed files that
   * failed for the most different pull requests other than this one. Built whether or not the
   * setting is on anywhere, so the list is ready when a switch is turned on.
   */
  firstPartFor(pr: number): { group: FirstPartGroup; previous: string[]; list: string[] } {
    return { group: this.firstPartGroups.assign(pr), previous: this.previousFailures(pr), list: this.likelyFailing.listFor(pr) };
  }

  /**
   * The two request fields a hand-off to a peer carries: the assignment, and (only when not
   * empty) the list in use with the previous failures, at most 100 paths. A path over 300
   * characters is left out with an audit row; that file runs in its lane as usual.
   */
  private firstPartWire(pr: number): { firstPartGroup: FirstPartGroup; likelyFailing?: LikelyFailingWire } {
    const fp = this.firstPartFor(pr);
    const { field, dropped } = boundLikelyFailingWire(fp.list, fp.previous);
    if (dropped.length > 0) this.audit({ event: 'likely-failing-path-too-long', pr, count: dropped.length, paths: dropped.slice(0, 5).map((x) => boundedHead(x, 400)) });
    return { firstPartGroup: fp.group, ...(field ? { likelyFailing: field } : {}) };
  }

  /** The `likelyFailingFirst` block of a run input, plus start evidence; off omits the block but retains evidence. */
  private firstPartInput(entry: QueueEntry): { likelyFailingFirst?: FirstPartInput; firstPartEvidence?: FirstPartEvidence } {
    if (entry.kind === 'main') return {};
    const setting = this.likelyFailingFirst();
    // A peer run uses what the coordinator sent (a peer never builds its own list); with no
    // assignment sent, a pull request counts as `without`.
    const src = entry.peerAttempt
      ? { group: entry.peerFirstPartGroup ?? null, previous: entry.peerLikelyFailing?.previous ?? [], list: entry.peerLikelyFailing?.list ?? [] }
      : this.firstPartFor(entry.pr);
    const evidence: FirstPartEvidence = { setting, group: src.group ?? 'without', ran: false };
    return { firstPartEvidence: evidence, ...(setting === 'off' ? {} : {
      likelyFailingFirst: { setting, ...(src.group ? { group: src.group } : {}), previous: src.previous, list: src.list },
    }) };
  }

  likelyFailingFirstStatus() {
    const report = this.firstPartReport.counts();
    return { setting: this.likelyFailingFirst(), list: this.likelyFailing.info(), open: report.open, overdue: report.overdue };
  }

  /** Record evidence only on the machine that ran this verify. */
  private noteFirstPart(f: Pick<InFlight, 'runInput'> & { token?: string }, result: unknown): void {
    const r = result as { kind?: unknown; record?: LocalVerifyRecord; firstPart?: FirstPartSummary; observation?: ObservationDetail } | null;
    if (!r || r.kind !== 'record' || !r.record || r.record.kind === 'main') return;
    const rec = r.record;
    const evidence = rec.firstPart ?? f.runInput?.firstPartEvidence ?? { setting: 'off', group: 'without', ran: false };
    try {
      this.firstPartReport.observe(observation(rec, rec.attempt?.id ?? f.token ?? `${rec.pr}:${rec.startedAt}`, evidence, r.observation));
      this.firstPartReport.daily(() => {
        if (!this.likelyFailingFirstOff) throw new Error('config writer unavailable');
        this.likelyFailingFirstOff();
        if (parseFirstPartSetting(this.likelyFailingFirstSetting?.()) !== 'off') throw new Error('config write did not persist off');
      }, (detail) => this.seams.signal?.(`local-verify:first-part-cost-limit:${String(detail.trial)}`, detail));
    } catch (e) { this.audit({ event: 'first-part-observation-write-failed', detail: String(e) }); }
    if (r.firstPart) this.audit({ event: 'first-part', pr: rec.pr, headSha: rec.headSha, ...r.firstPart, outcome: rec.outcome, minutes: Math.round((Date.parse(rec.finishedAt) - Date.parse(rec.startedAt)) / 6000) / 10 });
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
    // The likely-failing list learns from every verify of a change this coordinator records, its
    // own or a peer's: the files it failed finally on. Not a derived copy (no verify ran for it),
    // and never a file whose re-run alone was cut off by another lane's failure.
    if (source !== 'derived' && record.kind !== 'main' && record.outcome === 'failure' && Array.isArray(record.failedFiles)) {
      const cut = new Set(record.rerunCutOff ?? []);
      const counted = record.failedFiles.filter((f) => !cut.has(f));
      if (counted.length > 0) this.likelyFailing.record({ pr: record.pr, files: counted, at: Date.parse(record.finishedAt) });
    }
    this.seams.onRecord?.(record);
    this.operatorOnResult(record);
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

  // ---- operator queue controls (spec local-verify-queue-controls.md) ----
  //
  // Two controls, hold and front, that take effect at once and never touch a running verify.
  // The operator's choices live per PR number in `operatorQueue.ts`; everything here reads
  // them at the moment it admits, orders, starts or hands off work. Off unless the live
  // switch is `true`: with it off the records are kept but nothing below applies them.

  /** Late-bind the live `monitoring.localVerify.queueControls` switch. Absent ⇒ off; on only for a real `true`. */
  setQueueControlsEnabled(fn: (() => boolean) | null): void { this.queueControlsEnabled = fn; }

  queueControlsOn(): boolean {
    try { return this.queueControlsEnabled ? this.queueControlsEnabled() === true : false; } catch { return false; } // @silent-fallback-ok: an unreadable switch reads as off (the queue as it was before the controls)
  }

  get operatorQueuePath(): string { return this.operator.path; }

  /**
   * Late-bind how a notice reaches the session that operates the line (an agent message to the
   * session named in `monitoring.localVerify.operatorSession`). `sent` is true only when the
   * message router reports the message delivered; anything else (no session set, queued for a
   * session that is not running, a failure, a throw) falls back to an attention item.
   */
  setOperatorNotifier(fn: ((m: { subject: string; body: string }) => Promise<{ sent: boolean; phase?: string | null }>) | null): void { this.operatorNotifier = fn; }
  private operatorNotifier: ((m: { subject: string; body: string }) => Promise<{ sent: boolean; phase?: string | null }>) | null = null;

  /** Held by the operator right now: the switch is on and the change has a hold that is not being released. */
  private operatorHeld(pr: number): boolean {
    return this.queueControlsOn() && this.operator.isHeld(pr);
  }

  /**
   * The ONE order of the queue, used by the coordinator's own choice (which passes the queue
   * itself: sorted in place, as before the controls) and by the hand-off to a peer (which
   * passes a copy). First the order as it always was: priority, FIFO within a level, an aged
   * PR at the throughput level. Then, with the switch on, the fronted changes are taken to
   * the front of the CHANGES, most recently fronted first; a `main` verify keeps its place.
   * The marks never reorder the queue itself and nothing is written into an entry's priority,
   * so a change that is unfronted is back in its ordinary place.
   */
  private orderQueue(list: QueueEntry[], now: number): QueueEntry[] {
    list.sort((a, b) => effectivePriority(b, now) - effectivePriority(a, now));
    if (!this.queueControlsOn() || !this.operator.anyFront()) return list;
    const mark = (e: QueueEntry) => (e.kind === 'main' ? 0 : this.operator.frontOrder(e.pr));
    const fronted = list.filter((e) => mark(e) > 0);
    if (fronted.length === 0) return list;
    fronted.sort((a, b) => mark(b) - mark(a));
    return [...list.filter((e) => e.kind === 'main'), ...fronted, ...list.filter((e) => e.kind !== 'main' && mark(e) === 0)];
  }

  /** A verify of this change is running: in flight here, or reserved by a peer. The controls never touch it. */
  private operatorRunning(pr: number): 'here' | 'peer' | null {
    const f = this.inFlight;
    if (f && !f.cancelled && f.entry.kind !== 'main' && !f.entry.peerAttempt && f.entry.pr === pr) return 'here';
    return this.queue.some((e) => e.kind !== 'main' && e.pr === pr && !!e.remote) ? 'peer' : null;
  }

  /** Queued or running here (placing a change that is already placed changes nothing). */
  private operatorPresent(pr: number): boolean {
    const f = this.inFlight;
    return this.queue.some((e) => e.kind !== 'main' && e.pr === pr)
      || (!!f && !f.cancelled && f.entry.kind !== 'main' && !f.entry.peerAttempt && f.entry.pr === pr);
  }

  /** Places of the operator overflow in use: entries a front or a release admitted over the cap that are still queued. */
  private operatorOverflowUsed(): number {
    return this.operator.overflowUsed(new Set(this.queue.filter((e) => e.kind !== 'main').map((e) => e.pr)));
  }

  /** How many more entries a restore may bring back: the operator overflow, when it is or was in use. */
  private operatorRestoreAllowance(): number {
    return this.queueControlsOn() || this.operator.overCapCount() > 0 ? OPERATOR_QUEUE_LIMITS.overflow : 0;
  }

  private operatorRefusal(pr: number): OperatorRefusal | null {
    if (!this.queueControlsOn()) return 'disabled';
    if (this.cfg.peerOnly) return 'peer-only';
    if (this.stopped) return 'stopping';
    if (!isValidPr(pr)) return 'invalid-pr';
    return null;
  }

  private savedEntryOf(e: QueueEntry): SavedQueueEntry {
    return {
      headSha: e.headSha, baseSha: e.baseSha, baseRefName: e.baseRefName, firstQueuedAt: e.firstQueuedAt,
      attempts: e.attempts, errorRetries: e.errorRetries, starvedRaised: e.starvedRaised,
      ...(e.firstRefusedAt !== undefined ? { firstRefusedAt: e.firstRefusedAt } : {}),
      ...(e.pausedMs ? { pausedMs: e.pausedMs } : {}),
      ...(e.baseResolvedAt ? { baseResolvedAt: e.baseResolvedAt } : {}),
      ...(e.interruptions ? { interruptions: e.interruptions } : {}),
      ...(e.resumeFirst ? { resumeFirst: true as const } : {}),
      ...(e.priority === QUEUE_PRIORITY.mergeThroughput ? { priority: e.priority } : {}),
      ...(e.remoteAttempts ? { remoteAttempts: e.remoteAttempts } : {}),
      ...(e.preflightBypassRetry ? { preflightBypassRetry: true as const } : {}),
      ...(e.preflightRediscoverable ? { preflightRediscoverable: true as const } : {}),
    };
  }

  /** The entry a hold took out, as it goes back: everything it carried, and the held time counted as paused (not as waiting). */
  private entryFromSaved(pr: number, s: SavedQueueEntry, heldMs: number): QueueEntry {
    const pausedMs = (s.pausedMs ?? 0) + Math.max(0, heldMs);
    return {
      id: crypto.randomBytes(6).toString('hex'), pr, headSha: s.headSha, baseSha: s.baseSha, baseRefName: s.baseRefName,
      firstQueuedAt: s.firstQueuedAt, attempts: s.attempts, errorRetries: s.errorRetries, starvedRaised: s.starvedRaised,
      priority: s.priority === QUEUE_PRIORITY.mergeThroughput ? QUEUE_PRIORITY.mergeThroughput : QUEUE_PRIORITY.ordinary,
      // In memory only on a live entry: the next request for the change re-reads its files and text.
      files: null, text: '',
      ...(s.firstRefusedAt !== undefined ? { firstRefusedAt: s.firstRefusedAt } : {}),
      ...(pausedMs > 0 ? { pausedMs } : {}),
      ...(s.baseResolvedAt ? { baseResolvedAt: s.baseResolvedAt } : {}),
      ...(s.interruptions ? { interruptions: s.interruptions } : {}),
      ...(s.resumeFirst ? { resumeFirst: true as const } : {}),
      ...(s.remoteAttempts ? { remoteAttempts: s.remoteAttempts } : {}),
      ...(s.preflightBypassRetry ? { preflightBypassRetry: true as const } : {}),
      ...(s.preflightRediscoverable ? { preflightRediscoverable: true } : {}),
    };
  }

  /**
   * Move a held change's queue entry and waiting-list place into its hold record. The operator
   * file is written BEFORE the entry leaves the queue; when that write fails the entry stays
   * where it is (the start check and the dispatch check still refuse it). An entry a peer has
   * reserved is running and is left alone.
   */
  private takeToHeld(pr: number, why: 'hold' | 'found-queued'): 'queue' | 'waiting-list' | null {
    const rec = this.operator.get(pr);
    if (!rec?.hold || rec.hold.releasing) return null;
    const idx = this.queue.findIndex((e) => e.kind !== 'main' && e.pr === pr && !e.remote && !e.peerAttempt);
    const waiter = this.waiting.get(pr);
    if (idx < 0 && !waiter) return null;
    const before = this.operator.copyOf(pr);
    const h = rec.hold;
    if (idx >= 0) {
      const saved = this.savedEntryOf(this.queue[idx]);
      // The first time the change queued is kept across every trip in and out of the queue.
      if (h.entry) saved.firstQueuedAt = Math.min(saved.firstQueuedAt, h.entry.firstQueuedAt);
      h.entry = saved;
    }
    if (waiter) h.waiter = { firstRefusedAt: waiter.firstRefusedAt, lastOfferedAt: waiter.lastOfferedAt, refusals: waiter.refusals };
    h.takenAt = this.now();
    if (!this.operator.persist()) { this.operator.restore(pr, before); return null; }
    if (idx >= 0) this.queue.splice(idx, 1);
    if (waiter) this.waiting.remove(pr, 'held');
    const from = idx >= 0 ? 'queue' as const : 'waiting-list' as const;
    this.audit({ event: 'operator-held-out', pr, from, why });
    return from;
  }

  /**
   * The one rule that covers every gap: whenever a queue entry (or a waiting-list place) is
   * found for a held change, at boot or when the service next looks for work, it moves to held.
   * This is how a run that comes back without a result (an interruption, an error re-run, a
   * peer attempt abandoned on a restart) goes to held instead of back to the queue.
   */
  private sweepOperatorHeld(): void {
    if (this.restoring || this.cfg.peerOnly || !this.queueControlsOn() || !this.operator.anyHold()) return;
    let moved = false;
    for (const r of this.operator.held()) {
      if (r.hold!.releasing) continue;
      if (this.takeToHeld(r.pr, 'found-queued') === 'queue') moved = true;
    }
    if (moved) this.persistQueue();
  }

  /** A request arrived for a held change: the hold remembers it, durably, so a release admits the change. */
  private noteOperatorWanted(pr: number, how: 'explicit' | 'watcher'): void {
    const h = this.operator.get(pr)?.hold;
    if (!h || h.wanted === 'explicit' || h.wanted === how) return;
    h.wanted = how;
    this.operator.persist();
  }

  /** A change closed or merged: its hold and its front mark are dropped. */
  private operatorOnClosed(pr: number): void {
    this.operatorSeen.delete(pr);
    if (!this.operator.drop(pr)) return;
    this.operator.persist();
    this.audit({ event: 'operator-record-dropped', pr, reason: 'closed' });
  }

  private endOperatorFront(pr: number, why: string): void {
    this.operatorSeen.delete(pr);
    if (!this.operator.get(pr)?.front) return;
    this.operator.clearFront(pr);
    this.operator.persist();
    this.audit({ event: 'operator-front-ended', pr, why });
  }

  /**
   * The front mark ends when the change gets a result, pass or fail, for its CURRENT commit and
   * target branch (the result index's key), from a verify that ran or from a derived record.
   * Not at a start: an interrupted run, an error re-run or an abandoned peer attempt comes back
   * first. A result for an older commit or another target branch leaves the mark alone.
   */
  private operatorOnResult(record: LocalVerifyRecord): void {
    if (record.kind === 'main' || !this.queueControlsOn()) return;
    const pr = record.pr;
    const order = this.operator.frontOrder(pr);
    if (order === 0) return;
    const work: Promise<void> = (async () => {
      const view = await this.seams.prView(pr).catch(() => null);
      const current = view ? { headSha: view.headRefOid, baseRefName: view.baseRefName } : (this.operatorSeen.get(pr) ?? null);
      if (current && (current.headSha !== record.headSha || current.baseRefName !== record.baseRefName)) return;
      // An error that is being re-run has given no result yet.
      if (record.outcome === 'error' && this.operatorPresent(pr)) return;
      if (this.operator.frontOrder(pr) !== order) return; // fronted again meanwhile
      this.endOperatorFront(pr, `result:${record.outcome}`);
    })().catch((e) => this.audit({ event: 'operator-front-result-error', pr, detail: e instanceof Error ? e.message : String(e) }));
    this.pendingMainWork.push(work);
    void work.finally(() => { const i = this.pendingMainWork.indexOf(work); if (i >= 0) this.pendingMainWork.splice(i, 1); });
  }

  /**
   * An unreadable operator file is reported at once, one time: the previous good copy was used
   * (the most recent change may be missing), or nothing could be read and no hold is in force.
   */
  private reportOperatorLoad(): void {
    if (this.operatorLoadReported) return;
    this.operatorLoadReported = true;
    const r = this.operator.loadReport();
    // Records that were readable only in part: a lost hold or front mark, or a hold that lost what it had saved. Never audit-only.
    const issues = this.operator.loadIssues();
    const lost = issues.filter((i) => i.what === 'hold-dropped' || i.what === 'front-dropped' || i.what === 'record-dropped');
    const stripped = issues.filter((i) => i.what === 'saved-entry-dropped' || i.what === 'saved-waiter-dropped');
    const names = (list: typeof issues) => [...new Set(list.map((i) => (i.pr === null ? 'a record with no usable number' : `PR #${i.pr}`)))].join(', ');
    const partial = issues.length === 0 ? '' : ` Part of the list was damaged.${lost.length ? ` A hold or front mark was lost for: ${names(lost)}; those changes are not held now, so set them again.` : ''}${stripped.length ? ` Still held, but what the hold had saved (the place in the queue, a pending re-test) was lost for: ${names(stripped)}; after a release, request those changes again.` : ''}`;
    const key = `local-verify:operator-file-unreadable:${new Date(this.now()).toISOString()}`;
    if (r.status !== 'restored-from-previous' && r.status !== 'lost') {
      if (issues.length === 0) return;
      this.audit({ event: 'operator-file-unreadable', used: 'file-in-part', lost: lost.map((i) => i.pr), savedLost: stripped.map((i) => i.pr) });
      this.signal(key, {
        note: `The file that remembers which changes are held back from testing could be read only in part.${partial}`,
        used: 'file-in-part', lost: lost.map((i) => i.pr), savedLost: stripped.map((i) => i.pr),
      });
      return;
    }
    if (r.status === 'restored-from-previous') {
      const list = r.holds.length ? r.holds.map((h) => `PR #${h.pr} (${h.reason})`).join('; ') : 'none';
      this.audit({ event: 'operator-file-unreadable', used: 'previous-copy', held: r.holds.map((h) => h.pr), fronted: r.fronted });
      this.signal(key, {
        note: `The file that remembers which changes are held back from testing could not be read, so its previous copy is in use. Held now: ${list}. Moved to the front now: ${r.fronted.length ? r.fronted.map((p) => `PR #${p}`).join(', ') : 'none'}. The most recent hold, release or front may be missing: check this list and set it again if it is.${partial}`,
        used: 'previous-copy', held: r.holds.map((h) => h.pr), fronted: r.fronted,
      });
      return;
    }
    this.audit({ event: 'operator-file-unreadable', used: 'nothing', held: [], fronted: [] });
    this.signal(key, {
      note: 'The file that remembers which changes are held back from testing could not be read, and neither could its previous copy. No change is held and none is moved to the front now, so held changes may be tested. Set the holds again.',
      used: 'nothing',
    });
  }

  /** Room for one more record: changes GitHub reports closed or merged are dropped first. */
  private async makeOperatorRoom(pr: number): Promise<boolean> {
    if (this.operator.hasRoomFor(pr)) return true;
    for (const r of this.operator.records()) {
      const open = await this.seams.isPrOpen(r.pr).catch(() => null);
      if (open === false) this.operatorOnClosed(r.pr);
    }
    return this.operator.hasRoomFor(pr);
  }

  /**
   * Hold a change: it is out of the queue and the waiting list and is not admitted until it is
   * released. A verify of it that is already running, here or on a peer, is left alone
   * (`running: true`). After the room check nothing here waits, so a hold and the final step of
   * a start or a peer reservation cannot interleave: whichever runs first decides both this
   * answer and whether the verify starts.
   */
  async operatorHold(a: { pr: number; by: string; reason: string; until?: number }): Promise<OperatorHoldResult> {
    const refused = this.operatorRefusal(a.pr);
    if (refused) return { ok: false, code: refused };
    // Checked before anything is stored: a time a Date cannot hold could be neither shown nor audited.
    if (a.until !== undefined && !isValidTime(a.until)) return { ok: false, code: 'invalid-time' };
    if (this.restoring) await this.restoring.catch(() => undefined);
    this.reportOperatorLoad();
    if (!(await this.makeOperatorRoom(a.pr))) {
      this.audit({ event: 'operator-file-full', pr: a.pr, by: a.by, records: this.operator.size() });
      return { ok: false, code: 'operator-file-full' };
    }
    if (this.stopped) return { ok: false, code: 'stopping' };
    const before = this.operator.copyOf(a.pr);
    const rec = this.operator.ensure(a.pr);
    const old = rec.hold;
    const alreadyHeld = !!old && !old.releasing;
    const until = a.until !== undefined ? { until: a.until } : {};
    if (alreadyHeld && old) {
      // Held already: who, why and until are updated; what the hold took out stays as it is.
      const { until: _oldUntil, reminded: _oldReminded, ...kept } = old; void _oldUntil;
      rec.hold = { ...kept, by: a.by, reason: a.reason, ...until, ...(_oldReminded && a.until === old.until ? { reminded: true as const } : {}) };
    } else {
      // New, or a release that had not placed the change yet: what was saved stays saved.
      rec.hold = {
        by: a.by, reason: a.reason, at: this.now(), ...until,
        ...(old?.entry ? { entry: old.entry } : {}), ...(old?.waiter ? { waiter: old.waiter } : {}),
        ...(old?.takenAt !== undefined ? { takenAt: old.takenAt } : {}), ...(old?.wanted ? { wanted: old.wanted } : {}),
      };
    }
    if (!this.operator.persist()) { this.operator.restore(a.pr, before); return { ok: false, code: 'state-unwritable' }; }
    const running = this.operatorRunning(a.pr);
    this.audit({
      event: 'operator-hold', pr: a.pr, by: a.by, reason: a.reason, running: running ?? false, alreadyHeld,
      ...(a.until !== undefined ? { until: safeIso(a.until) } : {}),
    });
    const removed = this.takeToHeld(a.pr, 'hold');
    if (removed === 'queue') this.persistQueue();
    this.pump(); // the freed place is filled by the queue's usual rules; something else may start now
    return { ok: true, pr: a.pr, held: true, alreadyHeld, running: running !== null, ...(running ? { where: running } : {}), removed };
  }

  /**
   * Release a hold and put back exactly what it took out: the saved queue entry (its first
   * queued time, any pending re-test it carried), the waiting-list place, or the request made
   * while it was held. A hold that took nothing and was never asked for only ends: a release
   * never causes a test by itself. `releasing` is written first and cleared once the change is
   * durably placed, so a restart in between finishes the release.
   */
  async operatorRelease(a: { pr: number; by: string }): Promise<OperatorReleaseResult> {
    const refused = this.operatorRefusal(a.pr);
    if (refused) return { ok: false, code: refused };
    if (this.restoring) await this.restoring.catch(() => undefined);
    this.reportOperatorLoad();
    const rec = this.operator.get(a.pr);
    if (!rec?.hold) return { ok: false, code: 'not-held' };
    if (!rec.hold.releasing) {
      const before = this.operator.copyOf(a.pr);
      rec.hold.releasing = { by: a.by, at: this.now() };
      if (!this.operator.persist()) { this.operator.restore(a.pr, before); return { ok: false, code: 'state-unwritable' }; }
      this.audit({
        event: 'operator-release', pr: a.pr, by: a.by, heldMs: this.now() - rec.hold.at,
        restores: rec.hold.entry ? 'queue-entry' : rec.hold.waiter ? 'waiting-place' : rec.hold.wanted ? 'request' : 'nothing',
      });
    }
    return this.finishOperatorRelease(a.pr, false);
  }

  /** Place the released change and clear `releasing`. Also run at boot and on ticks for a release a restart or an unreadable change interrupted. */
  private async finishOperatorRelease(pr: number, retry: boolean): Promise<OperatorReleaseResult> {
    const h = this.operator.get(pr)?.hold;
    if (!h?.releasing) return { ok: false, code: 'not-held' };
    const token = h.releasing.at;
    const heldMs = h.takenAt !== undefined ? Math.max(0, this.now() - h.takenAt) : 0;
    const pending = (why: string): OperatorReleaseResult => {
      const cur = this.operator.get(pr)?.hold;
      if (retry && cur?.releasing) {
        cur.releasing.tries = (cur.releasing.tries ?? 0) + 1;
        if (cur.releasing.tries > OPERATOR_QUEUE_LIMITS.pendingRetries) {
          // The change could not be read for a long time: the hold still ends, and nothing is placed.
          this.operator.clearHold(pr);
          this.audit({ event: 'operator-release-abandoned', pr, reason: why });
        }
        this.operator.persist();
      }
      return { ok: true, pr, released: false, placed: 'pending', detail: why };
    };
    let placed: 'queue' | 'waiting-list' | 'already-placed' | 'none' = 'none';
    let overCap = false;
    let detail: string | undefined;
    let savedEntryDropped = false;
    if (this.operatorPresent(pr)) placed = 'already-placed';
    else if (this.waiting.get(pr)) placed = 'waiting-list'; // placed there before a restart: its place is kept
    else if (h.entry) {
      const full = this.prQueueLength() >= LOCAL_VERIFY_LIMITS.queueCap;
      if (full && this.operatorOverflowUsed() >= OPERATOR_QUEUE_LIMITS.overflow) {
        // The queue and its operator overflow are full: the head of the waiting list, so it takes the next free place.
        // The waiting list holds only the change number, so what the saved entry carried (a re-test
        // against a newer base, its attempts) is not kept: the answer and the audit row say so.
        this.waiting.put(pr, h.entry.firstRefusedAt ?? h.entry.firstQueuedAt, { head: true });
        placed = 'waiting-list';
        savedEntryDropped = true;
        detail = 'placed on the waiting list; the saved re-test was not kept';
      } else {
        const entry = this.entryFromSaved(pr, h.entry, heldMs);
        this.queue.push(entry);
        if (full) this.operator.markOverCap(pr);
        if (!this.persistQueue()) {
          this.queue.splice(this.queue.indexOf(entry), 1);
          if (full) this.operator.unmarkOverCap(pr);
          return pending('queue-unwritable');
        }
        placed = 'queue';
        overCap = full;
        if (full) this.audit({ event: 'release-admitted-over-cap', pr, headSha: entry.headSha, used: this.operatorOverflowUsed(), max: OPERATOR_QUEUE_LIMITS.overflow });
      }
    } else if (h.waiter || h.wanted) {
      const r = await this.request(pr, {
        explicit: h.wanted !== 'watcher', operator: 'release',
        carry: { ...(h.waiter ? { firstRefusedAt: h.waiter.firstRefusedAt } : {}), ...(heldMs > 0 ? { pausedMs: heldMs } : {}) },
      });
      const cur = this.operator.get(pr)?.hold;
      if (!cur?.releasing || cur.releasing.at !== token) {
        // Held again, or dropped as closed, while the change was read: this release placed nothing more.
        return { ok: true, pr, released: !cur, placed: 'none', detail: r.ok ? 'superseded' : r.code };
      }
      if (r.ok && r.status === 'recorded') detail = 'recorded';
      else if (r.ok) { placed = 'queue'; overCap = r.status === 'queued' && r.operatorOverCap === true; }
      else if (r.code === 'overflow-full') {
        this.waiting.put(pr, h.waiter?.firstRefusedAt ?? this.now(), { head: true, ...(h.waiter ? { refusals: h.waiter.refusals } : {}) });
        placed = 'waiting-list';
      } else if (r.code === 'pr-unreadable' || r.code === 'pr-invalid-shas' || r.code === 'stopping') return pending(r.code);
      else detail = r.code;
    }
    this.operator.clearHold(pr);
    this.operator.persist();
    this.audit({ event: 'operator-release-placed', pr, placed, ...(overCap ? { overCap: true } : {}), ...(savedEntryDropped ? { savedEntryDropped: true } : {}), ...(detail ? { detail } : {}) });
    // A restored entry is tested at the change's newest commit, as any entry is: the same read
    // a re-request makes (a moved head takes the entry's place; an unreadable change keeps it).
    if (h.entry && placed === 'queue') await this.request(pr, { explicit: true }).catch(() => null);
    this.pump();
    return { ok: true, pr, released: true, placed, ...(overCap ? { overCap: true as const } : {}), ...(detail ? { detail } : {}) };
  }

  /**
   * Front a change: it is the next CHANGE to start (the most recently fronted first). A change
   * that is not queued is admitted by this call, into a full queue too, within the operator
   * overflow. Front orders changes among themselves and passes no gate: a due `main` verify, an
   * update pause, a memory hold, the main-red hold and the verifier hold apply as before.
   */
  async operatorFront(a: { pr: number; by: string; reason: string }): Promise<OperatorFrontResult> {
    const refused = this.operatorRefusal(a.pr);
    if (refused) return { ok: false, code: refused };
    if (this.restoring) await this.restoring.catch(() => undefined);
    this.reportOperatorLoad();
    const limit = (): OperatorFrontResult | null => {
      const fronted = this.operator.fronted();
      if (this.operator.get(a.pr)?.front || fronted.length < OPERATOR_QUEUE_LIMITS.maxFronted) return null;
      return { ok: false, code: 'front-limit', fronted: fronted.map((r) => ({ pr: r.pr, reason: r.front!.reason, by: r.front!.by, at: safeIso(r.front!.at) })) };
    };
    const over = limit();
    if (over) return over;
    if (!(await this.makeOperatorRoom(a.pr))) {
      this.audit({ event: 'operator-file-full', pr: a.pr, by: a.by, records: this.operator.size() });
      return { ok: false, code: 'operator-file-full' };
    }
    if (this.stopped) return { ok: false, code: 'stopping' };
    const overNow = limit(); // the room check may have waited
    if (overNow) return overNow;
    const running = this.operatorRunning(a.pr);
    const queuedAt = this.queue.findIndex((e) => e.kind !== 'main' && e.pr === a.pr);
    const held = this.operator.isHeld(a.pr);
    const admitting = running === null && queuedAt < 0 && !held;
    const before = this.operator.copyOf(a.pr);
    const rec = this.operator.ensure(a.pr);
    const order = this.operator.takeOrder();
    // "front, admitting" is written BEFORE the change is admitted: a restart in between finishes the admission at boot.
    rec.front = { order, by: a.by, reason: a.reason, at: this.now(), ...(admitting ? { admitting: true as const } : {}) };
    // A held change stays held and is first when released: the hold remembers it is wanted.
    if (held && rec.hold && rec.hold.wanted !== 'explicit') rec.hold.wanted = 'explicit';
    if (!this.operator.persist()) { this.operator.restore(a.pr, before); return { ok: false, code: 'state-unwritable' }; }
    const state = running ? 'running' : held ? 'held' : admitting ? 'admitting' : 'queued';
    this.audit({ event: 'operator-front', pr: a.pr, by: a.by, reason: a.reason, order, state });
    if (running) return { ok: true, pr: a.pr, status: 'running', order, where: running };
    if (held) return { ok: true, pr: a.pr, status: 'held', order };
    if (!admitting) {
      const e = this.queue[queuedAt];
      if (e) this.operatorSeen.set(a.pr, { headSha: e.headSha, baseRefName: e.baseRefName });
      this.pump();
      return { ok: true, pr: a.pr, status: 'fronted', order, rank: this.operatorFrontRank(a.pr) };
    }
    return this.finishOperatorFront(a.pr, false);
  }

  /** A fronted change's place among the fronted changes, most recently fronted first: 1 = the next change to start. */
  private operatorFrontRank(pr: number): number {
    return this.operator.fronted().findIndex((r) => r.pr === pr) + 1;
  }

  /** Admit a fronted change that was not queued, then clear "admitting". Also run at boot and on ticks. */
  private async finishOperatorFront(pr: number, retry: boolean): Promise<OperatorFrontResult> {
    const f = this.operator.get(pr)?.front;
    if (!f?.admitting) return { ok: true, pr, status: 'fronted', ...(f ? { order: f.order } : {}) };
    const order = f.order;
    const r = await this.request(pr, { explicit: true, operator: 'front' });
    const cur = this.operator.get(pr)?.front;
    if (!cur || cur.order !== order) {
      // Unfronted, fronted again or dropped as closed while the change was read.
      return r.ok ? { ok: true, pr, status: r.status === 'recorded' ? 'recorded' : 'admitted' } : { ok: false, code: r.code };
    }
    if (r.ok && r.status !== 'recorded') {
      delete cur.admitting;
      delete cur.tries;
      this.operator.persist();
      this.pump();
      return {
        ok: true, pr, status: 'admitted', order,
        ...(r.status === 'queued' && r.operatorOverCap ? { overCap: true as const } : {}),
        rank: this.operatorFrontRank(pr),
      };
    }
    if (r.ok) {
      // It already has a result for its current commit: nothing to test, so nothing to put first.
      this.endOperatorFront(pr, 'recorded');
      return { ok: true, pr, status: 'recorded' };
    }
    if (r.code === 'held') {
      delete cur.admitting;
      this.noteOperatorWanted(pr, 'explicit');
      this.operator.persist();
      return { ok: true, pr, status: 'held', order };
    }
    if (retry && (r.code === 'pr-unreadable' || r.code === 'pr-invalid-shas' || r.code === 'stopping')) {
      cur.tries = (cur.tries ?? 0) + 1;
      if (cur.tries <= OPERATOR_QUEUE_LIMITS.pendingRetries) { this.operator.persist(); return { ok: false, code: r.code }; }
    }
    this.endOperatorFront(pr, r.code);
    return { ok: false, code: r.code };
  }

  /** End a front mark: the entry stays queued at its ordinary priority. */
  operatorUnfront(a: { pr: number; by: string }): OperatorUnfrontResult {
    const refused = this.operatorRefusal(a.pr);
    if (refused) return { ok: false, code: refused };
    this.reportOperatorLoad();
    if (!this.operator.get(a.pr)?.front) return { ok: false, code: 'not-fronted' };
    const before = this.operator.copyOf(a.pr);
    this.operator.clearFront(a.pr);
    if (!this.operator.persist()) { this.operator.restore(a.pr, before); return { ok: false, code: 'state-unwritable' }; }
    this.operatorSeen.delete(a.pr);
    this.audit({ event: 'operator-unfront', pr: a.pr, by: a.by });
    this.pump();
    return { ok: true, pr: a.pr, unfronted: true };
  }

  /** The operator's holds and front marks for `GET /local-verify`; null while the switch is off. */
  operatorQueue(): OperatorQueueView | null {
    if (this.cfg.peerOnly || !this.queueControlsOn()) return null;
    const now = this.now();
    const iso = (ms: number) => safeIso(ms); // never throws on a bad time
    return {
      enabled: true,
      held: this.operator.held().map((r) => {
        const h = r.hold!;
        return {
          pr: r.pr, reason: h.reason, by: h.by, at: iso(h.at), until: h.until !== undefined ? iso(h.until) : null, heldMs: Math.max(0, now - h.at),
          wanted: !!(h.entry || h.waiter || h.wanted), reminded: h.reminded === true, running: this.operatorRunning(r.pr) !== null,
          releasing: !!h.releasing, savedEntry: !!h.entry,
        };
      }),
      fronted: this.operator.fronted().map((r) => {
        const f = r.front!;
        return {
          pr: r.pr, reason: f.reason, by: f.by, at: iso(f.at), order: f.order, held: this.operator.isHeld(r.pr),
          queued: this.queue.some((e) => e.kind !== 'main' && e.pr === r.pr), running: this.operatorRunning(r.pr) !== null, admitting: f.admitting === true,
        };
      }),
      overflow: { used: this.operatorOverflowUsed(), max: OPERATOR_QUEUE_LIMITS.overflow },
      limits: { fronted: OPERATOR_QUEUE_LIMITS.maxFronted, records: OPERATOR_QUEUE_LIMITS.maxRecords },
    };
  }

  /** The `boot` audit row: why this process started, when the restart request carried a reason; `unknown` otherwise. */
  private auditBoot(): void {
    let last: ReturnType<typeof readLastRestartRequest> = null;
    try { last = readLastRestartRequest(this.cfg.stateDir); } catch { last = null; } // @silent-fallback-ok: no readable request reads as unknown, which is what the row then says
    const b = bootReason(last, this.lastBootRestartAt(), this.now());
    this.bootRestartAt = b.restartAt ?? null;
    this.audit({ event: 'boot', ...b });
  }
  /** The restart request this process's own `boot` row named: it explains this start, so it cannot also explain this process's stop. */
  private bootRestartAt: string | null = null;

  /** The restart request the newest earlier `boot` row named (so one request explains one start). Reads only the log's tail. */
  private lastBootRestartAt(): string | null {
    try {
      const size = fs.statSync(this.auditPath).size;
      const fd = fs.openSync(this.auditPath, 'r');
      try {
        const len = Math.min(size, 256 * 1024);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len);
        const lines = buf.toString('utf8').split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
          if (!lines[i].includes('"event":"boot"')) continue;
          try {
            const o = JSON.parse(lines[i]) as { event?: unknown; restartAt?: unknown };
            if (o.event === 'boot') return typeof o.restartAt === 'string' ? o.restartAt : null;
          } catch { /* @silent-fallback-ok: a torn first line from the tail cut */ }
        }
      } finally { fs.closeSync(fd); }
    } catch { /* @silent-fallback-ok: no audit log yet (first boot) */ }
    return null;
  }

  /**
   * Boot: an unreadable operator file is reported, and what a restart interrupted is finished
   * (a front that was still admitting, a release that had not placed its change). The restored
   * queue was already swept: an entry of a held change is in its hold record.
   */
  private async bootOperator(): Promise<void> {
    if (!this.queueControlsOn()) return;
    this.reportOperatorLoad();
    // Only the machine that holds the lease admits or places anything; elsewhere the tick does it once the lease is held.
    if (this.leaseState().holds) await this.finishOperatorPending();
    this.sweepOperatorHeld();
    this.persistQueue();
  }

  private async finishOperatorPending(): Promise<void> {
    for (const r of this.operator.records()) {
      if (this.stopped) return;
      if (r.hold?.releasing) await this.finishOperatorRelease(r.pr, true);
      if (this.operator.get(r.pr)?.front?.admitting) await this.finishOperatorFront(r.pr, true);
    }
  }

  /**
   * Every tick on a coordinator. Switch off: held changes that were wanted go back through
   * ordinary admission, so nothing is stranded outside the queue (the records are kept).
   * Switch on: the unreadable-file report, the lease notice, what a restart interrupted, the
   * sweep, and once an hour the reminder for due holds and the drop of closed changes.
   */
  private async tickOperator(): Promise<void> {
    if (this.operatorTicking || this.stopped) return;
    this.operatorTicking = true;
    try {
      if (!this.queueControlsOn()) {
        await this.readmitHeldWhileOff();
        return;
      }
      this.reportOperatorLoad();
      if (this.operator.size() === 0) return;
      const lease = this.leaseState();
      if (lease.unreadable) return;
      if (!lease.holds) {
        // Two readable reads in a row (as the peer-trust check does): one odd read tells nobody.
        if (this.operator.leaseNoticeSentAt() === null && ++this.operatorLeaseMisses >= 2) this.noticeOperatorLeaseLost(lease.holder);
        return;
      }
      this.operatorLeaseMisses = 0;
      // The lease is back on this machine after a notice: the records from the earlier period are kept.
      if (this.operator.leaseNoticeSentAt() !== null) this.noteOperatorRecordsKept();
      await this.finishOperatorPending();
      this.sweepOperatorHeld();
      if (this.now() - this.operatorCheckAt >= OPERATOR_QUEUE_LIMITS.checkEveryMs) await this.checkOperatorHolds();
    } finally {
      this.operatorTicking = false;
    }
  }

  /**
   * This machine has the lease again (after another machine held it, or after its own notice)
   * and finds holds or front marks in its own file from the earlier period: they are kept, and
   * one audit row lists them.
   */
  private noteOperatorRecordsKept(): void {
    if (this.cfg.peerOnly || !this.queueControlsOn()) return;
    const noticed = this.operator.leaseNoticeSentAt() !== null;
    this.operatorLeaseMisses = 0;
    if (noticed) { this.operator.setLeaseNotice(null); this.operator.persist(); }
    if (this.operator.size() === 0) return;
    this.audit({ event: 'operator-records-kept', held: this.operator.held().map((r) => r.pr), fronted: this.operator.fronted().map((r) => r.pr) });
  }

  /**
   * This machine holds records and no longer holds the coordinator lease: the machine that took
   * over cannot read this file and starts with no holds. One notice lists each held and fronted
   * change with its reason, so they can be set again there.
   */
  private noticeOperatorLeaseLost(holder: string | null): void {
    const held = this.operator.held().map((r) => ({ pr: r.pr, reason: r.hold!.reason, by: r.hold!.by }));
    const fronted = this.operator.fronted().map((r) => ({ pr: r.pr, reason: r.front!.reason, by: r.front!.by }));
    this.operator.setLeaseNotice(this.now());
    this.operator.persist();
    const line = (x: { pr: number; reason: string; by: string }) => `PR #${x.pr} (${x.reason}; set by ${x.by})`;
    const note = `This machine no longer runs the test line${holder ? ` (${holder} does now)` : ''}, and the machine that took over does not know these choices. Held back from testing here: ${held.length ? held.map(line).join('; ') : 'none'}. Moved to the front here: ${fronted.length ? fronted.map(line).join('; ') : 'none'}. Set them again on the machine that runs the line now.`;
    const key = `local-verify:operator-lease-moved:${new Date(this.now()).toISOString()}`;
    const attention = () => this.signal(key, { note, holder, held, fronted });
    const row = (to: 'operating-session' | 'attention', why?: string, phase?: string | null) =>
      this.audit({ event: 'operator-lease-lost', holder, held: held.map((h) => h.pr), fronted: fronted.map((f) => f.pr), announcedTo: to, ...(why ? { why } : {}), ...(phase !== undefined ? { phase } : {}) });
    const send = this.operatorNotifier;
    if (!send) { row('attention', 'no-operating-session-set'); attention(); return; }
    // The operating session is told directly; the attention item is the fallback when no session is set or the message could not be sent.
    const work: Promise<void> = Promise.resolve()
      .then(() => send({ subject: 'Local Verify: held changes stayed on a machine that no longer runs the line', body: note }))
      .then((r) => { if (r.sent) row('operating-session', undefined, r.phase ?? null); else { row('attention', 'not-delivered', r.phase ?? null); attention(); } },
        (e) => { row('attention', `send-failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`); attention(); });
    this.pendingMainWork.push(work);
    void work.finally(() => { const i = this.pendingMainWork.indexOf(work); if (i >= 0) this.pendingMainWork.splice(i, 1); });
  }

  /** Switch off: every held change that was wanted (queued, waiting, requested or fronted) goes back through ordinary admission. */
  private async readmitHeldWhileOff(): Promise<void> {
    if (!this.operator.anyHold() && !this.operator.anyFront()) return;
    if (!this.leaseState().holds) return;
    let changed = false;
    for (const r of this.operator.records()) {
      if (this.stopped) break;
      const f = this.operator.get(r.pr)?.front;
      if (f?.admitting) {
        // A front that was still admitting when the switch went off: one ordinary request, then nothing pending.
        const res = await this.request(r.pr, { explicit: true });
        if (!res.ok && (res.code === 'pr-unreadable' || res.code === 'pr-invalid-shas') && (f.tries = (f.tries ?? 0) + 1) <= OPERATOR_QUEUE_LIMITS.pendingRetries) { changed = true; continue; }
        const cur = this.operator.get(r.pr)?.front;
        if (cur) { delete cur.admitting; delete cur.tries; changed = true; }
      }
      const h = this.operator.get(r.pr)?.hold;
      if (!h || !(h.entry || h.waiter || h.wanted || h.releasing)) continue;
      const heldMs = h.takenAt !== undefined ? Math.max(0, this.now() - h.takenAt) : 0;
      let placed = 'already-placed';
      if (!this.operatorPresent(r.pr) && !this.waiting.get(r.pr)) {
        if (h.entry && this.prQueueLength() < LOCAL_VERIFY_LIMITS.queueCap) {
          this.queue.push(this.entryFromSaved(r.pr, h.entry, heldMs));
          placed = 'queue';
        } else if (h.entry || h.waiter) {
          // No free place (or it was waiting): the waiting list, with the time it first waited.
          this.waiting.put(r.pr, h.waiter?.firstRefusedAt ?? h.entry?.firstRefusedAt ?? h.entry?.firstQueuedAt ?? this.now(), h.waiter ? { refusals: h.waiter.refusals } : {});
          placed = 'waiting-list';
        } else if (h.wanted) {
          const res = await this.request(r.pr, { explicit: h.wanted !== 'watcher' });
          if (!res.ok && (res.code === 'pr-unreadable' || res.code === 'pr-invalid-shas')) {
            // Asked again on the next tick, a bounded number of times; then the request is given up (audited below).
            const tries = (this.operatorReadmitTries.get(r.pr) ?? 0) + 1;
            this.operatorReadmitTries.set(r.pr, tries);
            if (tries <= OPERATOR_QUEUE_LIMITS.pendingRetries) continue;
          }
          this.operatorReadmitTries.delete(r.pr);
          placed = res.ok ? res.status : res.code;
        } else placed = 'none';
      }
      const cur = this.operator.get(r.pr);
      if (!cur?.hold) continue; // dropped as closed while it was read
      if (cur.hold.releasing) this.operator.clearHold(r.pr); // a release in progress simply ends
      else { delete cur.hold.entry; delete cur.hold.waiter; delete cur.hold.wanted; delete cur.hold.takenAt; }
      changed = true;
      this.audit({ event: 'operator-readmitted-switch-off', pr: r.pr, placed });
    }
    if (changed) { this.operator.persist(); this.pump(); }
  }

  /**
   * Hourly, on the coordinator: a held or fronted change that has closed is dropped; a hold
   * past its `until`, or 24 hours old with none, is reminded ONCE. Holds found due at the same
   * check share one attention item, whose id carries the check time.
   */
  private async checkOperatorHolds(): Promise<void> {
    const now = this.now();
    this.operatorCheckAt = now;
    const due: OperatorRecord[] = [];
    const rest: OperatorRecord[] = [];
    for (const r of this.operator.records()) (r.hold && !r.hold.releasing && holdReminderDue(r.hold, now) ? due : rest).push(r);
    // Closed changes: every due hold is checked (a closed one is dropped, not reminded), plus a bounded, rotating part of the rest.
    const n = Math.min(OPERATOR_QUEUE_LIMITS.closedChecksPerPass, rest.length);
    const start = rest.length ? this.operatorClosedCursor % rest.length : 0;
    this.operatorClosedCursor = rest.length ? (start + n) % rest.length : 0;
    const sample = Array.from({ length: n }, (_, i) => rest[(start + i) % rest.length]);
    const stillDue: OperatorRecord[] = [];
    for (const r of [...due, ...sample]) {
      if (this.stopped) return;
      const open = await this.seams.isPrOpen(r.pr).catch(() => null);
      if (open === false) this.operatorOnClosed(r.pr);
      else if (due.includes(r) && this.operator.get(r.pr)?.hold) stillDue.push(r);
    }
    if (stillDue.length === 0) return;
    const items = stillDue.flatMap((r) => {
      const h = this.operator.get(r.pr)?.hold;
      if (!h || h.releasing || !holdReminderDue(h, now)) return [];
      h.reminded = true;
      this.audit({ event: 'operator-hold-due', pr: r.pr, by: h.by, reason: h.reason, heldMs: now - h.at, ...(h.until !== undefined ? { until: safeIso(h.until) } : {}) });
      return [{ pr: r.pr, by: h.by, reason: h.reason, heldHours: Math.round((now - h.at) / 3_600_000), until: h.until !== undefined ? safeIso(h.until) : null }];
    });
    if (items.length === 0) return;
    this.operator.persist();
    const line = (x: (typeof items)[number]) => `PR #${x.pr} (held ${x.heldHours} h by ${x.by}: ${x.reason}${x.until ? `; expected release ${x.until}` : ''})`;
    this.signal(`local-verify:operator-hold-due:${new Date(now).toISOString()}`, {
      note: `${items.length === 1 ? 'A change is' : `${items.length} changes are`} still held back from testing past ${items.length === 1 ? 'its' : 'their'} expected release: ${items.map(line).join('; ')}. A held change is not tested and cannot merge on a new result. Release it when it should be tested again; this reminder is sent once per hold.`,
      holds: items,
    });
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
      // A `main` entry is saved only while a peer holds it: the reservation must outlive a restart.
      for (const e of this.queue) if ((e.kind !== 'main' || e.remote) && !e.peerAttempt && !entries.includes(e)) entries.push(e);
      const out: PersistedQueueEntry[] = entries.map((e) => ({
        ...(e.kind === 'main' ? { kind: 'main' as const } : {}),
        pr: e.pr, headSha: e.headSha, baseSha: e.baseSha, baseRefName: e.baseRefName,
        firstQueuedAt: e.firstQueuedAt, attempts: e.attempts, errorRetries: e.errorRetries, starvedRaised: e.starvedRaised,
        ...(e.firstRefusedAt !== undefined ? { firstRefusedAt: e.firstRefusedAt } : {}),
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
      const prOk = x && x.kind === 'main' ? x.pr === MAIN_VERIFY_PR && isRemoteMarker(x.remote) && x.remote.dispatched.kind === 'main' : !!x && x.kind === undefined && isValidPr(x.pr);
      return !!x && prOk && isValidSha(x.headSha) && isValidSha(x.baseSha) && typeof x.baseRefName === 'string'
        && Number.isFinite(x.firstQueuedAt) && Number.isFinite(x.attempts) && Number.isFinite(x.errorRetries);
    }).map((x) => ({
      ...x, starvedRaised: x.starvedRaised === true,
      firstRefusedAt: Number.isFinite(x.firstRefusedAt) && (x.firstRefusedAt as number) > 0 ? x.firstRefusedAt : undefined,
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
    // The restart guard's "pid first seen gone" note belongs to the run whose marker just went.
    try { SafeFsExecutor.safeRmSync(exitSeenPath(this.cfg.stateDir), { force: true, operation: 'local-verify:clear-exit-seen' }); } catch { /* @silent-fallback-ok: it is keyed by the attempt token, so a leftover never applies to another run */ }
  }

  private readResult(p: string): (VerifyRunResult | { kind: 'crash'; detail: string }) | null {
    // Only a JSON object can be a result. A file holding a bare string, number or `null` parses
    // without error, and the exit handler's `'degradations' in result` then threw on it: an
    // unhandled rejection in the server, and no record for the run.
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(p, 'utf-8'));
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as VerifyRunResult | { kind: 'crash'; detail: string } : null;
    } catch { return null; } // @silent-fallback-ok: an absent or unparseable result file is "no result"; the caller records the crash
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
  private noteFlaky(record: LocalVerifyRecord, opts: { signal?: boolean; mainEvidence?: { runLog: string; lines?: unknown } } = {}): void {
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
      if (opts.mainEvidence && record.kind === 'main' && record.outcome === 'success') this.noteMainSeen(h, f, record.finishedAt, opts.mainEvidence, nowMs);
      hist.files[f.file] = h;
      const key = `local-verify:flaky:${f.file}`;
      if (this.flakySignalled.has(key)) continue;
      this.flakySignalled.add(key);
      this.signal(key, base);
    }
    if (opts.signal !== false) this.writeFlakyHistory(hist);
  }

  /**
   * Main evidence for one file of a green `main` verify this machine ran: every name that failed
   * in the lane AND was reported passed by name when the file ran alone. One entry per test with
   * its newest time, 7 days, at most 40 per file (newest kept). A name dropped by that cap, or
   * left out of the record for its length, marks the file `mainSeenCut`.
   */
  private noteMainSeen(h: FlakyHistory['files'][string], f: FlakyRetry, at: string, src: { runLog: string; lines?: unknown }, nowMs: number): void {
    const L = IMPORT_RELATED_RERUN;
    const fresh = (iso: string) => nowMs - Date.parse(iso) <= FLAKY_REPEAT.windowMs;
    let list = (Array.isArray(h.mainSeen) ? h.mainSeen : []).filter((e) => usableMainSeen(e) && fresh(e.at));
    // The record holds fewer names than failed (a name over the length bound, or more than 20): disclosed.
    let cut = (f.failedTestsTotal ?? 0) > (f.failedTests?.length ?? 0);
    const linesOf = src.lines && typeof src.lines === 'object' ? (src.lines as Record<string, unknown>)[f.file] : undefined;
    const lines = Array.isArray(linesOf) ? linesOf as Array<{ test?: unknown; line?: unknown; lineCut?: unknown }> : [];
    if (typeof f.testSetHash === 'string' && /^[0-9a-f]{64}$/.test(f.testSetHash)) {
      for (const name of new Set(f.soloPassedByName ?? [])) {
        if (name.length < 1 || name.length > L.nameChars) { cut = true; continue; }
        const prev = list.find((e) => e.test === name);
        if (prev && prev.at > at) continue; // one entry per test, the newest time
        const found = lines.find((x) => x && x.test === name);
        const raw = found && typeof found.line === 'string' ? found.line : '';
        const line = boundedHead(raw, L.lineChars);
        list = list.filter((e) => e.test !== name);
        list.push({ test: name, at, line, ...(found?.lineCut === true || line !== raw ? { lineCut: true as const } : {}), setHash: f.testSetHash, runLog: /^[0-9a-f]{16,64}\.log$/.test(src.runLog) ? src.runLog : '' });
      }
    }
    if (list.length > L.namesPerFile) {
      list = list.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).slice(-L.namesPerFile);
      cut = true;
    }
    if (list.length > 0) h.mainSeen = list; else delete h.mainSeen;
    if (cut) h.mainSeenCut = new Date(nowMs).toISOString();
    else if (typeof h.mainSeenCut === 'string' && !fresh(h.mainSeenCut)) delete h.mainSeenCut;
  }

  /**
   * The list of main-flaky tests offered with a PR run, from `mainSeen` ONLY (never from `seen`
   * or `notCleanOnGreenMain`), inside its bounds: 7 days, 40 names per file, 200 files (those
   * with the newest evidence), and 8 MB for the whole serialized isolation block measured in
   * UTF-8 bytes (oldest evidence dropped first). Every cut marks the file `namesCut` and is
   * audited, and a cut only ever removes eligibility.
   */
  private flakyOnMainList(hist: FlakyHistory, base: { allowed: boolean; notCleanOnGreenMain: readonly string[] }): FlakyOnMainFile[] {
    const L = IMPORT_RELATED_RERUN;
    const now = this.now();
    const fresh = (iso: string) => now - Date.parse(iso) <= FLAKY_REPEAT.windowMs;
    const newest = (f: FlakyOnMainFile) => f.tests.reduce((m, t) => (t.at > m ? t.at : m), '');
    let files: FlakyOnMainFile[] = [];
    for (const [file, h] of Object.entries(hist.files)) {
      if (!h || typeof h !== 'object' || file.length < 1 || file.length > 300) continue;
      const stored = Array.isArray(h.mainSeen) ? h.mainSeen.filter((e) => usableMainSeen(e) && fresh(e.at)) : [];
      const tests = [...stored].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, L.namesPerFile)
        .map((e) => ({ test: e.test, at: e.at, line: e.line, ...(e.lineCut === true ? { lineCut: true as const } : {}), setHash: e.setHash, runLog: e.runLog }));
      const cut = tests.length < stored.length || (typeof h.mainSeenCut === 'string' && !Number.isNaN(Date.parse(h.mainSeenCut)) && fresh(h.mainSeenCut));
      if (tests.length === 0 && !cut) continue;
      files.push({ file, tests, ...(cut ? { namesCut: true as const } : {}) });
    }
    const bounded: Record<string, unknown> = {};
    if (files.length > L.wireFiles) {
      const total = files.length;
      files = files.sort((a, b) => (newest(a) < newest(b) ? 1 : newest(a) > newest(b) ? -1 : a.file < b.file ? -1 : 1)).slice(0, L.wireFiles);
      bounded.files = total;
      bounded.keptFiles = files.length;
    }
    files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    // A body limit is in bytes and the bounds above are in characters: measure the block as it is sent.
    const size = () => Buffer.byteLength(JSON.stringify({ ...base, importRelatedRerun: true, flakyOnMain: files }), 'utf8');
    const before = size();
    if (before > L.wireBytes) {
      const oldestFirst = files.flatMap((f) => f.tests.map((t) => ({ f, t }))).sort((a, b) => (a.t.at < b.t.at ? -1 : a.t.at > b.t.at ? 1 : 0));
      const gone = new Set<FlakyOnMainTest>();
      let estimate = before;
      let i = 0;
      const drop = () => {
        const { f, t } = oldestFirst[i++];
        gone.add(t);
        estimate -= Buffer.byteLength(JSON.stringify(t), 'utf8') + 1;
        if (!f.namesCut) { f.namesCut = true; estimate += '"namesCut":true,'.length; }
      };
      const apply = () => { for (const f of files) if (f.tests.some((t) => gone.has(t))) f.tests = f.tests.filter((t) => !gone.has(t)); };
      // Bounded: at most one pass over the (already bounded) entries, then exact re-measures while still over.
      while (estimate > L.wireBytes && i < oldestFirst.length) drop();
      apply();
      while (size() > L.wireBytes && i < oldestFirst.length) { drop(); apply(); }
      bounded.bytes = before;
      bounded.bytesLimit = L.wireBytes;
      bounded.droppedTests = gone.size;
      bounded.bytesAfter = size();
    }
    if (Object.keys(bounded).length > 0) this.audit({ event: 'flaky-on-main-bounded', ...bounded });
    return files;
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
    h.greenMain = { headSha: record.headSha, finishedAt: record.finishedAt, notClean: (record.flakyRetried ?? []).map((f) => f.file), origin: 'local' };
    this.writeFlakyHistory(h);
  }

  /**
   * What a PR verify's isolation re-run may use: allowed only with a green main record on this
   * machine. `importRelatedRerun` is the live switch and `flakyOnMain` the named tests a `main`
   * verify here saw fail and pass alone (empty when the switch is off, or nothing is allowed):
   * with both, a failed file that imports a changed file may be re-run three times (spec
   * local-verify-import-related-rerun.md). Read when a run starts and once per peer dispatch.
   */
  isolationInput(): { allowed: boolean; notCleanOnGreenMain: string[]; importRelatedRerun: boolean; flakyOnMain: FlakyOnMainFile[] } {
    const hist = this.readFlakyHistory();
    const g = hist.greenMain;
    // SEC-113 D2.1: checked on every read. A record without `origin: 'local'` (written by older code,
    // possibly from a peer green, including after a rollback) never enables isolation re-runs.
    const base = g && g.origin === 'local' ? { allowed: true, notCleanOnGreenMain: g.notClean } : { allowed: false, notCleanOnGreenMain: [] as string[] };
    const on = this.importRelatedRerunOn();
    return { ...base, importRelatedRerun: on, flakyOnMain: on && base.allowed ? this.flakyOnMainList(hist, base) : [] };
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
  /** The trusted logins for eligibility, with the operator login read live when a reader is wired. */
  private logins(): { expectedGhLogin: string; operatorGhLogin: string | null } {
    const live = this.cfg.liveOperatorGhLogin;
    return { expectedGhLogin: this.cfg.expectedGhLogin, operatorGhLogin: live ? live() : (this.cfg.operatorGhLogin ?? null) };
  }

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
