/**
 * The `instar/local-verify` status reconcile loop (spec
 * docs/specs/local-verify-merge-authority.md §3 "Posting discipline" …
 * "Withdrawal"). Runs on the serving-lease holder every 60 seconds, independent of
 * the green-PR watcher's breaker, warm-up, rollback latch and pool pause.
 *
 * Each pass: refresh the floor gate (GitHub's real settings) → note the remote
 * `main` head (the service enqueues a debounced `main` verify) → list every open PR
 * with base `main` (no author filter, paginated) → for each head, project the state
 * and post ONLY when it differs from what GitHub reports for the context on that
 * head. A failed PR listing posts nothing.
 *
 * One serialized writer per head, shared by the loop, the event-driven withdrawal
 * and the verify-completion path: the state is re-projected immediately before each
 * send, the post is awaited, and only then is the cache updated — so a `success`
 * computed before a withdrawal can never land after it.
 *
 * Posting defaults to DRY-RUN (`monitoring.localVerify.postStatuses`, default
 * false): the posts it would make are audited and nothing is posted.
 */

import { checkEligibility, type LocalVerifyService } from './LocalVerifyService.js';
import type { FloorGate } from './floorGate.js';
import {
  LOCAL_VERIFY_STATUS_CONTEXT, projectHead, projectLocal,
  type CheckRunView, type ContextPin, type EvaluateRequiredContexts, type FloorMode, type ProjectedState, type Projection, type ProjectionInput,
} from './statusProjection.js';

const MIN = 60_000;
export const RECONCILER_LIMITS = Object.freeze({
  intervalMs: MIN,
  stuckAfterMs: 15 * MIN,
  mirrorPendingAfterMs: 6 * 60 * MIN,
  retryBaseMs: 30_000,
  retryMaxMs: 10 * MIN,
  /** Global cap on status posts per rolling minute; the excess is deferred to the next pass. */
  postsPerMinute: 30,
  /** Backoff after a PR-listing failure (whole pass) or a check-run read failure (that head's mirror reads): base doubling, capped. */
  passBackoffBaseMs: 2 * MIN,
  passBackoffMaxMs: 15 * MIN,
  /** A rollup with this many entries may be truncated (gh reads the first 100 contexts). */
  rollupTruncationAt: 100,
});

// ---- the reconciler's self-action decisions (pure; the reconciler calls these, and
//      the self-action registry drives the SAME functions under sustained pressure —
//      tests/unit/self-action-convergence.test.ts) ----

/**
 * Post admission against the global per-minute cap. A withdrawal (a post away from
 * `success`) is exempt and is never delayed; any other post is admitted only while
 * fewer than `postsPerMinute` posts happened in the last rolling minute. Returns the
 * post-time window pruned to that minute (unchanged for a withdrawal).
 */
export function admitStatusPost(
  i: { withdrawal: boolean; postTimes: readonly number[]; now: number },
  limits: { postsPerMinute: number } = RECONCILER_LIMITS,
): { admit: boolean; reason: 'withdrawal-exempt' | 'under-cap' | 'rate-limited'; postTimes: number[] } {
  if (i.withdrawal) return { admit: true, reason: 'withdrawal-exempt', postTimes: [...i.postTimes] };
  const pruned = pruneWindow(i.postTimes, i.now);
  return pruned.length >= limits.postsPerMinute
    ? { admit: false, reason: 'rate-limited', postTimes: pruned }
    : { admit: true, reason: 'under-cap', postTimes: pruned };
}

/** Drop leading post times older than one minute (the array is time-ordered). */
function pruneWindow(postTimes: readonly number[], now: number): number[] {
  let k = 0;
  while (k < postTimes.length && now - postTimes[k] >= MIN) k++;
  return postTimes.slice(k);
}

/** A head's failed-post backoff has elapsed (or it never failed): the pass may re-submit it. */
export function postRetryDue(r: { nextAt: number } | undefined, now: number): boolean {
  return !r || r.nextAt <= now;
}

/** After a failed post: per-head backoff, base doubling, capped. */
export function nextPostRetry(
  prev: { attempts: number } | undefined,
  now: number,
  limits: { retryBaseMs: number; retryMaxMs: number } = RECONCILER_LIMITS,
): { attempts: number; nextAt: number; delayMs: number } {
  const attempts = (prev?.attempts ?? 0) + 1;
  const delayMs = Math.min(limits.retryBaseMs * 2 ** (attempts - 1), limits.retryMaxMs);
  return { attempts, nextAt: now + delayMs, delayMs };
}

