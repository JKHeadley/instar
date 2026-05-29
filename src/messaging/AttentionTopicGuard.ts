/**
 * AttentionTopicGuard — a per-source + global circuit breaker for forum-topic
 * creation. NOT a blocker: it is a DELIVERY SHAPER (same class as
 * SentinelNotifier), never a gate. It holds no authority over agent behavior or
 * information flow — it only changes the FORM of delivery (one coalesced topic +
 * a log line) for non-critical, high-volume notices, and never withholds a
 * critical notice or drops an item. See docs/signal-vs-authority.md (the rate-
 * counter / transport-dedup carve-outs).
 *
 * Built in response to the 2026-05-28 topic-spam flood (the SECOND such flood;
 * the first, 2026-05-22, produced the SentinelNotifier fix). Root cause both
 * times: `TelegramAdapter.createAttentionItem` spawns a BRAND-NEW forum topic
 * per attention item, and there was no structural gate stopping a housekeeping
 * feature from raising attention items at volume.
 *
 * It sits at the one chokepoint (createAttentionItem) and caps how many NEW
 * topics may be spawned in a rolling window — BOTH per source AND globally. Past
 * the budget, items are COALESCED into one running notice topic + logged. The
 * GLOBAL cap is load-bearing: a mis-wired feature that varies its `sourceContext`
 * per item would dodge a per-source-only budget, so once total topic creation in
 * the window exceeds the global ceiling, every further non-critical item — of any
 * source — coalesces into ONE shared global bucket. That makes the "a brand-new
 * mis-wired feature gets auto-throttled" guarantee hold regardless of source
 * cardinality.
 *
 * Invariants:
 *  - HIGH / URGENT (case-insensitive; CRITICAL treated as URGENT) ALWAYS get
 *    their own topic and are never counted. Critical messages are never coalesced.
 *  - No item is ever DROPPED. A coalesced item is still recorded in the attention
 *    store and written to the suppression audit log; only its per-item TOPIC is
 *    withheld.
 *
 * Pure logic, injectable clock, bounded memory — unit-testable in isolation.
 */

export interface AttentionTopicGuardConfig {
  /** When false, every item is allowed its own topic (pre-guard behavior). */
  enabled: boolean;
  /** Rolling window over which topic creations are counted. */
  windowMs: number;
  /** Max NEW topics a single source may spawn within `windowMs`. */
  maxTopicsPerSource: number;
  /**
   * Max NEW topics across ALL sources within `windowMs`. Backstop against a
   * source that varies its key per item to dodge the per-source budget. Past
   * this, non-critical items coalesce into one shared global bucket regardless
   * of source. Must be >= maxTopicsPerSource to be meaningful.
   */
  maxTopicsGlobal: number;
  /** Hard cap on distinct source keys tracked (memory bound). */
  maxTrackedSources: number;
}

export const DEFAULT_ATTENTION_TOPIC_GUARD: AttentionTopicGuardConfig = {
  enabled: true,
  windowMs: 10 * 60 * 1000,
  maxTopicsPerSource: 3,
  maxTopicsGlobal: 8,
  maxTrackedSources: 512,
};

/** The shared key used when the GLOBAL cap (not a per-source cap) trips. */
export const GLOBAL_BUCKET = '*';

export type GuardDecision =
  | { action: 'allow' }
  | { action: 'coalesce'; firstInEpisode: boolean; suppressedCount: number; bucket: string };

/** Priorities that always get their own topic and are never counted. */
const CRITICAL_PRIORITIES = new Set(['HIGH', 'URGENT', 'CRITICAL']);

function coerceNum(v: unknown, fallback: number, { int = false, min = 0 }: { int?: boolean; min?: number } = {}): number {
  const n = typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n) || n < min) return fallback;
  return int ? Math.floor(n) : n;
}

export class AttentionTopicGuard {
  private readonly cfg: AttentionTopicGuardConfig;
  private readonly now: () => number;
  /** source key -> timestamps of recent topic-relevant events within the window. */
  private readonly events = new Map<string, number[]>();
  /** bucket key -> count of items coalesced in the CURRENT (uninterrupted) episode. */
  private readonly episode = new Map<string, number>();
  /** Global rolling timeline of topic-relevant events (all sources). */
  private globalEvents: number[] = [];

