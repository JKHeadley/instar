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
} from './SubscriptionPool.js';

/** The binding window for swap decisions: the 7-day window is the scarce one. */
export interface SelectionOptions {
  /** Soft threshold (binding-window utilization %) above which an account is
   *  considered "at pressure" and excluded from proactive selection. Default 90. */
  softThresholdPct?: number;
  /** ISO 'now' for deterministic urgency scoring (tests pass a fixed clock). */
  nowMs?: number;
}

const DEFAULT_SOFT_THRESHOLD = 90;

/** An account is selectable only in these statuses. */
function isEligibleStatus(a: SubscriptionAccount): boolean {
  return a.status === 'active' || a.status === 'warming';
}

/** Binding-window utilization (7-day); falls back to 5-hour, else 0 (unknown = empty). */
function bindingUtilization(snap: AccountQuotaSnapshot | null | undefined): number {
  if (!snap) return 0;
  if (snap.sevenDay) return snap.sevenDay.utilizationPct;
  if (snap.fiveHour) return snap.fiveHour.utilizationPct;
  return 0;
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
      isEligibleStatus(a) &&
      a.id !== excludeId &&
      bindingUtilization(a.lastQuota) < soft,
  );
  if (eligible.length === 0) return null;
  return eligible
    .map((a) => ({ a, s: scoreAccount(a, nowMs) }))
    .sort((x, y) => y.s - x.s)[0].a;
}

/** Is this account at/over the soft pressure threshold on its binding window? */
export function accountAtPressure(
  a: SubscriptionAccount,
  softThresholdPct = DEFAULT_SOFT_THRESHOLD,
): boolean {
  return bindingUtilization(a.lastQuota) >= softThresholdPct;
}

// ── Swap orchestration ────────────────────────────────────────────

/** Injected session-restart-with-resume (wraps SessionRefresh in prod). */
export type RefreshFn = (opts: {
  sessionName: string;
  reason: string;
  /** The config home of the account to resume under (CLAUDE_CONFIG_DIR). */
  configHome: string;
  /** The account id to record on the resumed session. */
  accountId: string;
}) => Promise<boolean>;

export interface SwapResult {
  swapped: boolean;
  /** The account swapped TO (null when no eligible alternate existed). */
  toAccountId: string | null;
  reason: string;
}

export interface QuotaAwareSchedulerConfig {
  /** Returns the current pool accounts (e.g. () => pool.list()). */
  listAccounts: () => SubscriptionAccount[];
  /** Restarts a session resumed under a given account (wraps SessionRefresh). */
  refreshFn: RefreshFn;
  /** Raised (deduped) when a session is at a wall with NO eligible alternate. */
  onNoAlternate?: (sessionName: string, exhaustedAccountId: string) => void;
  softThresholdPct?: number;
  logger?: { log: (m: string) => void; warn: (m: string) => void };
}

export class QuotaAwareScheduler {
  private readonly cfg: QuotaAwareSchedulerConfig;
  constructor(cfg: QuotaAwareSchedulerConfig) {
    this.cfg = cfg;
  }

  /** Pick the best account for a NEW session (proactive placement). */
  placeNewSession(nowMs: number): SubscriptionAccount | null {
    return selectAccount(this.cfg.listAccounts(), {
      softThresholdPct: this.cfg.softThresholdPct,
      nowMs,
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
  }): Promise<SwapResult> {
    const { sessionName, exhaustedAccountId, nowMs } = args;
    const next = selectAccount(
      this.cfg.listAccounts(),
      { softThresholdPct: this.cfg.softThresholdPct, nowMs },
      exhaustedAccountId,
    );
    if (!next) {
      this.cfg.onNoAlternate?.(sessionName, exhaustedAccountId);
      this.cfg.logger?.warn(
        `[QuotaAwareScheduler] ${sessionName}: account ${exhaustedAccountId} at limit, NO eligible alternate — left to existing back-off`,
      );
      return { swapped: false, toAccountId: null, reason: 'no-eligible-alternate' };
    }
    const ok = await this.cfg.refreshFn({
      sessionName,
      reason: `quota-swap: ${exhaustedAccountId} → ${next.id}`,
      configHome: next.configHome,
      accountId: next.id,
    });
    if (!ok) {
      this.cfg.logger?.warn(
        `[QuotaAwareScheduler] ${sessionName}: swap to ${next.id} — refresh reported failure`,
      );
      return { swapped: false, toAccountId: next.id, reason: 'refresh-failed' };
    }
    this.cfg.logger?.log(
      `[QuotaAwareScheduler] ${sessionName}: resumed on ${next.id} (was ${exhaustedAccountId}) — conversation preserved via --resume`,
    );
    return { swapped: true, toAccountId: next.id, reason: 'swapped-and-resumed' };
  }
}
