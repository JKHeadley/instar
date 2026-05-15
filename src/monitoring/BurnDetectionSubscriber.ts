/**
 * BurnDetectionSubscriber — wires the BurnThrottleRunbook into the
 * DegradationReporter as a self-healer for feature='token-burn-detection'.
 *
 * Phase 5 of docs/specs/token-burn-detection-and-self-heal.md. The
 * DegradationReporter already supports a `registerHealer(feature, healer)`
 * surface (per Remediator V2 spec). The runbook's `handle()` is sync and
 * returns RunbookOutcome; the healer signature is async + returns boolean.
 * This module is the small adapter between them.
 *
 * Returns true to DegradationReporter when the runbook installed a
 * throttle (the healer "succeeded" by acting on the signal); returns false
 * when only an alert was sent (the runbook chose alert-only) so the
 * reporter's own audit log records the partial-action correctly.
 */

import type { DegradationEvent, DegradationReporter } from './DegradationReporter.js';
import type { BurnThrottleRunbook, RunbookOutcome } from './BurnThrottleRunbook.js';

export const BURN_DETECTION_FEATURE = 'token-burn-detection';

export function registerBurnDetectionSubscriber(
  reporter: Pick<DegradationReporter, 'registerHealer'>,
  runbook: BurnThrottleRunbook,
  /**
   * Optional sink for outcomes — the verification step (Phase 6) will
   * subscribe here to re-sample telemetry post-throttle and emit a follow-up.
   */
  onOutcome?: (outcome: RunbookOutcome, event: DegradationEvent) => void,
): void {
  reporter.registerHealer(BURN_DETECTION_FEATURE, async (event: DegradationEvent) => {
    const outcome = runbook.handle(event);
    try {
      onOutcome?.(outcome, event);
    } catch (err) {
      console.warn(`[burn-detection-subscriber] onOutcome threw: ${(err as Error).message}`);
    }
    return outcome.kind === 'throttle-installed';
  });
}
