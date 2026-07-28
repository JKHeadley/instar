/**
 * OscillationBreaker — the F6 oscillation brake for the seamless orchestrator
 * (spec: llm-seamlessness-orchestrator.md §F6 + Tier-1 "oscillation breaker blacklists + raises one item").
 *
 * A topic that thrashes — ≥ maxActuationsPerWindow actuations inside oscillationWindowMs — is
 * BLACKLISTED for blacklistTtlMs: the engine suppresses it from proposals (via the injected
 * `isBlacklisted` seam) and stops churning it. The blacklist trip is reported ONCE per episode
 * (`recordActuation` returns true exactly on the transition into blacklisted) so the wiring raises
 * exactly ONE deduped attention item, never a per-tick flood (No-Unbounded-Loops / Bounded
 * Notification Surface).
 *
 * Machine-local for the first (dark/dryRun) ship: in dryRun nothing actuates, so the window is
 * always empty and the breaker is inert — it only becomes load-bearing once the operator flips the
 * P4 auto-prefetch increment live. Replicating this blacklist via the WS2 store (so "don't move
 * topic T again" survives a lease failover, spec line 85) is a TRACKED follow-up gated on that same
 * P4-live flip; a machine-local breaker degrades safely (a failover re-learns the thrash) and never
 * moves anything on its own.
 */
export interface OscillationBreakerConfig {
  /** actuations within the window that trip the blacklist. Default 3 (spec F6: "3 moves in a window"). */
  maxActuationsPerWindow: number;
  /** the sliding window (ms) over which actuations are counted. Default 1h. */
  oscillationWindowMs: number;
  /** how long a blacklisted topic stays suppressed (ms). Default 24h. */
  blacklistTtlMs: number;
}

export const DEFAULT_OSCILLATION_CONFIG: OscillationBreakerConfig = {
  maxActuationsPerWindow: 3,
  oscillationWindowMs: 60 * 60_000,
  blacklistTtlMs: 24 * 60 * 60_000,
};

export class OscillationBreaker {
  private readonly cfg: OscillationBreakerConfig;
  private readonly now: () => number;
  /** per-topic actuation timestamps (sliding window; pruned on each record/query). */
  private readonly history = new Map<number, number[]>();
  /** per-topic blacklist-until timestamp. */
  private readonly blacklistedUntil = new Map<number, number>();

  constructor(config?: Partial<OscillationBreakerConfig>, now?: () => number) {
    this.cfg = { ...DEFAULT_OSCILLATION_CONFIG, ...config };
    this.now = now ?? (() => Date.now());
  }

  /**
   * Record an actuation for a topic. Returns TRUE only on the transition INTO blacklisted
   * (so the caller raises exactly one attention item per episode); false otherwise.
   */
  recordActuation(topic: number, at?: number): boolean {
    const t = at ?? this.now();
    const cutoff = t - this.cfg.oscillationWindowMs;
    const times = (this.history.get(topic) ?? []).filter((ts) => ts > cutoff);
    times.push(t);
    this.history.set(topic, times);

    const already = this.isBlacklisted(topic, t);
    if (!already && times.length >= this.cfg.maxActuationsPerWindow) {
      this.blacklistedUntil.set(topic, t + this.cfg.blacklistTtlMs);
      return true; // the one-shot trip signal
    }
    return false;
  }

  /** True while the topic's blacklist window is active (expired entries self-clear). */
  isBlacklisted(topic: number, at?: number): boolean {
    const until = this.blacklistedUntil.get(topic);
    if (until === undefined) return false;
    const t = at ?? this.now();
    if (t >= until) { this.blacklistedUntil.delete(topic); return false; }
    return true;
  }

  /** The currently-blacklisted topics (for the /audit surface). */
  blacklistedTopics(at?: number): number[] {
    const t = at ?? this.now();
    return [...this.blacklistedUntil.keys()].filter((topic) => this.isBlacklisted(topic, t));
  }
}
