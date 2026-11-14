/**
 * UsageWallRescue — a session that hits its account's usage wall moves to an
 * account with room and keeps going (docs/specs/usage-wall-rescue.md).
 *
 * Before this, gaps lined up to leave a walled session sitting silently for
 * hours (2026-11-04, feedback fb-6e43a66a-75d):
 *   1. Nothing turned a usage wall into a swap. The watchdog only reported
 *      server throttles; a wall was deliberately classed "not a throttle".
 *   2. The only reactive swap path skipped every session with no account tag,
 *      and with pinning off (the default) every session was untagged.
 *   3. A new session could launch on a default login the pool already knew was
 *      out of quota.
 *
 * This module owns the decisions; the move itself stays in the existing
 * QuotaAwareScheduler.onQuotaPressure (reactive semantics: an eligible
 * same-framework account under the soft threshold, resume via --resume).
 *
 * ONE switch, `subscriptionPool.wallRescue.enabled` (default true,
 * operator-approved 2026-11-04), EFFECTIVE only while the pool holds 2+ usable
 * accounts of the session's framework. An operator's explicit
 * `autoSwapOnRateLimit: false` (a prior "do not auto-move my sessions") is
 * honored as off; an explicit `pinSessionsToPool: false` limits spawn tagging
 * to the walled-default guard.
 *
 * Signal vs authority: the watchdog's 'usage-wall' event is a signal; before
 * any move it is corroborated against the account's own quota reading, and the
 * authority to move is the existing swap engine, reached through this one
 * funnel with dedupe, doubling back-off, a per-session breaker on failed moves
 * and a per-machine hourly cap.
 *
 * @self-action-controller: usage-wall-rescue
 */

import type { SubscriptionAccount, SubscriptionFramework } from './SubscriptionPool.js';
import { isLocallyExecutable } from './SubscriptionPool.js';
import { bindingUtilization, selectAccount, type SwapResult } from './QuotaAwareScheduler.js';

/** The part of `config.subscriptionPool` this module reads (read LIVE). */
export interface WallRescueConfigView {
  wallRescue?: { enabled?: boolean };
  autoSwapOnRateLimit?: boolean;
  pinSessionsToPool?: boolean;
  swapSoftThresholdPct?: number;
}

const DEFAULT_SOFT_THRESHOLD = 90;

/** Accounts a session of `framework` could actually run on, here, now. */
export function usableAccounts(
  accounts: SubscriptionAccount[],
  framework: SubscriptionFramework,
): SubscriptionAccount[] {
  return accounts.filter((a) => a.framework === framework && isLocallyExecutable(a));
}

/** Why the rescue is off, or null when the switch is on. */
export function wallRescueSwitchOffReason(cfg: WallRescueConfigView | undefined): 'wallRescue.enabled' | 'autoSwapOnRateLimit' | null {
  if (cfg?.wallRescue?.enabled === false) return 'wallRescue.enabled';
  if (cfg?.autoSwapOnRateLimit === false) return 'autoSwapOnRateLimit';
  return null;
}

/** The single switch, before the pool-size condition. Missing = on (the default). */
export function wallRescueSwitchOn(cfg: WallRescueConfigView | undefined): boolean {
  return wallRescueSwitchOffReason(cfg) === null;
}

/** Is the rescue effective for this framework right now (switch on AND 2+ usable accounts)? */
export function wallRescueEffective(
  cfg: WallRescueConfigView | undefined,
  accounts: SubscriptionAccount[],
  framework: SubscriptionFramework = 'claude-code',
): boolean {
  return wallRescueSwitchOn(cfg) && usableAccounts(accounts, framework).length >= 2;
}

export type WallRescueOutcome =
  | 'disabled'           // switch off, fewer than 2 usable accounts, or an untagged non-claude session
  | 'in-flight'          // a rescue for this session is already running
  | 'cooling-down'       // tried recently; back off (doubling per failed move) before trying again
  | 'breaker-open'       // 5 failed moves in a row for this session; held for a day
  | 'rate-capped'        // the per-machine hourly cap on moves is reached
  | 'unknown-session'    // no running session by that name
  | 'unresolved-account' // could not tell which account the session is on — hold, never guess
  | 'source-not-walled'  // the account's own fresh reading says it has room — the banner is not corroborated
  | 'resets-soon'        // the walled window resets within minutes; a restart would cost more than the wait
  | 'swapped'            // moved to an account with room
  | 'no-room'            // no account has room — the user is told plainly
  | 'failed';            // a move was attempted and refused/failed

