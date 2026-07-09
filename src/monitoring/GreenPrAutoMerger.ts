/**
 * GreenPrAutoMerger — the background watcher that merges a green, mergeable,
 * non-held PR this agent authored, surviving session death (Phase 7 becomes
 * machinery, not memory). green-pr-automerge-enforcement R1–R11.
 *
 * Layer 1 (the guarantee). Ticks run ONLY on the multi-machine lease holder;
 * the first tick after acquiring the lease is OBSERVE-ONLY (warm-up: seed hold
 * memory, build the snapshot, read peer latches). At most one merge attempt per
 * tick, single-flight with a liveness guarantee that survives a server restart
 * (the MergeRunner owns the durable in-flight record + orphan reap). Everything
 * that decides "is this change good" already happened upstream; safe-merge
 * re-verifies at act time. Tier-0 supervision — the only discretionary call is
 * hold/candidate status and its failure direction is fail-toward-skip.
 *
 * All I/O is injected (deps) so every decision path is unit-testable without gh,
 * real processes, or a real lease.
 */

import { EventEmitter } from 'node:events';

import {
  type PrSummary,
  type Episode,
  type BreakerState,
  type HoldMemoryEntry,
  classifyCandidate,
  holdReasonOf,
  headInNamespace,
  stuckRedChecks,
  selectOldest,
  debounceHoldRelease,
  applyOutcome,
  maybeRearm,
  episodeEligible,
  freshBreaker,
  feedBreaker,
  breakerBlocking,
  validateTimeoutInvariant,
} from './greenPrLogic.js';
import type { GuardLatchStore } from './GuardLatchStore.js';

/** The arguments a merge attempt is launched with. */
export interface MergeAttempt {
  pr: number;
  headRefOid: string;
  repo: string;
}

/** The classified result of a merge attempt (from the MergeRunner). */
export interface MergeRunResult {
  /**
   * safe-merge's classified result slug, e.g. merged / armed / refused:* /
   * error:* / already-merged / closed. `armed` (mergerunner-auto-arm-handoff)
   * is terminal-success-PENDING: GitHub native auto-merge is armed and now
   * owns the merge — confirmed later by the reconciliation tick, NOT here.
   */
  outcome: string;
  /**
   * True only when an INDEPENDENT gh pr view confirmed MERGED (B10). ALWAYS
   * false for `armed` BY DESIGN — the merge has not landed at arm time, so an
   * independent confirm at arm time is meaningless. `confirmedMerged:false` is
   * CORRECT and EXPECTED for `armed`, NOT a B10 violation (the B10 rewrite line
   * in act() is gated on outcome === 'merged' and MUST NOT touch `armed`).
   */
  confirmedMerged: boolean;
  /**
   * For an `armed` outcome: the head sha GitHub auto-merge was armed against
   * (the `--match-head-commit` we passed). Carried so the episode stamps
   * `armedHead` and reconciliation can compare it to the PR's final head.
   */
  armedHead?: string;
  /** Set when the watcher hard-killed the child at the deadline. */
  deadlineKilled?: boolean;
}

/**
 * The act-path engine (Step 4): probes the safe-merge contract, records a
 * durable in-flight attempt, spawns safe-merge in its own process group, hard-
 * kills at the deadline, and independently confirms the merge. Injected so the
 * orchestrator is testable; the real one lives in MergeRunner.ts.
 */
export interface MergeRunner {
  /** Probe `safe-merge --capabilities`; false → refuse to drive a legacy script. */
  probeContract(): Promise<{ ok: boolean; version?: number }>;
  /** Run one merge attempt to completion (or deadline-kill). */
  run(attempt: MergeAttempt): Promise<MergeRunResult>;
  /** Reap any surviving orphan from a prior crash; re-verify PR state. Boot/warm-up only. */
  reapOrphan(): Promise<{ reaped: boolean; outcome?: string }>;
}

export interface ProtectedPathsVerdict {
  touches: boolean;
  unverifiable: boolean;
}

export interface GreenPrAutoMergerDeps {
  holdsLease(): boolean;
  leaseEpoch(): number;
  /** The single oldest-first GraphQL list call. Throws → tick-failed canary. */
  listOpenPrs(): Promise<PrSummary[]>;
  /** Did this PR's diff touch protected paths? Enumerated to exhaustion. */
  protectedPaths(pr: PrSummary): Promise<ProtectedPathsVerdict>;
  /**
   * Re-fetch hold-relevant + state fields immediately before acting AND for the
   * armed-episode reconciliation read. null → vanished. Widened
   * (mergerunner-auto-arm-handoff Blocker 4): also returns `mergeCommitOid` (the
   * squashed base commit on a MERGED read — informational for the audit line,
   * NOT the head-pin comparison operand) and `autoMergeRequest` (present ⇔
   * GitHub auto-merge armed; `expectedHeadOid` is the PR's FINAL head GitHub
   * will merge — the head-pin comparison operand when present).
   */
  refetchPr(pr: number): Promise<
    | (Pick<PrSummary, 'title' | 'labels' | 'isDraft' | 'headRefOid'> & {
        state: string;
        mergeCommitOid?: string | null;
        autoMergeRequest?: { enabledAt?: string | null; expectedHeadOid?: string | null } | null;
      })
    | null
  >;
  /**
   * Disarm GitHub native auto-merge on a PR (`gh pr merge <pr> --disable-auto`).
   * Returns a per-PR CONFIRMED-disabled boolean. The operator-authorized reach
   * of the documented kill switch (rollback / pause / pool-disarm / per-PR HOLD
   * on an armed episode — mergerunner-auto-arm-handoff Blocker 3). Idempotent.
   */
  disarmArmedEpisodes(pr: number): Promise<boolean>;
  /** gh api user login (async, never blocks boot). null → unresolved. */
  resolveGhLogin(): Promise<string | null>;
  /**
   * Apply a `[HOLD: …]` title prefix to a PR via gh (the conversational-hold
   * assist, R3). Returns whether it landed; the caller validated namespace + open.
   */
  applyHoldMarker(pr: number, reason: string): Promise<boolean>;
  /** Re-fetch a PR's head namespace + open state for the /hold route's guard. */
  holdEligible(pr: number): Promise<{ ok: boolean; status?: number; detail?: string }>;
  runner: MergeRunner;
  latches: Pick<GuardLatchStore, 'isMergeAllowed'>;
  /** Raise/refresh the ONE aggregated attention item (machine-stable id). */
  postAttentionAggregate(lines: string[]): Promise<void>;
  /** Append one transition audit line. */
  audit(event: Record<string, unknown>): void;
  loadState(): GreenPrState;
  saveState(state: GreenPrState): void;
  now(): number;
}