/** The backoff after `failures` consecutive PR-listing (or check-run read) failures: 2 min doubling, capped at 15. */
export function passBackoffDelay(
  failures: number,
  limits: { passBackoffBaseMs: number; passBackoffMaxMs: number } = RECONCILER_LIMITS,
): number {
  return Math.min(limits.passBackoffBaseMs * 2 ** (failures - 1), limits.passBackoffMaxMs);
}

/** Submission order for one pass: withdrawals first (the per-minute cap never delays them), stable otherwise. */
export function orderSubmissions<T extends { withdraw: boolean }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => Number(b.withdraw) - Number(a.withdraw));
}

export type RollupEntry =
  | { kind: 'status'; context: string; state: string }
  | { kind: 'check'; name: string; status: string | null; conclusion: string | null };

export interface OpenPr {
  number: number;
  headSha: string;
  baseRefName: string;
  headRefName: string;
  author: string | null;
  isCrossRepository: boolean;
  rollup: RollupEntry[];
  /** True when the rollup may be cut off (then a missing context is never "absent"). */
  rollupTruncated: boolean;
}

export type ObservedState = ProjectedState | 'absent';

export interface CombinedStatusRead { state: ObservedState; creator: string | null; description: string | null }

export interface StatusReconcilerSeams {
  /** Every open PR with base main, paginated past 100; null on any failure. */
  listOpenPrs(): Promise<OpenPr[] | null>;
  /** The remote `main` head; null on failure. */
  readMainHead(): Promise<string | null>;
  /** The latest `instar/local-verify` status on a commit (combined-status API); null = unreadable. */
  readCombinedStatus(sha: string): Promise<CombinedStatusRead | null>;
  /** Check runs with producers on a head; null = unreadable. */
  readCheckRuns(sha: string): Promise<CheckRunView[] | null>;
  postStatus(sha: string, state: ProjectedState, description: string): Promise<{ ok: true } | { ok: false; status: number | null; detail: string }>;
  holdsLease(): boolean;
  leaseEpoch(): number | null;
  /** The current lease holder's machine id, as this machine sees it (null = unknown). */
  leaseHolder(): string | null;
  now(): number;
  setTimer(fn: () => void, ms: number): void;
  signal?(key: string, detail: Record<string, unknown>): void;
  audit(event: Record<string, unknown>): void;
}

export interface StatusReconcilerConfig {
  repo: string;
  /** The agent's own GitHub login (the only expected creator of the status). */
  agentLogin: string;
  operatorGhLogin: string | null;
  machineId: string;
  /** `monitoring.localVerify.postStatuses`, read live (default false = dry-run). */
  postStatuses(): boolean;
  /** `monitoring.localVerify.enabled`, read live. When false, only the mirror runs, and only while the check is required. */
  localVerifyEnabled(): boolean;
  /** The Actions-floor context list (an input; safe-merge's constant is passed in by the wiring). */
  actionsFloor: readonly ContextPin[];
  /** safe-merge's evaluateRequiredContexts. */
  evaluate: EvaluateRequiredContexts;
}

interface HeadContext { prs: OpenPr[] }

interface Observed { state: ObservedState; by: 'github' | 'self' }

export interface PassResult {
  at: string;
  outcome: 'ok' | 'not-holder' | 'list-failed' | 'inactive' | 'busy' | 'backoff';
  heads: number;
  submitted: number;
  floorState: string;
}

function normalizeRollupState(s: string): ObservedState {
  switch (s.toUpperCase()) {
    case 'SUCCESS': return 'success';
    case 'PENDING': return 'pending';
    case 'FAILURE':
    case 'ERROR': return 'failure';
    default: return 'absent'; // EXPECTED: required but never posted
  }
}

function rollupFingerprint(rollup: RollupEntry[]): string {
  return rollup
    .filter((r): r is Extract<RollupEntry, { kind: 'check' }> => r.kind === 'check')
    .map((r) => `${r.name}|${r.status ?? ''}|${r.conclusion ?? ''}`)
    .sort()
    .join('\n');
}