export interface UsageWallRescueDeps {
  /** Live config read (so the switch applies without a restart). */
  readConfig: () => WallRescueConfigView | undefined;
  listAccounts: () => SubscriptionAccount[];
  /** The running session's record (tag + framework). */
  getSession: (sessionName: string) => { subscriptionAccountId?: string | null; framework?: string } | undefined;
  /** The session's EXPLICIT CLAUDE_CONFIG_DIR, or undefined when it rides the default login. */
  configHomeForSession: (sessionName: string) => string | undefined;
  /** Which pool account the default login currently holds (InUseAccountResolver). */
  resolveDefaultAccountId: () => Promise<string | null>;
  /** The existing reactive swap (QuotaAwareScheduler.onQuotaPressure). */
  swap: (args: {
    sessionName: string;
    exhaustedAccountId: string;
    nowMs: number;
    framework: SubscriptionFramework;
    callerClass: 'reactive-swap';
    sourceWasUntagged?: boolean;
  }) => Promise<SwapResult>;
  /**
   * Tell the people in this session's conversation something plain. Used only
   * when the session cannot be moved: no account has room, or automatic moves
   * kept failing. Best-effort; absent → silent (the standby still reports).
   */
  notifyUser?: (sessionName: string, text: string) => boolean | Promise<boolean>;
  /** Ask the quota poller for a fresh reading (on a wall the reading contradicts). */
  requestQuotaRefresh?: () => void;
  now?: () => number;
  /** Base back-off after an attempt for the same session. Default 10 minutes. */
  retryAfterMs?: number;
  /** Back-off ceiling. Default 2 hours. */
  maxBackoffMs?: number;
  /** Consecutive FAILED moves for one session before its breaker opens. Default 5. */
  breakerThreshold?: number;
  /** How long an open breaker holds before one more attempt. Default 24 hours. */
  breakerHoldMs?: number;
  /** Most move attempts per rolling hour on this machine. Default 12. */
  maxMovesPerHour?: number;
  /** Do not move when the walled window resets within this. Default 15 minutes. */
  resetsSoonMs?: number;
  /** A reading older than this does not count as fresh. Default 60 minutes. */
  freshReadingMs?: number;
  /** How long an observed wall marks an account walled for the spawn guard. Default 30 minutes. */
  wallMemoryMs?: number;
  logger?: { log: (m: string) => void; warn: (m: string) => void };
}

const DEFAULT_RETRY_AFTER_MS = 10 * 60_000;
const DEFAULT_MAX_BACKOFF_MS = 2 * 60 * 60_000;
const DEFAULT_BREAKER_THRESHOLD = 5;
const DEFAULT_BREAKER_HOLD_MS = 24 * 60 * 60_000;
const DEFAULT_MAX_MOVES_PER_HOUR = 12;
const DEFAULT_RESETS_SOON_MS = 15 * 60_000;
const DEFAULT_FRESH_READING_MS = 60 * 60_000;
const DEFAULT_WALL_MEMORY_MS = 30 * 60_000;
const NOTICE_REPEAT_MS = 6 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
const PRUNE_AFTER_MS = 2 * DEFAULT_BREAKER_HOLD_MS;

/** The rescue's brakes, as numbers (the defaults ship as WALL_RESCUE_LIMITS). */
export interface RescueGateLimits {
  baseMs: number;
  maxBackoffMs: number;
  breakerThreshold: number;
  breakerHoldMs: number;
  maxMovesPerHour: number;
}

export const WALL_RESCUE_LIMITS: RescueGateLimits = {
  baseMs: DEFAULT_RETRY_AFTER_MS,
  maxBackoffMs: DEFAULT_MAX_BACKOFF_MS,
  breakerThreshold: DEFAULT_BREAKER_THRESHOLD,
  breakerHoldMs: DEFAULT_BREAKER_HOLD_MS,
  maxMovesPerHour: DEFAULT_MAX_MOVES_PER_HOUR,
};

/**
 * The time gates, pure (the class's only gate, and the self-action ratchet's
 * subject). Failed MOVES drive the breaker and the doubling back-off; after the
 * hold the breaker is half-open (checks resume at the base interval and the
 * next failed move re-arms the full hold). Every check waits the base
 * interval. The per-machine hourly cap counts move attempts.
 */
