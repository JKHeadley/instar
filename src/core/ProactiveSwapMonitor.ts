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
 * ── Why a separate, lower threshold (lag-aware) ──
 * The QuotaPoller reads utilization periodically, so our reading TRAILS the real
 * usage (measured live: our ~90% == Anthropic's ~95% on the same account). A
 * pre-emptive swap therefore triggers at a LOWER measured threshold (default 80)
 * to leave margin for the lag — by the time we read 80%, real is higher, and the
 * swap completes before the wall.
 *
 * ── Effective-account resolution (covers the session you actually use) ──
 * A session carries `subscriptionAccountId` only if it was pinned at spawn. The
 * primary interactive session usually runs on the DEFAULT config (untagged), so
 * the monitor resolves an untagged session's effective account from the default
 * config's live login (InUseAccountResolver). Without this, the session a user
 * is actively in would be invisible to the swap engine and wedge at the wall.
 *
 * ── Bounded, non-storming ──
 * Per evaluation: only accounts AT pressure that have a sub-threshold ALTERNATE
 * are sources; candidates are sorted newest-first (the just-(re)started
 * interactive session ranks first) and capped per cycle; each swapped session
 * enters a cooldown so a slow restart isn't double-swapped. Near the wall the
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
}

export interface ProactiveSwapMonitorConfig {
  /** Current pool accounts (e.g. () => pool.list()). */
  listAccounts: () => SubscriptionAccount[];
  /** Currently-running, swap-eligible (claude-code) sessions. */
  listRunningSessions: () => ProactiveSwapSession[];
  /** The pool account the DEFAULT config is logged into right now (or null).
   *  Untagged sessions run here; from InUseAccountResolver in production. */
  resolveDefaultAccountId: () => Promise<string | null>;
  /** Performs the actual swap (wraps QuotaAwareScheduler.onQuotaPressure). */
  swap: (args: {
    sessionName: string;
    exhaustedAccountId: string;
    nowMs: number;
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
   *  Default 600000 (10m) — must exceed the swap+restart time. */
  cooldownMs?: number;
  /** Monitor tick cadence. Default 180000 (3m). */
  tickMs?: number;
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
  /** Last successful-swap timestamp per session (cooldown bookkeeping). */
  private readonly lastSwapAt = new Map<string, number>();
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

  /** Status for the read route (never throws). */
  status(): {
    thresholdPct: number;
    watchPct: number;
    maxSwapsPerCycle: number;
    cooldownMs: number;
    tickMs: number;
    running: boolean;
    lastResult: ProactiveSwapTickResult | null;
  } {
    return {
      thresholdPct: this.thresholdPct,
      watchPct: Math.max(0, this.thresholdPct - this.watchMarginPct),
      maxSwapsPerCycle: this.maxSwapsPerCycle,
      cooldownMs: this.cooldownMs,
      tickMs: this.tickMs,
      running: this.timer !== null,
      lastResult: this.lastResult,
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
   */
  async evaluate(): Promise<{ swapped: string[]; considered: number }> {
    const nowMs = this.now();
    const accounts = this.cfg.listAccounts();
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

    // TODO(follow-up, 2026-06-09 incident): a proactive cycle moving MANY
    // sessions at once is itself disruptive — every swap is a kill+respawn
    // ("Session respawned" + interruption) even when it succeeds. Beyond the
    // per-cycle cap + cooldown, consider gating on session ACTIVITY: only
    // swap sessions that are actually burning quota (recent pane activity),
    // and let idle sessions wall reactively instead of being preemptively
    // interrupted in bulk.
    const toSwap = eligible.slice(0, this.maxSwapsPerCycle);
    const swapped: string[] = [];
    for (const c of toSwap) {
      let outcome: ProactiveSwapOutcome;
      try {
        outcome = await this.cfg.swap({
          sessionName: c.sessionName,
          exhaustedAccountId: c.accountId,
          nowMs,
        });
      } catch {
        // @silent-fallback-ok: a swap failure is retried next cycle (no cooldown set)
        continue;
      }
      if (outcome.swapped) {
        this.lastSwapAt.set(c.sessionName, nowMs);
        swapped.push(c.sessionName);
        this.logger.log(
          `[ProactiveSwap] ${c.sessionName}: pre-emptively swapped off ${c.accountId} → ${outcome.toAccountId} ` +
            `(account ≥${this.thresholdPct}% measured — moved before the wall, conversation preserved)`,
        );
      }
    }
    return { swapped, considered: eligible.length };
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
      });
    }
    return out;
  }
}