export interface GreenPrSnapshotEntry {
  pr: number;
  headRefName: string;
  headRefOid: string;
  /** 'mergeable' | 'protected-paths' — Layer 2 routes protected to the operator. */
  kind: 'mergeable' | 'protected-paths';
}

export interface GreenPrState {
  lastTickAt?: number;
  lastSuccessfulListAt?: number;
  /** Lease epoch observed at the last acting tick — warm-up detection. */
  lastActingEpoch?: number;
  consecutiveWarmupOnlyTenures: number;
  breaker: BreakerState;
  /** Per-PR ladder episodes, keyed by PR number. */
  episodes: Record<number, Episode>;
  /** Hold-release debounce memory, keyed by PR number. */
  holdMemory: Record<number, HoldMemoryEntry>;
  /** Last-tick snapshot for Layer 2 (the stop-gate belt). */
  snapshot: { at: number; entries: GreenPrSnapshotEntry[] };
  /** Cached gh identity resolution. */
  identity?: { login: string | null; resolvedAt: number };
  /** Episodes that gave up (surfaced via attention), for the aggregate. */
  attentionLines?: string[];
  /**
   * red-pr-watchdog per-PR "already-raised" memory. Keyed by PR number. Present
   * ⇔ we have surfaced this stuck-red PR; re-raised only when the elapsed-hours
   * bucket grows OR the failing-check set changes (dedup discipline — ONE item
   * per stuck PR). Cleared when the PR recovers (goes green) or leaves the open
   * list (merged/closed).
   */
  redPrRaised?: Record<number, { at: number; firstFailAt: number; hours: number; checks: string[] }>;
}

export interface GreenPrAutoMergerConfig {
  enabled?: boolean;
  dryRun?: boolean;
  tickIntervalMs?: number;
  maxAttempts?: number;
  maxRearmEpisodes?: number;
  breakerThreshold?: number;
  deadlineKillBreakerThreshold?: number;
  busySkipBreakerThreshold?: number;
  breakerCooldownMin?: number;
  mergeTimeoutMs?: number;
  mergeKillGraceMs?: number;
  expectedGhLogin?: string;
  identityRecheckTicks?: number;
  holdReleaseTicks?: number;
  staleHoldDays?: number;
  /** The agent's branch namespace, e.g. "echo". */
  agentNamespace: string;
  repo: string;
  backoffBaseMs?: number;
  /**
   * mergerunner-auto-arm-handoff. `auto` (default) arms GitHub native
   * auto-merge and confirms on a later reconciliation tick; `admin` is the
   * legacy synchronous poll+merge. The rollback lever + the escape hatch for a
   * repo without native auto-merge.
   */
  mergeStrategy?: 'auto' | 'admin';
  /** ms an armed episode may stay OPEN before transitioning to armed-overdue (24h). */
  armedConfirmCeilingMs?: number;
  /** deduped re-raise cadence for an armed-overdue episode (24h). */
  armedOverdueReraiseMs?: number;
  /** the `--auto` spawn deadline (60s) — threaded into MergeRunnerConfig. */
  armTimeoutMs?: number;
  /** K-consecutive-unconfirmed-arms-on-same-head threshold before the Blocker-D line. */
  unconfirmedArmCeiling?: number;
  /**
   * red-pr-watchdog. Signal-only backstop: when a self-authored open PR has a
   * required check stuck RED past `redThresholdMs`, raise ONE deduped,
   * age-escalating attention line. Default on (a red PR sitting silent is the
   * incident this closes — the 2026-07-08 operator-found escape). Runs on the
   * same repo/lease gate as the merge path; NEVER blocks/merges/closes.
   */
  redPrWatchdog?: { enabled?: boolean; redThresholdMs?: number };
}

type ResolvedConfig = Required<Omit<GreenPrAutoMergerConfig, 'expectedGhLogin'>> & { expectedGhLogin: string };

const DEFAULTS = {
  enabled: false,
  dryRun: false,
  tickIntervalMs: 600_000,
  maxAttempts: 3,
  maxRearmEpisodes: 3,
  breakerThreshold: 3,
  deadlineKillBreakerThreshold: 3,
  busySkipBreakerThreshold: 3,
  breakerCooldownMin: 60,
  mergeTimeoutMs: 1_500_000,
  mergeKillGraceMs: 60_000,
  expectedGhLogin: '',
  identityRecheckTicks: 6,
  holdReleaseTicks: 2,
  staleHoldDays: 7,
  backoffBaseMs: 30_000,
  mergeStrategy: 'auto' as 'auto' | 'admin',
  armedConfirmCeilingMs: 86_400_000,
  armedOverdueReraiseMs: 86_400_000,
  armTimeoutMs: 60_000,
  unconfirmedArmCeiling: 3,
  redPrWatchdog: { enabled: true, redThresholdMs: 7_200_000 },
};

export function freshState(): GreenPrState {
  return {
    consecutiveWarmupOnlyTenures: 0,
    breaker: freshBreaker(),
    episodes: {},
    holdMemory: {},
    snapshot: { at: 0, entries: [] },
    redPrRaised: {},
  };
}

export class GreenPrAutoMerger extends EventEmitter {
  private readonly cfg: ResolvedConfig;
  private tickHandle: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private tickCount = 0;
  /** Resolved at boot: does the timeout invariant hold? */
  readonly invariantOk: boolean;
  readonly invariantReason?: string;

