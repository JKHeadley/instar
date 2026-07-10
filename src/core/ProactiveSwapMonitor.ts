/**
 * ProactiveSwapMonitor — the PRE-LIMIT half of the Subscription & Auth Standard's
 * continuity guarantee (P1.3).
 *
 * The reactive path (`autoSwapOnRateLimit`) only fires AFTER a session hits its
 * account's wall: a RateLimitSentinel escalation on an ACTUAL throttle signal.
 * So a session blips at the wall before recovering — and an UNTAGGED session
 * (one with no `subscriptionAccountId`, e.g. the primary interactive session
 * running on the default config) has nothing for the swap engine to grab, so it
 * just wedges until an operator manually swaps the default login. That is the
 * exact 2026-06-09 failure that motivated this monitor.
 *
 * This monitor moves a session OFF an account BEFORE it walls, at a lag-aware
 * measured threshold below the real limit.
 *
 * ── Anti-thrash brakes (swap-continuity-antithrash §3) ──
 * The 2026-07-02 thrash day (36 executed proactive swaps in 8 waves, repeated
 * kills of six parallel build subagents) proved the bare threshold loop
 * oscillates. When an SwapAntiThrashEngine is wired (`cfg.antiThrash`), every
 * proactive decision runs the brake pipeline at THIS chokepoint:
 * ledger-lost pause → thrash breaker → dwell → validity gate + all-hot →
 * filter→score→verify target selection → reversal refusal. In dryRun the
 * legacy decision path stays byte-identical to v1.3.722 while the engine logs
 * would-refuse rows (the rung-2 soak); live, the engine's verdict binds and
 * UNTAGGED sessions leave the proactive candidate set entirely (Q3 — a
 * background optimizer must never mutate the default-slot binding).
 *
 * ── In-flight work deferral (swap-continuity-antithrash §4) ──
 * When a SwapWorkGate is wired (`cfg.workGate`) and swapContinuity is live, a
 * braked proactive swap whose session is BUSY (mid-turn or carrying live
 * subagents) is DEFERRED — the intent is retried each tick through the FULL
 * brake pipeline (I9), bounded by `deferralCeilingMs`; at the ceiling the
 * intent is DROPPED (the wall wins; the reactive floor exists) and the
 * session enters re-intent backoff. The monitor owns the deferral lifecycle
 * (the gate is a stateless predicate).
 *
 * ── Bounded, non-storming ──
 * Per evaluation: candidates are sorted newest-first and capped per cycle
 * (executed swaps only — deferrals never consume the budget); at most one
 * executed swap per target account per tick (pile-on cap); each swapped
 * session enters dwell (ledger-backed, restart-safe). Near the wall the
 * monitor triggers a fresh poll so a fast burn isn't missed between the
 * low-frequency baseline polls.
 *
 * Gated OFF by default (moving live sessions is real authority — same authority
 * as `autoSwapOnRateLimit`, just an earlier trigger). The decision core is pure
 * (injected deps) so it tests with zero sessions and zero network.
 */

import {
  selectAccount,
  accountAtPressure,
} from './QuotaAwareScheduler.js';
import type { SubscriptionAccount } from './SubscriptionPool.js';
import type { SwapAntiThrashEngine, AntiThrashKnobs } from './SwapAntiThrash.js';
import type { WorkProbeResult } from './SwapWorkGate.js';
import { governor, consumeAdmissionToken } from '../monitoring/selfaction/governor.js';
import type { DerivedTarget } from '../monitoring/selfaction/types.js';

/* @self-action-controller: proactive-swap-monitor */
// Unified self-action backpressure (Increment B, OBSERVE-ONLY): every executed
// proactive swap rides the SelfActionGovernor chokepoint ADDITIVELY — none of
// the incident-earned anti-thrash brakes above is removed (retrofit is
// additive at every rung; the tightest bound wins). Observe mode records the
// would-verdict and always allows.
const proactiveSwapGov = governor.for('proactive-swap-monitor');

/** Canonical target derivation for the swap controller: the DESTINATION
 *  account is the anti-ping-pong recurrence identity (A→B→A collapses onto
 *  the per-account ceiling); the legacy path — where the scheduler picks the
 *  destination at execute time — keys on the vacated account (stable, never
 *  a per-incarnation id). */
