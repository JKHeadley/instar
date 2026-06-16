/**
 * Quota Tracker — reads usage state from a JSON file and provides
 * load-shedding decisions to the job scheduler.
 *
 * The quota state file is written externally (by a collector script,
 * an OAuth integration, or the agent itself). This class reads it
 * and translates usage percentages into scheduling decisions.
 *
 * The architecture mirrors Dawn's proven pattern:
 * - Collector writes quota-state.json (polling interval, OAuth, etc.)
 * - QuotaTracker reads it and exposes canRunJob(priority)
 * - JobScheduler calls canRunJob before spawning sessions
 */

import fs from 'node:fs';
import { DegradationReporter } from './DegradationReporter.js';
import path from 'node:path';
import type { QuotaState, JobPriority, JobSchedulerConfig } from '../core/types.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

/**
 * Live pool-placeability signal for the POOL-AWARE quota throttle. Returned by an
 * injected provider (wired in server.ts) that asks the placement layer's OWN
 * `selectAccount` "is there a placeable account, and what is its headroom?". The
 * throttle uses placement's exact eligibility predicate by construction, so a
 * throttle "allow" always corresponds to a real account the pool can place on —
 * closing the band where the brake could allow work that placement couldn't land
 * (the respawn-loop gap). Spec: docs/specs/POOL-AWARE-QUOTA-THROTTLE-SPEC.md.
 */
export interface PoolQuota {
  /** True iff placement's selectAccount returned a placeable account. */
  placeable: boolean;
  /** Best placeable account's weekly utilization (0-100), or null if unknown. */
  weeklyPercent?: number | null;
  /** Best placeable account's 5-hour utilization (0-100), or null if unknown. */
  fiveHourPercent?: number | null;
  /**
   * True when the pool has a placeable account by STATUS but no trustworthy live
   * quota reading for it (e.g. a freshly-enrolled or just-after-an-outage pool
   * whose per-account snapshots are missing/stale). The throttle then applies the
   * SAME bounded degraded-mode cap as the file path (shed low, allow medium+)
   * rather than trusting a phantom "0% fresh" reading. Closes the round-2 finding
   * that the pool path had no staleness/provenance guard.
   */
  degraded?: boolean;
}

export interface QuotaTrackerConfig {
  /** Path to the quota state JSON file */
  quotaFile: string;
  /** Thresholds from scheduler config */
  thresholds: JobSchedulerConfig['quotaThresholds'];
  /** How stale (in ms) the quota data can be before we treat it as unknown */
  maxStalenessMs?: number;
}

export class QuotaTracker {
  private config: QuotaTrackerConfig;
  private cachedState: QuotaState | null = null;
  private lastRead: number = 0;
  private readCooldownMs = 5000; // Don't re-read more than every 5s
  // Warn ONCE per no-file episode, not on every getState() call. The
  // `!this.cachedState` guard below was ineffective: when the file is absent,
  // cachedState is never populated, so the warn fired on every call (observed
  // 902×/day on the gemini-cli agent — pure log spam that drowns real signal).
  // Re-armed when the file reappears so a later disappearance warns once more.
  private warnedNoFile = false;

  /**
   * Optional live pool-placeability provider (wired post-construction in
   * server.ts for multi-account agents). When set, the throttle reasons over the
   * pool's real placeability instead of a single account's usage. Unset on solo
   * agents → the legacy single-account path runs unchanged.
   */
  private poolQuotaProvider?: () => PoolQuota | null;

  constructor(config: QuotaTrackerConfig) {
    this.config = config;
  }

  /**
   * Inject (or clear) the live pool-placeability provider. Wired in server.ts to
   * `() => selectAccount(subscriptionPool.list(), …)` so the throttle shares
   * placement's exact eligibility. Pass `undefined` to revert to single-account
   * gating.
   */
  setPoolQuotaProvider(fn: (() => PoolQuota | null) | undefined): void {
    this.poolQuotaProvider = fn;
  }

  /**
   * Read the current quota state from the file.
   * Returns null if file doesn't exist or is corrupted.
   */
  getState(): QuotaState | null {
    const now = Date.now();

    // Don't hit disk too frequently
    if (this.cachedState && (now - this.lastRead) < this.readCooldownMs) {
      return this.cachedState;
    }

    try {
      if (!fs.existsSync(this.config.quotaFile)) {
        if (!this.warnedNoFile) {
          console.warn('[quota] No quota state file found — all jobs will run (fail-open)');
          this.warnedNoFile = true;
        }
        return null;
      }
      // File present again → re-arm the one-shot warning for a future absence.
      this.warnedNoFile = false;

      const raw = fs.readFileSync(this.config.quotaFile, 'utf-8');
      const state: QuotaState = JSON.parse(raw);

      // Check staleness — stale data should fail open (allow all jobs)
      const maxStale = this.config.maxStalenessMs ?? 30 * 60 * 1000; // 30 min default
      const lastUpdated = new Date(state.lastUpdated).getTime();
      if ((now - lastUpdated) > maxStale) {
        console.warn(`[quota] Stale data (${Math.round((now - lastUpdated) / 60000)}m old) — discarding, will fail open`);
        this.lastRead = now; // Prevent re-reading stale file on every call
        return null;
      }

      this.cachedState = state;
      this.lastRead = now;
      return state;
    } catch {
      this.lastRead = Date.now(); // Prevent hammering a corrupt file
      return this.cachedState; // Return last-known-good rather than null
    }
  }