  constructor(
    private readonly deps: GreenPrAutoMergerDeps,
    cfg: GreenPrAutoMergerConfig,
  ) {
    super();
    this.cfg = {
      ...DEFAULTS,
      ...cfg,
      agentNamespace: cfg.agentNamespace,
      repo: cfg.repo,
      expectedGhLogin: cfg.expectedGhLogin ?? '',
      // Deep-merge the nested watchdog block so a partial override (e.g. just
      // `enabled:false`) keeps the other default instead of dropping it.
      redPrWatchdog: {
        enabled: cfg.redPrWatchdog?.enabled ?? DEFAULTS.redPrWatchdog.enabled,
        redThresholdMs: cfg.redPrWatchdog?.redThresholdMs ?? DEFAULTS.redPrWatchdog.redThresholdMs,
      },
    } as ResolvedConfig;
    // B24 invariant scope (mergerunner-auto-arm-handoff §armTimeoutMs): on the
    // auto path the busy-skip budget is checked against the SHORT armTimeoutMs
    // (a hung arm trips in minutes, not ~26 min); the admin path keeps the
    // 25-min mergeTimeoutMs invariant verbatim.
    const invTimeoutMs = this.cfg.mergeStrategy === 'admin' ? this.cfg.mergeTimeoutMs : this.cfg.armTimeoutMs;
    const inv = validateTimeoutInvariant(
      this.cfg.busySkipBreakerThreshold,
      this.cfg.tickIntervalMs,
      invTimeoutMs,
      this.cfg.mergeKillGraceMs,
    );
    this.invariantOk = inv.ok;
    this.invariantReason = inv.reason;
  }

  start(): void {
    if (!this.cfg.enabled || this.tickHandle) return;
    if (!this.invariantOk) {
      // Boot refusal must be LOUD (B24) — never start with an inverted invariant.
      this.deps.audit({ kind: 'green-pr-automerge', event: 'boot-refused-invariant', reason: this.invariantReason });
      return;
    }
    // Warm-up + orphan reap happens on the first acting tick.
    this.tickHandle = setInterval(() => { void this.tick(); }, this.cfg.tickIntervalMs);
    if (typeof this.tickHandle.unref === 'function') this.tickHandle.unref();
  }

  stop(): void {
    if (this.tickHandle) { clearInterval(this.tickHandle); this.tickHandle = null; }
  }

  snapshot(): GreenPrState { return this.deps.loadState(); }

  /**
   * The /hold route's handler (R3): validate the PR is open + in this agent's
   * namespace, then apply the marker via gh. Lease-INDEPENDENT — a hold
   * originates wherever the session lives. Honest non-2xx on failure (a hold
   * that silently failed to apply would be merged ~10 minutes later).
   */
  async applyHold(pr: number, reason: string): Promise<{ ok: boolean; status?: number; detail?: string; pr: number }> {
    const elig = await this.deps.holdEligible(pr);
    if (!elig.ok) return { ok: false, status: elig.status ?? 404, detail: elig.detail ?? 'PR not eligible for hold', pr };
    try {
      const applied = await this.deps.applyHoldMarker(pr, reason);
      if (!applied) return { ok: false, status: 502, detail: 'gh failed to apply the hold marker', pr };
      this.deps.audit({ kind: 'green-pr-automerge', event: 'hold-applied', pr });

      // The HOLD-label/title path does NOT stop GitHub native auto-merge (GitHub
      // gates on checks/mergeability, not title/labels — mergerunner-auto-arm-
      // handoff Blocker 3). If this PR is armed, ALSO --disable-auto it; the
      // marker only blocks a LATER re-arm. Honest non-2xx on a disable failure.
      const state = this.deps.loadState();
      const ep = state.episodes[pr];
      if (ep && ep.armedAt != null) {
        let disabled = false;
        try { disabled = await this.deps.disarmArmedEpisodes(pr); }
        catch { /* @silent-fallback-ok: green-pr-automerge fail-safe — a disable error is honest; never claim the hold stopped the merge */ disabled = false; }
        if (disabled) {
          delete ep.armedAt; delete ep.armedHead; delete ep.overdue; delete ep.overdueSurfacedAt;
          this.deps.audit({ kind: 'green-pr-automerge', event: 'disarmed', pr, reason: 'hold' });
          this.deps.saveState(state);
        } else {
          this.deps.audit({ kind: 'green-pr-automerge', event: 'disarm-failed', pr, reason: 'hold' });
          this.deps.saveState(state);
          return { ok: false, status: 502, detail: 'hold marker applied but could not disable the in-flight auto-merge — PR may still merge; disable it on GitHub directly', pr };
        }
      }
      return { ok: true, pr };
    } catch (e) { /* @silent-fallback-ok: green-pr-automerge fail-safe — skip/refuse, never over-merge; safe-merge is the act-time authority */
      return { ok: false, status: 502, detail: String((e as Error)?.message).slice(0, 200), pr };
    }
  }