export function decideRescueGate(input: {
  failedMoves: number;
  lastFailedAtMs: number | undefined;
  lastCheckAtMs: number | undefined;
  moveTimesMs: readonly number[];
  nowMs: number;
  limits: RescueGateLimits;
}): 'breaker-open' | 'cooling-down' | 'rate-capped' | null {
  const { failedMoves, lastFailedAtMs, lastCheckAtMs, moveTimesMs, nowMs, limits } = input;
  if (failedMoves > 0 && lastFailedAtMs !== undefined) {
    if (failedMoves >= limits.breakerThreshold) {
      if (nowMs - lastFailedAtMs < limits.breakerHoldMs) return 'breaker-open';
    } else {
      const backoff = Math.min(limits.baseMs * 2 ** (failedMoves - 1), limits.maxBackoffMs);
      if (nowMs - lastFailedAtMs < backoff) return 'cooling-down';
    }
  }
  if (lastCheckAtMs !== undefined && nowMs - lastCheckAtMs < limits.baseMs) return 'cooling-down';
  if (moveTimesMs.filter((t) => nowMs - t < HOUR_MS).length >= limits.maxMovesPerHour) return 'rate-capped';
  return null;
}

function asFramework(f: string | undefined): SubscriptionFramework {
  return (f ?? 'claude-code') as SubscriptionFramework;
}

/** describeWall result meaning "the conversation was already told; say nothing more". */
export const QUOTA_WALL_ALREADY_TOLD = false as const;

/** Plain user notices (no ids, no jargon). */
export const WALL_NOTICE_MOVING =
  'This conversation reached the usage limit on its subscription account. It is being moved to another account that has room and will carry on by itself in a moment. Nothing for you to do.';
export const WALL_NOTICE_NO_ROOM =
  'This conversation reached the usage limit on its subscription account, and no other connected account has enough room right now. It will carry on by itself when the limit resets.';
export const WALL_NOTICE_GAVE_UP =
  'This conversation reached the usage limit, and moving it to another account did not work after several tries. It will carry on by itself when the limit resets. I will look into why the move failed.';

export class UsageWallRescue {
  private readonly deps: UsageWallRescueDeps;
  private readonly inFlight = new Set<string>();
  private readonly lastAttemptAt = new Map<string, number>();
  /** session → when its last FAILED move happened (drives back-off and the breaker). */
  private readonly lastFailedAt = new Map<string, number>();
  /** session → consecutive moves that were attempted and failed. */
  private readonly consecutiveFailures = new Map<string, number>();
  /** Start times of move attempts in the last hour on this machine. */
  private readonly attemptTimes: number[] = [];
  /** accountId → when a wall was last SEEN (and corroborated) on a session under it. */
  private readonly observedWalls = new Map<string, number>();
  /** session → the last outcome of a real check (not a time-gate refusal). */
  private readonly lastOutcome = new Map<string, { outcome: WallRescueOutcome; at: number }>();
  /** sessions with a direct notice still being delivered. */
  private readonly noticePending = new Set<string>();
  /** session → when the user was last CONFIRMED told it cannot be moved. */
  private readonly lastNoticeAt = new Map<string, number>();
  /** Last resolved default-login account (refreshed async; read sync by the spawn guard). */
  private cachedDefaultAccountId: string | null = null;
  /** Last outcomes (bounded), for the status route. */
  private readonly recent: Array<{ sessionName: string; outcome: WallRescueOutcome; at: string }> = [];

  constructor(deps: UsageWallRescueDeps) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private soft(cfg: WallRescueConfigView | undefined): number {
    return cfg?.swapSoftThresholdPct ?? DEFAULT_SOFT_THRESHOLD;
  }

  private isFresh(a: SubscriptionAccount, nowMs: number): boolean {
    const t = Date.parse(a.lastQuota?.measuredAt ?? '');
    return Number.isFinite(t) && nowMs - t <= (this.deps.freshReadingMs ?? DEFAULT_FRESH_READING_MS);
  }

  /** Refresh the cached default-login account. Errors leave the old value. */
  async refreshDefaultAccount(): Promise<string | null> {
    try {
      this.cachedDefaultAccountId = await this.deps.resolveDefaultAccountId();
    } catch {
      // @silent-fallback-ok: unknown default keeps the last known value; the
      // spawn guard only acts on a POSITIVE walled reading, never on unknown.
    }
    return this.cachedDefaultAccountId;
  }

  /**
   * Which pool account a running session is on. Tag first; else an explicit
   * CLAUDE_CONFIG_DIR that matches a pool account; else the account the
   * default login holds NOW. That last source can differ from the account the
   * session launched on (the default slot can be repointed), which is why
   * every untagged move is corroborated against the account's own reading
   * before it runs (see attempt()). Null when nothing can be established.
   */
  async resolveSessionAccount(sessionName: string): Promise<{ accountId: string; untagged: boolean; via: 'tag' | 'home' | 'default' } | null> {
    const session = this.deps.getSession(sessionName);
    if (!session) return null;
    if (session.subscriptionAccountId) return { accountId: session.subscriptionAccountId, untagged: false, via: 'tag' };
    const framework = asFramework(session.framework);
    if (framework !== 'claude-code') return null; // only claude logins have a resolvable default slot
    const accounts = this.deps.listAccounts();
    const home = this.deps.configHomeForSession(sessionName);
    if (home) {
      // An explicit home that matches no pool account says nothing about the
      // default login — unresolved, never a fall-through guess.
      const byHome = accounts.find((a) => a.configHome === home && a.framework === framework);
      return byHome ? { accountId: byHome.id, untagged: true, via: 'home' } : null;
    }
    const def = await this.refreshDefaultAccount();
    if (def && accounts.some((a) => a.id === def)) return { accountId: def, untagged: true, via: 'default' };
    return null;
  }

