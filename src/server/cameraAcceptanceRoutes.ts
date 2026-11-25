import { Router } from 'express';
import { issueCameraVerifierRequest, type CameraRequestJournal } from '../core/CameraAcceptanceRequests.js';

export interface CameraAcceptanceRouteDeps {
  /** Resolve the configured pilot with a strict verifier credential and scoped journal. */
  resolveVerifier(credential: string): Promise<{ principal: string; journal: CameraRequestJournal } | null>;
}

export function createCameraAcceptanceRoutes(deps: CameraAcceptanceRouteDeps | undefined): Router {
  const router = Router();
  router.post('/chief-of-staff/camera-acceptance/requests', async (req, res) => {
    if (!deps) { res.status(503).json({ error: 'camera-pilot-unavailable' }); return; }
    const credential = req.get('X-Instar-Origin-Session');
    if (!credential || !/^ior1_[A-Za-z0-9_-]{43}$/.test(credential)) {
      res.status(403).json({ error: 'camera-verifier-required' });
      return;
    }

    try {
      const verifier = await deps.resolveVerifier(credential);
      if (!verifier) { res.status(403).json({ error: 'camera-verifier-required' }); return; }
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
    } catch {
      // @silent-fallback-ok: an unavailable authority or durable write gets an explicit unavailable response.
      res.status(503).json({ error: 'camera-pilot-unavailable' });
    }
  });
  return router;
}
