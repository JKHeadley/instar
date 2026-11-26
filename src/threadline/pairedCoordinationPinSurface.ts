import { randomUUID } from 'node:crypto';
import { Router, type Request } from 'express';
import type { PublicPinHook } from '../server/publicPinHook.js';
import {
  PAIRED_COORDINATION_APPROVAL, PAIRED_COORDINATION_KIND, pairedCoordinationGrantDigest, type OperatorBinding,
} from './pairedCoordinationPolicy.js';
import type { createPairedCoordinationGrantStore } from './pairedCoordinationGrantStore.js';

export const PAIRED_COORDINATION_PIN_PATH = '/trust/paired-agent-coordination';

/** Standalone router for a dark rehearsal. The production server does not mount it. */
export function createPairedCoordinationPinSurface(deps: {
  enabled?: boolean;
  /** Resolve the current authenticated owner using the normal dashboard session boundary. */
  currentOwner(req: Request): OperatorBinding | null;
  pin: Pick<PublicPinHook, 'verify'>;
  store: ReturnType<typeof createPairedCoordinationGrantStore>;
}) {
  const router = Router();
  if (deps.enabled !== true) return router;

  router.get(PAIRED_COORDINATION_PIN_PATH, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const owner = deps.currentOwner(req);
    if (!owner) { res.sendStatus(403); return; }
    const grant = deps.store.readGrant(owner.operatorId);
    res.json({
      wording: PAIRED_COORDINATION_APPROVAL, revision: grant?.revision ?? 0,
      active: grant?.state === 'allowed' && grant.ownerRevision === owner.ownerRevision,
    });
  });

  router.post(PAIRED_COORDINATION_PIN_PATH, (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.get('X-Instar-Request') !== '1' || !req.is('application/json')) { res.sendStatus(403); return; }
    const owner = deps.currentOwner(req);
    if (!owner) { res.sendStatus(403); return; }
    const action = req.body?.action;
    const expectedRevision = req.body?.expectedRevision;
    if ((action !== 'allow' && action !== 'revoke') || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      res.sendStatus(400);
      return;
    }
    const change = { ...owner, expectedRevision, action };
    const verdict = deps.pin.verify(req, req.body.pin, { requestKey: PAIRED_COORDINATION_KIND });
    if (!verdict.ok) {
      res.sendStatus(verdict.reason === 'paused' ? 429 : verdict.reason === 'unavailable' ? 503 : 403);
      return;
    }
    const committed = deps.store.commitGrantChange(change, {
      authorizationId: randomUUID(), operatorId: owner.operatorId, requestDigest: pairedCoordinationGrantDigest(change),
    });
    if (!committed) { res.sendStatus(409); return; }
    res.json({ active: action === 'allow', revision: expectedRevision + 1 });
  });
  return router;
}