  /** Sync twin of resolveSessionAccount for wording: the cached default, no refresh. */
  private resolveSessionAccountSync(sessionName: string): { accountId: string; via: 'tag' | 'home' | 'default' } | null {
    const session = this.deps.getSession(sessionName);
    if (!session) return null;
    if (session.subscriptionAccountId) return { accountId: session.subscriptionAccountId, via: 'tag' };
    if (asFramework(session.framework) !== 'claude-code') return null;
    const accounts = this.deps.listAccounts();
    const home = this.deps.configHomeForSession(sessionName);
    if (home) {
      const id = accounts.find((a) => a.configHome === home && a.framework === 'claude-code')?.id;
      return id ? { accountId: id, via: 'home' } : null;
    }
    const def = this.cachedDefaultAccountId;
    return def && accounts.some((a) => a.id === def) ? { accountId: def, via: 'default' } : null;
  }

  /**
   * The corroboration checks on the resolved source account, shared by the
   * move and by the wording so they can never disagree: a FRESH reading under
   * the threshold contradicts the wall; a fresh reading whose walled window
   * resets within the window (and in the future) means waiting beats a restart.
   * A stale or absent reading is unknown — the settled banner stands.
   */
  private corroborate(
    source: SubscriptionAccount | undefined,
    cfg: WallRescueConfigView | undefined,
    nowMs: number,
    identityProven: boolean,
  ): 'source-not-walled' | 'resets-soon' | null {
    if (!source || !this.isFresh(source, nowMs)) return null;
    const soft = this.soft(cfg);
    // Only a PROVEN identity (tag or explicit home) can be contradicted by its
    // reading. For a default-slot candidate a healthy reading more likely means
    // the slot moved since the session launched; the banner is then the
    // evidence, and moving costs one restart onto an account with room (the
    // healthy candidate is merely excluded from the targets).
    if (bindingUtilization(source.lastQuota) < soft) return identityProven ? 'source-not-walled' : null;
    const resetAt = this.walledWindowResetMs(source, soft);
    if (resetAt !== null && resetAt > nowMs && resetAt - nowMs <= (this.deps.resetsSoonMs ?? DEFAULT_RESETS_SOON_MS)) {
      return 'resets-soon';
    }
    return null;
  }

  /**
   * A session settled at its usage wall. Move it to an account with room, or —
   * when no account has room — tell the people in the conversation plainly.
   * Never throws.
   */
  async onUsageWall(sessionName: string): Promise<WallRescueOutcome> {
    return this.finish(sessionName, await this.attempt(sessionName, 'usage-wall'), 'usage-wall');
  }

  /**
   * The watchdog saw this session's wall clear (the pane moved on). Ends the
   * wall episode: its last outcome no longer speaks for a later wall.
   */
  onWallCleared(sessionName: string): void {
    this.lastOutcome.delete(sessionName);
  }

  /**
   * Legacy opt-in (`autoSwapOnRateLimit: true`): a server-throttle escalation
   * also moves the session. Same funnel and brakes as the wall; no wall
   * corroboration, since a throttle is not the account's quota.
   */
  async onThrottleEscalated(sessionName: string): Promise<WallRescueOutcome> {
    return this.finish(sessionName, await this.attempt(sessionName, 'throttle'), 'throttle');
  }