  /** The cron / manual-trigger entry point. Lease-gated; single-flight; warm-up. */
  async tick(opts: { manual?: boolean } = {}): Promise<{ acted: boolean; reason: string }> {
    this.tickCount += 1;
    const state = this.deps.loadState();
    state.lastTickAt = this.deps.now();

    // Lease gate (R10): ticks run only on the holder.
    if (!safeBool(() => this.deps.holdsLease())) {
      this.deps.saveState(state);
      return { acted: false, reason: 'not-lease-holder' };
    }

    // Single-flight (R5): never overlap an in-flight attempt.
    if (this.inFlight) {
      state.breaker = feedBreaker(state.breaker, 'busy-skip', this.deps.now(), this.breakerCfg());
      this.deps.audit({ kind: 'green-pr-automerge', event: 'tick-skipped-busy' });
      this.deps.saveState(state);
      return { acted: false, reason: 'busy' };
    }

    // Dual-latch gate (R9): rollback / emergency-pause / unreadable → no merge.
    const gate = this.deps.latches.isMergeAllowed();
    if (!gate.allowed) {
      this.deps.audit({ kind: 'green-pr-automerge', event: 'tick-skipped-disabled', reason: gate.reason });
      this.deps.saveState(state);
      return { acted: false, reason: `disabled:${gate.reason}` };
    }

    // Breaker open within cooldown → skip.
    if (breakerBlocking(state.breaker, this.deps.now(), this.cfg.breakerCooldownMin * 60_000)) {
      this.deps.audit({ kind: 'green-pr-automerge', event: 'tick-skipped-breaker-open' });
      this.deps.saveState(state);
      return { acted: false, reason: 'breaker-open' };
    }

    // Armed-episode reconciliation (mergerunner-auto-arm-handoff): the top-of-
    // acting-tick step. READ-ONLY accounting — confirms an eventual GitHub merge
    // one tick later (the B10 truth, just moved off the synchronous arm). Below
    // the disabled: early-return (so it never runs under a live disarm latch —
    // which is exactly why the disarm reach lives in the route, not here), above
    // gather(). Fail-open on any read error; never feeds the breaker.
    await this.reconcileArmed(state);

    // Warm-up (R10): the first tick of a new lease tenure is OBSERVE-ONLY.
    const epoch = safeNum(() => this.deps.leaseEpoch());
    const isWarmup = state.lastActingEpoch !== epoch;

    let candidates: PrSummary[];
    try {
      candidates = await this.deps.listOpenPrs();
      state.lastSuccessfulListAt = this.deps.now();
      state.breaker = feedBreaker(state.breaker, 'reset', this.deps.now(), this.breakerCfg());
    } catch (e) { /* @silent-fallback-ok: green-pr-automerge fail-safe — skip/refuse, never over-merge; safe-merge is the act-time authority */
      // Tick-failed canary (L5(b)): a failed/unparseable list call feeds the breaker.
      state.breaker = feedBreaker(state.breaker, 'tick-failed', this.deps.now(), this.breakerCfg());
      this.deps.audit({ kind: 'green-pr-automerge', event: 'tick-failed', class: 'list', detail: String((e as Error)?.message).slice(0, 200) });
      this.deps.saveState(state);
      return { acted: false, reason: 'list-failed' };
    }

    // Build the candidate set (cheap fields) + the Layer-2 snapshot.
    const { eligible, snapshotEntries } = await this.gather(candidates, state);
    state.snapshot = { at: this.deps.now(), entries: snapshotEntries };

    // Red-PR watchdog (red-pr-watchdog): surface my own PRs stuck RED past the
    // threshold. Runs on every acting/warm-up tick that got a fresh PR list —
    // same repo/lease gate as the merge path. SIGNAL-ONLY: it only raises
    // attention (mutations here are persisted by the saveState below, whichever
    // branch returns). Placed AFTER the merge-candidate gather so a stuck-red PR
    // is surfaced even on a lease-flap warm-up tenure.
    this.redPrWatchdogPass(candidates, state);

    if (isWarmup) {
      // Seed hold memory + snapshot + reap any orphan; begin merges next tick.
      await this.warmupReap(state);
      state.lastActingEpoch = epoch;
      state.consecutiveWarmupOnlyTenures += 1;
      if (state.consecutiveWarmupOnlyTenures >= 3) {
        await this.refreshAggregate(state, [`waiting:lease-flap — ${state.consecutiveWarmupOnlyTenures} consecutive warm-up-only tenures (running, seeing PRs, never permitted to act)`]);
      }
      this.deps.audit({ kind: 'green-pr-automerge', event: 'tick-warm-up', candidates: eligible.length });
      this.deps.saveState(state);
      return { acted: false, reason: 'warm-up' };
    }

    state.lastActingEpoch = epoch;
    state.consecutiveWarmupOnlyTenures = 0;

    const target = selectOldest(eligible);
    if (!target) {
      this.deps.saveState(state);
      return { acted: false, reason: 'no-candidate' };
    }

    // Act (Step 4 engine). dryRun observes only.
    if (this.cfg.dryRun) {
      this.deps.audit({ kind: 'green-pr-automerge', event: 'would-merge', pr: target.number, head: target.headRefOid });
      this.deps.saveState(state);
      return { acted: false, reason: 'dry-run' };
    }

    const acted = await this.act(target, state);
    this.deps.saveState(state);
    return { acted, reason: acted ? 'acted' : 'skipped' };
  }

  // ---- candidate gathering -----------------------------------------------

  private async gather(prs: PrSummary[], state: GreenPrState): Promise<{ eligible: PrSummary[]; snapshotEntries: GreenPrSnapshotEntry[] }> {
    const eligible: PrSummary[] = [];
    const snapshotEntries: GreenPrSnapshotEntry[] = [];
    const nowMs = this.deps.now();

    for (const pr of prs) {
      // Skip an already-armed PR (mergerunner-auto-arm-handoff Blocker 2 — re-arm
      // thrash). An armed PR is GitHub's and never re-enters the act path; it
      // re-enters ONLY after reconciliation clears armedAt. The GitHub-side
      // autoMergeArmed flag (cheap-pass, from the widened PrSummary) is the belt
      // that catches a lease move where the local episode is stale/absent
      // (Blocker 4). It is still surfaced in the Layer-2 snapshot so status sees it.
      const localArmed = state.episodes[pr.number]?.armedAt != null;
      const githubArmed = pr.autoMergeArmed === true;
      if (localArmed || githubArmed) {
        this.deps.audit({ kind: 'green-pr-automerge', event: 'skipped:already-armed', pr: pr.number, source: localArmed ? 'local-episode' : 'github' });
        snapshotEntries.push({ pr: pr.number, headRefName: pr.headRefName, headRefOid: pr.headRefOid, kind: 'mergeable' });
        continue;
      }
      const verdict = classifyCandidate(pr, this.cfg.agentNamespace);
      // Hold-release debounce (R3): a PR that WAS held resumes only after the
      // marker is absent for holdReleaseTicks AND tickIntervalMs elapsed.
      const heldNow = holdReasonOf(pr) !== null;
      const deb = debounceHoldRelease(state.holdMemory[pr.number], heldNow, nowMs, this.cfg.holdReleaseTicks, this.cfg.tickIntervalMs);
      if (deb.mem) state.holdMemory[pr.number] = deb.mem; else delete state.holdMemory[pr.number];

      if (!verdict.eligible) {
        if (verdict.skip === 'held' && deb.transition === 'released') {
          this.deps.audit({ kind: 'green-pr-automerge', event: 'hold-released', pr: pr.number });
        }
        continue;
      }
      // verdict.eligible but the hold debounce may still hold it back this tick.
      if (heldNow || !deb.resumeEligible) continue;

      // Protected-paths gate (enumerated to exhaustion).
      let pp: ProtectedPathsVerdict;
      try {
        pp = await this.deps.protectedPaths(pr);
      } catch { /* @silent-fallback-ok: green-pr-automerge fail-safe — skip/refuse, never over-merge; safe-merge is the act-time authority */
        pp = { touches: false, unverifiable: true };
      }
      if (pp.unverifiable) {
        this.deps.audit({ kind: 'green-pr-automerge', event: 'waiting', class: 'protected-paths-unverifiable', pr: pr.number });
        continue;
      }
      if (pp.touches) {
        // Excluded from auto-merge; surfaced to the operator + included in the
        // Layer-2 snapshot as the operator-routed variant (round-5/6).
        snapshotEntries.push({ pr: pr.number, headRefName: pr.headRefName, headRefOid: pr.headRefOid, kind: 'protected-paths' });
        await this.refreshAggregate(state, [`PR #${pr.number} is green but touches protected paths — it needs your manual review and merge`]);
        continue;
      }
      eligible.push(pr);
      snapshotEntries.push({ pr: pr.number, headRefName: pr.headRefName, headRefOid: pr.headRefOid, kind: 'mergeable' });
    }
    return { eligible, snapshotEntries };
  }

