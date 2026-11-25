/**
 * Permanent agent links, the agent-facing builder (docs/specs/permanent-agent-links.md §2b).
 *
 * POST /agent-links (Bearer) { target, ref?, comment? } → { url, appUrl } — a reference only: it
 * creates no share, access grant or pairing. Uses the same strict identity reader as the phone's
 * identity route, so it never makes a link for an id that route would refuse to serve.
 */
import { Router, type Request, type Response } from 'express';
import { buildAgentLink, readLinkIdentity } from '../core/AgentLinks.js';
import { featureEvidence } from '../monitoring/FeatureEvidenceLog.js';

export interface AgentLinkRouteDeps {
  stateDir: string;
  /** `agentLinks.enabled`, read live per request. */
  enabled: () => boolean;
  /**
   * Machines observed publishing a different identity fingerprint than this one (the identity
   * coherence check). Unknown or unreadable peers are never listed. Absent ⇒ no warning.
   */
  splitMachines?: () => string[];
}

export function createAgentLinkRoutes(deps: AgentLinkRouteDeps): Router {
  const router = Router();
  router.post('/agent-links', (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const evidence = (outcome: string, kind: 'fired' | 'held' | 'error'): void => {
      featureEvidence.recordAtMostEvery('agentLinks', `build|${outcome}`, 60_000, { kind, reason: `agent-link build: ${outcome}`, context: { outcome } });
    };
    if (!deps.enabled()) { evidence('off', 'held'); res.status(404).json({ error: 'agent-links-off' }); return; }
    const id = readLinkIdentity(deps.stateDir);
    if (!id.ok) { evidence(id.error, 'error'); res.status(409).json({ error: id.error }); return; }
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as { target?: unknown; ref?: unknown; comment?: unknown };
    const built = buildAgentLink(id.canonicalId, body);
    if (!built.ok) { evidence('bad-target', 'held'); res.status(400).json({ error: 'bad-target' }); return; }
    let split: string[] = [];
    try { split = deps.splitMachines?.() ?? []; } catch { split = []; } // @silent-fallback-ok — the warning is a signal only; unknown means no warning
    evidence(split.length ? 'built-split' : 'built', 'fired');
    res.json({ url: built.url, appUrl: built.appUrl, ...(split.length ? { warning: 'split-identity', machines: split } : {}) });
  });
  return router;
}
