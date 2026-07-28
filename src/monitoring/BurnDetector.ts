/**
 * BurnDetector — emits a structured signal when a single attribution_key
 * crosses configured fresh-cost thresholds. Cache reads remain visible in the
 * ledger's gross totals but never increase burn share or rate.
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
import { PRE_ATTRIBUTION_KEY } from './AttributionResolver.js';

/** Backward-compatible for test doubles and older ledger adapters. */
function burnTokens(row: AttributionKeyRow): number {
  return row.freshTokens ?? row.totalTokens;
}

export interface BurnDetectionConfig {
  enabled: boolean;
  /** Default 0.25 (25%). */
  absoluteShareThreshold: number;
  /**
   * Minimum last-1h tokens for the ABSOLUTE-SHARE trigger to fire. A key whose
   * trailing-24h share is high but whose CURRENT (last-1h) spend is at or below
   * this floor is not actively burning — it is a finished burst still sitting
   * inside the 24h window. Gating on it closes the "consumed 67% of 24h spend …
   * Projected 0 tokens in next 24h" false alarm that otherwise re-fires every
   * cooldown for a full day after one heavy session ends. Default 0 → require
   * strictly positive recent activity. (The baseline-divergence trigger already
   * has its own activity floor, `rollingBaselineFloor`.)
   */
  absoluteShareActivityFloorTokens: number;
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
  absoluteShareActivityFloorTokens: 0,
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
  /**
   * Model-tier escalation §8 mid-run cap monitor (UltraSessionCapMonitor).
   * Rides THIS detector's tick cadence so no new poller exists
   * (FABLE-MODEL-ESCALATION-SPEC round-3 Integration-NEW-2). Its tick()
   * never throws. Optional — absent on agents without the feature wired.
   */
  ultraCapMonitor?: { tick(): void };
}

export class BurnDetector {
  private readonly ledger: BurnDetectorDeps['ledger'];
  private readonly reporter: BurnDetectorDeps['reporter'];
  private readonly config: BurnDetectionConfig;
  private readonly now: () => number;
  private readonly ultraCapMonitor?: { tick(): void };
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
    this.ultraCapMonitor = deps.ultraCapMonitor;
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
    // §8 ultra-cap monitor rides this cadence — BEFORE the empty-ledger
    // early-returns below, so a quiet attribution ledger can't starve the
    // per-session cap check. Its tick() is self-guarding (never throws).
    this.ultraCapMonitor?.tick();
    const now = this.now();
    const since24h = now - 24 * 60 * 60 * 1000;
    const since1h = now - 60 * 60 * 1000;
    const since7d = now - 7 * 24 * 60 * 60 * 1000;

    const keys24h = this.ledger.byAttributionKey({ sinceMs: since24h });
    if (keys24h.length === 0) return [];
    const total24h = keys24h.reduce((sum, k) => sum + burnTokens(k), 0);
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
      const tokens24h = burnTokens(key24h);
      const share = tokens24h / total24h;
      const key1h = keys1hMap.get(key24h.attributionKey);
      const tokens1h = key1h ? burnTokens(key1h) : 0;
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
      //
      // The PRE_ATTRIBUTION_KEY sentinel ("resolver never ran") is EXEMPT from
      // this trigger. A bucket at 100% share under the sentinel means "we
      // don't attribute these events yet" — a coverage gap — not "one
      // component is burning." Before attribution was wired, every event sat
      // under this sentinel, so absolute-share fired forever (the false
      // positive this change closes). Per the umbrella spec §"Threshold
      // logic", the sentinel is a coverage signal, never an absolute-share
      // burn trigger. The genuinely-residual `unknown::<sessionId>` key
      // (resolver ran, found no match) is NOT exempt and still alerts —
      // that's the spec's "alert on unattributable spend." Baseline-divergence
      // (trigger 2) is intentionally still allowed on the sentinel: a sudden
      // spike of NEW unattributed spend vs its own 7-day history is worth
      // surfacing even though its absolute share is not.
      //
      // ACTIVITY GATE: absolute-share also requires the key to be actively
      // spending right now (last-1h tokens above absoluteShareActivityFloorTokens).
      // A burn alert means "something is spending heavily NOW" — a key whose
      // 24h share is high but whose current rate is ~zero is a FINISHED burst
      // still inside the trailing window, not a live burn. Without this gate one
      // heavy session re-tripped the 25% alarm every cooldown for a full 24h
      // with a self-contradictory "consumed 67% of 24h spend … Projected 0
      // tokens" message (the 2026-06-03 noise incident). The baseline-divergence
      // trigger already gates on rollingBaselineFloor; this brings the
      // absolute-share trigger to parity.
      const isPreAttributionSentinel = key24h.attributionKey === PRE_ATTRIBUTION_KEY;
      const isActivelySpending = tokens1h > this.config.absoluteShareActivityFloorTokens;
      if (!isPreAttributionSentinel && isActivelySpending && share > this.config.absoluteShareThreshold) {
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
            baselineMedian7d = burnTokens(key7d) / (7 * 24);
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
          tokens24h,
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
          `Projected ${projectedDaily.toLocaleString()} tokens in next 24h at the current rate.`,
      });
    }

    return signals;
  }
}