  // ---- act ----------------------------------------------------------------

  private async act(target: PrSummary, state: GreenPrState): Promise<boolean> {
    // Identity contract (R4): verify gh login matches expectedGhLogin (TTL cached).
    const idOk = await this.identityOk(state);
    if (idOk !== 'ok') {
      this.deps.audit({ kind: 'green-pr-automerge', event: `skipped:${idOk}` });
      return false;
    }

    // Episode ladder eligibility.
    let ep = state.episodes[target.number];
    if (ep && ep.headRefOid !== target.headRefOid) {
      const re = maybeRearm(ep, target.headRefOid, this.ladderCfg());
      if (re === null) {
        this.deps.audit({ kind: 'green-pr-automerge', event: 'gave-up-rearm-exhausted', pr: target.number });
        return false;
      }
      ep = re;
      state.episodes[target.number] = ep;
    }
    if (!episodeEligible(ep, this.deps.now())) return false;

    // Contract probe BEFORE every attempt (round-3: mid-run checkout swap).
    const probe = await this.deps.runner.probeContract();
    if (!probe.ok) {
      this.deps.audit({ kind: 'green-pr-automerge', event: 'skipped:safe-merge-contract' });
      return false;
    }

    // Re-fetch hold/state immediately before acting (R3 residual window bound).
    const live = await this.deps.refetchPr(target.number);
    if (!live) { this.deps.audit({ kind: 'green-pr-automerge', event: 'skipped:vanished', pr: target.number }); return false; }
    if (live.state !== 'OPEN') { this.recordOutcome(state, target, live.state === 'MERGED' ? 'merged-by-other' : 'closed-by-other'); return false; }
    if (live.isDraft || holdReasonOf({ isDraft: live.isDraft, title: live.title, labels: live.labels })) {
      this.deps.audit({ kind: 'green-pr-automerge', event: 'skipped:held-on-refetch', pr: target.number });
      return false;
    }
    // Authoritative pre-arm gate (mergerunner-auto-arm-handoff Blocker 4 — defense
    // in depth): if the cheap-pass autoMergeArmed was stale-false but the live
    // refetchPr shows auto-merge already armed, REFUSE to re-arm right before
    // spawning. Synthesize the local episode so reconciliation tracks the merge.
    if (live.autoMergeRequest) {
      this.deps.audit({ kind: 'green-pr-automerge', event: 'skipped:already-armed-on-refetch', pr: target.number });
      const ep = state.episodes[target.number] ?? { pr: target.number, headRefOid: target.headRefOid, attempts: 0, rearmEpisodes: 0, state: 'active' as const };
      ep.armedAt = ep.armedAt ?? this.deps.now();
      ep.armedHead = ep.armedHead ?? (live.autoMergeRequest.expectedHeadOid ?? live.headRefOid);
      ep.lastOutcome = 'armed';
      state.episodes[target.number] = ep;
      return false;
    }
    if (live.headRefOid !== target.headRefOid) {
      this.deps.audit({ kind: 'green-pr-automerge', event: 'skipped:head-moved', pr: target.number });
      return false;
    }

    // Single-flight + spawn (the MergeRunner owns the durable in-flight record).
    this.inFlight = true;
    let result: MergeRunResult;
    try {
      this.deps.audit({ kind: 'green-pr-automerge', event: 'merge-attempted', pr: target.number, head: target.headRefOid });
      result = await this.deps.runner.run({ pr: target.number, headRefOid: target.headRefOid, repo: this.cfg.repo });
    } catch (e) { /* @silent-fallback-ok: green-pr-automerge fail-safe — skip/refuse, never over-merge; safe-merge is the act-time authority */
      result = { outcome: `error:runner-${String((e as Error)?.message).slice(0, 40)}`, confirmedMerged: false };
    } finally {
      this.inFlight = false;
    }

    if (result.deadlineKilled) {
      state.breaker = feedBreaker(state.breaker, 'deadline-kill', this.deps.now(), this.breakerCfg());
    }

    // B10: classify "merged" ONLY on independent confirmation. This rewrite is
    // gated on outcome === 'merged' and MUST NOT touch 'armed' — an `armed`
    // result carries confirmedMerged:false BY DESIGN (the merge has not landed
    // at arm time; the independent confirm happens ONE TICK LATER in
    // reconcileArmed). Generalizing this to a merged-MIRROR form
    // ((merged || armed) && !confirmedMerged → error) would rewrite every
    // legitimate armed into an error and give up on a PR GitHub genuinely armed
    // — the exact inverse of intent. Do NOT do that (mergerunner-auto-arm-
    // handoff Blocker B).
    const outcome = result.outcome === 'merged' && !result.confirmedMerged ? 'error:merge-unconfirmed' : result.outcome;
    this.recordOutcome(state, target, outcome, result.armedHead);
    // `act()` returns "did the watcher perform a real, intended terminal action"
    // — NOT "did the PR merge." Both `merged` (immediate) and `armed`
    // (terminal-success-pending; GitHub now owns the merge, the slot is freed,
    // the episode is stamped armedAt) are real terminal actions → acted:true.
    return outcome === 'merged' || outcome === 'armed';
  }

