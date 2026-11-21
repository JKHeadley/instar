/**
 * The fold benefit estimator (context-budget-layered-summaries §7.2 "Benefit,
 * floor, and the two caps"; Phase 2 slice P2-5).
 *
 *   break-even turns = total incremental fold cost ÷ per-turn saving after the fold
 *
 * compared with the expected remaining turns; a fold is worth asking for when
 * expected remaining turns ≥ break-even × margin (default 1.5×). Everything is
 * in COST-WEIGHTED token units (the §11 weights: cache read, cache write,
 * uncached input, output at their relative prices), so a warm-cache handoff and
 * a cold one cost what they really cost.
 *
 *  - **Cost**: the handoff turn (the live context re-read, priced by cache
 *    state, plus its output), any send-back turns, the packet's cache write,
 *    and the fixed fold calls (audit, probe generation, probe turns, grading)
 *    measured in Phase 0 / Phase 2 and passed in.
 *  - **Saving per turn**: the context no longer re-read each turn
 *    (live − packet), priced at the cache-read rate — the steady-state rate a
 *    long session pays, and a lower bound.
 *  - **Expected remaining turns**: the trailing turn rate over a horizon plus a
 *    per-open-thread allowance (a deterministic read of H1's open threads, not
 *    a model call). Both constants are named inputs, calibrated from Phase 2.
 *  - **Cache-blind engines** (no cache accounting, §9.6) are conservative on
 *    both sides: the saving at the cache-read rate (lower bound) and EVERY cost
 *    term at the uncached rate (upper bound), so the fold is never over-sold.
 *  - **`unknown`** is reserved for poller lag (the live size cannot be read);
 *    no fold is proposed on `unknown`, never on a missing cost model.
 *
 * Cap 1 (the critical checkpoint): turns-to-wall against the effective
 * auto-compact window; critical when it falls to the headroom for one handoff
 * turn plus one packet write at the recent growth rate.
 *
 * Signal only: the estimator says whether asking is worth it; the runner asks.
 */
import { COST_WEIGHTS, type CostWeights } from './contextBudgetMetrics.js';

export const BENEFIT_DEFAULTS = {
  margin: 1.5,
  /** Expected-remaining horizon over the trailing turn rate (hours). */
  horizonHours: 1,
  /** Turns allowed per open thread in H1. basis: cost default, calibrated from Phase 2 data. */
  turnsPerOpenThread: 4,
} as const;

export interface FoldCostTerms {
  /** Output tokens of the handoff turn (and of each send-back). */
  handoffOutputTokens: number;
  /** Send-back turns expected (0 normally; the audit may send back once). */
  sendBacks: number;
  /** Fixed fold calls, in uncached-input-equivalent tokens: audit, probe generation, probe turns, grading. */
  fixedTokens: number;
}

export interface BenefitInput {
  /** The live context size in tokens; null while the ledger poller lags the live file (⇒ unknown). */
  liveContextTokens: number | null;
  packetTokens: number;
  /** `accounted`: the engine reports cache reads/writes; `blind`: it does not (§9.6). */
  cache: 'accounted' | 'blind';
  /** The prompt cache is warm right now (right after a reply, before the TTL). */
  warm: boolean;
  costs: FoldCostTerms;
  /** Turns per hour over the trailing window; null when there is no history (counts as 0). */
  trailingTurnsPerHour: number | null;
  openThreads: number;
  weights?: CostWeights;
  margin?: number;
  horizonHours?: number;
  turnsPerOpenThread?: number;
}

export type BenefitEstimate =
  | { status: 'unknown'; reason: string }
  | {
      status: 'ok';
      cost: number;
      savingPerTurn: number;
      /** Infinity when the fold saves nothing per turn. */
      breakEvenTurns: number;
      expectedRemainingTurns: number;
      margin: number;
      /** expected ≥ break-even × margin. */
      worthAsking: boolean;
      /** Below break-even: folding costs more tokens than it saves (the no-fold floor). */
      belowFloor: boolean;
      terms: { handoff: number; sendBacks: number; packetWrite: number; fixed: number };
    };

const finite = (n: number) => Number.isFinite(n) && n >= 0;

