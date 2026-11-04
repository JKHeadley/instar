/**
 * The measured path to default-on (spec: docs/specs/feature-maturation-ladder.md §4, §8, §10).
 *
 *   GET  /maturation/ladder            every feature's rung, next rung, thresholds now vs target
 *   GET  /maturation/moves             the audit rows
 *   POST /maturation/moves             apply a move the review's model decided; every floor can only refuse
 *   POST /maturation/moves/:id/revert  undo one, only if what it wrote is still there
 *   POST /maturation/evidence          a job or hook reports what a feature did, or grades a past event
 *
 * E2E-PAIRING: tests/e2e/maturation-ladder-alive.test.ts.
 */

import { Router, type Request, type Response } from 'express';

import { resolveDevAgentGate } from '../core/devAgentGate.js';

import type { FeatureEvidenceInput, FeatureEvidenceLog } from '../monitoring/FeatureEvidenceLog.js';
import type { MaturationLadderService } from '../monitoring/MaturationLadderService.js';
import type { TargetRung } from '../monitoring/MaturationLadder.js';

export interface MaturationLadderCtx {
  enabled: () => boolean;
  ladder: () => MaturationLadderService | null;
  evidence: () => FeatureEvidenceLog | null;
}

export function isMaturationLadderEnabled(config: { developmentAgent?: boolean; maturation?: { ladder?: { enabled?: boolean } } }): boolean {
  return resolveDevAgentGate(config.maturation?.ladder?.enabled, config);
}

const EVIDENCE_PER_MINUTE = 60;
const KINDS = new Set(['fired', 'held', 'error', 'outcome']);
const OUTCOMES = new Set(['right', 'wrong', 'unknown']);

export function createMaturationLadderRoutes(ctx: MaturationLadderCtx): Router {
  const router = Router();
  const recent = new Map<string, number[]>();

  const service = (res: Response): MaturationLadderService | null => {
    if (!ctx.enabled()) {
      res.status(503).json({ error: 'the maturation ladder is not switched on for this agent (maturation.ladder.enabled)' });
      return null;
    }
    const svc = ctx.ladder();
    if (!svc) {
      res.status(503).json({ error: 'the maturation ladder is not running on this machine' });
      return null;
    }
    return svc;
  };

  router.get('/maturation/ladder', (req: Request, res: Response) => {
    const svc = service(res);
    if (!svc) return;
    const id = typeof req.query.id === 'string' ? req.query.id.slice(0, 200) : undefined;
    res.json(svc.response(id));
  });

  router.get('/maturation/moves', (req: Request, res: Response) => {
    const svc = service(res);
    if (!svc) return;
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 100));
    res.json({ rows: svc.auditRows(limit) });
  });

  router.post('/maturation/moves', (req: Request, res: Response) => {
    const svc = service(res);
    if (!svc) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.id !== 'string' || (b.target !== 'dev-agent-live' && b.target !== 'fleet')) {
      res.status(400).json({ error: 'id and target (dev-agent-live or fleet) are required' });
      return;
    }
    if (typeof b.reason !== 'string' || !b.reason.trim() || b.reason.length > 2000) {
      res.status(400).json({ error: 'a reason is required (at most 2000 characters)' });
      return;
    }
    if (!Array.isArray(b.opinions) || b.opinions.length < 1 || b.opinions.length > 8) {
      res.status(400).json({ error: 'opinions are required: this route applies a decision a model already made' });
      return;
    }
    if (!b.from || typeof b.from !== 'object' || Array.isArray(b.from)) {
      res.status(400).json({ error: 'from is required: the current values read from the ladder response' });
      return;
    }
    const result = svc.applyMove({
      id: b.id,
      target: b.target as TargetRung,
      reason: b.reason,
      from: b.from as Record<string, unknown>,
      opinions: b.opinions.slice(0, 8),
    });
    res.status(result.ok ? 200 : 409).json(result);
  });

  router.post('/maturation/moves/:moveId/revert', (req: Request, res: Response) => {
    const svc = service(res);
    if (!svc) return;
    const reason = (req.body as { reason?: unknown } | undefined)?.reason;
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 2000) {
      res.status(400).json({ error: 'a reason is required (at most 2000 characters)' });
      return;
    }
    const result = svc.revertMove(String(req.params.moveId), reason);
    res.status(result.ok ? 200 : 409).json(result);
  });

  router.post('/maturation/evidence', (req: Request, res: Response) => {
    const svc = service(res);
    if (!svc) return;
    const log = ctx.evidence();
    if (!log) {
      res.status(503).json({ error: 'the evidence log is not running on this machine' });
      return;
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const id = b.featureId;
    if (typeof id !== 'string' || !svc.entries.some(e => e.id === id)) {
      res.status(400).json({ error: 'featureId must be a feature on the ladder' });
      return;
    }
    if (typeof b.kind !== 'string' || !KINDS.has(b.kind)) {
      res.status(400).json({ error: 'kind must be fired, held, error or outcome' });
      return;
    }
    if (typeof b.reason !== 'string' || !b.reason.trim()) {
      res.status(400).json({ error: 'a reason is required' });
      return;
    }
    if (b.kind === 'outcome' && (typeof b.outcome !== 'string' || !OUTCOMES.has(b.outcome))) {
      res.status(400).json({ error: 'an outcome row needs outcome: right, wrong or unknown' });
      return;
    }
    const now = Date.now();
    const times = (recent.get(id) ?? []).filter(t => t > now - 60_000);
    if (times.length >= EVIDENCE_PER_MINUTE) {
      res.status(429).json({ error: `at most ${EVIDENCE_PER_MINUTE} rows a minute per feature` });
      return;
    }
    times.push(now);
    recent.set(id, times);
    const input: FeatureEvidenceInput = {
      kind: b.kind as FeatureEvidenceInput['kind'],
      reason: b.reason,
      ...(typeof b.outcome === 'string' && OUTCOMES.has(b.outcome) ? { outcome: b.outcome as FeatureEvidenceInput['outcome'] } : {}),
      ...(typeof b.gradesEventId === 'string' ? { gradesEventId: b.gradesEventId } : {}),
      ...(typeof b.gradedBy === 'string' ? { gradedBy: b.gradedBy } : {}),
      ...(b.context && typeof b.context === 'object' && !Array.isArray(b.context) ? { context: b.context as FeatureEvidenceInput['context'] } : {}),
    };
    const eventId = log.record(id, input);
    if (!eventId) {
      res.status(500).json({ error: 'the row could not be written' });
      return;
    }
    res.json({ eventId });
  });

  return router;
}