export class StatusReconciler {
  private readonly observed = new Map<string, Observed>();
  private readonly contexts = new Map<string, HeadContext>();
  private readonly mirrorRuns = new Map<string, { fp: string; runs: CheckRunView[] | null }>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly retries = new Map<string, { attempts: number; nextAt: number; lastError: string }>();
  private readonly wouldPosted = new Map<string, string>();
  private readonly stuckSince = new Map<string, number>();
  private readonly mirrorPendingSince = new Map<string, number>();
  private readonly raised = new Set<string>();
  private wasHolder = false;
  private acquiredEpoch: number | null = null;
  private lastSeenOtherHolder: string | null = null;
  private passing = false;
  /** The pass in flight (so a caller that needs a fresh listing can wait for it instead of a `busy` answer). */
  private passPromise: Promise<PassResult> | null = null;
  private lastPass: PassResult | null = null;
  /** Completed-post sequence: a rollup listed before a post completed must not overwrite it. */
  private postSeq = 0;
  private readonly lastPostSeq = new Map<string, number>();
  /** The last state THIS server successfully posted on each head. */
  private readonly selfPosted = new Map<string, ProjectedState>();
  /** Heads that left the listing while holding a server-posted success: withdrawn next. */
  private readonly droppedPending = new Set<string>();
  private readonly postTimes: number[] = [];
  /** Per-head backoff of the mirror's check-run reads after read failures. */
  private readonly checkRunBackoff = new Map<string, { failures: number; nextAt: number }>();
  private passFailures = 0;
  private nextPassAt = 0;
  private timerStarted = false;
  private stopped = false;

  constructor(
    private readonly cfg: StatusReconcilerConfig,
    private readonly seams: StatusReconcilerSeams,
    private readonly floorGate: FloorGate,
    private readonly service: LocalVerifyService | null,
  ) {}

  // ---- lifecycle ----

  /** Run a pass now (boot), then every 60 s. */
  start(): void {
    if (this.timerStarted) return;
    this.timerStarted = true;
    const loop = () => {
      if (this.stopped) return;
      void this.pass().catch((e) => this.seams.audit({ event: 'pass-error', detail: e instanceof Error ? e.message : String(e) }))
        .finally(() => { if (!this.stopped) this.seams.setTimer(loop, RECONCILER_LIMITS.intervalMs); });
    };
    loop();
  }

  stop(): void { this.stopped = true; }

  /** Resolves when every queued per-head write has settled (tests). */
  async drain(): Promise<void> {
    while (this.chains.size) await Promise.allSettled([...this.chains.values()]);
  }

  // ---- read surface ----

  /** Heads whose last projected/posted status is `success` (the restart hold reads this; synchronous). */
  successHeads(): string[] {
    return [...this.observed.entries()].filter(([, o]) => o.state === 'success').map(([h]) => h);
  }

  /**
   * The floor in force for an eligible PR of the configured repo: `local` only when
   * the config says local, the verifier is on, and GitHub's settings make it
   * effective (§4). The watcher and safe-merge (via GET /local-verify/status) read this.
   */
  effectiveFloor(): FloorMode {
    return this.cfg.localVerifyEnabled() && this.service !== null && this.floorGate.state() === 'effective' ? 'local' : 'actions';
  }

