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
  /** safe-merge's classified result slug, e.g. merged / refused:* / error:* / already-merged / closed. */
  outcome: string;
  /** True only when an INDEPENDENT gh pr view confirmed MERGED (B10). */
  confirmedMerged: boolean;
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
  /** Re-fetch hold-relevant + state fields immediately before acting. null → vanished. */
  refetchPr(pr: number): Promise<Pick<PrSummary, 'title' | 'labels' | 'isDraft' | 'headRefOid'> & { state: string } | null>;
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
};

export function freshState(): GreenPrState {
  return {
    consecutiveWarmupOnlyTenures: 0,
    breaker: freshBreaker(),
    episodes: {},
    holdMemory: {},
    snapshot: { at: 0, entries: [] },
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
    } as ResolvedConfig;
    const inv = validateTimeoutInvariant(
      this.cfg.busySkipBreakerThreshold,
      this.cfg.tickIntervalMs,
      this.cfg.mergeTimeoutMs,
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

    // B10: classify "merged" ONLY on independent confirmation.
    const outcome = result.outcome === 'merged' && !result.confirmedMerged ? 'error:merge-unconfirmed' : result.outcome;
    this.recordOutcome(state, target, outcome);
    return outcome === 'merged';
  }

  private recordOutcome(state: GreenPrState, target: PrSummary, outcome: string): void {
    const ep: Episode = state.episodes[target.number] ?? { pr: target.number, headRefOid: target.headRefOid, attempts: 0, rearmEpisodes: 0, state: 'active' };
    const folded = applyOutcome(ep, outcome, this.deps.now(), this.ladderCfg());
    state.episodes[target.number] = folded.ep;
    if (folded.feedsBreaker) {
      // Per-PR ladder failures do NOT feed the global breaker directly (that is
      // for tick/deadline/busy classes); they advance the per-PR ladder only.
    }
    this.deps.audit({ kind: 'green-pr-automerge', event: outcome, pr: target.number });
    if (outcome === 'merged') {
      // Reap the episode on success.
      delete state.episodes[target.number];
    } else if (folded.ep.state === 'gave-up' && outcome !== 'merged-by-other' && outcome !== 'closed-by-other') {
      void this.refreshAggregate(state, [`PR #${target.number} could not be auto-merged after ${folded.ep.attempts} attempts (${outcome}) — needs a look`]);
    } else if (outcome === 'closed-by-other') {
      void this.refreshAggregate(state, [`PR #${target.number} was closed without merging — discarded work`]);
    }
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