  private recordOutcome(state: GreenPrState, target: PrSummary, outcome: string, armedHead?: string): void {
    // auto-merge-unavailable (repo setting OFF) — terminal-non-ladder. A
    // PERMANENT condition; do NOT burn maxAttempts over three pointless ticks
    // and do NOT silently flip to --admin (signal, not authority). Record the
    // refusal + raise ONE attention line; the operator chooses.
    if (outcome === 'refused:auto-arm-unavailable') {
      const ep: Episode = state.episodes[target.number] ?? { pr: target.number, headRefOid: target.headRefOid, attempts: 0, rearmEpisodes: 0, state: 'active' };
      ep.lastOutcome = outcome;
      ep.lastAttemptAt = this.deps.now();
      state.episodes[target.number] = ep;
      this.deps.audit({ kind: 'green-pr-automerge', event: 'auto-merge-unavailable', pr: target.number });
      void this.refreshAggregate(state, [`PR #${target.number} is green but I could not arm auto-merge — "Allow auto-merge" is disabled on the repo. Enable it, or set mergeStrategy:'admin'.`]);
      return;
    }

    const ep: Episode = state.episodes[target.number] ?? { pr: target.number, headRefOid: target.headRefOid, attempts: 0, rearmEpisodes: 0, state: 'active' };
    const folded = applyOutcome(ep, outcome, this.deps.now(), this.ladderCfg(), { armedHead: armedHead ?? target.headRefOid });
    state.episodes[target.number] = folded.ep;
    if (folded.feedsBreaker) {
      // Per-PR ladder failures do NOT feed the global breaker directly (that is
      // for tick/deadline/busy classes); they advance the per-PR ladder only.
    }
    this.deps.audit({ kind: 'green-pr-automerge', event: outcome, pr: target.number });
    if (outcome === 'merged') {
      // Reap the episode on success.
      delete state.episodes[target.number];
    } else if (outcome === 'armed') {
      // GitHub now owns the merge — the episode stays armed; reconciliation
      // confirms the eventual merge. No attention, no reap.
    } else if (outcome === 'error:auto-arm-unconfirmed' || outcome === 'error:auto-confirm-unreadable') {
      // Non-ladder retry (Blocker D). The head-keyed unconfirmedArmAttempts
      // counter advanced in applyOutcome; surface ONE deduped attention line at
      // the ceiling (signal, not authority — never blocks the next attempt).
      const ctr = folded.ep.unconfirmedArmAttempts;
      if (ctr && ctr.count >= this.cfg.unconfirmedArmCeiling) {
        void this.refreshAggregate(state, [`Armed PR #${target.number} but cannot confirm it stuck (${ctr.count} attempts) — check GitHub auto-merge state for #${target.number}`]);
      }
    } else if (folded.ep.state === 'gave-up' && outcome !== 'merged-by-other' && outcome !== 'closed-by-other') {
      void this.refreshAggregate(state, [`PR #${target.number} could not be auto-merged after ${folded.ep.attempts} attempts (${outcome}) — needs a look`]);
    } else if (outcome === 'closed-by-other') {
      void this.refreshAggregate(state, [`PR #${target.number} was closed without merging — discarded work`]);
    }
  }

  // ---- armed-episode reconciliation (mergerunner-auto-arm-handoff) ---------

  /**
   * The top-of-acting-tick reconciliation: confirm the eventual GitHub merge of
   * each armed episode one tick after arming (the B10 truth, moved off the
   * synchronous arm). READ-ONLY — never calls `gh pr merge`; the disarm reach is
   * the SEPARATE in-route call (Blocker 3a). Resolves each `armedAt` episode:
   *   MERGED → reap (head-pin verified) · CLOSED → reap (closed-by-other)
   *   OPEN+armed → steady state (leave) · OPEN+disarmed/head-moved → clear + re-evaluate
   *   >ceiling → armed-overdue (keep reconciling + deduped re-raise) · read-fail → fail-open
   */
  private async reconcileArmed(state: GreenPrState): Promise<void> {
    const armed = Object.values(state.episodes).filter((e) => e.armedAt != null);
    for (const ep of armed) {
      let live: Awaited<ReturnType<GreenPrAutoMergerDeps['refetchPr']>>;
      try {
        live = await this.deps.refetchPr(ep.pr);
      } catch { /* @silent-fallback-ok: green-pr-automerge fail-safe — fail-open on a reconciliation read error; never give up on a real in-flight merge */
        live = undefined as never;
      }
      // UNKNOWN / read-failure → fail-open: leave armed, NO ladder, NO breaker,
      // retry next tick. We never give up on a real in-flight merge.
      if (!live || live.state === 'UNKNOWN') {
        this.deps.audit({ kind: 'green-pr-automerge', event: 'armed-reconcile-read-failed', pr: ep.pr });
        this.maybeMarkOverdue(state, ep);
        continue;
      }

      if (live.state === 'MERGED') {
        // The PR's FINAL HEAD (autoMergeRequest.expectedHeadOid else headRefOid)
        // is the comparison operand — NEVER mergeCommitOid (the squash base
        // commit never equals the head; comparing it would false-fire on EVERY
        // clean squash merge).
        const finalHead = live.autoMergeRequest?.expectedHeadOid ?? live.headRefOid;
        if (finalHead && ep.armedHead && finalHead === ep.armedHead) {
          this.deps.audit({ kind: 'green-pr-automerge', event: 'merged', pr: ep.pr, head: finalHead, viaArmed: true });
        } else {
          // Merged at a head we did NOT arm — post-hoc detection of the residual
          // race. Audit + ONE attention line, but STILL reap (the merge happened).
          this.deps.audit({ kind: 'green-pr-automerge', event: 'merged-at-unexpected-head', pr: ep.pr, armedHead: ep.armedHead ?? null, finalHead: finalHead ?? null, mergeCommitOid: live.mergeCommitOid ?? null });
          void this.refreshAggregate(state, [`PR #${ep.pr} auto-merged at a head I did not arm — review the merged commit`]);
        }
        delete state.episodes[ep.pr];
        continue;
      }

      if (live.state === 'CLOSED') {
        this.deps.audit({ kind: 'green-pr-automerge', event: 'closed-by-other', pr: ep.pr, viaArmed: true });
        delete state.episodes[ep.pr];
        void this.refreshAggregate(state, [`PR #${ep.pr} was closed without merging — discarded work`]);
        continue;
      }

      // Still OPEN.
      const stillArmed = !!live.autoMergeRequest;
      const headMoved = ep.armedHead != null && live.headRefOid !== ep.armedHead;
      if (!stillArmed || headMoved) {
        // A force-push disarmed it, a maintainer turned it off, or the head moved
        // past armedHead → clear armedAt/armedHead and let the candidate path
        // re-evaluate and (if still eligible) re-arm. A new head is a genuine new
        // attempt, bounded by the existing maybeRearm ladder.
        this.deps.audit({ kind: 'green-pr-automerge', event: 'armed-cleared', pr: ep.pr, reason: !stillArmed ? 'disarmed' : 'head-moved' });
        const fresh = state.episodes[ep.pr];
        if (fresh) {
          delete fresh.armedAt;
          delete fresh.armedHead;
          delete fresh.overdue;
          delete fresh.overdueSurfacedAt;
        }
        continue;
      }

      // Steady state while CI runs — no ladder advance, no breaker feed. Leave
      // the armed episode; surface armed-overdue past the ceiling (Close the Loop).
      this.maybeMarkOverdue(state, ep);
    }
  }

