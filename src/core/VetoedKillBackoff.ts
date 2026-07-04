/**
 * VetoedKillBackoff — a per-session veto-backoff ledger for the SessionManager
 * kill branches (the age-gate AND the bound-idle zombie killer).
 *
 * SessionManager.monitorTick runs every 5 seconds. When it decides a session is
 * killable (past its max age, or idle-at-prompt past its bound-idle threshold) it
 * requests a kill via terminateSession → ReapGuard. If the §P2 KEEP-guard vetoes
 * that kill (a recent user message, an open commitment, a live subagent, …), the
 * session correctly survives — but a naive caller re-requests the SAME kill every
 * 5 seconds forever (720 attempts/hour/session → the 2026-06-05 17,503-line log
 * flood, and the 2026-07-03 132MB reap-log idle-zombie hot-spin).
 *
 * This ledger makes the kill branch RESPECT the guard's verdict: after a veto it
 * suppresses re-requests for `backoffMs` (so a kept session is re-checked on a slow
 * cadence, not every tick). It changes only how OFTEN a vetoed kill is retried —
 * never WHICH sessions are killed (the KEEP-guard remains the sole authority). A
 * genuinely-idle-abandoned session has no keep-reason, so its first request returns
 * terminated:true and it dies exactly as before.
 *
 * Generalized from the shipped `AgeKillBackoff` (#863): a superset that adds a
 * reason-KEY-aware stale-reprieve (a changed protection re-checks now, doesn't wait
 * out the window), an episode counter (feeds the P19 breaker), and a once-per-episode
 * log gate (`recordVeto` returns `firstOfEpisode`) — all folded into the ledger value
 * so no parallel Set is needed. The class is not persisted; there is no on-disk value
 * to migrate.
 *
 * Pure logic, injectable clock, bounded memory — unit-testable in isolation.
 */

export interface VetoedKillBackoffOptions {
  /** Suppress kill re-requests for this long after a veto. 0 = no cooldown window
   *  (still tracks episodes + log-once + breaker; NOT a disable — the disable path
   *  is never constructing the instance). */
  backoffMs: number;
  /** Hard cap on distinct sessions tracked (memory bound; oldest-evicted). */
  maxTracked: number;
}

export const DEFAULT_VETOED_KILL_BACKOFF: VetoedKillBackoffOptions = {
  backoffMs: 10 * 60 * 1000, // 10 minutes → 6 attempts/hr (was 720/hr)
  maxTracked: 1024,
};

/** Back-compat aliases for the shipped age-gate name. */
export type AgeKillBackoffOptions = VetoedKillBackoffOptions;
export const DEFAULT_AGE_KILL_BACKOFF: VetoedKillBackoffOptions = DEFAULT_VETOED_KILL_BACKOFF;

/** Per-entry ledger value (L1 — the `number` → object migration). Every reader
 *  MUST use `.until`; comparing the whole object to a number yields NaN and
 *  silently collapses the backoff. */
interface BackoffEntry {
  /** epoch ms until which kill re-requests are suppressed. */
  until: number;
  /** the STABLE keep-reason key that vetoed the last kill (null when unkeyed —
   *  the age-gate's 2-arg callsites, which never trigger the stale-reprieve). */
  reasonKey: string | null;
  /** whether the WARN for this episode has already been logged (once-per-episode). */
  logged: boolean;
  /** consecutive veto episodes on this session for the current reason (feeds the
   *  P19 breaker; reset by reset/recordKilled/clear). */
  episodeCount: number;
}

