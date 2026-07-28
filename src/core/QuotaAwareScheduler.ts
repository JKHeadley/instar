/**
 * QuotaAwareScheduler — P1.3 of the Subscription & Auth Standard.
 *
 * Picks the optimal subscription account for a session and guarantees a
 * long-lived session never dies on a quota limit: it swaps proactively before
 * the wall, or resumes on another account reactively after hitting it.
 *
 * ── The hard continuity guarantee (Justin's decision 2) ──
 * A long-lived session that hits its account's quota MUST resume on a DIFFERENT
 * account and continue the SAME conversation — never die. This reuses existing
 * machinery: `claude --resume <uuid>` is AGNOSTIC to CLAUDE_CONFIG_DIR, so
 * resuming under a different account just works. The swap path drives
 * SessionRefresh (kill → respawn-with-resume) pointed at the new account's
 * config home; TopicResumeMap preserves the conversation UUID across the swap.
 *
 * ── Selection policy: reset-date-optimal "use-before-reset" draining ──
 * Among eligible accounts, prefer the one with the most unused headroom whose
 * window resets SOONEST — drain each account maximally before its quota resets
 * (unused quota that resets is wasted), rather than spreading evenly.
 *
 * This file is the PURE selection core + the swap-decision logic. Both are
 * hermetically testable (no session lifecycle, no network). The orchestration
 * that actually restarts a session is injected (`refreshFn`) so tests stay pure.
 */

import type {
  SubscriptionAccount,
  AccountQuotaSnapshot,
  SubscriptionFramework,
} from './SubscriptionPool.js';
import { isLocallyExecutable, requiresOwnerRelogin } from './SubscriptionPool.js';

/** The binding window for swap decisions: the 7-day window is the scarce one. */
export interface SelectionOptions {
  /** Soft threshold (binding-window utilization %) above which an account is
   *  considered "at pressure" and excluded from proactive selection. Default 90. */
  softThresholdPct?: number;
  /** ISO 'now' for deterministic urgency scoring (tests pass a fixed clock). */
  nowMs?: number;
  /** Restrict placement/headroom to accounts usable by this session framework. */
  framework?: SubscriptionFramework;
}

const DEFAULT_SOFT_THRESHOLD = 90;

/**
 * Most-constrained-window utilization: the MAX across the account's known
 * windows (5-hour AND weekly). Taking the max means EITHER window crossing the
 * threshold counts as pressure — the 5-hour limit blocks you independently of
 * the weekly (you can be locked out for hours with plenty of weekly headroom
 * left), so the binding constraint is whichever window is the most used. 0 when
 * there is no reading yet (unknown = treated as empty / still selectable —
 * deliberate FOR REACTIVE RESCUE; catastrophic as a proactive optimization
 * input, which is why the anti-thrash validity gate exists on top:
 * swap-continuity-antithrash §3.3 bound 0).
 */
export function bindingUtilization(snap: AccountQuotaSnapshot | null | undefined): number {
  if (!snap) return 0;
  const utils: number[] = [];
  if (snap.sevenDay) utils.push(snap.sevenDay.utilizationPct);
  if (snap.fiveHour) utils.push(snap.fiveHour.utilizationPct);
  return utils.length ? Math.max(...utils) : 0;
}

/** Soonest reset across the account's known windows (ms epoch), or +Infinity. */
function soonestResetMs(snap: AccountQuotaSnapshot | null | undefined): number {
  if (!snap) return Number.POSITIVE_INFINITY;
  const candidates: number[] = [];
  for (const w of [snap.sevenDay, snap.fiveHour]) {
    if (w?.resetsAt) {
      const t = Date.parse(w.resetsAt);
      if (Number.isFinite(t)) candidates.push(t);
    }
  }
  return candidates.length ? Math.min(...candidates) : Number.POSITIVE_INFINITY;
}

/**
 * "Use-before-reset" score: more unused headroom AND a sooner reset → higher.
 * unusedHeadroom = 100 - bindingUtilization (0..100).
 * urgency = 1 / hoursUntilReset (sooner reset = more urgent to drain), clamped.
 * An account with no quota data yet (unknown) scores on headroom alone (treated
 * as empty / far reset) so a freshly-enrolled account is still selectable.
 */
