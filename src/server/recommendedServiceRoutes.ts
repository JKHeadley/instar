/**
 * Routes for recommended outside services (docs/specs/recommended-services.md, Surfaces).
 * Reading is open to any session. A no is the operator's act, so it needs the PIN, never a
 * bearer token alone. Absent ledger answers 503.
 */
import type { Request, Response, Router } from 'express';
import { NO_REASONS, type NoReason, type RecommendedServicesLedger } from '../recommended/RecommendedServicesLedger.js';
import { RECOMMENDED_SERVICE_IDS } from '../recommended/serviceIds.js';

export interface RecommendedServiceRouteDeps {
  ledger: () => RecommendedServicesLedger | null;
  checkPin: (req: Request, res: Response) => boolean;
}

export function registerRecommendedServiceRoutes(router: Router, deps: RecommendedServiceRouteDeps): void {
  const ledgerOr503 = (res: Response): RecommendedServicesLedger | null => {
    const ledger = deps.ledger();
    if (!ledger) res.status(503).json({ error: 'recommended-services-unavailable', detail: 'Choices cannot be saved on this machine yet, because it has no machine identity.' });
    return ledger;
  };

  router.get('/recommended-services', (_req, res) => {
    const ledger = ledgerOr503(res);
    if (!ledger) return;
    res.json({ services: RECOMMENDED_SERVICE_IDS.map((id) => ledger.effective(id)), offersLive: false, replicating: ledger.isReplicating() });
  });

  router.post('/recommended-services/:id/no', (req, res) => {
    const ledger = ledgerOr503(res);
    if (!ledger) return;
    if (!RECOMMENDED_SERVICE_IDS.includes(req.params.id)) {
      res.status(404).json({ error: 'unknown-service' });
      return;
    }
    if (req.headers['x-instar-request'] !== '1') {
      res.status(403).json({ error: 'X-Instar-Request: 1 required' });
      return;
    }
    const { reason = 'none', shutdown = false } = (req.body ?? {}) as { reason?: unknown; shutdown?: unknown };
    if (!NO_REASONS.includes(reason as NoReason)) {
      res.status(400).json({ error: 'invalid-reason', valid: NO_REASONS });
      return;
    }
    if (typeof shutdown !== 'boolean') {
      res.status(400).json({ error: 'invalid-shutdown' });
      return;
    }
    if (!deps.checkPin(req, res)) return;
    try {
      ledger.recordNo({ service: req.params.id, reason: reason as NoReason, shutdown: shutdown ? 'authorized' : 'none', origin: 'owner-surface' });
    } catch {
      res.status(503).json({ error: 'recommended-services-unavailable', detail: 'That choice could not be saved. Nothing changed.' });
      return;
    }
    res.json(ledger.effective(req.params.id));
  });
}
