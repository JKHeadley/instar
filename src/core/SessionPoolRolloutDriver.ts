/**
 * SessionPoolRolloutDriver — the cadenced DRIVER for the Multi-Machine Session
 * Pool rollout gate (§Rollout, Track H). `StageAdvancer` is the mechanical gate
 * (the SOLE writer of `multiMachine.sessionPool.stage`, gated on a green prior-
 * stage E2E, auto-reverting on red) — but the gate is inert on its own: a
 * StageAdvancer that nothing CALLS never advances anything. The track-H wiring
 * note says so explicitly: "StageAdvancer is constructed but not driven yet — the
 * rollout job that calls advanceTo/reconcile is a later step."
 *
 * That "later step" is this driver. On each `tick()` it:
 *   1. RECONCILES FIRST — a red regression on the current stage must revert to the
 *      prior safe stage BEFORE any advance is attempted (safety before progress).
 *   2. ATTEMPTS ONE ADVANCE toward an operator-authorized CEILING — at most one
 *      stage per tick, and never past the ceiling the operator opted the agent up
 *      to. The advance itself is still fully gated by `StageAdvancer.advanceTo`
 *      (green prior-stage E2E for the current commit) — this driver adds cadence
 *      and an operator ceiling, it NEVER weakens the gate.
 *
 * Why this matters (the 2026-07-22 overnight incident): an agent whose sessionPool
 * sat at `shadow` (watch-only) had nothing to promote it to `live-transfer`, so
 * when its primary machine slept the standby node could not take over. The gate
 * machinery existed; the driver that turns a passing failover E2E into an actual
 * promotion did not. This is that driver.
 *
 * ── Dark by default (real authority) ──
 * Advancing the sessionPool stage changes cross-machine session-migration
 * behavior — real authority, same class as the reactive swap. So the driver is a
 * strict no-op unless `enabled()` is true, AND it never advances past
 * `targetCeiling()` (default `'dark'` ⇒ even when enabled, no auto-advance until
 * an operator names a ceiling). The decision core is pure (injected deps) so it
 * tests with zero sessions and zero network.
 *
 * ── v1 scope note ──
 * When disabled the driver does NOTHING — including no reconcile. A red-regression
 * auto-revert therefore only runs while the driver is enabled; a dark agent's
 * stage simply stays where its config put it (there is no auto-driving at all).
 * Coupling reconcile to the enable flag keeps the first increment all-or-nothing
 * and inert-when-dark; a future increment may split "always reconcile / gate only
 * the advance" if an operator wants revert-without-advance.
 */

import { StageAdvancer, STAGES, stageIndex, type SessionPoolStage } from './StageAdvancer.js';

export interface SessionPoolRolloutDriverDeps {
  advancer: StageAdvancer;
  /** Dark-by-default master switch: the whole tick is a no-op unless this is true. */
  enabled: () => boolean;
  /**
   * The highest stage the operator has authorized this agent to roll out to. The
   * driver advances toward it but NEVER past it. Default `'dark'` ⇒ no auto-advance
   * (reconcile still runs when enabled). An invalid value is treated as `'dark'`.
   */
  targetCeiling?: () => SessionPoolStage;
  audit?: (event: string, detail: Record<string, unknown>) => void;
}

export interface RolloutTickResult {
  /** false ⇒ the driver was disabled and did nothing. */
  ran: boolean;
  /** The stage after reconcile (== current when no regression, the prior stage on a red revert). */
  reconciledTo: SessionPoolStage | null;
  /** The stage advanced TO this tick, or null if no advance happened. */
  advancedTo: SessionPoolStage | null;
  /** Why an advance did NOT happen this tick (null when one did, or when disabled). */
  advanceSkippedReason: 'at-ceiling' | 'e2e-gate-not-passed' | 'already-at-or-past' | 'invalid-stage' | null;
}

const DARK: SessionPoolStage = 'dark';

export class SessionPoolRolloutDriver {
  constructor(private readonly d: SessionPoolRolloutDriverDeps) {}

  /**
   * One rollout cycle: reconcile (revert on red) then attempt a single gated
   * advance toward the operator ceiling. Safe to call on any cadence; idempotent
   * once at the ceiling with no fresh E2E. Never throws for a normal decision.
   */
  tick(): RolloutTickResult {
    if (!this.d.enabled()) {
      return { ran: false, reconciledTo: null, advancedTo: null, advanceSkippedReason: null };
    }

    // 1. Safety first: a red regression on the current stage reverts BEFORE any advance.
    const reconciledTo = this.d.advancer.reconcile();

    // 2. Resolve the operator ceiling (clamp an invalid/absent value to the dark floor).
    const rawCeiling = this.d.targetCeiling ? this.d.targetCeiling() : DARK;
    const ceiling: SessionPoolStage = stageIndex(rawCeiling) >= 0 ? rawCeiling : DARK;

    const currentIdx = stageIndex(reconciledTo);
    const ceilingIdx = stageIndex(ceiling);

    // Already at or above the authorized ceiling — nothing to advance.
    if (currentIdx >= ceilingIdx) {
      return { ran: true, reconciledTo, advancedTo: null, advanceSkippedReason: 'at-ceiling' };
    }

    // 3. Attempt exactly one gated advance. StageAdvancer enforces the green E2E gate.
    const nextStage = STAGES[currentIdx + 1];
    const res = this.d.advancer.advanceTo(nextStage);
    if (res.ok) {
      this.d.audit?.('rollout-advanced', { from: reconciledTo, to: res.stage, ceiling });
      return { ran: true, reconciledTo, advancedTo: res.stage, advanceSkippedReason: null };
    }
    return { ran: true, reconciledTo, advancedTo: null, advanceSkippedReason: res.reason };
  }
}