  constructor(cfg: Partial<AttentionTopicGuardConfig> = {}, now: () => number = () => Date.now()) {
    // Validate/coerce: a fat-fingered NaN/negative must NOT silently disable the
    // guard (NaN comparisons are always false → it would never trip).
    const d = DEFAULT_ATTENTION_TOPIC_GUARD;
    const windowMs = coerceNum(cfg.windowMs, d.windowMs, { min: 1 });
    const maxTopicsPerSource = coerceNum(cfg.maxTopicsPerSource, d.maxTopicsPerSource, { int: true, min: 0 });
    this.cfg = {
      enabled: cfg.enabled !== false,
      windowMs,
      maxTopicsPerSource,
      // Independent global ceiling. A LOW global with a HIGH per-source budget is
      // the intended high-cardinality config (cap total topics regardless of how
      // many distinct source keys appear), so we do NOT clamp it up to per-source.
      maxTopicsGlobal: coerceNum(cfg.maxTopicsGlobal, d.maxTopicsGlobal, { int: true, min: 1 }),
      maxTrackedSources: coerceNum(cfg.maxTrackedSources, d.maxTrackedSources, { int: true, min: 1 }),
    };
    this.now = now;
  }

  get config(): Readonly<AttentionTopicGuardConfig> {
    return this.cfg;
  }

  /**
   * Decide whether an item from `source` at `priority` may spawn its own topic.
   * Returns the coalesce `bucket` (the source key, or GLOBAL_BUCKET when only the
   * global cap tripped) so the adapter routes all global-flood notices into ONE
   * shared topic rather than one-per-varying-source.
   */
  decide(source: string | undefined, priority: string | undefined): GuardDecision {
    if (!this.cfg.enabled) return { action: 'allow' };
    const p = (priority ?? '').toUpperCase();
    if (CRITICAL_PRIORITIES.has(p)) return { action: 'allow' };

    const key = source && source.trim() ? source : 'unknown';
    const now = this.now();
    const cutoff = now - this.cfg.windowMs;

    const perRecent = (this.events.get(key) ?? []).filter((t) => t >= cutoff);
    this.globalEvents = this.globalEvents.filter((t) => t >= cutoff);

    const perTripped = perRecent.length >= this.cfg.maxTopicsPerSource;
    const globalTripped = this.globalEvents.length >= this.cfg.maxTopicsGlobal;

    // Record this event in both timelines so a sustained flood keeps the window
    // full and stays in a single coalesce episode.
    perRecent.push(now);
    this.events.set(key, perRecent);
    this.globalEvents.push(now);
    this.evictStaleSources(cutoff);

    if (perTripped || globalTripped) {
      // Per-source flood → coalesce under the source (one topic per flooding
      // source). Global-only flood (many low-volume sources) → coalesce under the
      // shared global bucket (one topic total), defeating key-variation dodges.
      const bucket = perTripped ? key : GLOBAL_BUCKET;
      const count = (this.episode.get(bucket) ?? 0) + 1;
      this.episode.set(bucket, count);
      return { action: 'coalesce', firstInEpisode: count === 1, suppressedCount: count, bucket };
    }

    // Under both budgets: own topic, and any prior episode for this source is over.
    this.episode.set(key, 0);
    return { action: 'allow' };
  }

  /** Drop source keys whose events have all aged out, and hard-cap map size. */
  private evictStaleSources(cutoff: number): void {
    if (this.events.size <= this.cfg.maxTrackedSources) {
      // cheap path: nothing to do until we approach the cap.
      return;
    }
    for (const [k, ts] of this.events) {
      const live = ts.filter((t) => t >= cutoff);
      if (live.length === 0) {
        this.events.delete(k);
        this.episode.delete(k);
      } else {
        this.events.set(k, live);
      }
    }
    // If still over the cap (many genuinely-active sources), drop the oldest.
    while (this.events.size > this.cfg.maxTrackedSources) {
      const oldest = this.events.keys().next().value;
      if (oldest === undefined) break;
      this.events.delete(oldest);
      this.episode.delete(oldest);
    }
  }

  /** Test/inspection seam. */
  episodeCount(bucket: string): number {
    return this.episode.get(bucket && bucket.trim() ? bucket : 'unknown') ?? 0;
  }

  /** Test/inspection seam — number of distinct source keys currently tracked. */
  get trackedSourceCount(): number {
    return this.events.size;
  }
}
