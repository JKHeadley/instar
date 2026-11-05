/**
 * GET /mobile/health-issues (docs/specs/mobile-health-issues.md): the owner's reading of /health.
 *
 * Read-only. Owner phone or bearer; the console reads it with its bearer. Each reason /health is degraded
 * comes back sorted by whether it affects the person, in plain words, with a next step. /health itself is
 * unchanged and is read here over loopback, so the two cannot disagree about what is wrong.
 */
import type { Request, Response, Router } from 'express';
import { ownerOrBearer, singleFlight } from './mobileCapacityRoutes.js';
import { summarizeHealth, type HealthCurrentState, type HealthIssuesSummary } from '../monitoring/healthIssues.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';

export const MOBILE_HEALTH_SCHEMA_VERSION = 1;
/** The Fleet screen reads every 30 s per agent; a short cache keeps a burst to one /health read. */
export const HEALTH_READ_CACHE_MS = 5_000;

export interface MobileHealthDeps {
  /** GET /health on this server with its own token, so the detailed fields are present. */
  readHealth: () => Promise<{ status: number; body: unknown }>;
  bearerOk: (req: Request) => boolean;
  /** The recent degradations /health counted. Defaults to the reporter. */
  recentEvents?: () => ReadonlyArray<{ feature?: unknown; timestamp?: unknown; internalOnly?: unknown; narrative?: unknown }>;
  /** What is true now for channels that report a failure only once. */
  current?: () => HealthCurrentState;
  now?: () => number;
}

function report(detail: string, err: unknown): void {
  DegradationReporter.getInstance().report({
    feature: 'MobileHealthIssues.read',
    primary: 'Owner health reading',
    fallback: 'The phone and console say they could not read the agent’s health',
    reason: `${detail}: ${err instanceof Error ? err.message : String(err)}`,
    impact: 'The health screens can’t explain what is wrong right now.',
  });
}

export function mountMobileHealthRoutes(router: Router, deps: MobileHealthDeps): void {
  const now = () => (deps.now ? deps.now() : Date.now());
  const cached = singleFlight<HealthIssuesSummary>(HEALTH_READ_CACHE_MS, now);
  const events = deps.recentEvents ?? (() => DegradationReporter.getInstance().getRecentEvents()
    .map((e) => ({ ...e, narrative: DegradationReporter.narrativeFor(e) })));

  router.get('/mobile/health-issues', async (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    if (!ownerOrBearer(req, deps.bearerOk)) {
      res.status(403).json({ error: 'owner-phone-required', detail: 'Only the owner\'s phone can see this.' });
      return;
    }
    try {
      const summary = await cached('health', async () => {
        const r = await deps.readHealth();
        if (r.status !== 200) throw new Error(`/health answered ${r.status}`);
        return summarizeHealth(r.body, events(), deps.current?.() ?? {});
      });
      res.json({ schemaVersion: MOBILE_HEALTH_SCHEMA_VERSION, generatedAt: new Date(now()).toISOString(), ...summary });
    } catch (err) {
      report('GET /mobile/health-issues', err);
      res.status(500).json({ error: 'health-unavailable' });
    }
  });
}
