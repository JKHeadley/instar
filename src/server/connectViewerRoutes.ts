import type { Router } from 'express';
import type { ConnectViewerAuthority } from '../core/ConnectViewerAuthority.js';

/** The route is absent unless the server explicitly supplies trusted local enrollment authority. */
export function mountConnectViewerEnrollment(router: Router, authority?: ConnectViewerAuthority): void {
  if (!authority) return;
  const route = '/desktop/connect/viewer/enroll';
  router.post(route, (req, res) => {
    if (req.originalUrl !== route) {
      res.status(404).end();
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    const { challengeId, publicKey, signature } = req.body ?? {};
    if (typeof challengeId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(challengeId) ||
        typeof publicKey !== 'string' || typeof signature !== 'string') {
      res.status(400).json({ error: 'invalid-request' });
      return;
    }
    if (!authority.enroll(challengeId, publicKey, signature)) {
      res.status(403).json({ error: 'enrollment-refused' });
      return;
    }
    res.status(204).end();
  });
}