  /**
   * Determine if a job at the given priority should run based on current quota.
   *
   * Checks BOTH weekly usage AND 5-hour rate limit:
   * - 5-hour >= 95%: block ALL spawns (sessions will immediately fail)
   * - 5-hour >= 80%: only critical priority
   * - Weekly >= shutdown (e.g. 95%): no jobs
   * - Weekly >= critical (e.g. 92%): critical only
   * - Weekly >= elevated (e.g. 85%): high+ only
   * - Weekly >= normal (e.g. 75%): medium+ only
   *
   * If quota data is unavailable or stale, defaults to allowing all jobs
   * (fail-open — better to run than to silently stop).
   */
  canRunJob(priority: JobPriority): boolean {
    const result = this.shouldSpawnSession(priority);
    return result.allowed;
  }

  /**
   * Check if a session should be spawned at the given priority.
   * Returns a structured result with reason — useful for logging and notifications.
   *
   * Checks both weekly AND 5-hour rate limits.
   */
  shouldSpawnSession(priority?: JobPriority): { allowed: boolean; reason: string } {
    // POOL-AWARE PATH (the robustness fix): when a live pool-placeability provider
    // is wired (multi-account agent), the brake reflects POOL placeability — shared
    // BY CONSTRUCTION with the placement layer. The provider asks placement's OWN
    // selectAccount "is there a placeable account, and what's its headroom?", so a
    // throttle "allow" always corresponds to an account the pool can actually place
    // on. This both (a) fixes the account-blind throttle that stopped the WHOLE
    // agent on one maxed account while fresh accounts sat idle, and (b) closes the
    // band where the old design allowed work placement couldn't land → respawn loop
    // (selectAccount's soft threshold is stricter than the shutdown threshold).
    // Live, status-aware data — no stale snapshot. Spec: docs/specs/POOL-AWARE-QUOTA-THROTTLE-SPEC.md.
    if (this.poolQuotaProvider) {
      let pool: PoolQuota | null = null;
      try {
        pool = this.poolQuotaProvider();
      } catch {
        // @silent-fallback-ok: a provider throw deliberately falls through to the
        // conservative file-based quota logic below (fail-safe — the throttle still
        // gates, never silently allows). This is a hot path (every spawn gate), so
        // reporting per-call would spam; the fallthrough IS the intended degraded
        // behavior, not a swallowed error.
        pool = null;
      }
      if (pool) {
        if (!pool.placeable) {
          // NOTE: "placeable" is evaluated at DECISION time. A later placement that
          // finds the last account just got consumed is a NORMAL, non-looping
          // outcome (the caller backs off / retries), not the old respawn loop —
          // that loop came from the throttle and placement DISAGREEING, which can no
          // longer happen now that the throttle asks placement's own predicate.
          return { allowed: false, reason: 'No placeable account in the pool — every account is at/over capacity' };
        }
        // DATA-QUALITY GUARD: if the pool has a placeable account by STATUS but no
        // trustworthy live reading for it (degraded flag, or a non-finite/implausible
        // percent), do NOT trust a phantom "0% fresh" — apply the SAME bounded
        // degraded-mode cap as the file path. (Closes the round-2 finding: the pool
        // path otherwise inherited selectAccount's unclamped, staleness-blind view.)
        const weekly = pool.weeklyPercent;
        const weeklyTrustworthy = typeof weekly === 'number' && isFinite(weekly) && weekly >= 0 && weekly <= 100;
        if (pool.degraded || (weekly !== null && weekly !== undefined && !weeklyTrustworthy)) {
          return this.boundedDegradedDecision(pool.fiveHourPercent ?? undefined, priority,
            'pool quota reading is missing/untrustworthy');
        }
        // selectAccount already vouched for placeability; gate the best placeable
        // account's effective usage (weekly + 5h, both checked in evaluateAccountQuota)
        // by priority so load-shedding still applies. An allow here is guaranteed
        // placeable. A null percent means "unknown but placeable" → treated as 0.
        const r = this.evaluateAccountQuota(weekly ?? 0, pool.fiveHourPercent ?? undefined, priority);
        return r.allowed
          ? { allowed: true, reason: `Pool headroom — best placeable account at ${Math.round(weekly ?? 0)}% weekly` }
          : r;
      }
      // provider threw / returned null → fall through to the file-based logic below.
    }

    const state = this.getState();
    if (!state) return { allowed: true, reason: 'No quota data — fail open' };

    // DEGRADED-DATA HARDENING (bounded): a non-authoritative estimate (JSONL
    // token-counting) or an implausible >100% value must NOT slam the brake on the
    // whole agent (the 2026-06-15 incident: a claude-jsonl 186% estimate stopped
    // everything). But because we genuinely do not KNOW the real usage, fail-open is
    // BOUNDED — we shed the lowest-priority work and still honor a genuine
    // authoritative 5-hour wall. An AUTHORITATIVE source (anthropic-oauth) is never
    // treated as degraded, so a real wall still stops. Spec §3.
    const authoritative = state.source === 'anthropic-oauth';
    const degraded = !authoritative &&
      (state.source === 'claude-jsonl' || (typeof state.usagePercent === 'number' && state.usagePercent > 100));
    if (degraded) {
      return this.boundedDegradedDecision(state.fiveHourPercent, priority, 'quota data is a non-authoritative estimate');
    }

    // SINGLE-ACCOUNT PATH (legacy, unchanged): gate on the one account's usage.
    return this.evaluateAccountQuota(state.usagePercent, state.fiveHourPercent, priority);
  }