export function deriveTargetKey(ctx: { targetAccountId?: string; exhaustedAccountId: string }): DerivedTarget {
  return {
    key: `account:${ctx.targetAccountId ?? ctx.exhaustedAccountId}`,
    classId: 'subscription-account',
    keyIsVolatile: false,
  };
}

/** A running, swap-eligible session as the monitor sees it. */
export interface ProactiveSwapSession {
  /** tmux session name (what the swap path keys on). */
  sessionName: string;
  /** The pool account this session is tagged with, or null if untagged
   *  (untagged ⇒ running on the default config ⇒ resolved via the default login). */
  accountId: string | null;
  /** ISO start time — newest-first ordering proxy for "most recently active". */
  startedAt?: string;
}

/** The shape returned by the injected swap (a subset of QuotaAwareScheduler.SwapResult). */
export interface ProactiveSwapOutcome {
  swapped: boolean;
  toAccountId: string | null;
  reason?: string;
}

/** swapContinuity knobs as the monitor consumes them (resolved by the wiring). */
export interface SwapContinuityKnobs {
  enabled: boolean;
  dryRun: boolean;
  deferralCeilingMs: number;
  reactiveGraceMs: number;
  recheckMs: number;
}

export interface ProactiveSwapMonitorConfig {
  /** Current pool accounts (e.g. () => pool.list()). */
  listAccounts: () => SubscriptionAccount[];
  /** Currently-running, swap-eligible (claude-code) sessions. */
  listRunningSessions: () => ProactiveSwapSession[];
  /** The pool account the DEFAULT config is logged into right now (or null).
   *  Untagged sessions run here; from InUseAccountResolver in production. */
  resolveDefaultAccountId: () => Promise<string | null>;
  /** Performs the actual swap (wraps QuotaAwareScheduler.onQuotaPressure).
   *  When the brakes are LIVE the monitor passes the authoritative
   *  `targetAccountId` through (§3.3 — the checked target IS the executed
   *  target, I1) plus `callerClass: 'proactive-swap'`. */
  swap: (args: {
    sessionName: string;
    exhaustedAccountId: string;
    nowMs: number;
    targetAccountId?: string;
    callerClass?: 'proactive-swap';
  }) => Promise<ProactiveSwapOutcome>;
  /** Optional fresh-poll trigger, awaited when an account is in the watch zone. */
  triggerPoll?: () => Promise<unknown>;
  /** Measured binding-window utilization % that triggers a pre-emptive swap. Default 80. */
  thresholdPct?: number;
  /** When an at-risk account is within this many points of the threshold, the
   *  monitor refreshes the poll before deciding (so a fast burn isn't missed
   *  between baseline polls). Default 15 (i.e. watch zone starts at 65%). */
  watchMarginPct?: number;
  /** Max sessions swapped per evaluation cycle (storm guard). Default 3. */
  maxSwapsPerCycle?: number;
  /** Per-session cooldown after a successful swap before it's eligible again.
   *  Default 600000 (10m) — must exceed the swap+restart time. SUBSUMED by
   *  antiThrash dwell when the brakes are live (§9). */
  cooldownMs?: number;
  /** Monitor tick cadence. Default 180000 (3m). */
  tickMs?: number;
  /** Anti-thrash brakes (Piece 1). Knobs read LIVE per tick (§7.1). */
  antiThrash?: {
    engine: SwapAntiThrashEngine;
    getKnobs: () => AntiThrashKnobs;
  };
  /** In-flight work deferral (Piece 2). Knobs read live per evaluation. */
  workGate?: {
    probe: (sessionName: string) => Promise<WorkProbeResult>;
    getContinuity: () => SwapContinuityKnobs;
  };
  /** Injected for tests. */
  now?: () => number;
  logger?: { log: (m: string) => void; warn: (m: string) => void };
}

export interface ProactiveSwapTickResult {
  /** Session names that were actually swapped this pass. */
  swapped: string[];
  /** How many sessions were eligible (at-pressure, has-alternate, off-cooldown). */
  considered: number;
  /** Whether a fresh poll was triggered before the decision (watch zone). */
  refreshed: boolean;
}