  private finish(sessionName: string, outcome: WallRescueOutcome, trigger: 'usage-wall' | 'throttle'): WallRescueOutcome {
    const nowMs = this.now();
    // Only a real check of a WALL feeds the wall wording (a throttle outcome or
    // a time-gate refusal says nothing about this wall).
    if (trigger === 'usage-wall' && outcome !== 'cooling-down' && outcome !== 'in-flight' && outcome !== 'rate-capped' && outcome !== 'breaker-open' && outcome !== 'unknown-session') {
      this.lastOutcome.set(sessionName, { outcome, at: nowMs });
    }
    if (outcome === 'swapped') {
      this.consecutiveFailures.delete(sessionName);
      this.lastFailedAt.delete(sessionName);
      this.lastNoticeAt.delete(sessionName);
    } else if (outcome === 'failed') {
      const n = (this.consecutiveFailures.get(sessionName) ?? 0) + 1;
      this.consecutiveFailures.set(sessionName, n);
      this.lastFailedAt.set(sessionName, nowMs);
      if (n === (this.deps.breakerThreshold ?? DEFAULT_BREAKER_THRESHOLD)) {
        this.tell(sessionName, WALL_NOTICE_GAVE_UP, nowMs, true);
      }
    } else if (outcome === 'no-room') {
      this.tell(sessionName, WALL_NOTICE_NO_ROOM, nowMs, false);
    }
    this.prune(nowMs);
    return this.record(sessionName, outcome, nowMs);
  }

  private tell(sessionName: string, text: string, nowMs: number, force: boolean): void {
    const last = this.lastNoticeAt.get(sessionName);
    if (!force && last !== undefined && nowMs - last < NOTICE_REPEAT_MS) return;
    if (!this.deps.notifyUser || this.noticePending.has(sessionName)) return;
    // Only a CONFIRMED delivery counts as "told" (it is what silences the
    // standby); a failed or absent send leaves the standby to speak.
    this.noticePending.add(sessionName);
    let delivery: Promise<boolean>;
    try {
      delivery = Promise.resolve(this.deps.notifyUser(sessionName, text));
    } catch {
      delivery = Promise.resolve(false);
    }
    void delivery
      .then((ok) => { if (ok === true) this.lastNoticeAt.set(sessionName, this.now()); })
      .catch(() => { /* @silent-fallback-ok: unconfirmed → the standby still reports the wall */ })
      .finally(() => { this.noticePending.delete(sessionName); });
  }

  /** The time-based gates (breaker, back-off, hourly cap) for a session, without side effects. */
  private gate(sessionName: string, nowMs: number): 'breaker-open' | 'cooling-down' | 'rate-capped' | null {
    return decideRescueGate({
      failedMoves: this.consecutiveFailures.get(sessionName) ?? 0,
      lastFailedAtMs: this.lastFailedAt.get(sessionName),
      lastCheckAtMs: this.lastAttemptAt.get(sessionName),
      moveTimesMs: this.attemptTimes,
      nowMs,
      limits: {
        baseMs: this.deps.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS,
        maxBackoffMs: this.deps.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
        breakerThreshold: this.deps.breakerThreshold ?? DEFAULT_BREAKER_THRESHOLD,
        breakerHoldMs: this.deps.breakerHoldMs ?? DEFAULT_BREAKER_HOLD_MS,
        maxMovesPerHour: this.deps.maxMovesPerHour ?? DEFAULT_MAX_MOVES_PER_HOUR,
      },
    });
  }

  /** The walled window's reset (ms) when it is at/over the threshold, else null. */
  private walledWindowResetMs(a: SubscriptionAccount, soft: number): number | null {
    // The windows actually BLOCKING service are the exhausted ones (>= 100%);
    // service resumes when the last of them resets. Only when no window reads
    // exhausted (the reading lags the wall) do the pressured (>= soft) windows
    // stand in.
    const collect = (min: number): number[] => {
      const out: number[] = [];
      for (const w of [a.lastQuota?.fiveHour, a.lastQuota?.sevenDay]) {
        if (w && w.utilizationPct >= min) {
          const t = Date.parse(w.resetsAt);
          if (Number.isFinite(t)) out.push(t);
        }
      }
      return out;
    };
    const exhausted = collect(100);
    const resets = exhausted.length ? exhausted : collect(soft);
    return resets.length ? Math.max(...resets) : null;
  }