  /**
   * The GET /local-verify/status body. `floor` and `mainHealth` are the contract
   * safe-merge's `selectSafeMergeFloor` / `evaluateLocalPredicate` read:
   * `floor: { configured, effective, reason }`, `mainHealth: { state, mainHead }`
   * (null without a verifier ⇒ safe-merge refuses as unmeasurable).
   */
  status(): Record<string, unknown> {
    const gate = this.floorGate.status();
    const effective = this.effectiveFloor();
    const reason = effective === 'local' ? 'ok'
      : gate.configFloor !== 'local' ? 'config-actions'
        : !this.cfg.localVerifyEnabled() || this.service === null ? 'verifier-disabled'
          : gate.state;
    const mh = this.service?.mainHealth() ?? null;
    return {
      floor: { configured: gate.configFloor, effective, reason, settingsState: gate.state, checkRequired: gate.checkRequired, settings: gate.settings, lastReadAt: gate.lastReadAt },
      mainHealth: mh ? { state: mh.state, mainHead: mh.currentMainHead, redHead: mh.redHead, reason: mh.reason, lastGreenHead: mh.lastGreenHead, pendingMainHead: mh.pendingMainHead, mainInFlight: mh.mainInFlight } : null,
      // The spec's pool-wide floor comparison on lease takeover reads the previous
      // holder's audit log, which is machine-local; it is not built (accepted).
      takeoverFloorCheck: 'not-built',
      mode: this.cfg.postStatuses() ? 'live' : 'dry-run',
      localVerifyEnabled: this.cfg.localVerifyEnabled(),
      holdsLease: this.wasHolder,
      acquiredEpoch: this.acquiredEpoch,
      lastPass: this.lastPass,
      heads: this.contexts.size,
      stuckHeads: [...this.stuckSince.entries()].map(([head, since]) => ({ head, since: new Date(since).toISOString() })),
      mirrorPending: [...this.mirrorPendingSince.entries()].map(([head, since]) => ({ head, since: new Date(since).toISOString() })),
      failedPosts: [...this.retries.entries()].map(([head, r]) => ({ head, attempts: r.attempts, nextAt: new Date(r.nextAt).toISOString(), lastError: r.lastError })),
      droppedPending: [...this.droppedPending],
      settingsReadable: this.floorGate.settingsReadable(),
      checkRunBackoff: [...this.checkRunBackoff.entries()].map(([head, b]) => ({ head, failures: b.failures, nextAt: new Date(b.nextAt).toISOString() })),
      requiredButNotPosting: this.raised.has('local-verify:required-but-not-posting'),
      passBackoff: this.passFailures > 0 ? { failures: this.passFailures, nextPassAt: new Date(this.nextPassAt).toISOString() } : null,
    };
  }

  // ---- event-driven entry points ----

  /** The verify-completion path (LocalVerifyService.onRecord). */
  onRecord(headSha: string): void {
    if (this.contexts.has(headSha)) void this.submit(headSha, 'record');
  }

  /** Whether the last pass listed this head on an open PR to main (a head the loop can post for). */
  knowsHead(headSha: string): boolean { return this.contexts.has(headSha); }

  /** The `instar/local-verify` state GitHub is known to hold for a head (read back, or just posted); null when unknown. */
  headState(headSha: string): string | null { return this.observed.get(headSha)?.state ?? null; }

  /** Whether posts are live (`monitoring.localVerify.postStatuses`); in dry-run GitHub never gets the status. */
  postingLive(): boolean { return this.cfg.postStatuses(); }

  /**
   * Entering main-suspect / main-red: post `pending` on every success head the
   * repair rule no longer admits, without waiting for the loop.
   */
  withdrawAll(reason: string): void {
    // Every known head: send re-projects and posts only where GitHub disagrees, so
    // a stale cache entry can never make a success head skip its withdrawal.
    for (const head of this.contexts.keys()) void this.submit(head, `withdraw:${reason}`);
  }

  // ---- the pass ----

  private safeHolds(): boolean {
    try { return this.seams.holdsLease(); } catch { return false; } // @silent-fallback-ok — an unreadable lease reads as NOT held: a standby never posts
  }

  private safeEpoch(): number | null {
    try { return this.seams.leaseEpoch(); } catch { return null; } // @silent-fallback-ok — an unknown epoch never matches, so nothing posts
  }

  private onAcquired(epoch: number | null): void {
    const foreign = this.lastSeenOtherHolder !== null && this.lastSeenOtherHolder !== this.cfg.machineId;
    this.acquiredEpoch = epoch;
    this.observed.clear(); // rebuilt from GitHub, never by blind re-posting
    this.wouldPosted.clear();
    this.stuckSince.clear();
    this.lastSeenOtherHolder = null;
    this.seams.audit({ event: 'lease-acquired', machineId: this.cfg.machineId, epoch, foreignHolder: foreign });
    this.service?.onLeaseAcquired({ foreignHolder: foreign, epoch });
  }

  /** A pass, or the one already running: never `busy` (the merge line's "list this head first"). */
  awaitPass(): Promise<PassResult> {
    return this.passPromise ?? this.pass();
  }

