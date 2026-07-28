/**
 * IncidentDedupe — a BEST-EFFORT "one per incident" gate (NOT exactly-once).
 *
 * The VetoedKillBackoff P19 breaker (Fix A′) depends on THIS seam, never on the
 * alerting transport directly, so session-lifecycle safety is decoupled from the
 * alert transport: the breaker asks "may I emit this incident?" and the seam owns
 * the dedupe decision.
 *
 * The shipped backing is an in-process TTL map (spec C4): within one process's
 * window, a repeat of the same incident key returns false (already emitted). It is
 * BEST-EFFORT — across a server restart or on a second machine a duplicate emission
 * is possible and ACCEPTABLE (the goal is flood-avoidance, not durable exactly-once).
 * A future subsystem needing a genuinely durable cross-machine "one per incident"
 * contract can be given a different backing without touching the breaker.
 */
export interface IncidentDedupe {
  /** Returns true at most once per `incidentKey` within `ttlMs`. Returning true
   *  RECORDS the emission. */
  shouldEmit(incidentKey: string, ttlMs: number): boolean;
}

/**
 * Simple in-process TTL-map backing (spec C4: best-effort, in-process coalescing +
 * TTL). Bounded to `maxEntries` (oldest-evicted) so a high-cardinality key stream
 * can never grow it unbounded. Injectable clock for tests.
 */
export class InProcessIncidentDedupe implements IncidentDedupe {
  /** incidentKey -> epoch ms at which the coalescing window expires. */
  private readonly expiry = new Map<string, number>();
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now(), maxEntries = 512) {
    this.now = now;
    this.maxEntries = Math.max(1, maxEntries);
  }

  shouldEmit(incidentKey: string, ttlMs: number): boolean {
    const now = this.now();
    const existing = this.expiry.get(incidentKey);
    if (existing != null && now < existing) {
      // Still inside the coalescing window — already emitted for this incident.
      return false;
    }
    // Fresh emission — record it (re-insert so it moves to newest for eviction).
    this.expiry.delete(incidentKey);
    this.expiry.set(incidentKey, now + Math.max(0, ttlMs));
    this.evictIfNeeded();
    return true;
  }

  /** Drop the oldest entry while over the cap (insertion-ordered Map). */
  private evictIfNeeded(): void {
    while (this.expiry.size > this.maxEntries) {
      const oldest = this.expiry.keys().next().value;
      if (oldest === undefined) break;
      this.expiry.delete(oldest);
    }
  }
}