  private async attempt(sessionName: string, trigger: 'usage-wall' | 'throttle'): Promise<WallRescueOutcome> {
    const session = this.deps.getSession(sessionName);
    if (!session) return 'unknown-session';
    const framework = asFramework(session.framework);
    if (!session.subscriptionAccountId && framework !== 'claude-code') return 'disabled';
    const cfg = this.deps.readConfig();
    const accounts = this.deps.listAccounts();
    const enabled = trigger === 'throttle'
      ? cfg?.autoSwapOnRateLimit === true && usableAccounts(accounts, framework).length >= 2
      : wallRescueEffective(cfg, accounts, framework);
    if (!enabled) return 'disabled';
    if (this.inFlight.has(sessionName)) return 'in-flight';
    const nowMs = this.now();
    const gated = this.gate(sessionName, nowMs);
    if (gated) return gated;
    this.inFlight.add(sessionName);
    this.lastAttemptAt.set(sessionName, nowMs);
    try {
      // ── The check (never counts as a failed move) ──
      let resolved: Awaited<ReturnType<UsageWallRescue['resolveSessionAccount']>>;
      try {
        resolved = await this.resolveSessionAccount(sessionName);
      } catch {
        resolved = null; // @silent-fallback-ok: an unreadable source is unresolved — hold
      }
      if (!resolved) {
        this.deps.logger?.warn(`[UsageWallRescue] ${sessionName}: account could not be resolved — holding`);
        return 'unresolved-account';
      }
      const source = accounts.find((a) => a.id === resolved.accountId);
      const proven = resolved.via !== 'default';
      // Does the wall belong to the resolved account? Proven identity: yes
      // unless its own reading contradicts (then hold). Default-slot
      // candidate: only when its reading is not healthy; a healthy candidate
      // is NOT blamed — the source is passed as unknown, so the candidate
      // stays a valid target and is never recorded as walled.
      // A default-slot candidate is never BLAMED (nothing is recorded as walled,
      // its reading cannot veto, its reset time cannot hold the session), but
      // it is still EXCLUDED as a target: the session may well be on it, and a
      // "move" back onto the walled account would count as a success and loop.
      // Only a proven identity is attributed.
      const exhaustedAccountId = resolved.accountId;
      if (trigger === 'usage-wall' && proven) {
        const held = this.corroborate(source, cfg, nowMs, true);
        if (held) {
          this.deps.logger?.log(`[UsageWallRescue] ${sessionName}: wall banner on ${resolved.accountId}, holding (${held})`);
          // A reading taken before the wall can read healthy: ask for a new
          // one, so the next check (base interval) decides on current data.
          if (held === 'source-not-walled') {
            try { this.deps.requestQuotaRefresh?.(); } catch { /* @silent-fallback-ok: next poll still comes */ }
          }
          return held;
        }
        this.observedWalls.set(resolved.accountId, nowMs);
      }
      // Reserve the hourly budget atomically, right before the move (other
      // sessions may have moved while this one was resolving its account).
      const nowMove = this.now();
      if (this.attemptTimes.filter((t) => nowMove - t < HOUR_MS).length >= (this.deps.maxMovesPerHour ?? DEFAULT_MAX_MOVES_PER_HOUR)) {
        return 'rate-capped';
      }
      this.attemptTimes.push(nowMove);
      // ── The move (only its outcome can be a failed move) ──
      let result: SwapResult;
      try {
        result = await this.deps.swap({
          sessionName,
          exhaustedAccountId,
          nowMs,
          framework,
          callerClass: 'reactive-swap',
          sourceWasUntagged: resolved.untagged,
        });
      } catch (err) {
        this.deps.logger?.warn(`[UsageWallRescue] ${sessionName}: move failed (${err instanceof Error ? err.message : String(err)})`);
        return 'failed';
      }
      if (result.swapped) {
        this.deps.logger?.log(
          `[UsageWallRescue] ${sessionName}: ${trigger} on ${exhaustedAccountId}${resolved.untagged ? ' (default login)' : ''} → moved to ${result.toAccountId}`,
        );
        return 'swapped';
      }
      if (result.reason === 'no-eligible-alternate') {
        // Nothing restarted: give the hourly budget back.
        const i = this.attemptTimes.lastIndexOf(nowMove);
        if (i >= 0) this.attemptTimes.splice(i, 1);
        return 'no-room';
      }
      this.deps.logger?.warn(`[UsageWallRescue] ${sessionName}: move off ${exhaustedAccountId} did not complete (${result.reason})`);
      return 'failed';
    } finally {
      this.inFlight.delete(sessionName);
    }
  }

  private prune(nowMs: number): void {
    for (const [k, t] of this.lastAttemptAt) {
      if (nowMs - t > PRUNE_AFTER_MS) {
        this.lastAttemptAt.delete(k);
        this.lastFailedAt.delete(k);
        this.consecutiveFailures.delete(k);
        this.lastNoticeAt.delete(k);
        this.lastOutcome.delete(k);
      }
    }
    for (const [k, t] of this.observedWalls) if (nowMs - t > PRUNE_AFTER_MS) this.observedWalls.delete(k);
    while (this.attemptTimes.length && nowMs - this.attemptTimes[0] >= HOUR_MS) this.attemptTimes.shift();
  }

