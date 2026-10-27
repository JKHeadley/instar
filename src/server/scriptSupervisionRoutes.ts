/**
 * POST /jobs/script-supervision/pass — the daily high-level review of script
 * jobs (docs/specs/job-cost-reduction.md §5.6.5). Bearer auth comes from the
 * server's global auth middleware. Triggered by the shipped
 * `script-job-supervisor` script job (claim-gated, one machine).
 *
 * 503 when the supervisor is unwired or its script rollout is inactive.
 */

import { Router, type Request, type Response } from 'express';
import type { ScriptJobSupervisor } from '../scheduler/ScriptJobSupervisor.js';

export function createScriptSupervisionRoutes(deps: { supervisor: ScriptJobSupervisor | null; enabled: () => boolean }): Router {
  const router = Router();
  router.post('/jobs/script-supervision/pass', async (_req: Request, res: Response) => {
    if (!deps.supervisor || !deps.enabled?.()) return res.status(503).json({ error: 'script-supervision-unavailable', reason: 'the script job supervisor is not active on this agent' });
    try {
      const result = await deps.supervisor.pass();
      // A pass that could not judge is still a 200 with ok:false; the script
      // maps ok:false to JOB_RESULT failed so the failure path alerts.
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  return router;
}

/** Mount helper for the integrator: `mountScriptSupervisionRoutes(app, { supervisor })`. */
export function mountScriptSupervisionRoutes(app: { use(router: Router): unknown }, deps: { supervisor: ScriptJobSupervisor | null; enabled: () => boolean }): void {
  app.use(createScriptSupervisionRoutes(deps));
}