  /**
   * Bounded degraded-mode decision, shared by the file path (non-authoritative
   * estimate) and the pool path (placeable account with no trustworthy reading).
   * We don't KNOW the real usage, so: honor a genuine authoritative 5-hour wall,
   * then shed the lowest-priority work and allow medium+ — a conservative cap, not
   * an unbounded fail-open and not a whole-agent stall. Spec §4.
   */
  private boundedDegradedDecision(
    fiveHourPercent: number | undefined,
    priority: JobPriority | undefined,
    reasonContext: string,
  ): { allowed: boolean; reason: string } {
    if (typeof fiveHourPercent === 'number' && isFinite(fiveHourPercent) && fiveHourPercent >= 95) {
      return { allowed: false, reason: `5-hour rate limit at ${fiveHourPercent}% — sessions will fail immediately` };
    }
    if (priority === 'low') {
      return { allowed: false, reason: `${reasonContext} — shedding low-priority work (degraded mode)` };
    }
    return { allowed: true, reason: `${reasonContext} — running medium+ priority in degraded mode (low-priority shed)` };
  }

  /**
   * Evaluate ONE account's (weekly, 5-hour) usage against the configured
   * thresholds for a given priority. Extracted so the pool-aware path can score
   * each account independently and pick the best-available one. The single-account
   * (legacy) path calls this directly with the one account's numbers, preserving
   * the exact prior behavior for agents that don't run a multi-account pool.
   */
  private evaluateAccountQuota(
    rawWeekly: number,
    rawFiveHour: number | undefined,
    priority?: JobPriority,
  ): { allowed: boolean; reason: string } {
    // Check 5-hour rate limit first — these cause immediate session failures
    const fiveHour = rawFiveHour;
    if (typeof fiveHour === 'number' && isFinite(fiveHour)) {
      if (fiveHour >= 95) {
        return { allowed: false, reason: `5-hour rate limit at ${fiveHour}% — sessions will fail immediately` };
      }
      if (fiveHour >= 80 && priority && priority !== 'critical') {
        return { allowed: false, reason: `5-hour rate limit at ${fiveHour}% — only critical priority allowed` };
      }
    }

    // Check weekly usage
    if (typeof rawWeekly !== 'number' || !isFinite(rawWeekly)) {
      return { allowed: true, reason: 'Invalid weekly data — fail open' };
    }
    const usage = Math.max(0, Math.min(100, rawWeekly));
    const { normal, elevated, critical, shutdown } = this.config.thresholds;

    if (usage >= shutdown) {
      return { allowed: false, reason: `Weekly quota at ${usage}% — all jobs stopped` };
    }

    if (usage >= critical) {
      const ok = !priority || priority === 'critical';
      return ok
        ? { allowed: true, reason: `Weekly at ${usage}% — critical only` }
        : { allowed: false, reason: `Weekly quota at ${usage}% — only critical priority runs` };
    }

    if (usage >= elevated) {
      const ok = !priority || priority === 'critical' || priority === 'high';
      return ok
        ? { allowed: true, reason: `Weekly at ${usage}% — high+ only` }
        : { allowed: false, reason: `Weekly quota at ${usage}% — only high+ priority runs` };
    }

    if (usage >= normal) {
      const ok = !priority || priority !== 'low';
      return ok
        ? { allowed: true, reason: `Weekly at ${usage}% — medium+ only` }
        : { allowed: false, reason: `Weekly quota at ${usage}% — low priority paused` };
    }

    return { allowed: true, reason: 'Quota normal' };
  }

