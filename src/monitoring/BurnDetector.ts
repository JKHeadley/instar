/**
 * BurnDetector — emits a structured signal when a single attribution_key
 * crosses configured spend thresholds.
 *
 * Phase 3 of docs/specs/token-burn-detection-and-self-heal.md.
 *
 * Signal-only (per umbrella spec §"Signal-vs-Authority Decomposition"): the
 * detector emits to the existing DegradationReporter. The Phase 4 runbook
 * (Tier-2 Remediator surface) is the only authority that decides whether
 * to alert / throttle / both. The BurnDetector cannot decide anything.
 *
 * Triggers (OR'd):
 *   1. Absolute share — a single attribution_key consumed > absoluteShareThreshold
 *      of total 24h spend.
 *   2. Baseline divergence — the key's last-1h rate is > rollingBaselineMultiplier ×
 *      its trailing-7-day median rate, AND the 1h rate exceeds rollingBaselineFloor
 *      tokens/h.
 *
 * Cold-start (per umbrella spec §"Threshold logic"): the baseline-divergence
 * trigger only fires after a key has been observed for 7 days. Until then,
 * absolute-share is the only signal — that's the trigger that would have
 * caught the 2026-05-15 incident.
 *
 * Polling cadence: 60s, decoupled from the ledger writer. The detector does
 * its own clock (injected `now`) so tests don't need to fake timers globally.
 */

import type { TokenLedger, AttributionKeyRow } from './TokenLedger.js';
import type { DegradationReporter } from './DegradationReporter.js';

export interface BurnDetectionConfig {
  enabled: boolean;
  /** Default 0.25 (25%). */
  absoluteShareThreshold: number;
  /** Default 2 (2x). */
  rollingBaselineMultiplier: number;
  /** Default 10_000_000 tokens/hour. */
  rollingBaselineFloor: number;
  /** Per-key alert cooldown (default 3_600_000ms = 1h). */
  perKeyAlertCooldownMs: number;
  /** Poll interval (default 60_000ms = 60s). */
  pollIntervalMs: number;
  /** Cold-start duration (default 7d). Baseline-divergence trigger disabled until elapsed. */
  coldStartMs: number;
}

export const DEFAULT_BURN_DETECTION_CONFIG: BurnDetectionConfig = {
  enabled: true,
  absoluteShareThreshold: 0.25,
  rollingBaselineMultiplier: 2,
  rollingBaselineFloor: 10_000_000,
  perKeyAlertCooldownMs: 3_600_000,
  pollIntervalMs: 60_000,
  coldStartMs: 7 * 24 * 60 * 60 * 1000,
};

export interface BurnSignal {
  attributionKey: string;
  trigger: 'absolute-share' | 'baseline-divergence';
  emittedAt: string;
  observed: {
    tokens24h: number;
    share24h: number;
    tokensLast1h: number;
    projectedDaily: number;
  };
  /** Trailing-7d median tokens/h. Only populated for `baseline-divergence`. */
  baselineMedian7d?: number;
}