  async pass(): Promise<PassResult> {
    const at = new Date(this.seams.now()).toISOString();
    if (this.passing) return { at, outcome: 'busy', heads: 0, submitted: 0, floorState: this.floorGate.state() };
    this.passing = true;
    let settle!: (r: PassResult) => void;
    this.passPromise = new Promise<PassResult>((r) => { settle = r; });
    try {
      let result: PassResult;
      try { result = await this.passInner(at); } catch (e) { settle({ at, outcome: 'list-failed', heads: 0, submitted: 0, floorState: this.floorGate.state() }); throw e; }
      settle(result);
      this.lastPass = result;
      return result;
    } finally {
      this.passing = false;
      this.passPromise = null;
    }
  }

  private async passInner(at: string): Promise<PassResult> {
    /* @self-action-controller: local-verify-status-pass-backoff */
    if (this.seams.now() < this.nextPassAt) {
      return { at, outcome: 'backoff', heads: 0, submitted: 0, floorState: this.floorGate.state() };
    }
    // The floor is read on every machine: a standby's safe-merge reads its own
    // /local-verify/status, which must report GitHub's real settings, not a default.
    await this.floorGate.refresh();
    if (!this.floorGate.settingsReadable()) {
      // Unreadable settings never stop the pass: the check counts as required (the
      // mirror stays on), the floor stays actions, and withdrawals still go out.
      // Only the mirror's per-head check-run reads back off after read failures.
      this.seams.audit({ event: 'settings-unreadable' });
    }
    if (!this.safeHolds()) {
      if (this.wasHolder) this.seams.audit({ event: 'lease-lost', machineId: this.cfg.machineId, epoch: this.acquiredEpoch });
      this.wasHolder = false;
      let holder: string | null = null;
      try { holder = this.seams.leaseHolder(); } catch { holder = null; } // @silent-fallback-ok — unknown holder: the watermark decides at acquisition
      if (holder && holder !== this.cfg.machineId) this.lastSeenOtherHolder = holder;
      return { at, outcome: 'not-holder', heads: 0, submitted: 0, floorState: this.floorGate.state() };
    }
    const epoch = this.safeEpoch();
    if (!this.wasHolder || epoch !== this.acquiredEpoch) {
      this.wasHolder = true;
      this.onAcquired(epoch);
    }

    // GitHub requires the check but nothing is posted (dry-run): every PR is blocked.
    if (this.floorGate.checkRequiredKnown() === true && !this.cfg.postStatuses()) {
      this.raise('local-verify:required-but-not-posting', 'local-verify:required-but-not-posting', { severity: 'HIGH', note: 'GitHub requires instar/local-verify but monitoring.localVerify.postStatuses is false' });
    } else {
      this.raised.delete('local-verify:required-but-not-posting');
    }

    const enabled = this.cfg.localVerifyEnabled() && this.service !== null;
    if (!enabled && !this.floorGate.checkRequired()) {
      return { at, outcome: 'inactive', heads: 0, submitted: 0, floorState: this.floorGate.state() };
    }

    if (this.service) {
      const mainHead = await this.seams.readMainHead().catch(() => null);
      this.service.noteMainHead(mainHead); // null ⇒ head unknown ⇒ no repair admission
    }

    const listSeq = this.postSeq; // posts completing after this point beat the listing's rollup
    const prs = await this.seams.listOpenPrs().catch(() => null);
    if (prs === null) {
      this.seams.audit({ event: 'list-failed' });
      this.backoffPass();
      return { at, outcome: 'list-failed', heads: 0, submitted: 0, floorState: this.floorGate.state() };
    }

    const byHead = new Map<string, OpenPr[]>();
    for (const pr of prs) {
      if (pr.baseRefName !== 'main' || !/^[0-9a-f]{40}$/.test(pr.headSha)) continue;
      const list = byHead.get(pr.headSha) ?? [];
      list.push(pr);
      byHead.set(pr.headSha, list);
    }
    for (const head of [...this.contexts.keys()]) {
      if (!byHead.has(head)) {
        this.contexts.delete(head); this.observed.delete(head); this.mirrorRuns.delete(head);
        this.stuckSince.delete(head); this.mirrorPendingSince.delete(head); this.wouldPosted.delete(head);
        // The head moved or the PR left main: a success this server posted would
        // otherwise stay mergeable on that commit. Withdraw it.
        if (this.selfPosted.get(head) === 'success') this.droppedPending.add(head);
      }
    }
    let submitted = 0;
    const toSubmit: Array<{ head: string; trigger: string; withdraw: boolean }> = [];
    for (const head of [...this.droppedPending]) {
      if (byHead.has(head)) { this.droppedPending.delete(head); continue; } // back on an open PR: the normal path decides
      if (this.retryNotDue(head, this.seams.now())) continue;
      toSubmit.push({ head, trigger: 'dropped', withdraw: true });
    }

    const now = this.seams.now();
    for (const [head, group] of byHead) {
      this.contexts.set(head, { prs: group });
      await this.refreshHeadInputs(head, group, enabled);
      const desiredNow = this.reproject(head);

      // A post that completed after the listing started is newer than its rollup.
      if ((this.lastPostSeq.get(head) ?? 0) > listSeq && this.observed.get(head)?.by === 'self') {
        const o = this.observed.get(head)!;
        this.canaries(head, group, desiredNow, o.state, now, enabled);
        if (desiredNow.state !== o.state && !this.retryNotDue(head, now)) toSubmit.push({ head, trigger: 'pass', withdraw: o.state === 'success' });
        continue;
      }

      // What GitHub reports for the context on this head.
      const rollup = group[0].rollup;
      const entry = rollup.find((r): r is Extract<RollupEntry, { kind: 'status' }> => r.kind === 'status' && r.context === LOCAL_VERIFY_STATUS_CONTEXT);
      const truncated = group.some((g) => g.rollupTruncated);
      const prev = this.observed.get(head);
      const desired = this.reproject(head);
      let obs: ObservedState | null = entry ? normalizeRollupState(entry.state) : (truncated ? null : 'absent');
      const needCreator = obs === null
        || (obs !== 'absent' && (prev === undefined ? obs !== desired.state : prev.by === 'self' && prev.state !== obs));
      if (needCreator) {
        const read = await this.seams.readCombinedStatus(head).catch(() => null);
        if (read === null) {
          if (obs === null) { this.seams.audit({ event: 'status-unreadable', head }); continue; } // truncated + unreadable: never "absent"
        } else {
          obs = read.state;
          if (read.state !== 'absent' && read.creator !== null && read.creator !== this.cfg.agentLogin) {
            this.seams.audit({ event: 'foreign-status', head, creator: read.creator, state: read.state, prs: group.map((g) => g.number) });
          }
        }
      }
      // A post may have completed while this head's reads were awaited.
      if ((this.lastPostSeq.get(head) ?? 0) <= listSeq) this.observed.set(head, { state: obs!, by: 'github' });
      const seen = this.observed.get(head)!.state;

      this.canaries(head, group, desired, seen, now, enabled);
      if (desired.state !== seen && !this.retryNotDue(head, now)) toSubmit.push({ head, trigger: 'pass', withdraw: seen === 'success' });
    }
    // Withdrawals (away from success) go first; the per-minute cap never delays them.
    for (const t of orderSubmissions(toSubmit)) { void this.submit(t.head, t.trigger); submitted++; }
    if (this.stuckSince.size === 0) this.raised.delete('local-verify:status-stuck');
    this.passFailures = 0;
    this.nextPassAt = 0;
    return { at, outcome: 'ok', heads: byHead.size, submitted, floorState: this.floorGate.state() };
  }

