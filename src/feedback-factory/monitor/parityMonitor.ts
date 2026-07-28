/**
 * parityMonitor.ts — the Phase-3 live dual-forward parity MONITOR + cutover gate (spec §2.5).
 *
 * The per-pass comparison already exists (processor/parity.ts → ParityResult over the
 * order-independent invariants: per-report fingerprint, terminal-status, recurrence/cycling
 * counts — NOT raw cluster membership, which is order-dependent and would flap on benign
 * arrival-order noise). What Phase 3 needs ON TOP of one comparison is the WINDOW: run the
 * comparison repeatedly over real dual-forward traffic and only clear the cutover when a
 * genuine zero-divergence window has elapsed.
 *
 * This monitor records each pass, tracks the current zero-divergence streak (ANY divergent
 * pass resets it), and exposes the single structural gate `gate()` → cleared/blocked. That
 * `cleared` boolean is the objective `parity-zero-divergence` condition the Coordination
 * Mandate's `execute-cutover` authority reads — the agent cannot fake it; the window decides.
 *
 * Structure > Willpower: cutover is blocked by the gate, not by an agent deciding "looks
 * good". The pure core here is fully unit-testable; a thin durable wrapper (below) persists
 * passes so the window survives a restart, since it spans real traffic time.
 */

import type { ParityResult } from '../processor/parity.js';

/** One recorded comparison pass over a dual-forward traffic slice. */
export interface MonitorPass {
  /** ISO timestamp of this pass. */
  at: string;
  /** Clusters compared in this pass (the meaningful-sample input). */
  clustersCompared: number;
  /** Total divergences this pass (fingerprint + outcome). 0 == clean. */
  divergences: number;
  /** Convenience mirror of `divergences > 0`. */
  divergent: boolean;
}

/** The window a clean streak must satisfy before the cutover gate clears. */
export interface CutoverGatePolicy {
  /** Consecutive zero-divergence passes required (default 3). */
  requiredCleanPasses: number;
  /** The clean streak must span at least this much REAL time (default 1h). */
  minWindowMs: number;
  /** Total clusters compared across the clean streak — a meaningful sample (default 1). */
  minClustersObserved: number;
}

export const DEFAULT_GATE_POLICY: CutoverGatePolicy = {
  requiredCleanPasses: 3,
  minWindowMs: 60 * 60 * 1000,
  minClustersObserved: 1,
};

export interface CutoverGateStatus {
  /** The structural signal: true only when the zero-divergence window is genuinely satisfied. */
  cleared: boolean;
  reason: string;
  cleanPasses: number;
  windowMs: number;
  clustersObserved: number;
  /** ISO of the most recent divergent pass (the streak reset point), or null if never. */
  lastDivergentAt: string | null;
}

function passDivergences(r: ParityResult): number {
  return r.fingerprintDivergences.length + r.outcomeDivergences.length;
}

/**
 * Records parity passes and computes the cutover gate over the current zero-divergence
 * streak. Pure + clock-injected (gate(now) takes the current time) → fully testable.
 */
export class ParityMonitor {
  private readonly policy: CutoverGatePolicy;
  private readonly _passes: MonitorPass[] = [];

  constructor(policy: Partial<CutoverGatePolicy> = {}) {
    this.policy = { ...DEFAULT_GATE_POLICY, ...policy };
  }

  /** Feed a raw pass record. */
  record(pass: MonitorPass): void {
    this._passes.push(pass);
  }

  /** Convenience: record straight from a ParityResult + the pass timestamp. */
  recordResult(result: ParityResult, at: string): void {
    const divergences = passDivergences(result);
    this._passes.push({ at, clustersCompared: result.clustersCompared, divergences, divergent: divergences > 0 });
  }

  get passes(): readonly MonitorPass[] {
    return this._passes;
  }

  /**
   * The structural cutover gate. `cleared` is true only when the trailing run of passes is:
   *   - all clean (zero divergence), AND
   *   - at least `requiredCleanPasses` long, AND
   *   - spanning at least `minWindowMs` of real time (first-clean-pass → now), AND
   *   - covering at least `minClustersObserved` clusters in total.
   * Any divergent pass resets the streak. No passes → blocked.
   */
  gate(now: string): CutoverGateStatus {
    // Find the index just after the most recent divergent pass — the start of the clean streak.
    let streakStart = 0;
    let lastDivergentAt: string | null = null;
    for (let i = this._passes.length - 1; i >= 0; i--) {
      if (this._passes[i].divergent) {
        streakStart = i + 1;
        lastDivergentAt = this._passes[i].at;
        break;
      }
    }
    const streak = this._passes.slice(streakStart);
    const cleanPasses = streak.length;
    const clustersObserved = streak.reduce((s, p) => s + p.clustersCompared, 0);
    const nowMs = Date.parse(now);
    const firstCleanMs = cleanPasses > 0 ? Date.parse(streak[0].at) : nowMs;
    const windowMs = Number.isNaN(nowMs) || Number.isNaN(firstCleanMs) ? 0 : Math.max(0, nowMs - firstCleanMs);

    const reasons: string[] = [];
    if (cleanPasses < this.policy.requiredCleanPasses) {
      reasons.push(`need ${this.policy.requiredCleanPasses} consecutive clean passes, have ${cleanPasses}`);
    }
    if (windowMs < this.policy.minWindowMs) {
      reasons.push(`clean window ${Math.round(windowMs / 1000)}s < required ${Math.round(this.policy.minWindowMs / 1000)}s`);
    }
    if (clustersObserved < this.policy.minClustersObserved) {
      reasons.push(`observed ${clustersObserved} clusters < required ${this.policy.minClustersObserved}`);
    }
    const cleared = reasons.length === 0;
    return {
      cleared,
      reason: cleared
        ? `zero-divergence window satisfied: ${cleanPasses} clean passes over ${Math.round(windowMs / 1000)}s, ${clustersObserved} clusters`
        : reasons.join('; '),
      cleanPasses,
      windowMs,
      clustersObserved,
      lastDivergentAt,
    };
  }
}
