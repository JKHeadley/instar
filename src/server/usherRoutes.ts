/**
 * Usher HTTP routes — the read-only pull surface for the Usher's re-surface
 * signals + precision metrics (rung 4). Signal-only: consumers PULL; the Usher
 * never pushes to chat and never injects.
 *
 *   GET /usher/signals?topicId=N   — recent re-surface suggestions
 *   GET /usher/metrics?topicId=N   — fired / acted precision funnel
 *
 * Operator-facing (INTERNAL_PREFIXES). Spec: docs/specs/cwa-usher.md §3–4.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { UsherSignalStore } from '../core/UsherSignalStore.js';

const TopicIdParam = z.coerce.number().int().nonnegative();

export function createUsherRoutes(deps: { signalStore: UsherSignalStore | null }): Router {
  const router = Router();
  const store = deps.signalStore;

  if (!store) {
    router.use('/usher', (_req, res) => res.status(503).json({ error: 'usher disabled' }));
    return router;
  }

  router.get('/usher/signals', (req: Request, res: Response) => {
    const parsed = TopicIdParam.safeParse(req.query.topicId);
    if (!parsed.success) return res.status(400).json({ error: 'topicId query param required' });
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    res.json({ topicId: parsed.data, signals: store.getSignals(parsed.data, limit) });
  });

  router.get('/usher/metrics', (req: Request, res: Response) => {
    const parsed = TopicIdParam.safeParse(req.query.topicId);
    if (!parsed.success) return res.status(400).json({ error: 'topicId query param required' });
    const m = store.getMetrics(parsed.data);
    // Precision = acted / fired (the read that gates rung 5; paired externally
    // with the human-as-detector miss-map for the "what it missed" half).
    // acted_by_use / acted_by_miss split the numerator by which correlation path
    // confirmed usefulness (agent used it vs user had to correct on it); defaulted
    // so legacy topic files (pre-split) report 0 rather than undefined.
    const precision = m.fired > 0 ? m.acted / m.fired : null;
    res.json({
      topicId: parsed.data,
      metrics: { ...m, acted_by_use: m.acted_by_use ?? 0, acted_by_miss: m.acted_by_miss ?? 0, precision },
    });
  });

  return router;
}