  /** A failed post's backoff has not elapsed: the pass is the one retry path. */
  private retryNotDue(head: string, now: number): boolean {
    return !postRetryDue(this.retries.get(head), now);
  }

  private backoffPass(): void {
    this.passFailures++;
    const delay = passBackoffDelay(this.passFailures);
    this.nextPassAt = this.seams.now() + delay;
    this.seams.audit({ event: 'pass-backoff', failures: this.passFailures, delayMs: delay });
  }

  /** Global posts-per-minute cap (withdrawals exempt); false ⇒ defer to the next pass. */
  private admitPost(withdrawal: boolean): boolean {
    const a = admitStatusPost({ withdrawal, postTimes: this.postTimes, now: this.seams.now() });
    this.postTimes.length = 0;
    this.postTimes.push(...a.postTimes);
    return a.admit;
  }

  private floorOf(pr: OpenPr, enabled: boolean): { eligible: boolean; floor: FloorMode } {
    const eligible = checkEligibility(
      { author: pr.author ? { login: pr.author } : null, isCrossRepository: pr.isCrossRepository, headRefName: pr.headRefName, headRefOid: pr.headSha, baseRefName: pr.baseRefName, baseRefOid: '' },
      { expectedGhLogin: this.cfg.agentLogin, operatorGhLogin: this.cfg.operatorGhLogin },
    ).eligible;
    const floor: FloorMode = enabled ? this.floorGate.floorFor({ repo: this.cfg.repo, eligible }) : 'actions';
    return { eligible, floor };
  }