export function estimateFoldBenefit(i: BenefitInput): BenefitEstimate {
  if (i.liveContextTokens === null) return { status: 'unknown', reason: 'the live context size is behind the ledger poller' };
  if (!finite(i.liveContextTokens) || !finite(i.packetTokens) || !finite(i.costs.handoffOutputTokens) || !finite(i.costs.fixedTokens) || !finite(i.costs.sendBacks) || !finite(i.openThreads)) {
    return { status: 'unknown', reason: 'an input is not a finite, non-negative number' };
  }
  const w = i.weights ?? COST_WEIGHTS;
  const blind = i.cache === 'blind';
  // A context re-read: cache-read when the engine accounts for a warm cache, else uncached.
  const readRate = !blind && i.warm ? w.cacheRead : w.uncached;
  const handoffTurn = i.liveContextTokens * readRate + i.costs.handoffOutputTokens * w.output;
  const sendBack = i.costs.sendBacks * (i.liveContextTokens * (blind ? w.uncached : w.cacheRead) + i.costs.handoffOutputTokens * w.output);
  const packetWrite = i.packetTokens * (blind ? w.uncached : w.cacheWrite5m);
  const fixed = i.costs.fixedTokens * w.uncached;
  const cost = handoffTurn + sendBack + packetWrite + fixed;
  const savingPerTurn = Math.max(0, i.liveContextTokens - i.packetTokens) * w.cacheRead;
  const breakEvenTurns = savingPerTurn > 0 ? cost / savingPerTurn : Number.POSITIVE_INFINITY;
  const rate = i.trailingTurnsPerHour !== null && finite(i.trailingTurnsPerHour) ? i.trailingTurnsPerHour : 0;
  const expectedRemainingTurns = rate * (i.horizonHours ?? BENEFIT_DEFAULTS.horizonHours) + i.openThreads * (i.turnsPerOpenThread ?? BENEFIT_DEFAULTS.turnsPerOpenThread);
  const margin = i.margin ?? BENEFIT_DEFAULTS.margin;
  const round = (n: number) => (Number.isFinite(n) ? +n.toFixed(2) : n);
  return {
    status: 'ok',
    cost: round(cost), savingPerTurn: round(savingPerTurn), breakEvenTurns: round(breakEvenTurns),
    expectedRemainingTurns: round(expectedRemainingTurns), margin,
    worthAsking: Number.isFinite(breakEvenTurns) && expectedRemainingTurns >= breakEvenTurns * margin,
    belowFloor: !Number.isFinite(breakEvenTurns) || expectedRemainingTurns < breakEvenTurns,
    terms: { handoff: round(handoffTurn), sendBacks: round(sendBack), packetWrite: round(packetWrite), fixed: round(fixed) },
  };
}

export interface CapOneInput {
  liveContextTokens: number | null;
  /** The effective auto-compact window actually set at spawn (§9.5); null when unknown. */
  windowTokens: number | null;
  /** Recent context growth per turn, from the ledger scan; null when unknown. */
  growthPerTurn: number | null;
  handoffOutputTokens: number;
  packetTokens: number;
}

export type CapOneEstimate =
  | { status: 'unknown'; reason: string }
  | { status: 'ok'; turnsToWall: number; floorTurns: number; critical: boolean };

/** Cap 1 (§7.2): unknown ⇒ no checkpoint request (the backstop only, §17 row "Cap 1 turns-to-wall"). */
export function capOne(i: CapOneInput): CapOneEstimate {
  if (i.liveContextTokens === null || i.windowTokens === null || i.growthPerTurn === null) return { status: 'unknown', reason: 'the live size, the window or the growth rate is unknown' };
  if (!(i.growthPerTurn > 0)) return { status: 'ok', turnsToWall: Number.POSITIVE_INFINITY, floorTurns: 0, critical: false };
  const turnsToWall = Math.max(0, (i.windowTokens - i.liveContextTokens) / i.growthPerTurn);
  // Headroom for one handoff turn plus one packet write, at the recent growth rate.
  const floorTurns = (i.handoffOutputTokens + i.packetTokens) / i.growthPerTurn;
  return { status: 'ok', turnsToWall: +turnsToWall.toFixed(2), floorTurns: +floorTurns.toFixed(2), critical: turnsToWall <= floorTurns };
}
