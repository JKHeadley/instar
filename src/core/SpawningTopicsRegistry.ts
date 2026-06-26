/**
 * SpawningTopicsRegistry — F7 Piece 1
 * (docs/specs/verify-after-reachability.md §Piece 1).
 *
 * Replaces the closure-local `Set<number>` that `onTopicMessage` used to guard against
 * double-spawning a topic. The Set was cleared ONLY in the spawn promise's `.finally`,
 * so a HUNG spawn left the flag set forever → every subsequent inbound for that topic
 * was silently skipped (the single-machine black-hole F7 surfaces). It carried no
 * timestamp and no token.
 *
 * This component is the SAFE minimum (round-2 review proved any external auto-CLEAR of
 * the flag relocates the double-spawn race, because the spawn body is non-cancellable):
 *  - `add(topic)` returns a unique TOKEN and stamps `startedAtMs`.
 *  - `clear(topic, token)` is TOKEN-GUARDED: it deletes ONLY if the live entry's token
 *    still matches — so a late `.finally` from a superseded spawn cannot delete a newer
 *    entry (the ABA fix). The `.finally` on a spawn's own settle remains the SOLE
 *    clearer; NO timeout and NO sweep clear the flag here.
 *  - `stuckSinceMs(topic, now)` lets the TopicReachabilityVerifier SURFACE a spawn that
 *    has been in flight past a threshold (it is never cleared — surfaced, not raced).
 *
 * The mechanical auto-recovery of a hung spawn (cancellable spawn) is a tracked
 * follow-up — see the spec.
 */

export interface SpawningEntry {
  /** Unique per-add token (NOT the topic — the ABA guard). */
  token: string;
  /** ms epoch when this spawn entered the registry. */
  startedAtMs: number;
}

export class SpawningTopicsRegistry {
  private readonly map = new Map<number, SpawningEntry>();
  private readonly now: () => number;
  private seq = 0;

  constructor(deps: { now?: () => number } = {}) {
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Mark `topic` as spawning. Returns a unique token the caller passes back to
   * `clear`. If an entry already exists (a retry that already landed), it is REPLACED
   * with a fresh token+timestamp — the new spawn supersedes the old, and the old
   * spawn's later `clear(old token)` becomes a no-op (ABA-safe).
   */
  add(topic: number): string {
    const token = `spawn:${topic}:${this.now().toString(36)}:${(this.seq++).toString(36)}`;
    this.map.set(topic, { token, startedAtMs: this.now() });
    return token;
  }

  /**
   * Token-guarded clear. Deletes the entry ONLY if its live token equals `token`.
   * A late `.finally` from a superseded spawn (whose token no longer matches) is a
   * no-op, so it can never delete a newer spawn's entry.
   */
  clear(topic: number, token: string): void {
    const e = this.map.get(topic);
    if (e && e.token === token) this.map.delete(topic);
  }

  /** Is `topic` currently marked spawning? (The hot-path double-spawn guard read.) */
  has(topic: number): boolean {
    return this.map.has(topic);
  }

  /**
   * If `topic` has been spawning since longer than now-startedAtMs, return that age in
   * ms; else undefined. The verifier uses this to detect a wedged spawn. NEVER clears.
   */
  stuckSinceMs(topic: number, nowMs: number = this.now()): number | undefined {
    const e = this.map.get(topic);
    if (!e) return undefined;
    return Math.max(0, nowMs - e.startedAtMs);
  }

  /** Snapshot of currently-spawning topics (for the verifier / status). */
  entries(): Array<{ topic: number; startedAtMs: number }> {
    return [...this.map.entries()].map(([topic, e]) => ({ topic, startedAtMs: e.startedAtMs }));
  }

  /** Count of in-flight spawns (naturally tiny — one per concurrent spawn). */
  size(): number {
    return this.map.size;
  }
}