  /** Per-pass fresh reads a projection needs (check runs for mirror heads). */
  private async refreshHeadInputs(head: string, group: OpenPr[], enabled: boolean): Promise<void> {
    const floors = group.map((pr) => ({ pr, ...this.floorOf(pr, enabled) }));
    if (floors.some((f) => f.floor === 'actions' || !f.eligible)) {
      const fp = rollupFingerprint(group[0].rollup);
      const cached = this.mirrorRuns.get(head);
      const rb = this.checkRunBackoff.get(head);
      const due = !rb || rb.nextAt <= this.seams.now();
      if ((!cached || cached.fp !== fp || cached.runs === null) && due) {
        const runs = await this.seams.readCheckRuns(head).catch(() => null);
        this.mirrorRuns.set(head, { fp, runs });
        if (runs === null) {
          const failures = (rb?.failures ?? 0) + 1;
          const delay = passBackoffDelay(failures);
          this.checkRunBackoff.set(head, { failures, nextAt: this.seams.now() + delay });
          this.seams.audit({ event: 'check-runs-unreadable', head, failures, delayMs: delay });
        } else {
          this.checkRunBackoff.delete(head);
        }
      }
    }
  }

  private inputsFor(head: string): ProjectionInput[] {
    const ctx = this.contexts.get(head);
    if (!ctx) return [];
    const enabled = this.cfg.localVerifyEnabled() && this.service !== null;
    const mh = this.service?.mainHealth();
    const { protectionContexts, rulesetContexts } = this.floorGate.contexts();
    return ctx.prs.map((pr) => {
      const { eligible, floor } = this.floorOf(pr, enabled);
      return {
        pr: { number: pr.number, headSha: head, baseRefName: pr.baseRefName, eligible, floor },
        repo: this.cfg.repo,
        record: this.service?.getRecord(pr.number, head, pr.baseRefName) ?? null,
        verifying: this.service?.isVerifying(pr.number, head) ?? false,
        mainHealth: { state: mh?.state ?? 'main-suspect', mainHeadSha: mh?.currentMainHead ?? null },
        mirror: {
          floor: this.cfg.actionsFloor, protectionContexts, rulesetContexts,
          checkRuns: this.mirrorRuns.get(head)?.runs ?? null, evaluate: this.cfg.evaluate,
        },
      };
    });
  }

  /** Re-project a head from the latest pass data and the service's current state. */
  reproject(head: string): Projection {
    return projectHead(this.inputsFor(head));
  }

  private raise(key: string, dedupe: string, detail: Record<string, unknown>): void {
    if (this.raised.has(dedupe)) return;
    this.raised.add(dedupe);
    this.seams.audit({ event: 'signal', key, ...detail });
    try { this.seams.signal?.(key, detail); } catch { /* @silent-fallback-ok: a sink failure never changes posting */ }
  }

  private canaries(head: string, group: OpenPr[], desired: Projection, obs: ObservedState, now: number, enabled: boolean): void {
    // Stuck-status canary: an eligible local-floor head with a green, admissible
    // record whose posted status differs from its projection for > 15 minutes.
    // In dry-run nothing is posted by design, so the canary is not armed.
    const inputs = this.inputsFor(head);
    const greenAdmissible = enabled && inputs.some((i) => i.pr.floor === 'local' && i.pr.eligible && projectLocal(i).state === 'success');
    if (this.cfg.postStatuses() && greenAdmissible && obs !== desired.state) {
      const since = this.stuckSince.get(head) ?? now;
      this.stuckSince.set(head, since);
      if (now - since > RECONCILER_LIMITS.stuckAfterMs) {
        this.raise('local-verify:status-stuck', 'local-verify:status-stuck', { head, prs: group.map((g) => g.number), posted: obs, projected: desired.state, sinceMs: now - since });
      }
    } else {
      this.stuckSince.delete(head);
    }
    // Mirror left pending for > 6 hours.
    const mirrorHead = inputs.some((i) => i.pr.floor === 'actions' || !i.pr.eligible);
    if (mirrorHead && desired.state === 'pending') {
      const since = this.mirrorPendingSince.get(head) ?? now;
      this.mirrorPendingSince.set(head, since);
      if (now - since > RECONCILER_LIMITS.mirrorPendingAfterMs) {
        this.raise('local-verify:mirror-pending', `local-verify:mirror-pending:${head}`, { head, prs: group.map((g) => g.number), reason: desired.reason });
      }
    } else {
      this.mirrorPendingSince.delete(head);
      this.raised.delete(`local-verify:mirror-pending:${head}`);
    }
  }

