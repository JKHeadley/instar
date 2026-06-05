/**
 * AgeKillBackoff — a per-session back-off ledger for the SessionManager age-gate.
 *
 * The age-gate (SessionManager.monitorTick) runs every 5 seconds. When a session is
 * past its max age and idle-at-prompt, it requests a kill via the ReapAuthority. If the
 * §P2 KEEP-guard vetoes that kill (the session got a recent user message, is topic-bound,
 * holds a commitment, …), the session correctly survives — but the age-gate used to
 * re-request the kill every 5 seconds forever (720 attempts/hour/session → the 2026-06-05
 * 17,503-line log flood + wasted CPU that read as "heavy load").
 *
 * This ledger makes the age-gate RESPECT the guard's verdict: after a veto, it suppresses
 * re-requests for `backoffMs` (so a kept session is re-checked on a slow cadence, not every
 * tick). It changes only how OFTEN the age-gate asks — never WHICH sessions are killed
 * (the KEEP-guard remains the sole authority). A genuinely-idle-abandoned session has no
 * keep-reason, so its first request returns terminated:true and it dies exactly as before.
 *
 * Pure logic, injectable clock, bounded memory — unit-testable in isolation (mirrors
 * AttentionTopicGuard).
 */

export interface AgeKillBackoffOptions {
  /** Suppress age-kill re-requests for this long after a veto. 0 disables back-off. */
  backoffMs: number;
  /** Hard cap on distinct sessions tracked (memory bound; oldest-evicted). */
  maxTracked: number;
}

export const DEFAULT_AGE_KILL_BACKOFF: AgeKillBackoffOptions = {
  backoffMs: 10 * 60 * 1000, // 10 minutes → 6 attempts/hr (was 720/hr)
  maxTracked: 1024,
};

function coerceNonNegInt(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

export class AgeKillBackoff {
  private readonly backoffMs: number;
  private readonly maxTracked: number;
  /** sessionId -> epoch ms until which age-kill re-requests are suppressed. */
  private readonly suppressedUntil = new Map<string, number>();

  constructor(opts: Partial<AgeKillBackoffOptions> = {}) {
    const d = DEFAULT_AGE_KILL_BACKOFF;
    // backoffMs may be 0 (disable) — only a negative/NaN falls back to the default.
    this.backoffMs = coerceNonNegInt(opts.backoffMs, d.backoffMs);
    this.maxTracked = Math.max(1, coerceNonNegInt(opts.maxTracked, d.maxTracked));
  }

  /** Whether the age-gate may request a kill for this session right now. False while the
   *  session is inside its post-veto back-off window. With backoffMs=0, always true. */
  shouldRequest(sessionId: string, nowMs: number): boolean {
    if (this.backoffMs === 0) return true;
    const until = this.suppressedUntil.get(sessionId);
    return until == null || nowMs >= until;
  }

  /** Record that the guard KEPT this session (kill vetoed) — back off re-requests. */
  recordVeto(sessionId: string, nowMs: number): void {
    if (this.backoffMs === 0) return;
    this.suppressedUntil.set(sessionId, nowMs + this.backoffMs);
    this.evictIfNeeded();
  }

  /** The session was actually killed — drop its state. */
  recordKilled(sessionId: string): void {
    this.suppressedUntil.delete(sessionId);
  }

  /** Session is gone (cleanup on removal). */
  clear(sessionId: string): void {
    this.suppressedUntil.delete(sessionId);
  }

  /** A session's state changed materially (e.g. a new user message / injection) — drop the
   *  back-off so it is re-evaluated at the next tick rather than staying suppressed. */
  reset(sessionId: string): void {
    this.suppressedUntil.delete(sessionId);
  }

  /** Test/inspection seam — ms remaining in the back-off window (0 if not suppressed). */
  remainingMs(sessionId: string, nowMs: number): number {
    const until = this.suppressedUntil.get(sessionId);
    return until != null && until > nowMs ? until - nowMs : 0;
  }

  /** Test/inspection seam. */
  get trackedCount(): number {
    return this.suppressedUntil.size;
  }

  /** Drop the oldest entry while over the cap (insertion-ordered Map). */
  private evictIfNeeded(): void {
    while (this.suppressedUntil.size > this.maxTracked) {
      const oldest = this.suppressedUntil.keys().next().value;
      if (oldest === undefined) break;
      this.suppressedUntil.delete(oldest);
    }
  }
}
