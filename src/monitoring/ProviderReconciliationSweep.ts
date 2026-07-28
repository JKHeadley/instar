/**
 * ProviderReconciliationSweep — the Layer-1c cross-check the operator directive
 * asks for (docs/specs/routing-control-room-spend-alerts.md §Layer 1c):
 * a cadenced, REPORTING-side sweep comparing, per (keyRef, door) over a
 * trailing window, the internally-derived spend against the provider-reported
 * spend (and, where this machine is the metered-lease holder, against the
 * ledger's committed figure — booked-vs-reported, FD-11's invoice-drift made
 * per-call and faster than a monthly invoice).
 *
 * NAMED DISTINCTLY from the money layer's RESERVE-EXPIRY sweep because they
 * must never be conflated (spec vocabulary): this sweep NEVER takes the
 * per-key money lock, never touches ledger rows, and runs entirely on the
 * reporting side — it READS the committed totals through the same read surface
 * the caps view uses.
 *
 * Direction + safety (one-way, matching the re-pricing rule):
 *  - provider LOWER than booked → the REPORT shows the lower figure; the
 *    committed counter is NEVER lowered (no re-opened headroom).
 *  - provider HIGHER than booked → a DRIFT SIGNAL: above
 *    `routingSpend.reconciliation.driftAlertPct` it feeds the Increment-C
 *    emitter (`onReconciliationDrift` — informational lane, PIN promotion is
 *    the human path); below it, recorded silently (Near-Silent).
 *
 * No feedback loop: the sweep's output never changes its input (prices and
 * provider reports are external facts), so its only self-action is the drift
 * ALERT — which rides the Increment-C dispatcher latch (24h re-arm per
 * (keyRef, door, driftBucket)); the `spend-recon-sweep` convergence model pins
 * once-per-bucket emission under permanently-drifting pressure.
 */

import type { ProviderCostReportStore } from './ProviderCostReportStore.js';

export interface ReconciliationSweepDeps {
  store: ProviderCostReportStore;
  /**
   * The internally-derived spend per (keyRef, door) over [sinceMs, untilMs] —
   * tokens × as-of price from the reporting side (feature_metrics + price
   * authority). Injected so the sweep stays a pure comparator.
   */
  internalDerivedUsd: (sinceMs: number, untilMs: number) => Array<{ keyRef: string; door: string; internalUsd: number }>;
  /**
   * The committed figure per keyRef from the caps READ surface (never the
   * money lock). Null on a machine that is not the metered-lease holder.
   */
  committedUsd?: (keyRef: string) => number | null;
  /** The Increment-C emit surface (already live + convergence-modeled). */
  onDrift?: (keyRef: string, door: string, driftPct: number) => void;
  /** Alert threshold (percent, default 10). Below it: recorded silently. */
  driftAlertPct?: number;
  /** Trailing window (default 24h). */
  windowMs?: number;
  now?: () => number;
}

export class ProviderReconciliationSweep {
  private readonly d: ReconciliationSweepDeps;
  private readonly now: () => number;

  constructor(deps: ReconciliationSweepDeps) {
    this.d = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * One reconciliation pass: compare provider-reported vs internal-derived per
   * (keyRef, door) over the trailing window, append a recon record for every
   * pair that has EITHER side, and raise the drift signal above the threshold.
   * Read-only against every other store; never throws (a failed pass retries
   * on the next cadence).
   */
  run(): { compared: number; drifted: number } {
    try {
      const until = this.now();
      const since = until - (this.d.windowMs ?? 24 * 60 * 60 * 1000);
      const provider = this.d.store.windowTotals(since, until);
      const internal = this.d.internalDerivedUsd(since, until);
      const byKey = new Map<string, { keyRef: string; door: string; internalUsd: number; providerUsd: number | null }>();
      for (const i of internal) {
        byKey.set(`${i.keyRef} ${i.door}`, { keyRef: i.keyRef, door: i.door, internalUsd: i.internalUsd, providerUsd: null });
      }
      for (const p of provider) {
        const k = `${p.keyRef} ${p.door}`;
        const e = byKey.get(k) ?? { keyRef: p.keyRef, door: p.door, internalUsd: 0, providerUsd: null };
        e.providerUsd = p.providerCostUsd;
        byKey.set(k, e);
      }
      let drifted = 0;
      for (const e of byKey.values()) {
        // Signed drift only when BOTH sides exist and internal is non-trivial
        // (a $0 internal base would make any provider figure infinite drift).
        const drift =
          e.providerUsd !== null && e.internalUsd > 0.000001
            ? Math.round(((e.providerUsd - e.internalUsd) / e.internalUsd) * 1000) / 10
            : null;
        this.d.store.appendRecon({
          keyRef: e.keyRef,
          door: e.door,
          windowStartMs: since,
          windowEndMs: until,
          internalUsd: e.internalUsd,
          providerUsd: e.providerUsd,
          committedUsd: this.d.committedUsd?.(e.keyRef) ?? null,
          driftPct: drift,
        });
        if (drift !== null && Math.abs(drift) >= (this.d.driftAlertPct ?? 10)) {
          drifted += 1;
          try {
            this.d.onDrift?.(e.keyRef, e.door, drift);
          } catch {
            // @silent-fallback-ok: the drift signal is a notifier — a throwing
            // consumer never breaks the reporting sweep.
          }
        }
      }
      return { compared: byKey.size, drifted };
    } catch {
      // @silent-fallback-ok: the sweep is cadenced observability — a failed pass
      // records nothing and retries next tick; it must never disturb the server.
      return { compared: 0, drifted: 0 };
    }
  }
}
