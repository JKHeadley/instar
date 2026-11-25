import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  issueCameraVerifierRequest, withdrawCameraPass,
  type CameraPassWithdrawalJournal, type CameraRequestJournal,
} from '../core/CameraAcceptanceRequests.js';

interface CameraRouteVerifier {
  principal: string;
  journal: CameraRequestJournal & CameraPassWithdrawalJournal;
}

export interface CameraAcceptanceRouteDeps {
  /** Resolve the configured pilot with a strict verifier credential and scoped journal. */
  resolveVerifier(credential: string): Promise<CameraRouteVerifier | null>;
}

const token = z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/);
const withdrawalBody = z.strictObject({
  id: token, candidate: token, revision: z.number().int().positive(),
  passSequence: z.number().int().positive(), reason: z.enum(['retest', 'regression']),
});

export function createCameraAcceptanceRoutes(deps: CameraAcceptanceRouteDeps | undefined): Router {
  const router = Router();

  const withVerifier = (run: (verifier: CameraRouteVerifier, req: Request, res: Response) => Promise<void>) =>
    async (req: Request, res: Response) => {
      if (!deps) { res.status(503).json({ error: 'camera-pilot-unavailable' }); return; }
      const credential = req.get('X-Instar-Origin-Session');
      if (!credential || !/^ior1_[A-Za-z0-9_-]{43}$/.test(credential)) {
        res.status(403).json({ error: 'camera-verifier-required' });
        return;
      }
      try {
        const verifier = await deps.resolveVerifier(credential);
        if (!verifier) { res.status(403).json({ error: 'camera-verifier-required' }); return; }
        await run(verifier, req, res);
      } catch {
        // @silent-fallback-ok: the response explicitly reports unavailable authority or storage.
        res.status(503).json({ error: 'camera-pilot-unavailable' });
      }
    };

  router.post('/chief-of-staff/camera-acceptance/requests', withVerifier(async (verifier, _req, res) => {
    const result = await issueCameraVerifierRequest(verifier.journal, verifier.principal);
    switch (result.status) {
      case 'issued':
        res.status(201).json({ requestId: result.request.id });
        return;
      case 'pending-required':
        res.status(409).json({ error: 'camera-retest-requires-pending' });
        return;
      case 'forbidden':
        res.status(403).json({ error: 'camera-verifier-required' });
        return;
      case 'unavailable':
        res.status(503).json({ error: 'camera-pilot-unavailable' });
        return;
    }
  }));

  router.post('/chief-of-staff/camera-acceptance/pass-withdrawals', withVerifier(async (verifier, req, res) => {
    const input = withdrawalBody.safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: 'invalid-camera-withdrawal' }); return; }
    const result = await withdrawCameraPass(verifier.journal, verifier.principal, input.data);
    switch (result.status) {
      case 'recorded':
        res.status(200).json({ decision: result.receipt.decision, sequence: result.receipt.sequence });
        return;
      case 'invalid':
        res.status(400).json({ error: 'invalid-camera-withdrawal' });
        return;
      case 'conflict':
      case 'stale-pass':
        res.status(409).json({ error: result.status });
        return;
      case 'forbidden':
        res.status(403).json({ error: 'camera-verifier-required' });
        return;
      case 'unavailable':
        res.status(503).json({ error: 'camera-pilot-unavailable' });
        return;
    }
  }));
  return router;
}