export function scoreAccount(a: SubscriptionAccount, nowMs: number): number {
  const util = bindingUtilization(a.lastQuota);
  const unusedHeadroom = Math.max(0, 100 - util);
  const resetMs = soonestResetMs(a.lastQuota);
  let urgency = 0.0001; // far/unknown reset → low urgency, headroom dominates
  if (Number.isFinite(resetMs)) {
    const hours = Math.max(0.25, (resetMs - nowMs) / 3_600_000);
    urgency = 1 / hours;
  }
  return unusedHeadroom * urgency;
}

/**
 * Select the optimal account for a (new or swapped) session. Returns null when
 * no eligible account exists. `excludeId` lets a reactive swap avoid re-picking
 * the account that just hit its limit.
 */
export function selectAccount(
  accounts: SubscriptionAccount[],
  opts: SelectionOptions = {},
  excludeId?: string,
): SubscriptionAccount | null {
  const soft = opts.softThresholdPct ?? DEFAULT_SOFT_THRESHOLD;
  const nowMs = opts.nowMs ?? Date.parse('2026-01-01T00:00:00Z'); // tests pass nowMs; prod callers always set it
  const eligible = accounts.filter(
    (a) =>
      isLocallyExecutable(a) &&
      (opts.framework === undefined || a.framework === opts.framework) &&
      a.id !== excludeId &&
      bindingUtilization(a.lastQuota) < soft,
  );
  if (eligible.length === 0) return null;
  return eligible
    .map((a) => ({ a, s: scoreAccount(a, nowMs) }))
    .sort((x, y) => y.s - x.s)[0].a;
}

/**
 * Pool-headroom summary for the QUOTA THROTTLE (`QuotaTracker` provider). This is
 * DISTINCT from `selectAccount`, which picks WHERE to place a session for
 * use-it-or-lose-it (it favors the soonest-to-reset account, which may be highly
 * used). The throttle asks a different question — "is there capacity for this work
 * ANYWHERE in the pool?" — so it must gate on the MOST-HEADROOM eligible account,
 * not the drain-first winner. (Live proof against the real pool, 2026-06-16: with a
 * fresh 0% reserve alongside an 85% drain-first account, gating on the drain-first
 * account wrongly shed all non-critical work — overriding codex round-2 minor #2's
 * "accepted as marginal" with real evidence that it materially under-delivered.)
 *
 * Crucially it shares the EXACT eligibility predicate `selectAccount` uses
 * (`isLocallyExecutable` + binding utilization below the soft threshold), so
 * `placeable` here ⟺ `selectAccount(...) !== null` — the never-loop invariant
 * holds (the throttle never allows when placement can place nothing). A
 * credential-less meta account (WS5.2 §6.2) is excluded from BOTH by the shared
 * predicate, so the invariant is preserved. Percentages
 * are clamped to [0,100]; `degraded:true` when the best account has no trustworthy
 * live reading, so the throttle applies its bounded degraded cap instead of a
 * phantom "0% fresh".
 */
export function poolHeadroom(
  accounts: SubscriptionAccount[],
  opts: SelectionOptions = {},
): { placeable: boolean; weeklyPercent: number | null; fiveHourPercent: number | null; degraded: boolean } {
  const soft = opts.softThresholdPct ?? DEFAULT_SOFT_THRESHOLD;
  const eligible = accounts.filter(
    (a) =>
      isLocallyExecutable(a) &&
      (opts.framework === undefined || a.framework === opts.framework) &&
      bindingUtilization(a.lastQuota) < soft,
  );
  if (eligible.length === 0) {
    return { placeable: false, weeklyPercent: null, fiveHourPercent: null, degraded: false };
  }
  let best = eligible[0];
  for (const a of eligible) {
    if (bindingUtilization(a.lastQuota) < bindingUtilization(best.lastQuota)) best = a;
  }
  const clamp = (v: number | undefined): number | null =>
    typeof v === 'number' && isFinite(v) ? Math.max(0, Math.min(100, v)) : null;
  const weeklyPercent = clamp(best.lastQuota?.sevenDay?.utilizationPct);
  const fiveHourPercent = clamp(best.lastQuota?.fiveHour?.utilizationPct);
  const degraded = weeklyPercent === null && fiveHourPercent === null;
  return { placeable: true, weeklyPercent, fiveHourPercent, degraded };
}