  /**
   * Read-only status for GET /subscription-pool/wall-rescue: the switch (and
   * what turned it off), whether it is effective, the usable-account count,
   * the spawn-tagging posture, and the last outcomes.
   */
  status(): {
    switchOn: boolean;
    disabledBy: 'wallRescue.enabled' | 'autoSwapOnRateLimit' | 'fewer-than-2-usable-accounts' | null;
    effective: boolean;
    usableAccounts: number;
    pinning: 'all-spawns' | 'walled-default-only' | 'off';
    defaultAccountId: string | null;
    movesLastHour: number;
    recent: Array<{ sessionName: string; outcome: WallRescueOutcome; at: string }>;
  } {
    const cfg = this.deps.readConfig();
    const accounts = this.deps.listAccounts();
    const usable = usableAccounts(accounts, 'claude-code').length;
    const off = wallRescueSwitchOffReason(cfg);
    const effective = off === null && usable >= 2;
    const nowMs = this.now();
    return {
      switchOn: off === null,
      disabledBy: off ?? (usable < 2 ? 'fewer-than-2-usable-accounts' : null),
      effective,
      usableAccounts: usable,
      pinning: !effective ? 'off' : cfg?.pinSessionsToPool === false ? 'walled-default-only' : 'all-spawns',
      defaultAccountId: this.cachedDefaultAccountId,
      movesLastHour: this.attemptTimes.filter((t) => nowMs - t < HOUR_MS).length,
      recent: [...this.recent],
    };
  }

  private record(sessionName: string, outcome: WallRescueOutcome, nowMs: number): WallRescueOutcome {
    this.recent.push({ sessionName, outcome, at: new Date(nowMs).toISOString() });
    if (this.recent.length > 20) this.recent.splice(0, this.recent.length - 20);
    return outcome;
  }

  /** Is this account known to be out of quota (a full reading, or a corroborated wall seen recently)? */
  isKnownWalled(accountId: string): boolean {
    const acct = this.deps.listAccounts().find((a) => a.id === accountId);
    const nowMs = this.now();
    if (acct && acct.lastQuota && bindingUtilization(acct.lastQuota) >= 100) {
      // A full reading counts only while it can still be true: fresh, or its
      // walled window has not reset yet.
      const resetAt = this.walledWindowResetMs(acct, 100);
      if (this.isFresh(acct, nowMs) || (resetAt !== null && resetAt > nowMs)) return true;
    }
    const seen = this.observedWalls.get(accountId);
    return seen !== undefined && nowMs - seen < (this.deps.wallMemoryMs ?? DEFAULT_WALL_MEMORY_MS);
  }

  /**
   * Standby wording for a walled session. Says "being moved" ONLY when the
   * same admission the move uses would admit it now: rescue effective, the
   * session's account resolvable (same rules, cached default), no failed move
   * yet, no time gate other than the base re-check interval of a move already
   * underway, the same corroboration passing, and another account with room.
   * Every other case returns null so the standard "paused until the limit
   * resets" notice stands — never a promise the code will not keep.
   */
  describeWall(sessionName: string): string | typeof QUOTA_WALL_ALREADY_TOLD | null {
    const session = this.deps.getSession(sessionName);
    if (!session) return null;
    const framework = asFramework(session.framework);
    const accounts = this.deps.listAccounts();
    const cfg = this.deps.readConfig();
    if (!wallRescueEffective(cfg, accounts, framework)) return null;
    const nowMs = this.now();
    const currentRes = this.resolveSessionAccountSync(sessionName);
    if (!currentRes) return null;
    const current = currentRes.accountId;
    // A check already ran for THIS wall (outcomes refresh every base interval
    // while the wall lasts, so an older one belongs to an earlier wall): speak
    // from its outcome, never re-promise. When the conversation was already
    // told "no room" recently, say nothing more (QUOTA_WALL_ALREADY_TOLD).
    const lastRec = this.lastOutcome.get(sessionName);
    const episodeMs = 2 * (this.deps.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS);
    const last = lastRec && nowMs - lastRec.at <= episodeMs ? lastRec.outcome : undefined;
    if (last === 'no-room') {
      const told = this.lastNoticeAt.get(sessionName);
      return told !== undefined && nowMs - told < NOTICE_REPEAT_MS ? QUOTA_WALL_ALREADY_TOLD : WALL_NOTICE_NO_ROOM;
    }
    if (last !== undefined && last !== 'swapped') return null;
    if ((this.consecutiveFailures.get(sessionName) ?? 0) > 0) return null;
    const gated = this.gate(sessionName, nowMs);
    // 'cooling-down' with no failures = a check already ran within the base
    // interval; if it moved the session the wall is gone, so wording is moot.
    if (gated === 'breaker-open' || gated === 'rate-capped') return null;
    const proven = currentRes.via !== 'default';
    if (proven && this.corroborate(accounts.find((a) => a.id === current), cfg, nowMs, true)) return null;
    // Same exclusion as the move: the resolved account (proven or candidate).
    const room = selectAccount(accounts, { softThresholdPct: this.soft(cfg), nowMs, framework }, current);
    return room ? WALL_NOTICE_MOVING : null;
  }