function coerceNonNegInt(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

/**
 * Map a ReapGuard blockedReason result (or a bare reason string) to the STABLE
 * ledger key. The `reason` field ReapGuard returns is already a stable enum key
 * (`open-commitment`, `recent-user-message`, …), NOT free-form/interpolated text,
 * so it is safe to use verbatim as the ledger key (R3-2). The human-readable string
 * (if any interpolation ever existed) is used only for WARN/attention wording; only
 * this stable key crosses into the ledger.
 *
 * Returns null when there is no usable reason string — the "unkeyable, fail-open"
 * case: the caller re-evaluates this tick rather than minting a fabricated key.
 */
export function normalizeReasonKey(
  blocked: { reason?: string } | string | null | undefined,
): string | null {
  if (!blocked) return null;
  const reason = typeof blocked === 'string' ? blocked : blocked.reason;
  return typeof reason === 'string' && reason.length > 0 ? reason : null;
}

/**
 * Every keep-reason `ReapGuard.blockedReason()` can currently return (source of
 * truth: src/core/ReapGuard.ts evaluate()). Used by the exhaustive normalization
 * test — each maps to its OWN distinct key, and no two materially-different keep
 * reasons collapse onto one another.
 */
export const KNOWN_REAP_KEEP_REASONS = [
  'protected',
  'spawn-grace',
  'recovery-in-flight',
  'pending-injection',
  'relay-lease',
  'recent-user-message',
  'open-commitment',
  'active-subagent',
  'structural-long-work',
  'active-process',
  'process-uninspectable',
  'main-process-active',
  'guard-error',
] as const;

/**
 * The subset of skip reasons whose PERSISTENCE is a genuine "this session is STUCK
 * and should be investigated" signal — i.e. the ones the Fix A′ P19 breaker may
 * escalate on (spec §Fix A′: "likely a stuck open-commitment or a resume-loop").
 *
 * DELIBERATELY EXCLUDED (second-pass review, point 9 — the multi-machine standby
 * escalation gap the converged spec did not cover):
 *  - Authority/CAS skips `terminateSession` returns BEFORE the keep-guard runs —
 *    `not-lease-holder` (a STANDBY machine returns this every tick for every idle
 *    session — escalating it as "vetoed from cleanup" is false), `in-flight`,
 *    `not-found`, `already-completed`/`already-killed`/`already-*`. These are not
 *    keep-reasons at all.
 *  - Intentional / transient keep-reasons that are NOT a stuck anomaly:
 *    `protected` (operator-configured permanent keep), `spawn-grace` (startup),
 *    `recovery-in-flight` (a bounded recovery window), `guard-error` (a transient
 *    inspect failure that resolves itself).
 *
 * A skip reason OUTSIDE this set still COOLS DOWN (recordVeto → the flood-stop
 * benefit applies universally, incl. the standby `not-lease-holder` flood) — it
 * simply never raises the "stuck session" attention item.
 */
export const IDLE_ZOMBIE_ESCALATION_REASONS: ReadonlySet<string> = new Set([
  'open-commitment',
  'recent-user-message',
  'active-subagent',
  'structural-long-work',
  'active-process',
  'main-process-active',
  'process-uninspectable',
  'pending-injection',
  'relay-lease',
]);

export class VetoedKillBackoff {
  private readonly backoffMs: number;
  private readonly maxTracked: number;
  /** sessionId -> ledger entry (insertion-ordered for oldest-eviction). */
  private readonly entries = new Map<string, BackoffEntry>();

  constructor(opts: Partial<VetoedKillBackoffOptions> = {}) {
    const d = DEFAULT_VETOED_KILL_BACKOFF;
    // backoffMs may be 0 (no cooldown window) — only a negative/NaN falls back.
    this.backoffMs = coerceNonNegInt(opts.backoffMs, d.backoffMs);
    this.maxTracked = Math.max(1, coerceNonNegInt(opts.maxTracked, d.maxTracked));
  }

  /**
   * Whether the kill branch may request a kill for this session right now.
   *
   * - backoffMs === 0 → always true (no cooldown gate).
   * - no entry → true (never vetoed / already cleared).
   * - STALE-REPRIEVE (R3-2): a stored key AND a supplied key that DIFFER means the
   *   protection changed → invalidate the entry and allow one fresh evaluation now.
   * - else → true once `nowMs >= entry.until`.
   *
   * Back-compat: `reasonKey` omitted (age-gate 2-arg callsites) ⇒ treated as null
   * ⇒ no stale-reprieve, today's behavior.
   */
  shouldRequest(sessionId: string, nowMs: number, reasonKey?: string | null): boolean {
    if (this.backoffMs === 0) return true;
    const entry = this.entries.get(sessionId);
    if (!entry) return true;
    if (entry.reasonKey != null && reasonKey != null && reasonKey !== entry.reasonKey) {
      // Protection changed — re-check now rather than waiting out the window.
      this.entries.delete(sessionId);
      return true;
    }
    return nowMs >= entry.until;
  }

  /**
   * Record that the guard KEPT this session (kill vetoed) — back off re-requests.
   * Returns `firstOfEpisode`: true exactly once per (session, reasonKey) episode so
   * the caller logs the WARN once, not every tick.
   *
   * With backoffMs === 0 (no cooldown) the entry is STILL recorded — episode
   * counting, the once-per-episode log gate, and the P19 breaker all still work
   * (R4-5: cooldownMs:0 is enabled-but-no-cooldown, NOT a disable).
   */
  recordVeto(sessionId: string, nowMs: number, reasonKey?: string | null): boolean {
    const key = reasonKey ?? null;
    const existing = this.entries.get(sessionId);
    let firstOfEpisode: boolean;
    if (!existing || existing.reasonKey !== key) {
      // New episode (no entry, or the reason changed) — fresh entry, log once.
      this.entries.set(sessionId, {
        until: nowMs + this.backoffMs,
        reasonKey: key,
        logged: true,
        episodeCount: 1,
      });
      firstOfEpisode = true;
    } else {
      // Same reason, existing episode — extend the window + count the episode.
      existing.until = nowMs + this.backoffMs;
      existing.episodeCount++;
      if (existing.logged) {
        firstOfEpisode = false;
      } else {
        existing.logged = true;
        firstOfEpisode = true;
      }
    }
    this.evictIfNeeded();
    return firstOfEpisode;
  }

  /** Consecutive veto episodes recorded for this session (0 if none). */
  episodeCount(sessionId: string): number {
    return this.entries.get(sessionId)?.episodeCount ?? 0;
  }

  /** The session was actually killed — drop its state (episode ends). */
  recordKilled(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  /** Session is gone (cleanup on removal). */
  clear(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  /** A session's state changed materially (e.g. it resumed work) — drop the
   *  back-off so it is re-evaluated at the next tick rather than staying suppressed. */
  reset(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  /** Test/inspection seam — ms remaining in the back-off window (0 if not
   *  suppressed). Reads `.until`, never the whole object (L1). */
  remainingMs(sessionId: string, nowMs: number): number {
    const entry = this.entries.get(sessionId);
    return entry != null && entry.until > nowMs ? entry.until - nowMs : 0;
  }

  /** Test/inspection seam. */
  get trackedCount(): number {
    return this.entries.size;
  }

  /** Drop the oldest entry while over the cap (insertion-ordered Map). */
  private evictIfNeeded(): void {
    while (this.entries.size > this.maxTracked) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