/** Is this account at/over the soft pressure threshold on its binding window? */
export function accountAtPressure(
  a: SubscriptionAccount,
  softThresholdPct = DEFAULT_SOFT_THRESHOLD,
): boolean {
  return bindingUtilization(a.lastQuota) >= softThresholdPct;
}

// ── Swap orchestration ────────────────────────────────────────────

/** Injected session-restart-with-resume (wraps SessionRefresh in prod).
 *  Returning a bare boolean is back-compat; the object form additionally
 *  surfaces the structured refusal code (rate_limited / session-busy / …) so
 *  the anti-thrash observation layer can classify failures (§3.1 trigger 2). */
export type RefreshFn = (opts: {
  sessionName: string;
  reason: string;
  /** The config home of the account to resume under (CLAUDE_CONFIG_DIR). */
  configHome: string;
  /** The account id to record on the resumed session. */
  accountId: string;
  /** Work-gate caller class (swap-continuity-antithrash §4.2) — server-internal only (I11). */
  callerClass?: 'proactive-swap' | 'reactive-swap';
}) => Promise<boolean | { ok: boolean; code?: string }>;

export interface SwapResult {
  swapped: boolean;
  /** The account swapped TO (null when no eligible alternate existed). */
  toAccountId: string | null;
  reason: string;
}

/**
 * Anti-thrash hooks (swap-continuity-antithrash): observation of the REACTIVE
 * path (I6 — never gates it) + the execute-time revalidation inputs for the
 * PROACTIVE explicit-target funnel (§3.3). All optional — absent = today's
 * behavior byte-for-byte.
 */
export interface QuotaSwapAntiThrashHooks {
  /** Bound-0 validity check (reading PRESENT + FRESH) — §3.3. */
  readingValid: (acct: SubscriptionAccount, nowMs: number) => boolean;
  /** Live knobs for the revalidation arithmetic. */
  getKnobs: () => { thresholdPct: number; targetHeadroomPct: number; minImprovementPct: number };
  /** The session's CURRENT account id (source-identity check, R3-m3). */
  resolveEffectiveAccountId: (
    sessionName: string,
    sourceWasUntagged: boolean,
    sourceTrigger?: 'quota-pressure' | 'login-loss',
  ) => Promise<string | null>;
  /** Observe an executed REACTIVE swap (dwell clock-start, hop alerts). */
  onReactiveExecuted?: (args: { session: string; from: string; to: string; nowMs: number }) => void;
  /** Observe a reactive execution failure (§3.6 `failed` rows, kind 'reactive'). */
  onReactiveFailed?: (args: { session: string; from: string; to?: string; errorClass: string; nowMs: number }) => void;
  /** Observe a rate-cap refusal of a REACTIVE swap — the stranded state (§3.1 trigger 2). */
  onReactiveRateCapRefusal?: (session: string, nowMs: number) => void;
}

export interface QuotaAwareSchedulerConfig {
  /** Returns the current pool accounts (e.g. () => pool.list()). */
  listAccounts: () => SubscriptionAccount[];
  /** Restarts a session resumed under a given account (wraps SessionRefresh). */
  refreshFn: RefreshFn;
  /** Raised (deduped) when a session is at a wall with NO eligible alternate. */
  onNoAlternate?: (sessionName: string, exhaustedAccountId: string) => void;
  softThresholdPct?: number;
  /** Anti-thrash observation + revalidation hooks (optional, additive). */
  antiThrash?: QuotaSwapAntiThrashHooks;
  logger?: { log: (m: string) => void; warn: (m: string) => void };
}

export class QuotaAwareScheduler {
  private readonly cfg: QuotaAwareSchedulerConfig;
  constructor(cfg: QuotaAwareSchedulerConfig) {
    this.cfg = cfg;
  }