interface Candidate {
  sessionName: string;
  /** The effective (resolved) account the session is running under. */
  accountId: string;
  /** Start time in ms (0 when unknown) — recency ordering. */
  startedMs: number;
  /** True when the session carries no tag (resolved via the default slot). */
  untagged: boolean;
}

interface DeferralEntry {
  firstAtMs: number;
  count: number;
  from: string;
  to: string;
}

export class ProactiveSwapMonitor {
  private readonly cfg: ProactiveSwapMonitorConfig;
  private readonly thresholdPct: number;
  private readonly watchMarginPct: number;
  private readonly maxSwapsPerCycle: number;
  private readonly cooldownMs: number;
  private readonly tickMs: number;
  private readonly now: () => number;
  private readonly logger: { log: (m: string) => void; warn: (m: string) => void };
  /** Last successful-swap timestamp per session (legacy cooldown bookkeeping). */
  private readonly lastSwapAt = new Map<string, number>();
  /** Pending deferred proactive intents (Piece 2 — monitor-owned lifecycle). */
  private readonly deferrals = new Map<string, DeferralEntry>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private lastResult: ProactiveSwapTickResult | null = null;

  constructor(cfg: ProactiveSwapMonitorConfig) {
    this.cfg = cfg;
    this.thresholdPct = cfg.thresholdPct ?? 80;
    this.watchMarginPct = cfg.watchMarginPct ?? 15;
    this.maxSwapsPerCycle = cfg.maxSwapsPerCycle ?? 3;
    this.cooldownMs = cfg.cooldownMs ?? 600_000;
    this.tickMs = cfg.tickMs ?? 180_000;
    this.now = cfg.now ?? (() => Date.now());
    this.logger = cfg.logger ?? { log: () => {}, warn: () => {} };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.ticking) return; // never overlap ticks
      void this.tick();
    }, this.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Status for the read route (never throws). Additive `brakes`/`deferrals`
   *  blocks per swap-continuity-antithrash §6.3 (all fields LOCAL-SCOPE). */
  status(): {
    thresholdPct: number;
    watchPct: number;
    maxSwapsPerCycle: number;
    cooldownMs: number;
    tickMs: number;
    running: boolean;
    lastResult: ProactiveSwapTickResult | null;
    antiThrash?: { enabled: boolean; dryRun: boolean };
    brakes?: Record<string, unknown>;
    deferrals?: { active: number; sessions: string[] };
  } {
    const base = {
      thresholdPct: this.thresholdPct,
      watchPct: Math.max(0, this.thresholdPct - this.watchMarginPct),
      maxSwapsPerCycle: this.maxSwapsPerCycle,
      cooldownMs: this.cooldownMs,
      tickMs: this.tickMs,
      running: this.timer !== null,
      lastResult: this.lastResult,
    };
    if (!this.cfg.antiThrash) return base;
    const knobs = this.safeKnobs();
    return {
      ...base,
      ...(knobs ? { antiThrash: { enabled: knobs.enabled, dryRun: knobs.dryRun } } : {}),
      brakes: this.cfg.antiThrash.engine.status(this.now()),
      deferrals: { active: this.deferrals.size, sessions: [...this.deferrals.keys()] },
    };
  }

  /**
   * One monitor pass: if any at-risk account is in the watch zone, refresh the
   * quota poll first (fresh data near the wall), then evaluate + swap.
   */
  async tick(): Promise<ProactiveSwapTickResult> {
    if (this.ticking) {
      return this.lastResult ?? { swapped: [], considered: 0, refreshed: false };
    }
    this.ticking = true;
    try {
      let refreshed = false;
      if (this.cfg.triggerPoll) {
        const watchPct = Math.max(0, this.thresholdPct - this.watchMarginPct);
        const near = (await this.mapCandidates(watchPct)).length > 0;
        if (near) {
          try {
            await this.cfg.triggerPoll();
            refreshed = true;
          } catch {
            // @silent-fallback-ok: a poll blip just means we decide on prior data
          }
        }
      }
      const evaluated = await this.evaluate();
      const result: ProactiveSwapTickResult = { ...evaluated, refreshed };
      this.lastResult = result;
      return result;
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Pure-ish decision + swap on the CURRENT snapshots (no poll refresh). Exposed
   * for tests and the on-demand check route.
   *
   * With the anti-thrash brakes LIVE the braked pipeline binds; in dryRun (or
   * with no engine wired) the legacy v1.3.722 decision path is byte-identical
   * while the engine (when present) logs would-decisions for the soak.
   */
  async evaluate(): Promise<{ swapped: string[]; considered: number }> {
    const nowMs = this.now();
    const accounts = this.cfg.listAccounts();
    const knobs = this.safeKnobs();
    const engine = this.cfg.antiThrash?.engine ?? null;
    const engineActive = !!(engine && knobs?.enabled);
    const live = !!(engineActive && knobs && !knobs.dryRun);

    if (engine && knobs?.enabled) engine.beginTick(accounts, nowMs, true);
    try {
      if (live && engine && knobs) {
        return await this.evaluateBraked(engine, accounts, nowMs);
      }
      return await this.evaluateLegacy(accounts, nowMs, engineActive ? engine : null);
    } finally {
      if (engine && knobs?.enabled) engine.endTick(nowMs);
    }
  }

  // ── The LIVE braked pipeline (§3 + §4 proactive arm) ─────────────────────
  private async evaluateBraked(
    engine: SwapAntiThrashEngine,
    accounts: SubscriptionAccount[],
    nowMs: number,
  ): Promise<{ swapped: string[]; considered: number }> {
    const byId = new Map(accounts.map((a) => [a.id, a]));
    // Candidate set: TAGGED sessions only (Q3 — untagged sessions are outside
    // the proactive candidate set by construction, I10), whose source account
    // carries a VALID fresh reading at/over the threshold (§3.3 source leg).
    const candidates: Candidate[] = [];
    const currentAccountBySession = new Map<string, string | null>();
    for (const s of this.cfg.listRunningSessions()) {
      currentAccountBySession.set(s.sessionName, s.accountId);
      if (!s.accountId) continue;
      const acct = byId.get(s.accountId);
      if (!acct) continue;
      if (!engine.sourceEligible(acct, nowMs)) continue;
      const startedMs = s.startedAt ? Date.parse(s.startedAt) : NaN;
      candidates.push({
        sessionName: s.sessionName,
        accountId: s.accountId,
        startedMs: Number.isFinite(startedMs) ? startedMs : 0,
        untagged: false,
      });
    }
    candidates.sort((a, b) => b.startedMs - a.startedMs);

    // Deferral invalidation sweep (I9): an intent whose session's account
    // changed underneath it (a reactive swap moved it), or whose session left
    // candidacy (wave subsided / session gone), is INVALIDATED — never
    // executed as a second kill inside the dwell window.
    for (const [session, d] of [...this.deferrals]) {
      const stillCandidate = candidates.some((c) => c.sessionName === session);
      const currentAcct = currentAccountBySession.get(session);
      if (!stillCandidate || currentAcct !== d.from) {
        engine.recordInvalidated({
          session,
          from: d.from,
          to: d.to,
          nowMs,
          deferralAgeMs: nowMs - d.firstAtMs,
          deferCount: d.count,
        });
        this.deferrals.delete(session);
      }
    }

    const targetsUsedThisTick = new Set<string>();
    const swapped: string[] = [];
    let considered = 0;
    const continuity = this.safeContinuity();

    for (const c of candidates) {
      if (swapped.length >= this.maxSwapsPerCycle) break;
      considered += 1;
      const deferral = this.deferrals.get(c.sessionName);
      const deferralAgeMs = deferral ? nowMs - deferral.firstAtMs : undefined;

      // Full brake pipeline — re-run on every deferred retry too (I9: the
      // intent that finally fires is one that would have been approved fresh).
      const verdict = engine.evaluateIntent({
        session: c.sessionName,
        fromAccountId: c.accountId,
        accounts,
        nowMs,
        targetsUsedThisTick,
        ...(deferralAgeMs !== undefined ? { deferralAgeMs } : {}),
        ...(deferral ? { deferCount: deferral.count } : {}),
      });
      if (verdict.action !== 'execute') continue; // refusal rows already written by the engine

      // Piece 2: the work gate (proactive arm — defer, ceiling-drop).
      if (this.cfg.workGate && continuity?.enabled) {
        let probe: WorkProbeResult | null = null;
        try {
          probe = await this.cfg.workGate.probe(c.sessionName);
        } catch {
          // @silent-fallback-ok: probe machinery itself failed → indeterminate,
          // which resolves BUSY (I7) — the swap is DEFERRED, the safe direction;
          // the deferral is recorded on the anti-thrash engine below.
          probe = null;
        }
        const busy = probe ? probe.busy : true;
        if (busy) {
          const reason = probe?.reason ?? 'busy-indeterminate';
          const inFlight = { turn: probe?.turnInFlight ?? false, subagents: probe?.subagents?.length ?? 0 };
          const subagentLeg = probe?.subagentLeg ?? 'indeterminate';
          if (continuity.dryRun) {
            // Would-defer (rung-2 soak): log the row, change nothing.
            engine.recordDeferred({
              session: c.sessionName,
              from: c.accountId,
              to: verdict.targetAccountId,
              nowMs,
              reason,
              inFlight,
              subagentLeg,
              deferralAgeMs: 0,
              deferCount: 1,
              dryRun: true,
              rowKind: 'first',
            });
            // fall through to execute (dryRun changes nothing)
          } else {
            const d: DeferralEntry = deferral ?? {
              firstAtMs: nowMs,
              count: 0,
              from: c.accountId,
              to: verdict.targetAccountId,
            };
            d.count += 1;
            d.to = verdict.targetAccountId; // ceiling clock carries across target re-selection (§4.2)
            this.deferrals.set(c.sessionName, d);
            const age = nowMs - d.firstAtMs;
            if (age >= continuity.deferralCeilingMs) {
              // At the ceiling: the wall wins — DROP the intent; the session
              // keeps working and the reactive floor absorbs a genuine wall.
              engine.recordDropped({
                session: c.sessionName,
                from: d.from,
                to: d.to,
                nowMs,
                deferralAgeMs: age,
                deferCount: d.count,
                inFlight,
                subagentLeg,
              });
              this.deferrals.delete(c.sessionName);
            } else if (d.count === 1) {
              // Dedup (§4.2): FIRST row only; the final row is the eventual
              // swapped/dropped/invalidated row carrying deferCount.
              engine.recordDeferred({
                session: c.sessionName,
                from: d.from,
                to: d.to,
                nowMs,
                reason,
                inFlight,
                subagentLeg,
                deferralAgeMs: age,
                deferCount: d.count,
                rowKind: 'first',
              });
            }
            continue;
          }
        }
      }

      // Execute — the checked target IS the executed target (I1); the
      // scheduler revalidates the WHOLE decision at execute time (§3.3).
      try {
        // Self-action backpressure admission (observe-only: always allows).
        // An enforce-mode non-allow stands down this candidate — the pressure
        // condition re-fires on the next tick (level-triggered).
        const swapTarget = deriveTargetKey({ targetAccountId: verdict.targetAccountId, exhaustedAccountId: c.accountId });
        const swapAdmission = await proactiveSwapGov.admit(swapTarget, { incarnation: c.sessionName, lane: 'job' });
        if (swapAdmission.outcome !== 'allow') continue;
        const swapSink = consumeAdmissionToken(swapAdmission.token, 'proactive-swap-monitor', { targetKey: swapTarget.key });
        if (!swapSink.proceed) continue;
        const outcome = await this.cfg.swap({
          sessionName: c.sessionName,
          exhaustedAccountId: c.accountId,
          nowMs,
          targetAccountId: verdict.targetAccountId,
          callerClass: 'proactive-swap',
        });
        if (outcome.swapped) {
          engine.recordProactiveExecuted({
            session: c.sessionName,
            from: c.accountId,
            to: outcome.toAccountId ?? verdict.targetAccountId,
            nowMs,
            fromUtilPct: verdict.fromUtilPct,
            toUtilPct: verdict.toUtilPct,
            ...(deferral ? { deferralAgeMs: nowMs - deferral.firstAtMs, deferCount: deferral.count } : {}),
          });
          this.lastSwapAt.set(c.sessionName, nowMs);
          this.deferrals.delete(c.sessionName);
          targetsUsedThisTick.add(verdict.targetAccountId);
          swapped.push(c.sessionName);
          this.logger.log(
            `[ProactiveSwap] ${c.sessionName}: pre-emptively swapped off ${c.accountId} → ${outcome.toAccountId ?? verdict.targetAccountId} ` +
              `(account ≥${this.thresholdPct}% measured — moved before the wall, conversation preserved)`,
          );
        } else if (outcome.reason === 'target-revalidation-failed') {
          engine.recordRevalidationRefusal({
            session: c.sessionName,
            from: c.accountId,
            to: verdict.targetAccountId,
            nowMs,
            reason: 'target-revalidation-failed',
          });
        } else if (outcome.reason === 'intent-stale') {
          engine.recordRevalidationRefusal({
            session: c.sessionName,
            from: c.accountId,
            to: verdict.targetAccountId,
            nowMs,
            reason: 'intent-stale',
          });
          this.deferrals.delete(c.sessionName);
        } else if (outcome.reason === 'session-busy') {
          // Funnel-gate race: the SessionRefresh work gate saw busy after our
          // probe. Treat exactly like a busy probe (deferral bookkeeping).
          const d: DeferralEntry = deferral ?? { firstAtMs: nowMs, count: 0, from: c.accountId, to: verdict.targetAccountId };
          d.count += 1;
          this.deferrals.set(c.sessionName, d);
        } else {
          engine.recordExecFailure({
            session: c.sessionName,
            from: c.accountId,
            to: verdict.targetAccountId,
            kind: 'proactive',
            errorClass: outcome.reason ?? 'refresh-failed',
            nowMs,
          });
        }
      } catch (err) {
        // §3.6: a swap execution that THROWS is a failed row + backoff — never
        // a silent every-tick retry.
        engine.recordExecFailure({
          session: c.sessionName,
          from: c.accountId,
          to: verdict.targetAccountId,
          kind: 'proactive',
          errorClass: err instanceof Error ? err.constructor.name : 'Error',
          nowMs,
        });
      }
    }
    return { swapped, considered };
  }

  // ── The legacy v1.3.722 decision path (dark / dryRun — byte-identical) ───
  private async evaluateLegacy(
    accounts: SubscriptionAccount[],
    nowMs: number,
    shadowEngine: SwapAntiThrashEngine | null,
  ): Promise<{ swapped: string[]; considered: number }> {
    const atPressure = await this.mapCandidates(this.thresholdPct);

    const eligible = atPressure.filter((c) => {
      const last = this.lastSwapAt.get(c.sessionName);
      if (last !== undefined && nowMs - last < this.cooldownMs) return false;
      // Only swap when there's an alternate BELOW the proactive threshold — never
      // move a session onto an account that is itself nearly full (anti-thrash).
      const alt = selectAccount(
        accounts,
        { softThresholdPct: this.thresholdPct, nowMs },
        c.accountId,
      );
      return alt !== null;
    });

    // Newest-(re)started first: the interactive session a user is actively in
    // (it just restarted on compaction/recovery) ranks ahead of idle background
    // sessions, so under the per-cycle cap it is rescued first.
    eligible.sort((a, b) => b.startedMs - a.startedMs);

    // Rung-2 dry-run shadow (§10): the engine evaluates the LIVE rule's
    // candidate set (tagged only) and writes would-refuse/would-defer rows —
    // observability with ZERO decision change.
    if (shadowEngine) {
      const shadowTargets = new Set<string>();
      for (const c of atPressure) {
        if (c.untagged) continue; // Q3 — untagged is outside the live candidate set
        try {
          shadowEngine.evaluateIntent({
            session: c.sessionName,
            fromAccountId: c.accountId,
            accounts,
            nowMs,
            targetsUsedThisTick: shadowTargets,
          });
        } catch {
          // @silent-fallback-ok: the shadow must never affect the legacy path
        }
      }
    }

    const toSwap = eligible.slice(0, this.maxSwapsPerCycle);
    const swapped: string[] = [];
    for (const c of toSwap) {
      let outcome: ProactiveSwapOutcome;
      try {
        // Self-action backpressure admission (observe-only; legacy path keys
        // on the vacated account — the scheduler picks the destination).
        const legacySwapTarget = deriveTargetKey({ exhaustedAccountId: c.accountId });
        const legacySwapAdmission = await proactiveSwapGov.admit(legacySwapTarget, { incarnation: c.sessionName, lane: 'job' });
        if (legacySwapAdmission.outcome !== 'allow') continue;
        const legacySwapSink = consumeAdmissionToken(legacySwapAdmission.token, 'proactive-swap-monitor', { targetKey: legacySwapTarget.key });
        if (!legacySwapSink.proceed) continue;
        outcome = await this.cfg.swap({
          sessionName: c.sessionName,
          exhaustedAccountId: c.accountId,
          nowMs,
          callerClass: 'proactive-swap',
        });
      } catch (err) {
        // Legacy behavior: retried next cycle (no cooldown set). With the
        // engine present the failure is at least RECORDED (§3.6 observability;
        // decision behavior unchanged in dryRun — no backoff binds here).
        shadowEngine?.recordExecFailure({
          session: c.sessionName,
          from: c.accountId,
          kind: 'proactive',
          errorClass: err instanceof Error ? err.constructor.name : 'Error',
          nowMs,
        });
        continue;
      }
      if (outcome.swapped) {
        this.lastSwapAt.set(c.sessionName, nowMs);
        swapped.push(c.sessionName);
        shadowEngine?.recordProactiveExecuted({
          session: c.sessionName,
          from: c.accountId,
          to: outcome.toAccountId ?? '',
          nowMs,
          ...(c.untagged ? { defaultAccountChanged: true } : {}),
        });
        this.logger.log(
          `[ProactiveSwap] ${c.sessionName}: pre-emptively swapped off ${c.accountId} → ${outcome.toAccountId} ` +
            `(account ≥${this.thresholdPct}% measured — moved before the wall, conversation preserved)`,
        );
      }
    }
    return { swapped, considered: eligible.length };
  }

  private safeKnobs(): AntiThrashKnobs | null {
    try {
      return this.cfg.antiThrash?.getKnobs() ?? null;
    } catch {
      // @silent-fallback-ok: a broken knob getter reads as feature-dark (null)
      // — the brakes simply stay out of the path; legacy swap behavior holds.
      return null;
    }
  }

  private safeContinuity(): SwapContinuityKnobs | null {
    try {
      return this.cfg.workGate?.getContinuity() ?? null;
    } catch {
      // @silent-fallback-ok: same feature-dark degrade as safeKnobs above.
      return null;
    }
  }

  /**
   * Map running sessions to candidates whose EFFECTIVE account is at/over minPct.
   * Effective account = the session's tag, else the default-config login (so the
   * untagged interactive session is visible). Resolves the default login once.
   */
  private async mapCandidates(minPct: number): Promise<Candidate[]> {
    const accounts = this.cfg.listAccounts();
    const byId = new Map(accounts.map((a) => [a.id, a]));
    let defaultAcctId: string | null = null;
    try {
      defaultAcctId = await this.cfg.resolveDefaultAccountId();
    } catch {
      defaultAcctId = null; // @silent-fallback-ok: unknown default login → tagged-only
    }
    const out: Candidate[] = [];
    for (const s of this.cfg.listRunningSessions()) {
      const eff = s.accountId ?? defaultAcctId;
      if (!eff) continue;
      const acct = byId.get(eff);
      if (!acct) continue;
      if (!accountAtPressure(acct, minPct)) continue;
      const startedMs = s.startedAt ? Date.parse(s.startedAt) : NaN;
      out.push({
        sessionName: s.sessionName,
        accountId: eff,
        startedMs: Number.isFinite(startedMs) ? startedMs : 0,
        untagged: s.accountId === null,
      });
    }
    return out;
  }
}
