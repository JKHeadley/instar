/**
 * Failure-Learning Loop HTTP routes (spec §4.5).
 *
 * Read surface for the Process Health dashboard tab + the one-tap
 * agent-diagnosed write. Mounted UNCONDITIONALLY: when the feature is disabled
 * (ledger null) every route 503-stubs so the surface always exists for
 * capability probing (matches the E2E "alive = 200 not 503" requirement).
 *
 * Endpoints (all behind the server's standard Bearer auth — this router is
 * mounted AFTER authMiddleware, never in the exemption list, spec §4.5 A1):
 *   GET  /failures            — list (toApiView; detail.full NEVER served, §4.8)
 *   GET  /failures/:id        — one record (toApiView)
 *   GET  /failures/analysis   — indexed aggregates (§4.4)
 *   GET  /failures/insights   — discovered insights (empty until the analyzer ships)
 *   POST /failures            — agent-diagnosed one-tap (§4.2 #B): requires
 *                               X-Instar-Request intent marker + filedBy audit;
 *                               server-validates the initiative; one-tap never
 *                               upgrades to automatic.
 *
 * Write-surface note (spec §4.2#B / F12, round-3): we make NO "unwritable over
 * tunnel" claim — the transport signal can't distinguish tunnel traffic. The
 * honest control is the X-Instar-Request intent marker + the filedBy audit
 * trail + the analyzer's author-broken-down coverage signal.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { FailureLedger } from '../monitoring/FailureLedger.js';
import type { FailureSeverity } from '../monitoring/FailureLedger.js';
import { FailureAttributionEngine } from '../monitoring/FailureAttributionEngine.js';

const ListQuery = z.object({
  source: z.string().optional(),
  category: z.string().optional(),
  initiativeId: z.string().optional(),
  attribution: z.enum(['automatic', 'one-tap', 'inferred']).optional(),
  status: z.string().optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
});

const PostBody = z.object({
  summary: z.string().min(1).max(2000),
  initiativeId: z.string().min(1).max(128),
  causeCommitOid: z.string().max(64).optional(),
  severity: z.enum(['low', 'medium', 'high']).default('medium'),
  category: z.string().max(40).optional(),
  // detail.full is internal — callers may supply only redacted-safe text here.
  detail: z.string().max(8000).optional(),
});

export function createFailureRoutes(deps: {
  ledger: FailureLedger | null;
  attributionEngine: FailureAttributionEngine | null;
  enabled?: boolean;
}): Router {
  const router = Router();
  const { ledger, attributionEngine } = deps;
  const enabled = deps.enabled !== false && !!ledger;

  if (!enabled || !ledger) {
    router.use('/failures', (_req, res) => {
      res.status(503).json({ error: 'failure-learning disabled' });
    });
    return router;
  }

  router.get('/failures', (req: Request, res: Response) => {
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: 'invalid query', detail: parsed.error.flatten() });
    const records = ledger.list({
      source: parsed.data.source as never,
      category: parsed.data.category as never,
      initiativeId: parsed.data.initiativeId,
      attribution: parsed.data.attribution,
      status: parsed.data.status as never,
      limit: parsed.data.limit,
    });
    // toApiView strips detail.full — full NEVER crosses this boundary (§4.8).
    res.json({ failures: records.map((r) => FailureLedger.toApiView(r)) });
  });

  router.get('/failures/analysis', (req: Request, res: Response) => {
    const sinceDays = req.query.sinceDays ? Number(req.query.sinceDays) : undefined;
    const sinceMs = sinceDays && sinceDays > 0 ? Date.now() - sinceDays * 86400_000 : undefined;
    res.json(ledger.analyze({ sinceMs }));
  });

  // Insights surface — empty until the analyzer ships (later rollout slice).
  router.get('/failures/insights', (_req: Request, res: Response) => {
    res.json({ insights: [], note: 'analyzer not yet enabled — insights populate once it ships' });
  });

  router.get('/failures/:id', (req: Request, res: Response) => {
    const rec = ledger.get(req.params.id);
    if (!rec) return res.status(404).json({ error: 'not found' });
    res.json(FailureLedger.toApiView(rec));
  });

  router.post('/failures', (req: Request, res: Response) => {
    // Intent marker (spec §4.2#B): the one mutating route requires explicit
    // user/agent intent. Not a transport boundary — paired with filedBy audit.
    if (req.headers['x-instar-request'] !== '1') {
      return res.status(403).json({ error: 'POST /failures requires the X-Instar-Request: 1 intent header' });
    }
    const parsed = PostBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid body', detail: parsed.error.flatten() });
    const body = parsed.data;

    // Server-side validation (§4.2#B A2): the cited initiative MUST exist.
    if (!attributionEngine) {
      return res.status(503).json({ error: 'attribution engine not configured' });
    }
    const verdict = attributionEngine.validateAgentDiagnosed({
      initiativeId: body.initiativeId,
      causeCommitOid: body.causeCommitOid,
    });
    if (!verdict.ok) return res.status(400).json({ error: verdict.reason });

    const filedBy =
      (req.headers['x-instar-agentid'] as string) ||
      (req.headers['x-instar-session'] as string) ||
      'agent-diagnosed';
    const redacted = body.detail ?? body.summary;
    const rec = ledger.open({
      filedBy,
      source: 'agent-diagnosed',
      severity: body.severity as FailureSeverity,
      summary: body.summary,
      // The one-tap body is redacted-safe; we do not synthesize a separate full.
      detail: { redacted, full: redacted },
      category: FailureAttributionEngine.coerceCategory(body.category),
      initiativeId: verdict.verdict.initiativeId,
      projectId: verdict.verdict.projectId,
      specPath: verdict.verdict.specPath,
      causeCommitOid: verdict.verdict.causeCommitOid,
      attribution: verdict.verdict.attribution, // 'one-tap' — never upgrades (B6)
      attributionConfidence: verdict.verdict.attributionConfidence,
      provenance: 'unknown',
    });
    if (!rec) return res.status(500).json({ error: 'failed to record (logged via fail-open path)' });
    res.status(201).json(FailureLedger.toApiView(rec));
  });

  return router;
}