  /** Pick the best account for a NEW session (proactive placement). */
  placeNewSession(nowMs: number, framework?: SubscriptionFramework): SubscriptionAccount | null {
    return selectAccount(this.cfg.listAccounts(), {
      softThresholdPct: this.cfg.softThresholdPct,
      nowMs,
      framework,
    });
  }

  /**
   * THE GUARANTEE. A session running under `exhaustedAccountId` has hit (or is
   * about to hit) its quota. Pick another eligible account and resume the
   * session under it — never leave it dead. If no alternate exists, signal
   * onNoAlternate (the caller raises one deduped Attention item) and leave the
   * existing rate-limit back-off as the floor.
   */
  async onQuotaPressure(args: {
    sessionName: string;
    exhaustedAccountId: string;
    nowMs: number;
    /**
     * The funnel contract (swap-continuity-antithrash §3.3): an explicit
     * `targetAccountId` means "the caller already ran the brake pipeline;
     * REVALIDATE, never re-select". NO target means "reactive semantics:
     * today's 90-threshold re-selection, drain-first scoring" — a future
     * proactive-class caller that omits the target gets reactive semantics,
     * never a silent brake bypass.
     */
    targetAccountId?: string;
    callerClass?: 'proactive-swap' | 'reactive-swap';
    /** Framework of the session being moved. Falls back to the exhausted account. */
    framework?: SubscriptionFramework;
    /** True when the evaluated source came from the default-login resolver. */
    sourceWasUntagged?: boolean;
    /** Level-triggered source condition. Login loss is revalidated at the same
     * kill boundary as the untagged default-account identity. */
    sourceTrigger?: 'quota-pressure' | 'login-loss';
  }): Promise<SwapResult> {
    const { sessionName, exhaustedAccountId, nowMs, targetAccountId } = args;
    const isProactive = targetAccountId !== undefined;
    const callerClass = args.callerClass ?? (isProactive ? 'proactive-swap' : 'reactive-swap');
    const accounts = this.cfg.listAccounts();
    const sourceAccount = accounts.find((a) => a.id === exhaustedAccountId);
    const framework = args.framework ?? sourceAccount?.framework;
    if (framework === undefined) {
      this.cfg.logger?.warn(
        `[QuotaAwareScheduler] ${sessionName}: source framework unknown for ${exhaustedAccountId} — refusing account selection`,
      );
      return { swapped: false, toAccountId: null, reason: 'source-framework-unknown' };
    }

    let next: SubscriptionAccount | null;
    if (isProactive) {
      // ── Execute-time revalidation (§3.3, R4-m4) — refuse, never re-select ──
      const at = this.cfg.antiThrash;
      next = accounts.find((a) => a.id === targetAccountId) ?? null;
      if (!next) {
        return { swapped: false, toAccountId: targetAccountId!, reason: 'target-revalidation-failed' };
      }
      if (framework !== undefined && next.framework !== framework) {
        return { swapped: false, toAccountId: next.id, reason: 'target-framework-mismatch' };
      }
      if (at) {
        const k = at.getKnobs();
        const ceiling = k.thresholdPct - k.targetHeadroomPct;
        // 1. Target validity + ceiling (bound 0 + bound 1) on a fresh snapshot.
        if (!at.readingValid(next, nowMs) || bindingUtilization(next.lastQuota) >= ceiling) {
          return { swapped: false, toAccountId: next.id, reason: 'target-revalidation-failed' };
        }
        // 2. Source identity (R3-m3): a reactive swap that completed in the
        // sub-tick window invalidates the intent — never a second kill.
        const current = await at.resolveEffectiveAccountId(
          sessionName,
          args.sourceWasUntagged === true,
          args.sourceTrigger,
        );
        if ((args.sourceWasUntagged === true && current !== exhaustedAccountId) ||
            (args.sourceWasUntagged !== true && current !== null && current !== exhaustedAccountId)) {
          return { swapped: false, toAccountId: next.id, reason: 'intent-stale' };
        }
        // 3. Source condition, fresh: either quota pressure still exists, or
        // the exact owner-relogin-required episode still exists. A repaired
        // login makes the intent stale before the session is killed.
        const source = accounts.find((a) => a.id === exhaustedAccountId);
        if (args.sourceTrigger === 'login-loss') {
          if (!source || !requiresOwnerRelogin(source)) {
            return { swapped: false, toAccountId: next.id, reason: 'intent-stale' };
          }
        } else {
          if (!source || !isLocallyExecutable(source) || !at.readingValid(source, nowMs) || bindingUtilization(source.lastQuota) < k.thresholdPct) {
            return { swapped: false, toAccountId: next.id, reason: 'intent-stale' };
          }
          // 4. Improvement delta, fresh (bound 2 at the actual kill point).
          if (bindingUtilization(source.lastQuota) - bindingUtilization(next.lastQuota) < k.minImprovementPct) {
            return { swapped: false, toAccountId: next.id, reason: 'target-revalidation-failed' };
          }
        }
      }
    } else {
      // ── Reactive semantics — byte-identical to v1.3.722 (I6) ──
      next = selectAccount(
        accounts,
        { softThresholdPct: this.cfg.softThresholdPct, nowMs, framework },
        exhaustedAccountId,
      );
      if (!next) {
        this.cfg.onNoAlternate?.(sessionName, exhaustedAccountId);
        this.cfg.logger?.warn(
          `[QuotaAwareScheduler] ${sessionName}: account ${exhaustedAccountId} at limit, NO eligible alternate — left to existing back-off`,
        );
        return { swapped: false, toAccountId: null, reason: 'no-eligible-alternate' };
      }
    }

    let refreshOutcome: boolean | { ok: boolean; code?: string };
    try {
      refreshOutcome = await this.cfg.refreshFn({
        sessionName,
        reason: `${args.sourceTrigger === 'login-loss' ? 'login-loss-swap' : 'quota-swap'}: ${exhaustedAccountId} → ${next.id}`,
        configHome: next.configHome,
        accountId: next.id,
        callerClass,
      });
    } catch (err) {
      // §3.1/§3.6 fix-alongside: reactive execution failures were previously a
      // silent discarded promise — now observed (failed rows, kind 'reactive')
      // before the error propagates exactly as before.
      if (!isProactive) {
        this.cfg.antiThrash?.onReactiveFailed?.({
          session: sessionName,
          from: exhaustedAccountId,
          to: next.id,
          errorClass: err instanceof Error ? err.constructor.name : 'Error',
          nowMs,
        });
      }
      throw err;
    }
    const ok = typeof refreshOutcome === 'boolean' ? refreshOutcome : refreshOutcome.ok;
    const code = typeof refreshOutcome === 'boolean' ? undefined : refreshOutcome.code;
    if (!ok) {
      this.cfg.logger?.warn(
        `[QuotaAwareScheduler] ${sessionName}: swap to ${next.id} — refresh reported failure${code ? ` (${code})` : ''}`,
      );
      if (!isProactive) {
        if (code === 'rate_limited') {
          // The one state where a session is stranded on a walled account with
          // no further mechanical rescue this window (§3.1 trigger 2).
          this.cfg.antiThrash?.onReactiveRateCapRefusal?.(sessionName, nowMs);
        }
        this.cfg.antiThrash?.onReactiveFailed?.({
          session: sessionName,
          from: exhaustedAccountId,
          to: next.id,
          errorClass: code ?? 'refresh-failed',
          nowMs,
        });
      }
      return { swapped: false, toAccountId: next.id, reason: code ?? 'refresh-failed' };
    }
    this.cfg.logger?.log(
      `[QuotaAwareScheduler] ${sessionName}: resumed on ${next.id} (was ${exhaustedAccountId}) — conversation preserved via --resume`,
    );
    if (!isProactive) {
      this.cfg.antiThrash?.onReactiveExecuted?.({
        session: sessionName,
        from: exhaustedAccountId,
        to: next.id,
        nowMs,
      });
    }
    return { swapped: true, toAccountId: next.id, reason: 'swapped-and-resumed' };
  }
}