export interface BurnDetectorDeps {
  ledger: Pick<TokenLedger, 'byAttributionKey' | 'summary'>;
  reporter: Pick<DegradationReporter, 'report'>;
  config?: Partial<BurnDetectionConfig>;
  /** Injectable clock for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export class BurnDetector {
  private readonly ledger: BurnDetectorDeps['ledger'];
  private readonly reporter: BurnDetectorDeps['reporter'];
  private readonly config: BurnDetectionConfig;
  private readonly now: () => number;
  /** First time a given attribution_key was seen. Used for cold-start cutoff. */
  private readonly firstSeen = new Map<string, number>();
  /** Last alert emit time per key — gates per-key alert cooldown. */
  private readonly lastAlertAt = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: BurnDetectorDeps) {
    this.ledger = deps.ledger;
    this.reporter = deps.reporter;
    this.config = { ...DEFAULT_BURN_DETECTION_CONFIG, ...(deps.config ?? {}) };
    this.now = deps.now ?? (() => Date.now());
  }

  start(): void {
    if (!this.config.enabled || this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        console.warn(`[burn-detector] tick error (non-fatal): ${(err as Error).message}`);
      }
    }, this.config.pollIntervalMs);
    // Prevent the interval from keeping the process alive on its own — the
    // server's lifecycle owns shutdown.
    if (this.timer && typeof (this.timer as { unref?: () => void }).unref === 'function') {
      (this.timer as { unref: () => void }).unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One detector cycle. Returns the signals emitted on this tick — useful
   * for tests, and the production loop ignores the return.
   */
  tick(): BurnSignal[] {
    if (!this.config.enabled) return [];
    const now = this.now();
    const since24h = now - 24 * 60 * 60 * 1000;
    const since1h = now - 60 * 60 * 1000;
    const since7d = now - 7 * 24 * 60 * 60 * 1000;

    const keys24h = this.ledger.byAttributionKey({ sinceMs: since24h });
    if (keys24h.length === 0) return [];
    const total24h = keys24h.reduce((sum, k) => sum + k.totalTokens, 0);
    if (total24h <= 0) return [];

    // Update first-seen map.
    for (const k of keys24h) {
      if (!this.firstSeen.has(k.attributionKey)) {
        this.firstSeen.set(k.attributionKey, k.firstTs);
      }
    }

    const signals: BurnSignal[] = [];
    const keys1h = this.ledger.byAttributionKey({ sinceMs: since1h });
    const keys1hMap = new Map(keys1h.map((k) => [k.attributionKey, k]));

    for (const key24h of keys24h) {
      const share = key24h.totalTokens / total24h;
      const key1h = keys1hMap.get(key24h.attributionKey);
      const tokens1h = key1h ? key1h.totalTokens : 0;
      const projectedDaily = tokens1h * 24;

      // Skip exempt runbook self-attribution prefix (defence in depth — Phase 4
      // runbook also exempts itself at the gate level).
      if (key24h.attributionKey.startsWith('burn-throttle-runbook::')) continue;

      // Cooldown.
      const lastAlert = this.lastAlertAt.get(key24h.attributionKey) ?? 0;
      if (now - lastAlert < this.config.perKeyAlertCooldownMs) continue;

      let trigger: BurnSignal['trigger'] | null = null;
      let baselineMedian7d: number | undefined;

      // Trigger 1 — absolute share.
      if (share > this.config.absoluteShareThreshold) {
        trigger = 'absolute-share';
      }

      // Trigger 2 — baseline divergence (only after cold-start window).
      if (!trigger) {
        const firstSeen = this.firstSeen.get(key24h.attributionKey) ?? key24h.firstTs;
        if (now - firstSeen >= this.config.coldStartMs && tokens1h >= this.config.rollingBaselineFloor) {
          // 7-day median rate (tokens/h). Use the simple per-key 7d total / 168
          // as a proxy when the table doesn't store hourly buckets — Phase 4 may
          // refine to a true median.
          const keys7d = this.ledger.byAttributionKey({ sinceMs: since7d });
          const key7d = keys7d.find((k) => k.attributionKey === key24h.attributionKey);
          if (key7d) {
            baselineMedian7d = key7d.totalTokens / (7 * 24);
            if (tokens1h > this.config.rollingBaselineMultiplier * baselineMedian7d) {
              trigger = 'baseline-divergence';
            }
          }
        }
      }

      if (!trigger) continue;

      const signal: BurnSignal = {
        attributionKey: key24h.attributionKey,
        trigger,
        emittedAt: new Date(now).toISOString(),
        observed: {
          tokens24h: key24h.totalTokens,
          share24h: share,
          tokensLast1h: tokens1h,
          projectedDaily,
        },
        baselineMedian7d,
      };
      signals.push(signal);
      this.lastAlertAt.set(key24h.attributionKey, now);

      // Emit to DegradationReporter. The runbook in Phase 4 will subscribe via
      // the existing Remediator dispatch and decide alert vs throttle.
      this.reporter.report({
        feature: 'token-burn-detection',
        primary: `attribution_key ${key24h.attributionKey} sustained spend within thresholds`,
        fallback: `signal-only: detector flagged the key (Phase 4 runbook will decide alert vs throttle)`,
        reason:
          trigger === 'absolute-share'
            ? `${key24h.attributionKey} consumed ${(share * 100).toFixed(1)}% of 24h spend (threshold ${(this.config.absoluteShareThreshold * 100).toFixed(0)}%)`
            : `${key24h.attributionKey} last-1h rate ${tokens1h.toLocaleString()} tok/h, baseline ${baselineMedian7d?.toLocaleString() ?? '?'} tok/h (multiplier ${this.config.rollingBaselineMultiplier}x)`,
        impact:
          `Projected ${projectedDaily.toLocaleString()} tokens in next 24h at current rate. ` +
          `Phase 3 is observation-only; Phase 4 wires alerting and bounded auto-throttle.`,
      });
    }

    return signals;
  }
}
