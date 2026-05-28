/**
 * Handoff-initiate route — the operator/test trigger for a planned handoff
 * (spec §8 G3e). Bearer-authed local route (mounted AFTER the global auth
 * middleware in AgentServer, so it inherits the same authToken gate as every
 * other operator route).
 *
 * This is the explicit "hand off now" signal. There is deliberately NO
 * sleep/pre-sleep auto-trigger: SleepWakeDetector emits only a 'wake' event
 * (verified), so there is no pre-sleep moment to hook for v1. A planned handoff
 * is therefore operator/test-initiated; an automatic trigger is a tracked
 * follow-on design.
 *
 *   POST /handoff/initiate — run the planned-handoff lifecycle to a terminal
 *     outcome; returns { outcome, inProgress }. outcome ∈ handed-off |
 *     aborted-stay-awake | failed. A `failed` outcome maps to HTTP 500 (the
 *     handoff genuinely errored); handed-off / aborted-stay-awake are both 200
 *     (the sentinel resolved safely — aborting and staying awake is a correct,
 *     expected outcome, not an error).
 *   GET  /handoff/status — race-guard observability: { inProgress }.
 *
 * The DECISION and all safety live in HandoffSentinel (verify the ack echo +
 * validate BEFORE yielding; otherwise abort and stay awake). This route only
 * pulls the trigger and surfaces the outcome. When the wiring is absent (solo
 * agent, or multi-machine disabled), the route 503s honestly — never a silent
 * ok that pretends a handoff happened.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';

/** The HandoffSentinel's terminal outcomes (mirrors HandoffOutcome). */
export type HandoffOutcomeStr = 'handed-off' | 'aborted-stay-awake' | 'failed';

export interface HandoffInitiateRoutesDeps {
  /**
   * Run the planned handoff to a terminal outcome (HandoffSentinel.initiate via
   * the handoffSentinelWiring). null → not wired (solo / multi-machine off).
   */
  onInitiate: (() => Promise<HandoffOutcomeStr>) | null;
  /** Race-guard read: is a handoff mid-flight? (HandoffSentinel.inProgress) */
  inProgress: (() => boolean) | null;
}

export function createHandoffInitiateRoutes(deps: HandoffInitiateRoutesDeps): Router {
  const router = Router();

  // Not wired → honest 503 on the whole /handoff surface (never a silent ok).
  if (!deps.onInitiate) {
    router.use('/handoff', (_req, res) =>
      res
        .status(503)
        .json({ error: 'planned handoff not wired (solo agent or multi-machine disabled)' }),
    );
    return router;
  }
  const onInitiate = deps.onInitiate;
  const inProgress = deps.inProgress;

  router.post('/handoff/initiate', async (_req: Request, res: Response) => {
    try {
      const outcome = await onInitiate();
      const status = outcome === 'failed' ? 500 : 200;
      res.status(status).json({ outcome, inProgress: inProgress?.() ?? false });
    } catch (err) {
      res.status(500).json({
        outcome: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.get('/handoff/status', (_req: Request, res: Response) => {
    res.json({ inProgress: inProgress?.() ?? false });
  });

  return router;
}