  /**
   * The spawn-account resolver (SessionManager.setSpawnAccountResolver).
   * Picks among usable claude accounts with a FRESH reading under the
   * threshold (a successful recent poll is evidence the login works), the one
   * with the most room. Unread accounts are never picked.
   *  - Rescue effective and pinning not explicitly off → tag every claude-code
   *    spawn, so no session rides the default login untagged.
   *  - Pinning explicitly off → only the guard: when the default login is
   *    KNOWN walled, launch on an account with room instead.
   *  - Otherwise, or nothing qualifies → null: the default login, as before.
   */
  spawnAccount(): { configHome: string; accountId: string } | null {
    const cfg = this.deps.readConfig();
    const accounts = this.deps.listAccounts();
    if (!wallRescueEffective(cfg, accounts, 'claude-code')) return null;
    const nowMs = this.now();
    const soft = this.soft(cfg);
    let exclude: string | null = null;
    if (cfg?.pinSessionsToPool === false) {
      const def = this.cachedDefaultAccountId;
      if (!def || !this.isKnownWalled(def)) return null;
      exclude = def;
    }
    const pick = usableAccounts(accounts, 'claude-code')
      .filter((a) => a.id !== exclude && !this.isKnownWalled(a.id) && this.isFresh(a, nowMs) && bindingUtilization(a.lastQuota) < soft)
      .sort((a, b) => bindingUtilization(a.lastQuota) - bindingUtilization(b.lastQuota) || a.id.localeCompare(b.id))[0];
    return pick ? { configHome: pick.configHome, accountId: pick.id } : null;
  }

  /**
   * The spawn-account resolver for a NEW headless Codex session
   * (fb-39e55b95-f00, fb-fb4d0e68-3a2). Before this, a `codex-cli` spawn never
   * asked the pool: it launched on the default `CODEX_HOME` login untagged, so
   * a login the pool read at 100% weekly took every spawn and each died at its
   * first turn.
   *
   * Same posture as `spawnAccount` (the Claude resolver), with one difference:
   * the Codex default login cannot be matched to a pool account (only claude
   * logins have a resolvable default slot), so the guard steers away from the
   * default whenever ANY usable Codex account is known walled.
   *  - Switch off, or no usable Codex account → null: the default login.
   *  - Every usable Codex account known walled → refuse, with a plain reason
   *    naming the soonest reset, instead of launching into the wall.
   *  - Rescue effective (2+ usable) and pinning not explicitly off → tag the
   *    spawn; otherwise act only when some Codex account is known walled.
   *  - Pick: not walled, a FRESH reading under the soft threshold (a recent
   *    successful read is evidence the login works; unread accounts are never
   *    picked), most room first. Nothing qualifies → null: the default login.
   * "Walled" is the SAME predicate the rescue uses (`isKnownWalled`): a reading
   * at or above 100% in either window counts until that window's resetsAt.
   */
  codexSpawnAccount(): { configHome: string; accountId: string } | { refused: string } | null {
    const cfg = this.deps.readConfig();
    if (!wallRescueSwitchOn(cfg)) return null;
    const accounts = this.deps.listAccounts();
    const usable = usableAccounts(accounts, 'codex-cli');
    if (usable.length === 0) return null;
    const nowMs = this.now();
    const walled = usable.filter((a) => this.isKnownWalled(a.id));
    if (walled.length === usable.length) {
      const resets = walled
        .map((a) => this.walledWindowResetMs(a, 100))
        .filter((t): t is number => t !== null && t > nowMs);
      const when = resets.length ? ` The soonest limit resets at ${new Date(Math.min(...resets)).toISOString()}.` : '';
      return {
        refused: `codex-accounts-walled: every Codex account on this machine is at its usage limit, so the session was not started.${when}`,
      };
    }
    const tagAll = cfg?.pinSessionsToPool !== false && wallRescueEffective(cfg, accounts, 'codex-cli');
    if (!tagAll && walled.length === 0) return null;
    const soft = this.soft(cfg);
    const pick = usable
      .filter((a) => !this.isKnownWalled(a.id) && this.isFresh(a, nowMs) && bindingUtilization(a.lastQuota) < soft)
      .sort((a, b) => bindingUtilization(a.lastQuota) - bindingUtilization(b.lastQuota) || a.id.localeCompare(b.id))[0];
    return pick ? { configHome: pick.configHome, accountId: pick.id } : null;
  }
}