  /**
   * Transition an armed episode to `armed-overdue` past armedConfirmCeilingMs and
   * re-raise a byte-stable deduped attention line on the armedOverdueReraiseMs
   * cadence (Blocker 5). Never clears armedAt — the loop stays open.
   */
  private maybeMarkOverdue(state: GreenPrState, ep: Episode): void {
    if (ep.armedAt == null) return;
    const now = this.deps.now();
    const overdue = now - ep.armedAt >= this.cfg.armedConfirmCeilingMs;
    if (!overdue) return;
    const live = state.episodes[ep.pr];
    if (!live) return;
    const dueToReraise = live.overdueSurfacedAt == null || (now - live.overdueSurfacedAt) >= this.cfg.armedOverdueReraiseMs;
    if (!dueToReraise) return;
    live.overdue = true;
    live.overdueSurfacedAt = now;
    this.deps.audit({ kind: 'green-pr-automerge', event: 'armed-overdue', pr: ep.pr });
    // Byte-stable text so P17 attention-coalescing dedupes it instead of flooding.
    void this.refreshAggregate(state, [`PR #${ep.pr} has had auto-merge armed >24h and still hasn't merged — CI may be stuck or red; needs a look`]);
  }

  // ---- disarm reach — operator kill-switch (Blocker 3) --------------------