  /**
   * Write a quota state to the file (for collector scripts or manual updates).
   */
  updateState(state: QuotaState): void {
    if (typeof state.usagePercent !== 'number' || !isFinite(state.usagePercent)) {
      throw new Error(`Invalid usagePercent: ${state.usagePercent}`);
    }
    if (!state.lastUpdated || isNaN(new Date(state.lastUpdated).getTime())) {
      throw new Error(`Invalid lastUpdated: ${state.lastUpdated}`);
    }
    const dir = path.dirname(this.config.quotaFile);
    fs.mkdirSync(dir, { recursive: true });
    // Atomic write: unique temp filename to prevent concurrent corruption
    const tmpPath = this.config.quotaFile + `.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2));
      fs.renameSync(tmpPath, this.config.quotaFile);
    } catch (err) {
      try { SafeFsExecutor.safeUnlinkSync(tmpPath, { operation: 'src/monitoring/QuotaTracker.ts:175' }); } catch { /* ignore */ }
      throw err;
    }
    this.cachedState = state;
    this.lastRead = Date.now();
  }

  /**
   * Get the recommendation string for display purposes.
   */
  getRecommendation(): QuotaState['recommendation'] {
    const state = this.getState();
    if (!state) return 'normal';

    // 5-hour at 95%+ is always 'stop' regardless of weekly
    if (typeof state.fiveHourPercent === 'number' && state.fiveHourPercent >= 95) return 'stop';
    if (typeof state.fiveHourPercent === 'number' && state.fiveHourPercent >= 80) return 'critical';

    const usage = state.usagePercent;
    const { normal, elevated, critical, shutdown } = this.config.thresholds;

    if (usage >= shutdown) return 'stop';
    if (usage >= critical) return 'critical';
    if (usage >= elevated) return 'reduce';
    if (usage >= normal) return 'reduce';
    return 'normal';
  }

  /**
   * Fetch quota status from a remote API (e.g., Dawn's /api/instar/quota).
   * If the remote says canProceed=false, updates local state accordingly.
   *
   * This allows Instar agents to check a central quota authority before
   * spawning sessions, preventing wasted attempts on exhausted machines.
   *
   * @param url - Full URL to the quota API (e.g., "https://dawn.bot-me.ai/api/instar/quota")
   * @param apiKey - Authorization token (sent as Bearer header)
   * @param timeoutMs - Request timeout (default 5000ms)
   * @returns Remote quota status, or null on failure (fail-open)
   */
  async fetchRemoteQuota(
    url: string,
    apiKey: string,
    timeoutMs: number = 5000,
  ): Promise<RemoteQuotaResult | null> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'application/json',
        },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!response.ok) {
        console.warn(`[quota] Remote quota API returned ${response.status}`);
        return null;
      }

      const data = await response.json() as RemoteQuotaResult;

      // If remote says blocked, update local state to reflect it
      if (!data.canProceed && typeof data.weeklyPercent === 'number') {
        const state = this.getState() ?? {
          usagePercent: 0,
          lastUpdated: new Date().toISOString(),
        };
        state.usagePercent = data.weeklyPercent;
        if (typeof data.fiveHourPercent === 'number') {
          state.fiveHourPercent = data.fiveHourPercent;
        }
        state.lastUpdated = new Date().toISOString();
        this.cachedState = state;
      }

      return data;
    } catch (err) {
      // Network failure, timeout, etc. — fail open but REPORT it
      console.warn(`[quota] Remote quota check failed: ${err instanceof Error ? err.message : err}`);
      DegradationReporter.getInstance().report({
        feature: 'QuotaTracker.remoteCheck',
        primary: 'Real-time quota monitoring via remote API',
        fallback: 'Fail open — assuming no quota limits (may overspend)',
        reason: `Remote quota check failed: ${err instanceof Error ? err.message : String(err)}`,
        impact: 'Quota limits not enforced. Agent may spawn sessions that exceed API limits.',
      });
      return null;
    }
  }
}

/** Result from a remote quota API (e.g., /api/instar/quota) */
export interface RemoteQuotaResult {
  canProceed: boolean;
  blockReason?: string | null;
  activeAccount?: string | null;
  weeklyPercent: number;
  fiveHourPercent?: number | null;
  canRunPriority?: string;
  recommendation?: string | null;
  stale?: boolean;
}
