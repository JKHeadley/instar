/**
 * GET /never-silent/incidents — Never-Silent Conversation observability
 * (docs/specs/never-silent-conversation.md §4). Read-only. 503 while the feature is
 * off on this agent. The waiting message text never leaves the store through here.
 *
 * E2E-PAIRING: tests/e2e/never-silent-alive.test.ts.
 */
import { Router, type Request, type Response } from 'express';
import type { NeverSilentStore } from '../monitoring/neverSilent/NeverSilentStore.js';

let instance: { store: NeverSilentStore; enabled: () => boolean } | null = null;

/** Set by server boot once the feature is built (null when it is not). */
export function setNeverSilentInstance(next: { store: NeverSilentStore; enabled: () => boolean } | null): void {
  instance = next;
}

export function createNeverSilentRoutes(): Router {
  const router = Router();
  router.get('/never-silent/incidents', (req: Request, res: Response) => {
    if (!instance || !instance.enabled()) {
      res.status(503).json({ error: 'never-silent conversations are not switched on for this agent (monitoring.neverSilent.enabled)' });
      return;
    }
    const snap = instance.store.snapshot();
    const openOnly = req.query.open === '1' || req.query.open === 'true';
    const incidents = openOnly ? snap.incidents.filter((i) => !i.closedAt) : snap.incidents;
    const obligations = openOnly ? snap.obligations.filter((o) => o.state === 'pending' || o.state === 'told-pending') : snap.obligations;
    // lease-freshness-lapse-retry — this machine's own replies held at the send boundary for the lease: a count
    // beside the incidents (never judged, never noticed), closed with the delivery time.
    const sendHolds = openOnly ? snap.sendHolds.filter((h) => !h.closedAt) : snap.sendHolds;
    res.json({
      incidents: incidents.slice(-200).reverse(),
      obligations: obligations.slice(-500).reverse(),
      sendHolds: sendHolds.slice(-200).reverse(),
      counts: {
        openObligations: snap.obligations.filter((o) => o.state === 'pending' || o.state === 'told-pending').length,
        openIncidents: snap.incidents.filter((i) => !i.closedAt).length,
        openSendHolds: snap.sendHolds.filter((h) => !h.closedAt).length,
      },
    });
  });
  return router;
}