  /**
   * Enumerate every `armedAt` episode and `gh pr merge <pr> --disable-auto` it.
   * Called IN-LINE from the rollback / pool-disarm route handlers (NOT the
   * latch-gated tick — the latch the operator just set is the very thing that
   * stops the tick reaching this code). LEASE-INDEPENDENT (like applyHold); the
   * operator's kill switch must reach the armed merges from wherever the route
   * is served, and `--disable-auto` is idempotent/safe from any holder.
   *
   * Honest failure (Blocker 3b): on a CONFIRMED disable, clear armedAt/armedHead
   * and add to the disarmed-confirmed set; on a FAILED disable, LEAVE armedAt set
   * (reconciliation keeps watching it) and add to a DISTINCT disarm-FAILED set.
   * The two outcomes are NEVER collapsed into one attention line.
   */
  async disarmAllArmed(reason: string): Promise<{ disarmed: number[]; failed: number[] }> {
    const state = this.deps.loadState();
    const armed = Object.values(state.episodes).filter((e) => e.armedAt != null).map((e) => e.pr);
    const disarmed: number[] = [];
    const failed: number[] = [];
    for (const pr of armed) {
      let ok = false;
      try {
        ok = await this.deps.disarmArmedEpisodes(pr);
      } catch { /* @silent-fallback-ok: green-pr-automerge fail-safe — a disable error is an honest FAILED disarm, never a silent strand */
        ok = false;
      }
      const ep = state.episodes[pr];
      if (ok) {
        if (ep) { delete ep.armedAt; delete ep.armedHead; delete ep.overdue; delete ep.overdueSurfacedAt; }
        disarmed.push(pr);
        this.deps.audit({ kind: 'green-pr-automerge', event: 'disarmed', pr, reason });
      } else {
        // Leave armedAt set so reconciliation keeps watching it.
        failed.push(pr);
        this.deps.audit({ kind: 'green-pr-automerge', event: 'disarm-failed', pr, reason });
      }
    }
    const lines: string[] = [];
    if (disarmed.length > 0) {
      lines.push(`Disarmed auto-merge on PR ${disarmed.map((p) => `#${p}`).join(', ')} per ${reason} — they will NOT merge until re-armed`);
    }
    for (const pr of failed) {
      lines.push(`Could NOT disable auto-merge on PR #${pr} — disable it on GitHub directly; it may still merge`);
    }
    if (lines.length > 0) await this.refreshAggregate(state, lines);
    this.deps.saveState(state);
    return { disarmed, failed };
  }

  // ---- identity (R4) ------------------------------------------------------

  private async identityOk(state: GreenPrState): Promise<'ok' | 'identity-unconfigured' | 'identity-mismatch' | 'identity-unresolved'> {
    if (!this.cfg.expectedGhLogin) return 'identity-unconfigured';
    const ttlMs = this.cfg.identityRecheckTicks * this.cfg.tickIntervalMs;
    const cached = state.identity;
    const fresh = cached && (this.deps.now() - cached.resolvedAt) < ttlMs;
    let login = fresh ? cached!.login : null;
    if (!fresh) {
      login = await this.deps.resolveGhLogin();
      state.identity = { login, resolvedAt: this.deps.now() };
    }
    if (login === null) return 'identity-unresolved';
    if (login !== this.cfg.expectedGhLogin) return 'identity-mismatch';
    return 'ok';
  }

  // ---- warm-up orphan reap (R5) ------------------------------------------

  private async warmupReap(state: GreenPrState): Promise<void> {
    try {
      const r = await this.deps.runner.reapOrphan();
      if (r.reaped) this.deps.audit({ kind: 'green-pr-automerge', event: 'orphan-reaped', outcome: r.outcome });
    } catch (e) { /* @silent-fallback-ok: green-pr-automerge fail-safe — skip/refuse, never over-merge; safe-merge is the act-time authority */
      this.deps.audit({ kind: 'green-pr-automerge', event: 'orphan-reap-incomplete', detail: String((e as Error)?.message).slice(0, 120) });
    }
  }

  // ---- aggregated attention (P17) ----------------------------------------

  private async refreshAggregate(state: GreenPrState, addLines: string[]): Promise<void> {
    const lines = new Set([...(state.attentionLines ?? []), ...addLines]);
    state.attentionLines = [...lines].slice(-50);
    try {
      await this.deps.postAttentionAggregate(state.attentionLines);
    } catch { /* @silent-fallback-ok: green-pr-automerge fail-safe — skip/refuse, never over-merge; safe-merge is the act-time authority */ /* attention delivery failure is non-fatal to the tick */ }
  }

  // ---- red-PR watchdog (red-pr-watchdog) ----------------------------------

  /**
   * SIGNAL-ONLY pass over MY OWN open PRs: raise ONE deduped, age-escalating
   * attention line for each PR that has a required check stuck RED past
   * `redThresholdMs`. Never blocks/merges/closes — it only calls refreshAggregate.
   *
   * Dedup: per-PR `redPrRaised` memory. First stuck observation raises; after
   * that, re-raise only when the elapsed-hours bucket GROWS or the failing-check
   * SET changes. A PR that recovers (no stuck-red checks) or leaves the open list
   * (merged/closed) has its memory cleared (Close the Loop).
   *
   * "My own" is the branch-namespace filter (a pure proxy for author — listOpenPrs
   * already passes `--author @me`, and PrSummary carries no author field).
   */
  private redPrWatchdogPass(prs: PrSummary[], state: GreenPrState): void {
    const wd = this.cfg.redPrWatchdog;
    if (!wd || wd.enabled === false) return;
    const now = this.deps.now();
    const thresholdMs = wd.redThresholdMs ?? DEFAULTS.redPrWatchdog.redThresholdMs;
    const raised = (state.redPrRaised ??= {});
    const openPrNumbers = new Set(prs.map((p) => p.number));
    const lines: string[] = [];

    for (const pr of prs) {
      // Only my own PRs (branch-namespace proxy for author).
      if (!headInNamespace(pr.headRefName, this.cfg.agentNamespace)) continue;
      const stuck = stuckRedChecks(pr, now, thresholdMs);
      if (stuck.length === 0) {
        // Green / recovered / not-yet-stuck → clear any prior raise.
        if (raised[pr.number]) {
          delete raised[pr.number];
          this.deps.audit({ kind: 'green-pr-automerge', event: 'red-pr-recovered', pr: pr.number });
        }
        continue;
      }
      const checkNames = [...new Set(stuck.map((c) => c.name))].sort();
      const firstFailAt = Math.min(...stuck.map((c) => c.completedAt));
      const hours = Math.max(1, Math.round((now - firstFailAt) / 3_600_000));
      const prior = raised[pr.number];
      const checksChanged = !prior || prior.checks.join(' ') !== checkNames.join(' ');
      const aged = !!prior && hours > prior.hours;
      if (!prior || aged || checksChanged) {
        raised[pr.number] = { at: now, firstFailAt, hours, checks: checkNames };
        lines.push(`PR #${pr.number} red for ${hours}h — ${checkNames.join(', ')}`);
        this.deps.audit({ kind: 'green-pr-automerge', event: 'red-pr-stuck', pr: pr.number, hours, checks: checkNames });
      }
    }

    // Clear memory for PRs no longer in the open list (they merged/closed).
    for (const key of Object.keys(raised)) {
      const n = Number(key);
      if (!openPrNumbers.has(n)) {
        delete raised[n];
        this.deps.audit({ kind: 'green-pr-automerge', event: 'red-pr-cleared', pr: n, reason: 'closed-or-merged' });
      }
    }

    if (lines.length > 0) void this.refreshAggregate(state, lines);
  }

  /**
   * The GET /green-pr-automerge read surface for the watchdog: the current
   * config + the live stuck-red memory (answers "why did I get a red-PR alert?").
   * `redForMs` is measured from each PR's oldest failing check.
   */
  redPrWatchdogView(): {
    config: { enabled: boolean; redThresholdMs: number };
    stuckRed: { pr: number; redForMs: number; failingChecks: string[] }[];
  } {
    const state = this.deps.loadState();
    const now = this.deps.now();
    const raised = state.redPrRaised ?? {};
    const stuckRed = Object.entries(raised).map(([pr, r]) => ({
      pr: Number(pr),
      redForMs: Math.max(0, now - (r.firstFailAt ?? r.at ?? now)),
      failingChecks: Array.isArray(r.checks) ? r.checks : [],
    }));
    return {
      config: {
        enabled: this.cfg.redPrWatchdog.enabled !== false,
        redThresholdMs: this.cfg.redPrWatchdog.redThresholdMs ?? DEFAULTS.redPrWatchdog.redThresholdMs,
      },
      stuckRed,
    };
  }

  // ---- runtime control (R9, via GuardLatchStore wired at boot) ------------
  // rollback / enable / pool-disarm are driven through the routes against the
  // GuardLatchStore directly; the watcher only READS the gate each tick.

  private breakerCfg() {
    return {
      busySkipBreakerThreshold: this.cfg.busySkipBreakerThreshold,
      deadlineKillBreakerThreshold: this.cfg.deadlineKillBreakerThreshold,
      breakerThreshold: this.cfg.breakerThreshold,
      breakerCooldownMs: this.cfg.breakerCooldownMin * 60_000,
    };
  }

  private ladderCfg() {
    return { maxAttempts: this.cfg.maxAttempts, maxRearmEpisodes: this.cfg.maxRearmEpisodes, backoffBaseMs: this.cfg.backoffBaseMs };
  }
}

function safeBool(fn: () => boolean): boolean {
  try { return !!fn(); } catch { /* @silent-fallback-ok: green-pr-automerge fail-safe — skip/refuse, never over-merge; safe-merge is the act-time authority */ return false; }
}
function safeNum(fn: () => number): number {
  try { const n = fn(); return Number.isFinite(n) ? n : 0; } catch { /* @silent-fallback-ok: green-pr-automerge fail-safe — skip/refuse, never over-merge; safe-merge is the act-time authority */ return 0; }
}
