import type { Router } from 'express';
import { ConnectViewerEnrollment, type ConnectViewerBinding } from '../core/ConnectViewerEnrollment.js';

export interface ConnectViewerEnrollmentAuthority {
  /** Resolve an opaque challenge ID in the server's process-local approved challenge store. */
  approvedChallenge(id: string): ConnectViewerEnrollment | undefined;
  /** Register only in the dedicated viewer namespace. No owner or capture authority is issued. */
  enroll(binding: ConnectViewerBinding, publicKey: string): void;
}

/** The route is absent unless the server explicitly supplies trusted local enrollment authority. */
export function mountConnectViewerEnrollment(router: Router, authority?: ConnectViewerEnrollmentAuthority): void {
  if (!authority) return;
  router.post('/desktop/connect/viewer/enroll', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const { challengeId, publicKey, signature } = req.body ?? {};
    if (typeof challengeId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(challengeId) ||
        typeof publicKey !== 'string' || typeof signature !== 'string') {
      res.status(400).json({ error: 'invalid-request' });
      return;
    }
    const challenge = authority.approvedChallenge(challengeId);
    const binding = challenge?.challenge.nonce === challengeId ? challenge.accept(publicKey, signature) : undefined;
    if (!binding) {
      res.status(403).json({ error: 'enrollment-refused' });
      return;
    }
    authority.enroll(binding, publicKey);
    res.status(204).end();
  });
}