  // ---- the single serialized writer per head ----

  /* @self-action-controller: local-verify-status-post */
  submit(head: string, trigger: string): Promise<void> {
    const prev = this.chains.get(head) ?? Promise.resolve();
    const next = prev.then(() => this.send(head, trigger)).catch((e) => {
      this.seams.audit({ event: 'post-error', head, trigger, detail: e instanceof Error ? e.message : String(e) });
    });
    this.chains.set(head, next);
    void next.finally(() => { if (this.chains.get(head) === next) this.chains.delete(head); });
    return next;
  }

  private async send(head: string, trigger: string): Promise<void> {
    let d: Projection;
    let o: Observed | undefined;
    if (!this.contexts.has(head)) {
      // A dropped head holding a server-posted success: withdraw it.
      if (!this.droppedPending.has(head) || this.selfPosted.get(head) !== 'success') { this.droppedPending.delete(head); return; }
      d = { state: 'pending', reason: 'head-left-listing', description: 'withdrawn · head no longer on an open PR to main' };
      o = { state: 'success', by: 'self' };
    } else {
      d = this.reproject(head); // re-projected immediately before the send
      o = this.observed.get(head);
      if (o && o.state === d.state) { this.retries.delete(head); return; }
    }
    const epoch = this.safeEpoch();
    if (!this.safeHolds() || epoch === null || epoch !== this.acquiredEpoch) {
      this.seams.audit({ event: 'post-skipped-lease', head, trigger, machineId: this.cfg.machineId, epoch, acquiredEpoch: this.acquiredEpoch });
      return;
    }
    const prs = this.contexts.get(head)?.prs.map((p) => p.number) ?? [];
    if (!this.cfg.postStatuses()) {
      const key = `${d.state}|${d.description}`;
      if (this.wouldPosted.get(head) !== key) {
        this.wouldPosted.set(head, key);
        this.seams.audit({ event: 'would-post', head, state: d.state, description: d.description, reason: d.reason, prs, observed: o?.state ?? null, trigger, machineId: this.cfg.machineId, epoch });
      }
      return;
    }
    const withdrawal = o?.state === 'success' && d.state !== 'success';
    if (!this.admitPost(withdrawal)) {
      this.seams.audit({ event: 'post-deferred-rate', head, state: d.state, trigger, perMinute: RECONCILER_LIMITS.postsPerMinute });
      return; // the next pass re-submits (the projection still differs)
    }
    this.postTimes.push(this.seams.now());
    const res = await this.seams.postStatus(head, d.state, d.description).catch((e) => ({ ok: false as const, status: null, detail: e instanceof Error ? e.message : String(e) }));
    this.seams.audit({
      event: 'status-posted', head, state: d.state, reason: d.reason, prs, trigger, ok: res.ok,
      ...(res.ok ? {} : { httpStatus: res.status, detail: res.detail.slice(0, 200) }),
      machineId: this.cfg.machineId, epoch,
    });
    if (res.ok) {
      this.postSeq++;
      this.lastPostSeq.set(head, this.postSeq);
      this.selfPosted.set(head, d.state);
      if (this.contexts.has(head)) this.observed.set(head, { state: d.state, by: 'self' });
      else this.droppedPending.delete(head);
      this.retries.delete(head);
      return;
    }
    const r = this.retries.get(head) ?? { attempts: 0, nextAt: 0, lastError: '' };
    const next = nextPostRetry(r, this.seams.now());
    r.attempts = next.attempts;
    r.nextAt = next.nextAt;
    r.lastError = res.status !== null ? `HTTP ${res.status}` : res.detail.slice(0, 120);
    this.retries.set(head, r);
    // No timer: the 60-second pass is the one retry path, and it waits for nextAt.
  }
}
